# QA-003 — Build security/privacy regression suite


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P10 — Quality, security, release, and operations
- **Lane:** qa-release
- **Depends on:** BE-004, SDK-012, ADM-008, MESH-GAP-005, MESH-GAP-011
- **Parallelizable with:** None
- **Coverage matrix rows:** all
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Create production gate evidence for the whole UI/backend/native system.

## User-visible outcome

Permissions, auth, AdminAction, redaction, route privacy and credential storage are tested adversarially.

## Backend/API implementation details

- Exercise Gateway/Auth/Config/Supervisor/Mesh/Orchestrator/Tooling contracts through public SDK paths.
- Include process and thread modes where applicable.

## SDK integration details

- Use SDK conformance fixtures and transport adapters as the test harness boundary.

## Tauri/native integration details

- Desktop/mobile packaging tasks must emit artifacts and smoke logs.

## UI/UX implementation details

- Run screen-level, visual, accessibility, and E2E tests against capability state fixtures and live backends.

## Code references to inspect first

- `tests/AGENTS.md` for pytest patterns
- Future Playwright/Vitest/axe/visual test dirs
- Docker/process-mode docs and Tauri/mobile release dirs

## Mock/component references

- Use `modules/ui-mock-reference` screenshots/components as visual intent baseline; production visual diffs compare implemented components, not fixture data.

## Data, permissions, and privacy contract

- Coverage matrix rows must be green or explicitly deferred with accepted rationale before production release.

## Acceptance criteria

- CI gate documents commands, logs, platforms, skipped tests, and owner.
- Security/privacy tests include negative cases.
- Release task produces runbook with install, update, backup, diagnostics, and rollback.

## Verification commands / evidence

- Full CI suite for relevant stack.
- Manual device matrix evidence where emulators are insufficient.
- Final readiness checklist cross-links all task IDs.

## Risks and guardrails

- Do not mark emulator-only assistant role as production complete without physical/device/OEM matrix.
- Do not release with mock transport accidentally selected.

## Handoff notes

- No additional handoff notes at planning time.

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

Security/privacy regression must include the production approval and selector policy from `MESH-GAP-002` and `MESH-GAP-005`.

Additional requirements:

- Negative tests for missing explicit selector, stale peer, denied peer, privilege mismatch, approval replay, changed args hash, changed provider, expired token, approve-all scope escape, dry-run bypass, unauthorized remote RAG namespace, remote audio without consent, scheduler foreign namespace, and redaction leaks.
- Tests must cover internal/local tools and remote mesh tools with the same approval primitives.
- Tests must assert raw `confirmed=true` cannot bypass token-bound approval in local/internal or remote mesh execution paths.
