# [MESH-GAP][P3] Implement scheduler delegation plus Auth/Config admin boundary hardening

## Execution metadata

- **Task ID:** MESH-GAP-009
- **Phase:** P3
- **Labels:** scheduler, auth, config, adminaction, mesh-security
- **Depends on:** MESH-GAP-002, MESH-GAP-003, MESH-GAP-005
- **Parallelizable with:** Can run with MESH-GAP-007/MESH-GAP-008 after approval/admin contracts
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
Close two high-risk boundary gaps: remote scheduler jobs need ownership/delegation semantics, and Auth/Config must remain privileged admin APIs rather than broad transparent mesh services.

## Scheduler requirements
- Remote schedule/list/cancel must carry:
  - namespace
  - owner peer/principal
  - executing peer
  - target selector/resource
  - delegated permission context
  - approval/policy decision ID
  - audit correlation ID
- Jobs that invoke tools/orchestrator flows must use delegated approval tokens from MESH-GAP-005, not ambient caller permissions forever.
- Listing and cancellation must be scoped by namespace/owner/permissions.
- Imported/migrated jobs must get new local IDs unless explicit ownership transfer is implemented.

## Auth/Config requirements
- Keep Auth/Config out of ordinary `gateway.mesh.services` sharing by default.
- Pairing/login infrastructure remains specially allowed as needed for WebRTC pairing/auth.
- Broad Auth admin and Config mutation require HTTP/admin RBAC and AdminAction draft-confirm-audit:
  - principal create/update/delete
  - permission changes
  - token create/revoke/scope update
  - peer approve/deny/remove/permission update
  - config set/plugin set/reload-impact changes
- Remote RPC for broad Auth/Config must be denied unless a future explicit admin-over-mesh mode is designed and approved.

## Code references
- `app/services/scheduler/service.py`
- `app/shared/contracts/models/scheduler.py`
- `app/services/auth/service.py`
- `app/shared/contracts/models/auth.py`
- `app/services/config/service.py`
- `app/shared/contracts/models/config.py` if present
- `app/services/gateway/webrtc/rpc.py`
- `app/services/gateway/service.py` mesh service map
- `.omx/specs/ui-production-tasks/tasks/ADM-003-wire-rbac-principals-roles-permissions-and-effective-access.md`
- `.omx/specs/ui-production-tasks/tasks/ADM-006-wire-config-editor-validation-diff-rollback-reload-impact.md`
- `.omx/specs/ui-production-tasks/tasks/ADM-012-wire-scheduler-jobs-and-automation-management.md`

## Acceptance criteria
- Remote scheduler operations are namespace/owner scoped and audited.
- Tool-invoking scheduled jobs preserve delegated approval/permission context.
- Auth/Config broad mesh RPC calls are denied by default.
- Admin HTTP mutations go through AdminAction/RBAC.
- UI can show scheduler/admin blocked reasons and required approvals.

## Verification
- Scheduler namespace/delegation tests.
- RPC denial tests for broad Auth/Config.
- AdminAction tests for risky Auth/Config changes.
- Audit assertions for schedule/create/execute/cancel/deny and Auth/Config mutation flows.
