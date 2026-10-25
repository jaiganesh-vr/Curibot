from app.models import UserMemory
from tests.test_conversation_routes import (
    TestingSessionLocal,
    client,
    create_authenticated_user,
    setup_database,  # noqa: F401 - autouse fixture: test database and auth
)


def add_memory(user_id, content: str) -> str:  # type: ignore[no-untyped-def]
    with TestingSessionLocal() as db:
        memory = UserMemory(user_id=user_id, content=content)
        db.add(memory)
        db.commit()
        return str(memory.id)


def test_memory_endpoints_require_authentication() -> None:
    memory_id = "00000000-0000-0000-0000-000000000001"

    assert client.get("/api/v1/memories").status_code == 401
    assert client.delete(f"/api/v1/memories/{memory_id}").status_code == 401
    assert client.delete("/api/v1/memories").status_code == 401


def test_list_returns_only_the_current_users_memories() -> None:
    owner, owner_headers = create_authenticated_user("owner@example.com")
    other, _ = create_authenticated_user("other@example.com")
    add_memory(owner.id, "Prefers Python")
    add_memory(other.id, "Other user's fact")

    response = client.get("/api/v1/memories", headers=owner_headers)

    assert response.status_code == 200
    assert [m["content"] for m in response.json()] == ["Prefers Python"]
    assert set(response.json()[0]) == {"id", "content", "created_at"}


def test_delete_one_memory_for_its_owner_only() -> None:
    owner, owner_headers = create_authenticated_user("owner@example.com")
    _, other_headers = create_authenticated_user("other@example.com")
    memory_id = add_memory(owner.id, "Lives in Chennai")

    forbidden = client.delete(f"/api/v1/memories/{memory_id}", headers=other_headers)
    assert forbidden.status_code == 404

    deleted = client.delete(f"/api/v1/memories/{memory_id}", headers=owner_headers)
    assert deleted.status_code == 204
    assert client.get("/api/v1/memories", headers=owner_headers).json() == []


def test_clear_removes_only_the_current_users_memories() -> None:
    owner, owner_headers = create_authenticated_user("owner@example.com")
    other, other_headers = create_authenticated_user("other@example.com")
    add_memory(owner.id, "First")
    add_memory(owner.id, "Second")
    add_memory(other.id, "Keep me")

    response = client.delete("/api/v1/memories", headers=owner_headers)

    assert response.status_code == 204
    assert client.get("/api/v1/memories", headers=owner_headers).json() == []
    assert [
        m["content"]
        for m in client.get("/api/v1/memories", headers=other_headers).json()
    ] == ["Keep me"]
