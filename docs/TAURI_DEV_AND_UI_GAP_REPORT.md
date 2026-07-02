# Tauri Dev Bootstrap and UI Production Gap Report

**Status:** Current bounded check  
**Date:** 2026-07-02  
**Scope:** Tauri desktop dev bootstrap, shared 22-route UI inventory, route mounting, and current production-readiness gaps for the Aurora Tauri/web/mobile cockpit.

## Executive status

Aurora's UI is no longer in the earlier broken state where primary routes were navigable but rendered `TauriRoutePlaceholder` or diagnostics/debug-dashboard content. The shared nav contract defines 22 primary routes, `apps/aurora-tauri/src/tauri-app.tsx` registers every route to a real component, and the Tauri route crawl now fails if any registered route renders placeholder/debug-dashboard copy.

This report is still a bounded gap report, not a final production-readiness claim. Recent evidence proves route mounting, mock-aligned route-specific UI, and no broad false local privacy blocking in the component/test harness. Remaining work is concentrated in live `tauri dev` desktop stack proof, backend-backed mutation paths, full assistant/admin/runtime E2E flows against the real local Gateway, desktop-native evidence capture, Android/iOS preflight evidence, and final documentation/CI consolidation.

## Current authoritative route inventory

`packages/aurora-ui/src/nav.tsx` defines the 22 primary routes required by the controlling plan:

| Section | Routes |
| --- | --- |
| Assistant | `/`, `/memory`, `/tools`, `/mesh` |
| Operate | `/admin`, `/admin/services`, `/admin/access`, `/admin/tokens`, `/admin/devices`, `/admin/config`, `/admin/contracts`, `/admin/plugins`, `/admin/pairing`, `/admin/backups`, `/admin/scheduler`, `/admin/audit` |
| Runtime | `/models`, `/diagnostics`, `/onboarding`, `/settings`, `/memory/policy`, `/settings/native` |

Current route gates assert this inventory with:

```sh
pnpm --filter @aurora/tauri-ui test:e2e:routes
```

The gate checks that:

- `auroraNavSections` contains 22 routes.
- `tauriRouteRegistryRouteIds` equals the nav route id set.
- Every route renders without placeholder/debug-dashboard UI.
- Assistant, admin, and runtime route groups have route-specific assertions.
- Runtime routes do not inherit diagnostics/native-boundary content except `/diagnostics`.
- Runtime routes do not show broad false `aui-badge-privacy-blocked` except the separate `/memory/policy` data-policy surface.

## Evidence collected in the current tree

Recent local verification for this report and adjacent route stories:

```sh
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/ui test
pnpm --filter @aurora/ui test -- -t 'route availability|production surface'
pnpm --filter @aurora/tauri-ui test:e2e:routes
pnpm --filter @aurora/tauri-ui test -- -t 'registers a production Tauri component|renders every primary route|e2e:admin|e2e:runtime'
pnpm --filter @aurora/tauri-ui test
pnpm --filter @aurora/tauri-ui typecheck
```

Historical local-stack artifacts from the original audit remain useful as provenance, but they are not the final production evidence:

- Playwright route screenshots: `.omx/artifacts/ui-audit/screenshots/*.png`
- Playwright route summary: `.omx/artifacts/ui-audit/screenshots/summary.json`
- Dev command exercised in the earlier audit: `pnpm --filter @aurora/tauri-ui tauri dev`
- Gateway health in that audit: `GET http://127.0.0.1:8000/api/health` returned healthy with 10 healthy services and 99 routes.

The final ultragoal still needs a fresh real-stack `tauri dev` smoke with screenshot/log artifacts after all UI and CI work is complete.

## What is fixed now

### 1. Route placeholders are no longer the final route behavior

Changed/current files:

- `packages/aurora-ui/src/nav.tsx`
- `apps/aurora-tauri/src/tauri-app.tsx`
- `apps/aurora-tauri/src/aurora-client.test.tsx`

`tauri-app.tsx` now maps all 22 primary route ids to route-specific components/resource loaders. Admin routes no longer fall through to `TauriRoutePlaceholder`; the only remaining unregistered-route copy is a defensive fallback for future mistakes and is not reachable from the primary route registry.

### 2. Route-specific production surfaces exist for all 22 routes

The current UI package contains route-specific surfaces for assistant chat, memory/data policy, tools, mesh, admin overview/services/RBAC/tokens/devices/config/contracts/plugins/pairing/backups/scheduler/audit, models, diagnostics, onboarding, settings, and native/mobile capability evidence.

These surfaces are bound to `@aurora/client`, Gateway contracts, Tauri/native capability manifests, and route policy evidence instead of direct Python service calls.

### 3. False global privacy blocking is guarded

Local selector/privacy preference is no longer treated as a broad hard blocker in route tests. The route gates distinguish routeable product pages from real consent/native-permission/AdminAction blocking states, and the settings/data-policy pages may intentionally display privacy-blocked policy rows as route-specific content.

### 4. Mock UX references have been translated into production-shaped pages

The current implementation preserves key mock concepts while binding them to real evidence:

- Assistant: conversation rail, message thread, composer, route sheet, tool-call cards, voice modes, attachment/context handling.
- Mesh: topology/trust/peer diagnostics rather than stale sample-only peers.
- Models: provider/runtime cards and native local-light/mobile evidence.
- Admin suite: route-specific resources and disabled/AdminAction-gated mutation paths.
- Diagnostics: live probes, redacted support bundle posture, native boundary evidence.
- Onboarding: Server Web, Desktop Local, Mesh Shell, Mobile Thin, Offline Demo setup modes.
- Settings/native: privacy defaults, voice behavior, native permissions, Android/iOS integration states.

## Current route-by-route audit

| Route | Current state | Remaining production gap |
| --- | --- | --- |
| `/` Assistant | Route-specific assistant chat UI with prompt composer, conversation rail, route sheet, tool-call cards, voice states, and no diagnostics-dashboard landing. | Needs full real-stack send/stream/cancel/retry/no-model E2E against local Gateway and event-stream evidence. |
| `/memory` | Memory/RAG cockpit with history/provenance/namespace states. | Needs broader live DB/RAG namespace coverage, import/export/delete flows, and missing embedding-dependency repair evidence. |
| `/tools` | Tool browser/approval cockpit with catalog, approval, scheduler/automation context, and safe disabled states. | Needs real execution/dry-run coverage for safe local tools and sensitive approval/AdminAction flows. |
| `/mesh` | Mesh peers/topology/trust/route-policy UI mounted in Tauri. | Needs live pair/connect/disconnect evidence and WebRTC quality scenarios beyond fixture/test harness data. |
| `/admin` | Admin overview page mounted. | Needs live deployment posture and mutation coverage where backend supports it. |
| `/admin/services` | Services resource page mounted. | Needs real service lifecycle/log action coverage or explicit AdminAction-disabled evidence for unsupported mutations. |
| `/admin/access` | RBAC/access page mounted with backend gap/disabled-state handling. | Backend role/principal mutation contracts still need real support or explicit unavailable-route evidence. |
| `/admin/tokens` | Token management page mounted with scoped token/redaction posture. | Needs one-time reveal/revoke/rotate E2E with no secret leakage. |
| `/admin/devices` | Trusted devices and pending device state mounted. | Needs live revoke/approve/mesh identity linkage evidence. |
| `/admin/config` | Config editor page mounted with schema/diff/redaction/AdminAction posture. | Needs live validation/save/rollback/AdminAction coverage. |
| `/admin/contracts` | Contracts route is mounted through the admin services/registry resource path. | Needs richer registry browser/detail assertions and live schema coverage. |
| `/admin/plugins` | Plugins/MCP/tool exposure page mounted. | Needs live enable/disable/reload disabled-or-AdminAction evidence. |
| `/admin/pairing` | Pairing queue page mounted. | Needs create/approve/deny/expiry E2E and QR/deep-link evidence where supported. |
| `/admin/backups` | Backup/restore route mounted. | Needs live backup list/create/verify/restore dry-run support or explicit backend-gap handling. |
| `/admin/scheduler` | Scheduler route mounted. | Needs live schedule/pause/resume/cancel/run-history coverage. |
| `/admin/audit` | Searchable/filterable audit route mounted. | Needs export/redaction evidence and live correlation-id coverage. |
| `/models` | Models/runtime provider cockpit mounted with provider/native/mobile states. | Needs live provider selection/import/download/benchmark support or explicit disabled backend-gap paths. |
| `/diagnostics` | Diagnostics page is the only route centered on native boundary/runtime diagnostics. | Needs fresh desktop-local Tauri WebView evidence, support bundle artifacts, and platform matrix screenshots/logs. |
| `/onboarding` | Setup modes and Auth/pairing/endpoint flow mounted. | Needs real first-run desktop local sidecar start/verify and mobile-thin onboarding evidence. |
| `/settings` | Privacy defaults, route/fallback policy, voice behavior, and native permission summary mounted. | Writes remain disabled/AdminAction-gated until Config/AdminAction mutation paths are fully proven. |
| `/memory/policy` | Data policy route is separated from memory browse in tests and route assertions. | Needs full retention/raw-audio/transcript/export/delete live coverage. |
| `/settings/native` | Native capability/settings route is mounted with desktop, Android, and iOS evidence states. | Needs real Tauri desktop commands plus Android/iOS preflight artifacts and supported request-button behavior where native APIs exist. |

## Dev bootstrap status

The desired one-command desktop development experience remains:

```sh
pnpm --filter @aurora/tauri-ui tauri dev
```

The earlier bootstrap work configured Tauri dev defaults so the command can start Vite, Tauri/Rust, and Python Aurora services in threads mode with visible logs. The final ultragoal must rerun this from the current tree and preserve evidence that:

- Python service logs, Tauri/Rust logs, and Vite logs are visible together.
- Gateway readiness is checked before local-ready UI claims.
- Closing Tauri or interrupting the command shuts down the Python child cleanly.
- No manual sidecar build or extra environment ritual is needed for normal local dev.

## Operator guide alignment for G196-G199

The operator-facing docs now use these exact local commands and boundaries:

| Need | Command or source | What it proves | What it does not prove |
| --- | --- | --- | --- |
| One-command desktop local dev | `pnpm --filter @aurora/tauri-ui tauri dev` | Starts the Tauri dev path that auto-configures `.venv/bin/python main.py` or `uv run python main.py`, threads mode, loopback Gateway, managed sidecar defaults, and unified terminal logs. | It is interactive and must be rerun for final desktop evidence; package sidecar staging is separate. |
| Headless Linux route/UI smoke | `pnpm --filter @aurora/tauri-ui tauri:smoke:linux` | Delegates to `test:ci-regression-gates`, which runs route, assistant, admin, runtime, outcome, dev-bootstrap, native-evidence, and service-boundary gates without launching a desktop WebView. | It is not a substitute for `tauri dev` WebView screenshots or mobile/device evidence. |
| Desktop WebView smoke | `pnpm --filter @aurora/tauri-ui dev:smoke` | Launches `tauri dev`, probes `/api/health`, `/api/registry`, `/api/services`, requires `[tauri]` and `[aurora][...]` logs, and writes `apps/aurora-tauri/reports/tauri-dev-smoke.json`. | Requires a GUI-capable environment such as Xvfb on Linux CI. |
| Packaged thin desktop build | `pnpm --filter @aurora/tauri-ui build:bundle:thin` | Stages the `thin` sidecar profile and runs unsigned Tauri packaging through `src-tauri/tauri.release.conf.json`. | It does not sign, notarize, or prove heavyweight local assistant profiles. |
| Android CI preflight | `pnpm --filter @aurora/tauri-ui android:preflight:ci` after `pnpm --filter @aurora/tauri-ui android:init` | Requires the generated Android project and writes a redacted native/signing/capability report. | It does not require release keystore secrets. |
| Android release preflight | `pnpm --filter @aurora/tauri-ui android:preflight:strict` | Requires generated Android project and signing inputs. | It still needs real signed AAB/upload evidence for release. |
| iOS policy baseline on Linux | `pnpm --filter @aurora/tauri-ui ios:policy` | Checks iOS manifest/policy copy and rejects system-assistant replacement claims. | It cannot satisfy iOS build/preflight acceptance. |
| iOS build/preflight | `pnpm --filter @aurora/tauri-ui tauri ios init`, `pnpm --filter @aurora/tauri-ui tauri ios build`, `pnpm --filter @aurora/tauri-ui ios:preflight` | Requires macOS/Xcode and the generated iOS project; provides simulator/build evidence. | Linux runners cannot provide this evidence. |

Final G199 readiness must be recorded as evidence, not inferred from docs. The final quality gate should include command output, screenshot/artifact paths, ai-slop-cleaner result, code-reviewer approval, and architect invariant clearance. If any of those reviews have not run, the gate must say `pending` rather than claiming approval.

## Why the old gates missed the broken UI

The original gates proved buildability and route metadata, not product usability. The current route gates now close several of those holes:

| Old miss | Current/required gate |
| --- | --- |
| Tauri built while admin pages rendered placeholders. | `test:e2e:routes` asserts every primary route renders without placeholder/debug-dashboard copy. |
| Route registries could drift. | `tauriRouteRegistryRouteIds` must match all ids from `auroraNavSections`. |
| Assistant could regress into diagnostics content. | `e2e:assistant` asserts assistant-specific chat landmarks and no native-boundary dashboard copy. |
| Admin routes could be omitted from Tauri mounting. | `e2e:admin` enumerates all admin route ids and asserts admin-specific components. |
| Runtime routes could inherit false global privacy blocking. | `e2e:runtime` rejects broad diagnostics/privacy-blocked leakage outside intended policy surfaces. |

Remaining CI work should expand these into real browser/desktop Playwright jobs with screenshots/log artifacts, console/network cleanliness checks, assistant/admin/runtime journey coverage, and desktop/native/mobile preflight gates.

## Remaining production remediation sequence

1. **Fresh `tauri dev` smoke:** rerun the one-command local desktop stack from the current tree and capture Vite/Rust/Python logs, Gateway readiness, shutdown, and screenshots.
2. **Assistant E2E:** prove send/stream/fallback/cancel/retry/no-model, route sheet, tool-call cards, voice/TTS/transcription states, and attachment/context handling.
3. **Admin E2E:** prove read paths plus draft/disabled mutation paths for services, RBAC, tokens, devices, config, contracts, plugins, pairing, backups, scheduler, and audit.
4. **Runtime E2E:** prove models, diagnostics/support bundle, onboarding, settings/native, data policy, and platform behavior matrix.
5. **Native/mobile evidence:** run desktop-native smoke plus Android and iOS preflights; UI must not claim unsupported platform capabilities.
6. **Docs/CI consolidation:** update CI names and docs to the exact commands that are actually run; upload screenshots/logs for failing route gates.
7. **Final quality gate:** run cleanup, verification, independent code review, architect clearance, and architecture-invariant audit before marking the aggregate ultragoal complete.

## Stop condition for production readiness

The UI should not be considered production-ready until all of these are proven in current artifacts:

1. `pnpm --filter @aurora/tauri-ui tauri dev` starts and stops a clean local desktop stack from a normal checkout after standard install/setup.
2. All 22 primary nav routes mount route-specific production UI in web/Tauri route gates.
3. No production route renders placeholder text, raw route dumps, generic backend-state dashboards, or fixture-only product data without explicit demo labeling.
4. Desktop local, web thin, Android preflight, and iOS preflight have platform evidence.
5. Assistant, admin, mesh, memory, tools, models, settings/native, diagnostics, onboarding, and data policy have E2E coverage.
6. Admin/security/privacy invariants are independently reviewed.
7. Docs describe actual commands, supported modes, and platform limits.
8. Final quality gate contains verification evidence, screenshots/logs, cleanup/no-op evidence, code-reviewer approval, and architect clearance.
