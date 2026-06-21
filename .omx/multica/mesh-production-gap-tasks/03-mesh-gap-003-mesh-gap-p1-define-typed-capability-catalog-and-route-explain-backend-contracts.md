# [MESH-GAP][P1] Define typed capability catalog and route-explain backend contracts

## Execution metadata

- **Task ID:** MESH-GAP-003
- **Phase:** P1
- **Labels:** mesh, gateway, contracts, capability-catalog
- **Depends on:** MESH-GAP-001
- **Parallelizable with:** Can run with MESH-GAP-002; unblocks MESH-GAP-004 and UI SDK updates
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
Promote the diagnostic capability graph into a typed product contract. UI/SDK must receive a canonical catalog of executable capabilities, blocked capabilities, route candidates, policies, resources, freshness, and remediation reasons.

## Backend/API requirements
Add or harden Gateway contracts:
- `GatewayMethods.GET_CAPABILITY_CATALOG`
- `GatewayMethods.EXPLAIN_ROUTE`

Required IO models under `app/shared/contracts/models/gateway.py` or a focused mesh/capability model module:
- `CapabilityCatalogRequest`
- `CapabilityCatalogResponse`
- `CapabilityProviderInfo`
- `CapabilityActionInfo`
- `CapabilityResourceInfo`
- `CapabilityPolicyDecisionInfo`
- `CapabilityFreshnessInfo`
- `RouteExplainRequest`
- `RouteExplainResponse`
- `RouteCandidateDecision`
- `RouteBlockerInfo`

Catalog action fields must include:
- stable action ID
- module/method/topic/tool/resource identity
- local/remote/provider peer ID
- service instance ID
- `MeshAddressSelector` needed to execute
- bindability: model-bindable, UI-only, approval-required, unavailable
- policy: required permissions, trust tier, safety class, explicit selector required, consent required, privacy indicator required, bandwidth check required
- source provenance and freshness: manifest time, last probe, TTL, stale flag, registry digest
- redacted input/output schemas where safe
- route hints and executable SDK operation kind

Route explain must include:
- selected target or no-route result
- every local/remote provider candidate
- include/exclude reason code and human message
- selector validation result
- fallback behavior
- security/privacy blockers

## Integration requirements
- Preserve `Gateway.GetCapabilityGraph` as diagnostic if it exists, but do not make UI depend on diagnostic-only graph for execution.
- `CapabilityCatalog` must eventually include Tooling, DB/RAG namespaces, audio resources, scheduler namespaces/jobs, model runtime providers, and native/mobile capabilities.
- Do not expose credentials, tokens, raw secrets, raw embeddings, or private filesystem paths.

## Code references
- `app/shared/contracts/models/gateway.py`
- `app/shared/contracts/models/mesh.py`
- `app/services/gateway/service.py`
- `app/services/gateway/mesh/capability_graph.py`
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/services/gateway/route_generator.py`
- `app/services/gateway/registry_aggregator.py`

## Acceptance criteria
- New method constants and IO models are registered through `@method_contract`.
- Gateway route generation exposes external/manage endpoints when auth/RBAC permits.
- SDK can build feature availability and route sheets without scraping logs or internals.
- Tests cover multiple providers, stale providers, denied providers, selector failures, and redaction.

## Verification
- Unit tests under `tests/unit/gateway` for catalog and route explain.
- Registry/OpenAPI snapshot includes new endpoints.
- Negative tests prove secrets and internal-only data are redacted.
