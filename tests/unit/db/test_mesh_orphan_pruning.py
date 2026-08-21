"""Regression tests for safe orphaned mesh peer row pruning."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import aiosqlite
import pytest

from app.services.db.manager import DatabaseManager
from app.shared.contracts.models.db import DBPruneOrphanedMeshPeerRowsRequest


async def _create_mesh_peer_schema(db_path: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(
            """
            CREATE TABLE mesh_peers (
                id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                node_name TEXT NOT NULL DEFAULT '',
                room_name TEXT NOT NULL,
                outbound_status TEXT NOT NULL DEFAULT 'pending',
                outbound_permissions TEXT NOT NULL DEFAULT '[]',
                outbound_token_id TEXT,
                outbound_device_id TEXT,
                outbound_user_id TEXT,
                inbound_status TEXT NOT NULL DEFAULT 'unknown',
                inbound_token TEXT,
                inbound_token_id TEXT,
                first_seen_at TIMESTAMP,
                last_seen_at TIMESTAMP,
                updated_at TIMESTAMP,
                UNIQUE(peer_id, room_name)
            );
            CREATE TABLE mesh_peer_auth_grant_revisions (
                peer_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
                disposition TEXT NOT NULL DEFAULT 'present'
                    CHECK (disposition IN ('present', 'removed')),
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        await db.commit()


async def _insert_peer(
    db: aiosqlite.Connection,
    row_id: str,
    *,
    peer_id: str | None = None,
    node_name: str = "Laptop",
    room_name: str | None = None,
    outbound_status: str = "pending",
    inbound_status: str = "unknown",
    outbound_token_id: str | None = None,
    inbound_token: str | None = None,
    inbound_token_id: str | None = None,
    first_seen_at: datetime,
    last_seen_at: datetime | None = None,
) -> None:
    await db.execute(
        """
        INSERT INTO mesh_peers (
            id, peer_id, node_name, room_name, outbound_status, outbound_permissions,
            outbound_token_id, inbound_status, inbound_token, inbound_token_id,
            first_seen_at, last_seen_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row_id,
            peer_id or row_id,
            node_name,
            room_name or f"{row_id}-room",
            outbound_status,
            outbound_token_id,
            inbound_status,
            inbound_token,
            inbound_token_id,
            first_seen_at.isoformat(sep=" ", timespec="seconds"),
            last_seen_at.isoformat(sep=" ", timespec="seconds") if last_seen_at else None,
            first_seen_at.isoformat(sep=" ", timespec="seconds"),
        ),
    )


async def _peer_rows(db_path: str) -> dict[str, tuple[object, ...]]:
    async with aiosqlite.connect(db_path) as db:
        rows = await (
            await db.execute(
                """
                SELECT id, peer_id, node_name, outbound_status, inbound_status,
                       outbound_token_id, inbound_token, inbound_token_id
                FROM mesh_peers
                ORDER BY id
                """
            )
        ).fetchall()
    return {str(row[0]): tuple(row[1:]) for row in rows}


async def _authority_rows(db_path: str) -> list[tuple[object, ...]]:
    async with aiosqlite.connect(db_path) as db:
        return await (
            await db.execute(
                """
                SELECT peer_id, revision, disposition
                FROM mesh_peer_auth_grant_revisions
                ORDER BY peer_id
                """
            )
        ).fetchall()


@pytest.mark.asyncio
async def test_prunes_only_old_never_approved_credentialless_mesh_peer_rows(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-orphan-prune.db")
    await _create_mesh_peer_schema(db_path)
    now = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)
    old = now - timedelta(days=40)
    recent = now - timedelta(hours=6)

    async with aiosqlite.connect(db_path) as db:
        await _insert_peer(db, "old-unknown", first_seen_at=old)
        await _insert_peer(
            db,
            "old-pending",
            inbound_status="pending",
            first_seen_at=old,
            last_seen_at=old + timedelta(days=1),
        )
        await _insert_peer(db, "fresh-orphan", first_seen_at=recent)
        await _insert_peer(db, "denied-peer", outbound_status="denied", first_seen_at=old)
        await _insert_peer(db, "approved-peer", outbound_status="approved", first_seen_at=old)
        await _insert_peer(
            db,
            "outbound-token-peer",
            outbound_token_id="issued-token",
            first_seen_at=old,
        )
        await _insert_peer(
            db,
            "inbound-token-peer",
            inbound_token="sealed-token",
            first_seen_at=old,
        )
        await _insert_peer(
            db,
            "inbound-token-id-peer",
            inbound_token_id="remote-token-id",
            first_seen_at=old,
        )
        await _insert_peer(
            db,
            "same-name-approved",
            peer_id="different-stable-peer",
            node_name="Laptop",
            outbound_status="approved",
            first_seen_at=old,
        )
        await db.executemany(
            """
            INSERT INTO mesh_peer_auth_grant_revisions (peer_id, revision, disposition)
            VALUES (?, ?, ?)
            """,
            [
                ("old-unknown", 0, "present"),
                ("approved-peer", 7, "present"),
                ("different-stable-peer", 3, "present"),
            ],
        )
        await db.commit()

    manager = DatabaseManager(db_path=db_path)
    before_authority = await _authority_rows(db_path)

    result = await manager.prune_orphaned_mesh_peer_rows(
        DBPruneOrphanedMeshPeerRowsRequest(
            now=now.timestamp(),
            retention_seconds=30 * 24 * 60 * 60,
        )
    )

    assert result.success is True
    assert [(row.row_id, row.peer_id, row.room_name) for row in result.pruned_rows] == [
        ("old-unknown", "old-unknown", "old-unknown-room"),
        ("old-pending", "old-pending", "old-pending-room"),
    ]
    remaining = await _peer_rows(db_path)
    assert "old-unknown" not in remaining
    assert "old-pending" not in remaining
    assert set(remaining) == {
        "approved-peer",
        "denied-peer",
        "fresh-orphan",
        "inbound-token-id-peer",
        "inbound-token-peer",
        "outbound-token-peer",
        "same-name-approved",
    }
    assert remaining["same-name-approved"][:4] == (
        "different-stable-peer",
        "Laptop",
        "approved",
        "unknown",
    )
    assert await _authority_rows(db_path) == before_authority


@pytest.mark.asyncio
async def test_orphan_prune_is_bounded_by_max_rows(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-orphan-prune-bounded.db")
    await _create_mesh_peer_schema(db_path)
    now = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)
    old = now - timedelta(days=40)

    async with aiosqlite.connect(db_path) as db:
        await _insert_peer(db, "old-a", first_seen_at=old)
        await _insert_peer(db, "old-b", first_seen_at=old + timedelta(hours=1))
        await db.commit()

    manager = DatabaseManager(db_path=db_path)
    result = await manager.prune_orphaned_mesh_peer_rows(
        DBPruneOrphanedMeshPeerRowsRequest(
            now=now.timestamp(),
            retention_seconds=30 * 24 * 60 * 60,
            max_rows=1,
        )
    )

    assert result.success is True
    assert [row.row_id for row in result.pruned_rows] == ["old-a"]
    assert set(await _peer_rows(db_path)) == {"old-b"}
