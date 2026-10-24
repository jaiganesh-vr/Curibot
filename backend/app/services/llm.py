from functools import lru_cache

from langchain_groq import ChatGroq

from app.core.config import get_settings


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
