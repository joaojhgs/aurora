"""Regression tests for principal-owned persisted chat sessions."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import aiosqlite
import pytest

from app.messaging import Envelope
from app.services.db.manager import DatabaseManager
from app.services.db.service import DBService
from app.shared.contracts.models.db import (
    DBCreateSessionRequest,
    DBGetSessionRequest,
    DBListSessionsRequest,
)
from app.shared.models.db import Message


@pytest.mark.asyncio
async def test_sessions_schema_requires_explicit_type_and_backfills_history(tmp_path: Path) -> None:
    """The migration preserves old threads without adding a DB type default."""

    db_path = tmp_path / "legacy.db"
    migrations = Path("app/services/db/migrations")
    async with aiosqlite.connect(db_path) as db:
        await db.executescript((migrations / "001_initial_schema.sql").read_text())
        await db.execute(
            """
            INSERT INTO messages (
                id, content, message_type, timestamp, session_id, metadata, source_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "legacy-message",
                "Preserve this conversation",
                "user_text",
                "2026-01-02T03:04:05+00:00",
                "legacy-session",
                None,
                "Text",
            ),
        )
        await db.executescript((migrations / "010_chat_sessions.sql").read_text())
        await db.commit()

        columns = await (await db.execute("PRAGMA table_info(sessions)")).fetchall()
        type_column = next(column for column in columns if column[1] == "type")
        assert type_column[3] == 1
        assert type_column[4] is None

        row = await (
            await db.execute(
                """
                SELECT id, principal_id, type, title
                FROM sessions
                WHERE id = 'legacy-session'
                """
            )
        ).fetchone()
        assert row == (
            "legacy-session",
            "system",
            "chat",
            "Preserve this conversation",
        )


@pytest.mark.asyncio
async def test_sessions_are_isolated_by_principal_and_track_message_counts(tmp_path: Path) -> None:
    """A session ID cannot be claimed or read by a different principal."""

    manager = DatabaseManager(str(tmp_path / "sessions.db"))
    await manager.initialize()

    first = await manager.ensure_session(
        principal_id="user-a",
        session_type="chat",
        session_id="shared-device-thread",
    )
    await manager.ensure_session(
        principal_id="user-a",
        session_type="chat",
        session_id="second-thread",
    )

    with pytest.raises(PermissionError):
        await manager.ensure_session(
            principal_id="user-b",
            session_type="chat",
            session_id=first.id,
        )

    assert await manager.get_session_for_principal(first.id, "user-b") is None
    assert await manager.get_session_messages_for_principal(first.id, "user-b") == []

    assert await manager.store_message(Message.create_user_text_message("First title", first.id))
    assert await manager.store_message(Message.create_assistant_message("First answer", first.id))

    stored = await manager.get_session_for_principal(first.id, "user-a")
    assert stored is not None
    assert stored.title == "First title"
    assert stored.message_count == 2
    assert [
        message.content
        for message in await manager.get_session_messages_for_principal(
            first.id,
            "user-a",
        )
    ] == ["First title", "First answer"]


@pytest.mark.asyncio
async def test_public_session_api_derives_principal_and_rejects_peer_transport(
    tmp_path: Path,
) -> None:
    """Public payloads cannot choose an owner and peer RPC cannot access sessions."""

    manager = DatabaseManager(str(tmp_path / "session-api.db"))
    await manager.initialize()
    service = object.__new__(DBService)
    service.db_manager = manager
    user_a = Envelope(
        type="DB.CreateSession",
        payload={},
        origin="external",
        principal_id="user-a",
        identity_source="gateway_http",
    )
    user_b = user_a.model_copy(update={"principal_id": "user-b"})

    created = await service.create_session(DBCreateSessionRequest(type="chat"), user_a)
    listed_a = await service.list_sessions(DBListSessionsRequest(type="chat"), user_a)
    listed_b = await service.list_sessions(DBListSessionsRequest(type="chat"), user_b)

    assert created.session.principal_id == "user-a"
    assert created.session.type == "chat"
    assert listed_a.active_session_id == created.session.id
    assert [session.id for session in listed_a.sessions] == [created.session.id]
    assert listed_b.sessions == []

    with pytest.raises(LookupError):
        await service.get_session(
            DBGetSessionRequest(session_id=created.session.id),
            user_b,
        )

    peer = user_a.model_copy(update={"identity_source": "webrtc_rpc", "caller_peer_id": "peer-1"})
    with pytest.raises(PermissionError):
        await service.list_sessions(DBListSessionsRequest(type="chat"), peer)


@pytest.mark.asyncio
async def test_last_opened_session_and_daemon_24_hour_cutoff(tmp_path: Path) -> None:
    """Wakeword chat reuses a recent global active thread and replaces a stale one."""

    db_path = tmp_path / "daemon-sessions.db"
    manager = DatabaseManager(str(db_path))
    await manager.initialize()
    fixed_now = datetime(2026, 7, 11, 12, 0, tzinfo=timezone.utc)

    recent = await manager.ensure_session(
        principal_id="user-a",
        session_type="chat",
        session_id="recent-thread",
    )
    older = await manager.ensure_session(
        principal_id="user-b",
        session_type="chat",
        session_id="older-thread",
    )
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE sessions SET last_active_at = ? WHERE id = ?",
            ((fixed_now - timedelta(hours=1)).isoformat(), recent.id),
        )
        await db.execute(
            "UPDATE sessions SET last_active_at = ? WHERE id = ?",
            ((fixed_now - timedelta(hours=2)).isoformat(), older.id),
        )
        await db.commit()

    reused = await manager.resolve_daemon_session(
        session_type="chat",
        stale_after_seconds=86_400,
        now=fixed_now,
    )
    assert reused.id == recent.id
    assert reused.principal_id == "user-a"
    assert reused.type == "chat"
    assert reused.last_active_at == fixed_now

    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE sessions SET last_active_at = ? WHERE id = ?",
            ((fixed_now - timedelta(hours=24)).isoformat(), recent.id),
        )
        await db.execute(
            "UPDATE sessions SET last_active_at = ? WHERE id = ?",
            ((fixed_now - timedelta(hours=25)).isoformat(), older.id),
        )
        await db.commit()

    created = await manager.resolve_daemon_session(
        session_type="chat",
        stale_after_seconds=86_400,
        now=fixed_now,
    )
    assert created.id != recent.id
    assert created.principal_id == "user-a"
    assert created.type == "chat"
    assert created.title == "Voice chat 2026-07-11"
