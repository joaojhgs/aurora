# @aurora/ui

Production React shell primitives for Aurora. Components consume normalized SDK state only; they do not call Gateway, Tauri IPC, Python services, or raw WebRTC APIs directly.

The package supplies the shared assistant, operator, administration, mesh, tooling, onboarding, and settings surfaces used by hosted web and Tauri shells. Runtime behavior remains capability-gated and surface-aware rather than assuming every client has the same native features.

## Thin-client runtime

`src/web-thin-runtime.ts` is the UI-facing adapter for the shared browser/WebView
transport implemented by `@aurora/client/webrtc`. Hosted web, desktop Tauri
thin, Android thin, and the iOS thin source path use the same runtime with one
of three explicit policies:

- `http-only` uses the configured HTTPS Gateway transport.
- `webrtc-only` uses WSS signaling and the `aurora-rpc` WebRTC DataChannel. It
  does not require or silently fall back to an Aurora HTTP application server.
- `webrtc-preferred` selects an authorized WebRTC route for new calls and may
  use an explicitly configured HTTPS Gateway as fallback. It never replays an
  uncertain in-flight mutation automatically.

Connection profiles contain only nonsecret endpoint and stable-peer metadata.
Hosted web encrypts reconnect and room-secret material with an origin-scoped,
non-extractable WebCrypto key before IndexedDB persistence and falls back to
memory-only when that vault is unavailable. Desktop/mobile shells delegate
opaque credential status, proof, and deletion operations to their native
stores. UI components receive typed controller state and actions and never
hold raw MQTT clients, peer connections, room passwords, long-lived peer
tokens, SDP, or ICE credentials.

Thin first-run onboarding is intentionally invite-first. It asks only for the
local node name and an Aurora mesh invite supplied by QR on mobile, file import,
deep link, or paste. The invite fills signaling and pairing material
automatically; profile names, modes, Gateway/signaling endpoints, and stable
peer identifiers remain available from the normal connection settings after
onboarding. Full-screen onboarding owns its own touch-scroll viewport because
the production application shell intentionally locks document scrolling.

`BrowserThinRuntimeConfig.rolloutFlags` provides reversible gates for the
WebRTC entry point, scoped subscriptions, fragmentation/backpressure, and
optional application-layer E2EE. Defaults preserve the current protocol.
Disabling `webrtc_thin_client` sends `webrtc-preferred` to its configured HTTP
transport, keeps `webrtc-only` fail-closed, and leaves saved peer credentials
untouched. Capability gates change the local protocol hello, so Python and
TypeScript both use only the negotiated intersection. An E2EE-required profile
never silently downgrades to plaintext.

Voice ownership is centralized in `src/platform-surface.ts`. Focused
push-to-talk and waveform capture use browser/WebView microphone APIs when the
surface permits them. Desktop-local background wakeword remains owned by the
Python `STTCoordinator`; thin web/mobile surfaces do not claim durable
background listening without separately proven native adapters.

## Canonical docs

- [Frontend and UI architecture](../../docs/FRONTEND_AND_UI_ARCHITECTURE.md)
- [UI client-surface roadmap](../../docs/UI_CLIENT_SURFACE_ROADMAP.md)
- [Current UI client-surface status](../../docs/UI_CLIENT_SURFACE_STATUS.md)
- [WebView WebRTC protocol contract](../../docs/WEBVIEW_WEBRTC_PROTOCOL_CONTRACT.md)
- [Production UI contracts](../../docs/PRODUCTION_UI_CONTRACTS.md)
- [Accessibility/responsive/visual tests](../../docs/ACCESSIBILITY_RESPONSIVE_VISUAL_TESTS.md)

## UI ownership boundaries

`src/feature-manifest.tsx` is the package source for Aurora route identity, route copy, navigation metadata, availability policy, and lazy route entries. Web and Tauri hosts should project route adapters from the manifest and keep host-specific chrome, shell wiring, and platform bridges in their own files.

TanStack Query owns server, peer, and route data fetching. Query subscriptions and live shell events update cached server snapshots when a host can provide events. Routes that still need a timed safety refresh use the shared 15 second query fallback family from the query layer instead of route-local polling loops.

Zustand stores own client state such as the active surface, connection profile state, and local stream buffers. Server or peer records should not be moved into zustand stores to avoid creating a second cache beside Query.

Decomposition helpers should preserve existing public view props and route resource exports. Hooks such as `usePeerRoster` and `useSpeechCatalog`, diagnostics controllers, and section helpers are package-internal unless they are intentionally promoted through `src/index.ts` or a documented package subpath for a host adapter.

When adding a new route, update the feature manifest first, then derive nav, shell, product copy, web route registry, and Tauri route projections from that entry. A route should not add a parallel manual inventory unless the host needs platform-specific adapter metadata that cannot belong in the shared manifest.

## Styling contract

Edit `src/styles.input.css`, then run `pnpm --filter @aurora/ui build:styles`.
Tailwind v4 generates `src/styles.css`, exported as `@aurora/ui/styles.css`,
and copies it into `dist`. Never hand-edit the generated stylesheet. Hosts
import the shared output; add app source paths to the shared pipeline when needed.
Use theme tokens from `@theme`, existing `components/ui` primitives, and static
utilities in JSX. Delete owned CSS rules when their consumers move to utilities.

Run `pnpm --filter @aurora/ui check:styles` to check generated coverage and
`pnpm --filter @aurora/ui test:styles` for guardrail regression tests.
`scripts/style-guardrail-inventory.json` records the compatibility budget; new
custom classes or unresolved dynamic class sites require explicit review.
Do not add empty selectors or blanket exceptions to silence missing-style errors.
Retained CSS handles shared component descendants, platform viewport/keyboard
state, safe-area sizing, older WebView fallbacks, and animation keyframes.
Development preview overrides stay isolated in the debug-only web module.

## Public exports

`package.json` defines supported subpaths. Web and Tauri use explicit view and
runtime subpaths for lazy route loading and host adapters. Preserve public
exports when decomposing a view; private helpers remain internal. The
`./components/*`, `./lib/*`, and `./hooks/*` patterns are compatibility surfaces.
Removing a public export requires considering both repository imports and
external consumers, separately from unused dependency cleanup.

The root `src/index.ts` barrel is for stable host-facing components, contracts,
and adapters. Prefer an explicit subpath when a host needs only one lazy view or
runtime adapter. Do not promote a hook, store, test seam, or section helper to
the root barrel just because it is exported from its defining file. A workspace
search found no live workspace consumer of the legacy store class, but it cannot
establish compatibility for external package users. PER-282 therefore prunes
the unused `./assistant-stream-store` class export and package subpath as an
intentional API change; external compatibility is unproven. Production
streaming continues to use the Zustand store at
`./state/assistant-stream-store`, which remains exported and covered by the
existing production-store behavior tests.

### Dependency ownership

Every runtime dependency below has a current source importer. Keep this table
aligned with `package.json` when dependencies or UI surfaces change.

| Dependency | Live importer | Surface effect |
| --- | --- | --- |
| `@assistant-ui/react` | `components/assistant-ui/tool-fallback.tsx`, `mermaid-diagram.tsx`, `model-selector.tsx` | Assistant messages, diagrams, and model controls |
| `@assistant-ui/react-markdown` | `components/assistant-ui/mermaid-diagram.tsx` | Markdown rendering types for assistant diagrams |
| `@assistant-ui/react-mcp` | `components/assistant-ui/mcp-config.tsx` | MCP configuration panel |
| `@assistant-ui/store` | `components/assistant-ui/mcp-config.tsx` | Assistant UI state access |
| `@aurora/client` | `assistant-history-model.ts`, `browser-native-capability-pack.ts`, and runtime adapters | Typed SDK, service, and event boundaries |
| `@aurora/voice-web` | `use-assistant-tts.ts`, `browser-speech-pack.ts` | Browser speech and playback |
| `@base-ui/react` | `components/ui/*` | Shared accessible UI primitives |
| `@floating-ui/react` | `components/animate-ui/primitives/animate/tooltip.tsx` | Tooltip positioning |
| `@shadcn/react` | `components/ui/message-scroller.tsx` | Assistant message scrolling |
| `@sqlite.org/sqlite-wasm` | `local-data/browser-sqlite-worker.ts` | Browser-local SQL storage |
| `beautiful-mermaid` | `components/assistant-ui/mermaid-diagram.tsx` | Assistant diagram rendering |
| `class-variance-authority` | `components/ui/field.tsx`, `attachment.tsx`, `sidebar.tsx`, `marker.tsx` | Declarative primitive variants |
| `clsx` | `shadcn-lib/utils.ts` | Conditional class composition |
| `cmdk` | `components/ui/command.tsx` | Command palette behavior |
| `lucide-react` | `feature-manifest.tsx`, `nav.tsx`, and shared views | Product and navigation icons |
| `motion` | `components/animate-ui/*`, `tooling/tool-sharing-controls.tsx` | UI transitions and animated controls |
| `next-themes` | `components/ui/sonner.tsx` | Theme-aware toast presentation |
| `qrcode` | `mesh-peers-sections.tsx` (dynamic import) | Pairing invite QR rendering |
| `radix-ui` | `components/ui/direction.tsx`, `components/assistant-ui/model-selector.tsx` | Direction and select primitives |
| `react` | Shared components and hooks | UI rendering and state lifecycle |
| `react-resizable-panels` | `components/ui/resizable.tsx` | Resizable panels |
| `sonner` | `primitives.tsx`, `components/ui/sonner.tsx` | User notifications |
| `tailwind-merge` | `shadcn-lib/utils.ts` | Utility-class conflict resolution |
| `zustand` | `src/state/{assistant-stream-store,connection-store,surface-store}.ts` | Client-side UI state |
| `@tanstack/react-query` | `query-hooks.ts`, assistant history, peer roster, speech catalog, and data views | Remote/local query caching and synchronization |

`@types/qrcode` is the development type package for the dynamic `qrcode`
import. Other development dependencies serve test, typecheck, coverage, or
style-build workflows rather than production UI behavior.

## View composition

The view modules keep product surfaces together while stateful behavior is
extracted into hooks and focused sections. Current measured sizes are:

| View | Lines | Composition responsibility |
| --- | ---: | --- |
| `assistant-view.tsx` | 728 | Compose assistant session, history, streaming, voice, and execution hooks with the conversation and composer surfaces. |
| `mesh-peers-view.tsx` | 1,082 | Compose peer roster, pairing, connection state, and mesh administration sections. |
| `voice-settings-view.tsx` | 635 | Compose voice catalog, local speech-pack, language, and runtime setting sections. |

PER-282 gives approximate targets of 600 lines for the top-level `AssistantView`
and 400 lines for extracted units; its separate acceptance criterion is that no
`*-view.tsx` exceed approximately 1,500 lines without written justification.
The 728-line `assistant-view.tsx` module includes imports, types, and public
re-exports: exported `AssistantView` is a 9-line provider wrapper, and its
`AssistantQueryView` composition spans 593 lines. Module line count therefore
does not equal the top-level component's size. Further decomposition should
follow existing component or state seams while preserving public props and
behavior; these measurements alone do not claim PER-282 acceptance.
