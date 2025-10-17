# Ambient Transcription Feature

## Overview

Ambient transcription allows Aurora to continuously transcribe audio in the background, creating a log of all spoken conversations in the environment. This is useful for creating daily summaries, searchable transcripts, or meeting notes.

## Current Status

**⚠️ Note**: As of October 2025, the ambient transcription **logging service** is not yet implemented in the new message bus architecture. The transcription service runs continuously when enabled, but transcriptions are not saved to files.

The configuration exists in `config.json`, but requires implementation of an `AmbientTranscriptionLogger` service.

## Configuration

Enable ambient transcription in `config.json`:

```json
{
  "general": {
    "speech_to_text": {
      "ambient_transcription": {
        "enable": true,
        "chunk_duration": 3.0,
        "storage_path": "ambient_logs/",
        "filter_short_transcriptions": true,
        "min_transcription_length": 10
      }
    }
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enable` | boolean | `true` | Enable continuous transcription |
| `chunk_duration` | float | `3.0` | Transcribe audio every N seconds |
| `storage_path` | string | `"ambient_logs/"` | Directory for log files |
| `filter_short_transcriptions` | boolean | `true` | Skip short transcriptions |
| `min_transcription_length` | integer | `10` | Minimum characters to log |

## How It Works

### With Wake Word Enabled

```
┌─────────────────────────────────────────────────┐
│ Ambient Mode (Continuous)                      │
│  ├─ Microphone active                          │
│  ├─ Wake word detection active                 │
│  ├─ Transcription service RUNNING              │
│  └─ Transcribing ambient audio every 3s        │
└─────────────────────────────────────────────────┘
              ↓ (wake word detected)
┌─────────────────────────────────────────────────┐
│ Interactive Mode (STT Session)                 │
│  ├─ STT session started                        │
│  ├─ Transcription buffers CLEARED              │
│  ├─ User speech captured                       │
│  ├─ Orchestrator processes input               │
│  └─ TTS responds                                │
└─────────────────────────────────────────────────┘
              ↓ (session ends)
┌─────────────────────────────────────────────────┐
│ Back to Ambient Mode                           │
│  └─ Transcription service STILL RUNNING        │
│     (never paused when ambient mode enabled)   │
└─────────────────────────────────────────────────┘
```

### Key Behavior

1. **Continuous Operation**: When ambient transcription is enabled, the transcription service never pauses
2. **Buffer Clearing**: On wake word detection, audio buffers are cleared to prevent stale audio from being processed
3. **Session Isolation**: Interactive STT sessions don't interfere with ambient transcription

## Implementation Details

### STT Coordinator Changes

The STT Coordinator service (`app/stt_coordinator/service.py`) checks if ambient transcription is enabled:

```python
# Load configuration
self._ambient_enabled = config_manager.get(
    "general.speech_to_text.ambient_transcription.enable",
    False
)

# At session end, only pause transcription if ambient mode is disabled
if not self._ambient_enabled:
    await self.bus.publish(
        TranscriptionTopics.CONTROL,
        TranscriptionControl(action="pause"),
        event=False
    )
```

### Transcription Service Buffer Management

When resuming transcription (after wake word), buffers are cleared:

```python
elif action == "resume":
    self._paused = False
    # Clear audio buffers to avoid processing stale audio
    with self._buffer_lock:
        self._audio_buffer.clear()
        self._speech_segments.clear()
    self._in_speech = False
    self._silence_chunks = 0
```

## Privacy Considerations

### ⚠️ Important

Ambient transcription records **all audio** in the environment:

- **Home use**: May record private conversations
- **Office use**: May record confidential information
- **Legal**: Check local recording consent laws

### Recommendations

1. **Inform others**: Let people know recording is active
2. **Secure storage**: Encrypt the `ambient_logs/` directory
3. **Regular cleanup**: Delete old logs to minimize data retention
4. **Disable when not needed**: Toggle off in config when not required

## See Also

- [Message Bus Architecture](MESSAGING_ARCHITECTURE.md)
- [STT Coordinator Service](../app/stt_coordinator/service.py)
- [Transcription Service](../app/stt_transcription/service.py)
