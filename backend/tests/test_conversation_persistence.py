from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Conversation, Message, User


def create_user(db: Session, email: str = "test@example.com") -> User:
    user = User(email=email, hashed_password="test-hash")
    db.add(user)
    db.flush()
    return user


def test_create_conversation_for_user(db_session: Session) -> None:
    user = create_user(db_session)
    conversation = Conversation(user=user, title="Test conversation")

    db_session.add(conversation)
    db_session.commit()

    saved = db_session.scalar(
        select(Conversation).where(Conversation.id == conversation.id)
    )

    assert saved is not None
    assert saved.user_id == user.id
    assert saved.title == "Test conversation"


def test_messages_persist_and_retrieve_in_order(db_session: Session) -> None:
    user = create_user(db_session)
    conversation = Conversation(user=user)
    base_time = datetime.now(UTC)

    conversation.messages.extend(
        [
            Message(
                role="user",
                content="Hello",
                created_at=base_time,
            ),
            Message(
                role="assistant",
                content="Hi there",
                created_at=base_time + timedelta(seconds=1),
            ),
        ]
    )

    db_session.add(conversation)
    db_session.commit()

    messages = list(
        db_session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at, Message.id)
        )
    )

    assert [message.role for message in messages] == ["user", "assistant"]
    assert [message.content for message in messages] == ["Hello", "Hi there"]


def test_database_rejects_invalid_message_role(db_session: Session) -> None:
    user = create_user(db_session)
    conversation = Conversation(user=user)
    db_session.add(conversation)
    db_session.flush()

    db_session.add(
        Message(
            conversation_id=conversation.id,
            role="invalid",
            content="This should fail",
        )
    )

    with pytest.raises(IntegrityError):
        db_session.flush()

    db_session.rollback()


def test_deleting_conversation_cascades_to_messages(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = Conversation(
        user=user,
        messages=[Message(role="user", content="Delete me")],
    )
    db_session.add(conversation)
    db_session.commit()
    conversation_id = conversation.id

    # Use a direct SQL DELETE to verify the database-level cascade.
    db_session.execute(delete(Conversation).where(Conversation.id == conversation_id))
    db_session.commit()

    remaining = db_session.scalar(
        select(func.count())
        .select_from(Message)
        .where(Message.conversation_id == conversation_id)
    )
    assert remaining == 0


def test_deleting_user_cascades_to_conversations_and_messages(
    db_session: Session,
) -> None:
    user = create_user(db_session)
    conversation = Conversation(
        user=user,
        messages=[Message(role="user", content="Delete me too")],
    )
    db_session.add(conversation)
    db_session.commit()
    user_id = user.id
    conversation_id = conversation.id

    # Verify database cascades independently of ORM relationship cascades.
    db_session.execute(delete(User).where(User.id == user_id))
    db_session.commit()

    remaining_conversations = db_session.scalar(
        select(func.count())
        .select_from(Conversation)
        .where(Conversation.user_id == user_id)
    )
    remaining_messages = db_session.scalar(
        select(func.count())
        .select_from(Message)
        .where(Message.conversation_id == conversation_id)
    )

    assert remaining_conversations == 0
    assert remaining_messages == 0
