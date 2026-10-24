from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import CurrentUser
from app.db.session import get_db
from app.models import Conversation, Message
from app.schemas.conversation import (
    ChatTurnResponse,
    ConversationCreateRequest,
    ConversationResponse,
    MessageCreateRequest,
    MessageResponse,
)
from app.services.conversations import (
    ChatGenerationError,
    ConversationNotFoundError,
    create_conversation,
    send_message,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])


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
            detail="The assistant could not generate a response.",
        ) from None

    return ChatTurnResponse(
        user_message=MessageResponse.model_validate(user_message),
        assistant_message=MessageResponse.model_validate(assistant_message),
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
