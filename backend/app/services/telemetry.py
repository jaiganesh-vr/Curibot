from threading import Lock
from time import perf_counter
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage
from langchain_core.outputs import LLMResult


class TurnTelemetry(BaseCallbackHandler):
    """Collect what the agent did during one chat turn.

    Passed as a callback in the graph's config, so the graph itself is
    unchanged. Records counts, timings, statuses, and token usage only,
    never message text, tool inputs, or tool outputs. Callbacks can arrive
    from parallel tool threads, so updates take a lock.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._started = perf_counter()
        self._run_starts: dict[UUID, float] = {}
        self._tool_names: dict[UUID, str] = {}
        self.model_calls = 0
        self.model_errors = 0
        self.model_ms = 0
        self.tool_rounds = 0
        self.tools: list[dict[str, Any]] = []
        self.input_tokens = 0
        self.output_tokens = 0
        self.reasoning_tokens = 0

    def _elapsed_ms(self, run_id: UUID) -> int:
        started = self._run_starts.pop(run_id, perf_counter())
        return round((perf_counter() - started) * 1000)

    def on_chat_model_start(
        self, serialized: dict[str, Any], messages: Any, *, run_id: UUID, **kwargs: Any
    ) -> None:
        with self._lock:
            self._run_starts[run_id] = perf_counter()

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        with self._lock:
            self.model_calls += 1
            self.model_ms += self._elapsed_ms(run_id)

            generation = response.generations[0][0] if response.generations else None
            message = getattr(generation, "message", None)
            if not isinstance(message, AIMessage):
                return
            if message.tool_calls:
                self.tool_rounds += 1

            usage: dict[str, Any] = dict(message.usage_metadata or {})
            self.input_tokens += int(usage.get("input_tokens", 0))
            self.output_tokens += int(usage.get("output_tokens", 0))
            details: dict[str, Any] = dict(usage.get("output_token_details") or {})
            self.reasoning_tokens += int(details.get("reasoning", 0))

    def on_llm_error(
        self, error: BaseException, *, run_id: UUID, **kwargs: Any
    ) -> None:
        with self._lock:
            self.model_errors += 1
            self._run_starts.pop(run_id, None)

    def on_tool_start(
        self, serialized: dict[str, Any], input_str: str, *, run_id: UUID, **kwargs: Any
    ) -> None:
        with self._lock:
            self._run_starts[run_id] = perf_counter()
            self._tool_names[run_id] = str(
                (serialized or {}).get("name") or kwargs.get("name") or "unknown"
            )

    def _finish_tool(self, run_id: UUID, status: str) -> None:
        with self._lock:
            self.tools.append(
                {
                    "name": self._tool_names.pop(run_id, "unknown"),
                    "ms": self._elapsed_ms(run_id),
                    "status": status,
                }
            )

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._finish_tool(run_id, "ok")

    def on_tool_error(
        self, error: BaseException, *, run_id: UUID, **kwargs: Any
    ) -> None:
        self._finish_tool(run_id, "error")

    def summary(self) -> dict[str, Any]:
        with self._lock:
            return {
                "duration_ms": round((perf_counter() - self._started) * 1000),
                "model_calls": self.model_calls,
                "model_errors": self.model_errors,
                "model_ms": self.model_ms,
                "tool_rounds": self.tool_rounds,
                "tool_calls": len(self.tools),
                "tools": list(self.tools),
                "tokens": {
                    "input": self.input_tokens,
                    "output": self.output_tokens,
                    "reasoning": self.reasoning_tokens,
                },
            }
