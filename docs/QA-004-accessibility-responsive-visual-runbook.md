# QA-004 Accessibility, Responsive, And Visual Regression Runbook

## Scope

PER-225 adds a production gate for the current SDK-backed React UI surfaces:

- Assistant cockpit surface through `AssistantView`.
- Admin/operator overview through `AdminOverviewContent`.
- Mobile settings/permissions surface through `SettingsPermissionsView`.

The gate uses `AuroraClient` plus SDK fixtures as the harness boundary. It does not claim live Gateway, Tauri IPC, native packaging, Android assistant-role, iOS App Intents, audio-device, or multi-peer mesh E2E coverage.

## Commands

Run the focused gate:

```bash
pnpm --filter @aurora/ui test:qa004
```

This script builds `@aurora/client` first because the SDK package exports its `dist/` entrypoint.

Run the package checks:

```bash
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/ui test
```

Run the workspace frontend checks when release time allows:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Artifacts

The focused gate writes artifacts under:

```text
packages/aurora-ui/reports/qa-004/
```

Expected files:

- `accessibility.json` records axe-core results for assistant, admin, and mobile settings surfaces at desktop, tablet, and mobile widths.
- `responsive.json` records landmark, mobile navigation, backend-evidence, state-language, breakpoint, and focus-selector checks.
- `visual-regression.json` records deterministic normalized markup fingerprints and static HTML artifact paths.
- `security-privacy-negative-cases.json` records negative cases for redaction, explicit-selector fallback claims, native unsupported claims, and AdminAction gating.
- `assistant-*.html`, `admin-*.html`, and `mobile-settings-*.html` are static render artifacts for visual inspection.

## Platform Matrix

| Platform | Gate evidence | Status |
| --- | --- | --- |
| Browser/server web | React static render, SDK fixture state, axe-core/jsdom | Covered by `test:qa004`. |
| Desktop thin/Tauri shell | Shared UI package render only | Deferred to Tauri WebDriver/native sidecar gates. |
| Android | Mobile viewport/static settings surface only | Physical/OEM assistant-role matrix deferred to native release gates. |
| iOS | Mobile viewport/static settings surface only | App Intents/Shortcuts/device signing matrix deferred to native release gates. |
| Live backend/process mode | Not exercised by this UI package gate | Covered by backend/process-mode CI and future live E2E gates. |

## Accessibility Coverage

The gate runs axe-core against each rendered surface and viewport. `color-contrast` is an accepted skip because jsdom does not compute CSS color reliably; CSS token/focus checks and manual visual review cover that gap until browser-based visual tooling is available.

Keyboard and focus evidence:

- The shell exposes primary and mobile navigation landmarks.
- Each surface renders a single main content region through the app shell.
- CSS includes `:focus-visible`.
- Disabled actions remain buttons with disabled state rather than links that pretend to run unavailable behavior.

## Responsive And Visual Coverage

Viewports:

- Desktop: `1440x1024`.
- Tablet: `900x1180`.
- Mobile: `390x844`.

Visual regression is a deterministic normalized static-markup fingerprint. This is intentionally narrower than screenshot comparison; it proves structure, state language, routes, and action gating are stable without claiming browser layout pixels. Future Playwright/browser tooling can replace or supplement these baselines.

## Security And Privacy Negative Cases

The gate verifies:

- Secret-like token/API-key/password values are not rendered in the mobile settings surface.
- `secrets redacted` evidence remains visible.
- Explicit selector failures are not described as fallback success.
- Native capability claims stay unsupported without SDK native manifest evidence.
- Admin-critical settings remain AdminAction-gated.

## Release Readiness Checklist

- Run `pnpm --filter @aurora/ui test:qa004` and attach/report the generated artifact paths.
- Run `pnpm --filter @aurora/ui typecheck`.
- Run `pnpm --filter @aurora/ui test`.
- Record any skipped browser, native, device, or live backend coverage with owner and follow-up task.
- Do not mark Android assistant-role, iOS invocation, Tauri IPC, live Gateway, process mode, audio, or two-peer mesh behavior as production-complete from this gate alone.

## Rollback

If the gate blocks a release due to a UI regression:

1. Keep the failing `reports/qa-004/*.json` and matching HTML artifact.
2. Revert the UI change that altered the fingerprint or axe result.
3. Re-run `pnpm --filter @aurora/ui test:qa004`.
4. If the new output is intentional, update the baseline fingerprints in `packages/aurora-ui/tests/qa-004-accessibility-responsive-visual.test.tsx` and include the rationale in the PR.
