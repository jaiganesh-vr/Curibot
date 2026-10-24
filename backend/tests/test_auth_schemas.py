from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.schemas.auth import (
    TokenResponse,
    UserLoginRequest,
    UserRegisterRequest,
    UserResponse,
)


def test_registration_accepts_valid_input() -> None:
    request = UserRegisterRequest(
        email="jaiganesh@example.com",
        password="secure-test-password",
    )

    assert request.email == "jaiganesh@example.com"
    assert request.password == "secure-test-password"


def test_registration_rejects_invalid_email() -> None:
    with pytest.raises(ValidationError):
        UserRegisterRequest(
            email="not-an-email",
            password="secure-test-password",
        )


def test_registration_rejects_short_password() -> None:
    with pytest.raises(ValidationError):
        UserRegisterRequest(
            email="jaiganesh@example.com",
            password="short",
        )


def test_login_accepts_valid_input() -> None:
    request = UserLoginRequest(
        email="jaiganesh@example.com",
        password="x",
    )

    assert request.password == "x"


def test_user_response_does_not_expose_password_hash() -> None:
    response = UserResponse(
        id=uuid4(),
        email="jaiganesh@example.com",
        is_active=True,
        created_at=datetime.now(UTC),
    )

    data = response.model_dump()

    assert "hashed_password" not in data
    assert "password" not in data
    assert data["is_active"] is True


def test_token_response_uses_bearer_type() -> None:
    response = TokenResponse(access_token="test-token")

    assert response.token_type == "bearer"
