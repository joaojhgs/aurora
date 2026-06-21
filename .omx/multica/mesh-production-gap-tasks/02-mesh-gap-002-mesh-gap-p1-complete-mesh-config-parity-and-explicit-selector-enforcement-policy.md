# [MESH-GAP][P1] Complete mesh config parity and explicit-selector enforcement policy

## Execution metadata

- **Task ID:** MESH-GAP-002
- **Phase:** P1
- **Labels:** mesh, config, security, selector-policy
- **Depends on:** MESH-GAP-001
- **Parallelizable with:** Can run with MESH-GAP-003 after branch normalization
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
Make mesh policy configurable and enforceable. Runtime and generated config must not diverge, and safety-sensitive categories must be able to require explicit peer/resource selectors.

## Backend/config requirements
- Define the canonical `mesh_sharing` schema as the source for every runtime `MeshServiceConfig` field:
  - `share`
  - `max_concurrent`
  - `allowed_peers`
  - `prefer`
  - `fallback`
  - `min_version`
  - `required_capabilities`
  - `require_explicit_selector`
- Update `app/services/config/config_schema.json`.
- Regenerate/update:
  - `app/services/config/config_defaults.json`
  - `app/shared/config/models.py`
  - `app/shared/config/keys.py`
- Update `GatewayService._get_gateway_config()` so `MeshSharing -> MeshServiceConfig` preserves every field and rejects unsupported/unknown values through schema validation.
- Add operation-level policy for explicit selectors where module-level policy is too coarse:
  - Tooling execution for selected/remote/provider-specific tools.
  - DB/RAG namespaces and message history.
  - scheduler remote ownership/delegation.
  - hardware target controls.
  - audio streaming/mic/wakeword/remote playback.
- Preserve transparent routing for low-risk service dependencies.

## Code references
- `app/services/gateway/config.py`
- `app/services/gateway/service.py` `_get_gateway_config`
- `app/services/config/config_schema.json`
- `app/shared/config/models.py`
- `app/shared/config/keys.py`
- `docs/CONFIG_SERVICE_PATTERN.md`
- `docs/PEER_PAIRING_FLOW.md`
- `tests/unit/app/config/test_mesh_sharing_schema.py`
- `tests/unit/gateway/test_routing_table.py`

## Acceptance criteria
- No runtime `MeshServiceConfig` field is absent from generated config artifacts.
- `ConfigKeys` exposes `require_explicit_selector` for every mesh-shareable service.
- Gateway config load keeps all mesh policy fields intact.
- Selector-required errors are structured and actionable.
- Existing config defaults remain privacy-first: `share=false`, local preferred.

## Verification
- Config schema/generation tests.
- Routing tests for selector required, selected peer missing, unauthorized, stale, incompatible, and capacity errors.
- Manual inspect generated defaults for STT coordinator, WakeWord, Transcription, DB, TTS, Tooling, Scheduler, Orchestrator.
