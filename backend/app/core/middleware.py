import logging
import re
import uuid
from time import perf_counter

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import end_request_context, log_event, start_request_context

logger = logging.getLogger("app.request")

REQUEST_ID_HEADER = "X-Request-ID"
# Accept a caller's ID only if it is short and safe to echo and log.
_VALID_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class RequestContextMiddleware:
    """Give every request an ID, echo it back, and log the outcome.

    A pure ASGI middleware rather than BaseHTTPMiddleware, so a streaming
    response is logged when its body has actually finished.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = dict(scope["headers"]).get(REQUEST_ID_HEADER.lower().encode())
        candidate = incoming.decode("latin-1") if incoming else ""
        request_id = (
            candidate if _VALID_REQUEST_ID.match(candidate) else uuid.uuid4().hex
        )

        token = start_request_context(request_id)
        started = perf_counter()
        status = 500

        async def send_with_request_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)[REQUEST_ID_HEADER] = request_id
            await send(message)

        try:
            await self.app(scope, receive, send_with_request_id)
        finally:
            path = scope["path"]
            # The frontend polls the health check; keep it out of INFO logs.
            level = logging.DEBUG if path.startswith("/health") else logging.INFO
            log_event(
                logger,
                "request_completed",
                level,
                method=scope["method"],
                path=path,
                status=status,
                duration_ms=round((perf_counter() - started) * 1000),
            )
            end_request_context(token)
