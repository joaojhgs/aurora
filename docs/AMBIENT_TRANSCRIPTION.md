# Ambient Transcription Feature

**Status:** Partial feature — the Android native notification/ambient capture path is connected in source; packaged Android runtime validation is unavailable on this host. Continuous iOS capture is unsupported.

## Overview

Aurora stores transcript sessions separately from assistant conversations. The lightweight local-data API provides encrypted transcript segments, bounded reads, export/import, deletion, and retention cleanup. On Android, saved node settings flow through the typed SDK and Tauri policy owner to the existing foreground notification service. That service runs finite STT-only capture intervals and writes encrypted transcript text to the local archive; it does not create assistant conversations or store raw audio.

The legacy Python ambient setting below controls a separate Python capture path. It does not use the Android node setting or write to the lightweight transcript archive.

## Current Status

The Android node-policy and Python `config.json` settings are separate configuration boundaries. A saved preference is not microphone permission and does not mean capture is running. The Android service reports capability, permission, foreground state, speech-asset availability, archive availability, and capture state separately. Packaged Android runtime behavior has not been validated on this host; continuous background capture on iOS is unsupported.

## Lightweight archive and saved preferences

The local-data SQLite schema is version 4. Migration `0004_transcript_archive.sql` adds sessions and segments without changing earlier migrations or assistant history. Browser document upgrades retain existing records and add empty transcript collections.

`session.transcripts` is the typed repository boundary. It supports create/start, immutable segment replay, finalization, interruption recovery, paged reads, deletion, and bounded expiry cleanup. Session reads default to 100 entries and allow at most 500; segment reads default to 500 and allow at most 2,000. Segments are ordered by sequence. A repeated identical segment remains safe after finalization; a new segment cannot be appended to a finished session.

Transcript text uses the existing encrypted-envelope boundary. Its AAD identifies `aurora_transcript_segments`, `text_envelope_json`, the segment ID, profile, and local node. Raw audio is not part of the archive. Confidence, speaker identity, language, and model provenance remain unknown when the capture owner does not supply them.

New V1 exports include transcript collections, counts, and hashes. Older V1 exports without those fields remain readable as empty transcript collections; existing collection hashes are still checked. Content search requires explicit decryption authorization. Clearing the local-data database also removes transcripts; deleting a transcript session removes its segments.

The canonical node-policy V2 document adds this saved preference:

```json
{
  "backgroundTranscription": {
    "version": 1,
    "enabled": false,
    "ambient": false,
    "notification": false,
    "retentionDays": 30
  }
}
```

This is a subtree of the node-policy document, not a complete document to import. Older documents receive these disabled defaults. `ambient` requests continuous recording; `notification` requests manual notification recording. `retentionDays` is bounded from 1 to 3,650, and optional `language` is a string or null. Changes use the existing profile-selected Rust owner and revision checks.

A saved preference does not grant microphone permission or indicate that recording is running. Current capability, permission, available speech assets, writable storage, and capture state are separate facts. On Android, the existing foreground notification offers manual recording when enabled, while an eligible ambient preference can request native background capture subject to platform permission and capability. Capture uses finite STT-only intervals and archives encrypted text; it does not store raw audio. Packaged Android runtime validation is unavailable on this host, and continuous iOS capture is unsupported.

Recovery runs only under a confirmed storage owner. OPFS uses its exclusive browser lock; IndexedDB does not interrupt sessions under an uncertain lease-only owner. Native recovery occurs once per process and scope so another reader opening the same database does not interrupt an existing recording.

## Configuration

Ambient transcription defaults off. The following `config.json` example explicitly enables the Python setting; it does not enable transcript storage or background capture on other platforms:

```json
{
  "services": {
    "stt": {
      "coordinator": {
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
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enable` | boolean | `false` | Enable continuous transcription |
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
│     (no coordinator pause at session end)      │
└─────────────────────────────────────────────────┘
```

### Key Behavior

1. **Continuous Operation**: At an interactive session's end, the coordinator keeps transcription running when ambient mode is enabled
2. **Buffer Clearing**: On wake word detection, audio buffers are cleared to prevent stale audio from being processed
3. **Session Isolation**: Interactive STT sessions don't interfere with ambient transcription

## Implementation Details

### STT Coordinator Changes

The STT Coordinator service (`app/services/stt_coordinator/service.py`) checks if ambient transcription is enabled:

It reads `services.stt.coordinator` through the typed Config API and resolves a missing ambient setting to `false`. At session end, it publishes a pause request using `TranscriptionMethods.CONTROL` only when ambient mode is disabled.

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

When ambient mode is enabled, nearby speech may be captured and transcribed. This setting does not create an ambient archive or configure audio-file retention:

- **Home use**: May transcribe private conversations
- **Office use**: May transcribe confidential information
- **Legal**: Check local recording consent laws

### Recommendations

1. **Inform others**: Let people know the microphone is active
2. **Disable when not needed**: Toggle off in config when not required

The `storage_path` setting is reserved for a future logging service. It does not currently create files to encrypt or clean up.

## See Also

- [Message Bus Architecture](MESSAGING_ARCHITECTURE.md)
- [STT Coordinator Service](../app/services/stt_coordinator/service.py)
- [Transcription Service](../app/services/stt_transcription/service.py)
