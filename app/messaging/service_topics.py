"""Service Topics - Centralized topic definitions for all services.

This module defines all valid message bus topics as typed constants,
preventing typos and making it easy to discover available topics.
"""

from typing import List

from app.messaging.event_registry import TopicDefinition

# =============================================================================
# AUDIO INPUT SERVICE
# =============================================================================


class AudioInputTopics:
    """Topics for AudioInputService."""

    # Events
    STREAM_STARTED = "Audio.Stream.Started"
    STREAM_STOPPED = "Audio.Stream.Stopped"
    STREAM_CHUNK = "Audio.Stream.Microphone"  # AudioChunk events

    # Commands
    CONTROL = "Audio.Input.Control"


AUDIO_INPUT_TOPIC_DEFS: list[TopicDefinition] = [
    # Legacy AudioTopics from audio_messages.py
    TopicDefinition(
        topic="Audio.Started",
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioStreamStarted",
        description="Audio started (legacy)",
    ),
    TopicDefinition(
        topic="Audio.Stopped",
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioStreamStopped",
        description="Audio stopped (legacy)",
    ),
    # AudioTopics stream types (from audio_messages.py)
    TopicDefinition(
        topic="Audio.Stream.Microphone",
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioChunk",
        description="Audio chunk from microphone",
    ),
    TopicDefinition(
        topic="Audio.Stream.WebSocket",
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioChunk",
        description="Audio chunk from WebSocket",
    ),
    TopicDefinition(
        topic="Audio.Stream.File", service="AudioInputService", message_type="Event", payload_class="AudioChunk", description="Audio chunk from file"
    ),
    TopicDefinition(
        topic="Audio.Stream.Generic",
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioChunk",
        description="Audio chunk from generic source",
    ),
    # New AudioInputTopics
    TopicDefinition(
        topic=AudioInputTopics.STREAM_STARTED,
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioStreamStarted",
        description="Audio stream started",
    ),
    TopicDefinition(
        topic=AudioInputTopics.STREAM_STOPPED,
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioStreamStopped",
        description="Audio stream stopped",
    ),
    TopicDefinition(
        topic=AudioInputTopics.STREAM_CHUNK,
        service="AudioInputService",
        message_type="Event",
        payload_class="AudioChunk",
        description="Audio chunk from microphone (new)",
    ),
    TopicDefinition(
        topic=AudioInputTopics.CONTROL,
        service="AudioInputService",
        message_type="Command",
        payload_class="AudioInputControl",
        description="Control audio input (start/stop/pause/resume)",
    ),
]


# =============================================================================
# WAKE WORD SERVICE
# =============================================================================


class WakeWordTopics:
    """Topics for WakeWordService."""

    # Events
    DETECTED = "WakeWord.Detected"
    TIMEOUT = "WakeWord.Timeout"

    # Commands
    CONTROL = "WakeWord.Control"


WAKEWORD_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=WakeWordTopics.DETECTED,
        service="WakeWordService",
        message_type="Event",
        payload_class="WakeWordDetected",
        description="Wake word detected in audio stream",
    ),
    TopicDefinition(
        topic=WakeWordTopics.TIMEOUT,
        service="WakeWordService",
        message_type="Event",
        payload_class="WakeWordTimeout",
        description="Wake word detection timed out",
    ),
    TopicDefinition(
        topic=WakeWordTopics.CONTROL,
        service="WakeWordService",
        message_type="Command",
        payload_class="WakeWordControl",
        description="Control wake word detection",
    ),
]


# =============================================================================
# TRANSCRIPTION SERVICE
# =============================================================================


class TranscriptionTopics:
    """Topics for TranscriptionService."""

    # Events
    RESULT = "Transcription.Result"
    RESULT_REALTIME = "Transcription.Result.Realtime"
    RESULT_ACCURATE = "Transcription.Result.Accurate"
    RESULT_FINAL = "Transcription.Result.Final"
    ERROR = "Transcription.Error"

    # Commands
    CONTROL = "Transcription.Control"


TRANSCRIPTION_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=TranscriptionTopics.RESULT,
        service="TranscriptionService",
        message_type="Event",
        payload_class="TranscriptionResult",
        description="Transcription result (any type)",
    ),
    TopicDefinition(
        topic=TranscriptionTopics.RESULT_REALTIME,
        service="TranscriptionService",
        message_type="Event",
        payload_class="TranscriptionResult",
        description="Realtime transcription result (low latency)",
    ),
    TopicDefinition(
        topic=TranscriptionTopics.RESULT_ACCURATE,
        service="TranscriptionService",
        message_type="Event",
        payload_class="TranscriptionResult",
        description="Accurate transcription result (high accuracy)",
    ),
    TopicDefinition(
        topic=TranscriptionTopics.RESULT_FINAL,
        service="TranscriptionService",
        message_type="Event",
        payload_class="TranscriptionResult",
        description="Final transcription result",
    ),
    TopicDefinition(
        topic=TranscriptionTopics.ERROR,
        service="TranscriptionService",
        message_type="Event",
        payload_class="TranscriptionError",
        description="Transcription error",
    ),
    TopicDefinition(
        topic=TranscriptionTopics.CONTROL,
        service="TranscriptionService",
        message_type="Command",
        payload_class="TranscriptionControl",
        description="Control transcription (start/stop/pause/resume)",
    ),
]


# =============================================================================
# STT COORDINATOR SERVICE
# =============================================================================


class STTCoordinatorTopics:
    """Topics for STTCoordinatorService."""

    # Events
    SESSION_STARTED = "STT.Session.Started"
    SESSION_ENDED = "STT.Session.Ended"
    USER_SPEECH_CAPTURED = "STT.UserSpeechCaptured"

    # Commands
    CONTROL = "STT.Coordinator.Control"


STT_COORDINATOR_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=STTCoordinatorTopics.SESSION_STARTED,
        service="STTCoordinatorService",
        message_type="Event",
        payload_class="STTSessionStarted",
        description="STT session started (wake word detected)",
    ),
    TopicDefinition(
        topic=STTCoordinatorTopics.SESSION_ENDED,
        service="STTCoordinatorService",
        message_type="Event",
        payload_class="STTSessionEnded",
        description="STT session ended",
    ),
    TopicDefinition(
        topic=STTCoordinatorTopics.USER_SPEECH_CAPTURED,
        service="STTCoordinatorService",
        message_type="Event",
        payload_class="STTUserSpeechCaptured",
        description="User speech captured and transcribed",
    ),
    TopicDefinition(
        topic=STTCoordinatorTopics.CONTROL,
        service="STTCoordinatorService",
        message_type="Command",
        payload_class="STTCoordinatorControl",
        description="Control STT coordinator",
    ),
]


# =============================================================================
# TTS SERVICE
# =============================================================================


class TTSTopics:
    """Topics for TTSService."""

    # Commands
    REQUEST = "TTS.Request"
    STOP = "TTS.Stop"
    PAUSE = "TTS.Pause"
    RESUME = "TTS.Resume"
    CONTROL = "TTS.Control"

    # Events
    STARTED = "TTS.Started"
    STOPPED = "TTS.Stopped"
    PAUSED = "TTS.Paused"
    RESUMED = "TTS.Resumed"
    ERROR = "TTS.Error"


TTS_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=TTSTopics.REQUEST, service="TTSService", message_type="Command", payload_class="TTSRequest", description="Request TTS playback"
    ),
    TopicDefinition(topic=TTSTopics.STOP, service="TTSService", message_type="Command", payload_class="TTSStop", description="Stop TTS playback"),
    TopicDefinition(topic=TTSTopics.PAUSE, service="TTSService", message_type="Command", payload_class="TTSPause", description="Pause TTS playback"),
    TopicDefinition(
        topic=TTSTopics.RESUME, service="TTSService", message_type="Command", payload_class="TTSResume", description="Resume TTS playback"
    ),
    TopicDefinition(
        topic=TTSTopics.CONTROL, service="TTSService", message_type="Command", payload_class="Command", description="Control TTS (pause/resume/stop)"
    ),
    TopicDefinition(
        topic=TTSTopics.STARTED, service="TTSService", message_type="Event", payload_class="TTSStarted", description="TTS playback started"
    ),
    TopicDefinition(
        topic=TTSTopics.STOPPED, service="TTSService", message_type="Event", payload_class="TTSStopped", description="TTS playback stopped"
    ),
    TopicDefinition(topic=TTSTopics.PAUSED, service="TTSService", message_type="Event", payload_class="TTSPaused", description="TTS playback paused"),
    TopicDefinition(
        topic=TTSTopics.RESUMED, service="TTSService", message_type="Event", payload_class="TTSResumed", description="TTS playback resumed"
    ),
    TopicDefinition(topic=TTSTopics.ERROR, service="TTSService", message_type="Event", payload_class="TTSError", description="TTS error occurred"),
]


# =============================================================================
# ORCHESTRATOR SERVICE
# =============================================================================


class OrchestratorTopics:
    """Topics for OrchestratorService."""

    # Commands
    USER_INPUT = "Orchestrator.UserInput"
    EXTERNAL_USER_INPUT = "External.UserInput"  # From APIs/webhooks
    UI_USER_INPUT = "UI.UserInput"  # From UI
    TOOL_REQUEST = "Orchestrator.ToolRequest"

    # Events
    LLM_RESPONSE = "Orchestrator.LLMResponse"
    TOOL_RESULT = "Orchestrator.ToolResult"


ORCHESTRATOR_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=OrchestratorTopics.USER_INPUT,
        service="OrchestratorService",
        message_type="Command",
        payload_class="UserInput",
        description="User input for processing",
    ),
    TopicDefinition(
        topic=OrchestratorTopics.EXTERNAL_USER_INPUT,
        service="OrchestratorService",
        message_type="Command",
        payload_class="UserInput",
        description="User input from external source",
    ),
    TopicDefinition(
        topic=OrchestratorTopics.UI_USER_INPUT,
        service="OrchestratorService",
        message_type="Command",
        payload_class="UserInput",
        description="User input from UI",
    ),
    TopicDefinition(
        topic=OrchestratorTopics.LLM_RESPONSE,
        service="OrchestratorService",
        message_type="Event",
        payload_class="LLMResponseReady",
        description="LLM response ready",
    ),
    TopicDefinition(
        topic=OrchestratorTopics.TOOL_REQUEST,
        service="OrchestratorService",
        message_type="Command",
        payload_class="ToolRequest",
        description="Tool execution request",
    ),
    TopicDefinition(
        topic=OrchestratorTopics.TOOL_RESULT,
        service="OrchestratorService",
        message_type="Event",
        payload_class="ToolResult",
        description="Tool execution result",
    ),
    TopicDefinition(
        topic="Tool.Result",  # Legacy topic for backward compatibility
        service="OrchestratorService",
        message_type="Event",
        payload_class="ToolResult",
        description="Tool execution result (legacy)",
    ),
]


# =============================================================================
# DATABASE SERVICE
# =============================================================================


class DBTopics:
    """Topics for DBService."""

    # Commands
    STORE_MESSAGE = "DB.StoreMessage"
    STORE_CRON_JOB = "DB.StoreCronJob"
    DELETE_CRON_JOB = "DB.DeleteCronJob"

    # Queries
    GET_RECENT_MESSAGES = "DB.GetRecentMessages"
    GET_MESSAGES_FOR_DATE = "DB.GetMessagesForDate"
    GET_CRON_JOBS = "DB.GetCronJobs"

    # Responses
    MESSAGES_RESPONSE = "DB.MessagesResponse"


DB_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=DBTopics.STORE_MESSAGE,
        service="DBService",
        message_type="Command",
        payload_class="StoreMessage",
        description="Store message in history",
    ),
    TopicDefinition(
        topic=DBTopics.STORE_CRON_JOB, service="DBService", message_type="Command", payload_class="StoreCronJob", description="Store cron job"
    ),
    TopicDefinition(
        topic=DBTopics.DELETE_CRON_JOB, service="DBService", message_type="Command", payload_class="DeleteCronJob", description="Delete cron job"
    ),
    TopicDefinition(
        topic=DBTopics.GET_RECENT_MESSAGES,
        service="DBService",
        message_type="Query",
        payload_class="GetRecentMessages",
        description="Get recent messages",
    ),
    TopicDefinition(
        topic=DBTopics.GET_MESSAGES_FOR_DATE,
        service="DBService",
        message_type="Query",
        payload_class="GetMessagesForDate",
        description="Get messages for a specific date",
    ),
    TopicDefinition(
        topic=DBTopics.GET_CRON_JOBS, service="DBService", message_type="Query", payload_class="GetCronJobs", description="Get cron jobs"
    ),
    TopicDefinition(
        topic=DBTopics.MESSAGES_RESPONSE,
        service="DBService",
        message_type="Response",
        payload_class="MessagesResponse",
        description="Response with messages",
    ),
]


# =============================================================================
# SCHEDULER SERVICE
# =============================================================================


class SchedulerTopics:
    """Topics for SchedulerService."""

    # Commands
    SCHEDULE_JOB = "Scheduler.ScheduleJob"
    CANCEL_JOB = "Scheduler.CancelJob"
    PAUSE_JOB = "Scheduler.PauseJob"
    RESUME_JOB = "Scheduler.ResumeJob"

    # Events
    JOB_FIRED = "Scheduler.JobFired"
    JOB_COMPLETED = "Scheduler.JobCompleted"


SCHEDULER_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=SchedulerTopics.SCHEDULE_JOB,
        service="SchedulerService",
        message_type="Command",
        payload_class="ScheduleJob",
        description="Schedule a job",
    ),
    TopicDefinition(
        topic=SchedulerTopics.CANCEL_JOB,
        service="SchedulerService",
        message_type="Command",
        payload_class="CancelJob",
        description="Cancel a scheduled job",
    ),
    TopicDefinition(
        topic=SchedulerTopics.PAUSE_JOB,
        service="SchedulerService",
        message_type="Command",
        payload_class="PauseJob",
        description="Pause a scheduled job",
    ),
    TopicDefinition(
        topic=SchedulerTopics.RESUME_JOB,
        service="SchedulerService",
        message_type="Command",
        payload_class="ResumeJob",
        description="Resume a paused job",
    ),
    TopicDefinition(
        topic=SchedulerTopics.JOB_FIRED,
        service="SchedulerService",
        message_type="Event",
        payload_class="SchedulerJobFired",
        description="Scheduled job fired",
    ),
    TopicDefinition(
        topic=SchedulerTopics.JOB_COMPLETED,
        service="SchedulerService",
        message_type="Event",
        payload_class="SchedulerJobCompleted",
        description="Scheduled job completed",
    ),
]


# =============================================================================
# TOOLING SERVICE
# =============================================================================


class ToolingTopics:
    """Topics for ToolingService."""

    # Events
    TOOLS_INITIALIZED = "Tooling.Initialized"
    TOOLS_RELOADED = "Tooling.Reloaded"
    TOOLS_CHANGED = "Tooling.Changed"  # Tools added/removed/updated

    # Commands
    RELOAD_MCP_TOOLS = "Tooling.ReloadMCP"

    # Queries
    GET_TOOLS = "Tooling.GetTools"
    QUERY_TOOLS = "Tooling.QueryTools"  # Query with filters
    GET_TOOL_BY_NAME = "Tooling.GetToolByName"
    GET_STATS = "Tooling.GetStats"


TOOLING_TOPIC_DEFS: list[TopicDefinition] = [
    TopicDefinition(
        topic=ToolingTopics.TOOLS_INITIALIZED,
        service="ToolingService",
        message_type="Event",
        payload_class="ToolsInitialized",
        description="Tools initialized",
    ),
    TopicDefinition(
        topic=ToolingTopics.TOOLS_RELOADED,
        service="ToolingService",
        message_type="Event",
        payload_class="ToolsReloaded",
        description="Tools reloaded",
    ),
    TopicDefinition(
        topic=ToolingTopics.TOOLS_CHANGED,
        service="ToolingService",
        message_type="Event",
        payload_class="ToolsChanged",
        description="Tools added, removed, or updated",
    ),
    TopicDefinition(
        topic=ToolingTopics.GET_TOOLS,
        service="ToolingService",
        message_type="Query",
        payload_class="GetToolsQuery",
        description="Get available tools",
    ),
    TopicDefinition(
        topic=ToolingTopics.QUERY_TOOLS,
        service="ToolingService",
        message_type="Query",
        payload_class="QueryToolsQuery",
        description="Query tools with filters (enabled/disabled, by category, etc.)",
    ),
    TopicDefinition(
        topic=ToolingTopics.GET_TOOL_BY_NAME,
        service="ToolingService",
        message_type="Query",
        payload_class="GetToolByNameQuery",
        description="Get a specific tool by name",
    ),
    TopicDefinition(
        topic=ToolingTopics.GET_STATS,
        service="ToolingService",
        message_type="Query",
        payload_class="GetToolStatsQuery",
        description="Get tooling statistics",
    ),
    TopicDefinition(
        topic=ToolingTopics.RELOAD_MCP_TOOLS,
        service="ToolingService",
        message_type="Command",
        payload_class="ReloadMCPToolsCommand",
        description="Reload MCP tools",
    ),
]


# =============================================================================
# REGISTRY INITIALIZATION
# =============================================================================


def register_all_service_topics() -> None:
    """Register all service topics in the global registry."""
    from app.messaging.event_registry import get_event_registry

    registry = get_event_registry()

    # Register all services
    registry.register_service_topics("AudioInputService", AUDIO_INPUT_TOPIC_DEFS)
    registry.register_service_topics("WakeWordService", WAKEWORD_TOPIC_DEFS)
    registry.register_service_topics("TranscriptionService", TRANSCRIPTION_TOPIC_DEFS)
    registry.register_service_topics("STTCoordinatorService", STT_COORDINATOR_TOPIC_DEFS)
    registry.register_service_topics("TTSService", TTS_TOPIC_DEFS)
    registry.register_service_topics("OrchestratorService", ORCHESTRATOR_TOPIC_DEFS)
    registry.register_service_topics("DBService", DB_TOPIC_DEFS)
    registry.register_service_topics("SchedulerService", SCHEDULER_TOPIC_DEFS)
    registry.register_service_topics("ToolingService", TOOLING_TOPIC_DEFS)

    from app.helpers.aurora_logger import log_info

    log_info(f"✅ Registered {len(registry.get_all_topics())} topics for {len(registry.get_all_services())} services")


# Export all topic classes
__all__ = [
    "AudioInputTopics",
    "WakeWordTopics",
    "TranscriptionTopics",
    "STTCoordinatorTopics",
    "TTSTopics",
    "OrchestratorTopics",
    "DBTopics",
    "SchedulerTopics",
    "ToolingTopics",
    "register_all_service_topics",
]
