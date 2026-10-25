# Observability

Curibot's backend writes structured logs for every request and every agent
turn, and can optionally send full traces to LangSmith.

## Logs

Each line is one JSON object (`LOG_FORMAT=json`, the Docker default) or a
readable line (`LOG_FORMAT=text`). Every line carries the context of the
request it belongs to:

| Field | Meaning |
| --- | --- |
| `request_id` | Unique per request; returned to the browser as `X-Request-ID` |
| `user_id` | The signed-in user, once authenticated |
| `conversation_id` | Set during a chat turn |

### Events

**`request_completed`**: one per HTTP request, logged when the response,
including a stream, has finished. Fields: `method`, `path`, `status`,
`duration_ms`. Health checks are logged at `DEBUG` to keep the polling quiet.

**`turn_completed`**: one per chat turn. **`turn_failed`** has the same
fields plus the traceback.

| Field | Meaning |
| --- | --- |
| `duration_ms` | Whole turn, including tools |
| `model_calls`, `model_ms`, `model_errors` | LLM calls, their total latency, and failures |
| `tool_rounds` | Model replies that requested tools |
| `tool_calls`, `tools` | Tool executions, each with `name`, `ms`, and `status` |
| `limit_reached` | Whether the tool round limit forced an answer |
| `tokens` | `input`, `output`, and `reasoning` tokens reported by the model |
| `streamed` | Whether the turn was streamed to the browser |

### Querying

`fromjson?` skips any line that is not JSON, so the queries keep working
even if a library prints plain text.

```bash
# Agent turns, newest last
docker compose logs backend --no-log-prefix | jq -R 'fromjson? | select(.event=="turn_completed")'

# Everything for one request (copy X-Request-ID from the browser's network tab)
docker compose logs backend --no-log-prefix | jq -R 'fromjson? | select(.request_id=="<id>")'

# Turns that hit the tool round limit, and failures
docker compose logs backend --no-log-prefix | jq -R 'fromjson? | select(.limit_reached==true or .event=="turn_failed")'

# Token usage per turn
docker compose logs backend --no-log-prefix | jq -cR 'fromjson? | select(.event=="turn_completed") | {request_id, tokens}'
```

### Privacy

Logs contain identifiers, counts, durations, and statuses only. They never
contain message text, assistant replies, memories, search queries, email
addresses, passwords, or API keys. HTTP and LLM client libraries are held
at `WARNING` so that `LOG_LEVEL=DEBUG` cannot log request bodies. A test
(`tests/test_telemetry.py`) checks that a turn's content never reaches the
logs.

## LangSmith tracing (optional)

[LangSmith](https://smith.langchain.com) shows each graph run step by step:
model inputs and outputs, tool calls, and timings. LangChain enables it
from environment variables:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=<your key>
LANGSMITH_PROJECT=curibot
```

Then rebuild the backend: `docker compose up -d --build backend`. The
project appears in LangSmith after the first trace is accepted.

### Troubleshooting

If no project appears, look for upload warnings:

```bash
docker compose logs backend --no-log-prefix | jq -R 'fromjson? | select(.logger=="langsmith.client") | .event'
```

`403 Forbidden` means the key was rejected:

- Use a key that starts with `lsv2_pt_` (personal access token) or
  `lsv2_sk_` (service key), from **Settings → API Keys** in LangSmith.
- EU accounts (`eu.smith.langchain.com`) also need
  `LANGSMITH_ENDPOINT=https://eu.api.smith.langchain.com`.
- Service keys that span several workspaces also need
  `LANGSMITH_WORKSPACE_ID`.

### Finding a trace from a log line

Each chat turn is traced as a run named **`chat_turn`**, tagged with
`curibot` plus `web_search` and/or `memory` when those features are on,
and carrying the same IDs as the logs as metadata:

| Metadata | Matches the log field |
| --- | --- |
| `request_id` | `request_id` (also the `X-Request-ID` response header) |
| `conversation_id` | `conversation_id` |
| `user_id` | `user_id` |
| `streamed` | `streamed` |

To investigate a `turn_failed` or slow `turn_completed` line, copy its
`request_id`, open the project in LangSmith, and filter runs by
**Metadata → `request_id`**. The trace shows every model input and output
and every tool call in that turn.

Unlike the logs, **traces include full message content**, so tracing is
off by default. Enable it for development and debugging, not for real
users' data unless they have agreed to it.
