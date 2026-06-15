# P0-004 — Create monorepo/package layout decision for SDK, UI, Tauri, and native plugins

## Execution metadata

- **Phase:** P0 — Production planning baseline and repository readiness
- **Lane:** architecture
- **Depends on:** P0-001
- **Parallelizable with:** P0-002, P0-003
- **Coverage matrix rows:** sdk.transport.client, native.android.assistant_role, native.ios.invocation
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Define where production TypeScript SDK, shared UI, Tauri app, desktop sidecar, Android plugin, and iOS plugin/extensions live.

## User-visible outcome

Task owners can implement in isolation without arguing file layout.

## Backend/API implementation details

- No backend contract changes are expected in this task. If implementation discovers a missing backend dependency, create/link the relevant `BE-*` task instead of widening this task silently.

## SDK integration details

- No new SDK surface is expected in this task. Consume existing SDK APIs only, and add SDK work to the relevant `SDK-*` task if a gap is discovered.

## Tauri/native integration details

- Adopt official Tauri 2 app shell as accepted decision; Python-backed Tauri remains prototype-only.
- Use Rust core for Tauri commands, desktop sidecar supervision, secure IPC, updater, and platform plugin glue.

## UI/UX implementation details

- No production UI changes are expected in this task. Any UI impact should be documented as downstream work and linked to the relevant `UI-*`, `UIA-*`, `ADM-*`, or `MESH-*` task.

## Code references to inspect first

- Current repo has no production `package.json`, `Cargo.toml`, `src-tauri/`, or workspace root; `modules/ui-mock-reference` is reference-only.
- `pyproject.toml` remains Python service/runtime source.

## Mock/component references

- No direct mock component reference applies. If UX impact is discovered, update `flow-to-task-coverage.md` and link the exact mock file before implementation.

## Data, permissions, and privacy contract

- Recommended future packages: `packages/aurora-sdk`, `packages/aurora-ui`, `apps/aurora-web`, `apps/aurora-tauri/src-tauri`, `apps/aurora-tauri/src`, `native/android`, `native/ios` or Tauri plugin subdirs.

## Acceptance criteria

- Documented package names, build ownership, import direction, and forbidden dependencies.
- No production UI imports from `modules/ui-mock-reference` after migration except copied components with attribution/review.
- Tauri/native code has platform-specific directories and CI ownership.

## Verification commands / evidence

- Static workspace graph or package manager command lists packages.
- Architecture doc reviewed before any production code scaffold task proceeds.

## Risks and guardrails

- Keep changes scoped to this task. Do not alter unrelated services, package layout, route semantics, permissions, or mock fixtures without a linked dependency update.

## Handoff notes

- No additional handoff notes at planning time.
