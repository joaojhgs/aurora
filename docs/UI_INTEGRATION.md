# Aurora UI Integration Guide

## Overview

Aurora provides an optional PyQt6-based graphical user interface that integrates with the message bus architecture. The UI runs in the main thread while Aurora services run in background threads, communicating via thread-safe Qt signals.

## Enabling the UI

Configure in `config.json`:

```json
{
  "ui": {
    "activate": true,
    "dark_mode": true,
    "debug": false
  }
}
```

## Architecture

### Threading Model

```
┌─────────────────────────────────────────────┐
│ Main Thread (Qt Event Loop)                │
│  ├─ QApplication                            │
│  ├─ AuroraUI (Window)                       │
│  └─ UIBridge receives Qt signals           │
└─────────────────────────────────────────────┘
                      ↕ (thread-safe signals)
┌─────────────────────────────────────────────┐
│ Background Thread (asyncio event loop)     │
│  ├─ Supervisor                              │
│  ├─ All Services (STT, TTS, Orchestrator)  │
│  ├─ LocalBus (message bus)                 │
│  └─ UIBridge publishes to bus              │
└─────────────────────────────────────────────┘
```

### UIBridge Service

The `UIBridge` service (`app/ui/bridge_service.py`) acts as a bidirectional adapter:

**Message Bus → UI**:
- Subscribes to events (transcriptions, LLM responses, TTS status)
- Emits Qt signals to update UI (thread-safe)

**UI → Message Bus**:
- Receives user input from UI
- Publishes commands to message bus

## Message Flow

### User Speech (Voice Input)

```
1. User says "Jarvis, hello"
2. Wake word detected → STT session starts
3. Speech transcribed → USER_SPEECH_CAPTURED event
4. UIBridge receives event:
   - Emits signals.status_changed.emit("processing")
   - Emits signals.message_received.emit(text, is_user=True, source="STT")
5. UI updates:
   - Status indicator changes to "processing"
   - User message appears in chat
6. Orchestrator processes → LLM_RESPONSE event
7. UIBridge receives event:
   - Emits signals.status_changed.emit("idle")
   - Emits signals.message_received.emit(text, is_user=False, source=None)
8. UI updates:
   - Status changes to "idle"
   - Assistant message appears in chat
9. TTS starts → STARTED event
10. UIBridge receives event:
    - Emits signals.status_changed.emit("speaking")
11. TTS completes → STOPPED event
12. UIBridge receives event:
    - Emits signals.status_changed.emit("idle")
```

### Text Input (UI Input)

```
1. User types message in UI
2. UI emits user_message_signal
3. UIBridge callback receives signal
4. UIBridge publishes UI.UserInput command to bus
5. Orchestrator receives and processes
6. Flow continues same as voice input (steps 6-12)
```

## Status Indicator States

The UI status indicator shows the current system state:

| Status | Color | Meaning |
|--------|-------|---------|
| **idle** | Gray | Waiting for input |
| **listening** | Blue | Recording user speech |
| **processing** | Yellow | Analyzing input with LLM |
| **speaking** | Green | Playing TTS response |

### State Transitions

```
idle → listening (wake word detected)
listening → processing (speech captured)
processing → idle (LLM responds, no TTS)
processing → speaking (TTS starts)
speaking → idle (TTS completes)
```

## UI Bridge Subscriptions

The UIBridge subscribes to the following message bus topics:

```python
# STT Events
STTCoordinatorTopics.SESSION_STARTED     → status: "listening"
STTCoordinatorTopics.USER_SPEECH_CAPTURED → status: "processing", add user message

# Orchestrator Events  
OrchestratorTopics.LLM_RESPONSE          → status: "idle", add assistant message

# TTS Events
TTSTopics.STARTED                         → status: "speaking"
TTSTopics.STOPPED                         → status: "idle"

# Database Responses
DBTopics.MESSAGES_RESPONSE                → load historical messages
```

## UI Controls

### Stop Speaking Button

Immediately stops TTS playback:

```python
# User clicks stop button
→ UI calls _stop_tts_callback()
→ UIBridge publishes TTSTopics.STOP command
→ TTS service receives and stops playback
→ TTS emits STOPPED event
→ UIBridge updates status to "idle"
```

### Message History

On startup, the UI loads today's messages from the database:

```python
# UIBridge.start()
→ Publishes DBTopics.GET_MESSAGES_FOR_DATE query
→ DBService responds with MessagesResponse
→ UIBridge emits signals.message_received for each message
→ UI populates chat history
```

## Thread Safety

### Qt Signals (Thread-Safe)

All UI updates use Qt's built-in signal/slot mechanism, which is thread-safe:

```python
# In UIBridge (runs in background thread)
async def _on_transcription(self, env: Envelope):
    # This is thread-safe!
    self.ui_window.signals.message_received.emit(text, True, "STT")
    self.ui_window.signals.status_changed.emit("processing")
```

### asyncio.run_coroutine_threadsafe()

For UI → Bus communication, use this to bridge threads:

```python
# In UI thread
def _on_stop_tts_request(self):
    asyncio.run_coroutine_threadsafe(
        self.bus.publish(TTSTopics.STOP, TTSStop()),
        self._loop  # Background thread's event loop
    )
```

## Concurrent Message Delivery

As of October 2025, the message bus delivers events **concurrently** to all subscribers:

### Before (Sequential)

```
03:00:00 - Transcription published
03:00:00 - Orchestrator receives (8 seconds processing)
03:00:08 - Orchestrator completes
03:00:08 - UIBridge receives (8 seconds late!)
```

**Problem**: User message appeared 8 seconds after speaking.

### After (Concurrent)

```
03:00:00 - Transcription published
03:00:00 - Orchestrator receives (8 seconds processing) ← Running
03:00:00 - UIBridge receives (immediate!)               ← Running
```

**Solution**: Both handlers run in parallel. UI updates immediately.

## Common Issues

### UI Not Updating

**Symptoms**: Status stays "idle", messages don't appear

**Causes**:
1. UIBridge not started
2. Qt signals not connected
3. Service not publishing events with typed topics
4. Handler exceptions (check logs)

**Debug**:
```python
# Check if signals are connected
print(f"Signals connected: {hasattr(self.ui_window, 'signals')}")

# Enable UI debug mode in config
"ui": { "debug": true }
```

### Messages Appear Late

**Fixed**: As of October 2025, concurrent delivery ensures immediate updates.

**If still occurring**:
1. Check if handler is blocking (should be async)
2. Verify event loop is running
3. Check system resources (CPU/memory)

### Stop Button Not Working

**Symptoms**: Button click doesn't stop TTS

**Causes**:
1. `TTSStop` not exported from `app/tts/__init__.py`
2. Callback not registered
3. TTS service not subscribed to STOP topic

**Fix**:
```python
# Verify exports
from app.tts import TTSStop, TTSPause, TTSResume

# Verify callback
self.ui_window._stop_tts_callback = self._on_stop_tts_request
```

## Development Tips

### Testing UI Integration

```python
# Run with UI enabled
python main.py

# Watch logs in real-time
tail -f ui_concurrent_test.log
```

### Adding New UI Features

1. **Add signal** to `AuroraSignals` class:
   ```python
   class AuroraSignals(QObject):
       new_feature = pyqtSignal(str)
   ```

2. **Emit from UIBridge**:
   ```python
   async def _on_new_event(self, env: Envelope):
       self.ui_window.signals.new_feature.emit(data)
   ```

3. **Connect in UI**:
   ```python
   self.signals.new_feature.connect(self.handle_new_feature)
   ```

### Message Source Types

Messages are tagged with their source:

- `"STT"` - Voice input (blue badge)
- `"UI"` - Text input (green badge)
- `None` - Assistant response (no badge)

## Best Practices

1. **Always use Qt signals** for UI updates from background threads
2. **Keep handlers async** to avoid blocking the event loop
3. **Use typed topics** from `service_topics.py` for consistency
4. **Handle errors gracefully** in signal callbacks
5. **Log UI state changes** when debug mode enabled
6. **Test with concurrent events** to ensure thread safety

## See Also

- [Message Bus Architecture](MESSAGING_ARCHITECTURE.md)
- [Service Topics Reference](../app/messaging/service_topics.py)
- [UI Bridge Implementation](../app/ui/bridge_service.py)
- [Aurora UI Implementation](../modules/ui/aurora_ui.py)
