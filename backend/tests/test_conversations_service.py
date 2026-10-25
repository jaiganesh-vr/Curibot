from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import ConfigDict
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import Message, User
from app.services.conversations import (
    ChatGenerationError,
    ConversationNotFoundError,
    create_conversation,
    delete_conversation,
    rename_conversation,
    send_message,
)
from tests.test_conversation_persistence import (
    create_user,
)


class FakeChatModel(BaseChatModel):
    """A deterministic chat model for service tests."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    response: str = "Hello from the fake model"

    @property
    def _llm_type(self) -> str:
        return "fake-chat-model"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(
            generations=[ChatGeneration(message=AIMessage(content=self.response))]
        )


def test_create_conversation(db_session: Session) -> None:
    user = create_user(db_session)

    conversation = create_conversation(
        db_session,
        user,
        title="Service test",
    )

    assert conversation.user_id == user.id
    assert conversation.title == "Service test"


def test_send_message_persists_user_and_assistant(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    user_message, assistant_message = send_message(
        db_session,
        user,
        conversation.id,
        "Hi",
        model=FakeChatModel(response="Hello!"),
    )

    assert user_message.role == "user"
    assert user_message.content == "Hi"
    assert assistant_message.role == "assistant"
    assert assistant_message.content == "Hello!"
    assert user_message.conversation_id == conversation.id
    assert assistant_message.conversation_id == conversation.id
    assert user_message.created_at <= assistant_message.created_at

    saved_messages = list(
        db_session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at, Message.id)
        )
    )
    assert [message.role for message in saved_messages] == [
        "user",
        "assistant",
    ]


def test_first_message_sets_title_and_updates_activity(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    _, assistant_message = send_message(
        db_session,
        user,
        conversation.id,
        "  Plan a   trip\nto Japan " + "x" * 100,
        model=FakeChatModel(),
    )
    db_session.refresh(conversation)

    assert conversation.title == ("Plan a trip to Japan " + "x" * 100)[:60]
    assert conversation.updated_at == assistant_message.created_at

    send_message(
        db_session,
        user,
        conversation.id,
        "A different follow-up",
        model=FakeChatModel(),
    )
    db_session.refresh(conversation)

    assert conversation.title == ("Plan a trip to Japan " + "x" * 100)[:60]


def test_send_message_includes_prior_history(
    db_session: Session,
) -> None:
    base_time = datetime.now(UTC)
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)
    db_session.add_all(
        [
            Message(
                conversation_id=conversation.id,
                role="user",
                content="My name is Sam.",
                created_at=base_time,
            ),
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content="Nice to meet you, Sam.",
                created_at=base_time + timedelta(seconds=1),
            ),
        ]
    )
    db_session.commit()

    class HistoryCheckingModel(FakeChatModel):
        received_messages: list = []

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            self.received_messages = list(messages)
            return super()._generate(messages, stop, run_manager, **kwargs)

    model = HistoryCheckingModel(response="Your name is Sam.")
    send_message(
        db_session,
        user,
        conversation.id,
        "What is my name?",
        model=model,
    )

    assert len(model.received_messages) == 3
    assert isinstance(model.received_messages[0], HumanMessage)
    assert model.received_messages[0].content == "My name is Sam."
    assert isinstance(model.received_messages[1], AIMessage)
    assert model.received_messages[1].content == "Nice to meet you, Sam."
    assert model.received_messages[2].content == "What is my name?"


def test_send_message_rejects_missing_conversation(
    db_session: Session,
) -> None:
    user = create_user(db_session)

    with pytest.raises(ConversationNotFoundError):
        send_message(
            db_session,
            user,
            uuid4(),
            "Hello",
            model=FakeChatModel(),
        )


def test_send_message_rejects_another_users_conversation(
    db_session: Session,
) -> None:
    owner = create_user(db_session, "owner@example.com")
    other_user = create_user(db_session, "other@example.com")
    conversation = create_conversation(db_session, owner)

    with pytest.raises(ConversationNotFoundError):
        send_message(
            db_session,
            other_user,
            conversation.id,
            "Access someone else's conversation",
            model=FakeChatModel(),
        )


def test_model_failure_does_not_persist_new_messages(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FailingModel(FakeChatModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            raise RuntimeError("Simulated model failure")

    with pytest.raises(ChatGenerationError):
        send_message(
            db_session,
            user,
            conversation.id,
            "This should not be saved",
            model=FailingModel(),
        )

    saved_messages = list(
        db_session.scalars(
            select(Message).where(Message.conversation_id == conversation.id)
        )
    )
    assert saved_messages == []


def test_create_conversation_requires_persisted_user(
    db_session: Session,
) -> None:
    user = User(email="unpersisted@example.com", hashed_password="test-hash")

    with pytest.raises(IntegrityError):
        create_conversation(db_session, user, title="Invalid owner")


def test_checkpoint_missing_restores_database_history(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)
    base_time = datetime.now(UTC)

    db_session.add_all(
        [
            Message(
                conversation_id=conversation.id,
                role="user",
                content="My name is Sam.",
                created_at=base_time,
            ),
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content="Nice to meet you, Sam.",
                created_at=base_time + timedelta(seconds=1),
            ),
        ]
    )
    db_session.commit()

    class FakeCheckpointer:
        def get_tuple(self, config: dict[str, Any]) -> None:
            return None

    class FakeGraph:
        received_messages: list[Any] = []

        def invoke(
            self,
            state: dict[str, Any],
            config: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            self.received_messages = list(state["messages"])
            return {
                "messages": [
                    *state["messages"],
                    AIMessage(content="Your name is Sam."),
                ]
            }

    fake_graph = FakeGraph()
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: fake_graph,
    )

    send_message(
        db_session,
        user,
        conversation.id,
        "What is my name?",
        checkpointer=FakeCheckpointer(),  # type: ignore[arg-type]
    )

    assert len(fake_graph.received_messages) == 3
    assert fake_graph.received_messages[0].content == "My name is Sam."
    assert fake_graph.received_messages[1].content == "Nice to meet you, Sam."
    assert fake_graph.received_messages[2].content == "What is my name?"


def test_existing_checkpoint_receives_only_new_message(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FakeCheckpointer:
        def get_tuple(self, config: dict[str, Any]) -> SimpleNamespace:
            return SimpleNamespace(
                checkpoint={
                    "channel_values": {
                        "messages": [],
                    }
                }
            )

        def delete_thread(self, thread_id: str) -> None:
            raise AssertionError("A consistent checkpoint should not be deleted")

    class FakeGraph:
        received_messages: list[Any] = []
        received_config: dict[str, Any] | None = None

        def invoke(
            self,
            state: dict[str, Any],
            config: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            self.received_messages = list(state["messages"])
            self.received_config = config
            return {
                "messages": [
                    *state["messages"],
                    AIMessage(content="Hello again!"),
                ]
            }

    fake_graph = FakeGraph()
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: fake_graph,
    )

    send_message(
        db_session,
        user,
        conversation.id,
        "Hello again",
        checkpointer=FakeCheckpointer(),  # type: ignore[arg-type]
    )

    assert len(fake_graph.received_messages) == 1
    assert isinstance(fake_graph.received_messages[0], HumanMessage)
    assert fake_graph.received_messages[0].content == "Hello again"
    assert fake_graph.received_config == {
        "configurable": {"thread_id": str(conversation.id)}
    }


def test_stale_checkpoint_is_discarded_and_history_restored(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)
    base_time = datetime.now(UTC)

    db_session.add_all(
        [
            Message(
                conversation_id=conversation.id,
                role="user",
                content="Persisted question",
                created_at=base_time,
            ),
            Message(
                conversation_id=conversation.id,
                role="assistant",
                content="Persisted answer",
                created_at=base_time + timedelta(seconds=1),
            ),
        ]
    )
    db_session.commit()

    class FakeCheckpointer:
        deleted_thread_id: str | None = None

        def get_tuple(self, config: dict[str, Any]) -> SimpleNamespace:
            return SimpleNamespace(
                checkpoint={
                    "channel_values": {
                        "messages": [
                            HumanMessage(content="Stale question"),
                            AIMessage(content="Stale answer"),
                        ]
                    }
                }
            )

        def delete_thread(self, thread_id: str) -> None:
            self.deleted_thread_id = thread_id

    class FakeGraph:
        received_messages: list[Any] = []

        def invoke(
            self,
            state: dict[str, Any],
            config: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            self.received_messages = list(state["messages"])
            return {
                "messages": [
                    *state["messages"],
                    AIMessage(content="Recovered answer"),
                ]
            }

    fake_checkpointer = FakeCheckpointer()
    fake_graph = FakeGraph()

    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: fake_graph,
    )

    send_message(
        db_session,
        user,
        conversation.id,
        "Next question",
        checkpointer=fake_checkpointer,  # type: ignore[arg-type]
    )

    assert fake_checkpointer.deleted_thread_id == str(conversation.id)
    assert [message.content for message in fake_graph.received_messages] == [
        "Persisted question",
        "Persisted answer",
        "Next question",
    ]


def test_retry_discards_stale_checkpoint_after_model_failure(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FakeCheckpointer:
        deleted_thread_id: str | None = None
        stale = False

        def get_tuple(self, config: dict[str, Any]) -> SimpleNamespace | None:
            if not self.stale:
                return None

            return SimpleNamespace(
                checkpoint={
                    "channel_values": {
                        "messages": [
                            HumanMessage(content="Failed question"),
                        ]
                    }
                }
            )

        def delete_thread(self, thread_id: str) -> None:
            self.deleted_thread_id = thread_id
            self.stale = False

    class FakeGraph:
        received_messages: list[Any] = []

        def invoke(
            self,
            state: dict[str, Any],
            config: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            self.received_messages = list(state["messages"])
            if self.received_messages[-1].content == "Failed question":
                checkpointer.stale = True
                raise RuntimeError("Simulated model failure")

            return {
                "messages": [
                    *state["messages"],
                    AIMessage(content="Recovered successfully"),
                ]
            }

    checkpointer = FakeCheckpointer()
    fake_graph = FakeGraph()

    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: fake_graph,
    )

    with pytest.raises(ChatGenerationError):
        send_message(
            db_session,
            user,
            conversation.id,
            "Failed question",
            checkpointer=checkpointer,  # type: ignore[arg-type]
        )

    saved_messages = list(
        db_session.scalars(
            select(Message).where(Message.conversation_id == conversation.id)
        )
    )
    assert saved_messages == []

    user_message, assistant_message = send_message(
        db_session,
        user,
        conversation.id,
        "Retry question",
        checkpointer=checkpointer,  # type: ignore[arg-type]
    )

    assert checkpointer.deleted_thread_id == str(conversation.id)
    assert [message.content for message in fake_graph.received_messages] == [
        "Retry question"
    ]
    assert user_message.content == "Retry question"
    assert assistant_message.content == "Recovered successfully"


def test_commit_failure_discards_stale_checkpoint_on_retry(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FakeCheckpointer:
        messages: list[Any] = []
        deleted_thread_id: str | None = None

        def get_tuple(self, config: dict[str, Any]) -> SimpleNamespace | None:
            if not self.messages:
                return None

            return SimpleNamespace(
                checkpoint={"channel_values": {"messages": list(self.messages)}}
            )

        def delete_thread(self, thread_id: str) -> None:
            self.deleted_thread_id = thread_id
            self.messages = []

    checkpointer = FakeCheckpointer()

    class FakeGraph:
        received_messages: list[Any] = []

        def invoke(
            self,
            state: dict[str, Any],
            config: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            self.received_messages = list(state["messages"])
            response = AIMessage(content="Generated answer")

            # Simulate LangGraph having saved the attempted turn.
            checkpointer.messages = [
                *state["messages"],
                response,
            ]

            return {"messages": checkpointer.messages}

    fake_graph = FakeGraph()

    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: fake_graph,
    )

    original_commit = db_session.commit
    commit_calls = 0

    def failing_commit() -> None:
        nonlocal commit_calls
        commit_calls += 1

        if commit_calls == 1:
            raise SQLAlchemyError("Simulated database commit failure")

        original_commit()

    monkeypatch.setattr(db_session, "commit", failing_commit)

    with pytest.raises(SQLAlchemyError, match="Simulated database commit failure"):
        send_message(
            db_session,
            user,
            conversation.id,
            "Failed question",
            checkpointer=checkpointer,  # type: ignore[arg-type]
        )

    db_session.rollback()

    saved_messages = list(
        db_session.scalars(
            select(Message).where(Message.conversation_id == conversation.id)
        )
    )
    assert saved_messages == []

    user_message, assistant_message = send_message(
        db_session,
        user,
        conversation.id,
        "Retry question",
        checkpointer=checkpointer,  # type: ignore[arg-type]
    )

    assert checkpointer.deleted_thread_id == str(conversation.id)
    assert [message.content for message in fake_graph.received_messages] == [
        "Retry question"
    ]
    assert user_message.content == "Retry question"
    assert assistant_message.content == "Generated answer"


def test_rename_keeps_activity_ordering(db_session: Session) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)
    original_updated_at = conversation.updated_at

    renamed = rename_conversation(db_session, user, conversation.id, "Renamed")

    assert renamed.title == "Renamed"
    assert renamed.updated_at == original_updated_at


def test_delete_conversation_removes_messages_and_checkpoint(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)
    send_message(db_session, user, conversation.id, "Hi", model=FakeChatModel())

    class FakeCheckpointer:
        def __init__(self) -> None:
            self.deleted_threads: list[str] = []

        def delete_thread(self, thread_id: str) -> None:
            self.deleted_threads.append(thread_id)

    checkpointer = FakeCheckpointer()
    delete_conversation(
        db_session,
        user,
        conversation.id,
        checkpointer=checkpointer,  # type: ignore[arg-type]
    )

    assert db_session.scalars(select(Message)).all() == []
    assert checkpointer.deleted_threads == [str(conversation.id)]

    with pytest.raises(ConversationNotFoundError):
        delete_conversation(db_session, user, conversation.id)


def test_delete_conversation_tolerates_checkpoint_failure(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FailingCheckpointer:
        def delete_thread(self, thread_id: str) -> None:
            raise RuntimeError("checkpoint store unavailable")

    delete_conversation(
        db_session,
        user,
        conversation.id,
        checkpointer=FailingCheckpointer(),  # type: ignore[arg-type]
    )

    with pytest.raises(ConversationNotFoundError):
        delete_conversation(db_session, user, conversation.id)


def test_stream_message_yields_tokens_then_persists_turn(
    db_session: Session,
) -> None:
    from langchain_core.language_models.fake_chat_models import (
        GenericFakeChatModel,
    )

    from app.services.conversations import CompletedEvent, TokenEvent, stream_message

    user = create_user(db_session)
    conversation = create_conversation(db_session, user)
    model = GenericFakeChatModel(messages=iter([AIMessage(content="Hello there")]))

    events = list(stream_message(db_session, user, conversation.id, "Hi", model=model))

    tokens = [event.text for event in events if isinstance(event, TokenEvent)]
    assert len(tokens) > 1
    assert "".join(tokens) == "Hello there"

    completed = events[-1]
    assert isinstance(completed, CompletedEvent)
    assert completed.user_message.content == "Hi"
    assert completed.assistant_message.content == "Hello there"

    db_session.refresh(conversation)
    assert conversation.title == "Hi"
    assert len(db_session.scalars(select(Message)).all()) == 2


def test_stream_message_failure_persists_nothing(db_session: Session) -> None:
    from app.services.conversations import stream_message

    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FailingModel(FakeChatModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            raise RuntimeError("model unavailable")

    with pytest.raises(ChatGenerationError):
        list(
            stream_message(
                db_session, user, conversation.id, "Hi", model=FailingModel()
            )
        )

    assert db_session.scalars(select(Message)).all() == []


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("Hello", "Hello"),
        ("  Plan a   trip\nto Japan\t", "Plan a trip to Japan"),
        ("x" * 80, "x" * 60),
        ("   \n\t ", None),
    ],
)
def test_derive_title(content: str, expected: str | None) -> None:
    from app.services.conversations import derive_title

    assert derive_title(content) == expected


def test_stream_message_uses_checkpoint_and_skips_other_nodes(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from langchain_core.messages import AIMessageChunk

    from app.services.conversations import CompletedEvent, TokenEvent, stream_message

    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    class FakeCheckpointer:
        def get_tuple(self, config: dict[str, Any]) -> SimpleNamespace:
            return SimpleNamespace(checkpoint={"channel_values": {"messages": []}})

        def delete_thread(self, thread_id: str) -> None:
            raise AssertionError("A consistent checkpoint should not be deleted")

    class FakeStreamingGraph:
        received_messages: list[Any] = []
        received_config: dict[str, Any] | None = None

        def stream(
            self,
            state: dict[str, Any],
            config: dict[str, Any] | None = None,
            stream_mode: str | None = None,
        ) -> Any:
            assert stream_mode == "messages"
            self.received_messages = list(state["messages"])
            self.received_config = config
            yield AIMessageChunk(content="ignored"), {"langgraph_node": "other"}
            yield AIMessageChunk(content="Hel"), {"langgraph_node": "call_model"}
            yield AIMessageChunk(content=""), {"langgraph_node": "call_model"}
            yield AIMessageChunk(content="lo"), {"langgraph_node": "call_model"}

    fake_graph = FakeStreamingGraph()
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: fake_graph,
    )

    events = list(
        stream_message(
            db_session,
            user,
            conversation.id,
            "Hi again",
            checkpointer=FakeCheckpointer(),  # type: ignore[arg-type]
        )
    )

    assert [e.text for e in events if isinstance(e, TokenEvent)] == ["Hel", "lo"]
    completed = events[-1]
    assert isinstance(completed, CompletedEvent)
    assert completed.assistant_message.content == "Hello"

    assert [message.content for message in fake_graph.received_messages] == ["Hi again"]
    assert fake_graph.received_config == {
        "configurable": {"thread_id": str(conversation.id)}
    }


def test_stream_message_rejects_another_users_conversation(
    db_session: Session,
) -> None:
    from app.services.conversations import stream_message

    owner = create_user(db_session)
    other = create_user(db_session, email="other@example.com")
    conversation = create_conversation(db_session, owner)

    with pytest.raises(ConversationNotFoundError):
        list(
            stream_message(
                db_session, other, conversation.id, "Hi", model=FakeChatModel()
            )
        )
