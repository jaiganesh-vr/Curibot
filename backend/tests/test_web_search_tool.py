import json

import httpx
import pytest

from app.core.config import Settings, get_settings
from app.services.tools import (
    SNIPPET_MAX_CHARS,
    TAVILY_SEARCH_URL,
    WEB_SEARCH_TOOL_NAME,
    build_web_search_tool,
    format_results,
    get_enabled_tools,
)


def mock_client(handler) -> httpx.Client:  # type: ignore[no-untyped-def]
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_tool_sends_query_and_formats_results() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers["Authorization"]
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "title": "Groq docs",
                        "url": "https://console.groq.com/docs",
                        "content": "gpt-oss-120b   has a\\n131k context window.",
                    }
                ]
            },
        )

    tool = build_web_search_tool("test-key", 3, client=mock_client(handler))
    output = tool.invoke({"query": "gpt-oss context window"})

    assert tool.name == WEB_SEARCH_TOOL_NAME
    assert captured["url"] == TAVILY_SEARCH_URL
    assert captured["auth"] == "Bearer test-key"
    assert captured["body"] == {
        "query": "gpt-oss context window",
        "max_results": 3,
        "search_depth": "basic",
        "topic": "general",
        "include_answer": False,
    }
    assert "untrusted page content" in output
    assert "[1] Groq docs" in output
    assert "URL: https://console.groq.com/docs" in output
    assert "131k context window." in output


def test_long_snippets_are_shortened() -> None:
    result = {"title": "T", "url": "https://example.com", "content": "word " * 500}

    output = format_results("q", [result])

    snippet = output.split("URL: https://example.com\n", 1)[1]
    assert len(snippet) <= SNIPPET_MAX_CHARS + 1
    assert snippet.endswith("…")


def test_no_results_is_reported_plainly() -> None:
    assert format_results("nothing", []) == 'No web results found for "nothing".'


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        (lambda request: httpx.Response(500), "unavailable right now"),
        (lambda request: httpx.Response(200, content=b"not json"), "unavailable"),
    ],
)
def test_api_failures_become_messages_for_the_model(handler, expected) -> None:  # type: ignore[no-untyped-def]
    tool = build_web_search_tool("test-key", 3, client=mock_client(handler))

    assert expected in tool.invoke({"query": "anything"})


def test_timeouts_become_messages_for_the_model() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    tool = build_web_search_tool("test-key", 3, client=mock_client(handler))

    assert "timed out" in tool.invoke({"query": "anything"})


def test_tools_are_disabled_without_an_api_key() -> None:
    assert get_enabled_tools() == []
    assert Settings(_env_file=None).web_search_enabled is False
    assert Settings(_env_file=None, tavily_api_key="").web_search_enabled is False
    assert Settings(_env_file=None, tavily_api_key="key").web_search_enabled is True


def test_tools_are_enabled_with_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TAVILY_API_KEY", "configured-key")
    get_settings.cache_clear()

    tools = get_enabled_tools()

    assert [tool.name for tool in tools] == [WEB_SEARCH_TOOL_NAME]
