from sqlalchemy import CheckConstraint, String, Text
from sqlalchemy.orm import configure_mappers

from app.db.base import Base
from app.models import Conversation, Message, User


def test_all_models_are_registered() -> None:
    assert {"users", "conversations", "messages"} <= set(Base.metadata.tables.keys())


def test_conversation_schema() -> None:
    table = Conversation.__table__

    assert table.c.id.primary_key
    assert not table.c.user_id.nullable
    assert table.c.title.nullable
    assert table.c.title.type.length == 200

    foreign_key = next(iter(table.c.user_id.foreign_keys))
    assert foreign_key.target_fullname == "users.id"
    assert foreign_key.ondelete == "CASCADE"

    assert "ix_conversations_user_id" in {index.name for index in table.indexes}


def test_message_schema() -> None:
    table = Message.__table__

    assert table.c.id.primary_key
    assert not table.c.conversation_id.nullable
    assert not table.c.role.nullable
    assert isinstance(table.c.role.type, String)
    assert table.c.role.type.length == 20
    assert isinstance(table.c.content.type, Text)
    assert not table.c.content.nullable

    foreign_key = next(iter(table.c.conversation_id.foreign_keys))
    assert foreign_key.target_fullname == "conversations.id"
    assert foreign_key.ondelete == "CASCADE"

    indexes = {index.name for index in table.indexes}
    assert "ix_messages_conversation_created_id" in indexes

    constraints = {
        constraint.name: constraint
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert "ck_messages_role" in constraints
    assert str(constraints["ck_messages_role"].sqltext) == (
        "role IN ('system', 'user', 'assistant', 'tool')"
    )


def test_relationships_are_configured() -> None:
    configure_mappers()

    assert list(User.__mapper__.relationships.keys()) == [
        "conversations",
        "memories",
    ]
    assert list(Conversation.__mapper__.relationships.keys()) == [
        "user",
        "messages",
    ]
    assert list(Message.__mapper__.relationships.keys()) == ["conversation"]

    assert User.__mapper__.relationships["conversations"].cascade.delete_orphan
    assert User.__mapper__.relationships["memories"].cascade.delete_orphan
    assert Conversation.__mapper__.relationships["messages"].cascade.delete_orphan
