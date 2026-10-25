from collections.abc import Sequence
from datetime import UTC, datetime

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, SystemMessage, trim_messages
from langchain_core.messages.utils import count_tokens_approximately
from langchain_core.runnables import Runnable
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, MessagesState, StateGraph

from app.core.config import get_settings
from app.services.llm import get_chat_model
from app.services.prompts import build_system_prompt


def fit_history_to_budget(
    messages: Sequence[BaseMessage],
    max_tokens: int,
) -> list[BaseMessage]:
    """Keep the newest messages that fit in `max_tokens`.

    The result starts on a user turn, so the model never sees a reply
    without its question. The latest message is always kept, even if it
    alone exceeds the budget, so the model can still answer it.
    """
    trimmed = trim_messages(
        messages,
        max_tokens=max_tokens,
        token_counter=count_tokens_approximately,
        strategy="last",
        start_on="human",
        allow_partial=False,
    )
    if not trimmed and messages:
        return [messages[-1]]
    return list(trimmed)


def build_chat_graph(
    model: BaseChatModel | None = None,
    checkpointer: BaseCheckpointSaver[str] | None = None,
    max_context_tokens: int | None = None,
) -> Runnable[MessagesState, MessagesState]:
    """Build a conversational graph with optional checkpointing."""
    chat_model = model if model is not None else get_chat_model()
    context_budget = (
        max_context_tokens
        if max_context_tokens is not None
        else get_settings().context_max_tokens
    )

    def call_model(state: MessagesState) -> dict[str, list[BaseMessage]]:
        # The system prompt and trimming apply to the model input only. Graph
        # state, the checkpoint, and the saved history keep every message,
        # and prompt edits apply to existing chats.
        system_prompt = SystemMessage(
            content=build_system_prompt(datetime.now(UTC).date())
        )
        history = fit_history_to_budget(state["messages"], context_budget)
        response = chat_model.invoke([system_prompt, *history])
        return {"messages": [response]}

    builder = StateGraph(MessagesState)
    builder.add_node("call_model", call_model)
    builder.add_edge(START, "call_model")
    builder.add_edge("call_model", END)

    return builder.compile(checkpointer=checkpointer)
