"""
Helper functions for ambient transcription integration.
"""

import asyncio
from typing import Optional

from app.config.config_manager import ConfigManager
from app.database.ambient_transcription_service import AmbientTranscriptionService
from app.database.database_manager import DatabaseManager
from app.helpers.aurora_logger import log_error, log_info


async def setup_ambient_transcription_integration(
    config_manager: ConfigManager = None,
) -> tuple[Optional[DatabaseManager], Optional[AmbientTranscriptionService]]:
    """
    Set up ambient transcription database integration.

    Returns:
        tuple: (database_manager, ambient_service) or (None, None) if disabled
    """
    try:
        config_manager = config_manager or ConfigManager()

        # Check if ambient transcription is enabled
        ambient_enabled = config_manager.get("general.speech_to_text.ambient_transcription.enable", False)
        if not ambient_enabled:
            log_info("Ambient transcription is disabled")
            return None, None

        # Check if database storage is enabled
        use_database = config_manager.get("general.speech_to_text.ambient_transcription.use_database_storage", True)
        if not use_database:
            log_info("Ambient transcription database storage is disabled")
            return None, None

        # Initialize database manager
        db_manager = DatabaseManager()
        await db_manager.initialize()

        # Initialize ambient transcription service
        ambient_service = AmbientTranscriptionService(db_manager, config_manager)
        await ambient_service.initialize()

        log_info("Ambient transcription database integration initialized")
        return db_manager, ambient_service

    except Exception as e:
        log_error(f"Error setting up ambient transcription integration: {e}")
        return None, None


def create_ambient_callback(ambient_service: AmbientTranscriptionService, session_id: Optional[str] = None):
    """
    Create a callback function for the AudioToTextRecorder that stores transcriptions in the database.

    Args:
        ambient_service: The ambient transcription service instance
        session_id: Optional session ID for grouping transcriptions

    Returns:
        callable: Callback function compatible with AudioToTextRecorder
    """
    return ambient_service.create_storage_callback(session_id)


async def search_ambient_transcriptions(
    ambient_service: AmbientTranscriptionService, query: str, use_similarity: bool = True, limit: int = 20, similarity_threshold: float = 0.7
):
    """
    Search ambient transcriptions by text or semantic similarity.

    Args:
        ambient_service: The ambient transcription service instance
        query: Search query text
        use_similarity: Whether to use semantic similarity (True) or text search (False)
        limit: Maximum number of results to return
        similarity_threshold: Minimum similarity score for vector search

    Returns:
        list: List of AmbientTranscription objects matching the query
    """
    try:
        if use_similarity:
            return await ambient_service.search_by_similarity(query, limit, similarity_threshold)
        else:
            return await ambient_service.search_by_text(query, limit)
    except Exception as e:
        log_error(f"Error searching ambient transcriptions: {e}")
        return []


async def get_daily_ambient_summary(ambient_service: AmbientTranscriptionService, target_date=None):
    """
    Get all ambient transcriptions for a specific date.

    Args:
        ambient_service: The ambient transcription service instance
        target_date: Target date (defaults to today)

    Returns:
        list: List of AmbientTranscription objects for the date
    """
    try:
        return await ambient_service.get_transcriptions_for_date(target_date)
    except Exception as e:
        log_error(f"Error getting daily ambient summary: {e}")
        return []


def setup_ambient_recorder_with_database(config_manager: ConfigManager = None, session_id: Optional[str] = None, **recorder_kwargs):
    """
    Set up AudioToTextRecorder with database integration for ambient transcription.

    This is a helper function that handles the async setup and returns a configured recorder.

    Args:
        config_manager: Configuration manager instance
        session_id: Optional session ID for grouping transcriptions
        **recorder_kwargs: Additional arguments to pass to AudioToTextRecorder

    Returns:
        tuple: (recorder, ambient_service) where recorder is configured with database integration
    """
    try:
        from app.speech_to_text.audio_recorder import AudioToTextRecorder

        config_manager = config_manager or ConfigManager()

        # Get ambient transcription configuration
        ambient_config = config_manager.get("general.speech_to_text.ambient_transcription", {})

        # Setup database integration
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            db_manager, ambient_service = loop.run_until_complete(setup_ambient_transcription_integration(config_manager))
        finally:
            loop.close()

        # Configure recorder with ambient transcription
        recorder_config = {
            "enable_ambient_transcription": ambient_config.get("enable", False),
            "ambient_chunk_duration": ambient_config.get("chunk_duration", 3.0),
            "ambient_storage_path": ambient_config.get("storage_path", "ambient_logs/"),
            "ambient_filter_short": ambient_config.get("filter_short_transcriptions", True),
            "ambient_min_length": ambient_config.get("min_transcription_length", 10),
            "ambient_db_manager": db_manager,
            "ambient_config_manager": config_manager,
        }

        # Add database callback if service is available
        if ambient_service and not recorder_config.get("on_ambient_transcription"):
            recorder_config["on_ambient_transcription"] = create_ambient_callback(ambient_service, session_id)

        # Merge with user-provided kwargs (user settings take precedence)
        recorder_config.update(recorder_kwargs)

        recorder = AudioToTextRecorder(**recorder_config)

        log_info("AudioToTextRecorder configured with database integration")
        return recorder, ambient_service

    except Exception as e:
        log_error(f"Error setting up ambient recorder with database: {e}")
        # Fall back to basic recorder without database integration
        from app.speech_to_text.audio_recorder import AudioToTextRecorder

        recorder = AudioToTextRecorder(**recorder_kwargs)
        return recorder, None
