"""Persistence coverage for peer-scoped mesh reconnect credentials."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import aiosqlite
import pytest

from app.services.auth.auth_manager import AuthManager
from app.services.db.migration_manager import MigrationManager
from app.shared.crypto import derive_mesh_inbound_key, open_str, seal_str


@pytest.mark.asyncio
async def test_inbound_credential_persists_encrypted_bearer_and_public_token_id() -> None:
    manager = AuthManager(bus=AsyncMock())
    key = b"k" * 32
    manager._aget_mesh_inbound_key = AsyncMock(return_value=key)
    manager._db_request = AsyncMock(
        side_effect=[
            {"rows": [], "rowcount": 1},  # peer upsert
            {"rows": [], "rowcount": 1},  # credential update
        ]
    )

    saved = await manager.save_inbound_credential(
        remote_peer_id="peer-a",
        room_name="private-room",
        token="raw-secret-token",
        token_id="public-token-id",
        permissions=["Gateway.use"],
        remote_device_id="device-a",
        remote_user_id="user-a",
        remote_node_name="Aurora A",
    )

    assert saved is True
    save_sql = manager._db_request.await_args_list[1].args[1]
    assert "inbound_token_id = ?" in save_sql.sql
    assert "raw-secret-token" not in save_sql.params
    assert "public-token-id" in save_sql.params
    assert any(str(value).startswith("v2:") for value in save_sql.params)


@pytest.mark.asyncio
async def test_inbound_credential_loader_preserves_new_and_legacy_rows() -> None:
    manager = AuthManager(bus=AsyncMock())
    key = b"k" * 32
    manager._aget_mesh_inbound_key = AsyncMock(return_value=key)
    manager._db_request = AsyncMock(
        return_value={
            "rows": [
                {
                    "peer_id": "peer-new",
                    "inbound_token": seal_str(key, "new-secret"),
                    "inbound_token_id": "token-new",
                },
                {
                    "peer_id": "peer-legacy",
                    "inbound_token": "legacy-plaintext",
                },
            ],
            "rowcount": 2,
        }
    )

    loaded = await manager.load_inbound_credentials("private-room")

    assert loaded == {
        "peer-new": {"token": "new-secret", "token_id": "token-new"},
        "peer-legacy": {"token": "legacy-plaintext", "token_id": ""},
    }


@pytest.mark.asyncio
async def test_inbound_credential_loader_skips_corrupt_encrypted_rows() -> None:
    manager = AuthManager(bus=AsyncMock())
    key = b"k" * 32
    manager._aget_mesh_inbound_key = AsyncMock(return_value=key)
    manager._db_request = AsyncMock(
        return_value={
            "rows": [
                {
                    "peer_id": "peer-corrupt",
                    "inbound_token": "v2:not-valid-ciphertext",
                    "inbound_token_id": "token-corrupt",
                },
                {
                    "peer_id": "peer-valid",
                    "inbound_token": seal_str(key, "valid-secret"),
                    "inbound_token_id": "token-valid",
                },
            ],
            "rowcount": 2,
        }
    )

    loaded = await manager.load_inbound_credentials("private-room")

    assert loaded == {"peer-valid": {"token": "valid-secret", "token_id": "token-valid"}}


def test_open_str_rejects_corrupt_prefixed_ciphertext() -> None:
    with pytest.raises(ValueError, match="encrypted value"):
        open_str(b"k" * 32, "v2:not-valid-ciphertext")


@pytest.mark.asyncio
async def test_mesh_inbound_key_rejects_empty_config_without_caching_failure() -> None:
    manager = AuthManager(bus=AsyncMock())
    config = MagicMock()
    config.aget = AsyncMock(side_effect=["", "private-token-secret"])

    with patch("app.shared.config.interface.ConfigAPI", return_value=config):
        with pytest.raises(RuntimeError, match="token secret"):
            await manager._aget_mesh_inbound_key()
        assert manager._mesh_inbound_key is None

        key = await manager._aget_mesh_inbound_key()

    assert key == derive_mesh_inbound_key("private-token-secret")
    assert manager._mesh_inbound_key == key


@pytest.mark.asyncio
async def test_inbound_credential_save_fails_when_exact_peer_row_is_not_durable() -> None:
    manager = AuthManager(bus=AsyncMock())
    manager._db_request = AsyncMock(return_value={"rows": [], "rowcount": 0})
    manager._aget_mesh_inbound_key = AsyncMock(return_value=b"k" * 32)

    assert (
        await manager.save_inbound_credential(
            remote_peer_id="peer-a",
            room_name="private-room",
            token="secret",
            token_id="token-a",
        )
        is False
    )
    manager._aget_mesh_inbound_key.assert_not_awaited()


@pytest.mark.asyncio
async def test_migration_adds_inbound_token_id_once(tmp_path: Path) -> None:
    db_path = tmp_path / "aurora.db"
    migrations_dir = Path(__file__).resolve().parents[3] / "app" / "services" / "db" / "migrations"
    manager = MigrationManager(str(db_path), str(migrations_dir))

    await manager.run_migrations()
    await manager.run_migrations()

    async with aiosqlite.connect(db_path) as db:
        columns_cursor = await db.execute("PRAGMA table_info(mesh_peers)")
        columns = {row[1] for row in await columns_cursor.fetchall()}
        migration_cursor = await db.execute("SELECT COUNT(*) FROM migrations WHERE version = '009'")
        migration_count = (await migration_cursor.fetchone())[0]

    assert "inbound_token_id" in columns
    assert migration_count == 1
