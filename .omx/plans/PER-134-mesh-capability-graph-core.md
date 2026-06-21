# PER-134 Mesh Capability Graph Core Plan

## Requirements Summary
- Source of truth: Multica issue PER-134, plus the task/spec content read from `origin/main` because the checked-out base branch does not contain `.omx/multica/mesh-roadmap-tasks/` or `.omx/specs/deep-interview-mesh-distributed-integration.md`.
- Preserve existing module-level mesh routing in `app/services/gateway/mesh/peer_registry.py`, `app/services/gateway/mesh/routing_table.py`, and `app/messaging/mesh_bus.py`.
- Add a first-class, read-only capability graph that represents local and remote peers, service instances, methods, tools/resources for future expansion, policy/trust metadata, latency/capacity, version/capabilities, and provenance.
- Keep graph state in Gateway/runtime memory for this slice. Do not add Auth/DB persistence or change mesh routing behavior.
- Expose graph output through a redacted Gateway query for diagnostics and future Orchestrator use.

## Acceptance Criteria
- The graph can represent multiple peers providing the same module with different versions, capabilities, capacity, latency, and policy metadata.
- The graph model includes explicit peer/provider/resource identity fields sufficient for future remote Tooling, DB namespaces, hardware tools, scheduler ownership, and explicit selectors.
- Existing routing and manifest negotiation continue to work.
- Gateway graph output is read-only and does not include token, password, API key, or credential field names.
- Tests cover Pydantic model validation and graph construction from local registry plus remote peer manifests.

## Implementation Steps
1. Add capability graph Pydantic models and a `GatewayMethods.GET_CAPABILITY_GRAPH` topic in `app/shared/contracts/models/gateway.py`.
2. Add a pure graph builder under `app/services/gateway/mesh/` that accepts mesh config, local registry snapshots, peer registry snapshots, and local peer identity, then returns a redacted `CapabilityGraph`.
3. Wire `GatewayService.get_capability_graph()` as an external manage method using `EmptyInput`, without changing transparent routing.
4. Add focused unit tests in `tests/unit/gateway/` for graph models, local/remote provider aggregation, explicit resource placeholders, policy/trust defaults, capacity/latency redaction, and no-secret output.
5. Run targeted tests, then the existing mesh diagnostics/routing tests affected by shared models.

## Risks And Mitigations
- Risk: graph models become too speculative. Mitigation: keep future tool/resource descriptors generic but typed, and populate only service/method facts from current manifests.
- Risk: route behavior changes accidentally. Mitigation: no routing table changes; tests include existing routing/diagnostic coverage.
- Risk: diagnostic output leaks sensitive strings. Mitigation: model field names avoid credential terms and tests assert JSON output excludes common secret field names.

## Verification
- `uv run pytest tests/unit/gateway/test_capability_graph.py tests/unit/gateway/test_mesh_models.py tests/unit/gateway/test_mesh_diagnostics.py -q`
- If those pass quickly, add `uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_registry.py -q`.

## Stop Condition
PER-134 is ready for QA when the branch contains graph models, builder/service wiring, focused tests, a commit, a draft PR, and a Multica QA handoff with exact verification evidence.
