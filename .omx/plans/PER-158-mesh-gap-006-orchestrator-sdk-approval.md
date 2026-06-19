# PER-158 / MESH-GAP-006 Plan

## Sources

- Multica issue PER-158 / MESH-GAP-006.
- `.omx/multica/mesh-production-gap-tasks/06-mesh-gap-006-mesh-gap-p3-integrate-orchestrator-and-sdk-with-capability-catalog-aggregate-tools-and-app.md`
- `.omx/plans/mesh-production-e2e-integration-gap-plan.md`
- `.omx/specs/deep-interview-mesh-distributed-integration.md`
- `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`
- `.omx/specs/ui-production-tasks/tasks/SDK-006-implement-capability-graph-engine.md`
- `.omx/specs/ui-production-tasks/tasks/SDK-012-implement-route-privacy-policy-engine.md`
- `.omx/specs/ui-production-tasks/tasks/UIA-003-wire-tool-approval-cards-and-tool-result-display.md`

## Scope

Implement the orchestrator/backend slice now available on `feat/mesh-full-services-integrations`:

- Use the aggregate Tooling catalog for safe local plus remote binding.
- Preserve hidden provider metadata from catalog discovery through execution.
- Add an orchestrator approval interrupt payload for approval-required local and remote tools.
- Keep local-only fallback behavior when aggregate catalog is unavailable.
- Update SDK/UI planning specs to require the client APIs and event stream over the concrete Gateway/Tooling methods already landed.

Do not scaffold a production `@aurora/client` package in this task because the repo currently has only UI/SDK planning artifacts and mock reference files; SDK package creation remains owned by `SDK-001`.

## Code Paths

- `app/services/orchestrator/tool_bindings.py`
- `app/services/orchestrator/agents/chatbot.py`
- `app/services/orchestrator/graph.py`
- `app/services/orchestrator/state.py`
- `app/shared/contracts/models/tooling.py`
- `.omx/specs/ui-production-tasks/tasks/SDK-006-implement-capability-graph-engine.md`
- `.omx/specs/ui-production-tasks/tasks/SDK-012-implement-route-privacy-policy-engine.md`
- `.omx/specs/ui-production-tasks/tasks/UIA-003-wire-tool-approval-cards-and-tool-result-display.md`
- `tests/unit/orchestrator/test_tool_bindings.py`
- `tests/unit/orchestrator/test_graph.py`
- `tests/unit/orchestrator/test_chatbot.py`

## Invariants

- Bus-only service interaction with typed `ToolingMethods` constants and IO models.
- Unsafe or approval-required tools are not auto-bound to the LLM.
- Approval interrupts preserve global tool id, provider peer id, service instance id, mesh selector, policy decision id, correlation id, and approval request id.
- No broad Auth/Config/raw DB/audio exposure changes.

## Steps

1. Extend orchestrator binding metadata to track non-bindable approval candidates from catalog `blocked_tools`.
2. Have chatbot keep safe bindable tools for LLM context and store approval candidates in graph state.
3. In graph tool execution, detect a tool call matching an approval candidate, request approval via `Tooling.RequestApproval`, and return a structured tool message payload instead of executing the tool.
4. Add tests for safe remote execution metadata, unsafe local/remote approval interrupts, deterministic name collisions, and local-only fallback.
5. Update SDK/UI task specs with concrete `client.capabilities`, `client.routes`, `client.tools`, and approval event stream requirements tied to Gateway/Tooling contracts.
6. Run focused pytest coverage and then commit/PR to `feat/mesh-full-services-integrations`.

## Verification

- `uv run pytest tests/unit/orchestrator/test_tool_bindings.py tests/unit/orchestrator/test_chatbot.py tests/unit/orchestrator/test_graph.py -q`
- `uv run pytest tests/unit/tooling/test_service.py tests/unit/gateway/test_capability_catalog.py -q`

## Risks

- A model cannot select a tool that is not bound. Mitigation: approval candidates remain in state for UI/session-driven approval requests; bound LLM tools remain safe only.
- SDK implementation is planning-only in this repo. Mitigation: update the authoritative task specs and call out the absence of a package in handoff.
