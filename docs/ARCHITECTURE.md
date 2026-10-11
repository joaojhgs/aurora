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

## Speech capability metadata boundary

Speech capability discovery is lifecycle data, separate from a request being admitted. `SpeechStageCapabilityExportV1` is an optional, bounded wrapper on `ServiceAnnouncement`; `BaseService` supplies an empty-by-default runtime hook, and TTS currently reports finite synthesis metadata only when its provider, public logical voices, and local peer identity remain stable across its readiness probes. The registry retains the latest runtime projection during static refresh, and recipient export filters and canonicalizes that metadata with the service methods and permissions allowed for that recipient.

These records describe current discovery state. Finite synthesis now validates an explicitly selected voice against the ready provider inventory and rejects output if provider identity or voice revision changes during the readiness check or synthesis; omitted voice continues to use the provider default. This targeted guard is separate from full speech-stage admission and does not supply outbound-audio consent or bind the request to the advertised capability/configuration revision. See [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md#speech-stage-capability-metadata-partial) for the current boundary.

`BaseService` serializes accepted start, activate, deactivate, and stop intents. Adjacent same-kind requests share one managed transition, while newer requests retire older work before taking ownership. Canceling a caller does not abandon an accepted transition. Resource cleanup completes before a queued activation can reuse the service, lifecycle announcements stay bound to the committed generation, and direct lifecycle reentry from a hook fails fast. Enabled-config callbacks are ordered by arrival and lifecycle generation; arbitrary independent bus-worker cycles are not inferred from task names.

The finite STT handler snapshots its request before yielding and moves decoding, model invocation, and lazy segment iteration to a worker thread. Model identity, enabled state, the service lifecycle generation, and a local STT model revision are checked before inference and before the result is returned; relevant reloads advance that revision at start and successful commit, and changed enable controls advance it before readiness is republished. Superseded reload and startup reads are discarded before the current synchronous model-construction step or shared-state commit. Stop invalidates pending STT work before cleanup, removes a late microphone subscription, and retains a processing-thread handle that survives the bounded off-loop join; restart is rejected before config/model/microphone acquisition while that worker remains alive. If the worker later exits, its retained models remain closed until a fresh activation reaps them before config reads and installs replacements. During BaseService-managed cleanup, STT leaves the started marker to the lifecycle owner so deactivation can retain its process-level config listener for a later enabled event; full stop removes that listener. Direct `on_stop()` calls still clear the marker. Identical controls and irrelevant reload sections leave the model revision unchanged. Cancellation while queued prevents inference from starting, and transcript and engine exception details are redacted from handler logs. Running native inference cannot be preempted. These safeguards do not add current-config, sharing, consent, deadline, queue, or authenticated stage admission, and do not prove nine-combination or native-platform acceptance.

## Contract-first communication

Services expose callable behavior with `@method_contract` and typed method constants. The Gateway discovers exposed contracts and generates HTTP routes. The TypeScript SDK and conformance checks prevent drift between backend contracts and frontend fixtures.

See:

- [`MESSAGING_ARCHITECTURE.md`](MESSAGING_ARCHITECTURE.md)
- [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md)
- [`SERVICE_METHODS_REFERENCE.md`](SERVICE_METHODS_REFERENCE.md)

## Gateway, Auth, and mesh

The Gateway owns external HTTP/SSE/WebRTC boundaries. Auth owns principals, token/pairing/audit contract state. Mesh features are policy-gated and require explicit sharing/routing rules instead of transparent data access.

### Mesh topology and where routing decisions are made

Multi-peer routing lives in Python and in the thin runtime's per-peer registry.
`RoutingTable`, `PeerRegistry`, and the pure `evaluate_outbound_provider` layer
resolve a topic to a provider using routing policy, provider candidates with
typed reason codes, capacity leases, latency or round-robin selection, and
explicit-selector rules, and they fall back to another peer when one fails.

TypeScript shells join the mesh in two roles, and they differ:

| Shell role | Consumer shape | Provider shape |
| --- | --- | --- |
| Remote console | Connect remains policy-limited to one selected home peer. `WebRtcMeshPeerBridge` reaches the rest of the mesh through that peer, exactly as the HTTP transport reaches one Gateway. | Not a provider. |
| Mesh node | The runtime holds one session per stable peer id, routes RPC through the bridge named on the request, observes all room peers through a per-session allowlist, and sheds over-budget peers with `mesh_peer_standby_v1` rather than treating them as lost. | Full provider via `WebRtcPeerHost`: projects granted contracts as a projection-v1 manifest and serves inbound RPC. |

The thin runtime's session registry answers connection and roster questions.
Authorization is separate: the Rust `aurora-mesh-authority` crate is the single
authority for grants, permission evaluation, execution policy, revocation, and
reconnect challenges. Native shells reach it through Tauri commands; web shells
use the same Rust core through `@aurora/mesh-authority-web`.

On Android, the native mesh session keeps the paired WebRTC link alive while the
WebView is backgrounded, answers pings, serves the bounded
`native.get_device_status` tool after the Rust authority allows it, and defers
orchestration with the typed `orchestration_deferred` response until the device
returns to the foreground. Waydroid proves that protocol/service-hold behavior
against the real Python supervisor; physical-device Doze, OEM-kill, battery, and
thermal acceptance remain a separate release gate.

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

Current docs are indexed in [`DOCS_INDEX.md`](DOCS_INDEX.md). Curated historical material lives under `docs/archive/`; local agent plans and generated investigation artifacts are not tracked release source.
