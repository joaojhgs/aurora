# [MESH-GAP][P5] Refresh UI/SDK task specs for mesh capability catalog and approval flows

## Execution metadata

- **Task ID:** MESH-GAP-012
- **Phase:** P5
- **Labels:** ui, sdk, mesh, planning-sync
- **Depends on:** MESH-GAP-003, MESH-GAP-005
- **Parallelizable with:** Planning/docs task; can run while backend implementation proceeds if specs are kept in sync
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
Ensure existing UI production tasks do not wire to obsolete assumptions such as generic service sharing or one-provider `Tooling.GetTools`. The UI must be built around capability catalog, route explain, per-tool policy, approval tokens, and unified events.

## Required UI task updates
Update existing specs under `.omx/specs/ui-production-tasks/tasks/` including at minimum:
- `SDK-006-implement-capability-graph-engine.md`
- `SDK-012-implement-route-privacy-policy-engine.md`
- `SDK-013-implement-adminaction-client-controller.md`
- `UIA-003-wire-tool-approval-cards-and-tool-result-display.md`
- `UIA-004-wire-voice-ptt-wake-transcription-and-tts-playback-per-mode.md`
- `UIA-006-wire-conversation-history-memory-and-rag-provenance-ui.md`
- `ADM-007-wire-plugins-mcp-tools-and-reload-install-states.md`
- `ADM-008-wire-audit-log-details-and-export.md`
- `ADM-009-wire-diagnostics-probes-and-redacted-support-bundle.md`
- `ADM-012-wire-scheduler-jobs-and-automation-management.md`
- `MESH-003-wire-route-policy-editor-and-route-explain-ui.md`
- `BE-011-add-tool-risk-taxonomy-and-approval-hints.md`
- `BE-013-add-peer-capability-manifest-and-mesh-route-explain-contracts.md`
- `BE-017-add-memory-rag-provenance-export-delete-contracts.md`
- `BE-018-add-scheduler-management-exposure-and-adminaction-contract.md`
- `QA-002-build-multi-mode-e2e-matrix.md`
- `QA-003-build-security-privacy-regression-suite.md`
- `QA-008-build-thread-process-mesh-transport-parity-gate.md`

Mandatory additions:
- Capability catalog replaces diagnostic graph as execution source.
- Tool approval cards handle local/internal and remote mesh tools.
- Approval mode controls include ask each time, approve all local safe, approve all for session, approve all for trusted peer, dry-run only, deny all.
- Route explain UI displays provider inclusion/exclusion and selector failures.
- Admin tools page manages per-tool/toolkit/MCP sharing policy.
- Audio UI distinguishes batch transcription/synthesis from remote mic/streaming consent sessions.
- Memory UI uses namespace/provenance/export/import/tombstone semantics.
- QA matrix includes two-peer production mesh harness from MESH-GAP-011.

## Acceptance criteria
- UI task specs name the new backend/SDK contracts from MESH-GAP-003 through MESH-GAP-011.
- No UI task instructs implementers to call `Tooling.GetTools` as the full mesh catalog.
- No UI task treats raw `confirmed=true` as production approval.
- Mock references remain usable but production wiring points to SDK APIs.

## Verification
- Grep UI task specs for stale assumptions and update them.
- Update `.omx/specs/ui-production-tasks/index.md`, `backend-gap-crosswalk.md`, `flow-to-task-coverage.md`, and `manifest.md` if dependency/task IDs changed.
