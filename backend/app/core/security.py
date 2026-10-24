from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from pwdlib import PasswordHash

from app.core.config import get_settings

password_hash = PasswordHash.recommended()


def hash_password(password: str) -> str:
    """Hash a plaintext password using the recommended password hasher."""
    return password_hash.hash(password)


def verify_password(password: str, hashed_password: str) -> bool:
    """Verify a plaintext password against its stored hash."""
    return password_hash.verify(password, hashed_password)


def _get_jwt_secret() -> str:
    secret = get_settings().jwt_secret_key
    if secret is None or not secret.get_secret_value():
        raise RuntimeError("JWT_SECRET_KEY must be configured to issue tokens.")
    return secret.get_secret_value()


def create_access_token(
    subject: str,
    expires_delta: timedelta | None = None,
) -> str:
    """Create a signed JWT access token for a user identifier."""
    if not subject:
        raise ValueError("Token subject must not be empty.")

    settings = get_settings()
    now = datetime.now(UTC)
    expires_at = now + (
        expires_delta
        if expires_delta is not None
        else timedelta(minutes=settings.access_token_expire_minutes)
    )

    payload: dict[str, Any] = {
        "sub": subject,
        "iat": now,
        "exp": expires_at,
    }

    return jwt.encode(
        payload,
        _get_jwt_secret(),
        algorithm="HS256",
    )


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a signed access token."""
    payload = jwt.decode(
        token,
        _get_jwt_secret(),
        algorithms=["HS256"],
        options={"require": ["sub", "iat", "exp"]},
    )

    subject = payload.get("sub")
    if not isinstance(subject, str) or not subject:
        raise jwt.InvalidTokenError("Invalid token subject.")

    return payload
