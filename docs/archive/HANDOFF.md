# Aurora Project — Comprehensive Agent Handoff

**Generated:** April 2026
**Workspace:** `/home/developer/projects/aurora` (primary), `/home/developer/projects/aurora2` (mesh/auth branch)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Layout](#2-repository-layout)
3. [Two Workspaces Explained](#3-two-workspaces-explained)
4. [Schema-First Config (Completed)](#4-schema-first-config-completed)
5. [Distributed System / Mesh Networking (Completed in aurora2)](#5-distributed-system--mesh-networking)
6. [Auth / RBAC System (Completed in aurora2)](#6-auth--rbac-system)
7. [Gateway Architecture](#7-gateway-architecture)
8. [WebRTC / Signaling](#8-webrtc--signaling)
9. [Messaging System](#9-messaging-system)
10. [Deployment Stack](#10-deployment-stack)
11. [Uncommitted Work in aurora](#11-uncommitted-work-in-aurora)
12. [Known Issues & TODOs](#12-known-issues--todos)
13. [Key File Reference](#13-key-file-reference)
14. [Development Commands](#14-development-commands)

---

## 1. Project Overview

Aurora is a **privacy-first, modular voice assistant** built as a microservices architecture in Python 3.10-3.11. Services communicate exclusively via a message bus (LocalBus for threads mode, BullMQBus for process/Docker mode, MeshBus for distributed P2P).

### Core Capabilities
- Real-time speech-to-text (faster-whisper, OpenWakeWord)
- Text-to-speech (Piper TTS)
- LLM orchestration (LangChain/LangGraph — OpenAI, HuggingFace, llama.cpp)
- Tool calling (MCP, Brave Search, Jira, GitHub, Slack, Gmail, GCalendar)
- Vector database / RAG (SQLite + sqlite-vec)
- P2P mesh networking (WebRTC DataChannels, MQTT signaling)
- RBAC with bilateral peer trust

### Architecture Modes
| Mode | Bus | Orchestrator | Use Case |
|------|-----|-------------|----------|
| **Threads** (default) | `LocalBus` (asyncio queues) | `Supervisor` in-process | Development, testing |
| **Processes** | `BullMQBus` (Redis) | Docker Compose | Production, Docker |
| **Mesh** | `MeshBus` (wraps inner bus) | Gateway + WebRTC | Distributed P2P |

---

## 2. Repository Layout

```
aurora/
├── app/
│   ├── helpers/              # aurora_logger.py, getGoogleCredentials.py
│   ├── messaging/            # Bus implementations (local, bullmq, mesh)
│   │   └── AGENTS.md         # Messaging subsystem guide
│   ├── services/
│   │   ├── auth/             # Standalone auth service (RBAC, pairing, tokens)
│   │   ├── config/           # ConfigService + ConfigManager + schema + defaults
│   │   ├── db/               # DBService + RAG + migrations
│   │   ├── gateway/          # FastAPI + WebRTC + mesh subsystem
│   │   │   ├── mesh/         # 9 files: routing, bridging, negotiation, latency
│   │   │   └── webrtc/       # RTCClient, RPC handler, MQTT signaling
│   │   ├── orchestrator/     # LLM orchestration + chatbot agent
│   │   ├── scheduler/        # Cron jobs
│   │   ├── stt_coordinator/  # Audio input coordination
│   │   ├── stt_transcription/# Whisper transcription
│   │   ├── stt_wakeword/     # Wake word detection
│   │   ├── tooling/          # Tool manager + MCP client + plugin tools
│   │   └── supervisor.py     # Service lifecycle manager
│   ├── shared/
│   │   ├── auth/             # Identity, Permissions, Audit primitives
│   │   ├── config/           # ConfigAPI (interface.py), generated models + keys
│   │   ├── contracts/        # Method contracts, IO models per service
│   │   ├── messaging/        # Shared message models
│   │   ├── models/           # DB entity models
│   │   └── services/         # BaseService, process_launcher
│   └── ui/                   # Optional PyQt6 bridge
├── docker/services/          # 11 Dockerfiles (one per service)
├── docs/                     # Architecture, gateway, messaging, pairing docs
│   └── plans/                # Implementation plans
├── scripts/                  # Generation, docker, tilt helpers
├── tests/unit/               # ~600 unit tests
├── config.json               # Local config (gitignored, copied from defaults)
├── Tiltfile                  # Tilt dev orchestration
├── docker-compose.process.yml
├── docker-compose.tilt.yml   # Hot-reload overlay
└── main.py                   # Entry point (threads mode)
```

---

## 3. Two Workspaces Explained

### `/home/developer/projects/aurora` — Primary workspace

**Branch:** `feat/migration-to-modular-services-architecture`

Contains the merged mesh/auth work PLUS the **Schema-First Config** implementation (uncommitted). This is the workspace where all active development happens.

**Git state:** 39+ uncommitted files implementing:
- Schema-first config (complete — all 7 phases)
- Runtime config-driven service lifecycle (in-progress in BaseService/Supervisor/BullMQBus)
- Tilt/Docker improvements

### `/home/developer/projects/aurora2` — Mesh/auth reference

**Branch:** `feature/webrtc-gateway-setup-integration`

An earlier branch snapshot with the mesh networking and auth service work. This is a **reference copy** — all its changes have been merged into `aurora` via commit `6165377`. It contains planning docs (`AUTH_SERVICE_MIGRATION_PLAN.md`, `MULTI_TENANCY_ROADMAP.md`, `DISTRIBUTED_SYSTEM_DESIGN_PROPOSAL.md`) that are useful context.

**Rule:** Make changes in `aurora`, not `aurora2`.

---

## 4. Schema-First Config (Completed)

### What Was Done

The entire config system was migrated from hand-maintained Pydantic models with scattered string-literal config paths to a **schema-first** approach where `config_schema.json` is the single source of truth.

### Architecture

```
config_schema.json (hand-maintained, 1229 lines)
        │
        ├──[datamodel-code-generator]──► models.py (916 lines, 41 Pydantic classes)
        │
        ├──[generate_keys()]──────────► keys.py (941 lines, nested ConfigPath hierarchy)
        │
        └──[generate_defaults()]──────► config_defaults.json (297 lines)

All generated by: make generate-config
CI enforced by:    make check-config-generated
```

### Generated Artifacts

| File | Purpose | Key Details |
|------|---------|-------------|
| `app/shared/config/models.py` | Pydantic models | 41 classes, root=`Model`, all inherit `BaseConfigModel(extra='ignore')` |
| `app/shared/config/keys.py` | Typed config paths | `ConfigKeys.services.tts.model_file_path` → `"services.tts.model_file_path"` |
| `app/shared/config/models_base.py` | Base class | `extra='ignore'` for forward-compat in distributed systems |
| `app/services/config/config_defaults.json` | Default values | Extracted from schema `default` fields |

### ConfigAPI Typed Access Pattern

```python
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Tts

# Typed — returns Tts instance with IDE autocomplete
tts_cfg = await config_api.aget(ConfigKeys.services.tts, Tts)
path = tts_cfg.model_file_path

# Scalar leaf — returns raw value
enabled = await config_api.aget(ConfigKeys.services.tts.enabled, default=True)
```

The `aget()` and `get()` methods have `@overload` signatures:
- `aget(key, model: type[T]) -> T` — validates section dict into Pydantic model
- `aget(key, default=...) -> Any` — raw value access (backward-compatible)

### Services Fully Migrated

Every service uses `ConfigKeys` + typed Pydantic models:

| Service | Model(s) Used |
|---------|---------------|
| TTS | `Tts` |
| STT Coordinator | `Coordinator`, `AmbientTranscription`, `AudioInput` |
| STT Wakeword | `Wakeword` |
| STT Transcription | `Stt`, `Transcription`, `RealtimeModel`, `AccurateModel` |
| Orchestrator | `Orchestrator` (aliased), `Llm`, `Local`, `LlamaCpp`, `HuggingfacePipeline`, etc. |
| DB / RAG | `Db`, `Embeddings` |
| Auth | `Auth` (aliased as `AuthConfigModel`) |
| Gateway | `Gateway` (aliased as `GatewayConfigModel`), `Auth`, `MeshSharing` |
| Tooling | `Tooling`, `Mcp`, `Plugins` |
| Brave Search | `Tooling`, `Plugins`, `BraveSearch` |
| Google Credentials | `Tooling`, `Plugins`, `Google`, `Gmail`, `Gcalendar` |
| main.py | `ConfigKeys` (leaf access only) |

### ConfigManager Validation

Dual validation in `config_manager.py`:
1. **Pydantic strict** — `AppConfig.model_validate(config_data)` (raises on failure)
2. **JSON Schema advisory** — `jsonschema.Draft7Validator` against `config_schema.json` (logs warnings for constraints Pydantic can't model, e.g., `patternProperties`, `if/then`)

### CI Enforcement

`.github/workflows/lint.yml` runs `make check-config-generated` which:
1. Snapshots current `models.py`, `keys.py`, `config_defaults.json`
2. Regenerates all three from `config_schema.json`
3. Fails CI if any file differs

### Config Layout

Top-level: `ui`, `system`, `services`

```
services.
├── gateway.{enabled, api.{host,port,cors,token_secret,...}, mesh_network.{...}, webrtc.{...}, signaling_mqtt.{...}}
├── auth.{enabled, mesh_sharing, pairing_timeout_s, token_expiry_days, ...}
├── tts.{enabled, mesh_sharing, model_file_path, model_sample_rate, hardware_acceleration, ...}
├── stt.{language, hardware_acceleration, coordinator.{...}, wakeword.{...}, transcription.{...}}
├── orchestrator.{enabled, mesh_sharing, hardware_acceleration, llm.{provider, third_party.{...}, local.{...}}}
├── db.{enabled, mesh_sharing, embeddings.{use_local}}
├── tooling.{enabled, mesh_sharing, mcp.{enabled, servers}, plugins.{google,jira,openrecall,brave_search,...}}
├── scheduler.{enabled, mesh_sharing}
└── config.{enabled, mesh_sharing}
```

### Env Variable Fallback

43 env vars in `ENV_CONFIG_MAP` (`app/services/config/env_config.py`) provide `.env` overrides for config values. Resolution: `config.json` → `.env` mapping → schema default.

---

## 5. Distributed System / Mesh Networking

### Overview

Aurora instances can form a P2P mesh where services are selectively shared. Each instance advertises its available services via manifests; peers negotiate which services to share and route bus messages across WebRTC DataChannels.

### Mesh Components (in `app/services/gateway/mesh/`)

| File | Purpose |
|------|---------|
| `peer_registry.py` | Track connected peers, manifests, latency, stale detection; DB persistence |
| `routing_table.py` | Resolve bus topics to local/remote targets based on config + peer state |
| `peer_bridge.py` | Outbound RPC calls and event forwarding via WebRTC DataChannels |
| `negotiation.py` | Manifest generation, parsing, ACK with compatibility report |
| `latency.py` | Periodic ping/pong RTT measurement |
| `announcer.py` | Periodic manifest re-announcement |
| `version_compat.py` | Semver comparison with `exact`/`compatible`/`any` policies |
| `models.py` | Mesh-specific Pydantic models |

### MeshBus Routing (`app/messaging/mesh_bus.py`)

Wraps the inner bus (LocalBus or BullMQBus):

- **Commands** (`event=False`): `RoutingTable.resolve()` decides local vs. remote based on per-service `mesh_sharing` config (`prefer: local|network`, `fallback: local|network|none`)
- **Events** (`event=True, mesh=True`): Delivered locally first, then forwarded to all negotiated peers if the service has `share: true`
- **Loop prevention**: Events with `origin="mesh_forwarded"` are never re-forwarded

### Manifest Protocol

After WebRTC authentication, peers exchange manifests over DataChannels:

```
Peer A                              Peer B
  │──── manifest (services, versions) ────►│
  │◄──── manifest_ack (compat report) ─────│
  │◄──── manifest (their services) ────────│
  │──── manifest_ack ──────────────────────►│
```

Additional protocol messages: `ping`/`pong`, `event` (fire-and-forget), `capacity_update`, `call`/`result`/`error` (JSON-RPC).

### Per-Service Sharing Config

Each service has a `mesh_sharing` block in config:

```json
{
  "share": false,
  "max_concurrent": 10,
  "prefer": "local",
  "fallback": "local"
}
```

`prefer` and `fallback` control routing: `local` (use own service), `network` (use remote peer), `local_only` / `network_only` (no fallback).

### DB Tables for Mesh State

**`mesh_identity`** (singleton): Stable `peer_id` + `node_name` for this instance.

**`mesh_peers`**: Bilateral relationship state per known remote peer:
- Outbound (what WE grant THEM): `outbound_status`, `outbound_permissions`, FK to `users`/`devices`/`tokens`
- Inbound (what THEY grant US): `inbound_status`, `inbound_token`, `inbound_permissions`
- Connection tracking: `connection_status`, `first_seen_at`, `last_seen_at`

**Design rule:** All mesh state lives in DB, never in config files. Peer records never expire.

---

## 6. Auth / RBAC System

### Architecture

Auth is a **standalone service** (`app/services/auth/`) extracted from Gateway. It has **39 method contracts** covering:
- Login/logout, token validation
- Pairing (5-step state machine with bilateral mesh pairing)
- Principal CRUD (users, devices, tokens)
- Permission management
- Audit event storage
- Mesh peer CRUD (approve, deny, update permissions, remove)

### Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `app/services/auth/service.py` | ~1019 | 39 `@method_contract` handlers, `on_start`/`on_stop` lifecycle |
| `app/services/auth/auth_manager.py` | ~1374 | Core logic: pairing FSM, token issuance, principal CRUD, `_MeshSQL` helper |
| `app/shared/auth/identity.py` | ~70 | `Identity` dataclass with `can()`, `has_permission()`; sentinels: `ANONYMOUS`, `SYSTEM`, `OPEN_PEER` |
| `app/shared/auth/permissions.py` | ~270 | Permission matching: wildcards, type-based (`Auth.use`/`Auth.manage`), `KNOWN_PERMISSIONS` auto-generated from `*Methods` classes |
| `app/shared/auth/audit.py` | ~30 | `audit_event()` fire-and-forget helper |
| `app/shared/contracts/models/auth.py` | ~500+ | `AuthModule`, `AuthMethods` (39 constants), all Pydantic I/O models |

### Permission Model

Three granularity levels:
- `*` — superuser wildcard
- `Auth.*` — service-level wildcard
- `Auth.use` / `Auth.manage` — type-based (matches methods by `method_type` attribute)
- `Auth.PairingApprove` — granular per-method

**Bus topics ARE permissions** — unified namespace. Every `@method_contract` has a `method_type` ("use" or "manage") enabling coarse-grained access control.

### Pairing Flow

5-step in-memory state machine (5-minute expiry):

1. `Auth.PairingStart` → 6-digit code
2. Remote polls `Auth.PairingConnect`
3. Admin approves via `Auth.PairingApprove`
4. Remote calls `Auth.PairingExchange` → creates User + Device + Token in DB
5. **Bilateral**: `_reverse_pairing()` auto-triggers so both admins independently approve

### Token Validation

`Auth.ValidateToken` (internal exposure):
1. SHA-256 hash token → DB lookup → check expiry
2. Build `Identity` with `effective_perms = wildcard_intersection(user.permissions, token.scopes)`
3. Return `ValidateTokenResponse` with `principal_id`, `is_admin`, `permissions`, `effective_perms`

### Envelope Identity

The `Envelope` in `app/messaging/bus.py` carries `principal_id: str | None = None`. Transport layers (HTTP middleware, WebRTC RPC handler, mesh bridge) inject the caller's identity. This enables identity-aware bus routing and permission checks.

---

## 7. Gateway Architecture

### Subsystems

| Subsystem | Files | Purpose |
|-----------|-------|---------|
| **FastAPI** | `fastapi_app.py`, `auth.py`, `config.py` | HTTP API, token auth middleware, CORS |
| **WebRTC** | `webrtc/rtc_client.py`, `webrtc/rpc.py`, `webrtc/__init__.py` | Peer connections, JSON-RPC handler |
| **Mesh** | `mesh/` (9 files) | P2P routing, bridging, negotiation |
| **Signaling** | `webrtc/mqtt_client.py` | MQTT-based WebRTC signaling (offers/answers/ICE) |
| **Auth Proxy** | `auth_proxy.py` | Transitional bus-based auth adapter for RTCClient |

### HTTP Auth Flow

1. Request arrives at FastAPI
2. `auth.py` middleware extracts Bearer token
3. Calls `Auth.ValidateToken` via bus
4. Injects `Identity` into request state
5. Route handler checks permissions

### RPC Auth Gate

Anonymous WebRTC peers can only call:
- `auth` / `reauth` messages
- `Auth.PairingStart`, `Auth.PairingConnect`, `Auth.PairingExchange`, `Auth.Login`

All other RPC calls from `ANONYMOUS` peers return 401.

### Auto-Generated HTTP Routes

`RouteGenerator` in the gateway auto-generates REST endpoints from `@method_contract` definitions. No hand-crafted routers needed for contract-based services.

---

## 8. WebRTC / Signaling

### Signaling via MQTT

- Broker configured in `services.gateway.signaling_mqtt` (host, port, username, password)
- Room-based topic structure: `aurora/{room}/offer`, `aurora/{room}/answer`, `aurora/{room}/ice`
- Optional encrypted signaling via Scrypt + HKDF derived keys

### Encrypted Signaling

When `services.gateway.webrtc.encrypt_signaling` is enabled:
- Room keys derived: `k_enc` (data encryption), `k_sig` (signaling encryption)
- MQTT presence messages sealed with `aead_seal(k_sig, payload)`
- DataChannel messages optionally encrypted with AES-GCM
- Room names and passwords auto-generated if empty/default

### WebRTC Peer Lifecycle

1. MQTT discovery → SDP offer/answer exchange
2. ICE candidate exchange → DataChannel opens
3. Auth handshake over DataChannel (token-based)
4. Manifest exchange → service negotiation
5. Ongoing: ping/pong, RPC calls, event forwarding
6. Cleanup on disconnect

### STUN/TURN

Configurable in `services.gateway.webrtc.stun_servers` and `turn_servers`.

---

## 9. Messaging System

### Bus Implementations

| Bus | Backend | Use Case |
|-----|---------|----------|
| `LocalBus` | asyncio queues | Threads mode (dev) |
| `BullMQBus` | Redis (BullMQ protocol) | Process mode (Docker) |
| `MeshBus` | Wraps inner bus + WebRTC DataChannels | Distributed P2P |

### Message Types

- **Command** (`event=False`): Request/response, single handler, returns result
- **Event** (`event=True`): Fire-and-forget, multiple subscribers, concurrent delivery
- **Query** (`event=False` via `request()`): Command with return value, supports timeout

### Envelope

```python
class Envelope(BaseModel):
    topic: str
    payload: Any
    event: bool = True
    priority: int = 0
    principal_id: str | None = None  # Identity-aware messaging
```

### Priority System

Three tiers: Interactive (90-100) > System (50-70) > External (10-30). Use `get_interactive_priority()`, `get_system_priority()` helpers.

### Contract System

Every service method is registered via `@method_contract`:

```python
@method_contract(
    method_id=TTSMethods.REQUEST,
    summary="Synthesize speech",
    input_model=TTSRequest,
    output_model=TTSResponse,
    exposure="public",        # public | internal | mesh
    method_type="use"         # use | manage (for RBAC)
)
async def handle_tts_request(self, data: TTSRequest) -> TTSResponse: ...
```

---

## 10. Deployment Stack

### Docker Process Mode

12 services in separate containers, orchestrated by Docker Compose:

```
redis → config → db → auth → tooling → scheduler → tts
                                                   → stt-wakeword
                                                   → stt-transcription
                                                   → stt-coordinator
                                                   → orchestrator → gateway
```

**No supervisor container** — Compose is the orchestrator.

Each service has its own Dockerfile in `docker/services/Dockerfile.<name>` with entrypoint `python -m app.services.<name>`.

### Tilt (Dev Overlay)

`tilt up` from repo root. Uses `docker-compose.tilt.yml` overlay for:
- Hot reload via `watchmedo` watching `app/` and `modules/`
- Per-service log levels (UI buttons in Tilt dashboard)
- Config-driven service enable/disable (reads `services.<name>.enabled` from `config.json`)
- Build-arg derivation from config (DB embeddings mode, LLM mode, hardware acceleration)
- Optional ngrok tunnel

### MCP Servers (`.cursor/mcp.json`)

- **tilt-mcp** (v0.1.3): Tilt stack health, resource status, log streaming
- **gitnexus**: Code knowledge graph (3585 symbols, 11757 relationships, 293 execution flows)

### Build Args

| Dockerfile | Build Arg | Derived From |
|-----------|-----------|--------------|
| `Dockerfile.db` | `DB_EMBEDDINGS_MODE` | `services.db.embeddings.use_local` |
| `Dockerfile.orchestrator` | `ORCHESTRATOR_LLM_MODE`, `ORCHESTRATOR_HARDWARE` | `services.orchestrator.llm.provider`, `hardware_acceleration` |
| `Dockerfile.tts` | `TTS_HARDWARE` | `services.tts.hardware_acceleration` |
| `Dockerfile.transcription` | `STT_TRANSCRIPTION_HARDWARE` | `services.stt.transcription.hardware_acceleration` |
| `Dockerfile.wakeword` | `STT_WAKEWORD_HARDWARE` | `services.stt.wakeword.hardware_acceleration` |

---

## 11. Uncommitted Work in aurora

The working tree has **significant uncommitted changes** beyond the schema-first config work:

| Area | Files | Description |
|------|-------|-------------|
| **Schema-first config** | 30+ files | Complete implementation of all 7 phases (this session's work) |
| **BaseService lifecycle** | `base_service.py` | +262 lines — runtime config-driven service lifecycle refactor |
| **BullMQBus** | `bullmq_bus.py` | +240 lines — correlation/reply improvements |
| **Supervisor** | `supervisor.py` | +137 lines — service enable/disable at runtime |
| **Tiltfile** | `Tiltfile` | Config-driven service enable/disable |
| **Docker** | Multiple Dockerfiles | Build arg / layer improvements |

### What This Session Changed (Schema-First Config)

Files modified in the current session:

**Core infrastructure:**
- `app/shared/config/interface.py` — `@overload` signatures for `aget()`/`get()` with model parameter
- `app/shared/config/models.py` — generated (41 Pydantic classes)
- `app/shared/config/keys.py` — generated (nested ConfigPath hierarchy)
- `app/shared/config/models_base.py` — `BaseConfigModel(extra='ignore')`
- `app/services/config/config_manager.py` — dual Pydantic + JSON Schema validation
- `app/services/config/config_schema.json` — rewritten to `services.*` layout (1229 lines)
- `app/services/config/config_defaults.json` — regenerated from schema
- `scripts/generate_config_artifacts.py` — generation pipeline (5 stages)
- `.github/workflows/lint.yml` — `make check-config-generated` CI step

**All migrated services:**
- `app/services/tts/service.py`, `tts_engine.py`
- `app/services/stt_coordinator/service.py`
- `app/services/stt_wakeword/service.py`
- `app/services/stt_transcription/service.py`
- `app/services/orchestrator/agents/chatbot.py`, `service.py`
- `app/services/db/rag_service.py`
- `app/services/auth/service.py`, `auth_manager.py`
- `app/services/gateway/service.py`, `config.py`, `webrtc/rtc_client.py`
- `app/services/tooling/tools_manager.py`, `mcp/mcp_client.py`, `tools/brave_search.py`
- `app/helpers/getGoogleCredentials.py`
- `main.py`

**Bugs fixed during code review:**
- `gateway/config.py`: `cors=None` from `model_dump()` causing `AttributeError`
- `interface.py`: `get()` returning `None` in async context with model arg
- `generate_config_artifacts.py`: `$ref` pointers not resolved in `generate_keys()`
- `config_manager.py`: Dead code in `_get_default_config()`
- `tools_manager.py`: `search_brave_tool` was always `None`; now calls `async_get_brave_search_tool()`
- `rag_service.py`: Readiness probe always passed due to Pydantic model defaults
- `mcp_client.py`: `model_dump()` emitting `env={}` stripping subprocess environment
- All service `reload()` methods: Updated section filters to `services.*` paths
- `tts/service.py`: Sample rate fallback 24000→22050 to match schema

---

## 12. Known Issues & TODOs

### Code TODOs (3 in `app/`)

| File | TODO |
|------|------|
| `app/services/orchestrator/service.py:210` | Process tool result and continue agent execution |
| `app/services/tts/service.py:54` | Implement volume control functions |
| `app/services/supervisor.py:478` | Implement service restart logic |

### Missing Optional Dependencies (cause pre-existing test failures)

- `croniter` — scheduler tests
- `aiortc` — WebRTC tests
- `fastapi` — gateway HTTP tests
- `langchain` / `langchain_huggingface` — RAG embedding tests

Install with: `uv pip install croniter aiortc fastapi langchain langchain-huggingface`

### Plan Document Staleness

- `docs/plans/CONFIG_SCHEMA_FIRST_PLAN.md` line 5 says "Status: Plan — not yet implemented" but all 7 phases are complete. Header should be updated.

### Multi-Tenancy (Planning Only)

`MULTI_TENANCY_ROADMAP.md` in `aurora2` describes 5 phases for multi-principal support. Phase 0 (foundation — `principal_id` on Envelope) is complete. No subsequent phases implemented.

### Remaining String Literals

A few config string literals remain in infrastructure code where they're appropriate:
- `config_manager.py` `validate_config()` — uses `self.get("services....")` internally (it IS the config backend)
- `env_config.py` `ENV_CONFIG_MAP` — env var mapping table (must be raw strings)
- `config/service.py` dynamic plugin checks — uses f-strings for dynamic segments

### Deprecated Methods

`config_api.get_app_config()` and `config_api.aget_app_config()` still exist, marked deprecated. They fetch the full config and parse into the root `Model`. Services should use section-level access instead.

---

## 13. Key File Reference

### Entry Points
| File | Purpose |
|------|---------|
| `main.py` | CLI/UI entry point (threads mode) |
| `app/services/<name>/__main__.py` | Process mode entry point per service |

### Core Infrastructure
| File | Purpose |
|------|---------|
| `app/shared/services/base_service.py` | Base class for all services |
| `app/services/supervisor.py` | Service lifecycle manager (threads mode) |
| `app/shared/config/interface.py` | `ConfigAPI` — typed config access |
| `app/services/config/config_manager.py` | Config loading, validation, persistence |
| `app/services/config/config_schema.json` | **SOURCE OF TRUTH** for all config |
| `app/shared/contracts/registry.py` | Method contract registry |

### Bus Layer
| File | Purpose |
|------|---------|
| `app/messaging/bus.py` | `Envelope` model + `MessageBus` protocol |
| `app/messaging/local_bus.py` | In-process asyncio bus |
| `app/messaging/bullmq_bus.py` | Redis-backed bus for process mode |
| `app/messaging/mesh_bus.py` | P2P routing wrapper |
| `app/messaging/bus_runtime.py` | `get_bus()` singleton |

### Auth & Security
| File | Purpose |
|------|---------|
| `app/services/auth/service.py` | 39 contract handlers |
| `app/services/auth/auth_manager.py` | Core auth logic + mesh SQL |
| `app/shared/auth/identity.py` | `Identity` dataclass |
| `app/shared/auth/permissions.py` | Permission matching engine |
| `app/shared/crypto.py` | Key derivation, AEAD seal/open |

### Gateway & Mesh
| File | Purpose |
|------|---------|
| `app/services/gateway/service.py` | GatewayService lifecycle |
| `app/services/gateway/fastapi_app.py` | FastAPI app factory |
| `app/services/gateway/auth_proxy.py` | Bus-based auth adapter for RTCClient |
| `app/services/gateway/mesh/routing_table.py` | Local/remote routing decisions |
| `app/services/gateway/mesh/peer_bridge.py` | Outbound RPC via DataChannels |
| `app/services/gateway/webrtc/rtc_client.py` | WebRTC peer connection manager |
| `app/services/gateway/webrtc/rpc.py` | JSON-RPC handler |

### Documentation
| File | Purpose |
|------|---------|
| `AGENTS.md` | Top-level AI agent guide |
| `docs/ARCHITECTURE.md` | System architecture |
| `docs/GATEWAY.md` | Gateway API reference |
| `docs/PEER_PAIRING_FLOW.md` | Exhaustive pairing + mesh + trust docs |
| `docs/MESSAGING_ARCHITECTURE.md` | Bus system design |
| `docs/plans/CONFIG_SCHEMA_FIRST_PLAN.md` | Schema-first config plan (implemented) |

---

## 14. Development Commands

```bash
# Environment
uv sync                          # Install all deps
source .venv/bin/activate        # Activate venv

# Running
python main.py                   # Threads mode (dev)
make docker-process-mode         # Docker process mode
tilt up                          # Tilt dev mode

# Config generation
make generate-config             # Regenerate models, keys, defaults from schema
make check-config-generated      # CI: fail if artifacts are stale

# Code quality
make format                      # ruff format
make lint                        # ruff check
make check                       # All quality checks
make unit                        # Unit tests
make test                        # All tests except performance

# Docker
make docker-process-up           # Start containers
make docker-process-down         # Stop containers
make docker-process-logs         # View logs
make tilt-compose-rebuild        # Rebuild Tilt services
```

### Test Suite Status (as of this session)

```
590 passed, 40 skipped, 9 deselected (missing optional deps)
```

The 9 deselected are pre-existing failures from missing `fastapi`, `aiortc`, `langchain`, `langchain_huggingface`.

---

*End of handoff document.*
