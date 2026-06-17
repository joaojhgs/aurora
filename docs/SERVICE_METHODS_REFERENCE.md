# Aurora Service Methods Reference

This document provides a comprehensive reference of all service methods in Aurora, their exposure levels (internal vs external), and the differences between streaming and synchronous endpoints.

---

## Table of Contents

- [Exposure Levels Explained](#exposure-levels-explained)
- [Request Patterns Explained](#request-patterns-explained)
- [TTS Service](#tts-service)
- [STT Transcription Service](#stt-transcription-service)
- [STT WakeWord Service](#stt-wakeword-service)
- [STT Coordinator Service](#stt-coordinator-service)
- [Orchestrator Service](#orchestrator-service)
- [Scheduler Service](#scheduler-service)
- [DB Service](#db-service)
- [Tooling Service](#tooling-service)
- [Config Service](#config-service)
- [Gateway Service](#gateway-service)
- [Supervisor Service](#supervisor-service)

---

## Exposure Levels Explained

| Exposure | Description | Accessible Via |
|----------|-------------|----------------|
| `internal` | Only available within the Aurora system via message bus | Message Bus only |
| `external` | Only available via HTTP Gateway API | Gateway REST API only |
| `both` | Available via both message bus and HTTP Gateway | Message Bus + Gateway REST API |

### When to Use Each

- **Internal**: Server-side operations that don't make sense externally (e.g., playing audio on server speakers, controlling server microphone)
- **External**: Operations specifically designed for API consumers that have no internal use
- **Both**: Operations useful both internally and for API consumers (e.g., data retrieval, synthesis that returns data)

---

## Request Patterns Explained

### Synchronous (Single Request)

```
Client → Complete Request → Service → Complete Response
```

- One request, one response
- Waits for full processing to complete
- Best for: Complete files, single operations, API consumers

### Streaming (Batched/Chunked)

```
Client → Chunk 1 → Service (buffers)
Client → Chunk 2 → Service (buffers)
Client → Chunk N → Service (processes) → Event emitted
```

- Multiple small requests, results come via events
- Real-time processing with buffering/VAD
- Best for: Live audio, WebRTC, real-time voice

---

## TTS Service

Text-to-Speech synthesis and playback.

| Method ID | Summary | Input | Output | Exposure | Pattern |
|-----------|---------|-------|--------|----------|---------|
| `TTS.Request` | Process TTS and play on server | `TTSRequest` | `EmptyOutput` | **internal** | Async (fire-and-forget) |
| `TTS.Stop` | Stop server audio playback | `EmptyInput` | `EmptyOutput` | **internal** | Immediate |
| `TTS.Pause` | Pause server audio playback | `EmptyInput` | `EmptyOutput` | **internal** | Immediate |
| `TTS.Resume` | Resume server audio playback | `EmptyInput` | `EmptyOutput` | **internal** | Immediate |
| `TTS.Synthesize` | Synthesize and return audio data | `TTSSynthesizeRequest` | `TTSSynthesizeResponse` | **both** | Synchronous |

### Method Details

#### `TTS.Request` (Internal Only)
**Purpose**: Synthesize text and play audio through server speakers.

```python
# Input
TTSRequest(
    text: str,           # Text to synthesize
    interrupt: bool = False  # Interrupt current playback
)

# Output
EmptyOutput()  # Fire-and-forget, emits TTS.Started/TTS.Completed events
```

**Why Internal**: Plays audio on server hardware - meaningless for remote API clients.

#### `TTS.Synthesize` (Both)
**Purpose**: Synthesize text and return audio data as base64.

```python
# Input
TTSSynthesizeRequest(
    text: str,                    # Text to synthesize
    voice: str | None = None,     # Voice model (optional)
    speed: float = 1.0,           # Playback speed
    format: str = "wav",          # Output format: "wav" | "raw"
    sample_rate: int = 22050      # Sample rate
)

# Output
TTSSynthesizeResponse(
    audio_data: str,      # Base64-encoded audio
    format: str,          # "wav" or "raw"
    sample_rate: int,     # Actual sample rate
    channels: int,        # Number of channels (1)
    duration_ms: float,   # Audio duration in ms
    text: str             # Original text
)
```

**Why Both**: Returns data that can be used anywhere - internal services or API clients.

---

## STT Transcription Service

Speech-to-text transcription using Whisper.

| Method ID | Summary | Input | Output | Exposure | Pattern |
|-----------|---------|-------|--------|----------|---------|
| `Transcription.ProcessAudio` | Process audio chunk (streaming) | `STTAudioChunk` | `EmptyOutput` | **both** | Streaming |
| `Transcription.Control` | Control transcription | `STTControl` | `EmptyOutput` | **internal** | Immediate |
| `Transcription.Transcribe` | Transcribe complete audio | `TranscribeAudioRequest` | `TranscribeAudioResponse` | **both** | Synchronous |

### Method Details

#### `Transcription.ProcessAudio` (Both) - Streaming
**Purpose**: Process audio chunks in real-time for continuous transcription.

```python
# Input
STTAudioChunk(
    data: bytes,              # Raw audio bytes
    format: str = "pcm",      # Audio format
    sample_rate: int = 16000, # Sample rate
    channels: int = 1,        # Channel count
    sample_width: int = 2,    # Bytes per sample
    stream_id: str = "",      # Stream identifier
    source: str = "external"  # Source identifier
)

# Output
EmptyOutput()  # Results come via Transcription.Transcribed events
```

**Use Case**: WebRTC, live microphone streaming, real-time voice.

**How it works**:
1. Chunks are buffered internally
2. VAD (Voice Activity Detection) detects speech boundaries
3. When speech ends, Whisper transcribes the segment
4. `Transcription.Transcribed` event is emitted with text

#### `Transcription.Transcribe` (Both) - Synchronous
**Purpose**: Transcribe a complete audio file and return the result immediately.

```python
# Input
TranscribeAudioRequest(
    audio_data: str,          # Base64-encoded audio
    format: str = "wav",      # "wav" | "raw"
    sample_rate: int = 16000, # Sample rate
    channels: int = 1,        # Channel count
    language: str | None = None,  # Language hint
    model: str = "realtime"   # "realtime" | "accurate"
)

# Output
TranscribeAudioResponse(
    text: str,                # Transcribed text
    language: str,            # Detected language
    confidence: float,        # Confidence score
    duration_ms: float,       # Audio duration
    model_used: str           # Model that was used
)
```

**Use Case**: File uploads, batch processing, REST API consumers.

### Streaming vs Synchronous Comparison

| Aspect | `ProcessAudio` (Streaming) | `Transcribe` (Synchronous) |
|--------|---------------------------|---------------------------|
| Input | Small audio chunks (~100ms) | Complete audio file |
| Output | Events (async) | Direct response |
| Latency | Low per-chunk, VAD delay | Full processing time |
| Use Case | Live voice, WebRTC | File uploads, batch |
| VAD | Internal VAD detects speech | Optional VAD filter |
| State | Stateful (buffers chunks) | Stateless |

---

## STT WakeWord Service

Wake word detection using OpenWakeWord or Porcupine.

| Method ID | Summary | Input | Output | Exposure | Pattern |
|-----------|---------|-------|--------|----------|---------|
| `WakeWord.ProcessAudio` | Process audio chunk (streaming) | `STTAudioChunk` | `EmptyOutput` | **both** | Streaming |
| `WakeWord.Control` | Control wake word detection | `WakewordControl` | `EmptyOutput` | **internal** | Immediate |
| `WakeWord.Detect` | Check audio for wake word | `WakeWordDetectRequest` | `WakeWordDetectResponse` | **both** | Synchronous |

### Method Details

#### `WakeWord.ProcessAudio` (Both) - Streaming
**Purpose**: Continuously monitor audio stream for wake words.

```python
# Input
STTAudioChunk(...)  # Same as Transcription.ProcessAudio

# Output
EmptyOutput()  # Results come via WakeWord.Detected events
```

**When detected**: Emits `WakeWord.Detected` event with wake word name and confidence.

#### `WakeWord.Detect` (Both) - Synchronous
**Purpose**: Check a single audio chunk for wake word presence.

```python
# Input
WakeWordDetectRequest(
    audio_data: str,          # Base64-encoded audio
    format: str = "raw",      # Audio format
    sample_rate: int = 16000  # Sample rate
)

# Output
WakeWordDetectResponse(
    detected: bool,           # Was wake word detected?
    wake_word: str | None,    # Which wake word (if detected)
    confidence: float,        # Detection confidence
    backend: str              # Backend used (oww/porcupine)
)
```

**Use Case**: API consumers who want to check audio without subscribing to events.

---

## STT Coordinator Service

Coordinates STT sessions using server microphone.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `STT.Listen` | Start listening on server mic | `STTListenRequest` | `EmptyOutput` | **internal** |
| `STT.StopListening` | Stop server mic listening | `STTStopListeningRequest` | `EmptyOutput` | **internal** |
| `STT.Audio` | Process raw audio chunk | `STTAudioChunk` | `EmptyOutput` | **internal** |
| `STT.Control` | Control STT coordinator | `STTCoordinatorControl` | `EmptyOutput` | **internal** |

### Why All Internal

The STT Coordinator manages the **server's physical microphone**. These operations:
- Start/stop hardware audio capture on the server
- Manage server-side audio sessions
- Control server microphone state

For external clients who want to send their own audio, use:
- `Transcription.ProcessAudio` (streaming)
- `Transcription.Transcribe` (synchronous)

---

## Orchestrator Service

LLM orchestration and user input processing.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Orchestrator.UserInput` | Process user input (internal) | `OrchestratorProcessRequest` | `EmptyOutput` | **internal** |
| `Orchestrator.ExternalUserInput` | Process input and return response | `OrchestratorProcessRequest` | `OrchestratorResponse` | **external** |
| `Orchestrator.ToolResult` | Process tool execution result | `OrchestratorToolResultRequest` | `EmptyOutput` | **internal** |

### Method Details

#### `Orchestrator.UserInput` (Internal)
**Purpose**: Process user input from internal sources (UI, STT).

```python
# Input
OrchestratorProcessRequest(
    text: str,                    # User message
    session_id: str | None = None # Session identifier
)

# Output
EmptyOutput()  # Response sent via TTS and events
```

**Why Internal**: Triggers TTS playback on server, emits events for internal consumption.

#### `Orchestrator.ExternalUserInput` (External)
**Purpose**: Process user input and return the LLM response directly.

```python
# Input
OrchestratorProcessRequest(
    text: str,                    # User message
    session_id: str | None = None # Session identifier
)

# Output
OrchestratorResponse(
    text: str,                    # LLM response text
    session_id: str | None,       # Session identifier
    metadata: dict                # Additional metadata
)
```

**Why External**: API consumers want the response returned, not played via TTS.

---

## Scheduler Service

Job scheduling using cron expressions.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Scheduler.Schedule` | Schedule a new job | `SchedulerScheduleJobRequest` | `EmptyOutput` | **both** |
| `Scheduler.Cancel` | Cancel a job | `SchedulerCancelJobRequest` | `EmptyOutput` | **both** |
| `Scheduler.Pause` | Pause a job | `SchedulerPauseJobRequest` | `EmptyOutput` | **internal** |
| `Scheduler.Resume` | Resume a paused job | `SchedulerResumeJobRequest` | `EmptyOutput` | **internal** |
| `Scheduler.ListJobs` | List all scheduled jobs | `SchedulerListJobsRequest` | `SchedulerListJobsResponse` | **both** |

### Method Details

#### `Scheduler.Schedule` (Both)
```python
# Input
SchedulerScheduleJobRequest(
    name: str,           # Job name
    schedule: str,       # Cron expression (e.g., "0 9 * * *")
    action: str,         # Action to execute
    enabled: bool = True # Whether job is active
)
```

#### `Scheduler.ListJobs` (Both)
```python
# Input
SchedulerListJobsRequest(
    enabled_only: bool = False,  # Filter by active jobs
    limit: int = 100,            # Max results
    offset: int = 0              # Pagination offset
)

# Output
SchedulerListJobsResponse(
    jobs: list[SchedulerJobInfo],  # Job list
    total: int                      # Total count
)
```

---

## DB Service

Database operations for messages and RAG storage.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `DB.SaveMessage` | Store a chat message | `DBSaveMessageRequest` | `DBSaveMessageResponse` | **internal** |
| `DB.GetMessages` | Get recent messages | `DBGetMessagesRequest` | `DBGetMessagesResponse` | **both** |
| `DB.GetMessagesForDate` | Get messages for date | `DBGetMessagesForDateRequest` | `DBGetMessagesResponse` | **both** |
| `DB.SaveCronJob` | Store a cron job | `DBStoreCronJobRequest` | `EmptyOutput` | **internal** |
| `DB.GetCronJobs` | Get cron jobs | `DBGetCronJobsRequest` | `DBGetCronJobsResponse` | **internal** |
| `DB.DeleteCronJob` | Delete a cron job | `DBDeleteCronJobRequest` | `EmptyOutput` | **internal** |
| `DB.RAGStore` | Store RAG item | `DBRAGStoreRequest` | `EmptyOutput` | **internal** |
| `DB.RAGDelete` | Delete RAG item | `DBRAGDeleteRequest` | `EmptyOutput` | **internal** |
| `DB.RAGSearch` | Search RAG store | `DBRAGSearchRequest` | `DBRAGListResponse` | **both** |
| `DB.RAGGet` | Get RAG item | `DBRAGGetRequest` | `DBRAGItemResponse` | **internal** |
| `DB.RAGList` | List RAG items | `DBRAGListRequest` | `DBRAGListResponse` | **internal** |

### Why Some Are Internal

- **Write operations** (`SaveMessage`, `RAGStore`, etc.): Internal services control data integrity
- **Read operations** (`GetMessages`, `RAGSearch`): Safe for external read access

---

## Tooling Service

Tool management and execution.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Tooling.GetTools` | Get available tools | `ToolingGetToolsRequest` | `ToolingGetToolsResponse` | **both** |
| `Tooling.GetToolByName` | Get specific tool | `ToolingGetToolByNameRequest` | `ToolingGetToolByNameResponse` | **both** |
| `Tooling.GetStats` | Get tooling statistics | `ToolingGetStatsRequest` | `ToolingGetStatsResponse` | **both** |
| `Tooling.GetMCPStatus` | Get MCP server status | `ToolingGetMCPStatusRequest` | `ToolingGetMCPStatusResponse` | **both** |
| `Tooling.ReloadMCP` | Reload MCP tools | `ToolingReloadMCPRequest` | `EmptyOutput` | **internal** |
| `Tooling.ExecuteTool` | Execute a tool | `ToolingExecuteToolRequest` | `ToolingExecuteToolResponse` | **both** |

### Method Details

#### `Tooling.GetTools` (Both)
**Purpose**: Return bindable tool schemas with stable local/mesh identity metadata.

```python
# Output item
ToolingToolInfo(
    name="raspi-lab_switch_on",                 # Bindable, collision-safe name
    local_name="switch_on",                     # Provider-local tool name
    global_tool_id="raspi-lab:remote_raspi-lab_Tooling:tool:switch_on",
    provider_peer_id="raspi-lab",
    provider_service_instance_id="remote:raspi-lab:Tooling",
    namespace="raspi-lab",
    display_name="raspi-lab.switch_on",         # Human-facing name
    aliases=["switch_on"],
    description="Switch on a target.",
    args_schema={"type": "object", "properties": {...}},
    source_type="mesh_peer",                    # "local" | "mesh_peer"
    execution_location="remote",                # "local" | "remote"
    safety_class="standard",
    required_permissions=["Tooling.ExecuteTool"],
    confirmation_required=False,
    provenance={...},
)
```

Local-only discovery remains backward compatible: `name` is still the local
tool name. Provider-selected mesh discovery namespaces `name`, for example
`raspi-lab_switch_on` and `workstation_switch_on`, while `display_name` keeps
the user-facing `raspi-lab.switch_on` / `workstation.switch_on` form.

#### `Tooling.ExecuteTool` (Both)
**Purpose**: Execute a provider-local or explicitly selected remote tool with
policy checks and audit provenance.

```python
ToolingExecuteToolRequest(
    tool_name="raspi-lab_switch_on",            # local name, namespaced name, or global_tool_id
    arguments={"target": "lamp"},
    mesh_selector=MeshAddressSelector(peer_id="raspi-lab", tool_id="..."),
    resource_selector=ToolingResourceSelector(hardware_target="lamp"),
    confirmed=True,
    dry_run=False,
    correlation_id="rpc-123",
    caller_peer_id="workstation",              # injected by WebRTC RPC for remote callers
    caller_principal_id="peer-principal",      # injected by WebRTC RPC for remote callers
)
```

Remote sensitive/dangerous tools require an explicit resource selector and
confirmation before invocation. `dry_run=True` records the requested execution
without invoking the tool. Every outcome writes an `Auth.StoreAuditEvent`
record containing caller peer/principal, target/provider peer, tool identity,
resource selector, correlation ID, status/error code, and a redacted argument
hash rather than raw argument values.

---

## Config Service

Configuration management.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Config.Get` | Get config value | `GetConfigQuery` | `GetConfigResponse` | **both** |
| `Config.Set` | Update config value | `UpdateConfigCommand` | `UpdateConfigResponse` | **both** |
| `Config.Validate` | Validate config | `ValidateConfigQuery` | `ValidateConfigResponse` | **both** |
| `Config.GetPlugin` | Get plugin status | `GetPluginStatusQuery` | `GetPluginStatusResponse` | **both** |
| `Config.SetPlugin` | Update plugin status | `UpdatePluginStatusCommand` | `UpdateConfigResponse` | **both** |
| `Config.ReloadService` | Reload a service | `ReloadServiceCommand` | `EmptyOutput` | **internal** |

---

## Gateway Service

WebRTC peer authentication and pairing management.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Gateway.PairingStart` | Start device pairing | `PairingStartRequest` | `PairingStartResponse` | **both** |
| `Gateway.PairingConnect` | Poll pairing status | `PairingConnectRequest` | `PairingConnectResponse` | **both** |
| `Gateway.PairingExchange` | Exchange code for token | `PairingExchangeRequest` | `PairingExchangeResponse` | **both** |
| `Gateway.Login` | Authenticate with credentials | `LoginRequest` | `LoginResponse` | **both** |

### Method Details

#### `Gateway.PairingStart` (Both)
**Purpose**: Initiate a pairing flow for a new device. Generates a 6-digit code.

```python
# Input
PairingStartRequest(
    device_name: str,      # Name of the device to pair
    client_ip: str = ""    # Client IP for rate limiting
)

# Output
PairingStartResponse(
    code: str,                  # 6-digit pairing code
    expires_in_seconds: int     # Code TTL (from webrtc_pairing_timeout_seconds)
)
```

**Why Both**: Accessible via HTTP API and also via WebRTC DataChannel RPC from anonymous peers.

#### `Gateway.PairingConnect` (Both)
**Purpose**: Poll the status of a pairing request.

```python
# Input
PairingConnectRequest(
    code: str    # 6-digit pairing code
)

# Output
PairingConnectResponse(
    request_id: str,     # Pairing request UUID
    device_name: str,    # Device name
    status: str          # "pending" | "approved" | "expired"
)
```

#### `Gateway.PairingExchange` (Both)
**Purpose**: Exchange an approved pairing code for a permanent bearer token.

```python
# Input
PairingExchangeRequest(
    code: str    # 6-digit pairing code (must be approved)
)

# Output
PairingExchangeResponse(
    token: str,           # Bearer token
    device_id: str,       # Created device UUID
    user_id: str,         # Created principal UUID
    permissions: list     # Granted permissions
)
```

#### `Gateway.Login` (Both)
**Purpose**: Authenticate with username and password credentials.

```python
# Input
LoginRequest(
    username: str,
    password: str
)

# Output
LoginResponse(
    token: str,           # Bearer token
    user_id: str          # Authenticated user UUID
)
```

### Anonymous Access Note

These four methods are the **only** RPC calls that anonymous (unauthenticated) WebRTC peers are allowed to make. The RTCClient's auth gate and RPCHandler's anonymous allowlist ensure all other operations require authentication first.

---

## Supervisor Service

Service lifecycle management.

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Supervisor.GetStatus` | Get all service status | `EmptyInput` | `GetStatusResponse` | **both** |
| `Supervisor.RestartService` | Restart a service | `ServiceControlCommand` | `ServiceControlResponse` | **internal** |

---

## Summary Tables

### External API Endpoints (Gateway)

These methods are exposed via HTTP POST at `/api/{service}/{method}`:

| Service | Method | Endpoint |
|---------|--------|----------|
| TTS | Synthesize | `POST /api/tts/synthesize` |
| Transcription | ProcessAudio | `POST /api/transcription/processaudio` |
| Transcription | Transcribe | `POST /api/transcription/transcribe` |
| WakeWord | ProcessAudio | `POST /api/wakeword/processaudio` |
| WakeWord | Detect | `POST /api/wakeword/detect` |
| Orchestrator | ExternalUserInput | `POST /api/orchestrator/externaluserinput` |
| Scheduler | Schedule | `POST /api/scheduler/schedule` |
| Scheduler | Cancel | `POST /api/scheduler/cancel` |
| Scheduler | ListJobs | `POST /api/scheduler/listjobs` |
| DB | GetMessages | `POST /api/db/getmessages` |
| DB | GetMessagesForDate | `POST /api/db/getmessagesfordate` |
| DB | RAGSearch | `POST /api/db/ragsearch` |
| Tooling | GetTools | `POST /api/tooling/gettools` |
| Tooling | GetToolByName | `POST /api/tooling/gettoolbyname` |
| Tooling | GetStats | `POST /api/tooling/getstats` |
| Tooling | GetMCPStatus | `POST /api/tooling/getmcpstatus` |
| Tooling | ExecuteTool | `POST /api/tooling/executetool` |
| Config | Get | `POST /api/config/get` |
| Config | Set | `POST /api/config/set` |
| Config | Validate | `POST /api/config/validate` |
| Config | GetPlugin | `POST /api/config/getplugin` |
| Config | SetPlugin | `POST /api/config/setplugin` |
| Gateway | PairingStart | `POST /api/gateway/pairingstart` |
| Gateway | PairingConnect | `POST /api/gateway/pairingconnect` |
| Gateway | PairingExchange | `POST /api/gateway/pairingexchange` |
| Gateway | Login | `POST /api/gateway/login` |
| Supervisor | GetStatus | `POST /api/supervisor/getstatus` |

### Internal-Only Methods

These are only accessible via the message bus:

| Service | Method | Reason |
|---------|--------|--------|
| TTS | Request | Plays audio on server speakers |
| TTS | Stop/Pause/Resume | Controls server audio playback |
| Transcription | Control | Internal state management |
| WakeWord | Control | Internal state management |
| STT Coordinator | All methods | Server microphone control |
| Orchestrator | UserInput | Triggers server-side TTS |
| Orchestrator | ToolResult | Internal workflow |
| Scheduler | Pause/Resume | Administrative operations |
| DB | SaveMessage | Data integrity |
| DB | Cron job methods | Internal scheduler use |
| DB | RAG write methods | Data integrity |
| Tooling | ReloadMCP | Administrative operation |
| Config | ReloadService | Administrative operation |
| Supervisor | RestartService | Administrative operation |

---

## Future Considerations

### WebSocket Streaming

The current Gateway only supports REST (HTTP POST) endpoints. For true real-time streaming, consider:

1. **WebSocket endpoint** for bidirectional audio streaming
2. **Server-Sent Events (SSE)** for subscribing to transcription events

### Current Streaming Limitation

`Transcription.ProcessAudio` accepts chunks but results come via events. Without WebSocket:
- Client must poll or use another mechanism to receive transcription results
- For now, use `Transcription.Transcribe` for synchronous transcription via REST
