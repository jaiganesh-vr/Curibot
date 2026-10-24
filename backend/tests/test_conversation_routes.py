from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from pydantic import SecretStr
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import create_access_token
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Conversation, Message, User

TEST_JWT_SECRET = "unit-test-secret-not-production-32-bytes-minimum"

test_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSessionLocal = sessionmaker(
    bind=test_engine,
    autoflush=False,
    autocommit=False,
)


def build_test_settings():
    """Provide consistent settings for creating and validating test tokens."""
    return type(
        "TestSettings",
        (),
        {
            "jwt_secret_key": SecretStr(TEST_JWT_SECRET),
            "access_token_expire_minutes": 30,
        },
    )()


def override_get_db() -> Generator[Session]:
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


client = TestClient(app)


@pytest.fixture(autouse=True)
def setup_database() -> Generator[None]:
    previous_override = app.dependency_overrides.get(get_db)

    app.dependency_overrides[get_db] = override_get_db
    app.state.checkpointer = None

    with patch(
        "app.core.security.get_settings",
        return_value=build_test_settings(),
    ):
        Base.metadata.create_all(bind=test_engine)
        try:
            yield
        finally:
            Base.metadata.drop_all(bind=test_engine)

    if previous_override is None:
        app.dependency_overrides.pop(get_db, None)
    else:
        app.dependency_overrides[get_db] = previous_override


def create_authenticated_user(email: str) -> tuple[User, dict[str, str]]:
    with TestingSessionLocal() as db:
        user = User(email=email, hashed_password="test-hash")
        db.add(user)
        db.commit()
        db.refresh(user)
        user_id = str(user.id)

    token = create_access_token(subject=user_id)
    return user, {"Authorization": f"Bearer {token}"}


def fake_graph(response: str = "Hello from the fake model"):
    class FakeGraph:
        def invoke(self, state):
            return {
                "messages": [
                    *state["messages"],
                    AIMessage(content=response),
                ]
            }

    return FakeGraph()


def test_create_conversation_requires_authentication() -> None:
    response = client.post(
        "/api/v1/conversations",
        json={"title": "Test conversation"},
    )

    assert response.status_code == 401


def test_create_conversation_for_authenticated_user() -> None:
    user, headers = create_authenticated_user("owner@example.com")

    response = client.post(
        "/api/v1/conversations",
        json={"title": "My first chat"},
        headers=headers,
    )

    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "My first chat"
    assert "id" in data

    with TestingSessionLocal() as db:
        conversation = db.scalar(
            select(Conversation).where(
                Conversation.id == UUID(data["id"]),
                Conversation.user_id == user.id,
            )
        )
        assert conversation is not None


def test_send_message_returns_user_and_assistant_messages() -> None:
    _, headers = create_authenticated_user("chat@example.com")
    create_response = client.post(
        "/api/v1/conversations",
        json={},
        headers=headers,
    )
    assert create_response.status_code == 201
    conversation_id = create_response.json()["id"]

    with patch(
        "app.services.conversations.build_chat_graph",
        return_value=fake_graph("Hello!"),
    ):
        response = client.post(
            f"/api/v1/conversations/{conversation_id}/messages",
            json={"content": "Hi"},
            headers=headers,
        )

    assert response.status_code == 200
    data = response.json()
    assert data["user_message"]["content"] == "Hi"
    assert data["user_message"]["role"] == "user"
    assert data["assistant_message"]["content"] == "Hello!"
    assert data["assistant_message"]["role"] == "assistant"


def test_list_messages_returns_history_in_order() -> None:
    _, headers = create_authenticated_user("history@example.com")
    create_response = client.post(
        "/api/v1/conversations",
        json={},
        headers=headers,
    )
    assert create_response.status_code == 201
    conversation_id = create_response.json()["id"]

    with patch(
        "app.services.conversations.build_chat_graph",
        return_value=fake_graph("Hello!"),
    ):
        send_response = client.post(
            f"/api/v1/conversations/{conversation_id}/messages",
            json={"content": "Hi"},
            headers=headers,
        )
    assert send_response.status_code == 200

    response = client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=headers,
    )

    assert response.status_code == 200
    assert [message["role"] for message in response.json()] == [
        "user",
        "assistant",
    ]


def test_user_cannot_access_another_users_conversation() -> None:
    _, owner_headers = create_authenticated_user("first@example.com")
    _, other_headers = create_authenticated_user("second@example.com")

    create_response = client.post(
        "/api/v1/conversations",
        json={},
        headers=owner_headers,
    )
    assert create_response.status_code == 201
    conversation_id = create_response.json()["id"]

    history_response = client.get(
        f"/api/v1/conversations/{conversation_id}/messages",
        headers=other_headers,
    )
    assert history_response.status_code == 404

    with patch(
        "app.services.conversations.build_chat_graph",
        return_value=fake_graph(),
    ) as graph:
        message_response = client.post(
            f"/api/v1/conversations/{conversation_id}/messages",
            json={"content": "Unauthorized"},
            headers=other_headers,
        )

    assert message_response.status_code == 404
    graph.assert_not_called()


def test_message_endpoint_maps_model_failure_to_502() -> None:
    _, headers = create_authenticated_user("failure@example.com")
    create_response = client.post(
        "/api/v1/conversations",
        json={},
        headers=headers,
    )
    assert create_response.status_code == 201
    conversation_id = create_response.json()["id"]

    with patch(
        "app.services.conversations.build_chat_graph",
        side_effect=RuntimeError("Simulated provider failure"),
    ):
        response = client.post(
            f"/api/v1/conversations/{conversation_id}/messages",
            json={"content": "Hi"},
            headers=headers,
        )

    assert response.status_code == 502
    assert response.json()["detail"] == ("The assistant could not generate a response.")

    with TestingSessionLocal() as db:
        saved_messages = list(
            db.scalars(
                select(Message).where(Message.conversation_id == UUID(conversation_id))
            )
        )
        assert saved_messages == []


def test_message_endpoint_rejects_empty_content() -> None:
    _, headers = create_authenticated_user("validation@example.com")
    create_response = client.post(
        "/api/v1/conversations",
        json={},
        headers=headers,
    )
    assert create_response.status_code == 201
    conversation_id = create_response.json()["id"]

    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": ""},
        headers=headers,
    )

    assert response.status_code == 422


def test_list_conversations_requires_authentication() -> None:
    response = client.get("/api/v1/conversations")

    assert response.status_code == 401


def test_list_conversations_returns_only_current_users_conversations() -> None:
    _, owner_headers = create_authenticated_user("list-owner@example.com")
    _, other_headers = create_authenticated_user("list-other@example.com")

    owner_response = client.post(
        "/api/v1/conversations",
        json={"title": "Owner conversation"},
        headers=owner_headers,
    )
    other_response = client.post(
        "/api/v1/conversations",
        json={"title": "Other user's conversation"},
        headers=other_headers,
    )

    assert owner_response.status_code == 201
    assert other_response.status_code == 201

    response = client.get(
        "/api/v1/conversations",
        headers=owner_headers,
    )

    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["id"] == owner_response.json()["id"]
    assert data[0]["title"] == "Owner conversation"


def test_list_conversations_returns_newest_updated_first() -> None:
    _, headers = create_authenticated_user("list-order@example.com")

    older_response = client.post(
        "/api/v1/conversations",
        json={"title": "Older conversation"},
        headers=headers,
    )
    newer_response = client.post(
        "/api/v1/conversations",
        json={"title": "Newer conversation"},
        headers=headers,
    )

    assert older_response.status_code == 201
    assert newer_response.status_code == 201

    # Assign distinct timestamps instead of relying on creation timing.
    base_time = datetime(2026, 1, 1, tzinfo=UTC)

    with TestingSessionLocal() as db:
        older = db.get(Conversation, UUID(older_response.json()["id"]))
        newer = db.get(Conversation, UUID(newer_response.json()["id"]))

        assert older is not None
        assert newer is not None

        older.updated_at = base_time
        newer.updated_at = base_time + timedelta(minutes=1)
        db.commit()

    response = client.get(
        "/api/v1/conversations",
        headers=headers,
    )

    assert response.status_code == 200
    titles = [conversation["title"] for conversation in response.json()]
    assert titles == ["Newer conversation", "Older conversation"]
