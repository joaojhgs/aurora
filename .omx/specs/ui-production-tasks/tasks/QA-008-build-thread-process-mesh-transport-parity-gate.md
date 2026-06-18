# QA-008 — Build thread/process/mesh transport parity gate


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P10 — Quality, security, release, and operations
- **Lane:** qa-release
- **Depends on:** QA-002, BE-016, SDK-014, MESH-004
- **Parallelizable with:** QA-006
- **Coverage matrix rows:** runtime.mode_matrix, sdk.transport.client, mesh.route_policy
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Add an explicit release gate proving that the same UI/SDK flows behave consistently across LocalBus thread mode, BullMQ/Redis process mode, HTTP Gateway thin mode, Tauri local mode, and Mesh/WebRTC mode.

## User-visible outcome

Production readiness cannot pass by testing only one deployment topology.

## Backend/API implementation details

- Exercise real or hermetic backends for `LocalBus`, `BullMQBus` with Redis, Gateway HTTP routes, and Mesh/WebRTC routing where available.
- Verify registry, capability, auth/session, AdminAction, diagnostics, and assistant send/stream/cancel basics in each supported mode.

## SDK integration details

- Run the same `AuroraClient` behavior suite across HTTP, Tauri-local command mocks/real smoke, Mesh transport mocks/real smoke, and mock transport fixtures.
- Prove degraded reasons are equivalent and not transport-specific string leaks.

## Tauri/native integration details

- Desktop local sidecar mode must cover offline and sidecar-crash recovery.
- Mobile thin/mesh smoke may be emulator-based unless assistant-role or platform limitations require device evidence.

## UI/UX implementation details

- Run a minimal visual/user-flow smoke for onboarding, assistant chat, admin overview/topology, route sheet, diagnostics link, and permission-denied state in each mode.

## Code references to inspect first

- `tests/AGENTS.md`
- `app/messaging/local_bus.py`
- `app/messaging/bullmq_bus.py`
- `app/messaging/mesh_bus.py`
- `app/services/gateway/fastapi_app.py`
- `docker-compose.process.yml`
- `README.process-mode.md`

## Mock/component references

- `modules/ui-mock-reference/README.md` mode notes
- `modules/ui-mock-reference/lib/aurora/data.ts` capability fixtures
- `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx`

## Data, permissions, and privacy contract

- Use typed topic constants and registered method contracts for any backend additions.
- Sanitize deployment topology, peer topology, Redis URLs, tokens, local filesystem paths, and diagnostics before exposing them to UI.
- Use capability graph and AdminAction for any mutation or privileged detail; read-only degraded states still require permission checks when topology could leak sensitive infrastructure.

## Acceptance criteria

- Matrix has rows for thread/local, process/Redis, server HTTP, desktop Tauri local, mesh/WebRTC, Android thin/local-light where applicable, and iOS thin/local-light where applicable.
- Each row records pass/fail/skipped-with-rationale, commands, artifact paths, and owner.
- A failure in one transport cannot be hidden by passing mock transport tests.

## Verification commands / evidence

- CI job or documented manual suite output for the matrix.
- Docker Compose process-mode smoke with Redis available.
- Local thread-mode smoke without Redis.
- Mesh/WebRTC smoke or explicit environment-gated skip with follow-up issue.

## Risks and guardrails

- Do not bypass the bus or SDK boundaries to make UI state easier.
- Do not leak Redis URLs, host paths, peer secrets, tokens, or private model paths.
- Do not treat mock transport, emulator-only, or single-mode smoke as production parity.

## Handoff notes

- Added by full coverage review to make previously implicit process-mode, deployment-topology, and legacy UI migration coverage explicit.

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

Transport parity must prove capability catalog and approval behavior, not only connectivity.

Additional requirements:

- In every supported transport row, verify capability catalog ingestion, route explain, local+remote aggregate tools where applicable, local/internal approval, remote mesh approval where applicable, AdminAction composition, event stream, diagnostics, and audit receipt.
- The mesh row must use the two-peer harness from `MESH-GAP-011`; mock mesh is insufficient for final pass.
- The HTTP thin-client row must prove unsupported local/native-only features are degraded through capability graph rather than hidden or incorrectly enabled.
