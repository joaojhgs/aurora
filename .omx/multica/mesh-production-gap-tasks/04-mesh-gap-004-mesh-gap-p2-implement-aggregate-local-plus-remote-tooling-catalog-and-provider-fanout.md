# [MESH-GAP][P2] Implement aggregate local-plus-remote Tooling catalog and provider fanout

## Execution metadata

- **Task ID:** MESH-GAP-004
- **Phase:** P2
- **Labels:** mesh, tooling, provider-aggregation, orchestrator
- **Depends on:** MESH-GAP-002, MESH-GAP-003
- **Parallelizable with:** Can run with MESH-GAP-005 after catalog contract exists
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
Implement the core product behavior the roadmap required: Aurora can see local tools and authorized tools from multiple peers at once.

## Backend/API requirements
Add a Tooling or Gateway aggregate method, final name to be consistent with MESH-GAP-003:
- Preferred: `Tooling.GetToolCatalog` for tool-specific details plus `Gateway.GetCapabilityCatalog` for cross-service catalog.
- `Tooling.GetTools` may remain per-provider/backward-compatible.

The aggregate catalog must:
- Include local tools even when network providers exist.
- Fan out to all eligible remote Tooling providers using provider-candidate APIs.
- Return eligible tools and blocked/unavailable providers/tools with reason codes.
- Preserve stable IDs: local name, global tool ID, provider peer ID, provider service instance, namespace/display name.
- Include safety class, required permissions, schema, source/toolkit/MCP provenance, rate hints, approval requirement, and sharing policy decision.
- Cache per-peer discovery with TTL and invalidate on manifest/service/tool policy changes.
- Avoid advertising tools the caller/principal/peer cannot use.

## Orchestrator requirements
- Replace single `Tooling.GetTools` binding path with the aggregate safe-tool subset once MESH-GAP-006 lands.
- Do not bind dangerous/sensitive/approval-required tools directly to the LLM unless policy explicitly allows auto-approval for that mode.

## Code references
- `app/services/tooling/service.py`
- `app/shared/contracts/models/tooling.py`
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/peer_bridge.py`
- `app/messaging/mesh_bus.py`
- `app/services/orchestrator/agents/chatbot.py`
- `app/services/orchestrator/tool_bindings.py`
- `tests/unit/tooling/test_service.py`
- `tests/unit/orchestrator/test_tool_bindings.py`

## Acceptance criteria
- With local + two remote Tooling providers, catalog returns all eligible safe tools with collision-safe names.
- Blocked provider/tool entries include actionable reason codes.
- Old per-provider `Tooling.GetTools` remains compatible.
- Catalog respects peer allowlists, principal permissions, trust tier, safety class, explicit selector policy, and capacity.
- No raw secrets or unsafe arguments leak in discovery.

## Verification
- Unit tests for local+remote aggregation, collisions, cache invalidation, excluded providers, and filtered unsafe tools.
- Mocked integration test over `MeshBus/PeerBridge` for remote provider fanout.
