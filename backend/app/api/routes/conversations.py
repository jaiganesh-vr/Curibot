import json
import logging
from collections.abc import Iterator
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser
from app.db.session import get_db
from app.models import Conversation, Message
from app.schemas.conversation import (
    ChatTurnResponse,
    ConversationCreateRequest,
    ConversationResponse,
    ConversationUpdateRequest,
    MessageCreateRequest,
    MessageResponse,
)
from app.services.conversations import (
    ChatGenerationError,
    ConversationNotFoundError,
    TokenEvent,
    create_conversation,
    delete_conversation,
    get_owned_conversation,
    rename_conversation,
    send_message,
    stream_message,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/conversations", tags=["conversations"])

GENERATION_ERROR_DETAIL = "The assistant could not generate a response."


def format_sse(event: str, data: dict[str, Any]) -> str:
    """Encode one Server-Sent Events message."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post(
    "",
    response_model=ConversationResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_conversation_endpoint(
    request: ConversationCreateRequest,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> ConversationResponse:
    conversation = create_conversation(
        db=db,
        user=current_user,
        title=request.title,
    )
    return ConversationResponse.model_validate(conversation)


@router.get(
    "",
    response_model=list[ConversationResponse],
)
def list_conversations_endpoint(
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[ConversationResponse]:
    conversations = db.scalars(
        select(Conversation)
        .where(Conversation.user_id == current_user.id)
        .order_by(
            Conversation.updated_at.desc(),
            Conversation.id,
        )
    ).all()

    return [
        ConversationResponse.model_validate(conversation)
        for conversation in conversations
    ]


@router.patch(
    "/{conversation_id}",
    response_model=ConversationResponse,
)
def rename_conversation_endpoint(
    conversation_id: UUID,
    request_body: ConversationUpdateRequest,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> ConversationResponse:
    try:
        conversation = rename_conversation(
            db=db,
            user=current_user,
            conversation_id=conversation_id,
            title=request_body.title,
        )
    except ConversationNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found.",
        ) from None

    return ConversationResponse.model_validate(conversation)


@router.delete(
    "/{conversation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_conversation_endpoint(
    conversation_id: UUID,
    request: Request,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        delete_conversation(
            db=db,
            user=current_user,
            conversation_id=conversation_id,
            checkpointer=request.app.state.checkpointer,
        )
    except ConversationNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found.",
        ) from None

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/{conversation_id}/messages",
    response_model=ChatTurnResponse,
)
def create_message_endpoint(
    conversation_id: UUID,
    request: Request,
    request_body: MessageCreateRequest,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> ChatTurnResponse:
    try:
        user_message, assistant_message = send_message(
            db=db,
            user=current_user,
            conversation_id=conversation_id,
            content=request_body.content,
            checkpointer=request.app.state.checkpointer,
        )
    except ConversationNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found.",
        ) from None
    except ChatGenerationError:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=GENERATION_ERROR_DETAIL,
        ) from None

    return ChatTurnResponse(
        user_message=MessageResponse.model_validate(user_message),
        assistant_message=MessageResponse.model_validate(assistant_message),
    )


@router.post("/{conversation_id}/messages/stream")
def stream_message_endpoint(
    conversation_id: UUID,
    request: Request,
    request_body: MessageCreateRequest,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> StreamingResponse:
    """Stream the assistant reply as Server-Sent Events.

    Events: "token" ({"text"}) for each piece of the reply, then either
    "done" (the saved chat turn) or "error" ({"detail"}).
    """
    # Check ownership up front so a missing conversation is a normal 404.
    try:
        get_owned_conversation(db, current_user, conversation_id)
    except ConversationNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found.",
        ) from None

    checkpointer = request.app.state.checkpointer

    def event_stream() -> Iterator[str]:
        try:
            for event in stream_message(
                db=db,
                user=current_user,
                conversation_id=conversation_id,
                content=request_body.content,
                checkpointer=checkpointer,
            ):
                if isinstance(event, TokenEvent):
                    yield format_sse("token", {"text": event.text})
                else:
                    turn = ChatTurnResponse(
                        user_message=MessageResponse.model_validate(event.user_message),
                        assistant_message=MessageResponse.model_validate(
                            event.assistant_message
                        ),
                    )
                    yield format_sse("done", turn.model_dump(mode="json"))
        except ConversationNotFoundError:
            yield format_sse("error", {"detail": "Conversation not found."})
        except Exception:
            # The status line is already sent, so report failures in-stream.
            logger.exception("Streaming chat turn failed")
            yield format_sse("error", {"detail": GENERATION_ERROR_DETAIL})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get(
    "/{conversation_id}/messages",
    response_model=list[MessageResponse],
)
def list_messages_endpoint(
    conversation_id: UUID,
    current_user: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
) -> list[MessageResponse]:
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.user_id == current_user.id,
        )
    )

    if conversation is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found.",
        )

    messages = db.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at, Message.id)
    ).all()

    return [MessageResponse.model_validate(message) for message in messages]
