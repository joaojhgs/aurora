# Aurora Architecture Migration - Master Implementation Plan

## Executive Summary

This plan details the complete migration of Aurora from its current state to a modular, contract-based architecture supporting three deployment modes:

1. **Local Mode**: Standalone application running on a single machine
2. **Server-Client Mode**: Central server with remote clients (mobile, desktop, IoT)
3. **P2P Cloud Mode**: Peer-to-peer network with capability sharing and access control

The migration follows an iterative approach, starting with core infrastructure and progressively migrating all services.---

## Phase 0: Complete Registry Foundation

**Goal**: Implement the complete module and method contract registry as the single source of truth for all service capabilities.

### 0.1 Complete Registry Implementation ✅

- [x] Add [ModuleContract](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#69-90) class to [app/shared/contracts/registry.py](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py)
- [x] Include [module](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#304-311), [version](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#155-181), `summary`, `capabilities`, `depends_on` fields
- [x] Support semantic versioning validation
- [x] Implement module-level registry storage ([_modules](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#304-311) dict)
- [x] Implement [register_module()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#110-153) function
- [x] Implement [export()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#313-355) function
- [x] Export modules with all methods as JSON
- [x] Calculate and include SHA256 digest for quick equality checks
- [x] Implement [import_registry()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#357-367) function for loading remote registries
- [x] Add [list_modules()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#304-311) function
- [x] Update `@method_contract` decorator to auto-register with parent module

### 0.2 Registry-Bus Integration ✅

> [!IMPORTANT]> EventRegistry will be **completely replaced** by the MethodContract registry. No deprecation period - direct removal and migration.

- [x] Update MessageBus to use contract registry for topic validation
- [x] Replace `EventRegistry` validation with contract registry queries
- [x] Query [all_contracts()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#283-290) for valid topics
- [x] Remove `EventRegistry` class and all direct usage
- [x] Delete `app/messaging/event_registry.py`
- [x] Remove all [register_all_service_topics()](file:///home/skyron/Documentos/aurora/app/messaging/**init**.py#63-74) calls (converted to no-op stub)
- [x] Remove all manual `EventRegistry.register_topic()` calls
- [x] Update `MessageBus.publish()` and [subscribe()](file:///home/skyron/Documentos/aurora/app/messaging/bus.py#158-166) validation
- [x] Check if topic exists in contract registry
- [x] Use contract metadata for validation rules

### 0.3 Contract Models and Validation ✅

- [x] Create [app/shared/contracts/models/](file:///home/skyron/Documentos/aurora/app/shared/contracts/models) directory
- [x] Define Pydantic IO models for core domains:
- [x] TTS models (TTSRequest, TTSControl, TTSStatus, TTSError)
- [x] STT models (STTTranscriptionRequest, STTTranscriptionResult, etc.)
- [x] DB models (DBSaveMessageRequest, DBGetMessagesResponse, etc.)
- [x] Config models (ConfigGetRequest, ConfigSetResponse)
- [x] Orchestrator models (OrchestratorProcessRequest, OrchestratorResponse)
- [x] Common models (EmptyInput, EmptyOutput, ErrorOutput)
- [x] Organized in modular structure (common.py, tts.py, stt.py, db.py, config.py, orchestrator.py)

### 0.4 Verification ✅

- [x] Write unit tests for [ModuleContract](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#69-90) and [MethodContract](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#36-67)
- [x] Write unit tests for [export()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#313-355) / [import_registry()](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#357-367)
- [x] Test roundtrip (export → import → verify digest)
- [x] Test digest changes when contract modified
- [x] Test registry-bus integration
- [x] Verify topics auto-populate from contracts
- [x] Verify bus accepts messages to contract-registered topics

**Command**: `pytest tests/unit/contracts/ -v` ✅ 7/7 passed---

## Phase 1: Core Service Migration

**Goal**: Migrate all existing services to use the module and method contract system.

### Design Update: Automatic Module Registration & Method Contracts

**Decision**: Services will automatically register their module in [**init**](file:///home/skyron/Documentos/aurora/app/shared/messaging/models/orchestrator_models.py#55-68) by passing metadata to [BaseService](file:///home/skyron/Documentos/aurora/app/shared/services/base_service.py#20-343). Method contracts will be declared using `@method_contract` decorators on methods.**Requirements**:

1.  **BaseService Init**: Services MUST call [super().**init**(service_name, summary, capabilities)](file:///home/skyron/Documentos/aurora/app/services/supervisor.py#411-415) in their [**init**](file:///home/skyron/Documentos/aurora/app/shared/messaging/models/orchestrator_models.py#55-68).
2.  **Method Decorators**: Use `@method_contract(name="MethodName", ...)` on handler methods.

    -   **Improvement**: The [module](file:///home/skyron/Documentos/aurora/app/shared/contracts/registry.py#304-311) argument is NO LONGER REQUIRED in decorators. [BaseService](file:///home/skyron/Documentos/aurora/app/shared/services/base_service.py#20-343) automatically injects the module name during initialization (Late Binding).

3.  **Registry Robustness**: [BaseService](file:///home/skyron/Documentos/aurora/app/shared/services/base_service.py#20-343) scans for decorated methods at runtime and registers them, solving import-time/runtime conflicts.
4.  **Topic Naming**: Services MUST use the correct topic constants from [app/messaging/service_topics.py](file:///home/skyron/Documentos/aurora/app/messaging/service_topics.py).

**Migration Pattern**:

```python
class MyService(BaseService):
    def __init__(self):
        super().__init__("MyService", summary="...", capabilities=["..."])

    @method_contract(name="MyMethod", input_model=Request, output_model=Response)
    async def my_method(self, req: Request) -> Response:
        ...
```



### 1.1 Merge STT Services (stt_audio_input + stt_coordinator) ✅

> [!IMPORTANT]> These two services are internal-only and will be combined into a single [STTCoordinatorService](file:///home/skyron/Documentos/aurora/app/services/stt_coordinator/service.py#85-814) that handles both audio input and coordination logic.

- [x] Create new merged service structure
- [x] Keep `app/services/stt_coordinator/` as the location
- [x] Merge audio input logic from `stt_audio_input/service.py`
- [x] Combine initialization and lifecycle management
- [x] Update imports and dependencies
- [x] Update service registry/supervisor to remove `AudioInputService`
- [x] Update pyproject.toml dependencies
- [x] Delete `app/services/stt_audio_input/` directory
- [x] Update docker-compose.process.yml
- [x] Delete Dockerfile.audio-input

#### Verification ✅

- [x] Run existing STT tests: Registry tests 7/7 passing
- [x] Verify service instantiation and imports
- [x] Verify all attributes present (audio + coordinator)

### 1.2 Migrate TTS Service ✅

- [x] Register TTS module: `register_module("TTS")` (version auto-detected from pyproject.toml)
- [x] Define method contracts:
- [x] `TTS.Request` (command, internal+external)
- [x] `TTS.Stop` (command, internal+external)
- [x] `TTS.Pause` (command, internal)
- [x] `TTS.Resume` (command, internal)
- [x] Apply `@method_contract` decorators to handler methods
- [x] Remove manual `bus.subscribe()` calls
- [x] Update decorator to auto-populate module_version

#### Verification ✅

- [x] TTS module registered with auto-version
- [x] 4 method contracts registered
- [x] Registry export includes TTS module

### 1.3 Migrate STT Services ✅

#### STTCoordinatorService (merged) ✅

- [x] Register module: `register_module("STTCoordinator")` (version auto-detected)
- [x] Define method contracts (4 contracts):
- [x] `Wakeword.Detected` → on_wake_word (internal)
- [x] `Transcription.Result.Accurate` → on_transcription (internal)
- [x] `STT.Coordinator.Control` → control (internal)
- [x] `Audio.Input.Control` → audio_input_control (internal, deprecated)
- [x] Apply `@method_contract` decorators
- [x] Remove manual topic registrations (5 subscriptions removed)

#### STTTranscriptionService ✅

- [x] Register module: `register_module("STTTranscription")` (version auto-detected)
- [x] Define method contracts (2 contracts):
- [x] `Audio.Chunk.Stream.Microphone` → on_audio (internal)
- [x] `Transcription.Control` → control (internal)
- [x] Apply `@method_contract` decorators
- [x] Remove manual topic registrations (5 subscriptions removed)

#### STTWakewordService ✅

- [x] Register module: `register_module("STTWakeword")` (version auto-detected)
- [x] Fix BaseService inheritance
- [x] Define method contracts (2 contracts):
- [x] `Audio.Chunk.Stream.Microphone` → on_audio (internal)
- [x] `Wakeword.Control` → control (internal)
- [x] Apply `@method_contract` decorators
- [x] Remove manual topic registrations (3 subscriptions removed)

#### Verification ✅

- [x] All 3 STT services migrated
- [x] Total: 8 method contracts registered
- [x] All services using auto-version detection
- [x] Run: `pytest tests/integration/stt/ -v`
- [x] Manual test: Full voice interaction (wake word → transcription → action)

### 1.4 Migrate Database Service ✅

- [x] Create `app/shared/contracts/models/db.py`
- [x] Update `DBService` with `@method_contract` decorators
- [x] Remove manual `bus.subscribe()` calls
- [x] Verify registration and contracts

### 1.5 Migrate Scheduler Service ✅

- [x] Create `app/shared/contracts/models/scheduler.py`
- [x] Update `SchedulerService` with `@method_contract` decorators
- [x] Remove manual `bus.subscribe()` calls
- [x] Verify registration and contracts

### 1.6 Migrate Orchestrator Service ✅

- [x] Create `app/shared/contracts/models/orchestrator.py`
- [x] Update `OrchestratorService` with `@method_contract` decorators
- [x] Remove manual `bus.subscribe()` calls
- [x] Verify registration and contracts

---

## Phase 1.6.5: Refactor BaseService for Auto-Subscription (Template Method) ✅

Refactor `BaseService` to handle contract subscription automatically in a concrete `start()` method, calling `on_start()` for subclass logic.

### Shared

#### [MODIFY] [base_service.py](file:///home/skyron/Documentos/aurora/app/shared/services/base_service.py)

- [x] Make `start()` concrete: calls `_subscribe_registered_contracts()` then `on_start()`
- [x] Make `stop()` concrete: calls `on_stop()`
- [x] Add abstract `on_start()` and `on_stop()`

### Services

#### [MODIFY] All Service Files

- [x] Rename `start()` to `on_start()`
- [x] Rename `stop()` to `on_stop()`
- [x] Remove manual `_subscribe_registered_contracts()` calls

---

## Phase 1.6.6: Enforce Topic Constants ✅

**Goal**: Ensure all `@method_contract` decorators use typed constants from `service_topics.py` instead of raw string literals to prevent typos and enforce type safety.

### Messaging

#### [MODIFY] [service_topics.py](file:///home/skyron/Documentos/aurora/app/messaging/service_topics.py)

- [x] Add missing `STTCoordinatorTopics.LISTEN`
- [x] Add missing `STTCoordinatorTopics.STOP_LISTENING`
- [x] Add missing `STTCoordinatorTopics.AUDIO`

### Services

#### [MODIFY] [tts/service.py](file:///home/skyron/Documentos/aurora/app/services/tts/service.py)

- [x] Use `TTSTopics.REQUEST` (already using typed constant)
- [x] Use `TTSTopics.STOP` (already using typed constant)
- [x] Use `TTSTopics.PAUSE` (already using typed constant)
- [x] Use `TTSTopics.RESUME` (already using typed constant)

#### [MODIFY] [stt_coordinator/service.py](file:///home/skyron/Documentos/aurora/app/services/stt_coordinator/service.py)

- [x] Use `STTCoordinatorTopics.LISTEN` (already using typed constant)
- [x] Use `STTCoordinatorTopics.STOP_LISTENING` (already using typed constant)
- [x] Use `STTCoordinatorTopics.AUDIO` (already using typed constant)
- [x] Verify `WakeWordTopics.DETECTED` is used (not raw string)
- [x] Verify `TranscriptionTopics.RESULT` is used (not raw string)
- [x] Verify `STTCoordinatorTopics.CONTROL` is used (not raw string)
- [x] Verify `AudioInputTopics.CONTROL` is used (not raw string)

#### Verification

- [x] Run grep to ensure no `bus_topic="` raw strings remain in migrated services
- [x] Verify all services import their topic constants

---

## Phase 1.7.5: Refactor Topic Constants Organization

**Goal**: Move topic constants from `app/messaging/service_topics.py` to `app/shared/contracts/models/` alongside their respective models, and address naming redundancy.

### Problem

1. Topic constants are separated from their contract models
2. Naming redundancy: `"TTS.Request"` includes module name, but decorator already knows module from `service_name`
3. Conceptual mismatch: These are method name constants, not just "service topics"

### Proposed Solution: Relative Method Names

Move to contract model files with relative names (no module prefix):

```python
# app/shared/contracts/models/tts.py
class TTSMethods:
    REQUEST = "request"
    STOP = "stop"
    PAUSE = "pause"
    RESUME = "resume"
```



### Changes Required

#### Contract Models

- [x] Add `TTSMethods` to `tts.py`
- [x] Add `STTMethods` to `stt.py`
- [x] Add `DBMethods` to `db.py`
- [x] Add `SchedulerMethods` to `scheduler.py`
- [x] Add `OrchestratorMethods` to `orchestrator.py`
- [x] Add `ToolingMethods` to `tooling.py`

#### Registry (Optional Enhancement)

- [ ] Make `bus_topic` optional in `@method_contract`
- [ ] Auto-derive from `name` if not provided: `f"{module}.{name.capitalize()}"`

#### Services

- [x] Update all 6 services to use new method constants
- [x] Update imports from `service_topics` to contract models

#### Cleanup

- [x] Add deprecation notice to `service_topics.py`
- [x] Keep old constants for backward compatibility

**See `phase_1_7_5_plan.md` for detailed analysis and options.**---

## Phase 1.7: Migrate Tooling Service

- [ ] Update `__init__`: Pass `summary` and `capabilities` to `BaseService` (auto-registers "Tooling" module)
- [ ] Define method contracts for each tool:
- [ ] `Tool.Execute` (command, internal+external)
- [ ] `Tool.List` (query, internal+external)
- [ ] `Tool.GetSchema` (query, internal+external)
- [ ] Apply `@method_contract` decorators
- [ ] Use `capabilities` field to list available tools

#### Verification

- [ ] Run: `pytest tests/unit/services/tooling/ -v`
- [ ] Manual test: Execute a tool via orchestrator

### 1.8 Migrate Config Service

- [x] Update `__init__`: Pass `summary` and `capabilities` to `BaseService` (auto-registers "Config" module)
- [x] Define method contracts:
- [x] `Config.Get` (query, internal+external)
- [x] `Config.Set` (command, internal+external)
- [x] `Config.Reload` (command, internal)
- [x] `Config.Changed` (event, internal)
- [x] Apply `@method_contract` decorators
- [x] Set `required_perms=["config:read"]` and `["config:write"]`

#### Verification

- [ ] Run: `pytest tests/unit/services/config/ -v`
- [ ] Manual test: Change config value, verify services reload

### 1.9 Update Supervisor

- [x] Update `Supervisor.__init__()` to call `register_all_service_modules()`
- [x] Create helper to auto-discover services from registry
- [x] Log registered modules and capabilities on startup

#### Verification

- [x] Run: `python main.py --help` (verify startup)
- [x] Check logs for module registration messages
- [x] Verify `export()` includes all migrated services

---

## Phase 2: Supervisor as Gateway (Thread + Process Modes)

**Goal**: Enhance Supervisor to act as a unified gateway hosting FastAPI and WebRTC endpoints, dynamically enabled via configuration.

### 2.1 Supervisor Architecture Enhancement

> [!NOTE]> The Supervisor will host both FastAPI and WebRTC directly. No separate "supervisor_gateway" module needed.

- [ ] Enhance `app/services/supervisor.py` to support gateway features
- [ ] Add FastAPI application instance (conditional)
- [ ] Add WebRTC client instance (conditional)
- [ ] Query config service at runtime for feature toggles
- [ ] Create gateway submodules within supervisor:
- [ ] `app/services/gateway/fastapi_router.py` - REST API routes
- [ ] `app/services/gateway/webrtc_client.py` - WebRTC connection manager
- [ ] `app/services/gateway/auth.py` - Authentication and permission checking
- [ ] `app/services/gateway/registry_endpoint.py` - Expose registry export

### 2.2 FastAPI Integration (Config-Driven)

> [!IMPORTANT]> FastAPI can run in both thread and process modes. It's config-driven and can be toggled at runtime.

- [ ] Add config keys for FastAPI:
- [ ] `api.enabled` (boolean, default: false)
- [ ] `api.host` (string, default: "0.0.0.0")
- [ ] `api.port` (int, default: 8000)
- [ ] Supervisor queries config on startup/reload
- [ ] Use `bus.request("Config.Get", key="api.enabled")`
- [ ] Start/stop FastAPI server based on config
- [ ] Add FastAPI app to Supervisor (when enabled)
- [ ] Auto-generate REST endpoints from registry
- [ ] For each method where `exposure in ["external", "both"]`
- [ ] Generate POST `/api/{module}/{method}` endpoint
- [ ] Validate input using `input_model`
- [ ] Publish to bus and await response (for queries)
- [ ] Return output using `output_model`
- [ ] Implement authentication middleware
- [ ] JWT token validation
- [ ] Check `required_perms` against user claims
- [ ] Add `/api/registry/export` endpoint
- [ ] Return `export()` JSON
- [ ] Used by clients for capability discovery
- [ ] Add `/api/health` endpoint

### 2.3 WebRTC Integration (External Signaling)

> [!IMPORTANT]> WebRTC uses **external signaling servers** (MQTT or Nostr) so users don't need to host public servers. Uses STUN/TURN for NAT traversal.

#### Signaling Options

Aurora supports two decentralized signaling strategies:**Option 1: MQTT (Message Queue Telemetry Transport)**

- Lightweight pub/sub messaging protocol
- Low latency, ideal for real-time signaling
- Many public brokers available (e.g., test.mosquitto.org, broker.hivemq.com)
- WebSocket-based connection

**Option 2: Nostr (Notes and Other Stuff Transmitted by Relays)**

- Decentralized relay network with censorship resistance
- Uses cryptographic identities (public/private keys)
- Encrypted signaling via Nostr events
- Many free public relays (e.g., relay.damus.io, nos.lol)
- Better privacy and resistance to blocking

#### Configuration

- [ ] Add config keys for WebRTC:
- [ ] `webrtc.enabled` (boolean, default: false)
- [ ] `webrtc.strategy` (string: "mqtt" | "nostr", default: "mqtt")
- [ ] `webrtc.app_id` (string, unique app identifier)
- [ ] `webrtc.room` (string, room/channel name)
- [ ] `webrtc.password` (string, for E2EE key derivation)
- [ ] `webrtc.stun_servers` (list of STUN server URLs)
- [ ] `webrtc.turn_servers` (list of TURN server URLs, optional)
- [ ] **MQTT-specific:**
    - [ ] `signaling_mqtt.brokers` (list of MQTT broker URLs)
    - [ ] `signaling_mqtt.topic_root` (string, default: "aurora")
    - [ ] `signaling_mqtt.username` (optional authentication)
    - [ ] `signaling_mqtt.password` (optional authentication)
- [ ] **Nostr-specific:**
    - [ ] `signaling_nostr.relays` (list of Nostr relay URLs)
    - [ ] `signaling_nostr.private_key` (hex-encoded private key for signing)
    - [ ] `signaling_nostr.public_key` (hex-encoded public key, derived from private)

#### Implementation

- [ ] Supervisor queries config on startup/reload
- [ ] Use `bus.request("Config.Get", key="webrtc.enabled")`
- [ ] Start/stop WebRTC client based on config
- [ ] Create signaling adapter interface
- [ ] Define `SignalingAdapter` protocol in `app/services/gateway/webrtc/signaling/base.py`
- [ ] Methods: `connect()`, `join_room()`, `send()`, `on_message()`, `leave()`, `close()`
- [ ] Implement MQTT signaling adapter
- [ ] Create `app/services/gateway/webrtc/signaling/mqtt_client.py`
- [ ] Connect to external MQTT broker via WebSocket
- [ ] Subscribe to topics: `{topic_root}/{app_id}/{room}/{presence|offer|answer|candidate}`
- [ ] Send signaling messages as MQTT publishes
- [ ] Implement AEAD encryption for signaling payload
- [ ] Implement Nostr signaling adapter
- [ ] Create `app/services/gateway/webrtc/signaling/nostr_client.py`
- [ ] Connect to Nostr relays via WebSocket
- [ ] Use **ephemeral events** (NIP-16, kind 20000-29999) for signaling to avoid relay storage
- [ ] Publish signaling as Nostr events:
    - [ ] `kind=20001` for presence announcements
    - [ ] `kind=20002` for SDP offers
    - [ ] `kind=20003` for SDP answers
    - [ ] `kind=20004` for ICE candidates
- [ ] Use **encrypted DMs** (NIP-04) for private peer-to-peer signaling
- [ ] Filter events by `app_id` and `room` tags
- [ ] Sign all events with user's private key
- [ ] Add aiortc-based WebRTC peer connection
- [ ] Use external STUN/TURN servers for NAT traversal
- [ ] Create data channels for RPC communication
- [ ] Create data channel message protocol
- [ ] JSON-RPC 2.0 format over data channel
- [ ] Map RPC calls to bus messages
- [ ] Check `exposure` and `required_perms` from registry
- [ ] Add connection authentication
- [ ] Token-based auth in signaling handshake
- [ ] Verify Nostr event signatures for identity
- [ ] Per-connection permission context
- [ ] Implement bi-directional event streaming
- [ ] Server → Client: Events matching client subscriptions
- [ ] Client → Server: Commands/queries

### 2.4 Process Mode Bus Bridge

> [!NOTE]> Redis message bus (`BullMQBus`) already exists in `app/messaging/bullmq_bus.py`.> [!WARNING]> **Streaming Audio Performance Considerations**>> When streaming audio chunks over the message bus (especially Redis), be aware of:> - **Serialization overhead**: Pydantic model serialization/deserialization adds latency (~1-5ms per message)> - **Redis network latency**: Round-trip to Redis adds ~1-10ms depending on network> - **Job queue overhead**: BullMQ adds job processing overhead (~5-20ms per job)> - **Throughput limits**: Redis can handle ~10k-100k msgs/sec, but audio streaming at 16kHz PCM = ~32 chunks/sec>> **Recommendation**: For real-time audio streaming in process mode, consider:> 1. Use larger chunk sizes (e.g., 100ms instead of 20ms) to reduce message count> 2. Use direct WebRTC data channels for audio (bypass bus entirely)> 3. Keep STT services in same process for local audio input> 4. Use bus only for transcription results, not raw audio

- [ ] Verify `BullMQBus` compatibility with contracts
- [ ] Test topic validation with contract registry
- [ ] Ensure works with both `InMemoryBus` and `BullMQBus`
- [ ] Add config for bus backend selection
- [ ] `messaging.backend` ("memory" | "redis")
- [ ] `messaging.redis_url` (for BullMQ backend)
- [ ] Update `Supervisor` to select bus backend from config
- [ ] Use `InMemoryBus` for thread mode (default)
- [ ] Use `BullMQBus` for process mode
- [ ] Ensure message serialization compatibility
- [ ] Verify Pydantic `model_dump()` and `model_validate()` work across processes

### 2.5 Client SDK Generation (Optional)

- [ ] Create `scripts/generate_client_sdk.py`
- [ ] Generate Python client from registry
- [ ] Type-safe client classes for each module
- [ ] HTTP and WebRTC transport options
- [ ] Generate TypeScript/JavaScript client (future)

### 2.6 Verification

- [ ] Unit test FastAPI route generation from contracts
- [ ] Unit test WebRTC data channel message handling
- [ ] Integration test:

1. Start Supervisor in process mode with `RUN_MODE=process`
2. Start TTS service as separate process
3. Make HTTP request to `/api/TTS/Request`
4. Verify TTS audio plays

- [ ] Manual test WebRTC connection:

1. Run Supervisor in process mode
2. Open WebRTC test client (HTML page)
3. Establish connection and send command
4. Verify bidirectional communication

**Commands**:

- `RUN_MODE=process python main.py` (start supervisor gateway)
- `python -m app.services.tts` (start TTS in separate process)
- `pytest tests/integration/supervisor_gateway/ -v`

---

## Phase 3: P2P and Remote Capabilities

**Goal**: Implement peer-to-peer discovery, registry negotiation, and capability sharing.

### 3.1 Registry Negotiation Protocol

- [ ] Implement `negotiate_compatibility()` function
- [ ] Input: Local registry export, remote registry export
- [ ] Output: Compatible module set with version ranges
- [ ] Use semantic versioning for compatibility checks
- [ ] Add `depends_on` validation
- [ ] Ensure all dependencies are satisfied
- [ ] Fail gracefully if incompatible
- [ ] Create contract adapter system
- [ ] Hook for transforming messages between versions
- [ ] Register adapters for backward compatibility

### 3.2 Remote Module Loading

- [ ] Create `RemoteModuleProxy` class
- [ ] Wraps a remote module as if it were local
- [ ] Publishes to bus with `origin="remote"`
- [ ] Forwards responses back to client
- [ ] Update Supervisor to load remote modules
- [ ] Read from peer registry
- [ ] Create proxy for each advertised capability
- [ ] Register in local registry with `remote=True` flag

### 3.3 Access Control and Permissions

- [ ] Implement ACL system
- [ ] Define permission schemas (e.g., `"tts:request"`, `"db:write"`)
- [ ] Store user/peer permissions in config or DB
- [ ] Add permission checking to bus publish
- [ ] Query registry for `required_perms`
- [ ] Check message origin's permission context
- [ ] Reject unauthorized messages
- [ ] Create permission UI (optional)
- [ ] Admin interface to grant/revoke peer permissions

### 3.4 P2P Discovery (External Signaling Services)

> [!IMPORTANT]> Use the same **external signaling** (MQTT or Nostr) from Phase 2 for P2P discovery. No need to host relay servers.

#### P2P Discovery Flow

1. **Join Discovery Room**: Peer connects to configured signaling service and joins a discovery room
2. **Advertise Capabilities**: Peer broadcasts presence with registry export (available modules/methods)
3. **Discover Peers**: Listen for presence announcements from other peers
4. **Negotiate Connection**: Exchange WebRTC SDP offers/answers via signaling
5. **Establish Direct P2P**: Create direct WebRTC data channel (bypassing signaling after connection)

#### MQTT-based P2P

- [ ] Peers subscribe to discovery topic: `{topic_root}/aurora/p2p/{discovery_room}/presence`
- [ ] Advertise capabilities as MQTT message with registry export
- [ ] Listen for other peers' announcements
- [ ] Initiate WebRTC connection via existing MQTT signaling

#### Nostr-based P2P (Recommended for censorship resistance)

- [ ] Peers query Nostr relays for discovery events:
- [ ] Use `kind=30001` (parameterized replaceable event) for persistent peer presence
- [ ] Tag events with `d:{discovery_room}` for discovery room
- [ ] Include registry export in event content
- [ ] Each peer publishes their own presence event
- [ ] Replaceable: updating the same event replaces previous version
- [ ] Includes: public key, capabilities (registry export), last seen timestamp
- [ ] Query relays for all presence events in discovery room
- [ ] Filter by `kind=30001` and `d:{discovery_room}` tag
- [ ] Initiate WebRTC connection using Nostr ephemeral events for signaling
- [ ] Send offer to peer's public key via encrypted DM
- [ ] Peer responds with answer
- [ ] **Advantages of Nostr for P2P:**
- [ ] No single point of failure (multiple relays)
- [ ] Censorship resistant (blocked relay? use another)
- [ ] Cryptographic identity (public keys as peer IDs)
- [ ] Free public relays available globally

#### Implementation

- [ ] Leverage existing signaling adapters for P2P
- [ ] Reuse MQTT or Nostr client from Phase 2
- [ ] Add discovery-specific methods: `advertise_capabilities()`, `discover_peers()`
- [ ] Implement peer-to-peer WebRTC connections
- [ ] Use STUN/TURN from config for NAT traversal
- [ ] Establish direct P2P data channel after signaling
- [ ] Fallback to TURN relay if direct connection fails
- [ ] Add P2P-specific config:
- [ ] `p2p.enabled` (boolean)
- [ ] `p2p.discovery_room` (room name for peer discovery)
- [ ] `p2p.advertise_interval_s` (how often to re-advertise, default: 60)
- [ ] Reuse `webrtc.strategy` ("mqtt" | "nostr")
- [ ] Reuse `webrtc.stun_servers` and `webrtc.turn_servers`

### 3.5 Capability Sharing Configuration

- [ ] Add `sharing` section to config
- [ ] `sharing.enabled` (boolean)
- [ ] `sharing.enabled_modules`: List of modules to share
- [ ] `sharing.access_control`: Permission rules per module/method
- [ ] Supervisor loads sharing config at startup
- [ ] Filter registry export to only advertise shared modules
- [ ] Enforce ACL on incoming P2P requests
- [ ] UI for toggling sharing (optional)
- [ ] Enable/disable modules for remote access
- [ ] View connected peers

### 3.6 Verification

- [ ] Unit test registry negotiation with compatible/incompatible versions
- [ ] Integration test remote module proxy:

1. Start Supervisor A (exposes TTS)
2. Start Supervisor B (no TTS, connects to A)
3. B requests TTS from A
4. Verify audio plays on A's hardware

- [ ] Manual test P2P:

1. Run two Aurora instances on different machines
2. Both connect to relay server
3. Instance B discovers Instance A
4. B uses A's STT capability
5. Verify transcription works

**Commands**:

- `pytest tests/integration/p2p/ -v`
- Manual P2P test requires 2+ devices on network

---

## Phase 4: Testing and Documentation

**Goal**: Ensure all changes are thoroughly tested and documented.

### 4.1 Test Coverage

- [ ] Achieve >80% coverage for contract registry
- [ ] Add integration tests for all migrated services
- [ ] Add end-to-end tests for each deployment mode:
- [ ] Local mode (thread)
- [ ] Server-client mode (process)
- [ ] P2P mode (relay + direct)

### 4.2 Performance and Stress Testing

#### Audio Streaming Performance Tests

> [!IMPORTANT]> Real-time audio processing is latency-sensitive. Bus performance must be validated for production use.**InMemoryBus Audio Streaming Test**

- [ ] Create `tests/performance/test_audio_streaming_inmemory.py`
- [ ] Test streaming 16kHz PCM audio (32 frames/sec, ~1KB/frame)
- [ ] Publish 1000 audio frames sequentially
- [ ] Measure: avg latency, p95 latency, p99 latency
- [ ] **Target**: p99 < 5ms for in-memory bus
- [ ] Test concurrent audio streams (3+ simultaneous streams)
- [ ] Verify no dropped frames
- [ ] Measure CPU usage
- [ ] Test burst scenarios (100 frames in 1 second)
- [ ] Verify queue doesn't back up

**BullMQBus (Redis) Audio Streaming Test**

- [ ] Create `tests/performance/test_audio_streaming_redis.py`
- [ ] Test streaming 16kHz PCM audio over Redis
- [ ] Publish 1000 audio frames
- [ ] Measure: avg latency, p95 latency, p99 latency
- [ ] **Target**: p99 < 50ms for Redis bus (10x slower than in-memory is acceptable)
- [ ] **Warning**: If p99 > 100ms, audio streaming over Redis is NOT recommended
- [ ] Test serialization overhead
- [ ] Measure `model_dump()` time for audio chunk (~1KB payload)
- [ ] Measure `model_validate()` time
- [ ] **Target**: < 1ms per operation
- [ ] Test Redis network latency
- [ ] Run Redis locally: measure latency
- [ ] Run Redis on same LAN: measure latency
- [ ] **Document**: Baseline latencies for different Redis configurations
- [ ] Test message size impact
- [ ] Compare 20ms chunks (~640 bytes) vs 100ms chunks (~3.2KB)
- [ ] Measure throughput difference
- [ ] **Recommendation**: Use larger chunks for Redis to reduce overhead

**Potential Pitfalls Documentation**

- [ ] Document in `docs/performance.md`:
- [ ] **Pitfall #1**: Small audio chunks (< 50ms) over Redis cause excessive overhead
    - [ ] Solution: Use 100-200ms chunks, or bypass bus for audio
- [ ] **Pitfall #2**: Redis on remote network adds unpredictable latency
    - [ ] Solution: Deploy Redis on same machine or local network
- [ ] **Pitfall #3**: BullMQ job processing adds minimum ~5ms latency
    - [ ] Solution: Not suitable for ultra-low-latency audio (< 10ms requirement)
- [ ] **Pitfall #4**: Large audio payloads (> 10KB) can cause Redis slowdowns
    - [ ] Solution: Use separate audio streaming channel (WebRTC data channel)
- [ ] **Pitfall #5**: Concurrent audio streams saturate Redis bandwidth
    - [ ] Solution: Limit concurrent streams or increase Redis resources

#### General Performance Tests

- [ ] Performance tests
- [ ] Message throughput on bus (msgs/sec)
- [ ] Latency for remote module calls
- [ ] WebRTC data channel bandwidth
- [ ] Load testing
- [ ] 1000 messages/sec sustained on InMemoryBus
- [ ] 100 messages/sec sustained on BullMQBus
- [ ] 10 concurrent WebRTC connections

### 4.3 Documentation

- [ ] Update `README.md` with deployment mode instructions
- [ ] Create `docs/architecture.md` detailing contract system
- [ ] Create `docs/deployment/local.md`
- [ ] Create `docs/deployment/server-client.md`
- [ ] Create `docs/deployment/p2p.md`
- [ ] Document contract authoring guide
- [ ] How to create a new module
- [ ] How to define method contracts
- [ ] Exposure and permission best practices
- [ ] Update API documentation
- [ ] Auto-generate from registry export
- [ ] OpenAPI/Swagger spec for HTTP endpoints

### 4.3 Migration Guide

- [ ] Create `docs/migration/v2.0.md`
- [ ] Document breaking changes
- [ ] Provide upgrade path for existing users
- [ ] Add deprecation warnings where applicable

### 4.4 Verification

- [ ] All tests pass: `pytest tests/ -v`
- [ ] Coverage report: `pytest --cov=app tests/`
- [ ] Documentation builds: `mkdocs build` (if using mkdocs)
- [ ] Manual walkthrough of all three deployment modes

---

## Cross-Cutting Concerns

### Logging and Observability

- [ ] Add contract metadata to all log messages
- [ ] Include `module`, `method`, `version` in log context
- [ ] Add metrics for contract usage
- [ ] Count invocations per method
- [ ] Track latency by contract
- [ ] Create observability dashboard (optional)

### Error Handling

- [ ] Standardize error responses across all contracts
- [ ] Add error codes to contract definitions
- [ ] Implement retry logic for commands (use `max_attempts` from contract)

### Configuration

- [ ] Add contract-related config options
- [ ] `contracts.validation_strict`: Fail on unknown methods
- [ ] `contracts.auto_export_path`: Auto-save registry to file
- [ ] Support runtime contract reloading (advanced)

---

## Implementation Order Summary

1. **Phase 0** (Foundation) - **MUST BE FIRST**
2. **Phase 1.1** (Merge STT services) - Quick win, reduces complexity
3. **Phase 1.2-1.9** (Migrate services one-by-one) - Iterative, low risk
4. **Phase 2** (Supervisor Gateway) - Enables server-client mode
5. **Phase 3** (P2P) - Most complex, depends on everything above
6. **Phase 4** (Testing/Docs) - Ongoing throughout, finalize at end

Each phase should be verified independently before proceeding to the next.---

## Acceptance Criteria

- [ ] All services use `@method_contract` decorator (no manual topic registration)
- [ ] `export()` produces complete registry JSON with digest
- [ ] Supervisor runs in both thread and process modes
- [ ] FastAPI gateway auto-exposes external methods
- [ ] WebRTC bidirectional communication works
- [ ] Two Aurora instances can share capabilities via P2P
- [ ] Access control enforces permissions correctly
- [ ] Test coverage >80% for all new code
- [ ] Documentation complete for all deployment modes

---

## Risk Assessment

| Risk | Impact | Mitigation ||------|--------|------------|| Registry abstraction too complex | High | Start minimal (Phase 0), iterate || Breaking changes for existing users | Medium | Maintain backward compat layer || Performance degradation from indirection | Low | Benchmark, optimize hot paths || P2P reliability on consumer networks | High | Implement robust retry, fallback to relay || Security vulnerabilities in WebRTC/API | High | Mandatory auth, regular security audits |---

## Notes

- Keep `app/services/` structure for now (per user request)
- EventRegistry will be **replaced** (not deprecated) once all services migrate