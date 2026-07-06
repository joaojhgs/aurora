# Aurora UI Visual Refinement & Interactivity Plan

**Author:** Planning agent (big-brain pass)
**Date:** 2026-07-03
**Status:** Pending approval — controlling instruction set for the frontend-specialist agent
**Reads with:** [`docs/TAURI_UI_VISUAL_REFINEMENT_HANDOFF.md`](TAURI_UI_VISUAL_REFINEMENT_HANDOFF.md) (source-of-truth constraints, route inventory, reproduction/verification commands)

---

## 0. How to use this document

You (the frontend agent) are rebuilding the *look, density, and interactivity* of every Aurora production route so the whole app matches the quality of the Assistant page and the `modules/ui-mock-reference` cockpit — while preserving real Aurora SDK/Gateway/platform truth.

- **Design source of truth:** `modules/ui-mock-reference` (Next.js + shadcn/ui + Tailwind). Live at `http://127.0.0.1:3333`.
- **Target codebase:** `packages/aurora-ui/src/*` (custom `aui-*` components + `styles.css`), rendered by `apps/aurora-tauri`. Live at `http://127.0.0.1:1420`.
- **Evidence:** `.omx/artifacts/visual-ralph/all-pages-final/` — `desktop-mock-*`, `desktop-prod-*`, `mobile-*` pairs, and four contact sheets. A second, plan-verification capture pass lives in `.omx/artifacts/ui-plan-verify/` — fresh full-page `1440x1024` `prod-*.png` for all 13 previously-uninspected routes (admin, admin-access, admin-tokens, admin-devices, admin-contracts, admin-plugins, admin-pairing, admin-scheduler, diagnostics, onboarding, settings, settings-native, assistant) plus a live degraded-state capture. Re-capture after each page (commands in the handoff).
- **Workflow:** Do **Phase 1 (foundation primitives)** first, then work route-by-route in the **Section 8 execution order**. Screenshot mock + prod at `1440x1024` and `390x844` before and after each route. Run the tests in Section 9 continuously.

> **Verification status (2026-07-03 update):** Every one of the 22 routes has now been inspected at full resolution, and interactivity was probed live in a browser against the running app at `http://127.0.0.1:1420`. All Section 6 entries are marked ✅ and carry a **Live interactivity** note describing what is actually wired vs honestly capability-gated. See Section 2 for the two environment-level findings this pass surfaced (global capability-gating behavior and the absent detail-drawer pattern).

This plan is intentionally prescriptive. Where a prescription conflicts with a real backend/capability constraint, **truthfulness wins** — keep the honest state and make it *look* intentional, do not fake data.

---

## 1. Design read (locked)

Reading this as: **a privacy-first technical operator cockpit + assistant console** for local-AI infrastructure users. It must feel like the mock: dark base, teal accent, compact shadcn-adjacent cards, dense tables, left nav + right activity rail, mobile bottom-nav. It must **not** feel like a generic SaaS dashboard, a debug panel, or a documentation page.

Dials (unchanged from handoff):

- `DESIGN_VARIANCE: 5` — disciplined, not experimental.
- `MOTION_INTENSITY: 2` — mostly static; subtle state feedback only (hover, focus, pending spinners, toast).
- `VISUAL_DENSITY: 9` — dense cockpit; compact rows, tight cards, minimal wasted whitespace.

> **Scope note:** This is dense product/admin UI, not a marketing page. The relevant taste rules that still apply hard: **zero em-dashes** anywhere visible, **eyebrow-label restraint**, **one accent / one radius / one theme** consistency locks, **WCAG-AA contrast on every control**, **no walls of paragraph text**, **motion must be motivated**, and **real-not-fake data** (demo data must stay explicitly labeled). Marketing-only taste rules (heroes, logo walls, serif discipline) do not apply.

### Hard constraints (do not regress)

- Preserve the dark radial base, teal accent, left nav, right activity rail, mobile bottom-nav.
- No task/provenance/debug/evidence language in visible UI. Keep the handoff's wording table (Section 7 of the handoff).
- Never claim unsupported native capability. Keep demo/fixture data labeled "Demo".
- Route state comes from the Aurora SDK/Gateway — do not swap real state for prettier fake data.
- Every page stays route-specific and production-facing.

---

## 2. Root-cause diagnosis — *why the current UI reads as "trash"*

The Assistant page is good because it was purpose-built. Every other page is worse because it hand-rolls bespoke markup + bespoke CSS instead of composing a shared primitive set the way the mock composes shadcn. The screenshots expose **ten recurring systemic anti-patterns**. Fixing them at the primitive level (Phase 1) fixes 70% of the ugliness across all 22 routes at once.

| # | Anti-pattern | Evidence | Mock does instead |
|---|---|---|---|
| A1 | **Eyebrow-label spam.** Nearly every card/section carries an uppercase `aui-kicker`/`text-transform:uppercase` micro-label (`SELECTED TOOL`, `SCHEMA FIELDS`, `RAW AUDIO STORAGE`, `CURRENTLY SELECTED PROVIDER`, `REGISTRY`, `COLLECTIONS`…). `uppercase`/kicker appears in *every* view. | Tools, Models, Config, Data Policy, Services, Memory, Audit | A plain `CardTitle` in sentence case; no eyebrow. |
| A2 | **Raw `<dl>` fact-dumps.** Label/value pairs rendered as unstyled definition lists that read like debug output. | Backups "Availability", CapabilityDrawer, ImpactPlan, most admin views | Compact 2-col `Meta` rows inside a Card, or a real table. |
| A3 | **Run-on inline meta text.** Header stats concatenated into a paragraph with no separators (`Namespaces 5 main.memories Records 612 namespace(s) did not report counts Retention…`). | Memory header, Backups availability | A metric strip of small stat cards. |
| A4 | **Walls of ALL-CAPS heading + gray paragraph.** Pages read like documentation. | Data Policy right column, Native Settings, Backups, Diagnostics | 1-2 line helper text max; details behind a drawer/tooltip. |
| A5 | **Always-expanded metadata grids.** 8-12 tiny label/value tiles shown at once for a single selected item. | Tools (PROVIDER/PEER/TRUST TIER/TRANSPORT/DATA EGRESS/MUTATION/ARGS HASH/TTL/AUDIT/CORRELATION), Models "runtime categories" | Summary row → detail in a `Sheet` drawer on click. |
| A6 | **Broken form spacing / overlap.** Labels, textareas, checkboxes, and submit buttons collide with each other and with tooltips. | Backups "Create backup" (labels overlap tooltip; checkboxes jammed), Models reauth checkbox floating under header | Vertical form field stack with consistent gaps, fieldset grouping. |
| A7 | **Inline AdminAction confirm.** Destructive/admin mutations gated by an inline "I confirm reauthentication" checkbox + inline button, scattered per page. | Backups, Models, Config | A single reusable `AdminConfirmDialog` modal (reason + typed-phrase + affected resources + audit receipt). |
| A8 | **Oversized / inconsistent buttons.** Primary buttons are huge full-width teal slabs in some places, tiny elsewhere. | Memory Search/Refresh (giant), Config/Backups (inline) | One `Button` scale with `default`/`outline`/`ghost`/`icon` variants. |
| A9 | **Cramped tables that truncate.** Tables squeezed by the activity rail wrap mid-word or clip headers (`HEAF` for Heartbeat, `2026 19T0`). | Services, Data Policy retention table | `Card p-0` + horizontal scroll + responsive column hiding (`hidden md:table-cell`). |
| A10 | **Filter/field overload.** 17 filter inputs shown at once in a 3-col grid. | Audit | Compact filter bar (search + 2-3 key selects) with "More filters" disclosure. |

Additional shell/interactivity findings:

- Right **Activity rail** shows demo events; fine in demo mode, but it must stay honest in real transports (already branches on `transportKind`). Keep.
- Many primary actions are **permanently disabled** by real backend gating (full restore, reload catalog, config editor). That is correct — but they currently look like *bugs* because the disabled state is not visually explained. Give disabled actions a clear inline reason + consistent disabled styling (Section 4, rule G7).

**Two environment-level findings from the live interactivity pass (2026-07-03) — read these before touching any page:**

- **F1 — Everything is capability-gated on the route/registry catalog, and the gating cascades hard.** When the running app cannot load the capability catalog (observed live: the left status rail stuck at `Routes ready 0/0 routes available`, `runtime mode pending`, `peer identity pending`), *entire pages collapse to disabled/empty*. Concrete proof: on `/admin/scheduler` with `0/0` routes, **every** create-form control reports `[disabled, readonly]` (Job name, Schedule, Action select, Target peer, AdminAction reason, the confirm checkbox, and the "Create via AdminAction" button), and the jobs region renders "No scheduler jobs available." The same page with a populated catalog shows real values and an enabled teal Create button. **Implication:** the disabled controls are *not broken wiring* — they are wired to real SDK/AdminAction calls and honestly disabled. The frontend agent must NOT "wire them up" (they are wired); it must (a) make the gated state look intentional per G7, and (b) make the loading/empty/degraded states first-class per G8, because this app spends real time in the `0/0`/pending state while the local Gateway warms up. Do not fake capability to make a page look "done."
- **F2 — The detail-on-demand drawer pattern is absent from every admin/data view.** Source audit: `Sheet`/`Drawer`/`setDetail`/`onRowClick` appear only in the Assistant surface (`route-sheet.tsx`, `assistant-view.tsx`) and `state-surface.tsx`'s `CapabilityDrawer`; the admin/data views (services, tokens, devices, RBAC, contracts, scheduler, audit, backups, mesh, models, plugins, memory) have **zero** row-click drawer usage. That is exactly why they dump all metadata inline (A2/A5). G5 is therefore a net-new capability for these pages, not a tweak — budget for building `DetailSheet` and rewiring every table row onto it.
- **F3 — Bare degraded/empty states are pervasive and ugly.** Observed live, not inferred: Contracts renders "No method descriptors were returned by Gateway.GetRegistry." as a bare heading; Plugins shows an all-zero StatStrip + empty inventory table; Admin Overview and every page keep the `0/0 routes` status rail. These are legitimate states that currently look like the app is broken. They must become composed `EmptyState`/skeleton/`RouteStateNotice` surfaces (G8).

---

## 3. Design tokens & consistency locks (apply globally)

Audit `packages/aurora-ui/src/styles.css` (3032 lines, incl. a bottom "Visual Ralph override pass") against these locks and consolidate. Prefer editing shared tokens/selectors over per-route CSS.

- **Accent lock:** one teal accent used identically everywhere (buttons, active nav, focus rings, key metrics). No stray blue links mixed with teal. Reuse the existing teal from the mock (`--primary`).
- **Radius lock:** one radius scale. Suggest cards/panels `10px`, inputs/buttons `8px`, pills/badges full. No mixed sharp/rounded within a page.
- **Theme lock:** dark only for the whole app (already true). No section inverts to a lighter panel.
- **Surface scale:** define 3 surface levels (page `--bg`, card `--surface`, elevated/hover `--surface-2`) and use them consistently instead of ad-hoc `rgba` fills.
- **Spacing scale:** 4px base. Page content padding `p-6` desktop / `p-4` mobile; section gap `24px`; card padding `16px`; form field gap `12px`; inline row gap `8px`. Kill arbitrary one-off margins.
- **Type scale:** page title `~22px/600`; card title `15px/600`; body `13px`; meta/label `11-12px` muted; mono for IDs/hashes/timestamps only. Never uppercase body text.
- **Contrast:** every label, placeholder, badge, disabled control must pass WCAG AA on its surface. Muted text no lighter than `#8a95a1`-equivalent on the card surface.
- **Em-dash ban:** remove every `—`/`–` from visible strings (headings, helper text, badges, tooltips). Use `-`, commas, or separate sentences. Grep the `aurora-ui` strings before finishing.

---

## 4. Global rules the agent must apply to EVERY route

These are non-negotiable and are the acceptance bar for each page. Most are enforced by adopting the Phase 1 primitives.

- **G1 — Eyebrow budget.** Max **one** uppercase eyebrow per page (the page kicker in `PageHeader`, e.g. `ADMIN`). Delete every per-card/per-section uppercase micro-label; replace with a sentence-case card title or nothing.
- **G2 — No raw `<dl>` dumps.** Replace every debug-style definition list with either a compact `<Meta>` grid inside a card or a real table. Facts that are truly incidental move into the detail `Sheet` or a tooltip.
- **G3 — No run-on meta text.** Header/summary numbers become a `StatStrip` of small metric cards, not a concatenated sentence.
- **G4 — Helper text ≤ 2 lines.** Any explanatory paragraph longer than ~2 lines gets cut, moved into a `?` tooltip/popover, or a collapsible "Details" drawer. No documentation walls.
- **G5 — Detail on demand.** For any list/table of entities (services, tokens, devices, peers, tools, jobs, audit events, contracts, plugins, manifests), the row shows a compact summary; clicking the row opens a right-side `Sheet` drawer with the full metadata. Do not render all metadata inline.
- **G6 — AdminAction = modal.** Every admin mutation uses the shared `AdminConfirmDialog` (reason, optional typed-phrase for destructive ops, affected-resource list, and the returned audit receipt). Remove inline "I confirm reauthentication" checkboxes and inline confirm buttons.
- **G7 — Honest disabled state.** When an action is gated by backend capability, render it as a disabled `Button` with (a) consistent disabled styling and (b) a short inline reason chip or tooltip using approved wording (`Unavailable`, `Requires backend contract`, `Admin approval required`). Never leave a dead-looking control with no explanation.
- **G8 — Standard states.** Every route must render four states cleanly using the shared surfaces: **loading** (skeleton matching final layout, not a spinner), **empty** (composed `EmptyState` with next step), **error/denied/offline** (`RouteStateNotice`), and **ready**. No blank black regions.
- **G9 — Button system.** One `Button` component; `default` (teal) for the single primary action, `outline` for secondary, `ghost`/`icon` for row actions. Max one primary button per section. No full-width teal slabs unless it is a genuine single mobile CTA.
- **G10 — Table density.** Tables live in `Card` with `p-0`, horizontal scroll wrapper, sticky-ish header row, zebra/hover row states, responsive column hiding (`hidden md:` / `hidden lg:` / `hidden xl:`) so columns never wrap mid-word or clip.
- **G11 — Demo labeling.** When data is fixture/sample, keep a single clear "Demo" badge in the header badge cluster; do not scatter "sample/mock" strings in body copy.
- **G12 — Badge clusters.** Header badges use one `BadgeCluster` that wraps gracefully and hides low-priority badges (`hidden sm:inline-flex`) on mobile instead of overflowing.

---

## 5. Phase 1 — Foundation primitive library (do this first)

Build/normalize a small set of reusable primitives in `packages/aurora-ui/src` mirroring the mock's shadcn vocabulary, then refactor pages onto them. Some already exist in `state-surface.tsx` (`PageHeader`, `RouteStateNotice`, `AdminActionButton`, `CapabilityDrawer`, `EmptyState`, `SurfaceSkeleton`) — extend, don't duplicate.

Deliver these components (names indicative; keep `aui-*` class conventions):

1. **`PageHeader`** — extend existing to add an `actions?: ReactNode` slot (top-right, for the primary page action, e.g. "Import model", "Preview action", "Export redacted"). Keep title (sentence case), single optional eyebrow, ≤2-line description, and a `BadgeCluster`. Mock parity: `components/aurora/page-header.tsx` + `services-view` usage.
2. **`Card` / `SectionCard`** — a single card primitive: `surface` bg, locked radius, `16px` padding, optional `title`+`icon`+`actions` header row, optional `footer`. A `p-0` mode for tables. This replaces the many bespoke `aui-*-panel` classes.
3. **`StatStrip` + `Stat`** — responsive grid (`2 → 4` cols) of compact metric cards: small sentence-case label, large value, one-line sub-caption, optional status badge. Replaces run-on header meta (A3) and the big-number tile grids (Models/Config/Services/Audit/Data Policy metric rows).
4. **`Meta` / `MetaGrid`** — compact 2-col label/value pairs (label `11px` muted above value `13px`), for use inside cards and drawers. Replaces raw `<dl>` (A2).
5. **`DataTable`** — thin wrapper: `Card p-0` + scroll + header + hover/zebra rows + responsive column-hide helpers + `onRowClick`. Replaces the cramped bespoke tables (A9).
6. **`DetailSheet`** — right-side drawer (mock uses shadcn `Sheet`) for per-entity detail. Header (title + status badge + description), `MetaGrid`, sub-sections, and up to two action buttons. This is the home for all the metadata currently dumped inline (A5).
7. **`FormField`** — label + control + optional helper/error, with locked vertical rhythm and focus ring. Wrap inputs/textarea/select/switch/checkbox so forms stop overlapping (A6). Add `Switch` and styled `Checkbox`.
8. **`Toolbar` / `FilterBar`** — a compact horizontal control row (search input + a few selects + a right-aligned action), with a "More filters" `Popover`/disclosure for advanced fields. Fixes Audit (A10) and any search headers.
9. **`AdminConfirmDialog`** — modal port of the mock's `components/aurora/admin-confirm-dialog.tsx`: props `{ title, description, methodId, severity, affected[], requireReason, requireTypedPhrase? }`, returns confirm → caller performs the SDK AdminAction and shows the audit receipt via toast + inline result. Replaces all inline confirms (A7/G6).
10. **`Toast`** — adopt a lightweight toast (sonner-equivalent) for async action feedback (success/failure + audit receipt id). Mock uses `sonner`.
11. **`BadgeCluster`** + finalize `status-badges.tsx` variants (health/route/privacy/mode/capability/exposure/method-type) matching mock semantics and colors; ensure graceful wrap + mobile hiding (G12).
12. **`StatusPill` / disabled-action affordance** — standard disabled button + reason chip/tooltip (G7).

**Refactor rule:** as each page moves onto these primitives, delete its bespoke `aui-*-panel`/`aui-*-facts`/`aui-*-header` CSS and any dead selectors in the `styles.css` override pass. Lock behavior with tests before deleting CSS.

---

## 6. Per-route prescriptions

Priority tiers (updated after full-res + live verification of all routes): **Tier 1 (worst — broken layout or extreme verbosity):** Backups, Pairing, Scheduler, Native Settings, Data Policy, Tools, Config, Audit. **Tier 2:** Memory, Mesh, Models, Services, Access/RBAC, Tokens, Devices, Plugins, Contracts, Diagnostics, Settings. **Tier 3 (polish):** Admin Overview, Onboarding, Assistant (shell-only). *(Changes this pass: Pairing and Scheduler promoted to Tier 1 for confirmed broken/orphaned layout; Settings moved to Tier 2 for card-in-card verbosity; Onboarding stays Tier 3 as it is already close to the mock.)*

Each entry: current problems → target → wiring/UX fixes → truthfulness. **All 22 routes are now ✅ full-res verified**; entries inspected in the 2026-07-03 live pass additionally carry a **Live interactivity** line reporting what is actually wired vs honestly capability-gated (see Section 2, F1-F3).

### 6.1 Assistant `/` (Tier 3, shell-only)
**Keep.** Strongest page. Do not restyle its chat, composer, route/privacy sheet, or tool cards. Only touch it if a shared shell/primitive change requires it. Its tool-call card and route-sheet are the visual bar the other pages should reach.

### 6.2 Memory & Knowledge `/memory` ✅ (Tier 2)
- **Problems:** Header is a run-on meta wall (A3: "Namespaces 5 main.memories Records 612 …Embedding health Embedding setup required Configure or reconnect…"). Giant teal Search/Refresh buttons (A8). A truncated, dead-looking right select ("Route unavailable: Unavailabl…"). Collection cards are actually good.
- **Target:** `PageHeader` + `StatStrip` (Namespaces, Records, Embedding health, Retention) replacing the run-on text. Keep the "Collections" metric-card grid (drop the `COLLECTIONS` eyebrow, G1). A compact `Toolbar` row: namespace `Select` + search `Input` + normal-size Search (`default`) and Refresh (`ghost` icon) buttons — not full-width slabs. Results/Namespaces/Conversation as three balanced cards; make each namespace and conversation row open a `DetailSheet` with provenance.
- **Wiring/UX:** Fix the truncated route-status select — either make it a readable disabled `Select` with a reason chip (G7) or move that state into the header badge cluster. Ensure Search actually runs against `DB.RAGSearch` and shows loading skeleton + empty state (G8). Embedding-setup should be an actionable inline notice, not header prose.
- **Truthfulness:** Keep real namespace/record counts and "did not report counts" state; keep AdminAction governance note (shortened, ≤2 lines).

### 6.3 Tools & Automations `/tools` ✅ (Tier 1)
- **Problems:** Red capability-gated banner; overflowing header badge cluster; a `TOOL SEARCH` panel; and a huge always-open 10-field metadata grid for the selected tool (A5) plus verbose MCP/execution prose (A4). Reads as a form dump, not the mock's clean two-card workbench.
- **Target (match mock `tools/page` + `tool-call-card`):** Left = **Tool registry** `DataTable`/list: rows of `tool.name` · call count · risk badge (`Read-Only`/`Mutating`/`External`/`Admin`) · enable `Switch`. Right = **Scheduled jobs** compact table (Job · Schedule(mono cron) · Status badge · next-run). Selecting a tool opens a `DetailSheet` containing the schema, permissions, provider/peer/transport/TTL `MetaGrid`, parameter form, dry-run, and approval state — everything that is currently dumped inline.
- **Wiring/UX:** Keep real schema-derived parameter validation and `Tooling.ExecuteTool`/AdminAction behavior, but inside the drawer. The capability-gated state becomes a single header `Unavailable` badge + one inline notice, not a red slab. "Reload catalog" stays a disabled `Button` with reason chip (G7). Enable toggles must reflect and drive real tool enable state (or be disabled+explained if not writable).
- **Truthfulness:** Keep "No schema reported by backend" / "audit pending" states; move them into the drawer as muted `Meta` values.

### 6.4 Mesh & Peers `/mesh` ✅ (Tier 2)
- **Problems:** Actually one of the better pages. Peer cards use loose label/value pairs (A2-lite); topology cards a bit tall; some eyebrows (`LOCAL NODE`, `RUNTIME`…).
- **Target:** Keep the top `StatStrip` (Local node / Runtime / Trust states / Diagnostics / Devices) but drop eyebrow caps. Tighten peer cards into a `DataTable` or compact card grid: peer name + id(mono) + status badge, and a compact `MetaGrid` (Connection, Latency, Route quality). Row/card click → `DetailSheet` with full transport metrics.
- **Wiring/UX:** Keep the "Demo peer data" banner (single, in demo mode). Ensure peer actions (if any: approve/deny/remove) route through `AdminConfirmDialog`. Preserve denied/pending/unsupported/remote grouping via badges.
- **Truthfulness:** Gateway/Auth-derived state only; keep stale/denied/manifest-stale honesty.

### 6.5 Admin Overview `/admin` ✅ (Tier 3)
- **Problems:** Better-structured than most (StatStrip + two cards) but still eyebrow-heavy (`OPERATOR SURFACE`, `DEPLOYMENT`, `RUNTIME TOPOLOGY`) and dominated by **two raw `<dl>` fact-dumps** (A2): the "Posture" card (Service mode / Runtime / Registry digest / Services / Methods / Peers / Native) and the taller "Deployment topology" card (Client boundary / Architecture / Bus backend / Redis / BullMQ / Registry freshness / Container hints / Redaction) which then nests a `thread_mode_no_process_controls` degraded sub-card **and** a Service/Topology mini-table. The topology column is a wall of stacked label/value prose. Bottom action buttons ("Diagnostics export", "Services", "Contracts registry") sit under a scroll and read like an afterthought.
- **Target:** `PageHeader` (single eyebrow `ADMIN`) + `StatStrip` (Services healthy, Capability gaps, Mesh peers, Deployment posture). Convert both `<dl>` dumps into one **Deployment posture** `Card` with a `MetaGrid` (Service mode, Runtime, Registry digest, Methods, Peers) and a **Runtime topology** `Card` with a `MetaGrid` (Client boundary, Architecture, Bus backend, Redis/BullMQ, Registry freshness, Redaction) — the deep per-service topology becomes a compact `DataTable` (Service · Topology) with row → `DetailSheet` for the process-control detail. Promote the bottom actions into the `PageHeader` `actions` slot or a compact card grid of admin launchers.
- **Live interactivity:** On full load the page renders real posture/topology values; on a cold catalog it degrades to the `0/0 routes` rail and "could not load the admin overview manifest / Service overview unavailable / Unknown SDK error" heading (observed live). That error state is currently a bare heading — it must become a composed `RouteStateNotice` with a retry affordance (G8, F3). The "Diagnostics export / Services / Contracts registry" buttons are real navigation/actions; keep them but relocate and give the export a toast.
- **Truthfulness:** Keep the "Demo" transport badge, `thread-mode` posture, and "process restart controls are intentionally disabled" honesty; render the intentionally-disabled controls per G7, not as alarms.

### 6.6 Services `/admin/services` ✅ (Tier 2)
- **Problems:** Metric strip fine, but the Services table is cramped by the rail — `HEARTBEAT` clips to `HEAF`, timestamps wrap `2026 19T0` (A9). Each row has redundant description + a blue `Details: routes, methods, and backend exposure` text link and doubled route badges.
- **Target (match mock `services-view`):** Full-width `DataTable` in `Card p-0`: Module · Health · Instance(mono, `hidden md:`) · Capabilities(badges, `hidden lg:`) · Route · Heartbeat(`hidden xl:`) · Actions(right icon buttons). Whole row clickable → `DetailSheet` (methods & exposure, `MetaGrid`, run-health/restart buttons). Remove the inline "Details:" link and the eyebrow `REGISTRY`.
- **Wiring/UX:** Row action icons: Restart (enabled when `Supervisor.RestartService` covered) and Stop (locked icon + tooltip when `missing_contract`) → both via `AdminConfirmDialog` (Stop requires typed phrase). "Run health check" → toast feedback.
- **Truthfulness:** Keep coverage gating (`missing_contract`/`internal_only`) exactly; show as disabled+reason.

### 6.7 Access & RBAC `/admin/access` ✅ (Tier 2)
- **Problems:** Good bones (StatStrip: Principals 4 / Roles 4 / Permissions 46 / Audit 7) but two concrete issues. (1) A row of **five "sub-navigation" cards** (Roles, Principals, Permission matrix, API tokens, Trusted devices) each with an eyebrow-ish title + micro-caption — these duplicate the left nav and add eyebrow spam (A1). (2) The "Identity access" **table is cramped and redundant**: the `ROUTE` column repeats the identical string "Auth.PatchPermissions requires AdminAction approval." on *every* row, the `ACTIONS` header truncates to `ACTI`, identities wrap mid-word ("assistant.use r"), and the only action is a lone key icon. A blue info notice explains the `Auth.ListRoles` gap (keep, but shorten).
- **Target:** `PageHeader` (`ADMIN`) + `StatStrip`. Drop the 5 sub-nav cards (or collapse to at most a compact segmented control / tabs for Principals · Roles · Permissions · Devices). Rebuild "Identity access" as a `DataTable` (Identity(name + principal id mono) · Role(badge) · Effective access(scope badges) · Scope(`Local`/`Mesh` badge) · Actions(icon)). **Delete the repeated "requires AdminAction approval" cell** — that governance fact belongs once in the section helper text or inside the row's `DetailSheet`, not per row. Row click → `DetailSheet` (full permission list, role assignment, audit).
- **Live interactivity:** With a cold catalog the whole surface reports `0/0 routes` and controls disable (F1). The per-row key icon triggers `Auth.PatchPermissions` and is honestly disabled when that method is not advertised ("Auth.PatchPermissions is not advertised by the capability catalog"). Route it through `AdminConfirmDialog` (G6) and show the audit receipt via toast. Roles are honestly *derived* from `Auth.ListPrincipals` because `Auth.ListRoles` is not advertised — keep that derivation and its one-line notice; do not fake role CRUD.
- **Truthfulness:** Preserve the derived-roles honesty and effective-access previews; disable+explain any control whose backend method is absent.

### 6.8 Tokens `/admin/tokens` ✅ (Tier 2)
- **Problems:** Solid StatStrip (Tokens 3 / Expiring 2 / Expired 1 / Scopes 5) and a real redacted inventory table, but: the **"Create-token preview wizard"** is a large inline card (Owner input, Expires input, Requested-scope badges, a disabled "Create token unavailable" button, a blue "One-time reveal only" notice, and a gray "Auth.CreateToken is not exposed… creation remains a disabled preview" line) that dominates the page above the actual inventory (A6-adjacent, wrong IA). Eyebrows `CREATE` / `CREDENTIALS` (A1). Inventory table `ACTIONS` header truncates to `ACTIO`; scope badges stack and push row height.
- **Target:** `PageHeader` (`ADMIN`, `actions`: "Create token" — disabled+reason chip while gated) + `StatStrip`. Lead with the **Scoped token inventory** `DataTable` (Prefix(mono, redacted) · Owner · Device · Scopes(badge cluster, `hidden lg:`) · Status pill · Expires · Last used · Actions(copy/revoke icons)); row → `DetailSheet`. Move the create wizard **out of the page body** into the modal/drawer opened by the header action — so when it is a disabled preview it is a single disabled button + reason, not a giant dead form.
- **Live interactivity:** `Auth.CreateToken` is **not exposed by the SDK/contracts in this checkout**, so creation is a genuine disabled preview — keep it disabled (do not wire fake creation) and surface the reason via G7. `Auth.RevokeToken` is honestly gated when not advertised; when present, revoke → `AdminConfirmDialog` + toast with audit receipt. The row copy icon copies the redacted prefix only. With a cold catalog the inventory + controls disable (F1).
- **Truthfulness:** Never render raw token/secret material — the "one-time reveal only, secrets not retained" boundary is correct; keep prefixes redacted.

### 6.9 Devices `/admin/devices` ✅ (Tier 2)
- **Problems:** StatStrip is good (Devices 3 / Pending 2 / Sessions 2 / Tokens 3). But the body is card-in-card prose: a "Trust posture" card nests a "Pending pairing requests" sub-card (a paragraph describing the Kitchen tablet request + Approve/Deny buttons) and a "Platform security status" sub-card that is a **raw `<dl>`** (Platform / a comma-run of Capabilities / a Boundary paragraph) (A2/A4). Below, a **"CONTROLS / AdminAction boundary"** card carries the inline-confirm anti-pattern: a `Refresh` button, an "ADMINACTION REASON" textarea, and an **ALL-CAPS checkbox** "I CONFIRM RECENT ADMINACTION REAUTHENTICATION FOR DEVICE, PAIRING, AND MESH TRUST MUTATIONS" (A7/G6).
- **Target:** `PageHeader` (`ADMIN`) + `StatStrip`. Replace the pending-request sub-card with a **Pending pairings** `DataTable` (device · origin(ip/node) · requested · expiry · Actions) and the platform `<dl>` with a compact **Platform security** `MetaGrid` (Platform, Capabilities as a wrapping badge cluster, Trust boundary as ≤2-line helper). A registered-devices/sessions `DataTable` (device · principal · status badge · last seen · session) with row → `DetailSheet` for credential/session detail. **Delete the "AdminAction boundary" card entirely** — reason + reauth move into `AdminConfirmDialog`.
- **Live interactivity:** Approve/Deny are wired to `Auth.PairingApprove`/`Auth.PairingDeny`; Delete device to `Auth.DeleteDevice`; mesh trust to `Auth.MeshApprovePeer`/`Auth.MeshRemovePeer` — each honestly disabled with a per-capability reason when not advertised (e.g. "Auth.DeleteDevice is not advertised by the capability catalog"). Route all through the modal; show fingerprint/device id in the confirm body; toast the audit receipt. Cold catalog → controls + list disable (F1).
- **Truthfulness:** Keep the "device trust uses Auth records; native capability claims use the SDK native manifest only" boundary; keep pairing-secret redaction.

### 6.10 Configuration `/admin/config` ✅ (Tier 1)
- **Problems:** Mostly empty states ("Config editor unavailable"; 0 schema fields) rendered as flat empty cards; eyebrow-heavy metric tiles; staged-review + admin-reason + inline checkbox + teal confirm button crammed (A6/A7).
- **Target:** `StatStrip` (Schema fields / Secrets / Restart-required / Staged) without caps eyebrows. Left = **schema accordion** (mock config-view style) of config sections; when unavailable, a single composed `EmptyState` ("Configuration editor is unavailable in this backend/mode") not a flat empty card. Right = **Staged review** card: diff preview + reload impact + a proper `FormField` reason, and a single "Review & Apply" `Button` that opens `AdminConfirmDialog` (no inline confirm checkbox). Rollback history as a compact table.
- **Wiring/UX:** Wire `Config.PreviewDiff` / `Config.PreviewReloadImpact` before `Config.Set` through the modal; secrets stay redacted. Never bypass AdminAction review.
- **Truthfulness:** Keep "unavailable"/"no staged changes"/"no version history" states, styled as intentional empties.

### 6.11 Contracts `/admin/contracts` ✅ (Tier 2)
- **Problems:** This is the **most table-mature page** and the best template for the DataTable+filter direction. It already has a StatStrip (Contracts 33 / Services 3 / Unavailable 0 / Updated timestamp) and an "Explorer" with search + Service/module select + Exposure select + a nested sub-StatStrip (Filtered methods / HTTP routes / Live registry / Schemas) + a grouped table (Service/module · Method · Type · Exposure · Backend · Gateway route · Conformance) sectioned by "AUTH MODULE / 18 CONTRACTS". Issues: eyebrows (`EXPLORER`); a redundant standalone **"Method detail" `<select>`** floating in the filter row (detail should come from clicking a row, not a separate dropdown); `Gateway route` cells wrap; `Conformance` badges stack two-high per row; the `Updated` stat wraps its timestamp.
- **Target:** Keep the layout but formalize it: `FilterBar` (search `Input` + Service/module `Select` + Exposure `Select`, right-aligned) over a `DataTable` (Method(mono) · Module · Type badge · Exposure badge · Backend · Gateway route(mono, `hidden lg:`) · Conformance badge). **Remove the "Method detail" select** — row click opens a `DetailSheet` (IO models/JSON schema, permissions, gateway route, conformance history). Keep the module grouping as sticky group headers.
- **Live interactivity:** The search box and the two selects are real client-side filters over `Gateway.GetRegistry` data. **Directly observed degraded state:** on a cold catalog the page renders "No method descriptors were returned by Gateway.GetRegistry." as a bare heading with `0/0 routes` — replace that with a composed `EmptyState`/`RouteStateNotice` (G8, F3). The `Schemas 0` metric is honest when no JSON schemas are advertised; keep it.
- **Truthfulness:** Use production-facing labels (`Gateway route`, `Live registry`) — never `generated`. Keep conformance (`live-registry`/`conformant`/`missing-capability`) exactly as reported.

### 6.12 Plugins `/admin/plugins` ✅ (Tier 2)
- **Problems:** In this deployment the page is **almost entirely an empty/unavailable state**, and it looks broken rather than intentional: a full-width "Unavailable" warning banner, a StatStrip that is **all zeros** (Tools 0 / Plugin-MCP 0 / Policy gated 0 / Unavailable 0), an empty "Provider grouping" card, an "AdminAction / Reload and install controls" card with a disabled "Reload catalog" button, and an "Inventory" card whose table body is the bare sentence "No plugin, MCP, or tool catalog entries were returned by the SDK." Eyebrows everywhere (`PROVIDERS`, `ADMINACTION`, `INVENTORY`). Header badge cluster overflows (`service-unavailable`, `Unsupported`, `Admin Critical`, `Pending`, `secrets protected`).
- **Target:** `PageHeader` (`ADMIN`, `actions`: "Reload catalog" disabled+reason) + `BadgeCluster` that wraps/hides on mobile (G12). When the catalog is empty, render **one composed `EmptyState`** ("No plugin, MCP, or tool catalog is advertised by this backend") with the repair next-step — not four separate empty cards + a banner. When populated, a `DataTable` (Tool · Provider · Health badge · Risk badge · Policy · Audit) with row → `DetailSheet` (capabilities, endpoints, sharing policy) and an enable `Switch` where writable, grouped by provider via section headers (no eyebrows).
- **Live interactivity:** "Reload catalog" is wired to an AdminAction-gated method and honestly disabled: "…is not advertised by Gateway registry; repair the backend contract before enabling this control." Policy is read-only when the mutation contract is absent. Do not fake plugin rows — the empty state is truthful; just make it look intentional (G7/G8).
- **Truthfulness:** Keep the "returned by the SDK" honesty; render unsupported/unavailable as designed empties, not alarms.

### 6.13 Pairing `/admin/pairing` ✅ (Tier 1 — genuinely broken layout + confirm density)
- **Problems:** Confirmed one of the worst. (1) Leads with a "Pairing queue" section that is **disabled/unsupported** ("Pairing queue is disabled until Aurora reports pending-pairing access as available.") shown as a flat card with an "Admin action required" chip. (2) A **cramped, overlapping horizontal control row** where labels are clipped: "ADMINACTION REASON" textarea + "APPROVE PERMISSIONS" input + a checkbox row whose labels truncate to "In-ses admin unloc confir for Admi subm" and "Grant admin role on approval" — fields are jammed edge-to-edge with no rhythm (A6). (3) Two more stacked forms below: "Pairing code, QR, and deep link" (Device name / Remote peer id / Remote node name + teal "Create pairing code via AdminAction") and "Exchange and revoke" (paste-code input + "Exchange via AdminAction" + a disabled "Revoke exchanged token via AdminAction") with a blue "Pending pairing revoke unavailable: missing backend contract Auth.PairingRevoke." notice. Prose-heavy throughout (A4).
- **Target:** `PageHeader` (`ADMIN`). Pending-pairing **queue as a `DataTable`** (peer/device · origin · requested · fingerprint(mono) · state · Actions) with a composed `EmptyState` when the queue capability is unavailable (not a flat card). Move **all** the scattered controls into two focused actions: a "Create pairing code" action (opens a `FormField` drawer/modal) and per-row Approve/Deny + Exchange actions routed through `AdminConfirmDialog` (fingerprint shown to confirm; reason + reauth handled by the modal — delete the inline reason/permission/confirm row entirely). QR/deep-link output and exchange details live in a `DetailSheet`.
- **Live interactivity:** `Auth.PairingStart` (create code) and `Auth.PairingExchange` (exchange) **are wired and enabled** (teal). Pending-code **revoke is honestly unavailable** — `Auth.PairingRevoke` is not exposed; exchanged tokens can still be revoked via `Auth.RevokeToken` when the backend returns a token id. Keep revoke disabled+explained; do not fabricate it. Queue actions gate on `Auth.ListPendingPairings`. Cold catalog → all disable (F1). QR image is honestly "unavailable until a QR renderer/backend contract exists" — keep the deep-link payload path.
- **Truthfulness:** Preserve the missing-contract notices verbatim-in-meaning (shortened per G4); keep pairing-secret redaction and credential boundaries.

### 6.14 Backups `/admin/backups` ✅ (Tier 1 — currently the most broken)
- **Problems:** **Genuinely broken layout.** The "Create backup" form overlaps: `Reason` label collides with the textarea tooltip box; the two checkboxes and their long labels are jammed with no spacing; "Create via AdminAction" is crammed inline (A6). "Availability" is a raw `<dl>` dump (A2) with bulleted "Authenticate disabled…"/"Grant permission available…" run-ons (A4). Full restore is a permanently-disabled button that looks dead (A8/G7).
- **Target:** `PageHeader` (`actions`: "Preview action") + `BadgeCluster`. Replace the 5 bespoke `aui-backup-panel`s with: (1) **Manifests** `DataTable` (backup id + created · status · components · storage · integrity(mono)) with row select → `DetailSheet`; (2) a **Create backup** action that opens `AdminConfirmDialog` (reason `FormField`, "include personal RAG metadata" `Switch`, typed reauth handled by the modal, affected components list) — delete the inline form entirely; (3) **Availability** as a small `StatStrip`/`MetaGrid` (State, Route, Mutation gate, Blockers), not a `<dl>`; (4) **Verify / Restore / Rollback** as clearly-labeled buttons that open the confirm modal, with Full-Restore shown as disabled + reason chip ("Destructive restore unavailable until backend exposes a confirmed contract").
- **Wiring/UX:** Preserve all real calls (`backups.list/create/verify/restore(dry_run)/rollback`) but behind the modal (G6). Show operation result + audit receipt via toast + an inline result card. Fix the CSS overlap regardless of refactor path.
- **Truthfulness:** Keep dry-run-only restore and warning-only rollback; keep secrets-redacted/audit-receipt honesty.

### 6.15 Scheduler `/admin/scheduler` ✅ (Tier 2 — broken layout + wrong IA)
- **Problems:** Two confirmed defects beyond the usual. (1) **Wrong information architecture:** the page leads with the big "Schedule automation" **create form** (Job name / Schedule / Action / Target peer / AdminAction reason) + a "Delegation context" `<dl>` card, and the actual **jobs list ("Ownership-scoped job table") is buried below the fold** — the primary content (existing jobs) is subordinated to the create form. (2) **Broken layout:** the "I confirm recent AdminAction reauthentication for scheduler mutations" checkbox + its label **float orphaned in the empty gutter between the two columns**, detached from both the form fields and the Create button (A6) — verified in both the artifact and a fresh live capture. Eyebrows `CREATE` / `POLICY`; Delegation context is a raw `<dl>` (Route / AdminAction / Target selector / Blockers) (A2).
- **Target:** Lead with the **jobs `DataTable`** (Name · Schedule(mono cron) · Owner/namespace · Status badge · Last/next run · Actions) with row → `DetailSheet` (history, delegation, blockers). Move create/edit into a `FormField` drawer/modal opened by a `PageHeader` "Schedule automation" action. Turn "Delegation context" into a `MetaGrid`. **Delete the floating confirm checkbox** — reauth lives in `AdminConfirmDialog`.
- **Live interactivity (directly probed):** With `0/0 routes` the *entire* create form is `[disabled, readonly]` (every input, the confirm checkbox, and the "Create via AdminAction" button) and the jobs region shows "No scheduler jobs available." — this is the F1 cascade, not broken wiring. When the catalog advertises the scheduler capability the form enables and Create fires `Scheduler.Schedule` via AdminAction. **Edit is honestly disabled** ("…edit is intentionally disabled") because the edit method candidates are not advertised. Route run-now/pause/delete/create through the modal + toast; keep edit disabled+explained.
- **Truthfulness:** Keep local/delegated/remote/denied namespace grouping and blocker reporting exactly.

### 6.16 Audit Log `/admin/audit` ✅ (Tier 1)
- **Problems:** 17 filter inputs shown at once in a 3-col grid (A10) — overwhelming, uppercase-labeled. Events table below.
- **Target:** Compact `FilterBar`: a search `Input` + Event `Select` + Result `Select` + date range, and a **"More filters"** `Popover`/disclosure holding the remaining ~13 fields (Actor, Action, Resource, Principal, Peer, Route path, Approval mode, Tool id, Data namespace, Audio session, Scheduler job, Correlation id, Denial reason). Right-aligned "Export redacted" `Button`. Below: events `DataTable` (time · actor · action · resource · result badge) → row `DetailSheet` (redacted payload preview, receipt, correlation ids).
- **Wiring/UX:** Filters drive `Auth.AuditLog`; export triggers real redacted export with toast. Keep sensitive/redacted boundaries; move the "Export includes…" note into a tooltip on the button.

### 6.17 Models & Runtime `/models` ✅ (Tier 2)
- **Problems:** reauth checkbox floats awkwardly directly under the header (A6). "Model runtime categories" is a 7-tile big-number grid with an uppercase eyebrow per tile (A1/A5). Provider cards below are dense but ok.
- **Target (match mock `models-view`):** `PageHeader` (`actions`: "Import model", disabled+reason if gated) + provider `Card` grid (icon chip + capability badge + name + compact `Meta` rows Kind/Context/Size/Health). A **Provider route policy** card (candidate routes: badge + model + note + privacy + latency) + a **Benchmark snapshot** card (labeled `Progress` bars). A runtime `DataTable` (feature · mode · status · metric(mono) · privacy). One warning card for mobile local-light gating. Remove the floating reauth checkbox — reauth belongs in the `AdminConfirmDialog` when changing the provider.
- **Wiring/UX:** Provider selection change → `AdminConfirmDialog` → `Config.Set`. Import/download stay disabled+explained until contracts exist. Keep no-model/fallback/local-vs-cloud truth.

### 6.18 Diagnostics `/diagnostics` ✅ (Tier 2)
- **Problems:** Leads with a "Desktop thin shell" system-state card (fine) then a **"Native boundary" raw `<dl>`** (Runtime mode / Transport / Native manifest / Tray / Notifications / Dialogs / Audio bridge / Denied native defaults — mostly "not available") + a "Shut down shell" button (A2). Below, a grid of **route-availability cards** (Assistant, Memory & Knowledge, Tools & Automations, Mesh & Peers, …) that each repeat title + status badge + a description paragraph + Provider + Privacy badge + Approval + a "Route details >" link — this **duplicates the shell route matrix** and is verbose (A4). Eyebrow `SYSTEM STATE`.
- **Target:** `PageHeader` (`RUNTIME`) + `StatStrip` (Runtime mode, Transport, Native capabilities available/total, Routes ready). Convert "Native boundary" to a compact **MetaGrid** and keep "Shut down shell" as one clearly-labeled action. Collapse the route-availability grid into a single **`DataTable`** (Route · Status badge · Provider · Privacy · Approval) with row → `DetailSheet` (repair task, capability detail) instead of a paragraph per card. Support-bundle/export as header actions.
- **Live interactivity:** "Shut down shell" is a real native action (no-op/undefined in browser thin mode — keep it disabled+explained on web). `Gateway.GetWebRTCDiagnostics` is honestly "not advertised by the capability catalog" — keep the mesh/WebRTC diagnostics section disabled+explained. Route-details links are real navigation; make the whole row clickable (F2). Cold catalog → route grid empties (F1/F3).
- **Truthfulness:** Keep `updated`/`not reported`/`not available` wording (never `generated`/evidence). Preserve the "native status shown only from the manifest" boundary.

### 6.19 Onboarding `/onboarding` ✅ (Tier 3 — one of the better pages)
- **Problems:** Actually well-structured (two-column: "Setup modes" list + numbered "Guided setup path" stepper) and closest to the mock. Remaining issues are minor: a **run-on caption** in the header ("Demo/offline Demo mode preference is memory-only fixture state · no saved mo…") that truncates (A3); the mode cards carry slightly long descriptions each with a status badge (Server Web/Desktop Local/Desktop Thin/Mesh Shell/Android/iOS/Offline Demo); the stepper cards ("Select mode", "Authenticate / pair", "Load capability graph", "Review privacy defaults") also run 3-4 lines each (A4-lite). Header badge cluster is wide (Pending / Demo / Demo mode / "browser token persistence disabled").
- **Target:** Keep the mode-list + stepper structure. `PageHeader` (`FIRST RUN`) with the run-on caption trimmed to ≤1 line (move detail to a tooltip). Mode entries as compact selectable rows (icon + name + one-line summary + status badge); trim step descriptions to ≤2 lines with detail on expand. Keep the "Start guided setup" primary button (single teal CTA is fine here per G9). Keep the progress bars.
- **Live interactivity:** Mode selection, "Start guided setup", and step actions are real; each mode/step shows honest per-mode state (Degraded/Unsupported/Local) from the SDK/route status (e.g. mesh "waits for Auth/Gateway capability status"). Authenticate/pair uses real `Auth.Login`/`Auth.PairingExchange`. Only show steps valid for the active mode; keep completed/blocked reflecting actual state. Cold catalog → step badges degrade (F1).
- **Truthfulness:** Keep the "Demo mode, not a live server" / "no local sidecar status" honesty per mode; do not present unsupported modes as available.

### 6.20 Settings `/settings` ✅ (Tier 2 — more verbose than expected)
- **Problems:** Heavier than "decent": a two-column **card-in-card** layout ("Privacy defaults" and "Voice behavior") where each outer card nests multiple sub-cards (Prefer local processing / Require explicit remote selectors / Block fallback after explicit target failure; Push-to-talk / Wake mode). Every sub-card is a **description paragraph + a stack of badges** (Unsupported/Sensitive/Pending/Needs consent/Raw audio/…) + an "AdminAction required" or "Unavailable" button (A4/A7). There are **no actual toggle controls visible** — the switches "are disabled until Config/AdminAction support exists", so the page reads as a wall of descriptions and disabled buttons rather than a settings surface.
- **Target:** Convert to proper settings rows: grouped `Card`s (Privacy, Voice) with **`FormField`+`Switch` rows** (setting name + ≤1-line helper + control on the right + a status/badge). Collapse the per-setting paragraph into the helper line; move rationale into a `?` tooltip. Replace the "AdminAction required" buttons with disabled switches carrying a reason chip (G7) until the backend exposes the mutation. Keep the two-column grouping but drop the nested-card depth.
- **Live interactivity:** Toggles are honestly disabled — privacy/voice mutations gate on `Config.Set`/AdminAction which are not advertised here. When available, a toggle change routes through `AdminConfirmDialog` → `Config.Set` + toast. Push-to-talk/Wake mode gate additionally on native microphone + WakeWord route availability. Do not render web-invalid native controls as enabled.
- **Truthfulness:** Keep the consent/raw-audio/foreground-explicit-consent honesty and the "switches disabled until support exists" state; native permission detail stays on `/settings/native`.

### 6.21 Data Policy `/memory/policy` ✅ (Tier 1 — verbose worst)
- **Problems:** Right column is a documentation wall: ALL-CAPS headings (`RAW AUDIO STORAGE`, `TRANSCRIPT STORAGE`, `REMOTE/MESH FALLBACK`, `NAMESPACE VISIBILITY`) each followed by gray paragraphs (A4). Retention table cells wrap mid-word ("main.memorie s 42 records") (A9).
- **Target:** `PageHeader` + `StatStrip` (Retention defaults / Namespace visibility / Raw audio-transcripts / Audit trail). Retention as a clean `DataTable` (Namespace · Privacy badge · Retention/sharing · Visibility · Data flows) with responsive column hiding so nothing wraps mid-word; row → `DetailSheet` for provenance. Convert the raw-audio/transcript/fallback wall into **compact policy cards** (title + status badge + ≤2-line summary; full text in drawer/tooltip). Export/delete/import flows as a compact action row with per-flow enabled/disabled + reason.
- **Wiring/UX:** Preserve retention/privacy truth and per-flow AdminAction gating (flows enabled only when namespace policy + AdminAction permit). No raw payloads/tokens rendered.

### 6.22 Native Settings `/settings/native` ✅ (Tier 1 — worst redundancy on any page)
- **Problems:** The single most redundant page in the app. It is a long list of capability cards (Tauri audio bridge status, Tauri audio capture, Tauri audio playback, Command, Tauri dialog open, …) where **every card repeats the identical paragraph verbatim**: "Tauri desktop native status is shown only from the manifest for permissions, tray, notifications, dialogs, audio, local file access, secure storage, or updater capability." — printed 8+ times down the page (A4 at its worst). Each card then has status badges (Local/capability enabled/native-manifest OR Needs consent/capability disabled/native-manifest), a "native permission missing: aurora.audioCapture" line, and a "Granted" or "Request unavailable" button. Eyebrow `SETTINGS / NATIVE`.
- **Target:** State that shared sentence **once** as section helper text under the header, then render capabilities as a compact **`DataTable`/list** (Capability · Status badge(granted/needs-consent/unsupported) · Native permission id(mono) · Action) with per-row detail in a `DetailSheet`. `StatStrip` of platform truth (Platform, Native manifest, Capabilities granted/total, Mode). Fix mobile to a clean single column.
- **Live interactivity:** "Request" buttons are enabled **only when the platform advertises a native request command** for that capability (honest); otherwise "Request unavailable" disabled + reason (G7). In browser thin mode all rows correctly show unsupported/manifest-only status. Do not synthesize a native permission prompt on web.
- **Truthfulness:** Native status comes only from the SDK native manifest (`platform-surface.ts`); keep the "shown only from the manifest" boundary (now stated once) and the per-capability `aurora.*` permission ids.

---

## 7. Consolidated "broken / not interactive / doesn't make sense" catalog

Give these explicit attention — they are the user's "wire it up / fix trash UX" asks:

1. **Backups Create form overlap (broken CSS).** Overlapping label/tooltip/checkbox/button. → Rebuild via `AdminConfirmDialog` + `FormField`; fix `.aui-backup-*` CSS. (6.14)
2. **Inline AdminAction confirms everywhere.** Backups/Models/Config use checkbox+inline button. → Unify on `AdminConfirmDialog` modal. (G6)
3. **Permanently-disabled controls that look dead:** Full restore (Backups), Reload catalog (Tools), Config editor (Config), Import/download (Models). → Consistent disabled styling + reason chip/tooltip. (G7)
4. **Memory truncated route select** ("Route unavailable: Unavailabl…"). → Fix truncation; readable disabled select or move to header badge. (6.2)
5. **Oversized primary buttons** (Memory Search/Refresh). → Standard `Button` scale. (G9)
6. **Models floating reauth checkbox** under header with no context. → Move reauth into the provider-change modal. (6.17)
7. **Cramped/truncating tables** (Services `HEAF`, wrapped timestamps; Data Policy mid-word wraps). → `DataTable` + responsive column hiding + `Card p-0`. (G10)
8. **Audit filter overload** (17 fields). → Compact `FilterBar` + "More filters" disclosure. (6.16)
9. **All-metadata-inline** (Tools 10-field grid; per-peer/per-service inline detail). → Move to `DetailSheet` on row click. (G5)
10. **Row detail via text link** ("Details: routes, methods…") instead of clickable row/drawer. → Whole-row click → drawer. (6.6)
11. **Empty pages rendered as flat black cards** (Config unavailable, empty search/history). → Composed `EmptyState` with next step. (G8)
12. **Confirm/mutation actions with no feedback.** → `toast` + inline result + audit receipt on every AdminAction. (Phase 1.10)
13. **Scheduler floating confirm checkbox (broken CSS).** The reauth checkbox + label float orphaned in the empty gutter between the two columns, detached from the form and the Create button. → Delete it; reauth moves into `AdminConfirmDialog`. Fix the two-column form so nothing renders in dead space. (6.15)
14. **Scheduler wrong IA.** Create form is above the fold; the jobs list ("Ownership-scoped job table") is buried below it. → Lead with the jobs table; create in a drawer/modal. (6.15)
15. **Native Settings identical paragraph repeated 8+ times.** The same "native status is shown only from the manifest…" sentence prints on every capability card. → State once as section helper; capabilities become a compact table. (6.22)
16. **Pairing cramped/overlapping control row.** ADMINACTION reason + APPROVE PERMISSIONS + confirm checkboxes jammed edge-to-edge with labels truncating ("In-ses admin unloc confir…"). → Move controls into `AdminConfirmDialog` + `FormField` drawer; delete the inline row. (6.13)
17. **Access/RBAC redundant per-row cell.** "Auth.PatchPermissions requires AdminAction approval." repeats on every table row. → State once in section helper/drawer; remove the column. (6.7)
18. **Tokens create-wizard dominates the page.** A large disabled preview form sits above the real inventory. → Move creation into the header-action modal; lead with the inventory table. (6.8)
19. **Devices/Pairing/Config inline uppercase reauth checkboxes.** ALL-CAPS "I CONFIRM RECENT ADMINACTION REAUTHENTICATION…" checkbox rows. → Replace with `AdminConfirmDialog`; never uppercase body copy. (6.9, 6.13, G6)
20. **Bare degraded/`0/0 routes` states.** Directly observed: entire forms disable and lists read "No … available" / "No method descriptors…" while the local Gateway warms up (F1/F3). → First-class skeleton/empty/`RouteStateNotice` for the catalog-cold state on every page. (G8)
21. **No detail drawer anywhere in admin views (F2).** Row detail is inline dumps or text links across all admin/data views. → Build `DetailSheet` and route every table row onto it. (G5)

For every action the agent touches: verify it (a) is wired to the real SDK call, (b) shows loading/disabled correctly, (c) shows success/error feedback, (d) routes admin mutations through the modal. **Note from the live pass (F1):** most disabled controls are already wired and are honestly capability-gated — do NOT "re-wire" them; make the gated/loading/empty states look intentional. If a control cannot be wired truthfully, make it a clearly-disabled affordance with a reason — do not leave ambiguous dead UI, and do not fake capability.

---

## 8. Suggested execution order

1. **Phase 1 primitives** (Section 5) + token/consistency locks (Section 3) + em-dash sweep. Land with tests green.
2. **Tier 1 pages:** Backups → Pairing → Scheduler → Native Settings → Data Policy → Tools → Config → Audit.
3. **Tier 2 pages:** Memory → Services → Models → Mesh → Access → Tokens → Devices → Plugins → Contracts → Diagnostics → Settings.
4. **Tier 3 polish:** Admin Overview → Onboarding; Assistant only if shell primitives changed.
5. **Cleanup pass:** delete dead `styles.css` override selectors now unused; consolidate shared selectors.

After each page: screenshot mock+prod at `1440x1024` and `390x844`, diff against `.omx/artifacts/visual-ralph/all-pages-final/`, and update visual fingerprints only after manual review.

---

## 9. Verification & acceptance criteria

**Per-page acceptance (all must hold):**
- [ ] Uses `PageHeader` + Phase 1 primitives; no bespoke per-page panel/`<dl>` markup remaining.
- [ ] ≤1 uppercase eyebrow on the page (G1); zero em-dashes in visible strings.
- [ ] No run-on meta text; header stats use `StatStrip` (G3).
- [ ] No always-expanded metadata grids; entity detail via `DetailSheet` (G5).
- [ ] All four states render cleanly (loading skeleton / empty / error / ready) (G8).
- [ ] Every admin mutation goes through `AdminConfirmDialog`; every action gives toast/inline feedback (G6).
- [ ] Disabled/gated controls have consistent styling + a reason (G7).
- [ ] Tables don't wrap mid-word or clip headers at `1440` or `390`; responsive column hiding applied (G10).
- [ ] One accent, one radius, dark theme locked; WCAG-AA contrast on all controls (Section 3).
- [ ] Real SDK/Gateway/platform state preserved; demo data labeled once; approved wording only (handoff Section 7).

**Test/command gate (from handoff):**
```sh
pnpm --filter @aurora/ui test -- --reporter=dot
pnpm --filter @aurora/ui typecheck
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui test -- src/aurora-client.test.tsx --reporter=dot
git diff --check
```
Update `packages/aurora-ui/tests/accessibility-responsive-visual.test.tsx` fingerprints only after manual desktop/mobile review. Expand the wording-guard tests rather than relying on manual review.

---

## 10. Handoff prompt for the frontend agent

```text
Use docs/TAURI_UI_VISUAL_REFINEMENT_PLAN.md as the controlling plan and
docs/TAURI_UI_VISUAL_REFINEMENT_HANDOFF.md for constraints, route inventory, and commands.
Source of truth: modules/ui-mock-reference (shadcn cockpit). Target: packages/aurora-ui.
Evidence: .omx/artifacts/visual-ralph/all-pages-final (mock vs prod, desktop + mobile).

1. Build the Phase 1 primitive library (Section 5) and apply the token/consistency locks
   (Section 3) + global rules (Section 4). Land with @aurora/ui tests green.
2. Refactor routes in the Section 8 order onto the primitives, following each per-route
   prescription in Section 6 and fixing every item in the Section 7 broken/UX catalog.
3. Preserve real Aurora SDK/Gateway/platform truth; keep demo data labeled; no
   task/debug/evidence/generated wording; zero em-dashes.
4. Screenshot mock+prod at 1440x1024 and 390x844 before/after each route; meet the
   Section 9 acceptance criteria; run the verification commands after each meaningful pass.
```
```
