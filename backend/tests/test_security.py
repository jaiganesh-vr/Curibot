from datetime import timedelta

import jwt
import pytest
from pydantic import SecretStr

from app.core.config import Settings
from app.core.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


def test_password_hash_and_verify() -> None:
    password = "test-password-for-unit-tests"
    hashed_password = hash_password(password)

    assert hashed_password != password
    assert verify_password(password, hashed_password)
    assert not verify_password("incorrect-password", hashed_password)


def test_valid_access_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(
            jwt_secret_key=SecretStr("unit-test-secret-not-for-production"),
        ),
    )

    token = create_access_token("test-user-id")
    payload = decode_access_token(token)

    assert payload["sub"] == "test-user-id"
    assert "iat" in payload
    assert "exp" in payload


def test_expired_access_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(
            jwt_secret_key=SecretStr("unit-test-secret-not-for-production"),
        ),
    )

    token = create_access_token(
        "test-user-id",
        expires_delta=timedelta(seconds=-1),
    )

    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(token)


def test_invalid_signature(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(
            jwt_secret_key=SecretStr("unit-test-secret-not-for-production"),
        ),
    )

    token = create_access_token("test-user-id")
    header, payload, signature = token.split(".")
    replacement = "A" if signature[0] != "A" else "B"
    tampered_token = f"{header}.{payload}.{replacement}{signature[1:]}"

    with pytest.raises(jwt.InvalidSignatureError):
        decode_access_token(tampered_token)


def test_token_creation_requires_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(jwt_secret_key=None),
    )

    with pytest.raises(RuntimeError, match="JWT_SECRET_KEY"):
        create_access_token("test-user-id")
