"""Database Service for Aurora's parallel architecture.

This service:
- Handles database persistence commands using DatabaseManager
- Responds to database queries
- Manages message history
- Manages scheduler jobs
"""

from __future__ import annotations

import logging

from pydantic import BaseModel

from app.db.manager import DatabaseManager
from app.db.models import CronJob, Message
from app.db.scheduler_db_service import SchedulerDatabaseService
from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.messaging import Command, DBTopics, Envelope, MessageBus, Query, QueryResult

logger = logging.getLogger(__name__)


# Message definitions
class StoreMessage(Command):
    """Command to store a message in history."""

    role: str
    content: str
    session_id: str | None = None
    metadata: dict = {}


class GetRecentMessages(Query):
    """Query to retrieve recent messages."""

    limit: int = 10
    session_id: str | None = None


class GetMessagesForDate(Query):
    """Query to retrieve messages for a specific date."""

    date: str | None = None  # ISO format date string (YYYY-MM-DD), None = today


class MessagesResponse(BaseModel):
    """Response containing a list of messages."""

    messages: list[dict]  # List of message dictionaries


class StoreCronJob(Command):
    """Command to store a cron job."""

    name: str
    schedule: str
    action: str
    enabled: bool = True


class GetCronJobs(Query):
    """Query to retrieve all cron jobs."""

    enabled_only: bool = False


class DeleteCronJob(Command):
    """Command to delete a cron job."""

    job_id: int


# Service implementation
class DBService:
    """Database service.

    Responsibilities:
    - Process database commands
    - Respond to queries
    - Manage data persistence
    - Ensure data integrity
    """

    def __init__(self, bus: MessageBus, db_path: str | None = None):
        """Initialize DB service with DatabaseManager.

        Args:
            bus: MessageBus instance
            db_path: Optional path to database file
        """
        self.bus = bus
        self.db_manager = DatabaseManager(db_path)
        self.scheduler_db = SchedulerDatabaseService(db_path)

    async def start(self) -> None:
        """Start the DB service and subscribe to commands."""
        log_info("Starting DB service...")

        # Initialize databases
        await self.db_manager.initialize()
        await self.scheduler_db.initialize()

        # Subscribe to commands and queries using typed topics
        self.bus.subscribe(DBTopics.STORE_MESSAGE, self._store_message)
        self.bus.subscribe(DBTopics.GET_RECENT_MESSAGES, self._get_messages)
        self.bus.subscribe(DBTopics.GET_MESSAGES_FOR_DATE, self._get_messages_for_date)
        self.bus.subscribe(DBTopics.STORE_CRON_JOB, self._store_cron_job)
        self.bus.subscribe(DBTopics.GET_CRON_JOBS, self._get_cron_jobs)
        self.bus.subscribe(DBTopics.DELETE_CRON_JOB, self._delete_cron_job)

        log_info("DB service started")

    async def stop(self) -> None:
        """Stop the DB service."""
        log_info("Stopping DB service...")

        # Close database connections if needed
        if self.db_manager:
            await self.db_manager.close()
            log_debug("Database manager closed")

        log_info("DB service stopped")

    async def _store_message(self, env: Envelope) -> None:
        """Handle store message command.

        Args:
            env: Message envelope containing StoreMessage command
        """
        try:
            cmd = StoreMessage.model_validate(env.payload)
            log_debug(f"Storing message: {cmd.role} - {cmd.content[:50]}...")

            # Create Message object
            message = Message(role=cmd.role, content=cmd.content, metadata=cmd.metadata if cmd.metadata else {})

            # Store in database
            success = await self.db_manager.store_message(message)

            if success:
                log_debug("Message stored successfully")
            else:
                log_warning("Failed to store message")

        except Exception as e:
            log_error(f"Error storing message: {e}", exc_info=True)

    async def _get_messages(self, env: Envelope) -> None:
        """Handle get recent messages query.

        Args:
            env: Message envelope containing GetRecentMessages query
        """
        try:
            query = GetRecentMessages.model_validate(env.payload)
            log_debug(f"Retrieving {query.limit} recent messages")

            # Get messages from database
            messages = await self.db_manager.get_recent_messages(limit=query.limit)

            # Convert to dict format
            messages_data = [{"role": msg.role, "content": msg.content, "timestamp": msg.timestamp, "metadata": msg.metadata} for msg in messages]

            # Send response to reply topic
            if env.reply_to:
                result = QueryResult(ok=True, data=messages_data)
                await self.bus.publish(
                    env.reply_to,
                    result,
                    origin="internal",
                )

        except Exception as e:
            log_error(f"Error retrieving messages: {e}", exc_info=True)
            if env.reply_to:
                result = QueryResult(ok=False, error=str(e))
                await self.bus.publish(
                    env.reply_to,
                    result,
                    origin="internal",
                )

    async def _get_messages_for_date(self, env: Envelope) -> None:
        """Handle get messages for date query.

        Args:
            env: Message envelope containing GetMessagesForDate query
        """
        try:
            from datetime import date, datetime

            query = GetMessagesForDate.model_validate(env.payload)

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
                    "timestamp": msg.timestamp.isoformat() if hasattr(msg.timestamp, "isoformat") else str(msg.timestamp),
                    "metadata": msg.metadata,
                }
                for msg in messages
            ]

            log_info(f"📚 Retrieved {len(messages_data)} messages for date {target_date}")

            # Send response - publish as event with MESSAGES_RESPONSE topic
            await self.bus.publish(
                DBTopics.MESSAGES_RESPONSE,
                MessagesResponse(messages=messages_data),
                event=True,
                origin="internal",
            )

        except Exception as e:
            log_error(f"Error retrieving messages for date: {e}", exc_info=True)

    async def _store_cron_job(self, env: Envelope) -> None:
        """Handle store cron job command.

        Args:
            env: Message envelope containing StoreCronJob command
        """
        try:
            cmd = StoreCronJob.model_validate(env.payload)
            log_info(f"Storing cron job: {cmd.name} ({cmd.schedule})")

            # Create CronJob object from command
            import uuid

            from app.db.models import JobStatus, ScheduleType

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

        except Exception as e:
            log_error(f"Error storing cron job: {e}", exc_info=True)

    async def _get_cron_jobs(self, env: Envelope) -> None:
        """Handle get cron jobs query.

        Args:
            env: Message envelope containing GetCronJobs query
        """
        try:
            query = GetCronJobs.model_validate(env.payload)
            log_debug("Retrieving cron jobs")

            # Get jobs from scheduler database
            if query.enabled_only:
                jobs = await self.scheduler_db.get_active_jobs()
            else:
                jobs = await self.scheduler_db.get_all_jobs()

            # Convert to dict format for serialization
            jobs_data = [job.to_dict() for job in jobs]

            log_debug(f"Retrieved {len(jobs_data)} cron jobs")

            # Send response to reply topic
            if env.reply_to:
                result = QueryResult(ok=True, data=jobs_data)
                await self.bus.publish(
                    env.reply_to,
                    result,
                    origin="internal",
                )

        except Exception as e:
            log_error(f"Error retrieving cron jobs: {e}", exc_info=True)
            if env.reply_to:
                result = QueryResult(ok=False, error=str(e))
                await self.bus.publish(
                    env.reply_to,
                    result,
                    origin="internal",
                )

    async def _delete_cron_job(self, env: Envelope) -> None:
        """Handle delete cron job command.

        Args:
            env: Message envelope containing DeleteCronJob command
        """
        try:
            cmd = DeleteCronJob.model_validate(env.payload)
            log_info(f"Deleting cron job: {cmd.job_id}")

            # Delete from scheduler database
            success = await self.scheduler_db.delete_job(str(cmd.job_id))

            if success:
                log_debug(f"Cron job {cmd.job_id} deleted successfully")
            else:
                log_warning(f"Failed to delete cron job {cmd.job_id}")

        except Exception as e:
            log_error(f"Error deleting cron job: {e}", exc_info=True)
