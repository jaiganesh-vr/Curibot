from datetime import UTC, datetime

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage, SystemMessage
from langchain_core.runnables import Runnable
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, MessagesState, StateGraph

from app.services.llm import get_chat_model
from app.services.prompts import build_system_prompt


def build_chat_graph(
    model: BaseChatModel | None = None,
    checkpointer: BaseCheckpointSaver[str] | None = None,
) -> Runnable[MessagesState, MessagesState]:
    """Build a conversational graph with optional checkpointing."""
    chat_model = model if model is not None else get_chat_model()

    def call_model(state: MessagesState) -> dict[str, list[BaseMessage]]:
        # The system prompt is prepended to the model input only. It is not
        # returned into graph state, so it never reaches the checkpoint or
        # the saved history, and prompt edits apply to existing chats.
        system_prompt = SystemMessage(
            content=build_system_prompt(datetime.now(UTC).date())
        )
        response = chat_model.invoke([system_prompt, *state["messages"]])
        return {"messages": [response]}

    builder = StateGraph(MessagesState)
    builder.add_node("call_model", call_model)
    builder.add_edge(START, "call_model")
    builder.add_edge("call_model", END)

    return builder.compile(checkpointer=checkpointer)
