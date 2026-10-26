from functools import lru_cache

import groq
from langchain_groq import ChatGroq

from app.core.config import get_settings


def is_invalid_tool_call_error(exc: Exception) -> bool:
    """Whether Groq rejected a tool call the model generated.

    Groq validates tool arguments against the schema and fails the request
    when they do not match, e.g. a web_search call without a query.
    """
    if not isinstance(exc, groq.APIError):
        return False
    body = exc.body
    # Streamed errors carry the error object itself; others wrap it.
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        body = body["error"]
    if isinstance(body, dict) and body.get("code") == "tool_use_failed":
        return True
    return "tool call validation failed" in exc.message.lower()


@lru_cache
def get_chat_model() -> ChatGroq:
    """Create and cache the configured Groq chat model."""
    settings = get_settings()

    if settings.groq_api_key is None:
        raise ValueError("GROQ_API_KEY must be configured to use the LLM service.")

    return ChatGroq(
        model=settings.groq_model,
        api_key=settings.groq_api_key,
        temperature=0,
    )
