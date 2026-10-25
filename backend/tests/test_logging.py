import json
import logging
import sys

from app.core.logging import (
    ContextFilter,
    JsonFormatter,
    TextFormatter,
    bind_context,
    current_context,
    end_request_context,
    log_event,
    start_request_context,
)


def make_record(message: str = "turn_completed", **fields: object) -> logging.LogRecord:
    record = logging.LogRecord(
        "app.test", logging.INFO, __file__, 1, message, None, None
    )
    record.fields = fields
    ContextFilter().filter(record)
    return record


def test_json_formatter_includes_context_and_fields() -> None:
    token = start_request_context("req-123")
    bind_context(user_id="user-1")
    try:
        record = make_record(duration_ms=42, tool_calls=2)
    finally:
        end_request_context(token)

    entry = json.loads(JsonFormatter().format(record))

    assert entry["event"] == "turn_completed"
    assert entry["level"] == "INFO"
    assert entry["logger"] == "app.test"
    assert entry["request_id"] == "req-123"
    assert entry["user_id"] == "user-1"
    assert entry["duration_ms"] == 42
    assert entry["tool_calls"] == 2
    assert "timestamp" in entry


def test_json_formatter_includes_exceptions() -> None:
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        record = logging.LogRecord(
            "app.test", logging.ERROR, __file__, 1, "failed", None, sys.exc_info()
        )
    ContextFilter().filter(record)

    entry = json.loads(JsonFormatter().format(record))

    assert "RuntimeError: boom" in entry["exception"]


def test_text_formatter_is_readable() -> None:
    token = start_request_context("req-456")
    try:
        line = TextFormatter().format(make_record("request_completed", status=200))
    finally:
        end_request_context(token)

    assert "INFO" in line
    assert "request_completed" in line
    assert "request_id=req-456" in line
    assert "status=200" in line


def test_context_is_empty_outside_a_request() -> None:
    bind_context(user_id="ignored")

    assert current_context() == {}


def test_log_event_passes_structured_fields(caplog) -> None:  # type: ignore[no-untyped-def]
    logger = logging.getLogger("app.test.events")

    with caplog.at_level(logging.INFO, logger="app.test.events"):
        log_event(logger, "turn_completed", tool_calls=3)

    assert caplog.records[0].getMessage() == "turn_completed"
    assert caplog.records[0].fields == {"tool_calls": 3}
