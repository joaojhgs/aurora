"""
Main database manager for Aurora.
Handles all database operations using aiosqlite.
"""

import contextlib
import json
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from uuid import uuid4

import aiosqlite

from app.helpers.aurora_logger import log_error, log_info
from app.services.db.migration_manager import MigrationManager
from app.services.db.models import Device, MeshCredential, Message, Session, Token, User
from app.services.db.sqlite_connection import close_database, open_database
from app.services.db.tool_identity_store import (
    allocate_tool_identity,
    reconcile_tool_identity,
    resolve_tool_identity_aliases,
)
from app.services.db.tooling_export_policy_store import (
    get_tooling_export_policy_snapshot,
    get_tooling_mesh_switches,
    mutate_tooling_export_policy,
    set_tooling_mesh_switches,
)
from app.services.db.tooling_exposure_ledger_store import (
    get_tooling_exposure_ledger,
    record_tooling_exposures,
)
from app.services.db.tooling_mesh_activation_store import (
    activate_tooling_mesh_enforcement,
    get_tooling_mesh_activation_state,
)
from app.services.db.tooling_remote_catalog_store import (
    abort_tooling_remote_catalog_sync,
    accept_tooling_remote_tool_schema,
    append_tooling_remote_catalog_page,
    begin_tooling_remote_catalog_sync,
    commit_tooling_remote_catalog_sync,
    finalize_tooling_remote_catalog_policy,
    get_tooling_remote_catalog,
    import_legacy_tooling_remote_catalogs,
    prune_tooling_remote_catalog_retention,
    recover_tooling_remote_catalogs,
    resolve_tooling_remote_tool_aliases,
    set_tooling_remote_provider_availability,
)
from app.shared.contracts.models.db import (
    DBAbortToolingRemoteCatalogSyncRequest,
    DBAbortToolingRemoteCatalogSyncResponse,
    DBAcceptToolingRemoteToolSchemaRequest,
    DBAcceptToolingRemoteToolSchemaResponse,
    DBActivateToolingMeshEnforcementRequest,
    DBActivateToolingMeshEnforcementResponse,
    DBAllocateToolIdentityRequest,
    DBAllocateToolIdentityResponse,
    DBAppendToolingRemoteCatalogPageRequest,
    DBAppendToolingRemoteCatalogPageResponse,
    DBBeginToolingRemoteCatalogSyncRequest,
    DBBeginToolingRemoteCatalogSyncResponse,
    DBCommitToolingRemoteCatalogSyncRequest,
    DBCommitToolingRemoteCatalogSyncResponse,
    DBFinalizeToolingRemoteCatalogPolicyRequest,
    DBFinalizeToolingRemoteCatalogPolicyResponse,
    DBGetToolingExportPolicySnapshotRequest,
    DBGetToolingExportPolicySnapshotResponse,
    DBGetToolingExposureLedgerRequest,
    DBGetToolingExposureLedgerResponse,
    DBGetToolingMeshActivationStateResponse,
    DBGetToolingRemoteCatalogRequest,
    DBGetToolingRemoteCatalogResponse,
    DBImportLegacyToolingRemoteCatalogsRequest,
    DBImportLegacyToolingRemoteCatalogsResponse,
    DBMeshAuthorityChange,
    DBMeshAuthoritySnapshot,
    DBMutateToolingExportPolicyRequest,
    DBMutateToolingExportPolicyResponse,
    DBPrunedMeshPeerRow,
    DBPruneOrphanedMeshPeerRowsRequest,
    DBPruneOrphanedMeshPeerRowsResponse,
    DBPruneToolingRemoteCatalogRetentionRequest,
    DBPruneToolingRemoteCatalogRetentionResponse,
    DBReconcileToolIdentityRequest,
    DBReconcileToolIdentityResponse,
    DBRecordToolingExposuresRequest,
    DBRecordToolingExposuresResponse,
    DBRecoverToolingRemoteCatalogsRequest,
    DBRecoverToolingRemoteCatalogsResponse,
    DBResolveToolIdentityAliasesResponse,
    DBResolveToolingRemoteToolAliasesRequest,
    DBResolveToolingRemoteToolAliasesResponse,
    DBSetToolingMeshSwitchesRequest,
    DBSetToolingMeshSwitchesResponse,
    DBSetToolingRemoteProviderAvailabilityRequest,
    DBSetToolingRemoteProviderAvailabilityResponse,
)
from app.shared.contracts.models.tooling import ToolingMeshKillSwitches


class MeshManagedAuthorityError(ValueError):
    """A generic CRUD path attempted to mutate mesh-managed authority."""


class DatabaseManager:
    """Main database manager for Aurora"""

    def __init__(self, db_path: str | None = None):
        if db_path is None:
            from app.shared.path_utils import get_data_dir

            db_path = str(get_data_dir() / "aurora.db")

        self.db_path = db_path

        # Set up migrations
        migrations_dir = Path(__file__).parent / "migrations"
        self.migration_manager = MigrationManager(db_path, str(migrations_dir))

    async def _connect(self) -> aiosqlite.Connection:
        """Return a connection with Aurora's shared SQLite policy.

        All operations must use this helper so foreign keys, WAL, and lock
        waiting stay consistent across DB and scheduler call paths.
        """
        return await open_database(self.db_path)

    @contextlib.asynccontextmanager
    async def _connection(self):
        """Yield one initialized connection and always close it."""

        db = await self._connect()
        try:
            yield db
        finally:
            await close_database(db)

    @staticmethod
    def _permission_tuple(value: object) -> tuple[str, ...]:
        """Normalize stored or in-memory permissions without broadening them."""

        decoded = value
        if isinstance(value, str):
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError:
                decoded = []
        if not isinstance(decoded, (list, tuple, set)):
            return ()
        return tuple(sorted({str(permission) for permission in decoded}))

    @staticmethod
    def _datetime_fingerprint(value: object) -> str | None:
        """Normalize stored/dataclass datetime values for exact graph comparisons."""

        if value is None:
            return None
        if isinstance(value, datetime):
            parsed = value
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(UTC).replace(tzinfo=None)
        return parsed.isoformat()

    @classmethod
    def _datetime_matches(cls, stored: object, expected: datetime | None) -> bool:
        return cls._datetime_fingerprint(stored) == cls._datetime_fingerprint(expected)

    @staticmethod
    async def _mesh_linked_peer_ids(
        db: aiosqlite.Connection,
        *,
        column: str,
        value: str,
    ) -> tuple[str, ...]:
        """Return distinct stable peers linked through one trusted column name."""

        if column not in {"outbound_user_id", "outbound_device_id", "outbound_token_id"}:
            raise ValueError(f"unsupported mesh authority link column: {column}")
        cursor = await db.execute(
            f"SELECT DISTINCT peer_id FROM mesh_peers WHERE {column} = ? ORDER BY peer_id",
            (value,),
        )
        return tuple(str(row[0]) for row in await cursor.fetchall())

    @classmethod
    async def _reject_mesh_managed_authority(
        cls,
        db: aiosqlite.Connection,
        *,
        column: str,
        value: str,
    ) -> None:
        peer_ids = await cls._mesh_linked_peer_ids(db, column=column, value=value)
        if peer_ids:
            raise MeshManagedAuthorityError(
                f"mesh_managed_authority:{column}:{value}:{','.join(peer_ids)}"
            )

    @classmethod
    async def _bump_mesh_authority_revision(
        cls,
        db: aiosqlite.Connection,
        *,
        peer_id: str,
        disposition: str,
        reason: str,
    ) -> DBMeshAuthorityChange:
        """Advance one stable-peer generation inside its owning transaction."""

        await db.execute(
            """
            INSERT OR IGNORE INTO mesh_peer_auth_grant_revisions (
                peer_id, revision, disposition, updated_at
            ) VALUES (?, 0, ?, CURRENT_TIMESTAMP)
            """,
            (peer_id, disposition),
        )
        cursor = await db.execute(
            """
            UPDATE mesh_peer_auth_grant_revisions
            SET revision = revision + 1,
                disposition = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE peer_id = ?
            """,
            (disposition, peer_id),
        )
        if cursor.rowcount != 1:
            raise ValueError("mesh peer authority revision did not advance")
        revision_row = await (
            await db.execute(
                "SELECT revision FROM mesh_peer_auth_grant_revisions WHERE peer_id = ?",
                (peer_id,),
            )
        ).fetchone()
        if revision_row is None:
            raise ValueError("mesh peer authority revision was not readable")

        if disposition == "removed":
            state = "revoked"
            permissions: tuple[str, ...] = ()
        else:
            rows = await (
                await db.execute(
                    """
                    SELECT outbound_status, outbound_permissions
                    FROM mesh_peers
                    WHERE peer_id = ?
                    ORDER BY room_name
                    """,
                    (peer_id,),
                )
            ).fetchall()
            approved_sets = [
                set(cls._permission_tuple(row[1])) for row in rows if str(row[0]) == "approved"
            ]
            if approved_sets:
                state = "active"
                permissions = tuple(sorted(set.intersection(*approved_sets)))
            elif any(str(row[0]) == "pending" for row in rows):
                state = "pending"
                permissions = ()
            else:
                state = "revoked"
                permissions = ()

        return DBMeshAuthorityChange(
            peer_id=peer_id,
            auth_grant_revision=int(revision_row[0]),
            disposition=disposition,
            state=state,
            effective_permissions=permissions,
            reason=reason,
        )

    async def get_mesh_peer_authority_snapshot(
        self,
        *,
        peer_id: str | None = None,
    ) -> tuple[DBMeshAuthoritySnapshot, ...]:
        """Read a stable, secret-free authority snapshot in one transaction."""

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN")
            peer_query = """
                SELECT peer_id
                FROM (
                    SELECT DISTINCT peer_id FROM mesh_peers
                    UNION
                    SELECT peer_id FROM mesh_peer_auth_grant_revisions
                )
            """
            params: tuple[str, ...] = ()
            if peer_id is not None:
                peer_query += " WHERE peer_id = ?"
                params = (peer_id,)
            peer_query += " ORDER BY peer_id"
            peer_rows = await (await db.execute(peer_query, params)).fetchall()

            snapshots: list[DBMeshAuthoritySnapshot] = []
            for row in peer_rows:
                stable_peer_id = str(row[0])
                revision_row = await (
                    await db.execute(
                        """
                        SELECT revision, disposition
                        FROM mesh_peer_auth_grant_revisions
                        WHERE peer_id = ?
                        """,
                        (stable_peer_id,),
                    )
                ).fetchone()
                revision = int(revision_row[0]) if revision_row is not None else 0
                disposition = str(revision_row[1]) if revision_row is not None else "present"

                if disposition == "removed":
                    state = "revoked"
                    permissions: tuple[str, ...] = ()
                else:
                    authority_rows = await (
                        await db.execute(
                            """
                            SELECT outbound_status, outbound_permissions
                            FROM mesh_peers
                            WHERE peer_id = ?
                            ORDER BY room_name
                            """,
                            (stable_peer_id,),
                        )
                    ).fetchall()
                    approved_sets = [
                        set(self._permission_tuple(authority_row[1]))
                        for authority_row in authority_rows
                        if str(authority_row[0]) == "approved"
                    ]
                    if approved_sets:
                        state = "active"
                        permissions = tuple(sorted(set.intersection(*approved_sets)))
                    elif any(
                        str(authority_row[0]) == "pending" for authority_row in authority_rows
                    ):
                        state = "pending"
                        permissions = ()
                    else:
                        state = "revoked"
                        permissions = ()

                snapshots.append(
                    DBMeshAuthoritySnapshot(
                        peer_id=stable_peer_id,
                        auth_grant_revision=revision,
                        disposition=disposition,
                        state=state,
                        effective_permissions=permissions,
                    )
                )
            await db.commit()
            return tuple(snapshots)
        except Exception:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        finally:
            if db is not None:
                await close_database(db)

    async def initialize(self):
        """Initialize the database and run migrations"""
        log_info(f"Initializing database at: {self.db_path}")

        # Ensure database file exists
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)

        # Run migrations
        await self.migration_manager.run_migrations()

        log_info("Database initialization completed")

    async def store_message(self, message: Message) -> bool:
        """Store a message in the database"""
        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            if message.session_id:
                session_cursor = await db.execute(
                    "SELECT 1 FROM sessions WHERE id = ?",
                    (message.session_id,),
                )
                if await session_cursor.fetchone() is None:
                    raise ValueError(f"session {message.session_id!r} does not exist")

            await db.execute(
                """
                INSERT INTO messages (
                    id, content, message_type, timestamp,
                    session_id, metadata, source_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    message.id,
                    message.content,
                    message.message_type.value,
                    message.timestamp.isoformat(),
                    message.session_id,
                    json.dumps(message.metadata) if message.metadata else None,
                    message.source_type,
                ),
            )
            if message.session_id:
                title = (
                    message.content.strip()[:80]
                    if message.is_user_message() and message.content.strip()
                    else None
                )
                now = self._utc_now().isoformat()
                await db.execute(
                    """
                    UPDATE sessions
                    SET title = CASE
                            WHEN (title IS NULL OR trim(title) = '') AND ? IS NOT NULL THEN ?
                            ELSE title
                        END,
                        updated_at = ?,
                        last_active_at = ?
                    WHERE id = ?
                    """,
                    (title, title, now, now, message.session_id),
                )
            await db.commit()
            return True
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error storing message: {e}")
            return False
        finally:
            if db is not None:
                await close_database(db)

    async def get_messages_for_date(self, target_date: date | None = None) -> list[Message]:
        """Get all messages for a specific date (defaults to today)"""
        if target_date is None:
            target_date = date.today()

        # Calculate date range for the target date
        start_datetime = datetime.combine(target_date, datetime.min.time())
        end_datetime = datetime.combine(target_date, datetime.max.time())

        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT * FROM messages
                    WHERE timestamp BETWEEN ? AND ?
                    ORDER BY timestamp ASC
                """,
                    (start_datetime.isoformat(), end_datetime.isoformat()),
                )

                rows = await cursor.fetchall()
                messages = []

                for row in rows:
                    message_data = dict(row)
                    # Parse metadata if present
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])

                    messages.append(Message.from_dict(message_data))

                return messages
        except Exception as e:
            log_error(f"Error retrieving messages for date {target_date}: {e}")
            return []

    async def get_recent_messages(self, limit: int = 50) -> list[Message]:
        """Get the most recent messages"""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT * FROM messages
                    ORDER BY timestamp DESC
                    LIMIT ?
                """,
                    (limit,),
                )

                rows = await cursor.fetchall()
                messages = []

                for row in rows:
                    message_data = dict(row)
                    # Parse metadata if present
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])

                    messages.append(Message.from_dict(message_data))

                # Return in chronological order (oldest first)
                return list(reversed(messages))
        except Exception as e:
            log_error(f"Error retrieving recent messages: {e}")
            return []

    async def get_recent_messages_for_principal(
        self,
        principal_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Message]:
        """Get recent messages only from sessions owned by one principal."""

        async with self._connection() as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                """
                SELECT messages.*
                FROM messages
                INNER JOIN sessions ON sessions.id = messages.session_id
                WHERE sessions.principal_id = ?
                ORDER BY messages.timestamp DESC
                LIMIT ? OFFSET ?
                """,
                (principal_id, limit, offset),
            )
            messages: list[Message] = []
            for row in await cursor.fetchall():
                message_data = dict(row)
                if message_data["metadata"]:
                    message_data["metadata"] = json.loads(message_data["metadata"])
                messages.append(Message.from_dict(message_data))
            return list(reversed(messages))

    async def get_messages_for_date_for_principal(
        self,
        principal_id: str,
        target_date: date,
    ) -> list[Message]:
        """Get one principal's messages for a calendar date."""

        start_datetime = datetime.combine(target_date, datetime.min.time())
        end_datetime = datetime.combine(target_date, datetime.max.time())
        async with self._connection() as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                """
                SELECT messages.*
                FROM messages
                INNER JOIN sessions ON sessions.id = messages.session_id
                WHERE sessions.principal_id = ?
                  AND messages.timestamp BETWEEN ? AND ?
                ORDER BY messages.timestamp ASC
                """,
                (principal_id, start_datetime.isoformat(), end_datetime.isoformat()),
            )
            messages: list[Message] = []
            for row in await cursor.fetchall():
                message_data = dict(row)
                if message_data["metadata"]:
                    message_data["metadata"] = json.loads(message_data["metadata"])
                messages.append(Message.from_dict(message_data))
            return messages

    async def get_message_by_id(self, message_id: str) -> Message | None:
        """Get a specific message by ID"""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM messages WHERE id = ?", (message_id,))
                row = await cursor.fetchone()

                if row:
                    message_data = dict(row)
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])
                    return Message.from_dict(message_data)

                return None
        except Exception as e:
            log_error(f"Error retrieving message {message_id}: {e}")
            return None

    async def delete_message(self, message_id: str) -> bool:
        """Delete a message by ID"""
        try:
            async with self._connection() as db:
                await db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error deleting message {message_id}: {e}")
            return False

    async def get_message_count_for_date(self, target_date: date | None = None) -> int:
        """Get the count of messages for a specific date"""
        if target_date is None:
            target_date = date.today()

        start_datetime = datetime.combine(target_date, datetime.min.time())
        end_datetime = datetime.combine(target_date, datetime.max.time())

        try:
            async with self._connection() as db:
                cursor = await db.execute(
                    """
                    SELECT COUNT(*) FROM messages
                    WHERE timestamp BETWEEN ? AND ?
                """,
                    (start_datetime.isoformat(), end_datetime.isoformat()),
                )

                result = await cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            log_error(f"Error getting message count for date {target_date}: {e}")
            return 0

    async def cleanup_old_messages(self, days_to_keep: int = 30) -> int:
        """Remove messages older than specified days"""
        cutoff_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        cutoff_date = cutoff_date.replace(day=cutoff_date.day - days_to_keep)

        try:
            async with self._connection() as db:
                cursor = await db.execute(
                    "DELETE FROM messages WHERE timestamp < ?", (cutoff_date.isoformat(),)
                )
                await db.commit()
                return cursor.rowcount
        except Exception as e:
            log_error(f"Error cleaning up old messages: {e}")
            return 0

    async def get_session_messages(self, session_id: str) -> list[Message]:
        """Get all messages for a specific session"""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT * FROM messages
                    WHERE session_id = ?
                    ORDER BY timestamp ASC
                """,
                    (session_id,),
                )

                rows = await cursor.fetchall()
                messages = []

                for row in rows:
                    message_data = dict(row)
                    if message_data["metadata"]:
                        message_data["metadata"] = json.loads(message_data["metadata"])
                    messages.append(Message.from_dict(message_data))

                return messages
        except Exception as e:
            log_error(f"Error retrieving session messages: {e}")
            return []

    async def update_message(self, message: Message) -> bool:
        """Update an existing message in the database"""
        try:
            async with self._connection() as db:
                await db.execute(
                    """
                    UPDATE messages
                    SET content = ?,
                        message_type = ?,
                        timestamp = ?,
                        session_id = ?,
                        metadata = ?,
                        source_type = ?
                    WHERE id = ?
                """,
                    (
                        message.content,
                        message.message_type.value,
                        message.timestamp.isoformat(),
                        message.session_id,
                        json.dumps(message.metadata) if message.metadata else None,
                        message.source_type,
                        message.id,
                    ),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error updating message {message.id}: {e}")
            return False

    @staticmethod
    def _utc_now() -> datetime:
        """Return an aware UTC timestamp for session ordering."""

        return datetime.now(UTC)

    @staticmethod
    def _parse_session_datetime(value: str | datetime) -> datetime:
        """Parse SQLite session timestamps into aware UTC datetimes."""

        if isinstance(value, datetime):
            parsed = value
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)

    @classmethod
    def _session_from_row(cls, row: aiosqlite.Row) -> Session:
        """Build a session entity from a row with an optional message count."""

        keys = set(row.keys())
        return Session(
            id=str(row["id"]),
            principal_id=str(row["principal_id"]),
            type=str(row["type"]),
            title=str(row["title"]) if row["title"] is not None else None,
            created_at=cls._parse_session_datetime(row["created_at"]),
            updated_at=cls._parse_session_datetime(row["updated_at"]),
            last_active_at=cls._parse_session_datetime(row["last_active_at"]),
            message_count=int(row["message_count"]) if "message_count" in keys else 0,
        )

    async def create_session(self, session: Session) -> Session:
        """Persist one explicitly typed principal-owned session."""

        if not session.type.strip():
            raise ValueError("session type must be explicit")
        async with self._connection() as db:
            await db.execute(
                """
                INSERT INTO sessions (
                    id, principal_id, type, title,
                    created_at, updated_at, last_active_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    session.principal_id,
                    session.type,
                    session.title,
                    session.created_at.isoformat(),
                    session.updated_at.isoformat(),
                    session.last_active_at.isoformat(),
                ),
            )
            await db.commit()
        return session

    async def ensure_session(
        self,
        *,
        principal_id: str,
        session_type: str,
        session_id: str | None = None,
        title: str | None = None,
        activate: bool = True,
    ) -> Session:
        """Validate ownership of a session or create it atomically."""

        principal_id = principal_id.strip()
        session_type = session_type.strip()
        if not principal_id:
            raise ValueError("principal_id is required")
        if not session_type:
            raise ValueError("session type must be explicit")

        resolved_id = session_id.strip() if session_id and session_id.strip() else str(uuid4())
        now = self._utc_now()
        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            db.row_factory = aiosqlite.Row
            await db.execute("BEGIN IMMEDIATE")
            cursor = await db.execute("SELECT * FROM sessions WHERE id = ?", (resolved_id,))
            row = await cursor.fetchone()
            if row is not None:
                existing = self._session_from_row(row)
                if existing.principal_id != principal_id:
                    raise PermissionError("session belongs to another principal")
                if existing.type != session_type:
                    raise ValueError("session type does not match the requested type")
                if activate or (title and not existing.title):
                    await db.execute(
                        """
                        UPDATE sessions
                        SET title = CASE
                                WHEN (title IS NULL OR trim(title) = '') AND ? IS NOT NULL THEN ?
                                ELSE title
                            END,
                            last_active_at = CASE WHEN ? THEN ? ELSE last_active_at END
                        WHERE id = ? AND principal_id = ?
                        """,
                        (title, title, activate, now.isoformat(), resolved_id, principal_id),
                    )
                await db.commit()
                if title and not existing.title:
                    existing.title = title
                if activate:
                    existing.last_active_at = now
                return existing

            session = Session(
                id=resolved_id,
                principal_id=principal_id,
                type=session_type,
                title=title,
                created_at=now,
                updated_at=now,
                last_active_at=now,
            )
            await db.execute(
                """
                INSERT INTO sessions (
                    id, principal_id, type, title,
                    created_at, updated_at, last_active_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    session.principal_id,
                    session.type,
                    session.title,
                    session.created_at.isoformat(),
                    session.updated_at.isoformat(),
                    session.last_active_at.isoformat(),
                ),
            )
            await db.commit()
            return session
        except Exception:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        finally:
            if db is not None:
                await close_database(db)

    async def get_session_for_principal(self, session_id: str, principal_id: str) -> Session | None:
        """Return a session only when it belongs to the requested principal."""

        async with self._connection() as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                """
                SELECT sessions.*,
                       (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id)
                           AS message_count
                FROM sessions
                WHERE sessions.id = ? AND sessions.principal_id = ?
                """,
                (session_id, principal_id),
            )
            row = await cursor.fetchone()
            return self._session_from_row(row) if row is not None else None

    async def list_sessions_for_principal(
        self,
        principal_id: str,
        *,
        session_type: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Session]:
        """List a principal's sessions in last-opened order."""

        query = """
            SELECT sessions.*,
                   (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id)
                       AS message_count
            FROM sessions
            WHERE sessions.principal_id = ?
        """
        params: list[object] = [principal_id]
        if session_type is not None:
            query += " AND sessions.type = ?"
            params.append(session_type)
        query += (
            " ORDER BY datetime(sessions.last_active_at) DESC, sessions.id ASC LIMIT ? OFFSET ?"
        )
        params.extend([limit, offset])
        async with self._connection() as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(query, params)
            return [self._session_from_row(row) for row in await cursor.fetchall()]

    async def count_sessions_for_principal(
        self, principal_id: str, *, session_type: str | None = None
    ) -> int:
        """Count a principal's sessions, optionally restricted by type."""

        query = "SELECT COUNT(*) FROM sessions WHERE principal_id = ?"
        params: list[object] = [principal_id]
        if session_type is not None:
            query += " AND type = ?"
            params.append(session_type)
        async with self._connection() as db:
            cursor = await db.execute(query, params)
            row = await cursor.fetchone()
            return int(row[0]) if row else 0

    async def set_active_session(self, session_id: str, principal_id: str) -> Session | None:
        """Mark a session as the principal's most recently opened thread."""

        async with self._connection() as db:
            cursor = await db.execute(
                """
                UPDATE sessions
                SET last_active_at = ?
                WHERE id = ? AND principal_id = ?
                """,
                (self._utc_now().isoformat(), session_id, principal_id),
            )
            await db.commit()
            if cursor.rowcount != 1:
                return None
        return await self.get_session_for_principal(session_id, principal_id)

    async def get_session_messages_for_principal(
        self, session_id: str, principal_id: str
    ) -> list[Message]:
        """Return chronological messages after verifying session ownership."""

        if await self.get_session_for_principal(session_id, principal_id) is None:
            return []
        return await self.get_session_messages(session_id)

    async def resolve_daemon_session(
        self,
        *,
        session_type: str,
        stale_after_seconds: int,
        now: datetime | None = None,
    ) -> Session:
        """Resolve the globally last-opened local session for wakeword chat.

        A recent session is reused regardless of which device opened it because
        all devices for one user share the same principal. If the most recent
        session is stale, a new session is created for that same principal. A
        database with no prior sessions falls back to the local SYSTEM principal.
        """

        session_type = session_type.strip()
        if not session_type:
            raise ValueError("session type must be explicit")
        resolved_now = (now or self._utc_now()).astimezone(UTC)
        cutoff = resolved_now - timedelta(seconds=stale_after_seconds)
        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            db.row_factory = aiosqlite.Row
            await db.execute("BEGIN IMMEDIATE")
            cursor = await db.execute(
                """
                SELECT sessions.*,
                       (SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id)
                           AS message_count
                FROM sessions
                WHERE sessions.type = ?
                ORDER BY datetime(sessions.last_active_at) DESC, sessions.id ASC
                LIMIT 1
                """,
                (session_type,),
            )
            row = await cursor.fetchone()
            previous = self._session_from_row(row) if row is not None else None
            if previous is not None and previous.last_active_at > cutoff:
                await db.execute(
                    "UPDATE sessions SET last_active_at = ? WHERE id = ?",
                    (resolved_now.isoformat(), previous.id),
                )
                await db.commit()
                previous.last_active_at = resolved_now
                return previous

            principal_id = previous.principal_id if previous is not None else "system"
            session = Session(
                id=str(uuid4()),
                principal_id=principal_id,
                type=session_type,
                title=f"Voice chat {resolved_now.date().isoformat()}",
                created_at=resolved_now,
                updated_at=resolved_now,
                last_active_at=resolved_now,
            )
            await db.execute(
                """
                INSERT INTO sessions (
                    id, principal_id, type, title,
                    created_at, updated_at, last_active_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session.id,
                    session.principal_id,
                    session.type,
                    session.title,
                    session.created_at.isoformat(),
                    session.updated_at.isoformat(),
                    session.last_active_at.isoformat(),
                ),
            )
            await db.commit()
            return session
        except Exception:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        finally:
            if db is not None:
                await close_database(db)

    async def create_user(self, user: User) -> bool:
        try:
            async with self._connection() as db:
                await db.execute(
                    """
                    INSERT INTO users (id, username, password_hash, role, permissions, is_admin, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        user.id,
                        user.username,
                        user.password_hash,
                        user.role,
                        json.dumps(user.permissions or []),
                        1 if user.is_admin else 0,
                        user.created_at.isoformat() if user.created_at else None,
                    ),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error creating user {user.username}: {e}")
            return False

    async def get_user_by_username(self, username: str) -> User | None:
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM users WHERE username = ?", (username,))
                row = await cursor.fetchone()
                return User.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving user {username}: {e}")
            return None

    async def get_user_by_id(self, user_id: str) -> User | None:
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
                row = await cursor.fetchone()
                return User.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving user {user_id}: {e}")
            return None

    async def count_users(self) -> int:
        try:
            async with self._connection() as db:
                cursor = await db.execute("SELECT COUNT(*) FROM users")
                result = await cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            log_error(f"Error counting users: {e}")
            return 0

    async def create_device(self, device: Device) -> bool:
        try:
            async with self._connection() as db:
                await db.execute(
                    """
                    INSERT INTO devices (id, user_id, name, public_key, is_trusted, last_seen, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        device.id,
                        device.user_id,
                        device.name,
                        device.public_key,
                        1 if device.is_trusted else 0,
                        device.last_seen.isoformat() if device.last_seen else None,
                        device.created_at.isoformat() if device.created_at else None,
                    ),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error creating device {device.name}: {e}")
            return False

    async def get_device_by_id(self, device_id: str) -> Device | None:
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM devices WHERE id = ?", (device_id,))
                row = await cursor.fetchone()
                return Device.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving device {device_id}: {e}")
            return None

    async def get_device_by_token(self, token_hash: str) -> Device | None:
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    """
                    SELECT d.* FROM devices d
                    JOIN tokens t ON d.id = t.device_id
                    WHERE t.token_hash = ?
                """,
                    (token_hash,),
                )
                row = await cursor.fetchone()
                return Device.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving device by token: {e}")
            return None

    async def get_devices_by_user(self, user_id: str) -> list[Device]:
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM devices WHERE user_id = ?", (user_id,))
                rows = await cursor.fetchall()
                return [Device.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error retrieving devices for user {user_id}: {e}")
            return []

    async def create_token(self, token: Token) -> bool:
        """Create a non-mesh token, rejecting mesh-linked principals/devices."""

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            if token.user_id:
                await self._reject_mesh_managed_authority(
                    db,
                    column="outbound_user_id",
                    value=token.user_id,
                )
            if token.device_id:
                await self._reject_mesh_managed_authority(
                    db,
                    column="outbound_device_id",
                    value=token.device_id,
                )
            await db.execute(
                """
                INSERT INTO tokens (id, device_id, user_id, token_hash, prefix, scopes, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token.id,
                    token.device_id,
                    token.user_id,
                    token.token_hash,
                    token.prefix,
                    json.dumps(token.scopes),
                    token.expires_at.isoformat() if token.expires_at else None,
                    token.created_at.isoformat() if token.created_at else None,
                ),
            )
            await db.commit()
            return True
        except MeshManagedAuthorityError:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error creating token: {e}")
            return False
        finally:
            if db is not None:
                await close_database(db)

    async def get_token_by_hash(self, token_hash: str) -> Token | None:
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    "SELECT * FROM tokens WHERE token_hash = ?", (token_hash,)
                )
                row = await cursor.fetchone()
                return Token.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving token: {e}")
            return None

    async def revoke_token_with_authority(
        self,
        token_id: str,
        *,
        reject_mesh_linked: bool = False,
    ) -> tuple[bool, tuple[DBMeshAuthorityChange, ...]]:
        """Revoke a token and invalidate every peer row that linked it."""

        db = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            linked_rows = await (
                await db.execute(
                    """
                    SELECT DISTINCT peer_id, outbound_user_id, outbound_device_id
                    FROM mesh_peers
                    WHERE outbound_token_id = ?
                    ORDER BY peer_id
                    """,
                    (token_id,),
                )
            ).fetchall()
            peer_ids = tuple(sorted({str(row[0]) for row in linked_rows}))
            if peer_ids and reject_mesh_linked:
                raise MeshManagedAuthorityError(
                    f"mesh_managed_authority:outbound_token_id:{token_id}:{','.join(peer_ids)}"
                )

            token_exists = (
                await (
                    await db.execute("SELECT 1 FROM tokens WHERE id = ?", (token_id,))
                ).fetchone()
                is not None
            )
            if not token_exists and not linked_rows:
                await db.rollback()
                return False, ()

            linked_user_ids = {str(row[1]) for row in linked_rows if row[1]}
            linked_device_ids = {str(row[2]) for row in linked_rows if row[2]}
            if linked_rows:
                await db.execute(
                    """
                    UPDATE mesh_peers
                    SET outbound_status = 'denied',
                        outbound_permissions = '[]',
                        outbound_token_id = NULL,
                        outbound_device_id = NULL,
                        outbound_user_id = NULL,
                        last_status_change_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE outbound_token_id = ?
                    """,
                    (token_id,),
                )

            cursor = await db.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
            if token_exists and cursor.rowcount != 1:
                raise ValueError("token changed during revocation")

            for user_id in linked_user_ids:
                still_active = await (
                    await db.execute(
                        """
                        SELECT 1 FROM mesh_peers
                        WHERE outbound_user_id = ? AND outbound_status = 'approved'
                        LIMIT 1
                        """,
                        (user_id,),
                    )
                ).fetchone()
                if still_active is None:
                    await db.execute(
                        "UPDATE users SET permissions = '[]', is_admin = 0 WHERE id = ?",
                        (user_id,),
                    )
                    await db.execute(
                        "UPDATE tokens SET scopes = '[]' WHERE user_id = ?",
                        (user_id,),
                    )
            for device_id in linked_device_ids:
                still_active = await (
                    await db.execute(
                        """
                        SELECT 1 FROM mesh_peers
                        WHERE outbound_device_id = ? AND outbound_status = 'approved'
                        LIMIT 1
                        """,
                        (device_id,),
                    )
                ).fetchone()
                if still_active is None:
                    await db.execute(
                        "UPDATE tokens SET scopes = '[]' WHERE device_id = ?",
                        (device_id,),
                    )

            changes = tuple(
                [
                    await self._bump_mesh_authority_revision(
                        db,
                        peer_id=peer_id,
                        disposition="present",
                        reason="token_revoked",
                    )
                    for peer_id in peer_ids
                ]
            )
            await db.commit()
            return True, changes
        except MeshManagedAuthorityError:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error revoking token {token_id}: {e}")
            return False, ()
        finally:
            if db:
                await close_database(db)

    async def revoke_token(self, token_id: str) -> bool:
        success, _changes = await self.revoke_token_with_authority(token_id)
        return success

    async def get_tokens_by_user(self, user_id: str) -> list[Token]:
        """Get all tokens for a user."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM tokens WHERE user_id = ?", (user_id,))
                rows = await cursor.fetchall()
                return [Token.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error retrieving tokens for user {user_id}: {e}")
            return []

    async def get_tokens_by_device(self, device_id: str) -> list[Token]:
        """Get all tokens for a device."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM tokens WHERE device_id = ?", (device_id,))
                rows = await cursor.fetchall()
                return [Token.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error retrieving tokens for device {device_id}: {e}")
            return []

    # ── Extended CRUD (Phase 2 — granular permissions) ────────────────────

    async def list_users(self) -> list[User]:
        """List all users."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM users ORDER BY created_at ASC")
                rows = await cursor.fetchall()
                return [User.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error listing users: {e}")
            return []

    async def update_user(self, user_id: str, **fields: object) -> bool:
        """Update user fields dynamically.

        Supported fields: username, password_hash, role, permissions, is_admin.
        """
        if not fields:
            return True

        allowed = {"username", "password_hash", "role", "permissions", "is_admin"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return True

        # Serialise special fields
        if "permissions" in updates:
            updates["permissions"] = json.dumps(updates["permissions"])
        if "is_admin" in updates:
            updates["is_admin"] = 1 if updates["is_admin"] else 0

        set_clause = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [user_id]

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            if {"permissions", "is_admin"}.intersection(updates):
                await self._reject_mesh_managed_authority(
                    db,
                    column="outbound_user_id",
                    value=user_id,
                )
            cursor = await db.execute(f"UPDATE users SET {set_clause} WHERE id = ?", values)
            if cursor.rowcount != 1:
                await db.rollback()
                return False
            await db.commit()
            return True
        except MeshManagedAuthorityError:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error updating user {user_id}: {e}")
            return False
        finally:
            if db is not None:
                await close_database(db)

    async def delete_user(self, user_id: str) -> bool:
        """Delete a user and cascade to devices/tokens via FK."""
        db = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            await self._reject_mesh_managed_authority(
                db,
                column="outbound_user_id",
                value=user_id,
            )
            cursor = await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
            await db.commit()
            return cursor.rowcount > 0
        except MeshManagedAuthorityError:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error deleting user {user_id}: {e}")
            return False
        finally:
            if db:
                await close_database(db)

    async def update_device(self, device_id: str, **fields: object) -> bool:
        """Update device fields dynamically.

        Supported fields: name, public_key, is_trusted, last_seen.
        """
        if not fields:
            return True

        allowed = {"name", "public_key", "is_trusted", "last_seen"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return True

        if "is_trusted" in updates:
            updates["is_trusted"] = 1 if updates["is_trusted"] else 0
        if "last_seen" in updates and hasattr(updates["last_seen"], "isoformat"):
            updates["last_seen"] = updates["last_seen"].isoformat()

        set_clause = ", ".join(f"{col} = ?" for col in updates)
        values = list(updates.values()) + [device_id]

        try:
            async with self._connection() as db:
                await db.execute(f"UPDATE devices SET {set_clause} WHERE id = ?", values)
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error updating device {device_id}: {e}")
            return False

    async def delete_device(self, device_id: str) -> bool:
        """Delete a device and cascade to tokens via FK."""
        db = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            await self._reject_mesh_managed_authority(
                db,
                column="outbound_device_id",
                value=device_id,
            )
            cursor = await db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
            await db.commit()
            return cursor.rowcount > 0
        except MeshManagedAuthorityError:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error deleting device {device_id}: {e}")
            return False
        finally:
            if db:
                await close_database(db)

    async def list_devices(self) -> list[Device]:
        """List all devices."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM devices ORDER BY created_at ASC")
                rows = await cursor.fetchall()
                return [Device.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error listing devices: {e}")
            return []

    async def list_tokens(
        self, user_id: str | None = None, device_id: str | None = None
    ) -> list[Token]:
        """List tokens, optionally filtered by user and/or device."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                query = "SELECT * FROM tokens WHERE 1=1"
                params: list[str] = []
                if user_id is not None:
                    query += " AND user_id = ?"
                    params.append(user_id)
                if device_id is not None:
                    query += " AND device_id = ?"
                    params.append(device_id)
                query += " ORDER BY created_at ASC"
                cursor = await db.execute(query, params)
                rows = await cursor.fetchall()
                return [Token.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error listing tokens: {e}")
            return []

    async def update_token_scopes(self, token_id: str, scopes: list[str]) -> bool:
        """Update the scopes of a token."""
        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            await self._reject_mesh_managed_authority(
                db,
                column="outbound_token_id",
                value=token_id,
            )
            cursor = await db.execute(
                "UPDATE tokens SET scopes = ? WHERE id = ?",
                (json.dumps(scopes), token_id),
            )
            if cursor.rowcount != 1:
                await db.rollback()
                return False
            await db.commit()
            return True
        except MeshManagedAuthorityError:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            raise
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Error updating token scopes {token_id}: {e}")
            return False
        finally:
            if db is not None:
                await close_database(db)

    async def approve_mesh_peer_with_authority(
        self,
        peer_id: str,
        permissions: list[str],
        approved_by: str | None = None,
        room_name: str | None = None,
    ) -> tuple[bool, list[str], DBMeshAuthorityChange | None]:
        """Atomically approve peer rows and all authority graphs they already link.

        ``room_name`` selects the exact row owned by a mesh pairing request.
        Omitting it preserves the stable-peer admin API and approves every room
        row for that peer. Unlinked pending rows are valid before credential
        exchange; partially linked rows fail closed.
        """
        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")

            query = (
                "SELECT id, room_name, outbound_user_id, outbound_token_id, "
                "outbound_status, outbound_permissions "
                "FROM mesh_peers WHERE peer_id = ?"
            )
            params: list[str] = [peer_id]
            if room_name is not None:
                query += " AND room_name = ?"
                params.append(room_name)
            cursor = await db.execute(query, params)
            peer_rows = await cursor.fetchall()
            if not peer_rows:
                raise ValueError("mesh peer row does not exist")

            linked_principals: set[tuple[str, str]] = set()
            for _row_id, _room, user_id, token_id, _status, _permissions in peer_rows:
                if user_id is None and token_id is None:
                    continue
                if not user_id or not token_id:
                    raise ValueError("mesh peer has a partial auth principal linkage")
                linked_principals.add((str(user_id), str(token_id)))

            permissions_json = json.dumps(permissions)
            is_admin = 1 if "*" in permissions else 0
            token_scopes_json = json.dumps(["*"] if is_admin else permissions)

            target_permissions = self._permission_tuple(permissions)
            authority_matches = all(
                str(row[4]) == "approved" and self._permission_tuple(row[5]) == target_permissions
                for row in peer_rows
            )
            if authority_matches:
                for user_id, token_id in linked_principals:
                    user_row = await (
                        await db.execute(
                            "SELECT permissions, is_admin FROM users WHERE id = ?",
                            (user_id,),
                        )
                    ).fetchone()
                    token_row = await (
                        await db.execute(
                            "SELECT scopes FROM tokens WHERE id = ? AND user_id = ?",
                            (token_id, user_id),
                        )
                    ).fetchone()
                    if (
                        user_row is None
                        or token_row is None
                        or self._permission_tuple(user_row[0]) != target_permissions
                        or bool(user_row[1]) != bool(is_admin)
                        or self._permission_tuple(token_row[0])
                        != self._permission_tuple(["*"] if is_admin else permissions)
                    ):
                        authority_matches = False
                        break

            approved_rooms = [str(row[1]) for row in peer_rows]
            if authority_matches:
                await db.rollback()
                return True, approved_rooms, None

            for user_id in {user_id for user_id, _token_id in linked_principals}:
                user_cursor = await db.execute(
                    "UPDATE users SET permissions = ?, is_admin = ? WHERE id = ?",
                    (permissions_json, is_admin, user_id),
                )
                if user_cursor.rowcount != 1:
                    raise ValueError("linked mesh user does not exist")

            for user_id, token_id in linked_principals:
                token_cursor = await db.execute(
                    "UPDATE tokens SET scopes = ? WHERE id = ? AND user_id = ?",
                    (token_scopes_json, token_id, user_id),
                )
                if token_cursor.rowcount != 1:
                    raise ValueError("linked mesh token does not exist or belongs to another user")

            update_query = """
                UPDATE mesh_peers
                SET outbound_status = 'approved',
                    outbound_permissions = ?,
                    outbound_approved_at = CURRENT_TIMESTAMP,
                    outbound_approved_by = ?,
                    last_status_change_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE peer_id = ?
            """
            update_params: list[str | None] = [permissions_json, approved_by, peer_id]
            if room_name is not None:
                update_query += " AND room_name = ?"
                update_params.append(room_name)
            peer_cursor = await db.execute(update_query, update_params)
            if peer_cursor.rowcount != len(peer_rows):
                raise ValueError("mesh peer rows changed during approval")

            authority_change = await self._bump_mesh_authority_revision(
                db,
                peer_id=peer_id,
                disposition="present",
                reason="approved",
            )
            await db.commit()
            return True, approved_rooms, authority_change
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Atomic mesh peer approval failed for peer {peer_id}: {e}")
            return False, [], None
        finally:
            if db is not None:
                await close_database(db)

    async def approve_mesh_peer(
        self,
        peer_id: str,
        permissions: list[str],
        approved_by: str | None = None,
        room_name: str | None = None,
    ) -> tuple[bool, list[str]]:
        success, approved_rooms, _change = await self.approve_mesh_peer_with_authority(
            peer_id,
            permissions,
            approved_by=approved_by,
            room_name=room_name,
        )
        return success, approved_rooms

    async def update_mesh_peer_permissions_with_authority(
        self, peer_id: str, permissions: list[str]
    ) -> tuple[bool, DBMeshAuthorityChange | None]:
        """Atomically update an approved peer and its dedicated auth graph.

        The mesh peer row, linked user, and linked token are one authority
        decision.  Updating them through three independent bus calls can leave
        durable split-brain permissions when a later write fails.  A single
        ``BEGIN IMMEDIATE`` transaction also prevents another writer from
        changing the linkage between validation and commit.

        Every approved row must link one complete, existing user/token pair.
        Distinct room pairings may have distinct principals; all of them are
        validated and updated in this transaction. Incomplete graphs fail closed.
        """
        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")

            cursor = await db.execute(
                """
                SELECT outbound_user_id, outbound_token_id, outbound_permissions
                FROM mesh_peers
                WHERE peer_id = ? AND outbound_status = 'approved'
                """,
                (peer_id,),
            )
            peer_rows = await cursor.fetchall()
            if not peer_rows:
                raise ValueError("peer is missing or is not approved")

            linked_principals: set[tuple[str, str]] = set()
            for user_id, token_id, _permissions in peer_rows:
                if not user_id or not token_id:
                    raise ValueError("approved peer has no complete auth principal linkage")
                linked_principals.add((str(user_id), str(token_id)))

            permissions_json = json.dumps(permissions)
            is_admin = 1 if "*" in permissions else 0
            token_scopes_json = json.dumps(["*"] if is_admin else permissions)

            target_permissions = self._permission_tuple(permissions)
            authority_matches = all(
                self._permission_tuple(row[2]) == target_permissions for row in peer_rows
            )
            if authority_matches:
                for user_id, token_id in linked_principals:
                    user_row = await (
                        await db.execute(
                            "SELECT permissions, is_admin FROM users WHERE id = ?",
                            (user_id,),
                        )
                    ).fetchone()
                    token_row = await (
                        await db.execute(
                            "SELECT scopes FROM tokens WHERE id = ? AND user_id = ?",
                            (token_id, user_id),
                        )
                    ).fetchone()
                    if (
                        user_row is None
                        or token_row is None
                        or self._permission_tuple(user_row[0]) != target_permissions
                        or bool(user_row[1]) != bool(is_admin)
                        or self._permission_tuple(token_row[0])
                        != self._permission_tuple(["*"] if is_admin else permissions)
                    ):
                        authority_matches = False
                        break
            if authority_matches:
                await db.rollback()
                return True, None

            for user_id in {user_id for user_id, _token_id in linked_principals}:
                user_cursor = await db.execute(
                    "UPDATE users SET permissions = ?, is_admin = ? WHERE id = ?",
                    (permissions_json, is_admin, user_id),
                )
                if user_cursor.rowcount != 1:
                    raise ValueError("linked mesh user does not exist")

            for user_id, token_id in linked_principals:
                token_cursor = await db.execute(
                    "UPDATE tokens SET scopes = ? WHERE id = ? AND user_id = ?",
                    (token_scopes_json, token_id, user_id),
                )
                if token_cursor.rowcount != 1:
                    raise ValueError("linked mesh token does not exist or belongs to another user")

            peer_cursor = await db.execute(
                """
                UPDATE mesh_peers
                SET outbound_permissions = ?, updated_at = CURRENT_TIMESTAMP
                WHERE peer_id = ?
                  AND outbound_status = 'approved'
                """,
                (permissions_json, peer_id),
            )
            if peer_cursor.rowcount != len(peer_rows):
                raise ValueError("approved peer linkage changed during permission update")

            authority_change = await self._bump_mesh_authority_revision(
                db,
                peer_id=peer_id,
                disposition="present",
                reason="permissions_updated",
            )
            await db.commit()
            return True, authority_change
        except Exception as e:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Atomic mesh permission update failed for peer {peer_id}: {e}")
            return False, None
        finally:
            if db is not None:
                await close_database(db)

    async def update_mesh_peer_permissions(self, peer_id: str, permissions: list[str]) -> bool:
        success, _change = await self.update_mesh_peer_permissions_with_authority(
            peer_id,
            permissions,
        )
        return success

    async def deny_mesh_peer_with_authority(
        self,
        peer_id: str,
        *,
        room_name: str | None = None,
    ) -> tuple[bool, DBMeshAuthorityChange | None]:
        """Deny selected peer rows and clear their complete effective authority."""

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            query = (
                "SELECT id, outbound_status, outbound_permissions, "
                "outbound_user_id, outbound_token_id, outbound_device_id "
                "FROM mesh_peers WHERE peer_id = ?"
            )
            params: list[str] = [peer_id]
            if room_name is not None:
                query += " AND room_name = ?"
                params.append(room_name)
            rows = await (await db.execute(query, params)).fetchall()
            if not rows:
                await db.rollback()
                return False, None

            user_ids = {str(row[3]) for row in rows if row[3]}
            token_ids = {str(row[4]) for row in rows if row[4]}
            device_ids = {str(row[5]) for row in rows if row[5]}
            no_op = all(
                str(row[1]) == "denied" and not self._permission_tuple(row[2]) for row in rows
            )
            if no_op:
                for user_id in user_ids:
                    still_active = await (
                        await db.execute(
                            """
                            SELECT 1 FROM mesh_peers
                            WHERE outbound_user_id = ? AND outbound_status = 'approved'
                            LIMIT 1
                            """,
                            (user_id,),
                        )
                    ).fetchone()
                    if still_active is not None:
                        continue
                    user_row = await (
                        await db.execute(
                            "SELECT permissions, is_admin FROM users WHERE id = ?",
                            (user_id,),
                        )
                    ).fetchone()
                    if user_row and (self._permission_tuple(user_row[0]) or bool(user_row[1])):
                        no_op = False
                        break
            if no_op:
                for token_id in token_ids:
                    still_active = await (
                        await db.execute(
                            """
                            SELECT 1 FROM mesh_peers
                            WHERE outbound_token_id = ? AND outbound_status = 'approved'
                            LIMIT 1
                            """,
                            (token_id,),
                        )
                    ).fetchone()
                    if still_active is not None:
                        continue
                    token_row = await (
                        await db.execute("SELECT scopes FROM tokens WHERE id = ?", (token_id,))
                    ).fetchone()
                    if token_row and self._permission_tuple(token_row[0]):
                        no_op = False
                        break
            if no_op:
                for user_id in user_ids:
                    still_active = await (
                        await db.execute(
                            """
                            SELECT 1 FROM mesh_peers
                            WHERE outbound_user_id = ? AND outbound_status = 'approved'
                            LIMIT 1
                            """,
                            (user_id,),
                        )
                    ).fetchone()
                    if still_active is not None:
                        continue
                    token_rows = await (
                        await db.execute(
                            "SELECT scopes FROM tokens WHERE user_id = ?",
                            (user_id,),
                        )
                    ).fetchall()
                    if any(self._permission_tuple(row[0]) for row in token_rows):
                        no_op = False
                        break
            if no_op:
                for device_id in device_ids:
                    still_active = await (
                        await db.execute(
                            """
                            SELECT 1 FROM mesh_peers
                            WHERE outbound_device_id = ? AND outbound_status = 'approved'
                            LIMIT 1
                            """,
                            (device_id,),
                        )
                    ).fetchone()
                    if still_active is not None:
                        continue
                    token_rows = await (
                        await db.execute(
                            "SELECT scopes FROM tokens WHERE device_id = ?",
                            (device_id,),
                        )
                    ).fetchall()
                    if any(self._permission_tuple(row[0]) for row in token_rows):
                        no_op = False
                        break
            if no_op:
                await db.rollback()
                return True, None

            update_query = """
                UPDATE mesh_peers
                SET outbound_status = 'denied',
                    outbound_permissions = '[]',
                    last_status_change_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE peer_id = ?
            """
            update_params: list[str] = [peer_id]
            if room_name is not None:
                update_query += " AND room_name = ?"
                update_params.append(room_name)
            cursor = await db.execute(update_query, update_params)
            if cursor.rowcount != len(rows):
                raise ValueError("mesh peer rows changed during denial")

            for user_id in user_ids:
                still_active = await (
                    await db.execute(
                        """
                        SELECT 1 FROM mesh_peers
                        WHERE outbound_user_id = ? AND outbound_status = 'approved'
                        LIMIT 1
                        """,
                        (user_id,),
                    )
                ).fetchone()
                if still_active is None:
                    await db.execute(
                        "UPDATE users SET permissions = '[]', is_admin = 0 WHERE id = ?",
                        (user_id,),
                    )
                    await db.execute(
                        "UPDATE tokens SET scopes = '[]' WHERE user_id = ?",
                        (user_id,),
                    )
            for device_id in device_ids:
                still_active = await (
                    await db.execute(
                        """
                        SELECT 1 FROM mesh_peers
                        WHERE outbound_device_id = ? AND outbound_status = 'approved'
                        LIMIT 1
                        """,
                        (device_id,),
                    )
                ).fetchone()
                if still_active is None:
                    await db.execute(
                        "UPDATE tokens SET scopes = '[]' WHERE device_id = ?",
                        (device_id,),
                    )
            for token_id in token_ids:
                still_active = await (
                    await db.execute(
                        """
                        SELECT 1 FROM mesh_peers
                        WHERE outbound_token_id = ? AND outbound_status = 'approved'
                        LIMIT 1
                        """,
                        (token_id,),
                    )
                ).fetchone()
                if still_active is None:
                    await db.execute(
                        "UPDATE tokens SET scopes = '[]' WHERE id = ?",
                        (token_id,),
                    )

            change = await self._bump_mesh_authority_revision(
                db,
                peer_id=peer_id,
                disposition="present",
                reason="denied",
            )
            await db.commit()
            return True, change
        except Exception as exc:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Atomic mesh peer denial failed for peer {peer_id}: {exc}")
            return False, None
        finally:
            if db is not None:
                await close_database(db)

    async def remove_mesh_peer_with_authority(
        self,
        peer_id: str,
        *,
        revoke_token: bool = True,
    ) -> tuple[bool, DBMeshAuthorityChange | None]:
        """Remove every peer room while preserving a monotonic removed tombstone."""

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            rows = await (
                await db.execute(
                    """
                    SELECT id, outbound_token_id, outbound_device_id, outbound_user_id
                    FROM mesh_peers
                    WHERE peer_id = ?
                    """,
                    (peer_id,),
                )
            ).fetchall()
            if not rows:
                await db.rollback()
                return False, None

            token_ids = {str(row[1]) for row in rows if row[1]}
            device_ids = {str(row[2]) for row in rows if row[2]}
            user_ids = {str(row[3]) for row in rows if row[3]}
            any_linked = bool(token_ids or device_ids or user_ids)
            if any_linked and not revoke_token:
                raise ValueError("cannot remove a linked mesh peer without revoking credentials")

            for row in rows:
                linked = [value is not None for value in row[1:]]
                if any(linked) and not all(linked):
                    raise ValueError("cannot remove a peer with partial authority linkage")
                if all(linked):
                    graph = await (
                        await db.execute(
                            """
                            SELECT token.id
                            FROM tokens AS token
                            JOIN devices AS device ON device.id = token.device_id
                            JOIN users AS user ON user.id = token.user_id
                            WHERE token.id = ?
                              AND token.device_id = ?
                              AND token.user_id = ?
                              AND device.id = ?
                              AND device.user_id = ?
                              AND user.id = ?
                            """,
                            (
                                str(row[1]),
                                str(row[2]),
                                str(row[3]),
                                str(row[2]),
                                str(row[3]),
                                str(row[3]),
                            ),
                        )
                    ).fetchone()
                    if graph is None:
                        raise ValueError("cannot remove a peer with mismatched authority linkage")

            if revoke_token:
                for column, values in (
                    ("outbound_token_id", token_ids),
                    ("outbound_device_id", device_ids),
                    ("outbound_user_id", user_ids),
                ):
                    for value in values:
                        shared_peer = await (
                            await db.execute(
                                f"""
                                SELECT peer_id FROM mesh_peers
                                WHERE {column} = ? AND peer_id <> ?
                                LIMIT 1
                                """,
                                (value, peer_id),
                            )
                        ).fetchone()
                        if shared_peer is not None:
                            raise ValueError(
                                "cannot remove a peer whose credential graph is shared"
                            )
                for user_id in user_ids:
                    await db.execute("DELETE FROM tokens WHERE user_id = ?", (user_id,))
                    await db.execute("DELETE FROM devices WHERE user_id = ?", (user_id,))
                    await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
                for device_id in device_ids:
                    await db.execute("DELETE FROM tokens WHERE device_id = ?", (device_id,))
                    await db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
                for token_id in token_ids:
                    await db.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
            cursor = await db.execute("DELETE FROM mesh_peers WHERE peer_id = ?", (peer_id,))
            if cursor.rowcount != len(rows):
                raise ValueError("mesh peer rows changed during removal")

            change = await self._bump_mesh_authority_revision(
                db,
                peer_id=peer_id,
                disposition="removed",
                reason="removed",
            )
            await db.commit()
            return True, change
        except Exception as exc:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Atomic mesh peer removal failed for peer {peer_id}: {exc}")
            return False, None
        finally:
            if db is not None:
                await close_database(db)

    async def prune_orphaned_mesh_peer_rows(
        self,
        request: DBPruneOrphanedMeshPeerRowsRequest,
    ) -> DBPruneOrphanedMeshPeerRowsResponse:
        """Garbage-collect old mesh rows that never gained trust or credentials."""

        now = request.now if request.now is not None else datetime.now(UTC).timestamp()
        cutoff = datetime.fromtimestamp(now - request.retention_seconds, UTC)
        cutoff_text = cutoff.replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")
        age_expr = "datetime(COALESCE(last_seen_at, first_seen_at))"
        eligible_where = f"""
            outbound_status = 'pending'
            AND inbound_status IN ('unknown', 'pending')
            AND outbound_token_id IS NULL
            AND outbound_device_id IS NULL
            AND outbound_user_id IS NULL
            AND outbound_approved_at IS NULL
            AND outbound_approved_by IS NULL
            AND inbound_token IS NULL
            AND inbound_token_id IS NULL
            AND inbound_device_id IS NULL
            AND inbound_user_id IS NULL
            AND inbound_approved_at IS NULL
            AND json_array_length(COALESCE(NULLIF(outbound_permissions, ''), '[]')) = 0
            AND json_array_length(COALESCE(NULLIF(inbound_permissions, ''), '[]')) = 0
            AND COALESCE(last_seen_at, first_seen_at) IS NOT NULL
            AND {age_expr} <= datetime(?)
        """

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            rows = await (
                await db.execute(
                    f"""
                    SELECT id, peer_id, room_name
                    FROM mesh_peers
                    WHERE {eligible_where}
                    ORDER BY {age_expr} ASC, peer_id ASC, room_name ASC, id ASC
                    LIMIT ?
                    """,
                    (cutoff_text, request.max_rows),
                )
            ).fetchall()
            pruned_rows: list[DBPrunedMeshPeerRow] = []
            for row_id, peer_id, room_name in rows:
                cursor = await db.execute(
                    f"DELETE FROM mesh_peers WHERE id = ? AND {eligible_where}",
                    (str(row_id), cutoff_text),
                )
                if cursor.rowcount != 1:
                    raise ValueError("mesh peer row changed during orphan pruning")
                pruned_rows.append(
                    DBPrunedMeshPeerRow(
                        row_id=str(row_id),
                        peer_id=str(peer_id),
                        room_name=str(room_name),
                    )
                )
            await db.commit()
            return DBPruneOrphanedMeshPeerRowsResponse(pruned_rows=pruned_rows)
        except Exception as exc:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Orphaned mesh peer row pruning failed: {exc}")
            return DBPruneOrphanedMeshPeerRowsResponse(success=False)
        finally:
            if db is not None:
                await close_database(db)

    async def link_mesh_peer_credential_with_authority(
        self,
        *,
        peer_id: str,
        token_id: str,
        device_id: str,
        user_id: str,
        room_name: str | None = None,
    ) -> tuple[bool, DBMeshAuthorityChange | None]:
        """Link one complete issued credential graph and advance its generation."""

        db: aiosqlite.Connection | None = None
        try:
            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            query = """
                SELECT id, outbound_token_id, outbound_device_id, outbound_user_id,
                       outbound_permissions
                FROM mesh_peers
                WHERE peer_id = ? AND outbound_status = 'approved'
            """
            params: list[str] = [peer_id]
            if room_name is not None:
                query += " AND room_name = ?"
                params.append(room_name)
            peer_rows = await (await db.execute(query, params)).fetchall()
            if len(peer_rows) != 1:
                raise ValueError("mesh credential link requires one exact approved peer row")

            graph = await (
                await db.execute(
                    """
                    SELECT token.scopes, user.permissions, user.is_admin
                    FROM tokens AS token
                    JOIN devices AS device ON device.id = token.device_id
                    JOIN users AS user ON user.id = token.user_id
                    WHERE token.id = ?
                      AND token.user_id = ?
                      AND token.device_id = ?
                      AND device.user_id = ?
                    """,
                    (token_id, user_id, device_id, user_id),
                )
            ).fetchone()
            if graph is None:
                raise ValueError("mesh credential graph is incomplete or mismatched")

            row = peer_rows[0]
            expected_permissions = self._permission_tuple(row[4])
            expected_admin = "*" in expected_permissions
            expected_scopes = ("*",) if expected_admin else expected_permissions
            if (
                self._permission_tuple(graph[0]) != expected_scopes
                or self._permission_tuple(graph[1]) != expected_permissions
                or bool(graph[2]) != expected_admin
            ):
                raise ValueError("mesh credential graph does not match approved authority")
            if (row[1], row[2], row[3]) == (token_id, device_id, user_id):
                await db.rollback()
                return True, None

            cursor = await db.execute(
                """
                UPDATE mesh_peers
                SET outbound_token_id = ?,
                    outbound_device_id = ?,
                    outbound_user_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (token_id, device_id, user_id, str(row[0])),
            )
            if cursor.rowcount != 1:
                raise ValueError("mesh peer row changed during credential link")

            change = await self._bump_mesh_authority_revision(
                db,
                peer_id=peer_id,
                disposition="present",
                reason="credential_linked",
            )
            await db.commit()
            return True, change
        except Exception as exc:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Atomic mesh credential link failed for peer {peer_id}: {exc}")
            return False, None
        finally:
            if db is not None:
                await close_database(db)

    async def issue_mesh_peer_credential_with_authority(
        self,
        *,
        peer_id: str,
        room_name: str,
        user: User,
        device: Device,
        token: Token,
    ) -> tuple[bool, DBMeshAuthorityChange | None]:
        """Create/link/rotate one dedicated mesh credential graph atomically."""

        db: aiosqlite.Connection | None = None
        try:
            if (
                device.user_id != user.id
                or token.user_id != user.id
                or token.device_id != device.id
            ):
                raise ValueError("mesh credential graph IDs are inconsistent")

            db = await self._connect()
            await db.execute("BEGIN IMMEDIATE")
            row = await (
                await db.execute(
                    """
                    SELECT id, outbound_token_id, outbound_device_id, outbound_user_id,
                           outbound_permissions
                    FROM mesh_peers
                    WHERE peer_id = ? AND room_name = ? AND outbound_status = 'approved'
                    """,
                    (peer_id, room_name),
                )
            ).fetchone()
            if row is None:
                raise ValueError("mesh credential issue requires one exact approved peer row")

            expected_permissions = self._permission_tuple(row[4])
            expected_admin = "*" in expected_permissions
            expected_scopes = ("*",) if expected_admin else expected_permissions
            if (
                self._permission_tuple(user.permissions) != expected_permissions
                or bool(user.is_admin) != expected_admin
                or self._permission_tuple(token.scopes) != expected_scopes
            ):
                raise ValueError("mesh credential graph does not match approved authority")

            old_token_id = str(row[1]) if row[1] else ""
            old_device_id = str(row[2]) if row[2] else ""
            old_user_id = str(row[3]) if row[3] else ""
            old_values = (old_token_id, old_device_id, old_user_id)
            if any(old_values) and not all(old_values):
                raise ValueError("cannot rotate a partial mesh credential graph")

            if all(old_values):
                old_graph = await (
                    await db.execute(
                        """
                        SELECT token.id
                        FROM tokens AS token
                        JOIN devices AS device ON device.id = token.device_id
                        JOIN users AS user ON user.id = token.user_id
                        WHERE token.id = ?
                          AND token.device_id = ?
                          AND token.user_id = ?
                          AND device.id = ?
                          AND device.user_id = ?
                          AND user.id = ?
                        """,
                        (
                            old_token_id,
                            old_device_id,
                            old_user_id,
                            old_device_id,
                            old_user_id,
                            old_user_id,
                        ),
                    )
                ).fetchone()
                if old_graph is None:
                    raise ValueError("cannot rotate an incomplete mesh credential graph")

            if old_values == (token.id, device.id, user.id):
                graph = await (
                    await db.execute(
                        """
                        SELECT user.username, user.password_hash, user.role,
                               user.permissions, user.is_admin, user.created_at,
                               device.user_id, device.name, device.public_key,
                               device.is_trusted, device.created_at,
                               token.user_id, token.device_id, token.token_hash,
                               token.prefix, token.scopes, token.expires_at,
                               token.created_at
                        FROM tokens AS token
                        JOIN users AS user ON user.id = token.user_id
                        JOIN devices AS device ON device.id = token.device_id
                        WHERE token.id = ?
                          AND user.id = ?
                          AND device.id = ?
                          AND token.user_id = ?
                          AND token.device_id = ?
                          AND device.user_id = ?
                        """,
                        (token.id, user.id, device.id, user.id, device.id, user.id),
                    )
                ).fetchone()
                if (
                    graph is not None
                    and str(graph[0]) == user.username
                    and str(graph[1]) == user.password_hash
                    and str(graph[2]) == user.role
                    and self._permission_tuple(graph[3]) == expected_permissions
                    and bool(graph[4]) == expected_admin
                    and self._datetime_matches(graph[5], user.created_at)
                    and str(graph[6]) == user.id
                    and str(graph[7]) == device.name
                    and graph[8] == device.public_key
                    and bool(graph[9]) == bool(device.is_trusted)
                    and self._datetime_matches(graph[10], device.created_at)
                    and str(graph[11]) == user.id
                    and str(graph[12]) == device.id
                    and str(graph[13]) == token.token_hash
                    and str(graph[14] or "") == str(token.prefix or "")
                    and self._permission_tuple(graph[15]) == expected_scopes
                    and self._datetime_matches(graph[16], token.expires_at)
                    and self._datetime_matches(graph[17], token.created_at)
                ):
                    await db.rollback()
                    return True, None
                raise ValueError("existing mesh credential graph does not match retry payload")

            for column, value in (
                ("outbound_token_id", old_token_id),
                ("outbound_device_id", old_device_id),
                ("outbound_user_id", old_user_id),
            ):
                if not value:
                    continue
                shared_peer = await (
                    await db.execute(
                        f"""
                        SELECT peer_id FROM mesh_peers
                        WHERE {column} = ? AND id <> ?
                        LIMIT 1
                        """,
                        (value, str(row[0])),
                    )
                ).fetchone()
                if shared_peer is not None:
                    raise ValueError("cannot rotate a shared mesh credential graph")

            for table, row_id in (
                ("users", user.id),
                ("devices", device.id),
                ("tokens", token.id),
            ):
                existing = await (
                    await db.execute(f"SELECT 1 FROM {table} WHERE id = ?", (row_id,))
                ).fetchone()
                if existing is not None:
                    raise ValueError(f"new mesh credential {table} row already exists")

            await db.execute(
                """
                INSERT INTO users (
                    id, username, password_hash, role, permissions, is_admin, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user.id,
                    user.username,
                    user.password_hash,
                    user.role,
                    json.dumps(user.permissions),
                    1 if user.is_admin else 0,
                    user.created_at.isoformat() if user.created_at else None,
                ),
            )
            await db.execute(
                """
                INSERT INTO devices (
                    id, user_id, name, public_key, is_trusted, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    device.id,
                    device.user_id,
                    device.name,
                    device.public_key,
                    1 if device.is_trusted else 0,
                    device.created_at.isoformat() if device.created_at else None,
                ),
            )
            await db.execute(
                """
                INSERT INTO tokens (
                    id, device_id, user_id, token_hash, prefix, scopes, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    token.id,
                    token.device_id,
                    token.user_id,
                    token.token_hash,
                    token.prefix,
                    json.dumps(token.scopes),
                    token.expires_at.isoformat() if token.expires_at else None,
                    token.created_at.isoformat() if token.created_at else None,
                ),
            )
            cursor = await db.execute(
                """
                UPDATE mesh_peers
                SET outbound_token_id = ?,
                    outbound_device_id = ?,
                    outbound_user_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (token.id, device.id, user.id, str(row[0])),
            )
            if cursor.rowcount != 1:
                raise ValueError("mesh peer row changed during credential issue")

            if old_user_id:
                await db.execute("DELETE FROM tokens WHERE user_id = ?", (old_user_id,))
                await db.execute("DELETE FROM devices WHERE user_id = ?", (old_user_id,))
                await db.execute("DELETE FROM users WHERE id = ?", (old_user_id,))
            elif old_device_id:
                await db.execute("DELETE FROM tokens WHERE device_id = ?", (old_device_id,))
                await db.execute("DELETE FROM devices WHERE id = ?", (old_device_id,))
            elif old_token_id:
                await db.execute("DELETE FROM tokens WHERE id = ?", (old_token_id,))

            change = await self._bump_mesh_authority_revision(
                db,
                peer_id=peer_id,
                disposition="present",
                reason="credential_linked",
            )
            await db.commit()
            return True, change
        except Exception as exc:
            if db is not None:
                with contextlib.suppress(Exception):
                    await db.rollback()
            log_error(f"Atomic mesh credential issue failed for peer {peer_id}: {exc}")
            return False, None
        finally:
            if db is not None:
                await close_database(db)

    async def upsert_mesh_peer(
        self,
        *,
        row_id: str,
        peer_id: str,
        room_name: str,
        node_name: str = "",
        ip: str | None = None,
        port: int | None = None,
    ) -> bool:
        try:
            async with self._connection() as db:
                cursor = await db.execute(
                    """
                    INSERT INTO mesh_peers (id, peer_id, room_name, node_name, ip, port)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(peer_id, room_name) DO UPDATE SET
                      node_name = COALESCE(NULLIF(excluded.node_name, ''), mesh_peers.node_name),
                      ip = COALESCE(excluded.ip, mesh_peers.ip),
                      port = COALESCE(excluded.port, mesh_peers.port),
                      last_seen_at = CURRENT_TIMESTAMP,
                      updated_at = CURRENT_TIMESTAMP
                    """,
                    (row_id, peer_id, room_name, node_name, ip, port),
                )
                await db.commit()
                return cursor.rowcount == 1
        except Exception as exc:
            log_error(f"Error upserting mesh peer {peer_id}: {exc}")
            return False

    async def save_mesh_inbound_credential(
        self,
        *,
        peer_id: str,
        room_name: str,
        encrypted_token: str,
        token_id: str | None,
        permissions: list[str],
        remote_device_id: str | None,
        remote_user_id: str | None,
        remote_node_name: str | None,
    ) -> bool:
        try:
            async with self._connection() as db:
                cursor = await db.execute(
                    """
                    UPDATE mesh_peers
                    SET inbound_status = 'approved',
                        inbound_token = ?,
                        inbound_token_id = ?,
                        inbound_permissions = ?,
                        inbound_device_id = ?,
                        inbound_user_id = ?,
                        inbound_approved_at = CURRENT_TIMESTAMP,
                        node_name = COALESCE(NULLIF(?, ''), node_name),
                        last_status_change_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE peer_id = ? AND room_name = ?
                    """,
                    (
                        encrypted_token,
                        token_id,
                        json.dumps(permissions),
                        remote_device_id,
                        remote_user_id,
                        remote_node_name,
                        peer_id,
                        room_name,
                    ),
                )
                await db.commit()
                return cursor.rowcount == 1
        except Exception as exc:
            log_error(f"Error saving inbound mesh credential for {peer_id}: {exc}")
            return False

    async def update_mesh_peer_connection_status(self, peer_id: str, status: str) -> bool:
        try:
            async with self._connection() as db:
                cursor = await db.execute(
                    """
                    UPDATE mesh_peers
                    SET connection_status = ?,
                        last_seen_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE peer_id = ?
                    """,
                    (status, peer_id),
                )
                await db.commit()
                return cursor.rowcount > 0
        except Exception as exc:
            log_error(f"Error updating mesh peer connection for {peer_id}: {exc}")
            return False

    async def mesh_outbound_credential_matches(
        self,
        *,
        token_id: str,
        device_id: str,
        user_id: str,
        claimant_peer_id: str,
        room_name: str,
    ) -> bool:
        try:
            async with self._connection() as db:
                row = await (
                    await db.execute(
                        """
                        SELECT 1 FROM mesh_peers
                        WHERE peer_id = ? AND room_name = ?
                          AND outbound_status = 'approved'
                          AND outbound_token_id = ?
                          AND outbound_device_id = ?
                          AND outbound_user_id = ?
                        """,
                        (claimant_peer_id, room_name, token_id, device_id, user_id),
                    )
                ).fetchone()
                return row is not None
        except Exception as exc:
            log_error(f"Error matching mesh outbound credential: {exc}")
            return False

    async def get_token_by_id(self, token_id: str) -> Token | None:
        """Get a token by its ID."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM tokens WHERE id = ?", (token_id,))
                row = await cursor.fetchone()
                return Token.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving token {token_id}: {e}")
            return None

    # ── Audit log (Phase 7) ──────────────────────────────────────────────

    async def store_audit_event(
        self,
        event_id: str,
        event: str,
        principal_id: str | None,
        details: str | None,
        ip_address: str | None,
    ) -> bool:
        """Store an audit event."""
        try:
            async with self._connection() as db:
                await db.execute(
                    """
                    INSERT INTO audit_log (id, event, principal_id, details, ip_address)
                    VALUES (?, ?, ?, ?, ?)
                """,
                    (event_id, event, principal_id, details, ip_address),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error storing audit event: {e}")
            return False

    async def get_audit_log(
        self,
        event: str | None = None,
        principal_id: str | None = None,
        since: str | None = None,
        until: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """Query the audit log with optional filters."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                query = "SELECT * FROM audit_log WHERE 1=1"
                params: list[object] = []
                if event:
                    query += " AND event = ?"
                    params.append(event)
                if principal_id:
                    query += " AND principal_id = ?"
                    params.append(principal_id)
                if since:
                    query += " AND timestamp >= ?"
                    params.append(since)
                if until:
                    query += " AND timestamp <= ?"
                    params.append(until)
                query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?"
                params.extend([limit, offset])
                cursor = await db.execute(query, params)
                rows = await cursor.fetchall()
                return [dict(row) for row in rows]
        except Exception as e:
            log_error(f"Error querying audit log: {e}")
            return []

    async def reconcile_tool_identity(
        self,
        request: DBReconcileToolIdentityRequest,
    ) -> DBReconcileToolIdentityResponse:
        """Run the Tooling identity/alias re-key as one DB-owned transaction."""

        return await reconcile_tool_identity(self.db_path, request)

    async def allocate_tool_identity(
        self, request: DBAllocateToolIdentityRequest
    ) -> DBAllocateToolIdentityResponse:
        """Allocate/reuse an immutable compatibility identity."""

        return await allocate_tool_identity(self.db_path, request)

    async def resolve_tool_identity_aliases(
        self, global_tool_ids: list[str], *, stable_peer_id: str | None = None
    ) -> DBResolveToolIdentityAliasesResponse:
        """Resolve persisted aliases to canonical IDs."""

        return await resolve_tool_identity_aliases(
            self.db_path, global_tool_ids, stable_peer_id=stable_peer_id
        )

    async def get_tooling_export_policy_snapshot(
        self, request: DBGetToolingExportPolicySnapshotRequest
    ) -> DBGetToolingExportPolicySnapshotResponse:
        """Read Tooling export authority through its typed store."""

        return await get_tooling_export_policy_snapshot(self.db_path, request)

    async def mutate_tooling_export_policy(
        self, request: DBMutateToolingExportPolicyRequest
    ) -> DBMutateToolingExportPolicyResponse:
        """Apply one optimistic Tooling export mutation atomically."""

        return await mutate_tooling_export_policy(self.db_path, request)

    async def get_tooling_mesh_switches(self) -> ToolingMeshKillSwitches:
        """Read persisted provider/consumer Tooling switches."""

        return await get_tooling_mesh_switches(self.db_path)

    async def set_tooling_mesh_switches(
        self, request: DBSetToolingMeshSwitchesRequest
    ) -> DBSetToolingMeshSwitchesResponse:
        """Apply one optimistic bilateral Tooling switch update."""

        return await set_tooling_mesh_switches(self.db_path, request)

    async def begin_tooling_remote_catalog_sync(
        self, request: DBBeginToolingRemoteCatalogSyncRequest
    ) -> DBBeginToolingRemoteCatalogSyncResponse:
        return await begin_tooling_remote_catalog_sync(self.db_path, request)

    async def append_tooling_remote_catalog_page(
        self, request: DBAppendToolingRemoteCatalogPageRequest
    ) -> DBAppendToolingRemoteCatalogPageResponse:
        return await append_tooling_remote_catalog_page(self.db_path, request)

    async def commit_tooling_remote_catalog_sync(
        self, request: DBCommitToolingRemoteCatalogSyncRequest
    ) -> DBCommitToolingRemoteCatalogSyncResponse:
        return await commit_tooling_remote_catalog_sync(self.db_path, request)

    async def finalize_tooling_remote_catalog_policy(
        self, request: DBFinalizeToolingRemoteCatalogPolicyRequest
    ) -> DBFinalizeToolingRemoteCatalogPolicyResponse:
        return await finalize_tooling_remote_catalog_policy(self.db_path, request)

    async def abort_tooling_remote_catalog_sync(
        self, request: DBAbortToolingRemoteCatalogSyncRequest
    ) -> DBAbortToolingRemoteCatalogSyncResponse:
        return await abort_tooling_remote_catalog_sync(self.db_path, request)

    async def get_tooling_remote_catalog(
        self, request: DBGetToolingRemoteCatalogRequest
    ) -> DBGetToolingRemoteCatalogResponse:
        return await get_tooling_remote_catalog(self.db_path, request)

    async def set_tooling_remote_provider_availability(
        self, request: DBSetToolingRemoteProviderAvailabilityRequest
    ) -> DBSetToolingRemoteProviderAvailabilityResponse:
        return await set_tooling_remote_provider_availability(self.db_path, request)

    async def accept_tooling_remote_tool_schema(
        self, request: DBAcceptToolingRemoteToolSchemaRequest
    ) -> DBAcceptToolingRemoteToolSchemaResponse:
        return await accept_tooling_remote_tool_schema(self.db_path, request)

    async def import_legacy_tooling_remote_catalogs(
        self, request: DBImportLegacyToolingRemoteCatalogsRequest
    ) -> DBImportLegacyToolingRemoteCatalogsResponse:
        return await import_legacy_tooling_remote_catalogs(self.db_path, request)

    async def recover_tooling_remote_catalogs(
        self, request: DBRecoverToolingRemoteCatalogsRequest
    ) -> DBRecoverToolingRemoteCatalogsResponse:
        return await recover_tooling_remote_catalogs(self.db_path, request)

    async def prune_tooling_remote_catalog_retention(
        self, request: DBPruneToolingRemoteCatalogRetentionRequest
    ) -> DBPruneToolingRemoteCatalogRetentionResponse:
        return await prune_tooling_remote_catalog_retention(self.db_path, request)

    async def resolve_tooling_remote_tool_aliases(
        self, request: DBResolveToolingRemoteToolAliasesRequest
    ) -> DBResolveToolingRemoteToolAliasesResponse:
        return await resolve_tooling_remote_tool_aliases(self.db_path, request)

    async def get_tooling_mesh_activation_state(
        self,
    ) -> DBGetToolingMeshActivationStateResponse:
        return await get_tooling_mesh_activation_state(self.db_path)

    async def activate_tooling_mesh_enforcement(
        self, request: DBActivateToolingMeshEnforcementRequest
    ) -> DBActivateToolingMeshEnforcementResponse:
        return await activate_tooling_mesh_enforcement(self.db_path, request)

    async def get_tooling_exposure_ledger(
        self, request: DBGetToolingExposureLedgerRequest
    ) -> DBGetToolingExposureLedgerResponse:
        return await get_tooling_exposure_ledger(self.db_path, request)

    async def record_tooling_exposures(
        self, request: DBRecordToolingExposuresRequest
    ) -> DBRecordToolingExposuresResponse:
        return await record_tooling_exposures(self.db_path, request)

    async def close(self):
        """Close any open connections and resources"""
        # This is a no-op since we use connection per operation
        # but included for API consistency and future use
        pass

    # ── Mesh credentials ─────────────────────────────────────────────────

    async def save_mesh_credential(self, credential: MeshCredential) -> bool:
        """Upsert a mesh credential (INSERT OR REPLACE keyed by room_name)."""
        try:
            async with self._connection() as db:
                await db.execute(
                    """
                    INSERT INTO mesh_credentials
                        (id, room_name, token, remote_device_id, remote_user_id,
                         created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(room_name) DO UPDATE SET
                        token = excluded.token,
                        remote_device_id = excluded.remote_device_id,
                        remote_user_id = excluded.remote_user_id,
                        updated_at = excluded.updated_at
                    """,
                    (
                        credential.id,
                        credential.room_name,
                        credential.token,
                        credential.remote_device_id,
                        credential.remote_user_id,
                        credential.created_at.isoformat() if credential.created_at else None,
                        credential.updated_at.isoformat() if credential.updated_at else None,
                    ),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error saving mesh credential for room '{credential.room_name}': {e}")
            return False

    async def get_mesh_credential_by_room(self, room_name: str) -> MeshCredential | None:
        """Retrieve a stored mesh credential by room name."""
        try:
            async with self._connection() as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    "SELECT * FROM mesh_credentials WHERE room_name = ?",
                    (room_name,),
                )
                row = await cursor.fetchone()
                return MeshCredential.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving mesh credential for room '{room_name}': {e}")
            return None

    async def delete_mesh_credential(self, room_name: str) -> bool:
        """Delete a mesh credential by room name."""
        db = None
        try:
            db = await self._connect()
            cursor = await db.execute(
                "DELETE FROM mesh_credentials WHERE room_name = ?",
                (room_name,),
            )
            await db.commit()
            return cursor.rowcount > 0
        except Exception as e:
            log_error(f"Error deleting mesh credential for room '{room_name}': {e}")
            return False
        finally:
            if db:
                await close_database(db)
