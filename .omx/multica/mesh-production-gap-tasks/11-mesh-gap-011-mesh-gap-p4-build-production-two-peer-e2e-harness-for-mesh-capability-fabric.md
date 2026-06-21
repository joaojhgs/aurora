# [MESH-GAP][P4] Build production two-peer E2E harness for mesh capability fabric

## Execution metadata

- **Task ID:** MESH-GAP-011
- **Phase:** P4
- **Labels:** mesh, e2e, qa, production-flow
- **Depends on:** MESH-GAP-004, MESH-GAP-005, MESH-GAP-006, MESH-GAP-007, MESH-GAP-008, MESH-GAP-009, MESH-GAP-010
- **Parallelizable with:** Final integration gate; can be scaffolded earlier but cannot pass until dependencies land
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
Build the production proof that the mesh roadmap actually works end-to-end. This harness must run realistic two-peer scenarios through public SDK/Gateway/Tauri/mesh paths, not just isolated unit tests.

## Harness requirements
Support at least two Aurora peers:
- consumer peer with UI/SDK/orchestrator path
- provider peer with Tooling, RAG/data namespace, STT/TTS capabilities, scheduler, and gateway mesh enabled

Run modes:
- thread mode / LocalBus where applicable
- process mode / BullMQBus / Redis
- HTTP Gateway thin client mode
- Tauri local/native transport mock or smoke where available
- Mesh/WebRTC transport

Scenarios to prove
1. Pair peers and approve permissions.
2. Provider shares Tooling service but only selected tools through per-tool policy.
3. Consumer capability/tool catalog shows local tools + selected remote tools + blocked tools/providers with reasons.
4. Safe local/internal tool executes with configured approval mode.
5. Safe remote mesh tool executes.
6. Dangerous local/internal tool requires approval unless approve-all policy explicitly allows it.
7. Dangerous remote mesh tool fails without approval token, succeeds with valid approval token, and rejects replay/mismatch.
8. RAG remote query works only with namespace selector/policy and logs provenance.
9. Batch remote transcription/synthesis works.
10. Streaming/mic/wakeword path is denied without consent/session and works only in approved session if enabled.
11. Scheduler remote job create/list/cancel respects namespace/owner/delegation.
12. Broad Auth/Config mesh RPC is denied except pairing/login infra; admin HTTP changes require AdminAction.
13. Route explain shows provider inclusion/exclusion and fallback.
14. Unified event stream emits capability/approval/route/audit/audio/data/scheduler events.
15. Support bundle redacts secrets and includes correlation trail.

## Code/test references
- `tests/integration/`
- `tests/unit/gateway/test_mesh_*`
- `tests/integration/test_mesh_*`
- `docker-compose.process.yml`
- `README.process-mode.md`
- `docs/TESTING_PROCESS_MODE.md`
- `.omx/specs/ui-production-tasks/tasks/QA-002-build-multi-mode-e2e-matrix.md`
- `.omx/specs/ui-production-tasks/tasks/QA-003-build-security-privacy-regression-suite.md`
- `.omx/specs/ui-production-tasks/tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md`

## Acceptance criteria
- Harness can be run locally with documented commands.
- CI/dev profile exists with deterministic fake tools/audio/RAG data.
- Every scenario above has pass/fail assertions and logs artifacts.
- Failed scenarios produce route/audit/correlation evidence.
- No test relies on mock transport for the final mesh/WebRTC proof except where explicitly marked as preflight.

## Verification
- Full harness command documented in `docs/`.
- Targeted test suites plus harness pass.
- Artifacts saved under `.omx/reports/mesh-gap-e2e/` or CI artifacts.
