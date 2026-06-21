# Backend/API Gap Crosswalk for UI Production Tasks

Date: 2026-06-14
Purpose: maps backend gaps discovered from code/spec/mock review to the individual backend and downstream UI/SDK tasks.

| Gap | Current code evidence | Primary task | Downstream tasks unblocked |
|---|---|---|---|
| AdminAction server-enforced draft/confirm/audit envelope missing | Manage contracts exist across `Auth`, `Config`, `Supervisor`, mesh, but generated routes do not enforce confirmation nonce/digest/reason. Audit primitives exist at `Auth.StoreAuditEvent`/`Auth.AuditLog`. | `BE-004` | `SDK-013`, `ADM-003`, `ADM-004`, `ADM-005`, `ADM-006`, `ADM-008`, `ADM-010`, `MESH-001` |
| Streaming/events missing as unified public contract | `Orchestrator.Response` is an event; `Config.Updated` exists; gateway dynamic routes are request/response. | `BE-003` | `SDK-011`, `UIA-002`, `BE-012`, health/activity rails |
| Orchestrator cancel/interrupt missing | `app/shared/contracts/models/orchestrator.py` has UserInput/ExternalUserInput/ToolResult/Response but no Cancel. | `BE-009` | `UIA-002`, `UIA-004`, QA resilience |
| Attachment/context ingestion missing | DB RAG and Orchestrator input exist, but no file/share/context contract. | `BE-008` | `UIA-005`, `AND-006`, `IOS-004` |
| Tool risk taxonomy/approval metadata incomplete | Legacy per-provider `Tooling.GetTools` serializes tool name/description/schema; it is not the full mesh catalog and lacks risk/egress/token-bound approval semantics. | `BE-011` / `MESH-GAP-005` | `UIA-003`, `ADM-007`, security tests |
| Executable capability catalog and route explain missing | MeshBus/routing/peer registry and diagnostic graph primitives exist; user-facing executable catalog, provider inclusion/exclusion, policy persistence, and route explain do not. | `BE-013` / `MESH-GAP-003` | `SDK-006`, `SDK-010`, `SDK-012`, `MESH-003`, route sheet |
| Mesh diagnostics missing | WebRTC client/RPC/latency exist; no UI-safe diagnostics endpoint/events. | `BE-014` | `MESH-004`, `ADM-009`, QA E2E |
| Config diff/rollback/reload-impact missing | `Config.Get`, `Set`, `Validate`, plugin methods exist; no version/diff/rollback contract. | `BE-010` | `ADM-006`, backup/release runbooks |
| Supervisor control overclaimed by constants/mock | `SupervisorMethods` declares Start/Stop/Restart; service implements status and placeholder restart only. | `BE-015` | `ADM-002`, AdminAction service controls |
| Pairing queue/list missing | Pairing start/connect/approve/exchange and event exist; no admin queue endpoint for pending requests. | `BE-012` | `ADM-011`, `MESH-001`, onboarding |
| Diagnostics export missing | Logs/registry/status exist separately; no redacted bundle contract. | `BE-005` | `ADM-009`, QA/release support workflows |
| Backup/restore missing | Config/DB/RAG data exist; no backup lifecycle contracts. | `BE-006` | `ADM-010`, release runbooks |
| Model provider catalog/runtime missing | Orchestrator has runtime logic but no UI-safe provider catalog/import/download/benchmark abstraction. | `BE-007` | `UIA-007`, `AND-008`, `IOS-007` |
| Gateway route/exposure inventory not machine-frozen | `MethodInfo` has fields; static gateway built-ins and dynamic bus routes are separate. | `P0-002` | `SDK-002`, `ADM-002`, contract explorer, capability graph |

## Coverage review additions — runtime/deployment topology and legacy UI migration

| Gap | Current evidence | New/updated task coverage | Downstream UI/SDK coverage |
| --- | --- | --- | --- |
| Process-mode deployment topology and Redis/BullMQ health were only implicit in QA wording. The UI needs a first-class, typed way to distinguish thread mode, process mode, desktop sidecar local mode, server thin mode, and mesh peer shell. | `docker-compose.process.yml` defines per-service process deployment with `AURORA_ARCHITECTURE_MODE=processes` and `REDIS_URL`; `README.process-mode.md` documents Redis/process operations; `app/messaging/local_bus.py`, `app/messaging/bullmq_bus.py`, and `app/messaging/bus_runtime.py` represent bus selection surfaces. | `BE-016` adds a read-only deployment topology/bus health contract; `QA-008` adds explicit transport/mode parity gate. | `ADM-013` wires topology dashboard; `SDK-014`/`QA-008` enforce SDK parity across HTTP, Tauri local, mesh, LocalBus, and BullMQBus. |
| Existing PyQt `UIBridge` behavior was not explicitly mapped to the new Tauri/SDK event model. | `app/ui/bridge_service.py` still bridges STT/TTS/orchestrator/history events via PyQt signals and bus topics. | `TAURI-007` creates the compatibility/deprecation mapping and tests before production Tauri migration can remove or replace PyQt paths. | `UIA-001`, `UIA-002`, `UIA-004`, `SDK-011`, and `TAURI-004` must cover legacy-equivalent chat, STT/TTS, status, and event flows. |
| Memory/RAG provenance, export, and delete governance were too implicit. `BE-006` covers backup/restore, but UIA memory screens need item-level provenance/delete/export contracts. | `app/services/db/service.py` exposes `RAG_SEARCH` as both, while `RAG_STORE`, `RAG_DELETE`, and `RAG_GET` are internal; current UI cannot safely promise delete/export/provenance without a contract. | `BE-017` adds explicit Memory/RAG provenance/export/delete contracts or capability-gated unsupported states. | `UIA-006` now depends on `BE-017`; `ADM-010` remains backup/restore. |
| Scheduler admin UI promised pause/resume but current backend marks those methods internal. | `app/services/scheduler/service.py` has `SchedulerMethods.PAUSE` and `RESUME` with `exposure="internal"`; list/schedule/cancel/pause/resume need permission/audit semantics before admin UI can enable them. | `BE-018` adds scheduler management exposure/AdminAction contract or explicit unsupported capability states. | `ADM-012` now depends on `BE-018`; UI must keep pause/resume disabled until capability exists. |

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production E2E gap crosswalk addendum

Additional mesh production tasks live in `.omx/multica/mesh-production-gap-tasks/` and should be treated as the backend prerequisite layer for final UI implementation.

| Gap | Required task(s) | Downstream UI/SDK tasks |
| --- | --- | --- |
| Generated config/runtime mesh policy mismatch and explicit selector enforcement | MESH-GAP-002 | SDK-012, MESH-003, QA-003, QA-008 |
| No typed executable capability catalog/route explain contract | MESH-GAP-003 | SDK-006, SDK-012, ADM-001, MESH-003, QA-008 |
| Tooling currently lacks local+all-remote aggregate catalog | MESH-GAP-004 | SDK-006, UIA-003, ADM-007, QA-002 |
| Tool approval/confirmation is primitive and not token-bound; local tools also need approval | MESH-GAP-005 | SDK-013, UIA-003, ADM-007, QA-003 |
| Orchestrator/SDK do not yet bind aggregate tools with approval interrupts | MESH-GAP-006 | SDK-006, SDK-012, SDK-013, UIA-001/003 |
| DB/RAG remote access lacks namespace/export/provenance product contract | MESH-GAP-007 | BE-017, UIA-006, QA-002 |
| Audio/STT/TTS remote sessions need explicit consent/event contract | MESH-GAP-008 | UIA-004, QA-002, QA-003 |
| Scheduler/Auth/Config boundaries need production delegation/admin hardening | MESH-GAP-009 | ADM-003/004/006/012, QA-003 |
| Unified mesh events/audit/diagnostics/support bundle gaps | MESH-GAP-010 | ADM-008, ADM-009, QA-008 |
| No production two-peer E2E proof of the capability fabric | MESH-GAP-011 | QA-002, QA-003, QA-008 |

<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.
