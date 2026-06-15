# QA-006 — Build release packaging and operator runbooks

## Execution metadata

- **Phase:** P10 — Quality, security, release, and operations
- **Lane:** qa-release
- **Depends on:** TAURI-006, AND-009, IOS-008, ADM-009
- **Parallelizable with:** None
- **Coverage matrix rows:** all
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Create production gate evidence for the whole UI/backend/native system.

## User-visible outcome

Operators and users can install/update/debug/recover production releases across platforms.

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
