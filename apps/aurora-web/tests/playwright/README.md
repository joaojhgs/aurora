# Aurora UI visual baseline harness

This suite is the Phase 0 screenshot harness for PER-279. It is intentionally rooted in production routes and production UI components so CSS cleanup cannot pass against recreated fixture markup.

Root owns all browser execution and visual evaluation. Agents may edit this harness, but should not run the Playwright command, launch the servers, capture screenshots, or judge images.

## Root commands

From the repository root, after root has captured the intended pre-change state:

```bash
pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts --update-snapshots
pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts
```

The first command records baselines. The second command is the green oracle and includes the `@mutation` guard. During snapshot update the mutation test records the stable target and returns before applying the deliberate inline 2px mutation, so the update command does not replace the stable baseline with the mutated state.

If root is already running the Next debug server, use:

```bash
AURORA_UI_VISUAL_BASE_URL=http://127.0.0.1:3428 \
  pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts --update-snapshots
AURORA_UI_VISUAL_BASE_URL=http://127.0.0.1:3428 \
  pnpm exec playwright test --config apps/aurora-web/tests/playwright/ui-visual.playwright.config.ts
```

The config still starts a small test-only component harness on port `3429` unless `AURORA_UI_VISUAL_COMPONENT_BASE_URL` is provided.

## Coverage

- Product routes: assistant, shell navigation sheet, connected devices, models, settings, spoken replies, onboarding, and admin overview.
- Surfaces: web, desktop-local, desktop-thin, Android, and iOS debug presets.
- Viewports: full, tablet, and phone for the required product route matrix.
- Themes: dark and light.
- Open states: assistant execution popover, model popover, conversations sheet, debug preview panel, voice settings language popover, production route sheet, and separate production dialog, sheet, and popover primitive states.
- Guardrails: each routed screenshot waits for the shell bootstrap text to clear and asserts the expected heading before capture. Admin routes force `aurora-admin=1`; the conversations sheet must open and show its heading.
- Pixel oracle: Playwright `toHaveScreenshot` runs with `maxDiffPixelRatio: 0.001`, and the mutation guard uses the same matcher against the stable component baseline after applying a deliberate inline 2px mutation.

## Host integration notes

The component harness bundles production `@aurora/ui`, `@aurora/client`, and `@aurora/voice-web` through workspace package exports. Root should build any workspace dependencies whose package exports point at `dist`, or provide `AURORA_UI_VISUAL_COMPONENT_BASE_URL` to point the component cases at another already-running real harness.
