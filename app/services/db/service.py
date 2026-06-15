"""Database Service for Aurora's parallel architecture.

This service:
- Handles database persistence commands using DatabaseManager
- Responds to database queries
- Manages message history
- Manages scheduler jobs
"""

from __future__ import annotations

from typing import Any

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Envelope, QueryResult
from app.services.db.manager import DatabaseManager
from app.services.db.models import CronJob, JobStatus, Message, ScheduleType
from app.services.db.rag_service import RAGService
from app.services.db.scheduler_db_service import SchedulerDatabaseService
from app.shared.contracts.models.common import EmptyOutput
from app.shared.contracts.models.db import (
    DBAuditLogRequest,
    DBAuditLogResponse,
    DBBoolResponse,
    DBCountAuditEventsRequest,
    DBCountResponse,
    DBCountUsersRequest,
    DBCreateDeviceRequest,
    DBCreateTokenRequest,
    DBCreateUserRequest,
    DBDeleteCronJobRequest,
    DBDeleteDeviceRequest,
    DBDeleteMeshCredentialRequest,
    DBDeleteUserRequest,
    DBDeviceListResponse,
    DBDeviceResponse,
    DBExecuteSQLRequest,
    DBExecuteSQLResponse,
    DBGetCronJobsRequest,
    DBGetCronJobsResponse,
    DBGetDeviceByIdRequest,
    DBGetMeshCredentialByRoomRequest,
    DBGetMessagesForDateRequest,
    DBGetMessagesRequest,
    DBGetMessagesResponse,
    DBGetTokenByHashRequest,
    DBGetTokenByIdRequest,
    DBGetUserByIdRequest,
    DBGetUserByUsernameRequest,
    DBListDevicesRequest,
    DBListTokensRequest,
    DBListUsersRequest,
    DBMeshCredentialResponse,
    DBMethods,
    DBModule,
    DBRAGDeleteRequest,
    DBRAGGetRequest,
    DBRAGItemResponse,
    DBRAGListRequest,
    DBRAGListResponse,
    DBRAGSearchRequest,
    DBRAGStoreRequest,
    DBRevokeTokenRequest,
    DBSaveMeshCredentialRequest,
    DBSaveMessageRequest,
    DBSaveMessageResponse,
    DBStoreCronJobRequest,
    DBTokenListResponse,
    DBTokenResponse,
    DBUpdateTokenScopesRequest,
    DBUpdateUserRequest,
    DBUserListResponse,
    DBUserResponse,
)
from app.shared.contracts.registry import method_contract
from app.shared.models.db import Device, MeshCredential, Token, User
from app.shared.services.base_service import BaseService


# Service implementation
class DBService(BaseService):
    """Database service.

    Responsibilities:
    - Process database commands
    - Respond to queries
    - Manage data persistence
    - Ensure data integrity
    """

    def __init__(self, db_path: str | None = None):
        """Initialize DB service with DatabaseManager.

        Args:
            db_path: Optional path to database file
        """
        super().__init__(
            module=DBModule.NAME,
            summary="Database persistence and retrieval service",
            capabilities=["message_persistence", "cron_jobs", "rag_storage", "vector_search"],
        )
        self.db_manager = DatabaseManager(db_path)
        self.scheduler_db = SchedulerDatabaseService(db_path)
        self.rag_service = RAGService()

    async def on_start(self) -> None:
        """Start the DB service."""
        log_info("Starting DB service...")

        # Initialize databases
        await self.db_manager.initialize()
        await self.scheduler_db.initialize()

        # Initialize RAG stores (requires config service to be ready)
        await self.rag_service.async_initialize()

        self._set_started(True)
        log_info("DB service started")

    async def on_stop(self) -> None:
        """Stop the DB service."""
        log_info("Stopping DB service...")

        # Close database connections
        await self.db_manager.close()
        # Scheduler DB uses aiosqlite which auto-closes connections
        # No explicit close needed

        log_info("DB service stopped")

    async def reload(self, config_section: str | None = None) -> None:
        """Reload service configuration.

        Args:
            config_section: The configuration section that changed (None = full reload)
        """
        log_info(f"Reloading DB service configuration (section: {config_section})")

        # For DB service, most config changes don't require action
        # Database path changes would require restart, but that's handled by supervisor
        # Just log the reload event
        log_debug(f"DB service reloaded for section: {config_section}")

    @method_contract(
        method_id=DBMethods.SAVE_MESSAGE,
        input_model=DBSaveMessageRequest,
        output_model=DBSaveMessageResponse,
        summary="Store a chat message",
        exposure="internal",
        method_type="use",
    )
    async def store_message(self, cmd: DBSaveMessageRequest) -> DBSaveMessageResponse:
        """Handle store message command."""
        try:
            log_debug(f"Storing message: {cmd.role} - {cmd.content[:50]}...")

            # Map role to MessageType
            if cmd.role == "user":
                # Determine if it's text or voice based on metadata
                source_type = cmd.metadata.get("source_type", "Text") if cmd.metadata else "Text"
                # Using session_id from metadata if not explicitly passed, or generating one
                session_id = (
                    cmd.metadata.get("session_id", "default") if cmd.metadata else "default"
                )

                if source_type == "STT":
                    message = Message.create_user_voice_message(cmd.content, session_id)
                else:
                    message = Message.create_user_text_message(cmd.content, session_id)
            elif cmd.role == "assistant":
                session_id = (
                    cmd.metadata.get("session_id", "default") if cmd.metadata else "default"
                )
                message = Message.create_assistant_message(cmd.content, session_id)
            else:
                # Default to user text if role is unknown
                session_id = (
                    cmd.metadata.get("session_id", "default") if cmd.metadata else "default"
                )
                message = Message.create_user_text_message(cmd.content, session_id)

            # Set metadata if provided
            if cmd.metadata:
                message.metadata = cmd.metadata

            # Store in database
            success = await self.db_manager.store_message(message)

            if success:
                log_debug("Message stored successfully")
                # We don't have the ID easily available from store_message currently, returning 0
                return DBSaveMessageResponse(message_id=0, success=True)
            else:
                log_warning("Failed to store message")
                return DBSaveMessageResponse(message_id=0, success=False)

        except Exception as e:
            log_error(f"Error storing message: {e}", exc_info=True)
            return DBSaveMessageResponse(message_id=0, success=False)

    @method_contract(
        method_id=DBMethods.GET_MESSAGES,
        input_model=DBGetMessagesRequest,
        output_model=DBGetMessagesResponse,
        summary="Get recent chat messages",
        exposure="both",
        method_type="use",
    )
    async def get_messages(self, query: DBGetMessagesRequest) -> DBGetMessagesResponse:
        """Handle get recent messages query."""
        try:
            log_debug(f"Retrieving {query.limit} recent messages")

            # Get messages from database
            messages = await self.db_manager.get_recent_messages(limit=query.limit)

            # Convert to dict format
            messages_data = [
                {
                    "role": msg.role,
                    "content": msg.content,
                    "timestamp": msg.timestamp,
                    "metadata": msg.metadata,
                }
                for msg in messages
            ]

            return DBGetMessagesResponse(
                messages=messages_data, total=len(messages_data), has_more=False
            )  # Simplified for now

        except Exception as e:
            log_error(f"Error retrieving messages: {e}", exc_info=True)
            return DBGetMessagesResponse(messages=[], total=0, has_more=False)

    @method_contract(
        method_id=DBMethods.GET_MESSAGES_FOR_DATE,
        input_model=DBGetMessagesForDateRequest,
        output_model=DBGetMessagesResponse,
        summary="Get messages for a specific date",
        exposure="both",
        method_type="use",
    )
    async def get_messages_for_date(
        self, query: DBGetMessagesForDateRequest
    ) -> DBGetMessagesResponse:
        """Handle get messages for date query."""
        try:
            from datetime import date, datetime

            # Parse date if provided, otherwise use today
            target_date = date.today()
            if query.date:
                target_date = datetime.fromisoformat(query.date).date()

            log_debug(f"Retrieving messages for date: {target_date}")

            # Get messages from database
            messages = await self.db_manager.get_messages_for_date(target_date=target_date)

            # Convert to dict format
            messages_data = [
                {
                    "role": msg.role,
                    "content": msg.content,
                    "timestamp": msg.timestamp.isoformat()
                    if hasattr(msg.timestamp, "isoformat")
                    else str(msg.timestamp),
                    "metadata": msg.metadata,
                }
                for msg in messages
            ]

            log_info(f"Retrieved {len(messages_data)} messages for date {target_date}")

            return DBGetMessagesResponse(
                messages=messages_data, total=len(messages_data), has_more=False
            )

        except Exception as e:
            log_error(f"Error retrieving messages for date: {e}", exc_info=True)
            return DBGetMessagesResponse(messages=[], total=0, has_more=False)

    @method_contract(
        method_id=DBMethods.SAVE_CRON_JOB,
        input_model=DBStoreCronJobRequest,
        output_model=EmptyOutput,
        summary="Store a cron job",
        exposure="internal",
        method_type="manage",
    )
    async def store_cron_job(self, cmd: DBStoreCronJobRequest) -> EmptyOutput:
        """Handle store cron job command."""
        try:
            log_info(f"Storing cron job: {cmd.name} ({cmd.schedule})")

            # Create CronJob object from command
            import uuid

            job = CronJob(
                id=str(uuid.uuid4()),
                name=cmd.name,
                schedule_type=ScheduleType.CRON,  # Assuming cron format
                schedule_value=cmd.schedule,
                next_run_time=None,  # Will be calculated by scheduler
                callback_module="",  # Will be set from action
                callback_function=cmd.action,
                is_active=cmd.enabled,
                status=JobStatus.PENDING,
            )

            # Store in scheduler database
            success = await self.scheduler_db.add_job(job)

            if success:
                log_debug(f"Cron job '{cmd.name}' stored successfully")
            else:
                log_warning(f"Failed to store cron job '{cmd.name}'")

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error storing cron job: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.GET_CRON_JOBS,
        input_model=DBGetCronJobsRequest,
        output_model=DBGetCronJobsResponse,
        summary="Get cron jobs",
        exposure="internal",
        method_type="use",
    )
    async def get_cron_jobs(self, query: DBGetCronJobsRequest) -> DBGetCronJobsResponse:
        """Handle get cron jobs query."""
        try:
            log_debug("Retrieving cron jobs")

            # Get jobs from scheduler database
            if query.enabled_only:
                jobs = await self.scheduler_db.get_active_jobs()
            else:
                jobs = await self.scheduler_db.get_all_jobs()

            # Convert to dict format for serialization
            jobs_data = [job.to_dict() for job in jobs]

            log_debug(f"Retrieved {len(jobs_data)} cron jobs")
            return DBGetCronJobsResponse(jobs=jobs_data)

        except Exception as e:
            log_error(f"Error retrieving cron jobs: {e}", exc_info=True)
            return DBGetCronJobsResponse(jobs=[])

    @method_contract(
        method_id=DBMethods.DELETE_CRON_JOB,
        input_model=DBDeleteCronJobRequest,
        output_model=EmptyOutput,
        summary="Delete a cron job",
        exposure="internal",
        method_type="manage",
    )
    async def delete_cron_job(self, cmd: DBDeleteCronJobRequest) -> EmptyOutput:
        """Handle delete cron job command."""
        try:
            log_info(f"Deleting cron job: {cmd.job_id}")

            # Delete from scheduler database
            success = await self.scheduler_db.delete_job(str(cmd.job_id))

            if success:
                log_debug(f"Cron job {cmd.job_id} deleted successfully")
            else:
                log_warning(f"Failed to delete cron job {cmd.job_id}")

            return EmptyOutput()

        except Exception as e:
            log_error(f"Error deleting cron job: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.RAG_STORE,
        input_model=DBRAGStoreRequest,
        output_model=EmptyOutput,
        summary="Store item in RAG",
        exposure="internal",
        method_type="use",
    )
    async def rag_store(self, cmd: DBRAGStoreRequest) -> EmptyOutput:
        """Handle RAG store command."""
        try:
            log_debug(f"Storing RAG item: {cmd.namespace}/{cmd.key}")
            if not self.rag_service.is_initialized:
                log_debug("Skipping RAG store because RAG stores are disabled or unavailable")
                return EmptyOutput()

            # Convert string namespace to tuple (store expects tuple)
            # Support both "tools" and "main.memories" formats
            if isinstance(cmd.namespace, str):
                namespace_tuple = tuple(cmd.namespace.split("."))
            else:
                namespace_tuple = cmd.namespace

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            store.put(namespace_tuple, cmd.key, cmd.value, cmd.index)

            log_debug(f"RAG item stored successfully: {cmd.namespace}/{cmd.key}")
            return EmptyOutput()

        except Exception as e:
            log_error(f"Error storing RAG item: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.RAG_DELETE,
        input_model=DBRAGDeleteRequest,
        output_model=EmptyOutput,
        summary="Delete item from RAG",
        exposure="internal",
        method_type="manage",
    )
    async def rag_delete(self, cmd: DBRAGDeleteRequest) -> EmptyOutput:
        """Handle RAG delete command."""
        try:
            log_debug(f"Deleting RAG item: {cmd.namespace}/{cmd.key}")
            if not self.rag_service.is_initialized:
                log_debug("Skipping RAG delete because RAG stores are disabled or unavailable")
                return EmptyOutput()

            # Convert string namespace to tuple (store expects tuple)
            # Support both "tools" and "main.memories" formats
            if isinstance(cmd.namespace, str):
                namespace_tuple = tuple(cmd.namespace.split("."))
            else:
                namespace_tuple = cmd.namespace

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            store.delete(namespace_tuple, cmd.key)

            log_debug(f"RAG item deleted successfully: {cmd.namespace}/{cmd.key}")
            return EmptyOutput()

        except Exception as e:
            log_error(f"Error deleting RAG item: {e}", exc_info=True)
            return EmptyOutput()

    @method_contract(
        method_id=DBMethods.RAG_SEARCH,
        input_model=DBRAGSearchRequest,
        output_model=DBRAGListResponse,
        summary="Search RAG store",
        exposure="both",
        method_type="use",
    )
    async def rag_search(self, query: DBRAGSearchRequest) -> DBRAGListResponse:
        """Handle RAG search query."""
        try:
            log_debug(
                f"Searching RAG store: namespace={query.namespace}, query='{query.query}', limit={query.limit}"
            )
            if not self.rag_service.is_initialized:
                log_debug(
                    "Returning empty RAG search because RAG stores are disabled or unavailable"
                )
                return DBRAGListResponse(items=[])

            # Convert string namespace to tuple (store expects tuple)
            # Support both "tools" and "main.memories" formats
            if isinstance(query.namespace, str):
                namespace_tuple = tuple(query.namespace.split("."))
            else:
                namespace_tuple = query.namespace

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            items = store.search(
                namespace_tuple, query=query.query, limit=query.limit, offset=query.offset
            )

            # Convert items to response format
            rag_items = []
            for item in items:
                search_score = None
                if isinstance(item.value, dict) and "_search_score" in item.value:
                    search_score = item.value.pop("_search_score")
                # Convert tuple namespace to string (contract expects string)
                namespace_str = (
                    ".".join(item.namespace)
                    if isinstance(item.namespace, tuple)
                    else item.namespace
                )
                rag_items.append(
                    DBRAGItemResponse(
                        value=item.value,
                        key=item.key,
                        namespace=namespace_str,
                        search_score=search_score,
                    )
                )

            return DBRAGListResponse(items=rag_items)

        except Exception as e:
            log_error(f"Error searching RAG store: {e}", exc_info=True)
            return DBRAGListResponse(items=[])

    @method_contract(
        method_id=DBMethods.RAG_GET,
        input_model=DBRAGGetRequest,
        output_model=DBRAGItemResponse,
        summary="Get RAG item",
        exposure="internal",
        method_type="use",
    )
    async def rag_get(self, query: DBRAGGetRequest) -> DBRAGItemResponse | None:
        """Handle RAG get query."""
        try:
            log_debug(f"Getting RAG item: {query.namespace}/{query.key}")
            if not self.rag_service.is_initialized:
                log_debug("Returning no RAG item because RAG stores are disabled or unavailable")
                return None

            # Convert string namespace to tuple (store expects tuple)
            # Support both "tools" and "main.memories" formats
            if isinstance(query.namespace, str):
                namespace_tuple = tuple(query.namespace.split("."))
            else:
                namespace_tuple = query.namespace

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            item = store.get(namespace_tuple, query.key)

            if item:
                # Convert tuple namespace to string (contract expects string)
                namespace_str = (
                    ".".join(item.namespace)
                    if isinstance(item.namespace, tuple)
                    else item.namespace
                )
                return DBRAGItemResponse(
                    value=item.value, key=item.key, namespace=namespace_str, search_score=None
                )
            return None

        except Exception as e:
            log_error(f"Error getting RAG item: {e}", exc_info=True)
            return None

    @method_contract(
        method_id=DBMethods.RAG_LIST,
        input_model=DBRAGListRequest,
        output_model=DBRAGListResponse,
        summary="List RAG items",
        exposure="internal",
        method_type="use",
    )
    async def rag_list(self, query: DBRAGListRequest) -> DBRAGListResponse:
        """Handle RAG list query."""
        try:
            log_debug(
                f"Listing RAG items: namespace={query.namespace}, limit={query.limit}, offset={query.offset}"
            )
            if not self.rag_service.is_initialized:
                log_debug("Returning empty RAG list because RAG stores are disabled or unavailable")
                return DBRAGListResponse(items=[])

            # Convert string namespace to tuple (store expects tuple)
            # Support both "tools" and "main.memories" formats
            if isinstance(query.namespace, str):
                namespace_tuple = tuple(query.namespace.split("."))
            else:
                namespace_tuple = query.namespace

            # Get the appropriate store based on namespace
            store = self.rag_service.combined_store
            items = store.retrieve_items(namespace_tuple, limit=query.limit, offset=query.offset)

            # Convert items to response format
            rag_items = []
            for item in items:
                # Convert tuple namespace to string (contract expects string)
                namespace_str = (
                    ".".join(item.namespace)
                    if isinstance(item.namespace, tuple)
                    else item.namespace
                )
                rag_items.append(
                    DBRAGItemResponse(
                        value=item.value, key=item.key, namespace=namespace_str, search_score=None
                    )
                )

            return DBRAGListResponse(items=rag_items)

        except Exception as e:
            log_error(f"Error listing RAG items: {e}", exc_info=True)
            return DBRAGListResponse(items=[])

    # ── User CRUD ────────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.CREATE_USER,
        input_model=DBCreateUserRequest,
        output_model=DBBoolResponse,
        summary="Create a user",
        exposure="internal",
        method_type="manage",
    )
    async def create_user(self, cmd: DBCreateUserRequest) -> DBBoolResponse:
        """Create a new user."""
        try:
            from datetime import datetime

            user = User(
                id=cmd.id,
                username=cmd.username,
                password_hash=cmd.password_hash,
                role=cmd.role,
                permissions=cmd.permissions or [],
                is_admin=cmd.is_admin,
                created_at=datetime.fromisoformat(cmd.created_at) if cmd.created_at else None,
            )
            success = await self.db_manager.create_user(user)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error creating user: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_USER_BY_USERNAME,
        input_model=DBGetUserByUsernameRequest,
        output_model=DBUserResponse,
        summary="Get a user by username",
        exposure="internal",
        method_type="use",
    )
    async def get_user_by_username(self, query: DBGetUserByUsernameRequest) -> DBUserResponse:
        """Get a user by username."""
        try:
            user = await self.db_manager.get_user_by_username(query.username)
            return DBUserResponse(user=user.to_dict() if user else None)
        except Exception as e:
            log_error(f"Error getting user by username: {e}", exc_info=True)
            return DBUserResponse(user=None)

    @method_contract(
        method_id=DBMethods.GET_USER_BY_ID,
        input_model=DBGetUserByIdRequest,
        output_model=DBUserResponse,
        summary="Get a user by ID",
        exposure="internal",
        method_type="use",
    )
    async def get_user_by_id(self, query: DBGetUserByIdRequest) -> DBUserResponse:
        """Get a user by ID."""
        try:
            user = await self.db_manager.get_user_by_id(query.user_id)
            return DBUserResponse(user=user.to_dict() if user else None)
        except Exception as e:
            log_error(f"Error getting user by ID: {e}", exc_info=True)
            return DBUserResponse(user=None)

    @method_contract(
        method_id=DBMethods.COUNT_USERS,
        input_model=DBCountUsersRequest,
        output_model=DBCountResponse,
        summary="Count total users",
        exposure="internal",
        method_type="use",
    )
    async def count_users(self, query: DBCountUsersRequest) -> DBCountResponse:
        """Count total users."""
        try:
            count = await self.db_manager.count_users()
            return DBCountResponse(count=count)
        except Exception as e:
            log_error(f"Error counting users: {e}", exc_info=True)
            return DBCountResponse(count=0)

    @method_contract(
        method_id=DBMethods.LIST_USERS,
        input_model=DBListUsersRequest,
        output_model=DBUserListResponse,
        summary="List all users",
        exposure="internal",
        method_type="use",
    )
    async def list_users(self, query: DBListUsersRequest) -> DBUserListResponse:
        """List all users."""
        try:
            users = await self.db_manager.list_users()
            return DBUserListResponse(users=[u.to_dict() for u in users])
        except Exception as e:
            log_error(f"Error listing users: {e}", exc_info=True)
            return DBUserListResponse(users=[])

    @method_contract(
        method_id=DBMethods.UPDATE_USER,
        input_model=DBUpdateUserRequest,
        output_model=DBBoolResponse,
        summary="Update a user's fields",
        exposure="internal",
        method_type="manage",
    )
    async def update_user(self, cmd: DBUpdateUserRequest) -> DBBoolResponse:
        """Update a user's fields."""
        try:
            success = await self.db_manager.update_user(cmd.user_id, **cmd.fields)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error updating user: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.DELETE_USER,
        input_model=DBDeleteUserRequest,
        output_model=DBBoolResponse,
        summary="Delete a user",
        exposure="internal",
        method_type="manage",
    )
    async def delete_user(self, cmd: DBDeleteUserRequest) -> DBBoolResponse:
        """Delete a user."""
        try:
            success = await self.db_manager.delete_user(cmd.user_id)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error deleting user: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    # ── Device CRUD ──────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.CREATE_DEVICE,
        input_model=DBCreateDeviceRequest,
        output_model=DBBoolResponse,
        summary="Create a device",
        exposure="internal",
        method_type="manage",
    )
    async def create_device(self, cmd: DBCreateDeviceRequest) -> DBBoolResponse:
        """Create a new device."""
        try:
            device = Device(
                id=cmd.id,
                user_id=cmd.user_id,
                name=cmd.name,
                public_key=cmd.public_key,
                is_trusted=cmd.is_trusted,
            )
            success = await self.db_manager.create_device(device)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error creating device: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_DEVICE_BY_ID,
        input_model=DBGetDeviceByIdRequest,
        output_model=DBDeviceResponse,
        summary="Get a device by ID",
        exposure="internal",
        method_type="use",
    )
    async def get_device_by_id(self, query: DBGetDeviceByIdRequest) -> DBDeviceResponse:
        """Get a device by ID."""
        try:
            device = await self.db_manager.get_device_by_id(query.device_id)
            return DBDeviceResponse(device=device.to_dict() if device else None)
        except Exception as e:
            log_error(f"Error getting device by ID: {e}", exc_info=True)
            return DBDeviceResponse(device=None)

    @method_contract(
        method_id=DBMethods.LIST_DEVICES,
        input_model=DBListDevicesRequest,
        output_model=DBDeviceListResponse,
        summary="List devices, optionally filtered by user",
        exposure="internal",
        method_type="use",
    )
    async def list_devices(self, query: DBListDevicesRequest) -> DBDeviceListResponse:
        """List devices, optionally filtered by user."""
        try:
            if query.user_id:
                devices = await self.db_manager.get_devices_by_user(query.user_id)
            else:
                devices = await self.db_manager.list_devices()
            return DBDeviceListResponse(devices=[d.to_dict() for d in devices])
        except Exception as e:
            log_error(f"Error listing devices: {e}", exc_info=True)
            return DBDeviceListResponse(devices=[])

    @method_contract(
        method_id=DBMethods.DELETE_DEVICE,
        input_model=DBDeleteDeviceRequest,
        output_model=DBBoolResponse,
        summary="Delete a device",
        exposure="internal",
        method_type="manage",
    )
    async def delete_device(self, cmd: DBDeleteDeviceRequest) -> DBBoolResponse:
        """Delete a device."""
        try:
            success = await self.db_manager.delete_device(cmd.device_id)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error deleting device: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    # ── Token CRUD ───────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.CREATE_TOKEN,
        input_model=DBCreateTokenRequest,
        output_model=DBBoolResponse,
        summary="Create a token",
        exposure="internal",
        method_type="manage",
    )
    async def create_token(self, cmd: DBCreateTokenRequest) -> DBBoolResponse:
        """Create a new token."""
        try:
            from datetime import datetime

            token = Token(
                id=cmd.id,
                token_hash=cmd.token_hash,
                prefix=cmd.prefix,
                device_id=cmd.device_id,
                user_id=cmd.user_id,
                scopes=cmd.scopes or [],
                expires_at=datetime.fromisoformat(cmd.expires_at) if cmd.expires_at else None,
            )
            success = await self.db_manager.create_token(token)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error creating token: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_TOKEN_BY_HASH,
        input_model=DBGetTokenByHashRequest,
        output_model=DBTokenResponse,
        summary="Get a token by hash",
        exposure="internal",
        method_type="use",
    )
    async def get_token_by_hash(self, query: DBGetTokenByHashRequest) -> DBTokenResponse:
        """Get a token by hash."""
        try:
            token = await self.db_manager.get_token_by_hash(query.token_hash)
            return DBTokenResponse(token=token.to_dict() if token else None)
        except Exception as e:
            log_error(f"Error getting token by hash: {e}", exc_info=True)
            return DBTokenResponse(token=None)

    @method_contract(
        method_id=DBMethods.GET_TOKEN_BY_ID,
        input_model=DBGetTokenByIdRequest,
        output_model=DBTokenResponse,
        summary="Get a token by ID",
        exposure="internal",
        method_type="use",
    )
    async def get_token_by_id(self, query: DBGetTokenByIdRequest) -> DBTokenResponse:
        """Get a token by ID."""
        try:
            token = await self.db_manager.get_token_by_id(query.token_id)
            return DBTokenResponse(token=token.to_dict() if token else None)
        except Exception as e:
            log_error(f"Error getting token by ID: {e}", exc_info=True)
            return DBTokenResponse(token=None)

    @method_contract(
        method_id=DBMethods.LIST_TOKENS,
        input_model=DBListTokensRequest,
        output_model=DBTokenListResponse,
        summary="List tokens, optionally filtered",
        exposure="internal",
        method_type="use",
    )
    async def list_tokens(self, query: DBListTokensRequest) -> DBTokenListResponse:
        """List tokens, optionally filtered by user and/or device."""
        try:
            tokens = await self.db_manager.list_tokens(
                user_id=query.user_id, device_id=query.device_id
            )
            return DBTokenListResponse(tokens=[t.to_dict() for t in tokens])
        except Exception as e:
            log_error(f"Error listing tokens: {e}", exc_info=True)
            return DBTokenListResponse(tokens=[])

    @method_contract(
        method_id=DBMethods.UPDATE_TOKEN_SCOPES,
        input_model=DBUpdateTokenScopesRequest,
        output_model=DBBoolResponse,
        summary="Update token scopes",
        exposure="internal",
        method_type="manage",
    )
    async def update_token_scopes(self, cmd: DBUpdateTokenScopesRequest) -> DBBoolResponse:
        """Update the scopes of a token."""
        try:
            success = await self.db_manager.update_token_scopes(cmd.token_id, cmd.scopes)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error updating token scopes: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.REVOKE_TOKEN,
        input_model=DBRevokeTokenRequest,
        output_model=DBBoolResponse,
        summary="Revoke a token",
        exposure="internal",
        method_type="manage",
    )
    async def revoke_token(self, cmd: DBRevokeTokenRequest) -> DBBoolResponse:
        """Revoke (delete) a token."""
        try:
            success = await self.db_manager.revoke_token(cmd.token_id)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error revoking token: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    # ── Audit Log ────────────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.GET_AUDIT_LOG,
        input_model=DBAuditLogRequest,
        output_model=DBAuditLogResponse,
        summary="Query the audit log",
        exposure="internal",
        method_type="use",
    )
    async def get_audit_log(self, query: DBAuditLogRequest) -> DBAuditLogResponse:
        """Query the audit log with optional filters."""
        try:
            events = await self.db_manager.get_audit_log(
                limit=query.limit,
                offset=query.offset,
                principal_id=query.principal_id,
                event=query.event,
            )
            # Count total matching events for pagination
            total = await self._count_audit_events(
                principal_id=query.principal_id, event=query.event
            )
            return DBAuditLogResponse(events=events, total=total)
        except Exception as e:
            log_error(f"Error getting audit log: {e}", exc_info=True)
            return DBAuditLogResponse(events=[], total=0)

    @method_contract(
        method_id=DBMethods.COUNT_AUDIT_EVENTS,
        input_model=DBCountAuditEventsRequest,
        output_model=DBCountResponse,
        summary="Count audit events matching filters",
        exposure="internal",
        method_type="use",
    )
    async def count_audit_events(self, query: DBCountAuditEventsRequest) -> DBCountResponse:
        """Count audit events matching filters."""
        try:
            count = await self._count_audit_events(
                principal_id=query.principal_id, event=query.event
            )
            return DBCountResponse(count=count)
        except Exception as e:
            log_error(f"Error counting audit events: {e}", exc_info=True)
            return DBCountResponse(count=0)

    async def _count_audit_events(
        self,
        principal_id: str | None = None,
        event: str | None = None,
    ) -> int:
        """Internal helper to count audit events matching filters."""
        import aiosqlite

        try:
            async with aiosqlite.connect(self.db_manager.db_path) as db:
                query_str = "SELECT COUNT(*) FROM audit_log WHERE 1=1"
                params: list[object] = []
                if event:
                    query_str += " AND event = ?"
                    params.append(event)
                if principal_id:
                    query_str += " AND principal_id = ?"
                    params.append(principal_id)
                cursor = await db.execute(query_str, params)
                result = await cursor.fetchone()
                return result[0] if result else 0
        except Exception as e:
            log_error(f"Error counting audit events: {e}")
            return 0

    # ── Mesh Credentials ─────────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.SAVE_MESH_CREDENTIAL,
        input_model=DBSaveMeshCredentialRequest,
        output_model=DBBoolResponse,
        summary="Save a mesh credential",
        exposure="internal",
        method_type="use",
    )
    async def save_mesh_credential(self, cmd: DBSaveMeshCredentialRequest) -> DBBoolResponse:
        """Save a mesh credential."""
        try:
            credential = MeshCredential(
                id=cmd.id,
                room_name=cmd.room_name,
                token=cmd.token,
                remote_device_id=cmd.remote_device_id,
                remote_user_id=cmd.remote_user_id,
            )
            success = await self.db_manager.save_mesh_credential(credential)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error saving mesh credential: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    @method_contract(
        method_id=DBMethods.GET_MESH_CREDENTIAL_BY_ROOM,
        input_model=DBGetMeshCredentialByRoomRequest,
        output_model=DBMeshCredentialResponse,
        summary="Get a mesh credential by room name",
        exposure="internal",
        method_type="use",
    )
    async def get_mesh_credential_by_room(
        self, query: DBGetMeshCredentialByRoomRequest
    ) -> DBMeshCredentialResponse:
        """Get a mesh credential by room name."""
        try:
            credential = await self.db_manager.get_mesh_credential_by_room(query.room_name)
            return DBMeshCredentialResponse(credential=credential.to_dict() if credential else None)
        except Exception as e:
            log_error(f"Error getting mesh credential: {e}", exc_info=True)
            return DBMeshCredentialResponse(credential=None)

    @method_contract(
        method_id=DBMethods.DELETE_MESH_CREDENTIAL,
        input_model=DBDeleteMeshCredentialRequest,
        output_model=DBBoolResponse,
        summary="Delete a mesh credential by room name",
        exposure="internal",
        method_type="manage",
    )
    async def delete_mesh_credential(self, cmd: DBDeleteMeshCredentialRequest) -> DBBoolResponse:
        """Delete a mesh credential by room name."""
        try:
            success = await self.db_manager.delete_mesh_credential(cmd.room_name)
            return DBBoolResponse(success=success)
        except Exception as e:
            log_error(f"Error deleting mesh credential: {e}", exc_info=True)
            return DBBoolResponse(success=False)

    # ── Generic SQL Execution ────────────────────────────────────────────

    @method_contract(
        method_id=DBMethods.EXECUTE_SQL,
        input_model=DBExecuteSQLRequest,
        output_model=DBExecuteSQLResponse,
        summary="Execute raw SQL (internal use only)",
        exposure="internal",
        method_type="manage",
    )
    async def execute_sql(self, cmd: DBExecuteSQLRequest) -> DBExecuteSQLResponse:
        """Execute arbitrary SQL for internal services (e.g. auth_manager).

        Supports both read (SELECT) and write (INSERT/UPDATE/DELETE) queries.
        Returns rows for SELECTs and rowcount for writes.
        """
        try:
            import aiosqlite

            params = tuple(cmd.params) if cmd.params else ()
            async with aiosqlite.connect(self.db_manager.db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(cmd.sql, params)

                # Detect if this is a SELECT (returns rows)
                sql_stripped = cmd.sql.strip().upper()
                if sql_stripped.startswith("SELECT"):
                    rows = await cursor.fetchall()
                    return DBExecuteSQLResponse(
                        rows=[dict(row) for row in rows],
                        rowcount=len(rows),
                    )
                else:
                    await db.commit()
                    return DBExecuteSQLResponse(
                        rows=[],
                        rowcount=cursor.rowcount,
                    )
        except Exception as e:
            log_error(f"Error executing SQL: {e}", exc_info=True)
            return DBExecuteSQLResponse(rows=[], rowcount=0)
