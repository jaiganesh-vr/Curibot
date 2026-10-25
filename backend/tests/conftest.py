from collections.abc import Generator

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings
from app.db.base import Base


@pytest.fixture(autouse=True)
def disable_web_search(monkeypatch: pytest.MonkeyPatch) -> Generator[None]:
    """Keep tests offline and tool-free regardless of the developer's .env.

    Environment variables override the .env file: an empty Tavily key turns
    web search off, and memory is turned off. Tests that need either pass
    tools or a MemoryAccess to build_chat_graph directly.
    """
    monkeypatch.setenv("TAVILY_API_KEY", "")
    monkeypatch.setenv("MEMORY_ENABLED", "false")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def db_session() -> Generator[Session]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection: object, _: object) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(bind=engine)

    try:
        with Session(engine) as session:
            yield session
            session.rollback()
    finally:
        Base.metadata.drop_all(bind=engine)
        engine.dispose()
