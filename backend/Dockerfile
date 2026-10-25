FROM python:3.13-slim

# Pinned so rebuilds are reproducible; keep in step with the local uv.
COPY --from=ghcr.io/astral-sh/uv:0.12.8 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app

EXPOSE 8000

# Apply pending migrations before serving, so a fresh database gets its
# tables. exec hands PID 1 to uvicorn so it receives shutdown signals.
CMD ["sh", "-c", "uv run --no-sync alembic upgrade head && exec uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000"]
