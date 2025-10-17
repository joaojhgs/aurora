# Aurora Messaging Architecture Guide

## Overview

Aurora now supports a **parallel/microservices architecture** using a message bus abstraction. This allows services to run as:
- **Threads** (default): In-process communication via `LocalBus`
- **Processes**: Distributed communication via `BullMQBus` with Redis

## Architecture Mode Selection

Configure the architecture mode in `config.json`:

```json
{
  "general": {
    "architecture": {
      "mode": "threads"  // or "processes"
    }
  }
}
```

### Threads Mode (Default)

- **Best for**: Development, testing, single-machine deployments
- **Requirements**: None (built-in)
- **Performance**: Low latency, shared memory
- **Scaling**: Vertical only (CPU cores)

### Processes Mode

- **Best for**: Production, distributed deployments, horizontal scaling
- **Requirements**: Redis server running
- **Performance**: Higher latency due to network, but horizontally scalable
- **Scaling**: Horizontal (multiple machines)

## Running Redis (for Processes Mode)

### Using Docker Compose

```bash
docker-compose up -d redis
```

### Manual Installation

```bash
# Ubuntu/Debian
sudo apt install redis-server
sudo systemctl start redis

# macOS
brew install redis
brew services start redis

# Docker
docker run -d -p 6379:6379 redis:7-alpine
```

### Redis Configuration

In `config.json`:

```json
{
  "messaging": {
    "redis": {
      "url": "redis://localhost:6379"
    }
  }
}
```

## Message Priority Mapping

Aurora uses a priority system where **lower numbers = higher priority**:

| Priority Class | Value | Use Cases |
|---------------|-------|-----------|
| **Interactive** | 10 | User interactions (STT, UI input) |
| **System** | 50 | Background tasks, scheduled jobs |
| **External** | 80 | External API requests, webhooks |

Configure in `config.json`:

```json
{
  "messaging": {
    "priorities": {
      "interactive": 10,
      "system": 50,
      "external": 80
    }
  }
}
```

### Priority Behavior

- **Interactive messages** (priority 10) preempt system and external messages
- **External messages** (priority 80) have lowest priority
- Commands are **reliable** with automatic retry and dead-letter handling
- Events are **best-effort** broadcast

## Message Types

### Commands
Point-to-point messages with guaranteed delivery:
- Automatic retry with exponential backoff
- Dead-letter queue for failed messages
- Priority-based processing

### Events
Broadcast messages for pub/sub patterns:
- Best-effort delivery
- Multiple subscribers supported
- Wildcard topic matching

### Queries
Request/response pattern:
- Synchronous-style API over async messaging
- Timeout support
- Correlation IDs for tracking

## Service Architecture

### Available Services

1. **STTService**: Speech-to-text processing
2. **TTSService**: Text-to-speech synthesis
3. **OrchestratorService**: LangGraph agent coordination
4. **DBService**: Database persistence
5. **SchedulerService**: Scheduled tasks and cron jobs

### Service Communication

Services communicate exclusively via the message bus:

```python
from app.messaging.bus_runtime import get_bus

# Get the global bus instance
bus = get_bus()

# Publish an event
await bus.publish(
    "TTS.Request",
    TTSRequest(text="Hello", interrupt=True),
    event=False,  # Command, not event
    priority=10,  # Interactive priority
    origin="internal"
)

# Subscribe to events
def my_handler(env: Envelope):
    message = env.payload
    # Process message
    
bus.subscribe("STT.TranscriptionDetected", my_handler)
```

## Running Aurora with Message Bus

### Using the Supervisor

```python
from app.services.supervisor import run_supervisor
import asyncio

asyncio.run(run_supervisor())
```

Or from command line:

```bash
python -m app.services.supervisor
```

### Integration with Existing Main

The supervisor can be integrated into `main.py` to gradually migrate:

```python
from app.services.supervisor import Supervisor
from app.messaging.bus_runtime import get_bus

async def main():
    # Initialize supervisor
    supervisor = Supervisor()
    await supervisor.initialize()
    await supervisor.start_services()
    
    # Get bus for other components
    bus = get_bus()
    
    # Start existing UI or other components
    # ...
    
    # Run until shutdown
    await supervisor.run()
    await supervisor.shutdown()
```

## Message Topics

### STT Service
- `STT.Control` - Control commands (start, stop, pause)
- `STT.StartListening` - Start audio capture
- `STT.StopListening` - Stop audio capture
- `STT.TranscriptionDetected` - Transcription result event
- `STT.WakeWordDetected` - Wake word detected event

### TTS Service
- `TTS.Request` - Play text-to-speech
- `TTS.Stop` - Stop playback
- `TTS.Pause` - Pause playback
- `TTS.Resume` - Resume playback
- `TTS.Started` - Playback started event
- `TTS.Stopped` - Playback stopped event
- `TTS.Error` - TTS error event

### Orchestrator Service
- `UI.UserInput` - User input from UI
- `External.UserInput` - User input from external APIs
- `LLM.ResponseReady` - LLM response available
- `Tool.Request` - Tool execution request
- `Tool.Result` - Tool execution result

### DB Service
- `DB.StoreMessage` - Store message in history
- `DB.GetRecentMessages` - Query recent messages
- `DB.StoreCronJob` - Store cron job
- `DB.GetCronJobs` - Query cron jobs
- `DB.DeleteCronJob` - Delete cron job

### Scheduler Service
- `Sched.Schedule` - Schedule a job
- `Sched.Cancel` - Cancel a job
- `Sched.Pause` - Pause a job
- `Sched.Resume` - Resume a job
- `Sched.JobFired` - Job execution started
- `Sched.JobCompleted` - Job execution completed

## Development Workflow

### Adding a New Service

1. Create service file in `app/services/`:

```python
from app.messaging.bus import MessageBus, Command, Event

class MyService:
    def __init__(self, bus: MessageBus):
        self.bus = bus
    
    async def start(self):
        self.bus.subscribe("My.Command", self._handler)
    
    async def stop(self):
        # Cleanup
        pass
    
    async def _handler(self, env: Envelope):
        # Process message
        pass
```

2. Register in Supervisor (`app/services/supervisor.py`):

```python
from app.services.my_service import MyService

services = [
    # ... existing services
    MyService(self.bus),
]
```

### Testing Messages

Use the unit tests as examples:

```python
import pytest
from app.messaging.local_bus import LocalBus

@pytest.mark.asyncio
async def test_my_message():
    bus = LocalBus()
    await bus.start()
    
    received = []
    bus.subscribe("test.topic", lambda env: received.append(env))
    
    await bus.publish("test.topic", MyMessage(data="test"))
    await asyncio.sleep(0.1)
    
    assert len(received) == 1
    await bus.stop()
```

## Monitoring and Observability

### Structured Logging

All messages include structured metadata:
- `type`: Message type
- `id`: Unique message ID
- `attempts`: Retry attempts
- `origin`: Message origin (internal/external/system)
- `priority`: Message priority
- `timestamp`: Message timestamp

### Metrics

LocalBus provides statistics:

```python
stats = bus.get_stats()
# Returns: {
#   "published": 100,
#   "delivered": 95,
#   "retries": 3,
#   "dead_letters": 2
# }
```

### Dead-Letter Queue

Failed messages after max retries are sent to dead-letter queue for inspection.

## Migration Guide

### From Direct Calls to Bus Messages

**Before:**
```python
from app.text_to_speech.tts import TTS

tts = TTS()
tts.play("Hello world")
```

**After:**
```python
from app.messaging.bus_runtime import get_bus
from app.services.tts_service import TTSRequest

bus = get_bus()
await bus.publish(
    "TTS.Request",
    TTSRequest(text="Hello world", interrupt=True),
    event=False,
    priority=10,
    origin="internal"
)
```

### Gradual Migration

1. Start with threads mode (no infrastructure changes needed)
2. Migrate one service at a time to use the bus
3. Keep compatibility shims during migration
4. Test thoroughly at each step
5. Switch to processes mode when ready for scaling

## Troubleshooting

### ImportError: No module named 'bullmq'

Install dependencies:
```bash
pip install bullmq janus
```

### RuntimeError: MessageBus not initialized

Ensure the bus is initialized before use:
```python
from app.messaging.bus_runtime import set_bus
from app.messaging.local_bus import LocalBus

bus = LocalBus()
await bus.start()
set_bus(bus)
```

### Redis connection refused (processes mode)

Check Redis is running:
```bash
redis-cli ping  # Should return PONG
```

Check configuration in `config.json`:
```json
{
  "messaging": {
    "redis": {
      "url": "redis://localhost:6379"
    }
  }
}
```

### Messages not being delivered

1. Check if service is subscribed to the topic
2. Verify message type matches expected payload
3. Check logs for handler exceptions
4. Verify bus is started: `await bus.start()`

### Priority not working

Ensure you're using commands (not events) with `event=False`:
```python
await bus.publish(
    "My.Command",
    message,
    event=False,  # Commands respect priority
    priority=10
)
```

## Concurrent Message Delivery

As of October 2025, Aurora's LocalBus delivers messages **concurrently** to all subscribers using `asyncio.create_task()`. This provides several benefits:

### Benefits

1. **Non-blocking delivery**: Long-running handlers don't block other subscribers
2. **Better responsiveness**: UI updates happen immediately, even during LLM processing
3. **Parallel processing**: Multiple services can process the same event simultaneously

### Implementation

```python
# LocalBus._deliver() method
tasks = [asyncio.create_task(handler(env)) for handler in handlers]
results = await asyncio.gather(*tasks, return_exceptions=True)
```

### Implications

- **Order not guaranteed**: Handlers may complete in any order
- **Race conditions**: Services must handle concurrent state updates
- **Error isolation**: One handler's failure doesn't affect others
- **Subscription order irrelevant**: All subscribers receive events simultaneously

### Example Flow

```
User says "Jarvis, hello"
├─ 03:00:00 - STT publishes USER_SPEECH_CAPTURED
├─ 03:00:00 - UI Bridge receives (adds user message)
├─ 03:00:00 - Orchestrator receives (starts LLM processing)
└─ 03:00:08 - Orchestrator publishes LLM_RESPONSE
    ├─ 03:00:08 - UI Bridge receives (adds assistant message)
    └─ 03:00:08 - TTS receives (starts speaking)
```

Notice how UI Bridge and Orchestrator receive the transcription **at the same time**, not sequentially.

## Best Practices

1. **Use commands for reliable operations**: Commands have retry logic
2. **Use events for notifications**: Events are best-effort broadcast
3. **Set appropriate priorities**: Interactive > System > External
4. **Tag origin correctly**: "internal" for user interactions, "external" for APIs
5. **Handle errors gracefully**: Subscribe handlers should catch exceptions
6. **Use idempotent handlers**: Commands may be retried
7. **Monitor dead-letter queue**: Indicates persistent failures
8. **Design for concurrent delivery**: Don't assume handler execution order
9. **Use state locks**: Protect shared state from concurrent modification
10. **Emit events atomically**: Publish state changes after internal updates complete

## See Also

- [Architecture Migration Plan](../instructions/architecture_migration_plan.md)
- [Module Contract Registry Plan](../instructions/module_contract_registry_plan.md)
- [API WebRTC Module Plan](../instructions/api_webrtc_module_plan.md)
