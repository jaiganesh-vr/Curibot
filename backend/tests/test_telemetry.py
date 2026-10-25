"""Agent turn telemetry and the guarantee that logs never contain content."""

import logging

import pytest
from langchain_core.messages import AIMessage
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import ContextFilter, JsonFormatter
from app.services.chat_graph import build_chat_graph
from app.services.conversations import (
    ChatGenerationError,
    create_conversation,
    send_message,
    stream_message,
)
from tests.test_agent_loop import ScriptedToolModel, make_search_tool
from tests.test_conversation_persistence import create_user

SECRET = "PINEAPPLE-SECRET-42"


def with_usage(
    message: AIMessage, input_tokens: int, output_tokens: int, reasoning: int = 0
) -> AIMessage:
    message.usage_metadata = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "output_token_details": {"reasoning": reasoning},
    }
    return message


def search_request(query: str, call_id: str) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": "web_search", "args": {"query": query}, "id": call_id}],
    )


def route_through(
    monkeypatch: pytest.MonkeyPatch, model: ScriptedToolModel, **graph_kwargs: object
) -> None:
    queries: list[str] = []
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: build_chat_graph(
            model=model,
            checkpointer=kwargs.get("checkpointer"),
            tools=[make_search_tool(queries)],
            memory=kwargs.get("memory"),
            **graph_kwargs,
        ),
    )


def turn_record(caplog) -> logging.LogRecord:  # type: ignore[no-untyped-def]
    records = [
        r for r in caplog.records if r.getMessage() in {"turn_completed", "turn_failed"}
    ]
    assert len(records) == 1
    return records[0]


def test_turn_completed_summarises_tools_rounds_and_tokens(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:  # type: ignore[no-untyped-def]
    model = ScriptedToolModel(
        script=[
            with_usage(search_request("news", "c1"), 100, 10, reasoning=5),
            with_usage(AIMessage("Here is the news."), 300, 40, reasoning=20),
        ],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    route_through(monkeypatch, model)
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    with caplog.at_level(logging.INFO):
        list(stream_message(db_session, user, conversation.id, "Any news?"))

    fields = turn_record(caplog).fields
    assert fields["streamed"] is True
    assert fields["model_calls"] == 2
    assert fields["tool_rounds"] == 1
    assert fields["tool_calls"] == 1
    assert fields["tools"][0]["name"] == "web_search"
    assert fields["tools"][0]["status"] == "ok"
    assert isinstance(fields["tools"][0]["ms"], int)
    assert fields["tokens"] == {"input": 400, "output": 50, "reasoning": 25}
    assert fields["limit_reached"] is False
    assert fields["duration_ms"] >= 0


def test_limit_reached_is_reported(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("WEB_SEARCH_MAX_ROUNDS", "2")
    get_settings.cache_clear()
    model = ScriptedToolModel(
        script=[search_request(f"q{n}", f"c{n}") for n in range(5)],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    route_through(monkeypatch, model, max_tool_rounds=2)
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    with caplog.at_level(logging.INFO):
        send_message(db_session, user, conversation.id, "Keep searching")

    fields = turn_record(caplog).fields
    assert fields["streamed"] is False
    assert fields["tool_rounds"] == 2
    assert fields["limit_reached"] is True


def test_turn_failed_logs_partial_telemetry(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:  # type: ignore[no-untyped-def]
    class CrashesAfterSearching(ScriptedToolModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # type: ignore[no-untyped-def]
            if self.calls:
                raise RuntimeError("provider rejected the response")
            return super()._generate(messages, stop, run_manager, **kwargs)

    model = CrashesAfterSearching(
        script=[search_request("q", "c1")], calls=[], tool_choices=[], tools_bound=[]
    )
    route_through(monkeypatch, model)
    user = create_user(db_session)
    db_session.commit()
    conversation = create_conversation(db_session, user)

    with caplog.at_level(logging.INFO), pytest.raises(ChatGenerationError):
        list(stream_message(db_session, user, conversation.id, "Search then fail"))

    record = turn_record(caplog)
    assert record.getMessage() == "turn_failed"
    assert record.levelno == logging.ERROR
    assert record.exc_info is not None
    assert record.fields["tool_rounds"] == 1
    assert record.fields["model_errors"] == 1


def test_logs_never_contain_message_query_or_memory_content(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, caplog
) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("MEMORY_ENABLED", "true")
    get_settings.cache_clear()
    model = ScriptedToolModel(
        script=[
            search_request(f"{SECRET} latest", "c1"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "save_memory",
                        "args": {"memory": f"Code word is {SECRET}"},
                        "id": "c2",
                    }
                ],
            ),
            AIMessage(f"Your code word is {SECRET}."),
        ],
        calls=[],
        tool_choices=[],
        tools_bound=[],
    )
    route_through(monkeypatch, model)
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    with caplog.at_level(logging.DEBUG):
        list(
            stream_message(
                db_session, user, conversation.id, f"My code word is {SECRET}"
            )
        )

    formatter = JsonFormatter()
    rendered = []
    for record in caplog.records:
        ContextFilter().filter(record)
        rendered.append(formatter.format(record))

    assert any("turn_completed" in line for line in rendered)
    assert all(SECRET not in line for line in rendered)
