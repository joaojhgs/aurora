# PER-156 Tool Catalog Provider Fanout Plan

## Requirements Summary

- Source issue: PER-156 / MESH-GAP-004.
- Source docs read: `.omx/multica/mesh-production-gap-tasks/04-mesh-gap-004-mesh-gap-p2-implement-aggregate-local-plus-remote-tooling-catalog-and-provider-fanout.md`, `.omx/plans/mesh-production-e2e-integration-gap-plan.md`, `.omx/specs/deep-interview-mesh-distributed-integration.md`.
- Relevant code paths: `app/shared/contracts/models/tooling.py`, `app/services/tooling/service.py`, `app/services/orchestrator/agents/chatbot.py`, `app/messaging/mesh_bus.py`, `app/services/gateway/mesh/peer_registry.py`, `tests/unit/tooling/test_service.py`, `tests/unit/orchestrator/test_chatbot.py`, `tests/integration/test_mesh_routing.py`.
- Invariants: bus-only communication, typed Tooling contract constants/models, privacy-first discovery with no raw secrets, backward-compatible `Tooling.GetTools`.

## Acceptance Criteria

- `Tooling.GetToolCatalog` returns local tools plus all eligible remote Tooling provider tools in one response.
- Remote fanout uses explicit `MeshAddressSelector` requests to `Tooling.GetTools`, so existing MeshBus/PeerBridge policy and provider eligibility gates remain authoritative.
- Ineligible or failed providers are represented with machine-readable reason codes.
- Bindable tool names remain collision-safe and stable across local and remote providers.
- Dangerous, sensitive, or confirmation-required tools are present as blocked/non-bindable catalog entries and are not bound directly to the LLM by the orchestrator.
- Existing `Tooling.GetTools` behavior stays unchanged for per-provider callers.

## Implementation Steps

1. Add Tooling catalog IO models and `ToolingMethods.GET_TOOL_CATALOG`.
2. Implement `ToolingService._on_get_tool_catalog` with local discovery, remote provider candidate fanout, short TTL cache, and cache invalidation on reload/local tool changes.
3. Add blocked provider/tool reason projection and safe bindable filtering.
4. Update chatbot tool retrieval to prefer `Tooling.GetToolCatalog`, with graceful fallback to legacy `GetTools`.
5. Add unit tests for local+remote aggregation, collisions, blocked providers, cache invalidation, and unsafe filtering.
6. Add a mocked MeshBus/PeerBridge integration test for explicit remote Tooling provider fanout.

## Risks And Mitigations

- Risk: ToolingService may not always run behind MeshBus in unit tests. Mitigation: detect optional registry/mesh internals conservatively and still return local catalog.
- Risk: remote calls may fail or time out. Mitigation: record a blocked provider entry and keep local tools available.
- Risk: unsafe tools could leak into LLM binding. Mitigation: catalog marks bindability and chatbot consumes only bindable tools.

## Verification

- `uv run pytest tests/unit/tooling/test_service.py tests/unit/orchestrator/test_chatbot.py tests/integration/test_mesh_routing.py -q`
- If dependency extras are missing, rerun with the minimal documented extras for gateway/tooling/orchestrator integration.
