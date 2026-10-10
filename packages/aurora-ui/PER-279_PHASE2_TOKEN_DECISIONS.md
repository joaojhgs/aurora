# PER-279 Phase 2 CSS/token cleanup decisions

This note records the Phase 2 source-authoring decisions made in the isolated CSS lane. Root owns validation and visual review; this lane did not run builds, tests, audits, browser checks, screenshots, or generated CSS regeneration.

## Dead assistant-ui vendor files

The following vendored assistant-ui files were removed because source reachability showed no imports from Aurora app, package code, or package tests after Phase 1. Runtime assistant UI imports are preserved through `components/assistant-ui/model-selector.tsx` and `components/assistant-ui/tool-fallback.tsx`; test-reachable `components/assistant-ui/mermaid-diagram.tsx` and `components/assistant-ui/mcp-config.tsx` are also preserved.

Removed files: `accordion.tsx`, `assistant-modal.tsx`, `assistant-sidebar.tsx`, `attachment.tsx`, `badge.tsx`, `composer-trigger-popover.tsx`, `context-display.tsx`, `diff-viewer.tsx`, `directive-text.tsx`, `dot-matrix.tsx`, `file.tsx`, `follow-up-suggestions.tsx`, `heat-graph.tsx`, `image.tsx`, `markdown-text.tsx`, `message-timing.tsx`, `number-roll.tsx`, `quote.tsx`, `reasoning.tsx`, `select.tsx`, `shiki-highlighter.tsx`, `sources.tsx`, `syntax-highlighter.tsx`, `tabs.tsx`, `thread-list.tsx`, `thread.tsx`, `threadlist-sidebar.tsx`, `tool-group.tsx`, `tooltip-icon-button.tsx`, and `voice.tsx`.

## Dropped undefined class tokens

These tokens were removed from reachable JSX/TSX instead of being defined as no-op or new visual CSS. They had no legitimate authored style in Phase 1 and adding definitions would change the validated Phase 1 visual surface or only mask the token audit.

| Token | Source decision |
| --- | --- |
| `adx-errors` | Removed from diagnostics error wrapper; the wrapper keeps `role="status"`. |
| `aui-route-policy-signals` | Removed from route policy `<dl>`; the accessible label remains. |
| `aui-runtime-secondary-label` | Removed from the runtime helper paragraph. |
| `aui-spin` | Removed from the model loading icon to avoid adding a new global spinner behavior. |
| `toaster` | Removed from the Sonner wrapper; existing `group` class and inline CSS variables remain. |
| `no-scrollbar` | Removed from sidebar and command list scroll containers. |
| `scroll-fade-b` | Removed from message scroller to avoid adding a new mask fade. |
| `scroll-fade-x` | Removed from attachment list to avoid adding a new mask fade. |
| `shimmer` | Removed from tool fallback trigger overlay and attachment filename state variants. |
| `group-data-[state=processing]/attachment:shimmer` | Removed from attachment filename; no Phase 1 authored shimmer style existed. |
| `group-data-[state=uploading]/attachment:shimmer` | Removed from attachment filename; no Phase 1 authored shimmer style existed. |
| `aui-tool-fallback-root` | Removed; structural grouping remains through `group/tool-fallback-root`. |
| `aui-tool-fallback-duration` | Removed; Tailwind utility classes remain. |
| `aui-tool-fallback-trigger` | Removed; Tailwind utility classes and `data-slot` remain. |
| `aui-tool-fallback-trigger-icon` | Removed; size utility classes remain. |
| `aui-tool-fallback-trigger-label-wrapper` | Removed; layout utility classes remain. |
| `aui-tool-fallback-trigger-shimmer` | Removed from `className`; the `data-slot="tool-fallback-trigger-shimmer"` hook remains for component semantics. |
| `aui-tool-fallback-trigger-chevron` | Removed; size utility classes remain. |
| `aui-tool-fallback-content` | Removed; layout utility classes and `data-slot` remain. |
| `aui-tool-fallback-args` | Removed; the component now passes through caller `className` only. |
| `aui-tool-fallback-result` | Removed; the component now passes through caller `className` only. |
| `aui-tool-fallback-approval` | Removed; utility layout classes remain. |
| `aui-tool-fallback-approval-confirm` | Removed; utility layout classes remain. |
| `aui-tool-fallback-approval-confirm-title` | Removed; `font-semibold` remains. |
| `aui-tool-fallback-approval-confirm-description` | Removed; muted text utility remains. |
| `aui-tool-fallback-approval-confirm-grants` | Removed; list utility classes remain. |
| `aui-tool-fallback-approval-confirm-grant` | Removed; code pill utility classes remain. |
| `aui-mcp-*` marker classes | Removed from preserved `mcp-config.tsx`; utility classes and component primitives remain. |
| `aui-mermaid-*` marker classes | Removed from preserved `mermaid-diagram.tsx`; utility classes and sanitizer/exported logic remain. |
| `aui-md` example marker | Removed from the preserved mermaid source comment example. |

## Kept authored selectors

These class tokens remain because `styles.input.css` contains real authored styles for them and they are part of the reachable `tool-fallback` surface:

- `aui-tool-fallback-result-header`
- `aui-tool-fallback-error-header`
- `aui-tool-fallback-error-reason`
- `aui-tool-fallback-args-value`
- `aui-tool-fallback-result-content`
- `aui-tool-fallback-error`

`@keyframes aui-spin` remains because the authored `.aui-tool-call-running .aui-assistant-tool-trigger > svg:first-child` selector uses it. The standalone `.aui-spin` utility was not kept.

## Not changed in Phase 2

Generated CSS output and package/dependency manifests were left untouched. Dependency pruning for removed vendored code should be considered in a later Phase 5 pass after root validation confirms no reachable imports require those packages.
