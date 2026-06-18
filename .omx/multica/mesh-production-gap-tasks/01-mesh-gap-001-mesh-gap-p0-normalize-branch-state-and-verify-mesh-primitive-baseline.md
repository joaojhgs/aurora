# [MESH-GAP][P0] Normalize branch state and verify mesh primitive baseline

## Execution metadata

- **Task ID:** MESH-GAP-001
- **Phase:** P0
- **Labels:** mesh, mesh-gap, release-readiness, tests
- **Depends on:** None
- **Parallelizable with:** Must complete before code-changing mesh-gap tasks
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
Normalize the repository branch state before implementing any mesh-gap tasks. During planning, local `feat/migration-to-modular-services-architecture` was ahead 2 and behind 38 while `/tmp/aurora-mesh-review` at `5e670fa` had the completed mesh primitives. The implementation branch must be made unambiguous.

## Required implementation details
- Decide the canonical branch for mesh+UI work with maintainers/board policy; likely merge/rebase local work onto `origin/feat/migration-to-modular-services-architecture` or switch to the remote branch head.
- Preserve local-only changes if relevant; do not discard uncommitted or ahead commits without explicit review.
- Confirm these primitives exist on the target branch or port them before downstream tasks:
  - `MeshAddressSelector` and selector extraction in `MeshBus`.
  - explicit-selector routing and no fallback for selected providers.
  - `PeerRegistry.get_provider_candidates()` with inclusion/exclusion reasons.
  - `Gateway.GetMeshStatus` and `Gateway.GetCapabilityGraph` or equivalent diagnostics.
  - Tooling stable metadata and remote execution policy.
  - scheduler remote namespace/owner policy.
  - tracing/correlation helpers and chaos tests.
- Produce `.omx/reports/mesh-gap-branch-baseline.md` with commit SHAs, branch relation, tests run, and primitive availability matrix.

## Code references
- `app/messaging/mesh_bus.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/service.py`
- `app/services/tooling/service.py`
- `app/services/orchestrator/tool_bindings.py`
- `app/services/scheduler/service.py`
- `.omx/plans/mesh-production-e2e-integration-gap-plan.md`

## Acceptance criteria
- Canonical target branch is documented with current SHA.
- Primitive availability matrix is complete.
- Stale local/remote divergence is resolved or explicitly documented as a blocker.
- Targeted primitive suite passes.

## Verification
Run, adapting extras if dependency groups changed:
```bash
uv run --extra gateway --extra service-tooling --extra service-orchestrator --extra service-scheduler --extra test-integration pytest   tests/unit/gateway/test_routing_table.py   tests/unit/gateway/test_peer_registry.py   tests/unit/gateway/test_capability_graph.py   tests/unit/tooling/test_service.py   tests/unit/orchestrator/test_tool_bindings.py   tests/unit/orchestrator/test_graph.py   tests/unit/app/config/test_mesh_sharing_schema.py   tests/unit/app/scheduler/test_scheduler_remote_policy.py -q
```
