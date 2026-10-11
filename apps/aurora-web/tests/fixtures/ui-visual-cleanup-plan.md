# PER-279 Phase 0 visual harness cleanup plan

## Behavior locked before CSS cleanup

1. Use production routes for product states: assistant, shell navigation, connected devices, models, settings, spoken replies, onboarding, and admin overview.
2. Use production components for otherwise hard-to-reach open states: route sheet plus separate primitive dialog, sheet, and popover cases are bundled from `@aurora/ui` by the test-only component harness.
3. Assert a route-specific heading before every screenshot so redirects, access-denied states, or half-loaded shells do not become baselines.
4. Wait for shell bootstrap copy such as “Loading Aurora” and “Connecting to Aurora” to disappear before screenshots or overlay interaction.
5. Keep admin route captures explicit with `aurora-admin=1`.
6. Keep conversations sheet coverage strict: the test clicks the real “Open conversations” control and requires the “Conversations” heading.
7. Keep the screenshot matcher strict at `maxDiffPixelRatio: 0.001`; snapshot update records only the stable target, while normal runs append an inline 2px marker and require Playwright `toHaveScreenshot` to reject it against the same baseline.

## Boundaries

- No CSS, package manifest, lockfile, production app route, or CI changes are part of this phase.
- Root runs all Playwright/browser/build/typecheck commands and evaluates all screenshots.
- Agents can edit only the visual harness files and report readiness plus required root commands.

## Root validation path

```bash
pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts --update-snapshots
pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts
```

When using root’s already-running debug server:

```bash
AURORA_UI_VISUAL_BASE_URL=http://127.0.0.1:3428 pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts --update-snapshots
AURORA_UI_VISUAL_BASE_URL=http://127.0.0.1:3428 pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts
```
