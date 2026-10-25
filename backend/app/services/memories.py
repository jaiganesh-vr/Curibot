from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.models import UserMemory
from app.models.memory import MEMORY_MAX_LENGTH

MEMORY_LIMIT_PER_USER = 50


class MemoryNotFoundError(Exception):
    """Raised when a memory is missing or belongs to another user."""


class MemoryLimitError(Exception):
    """Raised when a user already has the maximum number of memories."""


def normalize_memory(content: str) -> str:
    """Collapse whitespace and validate length; raises ValueError if invalid."""
    text = " ".join(content.split())

    if not text:
        raise ValueError("A memory cannot be empty.")
    if len(text) > MEMORY_MAX_LENGTH:
        raise ValueError(f"A memory can be at most {MEMORY_MAX_LENGTH} characters.")

    return text


def list_memories(db: Session, user_id: UUID) -> list[UserMemory]:
    """Return a user's memories, oldest first."""
    return list(
        db.scalars(
            select(UserMemory)
            .where(UserMemory.user_id == user_id)
            .order_by(UserMemory.created_at, UserMemory.id)
        ).all()
    )


def save_memory(
    db: Session,
    user_id: UUID,
    content: str,
) -> tuple[UserMemory, bool]:
    """Add a memory, or return the existing one if it is a duplicate.

    Returns the memory and whether it was newly created. The change is
    flushed, not committed: during a chat turn it commits with the turn.
    """
    text = normalize_memory(content)

    existing = db.scalar(
        select(UserMemory).where(
            UserMemory.user_id == user_id,
            func.lower(UserMemory.content) == text.lower(),
        )
    )
    if existing is not None:
        return existing, False

    count = db.scalar(
        select(func.count())
        .select_from(UserMemory)
        .where(UserMemory.user_id == user_id)
    )
    if (count or 0) >= MEMORY_LIMIT_PER_USER:
        raise MemoryLimitError

    # Set in Python rather than by the database: Postgres now() is the
    # transaction start, so memories saved in one turn would tie and list
    # in random order.
    memory = UserMemory(user_id=user_id, content=text, created_at=datetime.now(UTC))
    db.add(memory)
    db.flush()
    return memory, True


def delete_memory(db: Session, user_id: UUID, memory_id: UUID) -> None:
    """Delete one of the user's memories (flushed, not committed)."""
    memory = db.scalar(
        select(UserMemory).where(
            UserMemory.id == memory_id,
            UserMemory.user_id == user_id,
        )
    )
    if memory is None:
        raise MemoryNotFoundError

    db.delete(memory)
    db.flush()


def clear_memories(db: Session, user_id: UUID) -> int:
    """Delete all of the user's memories (flushed, not committed)."""
    result = db.execute(delete(UserMemory).where(UserMemory.user_id == user_id))
    db.flush()
    return int(getattr(result, "rowcount", 0) or 0)
