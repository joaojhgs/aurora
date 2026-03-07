# Messaging Bus -- Agent Guide

> **Scope**: `app/messaging/` -- Bus abstraction, implementations, runtime, priorities.
> **Parent**: [Root AGENTS.md](../../AGENTS.md) for global rules.
> **Related**: [Contracts AGENTS.md](../shared/contracts/AGENTS.md) for topic constants; [Gateway AGENTS.md](../services/gateway/AGENTS.md) for MeshBus usage.

---

## CRITICAL RULES

### 1. NEVER Use Literal String Topics

Every bus topic MUST use a typed constant from `app/shared/contracts/models/`. This is the single most important rule in this codebase for preventing silent failures.

```python
# WRONG -- causes silent failures, typos go undetected, grep misses usages
await bus.publish("Auth.AuditEvent", payload, event=True)
await bus.request("Auth.ValidateToken", request)

# CORRECT -- typed, autocomplete-friendly, refactor-safe
from app.shared.contracts.models.auth import AuthMethods
await bus.request(AuthMethods.STORE_AUDIT_EVENT, payload)
await bus.request(AuthMethods.VALIDATE_TOKEN, request)
```

**Where topic constants live:**

| Service | Class | File |
|---------|-------|------|
| Auth | `AuthMethods` | `app/shared/contracts/models/auth.py` |
| Config | `ConfigMethods` | `app/shared/contracts/models/config.py` |
| DB | `DBMethods` | `app/shared/contracts/models/db.py` |
| Gateway | `GatewayMethods` | `app/shared/contracts/models/gateway.py` |
| Orchestrator | `OrchestratorMethods` | `app/shared/contracts/models/orchestrator.py` |
| Scheduler | `SchedulerMethods` | `app/shared/contracts/models/scheduler.py` |
| STT | `STTMethods`, `WakeWordMethods`, `TranscriptionMethods` | `app/shared/contracts/models/stt.py` |
| TTS | `TTSMethods` | `app/shared/contracts/models/tts.py` |
| Tooling | `ToolingMethods` | `app/shared/contracts/models/tooling.py` |
| Supervisor | `SupervisorMethods` | `app/shared/contracts/models/supervisor.py` |
| Audio | `AudioTopics` | `app/messaging/audio_messages.py` |

**For events that don't follow request/response**, use `*Events` classes (e.g., `MeshEvents` in `app/shared/contracts/models/mesh.py`).

**If a topic constant doesn't exist**, add it to the appropriate `*Methods` class BEFORE using it in service code. See [Contracts AGENTS.md](../shared/contracts/AGENTS.md).

### 2. NEVER Block the Event Loop

All handlers are `async`. Use `asyncio.to_thread()` for CPU-bound or blocking I/O.

---

## Bus Abstraction

### Protocol (`bus.py`)

`MessageBus` defines the interface all implementations must satisfy:
- `start()` / `stop()` -- lifecycle
- `publish(topic, payload, event, priority, origin, mesh)` -- send messages
- `request(topic, payload, timeout)` -- request/response (returns `QueryResult`)
- `subscribe(topic, handler)` -- register handlers

### Envelope

All messages are wrapped in an `Envelope`:

```python
class Envelope(BaseModel):
    id: str                    # Unique message ID
    type: str                  # Topic name
    payload: BaseModel         # Pydantic model
    reply_to: str | None       # For request/response
    correlation_id: str | None # For tracing
    origin: str                # "internal" | "external" | "system" | "mesh_forwarded"
    priority: int              # Lower = higher priority
    attempts: int              # Delivery attempts
    max_attempts: int          # Max retries (commands only)
```

### Message Types

| Type | `event=` | Delivery | Retry | Use For |
|------|----------|----------|-------|---------|
| **Command** | `False` | Point-to-point | Yes (exponential backoff, 3 attempts) | Service requests, control commands |
| **Event** | `True` | Broadcast to all subscribers | No | Notifications, state changes |
| **Query** | via `bus.request()` | Request/response with timeout | No | Data retrieval, status checks |

```python
# Command (reliable, retried)
await bus.publish(TTSMethods.REQUEST, TTSRequest(text="Hello"), event=False, priority=10)

# Event (broadcast, best-effort)
await bus.publish(TTSMethods.STARTED, TTSStarted(...), event=True, origin="internal")

# Query (request/response, 5s default timeout)
result = await bus.request(DBMethods.GET_MESSAGES, GetMessagesQuery(limit=10), timeout=5.0)
if result.ok:
    messages = result.data
```

---

## Implementations

### LocalBus (`local_bus.py`) -- Thread Mode

- In-memory asyncio queues (separate priority queue for commands, FIFO for events)
- Concurrent delivery via `asyncio.gather` -- handlers run in parallel
- Wildcard topic matching (`"TTS.*"`)
- Dead-letter queue for failed commands
- Performance: 10,000+ msg/s, <1ms latency

### BullMQBus (`bullmq_bus.py`) -- Process Mode

- Redis-backed BullMQ queues and workers
- Each service gets its own queue
- Job priorities mapped to BullMQ priority levels
- Wildcard via base queue + topic filtering
- Performance: 1,000+ msg/s, 5-10ms latency
- Requires `REDIS_URL` environment variable

### MeshBus (`mesh_bus.py`) -- P2P Mesh Wrapper

Wraps the inner bus (LocalBus or BullMQBus) to add cross-instance routing:

- **Commands**: `RoutingTable.resolve()` decides local vs remote; `PeerBridge` sends to remote peer via WebRTC DataChannel
- **Events with `mesh=True`**: Delivered locally first, then forwarded to all negotiated peers (if module has `share: true`)
- **Loop prevention**: Events with `origin="mesh_forwarded"` are never re-forwarded
- **Fallback**: On remote failure, falls back per routing config (local, network, error)

---

## Priority System

Lower number = higher priority. Always use helpers:

```python
from app.messaging.priority_helpers import (
    get_interactive_priority,  # 10 -- user interactions
    get_system_priority,       # 50 -- background tasks
    get_external_priority,     # 80 -- external API requests
)
```

| Priority | Value | Use Cases |
|----------|-------|-----------|
| Interactive | 10 | STT, UI input, user commands |
| System | 50 | Scheduled jobs, background tasks |
| External | 80 | HTTP API requests, webhooks |

---

## Concurrent Delivery

LocalBus delivers messages **concurrently** to all subscribers via `asyncio.gather`. This means:

- Handlers run in parallel, not sequentially
- Completion order is NOT guaranteed
- One handler's failure does NOT affect others
- Services MUST use locks for shared mutable state

```python
# BAD -- race condition
self.state = "processing"

# GOOD -- protected
async with self._state_lock:
    self.state = "processing"
```

---

## Mesh Event Forwarding

When MeshBus is active, events can be forwarded to connected peers. Two gates must pass:

### Gate 1: Developer declaration (`mesh=True`)

The publish call decides if the event is cross-instance relevant:

```python
# Cross-instance: forwarded to peers
await self.bus.publish(TTSMethods.STARTED, ..., event=True, mesh=True)

# Local-only: hardware-bound, high-frequency
await self.bus.publish(AudioTopics.STREAM_MICROPHONE, ..., event=True)  # mesh=False default
```

### Gate 2: Operator config (`share: true`)

Even with `mesh=True`, the event won't forward unless the module has `share: true` in `gateway.mesh.services` config.

### Events with `mesh=True` by Service

| Service | Mesh Events | Local-only Events |
|---------|-------------|-------------------|
| TTS | `STARTED`, `STOPPED`, `PAUSED`, `RESUMED`, `ERROR` | -- |
| Orchestrator | `RESPONSE` | -- |
| STTCoordinator | `SESSION_STARTED`, `USER_SPEECH_CAPTURED`, `SESSION_ENDED` | `Audio.Started`, `Audio.Stopped`, `Audio.Stream.Microphone` |
| Config | `UPDATED` | -- |
| Tooling | `TOOLS_INITIALIZED`, `TOOLS_RELOADED` | -- |

### Adding `mesh=True` to New Events

- **Does a remote instance need to know?** -> `mesh=True`
- **Hardware-bound, high-frequency, or purely local?** -> default (`mesh=False`)

---

## Runtime Singletons

### `bus_runtime.py` (legacy)

```python
from app.messaging.bus_runtime import get_bus, set_bus
```

Simple global accessor. Used in `app/messaging/` and some legacy code.

### `app/shared/messaging/bus_init.py` (preferred)

```python
from app.shared.messaging.bus_init import get_bus_singleton, set_bus
```

Mode-aware singleton: threads mode uses a single global bus; process mode manages per-service buses. `BaseService` uses `get_bus_singleton()` internally.

Both modules are kept in sync by the Supervisor on startup.

---

## Audio Messages (`audio_messages.py`)

Audio streaming uses its own topic constants in `AudioTopics`:

```python
from app.messaging.audio_messages import AudioTopics

AudioTopics.STREAM_MICROPHONE  # "Audio.Stream.Microphone"
AudioTopics.STREAM_WEBSOCKET   # "Audio.Stream.WebSocket"
AudioTopics.CONTROL             # "Audio.Control"
AudioTopics.STARTED             # "Audio.Started"
AudioTopics.STOPPED             # "Audio.Stopped"
```

---

## Testing the Bus

```python
import pytest
from unittest.mock import AsyncMock, MagicMock

# Mock bus for service tests
mock_bus = AsyncMock()
mock_bus.request.return_value = QueryResult(ok=True, data={"key": "value"})
mock_bus.publish = AsyncMock()

# Verify publish was called with correct topic constant
mock_bus.publish.assert_called_once_with(
    TTSMethods.REQUEST,
    ...,
    event=False,
    priority=10,
)
```
