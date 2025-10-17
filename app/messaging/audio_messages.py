"""Audio streaming message types for Aurora's message bus.

This module defines message types for streaming audio data between services:
- AudioFormat: Describes audio stream format
- AudioChunk: Contains raw audio data chunk
- AudioStreamControl: Control messages for audio streams
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field

from .bus import Command, Event


class AudioEncoding(str, Enum):
    """Audio encoding formats supported by Aurora."""

    PCM_S16LE = "pcm_s16le"  # 16-bit signed little-endian PCM (most common)
    PCM_S24LE = "pcm_s24le"  # 24-bit signed little-endian PCM
    PCM_S32LE = "pcm_s32le"  # 32-bit signed little-endian PCM
    PCM_F32LE = "pcm_f32le"  # 32-bit float little-endian PCM
    OPUS = "opus"  # Opus compressed audio
    MP3 = "mp3"  # MP3 compressed audio
    FLAC = "flac"  # FLAC lossless compression


class AudioFormat(BaseModel):
    """Describes the format of an audio stream.

    This should be sent before starting an audio stream to inform
    consumers about how to decode the audio data.
    """

    sample_rate: int = Field(description="Sample rate in Hz (e.g., 16000, 44100, 48000)")
    channels: int = Field(default=1, description="Number of audio channels (1=mono, 2=stereo)")
    encoding: AudioEncoding = Field(default=AudioEncoding.PCM_S16LE, description="Audio encoding format")
    bits_per_sample: int = Field(default=16, description="Bits per sample for PCM formats")
    chunk_duration_ms: float = Field(default=100.0, description="Expected duration of each audio chunk in milliseconds")

    @property
    def bytes_per_sample(self) -> int:
        """Calculate bytes per sample based on bits_per_sample."""
        return self.bits_per_sample // 8

    @property
    def bytes_per_frame(self) -> int:
        """Calculate bytes per frame (all channels)."""
        return self.bytes_per_sample * self.channels

    @property
    def expected_chunk_size_bytes(self) -> int:
        """Calculate expected chunk size in bytes."""
        frames = int((self.sample_rate * self.chunk_duration_ms) / 1000)
        return frames * self.bytes_per_frame


class AudioChunk(Event):
    """Event containing a chunk of audio data.

    This is the primary message type for streaming audio through the message bus.
    Audio is sent in small chunks (typically 100ms) to enable low-latency processing.
    """

    data: bytes = Field(description="Raw audio data in the format specified by AudioFormat")
    source: str = Field(description="Audio source identifier (e.g., 'microphone', 'websocket', 'file')")
    stream_id: str = Field(description="Unique identifier for this audio stream")
    sequence: int = Field(description="Sequence number within the stream (starting from 0)")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Timestamp when this chunk was captured/generated")
    format: AudioFormat | None = Field(default=None, description="Audio format (typically only sent with first chunk)")

    @property
    def duration_ms(self) -> float:
        """Calculate duration of this chunk in milliseconds (if format available)."""
        if not self.format:
            return 0.0

        frames = len(self.data) // self.format.bytes_per_frame
        return (frames / self.format.sample_rate) * 1000


class AudioStreamState(str, Enum):
    """States for audio stream control."""

    START = "start"  # Stream is starting
    PAUSE = "pause"  # Stream is paused
    RESUME = "resume"  # Stream is resuming
    STOP = "stop"  # Stream is stopping
    ERROR = "error"  # Stream encountered an error


class AudioStreamControl(Command):
    """Command to control an audio stream.

    Used to start, pause, resume, or stop audio streams.
    """

    stream_id: str = Field(description="Unique identifier for the audio stream to control")
    state: AudioStreamState = Field(description="Desired state for the audio stream")
    source: str = Field(description="Audio source identifier")
    error_message: str | None = Field(default=None, description="Error message if state is ERROR")


class AudioStreamStarted(Event):
    """Event emitted when an audio stream starts.

    This is the first message in an audio stream and includes format information.
    """

    stream_id: str = Field(description="Unique identifier for this audio stream")
    source: str = Field(description="Audio source identifier")
    format: AudioFormat = Field(description="Format of the audio stream")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Timestamp when the stream started")


class AudioStreamStopped(Event):
    """Event emitted when an audio stream stops.

    This is the last message in an audio stream.
    """

    stream_id: str = Field(description="Unique identifier for the audio stream that stopped")
    source: str = Field(description="Audio source identifier")
    total_chunks: int = Field(description="Total number of chunks sent in this stream")
    total_duration_ms: float = Field(description="Total duration of the audio stream in milliseconds")
    timestamp: datetime = Field(default_factory=datetime.utcnow, description="Timestamp when the stream stopped")
    reason: str | None = Field(default=None, description="Reason for stopping (e.g., 'user_request', 'error', 'timeout')")


# Topic naming conventions for audio streams
class AudioTopics:
    """Standard topic names for audio streaming."""

    # Audio stream data
    STREAM_MICROPHONE = "Audio.Stream.Microphone"
    STREAM_WEBSOCKET = "Audio.Stream.WebSocket"
    STREAM_FILE = "Audio.Stream.File"
    STREAM_GENERIC = "Audio.Stream.Generic"

    # Audio stream control
    CONTROL = "Audio.Control"

    # Audio stream lifecycle events
    STARTED = "Audio.Started"
    STOPPED = "Audio.Stopped"

    @staticmethod
    def stream_for_source(source: str) -> str:
        """Get the appropriate stream topic for a given source.

        Args:
            source: Audio source identifier (e.g., "microphone", "websocket")

        Returns:
            Topic name for the audio stream
        """
        source_lower = source.lower()
        if source_lower == "microphone":
            return AudioTopics.STREAM_MICROPHONE
        elif source_lower == "websocket":
            return AudioTopics.STREAM_WEBSOCKET
        elif source_lower == "file":
            return AudioTopics.STREAM_FILE
        else:
            return AudioTopics.STREAM_GENERIC
