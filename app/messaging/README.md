# Aurora Messaging System

This directory contains the message bus implementation for Aurora's parallel/microservices architecture.

## Overview

The messaging system provides a transport-agnostic abstraction for inter-service communication with support for:
- Priority-based message routing
- Automatic retry with exponential backoff
- Request/response pattern for queries
- Event broadcasting to multiple subscribers
- Wildcard topic subscriptions
- Dead-letter queues for failed messages

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Message Bus                          │
│  ┌──────────────┐    ┌──────────────┐   ┌──────────────┐  │
│  │   LocalBus   │    │  BullMQBus   │   │   Future     │  │
│  │  (threads)   │    │ (processes)  │   │ Transports   │  │
│  └──────────────┘    └──────────────┘   └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
           ▲                    ▲                    ▲
           │                    │                    │
    ┌──────┴──────┐      ┌─────┴─────┐      ┌──────┴──────┐
    │  Services   │      │  Services │      │  Services   │
    │  (Thread)   │      │ (Process) │      │  (Remote)   │
    └─────────────┘      └───────────┘      └─────────────┘
```

## Components

### Core Files

- **`bus.py`** - MessageBus protocol and base types (Envelope, Event, Command, Query)
- **`bus_runtime.py`** - Global bus accessor singleton
- **`local_bus.py`** - Thread-based implementation using asyncio
- **`bullmq_bus.py`** - Redis-based implementation for distributed deployment

### Message Types

```python
# Event - broadcast, best-effort delivery
class Event(BaseModel):
    pass

# Command - point-to-point, reliable delivery with retry
class Command(BaseModel):
    pass

# Query - request/response pattern
class Query(BaseModel):
    pass

# QueryResult - standard query response
class QueryResult(BaseModel):
    ok: bool
    data: Any = None
    error: Optional[str] = None
```

### Envelope Structure

All messages are wrapped in an `Envelope`:

```python
class Envelope(BaseModel):
    id: str                           # Unique message ID
    type: str                         # Message topic
    payload: BaseModel                # Actual message
    reply_to: Optional[str]           # For request/response
    correlation_id: Optional[str]     # For tracing
    timestamp: datetime               # Creation time
    origin: str                       # "internal" | "external" | "system"
    priority: int                     # 0=highest, 99=lowest
    deadline_ms: Optional[int]        # Message TTL
    attempts: int                     # Delivery attempts
    max_attempts: int                 # Max retry attempts
```

## Usage

### Initialize Bus

```python
from app.messaging.local_bus import LocalBus
from app.messaging.bus_runtime import set_bus, get_bus

# Create and start bus
bus = LocalBus()
await bus.start()
set_bus(bus)

# Later, get the bus from anywhere
bus = get_bus()
```

### Publish Messages

```python
# Publish event (broadcast)
await bus.publish(
    "TTS.Started",
    TTSStartedEvent(text="Hello"),
    event=True,
    priority=50,
    origin="internal"
)

# Publish command (reliable)
await bus.publish(
    "TTS.Request",
    TTSRequest(text="Hello", interrupt=False),
    event=False,
    priority=10,
    origin="internal"
)
```

### Subscribe to Messages

```python
# Subscribe to specific topic
async def on_tts_started(env: Envelope):
    event = TTSStartedEvent.model_validate(env.payload)
    print(f"TTS started: {event.text}")

bus.subscribe("TTS.Started", on_tts_started)

# Subscribe with wildcard
async def on_any_tts_event(env: Envelope):
    print(f"TTS event: {env.type}")

bus.subscribe("TTS.*", on_any_tts_event)
```

### Request/Response Pattern

```python
# Define query and response types
class GetMessagesQuery(BaseModel):
    limit: int = 10

class MessagesResponse(BaseModel):
    messages: List[str]

# Handler - must publish response to reply_to topic
async def handle_query(env: Envelope):
    query = GetMessagesQuery.model_validate(env.payload)
    messages = await db.get_messages(query.limit)
    response = MessagesResponse(messages=messages)
    
    # Send response back
    if env.reply_to:
        await bus.publish(env.reply_to, response, origin="internal")

bus.subscribe("DB.GetMessages", handle_query)

# Request - blocks until response or timeout
result = await bus.request(
    "DB.GetMessages",
    GetMessagesQuery(limit=5),
    timeout=2.0
)

if result.ok:
    messages = result.data["messages"]
else:
    print(f"Error: {result.error}")
```

## Priority System

Messages are processed by priority (lower number = higher priority):

| Priority | Category | Use Cases |
|----------|----------|-----------|
| 0-20 | Critical | User input, UI interactions |
| 21-49 | High | TTS requests, STT transcriptions |
| 50-69 | Normal | LLM responses, database queries |
| 70-89 | Low | Background tasks, logging |
| 90-99 | Lowest | Cleanup, statistics |

## Retry Behavior

Commands automatically retry on failure:
- **Max attempts**: 3 (configurable per message)
- **Backoff**: Exponential (1s, 2s, 4s)
- **Dead-letter queue**: Failed messages preserved for debugging

```python
# Custom retry configuration
await bus.publish(
    "MyService.Command",
    MyCommand(),
    event=False,
    max_attempts=5  # Override default
)
```

## LocalBus vs BullMQBus

### LocalBus (Threads Mode)
- **Transport**: In-memory asyncio queues
- **Deployment**: Single process
- **Performance**: 10,000+ msg/s, <1ms latency
- **Use case**: Development, single-instance production

### BullMQBus (Processes Mode)
- **Transport**: Redis
- **Deployment**: Multi-process, distributed
- **Performance**: 1,000+ msg/s, 5-10ms latency
- **Use case**: Scalable production, multiple workers

## Configuration

```json
{
  "general": {
    "architecture": {
      "mode": "threads"  // or "processes"
    }
  },
  "messaging": {
    "redis": {
      "url": "redis://localhost:6379"
    },
    "priorities": {
      "user_input": 10,
      "system": 50,
      "external": 80
    }
  }
}
```

## Monitoring

### Get Bus Statistics

```python
stats = bus.get_stats()
print(f"Published: {stats['published']}")
print(f"Delivered: {stats['delivered']}")
print(f"Failed: {stats['failed']}")
```

### Inspect Dead-Letter Queue

```python
# LocalBus only
dlq = bus._dlq
for env in dlq:
    print(f"Failed: {env.type} after {env.attempts} attempts")
```

### Enable Debug Logging

```python
import logging
logging.getLogger("app.messaging").setLevel(logging.DEBUG)
```

## Testing

```bash
# Unit tests
pytest tests/unit/test_messaging.py -v

# Integration tests
pytest tests/integration/test_message_flow.py -v

# All messaging tests
pytest tests/unit/test_messaging.py tests/integration/test_message_flow.py -v
```

## Best Practices

### 1. Use Specific Topics
```python
# Good
await bus.publish("TTS.Request", ...)
await bus.publish("STT.TranscriptionDetected", ...)

# Avoid
await bus.publish("message", ...)
```

### 2. Use Events for Broadcast, Commands for Reliable Delivery
```python
# Event - fire and forget
await bus.publish("TTS.Started", event, event=True)

# Command - retry on failure
await bus.publish("TTS.Request", command, event=False)
```

### 3. Use Request/Response for Synchronous Operations
```python
# Instead of complex event correlation
result = await bus.request("DB.GetMessages", query, timeout=2.0)
```

### 4. Set Appropriate Priorities
```python
# User interactions - high priority
await bus.publish("UI.UserInput", input, priority=10)

# Background tasks - low priority
await bus.publish("Metrics.Log", data, priority=80)
```

### 5. Handle Errors Gracefully
```python
async def handler(env: Envelope):
    try:
        # Process message
        pass
    except Exception as e:
        logger.error(f"Handler error: {e}")
        # Don't re-raise if you want to prevent retry
```

## Common Patterns

### Service Base Class
```python
class BaseService:
    def __init__(self, bus: MessageBus):
        self.bus = bus
    
    async def start(self):
        # Subscribe to topics
        pass
    
    async def stop(self):
        # Cleanup
        pass
```

### Event Aggregation
```python
# Subscribe to multiple related events
bus.subscribe("TTS.*", handle_all_tts_events)
bus.subscribe("STT.*", handle_all_stt_events)
```

### Command Chain
```python
# Service A triggers Service B
async def on_transcription(env):
    text = env.payload.text
    # Process and send to orchestrator
    await bus.publish("Orchestrator.Process", ProcessInput(text=text))
```

## Troubleshooting

### Messages Not Being Delivered
1. Check subscriptions are registered before publishing
2. Verify topic names match exactly (case-sensitive)
3. Check if handler is raising exceptions
4. Enable debug logging

### Slow Message Processing
1. Check handler execution time
2. Verify priority settings
3. Check queue sizes in stats
4. Consider using processes mode

### Request Timeouts
1. Increase timeout value
2. Check if handler is publishing to reply_to
3. Verify handler isn't throwing exceptions
4. Check bus stats for failed deliveries

## See Also

- `/docs/MESSAGING_ARCHITECTURE.md` - Detailed architecture
- `/docs/MIGRATION_COMPLETE.md` - Migration report
- `/tests/unit/test_messaging.py` - Unit test examples
- `/tests/integration/test_message_flow.py` - Integration test examples

## License

Part of Aurora Voice Assistant - see main LICENSE file
