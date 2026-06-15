# Full UI Production Task Coverage Review

Date: 2026-06-14
Status: reviewed and patched; planning artifacts only.

## Review question

Does `.omx/specs/ui-production-tasks/` cover the original UI specification and current Aurora capabilities across multi-platform UI, assistant/client flows, admin dashboard flows, all transport methods, and all installation/runtime modes?

## Review method

- Re-read task index, task manifest, coverage crosswalks, and every task-file structure.
- Scanned task artifacts for required runtime/platform/service terms.
- Inspected repo evidence for runtime modes, transports, deployments, current services, and legacy UI surfaces.
- Compared gaps against current code/docs and patched planning artifacts where coverage was only implicit.
- Ran structural validation after patching.

## Original requirement coverage

| Requirement area | Coverage status | Evidence / task families |
| --- | --- | --- |
| Server/cloud UI through HTTP API Gateway | Covered | `SDK-007`, `BE-001..BE-004`, `UI-003`, `UIA-*`, `ADM-*`, `QA-002`, `QA-008` |
| Standalone desktop app with Tauri and local Python services | Covered | `TAURI-001..TAURI-007`, `SDK-009`, `TAURI-002`, `TAURI-004`, `QA-005`, `QA-008` |
| P2P mesh/WebRTC shell mode | Covered | `SDK-010`, `BE-013`, `BE-014`, `MESH-001..MESH-004`, `QA-008` |
| Thread-mode local/offline runtime | Covered explicitly after patch | `TAURI-002`, `TAURI-004`, `BE-016`, `ADM-013`, `QA-008` |
| Process-mode distributed runtime with Redis/BullMQ | Covered explicitly after patch | `BE-016`, `ADM-013`, `QA-008`, plus `README.process-mode.md` / `docker-compose.process.yml` references |
| Android Tauri + Kotlin native plugins | Covered | `AND-001..AND-009`, `UI-004`, `UIA-004`, `UIA-005`, `QA-002`, `QA-008` |
| iOS Tauri + Swift native plugins | Covered | `IOS-001..IOS-008`, `UI-004`, `UIA-004`, `UIA-005`, `QA-002`, `QA-008` |
| Native assistant entrypoints / platform limits | Covered | `AND-004` for Android assistant role qualification, `IOS-003` for App Intents/Shortcuts; index forbids Siri replacement claims. |
| Admin dashboard: RBAC, tokens, devices, services, config, audit, diagnostics | Covered | `ADM-001..ADM-013`, `BE-004`, `BE-005`, `BE-010`, `BE-015`, `BE-016` |
| Assistant UI: chat, streaming/cancel, tools, voice, attachments, memory/RAG, models | Covered | `UIA-001..UIA-007`, supporting `BE-003`, `BE-007..BE-011`, `SDK-011`, `SDK-013` |
| Security/privacy model | Covered | `SDK-012`, `BE-004`, `ADM-008`, `QA-003`, task-level data/privacy contracts |
| Build/release/operator readiness | Covered | `TAURI-006`, `AND-009`, `IOS-008`, `QA-006`, `QA-007`, `QA-008` |
| Current legacy PyQt UI surface | Covered explicitly after patch | `TAURI-007` maps/deprecates `app/ui/bridge_service.py` behavior into Tauri/SDK event contracts. |

## Current code capability coverage

| Current capability / source | Required production UI concern | Task coverage |
| --- | --- | --- |
| `app/services/gateway/fastapi_app.py`, `route_generator.py` | HTTP routes, built-ins, route casing, exposure, auth | `P0-002`, `SDK-007`, `BE-001`, `QA-001` |
| `app/messaging/local_bus.py` | Thread-mode local bus semantics | `TAURI-004`, `BE-016`, `QA-008` |
| `app/messaging/bullmq_bus.py`, Redis compose env | Process-mode distributed bus health | `BE-016`, `ADM-013`, `QA-008` |
| `app/messaging/mesh_bus.py`, gateway WebRTC/mesh modules | P2P routing, ICE/data-channel diagnostics, route policy | `SDK-010`, `BE-013`, `BE-014`, `MESH-*`, `QA-008` |
| `app/services/auth/*`, `app/shared/auth/*` | Login/pairing/RBAC/tokens/devices/audit | `BE-001`, `BE-004`, `BE-012`, `ADM-003..ADM-005`, `ADM-008`, `ADM-011` |
| `app/services/config/*`, config schema/defaults | Config editor, validation, diff, reload impact | `BE-010`, `ADM-006` |
| `app/services/supervisor.py` | Service status/control, thread/process differences | `BE-015`, `BE-016`, `ADM-002`, `ADM-013` |
| DB/RAG services | Memory/RAG provenance, backup/restore | `BE-006`, `BE-017`, `UIA-006`, `ADM-010` |
| Orchestrator/tooling/MCP | Chat, tool approvals, risk taxonomy, cancellation | `BE-009`, `BE-011`, `UIA-001..UIA-003`, `ADM-007` |
| STT/TTS/wake services | Voice, native permissions, status events | `UIA-004`, `AND-005`, `IOS-006`, `TAURI-007` |
| Scheduler service | Jobs/automation management and exposure/audit gating | `BE-018`, `ADM-012` |
| `app/ui/bridge_service.py` | Legacy PyQt behavior migration/deprecation | `TAURI-007` |
| `docker-compose.process.yml`, `README.process-mode.md`, `docs/TILT.md` | Operator process-mode topology, Redis/BullMQ, release/runbooks | `BE-016`, `ADM-013`, `QA-006`, `QA-008` |

## Findings

1. The original 91-task set covered the major product scope, platforms, SDK, backend gaps, assistant/admin UI, mesh, and release gates.
2. Process-mode/BullMQ/Redis was present but too implicit: it appeared mostly in QA and docs references, not as a first-class backend/UI contract. Fixed with `BE-016`, `ADM-013`, and `QA-008`.
3. Legacy PyQt/UIBridge migration was absent. Fixed with `TAURI-007`.
4. No additional source implementation is required in this review pass; all changes are planning/spec artifacts.

## Files added or updated by this review

- Added `tasks/BE-016-add-deployment-topology-bus-health-and-process-mode-contract.md`
- Added `tasks/TAURI-007-map-legacy-pyqt-uibridge-to-tauri-sdk-migration-contract.md`
- Added `tasks/BE-017-add-memory-rag-provenance-export-delete-contracts.md`
- Added `tasks/BE-018-add-scheduler-management-exposure-and-adminaction-contract.md`
- Added `tasks/ADM-013-wire-deployment-topology-and-process-mode-operations-dashboard.md`
- Added `tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md`
- Updated `index.md`
- Updated `manifest.md`
- Updated `backend-gap-crosswalk.md`
- Updated `flow-to-task-coverage.md`

## Final assessment

After the six additions and dependency/reference corrections, the task set covers the original spec and current codebase capabilities at the planning/task-definition level. The plan now explicitly covers web/server HTTP, Tauri desktop local/native, Android/iOS native plugins, mesh/WebRTC shell, thread mode/LocalBus, process mode/BullMQ/Redis, admin dashboard, assistant flows, security/privacy, operator diagnostics, release, and current PyQt migration.
