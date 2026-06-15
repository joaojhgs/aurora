# Backend/API Gap Crosswalk for UI Production Tasks

Date: 2026-06-14  
Purpose: maps backend gaps discovered from code/spec/mock review to the individual backend and downstream UI/SDK tasks.

| Gap | Current code evidence | Primary task | Downstream tasks unblocked |
|---|---|---|---|
| AdminAction server-enforced draft/confirm/audit envelope missing | Manage contracts exist across `Auth`, `Config`, `Supervisor`, mesh, but generated routes do not enforce confirmation nonce/digest/reason. Audit primitives exist at `Auth.StoreAuditEvent`/`Auth.AuditLog`. | `BE-004` | `SDK-013`, `ADM-003`, `ADM-004`, `ADM-005`, `ADM-006`, `ADM-008`, `ADM-010`, `MESH-001` |
| Streaming/events missing as unified public contract | `Orchestrator.Response` is an event; `Config.Updated` exists; gateway dynamic routes are request/response. | `BE-003` | `SDK-011`, `UIA-002`, `BE-012`, health/activity rails |
| Orchestrator cancel/interrupt missing | `app/shared/contracts/models/orchestrator.py` has UserInput/ExternalUserInput/ToolResult/Response but no Cancel. | `BE-009` | `UIA-002`, `UIA-004`, QA resilience |
| Attachment/context ingestion missing | DB RAG and Orchestrator input exist, but no file/share/context contract. | `BE-008` | `UIA-005`, `AND-006`, `IOS-004` |
| Tool risk taxonomy/approval metadata incomplete | `Tooling.GetTools` serializes tool name/description/schema; no risk/egress/approval hints. | `BE-011` | `UIA-003`, `ADM-007`, security tests |
| Mesh route policy/explain missing | MeshBus/routing/peer registry exist; user-facing policy persistence/explain does not. | `BE-013` | `SDK-010`, `SDK-012`, `MESH-003`, route sheet |
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
