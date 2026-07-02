# Tauri Dev Bootstrap and UI Production Gap Report

Date: 2026-07-02  
Scope: Tauri desktop dev bootstrap, local Gateway route availability, and every current Tauri UI route captured through Playwright against the running local dev stack.

## Executive status

The original failure was real: the Tauri UI could be launched, but the developer path was not self-contained, Python service logs were hidden from the Rust/Vite terminal, local permissions were interpreted as if the user had to select or approve almost every local route, and most admin routes rendered backend-evidence placeholders instead of product pages.

This pass fixed the minimal dev bootstrap and the false local-route blocking. It did **not** make the UI production complete. The current evidence shows a working local Tauri/Vite + Python threads-mode Gateway dev stack, but the UI still has major product gaps: admin routes are placeholders, Assistant is closer to a debug cockpit than a chat surface, Models shows contradictory selectable state, and several route pages are duplicated or incomplete.

## Evidence collected

Artifacts:

- Playwright route screenshots: `.omx/artifacts/ui-audit/screenshots/*.png`
- Playwright route summary: `.omx/artifacts/ui-audit/screenshots/summary.json`
- Dev command exercised: `pnpm --filter @aurora/tauri-ui tauri dev`
- Gateway health: `GET http://127.0.0.1:8000/api/health` returned healthy with 10 healthy services and 99 routes.
- Endpoint probes after fixes:
  - `Auth/ListPendingPairings`: HTTP 200, count 0
  - `Gateway/GetWebRTCDiagnostics`: HTTP 200
  - `Tooling/GetToolCatalog`: HTTP 200, count 9, blocked 0
  - `Auth/ListTokens`: HTTP 200, count 6
  - `Auth/MeshListPeers`: HTTP 200, count 8
  - `Gateway/GetCapabilityCatalog`: HTTP 200, count 99
  - `Orchestrator/GetModelCatalog`: HTTP 200, count 4

Playwright summary after fixes:

- All 22 routes loaded without navigation failure.
- The shell now reports `19/22 selectable` instead of the earlier `2/22`/`20 routes blocked` state.
- No route still reports broad false `privacy-blocked` except settings pages that intentionally display policy-control rows containing that word.
- Remaining route-level unsupported/unselectable items are real gaps: Access/RBAC backend contract, native-only shell evidence in browser fallback, and onboarding/native capability evidence.

## What was fixed in this pass

### 1. `tauri dev` now bootstraps the local Python services

Changed code:

- `apps/aurora-tauri/package.json`
- `apps/aurora-tauri/scripts/tauri-cli.mjs`
- `apps/aurora-tauri/src-tauri/src/lib.rs`

`pnpm --filter @aurora/tauri-ui tauri dev` now sets sane dev defaults automatically:

- `AURORA_ARCHITECTURE_MODE=threads`
- `AURORA_TAURI_DEV_AUTOSIDECAR=1`
- `AURORA_TAURI_SIDECAR_PROGRAM=<repo>/.venv/bin/python` when present
- `AURORA_TAURI_SIDECAR_ARGS=main.py`
- `AURORA_TAURI_SIDECAR_CWD=<repo root>`
- `AURORA_GATEWAY_URL=http://127.0.0.1:8000`

The Rust shell also pipes the Python sidecar stdout/stderr into the same terminal with `[aurora:python:stdout]` / `[aurora:python:stderr]` prefixes, so Vite, Rust, and Python service logs are visible together.

### 2. Managed dev sidecar exposes loopback Gateway without requiring manual auth setup

Changed code:

- `apps/aurora-tauri/src-tauri/src/lib.rs`
- `app/services/gateway/service.py`

The generated dev sidecar config now enables both Gateway and Auth services. For the managed local Tauri sidecar only, Gateway auth is disabled on loopback by `AURORA_TAURI_DISABLE_GATEWAY_AUTH=1` while the Auth service stays available for token/device/pairing/admin read models. This prevents a local anonymous dev shell from being mistaken for a remote untrusted client.

### 3. Route blocking was caused by policy/evidence mismatches, not actual missing local services

Changed code:

- `packages/aurora-sdk/src/capabilities.ts`
- `app/services/tooling/service.py`
- `app/services/auth/service.py`
- `app/services/gateway/service.py`

Root causes fixed:

- Local `explicit_selector_required` was treated as a hard privacy blocker. The SDK now treats local selector prompts as route preferences, not a reason to block the route.
- `Tooling.GetToolCatalog` saw local dev requests as missing permissions because the forwarded principal was `system`/`open_peer`; the local system/open peer envelope now gets system-equivalent permissions in the catalog path.
- Legacy token scopes using `all` violated the public token scope contract; they are normalized to `*` at the Auth API boundary.
- Mesh peer permissions stored as JSON strings caused Auth list APIs to 500; they are parsed before shaping `MeshPeerInfo`.
- Read-only diagnostics/list endpoints (`Gateway.GetWebRTCDiagnostics`, `Auth.ListPendingPairings`) were modeled as `manage` routes and generated HTTP 428 AdminAction requirements. They are now `use` routes while preserving their required manage permissions.

### 4. Browser Playwright can hit the real local Gateway

Changed code:

- `apps/aurora-tauri/src/aurora-client.ts`
- `packages/aurora-sdk/src/http.ts`
- `packages/aurora-sdk/src/client.ts`

The Vite/browser fallback now chooses `http://127.0.0.1:8000` during localhost dev instead of silently using fixtures. The SDK fetch binding was fixed for browsers, and unsupported native calls now reject asynchronously instead of throwing before `.catch()` can handle them.

## Current route-by-route audit

| Route | Current state from Playwright | Production gap |
| --- | --- | --- |
| `/` Assistant | Loads and can see `Orchestrator.ExternalUserInput`; no false privacy block. | Page is still a debug/evidence cockpit, not a production chat UI. It exposes route guards, JSON payloads, raw policy state, and unfinished voice controls. It needs thread history, streaming response UX, clean composer, model/tool context controls, attachments, and clear error/empty states modeled on `modules/ui-mock-reference/components/aurora/assistant/assistant-view.tsx`. |
| `/memory` | Loads without privacy block. | RAG namespaces can be unavailable because optional embedding deps are missing. UI does not clearly separate memory search, namespace management, privacy policy, import/export, and deletion flows. |
| `/tools` | Loads `9 tools`, `0 blocked`. | Raw backend tools/docstrings are exposed as approval cards. Production needs categories, search, clear safe execution flow, per-tool parameter forms, audit trail, and AdminAction/consent UX instead of a catalog dump. |
| `/mesh` | Loads without 428s after endpoint fixes. | Page shows stale persisted peers/device records and low-level trust data. Needs real peer lifecycle UX: empty state, pair/connect/disconnect, trust queue, route-quality summary, WebRTC diagnostics, and dangerous actions behind AdminAction confirmation. Mock reference: `modules/ui-mock-reference/components/aurora/mesh/mesh-view.tsx`. |
| `/admin` | Available route but renders `TauriRoutePlaceholder`. | There is an existing `AdminOverviewView` in `packages/aurora-ui/src/admin-overview-view.tsx`; Tauri shell does not mount it. |
| `/admin/services` | Available route but placeholder. | Existing `AdminServicesView` is not mounted. Needs service health, lifecycle affordances, logs/diagnostics links, and safe disabled mutation states. |
| `/admin/access` | Unsupported. | Backend capability/contract for RBAC roles (`ADM-003`, e.g. `Auth.ListRoles`) is missing or not advertised. Existing `AdminRbacView` cannot become real until backend contract exists. |
| `/admin/tokens` | Available route but placeholder. | No mounted token management page. Needs token list, revoke/rotate flows, scope display, redaction, and AdminAction confirmation. |
| `/admin/devices` | Available route but placeholder. | Existing `AdminDevicesView` is not mounted. Needs trusted devices, mesh identity linkage, revoke flow, stale-device state. |
| `/admin/config` | Available route but placeholder. | Existing `ConfigEditorView` is not mounted. Needs schema-aware config editing, diff, validation, rollback, secret redaction, and AdminAction confirmation. |
| `/admin/contracts` | Available route but placeholder. | Needs registry/method browser mounted from `Gateway.GetRegistry`/contract inventory. Current shell only shows capability evidence. |
| `/admin/plugins` | Available route but placeholder. | Existing `AdminPluginsView` is not mounted. Needs installed/enabled plugin state, tool exposure, reload/error states. |
| `/admin/pairing` | Available route but placeholder. | Existing `PairingQueueView` is not mounted. Needs pending pairing queue, approve/deny, QR/code display, expiry, audit. |
| `/admin/backups` | Available route but placeholder. | Existing `BackupRestoreView` is not mounted. Needs backup list/create/restore, encryption state, restore confirmation, and rollback warnings. |
| `/admin/scheduler` | Available route but placeholder. | Existing `AdminSchedulerView` is not mounted. Needs job list, run history, pause/resume, errors, and safe mutation boundary. |
| `/admin/audit` | Available route but placeholder. | Existing `AdminAuditView` is not mounted. Needs searchable/filterable audit log, correlation IDs, export/redaction. |
| `/models` | Loads 4 providers, 2 local, but reports `0 selectable` while a provider button says selected. | State is contradictory. Provider availability/selection logic must distinguish configured, selectable, selected, downloadable/importable, and benchmarkable. Local providers without configured model files need clear setup actions. Mock reference: `modules/ui-mock-reference/components/aurora/models/models-view.tsx`. |
| `/diagnostics` | Loads full route matrix and native boundary. | In browser Playwright it correctly shows `desktop-thin`/native unavailable, but production needs a separate real Tauri WebView smoke so desktop-local sidecar/native evidence is captured automatically. |
| `/onboarding` | Loads but has unsupported desktop-local/native paths in browser fallback. | Needs real first-run flow mounted from Tauri native evidence: choose local/thin/mesh, start/verify sidecar, token/pairing, and persist chosen endpoint. |
| `/settings` | Loads settings/policy state. | Good diagnostic content, but it is not yet a complete settings product: no writable forms, no confirmation flow, no local/remote route selector UI, no native permission request paths. |
| `/memory/policy` | Renders the same Memory page as `/memory`. | This should be a separate Data Policy page with retention, consent, namespace visibility, export/delete, and provenance controls. |
| `/settings/native` | Renders the same Settings page as `/settings`. | This should be a native capability/permission page with Tauri desktop, Android, and iOS-specific evidence and request buttons where supported. |

## Why the gates missed this

The existing gates proved buildability and endpoint contract shape, not product usability:

1. Tauri desktop CI proved the shell could build/check/smoke launch, not that every route mounted a real page.
2. SDK/UI tests accepted evidence placeholders as valid routeable UI.
3. Route gates checked capability metadata but did not fail on `TauriRoutePlaceholder` content.
4. Playwright coverage was not asserting production page landmarks, console/network cleanliness, or route-specific controls.
5. Browser fallback tests used fixtures or partial local evidence before this pass, so the real Gateway/sidecar path was under-tested.

## Required production remediation sequence

### Goal A — Lock the dev harness as a gate

- Add a CI/dev smoke that starts the same `tauri dev` bootstrap path in a bounded mode or verifies the wrapper/env contract plus Gateway endpoint readiness.
- Assert Python logs, Tauri/Rust logs, and Vite logs are all surfaced with stable prefixes.
- Assert `GET /api/health` and core read-only endpoints return 200 from the spawned sidecar.

### Goal B — Remove Tauri route placeholders

- Replace `TauriRoutePlaceholder` routing in `apps/aurora-tauri/src/tauri-app.tsx` with client-safe resource wrappers for the existing admin UI package components.
- If an existing view is async/server-shaped, wrap it in a client resource loader instead of rendering an async component directly.
- Add tests that fail if any primary nav route renders the placeholder copy.

### Goal C — Rebuild Assistant as a real chat UI

- Use the mock assistant structure: conversation rail, message thread, composer, route sheet, tool call cards, attachment/context sheet.
- Keep route/policy evidence accessible behind details panels, not as the primary page.
- Add streaming/event-state tests for pending, partial, final, error, cancellation, retry, and no-model states.

### Goal D — Complete local route policy semantics

- Keep the local selector fix, then add tests covering local selector-required, remote selector-required, consent-required, privacy-indicator-required, and AdminAction-required cases.
- Route matrix should count only real hard blockers as blocked.

### Goal E — Models production flow

- Fix `0 selectable` contradiction for local available providers.
- Separate selected/current provider, configured provider, downloadable/importable provider, and benchmarkable provider.
- Wire import/download/benchmark actions to real backend methods or disable them with explicit repair tasks.

### Goal F — Tools production flow

- Convert raw tool catalog cards into a tool browser with categories, search, parameter forms, execution preview, confirmation, result/error states, and audit visibility.
- Keep sensitive tools behind consent/AdminAction where required.

### Goal G — Memory and Data Policy split

- Make `/memory` a memory/RAG product page and `/memory/policy` a separate data policy page.
- Handle missing local embedding dependencies with actionable setup/status instead of silent unavailable namespaces.

### Goal H — Mesh product page

- Clear stale sample/dev peer confusion.
- Build pair/connect/trust/diagnostics flows with explicit empty/loading/error states.
- Keep WebRTC diagnostics and route-quality evidence visible but not as the whole product.

### Goal I — Settings and Native split

- Make `/settings` writable only through schema/diff/AdminAction flows.
- Make `/settings/native` a native capability page with desktop/Tauri, Android, and iOS-specific evidence/request affordances.
- Add a real Tauri WebView smoke for desktop-local native evidence, not only browser fallback Playwright.

### Goal J — CI gates that would have failed this UI

Add route-level Playwright assertions:

- Every nav route loads with no console errors and no 4xx/5xx except allowed static assets.
- No route renders `TauriRoutePlaceholder` copy.
- Each route has route-specific production landmarks/controls.
- Route matrix does not report local routes as privacy-blocked without a real consent or native permission action.
- Screenshot artifacts are uploaded for failures.

## Stop condition for production readiness

The UI should not be considered production-ready until:

1. `pnpm --filter @aurora/tauri-ui tauri dev` starts a clean local desktop dev stack from a fresh checkout with only normal install/setup steps.
2. All 22 primary nav routes mount real product pages or intentionally hidden/disabled navigation entries.
3. Playwright route gates fail on placeholders, route slop, console errors, false local privacy blocks, and missing route-specific controls.
4. Real Tauri desktop-local smoke captures sidecar/native evidence, not just browser fallback evidence.
5. Admin mutations have AdminAction draft/confirm/submit/audit/rollback/error UX before they are enabled.
