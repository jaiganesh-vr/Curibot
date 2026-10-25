from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    app_env: Literal["development", "test", "production"] = "development"
    database_url: str | None = None
    postgres_password: SecretStr | None = None
    jwt_secret_key: SecretStr | None = None
    access_token_expire_minutes: int = Field(default=30, gt=0)
    groq_api_key: SecretStr | None = None
    groq_model: str = "openai/gpt-oss-120b"
    # Approximate tokens of conversation history sent to the model per turn;
    # older messages are left out. Keep well below the model's context window
    # to leave room for the system prompt and the reply.
    context_max_tokens: int = Field(default=16_000, ge=1_000)

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        if self.app_env != "production":
            return self

        development_origins = {
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        }

        if not self.cors_origins:
            raise ValueError(
                "CORS_ORIGINS must contain at least one trusted origin in production."
            )

        if any(origin in development_origins for origin in self.cors_origins):
            raise ValueError(
                "CORS_ORIGINS must not contain development origins in production."
            )

        jwt_secret = (
            self.jwt_secret_key.get_secret_value()
            if self.jwt_secret_key is not None
            else ""
        )
        if len(jwt_secret) < 32:
            raise ValueError(
                "JWT_SECRET_KEY must contain at least 32 characters in production."
            )

        database_password = (
            self.postgres_password.get_secret_value()
            if self.postgres_password is not None
            else ""
        )
        if not (self.database_url or database_password):
            raise ValueError(
                "DATABASE_URL or POSTGRES_PASSWORD must be configured in production."
            )

        groq_key = (
            self.groq_api_key.get_secret_value()
            if self.groq_api_key is not None
            else ""
        )
        if not groq_key:
            raise ValueError("GROQ_API_KEY must be configured in production.")

        return self

    def get_database_url(self) -> URL:
        if self.database_url:
            url = make_url(self.database_url)
            if url.drivername == "postgresql":
                url = url.set(drivername="postgresql+psycopg")
            return url

        if self.postgres_password is None:
            raise ValueError(
                "Configure DATABASE_URL or POSTGRES_PASSWORD "
                "in the environment or root .env file."
            )

        return URL.create(
            drivername="postgresql+psycopg",
            username="app",
            password=self.postgres_password.get_secret_value(),
            host="localhost",
            port=5432,
            database="conversation_agent",
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
