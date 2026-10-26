"""The web-search agent loop, end to end, with a scripted model and tool."""

from typing import Any

import groq
import httpx
import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import BaseTool, tool
from langgraph.checkpoint.memory import InMemorySaver
from pydantic import ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Message
from app.services.chat_graph import (
    build_chat_graph,
    fit_history_to_budget,
    tool_rounds_in_current_turn,
)
from app.services.conversations import (
    CompletedEvent,
    TokenEvent,
    ToolCallEvent,
    create_conversation,
    send_message,
    stream_message,
)
from app.services.llm import is_invalid_tool_call_error
from tests.test_conversation_persistence import create_user


def invalid_tool_call_error(body: object) -> groq.APIError:
    return groq.APIError(
        "Tool call validation failed: parameters for tool web_search did not "
        "match schema: errors: [missing properties: 'query']",
        httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions"),
        body=body,
    )


def search_call(query: str, call_id: str = "call-1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": "web_search", "args": {"query": query}, "id": call_id}],
    )


class ScriptedToolModel(BaseChatModel):
    """Replies from a script and records what each call received.

    Called without tools bound, it cannot request a tool, so it returns
    `forced_answer` when the next scripted reply is a tool call (or the
    script has run out). With tools bound, the first `invalid_tool_calls`
    calls fail the way Groq rejects a malformed tool call.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    script: list[AIMessage]
    forced_answer: str = "Final answer without more searching."
    calls: list[list[BaseMessage]] = []
    tool_choices: list[Any] = []
    tools_bound: list[bool] = []
    invalid_tool_calls: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted-tool-model"

    def bind_tools(self, tools, *, tool_choice=None, **kwargs):  # type: ignore[no-untyped-def,override]
        return self.bind(tool_choice=tool_choice, has_tools=True)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # type: ignore[no-untyped-def]
        self.calls.append(list(messages))
        self.tool_choices.append(kwargs.get("tool_choice"))
        has_tools = bool(kwargs.get("has_tools"))
        self.tools_bound.append(has_tools)
        if has_tools and self.invalid_tool_calls:
            self.invalid_tool_calls -= 1
            raise invalid_tool_call_error({"code": "tool_use_failed"})
        if not has_tools and (not self.script or self.script[0].tool_calls):
            reply = AIMessage(content=self.forced_answer)
        else:
            reply = self.script.pop(0)
        return ChatResult(generations=[ChatGeneration(message=reply)])


def make_search_tool(queries: list[str], fail: bool = False) -> BaseTool:
    @tool
    def web_search(query: str) -> str:
        """Search the web."""
        queries.append(query)
        if fail:
            raise RuntimeError("search backend down")
        return f"Result for {query}: https://example.com/news"

    return web_search


def test_answers_directly_when_no_search_is_needed() -> None:
    queries: list[str] = []
    model = ScriptedToolModel(script=[AIMessage("4")], calls=[], tool_choices=[])
    graph = build_chat_graph(model=model, tools=[make_search_tool(queries)])

    result = graph.invoke({"messages": [HumanMessage("What is 2 + 2?")]})

    assert result["messages"][-1].content == "4"
    assert queries == []
    assert len(model.calls) == 1


def test_searches_then_answers_with_the_results() -> None:
    queries: list[str] = []
    model = ScriptedToolModel(
        script=[
            search_call("Groq news October 2026"),
            AIMessage("Groq shipped X. [Source](https://example.com/news)"),
        ],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    graph = build_chat_graph(model=model, tools=[make_search_tool(queries)])

    result = graph.invoke({"messages": [HumanMessage("Latest Groq news?")]})

    assert queries == ["Groq news October 2026"]
    assert [type(m) for m in result["messages"]] == [
        HumanMessage,
        AIMessage,
        ToolMessage,
        AIMessage,
    ]
    assert result["messages"][-1].content.startswith("Groq shipped X.")

    # The second model call sees the search results, and the prompt
    # describes the search tool rather than claiming no internet access.
    second_call = model.calls[1]
    assert isinstance(second_call[0], SystemMessage)
    assert "web_search tool" in second_call[0].content
    assert "untrusted web content" in second_call[0].content
    assert "Result for Groq news October 2026" in second_call[-1].content


def test_round_limit_forces_an_answer_without_tools_bound() -> None:
    """Regression: gpt-oss ignored tool_choice="none" and Groq rejected it.

    At the limit the model is called with no tools bound at all, the turn's
    results are moved into the system prompt, and tool steps are left out.
    """
    queries: list[str] = []
    model = ScriptedToolModel(
        # A model that would keep searching forever if allowed to.
        script=[search_call(f"query {n}", f"c{n}") for n in range(1, 10)],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    graph = build_chat_graph(
        model=model, tools=[make_search_tool(queries)], max_tool_rounds=2
    )

    result = graph.invoke({"messages": [HumanMessage("Keep searching")]})

    assert queries == ["query 1", "query 2"]
    assert model.tools_bound == [True, True, False]
    assert "none" not in model.tool_choices
    assert result["messages"][-1].content == model.forced_answer

    final_call = model.calls[-1]
    assert "used all the tool calls" in final_call[0].content
    assert "Result for query 1" in final_call[0].content
    assert "Result for query 2" in final_call[0].content
    assert [type(m) for m in final_call[1:]] == [HumanMessage]


def test_tool_failure_is_reported_to_the_model_not_raised() -> None:
    queries: list[str] = []
    model = ScriptedToolModel(
        script=[search_call("anything"), AIMessage("I couldn't search right now.")],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    graph = build_chat_graph(model=model, tools=[make_search_tool(queries, fail=True)])

    result = graph.invoke({"messages": [HumanMessage("Search please")]})

    tool_message = result["messages"][2]
    assert isinstance(tool_message, ToolMessage)
    assert tool_message.status == "error"
    assert result["messages"][-1].content == "I couldn't search right now."


def test_invalid_tool_call_is_retried_once() -> None:
    model = ScriptedToolModel(
        script=[AIMessage("Answer.")],
        calls=[],
        tool_choices=[],
        tools_bound=[],
        invalid_tool_calls=1,
    )
    graph = build_chat_graph(model=model, tools=[make_search_tool([])])

    result = graph.invoke({"messages": [HumanMessage("News?")]})

    assert result["messages"][-1].content == "Answer."
    assert model.tools_bound == [True, True]


def test_repeated_invalid_tool_calls_answer_without_tools() -> None:
    model = ScriptedToolModel(
        script=[], calls=[], tool_choices=[], tools_bound=[], invalid_tool_calls=2
    )
    graph = build_chat_graph(model=model, tools=[make_search_tool([])])

    result = graph.invoke({"messages": [HumanMessage("News?")]})

    assert result["messages"][-1].content == model.forced_answer
    assert model.tools_bound == [True, True, False]


def test_invalid_tool_call_error_detection() -> None:
    # Non-streamed responses wrap the error object; streamed ones do not.
    assert is_invalid_tool_call_error(
        invalid_tool_call_error({"error": {"code": "tool_use_failed"}})
    )
    assert is_invalid_tool_call_error(invalid_tool_call_error(None))
    assert not is_invalid_tool_call_error(RuntimeError("Tool call validation failed"))


def test_round_counter_only_counts_the_current_turn() -> None:
    history = [
        HumanMessage("old question"),
        search_call("old"),
        ToolMessage("old results", tool_call_id="call-1"),
        AIMessage("old answer"),
        HumanMessage("new question"),
        search_call("new", "call-2"),
    ]

    assert tool_rounds_in_current_turn(history) == 1


def test_budget_fallback_keeps_the_whole_current_turn() -> None:
    current_turn = [
        HumanMessage("question"),
        search_call("q"),
        ToolMessage("x " * 5_000, tool_call_id="call-1"),
    ]
    history = [HumanMessage("older"), AIMessage("older answer"), *current_turn]

    assert fit_history_to_budget(history, max_tokens=1_000) == current_turn


def test_stream_reports_the_search_and_saves_only_the_final_answer(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queries: list[str] = []
    model = ScriptedToolModel(
        script=[
            AIMessage(
                content="Let me check.",
                tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "c1"}],
            ),
            AIMessage("Here is the answer. [Source](https://example.com/news)"),
        ],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    search_tool = make_search_tool(queries)
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: build_chat_graph(
            model=model, checkpointer=kwargs.get("checkpointer"), tools=[search_tool]
        ),
    )
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    events = list(stream_message(db_session, user, conversation.id, "News?"))

    assert ToolCallEvent(name="web_search", query="q") in events
    tool_index = events.index(ToolCallEvent(name="web_search", query="q"))
    streamed_after = "".join(
        e.text for e in events[tool_index:] if isinstance(e, TokenEvent)
    )
    assert streamed_after == "Here is the answer. [Source](https://example.com/news)"

    completed = events[-1]
    assert isinstance(completed, CompletedEvent)
    assert completed.assistant_message.content == (
        "Here is the answer. [Source](https://example.com/news)"
    )
    saved = db_session.scalars(select(Message).order_by(Message.created_at)).all()
    assert [(m.role, m.content) for m in saved] == [
        ("user", "News?"),
        ("assistant", "Here is the answer. [Source](https://example.com/news)"),
    ]


def test_checkpoint_with_tool_steps_is_reused_on_the_next_turn(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queries: list[str] = []
    model = ScriptedToolModel(
        script=[
            search_call("first question"),
            AIMessage("First answer."),
            AIMessage("Follow-up answer."),
        ],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    search_tool = make_search_tool(queries)
    saver = InMemorySaver()
    deleted_threads: list[str] = []
    original_delete = saver.delete_thread

    def spy_delete(thread_id: str) -> None:
        deleted_threads.append(thread_id)
        original_delete(thread_id)

    monkeypatch.setattr(saver, "delete_thread", spy_delete)
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: build_chat_graph(
            model=model, checkpointer=kwargs.get("checkpointer"), tools=[search_tool]
        ),
    )
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    send_message(db_session, user, conversation.id, "First?", checkpointer=saver)
    send_message(db_session, user, conversation.id, "And then?", checkpointer=saver)

    # Tool steps in the checkpoint do not count as a mismatch with the
    # saved transcript, so the checkpoint is kept and reused.
    assert deleted_threads == []
    follow_up_call = model.calls[-1]
    # The earlier answer is sent, but its tool results are not resent.
    assert any(m.content == "First answer." for m in follow_up_call)
    assert not any(isinstance(m, ToolMessage) for m in follow_up_call)
    assert follow_up_call[-1].content == "And then?"
