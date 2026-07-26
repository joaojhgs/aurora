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
Browser reconnect material is memory-only; desktop/mobile shells delegate
opaque credential status, proof, and deletion operations to their native
stores. UI components receive typed controller state and actions and never
hold raw MQTT clients, peer connections, room passwords, long-lived peer
tokens, SDP, or ICE credentials.

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
