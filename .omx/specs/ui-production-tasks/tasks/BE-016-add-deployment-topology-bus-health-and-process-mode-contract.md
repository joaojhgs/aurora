# BE-016 — Add deployment topology, bus health, and process-mode contract


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/operations
- **Depends on:** P0-002, BE-002
- **Parallelizable with:** BE-005, BE-013, ADM-013
- **Coverage matrix rows:** admin.deployment_topology, runtime.mode_matrix, sdk.transport.client
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Expose a typed, non-mutating backend contract that tells the UI exactly which Aurora architecture mode is running, which bus backend is active, and whether required infrastructure such as Redis/BullMQ is healthy.

## User-visible outcome

Admin and onboarding surfaces can distinguish server process mode, thread mode, local sidecar mode, and degraded Redis/BullMQ states without guessing from transport errors.

## Backend/API implementation details

- Add or formalize a Gateway/Supervisor/Config-facing read-only contract returning `architecture_mode`, `bus_backend`, `redis_url_redacted`, `redis_reachable`, `bullmq_queue_health`, `service_process_topology`, `container/topology hints`, and `mode_capability_degradations`.
- Use `AURORA_ARCHITECTURE_MODE`, `REDIS_URL`, bus runtime state, registry aggregation, and process-mode service announcements as inputs; do not expose secrets.
- In thread mode, report `LocalBus` and single-process/thread topology; in process mode, report `BullMQBus`/Redis and per-service process/container topology; in mesh routes, report peer-provided topology only through sanitized peer manifests.
- Keep this read-only unless linked to `BE-015`/AdminAction service controls.

## SDK integration details

- Add generated descriptors and normalized `DeploymentTopology`/`BusHealth` types.
- Capability graph must expose degraded reasons such as `redis_unreachable`, `bullmq_queue_lag_unknown`, `process_registry_stale`, `thread_mode_no_process_controls`, and `mesh_peer_topology_untrusted`.
- HTTP, Tauri local, and mesh transports must return equivalent normalized shapes where available, with unsupported fields explicit.

## Tauri/native integration details

- Tauri local mode consumes this via local bus/command bridge and adds sidecar status from `TAURI-002` without bypassing `AuroraClient`.
- Desktop thin mode consumes it from the remote HTTP Gateway. Mobile thin/mesh modes show remote topology only if authorized.

## UI/UX implementation details

- Admin dashboard gains a deployment topology data source for `ADM-013`.
- Onboarding can explain “connected to process-mode server”, “running local thread-mode sidecar”, “Redis unavailable”, or “mesh peer-only shell” states.

## Code references to inspect first

- `app/messaging/local_bus.py` (`LocalBus`)
- `app/messaging/bullmq_bus.py` (`BullMQBus`, Redis queue behavior)
- `app/messaging/bus_runtime.py` architecture-mode bus selection
- `app/services/gateway/registry_aggregator.py` process/thread registry aggregation
- `app/services/supervisor.py` local lifecycle/status
- `docker-compose.process.yml` service topology and Redis dependency
- `README.process-mode.md` process-mode operations and Redis troubleshooting
- `docs/TILT.md` process-mode/Tilt development topology

## Mock/component references

- `modules/ui-mock-reference/components/aurora/app-shell.tsx`
- `modules/ui-mock-reference/components/aurora/admin/overview.tsx`
- `modules/ui-mock-reference/components/aurora/status-badges.tsx`
- `modules/ui-mock-reference/lib/aurora/types.ts`

## Data, permissions, and privacy contract

- Use typed topic constants and registered method contracts for any backend additions.
- Sanitize deployment topology, peer topology, Redis URLs, tokens, local filesystem paths, and diagnostics before exposing them to UI.
- Use capability graph and AdminAction for any mutation or privileged detail; read-only degraded states still require permission checks when topology could leak sensitive infrastructure.

## Acceptance criteria

- Contract response identifies thread/process/mesh/thin/local modes without secret leakage.
- Redis/BullMQ health and queue/topology degradation states are represented in registry/OpenAPI or the chosen generated inventory.
- Thread-mode `LocalBus` and process-mode `BullMQBus` are both covered by unit/integration tests or explicitly gated when Redis is unavailable.
- UI fixtures cannot mark process-mode topology healthy unless this contract reports it.

## Verification commands / evidence

- `pytest tests/unit/gateway -q` for exposed route/permission behavior.
- Targeted bus/runtime tests for LocalBus vs BullMQBus topology serialization.
- Process-mode smoke with Redis available and unavailable using `docker compose -f docker-compose.process.yml ps/logs` evidence.

## Risks and guardrails

- Do not bypass the bus or SDK boundaries to make UI state easier.
- Do not leak Redis URLs, host paths, peer secrets, tokens, or private model paths.
- Do not treat mock transport, emulator-only, or single-mode smoke as production parity.

## Handoff notes

- Added by full coverage review to make previously implicit process-mode, deployment-topology, and legacy UI migration coverage explicit.
