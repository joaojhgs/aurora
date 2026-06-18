# [MESH-GAP][EPIC] Production cross-peer capability fabric completion

## Execution metadata

- **Task ID:** MESH-GAP-EPIC
- **Phase:** EPIC
- **Labels:** mesh, mesh-gap, mesh-production, epic
- **Depends on:** None
- **Parallelizable with:** Coordinates child tasks only
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
Coordinate the mesh-gap completion work. The target is not “route one shared service remotely”; it is a user/admin/SDK-visible fabric where Aurora can discover local and authorized remote capabilities, explain route decisions, request approvals, execute safely, audit outcomes, and prove E2E behavior across thread/process/HTTP/Tauri/mesh modes.

## Scope
This epic tracks the grouped tasks below:
1. Branch/release normalization and primitive validation.
2. Mesh config parity and explicit-selector policy.
3. Typed capability catalog and route-explain contracts.
4. Aggregate local+remote Tooling catalog.
5. Per-tool sharing policy and approval protocol for internal and mesh tools.
6. Orchestrator/SDK integration with approval interrupts.
7. DB/RAG remote query/export policy implementation.
8. Audio/STT/TTS session safety.
9. Scheduler delegation and Auth/Config admin hardening.
10. Unified events/audit/diagnostics and full production E2E harness.

## Definition of done
- Every child task is complete or explicitly deferred with documented rationale.
- Production E2E proves local+remote tool aggregation, internal/local tool approval mode, remote approval mode, RAG/data policy, audio gating, scheduler policy, Auth/Config boundaries, audit, and route explanations.
- UI tasks consume the new capability catalog, approval, and event contracts rather than assuming generic service routing is enough.
