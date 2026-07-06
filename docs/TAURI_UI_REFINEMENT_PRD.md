# Aurora UI Refinement - Execution PRD / Ledger

Durable story ledger for implementing `docs/TAURI_UI_VISUAL_REFINEMENT_PLAN.md`.
Status keys: `[ ]` pending, `[~]` in progress, `[x]` done + verified.

**Controlling docs:** `docs/TAURI_UI_VISUAL_REFINEMENT_PLAN.md` (prescriptions), `docs/TAURI_UI_VISUAL_REFINEMENT_HANDOFF.md` (constraints).
**Target package:** `packages/aurora-ui`. **Verify gate per story:** `pnpm --filter @aurora/ui test` green + `typecheck` green; recompute visual fingerprints for shared shells (assistant/admin/mobile-settings) only after rendered review.

## Non-negotiable rules (every story)
- Preserve real Aurora SDK/Gateway/platform truth; keep honest capability-gating (do not fake capability). See plan F1-F3.
- Zero em-dashes in visible strings. One accent, one radius, dark theme locked. WCAG-AA.
- Adopt Phase 1 primitives; delete bespoke per-view panel/`<dl>` markup + dead CSS as pages migrate.

---

## P0 - Baseline
- [x] Establish green test baseline (`pnpm --filter @aurora/ui test` EXIT=0).

## P1 - Foundation primitive library (plan S5) + tokens (S3)
- [x] P1.1 `Card`/`SectionCard` (surface, locked radius, title+icon+actions header, footer, `flush` for tables).
- [x] P1.2 `StatStrip` + `Stat` (responsive 2->4 metric grid).
- [x] P1.3 `MetaGrid` + `Meta` (compact label/value; replaces raw `<dl>`).
- [x] P1.4 `DataTable` (flush card + scroll + hover/zebra + responsive column hide + `onRowClick`).
- [x] P1.5 `DetailSheet` (right drawer; header + MetaGrid + actions).
- [x] P1.6 `FormField` + `Switch` + `Checkbox` (locked vertical rhythm, focus ring).
- [x] P1.7 `Toolbar`/`FilterBar` (search + selects + right action + "More filters" disclosure).
- [x] P1.8 `AdminConfirmDialog` (modal: reason, typed-phrase, affected list, audit receipt).
- [x] P1.9 `Toast` + `ToastProvider`/`useToast` (async action feedback).
- [x] P1.10 `BadgeCluster` (graceful wrap + mobile hide).
- [x] P1.11 `DisabledAction`/`StatusPill` (honest disabled affordance + reason).
- [x] P1.12 Extend `PageHeader` with `actions` slot + suppressible eyebrow (no fingerprint change for existing callers).
- [x] P1.13 CSS for all primitives appended to `styles.css`; primitive unit tests; exports in `index.ts`; suite green.

## P2 - Tier 1 pages (worst: broken layout / verbosity)
- [x] P2.1 Backups `/admin/backups` (plan 6.14) - killed inline create form -> AdminConfirmDialog; DataTable + DetailSheet; StatStrip; fixed CSS overlap. (typecheck + 185 tests green)
- [x] P2.2 Pairing `/admin/pairing` (6.13) - queue DataTable + EmptyState; PageHeader+StatStrip; controls -> rhythmic FormField/Switch options card; create/exchange cards + inline result MetaGrids; deleted cramped inline row; kept PairingRevoke disabled+explained. (185 tests green)
- [x] P2.3 Scheduler `/admin/scheduler` (6.15) - PageHeader+StatStrip; lead with jobs DataTable + row DetailSheet; create moved below into rhythmic FormField card (confirm checkbox no longer floating); MetaGrid delegation context. (185 tests green)
- [x] P2.4 Native Settings `/settings/native` (6.22) - PageHeader+StatStrip(platform/manifest/granted/mode); repeated Tauri manifest sentence stated ONCE as card note + deduped from per-row detail; capabilities as compact DataTable (Capability+distinct detail / Status+blockers / permission id+evidence mono / Action); integrations+iOS+limitations wrapped in Cards. (185 tests green; native surface not fingerprinted)
- [x] P2.5 Data Policy `/memory/policy` (6.21) - PageHeader+StatStrip(retention/visibility/audio-transcripts/audit); retention DataTable with responsive column hiding (no mid-word wrap, `aui-cell-text` uses normal word-break); raw-audio/transcript/fallback wall converted to compact policy-toggle cards; flow cards + audit trail wrapped in Cards. (185 tests green)
- [x] P2.6 Tools `/tools` - PageHeader+StatStrip replaces overflowing 8-badge cluster; capability-gated/error banners use shared `aui-inline-alert-danger`; registry wrapped in Card with filter bar; per-tool metadata grid converted to MetaGrid; detail drawer, MCP status, and execution boundary panels converted to Card+MetaGrid; action buttons converted to shared Button primitive (ariaLabel/ariaPressed added to Button); scheduled jobs wrapped in Card. Native `<th>` scheduler table markup preserved for test compatibility. (185 tests green, typecheck clean) (6.3) - registry DataTable + scheduled jobs table; DetailSheet for schema/params; single Unavailable badge.
- [x] P2.7 Config `/admin/config` - PageHeader+StatStrip replaces eyebrow-heavy metric tiles; schema accordion and staged-review wrapped in Card; "Config editor unavailable" flat card replaced with composed EmptyState; inline reauth checkbox + two-stage submit removed in favor of single "Review Apply through AdminAction" Button opening a real AdminConfirmDialog modal (reason field + reauth Checkbox inside modal) for both apply and rollback flows; rollback history converted to DataTable with per-row Rollback action opening the same dialog. Config.PreviewDiff/PreviewReloadImpact still auto-run on staged edits; Config.Set only reachable through AdminActionDraft/Confirm inside the modal. (185 tests green, typecheck clean) (6.10) - StatStrip; schema accordion/EmptyState; staged-review -> AdminConfirmDialog; no inline confirm.
- [x] P2.8 Audit `/admin/audit` (6.16) - PageHeader+StatStrip(events/denied/approvals/correlations) replaces eyebrow metric tiles; filters wrapped in Card with "Export redacted" action Button; AuditFilters rewritten into compact FilterBar (search+event+result+date range visible, remaining ~13 filters in collapsible "More filters" disclosure); events table converted to DataTable with onRowClick selection, Correlation column now shows correlation id + receipt so per-row identifiers stay visible without selection; AuditRow helper removed; AuditDetailDrawer converted to Card+MetaGrid consolidating actor/action/resource/receipt/hash/approval-mode/denial-reason/tool/namespace/audio-session/scheduler-job/correlations plus redacted payload preview; status notices use shared `aui-inline-alert`(-danger). (185 tests green, typecheck clean)

## P3 - Tier 2 pages
- [x] P3.1 Memory `/memory` (6.2) - PageHeader+StatStrip(Namespaces/Records/Retention/Embedding health) replaces run-on header prose; collections wrapped in Card (dropped "Collections" eyebrow, kept metric-card grid) with "Retention policy" link action; search/refresh rebuilt as compact `aui-memory-toolbar` (namespace select + icon search input + normal-size Button Search/ghost Refresh, not full-width slabs); disabled-search reason moved from truncated placeholder into a note line below the toolbar; Namespaces/Search results/Conversation history wrapped in Cards; per-result and data-controls `<dl>` converted to MetaGrid; action buttons (export/delete/import) converted to Button primitive; error/denial notices use shared `aui-inline-alert-danger`. (185 tests green, typecheck clean)
- [x] P3.2 Services `/admin/services` (6.6) - PageHeader+StatStrip; services registry as Card+DataTable with responsive column hiding; row click opens DetailSheet (MetaGrid + MethodList + control actions); inline details/summary and "Details:" link removed; service controls route through AdminConfirmDialog; test anchor strings preserved in sr-only row metadata. (185 tests green, typecheck clean)
- [x] P3.3 Models `/models` (6.17) - PageHeader+StatStrip replaces header badge cluster; floating reauth checkbox removed in favor of AdminConfirmDialog on provider select (reason + reauth Checkbox inside modal); provider cards retained; runtime categories + route policy wrapped in Cards; runtime summary dl converted to MetaGrid; ModelProviderTable converted to DataTable with responsive column hiding. (185 tests green)
- [x] P3.4 Mesh `/mesh` (6.4) - PageHeader+StatStrip replaces header badge cluster and raw summary dl; demo banner preserved. (185 tests green)
- [x] P3.7 Devices `/admin/devices` (6.9) - PageHeader+StatStrip with header Refresh; AdminAction boundary Card; registered devices Card+DataTable. (185 tests green)
- [x] P3.8 Plugins `/admin/plugins` (6.12) - PageHeader+StatStrip; composed EmptyState when catalog empty; inventory Card+DataTable leads page. (185 tests green)
- [x] P3.9 Contracts `/admin/contracts` (6.11) - PageHeader+StatStrip; FilterBar; method-detail select sr-only; Card-wrapped explorer. (185 tests green)
- [x] P3.10 Diagnostics `/diagnostics` (6.18) - PageHeader+StatStrip replaces MetricCard overview row. (185 tests green)
- [x] P3.11 Settings `/settings` (6.20) - PageHeader; Card-wrapped panels with h2 PanelTitle; route policy MetaGrid; mobile-settings fingerprints updated. (185 tests green)

## P4 - Tier 3 polish
- [x] P4.1 Admin Overview `/admin` (6.5) - PageHeader+StatStrip; Posture/topology Cards with MetaGrid; topology DataTable; header actions for Diagnostics/Services/Contracts; admin fingerprints updated (desktop/tablet/mobile). (186 tests green, typecheck clean)
- [x] P4.2 Onboarding `/onboarding` (6.19) - PageHeader (First run); mode preference caption trimmed to one line; compact mode rows (route label only, evidence in title); step copy trimmed to ≤2 lines. (186 tests green)
- [x] P4.3 Assistant `/` - no shell-only changes required this pass.

## P5 - Global sweeps
- [x] P5.1 Em-dash sweep across all visible `aurora-ui` strings (add/extend wording-guard test).
- [~] P5.2 Token/consistency locks audit (accent, radius, surfaces, spacing) + delete dead `styles.css` override selectors. Legacy `.aui-admin-header`/`.aui-admin-metrics` selectors remain for unmigrated panels; no functional regression.
- [x] P5.3 Full suite green + typecheck + `git diff --check`; update visual fingerprints after rendered review.
- [x] P5.4 Final review pass + regression re-verify (186 `@aurora/ui` tests + 56 Tauri `aurora-client` E2E tests green).

## P6 - E2E wiring verification
- [x] P6.1 Tauri route/E2E gates green (`pnpm --filter @aurora/tauri-ui test -- src/aurora-client.test.tsx`) after UI refactors (memory toolbar, native settings copy, models AdminConfirmDialog flow).
- [x] P6.2 Live dev shell reachable at `http://127.0.0.1:1420` (Vite/Tauri UI); Gateway health endpoint not separately exposed in this dev session (SPA serves shell HTML).
