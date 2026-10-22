# design-sync notes — @aurora/ui-mock-reference

## Repo shape

- No dist/library build exists (this is a Next.js app, not a publishable
  package) — the converter runs in synth-entry mode, scraping
  `components/ui/**` and `components/aurora/**` directly. `buildCmd` in
  config.json runs `pnpm build` (needed for compiled Tailwind CSS, not the
  component bundle itself) plus a copy step for cssEntry/fonts (see below).
- `cssEntry` cannot point at `app/globals.css` directly — that file is raw
  Tailwind v4 source (`@import 'tailwindcss'` etc.), not compiled utility
  CSS. `cfg.cssEntry` points at `.design-sync/.cache/compiled/app.css`,
  populated by `buildCmd` from `next build`'s single output chunk
  (`.next/static/chunks/*.css` — this app only ever emits one). The
  `../media/*.woff2` sibling files (Geist fonts, self-hosted via
  `next/font`) are copied alongside into `.design-sync/.cache/media/` so
  the compiled CSS's relative `url()` refs resolve — **don't move the CSS
  file without preserving that sibling layout**, extractFonts resolves
  `url()` relative to the CSS file's own directory.
- Only one CSS chunk is emitted by `next build` today (verified for this
  build). If the app grows enough that Next starts splitting CSS across
  routes, `buildCmd`'s `cp .next/static/chunks/*.css` will silently pick
  only one — watch for that if fonts/utility classes start going missing
  after unrelated app changes.

## excludeSrcFiles / AppShell

- `components/aurora/app-shell.tsx` imports `next/link` + `next/navigation`.
  Bundling it (synth-entry re-exports every file under `srcDir`) pulls
  Next's router runtime into the single shared IIFE, which references many
  `process.env.__NEXT_*` flags with no browser `process` global —
  `ReferenceError: process is not defined` at bundle-load time, which broke
  **every** component's `window.Aurora` export, not just AppShell's.
- Also: `AppShell` calls `usePathname()`, which throws outside a real
  Next.js app-router context anyway — it's fundamentally not portable to
  arbitrary React apps the design agent might build, independent of the
  bundling bug.
- Fix: forked `lib/source-kit.mjs` (allowed — only `bundle.mjs`/`emit.mjs`
  are off-limits) to add a new `cfg.excludeSrcFiles` field that drops
  listed repo-relative paths from both the synth-entry scan and component
  derivation before either runs. Also forked `lib/common.mjs` to add
  `'excludeSrcFiles'` to `CONFIG_KEYS` (schema validation is strict on key
  names). Both forks declared in `cfg.libOverrides`.
- **Known limitation of this approach**: `componentSrcMap` positive
  (non-null) entries do NOT compose with synth-entry fallback discovery —
  adding even one positive entry makes the tool treat the config's
  positive entries as the *entire* component list (skips
  `deriveComponentsFromSrc` since the gating check is `!components.length`,
  and a non-empty `names` set from config short-circuits it). Only use
  `componentSrcMap` with `null` values (exclusions) in this repo; never add
  positive src-path pins. This is why the ~14 components whose name doesn't
  match their file name (the 9 status badges in `status-badges.tsx`, plus
  `AdminOverview`/`AdminSecondarySurface`/`Avatar`/`AvatarGroup`) are stuck
  in the `general` group instead of their real subdirectory — cosmetic only,
  not worth fighting the tool for.
- `Cpu` (a re-exported lucide-react icon from `status-badges.tsx`, not a
  real component) is excluded via `componentSrcMap: {"Cpu": null}`.

## Playwright / render check

- No `playwright`/`playwright-core` dependency exists anywhere in this
  monorepo, but chromium builds 1223 and 1228 were already cached at
  `~/.cache/ms-playwright/` from unrelated prior tooling. Installed
  `playwright-core@latest` + `playwright@latest` into `.ds-sync/` — its
  pinned chromium build is 1228, already cached, so no ~200MB download was
  needed. If this ever needs a fresh install, re-check the cache first.

## Preview-authoring convention: themed wrapper is mandatory

**Every authored preview (`.design-sync/previews/<Name>.tsx`) must wrap its
returned JSX in a themed backdrop div**, e.g.:

```tsx
<div className="rounded-lg bg-background p-6 text-foreground">
  {/* story content */}
</div>
```

Why: the converter's card template (`lib/emit.mjs`, off-limits to fork)
hardcodes `body{background:#fff}` inline in every generated `<Name>.html`,
which — same CSS specificity, declared after the linked stylesheet — wins
the cascade over this app's own `body{background-color:var(--background);
color:var(--foreground)}` rule. This app's `--foreground` is a near-white
color designed to sit on the dark `--background`, so any component that
doesn't provide its OWN explicit background (unlike `Card`/`Badge`/`Button`
default variant, which set `bg-card`/`bg-primary`/etc. on themselves) ends
up rendering near-white text on the forced white body — nearly invisible.
Confirmed on `Table` (plain cell text, no self-contained surface) and
`Button`'s `ghost` variant (no background until hover, so its default
state has no explicit text color either).

There is no config lever for this (checked `emit.mjs`, `common.mjs`,
`package-build.mjs` — no `previewBackground`/`cardBackground`-shaped key).
Composing the theme backdrop in the authored preview is the correct fix
per the skill's own philosophy — it's providing missing page-level theme
context, not faking styling the component doesn't have.

**Every subagent authoring previews in later waves must follow this
convention.** Components with their own explicit surface (Card, Dialog's
popup, Badge, Button's non-ghost variants) don't strictly need the wrapper
for legibility, but wrapping them anyway is harmless and more faithful to
how they actually appear in the real dark-themed app — do it for every
component for consistency.

## `p-6` is not compiled by the real app's Tailwind build — safelisted

- The mandatory themed-wrapper convention above (`rounded-lg bg-background
  p-6 text-foreground`) uses bare `p-6`, but the real app never uses
  unprefixed `p-6` anywhere in its own source — only `sm:p-6` (e.g.
  `space-y-6 p-4 sm:p-6` in the view components). Tailwind v4's JIT scans
  the app's own source for exact class usage (not `.design-sync/previews/`),
  so the base `.p-6` utility was never generated — confirmed absent from
  `.design-sync/.cache/compiled/app.css` (`.p-0`…`.p-4` all present, `.p-6`
  missing) while `bg-background`/`rounded-lg`/`text-foreground` all compile
  fine (used unprefixed elsewhere in the app).
- **Effect**: every preview's outer wrapper div silently rendered with zero
  padding — invisible on content-heavy previews (Card, Dialog: their own
  internal `CardHeader`/`CardContent` padding already compiles, so the
  missing outer inset was easy to miss), catastrophic on `Progress`: with
  no other content providing height, its card collapsed to the bare
  `h-1` (4px) track with no visible background inset at all —
  `package-validate.mjs` correctly flagged this `[RENDER_BLANK]`/`bad:true`.
- **Fix**: `buildCmd` now appends `.p-6{padding:calc(var(--spacing) * 6)}`
  to the cached CSS after the copy step (mirrors the compiled `.p-4` rule's
  `calc(var(--spacing) * N)` form so it tracks the same `--spacing` base
  the rest of the scale derives from). This is a design-sync-only safelist
  patch to the tool's cached CSS copy — it does not touch the real app's
  Tailwind config or source. Applied retroactively to the already-cached
  `.design-sync/.cache/compiled/app.css` for this sync; `buildCmd` carries
  it forward for every future `pnpm build` re-run.
- **Watch for the general case**: any authored preview using a spacing/sizing
  utility that isn't used bare anywhere in the real app's own source will
  hit this same silent-no-op failure mode, not just `p-6`. A future preview
  that looks unexpectedly cramped/collapsed with no build error is the
  symptom — check `grep '\.<class>{' .design-sync/.cache/compiled/app.css`
  before assuming the component itself is broken.

## Re-sync risks

- The `buildCmd` copy step assumes exactly one CSS chunk under
  `.next/static/chunks/`. If Next's bundling strategy changes (more
  routes, different splitting), the glob may pick the wrong chunk or fail.
  Re-verify chunk count after any significant app/route change.
- `componentSrcMap` grouping gaps (see above) are stable/known, not a
  regression — don't spend time "fixing" the `general` bucket unless the
  underlying tool grows a way to add enrichment-only src pins without
  disabling synth-entry's full-repo scan.
- The `excludeSrcFiles` fork means any OTHER component added later that
  imports `next/*` modules will reproduce the exact same bundle-wide
  `process is not defined` failure. Watch for it if new aurora components
  get added to this design system between syncs — same root cause, same
  fix (add to `excludeSrcFiles`), but each new offender needs a fresh
  `[BUNDLE_EXPORT]`/`[RENDER_ERRORS]` diagnosis for confirmation.

## Full-page view assemblies (AuditView, ConfigView, DevicesView, RbacView,
ServicesView, TokensView, AssistantView, RouteSheet, ToolCallCard,
DiagnosticsView, MeshView, ModelsView, OnboardingView,
SettingsPermissionsView, AdminOverview, AdminSecondarySurface)

- All 16 mount with zero props under `app/(cockpit)/**`, except
  `AdminSecondarySurface` (`surface: 'contracts'|'plugins'|'pairing'|'backups'`,
  a locally-defined non-exported union) and `RouteSheet`/`ToolCallCard`
  (used internally by `AssistantView`, not mounted directly — take real
  props: `open`/`onOpenChange`/`selected`/`onSelect` and `call`/`onDecision`
  respectively).
- `lib/aurora/data.ts` / `lib/aurora/types.ts` are NOT reachable from
  `@aurora/ui-mock-reference` (`cfg.srcDir` is `"components"` only). For
  `RouteSheet`/`ToolCallCard`, the fix is inlining the needed type/data
  shape directly in the preview file (local `RouteKind` type alias; a plain
  `ToolCall`-shaped object literal) rather than importing from `lib/`. Same
  inlining approach needed for any later component that takes `lib/aurora`
  data as a prop instead of importing it internally.
- Screenshot capture viewport is fixed at 900x700 (`package-capture.mjs`)
  unless `cfg.overrides.<Name>.viewport` is set. All 16 views are taller
  than 700px and get cropped with no scroll capture — not fixable from the
  preview itself; graded "good" on the visible portion per the rubric's
  Plausible guidance. `AdminSecondarySurface`'s `Contracts` state needed
  (and now has) `cfg.overrides.AdminSecondarySurface = {"viewport":
  "1300x700"}` for its 6-column table (widening the preview's own wrapper
  div has zero effect on the capture crop — only the config override works).
- `AssistantView` (root `flex h-full min-h-0`) and `RouteSheet` (fixed/overlay
  sheet) both need an explicit `h-[700px]` on the preview's wrapper div to
  render at all — `h-full` collapses to 0 with no ancestor height.
- `AdminOverview`/`AdminSecondarySurface` land in the `general` tool group —
  expected, matches the `componentSrcMap` grouping quirk above.
- Preview pattern used for all 16: `<div className="rounded-lg bg-background
  p-6 text-foreground min-w-[900px]"><ViewName /></div>`, importing only
  `<ViewName>` from the package (no fixture re-import needed — each view
  imports its own fixture data internally).

## Known render warns

- `AdminConfirmDialog` and `CapabilityDrawer` trip `[RENDER_THIN]` ("rendered
  height is 0px") in `package-validate.mjs` despite already being fully
  authored with `cfg.overrides.<Name> = {"cardMode": "single", ...}`. Root
  cause: both are portal-rendered overlays (Base UI teleports the open
  content to `document.body`), so the `#r0` mount root the checker measures
  stays 0px tall even though the actual dialog/sheet renders correctly
  elsewhere in the DOM. Confirmed benign by inspecting the screenshots
  directly (`_screenshots/aurora__AdminConfirmDialog.png`,
  `_screenshots/aurora__CapabilityDrawer.png`) — both show a fully composed,
  correctly styled overlay. `bad: false` in `.render-check.json` for both
  (non-blocking warn, not a gate failure). `Dialog`/`Sheet`/`RouteSheet` are
  the same portal shape and don't trip this — likely timing/portal-mount-order
  dependent; not worth chasing further.
- `DropdownMenu` tripped `[GRID_OVERFLOW]` (portal content escapes its grid
  cell) — fixed with `cfg.overrides.DropdownMenu = {"cardMode": "single",
  "primaryStory": "Default"}`, the standard remedy for this tag.
- `Toaster`'s `Default`/`Success`/`ErrorState` cells grade `needs-work`:
  `sonner`'s toast queue is module-level singleton state, and the preview
  bundler inlines a separate copy of `sonner` into the shared library bundle
  vs. each preview's own bundle — `toast()` calls from the preview never
  reach the rendered `Toaster` instance's copy. Confirmed via bundle
  inspection (`toastsCounter` symbol present separately in both
  `_ds_bundle.js` and `_preview/Toaster.js`). Not fixable from the preview
  `.tsx` alone — would need `sonner` externalized and shared across both
  bundle entry points, which is `bundle.mjs`/`emit.mjs` territory (off-limits
  to fork). Deferred; re-check if the converter ever gains a shared-externals
  mechanism for preview bundling.
