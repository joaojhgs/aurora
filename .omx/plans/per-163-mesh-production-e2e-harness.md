# PER-163 Mesh Production E2E Harness Plan

## Requirements Summary

- Source issue: PER-163 / MESH-GAP-011.
- Branch policy: implement on `multica/PER-163-mesh-production-e2e-harness`
  based on `origin/feat/mesh-full-services-integrations`.
- Context read: `.omx/plans/mesh-production-e2e-integration-gap-plan.md`,
  `.omx/specs/deep-interview-mesh-distributed-integration.md`,
  `.omx/specs/ui-production-tasks/tasks/QA-002-build-multi-mode-e2e-matrix.md`,
  `.omx/specs/ui-production-tasks/tasks/QA-003-build-security-privacy-regression-suite.md`,
  `.omx/specs/ui-production-tasks/tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md`,
  root `AGENTS.md`, and `tests/AGENTS.md`.
- Keep implementation isolated to harness/docs/tests unless a narrow production
  fix is required.

## Acceptance Criteria

- A local harness command emits deterministic artifacts under
  `.omx/reports/mesh-gap-e2e/`.
- The harness covers thread/LocalBus, process/BullMQ Redis, HTTP Gateway,
  Tauri local/native, and Mesh/WebRTC rows.
- All 15 PER-163 scenarios have pass/fail assertions and correlation evidence.
- Security/privacy negative cases include missing approval token, replay,
  mismatch, missing RAG namespace, missing audio consent, and broad Auth/Config
  denial.
- Artifacts redact secrets, raw audio, raw RAG records, Redis URLs, and host
  paths.

## Implementation Steps

1. Add `scripts/mesh_gap_e2e_harness.py` with deterministic two-peer fixtures,
   scenario/mode definitions, JSON report generation, event NDJSON, and support
   bundle artifact writing.
2. Add `tests/e2e/test_mesh_gap_e2e_harness.py` to assert required modes,
   scenarios, negative cases, redaction, and correlation readiness.
3. Add `docs/MESH_GAP_E2E_HARNESS.md` with local commands, CI profile, artifact
   paths, and live process/WebRTC extension notes.
4. Run targeted pytest and ruff checks.
5. Generate the harness report under `.omx/reports/mesh-gap-e2e/latest/` for QA
   evidence, then checkpoint Ultragoal.

## Risks And Mitigations

- Risk: a deterministic harness can drift from live WebRTC behavior.
  Mitigation: keep mode/scenario/artifact schemas stable and document live
  process/WebRTC extension commands.
- Risk: artifacts leak sensitive local values.
  Mitigation: test redaction against token, Redis URL, and host path examples.
- Risk: scope expands into production service changes.
  Mitigation: consume existing public contract semantics and avoid production
  code edits in this PER-163 slice.

## Verification

```bash
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
uv run ruff check scripts/mesh_gap_e2e_harness.py tests/e2e/test_mesh_gap_e2e_harness.py
uv run python scripts/mesh_gap_e2e_harness.py
```
