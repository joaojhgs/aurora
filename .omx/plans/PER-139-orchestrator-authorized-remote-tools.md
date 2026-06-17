# PER-139 Orchestrator Remote Tool Binding Plan

## Scope
- Issue: PER-139 `[MESH][P3-T03] Teach Orchestrator to bind local plus authorized remote tools safely`.
- Source docs read: issue description/metadata/comments, root/runtime `AGENTS.md`, repo `AGENTS.md`, `app/services/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, `app/messaging/AGENTS.md`, `tests/AGENTS.md`, `.omx/plans/PER-137-tooling-discovery-metadata.md`, `.omx/plans/PER-138-remote-tooling-execution-routing.md`, `docs/SERVICE_METHODS_REFERENCE.md`.
- Source docs named by metadata but missing in this checkout: `.omx/specs/deep-interview-mesh-distributed-integration.md`, `.omx/multica/mesh-roadmap-tasks/task-index.json`, `.omx/multica/mesh-roadmap-tasks/P3-T03*`.
- GitNexus context was requested by repo guidance but no MCP resources were exposed in this runtime.

## Requirements
- Preserve local-only orchestrator tool behavior.
- Bind local and safe remote tools into the same LLM planning context.
- Keep provider provenance out of model arguments but preserve it through execution.
- Hide remote high-risk/confirmation-required tools from automatic LLM binding for now.
- Execute remote selections with explicit provider/tool identity rather than display name alone.

## Implementation Steps
1. Add an orchestrator tool-binding helper that deserializes Tooling discovery metadata, filters unsafe remote tools, creates LangChain `StructuredTool` instances, and returns hidden execution bindings keyed by LLM-visible name.
2. Extend orchestrator `State` to carry `tool_bindings` alongside messages.
3. Update `chatbot.py` to use the helper and return bindings with the assistant message.
4. Update `graph.py` to translate selected tool names through `tool_bindings` into `ToolingExecuteToolRequest` with `global_tool_id` plus `MeshAddressSelector` for remote providers.
5. Add focused unit tests for local+remote binding, collision-safe remote names, confirmation-required filtering, and remote execution request construction.
6. Update service-method docs with orchestrator binding semantics.

## Acceptance Criteria
- Local tools still bind and execute by local name.
- Standard remote tools bind in the same context as local tools.
- Colliding remote local names remain deterministic through namespaced bindable names.
- Remote dangerous/sensitive/confirmation-required tools are hidden from automatic model binding.
- Remote tool execution uses `global_tool_id` and peer/service selector metadata.

## Verification
- `uv run pytest tests/unit/orchestrator/test_tool_bindings.py tests/unit/orchestrator/test_graph.py -q`
- Add `tests/unit/orchestrator/test_chatbot.py` if chatbot changes need direct coverage in this runtime.
