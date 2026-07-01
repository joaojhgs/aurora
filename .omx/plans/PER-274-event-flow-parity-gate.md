# PER-274 Event-Flow Transport Parity Gate Plan

## Requirements Summary

- Source of truth: Multica PER-274 and `docs/PER-269-tauri-ui-production-readiness-report.md`.
- Prior QA-008 baseline: `.omx/plans/PER-229-transport-parity-gate.md`, `.omx/ultragoal/PER-229-checkpoints.md`, `scripts/transport_parity_gate.py`, and `tests/e2e/test_transport_parity_gate.py`.
- Relevant guidance read: root `AGENTS.md`, `tests/AGENTS.md`, `app/messaging/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/shared/AGENTS.md`, and `app/shared/contracts/AGENTS.md`.
- UI/SDK context read: `.omx/specs/ui-refinement/index.md`, `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`, `.omx/specs/ui-refinement/aurora-ui-ux-flows.md`, `.omx/specs/ui-refinement/feature-service-availability-graph.md`, `.omx/specs/ui-production-tasks/index.md`, `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`, `.omx/specs/ui-production-tasks/tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md`, and `.omx/specs/mesh-ui-roadmap-integration-review.md`.

## Acceptance Criteria

- The existing QA-008 report records explicit event-flow requirements per transport row, not only broad coverage strings.
- Thread, process, HTTP, Tauri, and mesh rows require evidence for registry/capability load, assistant request/stream/cancel basics, config/service-health event delivery, denied/privacy-blocked state, and audit/correlation redaction.
- Mesh-specific provenance evidence is required for the Mesh/WebRTC row and recorded as not applicable for non-mesh rows with rationale.
- Rows cannot pass when event-flow evidence is missing, mock-only, or only static build evidence.
- The SDK command in the gate matches PER-274: `pnpm --filter @aurora/client test -- --runInBand`.

## Implementation Steps

1. Extend `scripts/transport_parity_gate.py` with structured event-flow requirement metadata and row status gating.
2. Derive event-flow evidence from existing harness scenarios and SDK/UI/Tauri command results.
3. Update e2e tests to assert required event-flow shape, missing-evidence blocking, and the `--runInBand` SDK command.
4. Update `docs/TRANSPORT_PARITY_GATE.md` to document the PER-274 event-flow gate expectations and artifacts.
5. Run targeted Python tests and the SDK test command where local dependencies allow.

## Risks And Mitigations

- Some rows remain environment-gated. Keep skipped rows blocking release readiness and record the exact command required to produce evidence.
- Existing harness scenarios are deterministic component evidence, not full device-lab proof. The matrix must label command/artifact sources so QA can distinguish component, CI, and platform-runner evidence.
- Tauri local event support may still be incomplete. The row must block if Tauri command event evidence is not run or fails.

## Verification Steps

- `uv run pytest tests/e2e/test_transport_parity_gate.py -q`
- `pnpm --filter @aurora/client test -- --runInBand`
- `uv run --extra gateway --extra mode-processes --extra test-e2e python scripts/transport_parity_gate.py --output-dir .omx/reports/transport-parity/per274-local`

## Stop Rule

Hand off to QA after the script, tests, docs, commit, and PR exist, with exact local verification and any environment-gated rows called out.
