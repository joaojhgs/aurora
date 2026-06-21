# Mesh Production Gap Multica Task Index

Project: `5345dd7c-2f0b-4a4b-b636-c1db93067f0a`

<!-- BRANCH-POLICY -->
## Branch policy

- Mesh-gap implementation base branch: `feat/mesh-full-services-integrations`.
- All mesh-gap implementation branches must branch from `origin/feat/mesh-full-services-integrations` and merge back into `feat/mesh-full-services-integrations`.
- Do not target `main` directly until the complete mesh production sequence is accepted.
- UI production tasks target `feat/ui-multi-platform-integration` later and stay blocked until MESH-GAP-011 is complete and MESH-GAP-012 refreshes UI specs against final backend names.

## Parallel implementation order

- **Wave 0:** MESH-GAP-001 only. Normalizes branch/release baseline.
- **Wave 1:** MESH-GAP-002 and MESH-GAP-003 in parallel.
- **Wave 2:** MESH-GAP-004 and MESH-GAP-005 in parallel after Wave 1.
- **Wave 3:** MESH-GAP-006, MESH-GAP-007, MESH-GAP-008, MESH-GAP-009 in parallel after required contracts/policy land.
- **Wave 4:** MESH-GAP-010 can begin after events/approval primitives; MESH-GAP-011 final harness starts as scaffold but only completes after Waves 2-4.
- **Wave 5:** MESH-GAP-012 keeps UI specs synced; it can run now for spec updates and again after backend naming settles.

## Tasks

- [ ] **MESH-GAP-EPIC** — [MESH-GAP][EPIC] Production cross-peer capability fabric completion _(phase: EPIC; deps: None)_
  `.omx/multica/mesh-production-gap-tasks/00-mesh-gap-epic-mesh-gap-epic-production-cross-peer-capability-fabric-completion.md`
- [ ] **MESH-GAP-001** — [MESH-GAP][P0] Normalize branch state and verify mesh primitive baseline _(phase: P0; deps: None)_
  `.omx/multica/mesh-production-gap-tasks/01-mesh-gap-001-mesh-gap-p0-normalize-branch-state-and-verify-mesh-primitive-baseline.md`
- [ ] **MESH-GAP-002** — [MESH-GAP][P1] Complete mesh config parity and explicit-selector enforcement policy _(phase: P1; deps: MESH-GAP-001)_
  `.omx/multica/mesh-production-gap-tasks/02-mesh-gap-002-mesh-gap-p1-complete-mesh-config-parity-and-explicit-selector-enforcement-policy.md`
- [ ] **MESH-GAP-003** — [MESH-GAP][P1] Define typed capability catalog and route-explain backend contracts _(phase: P1; deps: MESH-GAP-001)_
  `.omx/multica/mesh-production-gap-tasks/03-mesh-gap-003-mesh-gap-p1-define-typed-capability-catalog-and-route-explain-backend-contracts.md`
- [ ] **MESH-GAP-004** — [MESH-GAP][P2] Implement aggregate local-plus-remote Tooling catalog and provider fanout _(phase: P2; deps: MESH-GAP-002, MESH-GAP-003)_
  `.omx/multica/mesh-production-gap-tasks/04-mesh-gap-004-mesh-gap-p2-implement-aggregate-local-plus-remote-tooling-catalog-and-provider-fanout.md`
- [ ] **MESH-GAP-005** — [MESH-GAP][P2] Implement tool sharing policy and approval protocol for local and mesh tools _(phase: P2; deps: MESH-GAP-002, MESH-GAP-003)_
  `.omx/multica/mesh-production-gap-tasks/05-mesh-gap-005-mesh-gap-p2-implement-tool-sharing-policy-and-approval-protocol-for-local-and-mesh-tools.md`
- [ ] **MESH-GAP-006** — [MESH-GAP][P3] Integrate Orchestrator and SDK with capability catalog, aggregate tools, and approval interrupts _(phase: P3; deps: MESH-GAP-004, MESH-GAP-005)_
  `.omx/multica/mesh-production-gap-tasks/06-mesh-gap-006-mesh-gap-p3-integrate-orchestrator-and-sdk-with-capability-catalog-aggregate-tools-and-app.md`
- [ ] **MESH-GAP-007** — [MESH-GAP][P3] Implement DB/RAG remote query, namespace catalog, export/import policy, and provenance _(phase: P3; deps: MESH-GAP-002, MESH-GAP-003)_
  `.omx/multica/mesh-production-gap-tasks/07-mesh-gap-007-mesh-gap-p3-implement-db-rag-remote-query-namespace-catalog-export-import-policy-and-prove.md`
- [ ] **MESH-GAP-008** — [MESH-GAP][P3] Harden audio/STT/TTS mesh boundaries with explicit session consent and event streaming _(phase: P3; deps: MESH-GAP-002, MESH-GAP-003)_
  `.omx/multica/mesh-production-gap-tasks/08-mesh-gap-008-mesh-gap-p3-harden-audio-stt-tts-mesh-boundaries-with-explicit-session-consent-and-event-s.md`
- [ ] **MESH-GAP-009** — [MESH-GAP][P3] Implement scheduler delegation plus Auth/Config admin boundary hardening _(phase: P3; deps: MESH-GAP-002, MESH-GAP-003, MESH-GAP-005)_
  `.omx/multica/mesh-production-gap-tasks/09-mesh-gap-009-mesh-gap-p3-implement-scheduler-delegation-plus-auth-config-admin-boundary-hardening.md`
- [ ] **MESH-GAP-010** — [MESH-GAP][P4] Add unified mesh events, audit views, diagnostics, and support bundles _(phase: P4; deps: MESH-GAP-003, MESH-GAP-005)_
  `.omx/multica/mesh-production-gap-tasks/10-mesh-gap-010-mesh-gap-p4-add-unified-mesh-events-audit-views-diagnostics-and-support-bundles.md`
- [ ] **MESH-GAP-011** — [MESH-GAP][P4] Build production two-peer E2E harness for mesh capability fabric _(phase: P4; deps: MESH-GAP-004, MESH-GAP-005, MESH-GAP-006, MESH-GAP-007, MESH-GAP-008, MESH-GAP-009, MESH-GAP-010)_
  `.omx/multica/mesh-production-gap-tasks/11-mesh-gap-011-mesh-gap-p4-build-production-two-peer-e2e-harness-for-mesh-capability-fabric.md`
- [ ] **MESH-GAP-012** — [MESH-GAP][P5] Refresh UI/SDK task specs for mesh capability catalog and approval flows _(phase: P5; deps: MESH-GAP-003, MESH-GAP-005)_
  `.omx/multica/mesh-production-gap-tasks/12-mesh-gap-012-mesh-gap-p5-refresh-ui-sdk-task-specs-for-mesh-capability-catalog-and-approval-flows.md`

<!-- MULTICA-CREATED-ISSUES -->
## Multica issue IDs

| Task | Issue | Status | Parent |
| --- | --- | --- | --- |
| MESH-GAP-EPIC | PER-152 / `84087662-a7bf-4db6-91ab-5a5ccb6b7a1e` | todo | — |
| MESH-GAP-001 | PER-153 / `272f4126-63e3-4107-ba6a-c501866f54a7` | todo | PER-152 |
| MESH-GAP-002 | PER-154 / `23f95f58-cab3-4e32-884a-f7357b041ab6` | todo | PER-152 |
| MESH-GAP-003 | PER-155 / `556c7c3e-9d3e-4dfe-9771-e517288be27d` | todo | PER-152 |
| MESH-GAP-004 | PER-156 / `ac9f0191-d97f-4e09-b6ff-bc529a90c580` | todo | PER-152 |
| MESH-GAP-005 | PER-157 / `4ff11136-4468-4c34-bb21-316e6b555a89` | todo | PER-152 |
| MESH-GAP-006 | PER-158 / `4fdb3521-9d30-4405-aa36-8c3266c95f85` | todo | PER-152 |
| MESH-GAP-007 | PER-159 / `4ad1fbb3-93e6-4003-b5f3-05b03efd99ca` | todo | PER-152 |
| MESH-GAP-008 | PER-160 / `d6574f4d-a2ef-4fdf-851b-f25cf58019aa` | todo | PER-152 |
| MESH-GAP-009 | PER-161 / `b97b57b3-c015-410e-87f7-85e9561fc872` | todo | PER-152 |
| MESH-GAP-010 | PER-162 / `e629b297-679d-4e57-a72a-de3018cc0345` | todo | PER-152 |
| MESH-GAP-011 | PER-163 / `72bb7c29-6afa-478b-872b-f5cc6879ac80` | todo | PER-152 |
| MESH-GAP-012 | PER-164 / `2338572a-c049-467e-be75-6c771f44449d` | todo | PER-152 |
