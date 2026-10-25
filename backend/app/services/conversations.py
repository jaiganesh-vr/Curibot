import logging
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AnyMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_core.runnables import Runnable, RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import MessagesState
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import Conversation, Message, User
from app.services.chat_graph import build_chat_graph, is_conversational
from app.services.memory_tools import MemoryAccess

logger = logging.getLogger(__name__)

# Automatic titles from the first message; renamed titles may be longer.
TITLE_MAX_LENGTH = 50
TITLE_ELLIPSIS = "…"


class ConversationNotFoundError(Exception):
    """Raised when a conversation is missing or not owned by the user."""


class ChatGenerationError(Exception):
    """Raised when the LLM cannot generate a response."""


@dataclass(frozen=True)
class TokenEvent:
    """A piece of assistant text produced while streaming."""

    text: str


@dataclass(frozen=True)
class ToolCallEvent:
    """The model asked to run a tool, e.g. a web search, before answering."""

    name: str
    query: str


@dataclass(frozen=True)
class CompletedEvent:
    """The persisted user/assistant pair once streaming finishes."""

    user_message: Message
    assistant_message: Message


StreamEvent = TokenEvent | ToolCallEvent | CompletedEvent


def derive_title(content: str) -> str | None:
    """Build a conversation title from the first user message.

    Whitespace is collapsed. Longer messages are cut at a word boundary,
    when one falls in the second half of the limit, and end in an ellipsis.
    """
    text = " ".join(content.split())

    if len(text) <= TITLE_MAX_LENGTH:
        return text or None

    cut = text[: TITLE_MAX_LENGTH - len(TITLE_ELLIPSIS)]
    word_end = cut.rfind(" ")
    if word_end >= TITLE_MAX_LENGTH // 2:
        cut = cut[:word_end]

    return cut.rstrip(" ,.;:-") + TITLE_ELLIPSIS


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


def get_owned_conversation(
    db: Session,
    user: User,
    conversation_id: UUID,
) -> Conversation:
    """Return a conversation owned by the user or raise not found."""
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.user_id == user.id,
        )
    )

    if conversation is None:
        raise ConversationNotFoundError

    return conversation


def rename_conversation(
    db: Session,
    user: User,
    conversation_id: UUID,
    title: str,
) -> Conversation:
    """Rename a conversation without changing its activity ordering."""
    conversation = get_owned_conversation(db, user, conversation_id)

    # Assigning updated_at to itself suppresses the column's onupdate, so a
    # rename does not move the conversation to the top of the list.
    db.execute(
        update(Conversation)
        .where(Conversation.id == conversation.id)
        .values(title=title, updated_at=Conversation.updated_at)
    )

    try:
        db.commit()
        db.refresh(conversation)
    except Exception:
        db.rollback()
        raise

    return conversation


def delete_conversation(
    db: Session,
    user: User,
    conversation_id: UUID,
    checkpointer: BaseCheckpointSaver[str] | None = None,
) -> None:
    """Delete a conversation, its messages, and its LangGraph checkpoint."""
    conversation = get_owned_conversation(db, user, conversation_id)
    db.delete(conversation)

    try:
        db.commit()
    except Exception:
        db.rollback()
        raise

    if checkpointer is not None:
        try:
            checkpointer.delete_thread(str(conversation_id))
        except Exception:
            # The database rows are gone; an orphaned checkpoint is harmless.
            logger.exception("Failed to delete checkpoint thread")


@dataclass(frozen=True)
class _PreparedTurn:
    conversation: Conversation
    graph: Runnable[MessagesState, MessagesState]
    graph_input: MessagesState
    config: RunnableConfig | None


def _prepare_turn(
    db: Session,
    user: User,
    conversation_id: UUID,
    content: str,
    model: BaseChatModel | None,
    checkpointer: BaseCheckpointSaver[str] | None,
) -> _PreparedTurn:
    """Lock the conversation and build the graph input for a new user turn."""
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
        memory = MemoryAccess(db, user.id) if get_settings().memory_enabled else None
        graph = build_chat_graph(model=model, checkpointer=checkpointer, memory=memory)

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
            message_signature(message)
            for message in checkpoint_messages
            if is_conversational(message)
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

    except Exception as exc:
        db.rollback()
        logger.exception("Failed to prepare chat turn")
        raise ChatGenerationError from exc

    return _PreparedTurn(
        conversation=conversation,
        graph=graph,
        graph_input={"messages": graph_messages},
        config=config if checkpointer is not None else None,
    )


def _persist_turn(
    db: Session,
    conversation: Conversation,
    content: str,
    response_content: str,
) -> tuple[Message, Message]:
    """Save the user/assistant pair and update the conversation metadata."""
    # Assign ordered timestamps so the user turn precedes its assistant reply.
    user_created_at = datetime.now(UTC)
    assistant_created_at = user_created_at + timedelta(microseconds=1)

    user_message = Message(
        conversation_id=conversation.id,
        role="user",
        content=content,
        created_at=user_created_at,
    )
    assistant_message = Message(
        conversation_id=conversation.id,
        role="assistant",
        content=response_content,
        created_at=assistant_created_at,
    )

    db.add_all([user_message, assistant_message])

    if conversation.title is None:
        conversation.title = derive_title(content)
    conversation.updated_at = assistant_created_at

    try:
        db.commit()
        db.refresh(user_message)
        db.refresh(assistant_message)
    except Exception:
        db.rollback()
        raise

    return user_message, assistant_message


def send_message(
    db: Session,
    user: User,
    conversation_id: UUID,
    content: str,
    model: BaseChatModel | None = None,
    checkpointer: BaseCheckpointSaver[str] | None = None,
) -> tuple[Message, Message]:
    """Generate and persist a user/assistant message pair."""
    turn = _prepare_turn(db, user, conversation_id, content, model, checkpointer)

    try:
        if turn.config is not None:
            result = turn.graph.invoke(turn.graph_input, config=turn.config)
        else:
            result = turn.graph.invoke(turn.graph_input)
    except Exception as exc:
        db.rollback()
        logger.exception("Failed to generate chat response")
        raise ChatGenerationError from exc

    response_content = result["messages"][-1].content

    if not isinstance(response_content, str):
        db.rollback()
        raise ChatGenerationError("The model returned a non-text response.")

    return _persist_turn(db, turn.conversation, content, response_content)


def stream_message(
    db: Session,
    user: User,
    conversation_id: UUID,
    content: str,
    model: BaseChatModel | None = None,
    checkpointer: BaseCheckpointSaver[str] | None = None,
) -> Iterator[StreamEvent]:
    """Stream assistant text as it is generated, then persist the turn.

    Messages are saved only after the model finishes, so an interrupted
    stream leaves the database unchanged.
    """
    turn = _prepare_turn(db, user, conversation_id, content, model, checkpointer)
    parts: list[str] = []
    final_answer: str | None = None

    try:
        # "messages" yields model text as it is generated; "updates" yields
        # each node's complete output, which shows tool requests and the
        # final answer.
        for mode, payload in cast(
            Iterator[tuple[str, Any]],
            turn.graph.stream(
                turn.graph_input,
                config=turn.config,
                stream_mode=["messages", "updates"],
            ),
        ):
            if mode == "messages":
                chunk, metadata = cast(tuple[BaseMessage, dict[str, Any]], payload)
                if metadata.get("langgraph_node") != "call_model":
                    continue
                if isinstance(chunk.content, str) and chunk.content:
                    parts.append(chunk.content)
                    yield TokenEvent(text=chunk.content)
                continue

            update = cast(dict[str, Any], payload).get("call_model") or {}
            for message in update.get("messages", []):
                if not isinstance(message, AIMessage):
                    continue
                if message.tool_calls:
                    for call in message.tool_calls:
                        # The tool's main argument: a search query or a memory.
                        args = call["args"]
                        yield ToolCallEvent(
                            name=call["name"],
                            query=str(args.get("query") or args.get("memory") or ""),
                        )
                elif isinstance(message.content, str):
                    final_answer = message.content
    except Exception as exc:
        db.rollback()
        logger.exception("Failed to stream chat response")
        raise ChatGenerationError from exc

    # Text streamed before a tool call is not part of the answer, so save
    # the final model reply rather than everything that was streamed.
    response_content = final_answer if final_answer is not None else "".join(parts)
    user_message, assistant_message = _persist_turn(
        db, turn.conversation, content, response_content
    )
    yield CompletedEvent(
        user_message=user_message,
        assistant_message=assistant_message,
    )
