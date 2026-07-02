# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-07-02
- Primary product surfaces: Tauri desktop local/thin shell, web Gateway thin shell, Android/iOS Tauri mobile thin shells, shared React cockpit in `packages/aurora-ui`.
- Evidence reviewed:
  - `modules/ui-mock-reference/components/aurora/app-shell.tsx`
  - `modules/ui-mock-reference/components/aurora/assistant/assistant-view.tsx`
  - `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx`
  - `modules/ui-mock-reference/components/aurora/assistant/tool-call-card.tsx`
  - `modules/ui-mock-reference/components/aurora/mesh/mesh-view.tsx`
  - `modules/ui-mock-reference/components/aurora/models/models-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/overview.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/services-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/rbac-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/tokens-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/devices-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/config-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/audit-view.tsx`
  - `modules/ui-mock-reference/components/aurora/admin/secondary-surface.tsx`
  - `modules/ui-mock-reference/app/(cockpit)/memory/page.tsx`
  - `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx`
  - `modules/ui-mock-reference/components/aurora/diagnostics/diagnostics-view.tsx`
  - `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx`
  - `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx`
  - `packages/aurora-ui/src/nav.tsx`
  - `packages/aurora-ui/src/production-surface-contracts.ts`
  - `packages/aurora-ui/src/styles.css`
  - `apps/aurora-tauri/src/tauri-app.tsx`
  - `apps/aurora-tauri/README.md`
  - `docs/FRONTEND_AND_UI_ARCHITECTURE.md`
  - `docs/PRODUCTION_UI_CONTRACTS.md`
  - `docs/TAURI_DEV_AND_UI_GAP_REPORT.md`
- Evidence boundaries:
  - Observed: the current nav contract defines 22 production routes; production screens must consume `AuroraClient`/SDK state; mocks are the UX target but not production data truth; Tauri local dev is expected to run via `pnpm --filter @aurora/tauri-ui tauri dev`.
  - Inferred: visual tone and layout principles below are derived from the mock cockpit and existing shared UI components, not from a separate brand system or Figma file.

## Brand
- Personality: calm operator cockpit, privacy-first assistant, technical but approachable, explicit about capability limits.
- Trust signals: route/privacy chips, backend evidence labels, native capability status, redaction badges, AdminAction previews, disabled controls with reason text, audit/support-bundle language.
- Avoid: generic SaaS dashboards, fake live metrics, unlabelled fixture/demo data, claims that mobile shells replace system assistants, raw debug dumps as product UI, success states before backend confirmation.

## Product goals
- Goals:
  - Ship a production-ready assistant/operator cockpit across desktop, web, and mobile thin contexts.
  - Preserve the mock UX as the visual and interaction target while binding every screen to SDK, Gateway, Tauri/native, and bus/service contract evidence.
  - Make route availability, privacy, permission, AdminAction, platform capability, and degraded/offline states visible without blocking unrelated routes.
  - Make desktop local development truthful and repeatable with one command: `pnpm --filter @aurora/tauri-ui tauri dev`.
- Non-goals:
  - Do not create a second design system outside `packages/aurora-ui` and the existing mock-derived component language.
  - Do not make React screens call Python services, raw Gateway `fetch`, Tauri `invoke`, WebRTC internals, or PyQt bridge objects directly.
  - Do not present mock fixtures as live Aurora state or unsupported native/mobile capabilities as available.
- Success signals:
  - All 22 nav routes render route-specific production UI with no `TauriRoutePlaceholder` or debug-dashboard fallback.
  - Assistant, admin, mesh, memory, tools, models, settings/native, diagnostics, onboarding, and runtime flows have route-specific tests/E2E gates.
  - Desktop/web/mobile behavior differs only where platform evidence requires it and is labelled when degraded or unsupported.

## Personas and jobs
- Primary personas:
  - Local desktop assistant user: wants a chat-first local assistant with clear route/privacy choices, tool approvals, voice states, and safe local-stack control.
  - Remote web operator: connects to an existing Gateway, observes services and policies, and sees desktop-only actions as unavailable instead of broken.
  - Mesh/admin operator: manages peer trust, pairing, RBAC, tokens, services, config, backups, scheduler, audit, and diagnostics with confirmation/audit trails.
  - Mobile thin user: uses Android/iOS as an Aurora shell with honest permission, secure storage, pairing, assistant-role/shortcut, and background-limit evidence.
- User jobs:
  - Ask the assistant, choose/fallback routes, review tool calls, cancel/retry/no-model flows, and understand privacy impact before sending.
  - Inspect memory/RAG provenance, data policy, tool catalogs, mesh peers, model providers, runtime health, and support diagnostics.
  - Perform admin/security operations only after AdminAction draft/confirm/audit evidence.
  - Set up Aurora through desktop local, server web, mesh shell, mobile thin, or clearly labelled offline demo paths.
- Key contexts of use: local desktop development, operator troubleshooting, remote Gateway monitoring, mobile companion usage, privacy-sensitive/admin-critical maintenance.

## Information architecture
- Primary navigation:
  - Assistant section: `/`, `/memory`, `/tools`, `/mesh`.
  - Operate section: `/admin`, `/admin/services`, `/admin/access`, `/admin/tokens`, `/admin/devices`, `/admin/config`, `/admin/contracts`, `/admin/plugins`, `/admin/pairing`, `/admin/backups`, `/admin/scheduler`, `/admin/audit`.
  - Runtime section: `/models`, `/diagnostics`, `/onboarding`, `/settings`, `/memory/policy`, `/settings/native`.
- Core routes/screens:

| Route | Screen role | Required mock anchor | Production truth source |
| --- | --- | --- | --- |
| `/` | Assistant chat, route preview, tool/voice context | conversation rail, composer, route sheet, tool-call cards | `Orchestrator.ExternalUserInput`, `Orchestrator.Interrupt`, event stream, route explain, voice/native capability evidence |
| `/memory` | RAG namespaces, history, provenance | memory page | DB RAG namespace/search/provenance SDK methods |
| `/tools` | Tool catalog, approval cards, automation context | tools page, `ToolCallCard` | `Tooling.GetToolCatalog`, approval/AdminAction methods |
| `/mesh` | Peer trust, sessions, route quality | `mesh-view.tsx` | `Gateway.GetMeshStatus`, Auth peers/pairing, WebRTC diagnostics |
| `/admin` | Admin overview and topology | `admin/overview.tsx` | Gateway capability catalog, registry, deployment topology |
| `/admin/services` | Service registry and lifecycle affordances | `admin/services-view.tsx` | `Gateway.GetServices`, `Gateway.GetRegistry`, AdminAction descriptors |
| `/admin/access` | RBAC/principals/permissions | `admin/rbac-view.tsx` | Auth principals/roles/permissions/audit |
| `/admin/tokens` | Scoped token inventory/revocation posture | `admin/tokens-view.tsx` | Auth token methods, audit, redaction metadata |
| `/admin/devices` | Trusted devices/sessions | `admin/devices-view.tsx` | Auth devices/sessions, native capability manifest |
| `/admin/config` | Schema-aware config review/apply/rollback | `admin/config-view.tsx` | Config schema/diff/history/reload-impact SDK methods |
| `/admin/contracts` | Contract registry browser | services/contracts mock rows | Gateway registry and service descriptors |
| `/admin/plugins` | Plugins, MCP, tool exposure | `admin/secondary-surface.tsx` plugins | Tooling catalog, plugin/config/AdminAction evidence |
| `/admin/pairing` | Pairing queue and approval | `admin/secondary-surface.tsx` pairing | Auth pending pairing and approve/deny methods |
| `/admin/backups` | Backup manifests/verify/restore | `admin/secondary-surface.tsx` backups | Backup list/create/verify/restore/rollback methods |
| `/admin/scheduler` | Scheduled jobs and automations | tools/scheduler mock rows | Scheduler list/schedule/cancel/pause/resume methods |
| `/admin/audit` | Redacted audit search | `admin/audit-view.tsx` | Auth audit log and redaction support |
| `/models` | Runtime providers and model policy | `models-view.tsx` | Orchestrator model catalog/runtime, capability/native evidence |
| `/diagnostics` | Support probes, route matrix, redacted bundles | `diagnostics-view.tsx` | Gateway capability graph, Tauri/native probes, support-bundle contract |
| `/onboarding` | Deployment mode, auth, pairing setup | `onboarding-view.tsx` | Auth session/login/pairing, route graph, demo-mode flag |
| `/settings` | Privacy defaults, route policy, permissions | `settings-permissions-view.tsx` | Config, Auth identity, route graph, native manifest |
| `/memory/policy` | Data policy and memory governance | memory/policy rows | DB RAG and data-sharing policy/capability graph |
| `/settings/native` | Platform-native capability truth | settings/native rows | Tauri native manifest and OS permission commands |

- Content hierarchy: shell status and mode evidence first, route-specific landmark/header second, primary work area third, supporting policy/evidence/diagnostics panels fourth, destructive/admin controls behind confirmation dialogs.

## Design principles
- Principle 1: Evidence over assertion. A screen may show a capability only when SDK/Gateway/Tauri/native evidence supports it; otherwise render a clear unsupported/degraded/permission state.
- Principle 2: Route-specific before global. Diagnostics and backend state explain problems, but every nav route must have a product-specific screen and landmark.
- Principle 3: Privacy and admin safety are distinct. Selector preference, consent, privacy indicator, native permission, and AdminAction states must not collapse into one broad blocker.
- Principle 4: Mock fidelity with production truth. Preserve the mock cockpit composition and interaction intent, but adapt labels/actions when real contracts disagree.
- Principle 5: Mobile/web honesty. Thin clients are first-class shells, not implied local-service hosts.
- Tradeoffs: Prefer disabled controls with exact repair/evidence reasons over optimistic actions; prefer concise route-specific summaries over raw registry dumps; prefer existing components/tokens over new abstractions.

## Visual language
- Color: dark cockpit baseline with muted surfaces, subtle borders, semantic accent colors for health/route/privacy/AdminAction states, and high-contrast destructive/credential warnings.
- Typography: compact operator-readable hierarchy; route headers and card titles should be scannable; IDs/methods use monospace only where they are operational evidence.
- Spacing/layout rhythm: dashboard density with card grids, tables, split panels, and sticky shell navigation; use whitespace to separate primary action areas from evidence panels.
- Shape/radius/elevation: rounded cards and badges, light elevation/glass only for shell surfaces; avoid heavy skeuomorphic panels.
- Motion: restrained transitions for route changes, sheets, pending AdminAction, streaming assistant messages, and status updates; respect reduced motion.
- Imagery/iconography: lucide-style line icons from existing nav/components; no decorative imagery that could obscure operational state.

## Components
- Existing components to reuse:
  - Shell/navigation: `packages/aurora-ui/src/shell.tsx`, `nav.tsx`, `status-badges.tsx`, `styles.css`.
  - State/evidence surfaces: `state-surface.tsx`, `production-surface-contracts.ts`, route-specific resource components.
  - Assistant: `assistant-view.tsx`, `route-sheet.tsx`, `tool-approval-panel.tsx`.
  - Admin/runtime: admin view files, `memory-view.tsx`, `mesh-*`, `models-view.tsx`, `onboarding-view.tsx`, `settings-permissions-view.tsx`.
- New/changed components: add only route-owned components when existing primitives cannot express a required route landmark/state; do not add a parallel UI kit.
- Variants and states: every route must support loading, empty, error, offline/degraded, permission/native-permission, privacy, unsupported, and AdminAction states where applicable.
- Token/component ownership: shared tokens/styles live in `packages/aurora-ui/src/styles.css`; production contracts live in `packages/aurora-ui/src/production-surface-contracts.ts`; Tauri route mounting lives in `apps/aurora-tauri/src/tauri-app.tsx`.

## Accessibility
- Target standard: WCAG 2.1 AA intent for production screens and route gates; keep `pnpm --filter @aurora/ui test:accessibility` as the baseline package check.
- Keyboard/focus behavior: shell nav, mobile menu, route sheets, dialogs, composer, tables, AdminAction confirms, and disabled controls must be keyboard reachable or correctly inert.
- Contrast/readability: privacy/admin/destructive labels must remain readable in dark mode; badge color cannot be the only signal.
- Screen-reader semantics: one route-specific landmark/header per route; tables need headers; status badges need text; loading/errors need live-region-friendly copy when dynamic.
- Reduced motion and sensory considerations: streaming/voice/native status changes should avoid flashing and respect reduced-motion preferences.

## Responsive behavior
- Supported breakpoints/devices:
  - Desktop Tauri local and desktop Tauri thin.
  - Web browser thin client.
  - Android Tauri/mobile thin shell.
  - iOS Tauri/mobile thin shell.
  - Optional offline demo mode, always labelled as fixture/demo.
- Layout adaptations: desktop uses grouped sidebar and multi-column cockpit cards/tables; tablet collapses dense details into panels; mobile uses bottom primary tabs plus sheet navigation and one-column cards.
- Touch/hover differences: hover-only affordances must have touch-visible equivalents; destructive/admin actions need explicit tap confirmation; mobile native permissions must come from platform manifest evidence.

## Interaction states
- Loading: show route-specific skeleton/copy and what backend/native evidence is being requested.
- Empty: explain the zero state and next valid action without using fixture data as truth.
- Error: show SDK/backend/native error summaries with retry/repair when safe; do not expose secrets/tokens/raw audio.
- Success: require refreshed backend confirmation for mutations; optimistic UI must label pending/rollback states.
- Disabled: include exact unavailable reason: missing capability, unsupported platform, denied permission, privacy policy, internal-only method, or missing AdminAction.
- Offline/slow network: show degraded route state, cached/read-only limitations, and reconnection/retry affordance. Offline demo data must be labelled fixture/demo only.
- Permission/AdminAction: native OS permission, privacy consent, and AdminAction confirm/audit flows are separate UI states and should not be conflated.

## Content voice
- Tone: precise, calm, operator-focused, privacy-forward, never salesy.
- Terminology: use Aurora contract names when they are evidence (`Gateway.GetRegistry`, `Auth.AuditLog`, `Native.GetCapabilityManifest`), but pair them with human-readable labels.
- Microcopy rules:
  - Use “unsupported”, “degraded”, “permission required”, “AdminAction required”, or “fixture/demo” explicitly.
  - Never say “connected”, “saved”, “revoked”, “running”, “voice enabled”, or “securely stored” until the corresponding backend/native evidence exists.
  - Redaction copy must state that secrets, tokens, and raw audio are excluded.

## Implementation constraints
- Framework/styling system: React/TypeScript shared UI in `packages/aurora-ui`, hosted by Tauri/web shells; use existing CSS variables/classes and component idioms.
- Design-token constraints: extend `styles.css` only when a repeated production state needs a shared token; otherwise use existing badges/cards/tables.
- Performance constraints: route screens should render from normalized SDK state without blocking the event loop or polling raw services; long-running operations need pending/cancel/retry states.
- Compatibility constraints:
  - UI talks through `AuroraClient`, SDK transports, Gateway/Tauri boundaries only.
  - Tauri local sidecar supervision is shell/runtime infrastructure, not screen logic.
  - Python services continue to communicate via bus/contracts.
  - Admin mutations use AdminAction draft/confirm/audit; no fake success.
  - No secrets, tokens, raw audio, local private paths, or unredacted payloads in logs/support bundles.
- Test/screenshot expectations:
  - Route crawl fails placeholders/debug-dashboard UI.
  - Route-specific landmarks/controls are asserted for all 22 routes.
  - Assistant/admin/runtime/outcome/native-evidence gates cover production behavior.
  - Docs and package READMEs describe the actual commands and platform limits.

## Route production inventory and regression gates
- Route inventory is authoritative from `packages/aurora-ui/src/nav.tsx`: `/`, `/memory`, `/tools`, `/mesh`, `/admin`, `/admin/services`, `/admin/access`, `/admin/tokens`, `/admin/devices`, `/admin/config`, `/admin/contracts`, `/admin/plugins`, `/admin/pairing`, `/admin/backups`, `/admin/scheduler`, `/admin/audit`, `/models`, `/diagnostics`, `/onboarding`, `/settings`, `/memory/policy`, `/settings/native`.
- Tauri route registry must contain every primary nav item ID and no primary route may render the legacy `TauriRoutePlaceholder` copy: `This Tauri route is now navigable` or `A full product page still needs to be mounted`.
- Each primary route must expose at least one route-specific landmark/control listed in the Information Architecture table.
- Route policy gates must distinguish selector preference, consent, privacy indicator, native permission, and AdminAction.
- Tests and docs must not claim desktop-local/mobile support unless native/Tauri evidence is collected or an explicit unsupported/degraded state is rendered.

## Open questions
- [ ] Is there a separate Aurora brand/marketing design source outside this repository? Owner: product/design. Impact: may refine visual tone, typography, and iconography but must not override safety/evidence rules.
- [ ] Which route-specific screenshots are the final visual regression baseline for release? Owner: UI/QA. Impact: current contract defines landmarks/states; visual baseline selection controls screenshot artifact expectations.
- [ ] Which mobile capabilities are release-blocking versus intentionally unsupported for first mobile thin release? Owner: platform/product. Impact: affects Android/iOS preflight wording and disabled-state priority, not the requirement for truthful native evidence.
