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
    DBDeleteCronJobRequest,
    DBGetCronJobsRequest,
    DBGetCronJobsResponse,
    DBGetMessagesForDateRequest,
    DBGetMessagesRequest,
    DBGetMessagesResponse,
    DBMethods,
    DBModule,
    DBRAGDeleteRequest,
    DBRAGGetRequest,
    DBRAGItemResponse,
    DBRAGListRequest,
    DBRAGListResponse,
    DBRAGSearchRequest,
    DBRAGStoreRequest,
    DBSaveMessageRequest,
    DBSaveMessageResponse,
    DBStoreCronJobRequest,
)
from app.shared.contracts.registry import method_contract
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
    )
    async def rag_store(self, cmd: DBRAGStoreRequest) -> EmptyOutput:
        """Handle RAG store command."""
        try:
            log_debug(f"Storing RAG item: {cmd.namespace}/{cmd.key}")

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
    )
    async def rag_delete(self, cmd: DBRAGDeleteRequest) -> EmptyOutput:
        """Handle RAG delete command."""
        try:
            log_debug(f"Deleting RAG item: {cmd.namespace}/{cmd.key}")

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
    )
    async def rag_search(self, query: DBRAGSearchRequest) -> DBRAGListResponse:
        """Handle RAG search query."""
        try:
            log_debug(
                f"Searching RAG store: namespace={query.namespace}, query='{query.query}', limit={query.limit}"
            )

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
    )
    async def rag_get(self, query: DBRAGGetRequest) -> DBRAGItemResponse | None:
        """Handle RAG get query."""
        try:
            log_debug(f"Getting RAG item: {query.namespace}/{query.key}")

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
    )
    async def rag_list(self, query: DBRAGListRequest) -> DBRAGListResponse:
        """Handle RAG list query."""
        try:
            log_debug(
                f"Listing RAG items: namespace={query.namespace}, limit={query.limit}, offset={query.offset}"
            )

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
