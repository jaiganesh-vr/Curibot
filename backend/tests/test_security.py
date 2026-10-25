from datetime import UTC, datetime, timedelta

import jwt
import pytest
from pydantic import SecretStr
from sqlalchemy.engine import URL
from sqlalchemy.exc import ArgumentError

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


def test_future_issued_access_token_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "unit-test-secret-not-for-production"

    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(jwt_secret_key=SecretStr(secret)),
    )

    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "sub": "test-user-id",
            "iat": now + timedelta(minutes=5),
            "exp": now + timedelta(minutes=10),
        },
        secret,
        algorithm="HS256",
    )

    with pytest.raises(jwt.InvalidTokenError):
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


def test_development_settings_are_allowed_without_production_secrets() -> None:
    settings = Settings(
        app_env="development",
        jwt_secret_key=None,
        database_url=None,
        postgres_password=None,
        groq_api_key=None,
    )

    assert settings.app_env == "development"


def test_production_settings_reject_missing_jwt_secret() -> None:
    with pytest.raises(ValueError, match="JWT_SECRET_KEY"):
        Settings(
            app_env="production",
            cors_origins=["https://frontend.example.com"],
            jwt_secret_key=None,
            database_url="postgresql://app:password@localhost/test",
            groq_api_key=SecretStr("test-groq-key"),
        )


def test_production_settings_reject_short_jwt_secret() -> None:
    with pytest.raises(ValueError, match="at least 32 characters"):
        Settings(
            app_env="production",
            cors_origins=["https://frontend.example.com"],
            jwt_secret_key=SecretStr("too-short"),
            database_url="postgresql://app:password@localhost/test",
            groq_api_key=SecretStr("test-groq-key"),
        )


def test_production_settings_reject_missing_database() -> None:
    with pytest.raises(ValueError, match="DATABASE_URL or POSTGRES_PASSWORD"):
        Settings(
            app_env="production",
            cors_origins=["https://frontend.example.com"],
            jwt_secret_key=SecretStr("x" * 40),
            database_url=None,
            postgres_password=None,
            groq_api_key=SecretStr("test-groq-key"),
        )


def test_production_settings_reject_missing_groq_key() -> None:
    with pytest.raises(ValueError, match="GROQ_API_KEY"):
        Settings(
            app_env="production",
            cors_origins=["https://frontend.example.com"],
            jwt_secret_key=SecretStr("x" * 40),
            database_url="postgresql://app:password@localhost/test",
            groq_api_key=None,
        )


def test_valid_production_settings_are_accepted() -> None:
    settings = Settings(
        app_env="production",
        cors_origins=["https://frontend.example.com"],
        jwt_secret_key=SecretStr("x" * 40),
        database_url="postgresql://app:password@localhost/test",
        groq_api_key=SecretStr("test-groq-key"),
    )

    assert settings.app_env == "production"


@pytest.mark.parametrize(
    "missing_claim",
    ["sub", "iat", "exp"],
)
def test_access_token_missing_required_claim_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    missing_claim: str,
) -> None:
    secret = "unit-test-secret-not-for-production"

    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(jwt_secret_key=SecretStr(secret)),
    )

    now = datetime.now(UTC)
    payload = {
        "sub": "test-user-id",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    del payload[missing_claim]

    token = jwt.encode(payload, secret, algorithm="HS256")

    with pytest.raises(jwt.MissingRequiredClaimError):
        decode_access_token(token)


@pytest.mark.parametrize(
    "token",
    [
        "",
        "not-a-jwt",
        "header.payload",
        "a.b.c",
    ],
)
def test_malformed_access_token_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    token: str,
) -> None:
    monkeypatch.setattr(
        "app.core.security.get_settings",
        lambda: Settings(
            jwt_secret_key=SecretStr("unit-test-secret-not-for-production"),
        ),
    )

    with pytest.raises(jwt.InvalidTokenError):
        decode_access_token(token)


def test_database_url_adds_psycopg_driver() -> None:
    settings = Settings(
        database_url="postgresql://app:password@localhost/test",
    )

    url = settings.get_database_url()

    assert isinstance(url, URL)
    assert url.drivername == "postgresql+psycopg"
    assert url.database == "test"


def test_database_url_preserves_existing_driver() -> None:
    settings = Settings(
        database_url="postgresql+psycopg://app:password@localhost/test",
    )

    url = settings.get_database_url()

    assert url.drivername == "postgresql+psycopg"
    assert url.database == "test"


def test_database_url_requires_configuration() -> None:
    settings = Settings(
        database_url=None,
        postgres_password=None,
    )

    with pytest.raises(ValueError, match="Configure DATABASE_URL"):
        settings.get_database_url()


def test_malformed_database_url_is_rejected() -> None:
    settings = Settings(database_url="not-a-valid-database-url")

    with pytest.raises(ArgumentError):
        settings.get_database_url()


def test_default_cors_origins_allow_local_development() -> None:
    settings = Settings()

    assert settings.cors_origins == [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]


def test_cors_origins_can_be_configured() -> None:
    settings = Settings(
        cors_origins=["https://frontend.example.com"],
    )

    assert settings.cors_origins == [
        "https://frontend.example.com",
    ]


def test_production_settings_reject_default_cors_origins() -> None:
    with pytest.raises(ValueError, match="development origins"):
        Settings(
            app_env="production",
            cors_origins=[
                "http://localhost:5173",
                "http://127.0.0.1:5173",
            ],
            jwt_secret_key=SecretStr("x" * 40),
            database_url="postgresql://app:password@localhost/test",
            groq_api_key=SecretStr("test-groq-key"),
        )


def test_production_settings_accept_custom_cors_origin() -> None:
    settings = Settings(
        app_env="production",
        cors_origins=["https://frontend.example.com"],
        jwt_secret_key=SecretStr("x" * 40),
        database_url="postgresql://app:password@localhost/test",
        groq_api_key=SecretStr("test-groq-key"),
    )

    assert settings.cors_origins == ["https://frontend.example.com"]


def test_production_settings_reject_empty_cors_origins() -> None:
    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        Settings(
            app_env="production",
            cors_origins=[],
            jwt_secret_key=SecretStr("x" * 40),
            database_url="postgresql://app:password@localhost/test",
            groq_api_key=SecretStr("test-groq-key"),
        )
