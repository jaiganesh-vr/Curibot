from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import URL, make_url

PROJECT_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str | None = None
    postgres_password: SecretStr | None = None
    jwt_secret_key: SecretStr | None = None
    access_token_expire_minutes: int = 30
    groq_api_key: SecretStr | None = None
    groq_model: str = "openai/gpt-oss-120b"

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
