# Tauri/Web/Mobile UI Production Readiness — Single-Shot Ultragoal Team Plan

Date: 2026-07-02
Status: execution-ready plan, not implementation
Primary UX source: `modules/ui-mock-reference`
Current implementation anchors: `apps/aurora-tauri`, `packages/aurora-ui`, `packages/aurora-sdk`, `app/services/*`, `docs/TAURI_DEV_AND_UI_GAP_REPORT.md`, `docs/PRODUCTION_UI_CONTRACTS.md`, `docs/FRONTEND_AND_UI_ARCHITECTURE.md`
Codex goal-state warning: current thread has a completed aggregate Ultragoal objective. Before executing this plan in this same Codex thread, run `/goal clear` in the Codex UI or start a fresh Codex goal context.

## 0. Mission

Ship Aurora's Tauri/web/mobile UI as a production-ready operator and assistant cockpit, using the original mock UX as the visual and interaction target while binding every page to real Aurora SDK, sidecar, Gateway, bus, and Python-service behavior.

Completion means:

1. `pnpm --filter @aurora/tauri-ui tauri dev` starts a real local development stack without manual sidecar build or environment spelunking.
2. Desktop Tauri local mode starts/stops/monitors the Python Aurora node and surfaces Python, Rust/Tauri, and Vite/frontend logs in one developer-readable stream.
3. Web/thin mode works against an existing Gateway without pretending Tauri-native capabilities exist.
4. Every nav route is a real product page, not a placeholder, route report, fixture dump, or diagnostics dashboard.
5. Every production page has route-specific UI/UX from the mock reference, adapted to real data contracts and real empty/loading/error/permission states.
6. Every action that changes service state is protected by the existing AdminAction/permission model; read-only local routes are not falsely blocked by privacy selector requirements.
7. Desktop, web, Android, and iOS behavior is explicitly implemented or explicitly disabled with honest, actionable UX.
8. E2E and CI gates would have failed the previous broken UI: no placeholder pages, no broad false privacy blocking, no successful build masking broken navigation, no route with only debug copy.

## 1. Evidence and known current gaps

### 1.1 Mock UX evidence reviewed

The mock reference is a Next-style cockpit in `modules/ui-mock-reference` with these important product patterns:

- `components/aurora/app-shell.tsx`: desktop sidebar, mobile sheet menu, mobile bottom tabs, persistent cockpit shell.
- `components/aurora/assistant/assistant-view.tsx`: conversation rail, message thread, composer, route/privacy sheet, tool call cards, voice controls, attachment/context affordances.
- `components/aurora/assistant/route-sheet.tsx`: route candidates, privacy evidence, policy controls, selected route confirmation.
- `components/aurora/assistant/tool-call-card.tsx`: tool approval/deny UI with payload preview.
- `components/aurora/mesh/mesh-view.tsx`: mesh topology cards, trust queue, pair new peer, route preview, peer table, approve/deny/remove.
- `components/aurora/models/models-view.tsx`: provider cards, provider route policy, benchmark snapshot, runtime table, warnings.
- `components/aurora/admin/overview.tsx`: deployment posture, service health, capability gaps.
- `components/aurora/admin/services-view.tsx`: services table, heartbeat, routes, capabilities, restart/stop/detail affordances.
- `components/aurora/admin/rbac-view.tsx`: roles, principals, permissions, API tokens, trusted devices.
- `components/aurora/admin/tokens-view.tsx`: scoped tokens, create/revoke/copy flows, stats.
- `components/aurora/admin/devices-view.tsx`: trusted devices, pending pairings, platform capabilities.
- `components/aurora/admin/config-view.tsx`: config accordion, staged diff, secret/restart badges, review/apply flow.
- `components/aurora/admin/audit-view.tsx`: searchable/filterable audit log.
- `app/(cockpit)/memory/page.tsx`: memory/RAG collections plus conversation history.
- `app/(cockpit)/tools/page.tsx`: tool registry plus scheduler job snapshot.
- `components/aurora/diagnostics/diagnostics-view.tsx`: live probes, redaction preview, support-bundle export.
- `components/aurora/onboarding/onboarding-view.tsx`: server web, desktop local, mesh shell, mobile thin, offline demo setup modes.
- `components/aurora/settings/settings-permissions-view.tsx`: privacy defaults, voice behavior, native permissions, mobile integration states.

### 1.2 Current implementation evidence reviewed

- `packages/aurora-ui/src/nav.tsx` defines 22 primary routes:
  - Assistant: `/`, `/memory`, `/tools`, `/mesh`
  - Operate: `/admin`, `/admin/services`, `/admin/access`, `/admin/tokens`, `/admin/devices`, `/admin/config`, `/admin/contracts`, `/admin/plugins`, `/admin/pairing`, `/admin/backups`, `/admin/scheduler`, `/admin/audit`
  - Runtime: `/models`, `/diagnostics`, `/onboarding`, `/settings`, `/memory/policy`, `/settings/native`
- `apps/aurora-tauri/src/tauri-app.tsx` currently mounts real components only for assistant, models, memory/data, tools, mesh, settings/native, onboarding, diagnostics. All admin routes still fall into `TauriRoutePlaceholder` unless fixed.
- `docs/TAURI_DEV_AND_UI_GAP_REPORT.md` records that all 22 routes load after local route-policy fixes, but most route UX is still not production-ready.
- `packages/aurora-ui/src/production-surface-contracts.ts` already describes intended truth sources and should become the test oracle, not decorative metadata.
- Existing UI package already contains useful resource components (`AdminServicesResource`, `AdminDevicesResource`, `AdminAuditResource`, `AdminRbacResource`, `ConfigEditorView`, `BackupRestoreView`, `PairingQueueView`, `MeshPeersResource`, `MeshDiagnosticsResource`, `ModelsView`, `MemoryView`, `ToolApprovalPanel`, `OnboardingView`, `SettingsPermissionsView`), but many are incomplete, debug-shaped, fixture-shaped, or not mounted in Tauri.

### 1.3 Root failure pattern to prevent

The earlier gates passed because they verified shell/build existence and route loading, not production semantics. They did not fail when:

- a route was technically navigable but rendered placeholder copy;
- the assistant route rendered a backend-state/capability dashboard instead of chat;
- routes were counted as blocked because local selector/privacy policy states were treated as hard blockers;
- admin pages were omitted from Tauri mounting;
- mock-driven UX details were replaced by status text and catalog dumps;
- web Playwright could pass without desktop-native Tauri evidence;
- a sidecar existed for build packaging but `tauri dev` did not give a usable local development experience.

## 2. Non-negotiable architecture invariants

These invariants are part of the plan acceptance gate.

1. Services communicate through Aurora bus/contracts. No UI or Tauri code imports Python service internals directly.
2. Frontend accesses backend truth only through `@aurora/client` / `@aurora/sdk` abstractions or Tauri commands that themselves call the Gateway/sidecar boundary.
3. Local desktop sidecar is a development and packaging runtime boundary, not a second business-logic implementation.
4. Admin mutations require explicit AdminAction or equivalent permission confirmation. Read-only routes must not require AdminAction solely because their underlying permission namespace is sensitive.
5. Privacy selector, consent, privacy indicator, native permission, and AdminAction are distinct states in UI and SDK. Local selector preference is not a hard route block.
6. Web, desktop-local, desktop-thin, Android, and iOS show platform-specific capability truth. Unsupported native capabilities must be honest and actionable, not hidden or falsely advertised.
7. Existing `modules/ui-mock-reference` visual/interaction structure is the UX target. Implementation may adapt data and platform constraints, but not replace product flows with debug dashboards.
8. Build and dev workflows remain simple: `tauri dev` for desktop development, package scripts for build matrix, no manual sidecar env var ritual for normal use.
9. Tests prove user outcomes: real navigation, real calls, real state transitions, real errors, real screenshots, not just TypeScript/Cargo/build success.

## 3. Execution topology: single-shot Ultragoal with six parallel teams

Run as one aggregate Ultragoal with Team execution. Max six concurrent lanes to match AGENTS.md. The leader owns Ultragoal state and final verification. Workers own lane-local tasks and return evidence only.

### Team lanes

1. **Lane A — Shell, design system, route mounting**
   - Owner role: designer + executor
   - Scope: app shell fidelity, route map, placeholder removal, responsive layout, shared states, accessibility foundations.

2. **Lane B — SDK, sidecar, Gateway, contracts**
   - Owner role: architect + executor
   - Scope: missing backend/SDK methods, route policy semantics, sidecar/dev logging, platform manifests.

3. **Lane C — Assistant, voice, tools, memory**
   - Owner role: executor + test-engineer
   - Scope: chat UX, route sheet, tool approvals, memory/RAG, data policy, voice/TTS/transcription interactions.

4. **Lane D — Mesh, models, onboarding, settings/native**
   - Owner role: executor + designer
   - Scope: runtime pages and platform-specific UX.

5. **Lane E — Admin/operate suite**
   - Owner role: executor + security-minded reviewer
   - Scope: overview, services, access/RBAC, tokens, devices, config, contracts, plugins, pairing, backups, scheduler, audit.

6. **Lane F — E2E, visual, CI, docs, release readiness**
   - Owner role: test-engineer + verifier
   - Scope: Playwright/Tauri/mobile smoke, CI gates, visual evidence, docs, final production readiness audit.

### Dependency rules

- Lane B publishes SDK/backend contract shims first where UI lanes need data shapes.
- UI lanes can initially implement against typed fixture adapters only when a production adapter contract exists in the same PR; final acceptance requires real Gateway/sidecar E2E for each feature class.
- Lane F writes failing gates early so lane work cannot regress into placeholders/debug dashboards.
- Admin mutations cannot be faked as successful. If backend support is missing, add the backend contract or keep action disabled with an explicit repair task and test.

## 4. Goal decomposition

### G001 — Establish production UI design contract and route inventory

**Owner:** Lane A with leader review  
**Depends on:** none  
**Files likely touched:** `DESIGN.md`, `docs/PRODUCTION_UI_CONTRACTS.md`, `packages/aurora-ui/src/nav.tsx`, route test fixtures

**Work:**

- Create/refresh repo-root `DESIGN.md` using `modules/ui-mock-reference` as evidence.
- Define product personas: local desktop assistant user, remote web operator, mesh admin, mobile thin client user.
- Lock IA: Assistant, Operate, Runtime sections and route purposes.
- Map each of the 22 route IDs to:
  - product purpose;
  - mock reference source;
  - real backend truth source;
  - desktop/web/mobile behavior;
  - key controls/landmarks;
  - empty/loading/error/offline states;
  - permission/AdminAction behavior;
  - required E2E checks.
- Add a machine-readable route production checklist fixture if useful, derived from `production-surface-contracts.ts`.

**Acceptance:**

- `DESIGN.md` exists and cites reviewed mock/code evidence.
- Every route has a named production component and no route is allowed to use `TauriRoutePlaceholder` as final behavior.
- Test oracle enumerates all 22 routes and expected page landmarks.

### G002 — Lock `tauri dev` as the one-command local developer experience

**Owner:** Lane B  
**Depends on:** none  
**Files likely touched:** `apps/aurora-tauri/package.json`, `apps/aurora-tauri/scripts/tauri-cli.mjs`, `apps/aurora-tauri/src-tauri/src/lib.rs`, `main.py`, `docs/TAURI_DESKTOP_BUILD.md`, dev smoke tests

**Work:**

- Ensure `pnpm --filter @aurora/tauri-ui tauri dev` starts:
  - Vite frontend;
  - Rust/Tauri shell;
  - Python Aurora services in `threads` mode via sidecar/dev process;
  - Gateway on `http://127.0.0.1:8000` unless overridden.
- Never require a prebuilt packaged sidecar for dev.
- Auto-detect `.venv/bin/python` or fallback to `uv run python main.py`.
- Prefix logs consistently:
  - `[vite]` frontend bundler;
  - `[tauri]` Rust shell/native commands;
  - `[aurora]` Python service logs;
  - `[gateway]` health/API readiness if separated.
- Add clean shutdown: closing Tauri terminates child Python process; Ctrl-C drains all child processes.
- Add readiness probes before showing the UI as local-ready:
  - `/api/health`;
  - `/api/registry` or equivalent;
  - core read-only endpoint sample;
  - sidecar status command.
- Keep packaged build sidecar staging separate from dev runtime.

**Acceptance:**

- One command starts a usable local stack on Linux dev environment.
- Logs from Python, Tauri, and Vite are visible in the same terminal with stable prefixes.
- Sidecar status in UI is backed by actual Tauri command evidence, not browser fallback.
- Dev smoke fails if Gateway is not ready, Python process exits, or no logs are surfaced.

### G003 — Fix route policy semantics and SDK truth model

**Owner:** Lane B  
**Depends on:** G001 route inventory can proceed in parallel  
**Files likely touched:** `packages/aurora-sdk/src/capabilities.ts`, `packages/aurora-sdk/src/client.ts`, `packages/aurora-ui/src/shell-state.ts`, Gateway/Auth/Tooling services and contract models

**Work:**

- Distinguish these states everywhere:
  - `available-local`;
  - `available-remote`;
  - `degraded`;
  - `unsupported`;
  - `pending`;
  - `offline`;
  - selector-required;
  - consent-required;
  - privacy-indicator-required;
  - native-permission-required;
  - AdminAction-required.
- Ensure local selector-required routes remain clickable and show route-selection UX, not hard blocked status.
- Ensure remote/personal/sensitive routes that require consent remain blocked until consent/action.
- Normalize token scopes and permissions consistently across Auth list APIs.
- Provide SDK helpers for UI lanes:
  - `client.capabilities.listCatalog()`;
  - `client.capabilities.explainRoute(routeId/method)`;
  - `client.adminAction.draft/confirm/cancel`;
  - stable error shape mapping HTTP/Gateway failures to UI states.
- Fix missing/incorrect route metadata for read-only admin diagnostics endpoints.

**Acceptance:**

- Route matrix in desktop local mode does not report broad false `privacy-blocked` for local read routes.
- Tests cover selector-required vs consent-required vs privacy-indicator-required vs AdminAction-required vs native-permission-required.
- Each route has a deterministic `routeable`, `selectable`, `disabledReason`, and `actionRequired` outcome.

### G004 — Replace placeholders with mounted, client-safe route components

**Owner:** Lane A  
**Depends on:** G001; can start before G003 complete  
**Files likely touched:** `apps/aurora-tauri/src/tauri-app.tsx`, `packages/aurora-ui/src/*Resource*.tsx`, route adapters

**Work:**

- Replace `TauriRoutePlaceholder` final route behavior.
- Create a typed route component registry for the 22 nav items.
- Wrap async/server-shaped admin views in client-safe resource loaders.
- Preserve common `PageHeader`, route badges, permission notices, and shared loading/error/empty states.
- Keep diagnostics available only on `/diagnostics`, not as the default substitute for product routes.
- Add a temporary build-time/test-only assert that no route reaches placeholder copy.

**Acceptance:**

- Every primary nav route renders a route-specific landmark and at least one route-specific control/table/list/composer.
- Playwright route crawl fails if any route contains the placeholder phrase or generic “full product page still needs to be mounted” copy.
- Tauri and web route registries use the same nav contract unless a platform intentionally hides a route.

### G005 — Rebuild global shell to match mock-quality cockpit UX

**Owner:** Lane A  
**Depends on:** G001  
**Files likely touched:** `packages/aurora-ui/src/shell.tsx`, CSS/theme files, `apps/aurora-tauri/src/index.css`, shared layout components

**Work:**

- Implement mock-inspired desktop sidebar with grouped nav, active route state, route status chips, local/thin mode badge, quick diagnostics indicator.
- Implement mobile sheet navigation and mobile bottom tabs from mock (`Assistant`, `Mesh`, `Admin`, `Diagnostics`, `Settings`).
- Keep content responsive:
  - desktop: side rail + max content width where appropriate;
  - tablet: collapsible rail;
  - mobile: bottom tabs + sheet menu + touch-sized controls.
- Add shared components:
  - `PageHeader`;
  - `RouteBadge`;
  - `StateSurface` with concise copy;
  - `AdminActionButton`;
  - `CapabilityDrawer` adapted from mock;
  - consistent skeletons/errors/empty states.
- Remove debug dump styling from product routes.

**Acceptance:**

- Desktop and mobile screenshots show cockpit shell, not a raw dashboard.
- Keyboard navigation and focus indicators work for nav/menu/dialog/sheet.
- Lighthouse/axe or equivalent accessibility smoke has no critical issues for core routes.

### G006 — Assistant production chat page

**Owner:** Lane C  
**Depends on:** G003 for route semantics; G005 for shell components  
**Files likely touched:** `packages/aurora-ui/src/assistant-view.tsx`, route sheet/tool card components, SDK assistant methods, tests

**UX target:** `modules/ui-mock-reference/components/aurora/assistant/assistant-view.tsx`, `route-sheet.tsx`, `tool-call-card.tsx`

**Work:**

- Page structure:
  - conversation rail with recent conversations, local/remote/mesh route chips, search/new chat;
  - main message thread with user/assistant/system/tool messages;
  - composer with multiline input, send, stop, retry, attach/context, voice push-to-talk;
  - route/privacy sheet with candidates, selected provider, evidence, policy warnings;
  - tool call cards with approve/deny/edit scope;
  - compact runtime strip showing selected model, route, sidecar/Gateway health.
- Integration:
  - `Orchestrator.ExternalUserInput` for send;
  - event stream/streaming if available, with fallback to request/response;
  - cancellation route if supported;
  - TTS synth/stop for spoken reply where available;
  - Transcription/WakeWord controls only where backend/native capability exists;
  - context ingestion for text/url/file if supported.
- States:
  - empty first-run;
  - no model configured;
  - route selector required;
  - streaming partial;
  - tool approval pending;
  - timeout/retry;
  - cancellation;
  - offline sidecar;
  - remote Gateway auth failure.
- Privacy:
  - personal/sensitive route warning before remote/mesh fallback;
  - raw audio indicator;
  - no secret/tool payload raw dumps outside approved preview components.

**Acceptance:**

- User can send a text prompt against local Gateway in Tauri dev and see a real response or a precise backend error.
- Assistant page no longer shows global backend-state dashboard as primary content.
- E2E covers send, streaming/fallback, stop/retry, route sheet open/select, tool approval mock/live path, and no-model state.

### G007 — Memory and Data Policy production pages

**Owner:** Lane C  
**Depends on:** G003  
**Files likely touched:** `packages/aurora-ui/src/memory-view.tsx`, new `data-policy-view.tsx`, DB SDK methods/contracts if missing

**UX target:** `modules/ui-mock-reference/app/(cockpit)/memory/page.tsx` plus settings privacy patterns

**Work:**

- `/memory`:
  - summary cards for namespaces/records/retention/embedding health;
  - searchable conversation history;
  - RAG collections/namespace table;
  - provenance drawer showing source, route, privacy class, last used;
  - delete/export actions gated appropriately;
  - embedding dependency status with setup instructions when local embeddings are unavailable.
- `/memory/policy`:
  - retention defaults;
  - namespace visibility;
  - raw audio/transcript storage toggles;
  - remote/mesh fallback rules;
  - export/delete/import data flows;
  - audit trail for data policy changes.
- Backend/SDK:
  - use `DB.GetMessages`, `DB.GetMessagesForDate`, `DB.RAGSearch`;
  - add/list namespace and memory management endpoints if absent or mark disabled with repair task;
  - use Config/AdminAction for policy mutations.

**Acceptance:**

- Memory route shows real data or real empty state, not generic capability report.
- Data policy route is separate from memory browse and does not duplicate `/memory`.
- E2E covers search empty/results/error, namespace unavailable, retention toggle draft, export/delete disabled or confirmed flow.

### G008 — Tools and automations production page

**Owner:** Lane C  
**Depends on:** G003  
**Files likely touched:** `packages/aurora-ui/src/tool-approval-panel.tsx`, tooling SDK, scheduler link components

**UX target:** `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx` plus assistant tool-call card

**Work:**

- Replace raw catalog cards with:
  - category tabs/search/filter;
  - tool detail drawer with schema, permissions, provider, risk, examples;
  - parameter form generated from schema;
  - dry-run/preview when available;
  - execute flow with approval when sensitive/admin;
  - result/error panel and audit receipt;
  - MCP server status and reload if safely supported;
  - scheduler job snapshot and link to `/admin/scheduler`.
- Keep high-risk tools disabled until consent/AdminAction confirmed.
- Avoid presenting unavailable tooling as working.

**Acceptance:**

- Tool catalog can be browsed and filtered.
- At least one safe local tool path is executable or honestly disabled with backend repair task.
- Sensitive tool path shows approval UI and does not execute directly.
- E2E covers catalog load, search, detail drawer, parameter validation, approval-required path, execution/error path.

### G009 — Mesh production page

**Owner:** Lane D  
**Depends on:** G003; parts depend on backend mesh status  
**Files likely touched:** `packages/aurora-ui/src/mesh-peers-resource.tsx`, Gateway/Auth mesh methods, WebRTC diagnostics SDK

**UX target:** `modules/ui-mock-reference/components/aurora/mesh/mesh-view.tsx`

**Work:**

- Page structure:
  - topology summary cards;
  - local node identity/status;
  - trust queue/pending pairings;
  - pair new peer flow with code/QR/deep link when available;
  - route preview for selected peer/capability;
  - peer table with status, quality, permissions, last seen, actions;
  - WebRTC diagnostics panel;
  - stale/dev peer cleanup messaging.
- Actions:
  - approve/deny pending pairings;
  - remove/revoke peer;
  - copy pairing code;
  - refresh diagnostics;
  - explain route through peer.
- Platform behavior:
  - desktop local can be full node if Gateway mesh enabled;
  - web thin can view/manage remote mesh only through Gateway;
  - mobile thin can pair and invoke remote/mesh capabilities but must not claim full local service host unless native backend exists.

**Acceptance:**

- No stale sample peers are presented as live truth.
- Empty mesh state clearly explains how to pair.
- E2E covers status load, pair flow entry, approve/deny disabled/live state, route preview, WebRTC diagnostic error state.

### G010 — Models and runtime provider production page

**Owner:** Lane D  
**Depends on:** G003  
**Files likely touched:** `packages/aurora-ui/src/models-view.tsx`, Orchestrator model catalog/config SDK, native local-light manifest

**UX target:** `modules/ui-mock-reference/components/aurora/models/models-view.tsx`

**Work:**

- Fix contradiction where page says local provider exists but `0 selectable`.
- Distinguish:
  - currently selected provider;
  - configured providers;
  - installed local models;
  - downloadable/importable models;
  - benchmarkable providers;
  - mesh/remote providers;
  - mobile local-light availability.
- UI:
  - provider cards with health, privacy, latency/context, route quality;
  - current route policy banner;
  - benchmark snapshot table;
  - model path/import/download setup CTA;
  - provider selection confirmation;
  - no model configured assistant repair link.
- Backend:
  - use `Orchestrator.GetModelCatalog` and Config methods;
  - add benchmark/import/download endpoints only if production-backed; otherwise disabled with explicit repair issue.

**Acceptance:**

- Local provider is selectable when capability catalog reports executable provider.
- Selection writes through a real config/admin flow or remains disabled with precise repair task.
- E2E covers catalog load, provider select/draft, no-provider state, mobile local-light unsupported state.

### G011 — Onboarding production flows

**Owner:** Lane D  
**Depends on:** G002, G003  
**Files likely touched:** `packages/aurora-ui/src/onboarding-view.tsx`, auth SDK, secure storage/native commands

**UX target:** `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx`

**Work:**

- Implement mode cards:
  - Server Web: connect to remote HTTP Gateway, validate endpoint, login/token.
  - Desktop Local: start/verify local sidecar, Gateway, config path, service health.
  - Desktop Thin: connect to remote Gateway from Tauri without local sidecar.
  - Mesh Shell: pair with trusted peer, validate route catalog.
  - Android Mobile Thin: permissions, endpoint/pairing, keystore storage.
  - iOS Mobile Thin: endpoint/pairing, Keychain storage, Shortcuts/App Intents capability explanation.
  - Offline Demo: clearly fixture-only if retained; excluded from production default unless explicitly enabled.
- Persist selected mode safely per platform.
- Show resumable setup steps and repair actions.

**Acceptance:**

- First-launch route guides user to a working mode without raw backend status dump.
- Invalid endpoint/auth failure has usable recovery.
- Desktop local path can start via `tauri dev` or packaged sidecar.
- Mobile paths do not claim unavailable system-assistant replacement capabilities.

### G012 — Settings and Native capabilities split

**Owner:** Lane D  
**Depends on:** G003  
**Files likely touched:** `packages/aurora-ui/src/settings-permissions-view.tsx`, new native page/adapters, Config/native SDK

**UX target:** `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx`

**Work:**

- `/settings`:
  - route privacy defaults;
  - voice defaults;
  - assistant behavior;
  - theme/accessibility/local storage;
  - settings changes through staged diff/AdminAction where required.
- `/settings/native`:
  - Tauri desktop manifest and permissions;
  - tray/notifications/dialogs/audio/file/native shell/updater status;
  - Android assistant role, notifications, foreground service/audio, keystore, biometrics, share/deep link;
  - iOS Keychain, biometrics, App Intents/Shortcuts/widgets/share/deep links, foreground voice constraints;
  - request permission buttons only when platform supports them;
  - no browser fallback pretending native status.

**Acceptance:**

- Settings and Native pages are not duplicates.
- Native page shows real Tauri command evidence on desktop local.
- Web shows native-unavailable thin behavior cleanly.
- E2E covers desktop native evidence and browser fallback unsupported evidence.

### G013 — Admin overview and services

**Owner:** Lane E  
**Depends on:** G004; G003 for AdminAction semantics  
**Files likely touched:** admin overview/services components, Gateway services SDK

**UX target:** `admin/overview.tsx`, `admin/services-view.tsx`

**Work:**

- `/admin`:
  - deployment posture;
  - service health totals;
  - capability gaps;
  - recent admin/audit events;
  - sidecar/process mode summary;
  - shortcuts to services/config/contracts/audit.
- `/admin/services`:
  - services table with status, instance, route count, heartbeat, dependencies, logs link;
  - detail drawer with contracts/capabilities/recent errors;
  - restart/stop/reload only when backend supports it and after AdminAction;
  - process/thread mode differences.

**Acceptance:**

- Both pages mount in Tauri and web.
- Health is live Gateway/service truth.
- Mutations are disabled or confirmed, never fake-success.

### G014 — Access/RBAC, tokens, and devices

**Owner:** Lane E  
**Depends on:** G003; may require backend contracts  
**Files likely touched:** `AdminRbacResource`, auth SDK, `app/services/auth`, contract models

**UX target:** `admin/rbac-view.tsx`, `admin/tokens-view.tsx`, `admin/devices-view.tsx`

**Work:**

- `/admin/access`:
  - roles list;
  - principals/users/peers;
  - permission matrix;
  - role assignment and permission patch preview;
  - audit receipt.
- Backend gap:
  - `Auth.ListRoles` is currently advertised but unsupported/missing. Add real contract or derive roles explicitly from existing permission catalog with honest label.
- `/admin/tokens`:
  - list scoped tokens with prefix, owner, scopes, expiry, last used;
  - create token wizard with one-time reveal/copy;
  - revoke/rotate with AdminAction.
- `/admin/devices`:
  - trusted devices;
  - pending pairings;
  - mesh peer linkage;
  - revoke/approve/trust actions;
  - platform native security status.

**Acceptance:**

- Access route is no longer unsupported in local mode if backend roles/principals exist.
- Token creation never logs/reveals secrets after one-time display.
- Device/pairing actions require proper confirmation.
- E2E covers read pages and at least draft/disabled mutation flows.

### G015 — Config editor and contracts registry

**Owner:** Lane E  
**Depends on:** G003  
**Files likely touched:** config editor, contracts view, Config/Gateway SDK

**UX target:** `admin/config-view.tsx`; contracts concepts in mock data and docs

**Work:**

- `/admin/config`:
  - schema-backed section accordion;
  - typed fields and validation;
  - secret redaction;
  - staged diff;
  - reload/restart impact;
  - apply/discard/review AdminAction.
- `/admin/contracts`:
  - registry browser by service/module;
  - method detail with input/output schema, exposure, permissions, generated route path;
  - OpenAPI link/export;
  - contract conformance status;
  - route explain link.

**Acceptance:**

- Config cannot expose secrets or write without confirmation.
- Contracts page uses live registry, not static mock lists.
- E2E covers search/filter/detail and config validation error path.

### G016 — Plugins, pairing, backups, scheduler, audit

**Owner:** Lane E  
**Depends on:** G003  
**Files likely touched:** existing resource views, Tooling/Auth/Backup/Scheduler SDK, service contracts if missing

**UX targets:** mock admin patterns plus `tools/page.tsx`, `diagnostics-view.tsx`, current resource components

**Work:**

- `/admin/plugins`:
  - plugin/MCP catalog;
  - enabled/disabled/health;
  - reload only if backend route exists and gated;
  - plugin errors/logs.
- `/admin/pairing`:
  - pending pairing queue;
  - create pairing code/QR/deep link;
  - approve/deny/exchange/revoke;
  - expiry and audit.
- `/admin/backups`:
  - list backups;
  - create backup;
  - verify;
  - restore dry-run;
  - rollback warning;
  - encryption/manifest status.
- `/admin/scheduler`:
  - jobs table;
  - create/edit/pause/resume/cancel;
  - recurrence display;
  - run history;
  - tool integration.
- `/admin/audit`:
  - search/filter by actor/action/resource/time;
  - details drawer;
  - correlation id;
  - redacted export.

**Acceptance:**

- Every route has real live read path or explicit unavailable backend repair state.
- No route is a generic placeholder.
- Mutations use AdminAction or are disabled with exact missing contract.
- Audit export redacts secrets/payloads.

### G017 — Diagnostics and support bundle

**Owner:** Lane D + Lane F  
**Depends on:** G002/G003  
**Files likely touched:** diagnostics view, log stream adapters, support bundle scripts

**UX target:** `components/aurora/diagnostics/diagnostics-view.tsx`

**Work:**

- Diagnostics page should be the only page centered on system status.
- Include:
  - service probes;
  - Gateway route registry health;
  - event stream health;
  - WebRTC diagnostics;
  - native manifest/permission evidence;
  - sidecar process evidence;
  - recent frontend errors;
  - redaction preview;
  - support bundle export.
- Support bundle must exclude secrets/raw audio/token values.

**Acceptance:**

- Diagnostics can export or preview a redacted bundle.
- E2E captures healthy/degraded/error probe states.
- Product pages link to diagnostics for troubleshooting instead of embedding full diagnostic dumps.

### G018 — Desktop/web/mobile platform behavior matrix

**Owner:** Lane B + Lane D + Lane F  
**Depends on:** G002/G003/G012  
**Files likely touched:** platform adapters, Tauri permissions/manifests, Android/iOS generated config, tests/docs

**Work:**

Implement and test this behavior matrix:

| Platform | Runtime mode | Expected behavior |
| --- | --- | --- |
| Desktop Tauri local | local sidecar + Gateway | Starts Python services, shows native Tauri manifest, tray/logs/sidecar status, full assistant/admin/runtime if backend enabled. |
| Desktop Tauri thin | remote Gateway | No local sidecar requirement; native shell available but backend services remote; local-only actions disabled. |
| Web browser | remote/local HTTP Gateway only | No Tauri commands; browser mic only with permission; no native secure storage claims. |
| Android Tauri | mobile thin/native shell | Gateway/mesh transport first; Android assistant role and foreground voice status honest; keystore/notifications/share/deeplink where implemented. |
| iOS Tauri | mobile thin/native shell | Keychain/biometric/App Intents/Shortcuts/share/deeplink/widgets status honest; no system assistant replacement claim. |
| Offline demo | optional fixture mode | Clearly marked fixture/demo only; disabled in production builds unless explicit env flag. |

**Acceptance:**

- Platform-specific screenshots or JSON evidence exist for desktop local, web fallback, Android preflight, iOS preflight.
- UI never reports unsupported native capabilities as available.
- Mobile routes are usable as thin clients even when local Python services are unavailable.

### G019 — Production E2E, visual, and CI gates

**Owner:** Lane F  
**Depends on:** starts immediately; finalizes after G004-G018  
**Files likely touched:** Playwright tests, Tauri smoke, CI workflows, test fixtures, docs

**Work:**

Add gates that would have failed the prior broken implementation:

1. **Route production crawl:**
   - starts Gateway/sidecar or fixture-backed Gateway as appropriate;
   - visits all 22 routes;
   - asserts no console errors;
   - asserts no unexpected 4xx/5xx;
   - asserts no placeholder copy;
   - asserts route-specific landmarks/controls from G001.
2. **Assistant E2E:**
   - send message;
   - streaming/fallback result;
   - route sheet;
   - tool approval card;
   - cancellation/retry/no-model states.
3. **Admin E2E:**
   - services health;
   - contracts registry;
   - config validation/diff;
   - access/tokens/devices read paths;
   - audit filtering;
   - mutation draft/confirmation disabled/live checks.
4. **Runtime E2E:**
   - mesh status/pairing entry;
   - models provider selection state;
   - memory search;
   - tools catalog/detail;
   - diagnostics export redaction preview;
   - settings/native platform status.
5. **Visual evidence:**
   - store screenshots for all primary routes on desktop viewport;
   - store mobile viewport screenshots for shell and main route classes;
   - compare only stable landmarks/layout classes unless pixel baselines are approved.
6. **Tauri desktop smoke:**
   - `tauri dev`/bounded smoke verifies sidecar readiness and native command evidence;
   - existing Linux Tauri check remains.
7. **Mobile gates:**
   - Android preflight/emulator smoke for manifest and startup;
   - iOS policy/build baseline on macOS;
   - no signing required for PR gates.
8. **Static checks:**
   - no `TauriRoutePlaceholder` reachable from production route registry;
   - no fixture/demo mode in production build unless explicitly labeled;
   - no raw secret/token in UI logs or support bundle.

**Acceptance:**

- CI names are clear and non-duplicative:
  - Quality;
  - Python Tests;
  - Frontend and SDK;
  - Tauri Desktop Verification;
  - Tauri Android Verification;
  - Tauri iOS Baseline/Policy;
  - End-to-End Tests;
  - Docker Images.
- Failing screenshots/log artifacts are uploaded.
- Gates fail against the known-bad placeholder/dashboard behavior.

### G020 — Documentation, operator guide, and final quality gate

**Owner:** Lane F + leader  
**Depends on:** all goals  
**Files likely touched:** `docs/TAURI_DESKTOP_BUILD.md`, `docs/UI_INTEGRATION.md`, `docs/FRONTEND_AND_UI_ARCHITECTURE.md`, `docs/PRODUCTION_UI_CONTRACTS.md`, README snippets

**Work:**

- Document:
  - one-command Tauri dev;
  - sidecar concept and dev vs packaged behavior;
  - build matrix and package signing exclusions;
  - platform capability matrix;
  - how to run E2E/UI smoke locally;
  - route production contract;
  - troubleshooting logs and support bundle redaction.
- Run final cleanup:
  - anti-slop pass on changed UI/backend/test files;
  - independent code review;
  - architecture invariant audit;
  - final verification commands.

**Acceptance:**

- Docs match actual commands and tested behavior.
- Final Ultragoal quality gate includes verification command output, screenshots/artifacts, ai-slop-cleaner result, code-reviewer approval, architect invariant clearance.

## 5. Route-by-route production checklist

This checklist is the detailed UI gap map and should be converted into tests/fixtures by G001/G019.

### `/` Assistant

- Mock target: assistant conversation rail/thread/composer/route sheet/tool-call cards.
- Current gap: primary page can read as backend/capability report/debug cockpit instead of chat.
- Must include: recent chats, new chat, prompt composer, send/stop/retry, message bubbles, route/model selector, route/privacy sheet, tool approvals, voice button state, attachment/context button.
- Backend: Orchestrator external input, event stream if available, cancellation, TTS/transcription routes when present.
- Desktop: local sidecar status visible but secondary.
- Web: no Tauri native voice claims; browser mic only.
- Mobile: touch composer, bottom tabs, native mic permission state.

### `/memory`

- Mock target: Memory & Knowledge cards plus conversation history.
- Must include: search, namespaces, history list, provenance, retention state, delete/export gates.
- Backend: DB messages/RAG search, namespace management if available.
- Empty state: no memory yet with explanation of when Aurora stores memory.

### `/memory/policy`

- Mock target: settings privacy controls adapted to data policy.
- Must include: retention, raw audio/transcript toggles, namespace visibility, remote/mesh fallback, export/delete/import, audit link.
- Backend: Config/AdminAction, DB management if available.
- Must not duplicate `/memory` browse UI.

### `/tools`

- Mock target: tools/automations registry and scheduler snapshot.
- Must include: search/filter/category, tool details, schema form, dry-run/execute, approval, result/audit, MCP status.
- Backend: Tooling catalog/execution/approval, Scheduler list.

### `/mesh`

- Mock target: Mesh & Peers topology/trust queue/peer table.
- Must include: local node, topology cards, pending pairings, pair peer, route preview, peer actions, WebRTC diagnostics.
- Backend: Gateway mesh status/diagnostics, Auth pairings/devices.

### `/admin`

- Mock target: Admin overview deployment posture.
- Must include: health totals, deployment mode, capability gaps, recent audit/admin activity, shortcuts.
- Backend: Gateway capability catalog/services, Auth audit.

### `/admin/services`

- Mock target: services table/detail.
- Must include: status/heartbeat/instance/capabilities/routes/errors, logs/detail drawer, restart/reload if real.
- Backend: Gateway services, Supervisor status if exposed.

### `/admin/access`

- Mock target: RBAC tabs.
- Must include: roles, principals, permission matrix, assignment preview, AdminAction.
- Backend gap: implement or honestly derive `Auth.ListRoles`.

### `/admin/tokens`

- Mock target: token stats/list/create.
- Must include: create wizard, scopes, expiration, one-time reveal, revoke/rotate, audit.
- Backend: Auth token APIs.

### `/admin/devices`

- Mock target: devices and pending pairings.
- Must include: trusted devices, platform security status, pending approvals, revoke/trust.
- Backend: Auth devices/pairings, mesh peer linkage.

### `/admin/config`

- Mock target: config accordion and staged diff.
- Must include: schema fields, validation, redaction, restart impact, apply/discard/review.
- Backend: Config get/set/validate/AdminAction.

### `/admin/contracts`

- Must include: registry browser, method schema, exposure, permissions, generated route, OpenAPI/export, conformance status.
- Backend: Gateway registry/routes/capability catalog.

### `/admin/plugins`

- Must include: MCP/plugin catalog, status, provider, enabled/disabled, reload if real, errors/logs.
- Backend: Tooling catalog/MCP status.

### `/admin/pairing`

- Must include: pending pairings, create pairing code/QR/deep link, approve/deny, expiry, audit.
- Backend: Auth pairing APIs.

### `/admin/backups`

- Must include: backups list, create, verify, restore dry-run, restore confirmation, encryption/manifest.
- Backend gap: Backup service contract must be real or route must explain missing service with repair task.

### `/admin/scheduler`

- Must include: jobs, recurrence, status, next run, run history, create/edit/pause/resume/cancel.
- Backend: Scheduler list/schedule/cancel plus additional management where available.

### `/admin/audit`

- Mock target: audit search/table.
- Must include: filters, details drawer, actor/action/resource/time, correlation ID, redacted export.
- Backend: Auth audit log.

### `/models`

- Mock target: Models & Runtime provider cards/table.
- Must include: selectable providers, installed/downloadable/importable/benchmarkable states, selected/configured distinction, route policy, repair CTAs.
- Backend: Orchestrator model catalog, Config, native local-light manifest.

### `/diagnostics`

- Mock target: diagnostics live probes/redaction/export.
- Must include: probes, traces/logs, event stream, route registry, native/sidecar, support bundle.
- Backend: Gateway health/registry/diagnostics, Tauri native commands.

### `/onboarding`

- Mock target: onboarding mode cards/guided setup.
- Must include: server web, desktop local, desktop thin, mesh shell, Android, iOS, optional demo; endpoint/auth/pairing/sidecar checks.
- Backend/native: Auth login/pairing, secure storage/native status.

### `/settings`

- Mock target: settings permissions privacy/voice tabs.
- Must include: route defaults, voice behavior, assistant defaults, accessibility/theme, staged changes.
- Backend: Config get/set/validate/AdminAction.

### `/settings/native`

- Must include: native manifest, desktop permissions, Android/iOS capability states, request buttons only when supported.
- Backend/native: Tauri commands, Android/iOS preflight manifests.

## 6. Verification command suite

Final execution should report exact commands run. Minimum expected suite:

```sh
# Python/backend targeted checks
uv run ruff check app packages scripts tests
uv run pytest tests/unit/gateway tests/unit/auth tests/unit/config -q
uv run pytest tests/integration -q

# Frontend/SDK
pnpm --filter @aurora/client build
pnpm --filter @aurora/client test
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/ui test
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui test

# Route/UI E2E
pnpm --filter @aurora/tauri-ui test:e2e:routes
pnpm --filter @aurora/tauri-ui test:e2e:assistant
pnpm --filter @aurora/tauri-ui test:e2e:admin
pnpm --filter @aurora/tauri-ui test:e2e:runtime

# Tauri/native
cargo check --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml
pnpm --filter @aurora/tauri-ui tauri:smoke:linux
pnpm --filter @aurora/tauri-ui android:preflight
pnpm --filter @aurora/tauri-ui ios:preflight

# Existing consolidated CI entrypoints, if present
make lint
make unit
make integration
```

If commands differ by final implementation, update docs and CI to the tested commands.

## 7. Stop condition

Do not mark the Ultragoal complete until all are true:

- All 22 routes render production route-specific UI.
- No production route renders placeholder text, raw route dump, generic backend-state dashboard, or fixture-only product data without explicit demo label.
- `tauri dev` starts and stops the local desktop stack with visible Python/Rust/Vite logs.
- Desktop local, web thin, Android preflight, and iOS preflight have platform evidence.
- Assistant, admin, mesh, memory, tools, models, settings/native, diagnostics, and onboarding have E2E coverage.
- Admin/security/privacy invariants are independently reviewed.
- Docs describe actual commands and platform limits.
- Final quality gate contains verification evidence, screenshots/logs, ai-slop-cleaner/no-op evidence, code-reviewer approval, architect clearance.

## 8. Paste-ready OMX launch prompt

Use this after `/goal clear` or in a fresh Codex goal context:

```text
$ultragoal
Create and execute a single-shot, team-parallel production UI completion plan for Aurora using `.omx/plans/TAURI_UI_PRODUCTION_SINGLE_SHOT_ULTRAGOAL_PLAN.md` as the controlling brief.

Critical constraints:
- Use `modules/ui-mock-reference` as the UX source of truth. Adapt to real Aurora contracts only where the mock conflicts with actual backend/platform truth.
- Run with `$team` for parallel implementation, max six lanes: Shell/design/route mounting; SDK+sidecar+Gateway contracts; Assistant+voice+tools+memory; Mesh+models+onboarding+settings/native; Admin suite; E2E/CI/docs/verification.
- Make `pnpm --filter @aurora/tauri-ui tauri dev` the one-command local desktop development experience: Vite + Tauri/Rust + Python Aurora services in threads mode + Gateway readiness + unified logs + clean shutdown. No manual sidecar build/env ritual for dev.
- Remove all final-route use of `TauriRoutePlaceholder`. Every one of the 22 nav routes must render route-specific production UI with loading/empty/error/offline/permission states.
- Rebuild the Assistant page as actual chat UX: conversation rail, messages, composer, route/privacy sheet, tool-call cards, voice/tts/transcription states, send/stream/fallback/cancel/retry/no-model handling.
- Fix route policy semantics so local selector/privacy preference is not counted as a hard blocker, while consent, privacy indicator, native permission, and AdminAction remain distinct and enforced.
- Complete every route from the plan: memory, data policy, tools, mesh, admin overview, services, access/RBAC, tokens, devices, config, contracts, plugins, pairing, backups, scheduler, audit, models, diagnostics, onboarding, settings, native.
- Implement honest platform behavior for desktop local, desktop thin, web, Android, iOS, and optional offline demo. Do not claim unsupported native capabilities.
- Add gates that would have failed the previously broken UI: all-route Playwright crawl, no placeholder text, route-specific landmarks, no broad false privacy blocking, assistant/admin/runtime E2E, Tauri sidecar dev smoke, desktop native evidence, Android/iOS preflights, screenshots/log artifacts.
- Preserve Aurora architecture: UI through SDK/Gateway/Tauri boundary only; Python services communicate through bus/contracts; admin mutations through AdminAction; no secrets in logs/support bundles.

Execution protocol:
1. Read the plan file and create durable Ultragoal stories from its G001-G020 goals.
2. Launch Team execution with the six lanes above and explicit file ownership to avoid conflicts.
3. Write failing tests/gates before or alongside each implementation lane.
4. Checkpoint each Ultragoal story only from leader-owned evidence with fresh `get_goal` snapshots.
5. On the final story, run verification, ai-slop-cleaner on changed files, independent code-reviewer and architect reviews, and an architecture-invariant audit before marking complete.

Definition of done:
- All 22 routes are production-ready and integrated E2E.
- `tauri dev` locally runs the real stack cleanly.
- Desktop/web/mobile platform behavior is truthful and tested.
- CI gates are useful and non-duplicative.
- Docs explain the actual dev/build/test process.
```
