# Aurora architecture

**Status:** Current source of truth

Aurora is a privacy-first assistant runtime built from independently owned services connected by a typed message bus. It can run as one local process for development or as service containers/processes for production-style deployments. Frontends do not call Python service objects directly; they use the TypeScript SDK, Gateway, or Tauri-native transport boundaries.

## Runtime modes

| Mode | Bus | Process model | Typical use |
| --- | --- | --- | --- |
| Threads mode | `LocalBus` | Supervisor starts services in one Python process. | Local development, tests, Tauri desktop sidecar, simple single-machine installs. |
| Process mode | `BullMQBus` over Redis | Each service has a standalone entrypoint/container. | Docker/Tilt, production-style process isolation, distributed service development. |

The bus is the only inter-service communication mechanism. Services publish/request typed contract topics from `app/shared/contracts/models/` and exchange Pydantic models.

## High-level system map

```text
Frontend surfaces
  ├─ React UI package (@aurora/ui)
  ├─ Web app (apps/aurora-web)
  ├─ Tauri desktop/mobile shell (apps/aurora-tauri)
  └─ PyQt UIBridge fallback (app/ui)
        │
        ▼
TypeScript SDK (@aurora/client)
  ├─ HTTP Gateway transport
  ├─ Tauri local/native transport
  ├─ mock/test transports
  └─ mesh bridge abstractions
        │
        ▼
Gateway / Tauri bridge / local bus boundary
        │
        ▼
Aurora service bus
  ├─ ConfigService
  ├─ AuthService
  ├─ DBService
  ├─ BackupService
  ├─ ToolingService
  ├─ SchedulerService
  ├─ STT coordinator / wakeword / transcription services
  ├─ TTSService
  ├─ OrchestratorService
  └─ GatewayService
```

## Core services

| Service | Path | Responsibility |
| --- | --- | --- |
| ConfigService | `app/services/config/` | Schema-backed configuration, defaults, hot reload, generated config models/keys. |
| AuthService | `app/services/auth/` | Pairing, token/principal records, audit storage, auth/RBAC contract surfaces. |
| DBService | `app/services/db/` | SQLite persistence, conversation/message data, RAG/vector storage, cron-job storage. |
| BackupService | `app/services/backup/` | Admin backup manifests, verify/list, dry-run restore/rollback impact plans. |
| ToolingService | `app/services/tooling/` | Built-in tools, plugin/MCP tool registration and execution. |
| SchedulerService | `app/services/scheduler/` | Cron and one-shot scheduled jobs. |
| STTCoordinatorService | `app/services/stt_coordinator/` | Speech session coordination, wakeword/transcription orchestration, ambient-mode coordination. |
| STTWakewordService | `app/services/stt_wakeword/` | Wakeword detection. |
| STTTranscriptionService | `app/services/stt_transcription/` | Speech-to-text transcription. |
| TTSService | `app/services/tts/` | Text-to-speech generation and playback lifecycle events. |
| OrchestratorService | `app/services/orchestrator/` | LangGraph/LangChain assistant orchestration, LLM provider coordination, tool calls. |
| GatewayService | `app/services/gateway/` | FastAPI routes generated from contracts, SSE event stream, WebRTC/mesh, ACL and peer bridge. |
| Supervisor | `app/services/supervisor.py` | Threads-mode service startup/shutdown and lifecycle ordering. |

## Shared layers

| Layer | Path | Purpose |
| --- | --- | --- |
| Contracts | `app/shared/contracts/` | Method decorators, contract registry, typed topic constants, IO models. |
| Messaging | `app/messaging/`, `app/shared/messaging/` | LocalBus/BullMQBus runtime, envelopes, priorities, serialization. |
| Config models | `app/shared/config/` | Generated Pydantic config models and `ConfigKeys`. |
| Auth helpers | `app/shared/auth/` | Shared auth models/utilities. |
| Mesh helpers | `app/shared/mesh/` | Shared mesh models and utilities. |
| Base service | `app/shared/services/base_service.py` | Contract registration, bus subscription, service announce/depart, lifecycle hooks. |

## Contract-first communication

Services expose callable behavior with `@method_contract` and typed method constants. The Gateway discovers exposed contracts and generates HTTP routes. The TypeScript SDK and conformance checks prevent drift between backend contracts and frontend fixtures.

See:

- [`MESSAGING_ARCHITECTURE.md`](MESSAGING_ARCHITECTURE.md)
- [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md)
- [`SERVICE_METHODS_REFERENCE.md`](SERVICE_METHODS_REFERENCE.md)

## Gateway, Auth, and mesh

The Gateway owns external HTTP/SSE/WebRTC boundaries. Auth owns principals, token/pairing/audit contract state. Mesh features are policy-gated and require explicit sharing/routing rules instead of transparent data access.

See:

- [`GATEWAY.md`](GATEWAY.md)
- [`AUTH_AND_PERMISSIONS.md`](AUTH_AND_PERMISSIONS.md)
- [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md)
- [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md)

## Frontend and platform architecture

The production UI model is SDK-first:

- React components in `packages/aurora-ui` consume normalized SDK state.
- `apps/aurora-web` hosts the web shell.
- `apps/aurora-tauri` hosts the Tauri 2 desktop/mobile shell and native command bridge.
- Tauri desktop can run a supervised Python sidecar for local/offline mode, or use a remote Gateway in thin mode.
- `app/ui/bridge_service.py` remains a PyQt fallback/reference, not the desired direction for new production screens.

See [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md) and [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md).

## Configuration source of truth

`app/services/config/config_schema.json` is the source of truth for structured configuration. Generated artifacts must stay in sync:

- `app/shared/config/models.py`
- `app/shared/config/keys.py`
- `app/services/config/config_defaults.json`

Run:

```bash
make generate-config
make check-config-generated
```

See [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md).

## Deployment shape

| Deployment | Description | Docs |
| --- | --- | --- |
| Local threads | `uv run python main.py` starts the supervisor and in-process bus. | [`INSTALL.md`](INSTALL.md), [`UV_USAGE.md`](UV_USAGE.md) |
| Docker process mode | Compose starts Redis and service containers; no supervisor container. | [`../README.process-mode.md`](../README.process-mode.md) |
| Tilt process mode | Compose + Tilt development loop with optional hot reload and log controls. | [`TILT.md`](TILT.md) |
| Tauri desktop | React/Tauri shell plus profile-specific sidecar. | [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md) |

## Documentation boundaries

Current docs are indexed in [`DOCS_INDEX.md`](DOCS_INDEX.md). Historical plans and generated investigation artifacts are archived under `docs/archive/` or `.omx/plans/` and are not current architecture guidance.
