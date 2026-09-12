# Accessibility, Responsive, And Visual Regression Tests

## Scope

`pnpm --filter @aurora/ui test:accessibility` validates current SDK-backed React UI surfaces:

- Assistant cockpit through `AssistantView`.
- Admin/operator overview through `AdminOverviewContent`.
- Mobile settings/permissions through `SettingsPermissionsView`.

The suite uses `AuroraClient` plus SDK fixtures as the harness boundary. It does not claim live Gateway, Tauri IPC, native packaging, Android assistant-role, iOS App Intents, audio-device, or multi-peer mesh E2E coverage.

## Commands

```bash
pnpm --filter @aurora/ui test:accessibility
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/ui test
```

The focused script builds `@aurora/client` first because the UI package consumes the SDK package entrypoint.

## Artifacts

The focused suite writes artifacts under `packages/aurora-ui/reports/accessibility/`:

- `accessibility.json` — axe-core results for assistant, admin, and mobile settings surfaces at desktop/tablet/mobile widths.
- `responsive.json` — landmark, mobile navigation, backend-evidence, state-language, breakpoint, and focus-selector checks.
- `visual-regression.json` — deterministic normalized markup fingerprints and static HTML artifact paths.
- `security-privacy-negative-cases.json` — redaction, explicit-selector fallback, native unsupported, and AdminAction gating negative cases.
- `assistant-*.html`, `admin-*.html`, and `mobile-settings-*.html` — static render artifacts for review.

## Limits

This is a package-level regression suite, not a browser/device lab. Desktop Tauri, Android, iOS, live Gateway/process-mode, and two-peer mesh behavior are covered by their dedicated CI lanes in `docs/CI_CD.md`.
