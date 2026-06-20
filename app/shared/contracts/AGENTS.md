# Contract System -- Agent Guide

> **Scope**: `app/shared/contracts/` -- Contract registry, IO models, and topic constants.
> **Parent**: [Shared AGENTS.md](../AGENTS.md); [Root AGENTS.md](../../../AGENTS.md).
> **Related**: [Messaging AGENTS.md](../../messaging/AGENTS.md) for bus usage rules.

---

## CRITICAL RULES

### 1. Every Bus Topic MUST Have a Typed Constant

Before using a topic anywhere in service code, it MUST exist as a constant in a `*Methods` or `*Events` class in this directory.

```python
# CORRECT -- add constant first, then use it
class AuthMethods:
    STORE_AUDIT_EVENT = f"{AuthModule.NAME}.StoreAuditEvent"

# Then in service code:
await bus.request(AuthMethods.STORE_AUDIT_EVENT, payload)
```

```python
# WRONG -- literal string topic
await bus.publish("Auth.AuditEvent", payload)
```

### 2. Adding a New Topic

1. Open the appropriate file in `app/shared/contracts/models/` (e.g., `auth.py` for Auth topics)
2. Add the constant to the `*Methods` class (for request/response) or `*Events` class (for broadcast events)
3. Create the Pydantic IO models (`*Request`, `*Response`) in the same file
4. Only then use the constant in service code

### 3. IO Models Extend `IOModel`, Not `BaseModel`

```python
from app.shared.contracts.registry import IOModel  # NOT from pydantic

class MyRequest(IOModel):
    param: str

# Exception: Simple models in auth.py/mesh.py use BaseModel for historical reasons
```

---

## File Layout

One file per service module:

| File | Service | Methods Class | Key Models |
|------|---------|--------------|------------|
| `auth.py` | Auth | `AuthMethods` | Login, Pairing, Principal, Token, Device, Audit, MeshCredential models |
| `config.py` | Config | `ConfigMethods` | ConfigGet/Set Request/Response |
| `db.py` | DB | `DBMethods` | Message, RAG, CronJob, User, Device, Token, Audit, MeshCredential, ExecuteSQL models |
| `gateway.py` | Gateway | `GatewayMethods` | ServiceAnnouncement, MethodInfo, ServiceInfo |
| `mesh.py` | Mesh | `MeshEvents` | MeshPeerInfo, peer CRUD models, PairingRequestedEvent |
| `orchestrator.py` | Orchestrator | `OrchestratorMethods` | ProcessRequest, Response |
| `scheduler.py` | Scheduler | `SchedulerMethods` | Schedule, Cancel, ListJobs models |
| `stt.py` | STT | `STTMethods`, `WakeWordMethods`, `TranscriptionMethods` | Session, transcription, control models |
| `supervisor.py` | Supervisor | `SupervisorMethods` | Status, service control models |
| `tooling.py` | Tooling | `ToolingMethods` | GetTools, ExecuteTool, MCP models |
| `tts.py` | TTS | `TTSMethods` | TTSRequest, Synthesize, Status models |
| `audio.py` | Audio | `AudioInputMethods` | AudioInputControl |
| `common.py` | Shared | -- | EmptyInput, EmptyOutput, ErrorOutput, HealthCheckResponse |

---

## Methods Class Pattern

Each service module defines a `*Module` identifier and a `*Methods` class:

```python
class TTSModule:
    NAME = "TTS"

class TTSMethods:
    REQUEST = f"{TTSModule.NAME}.Request"       # "TTS.Request"
    STOP = f"{TTSModule.NAME}.Stop"             # "TTS.Stop"
    STARTED = f"{TTSModule.NAME}.Started"       # "TTS.Started"
    HEALTH_CHECK = f"{TTSModule.NAME}.HealthCheck"
```

For broadcast-only events (not request/response), use `*Events`:

```python
class MeshEvents:
    PEER_APPROVED = "Mesh.PeerApproved"
    PEER_PERMISSIONS_UPDATED = "Mesh.PeerPermissionsUpdated"
```

---

## Contract Registration

Services register contracts via the `@method_contract` decorator:

```python
from app.shared.contracts.registry import method_contract

@method_contract(
    method_id=TTSMethods.REQUEST,        # MUST use typed constant
    summary="Request TTS synthesis",
    input_model=TTSRequest,              # Pydantic model
    output_model=TTSResponse,            # Pydantic model
    exposure="both",                     # "internal" | "external" | "both"
    method_type="use",                   # "use" | "manage"
    required_perms=["TTS.Request"],      # Permission strings
)
async def handle_request(self, data: TTSRequest) -> TTSResponse:
    ...
```

### Exposure Levels

| Level | HTTP API | WebRTC RPC | Internal Bus |
|-------|----------|------------|-------------|
| `"internal"` | No | No | Yes |
| `"external"` | Yes | Yes | Yes |
| `"both"` | Yes | Yes | Yes |

### Method Types

| Type | Purpose | Permission Pattern |
|------|---------|-------------------|
| `"use"` | Normal operations | `Service.use` or specific `Service.Action` |
| `"manage"` | Admin operations | `Service.manage` or `Auth.manage` |

---

## Complete Inventory of Topic Constants

### AuthMethods (`auth.py`)
`LOGIN`, `LOGOUT`, `VALIDATE_TOKEN`, `REFRESH_TOKEN`, `WHO_AM_I`, `PAIRING_START`, `PAIRING_CONNECT`, `PAIRING_APPROVE`, `PAIRING_EXCHANGE`, `LIST_PRINCIPALS`, `CREATE_PRINCIPAL`, `GET_PRINCIPAL`, `UPDATE_PRINCIPAL`, `DELETE_PRINCIPAL`, `SET_PERMISSIONS`, `PATCH_PERMISSIONS`, `CHANGE_PASSWORD`, `LIST_TOKENS`, `CREATE_TOKEN`, `UPDATE_TOKEN_SCOPES`, `REVOKE_TOKEN`, `LIST_DEVICES`, `DELETE_DEVICE`, `AUDIT_LOG`, `STORE_AUDIT_EVENT`, `PAIRING_REQUESTED`, `SAVE_MESH_CREDENTIAL`, `LOAD_MESH_CREDENTIAL`, `DELETE_MESH_CREDENTIAL`, `LOAD_MESH_IDENTITY`, `SAVE_MESH_IDENTITY`, `MESH_UPSERT_PEER`, `MESH_LIST_PEERS`, `MESH_GET_PEER`, `MESH_APPROVE_PEER`, `MESH_DENY_PEER`, `MESH_UPDATE_PEER_PERMISSIONS`, `MESH_REMOVE_PEER`, `MESH_SAVE_INBOUND_CREDENTIAL`, `MESH_LOAD_INBOUND_CREDENTIALS`, `MESH_UPDATE_PEER_CONNECTION`

### MeshEvents (`mesh.py`)
`PEER_APPROVED`, `PEER_PERMISSIONS_UPDATED`

### ConfigMethods (`config.py`)
`GET`, `SET`, `UPDATED`, `ERROR`, `SET_PLUGIN`, `GET_PLUGIN`, `VALIDATE`, `RELOAD_SERVICE`, `HEALTH_CHECK`

### DBMethods (`db.py`)
`SAVE_MESSAGE`, `GET_MESSAGES`, `GET_MESSAGES_FOR_DATE`, `DELETE_MESSAGE`, `UPDATE_MESSAGE`, `RAG_SEARCH`, `RAG_STORE`, `RAG_DELETE`, `RAG_GET`, `RAG_LIST`, `SAVE_CRON_JOB`, `GET_CRON_JOBS`, `DELETE_CRON_JOB`, `HEALTH_CHECK`, `CREATE_USER`, `GET_USER_BY_USERNAME`, `GET_USER_BY_ID`, `COUNT_USERS`, `LIST_USERS`, `UPDATE_USER`, `DELETE_USER`, `CREATE_DEVICE`, `GET_DEVICE_BY_ID`, `LIST_DEVICES`, `DELETE_DEVICE`, `CREATE_TOKEN`, `GET_TOKEN_BY_HASH`, `GET_TOKEN_BY_ID`, `LIST_TOKENS`, `UPDATE_TOKEN_SCOPES`, `REVOKE_TOKEN`, `GET_AUDIT_LOG`, `COUNT_AUDIT_EVENTS`, `SAVE_MESH_CREDENTIAL`, `GET_MESH_CREDENTIAL_BY_ROOM`, `DELETE_MESH_CREDENTIAL`, `EXECUTE_SQL`

### TTSMethods (`tts.py`)
`REQUEST`, `SYNTHESIZE`, `STOP`, `PAUSE`, `RESUME`, `STARTED`, `STOPPED`, `PAUSED`, `RESUMED`, `ERROR`, `HEALTH_CHECK`

### STTMethods (`stt.py`)
`SESSION_STARTED`, `SESSION_ENDED`, `USER_SPEECH_CAPTURED`, `LISTEN`, `STOP_LISTENING`, `AUDIO`, `CONTROL`, `DETECTED`, `PARTIAL`, `FINAL`, `ERROR`, `TIMEOUT`, `HEALTH_CHECK`

### WakeWordMethods (`stt.py`)
`DETECTED`, `CONTROL`, `PROCESS_AUDIO`, `DETECT`, `HEALTH_CHECK`

### TranscriptionMethods (`stt.py`)
`RESULT`, `CONTROL`, `PROCESS_AUDIO`, `TRANSCRIBE`, `HEALTH_CHECK`, `ERROR`

### OrchestratorMethods (`orchestrator.py`)
`USER_INPUT`, `EXTERNAL_USER_INPUT`, `TOOL_RESULT`, `RESPONSE`, `HEALTH_CHECK`

### ToolingMethods (`tooling.py`)
`GET_TOOLS`, `GET_TOOL_BY_NAME`, `GET_STATS`, `GET_MCP_STATUS`, `EXECUTE_TOOL`, `RELOAD_MCP_TOOLS`, `HEALTH_CHECK`, `TOOLS_INITIALIZED`, `TOOLS_RELOADED`

### SchedulerMethods (`scheduler.py`)
`SCHEDULE`, `CANCEL`, `PAUSE`, `RESUME`, `LIST_JOBS`, `JOB_FIRED`, `JOB_COMPLETED`, `HEALTH_CHECK`

### GatewayMethods (`gateway.py`)
`SERVICE_ANNOUNCE`, `SERVICE_DEPART`, `SERVICE_HEARTBEAT`, `GET_REGISTRY`, `GET_SERVICES`, `GET_SERVICE_HEALTH`, `GET_DEPLOYMENT_TOPOLOGY`, `GET_WEBRTC_DIAGNOSTICS`

### SupervisorMethods (`supervisor.py`)
`GET_STATUS`, `RESTART_SERVICE`, `STOP_SERVICE`, `START_SERVICE`, `HEALTH`, `HEALTH_CHECK`

### AudioTopics (`app/messaging/audio_messages.py`)
`STREAM_MICROPHONE`, `STREAM_WEBSOCKET`, `STREAM_FILE`, `STREAM_GENERIC`, `CONTROL`, `STARTED`, `STOPPED`
