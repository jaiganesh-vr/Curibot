import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import MessagesState
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Conversation, Message, User
from app.services.chat_graph import build_chat_graph

logger = logging.getLogger(__name__)


class ConversationNotFoundError(Exception):
    """Raised when a conversation is missing or not owned by the user."""


class ChatGenerationError(Exception):
    """Raised when the LLM cannot generate a response."""


def create_conversation(
    db: Session,
    user: User,
    title: str | None = None,
) -> Conversation:
    """Create a conversation belonging to the authenticated user."""
    conversation = Conversation(user_id=user.id, title=title)
    db.add(conversation)

    try:
        db.commit()
        db.refresh(conversation)
    except Exception:
        db.rollback()
        raise

    return conversation


def send_message(
    db: Session,
    user: User,
    conversation_id: UUID,
    content: str,
    model: BaseChatModel | None = None,
    checkpointer: BaseCheckpointSaver[str] | None = None,
) -> tuple[Message, Message]:
    """Generate and persist a user/assistant message pair."""
    conversation = db.scalar(
        select(Conversation)
        .where(
            Conversation.id == conversation_id,
            Conversation.user_id == user.id,
        )
        .with_for_update()
    )

    if conversation is None:
        raise ConversationNotFoundError

    config: RunnableConfig = {"configurable": {"thread_id": str(conversation_id)}}

    try:
        graph = build_chat_graph(model=model, checkpointer=checkpointer)

        history = db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at, Message.id)
        ).all()

        history_messages: list[AnyMessage] = []
        for message in history:
            if message.role == "system":
                history_messages.append(SystemMessage(content=message.content))
            elif message.role == "user":
                history_messages.append(HumanMessage(content=message.content))
            elif message.role == "assistant":
                history_messages.append(AIMessage(content=message.content))

        checkpoint = (
            checkpointer.get_tuple(config) if checkpointer is not None else None
        )

        checkpoint_messages: list[AnyMessage] = []
        if checkpoint is not None:
            channel_values = checkpoint.checkpoint.get("channel_values", {})
            saved_messages = channel_values.get("messages", [])
            if isinstance(saved_messages, list):
                checkpoint_messages = saved_messages

        def message_signature(message: AnyMessage) -> tuple[str, str] | None:
            role_by_type = {
                "system": "system",
                "human": "user",
                "ai": "assistant",
                "tool": "tool",
            }
            role = role_by_type.get(message.type)
            if role is None or not isinstance(message.content, str):
                return None
            return role, message.content

        history_signatures = [
            message_signature(message) for message in history_messages
        ]
        checkpoint_signatures = [
            message_signature(message) for message in checkpoint_messages
        ]

        checkpoint_is_consistent = (
            checkpoint is not None
            and all(signature is not None for signature in checkpoint_signatures)
            and checkpoint_signatures == history_signatures
        )

        if checkpointer is not None and checkpoint is not None:
            if not checkpoint_is_consistent:
                checkpointer.delete_thread(str(conversation_id))

        graph_messages: list[AnyMessage]

        if checkpoint_is_consistent:
            graph_messages = [HumanMessage(content=content)]
        else:
            graph_messages = [
                *history_messages,
                HumanMessage(content=content),
            ]

        graph_input: MessagesState = {"messages": graph_messages}

        if checkpointer is not None:
            result = graph.invoke(graph_input, config=config)
        else:
            result = graph.invoke(graph_input)

    except Exception as exc:
        db.rollback()
        logger.exception("Failed to generate chat response")
        raise ChatGenerationError from exc

    response_content = result["messages"][-1].content

    if not isinstance(response_content, str):
        db.rollback()
        raise ChatGenerationError("The model returned a non-text response.")

    # Assign ordered timestamps so the user turn precedes its assistant reply.
    user_created_at = datetime.now(UTC)
    assistant_created_at = user_created_at + timedelta(microseconds=1)

    user_message = Message(
        conversation_id=conversation_id,
        role="user",
        content=content,
        created_at=user_created_at,
    )
    assistant_message = Message(
        conversation_id=conversation_id,
        role="assistant",
        content=response_content,
        created_at=assistant_created_at,
    )

    db.add_all([user_message, assistant_message])

    try:
        db.commit()
        db.refresh(user_message)
        db.refresh(assistant_message)
    except Exception:
        db.rollback()
        raise

    return user_message, assistant_message
