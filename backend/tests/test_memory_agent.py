"""Long-term memory in the agent: tools, prompt injection, and transactions."""

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.services.chat_graph import build_chat_graph
from app.services.conversations import (
    ChatGenerationError,
    ToolCallEvent,
    create_conversation,
    send_message,
    stream_message,
)
from app.services.memories import list_memories, save_memory
from app.services.memory_tools import MemoryAccess, build_memory_tools
from tests.test_agent_loop import ScriptedToolModel
from tests.test_conversation_persistence import create_user


def tool_call(name: str, args: dict[str, object], call_id: str = "m1") -> AIMessage:
    return AIMessage(
        content="", tool_calls=[{"name": name, "args": args, "id": call_id}]
    )


def system_prompt_of(call: list) -> str:  # type: ignore[type-arg]
    assert isinstance(call[0], SystemMessage)
    return str(call[0].content)


def test_memory_access_reports_each_outcome(db_session: Session) -> None:
    user = create_user(db_session)
    access = MemoryAccess(db_session, user.id)

    assert access.save("Prefers Python") == "Saved to memory."
    assert access.save("prefers python") == "Already remembered."
    assert access.save("   ").startswith("Not saved:")
    assert access.contents() == ["Prefers Python"]
    assert access.delete(5) == "No memory numbered 5."
    assert access.delete(1) == "Deleted memory 1."
    assert access.contents() == []


def test_memory_tools_validate_their_input(db_session: Session) -> None:
    user = create_user(db_session)
    save_tool, delete_tool = build_memory_tools(MemoryAccess(db_session, user.id))

    assert (
        save_tool.invoke({"memory": "Works as a data engineer"}) == "Saved to memory."
    )
    assert delete_tool.invoke({"memory_number": 1}) == "Deleted memory 1."
    with pytest.raises(ValueError):
        save_tool.invoke({"memory": "x" * 301})


def test_saved_memory_is_visible_later_in_the_same_turn(db_session: Session) -> None:
    user = create_user(db_session)
    model = ScriptedToolModel(
        script=[
            tool_call("save_memory", {"memory": "Name is Jaiganesh"}),
            AIMessage("Nice to meet you, Jaiganesh!"),
        ],
        calls=[],
        tool_choices=[],
    )
    graph = build_chat_graph(
        model=model, tools=[], memory=MemoryAccess(db_session, user.id)
    )

    result = graph.invoke({"messages": [HumanMessage("I'm Jaiganesh.")]})

    assert result["messages"][-1].content == "Nice to meet you, Jaiganesh!"
    assert "Long-term memory" in system_prompt_of(model.calls[0])
    assert "Nothing yet." in system_prompt_of(model.calls[0])
    assert "[1] Name is Jaiganesh" in system_prompt_of(model.calls[1])


def test_delete_memory_by_number(db_session: Session) -> None:
    user = create_user(db_session)
    save_memory(db_session, user.id, "Lives in Chennai")
    save_memory(db_session, user.id, "Prefers Python")
    model = ScriptedToolModel(
        script=[
            tool_call("delete_memory", {"memory_number": 1}),
            AIMessage("Done, I've forgotten that."),
        ],
        calls=[],
        tool_choices=[],
    )
    graph = build_chat_graph(
        model=model, tools=[], memory=MemoryAccess(db_session, user.id)
    )

    graph.invoke({"messages": [HumanMessage("Forget where I live.")]})

    assert "[1] Lives in Chennai" in system_prompt_of(model.calls[0])
    assert [m.content for m in list_memories(db_session, user.id)] == ["Prefers Python"]


def enable_memory(monkeypatch: pytest.MonkeyPatch, model: ScriptedToolModel) -> None:
    """Route the chat service through a graph with memory and the given model."""
    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: build_chat_graph(
            model=model,
            checkpointer=kwargs.get("checkpointer"),
            tools=[],
            memory=kwargs.get("memory"),
        ),
    )
    monkeypatch.setenv("MEMORY_ENABLED", "true")
    get_settings.cache_clear()


def test_memories_carry_over_to_a_new_conversation(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = ScriptedToolModel(
        script=[
            tool_call("save_memory", {"memory": "Prefers concise answers"}),
            AIMessage("Noted."),
            AIMessage("Short answer."),
        ],
        calls=[],
        tool_choices=[],
    )
    enable_memory(monkeypatch, model)
    user = create_user(db_session)
    first = create_conversation(db_session, user)
    second = create_conversation(db_session, user)

    send_message(db_session, user, first.id, "Keep answers short, please.")
    send_message(db_session, user, second.id, "What is HTTP?")

    assert "[1] Prefers concise answers" in system_prompt_of(model.calls[-1])


def test_stream_reports_saving_a_memory(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = ScriptedToolModel(
        script=[
            tool_call("save_memory", {"memory": "Is learning Rust"}),
            AIMessage("Good luck with Rust!"),
        ],
        calls=[],
        tool_choices=[],
    )
    enable_memory(monkeypatch, model)
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    events = list(
        stream_message(db_session, user, conversation.id, "I'm learning Rust")
    )

    assert ToolCallEvent(name="save_memory", query="Is learning Rust") in events
    assert [m.content for m in list_memories(db_session, user.id)] == [
        "Is learning Rust"
    ]


def test_memory_saved_in_a_failed_turn_is_rolled_back(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailsAfterSaving(ScriptedToolModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):  # type: ignore[no-untyped-def]
            if self.calls:
                raise RuntimeError("model crashed mid-turn")
            return super()._generate(messages, stop, run_manager, **kwargs)

    model = FailsAfterSaving(
        script=[tool_call("save_memory", {"memory": "Should not persist"})],
        calls=[],
        tool_choices=[],
    )
    enable_memory(monkeypatch, model)
    user = create_user(db_session)
    db_session.commit()
    conversation = create_conversation(db_session, user)

    with pytest.raises(ChatGenerationError):
        list(stream_message(db_session, user, conversation.id, "Remember this"))

    assert list_memories(db_session, user.id) == []


def test_memory_is_off_when_disabled(db_session: Session) -> None:
    model = ScriptedToolModel(script=[AIMessage("Hi")], calls=[], tool_choices=[])
    user = create_user(db_session)
    conversation = create_conversation(db_session, user)

    send_message(db_session, user, conversation.id, "Hello", model=model)

    assert "Long-term memory" not in system_prompt_of(model.calls[0])
