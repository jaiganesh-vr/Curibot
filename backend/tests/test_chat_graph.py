from datetime import date

from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.services.chat_graph import build_chat_graph
from app.services.prompts import build_system_prompt


class RecordingChatModel(FakeListChatModel):
    """A fake model that records the messages it was called with."""

    received: list[list[BaseMessage]] = []

    def invoke(self, input, config=None, **kwargs):  # type: ignore[no-untyped-def]
        self.received.append(list(input))
        return super().invoke(input, config, **kwargs)


def test_chat_graph_returns_assistant_response() -> None:
    fake_model = FakeListChatModel(responses=["Hello! How can I help?"])
    graph = build_chat_graph(model=fake_model)

    result = graph.invoke({"messages": [HumanMessage(content="Hello")]})

    assert len(result["messages"]) == 2
    assert result["messages"][-1].content == "Hello! How can I help?"


def test_model_receives_system_prompt_first() -> None:
    model = RecordingChatModel(responses=["Hi!"], received=[])
    graph = build_chat_graph(model=model)

    graph.invoke({"messages": [HumanMessage(content="Hello")]})

    sent = model.received[0]
    assert isinstance(sent[0], SystemMessage)
    assert "You are Curibot" in sent[0].content
    assert [message.content for message in sent[1:]] == ["Hello"]


def test_system_prompt_is_not_stored_in_state_or_checkpoint() -> None:
    model = RecordingChatModel(responses=["First", "Second"], received=[])
    graph = build_chat_graph(model=model, checkpointer=InMemorySaver())
    config = {"configurable": {"thread_id": "thread-1"}}

    graph.invoke({"messages": [HumanMessage(content="One")]}, config=config)
    result = graph.invoke({"messages": [HumanMessage(content="Two")]}, config=config)

    stored = graph.get_state(config).values["messages"]
    assert not any(isinstance(message, SystemMessage) for message in stored)
    assert not any(isinstance(message, SystemMessage) for message in result["messages"])

    # Each turn sends exactly one system prompt, not one per earlier turn.
    second_call = model.received[1]
    assert sum(isinstance(m, SystemMessage) for m in second_call) == 1
    assert [m.content for m in second_call[1:]] == ["One", "First", "Two"]


def test_system_prompt_states_the_date_and_formatting_rules() -> None:
    prompt = build_system_prompt(date(2026, 10, 25))

    assert "Sunday, 25 October 2026" in prompt
    assert "Markdown" in prompt
    assert "fenced code blocks" in prompt
    assert "cannot browse the internet" in prompt
