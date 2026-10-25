from collections.abc import Sequence
from datetime import UTC, datetime

from langchain_core.language_models import BaseChatModel, LanguageModelInput
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    trim_messages,
)
from langchain_core.messages.utils import count_tokens_approximately
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from app.core.config import get_settings
from app.services.llm import get_chat_model
from app.services.prompts import build_system_prompt
from app.services.tools import get_enabled_tools


def _last_user_index(messages: Sequence[BaseMessage]) -> int | None:
    for index in range(len(messages) - 1, -1, -1):
        if isinstance(messages[index], HumanMessage):
            return index
    return None


def fit_history_to_budget(
    messages: Sequence[BaseMessage],
    max_tokens: int,
) -> list[BaseMessage]:
    """Keep the newest messages that fit in `max_tokens`.

    The result starts on a user turn, so the model never sees a reply
    without its question, and a tool call is never separated from its
    result. If even the current turn does not fit, the current turn (the
    latest user message and any tool steps after it) is sent anyway so the
    model can still answer.
    """
    trimmed = trim_messages(
        messages,
        max_tokens=max_tokens,
        token_counter=count_tokens_approximately,
        strategy="last",
        start_on="human",
        allow_partial=False,
    )
    if trimmed or not messages:
        return list(trimmed)

    last_user = _last_user_index(messages)
    return list(messages[last_user:]) if last_user is not None else [messages[-1]]


def tool_rounds_in_current_turn(messages: Sequence[BaseMessage]) -> int:
    """Count model replies that requested tools since the latest user message."""
    start = _last_user_index(messages)
    current_turn = messages[start + 1 :] if start is not None else messages
    return sum(
        1
        for message in current_turn
        if isinstance(message, AIMessage) and message.tool_calls
    )


def build_chat_graph(
    model: BaseChatModel | None = None,
    checkpointer: BaseCheckpointSaver[str] | None = None,
    max_context_tokens: int | None = None,
    tools: Sequence[BaseTool] | None = None,
    max_tool_rounds: int | None = None,
) -> Runnable[MessagesState, MessagesState]:
    """Build the conversational graph.

    Without tools it is a single model call. With tools it is an agent loop:
    the model either answers or requests tools, the tool node runs them, and
    the results go back to the model, for at most `max_tool_rounds` rounds.
    """
    settings = get_settings()
    chat_model = model if model is not None else get_chat_model()
    context_budget = (
        max_context_tokens
        if max_context_tokens is not None
        else settings.context_max_tokens
    )
    tool_list = list(tools) if tools is not None else get_enabled_tools()
    round_limit = (
        max_tool_rounds
        if max_tool_rounds is not None
        else settings.web_search_max_rounds
    )

    model_with_tools: Runnable[LanguageModelInput, BaseMessage] = chat_model
    # Keeps earlier tool calls valid context but forbids new ones, so the
    # model must answer once the round limit is reached.
    model_answer_only: Runnable[LanguageModelInput, BaseMessage] = chat_model
    if tool_list:
        model_with_tools = chat_model.bind_tools(tool_list)
        model_answer_only = chat_model.bind_tools(tool_list, tool_choice="none")

    def call_model(state: MessagesState) -> dict[str, list[BaseMessage]]:
        # The system prompt and trimming apply to the model input only. Graph
        # state, the checkpoint, and the saved history keep every message,
        # and prompt edits apply to existing chats.
        system_prompt = SystemMessage(
            content=build_system_prompt(
                datetime.now(UTC).date(), web_search=bool(tool_list)
            )
        )
        history = fit_history_to_budget(state["messages"], context_budget)
        can_use_tools = (
            bool(tool_list)
            and tool_rounds_in_current_turn(state["messages"]) < round_limit
        )
        runnable = model_with_tools if can_use_tools else model_answer_only
        response = runnable.invoke([system_prompt, *history])
        return {"messages": [response]}

    builder = StateGraph(MessagesState)
    builder.add_node("call_model", call_model)
    builder.add_edge(START, "call_model")

    if tool_list:
        # Tool errors go back to the model as text instead of failing the turn.
        builder.add_node("tools", ToolNode(tool_list, handle_tool_errors=True))
        builder.add_conditional_edges("call_model", tools_condition)
        builder.add_edge("tools", "call_model")
    else:
        builder.add_edge("call_model", END)

    return builder.compile(checkpointer=checkpointer)
