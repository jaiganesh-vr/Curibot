from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import HumanMessage

from app.services.chat_graph import build_chat_graph


def test_chat_graph_returns_assistant_response() -> None:
    fake_model = FakeListChatModel(responses=["Hello! How can I help?"])
    graph = build_chat_graph(model=fake_model)

    result = graph.invoke({"messages": [HumanMessage(content="Hello")]})

    assert len(result["messages"]) == 2
    assert result["messages"][-1].content == "Hello! How can I help?"
