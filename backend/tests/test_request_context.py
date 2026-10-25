import logging

from tests.test_conversation_routes import (
    client,
    create_authenticated_user,
    setup_database,  # noqa: F401 - autouse fixture: test database and auth
)


def completed_records(caplog) -> list[logging.LogRecord]:  # type: ignore[no-untyped-def]
    return [r for r in caplog.records if r.getMessage() == "request_completed"]


def test_every_response_has_a_request_id() -> None:
    response = client.get("/health/live")

    request_id = response.headers["X-Request-ID"]
    assert len(request_id) == 32
    assert client.get("/health/live").headers["X-Request-ID"] != request_id


def test_a_valid_incoming_request_id_is_reused() -> None:
    response = client.get("/health/live", headers={"X-Request-ID": "trace-abc.123"})

    assert response.headers["X-Request-ID"] == "trace-abc.123"


def test_an_unsafe_incoming_request_id_is_replaced() -> None:
    unsafe = "bad id\nwith injection"
    response = client.get(
        "/health/live", headers={"X-Request-ID": unsafe.replace("\n", " ")}
    )

    assert response.headers["X-Request-ID"] != unsafe.replace("\n", " ")
    assert len(response.headers["X-Request-ID"]) == 32


def test_request_completed_is_logged_with_user_and_status(caplog) -> None:  # type: ignore[no-untyped-def]
    user, headers = create_authenticated_user("logged@example.com")

    with caplog.at_level(logging.INFO, logger="app.request"):
        response = client.get("/api/v1/conversations", headers=headers)

    record = completed_records(caplog)[-1]
    assert record.fields["method"] == "GET"
    assert record.fields["path"] == "/api/v1/conversations"
    assert record.fields["status"] == 200
    assert isinstance(record.fields["duration_ms"], int)
    assert record.context["request_id"] == response.headers["X-Request-ID"]
    assert record.context["user_id"] == str(user.id)


def test_failed_requests_are_logged_with_their_status(caplog) -> None:  # type: ignore[no-untyped-def]
    with caplog.at_level(logging.INFO, logger="app.request"):
        client.get("/api/v1/conversations")

    assert completed_records(caplog)[-1].fields["status"] == 401


def test_health_checks_are_kept_out_of_info_logs(caplog) -> None:  # type: ignore[no-untyped-def]
    with caplog.at_level(logging.INFO, logger="app.request"):
        client.get("/health/live")

    assert completed_records(caplog) == []


def test_cors_exposes_the_request_id_header() -> None:
    response = client.get("/health/live", headers={"Origin": "http://localhost:5173"})

    assert "x-request-id" in response.headers["access-control-expose-headers"].lower()
