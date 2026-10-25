from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from langgraph.checkpoint.postgres import PostgresSaver
from sqlalchemy.exc import SQLAlchemyError

from app.api.routes.auth import router as auth_router
from app.api.routes.conversations import router as conversations_router
from app.core.config import get_settings
from app.db.session import check_database_connection


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage the PostgreSQL checkpoint saver lifecycle."""
    database_url = get_settings().get_database_url()
    conn_string = database_url.set(drivername="postgresql").render_as_string(
        hide_password=False
    )

    with PostgresSaver.from_conn_string(conn_string) as checkpointer:
        checkpointer.setup()
        app.state.checkpointer = checkpointer
        yield


app = FastAPI(
    title="Stateful Conversation Agent",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(auth_router, prefix="/api/v1")
app.include_router(conversations_router, prefix="/api/v1")


@app.get("/health/live", tags=["health"])
def health_live() -> dict[str, str]:
    return {"status": "alive"}


@app.get("/health/ready", tags=["health"])
def health_ready() -> dict[str, str]:
    try:
        check_database_connection()
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {"status": "ready", "database": "connected"}
