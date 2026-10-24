from collections.abc import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings

settings = get_settings()

engine: Engine = create_engine(
    settings.get_database_url(),
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    autocommit=False,
)


def get_db() -> Generator[Session]:
    """Provide a database session for a single request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database_connection() -> bool:
    """Check whether the database is reachable."""
    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return True
