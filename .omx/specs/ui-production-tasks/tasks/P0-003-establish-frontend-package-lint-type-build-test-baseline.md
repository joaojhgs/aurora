# P0-003 — Establish frontend package lint/type/build/test baseline

## Execution metadata

- **Phase:** P0 — Production planning baseline and repository readiness
- **Lane:** frontend/readiness
- **Depends on:** None
- **Parallelizable with:** P0-001, P0-002
- **Coverage matrix rows:** sdk.transport.client
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Turn the UI reference/package baseline into a repeatable quality harness before production code is added.

## User-visible outcome

Every UI and SDK task has a known command set and no task inherits the current `eslint` missing-dependency ambiguity.

## Backend/API implementation details

- No backend contract changes are expected in this task. If implementation discovers a missing backend dependency, create/link the relevant `BE-*` task instead of widening this task silently.

## SDK integration details

- No new SDK surface is expected in this task. Consume existing SDK APIs only, and add SDK work to the relevant `SDK-*` task if a gap is discovered.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Add/decide production package scripts for typecheck, lint, unit tests, Storybook/visual docs if used, and build.
- Keep `modules/ui-mock-reference` as reference-only unless task explicitly migrates components.

## Code references to inspect first

- `modules/ui-mock-reference/package.json` currently declares `lint: eslint .` but lacks working lint dependency/config.
- `modules/ui-mock-reference/tsconfig.json` and Next build are current type/build references.

## Mock/component references

- No direct mock component reference applies. If UX impact is discovered, update `flow-to-task-coverage.md` and link the exact mock file before implementation.

## Data, permissions, and privacy contract

- Preserve the global privacy taxonomy and permission rules from the task index. If the task handles credentials, raw audio, personal data, admin-critical actions, or peer routing, classify it explicitly before implementation.

## Acceptance criteria

- Production UI package has passing `typecheck`, `lint`, `test`, and `build` scripts in CI.
- Mock reference README explains it is not production runtime code.
- Visual reference components can be imported/migrated deliberately, not accidentally run as backend-integrated UI.

## Verification commands / evidence

- `pnpm install --frozen-lockfile` or chosen workspace install.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` in production package.
- Reference mock remains buildable with documented lint limitation or fixed lint config.

## Risks and guardrails

- Keep changes scoped to this task. Do not alter unrelated services, package layout, route semantics, permissions, or mock fixtures without a linked dependency update.

## Handoff notes

- No additional handoff notes at planning time.
