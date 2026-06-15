# P0-001 — Freeze production UI scope, terms, and task-board contract

## Execution metadata

- **Phase:** P0 — Production planning baseline and repository readiness
- **Lane:** planning
- **Depends on:** None
- **Parallelizable with:** P0-002, P0-003
- **Coverage matrix rows:** all
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Create the canonical implementation glossary, mode definitions, task fields, and acceptance-gate conventions that every subsequent card uses.

## User-visible outcome

A reader can distinguish Server Web, Desktop Thin, Desktop Local, Mesh Shell, Android Thin, Android Local-Light, iOS Thin, and iOS Local-Light without re-reading previous research.

## Backend/API implementation details

- No backend contract changes are expected in this task. If implementation discovers a missing backend dependency, create/link the relevant `BE-*` task instead of widening this task silently.

## SDK integration details

- No new SDK surface is expected in this task. Consume existing SDK APIs only, and add SDK work to the relevant `SDK-*` task if a gap is discovered.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- No production UI changes are expected in this task. Any UI impact should be documented as downstream work and linked to the relevant `UI-*`, `UIA-*`, `ADM-*`, or `MESH-*` task.

## Code references to inspect first

- `.omx/specs/ui-refinement/index.md`
- `.omx/specs/ui-refinement/feature-service-availability-graph.md`
- `.omx/specs/ui-refinement/spec-vs-code-coverage-matrix.md`

## Mock/component references

- `modules/ui-mock-reference/lib/aurora/types.ts`
- `modules/ui-mock-reference/lib/aurora/data.ts`
- `modules/ui-mock-reference/components/aurora/status-badges.tsx`
- `modules/ui-mock-reference/components/aurora/capability-drawer.tsx`

## Data, permissions, and privacy contract

- Define canonical privacy enum: public, personal, sensitive, secret, raw-audio, credential, admin-critical.
- Define canonical availability enum from mock `AvailabilityState` and map to SDK capability state.

## Acceptance criteria

- Index includes scope, non-goals, deployment modes, privacy classes, and mode support codes.
- Every future task links to at least one matrix row or states why it is infrastructure-only.
- No task may call Python services directly from UI; SDK/bus/gateway boundary is explicit.

## Verification commands / evidence

- Review generated index for glossary and task template.
- `rg -n "direct service|call Python service directly|TODO scope" .omx/specs/ui-production-tasks` returns no unresolved policy violations.

## Risks and guardrails

- Keep changes scoped to this task. Do not alter unrelated services, package layout, route semantics, permissions, or mock fixtures without a linked dependency update.

## Handoff notes

- No additional handoff notes at planning time.
