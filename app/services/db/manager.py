"""
Main database manager for Aurora.
Handles all database operations using aiosqlite.
"""

import json
from datetime import date, datetime
from pathlib import Path
from typing import Optional

import aiosqlite

from app.helpers.aurora_logger import log_error, log_info
from app.services.db.migration_manager import MigrationManager
from app.services.db.models import Device, Message, Token, User


class DatabaseManager:
    """Main database manager for Aurora"""

    def __init__(self, db_path: str | None = None):
        if db_path is None:
            # Default to data directory in project root
            project_root = Path(__file__).parent.parent.parent
            data_dir = project_root / "data"
            data_dir.mkdir(exist_ok=True)
            db_path = str(data_dir / "aurora.db")

        self.db_path = db_path

        # Set up migrations
        migrations_dir = Path(__file__).parent / "migrations"
        self.migration_manager = MigrationManager(db_path, str(migrations_dir))

    async def _connect(self) -> aiosqlite.Connection:
        """Return a connection with ``PRAGMA foreign_keys = ON``.

        All write operations that depend on FK cascading should use this
        helper instead of calling ``aiosqlite.connect()`` directly.
        """
        db = await aiosqlite.connect(self.db_path)
        await db.execute("PRAGMA foreign_keys = ON")
        return db

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
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error storing message: {e}")
            return False

    async def get_messages_for_date(self, target_date: date | None = None) -> list[Message]:
        """Get all messages for a specific date (defaults to today)"""
        if target_date is None:
            target_date = date.today()

        # Calculate date range for the target date
        start_datetime = datetime.combine(target_date, datetime.min.time())
        end_datetime = datetime.combine(target_date, datetime.max.time())

        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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

    async def get_message_by_id(self, message_id: str) -> Message | None:
        """Get a specific message by ID"""
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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

    async def create_user(self, user: User) -> bool:
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM users WHERE username = ?", (username,))
                row = await cursor.fetchone()
                return User.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving user {username}: {e}")
            return None

    async def get_user_by_id(self, user_id: str) -> User | None:
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
                row = await cursor.fetchone()
                return User.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving user {user_id}: {e}")
            return None

    async def count_users(self) -> int:
        try:
            async with aiosqlite.connect(self.db_path) as db:
                cursor = await db.execute("SELECT COUNT(*) FROM users")
                result = await cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            log_error(f"Error counting users: {e}")
            return 0

    async def create_device(self, device: Device) -> bool:
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM devices WHERE id = ?", (device_id,))
                row = await cursor.fetchone()
                return Device.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving device {device_id}: {e}")
            return None

    async def get_device_by_token(self, token_hash: str) -> Device | None:
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute("SELECT * FROM devices WHERE user_id = ?", (user_id,))
                rows = await cursor.fetchall()
                return [Device.from_dict(dict(row)) for row in rows]
        except Exception as e:
            log_error(f"Error retrieving devices for user {user_id}: {e}")
            return []

    async def create_token(self, token: Token) -> bool:
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
        except Exception as e:
            log_error(f"Error creating token: {e}")
            return False

    async def get_token_by_hash(self, token_hash: str) -> Token | None:
        try:
            async with aiosqlite.connect(self.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    "SELECT * FROM tokens WHERE token_hash = ?", (token_hash,)
                )
                row = await cursor.fetchone()
                return Token.from_dict(dict(row)) if row else None
        except Exception as e:
            log_error(f"Error retrieving token: {e}")
            return None

    async def revoke_token(self, token_id: str) -> bool:
        db = None
        try:
            db = await self._connect()
            cursor = await db.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
            await db.commit()
            return cursor.rowcount > 0
        except Exception as e:
            log_error(f"Error revoking token {token_id}: {e}")
            return False
        finally:
            if db:
                await db.close()

    async def get_tokens_by_user(self, user_id: str) -> list[Token]:
        """Get all tokens for a user."""
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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

        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(f"UPDATE users SET {set_clause} WHERE id = ?", values)
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error updating user {user_id}: {e}")
            return False

    async def delete_user(self, user_id: str) -> bool:
        """Delete a user and cascade to devices/tokens via FK."""
        db = None
        try:
            db = await self._connect()
            cursor = await db.execute("DELETE FROM users WHERE id = ?", (user_id,))
            await db.commit()
            return cursor.rowcount > 0
        except Exception as e:
            log_error(f"Error deleting user {user_id}: {e}")
            return False
        finally:
            if db:
                await db.close()

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
            async with aiosqlite.connect(self.db_path) as db:
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
            cursor = await db.execute("DELETE FROM devices WHERE id = ?", (device_id,))
            await db.commit()
            return cursor.rowcount > 0
        except Exception as e:
            log_error(f"Error deleting device {device_id}: {e}")
            return False
        finally:
            if db:
                await db.close()

    async def list_devices(self) -> list[Device]:
        """List all devices."""
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
        try:
            async with aiosqlite.connect(self.db_path) as db:
                await db.execute(
                    "UPDATE tokens SET scopes = ? WHERE id = ?",
                    (json.dumps(scopes), token_id),
                )
                await db.commit()
                return True
        except Exception as e:
            log_error(f"Error updating token scopes {token_id}: {e}")
            return False

    async def get_token_by_id(self, token_id: str) -> Token | None:
        """Get a token by its ID."""
        try:
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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
            async with aiosqlite.connect(self.db_path) as db:
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

    async def close(self):
        """Close any open connections and resources"""
        # This is a no-op since we use connection per operation
        # but included for API consistency and future use
        pass
