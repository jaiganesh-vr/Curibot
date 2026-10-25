import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import User, UserMemory
from app.services.memories import (
    MEMORY_LIMIT_PER_USER,
    MemoryLimitError,
    MemoryNotFoundError,
    clear_memories,
    delete_memory,
    list_memories,
    normalize_memory,
    save_memory,
)
from tests.test_conversation_persistence import create_user


def test_save_normalizes_and_lists_in_order(db_session: Session) -> None:
    user = create_user(db_session)

    first, created = save_memory(db_session, user.id, "  Name is   Jaiganesh ")
    save_memory(db_session, user.id, "Prefers Python")

    assert created is True
    assert first.content == "Name is Jaiganesh"
    assert [m.content for m in list_memories(db_session, user.id)] == [
        "Name is Jaiganesh",
        "Prefers Python",
    ]


def test_duplicates_are_ignored_case_insensitively(db_session: Session) -> None:
    user = create_user(db_session)
    original, _ = save_memory(db_session, user.id, "Prefers Python")

    duplicate, created = save_memory(db_session, user.id, "prefers  PYTHON")

    assert created is False
    assert duplicate.id == original.id
    assert len(list_memories(db_session, user.id)) == 1


@pytest.mark.parametrize("content", ["", "   ", "x" * 301])
def test_invalid_memories_are_rejected(content: str) -> None:
    with pytest.raises(ValueError):
        normalize_memory(content)


def test_memory_limit_is_enforced(db_session: Session) -> None:
    user = create_user(db_session)
    for index in range(MEMORY_LIMIT_PER_USER):
        save_memory(db_session, user.id, f"Fact {index}")

    with pytest.raises(MemoryLimitError):
        save_memory(db_session, user.id, "One too many")


def test_memories_are_private_to_each_user(db_session: Session) -> None:
    owner = create_user(db_session)
    other = create_user(db_session, email="other@example.com")
    memory, _ = save_memory(db_session, owner.id, "Owner's fact")

    assert list_memories(db_session, other.id) == []
    with pytest.raises(MemoryNotFoundError):
        delete_memory(db_session, other.id, memory.id)


def test_delete_and_clear(db_session: Session) -> None:
    user = create_user(db_session)
    first, _ = save_memory(db_session, user.id, "First")
    save_memory(db_session, user.id, "Second")
    save_memory(db_session, user.id, "Third")

    delete_memory(db_session, user.id, first.id)
    assert [m.content for m in list_memories(db_session, user.id)] == [
        "Second",
        "Third",
    ]

    assert clear_memories(db_session, user.id) == 2
    assert list_memories(db_session, user.id) == []

    with pytest.raises(MemoryNotFoundError):
        delete_memory(db_session, user.id, uuid.uuid4())


def test_memories_are_deleted_with_their_user(db_session: Session) -> None:
    user = create_user(db_session)
    save_memory(db_session, user.id, "Will be removed")
    db_session.commit()

    db_session.delete(db_session.get(User, user.id))
    db_session.commit()

    assert db_session.scalars(select(UserMemory)).all() == []
