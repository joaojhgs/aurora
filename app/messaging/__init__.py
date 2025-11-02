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
from .priority_helpers import (
    get_external_priority,
    get_interactive_priority,
    get_priority,
    get_system_priority,
)
from .service_topics import (
    AUDIO_PROTOCOL_TOPIC_DEFS,
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
    # Priority helpers
    "get_priority",
    "get_interactive_priority",
    "get_system_priority",
    "get_external_priority",
    # Event Registry
    "EventRegistry",
    "TopicDefinition",
    "get_event_registry",
    "set_event_registry",
    # Audio Protocol (Generic) - Used by any service handling audio
    "AudioTopics",
    "AudioChunk",
    "AudioFormat",
    "AudioEncoding",
    "AudioStreamControl",
    "AudioStreamState",
    "AudioStreamStarted",
    "AudioStreamStopped",
    "AUDIO_PROTOCOL_TOPIC_DEFS",
    # Service Topics (Implementation-Specific)
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
    # Transcription
    "TranscriptionType",
    "TranscriptionResult",
    "TranscriptionControl",
    "TranscriptionError",
    "TranscriptionTopics",
]
