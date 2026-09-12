# PyQt UIBridge integration reference

**Status:** Legacy/current bridge reference

This document describes the optional PyQt UIBridge fallback. It is not the primary architecture for new production UI work. For the current SDK-first React/web/Tauri architecture, start with [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md).

## Scope

The PyQt bridge remains useful as:

- a local fallback UI when enabled in configuration;
- a behavior reference for bus topics and UI status transitions;
- a migration aid when adding SDK/Tauri parity for older desktop workflows.

New production screens should use `@aurora/client` and shared React UI primitives instead of direct Qt callbacks or Python service objects.

## Runtime model

- PyQt runs in the main thread.
- Aurora services run under the supervisor and communicate through the message bus.
- UI events are bridged into bus requests/events with typed contract models.
- Backend events are bridged back into Qt signals for display.

## Migration boundary

When replacing PyQt behavior in React/Tauri:

1. Identify the bus topic or contract method used by PyQt.
2. Add or confirm SDK method/event coverage.
3. Add UI tests that use SDK fixtures or transports.
4. Add Tauri-local evidence only through the narrow command bridge when native/local behavior is required.
5. Keep screen components free of raw `fetch`, Tauri `invoke`, direct WebRTC, or Python-service imports.

See [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md) for enforceable source rules.

## Related docs

- [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md)
- [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md)
- [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md)
- [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md)

## Legacy UIBridge contract inventory

The PyQt bridge remains a compatibility and regression surface while the SDK-first UI is the primary path. The unit contract test intentionally checks that this document still names every legacy surface that a replacement must preserve or intentionally retire.

### Qt signals

- `message_received`
- `transcription_received`
- `tts_started`
- `tts_stopped`
- `status_changed`

### Bus subscriptions

- `STTMethods.USER_SPEECH_CAPTURED`
- `STTMethods.SESSION_STARTED`
- `OrchestratorMethods.RESPONSE`
- `TTSMethods.STARTED`
- `TTSMethods.STOPPED`

### Bus publications and requests

- `OrchestratorMethods.USER_INPUT`
- `TTSMethods.STOP`
- `DBMethods.GET_MESSAGES_FOR_DATE`

### UI callbacks

- `ui_window.user_message_signal`
- `ui_window._stop_tts_callback`

A React/Tauri replacement must map these surfaces through the typed SDK transport and event stream rather than calling service methods directly.
