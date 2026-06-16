# PER-136 Provider Aggregation Plan

## Source Context

- Multica issue: PER-136, `[MESH][P2-T03] Support provider aggregation instead of one-provider-per-module routing`.
- Runtime metadata: expected branch `multica/P2-T03-provider-aggregation`, batch tail, verification depth focused on PeerRegistry unit tests and mesh diagnostics.
- Read guidance: `AGENTS.md`, `app/services/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/shared/AGENTS.md`, `tests/AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/GATEWAY.md`.
- Referenced `.omx/multica/mesh-roadmap-tasks/P2-T03*` and `.omx/specs/deep-interview-mesh-distributed-integration.md` are absent from this checkout. Existing adjacent plans `PER-134` and `PER-135` are present and show the same missing-doc fallback.

## Requirements

- Add a PeerRegistry API that returns all provider candidates for a module, not just the selected best provider.
- Include testable eligibility diagnostics for included and excluded providers.
- Preserve `get_best_provider()` behavior for transparent legacy routing.
- Respect allowed peers, version policy, required capabilities, capacity, explicit selectors, and exclude lists.
- Reuse diagnostics in mesh status output so route explanations expose the same inclusion/exclusion reasons.

## Implementation Steps

1. Add provider diagnostic models in `app/services/gateway/mesh/models.py` for candidate service metadata, eligibility, and reason codes.
2. Refactor `PeerRegistry` provider filtering into a shared aggregation helper that powers both `get_provider_candidates()` and existing `get_best_provider()`.
3. Extend Gateway route diagnostics to consume the aggregation API instead of reimplementing provider eligibility locally.
4. Add PeerRegistry tests covering 3+ overlapping providers, allowlists, version, capabilities, capacity, excluded peers, explicit selector narrowing, and best-provider regression.
5. Update mesh diagnostics tests to assert machine-readable exclusion reason codes.

## Acceptance Criteria

- Multiple Tooling providers can be represented and queried simultaneously.
- `get_best_provider()` remains available and still returns the lowest-latency eligible peer under current policy.
- Excluded providers include stable, testable reason codes and human-readable reasons.
- Provider aggregation respects peer allowlists and capability/version policy.
- Targeted unit tests pass.

## Verification

- `uv run pytest tests/unit/gateway/test_peer_registry.py tests/unit/gateway/test_mesh_diagnostics.py -q`
- `uv run pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_capability_graph.py -q`
- `uv run ruff check app/services/gateway/mesh/peer_registry.py app/services/gateway/mesh/models.py app/services/gateway/service.py tests/unit/gateway/test_peer_registry.py tests/unit/gateway/test_mesh_diagnostics.py`
- `git diff --check`

## Risks

- Risk: duplicate diagnostic logic diverges. Mitigation: route diagnostics consume PeerRegistry aggregation output.
- Risk: best-provider behavior changes. Mitigation: keep selection policy unchanged and add regression tests.
- Risk: selector filtering is confused with transparent routing. Mitigation: selector support is an optional aggregation filter and does not change routing fallback behavior.
