from collections.abc import Generator
from datetime import timedelta
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.security import create_access_token, verify_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import User

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


def override_get_db() -> Generator[Session]:
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db
client = TestClient(app)


def setup_function() -> None:
    Base.metadata.create_all(bind=test_engine)


def teardown_function() -> None:
    Base.metadata.drop_all(bind=test_engine)


def test_register_creates_user_without_exposing_password_hash() -> None:
    password = "a-secure-test-password"
    response = client.post(
        "/api/v1/auth/register",
        json={"email": "NewUser@example.com", "password": password},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["email"] == "newuser@example.com"
    assert data["is_active"] is True
    assert "hashed_password" not in data
    assert "password" not in data

    with TestingSessionLocal() as db:
        user = db.scalar(select(User).where(User.email == "newuser@example.com"))
        assert user is not None
        assert user.hashed_password != password
        assert verify_password(password, user.hashed_password)


def test_register_rejects_duplicate_email() -> None:
    payload = {
        "email": "duplicate@example.com",
        "password": "a-secure-test-password",
    }
    first = client.post("/api/v1/auth/register", json=payload)
    second = client.post("/api/v1/auth/register", json=payload)

    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["detail"] == ("An account with this email already exists.")


def test_register_rejects_invalid_email() -> None:
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "not-an-email",
            "password": "a-secure-test-password",
        },
    )

    assert response.status_code == 422


def test_register_rejects_short_password() -> None:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": "short@example.com", "password": "short"},
    )

    assert response.status_code == 422


def test_me_rejects_missing_token() -> None:
    response = client.get("/api/v1/auth/me")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_me_rejects_invalid_token() -> None:
    response = client.get(
        "/api/v1/auth/me",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401


def test_me_returns_authenticated_user() -> None:
    from unittest.mock import patch

    from pydantic import SecretStr

    password = "a-secure-test-password"
    registration = client.post(
        "/api/v1/auth/register",
        json={"email": "profile@example.com", "password": password},
    )
    assert registration.status_code == 201
    user_id = registration.json()["id"]

    test_settings = type(
        "TestSettings",
        (),
        {
            "jwt_secret_key": SecretStr(
                "unit-test-secret-not-production-32-bytes-minimum"
            ),
            "access_token_expire_minutes": 30,
        },
    )()

    with patch("app.core.security.get_settings", return_value=test_settings):
        token = create_access_token(subject=user_id)
        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == user_id
    assert data["email"] == "profile@example.com"
    assert "hashed_password" not in data


def test_me_rejects_expired_token() -> None:
    from unittest.mock import patch

    from pydantic import SecretStr

    test_settings = type(
        "TestSettings",
        (),
        {
            "jwt_secret_key": SecretStr(
                "unit-test-secret-not-production-32-bytes-minimum"
            ),
            "access_token_expire_minutes": 30,
        },
    )()

    with patch("app.core.security.get_settings", return_value=test_settings):
        token = create_access_token(
            subject="00000000-0000-0000-0000-000000000001",
            expires_delta=timedelta(seconds=-1),
        )

        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 401
    assert response.json()["detail"] == (
        "Invalid or expired authentication credentials."
    )


def test_me_rejects_inactive_user() -> None:
    from unittest.mock import patch

    from pydantic import SecretStr

    password = "a-secure-test-password"

    registration = client.post(
        "/api/v1/auth/register",
        json={
            "email": "inactive@example.com",
            "password": password,
        },
    )
    assert registration.status_code == 201
    user_id = registration.json()["id"]

    with TestingSessionLocal() as db:
        user = db.scalar(select(User).where(User.id == UUID(user_id)))
        assert user is not None
        user.is_active = False
        db.commit()

    test_settings = type(
        "TestSettings",
        (),
        {
            "jwt_secret_key": SecretStr(
                "unit-test-secret-not-production-32-bytes-minimum"
            ),
            "access_token_expire_minutes": 30,
        },
    )()

    with patch("app.core.security.get_settings", return_value=test_settings):
        token = create_access_token(subject=user_id)

        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json()["detail"] == (
        "Invalid or expired authentication credentials."
    )


def test_me_rejects_token_for_nonexistent_user() -> None:
    from unittest.mock import patch
    from uuid import uuid4

    from pydantic import SecretStr

    test_settings = type(
        "TestSettings",
        (),
        {
            "jwt_secret_key": SecretStr(
                "unit-test-secret-not-production-32-bytes-minimum"
            ),
            "access_token_expire_minutes": 30,
        },
    )()

    nonexistent_user_id = str(uuid4())

    with patch("app.core.security.get_settings", return_value=test_settings):
        token = create_access_token(subject=nonexistent_user_id)

        response = client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert response.json()["detail"] == (
        "Invalid or expired authentication credentials."
    )
