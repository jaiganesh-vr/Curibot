"""Structured, privacy-safe logging.

Every log record carries the current request's context (request ID, user
ID, conversation ID) and any structured fields passed with log_event().
Records are rendered as one JSON object per line, or as readable text for
local development.

Privacy: log identifiers, counts, durations, and statuses only. Never log
message text, replies, memories, search queries, emails, or credentials.
"""

import json
import logging
import sys
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any, Literal

LogFormat = Literal["json", "text"]

# One mutable dict per request. FastAPI runs sync dependencies and endpoints
# in worker threads with a *copy* of the context, so rebinding the variable
# there would not be seen elsewhere; mutating the shared dict is.
_request_context: ContextVar[dict[str, Any] | None] = ContextVar(
    "request_context", default=None
)

# Attributes every LogRecord has; anything else came from `extra`.
# uvicorn's color_message duplicates the message with terminal colour codes.
_STANDARD_ATTRS = set(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "message",
    "asctime",
    "taskName",
    "color_message",
}


def start_request_context(request_id: str) -> object:
    """Begin a request's context; returns a token for end_request_context."""
    return _request_context.set({"request_id": request_id})


def end_request_context(token: object) -> None:
    _request_context.reset(token)  # type: ignore[arg-type]


def bind_context(**fields: Any) -> None:
    """Add fields (e.g. user_id) to the current request's context."""
    context = _request_context.get()
    if context is not None:
        context.update({key: str(value) for key, value in fields.items()})


def current_context() -> dict[str, Any]:
    return dict(_request_context.get() or {})


def log_event(
    logger: logging.Logger,
    event: str,
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    """Log a named event with structured fields."""
    logger.log(level, event, extra={"fields": fields})


class ContextFilter(logging.Filter):
    """Attach the request context to every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.context = current_context()
        return True


def _record_fields(record: logging.LogRecord) -> dict[str, Any]:
    fields = dict(getattr(record, "fields", {}) or {})
    for key, value in record.__dict__.items():
        if key not in _STANDARD_ATTRS and key not in {"fields", "context"}:
            fields[key] = value
    return fields


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
            **getattr(record, "context", {}),
            **_record_fields(record),
        }
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class TextFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        timestamp = datetime.fromtimestamp(record.created, UTC).strftime("%H:%M:%S")
        pairs = {**getattr(record, "context", {}), **_record_fields(record)}
        details = " ".join(f"{key}={value}" for key, value in pairs.items())
        line = f"{timestamp} {record.levelname:<7} {record.name}: {record.getMessage()}"
        if details:
            line = f"{line} [{details}]"
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def configure_logging(level: str = "INFO", log_format: LogFormat = "text") -> None:
    """Route all logs, including uvicorn's, through one formatted handler."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if log_format == "json" else TextFormatter())
    handler.addFilter(ContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True

    # Replaced by our request_completed event, which carries the request ID.
    logging.getLogger("uvicorn.access").disabled = True
    # Client libraries log full request URLs and, at DEBUG, request bodies
    # (the Groq SDK logs the messages it sends). Pin them to WARNING so that
    # LOG_LEVEL=DEBUG never puts conversation content into the logs.
    for name in ("httpx", "httpcore", "groq", "langsmith", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)
