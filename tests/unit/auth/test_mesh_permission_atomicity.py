"""Regression coverage for mesh peer permission authority atomicity."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import aiosqlite
import pytest

from app.messaging.bus import QueryResult
from app.services.auth.auth_manager import AuthManager
from app.services.auth.service import AuthService
from app.services.db.manager import DatabaseManager, MeshManagedAuthorityError
from app.shared.contracts.models.db import (
    DBApproveMeshPeerRequest,
    DBMeshAuthorityChange,
    DBMethods,
    DBUpdateMeshPeerPermissionsRequest,
)
from app.shared.contracts.models.mesh import (
    MeshEvents,
    MeshPeerApproveRequest,
    MeshPeerAuthorityChangedEvent,
    MeshPeerAuthoritySnapshot,
    MeshPeerAuthoritySnapshotRequest,
    MeshPeerUpdatePermissionsRequest,
)
from app.shared.models.db import Device, Token, User


async def _create_mesh_authority_graph(db_path: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(
            """
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                permissions TEXT NOT NULL,
                is_admin BOOLEAN NOT NULL
            );
            CREATE TABLE devices (
                id TEXT PRIMARY KEY,
                user_id TEXT
            );
            CREATE TABLE tokens (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                device_id TEXT,
                scopes TEXT NOT NULL
            );
            CREATE TABLE mesh_peers (
                id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                room_name TEXT NOT NULL,
                outbound_status TEXT NOT NULL,
                outbound_permissions TEXT NOT NULL,
                outbound_user_id TEXT,
                outbound_token_id TEXT,
                outbound_device_id TEXT,
                outbound_approved_at TIMESTAMP,
                outbound_approved_by TEXT,
                last_status_change_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE mesh_peer_auth_grant_revisions (
                peer_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
                disposition TEXT NOT NULL DEFAULT 'present'
                    CHECK (disposition IN ('present', 'removed')),
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO users (id, permissions, is_admin)
            VALUES ('mesh-user', '["Orchestrator.use"]', 0);
            INSERT INTO devices (id, user_id)
            VALUES ('mesh-device', 'mesh-user');
            INSERT INTO tokens (id, user_id, device_id, scopes)
            VALUES ('mesh-token', 'mesh-user', 'mesh-device', '["Orchestrator.use"]');
            INSERT INTO mesh_peers (
                id,
                peer_id,
                room_name,
                outbound_status,
                outbound_permissions,
                outbound_user_id,
                outbound_token_id,
                outbound_device_id
            ) VALUES (
                'mesh-row',
                'stable-peer',
                'room-a',
                'approved',
                '["Orchestrator.use"]',
                'mesh-user',
                'mesh-token',
                'mesh-device'
            );
            """
        )
        await db.commit()


async def _load_mesh_authority_graph(db_path: str) -> dict[str, object]:
    async with aiosqlite.connect(db_path) as db:
        peer = await (
            await db.execute("SELECT outbound_permissions FROM mesh_peers WHERE id = 'mesh-row'")
        ).fetchone()
        user = await (
            await db.execute("SELECT permissions, is_admin FROM users WHERE id = 'mesh-user'")
        ).fetchone()
        token = await (
            await db.execute("SELECT scopes FROM tokens WHERE id = 'mesh-token'")
        ).fetchone()

    assert peer is not None
    assert user is not None
    assert token is not None
    return {
        "peer_permissions": json.loads(peer[0]),
        "user_permissions": json.loads(user[0]),
        "user_is_admin": bool(user[1]),
        "token_scopes": json.loads(token[0]),
    }


async def _load_mesh_peer_rows(db_path: str) -> list[dict[str, object]]:
    async with aiosqlite.connect(db_path) as db:
        rows = await (
            await db.execute(
                """
                SELECT room_name, outbound_status, outbound_permissions,
                       outbound_approved_by
                FROM mesh_peers
                WHERE peer_id = 'stable-peer'
                ORDER BY room_name
                """
            )
        ).fetchall()
    return [
        {
            "room_name": row[0],
            "status": row[1],
            "permissions": json.loads(row[2]),
            "approved_by": row[3],
        }
        for row in rows
    ]


async def _load_authority_revision(
    db_path: str,
    peer_id: str = "stable-peer",
) -> tuple[int, str] | None:
    async with aiosqlite.connect(db_path) as db:
        row = await (
            await db.execute(
                """
                SELECT revision, disposition
                FROM mesh_peer_auth_grant_revisions
                WHERE peer_id = ?
                """,
                (peer_id,),
            )
        ).fetchone()
    return (int(row[0]), str(row[1])) if row else None


async def _create_full_mesh_credential_graph(db_path: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(
            """
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                permissions TEXT NOT NULL,
                is_admin BOOLEAN NOT NULL,
                created_at TIMESTAMP
            );
            CREATE TABLE devices (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                public_key TEXT,
                is_trusted BOOLEAN NOT NULL,
                created_at TIMESTAMP
            );
            CREATE TABLE tokens (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                user_id TEXT,
                token_hash TEXT NOT NULL,
                prefix TEXT NOT NULL,
                scopes TEXT NOT NULL,
                expires_at TIMESTAMP,
                created_at TIMESTAMP
            );
            CREATE TABLE mesh_peers (
                id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                room_name TEXT NOT NULL,
                outbound_status TEXT NOT NULL,
                outbound_permissions TEXT NOT NULL,
                outbound_user_id TEXT,
                outbound_token_id TEXT,
                outbound_device_id TEXT,
                outbound_approved_at TIMESTAMP,
                outbound_approved_by TEXT,
                last_status_change_at TIMESTAMP,
                updated_at TIMESTAMP
            );
            CREATE TABLE mesh_peer_auth_grant_revisions (
                peer_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
                disposition TEXT NOT NULL DEFAULT 'present'
                    CHECK (disposition IN ('present', 'removed')),
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO users VALUES (
                'old-user', 'old-peer', 'old-hash', 'user',
                '["Orchestrator.use"]', 0, '2026-01-01T00:00:00'
            );
            INSERT INTO devices VALUES (
                'old-device', 'old-user', 'old device', 'old-public', 1,
                '2026-01-01T00:01:00'
            );
            INSERT INTO tokens VALUES (
                'old-token', 'old-device', 'old-user', 'old-token-hash',
                'old-prefix', '["Orchestrator.use"]',
                '2026-01-02T00:00:00', '2026-01-01T00:02:00'
            );
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (
                'mesh-row', 'stable-peer', 'room-a', 'approved',
                '["Orchestrator.use"]', 'old-user', 'old-token', 'old-device'
            );
            """
        )
        await db.commit()


def _new_mesh_graph(*, expires_at: datetime | None = None) -> tuple[User, Device, Token]:
    user = User(
        id="new-user",
        username="new-peer",
        password_hash="new-hash",
        role="user",
        permissions=["Orchestrator.use"],
        is_admin=False,
        created_at=datetime.fromisoformat("2026-01-03T00:00:00"),
    )
    device = Device(
        id="new-device",
        user_id="new-user",
        name="new device",
        public_key="new-public",
        is_trusted=True,
        created_at=datetime.fromisoformat("2026-01-03T00:01:00"),
    )
    token = Token(
        id="new-token",
        user_id="new-user",
        device_id="new-device",
        token_hash="new-token-hash",
        prefix="new-prefix",
        scopes=["Orchestrator.use"],
        expires_at=expires_at or datetime.fromisoformat("2026-01-04T00:00:00"),
        created_at=datetime.fromisoformat("2026-01-03T00:02:00"),
    )
    return user, device, token


async def _credential_row_counts(db_path: str) -> dict[str, int]:
    async with aiosqlite.connect(db_path) as db:
        counts = {}
        for table in ("users", "devices", "tokens"):
            counts[table] = (await (await db.execute(f"SELECT count(*) FROM {table}")).fetchone())[
                0
            ]
        return counts


async def _load_issue_graph_state(db_path: str) -> dict[str, object]:
    async with aiosqlite.connect(db_path) as db:
        peer_rows = await (
            await db.execute(
                """
                SELECT id, peer_id, room_name, outbound_user_id,
                       outbound_device_id, outbound_token_id
                FROM mesh_peers
                ORDER BY id
                """
            )
        ).fetchall()
        new_token = await (
            await db.execute("SELECT 1 FROM tokens WHERE id = 'new-token'")
        ).fetchone()
        old_graph = await (
            await db.execute(
                """
                SELECT token.id
                FROM tokens AS token
                JOIN devices AS device ON device.id = token.device_id
                JOIN users AS user ON user.id = token.user_id
                WHERE token.id = 'old-token'
                  AND token.device_id = 'old-device'
                  AND token.user_id = 'old-user'
                  AND device.user_id = 'old-user'
                """
            )
        ).fetchone()
    return {
        "peers": [tuple(row) for row in peer_rows],
        "new_token_exists": new_token is not None,
        "old_graph_exists": old_graph is not None,
    }


async def _add_pending_mesh_room(db_path: str, room_name: str = "room-b") -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions
            ) VALUES (?, 'stable-peer', ?, 'pending', '[]')
            """,
            (f"mesh-row-{room_name}", room_name),
        )
        await db.commit()


async def _add_linked_mesh_room(db_path: str, room_name: str = "room-b") -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "INSERT INTO users (id, permissions, is_admin) VALUES (?, ?, 0)",
            (f"mesh-user-{room_name}", '["TTS.Request"]'),
        )
        await db.execute(
            "INSERT INTO tokens (id, user_id, scopes) VALUES (?, ?, ?)",
            (
                f"mesh-token-{room_name}",
                f"mesh-user-{room_name}",
                '["TTS.Request"]',
            ),
        )
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id
            ) VALUES (?, 'stable-peer', ?, 'approved', ?, ?, ?)
            """,
            (
                f"mesh-row-{room_name}",
                room_name,
                '["TTS.Request"]',
                f"mesh-user-{room_name}",
                f"mesh-token-{room_name}",
            ),
        )
        await db.commit()


async def _load_all_mesh_authority(db_path: str) -> dict[str, list[dict[str, object]]]:
    async with aiosqlite.connect(db_path) as db:
        users = await (
            await db.execute("SELECT id, permissions, is_admin FROM users ORDER BY id")
        ).fetchall()
        tokens = await (
            await db.execute("SELECT id, user_id, scopes FROM tokens ORDER BY id")
        ).fetchall()
        peers = await (
            await db.execute(
                """
                SELECT room_name, outbound_permissions, outbound_user_id,
                       outbound_token_id
                FROM mesh_peers
                WHERE peer_id = 'stable-peer' AND outbound_status = 'approved'
                ORDER BY room_name
                """
            )
        ).fetchall()
    return {
        "users": [
            {
                "id": row[0],
                "permissions": json.loads(row[1]),
                "is_admin": bool(row[2]),
            }
            for row in users
        ],
        "tokens": [
            {
                "id": row[0],
                "user_id": row[1],
                "scopes": json.loads(row[2]),
            }
            for row in tokens
        ],
        "peers": [
            {
                "room_name": row[0],
                "permissions": json.loads(row[1]),
                "user_id": row[2],
                "token_id": row[3],
            }
            for row in peers
        ],
    }


@pytest.mark.asyncio
async def test_mesh_permission_update_commits_complete_authority_graph(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    manager = DatabaseManager(db_path=db_path)

    updated = await manager.update_mesh_peer_permissions("stable-peer", ["*", "TTS.Request"])

    assert updated is True
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": ["*", "TTS.Request"],
        "user_permissions": ["*", "TTS.Request"],
        "user_is_admin": True,
        "token_scopes": ["*"],
    }


@pytest.mark.asyncio
async def test_mesh_permission_update_rolls_back_when_token_write_fails(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            CREATE TRIGGER reject_mesh_token_scope_update
            BEFORE UPDATE OF scopes ON tokens
            BEGIN
                SELECT RAISE(ABORT, 'simulated token persistence failure');
            END
            """
        )
        await db.commit()
    manager = DatabaseManager(db_path=db_path)

    updated = await manager.update_mesh_peer_permissions("stable-peer", ["DB.use", "Tooling.use"])

    assert updated is False
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": ["Orchestrator.use"],
        "user_permissions": ["Orchestrator.use"],
        "user_is_admin": False,
        "token_scopes": ["Orchestrator.use"],
    }


@pytest.mark.asyncio
async def test_mesh_permission_update_commits_distinct_room_principals(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    await _add_linked_mesh_room(db_path)
    manager = DatabaseManager(db_path=db_path)

    updated = await manager.update_mesh_peer_permissions("stable-peer", ["DB.use", "Tooling.use"])

    assert updated is True
    assert await _load_all_mesh_authority(db_path) == {
        "users": [
            {
                "id": "mesh-user",
                "permissions": ["DB.use", "Tooling.use"],
                "is_admin": False,
            },
            {
                "id": "mesh-user-room-b",
                "permissions": ["DB.use", "Tooling.use"],
                "is_admin": False,
            },
        ],
        "tokens": [
            {
                "id": "mesh-token",
                "user_id": "mesh-user",
                "scopes": ["DB.use", "Tooling.use"],
            },
            {
                "id": "mesh-token-room-b",
                "user_id": "mesh-user-room-b",
                "scopes": ["DB.use", "Tooling.use"],
            },
        ],
        "peers": [
            {
                "room_name": "room-a",
                "permissions": ["DB.use", "Tooling.use"],
                "user_id": "mesh-user",
                "token_id": "mesh-token",
            },
            {
                "room_name": "room-b",
                "permissions": ["DB.use", "Tooling.use"],
                "user_id": "mesh-user-room-b",
                "token_id": "mesh-token-room-b",
            },
        ],
    }


@pytest.mark.asyncio
async def test_multi_room_permission_update_rolls_back_every_graph_on_token_failure(
    tmp_path,
) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    await _add_linked_mesh_room(db_path)
    before = await _load_all_mesh_authority(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            CREATE TRIGGER reject_second_room_token_scope_update
            BEFORE UPDATE OF scopes ON tokens
            WHEN OLD.id = 'mesh-token-room-b'
            BEGIN
                SELECT RAISE(ABORT, 'simulated second-room token persistence failure');
            END
            """
        )
        await db.commit()
    manager = DatabaseManager(db_path=db_path)

    updated = await manager.update_mesh_peer_permissions("stable-peer", ["DB.use", "Tooling.use"])

    assert updated is False
    assert await _load_all_mesh_authority(db_path) == before


@pytest.mark.asyncio
async def test_auth_manager_rejects_failed_atomic_db_result() -> None:
    bus = SimpleNamespace(
        request=AsyncMock(return_value=QueryResult(ok=True, data={"success": False}))
    )
    manager = AuthManager(bus)

    updated = await manager.update_mesh_peer_permissions("stable-peer", ["DB.use"])

    assert updated is False
    bus.request.assert_awaited_once()
    topic, request = bus.request.await_args.args
    assert topic == DBMethods.UPDATE_MESH_PEER_PERMISSIONS
    assert request == DBUpdateMeshPeerPermissionsRequest(
        peer_id="stable-peer", permissions=["DB.use"]
    )


@pytest.mark.asyncio
async def test_auth_service_does_not_report_success_or_publish_after_atomic_failure() -> None:
    bus = SimpleNamespace(publish=AsyncMock())
    with patch("app.shared.services.base_service.get_bus_singleton", return_value=bus):
        service = AuthService()
        service._manager = SimpleNamespace(
            update_mesh_peer_permissions=AsyncMock(return_value=False)
        )

        response = await service.handle_update_peer_permissions(
            MeshPeerUpdatePermissionsRequest(
                peer_id="stable-peer",
                permissions=["DB.use"],
            )
        )

    assert response.success is False
    assert "not found or not approved" in response.message
    bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_denied_linked_mesh_peer_reapproval_restores_complete_authority(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE mesh_peers SET outbound_status = 'denied' WHERE peer_id = 'stable-peer'"
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    success, approved_rooms = await database.approve_mesh_peer(
        "stable-peer",
        ["DB.use", "Tooling.use"],
        approved_by="admin-user",
    )

    assert success is True
    assert approved_rooms == ["room-a"]
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": ["DB.use", "Tooling.use"],
        "user_permissions": ["DB.use", "Tooling.use"],
        "user_is_admin": False,
        "token_scopes": ["DB.use", "Tooling.use"],
    }
    assert await _load_mesh_peer_rows(db_path) == [
        {
            "room_name": "room-a",
            "status": "approved",
            "permissions": ["DB.use", "Tooling.use"],
            "approved_by": "admin-user",
        }
    ]


@pytest.mark.asyncio
async def test_stable_peer_approval_commits_mixed_rooms_before_pairing_advances(
    tmp_path,
) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    await _add_pending_mesh_room(db_path)
    database = DatabaseManager(db_path=db_path)

    async def approve_request(topic, payload, timeout=10.0):
        assert topic == DBMethods.APPROVE_MESH_PEER
        assert payload == DBApproveMeshPeerRequest(
            peer_id="stable-peer",
            permissions=["DB.use", "Tooling.use"],
            approved_by="admin-user",
        )
        success, rooms = await database.approve_mesh_peer(
            payload.peer_id,
            payload.permissions,
            approved_by=payload.approved_by,
            room_name=payload.room_name,
        )
        return {"success": success, "approved_rooms": rooms}

    manager = AuthManager(SimpleNamespace())
    manager._db_request = AsyncMock(side_effect=approve_request)
    expires_at = datetime.now() + timedelta(minutes=5)
    manager.pairing_requests["pending-room-b"] = {
        "remote_peer_id": "stable-peer",
        "room_name": "room-b",
        "status": "pending",
        "expires_at": expires_at,
    }

    approved = await manager.approve_mesh_peer(
        "stable-peer",
        ["DB.use", "Tooling.use"],
        approved_by="admin-user",
    )

    assert approved is True
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": ["DB.use", "Tooling.use"],
        "user_permissions": ["DB.use", "Tooling.use"],
        "user_is_admin": False,
        "token_scopes": ["DB.use", "Tooling.use"],
    }
    assert await _load_mesh_peer_rows(db_path) == [
        {
            "room_name": "room-a",
            "status": "approved",
            "permissions": ["DB.use", "Tooling.use"],
            "approved_by": "admin-user",
        },
        {
            "room_name": "room-b",
            "status": "approved",
            "permissions": ["DB.use", "Tooling.use"],
            "approved_by": "admin-user",
        },
    ]
    assert manager.pairing_requests["pending-room-b"] == {
        "remote_peer_id": "stable-peer",
        "room_name": "room-b",
        "status": "approved",
        "expires_at": expires_at,
        "approved_by": "admin-user",
        "granted_permissions": ["DB.use", "Tooling.use"],
        "granted_is_admin": False,
    }


@pytest.mark.asyncio
async def test_mixed_room_approval_failure_rolls_back_without_pairing_or_event(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority.db")
    await _create_mesh_authority_graph(db_path)
    await _add_pending_mesh_room(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            CREATE TRIGGER reject_mesh_reapproval_token_scope_update
            BEFORE UPDATE OF scopes ON tokens
            BEGIN
                SELECT RAISE(ABORT, 'simulated reapproval persistence failure');
            END
            """
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    async def reject_approval(_topic, payload, timeout=10.0):
        success, rooms = await database.approve_mesh_peer(
            payload.peer_id,
            payload.permissions,
            approved_by=payload.approved_by,
            room_name=payload.room_name,
        )
        return {"success": success, "approved_rooms": rooms}

    manager = AuthManager(SimpleNamespace())
    manager._db_request = AsyncMock(side_effect=reject_approval)
    expires_at = datetime.now() + timedelta(minutes=5)
    manager.pairing_requests["pending-room-b"] = {
        "remote_peer_id": "stable-peer",
        "room_name": "room-b",
        "status": "pending",
        "expires_at": expires_at,
    }
    event_bus = SimpleNamespace(publish=AsyncMock())

    with patch("app.shared.services.base_service.get_bus_singleton", return_value=event_bus):
        service = AuthService()
        service._manager = manager
        response = await service.handle_approve_peer(
            MeshPeerApproveRequest(
                peer_id="stable-peer",
                permissions=["DB.use", "Tooling.use"],
            )
        )

    assert response.success is False
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": ["Orchestrator.use"],
        "user_permissions": ["Orchestrator.use"],
        "user_is_admin": False,
        "token_scopes": ["Orchestrator.use"],
    }
    assert await _load_mesh_peer_rows(db_path) == [
        {
            "room_name": "room-a",
            "status": "approved",
            "permissions": ["Orchestrator.use"],
            "approved_by": None,
        },
        {
            "room_name": "room-b",
            "status": "pending",
            "permissions": [],
            "approved_by": None,
        },
    ]
    assert manager.pairing_requests["pending-room-b"] == {
        "remote_peer_id": "stable-peer",
        "room_name": "room-b",
        "status": "pending",
        "expires_at": expires_at,
    }
    event_bus.publish.assert_not_awaited()


@pytest.mark.asyncio
async def test_pairing_approval_targets_its_exact_room() -> None:
    bus = SimpleNamespace(publish=AsyncMock(), request=AsyncMock())
    manager = AuthManager(bus)
    authority_change = DBMeshAuthorityChange(
        peer_id="stable-peer",
        auth_grant_revision=1,
        disposition="present",
        state="active",
        effective_permissions=("Orchestrator.use",),
        reason="approved",
    )
    manager._db_request = AsyncMock(
        return_value={
            "success": True,
            "approved_rooms": ["room-b"],
            "authority_changes": [authority_change.model_dump()],
        }
    )
    expires_at = datetime.now() + timedelta(minutes=5)
    manager.pairing_requests["pairing-code"] = {
        "id": "request-id",
        "remote_peer_id": "stable-peer",
        "remote_node_name": "peer",
        "room_name": "room-b",
        "status": "pending",
        "expires_at": expires_at,
    }

    approved = await manager.approve_pairing(
        "pairing-code",
        user_id="admin-user",
        permissions=["Orchestrator.use"],
    )

    assert approved is True
    topic, request = manager._db_request.await_args.args
    assert topic == DBMethods.APPROVE_MESH_PEER
    assert request == DBApproveMeshPeerRequest(
        peer_id="stable-peer",
        permissions=["Orchestrator.use"],
        approved_by="admin-user",
        room_name="room-b",
    )
    assert manager.pairing_requests["pairing-code"]["status"] == "approved"
    canonical_events = [
        call
        for call in bus.publish.await_args_list
        if call.args[0] == MeshEvents.PEER_AUTHORITY_CHANGED
    ]
    assert len(canonical_events) == 1
    assert canonical_events[0].args[1].auth_grant_revision == 1


@pytest.mark.asyncio
async def test_pairing_memory_does_not_advance_for_uncommitted_room() -> None:
    manager = AuthManager(SimpleNamespace())
    manager._db_request = AsyncMock(return_value={"success": True, "approved_rooms": ["room-a"]})
    expires_at = datetime.now() + timedelta(minutes=5)
    manager.pairing_requests["pending-room-b"] = {
        "remote_peer_id": "stable-peer",
        "room_name": "room-b",
        "status": "pending",
        "expires_at": expires_at,
    }

    approved = await manager.approve_mesh_peer(
        "stable-peer",
        ["Orchestrator.use"],
        approved_by="admin-user",
    )

    assert approved is True
    assert manager.pairing_requests["pending-room-b"]["status"] == "pending"


@pytest.mark.asyncio
async def test_authority_revision_advances_once_and_not_for_idempotent_retry(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-revision.db")
    await _create_mesh_authority_graph(db_path)
    database = DatabaseManager(db_path=db_path)

    success, change = await database.update_mesh_peer_permissions_with_authority(
        "stable-peer",
        ["DB.use", "Tooling.use"],
    )

    assert success is True
    assert change == DBMeshAuthorityChange(
        peer_id="stable-peer",
        auth_grant_revision=1,
        disposition="present",
        state="active",
        effective_permissions=("DB.use", "Tooling.use"),
        reason="permissions_updated",
    )
    assert await _load_authority_revision(db_path) == (1, "present")

    retry_success, retry_change = await database.update_mesh_peer_permissions_with_authority(
        "stable-peer",
        ["Tooling.use", "DB.use"],
    )

    assert retry_success is True
    assert retry_change is None
    assert await _load_authority_revision(db_path) == (1, "present")


@pytest.mark.asyncio
async def test_revision_migration_backfills_distinct_peers_without_delete_cascade(
    tmp_path,
) -> None:
    db_path = str(tmp_path / "mesh-authority-migration.db")
    migration = (
        Path(__file__).parents[3]
        / "app/services/db/migrations/011_mesh_peer_auth_grant_revisions.sql"
    ).read_text()
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(
            """
            CREATE TABLE mesh_peers (
                id TEXT PRIMARY KEY,
                peer_id TEXT NOT NULL,
                room_name TEXT NOT NULL
            );
            INSERT INTO mesh_peers VALUES ('row-a', 'stable-peer', 'room-a');
            INSERT INTO mesh_peers VALUES ('row-b', 'stable-peer', 'room-b');
            INSERT INTO mesh_peers VALUES ('row-c', 'other-peer', 'room-a');
            """
        )
        await db.executescript(migration)
        rows = await (
            await db.execute(
                """
                SELECT peer_id, revision, disposition
                FROM mesh_peer_auth_grant_revisions
                ORDER BY peer_id
                """
            )
        ).fetchall()
        foreign_keys = await (
            await db.execute("PRAGMA foreign_key_list(mesh_peer_auth_grant_revisions)")
        ).fetchall()
        await db.execute("DELETE FROM mesh_peers WHERE peer_id = 'stable-peer'")
        tombstone = await (
            await db.execute(
                """
                SELECT revision, disposition
                FROM mesh_peer_auth_grant_revisions
                WHERE peer_id = 'stable-peer'
                """
            )
        ).fetchone()

    assert rows == [
        ("other-peer", 0, "present"),
        ("stable-peer", 0, "present"),
    ]
    assert foreign_keys == []
    assert tombstone == (0, "present")


@pytest.mark.asyncio
async def test_authority_revision_rolls_back_with_failed_graph_write(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-rollback.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            CREATE TRIGGER reject_revision_token_scope_update
            BEFORE UPDATE OF scopes ON tokens
            BEGIN
                SELECT RAISE(ABORT, 'simulated token persistence failure');
            END
            """
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    success, change = await database.update_mesh_peer_permissions_with_authority(
        "stable-peer",
        ["DB.use"],
    )

    assert success is False
    assert change is None
    assert await _load_authority_revision(db_path) is None


@pytest.mark.asyncio
async def test_multi_room_authority_mutation_bumps_stable_peer_once(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-multi-room.db")
    await _create_mesh_authority_graph(db_path)
    await _add_linked_mesh_room(db_path)
    database = DatabaseManager(db_path=db_path)

    success, change = await database.update_mesh_peer_permissions_with_authority(
        "stable-peer",
        ["DB.use"],
    )

    assert success is True
    assert change is not None
    assert change.auth_grant_revision == 1
    assert await _load_authority_revision(db_path) == (1, "present")


@pytest.mark.asyncio
async def test_deny_is_atomic_and_idempotent_for_stable_peer(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-deny.db")
    await _create_mesh_authority_graph(db_path)
    database = DatabaseManager(db_path=db_path)

    success, change = await database.deny_mesh_peer_with_authority("stable-peer")

    assert success is True
    assert change is not None
    assert change.auth_grant_revision == 1
    assert change.reason == "denied"
    assert change.state == "revoked"
    assert change.effective_permissions == ()
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": [],
        "user_permissions": [],
        "user_is_admin": False,
        "token_scopes": [],
    }

    retry_success, retry_change = await database.deny_mesh_peer_with_authority("stable-peer")
    assert retry_success is True
    assert retry_change is None
    assert await _load_authority_revision(db_path) == (1, "present")


@pytest.mark.asyncio
async def test_deny_does_not_clear_authority_shared_by_another_approved_peer(
    tmp_path,
) -> None:
    db_path = str(tmp_path / "mesh-authority-shared-deny.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (
                'shared-row', 'other-peer', 'other-room', 'approved',
                '["Orchestrator.use"]', 'mesh-user', 'mesh-token', 'mesh-device'
            )
            """
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    success, change = await database.deny_mesh_peer_with_authority("stable-peer")

    assert success is True
    assert change is not None
    assert change.state == "revoked"
    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": [],
        "user_permissions": ["Orchestrator.use"],
        "user_is_admin": False,
        "token_scopes": ["Orchestrator.use"],
    }
    retry_success, retry_change = await database.deny_mesh_peer_with_authority("stable-peer")
    assert retry_success is True
    assert retry_change is None
    assert await _load_authority_revision(db_path) == (1, "present")


@pytest.mark.asyncio
async def test_remove_leaves_tombstone_and_rediscovery_continues_revision(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-remove.db")
    await _create_mesh_authority_graph(db_path)
    database = DatabaseManager(db_path=db_path)

    removed, removal = await database.remove_mesh_peer_with_authority("stable-peer")

    assert removed is True
    assert removal is not None
    assert removal.auth_grant_revision == 1
    assert removal.disposition == "removed"
    assert removal.state == "revoked"
    assert await _load_authority_revision(db_path) == (1, "removed")
    async with aiosqlite.connect(db_path) as db:
        assert (
            await (
                await db.execute("SELECT 1 FROM mesh_peers WHERE peer_id = 'stable-peer'")
            ).fetchone()
            is None
        )
        assert (
            await (await db.execute("SELECT 1 FROM tokens WHERE id = 'mesh-token'")).fetchone()
            is None
        )
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions
            ) VALUES ('rediscovered-row', 'stable-peer', 'room-new', 'pending', '[]')
            """
        )
        await db.commit()

    approved, rooms, approval = await database.approve_mesh_peer_with_authority(
        "stable-peer",
        ["TTS.Request"],
    )

    assert approved is True
    assert rooms == ["room-new"]
    assert approval is not None
    assert approval.auth_grant_revision == 2
    assert approval.disposition == "present"
    assert await _load_authority_revision(db_path) == (2, "present")


@pytest.mark.asyncio
async def test_remove_rejects_cross_peer_shared_token_without_revision(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-shared-remove.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (
                'shared-row', 'other-peer', 'other-room', 'approved',
                '["Orchestrator.use"]', 'mesh-user', 'mesh-token', 'mesh-device'
            )
            """
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    removed, change = await database.remove_mesh_peer_with_authority("stable-peer")

    assert removed is False
    assert change is None
    assert await _load_authority_revision(db_path) is None
    async with aiosqlite.connect(db_path) as db:
        peer_count = await (await db.execute("SELECT count(*) FROM mesh_peers")).fetchone()
        token_exists = await (
            await db.execute("SELECT 1 FROM tokens WHERE id = 'mesh-token'")
        ).fetchone()
    assert peer_count == (2,)
    assert token_exists == (1,)


@pytest.mark.asyncio
async def test_remove_rejects_migrated_complete_but_mismatched_linkage_without_tombstone(
    tmp_path,
) -> None:
    db_path = str(tmp_path / "mesh-authority-mismatched-remove.db")
    database = DatabaseManager(db_path=db_path)
    await database.initialize()
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO users (
                id, username, password_hash, role, permissions, is_admin, created_at
            ) VALUES (
                'linked-user', 'linked-user', 'hash-a', 'device',
                '["Orchestrator.use"]', 0, '2026-01-01T00:00:00'
            )
            """
        )
        await db.execute(
            """
            INSERT INTO users (
                id, username, password_hash, role, permissions, is_admin, created_at
            ) VALUES (
                'device-owner', 'device-owner', 'hash-b', 'device',
                '["Orchestrator.use"]', 0, '2026-01-01T00:00:00'
            )
            """
        )
        await db.execute(
            """
            INSERT INTO devices (
                id, user_id, name, public_key, is_trusted, created_at
            ) VALUES (
                'linked-device', 'device-owner', 'linked device', 'public-key',
                1, '2026-01-01T00:01:00'
            )
            """
        )
        await db.execute(
            """
            INSERT INTO tokens (
                id, device_id, user_id, token_hash, prefix, scopes, expires_at, created_at
            ) VALUES (
                'linked-token', 'linked-device', 'linked-user', 'token-hash',
                'prefix', '["Orchestrator.use"]', '2026-01-02T00:00:00',
                '2026-01-01T00:02:00'
            )
            """
        )
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (
                'mesh-row', 'stable-peer', 'room-a', 'approved',
                '["Orchestrator.use"]', 'linked-user', 'linked-token', 'linked-device'
            )
            """
        )
        await db.commit()

    removed, change = await database.remove_mesh_peer_with_authority("stable-peer")

    assert removed is False
    assert change is None
    assert await _load_authority_revision(db_path) is None
    async with aiosqlite.connect(db_path) as db:
        peer_row = await (
            await db.execute(
                """
                SELECT outbound_user_id, outbound_device_id, outbound_token_id
                FROM mesh_peers
                WHERE id = 'mesh-row'
                """
            )
        ).fetchone()
        counts = {
            table: (await (await db.execute(f"SELECT count(*) FROM {table}")).fetchone())[0]
            for table in ("users", "devices", "tokens")
        }
    assert peer_row == ("linked-user", "linked-device", "linked-token")
    assert counts == {"users": 2, "devices": 1, "tokens": 1}


@pytest.mark.asyncio
async def test_link_and_revoke_each_commit_one_stable_peer_generation(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-credential.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "INSERT INTO devices (id, user_id) VALUES ('replacement-device', 'mesh-user')"
        )
        await db.execute(
            """
            INSERT INTO tokens (id, user_id, device_id, scopes)
            VALUES (
                'replacement-token', 'mesh-user', 'replacement-device',
                '["Orchestrator.use"]'
            )
            """
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    linked, link_change = await database.link_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        token_id="replacement-token",
        device_id="replacement-device",
        user_id="mesh-user",
        room_name="room-a",
    )

    assert linked is True
    assert link_change is not None
    assert link_change.auth_grant_revision == 1
    assert link_change.reason == "credential_linked"
    retry_linked, retry_change = await database.link_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        token_id="replacement-token",
        device_id="replacement-device",
        user_id="mesh-user",
        room_name="room-a",
    )
    assert retry_linked is True
    assert retry_change is None

    revoked, revoke_changes = await database.revoke_token_with_authority("replacement-token")

    assert revoked is True
    assert len(revoke_changes) == 1
    assert revoke_changes[0].auth_grant_revision == 2
    assert revoke_changes[0].reason == "token_revoked"
    assert revoke_changes[0].state == "revoked"
    assert await _load_authority_revision(db_path) == (2, "present")
    async with aiosqlite.connect(db_path) as db:
        peer_row = await (
            await db.execute(
                """
                SELECT outbound_status, outbound_permissions, outbound_token_id,
                       outbound_device_id, outbound_user_id
                FROM mesh_peers WHERE peer_id = 'stable-peer'
                """
            )
        ).fetchone()
    assert peer_row == ("denied", "[]", None, None, None)


@pytest.mark.asyncio
async def test_issue_rotation_bumps_once_and_exact_retry_does_not_bump(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-issue-retry.db")
    await _create_full_mesh_credential_graph(db_path)
    database = DatabaseManager(db_path=db_path)
    user, device, token = _new_mesh_graph()

    issued, change = await database.issue_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        room_name="room-a",
        user=user,
        device=device,
        token=token,
    )

    assert issued is True
    assert change is not None
    assert change.auth_grant_revision == 1
    assert await _load_authority_revision(db_path) == (1, "present")
    assert await _credential_row_counts(db_path) == {"users": 1, "devices": 1, "tokens": 1}

    retry_issued, retry_change = await database.issue_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        room_name="room-a",
        user=user,
        device=device,
        token=token,
    )

    assert retry_issued is True
    assert retry_change is None
    assert await _load_authority_revision(db_path) == (1, "present")


@pytest.mark.asyncio
async def test_pairing_exchange_retry_after_lost_issue_response_reuses_exact_graph(
    tmp_path,
) -> None:
    db_path = str(tmp_path / "mesh-authority-lost-response.db")
    await _create_full_mesh_credential_graph(db_path)
    database = DatabaseManager(db_path=db_path)
    manager = AuthManager(SimpleNamespace(publish=AsyncMock()))
    manager.load_mesh_identity = AsyncMock(
        return_value={"peer_id": "local-peer", "node_name": "local-node"}
    )
    manager._publish_pairing_lifecycle_event = AsyncMock()
    manager._audit_pairing_lifecycle = AsyncMock()
    manager.pairing_requests["pairing-code"] = {
        "id": "request-id",
        "device_name": "Remote Device",
        "status": "approved",
        "expires_at": datetime.now() + timedelta(minutes=5),
        "approved_by": "admin-user",
        "remote_peer_id": "stable-peer",
        "remote_node_name": "remote-node",
        "room_name": "room-a",
        "pairing_session_id": "s" * 64,
        "granted_permissions": ["Orchestrator.use"],
        "granted_is_admin": False,
    }
    calls = 0

    async def issue_then_drop_response(topic, payload, timeout=10.0):
        nonlocal calls
        assert topic == DBMethods.ISSUE_MESH_PEER_CREDENTIAL
        calls += 1
        success, change = await database.issue_mesh_peer_credential_with_authority(
            peer_id=payload.peer_id,
            room_name=payload.room_name,
            user=User(
                id=payload.user.id,
                username=payload.user.username,
                password_hash=payload.user.password_hash,
                role=payload.user.role,
                permissions=payload.user.permissions or [],
                is_admin=payload.user.is_admin,
                created_at=datetime.fromisoformat(payload.user.created_at),
            ),
            device=Device(
                id=payload.device.id,
                user_id=payload.device.user_id,
                name=payload.device.name,
                public_key=payload.device.public_key,
                is_trusted=payload.device.is_trusted,
                created_at=datetime.fromisoformat(payload.device.created_at),
            ),
            token=Token(
                id=payload.token.id,
                token_hash=payload.token.token_hash,
                prefix=payload.token.prefix or "",
                device_id=payload.token.device_id,
                user_id=payload.token.user_id,
                scopes=payload.token.scopes or [],
                expires_at=datetime.fromisoformat(payload.token.expires_at),
                created_at=datetime.fromisoformat(payload.token.created_at),
            ),
        )
        assert success is True
        if calls == 1:
            assert change is not None
            return None
        return {"success": True, "authority_changes": [change.model_dump()] if change else []}

    manager._db_request = AsyncMock(side_effect=issue_then_drop_response)

    first = await manager.exchange_pairing(
        "pairing-code",
        pairing_session_id="s" * 64,
    )
    raw_credential = manager.pairing_requests["pairing-code"]["pending_exchange"]["token"]
    created_at = manager.pairing_requests["pairing-code"]["pending_exchange"]["created_at"]

    second = await manager.exchange_pairing(
        "pairing-code",
        pairing_session_id="s" * 64,
    )

    assert first is None
    assert second is not None
    assert second["token"] == raw_credential
    assert manager.pairing_requests["pairing-code"]["pending_exchange"]["created_at"] == created_at
    assert await _load_authority_revision(db_path) == (1, "present")
    assert await _credential_row_counts(db_path) == {"users": 1, "devices": 1, "tokens": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutate",
    [
        lambda user, _device, _token: setattr(user, "username", "altered-user"),
        lambda _user, device, _token: setattr(device, "name", "altered-device"),
        lambda _user, _device, token: setattr(
            token,
            "expires_at",
            datetime.fromisoformat("2026-01-05T00:00:00"),
        ),
    ],
)
async def test_issue_same_id_retry_rejects_altered_persisted_fields(tmp_path, mutate) -> None:
    db_path = str(tmp_path / "mesh-authority-issue-retry-mismatch.db")
    await _create_full_mesh_credential_graph(db_path)
    database = DatabaseManager(db_path=db_path)
    user, device, token = _new_mesh_graph()
    issued, change = await database.issue_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        room_name="room-a",
        user=user,
        device=device,
        token=token,
    )
    assert issued is True
    assert change is not None

    changed_user, changed_device, changed_token = _new_mesh_graph()
    mutate(changed_user, changed_device, changed_token)
    retry_issued, retry_change = await database.issue_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        room_name="room-a",
        user=changed_user,
        device=changed_device,
        token=changed_token,
    )

    assert retry_issued is False
    assert retry_change is None
    assert await _load_authority_revision(db_path) == (1, "present")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("row_id", "peer_id", "room_name"),
    [
        ("same-peer-other-room", "stable-peer", "room-b"),
        ("cross-peer-other-room", "other-peer", "other-room"),
    ],
)
async def test_issue_rotation_rejects_any_other_row_referencing_old_graph(
    tmp_path,
    row_id: str,
    peer_id: str,
    room_name: str,
) -> None:
    db_path = str(tmp_path / "mesh-authority-issue-shared.db")
    await _create_full_mesh_credential_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (?, ?, ?, 'approved', '["Orchestrator.use"]',
                      'old-user', 'old-token', 'old-device')
            """,
            (row_id, peer_id, room_name),
        )
        await db.commit()
    before = await _load_issue_graph_state(db_path)
    database = DatabaseManager(db_path=db_path)
    user, device, token = _new_mesh_graph()

    issued, change = await database.issue_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        room_name="room-a",
        user=user,
        device=device,
        token=token,
    )

    assert issued is False
    assert change is None
    assert await _load_issue_graph_state(db_path) == before
    assert await _load_authority_revision(db_path) is None


@pytest.mark.asyncio
async def test_issue_rotation_rejects_corrupt_old_graph_without_changes(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-issue-corrupt.db")
    await _create_full_mesh_credential_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute("UPDATE devices SET user_id = 'wrong-user' WHERE id = 'old-device'")
        await db.commit()
    before = await _load_issue_graph_state(db_path)
    database = DatabaseManager(db_path=db_path)
    user, device, token = _new_mesh_graph()

    issued, change = await database.issue_mesh_peer_credential_with_authority(
        peer_id="stable-peer",
        room_name="room-a",
        user=user,
        device=device,
        token=token,
    )

    assert issued is False
    assert change is None
    assert await _load_issue_graph_state(db_path) == before
    assert await _load_authority_revision(db_path) is None


@pytest.mark.asyncio
async def test_revoke_clears_revoked_device_tokens_when_user_still_approved(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-revoke-device.db")
    await _create_mesh_authority_graph(db_path)
    async with aiosqlite.connect(db_path) as db:
        await db.execute("INSERT INTO devices (id, user_id) VALUES ('other-device', 'mesh-user')")
        await db.execute(
            """
            INSERT INTO tokens (id, user_id, device_id, scopes)
            VALUES ('other-device-token', 'mesh-user', 'mesh-device', '["DB.use"]')
            """
        )
        await db.execute(
            """
            INSERT INTO tokens (id, user_id, device_id, scopes)
            VALUES ('still-approved-token', 'mesh-user', 'other-device', '["DB.use"]')
            """
        )
        await db.execute(
            """
            INSERT INTO mesh_peers (
                id, peer_id, room_name, outbound_status, outbound_permissions,
                outbound_user_id, outbound_token_id, outbound_device_id
            ) VALUES (
                'other-device-row', 'other-peer', 'other-room', 'approved',
                '["DB.use"]', 'mesh-user', 'still-approved-token', 'other-device'
            )
            """
        )
        await db.commit()
    database = DatabaseManager(db_path=db_path)

    revoked, changes = await database.revoke_token_with_authority("mesh-token")

    assert revoked is True
    assert len(changes) == 1
    async with aiosqlite.connect(db_path) as db:
        rows = await (await db.execute("SELECT id, scopes FROM tokens ORDER BY id")).fetchall()
        user = await (
            await db.execute("SELECT permissions FROM users WHERE id = 'mesh-user'")
        ).fetchone()
    assert rows == [
        ("other-device-token", "[]"),
        ("still-approved-token", '["DB.use"]'),
    ]
    assert user == ('["Orchestrator.use"]',)


@pytest.mark.asyncio
async def test_generic_authority_paths_reject_mesh_linked_graph(tmp_path) -> None:
    db_path = str(tmp_path / "mesh-authority-guards.db")
    await _create_mesh_authority_graph(db_path)
    database = DatabaseManager(db_path=db_path)

    with pytest.raises(MeshManagedAuthorityError):
        await database.update_user("mesh-user", permissions=["DB.use"])
    with pytest.raises(MeshManagedAuthorityError):
        await database.update_user("mesh-user", is_admin=True)
    with pytest.raises(MeshManagedAuthorityError):
        await database.update_token_scopes("mesh-token", ["DB.use"])
    with pytest.raises(MeshManagedAuthorityError):
        await database.delete_user("mesh-user")
    with pytest.raises(MeshManagedAuthorityError):
        await database.delete_device("mesh-device")
    with pytest.raises(MeshManagedAuthorityError):
        await database.revoke_token_with_authority(
            "mesh-token",
            reject_mesh_linked=True,
        )

    assert await _load_mesh_authority_graph(db_path) == {
        "peer_permissions": ["Orchestrator.use"],
        "user_permissions": ["Orchestrator.use"],
        "user_is_admin": False,
        "token_scopes": ["Orchestrator.use"],
    }
    assert await _load_authority_revision(db_path) is None


@pytest.mark.asyncio
async def test_generic_refresh_explicitly_rejects_mesh_linked_token() -> None:
    manager = AuthManager(SimpleNamespace())
    manager.authenticate_token = AsyncMock(return_value=SimpleNamespace(id="mesh-token"))
    manager._revoke_token = AsyncMock(return_value=False)
    manager._create_token = AsyncMock()

    refreshed = await manager.refresh_token("raw-token")

    assert refreshed is None
    manager._revoke_token.assert_awaited_once_with(
        "mesh-token",
        reject_mesh_linked=True,
    )
    manager._create_token.assert_not_awaited()


@pytest.mark.asyncio
async def test_auth_publishes_one_secret_free_event_for_committed_revision() -> None:
    publish = AsyncMock()
    manager = AuthManager(SimpleNamespace(publish=publish))
    committed = DBMeshAuthorityChange(
        peer_id="stable-peer",
        auth_grant_revision=7,
        disposition="present",
        state="active",
        effective_permissions=("DB.use",),
        reason="permissions_updated",
    )
    manager._db_request = AsyncMock(
        side_effect=[
            {"success": True, "authority_changes": [committed.model_dump()]},
            {"success": True, "authority_changes": []},
        ]
    )

    assert await manager.update_mesh_peer_permissions("stable-peer", ["DB.use"]) is True
    assert await manager.update_mesh_peer_permissions("stable-peer", ["DB.use"]) is True

    publish.assert_awaited_once()
    topic, event = publish.await_args.args
    assert topic == MeshEvents.PEER_AUTHORITY_CHANGED
    assert isinstance(event, MeshPeerAuthorityChangedEvent)
    assert event.auth_grant_revision == 7
    assert publish.await_args.kwargs == {"event": True, "origin": "internal"}
    assert not {
        "token",
        "token_id",
        "user_id",
        "device_id",
        "secret",
    }.intersection(event.model_dump())


@pytest.mark.asyncio
async def test_authority_snapshot_accepts_genuine_empty_and_secret_free_nonempty() -> None:
    manager = AuthManager(SimpleNamespace())
    manager._db_request = AsyncMock(
        side_effect=[
            {"authorities": []},
            {
                "authorities": [
                    {
                        "peer_id": "stable-peer",
                        "auth_grant_revision": 3,
                        "disposition": "present",
                        "state": "active",
                        "effective_permissions": ("DB.use",),
                    }
                ]
            },
        ]
    )

    assert await manager.get_mesh_peer_authority_snapshot() == ()
    snapshot = await manager.get_mesh_peer_authority_snapshot("stable-peer")

    assert snapshot == (
        MeshPeerAuthoritySnapshot(
            peer_id="stable-peer",
            auth_grant_revision=3,
            disposition="present",
            state="active",
            effective_permissions=("DB.use",),
        ),
    )
    dumped = snapshot[0].model_dump()
    assert not {
        "token",
        "token_id",
        "token_hash",
        "bearer",
        "user_id",
        "device_id",
        "room_secret",
        "actor",
        "reason",
    }.intersection(dumped)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        object(),
        {"authorities": None},
        {"authorities": {"peer_id": "not-a-list"}},
        {"authorities": [{"peer_id": "stable-peer"}]},
    ],
)
async def test_authority_snapshot_failures_do_not_collapse_to_empty(payload) -> None:
    manager = AuthManager(SimpleNamespace())
    manager._db_request = AsyncMock(return_value=payload)

    with pytest.raises((RuntimeError, ValueError)):
        await manager.get_mesh_peer_authority_snapshot()


@pytest.mark.asyncio
async def test_auth_service_propagates_authority_snapshot_failure() -> None:
    service = AuthService()
    service._manager = SimpleNamespace(
        get_mesh_peer_authority_snapshot=AsyncMock(side_effect=RuntimeError("snapshot failed"))
    )

    with pytest.raises(RuntimeError, match="snapshot failed"):
        await service.handle_get_authority_snapshot(
            MeshPeerAuthoritySnapshotRequest(peer_id="stable-peer")
        )


@pytest.mark.asyncio
async def test_admin_mesh_mutations_publish_each_committed_revision_once() -> None:
    publish = AsyncMock()
    manager = AuthManager(SimpleNamespace(publish=publish))

    def change(revision: int, reason: str, *, disposition: str = "present") -> dict:
        state = "active" if reason in {"approved", "permissions_updated"} else "revoked"
        return DBMeshAuthorityChange(
            peer_id="stable-peer",
            auth_grant_revision=revision,
            disposition=disposition,
            state=state,
            effective_permissions=("DB.use",) if state == "active" else (),
            reason=reason,
        ).model_dump()

    manager._db_request = AsyncMock(
        side_effect=[
            {
                "success": True,
                "approved_rooms": ["room-a"],
                "authority_changes": [change(1, "approved")],
            },
            {"success": True, "authority_changes": [change(2, "denied")]},
            {
                "success": True,
                "authority_changes": [change(3, "permissions_updated")],
            },
            {
                "success": True,
                "authority_changes": [change(4, "removed", disposition="removed")],
            },
        ]
    )

    assert await manager.approve_mesh_peer("stable-peer", ["DB.use"]) is True
    assert await manager.deny_mesh_peer("stable-peer") is True
    assert await manager.update_mesh_peer_permissions("stable-peer", ["DB.use"]) is True
    assert await manager.remove_mesh_peer("stable-peer") is True

    canonical_events = [
        call
        for call in publish.await_args_list
        if call.args[0] == MeshEvents.PEER_AUTHORITY_CHANGED
    ]
    assert [call.args[1].auth_grant_revision for call in canonical_events] == [1, 2, 3, 4]
