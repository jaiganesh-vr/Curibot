import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.postgres import PostgresSaver
from pydantic import ConfigDict
from sqlalchemy import create_engine, make_url, select, text
from sqlalchemy.engine import URL
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.models import Conversation, Message, User
from app.services.conversations import send_message

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests.",
)


def test_concurrent_transactions_serialize_conversation_row_lock() -> None:
    database_url = os.environ["TEST_DATABASE_URL"]
    parsed_url: URL = make_url(database_url)

    if parsed_url.database != "conversation_agent_test":
        pytest.fail(
            "Refusing to run PostgreSQL integration tests against "
            f"database {parsed_url.database!r}; expected "
            "'conversation_agent_test'."
        )

    if parsed_url.get_backend_name() != "postgresql":
        pytest.fail("PostgreSQL integration tests require a PostgreSQL URL.")

    engine = create_engine(database_url, pool_pre_ping=True)
    session_factory = sessionmaker(bind=engine, class_=Session)

    user_id = uuid4()
    conversation_id = uuid4()
    email = f"postgres-lock-test-{user_id}@example.invalid"

    first_lock_acquired = Event()
    second_query_started = Event()
    release_first_transaction = Event()
    second_lock_acquired = Event()

    first_backend_pids: list[int] = []
    second_backend_pids: list[int] = []

    try:
        with session_factory.begin() as session:
            session.add(
                User(
                    id=user_id,
                    email=email,
                    hashed_password="integration-test-only",
                )
            )
            session.add(
                Conversation(
                    id=conversation_id,
                    user_id=user_id,
                    title="PostgreSQL lock integration test",
                )
            )

        def acquire_first_lock() -> None:
            with session_factory() as session:
                with session.begin():
                    backend_pid = session.execute(
                        text("SELECT pg_backend_pid()")
                    ).scalar_one()
                    first_backend_pids.append(backend_pid)

                    session.execute(
                        select(Conversation)
                        .where(Conversation.id == conversation_id)
                        .with_for_update()
                    ).scalar_one()

                    first_lock_acquired.set()

                    if not release_first_transaction.wait(timeout=10):
                        raise TimeoutError(
                            "Timed out waiting to release the first transaction."
                        )

        def acquire_second_lock() -> None:
            if not first_lock_acquired.wait(timeout=5):
                raise TimeoutError("The first transaction did not acquire its lock.")

            with session_factory() as session:
                with session.begin():
                    backend_pid = session.execute(
                        text("SELECT pg_backend_pid()")
                    ).scalar_one()
                    second_backend_pids.append(backend_pid)
                    second_query_started.set()

                    session.execute(
                        select(Conversation)
                        .where(Conversation.id == conversation_id)
                        .with_for_update()
                    ).scalar_one()

                    second_lock_acquired.set()

        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(acquire_first_lock)
            second_future = executor.submit(acquire_second_lock)

            try:
                assert first_lock_acquired.wait(timeout=5), (
                    "The first transaction did not acquire its lock."
                )
                assert second_query_started.wait(timeout=5), (
                    "The second transaction did not start its query."
                )

                second_backend_pid = second_backend_pids[0]
                first_backend_pid = first_backend_pids[0]
                deadline = monotonic() + 5
                observed_blocker = False

                # Ask PostgreSQL whether the second backend is blocked
                # specifically by the first backend.
                with session_factory() as monitor_session:
                    while monotonic() < deadline:
                        blocking_pids = monitor_session.execute(
                            text("SELECT pg_blocking_pids(:backend_pid)"),
                            {"backend_pid": second_backend_pid},
                        ).scalar_one()

                        if first_backend_pid in blocking_pids:
                            observed_blocker = True
                            break

                        if second_lock_acquired.is_set():
                            break

                        sleep(0.05)

                assert observed_blocker, (
                    "PostgreSQL did not report the first transaction as "
                    "blocking the second transaction."
                )
                assert not second_lock_acquired.is_set(), (
                    "The second transaction acquired the lock before "
                    "the first transaction released it."
                )
            finally:
                release_first_transaction.set()

            first_future.result(timeout=10)
            second_future.result(timeout=10)

        assert second_lock_acquired.is_set(), (
            "The second transaction did not acquire the lock after release."
        )
    finally:
        release_first_transaction.set()

        try:
            with session_factory.begin() as session:
                conversation = session.get(Conversation, conversation_id)
                if conversation is not None:
                    session.delete(conversation)

                user = session.get(User, user_id)
                if user is not None:
                    session.delete(user)
        finally:
            engine.dispose()


def test_concurrent_messages_serialize_service_and_persist_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from langchain_core.messages import AIMessage

    database_url = os.environ["TEST_DATABASE_URL"]
    parsed_url = make_url(database_url)

    if parsed_url.database != "conversation_agent_test":
        pytest.fail(
            "Refusing to run against a database other than 'conversation_agent_test'."
        )

    if parsed_url.get_backend_name() != "postgresql":
        pytest.fail("PostgreSQL integration tests require PostgreSQL.")

    engine = create_engine(database_url, pool_pre_ping=True)
    session_factory = sessionmaker(bind=engine, class_=Session)

    user_id = uuid4()
    conversation_id = uuid4()
    email = f"postgres-service-test-{user_id}@example.invalid"

    graph_call_lock = Event()
    second_graph_entered = Event()
    release_first_graph = Event()
    graph_inputs: list[list[str]] = []

    class FakeGraph:
        def invoke(self, state, config=None):
            messages = state["messages"]
            contents = [str(message.content) for message in messages]

            # Each service call must reach this fake graph serially.
            if contents[-1] == "First concurrent question":
                graph_inputs.append(contents)
                graph_call_lock.set()

                if not release_first_graph.wait(timeout=10):
                    raise TimeoutError("Timed out releasing the first graph call.")

                return {
                    "messages": [
                        *messages,
                        AIMessage(content="Answer to the first question"),
                    ]
                }

            graph_inputs.append(contents)
            second_graph_entered.set()

            return {
                "messages": [
                    *messages,
                    AIMessage(content="Answer to the second question"),
                ]
            }

    monkeypatch.setattr(
        "app.services.conversations.build_chat_graph",
        lambda **kwargs: FakeGraph(),
    )

    try:
        with session_factory.begin() as session:
            user = User(
                id=user_id,
                email=email,
                hashed_password="integration-test-only",
            )
            session.add(user)
            session.add(
                Conversation(
                    id=conversation_id,
                    user_id=user_id,
                    title="Concurrent service test",
                )
            )

        def send(content: str) -> tuple[str, str]:
            with session_factory() as session:
                user = session.get(User, user_id)
                assert user is not None

                user_message, assistant_message = send_message(
                    session,
                    user,
                    conversation_id,
                    content,
                )
                return user_message.content, assistant_message.content

        with ThreadPoolExecutor(max_workers=2) as executor:
            first_future = executor.submit(send, "First concurrent question")

            try:
                assert graph_call_lock.wait(timeout=5), (
                    "The first service call did not reach the graph."
                )

                second_future = executor.submit(
                    send,
                    "Second concurrent question",
                )

                # The second call should wait on the conversation row lock,
                # and must not enter the graph while the first graph is blocked.
                assert not second_graph_entered.wait(timeout=0.5), (
                    "The second graph invocation started before the first "
                    "transaction completed."
                )
            finally:
                release_first_graph.set()

            assert first_future.result(timeout=10) == (
                "First concurrent question",
                "Answer to the first question",
            )
            assert second_future.result(timeout=10) == (
                "Second concurrent question",
                "Answer to the second question",
            )

        assert second_graph_entered.is_set()

        with session_factory() as session:
            persisted = list(
                session.scalars(
                    select(Message)
                    .where(Message.conversation_id == conversation_id)
                    .order_by(Message.created_at, Message.id)
                )
            )

        assert [(message.role, message.content) for message in persisted] == [
            ("user", "First concurrent question"),
            ("assistant", "Answer to the first question"),
            ("user", "Second concurrent question"),
            ("assistant", "Answer to the second question"),
        ]

        assert len(graph_inputs) == 2
        assert graph_inputs[0] == ["First concurrent question"]
        assert graph_inputs[1] == [
            "First concurrent question",
            "Answer to the first question",
            "Second concurrent question",
        ]
    finally:
        release_first_graph.set()

        try:
            with session_factory.begin() as session:
                conversation = session.get(Conversation, conversation_id)
                if conversation is not None:
                    session.delete(conversation)

                user = session.get(User, user_id)
                if user is not None:
                    session.delete(user)
        finally:
            engine.dispose()


def test_postgres_checkpoint_recovers_after_message_commit_failure() -> None:

    database_url = os.environ["TEST_DATABASE_URL"]
    parsed_url = make_url(database_url)

    if parsed_url.database != "conversation_agent_test":
        pytest.fail(
            "Refusing to run against a database other than 'conversation_agent_test'."
        )
    if parsed_url.get_backend_name() != "postgresql":
        pytest.fail("PostgreSQL integration tests require PostgreSQL.")

    engine = create_engine(database_url, pool_pre_ping=True)
    session_factory = sessionmaker(bind=engine, class_=Session)

    user_id = uuid4()
    conversation_id = uuid4()
    thread_id = str(conversation_id)
    email = f"postgres-checkpoint-test-{user_id}@example.invalid"

    class ProbeChatModel(BaseChatModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)

        @property
        def _llm_type(self) -> str:
            return "postgres-checkpoint-test"

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            return ChatResult(
                generations=[
                    ChatGeneration(
                        message=AIMessage(content="Deterministic test answer")
                    )
                ]
            )

    try:
        with session_factory.begin() as session:
            session.add(
                User(
                    id=user_id,
                    email=email,
                    hashed_password="integration-test-only",
                )
            )
            session.add(
                Conversation(
                    id=conversation_id,
                    user_id=user_id,
                    title="Checkpoint recovery integration test",
                )
            )

        with PostgresSaver.from_conn_string(database_url) as checkpointer:
            checkpointer.setup()
            config = {"configurable": {"thread_id": thread_id}}

            assert checkpointer.get_tuple(config) is None

            with session_factory() as session:
                user = session.get(User, user_id)
                assert user is not None

                original_commit = session.commit
                commit_calls = 0

                def fail_first_commit() -> None:
                    nonlocal commit_calls
                    commit_calls += 1
                    if commit_calls == 1:
                        raise SQLAlchemyError("Simulated message commit failure")
                    original_commit()

                session.commit = fail_first_commit  # type: ignore[method-assign]

                with pytest.raises(
                    SQLAlchemyError,
                    match="Simulated message commit failure",
                ):
                    send_message(
                        session,
                        user,
                        conversation_id,
                        "Failed question",
                        model=ProbeChatModel(),
                        checkpointer=checkpointer,
                    )

                session.rollback()

            checkpoint_after_failure = checkpointer.get_tuple(config)
            assert checkpoint_after_failure is not None
            checkpoint_messages = checkpoint_after_failure.checkpoint["channel_values"][
                "messages"
            ]
            assert [message.content for message in checkpoint_messages] == [
                "Failed question",
                "Deterministic test answer",
            ]

            with session_factory() as session:
                saved_messages = list(
                    session.scalars(
                        select(Message).where(
                            Message.conversation_id == conversation_id
                        )
                    )
                )
                assert saved_messages == []

                user = session.get(User, user_id)
                assert user is not None

                user_message, assistant_message = send_message(
                    session,
                    user,
                    conversation_id,
                    "Retry question",
                    model=ProbeChatModel(),
                    checkpointer=checkpointer,
                )

                assert user_message.content == "Retry question"
                assert assistant_message.content == "Deterministic test answer"

            recovered_checkpoint = checkpointer.get_tuple(config)
            assert recovered_checkpoint is not None
            recovered_messages = recovered_checkpoint.checkpoint["channel_values"][
                "messages"
            ]
            assert [message.content for message in recovered_messages] == [
                "Retry question",
                "Deterministic test answer",
            ]

        with session_factory() as session:
            persisted = list(
                session.scalars(
                    select(Message)
                    .where(Message.conversation_id == conversation_id)
                    .order_by(Message.created_at, Message.id)
                )
            )
            assert [(message.role, message.content) for message in persisted] == [
                ("user", "Retry question"),
                ("assistant", "Deterministic test answer"),
            ]
    finally:
        try:
            with PostgresSaver.from_conn_string(database_url) as checkpointer:
                checkpointer.delete_thread(thread_id)
        finally:
            try:
                with session_factory.begin() as session:
                    conversation = session.get(Conversation, conversation_id)
                    if conversation is not None:
                        session.delete(conversation)

                    user = session.get(User, user_id)
                    if user is not None:
                        session.delete(user)
            finally:
                engine.dispose()
