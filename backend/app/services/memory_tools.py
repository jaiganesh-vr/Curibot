from threading import Lock
from uuid import UUID

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.models.memory import MEMORY_MAX_LENGTH
from app.services.memories import (
    MEMORY_LIMIT_PER_USER,
    MemoryLimitError,
    MemoryNotFoundError,
    delete_memory,
    list_memories,
    save_memory,
)

SAVE_MEMORY_TOOL_NAME = "save_memory"
DELETE_MEMORY_TOOL_NAME = "delete_memory"


class MemoryAccess:
    """One user's memories, read and written within the current chat turn.

    LangGraph's ToolNode may run tool calls in parallel threads, and a
    SQLAlchemy session must not be used concurrently, so every operation
    takes a lock. Writes are flushed, so they commit or roll back with the
    turn.
    """

    def __init__(self, db: Session, user_id: UUID) -> None:
        self._db = db
        self._user_id = user_id
        self._lock = Lock()

    def contents(self) -> list[str]:
        with self._lock:
            return [memory.content for memory in list_memories(self._db, self._user_id)]

    def save(self, content: str) -> str:
        with self._lock:
            try:
                _, created = save_memory(self._db, self._user_id, content)
            except ValueError as exc:
                return f"Not saved: {exc}"
            except MemoryLimitError:
                return (
                    f"Not saved: the limit of {MEMORY_LIMIT_PER_USER} memories is "
                    "reached. Ask the user which memory to delete first."
                )
        return "Saved to memory." if created else "Already remembered."

    def delete(self, number: int) -> str:
        with self._lock:
            memories = list_memories(self._db, self._user_id)
            if not 1 <= number <= len(memories):
                return f"No memory numbered {number}."
            try:
                delete_memory(self._db, self._user_id, memories[number - 1].id)
            except MemoryNotFoundError:
                return f"No memory numbered {number}."
        return f"Deleted memory {number}."


class SaveMemoryInput(BaseModel):
    memory: str = Field(
        max_length=MEMORY_MAX_LENGTH,
        description=(
            "One short, self-contained fact about the user, written in the "
            "third person, e.g. 'Prefers Python over JavaScript'."
        ),
    )


class DeleteMemoryInput(BaseModel):
    memory_number: int = Field(
        description="The number of the memory to delete, as listed in the prompt."
    )


def build_memory_tools(access: MemoryAccess) -> list[BaseTool]:
    """Create the save_memory and delete_memory tools for one user."""

    # Parameter names must match the input schemas' field names.
    def save(memory: str) -> str:
        return access.save(memory)

    def forget(memory_number: int) -> str:
        return access.delete(memory_number)

    return [
        StructuredTool.from_function(
            func=save,
            name=SAVE_MEMORY_TOOL_NAME,
            description=(
                "Remember a lasting fact or preference about the user across "
                "all conversations."
            ),
            args_schema=SaveMemoryInput,
        ),
        StructuredTool.from_function(
            func=forget,
            name=DELETE_MEMORY_TOOL_NAME,
            description=(
                "Forget a remembered fact that is wrong, outdated, or that the "
                "user asked you to forget."
            ),
            args_schema=DeleteMemoryInput,
        ),
    ]
