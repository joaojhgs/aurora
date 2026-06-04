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
from .priority_helpers import (
    get_external_priority,
    get_interactive_priority,
    get_priority,
    get_system_priority,
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
    # Audio Protocol (Generic) - Used by any service handling audio
    "AudioTopics",
    "AudioChunk",
    "AudioFormat",
    "AudioEncoding",
    "AudioStreamControl",
    "AudioStreamState",
    "AudioStreamStarted",
    "AudioStreamStopped",
    # Service Topics (Implementation-Specific)
    "register_all_service_topics",
    # Transcription
    "TranscriptionType",
    "TranscriptionResult",
    "TranscriptionControl",
    "TranscriptionError",
]


def register_all_service_topics() -> None:
    """Register all service topics in the global registry.

    NOTE: This function is now a no-op stub for backward compatibility.
    With the new contract-based registry, topics are registered automatically
    when services use the @method_contract decorator.

    This stub prevents breaking existing code that calls this function.
    """
    # No-op
    pass
