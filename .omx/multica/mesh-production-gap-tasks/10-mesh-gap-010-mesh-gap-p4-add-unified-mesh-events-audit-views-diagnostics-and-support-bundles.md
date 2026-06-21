# [MESH-GAP][P4] Add unified mesh events, audit views, diagnostics, and support bundles

## Execution metadata

- **Task ID:** MESH-GAP-010
- **Phase:** P4
- **Labels:** mesh, observability, events, audit, diagnostics
- **Depends on:** MESH-GAP-003, MESH-GAP-005
- **Parallelizable with:** Can run with MESH-GAP-011 harness once core event types are defined
- **Project:** 5345dd7c-2f0b-4a4b-b636-c1db93067f0a

## Shared context

This task is part of the Mesh Production E2E Gap Plan in `.omx/plans/mesh-production-e2e-integration-gap-plan.md`.

Context summary:
- The original mesh roadmap intended a production-grade cross-peer capability fabric, not generic remote service redirection.
- Generic MeshBus/PeerBridge/RPC service routing is a foundation only.
- Production must support local + multiple remote peer capability discovery, provider aggregation, route explanation, per-tool/per-resource sharing policy, approval/confirmation, auditability, and UI/SDK-visible degraded/blocked states.
- Reviewed implementation evidence came from `/tmp/aurora-mesh-review` at `origin/feat/migration-to-modular-services-architecture` commit `5e670fa`; the active local checkout was stale/diverged during review. Normalize branch state before implementation.
- Preserve Aurora's bus-first architecture, typed topic constants, Pydantic/IOModel contracts, generated config pattern, and privacy-first defaults.


<!-- BRANCH-POLICY -->
## Branch policy

- **Base / integration branch:** `feat/mesh-full-services-integrations`.
- Create implementation branches from `origin/feat/mesh-full-services-integrations`, not from `main` and not from `feat/migration-to-modular-services-architecture`.
- Pull requests for this task must merge back into `feat/mesh-full-services-integrations` unless the architect explicitly retargets the batch.
- Do not merge directly to `main` from these mesh-gap tasks. `main` receives the integrated mesh work only after the full mesh production sequence is accepted.

## Objective
Expose the runtime evidence needed for UI and production operations: capability changes, route decisions, approvals, execution results, audio session states, RAG/data operations, scheduler events, and audit views.

## Backend/API requirements
- Extend or implement unified event stream contract from UI task `BE-003`.
- Event categories:
  - capability catalog changed/stale/refreshed
  - peer/provider connected/disconnected/stale/negotiated
  - route explain / route failure / fallback used
  - tool approval requested/approved/denied/expired/executed/failed
  - local/internal tool approval events as well as remote mesh tool events
  - RAG/data query/export/import/delete/tombstone events
  - audio session consent/start/stop/privacy indicator/transcription result
  - scheduler create/execute/cancel/deny
  - Auth/Config AdminAction draft/confirm/deny/audit
- Add redacted support bundle endpoint that includes mesh status, route diagnostics, capability catalog summary, recent audit events, config shape without secrets, and testable correlation IDs.

## Code references
- `app/shared/mesh/tracing.py`
- `app/services/gateway/service.py`
- `app/services/gateway/mesh/peer_bridge.py`
- `app/services/gateway/webrtc/rpc.py`
- `app/services/auth/service.py` audit log methods
- `.omx/specs/ui-production-tasks/tasks/BE-003-add-unified-event-stream-contract.md`
- `.omx/specs/ui-production-tasks/tasks/BE-005-add-diagnostics-bundle-export-contract-with-redaction.md`
- `.omx/specs/ui-production-tasks/tasks/ADM-008-wire-audit-log-details-and-export.md`
- `.omx/specs/ui-production-tasks/tasks/ADM-009-wire-diagnostics-probes-and-redacted-support-bundle.md`

## Acceptance criteria
- UI can subscribe to live approval, route, capability, peer, and audio/data events.
- Support bundle is redacted and useful for route/tool/audio/data debugging.
- Events carry correlation IDs and source/target peer where applicable.
- Audit views can filter by peer, provider, tool, action, policy decision, route, and correlation.

## Verification
- Event stream unit/integration tests.
- Redaction tests for support bundle.
- Audit filter tests.
- Failure-mode tests for disconnected peer, expired approval, route fallback, denied data/audio request.
