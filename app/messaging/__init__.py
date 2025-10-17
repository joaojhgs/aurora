"""Message Bus infrastructure for Aurora's parallel/microservices architecture."""

from .audio_messages import (
    AudioChunk,
    AudioEncoding,
    AudioFormat,
    AudioStreamControl,
    AudioStreamStarted,
    AudioStreamState,
    AudioStreamStopped,
    AudioTopics,
)
from .bus import Command, Envelope, Event, Handler, MessageBus, Query, QueryResult
from .bus_runtime import get_bus, set_bus
from .event_registry import EventRegistry, TopicDefinition, get_event_registry, set_event_registry
from .service_topics import (
    AudioInputTopics,
    DBTopics,
    OrchestratorTopics,
    SchedulerTopics,
    STTCoordinatorTopics,
    ToolingTopics,
    TranscriptionTopics,
    TTSTopics,
    WakeWordTopics,
    register_all_service_topics,
)
from .transcription_messages import (
    TranscriptionControl,
    TranscriptionError,
    TranscriptionResult,
    TranscriptionType,
)

__all__ = [
    "MessageBus",
    "Envelope",
    "Event",
    "Command",
    "Query",
    "QueryResult",
    "Handler",
    "get_bus",
    "set_bus",
    # Event Registry
    "EventRegistry",
    "TopicDefinition",
    "get_event_registry",
    "set_event_registry",
    # Service Topics
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
    # Audio streaming
    "AudioChunk",
    "AudioFormat",
    "AudioEncoding",
    "AudioStreamControl",
    "AudioStreamState",
    "AudioStreamStarted",
    "AudioStreamStopped",
    "AudioTopics",
    # Transcription
    "TranscriptionType",
    "TranscriptionResult",
    "TranscriptionControl",
    "TranscriptionError",
    "TranscriptionTopics",
]
