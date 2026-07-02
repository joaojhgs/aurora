# Aurora feature matrix

**Status:** Current source of truth

This matrix summarizes the current repo state. It distinguishes production-ready surfaces from bounded tests, partial features, and historical/fallback paths.

| Area | Status | Current evidence / boundary | Primary docs |
| --- | --- | --- | --- |
| Service bus | Current | LocalBus threads mode and BullMQBus process mode with typed Pydantic envelopes and priorities. | [`MESSAGING_ARCHITECTURE.md`](MESSAGING_ARCHITECTURE.md) |
| Config service | Current | Schema-first config, generated Pydantic models, `ConfigKeys`, defaults, and hot reload patterns. | [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md) |
| Gateway HTTP API | Current | FastAPI Gateway generates routes from service contracts and forwards through the bus. | [`GATEWAY.md`](GATEWAY.md), [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md) |
| Auth/RBAC | Current | AuthService, Gateway ACL, tokens/principals, pairing, audit, and required permission metadata. | [`AUTH_AND_PERMISSIONS.md`](AUTH_AND_PERMISSIONS.md) |
| Mesh/pairing | Current bounded | Pairing, capability/routing policy, data-sharing policy, and mesh transport harnesses. Physical/network environments still need deployment-specific validation. | [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md), [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md), [`MESH_GAP_E2E_HARNESS.md`](MESH_GAP_E2E_HARNESS.md) |
| Orchestrator/LLM | Current | LangGraph/LangChain orchestration with API and local-model profiles. Provider readiness depends on selected dependency/config profile. | [`ARCHITECTURE.md`](ARCHITECTURE.md), [`DEPENDENCIES.md`](DEPENDENCIES.md) |
| Tooling/MCP | Current | ToolingService owns built-in/plugin/MCP tool loading and execution. | [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) |
| DB/RAG | Current | SQLite persistence, RAG/vector storage, embedding modes, and mesh data-sharing policy. | [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md), [`docker/DB-SERVICE-EMBEDDINGS.md`](docker/DB-SERVICE-EMBEDDINGS.md) |
| Scheduler | Current | Cron/one-shot scheduling via SchedulerService and contracts. | `app/services/scheduler/README.md`, [`SERVICE_METHODS_REFERENCE.md`](SERVICE_METHODS_REFERENCE.md) |
| Backup/restore | Partial | Manifests, list/verify, and dry-run restore/rollback exist. Destructive restore/rollback executor is not enabled. | [`BACKUP_SERVICE.md`](BACKUP_SERVICE.md) |
| STT/TTS voice pipeline | Current profile-dependent | Services exist; runtime requires audio/model dependencies and platform audio setup. | [`DEPENDENCIES.md`](DEPENDENCIES.md), [`AMBIENT_TRANSCRIPTION.md`](AMBIENT_TRANSCRIPTION.md) |
| Ambient transcription | Partial | Config and STT coordinator behavior exist; durable ambient logging service is not implemented. | [`AMBIENT_TRANSCRIPTION.md`](AMBIENT_TRANSCRIPTION.md) |
| TypeScript SDK | Current | `AuroraClient`, transports, fixtures, and conformance checks. | [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md), `packages/aurora-sdk/README.md` |
| React UI package | Current bounded | Shared UI consumes SDK state and package-level accessibility/resilience tests. | [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md), [`ACCESSIBILITY_RESPONSIVE_VISUAL_TESTS.md`](ACCESSIBILITY_RESPONSIVE_VISUAL_TESTS.md) |
| Web shell | Current bounded | Next/web shell exists; production deployment depends on Gateway/Auth configuration. | [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md) |
| Tauri desktop | Current bounded | Tauri shell, secure-storage posture, sidecar profile builds, and smoke tests exist. Package signing remains separate release scope. | [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md), `apps/aurora-tauri/README.md` |
| Tauri Android/iOS | Skeleton/bounded | Native plugin skeletons and policy/preflight checks exist. Physical device and store signing require platform-specific CI/secrets. | `apps/aurora-tauri/README.md`, `apps/aurora-tauri/src-tauri/android/README.md` |
| PyQt UI | Legacy/current fallback | Optional UIBridge fallback/reference. New production UI work should target SDK-first React/Tauri/web. | [`UI_INTEGRATION.md`](UI_INTEGRATION.md) |
| Docker process mode | Current | Compose/Tilt process mode with service containers and Redis. | [`../README.process-mode.md`](../README.process-mode.md), [`TILT.md`](TILT.md) |
| CI/CD | Current | Durable lanes for quality, Python tests, e2e, frontend/SDK, performance, Docker, release, Tauri, and SDK conformance. | [`CI_CD.md`](CI_CD.md) |

## Status meanings

- **Current**: implemented and documented for normal use, subject to environment/config dependencies.
- **Current bounded**: implemented and tested within a specific harness or package boundary; not a full deployment certification.
- **Partial**: some implementation exists, but important behavior is missing and must be stated.
- **Skeleton/bounded**: structural support exists but real device/store/production behavior requires further implementation or external setup.
- **Legacy/current fallback**: maintained as fallback/reference, not the primary path for new production work.
