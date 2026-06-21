# [MESH-GAP][P2] Implement tool sharing policy and approval protocol for local and mesh tools

## Execution metadata

- **Task ID:** MESH-GAP-005
- **Phase:** P2
- **Labels:** tooling, security, approval, adminaction, mesh
- **Depends on:** MESH-GAP-002, MESH-GAP-003
- **Parallelizable with:** Can run with MESH-GAP-004; MESH-GAP-006 depends on it
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
Replace coarse service-level Tooling sharing and raw `confirmed=true` with production policy and approval semantics for both local/internal tools and remote mesh tools.

## Critical requirement from user
The approval harness must not be limited to aggregated tools from mesh peers. It must also support internal/local tools. Permission mode must be configurable, including an approve-all option.

## Backend/API requirements
Add Tooling/AdminAction contracts for:
- `Tooling.GetSharingPolicy`
- `Tooling.SetSharingPolicy`
- `Tooling.TestSharingPolicy`
- `Tooling.PrepareExecution`
- `Tooling.RequestApproval`
- `Tooling.ConfirmExecution`
- `Tooling.ExecuteTool` requiring an approval token for applicable policies

Policy dimensions:
- tool ID / global tool ID
- local vs remote execution location
- source type: core, plugin, MCP, toolkit
- toolkit/server name
- safety class: standard, sensitive, dangerous
- operation class: read, write, external, admin, hardware, data-egress
- resource namespace/hardware target/data scope
- caller peer/principal/device
- provider peer/service instance
- route/privacy class

Configurable approval modes:
- `deny_all` for category/tool/peer.
- `ask_each_time`.
- `allow_once` / approval token single use.
- `allow_until_expiry`.
- `approve_all_for_session`.
- `approve_all_for_peer` for trusted peers, only if admin enabled.
- `approve_all_local_safe` for internal/local safe tools, configurable and auditable.
- `dry_run_only`.

Approval token must bind:
- caller principal and peer/device
- target provider peer and service instance
- tool/global tool ID
- normalized redacted args hash
- resource selector
- route decision ID
- expiry
- nonce/replay guard
- approver principal
- policy decision ID

Security requirements:
- Raw `confirmed=true` alone must not authorize sensitive/dangerous/approval-required execution.
- Dry-run remains available for preview.
- Every approve/deny/execute/fail path emits audit with correlation ID.
- Remote RPC handler must continue injecting trusted caller provenance.

## Code references
- `app/services/tooling/service.py`
- `app/shared/contracts/models/tooling.py`
- `app/shared/auth/audit.py`
- `app/services/auth/service.py` audit methods
- `app/services/gateway/webrtc/rpc.py`
- `.omx/specs/ui-production-tasks/tasks/BE-004-implement-adminaction-draft-confirm-audit-enforcement.md`
- `.omx/specs/ui-production-tasks/tasks/BE-011-add-tool-risk-taxonomy-and-approval-hints.md`
- `tests/unit/tooling/test_service.py`

## Acceptance criteria
- Local/internal tools can require approval and can use approve-all modes according to policy.
- Remote tools can require approval with token-bound execution.
- Dangerous remote tool fails without valid approval token.
- Token replay, expiry, peer mismatch, args mismatch, tool mismatch, and resource mismatch are denied.
- Sharing policy can hide or expose specific tools independently of service-level Tooling share.
- Admin-configured approve-all modes are visible, auditable, reversible, and permission-gated.

## Verification
- Unit tests for every approval mode.
- Negative tests for raw `confirmed=true` bypass.
- Token mismatch/replay/expiry tests.
- Audit assertions for approve/deny/dry-run/execute.
- Integration test with local safe tool approve-all and remote dangerous tool approval-required.
