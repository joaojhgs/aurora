# Mesh Gap Branch Baseline

Issue: PER-153 / MESH-GAP-001
Date: 2026-06-18
Working branch: `multica/PER-153-mesh-branch-baseline`
Target PR base: `feat/mesh-full-services-integrations`

## Canonical Branch Decision

The canonical implementation base for mesh-gap work is `origin/feat/mesh-full-services-integrations`.

Evidence:

| Ref | SHA | Note |
| --- | --- | --- |
| `origin/feat/mesh-full-services-integrations` | `1b945f03fc6a557a1c868218ac2491d2f5bc046f` | Required branch-policy integration branch; this report's base. |
| `multica/PER-153-mesh-branch-baseline` | `1b945f03fc6a557a1c868218ac2491d2f5bc046f` before report commit | Dedicated PER-153 branch created from the canonical branch. |
| `origin/feat/migration-to-modular-services-architecture` | `5e670fa77bbdbd884001c8459906cb01d0d67095` | Prior review source from the gap plan. |
| `origin/main` | `1368bf3b83aa07ea9cee4bfaa8941e3c15f78768` | Not the target for mesh-gap task PRs. |

Branch relation:

- `git merge-base origin/feat/mesh-full-services-integrations origin/feat/migration-to-modular-services-architecture` -> `ab69218d2e08cb7178afa30ef8742e56f14020f7`.
- `git rev-list --left-right --count origin/feat/mesh-full-services-integrations...origin/feat/migration-to-modular-services-architecture` -> `383 394`.
- The branch-policy issue text supersedes the older local checkout warning: downstream mesh-gap work should start from `origin/feat/mesh-full-services-integrations`, not the stale `/home/developer/projects/aurora` checkout and not `origin/main`.

Local checkout note:

- `/home/developer/projects/aurora` was inspected and is on `feat/ui-mesh-diagnostics-status-surface` with a modified tracked `tests/test_scheduler.db`. It was not used for this baseline to avoid discarding or mixing unrelated local changes.
- A clean workspace clone was created from `origin/feat/mesh-full-services-integrations` for PER-153.

## Primitive Availability Matrix

| Primitive | Status on canonical branch | Evidence |
| --- | --- | --- |
| `MeshAddressSelector` model | Present | `app/shared/contracts/models/mesh.py` defines `MeshAddressSelector` with peer/provider/service/tool/resource selector fields. |
| Selector extraction in `MeshBus` | Present | `app/messaging/mesh_bus.py` imports `MeshAddressSelector`, calls `_extract_mesh_selector()` in publish/request paths, and accepts dict/model selector payloads. |
| Explicit-selector routing | Present | `app/services/gateway/mesh/routing_table.py` accepts a selector in `resolve()`, validates selected peer/provider/service/version/capacity, and returns structured route errors. |
| No transparent fallback for selected providers | Present | `RoutingTable.resolve_fallback()` returns an error for explicit selector targets, and tests cover stale explicit selector rejection without fallback. |
| `PeerRegistry.get_provider_candidates()` | Present | `app/services/gateway/mesh/peer_registry.py` defines `get_provider_candidates()` and returns `ProviderCandidate` records with `eligible`, `reason_code`, and `reason`. |
| Inclusion/exclusion reasons | Present | `tests/unit/gateway/test_peer_registry.py` covers overlapping providers, allowlists, version/capability filters, capacity, exclusions, and selector narrowing. |
| `Gateway.GetMeshStatus` | Present | `app/shared/contracts/models/gateway.py` defines `GatewayMethods.GET_MESH_STATUS`; `app/services/gateway/service.py` registers `get_mesh_status()` and emits route/provider diagnostics. |
| `Gateway.GetCapabilityGraph` | Present | `app/shared/contracts/models/gateway.py` defines `GatewayMethods.GET_CAPABILITY_GRAPH`; `app/services/gateway/service.py` registers `get_capability_graph()`; `tests/unit/gateway/test_capability_graph.py` covers graph behavior and redaction. |
| Tooling stable metadata | Present | `app/shared/contracts/models/tooling.py` includes `global_tool_id`, provider metadata, `execution_location`, safety/confirmation fields, and selectors. `app/services/tooling/service.py` builds stable global IDs and namespaced remote tool names. |
| Remote Tooling execution policy/provenance | Present as primitive | `ToolingExecuteToolRequest` carries `mesh_selector`, `resource_selector`, `confirmed`, `dry_run`, `caller_peer_id`, `caller_principal_id`, and `correlation_id`; `app/services/tooling/service.py` denies sensitive/dangerous remote execution without resource selector and audits correlation/provenance. Approval-token protocol remains downstream work. |
| Orchestrator remote tool binding | Present as primitive | `app/services/orchestrator/tool_bindings.py` hides high-risk remote tools from automatic model selection and preserves hidden mesh selectors for safe remote bindings. `tests/unit/orchestrator/test_tool_bindings.py` and `tests/unit/orchestrator/test_graph.py` cover this path. |
| Scheduler remote namespace/owner policy | Present | `app/shared/contracts/models/scheduler.py` carries namespace, owner, target selector, delegated permissions, policy decision, and caller fields. `app/services/scheduler/service.py` filters remote list/cancel scope and preserves delegated context; `tests/unit/app/scheduler/test_scheduler_remote_policy.py` covers it. |
| Tracing/correlation helpers | Present | `app/shared/mesh/tracing.py`, `app/services/gateway/webrtc/rpc.py`, `app/services/gateway/mesh/peer_bridge.py`, and `app/messaging/*_bus.py` carry correlation IDs across requests/events. Gateway RPC tests cover trusted correlation propagation and redacted denial audit details. |
| Chaos/failure tests | Present | `tests/integration/test_mesh_chaos_failure_modes.py`, `tests/integration/test_mesh_failover.py`, and `tests/integration/test_mesh_routing.py` cover stale peers, disconnect/fallback, service reannouncement, selector failures, and forwarded event correlation. |
| Mesh config generated parity | Partial | Generated config exposes `allowed_peers`, `min_version`, and `required_capabilities`; runtime `MeshServiceConfig` also has `require_explicit_selector`, but generated `MeshSharing` schema/defaults/keys do not expose that field. This is a downstream config-parity gap, not a branch-normalization blocker. |

## Verification

Command run:

```bash
env UV_CACHE_DIR=/tmp/uv-cache /home/developer/.local/bin/uv run --extra gateway --extra service-tooling --extra service-orchestrator --extra service-scheduler --extra test-integration pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_registry.py tests/unit/gateway/test_capability_graph.py tests/unit/tooling/test_service.py tests/unit/orchestrator/test_tool_bindings.py tests/unit/orchestrator/test_graph.py tests/unit/app/config/test_mesh_sharing_schema.py tests/unit/app/scheduler/test_scheduler_remote_policy.py -q
```

Result:

- `107 passed, 4 warnings in 12.69s`.
- Warnings were existing Pydantic/pytest-asyncio warnings plus the `ToolingToolInfo.schema` field-name warning.

Environment notes:

- Plain `uv run ...` failed first because `uv` was not on the shell `PATH`.
- `/home/developer/.local/bin/uv` was used.
- The first direct `/home/developer/.local/bin/uv` run failed because the default UV cache path was read-only; rerunning with `UV_CACHE_DIR=/tmp/uv-cache` succeeded and created a local `.venv` with CPython 3.11.15.
- The test run modified tracked `assets/graph.png`; it was restored before preparing the branch diff.

## Outcome

The stale/diverged checkout concern is resolved for this task by using the board-policy canonical branch `origin/feat/mesh-full-services-integrations` at `1b945f03fc6a557a1c868218ac2491d2f5bc046f`.

The required mesh primitives are present on the canonical branch and the targeted primitive suite passes. Downstream mesh-gap tasks can start from `feat/mesh-full-services-integrations` and should treat generated config parity for `require_explicit_selector`, aggregate capability/tool catalogs, approval protocol, and production E2E harnessing as remaining work per the mesh-gap plan.
