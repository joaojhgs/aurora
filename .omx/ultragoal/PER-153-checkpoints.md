# PER-153 Ultragoal Checkpoints

Issue: PER-153 / MESH-GAP-001
Branch: `multica/PER-153-mesh-branch-baseline`

## 2026-06-18

Goal: Normalize branch state and verify mesh primitive baseline before downstream mesh-gap implementation.

Completed:

- Read Multica issue, metadata, full comment history, root/runtime AGENTS, repository AGENTS, relevant subsystem AGENTS, mesh production gap plan, deep-interview mesh spec, and the generated MESH-GAP-001 task file.
- Created branch `multica/PER-153-mesh-branch-baseline` from `origin/feat/mesh-full-services-integrations`.
- Verified canonical branch SHA and relation to the prior reviewed migration branch.
- Inspected source/test evidence for selector routing, provider candidates, gateway diagnostics, tooling metadata/execution policy, orchestrator remote bindings, scheduler ownership policy, tracing/correlation, and chaos/failure tests.
- Wrote `.omx/plans/PER-153-mesh-branch-baseline.md`.
- Wrote `.omx/reports/mesh-gap-branch-baseline.md`.

Verification:

```bash
env UV_CACHE_DIR=/tmp/uv-cache /home/developer/.local/bin/uv run --extra gateway --extra service-tooling --extra service-orchestrator --extra service-scheduler --extra test-integration pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_registry.py tests/unit/gateway/test_capability_graph.py tests/unit/tooling/test_service.py tests/unit/orchestrator/test_tool_bindings.py tests/unit/orchestrator/test_graph.py tests/unit/app/config/test_mesh_sharing_schema.py tests/unit/app/scheduler/test_scheduler_remote_policy.py -q
```

Result: `107 passed, 4 warnings in 12.69s`.

Notes:

- Runtime `MeshServiceConfig.require_explicit_selector` is present, but generated config schema/defaults/keys do not expose it. This is documented as downstream config-parity work.
- The local `/home/developer/projects/aurora` checkout is not the baseline source for this task because it is on an unrelated UI branch with a modified tracked scheduler DB artifact.
