# PER-153 Mesh Branch Baseline Plan

Issue: PER-153 / MESH-GAP-001
Date: 2026-06-18

## Requirements Summary

Normalize the mesh-gap implementation target before downstream mesh-gap code work. The issue branch policy selects `feat/mesh-full-services-integrations` as the base/integration branch, so this task verifies that branch head directly instead of relying on the older `/tmp/aurora-mesh-review` snapshot from `origin/feat/migration-to-modular-services-architecture`.

Source docs and constraints read:

- Multica issue PER-153 title, description, metadata, and comments.
- `AGENTS.md`, `app/services/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/services/auth/AGENTS.md`, `app/messaging/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, `tests/AGENTS.md`.
- `.omx/multica/mesh-production-gap-tasks/01-mesh-gap-001-mesh-gap-p0-normalize-branch-state-and-verify-mesh-primitive-baseline.md`.
- `.omx/plans/mesh-production-e2e-integration-gap-plan.md`.
- `.omx/specs/deep-interview-mesh-distributed-integration.md`.

## Acceptance Criteria

- Canonical target branch and SHA are documented.
- Branch relation to the prior reviewed migration branch is documented.
- Required primitive availability matrix is complete with concrete code/test references.
- Stale local checkout divergence is resolved or documented as a blocker.
- Targeted primitive suite passes.

## Implementation Steps

1. Establish a clean clone from `origin/feat/mesh-full-services-integrations` and create `multica/PER-153-mesh-branch-baseline`.
2. Record branch SHAs and ancestry counts for `origin/feat/mesh-full-services-integrations`, `origin/feat/migration-to-modular-services-architecture`, and `origin/main`.
3. Inspect the required primitives in:
   - `app/messaging/mesh_bus.py`
   - `app/services/gateway/mesh/routing_table.py`
   - `app/services/gateway/mesh/peer_registry.py`
   - `app/services/gateway/service.py`
   - `app/services/tooling/service.py`
   - `app/services/orchestrator/tool_bindings.py`
   - `app/services/scheduler/service.py`
   - `app/shared/contracts/models/*`
   - targeted mesh/tooling/orchestrator/scheduler tests
4. Run the issue's targeted primitive suite with the required extras.
5. Write `.omx/reports/mesh-gap-branch-baseline.md` with branch evidence, matrix, test result, and downstream risks.
6. Commit and publish a PR targeted at `feat/mesh-full-services-integrations`, then hand off to QA.

## Risks and Mitigations

- Risk: using the stale `/home/developer/projects/aurora` checkout would mix an unrelated UI branch and a modified tracked DB artifact into the baseline. Mitigation: use a clean workspace clone from the canonical branch and leave that checkout untouched.
- Risk: runtime mesh policy fields may not all be exposed in generated config. Mitigation: report this precisely; `require_explicit_selector` exists in runtime config but is absent from generated config schema/defaults/keys and remains downstream config-parity work.
- Risk: test tooling writes generated artifacts. Mitigation: restore unrelated generated file changes before commit.

## Verification Steps

Run:

```bash
env UV_CACHE_DIR=/tmp/uv-cache /home/developer/.local/bin/uv run --extra gateway --extra service-tooling --extra service-orchestrator --extra service-scheduler --extra test-integration pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_registry.py tests/unit/gateway/test_capability_graph.py tests/unit/tooling/test_service.py tests/unit/orchestrator/test_tool_bindings.py tests/unit/orchestrator/test_graph.py tests/unit/app/config/test_mesh_sharing_schema.py tests/unit/app/scheduler/test_scheduler_remote_policy.py -q
```

Expected result: all tests pass. Record warnings, cache/path adaptations, and any generated file cleanup in the report.
