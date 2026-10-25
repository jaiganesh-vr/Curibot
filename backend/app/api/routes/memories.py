from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser
from app.db.session import get_db
from app.schemas.memory import MemoryResponse
from app.services.memories import (
    MemoryNotFoundError,
    clear_memories,
    delete_memory,
    list_memories,
)

router = APIRouter(prefix="/memories", tags=["memories"])


@router.get("", response_model=list[MemoryResponse])
def list_memories_endpoint(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[MemoryResponse]:
    """Return what the assistant remembers about the current user."""
    return [
        MemoryResponse.model_validate(memory)
        for memory in list_memories(db, current_user.id)
    ]


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory_endpoint(
    memory_id: UUID,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        delete_memory(db, current_user.id, memory_id)
    except MemoryNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Memory not found.",
        ) from None

    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def clear_memories_endpoint(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    clear_memories(db, current_user.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
