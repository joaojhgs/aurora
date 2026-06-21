# [MESH-GAP][P3] Integrate Orchestrator and SDK with capability catalog, aggregate tools, and approval interrupts

## Execution metadata

- **Task ID:** MESH-GAP-006
- **Phase:** P3
- **Labels:** orchestrator, sdk, tooling, approval, mesh
- **Depends on:** MESH-GAP-004, MESH-GAP-005
- **Parallelizable with:** Can run with MESH-GAP-007/MESH-GAP-008 after catalog and approval contracts land
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
Wire the assistant execution path to the production capability fabric. The LLM and UI should receive safe local+remote tools from the aggregate catalog, while approval-required capabilities produce explicit approval interrupts/cards rather than unsafe calls.

## Orchestrator requirements
- Replace chatbot single `Tooling.GetTools` call with aggregate tool catalog/capability catalog.
- Bind only safe, authorized, policy-allowed tools to the model.
- Keep hidden execution metadata: global tool ID, provider peer ID, service instance ID, route selector, policy decision ID.
- For approval-required tools, return a structured approval request to the UI/session instead of binding directly or silently hiding when the user intent requires that capability.
- Support local/internal tool approval requirements and approve-all modes from MESH-GAP-005.
- Preserve local-only behavior when mesh is disabled.

## SDK requirements
Update `@aurora/client` task specs and implementation to expose:
- `client.capabilities.listCatalog()`
- `client.routes.explain()`
- `client.tools.listCatalog()`
- `client.tools.prepareExecution()`
- `client.tools.requestApproval()`
- `client.tools.confirmExecution()`
- `client.tools.execute()`
- event stream for approval requested/approved/denied/executed/failed

## UI integration requirements
- UI tasks must use SDK APIs only.
- Tool cards must represent local and remote tools consistently.
- RouteSheet must show local/remote provider decision and blocked reasons.

## Code references
- `app/services/orchestrator/agents/chatbot.py`
- `app/services/orchestrator/graph.py`
- `app/services/orchestrator/tool_bindings.py`
- `app/services/orchestrator/state.py`
- `app/shared/contracts/models/tooling.py`
- `.omx/specs/ui-production-tasks/tasks/SDK-006-implement-capability-graph-engine.md`
- `.omx/specs/ui-production-tasks/tasks/SDK-012-implement-route-privacy-policy-engine.md`
- `.omx/specs/ui-production-tasks/tasks/UIA-003-wire-tool-approval-cards-and-tool-result-display.md`

## Acceptance criteria
- LLM context includes local + authorized safe remote tools in one context.
- Approval-required local and remote tools produce approval interrupts/cards.
- Hidden provider metadata survives from discovery through execution.
- Tool collision names are deterministic.
- Existing local-only orchestrator tests still pass.

## Verification
- Unit tests for aggregate binding.
- Graph test where model selects a remote safe tool and execution uses intended peer.
- Graph/UI-session test where unsafe local tool and unsafe remote tool produce approval request rather than execution.
- SDK conformance tests for HTTP, Tauri-local mock, mesh mock.
