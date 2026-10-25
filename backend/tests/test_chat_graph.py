from datetime import date

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
)
from langchain_core.messages.utils import count_tokens_approximately
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import ValidationError

from app.core.config import Settings
from app.services.chat_graph import build_chat_graph, fit_history_to_budget
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


def long_conversation(turns: int, words: int = 80) -> list[BaseMessage]:
    """Alternate user/assistant messages of roughly `words` words each."""
    messages: list[BaseMessage] = []
    for turn in range(turns):
        filler = " ".join(f"word{turn}" for _ in range(words))
        messages.append(HumanMessage(content=f"question {turn}: {filler}"))
        messages.append(AIMessage(content=f"answer {turn}: {filler}"))
    return messages


def test_short_history_is_sent_in_full() -> None:
    history = [*long_conversation(2, words=5), HumanMessage(content="latest")]

    assert fit_history_to_budget(history, max_tokens=16_000) == history


def test_long_history_keeps_newest_messages_within_budget() -> None:
    history = [*long_conversation(30), HumanMessage(content="latest question")]

    kept = fit_history_to_budget(history, max_tokens=1_500)

    assert 0 < len(kept) < len(history)
    assert count_tokens_approximately(kept) <= 1_500
    # The newest messages survive, in order, ending with the latest question.
    assert kept == history[-len(kept) :]
    assert kept[-1].content == "latest question"
    # The model never sees an answer without its question.
    assert isinstance(kept[0], HumanMessage)


def test_oversized_latest_message_is_still_sent() -> None:
    huge = HumanMessage(content="x " * 10_000)
    history = [*long_conversation(3), huge]

    assert fit_history_to_budget(history, max_tokens=1_000) == [huge]


def test_graph_trims_model_input_but_keeps_full_state() -> None:
    model = RecordingChatModel(responses=["Reply"], received=[])
    graph = build_chat_graph(
        model=model,
        checkpointer=InMemorySaver(),
        max_context_tokens=1_500,
    )
    config = {"configurable": {"thread_id": "long-thread"}}
    history = [*long_conversation(30), HumanMessage(content="latest question")]

    graph.invoke({"messages": history}, config=config)

    sent = model.received[0]
    assert isinstance(sent[0], SystemMessage)
    assert len(sent) - 1 < len(history)
    assert sent[-1].content == "latest question"

    # Nothing is dropped from the stored conversation.
    stored = graph.get_state(config).values["messages"]
    assert len(stored) == len(history) + 1


def test_context_budget_setting_has_a_safe_default_and_minimum() -> None:
    assert Settings(_env_file=None).context_max_tokens == 16_000
    assert (
        Settings(_env_file=None, context_max_tokens=4_000).context_max_tokens == 4_000
    )
    with pytest.raises(ValidationError):
        Settings(_env_file=None, context_max_tokens=10)
