# PER-135 Hybrid Addressing Primitives Plan

## Source Context

- Multica issue: PER-135, `[MESH][P2-T02] Add hybrid addressing primitives for peer, provider, resource, and namespace selectors`.
- Issue acceptance: typed and validated explicit selector paths; transparent routing remains compatible; selector failures are actionable; policy can require explicit selectors for safety-sensitive categories.
- Present source docs read: `AGENTS.md`, `app/messaging/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, `app/services/gateway/AGENTS.md`, `tests/AGENTS.md`.
- Referenced `.omx/multica/mesh-roadmap-tasks/` and `.omx/specs/deep-interview-mesh-distributed-integration.md` are not present on this checked-out branch, so the issue body is the task source of truth.

## Requirements

- Add a common typed selector model with optional `peer_id`, `provider_id`, `service_instance_id`, `resource_namespace`, `tool_id`, `hardware_target`, and `data_scope`.
- Keep transparent routing behavior for existing callers that do not provide selectors.
- Make explicit selector routing take precedence over module-level `prefer` policy.
- Return clear route errors for missing peer/provider/service, stale peers, disallowed peers, incompatible versions/capabilities, or policy-required selectors.
- Add per-service policy configuration that can require explicit selectors without changing defaults.
- Document transparent vs explicit categories and focused test coverage.

## Implementation Steps

1. Add selector and failure primitives in `app/shared/contracts/models/mesh.py` and route-decision metadata in `app/services/gateway/mesh/models.py`.
2. Add optional selector fields to safety-sensitive contract payloads in `app/shared/contracts/models/tooling.py` and DB/RAG models in `app/shared/contracts/models/db.py`.
3. Extend `MeshServiceConfig` in `app/services/gateway/config.py` with a backwards-compatible `require_explicit_selector` flag.
4. Teach `RoutingTable.resolve()` and fallback logic to accept a selector, enforce explicit selector policy, and validate peer/provider/service compatibility before transparent routing.
5. Teach `MeshBus` to extract `mesh_selector` from typed payloads and pass it into routing/fallback resolution.
6. Add unit/integration tests for explicit peer/provider precedence, failure messages, policy-required selectors, and backward-compatible transparent routing.
7. Update mesh docs with the hybrid addressing contract and verification guidance.

## Verification

- `uv run pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_mesh_bus.py tests/integration/test_mesh_routing.py -q`
- `uv run ruff check` on changed Python files.
- `git diff --check`

## Risks

- Risk: selector shape becomes too broad before all services consume it. Mitigation: add typed optional primitives only, and route only on selectors the current registry can validate.
- Risk: explicit selector fallback weakens intent. Mitigation: explicit selector failures return `error`; fallback is used only for transparent routing.
- Risk: safety-sensitive policy breaks defaults. Mitigation: `require_explicit_selector` defaults to `False`.
