# PyQt UIBridge To Tauri/SDK Migration Contract

## Scope

This document is the compatibility contract for replacing the optional PyQt
`UIBridge` with the future `AuroraClient` and official Tauri 2 adapters. It is a
planning and migration artifact only: production screens must still use the SDK
and backend evidence, not direct Qt, Tauri `invoke`, Python service objects, or
raw bus calls.

PyQt remains a dev/local fallback until the SDK event stream and Tauri local
transport cover the rows below with tests. Removing PyQt from release packaging
is blocked until the checked inventory in this document and
`tests/unit/app/ui/test_uibridge_migration_contract.py` passes against the
implemented SDK/Tauri equivalents.

## Compatibility Mapping

| Legacy PyQt bridge surface | Current bus topic or callback | Current payload/status | Future AuroraClient/Tauri contract | Production UI behavior | Status |
| --- | --- | --- | --- | --- | --- |
| `ui_window.user_message_signal` callback | publishes `OrchestratorMethods.USER_INPUT` | `UserInput(text, source="ui")`, command priority interactive, `origin="internal"` | `client.assistant.sendMessage({ text, source: "desktop" })` over the active SDK transport; Tauri local mode may use a typed native transport adapter internally, but screens stay SDK-only. | Assistant text chat sends user text, enters pending/processing from backend request/event evidence, and renders the assistant response when `OrchestratorMethods.RESPONSE` arrives. | Supported by `UIA-001`; SDK method/event parity required before PyQt removal. |
| `ui_window._stop_tts_callback` callback | publishes `TTSMethods.STOP` | `TTSStop()`, command priority interactive, `origin="internal"` | `client.voice.stopPlayback()` or an interrupt wrapper that calls the typed TTS/Orchestrator interrupt contract when available. | Stop speaking control is enabled only when backend TTS playback evidence says speaking/playing; result returns to idle from backend event, not optimistic local state. | Supported locally; should migrate to `BE-009`/voice interrupt semantics when available. |
| `message_received` Qt signal and `ui_window.signals.message_received.emit(...)` | receives `OrchestratorMethods.RESPONSE`; history load emits from `DBMethods.GET_MESSAGES_FOR_DATE` response; STT final emits user message | Assistant text from `LLMResponseReady.text`; history rows as `content`, `role`, optional `metadata.source_type`; STT user message source `"STT"` | `client.events.on("assistant.response")`, `client.history.listToday()` or `client.conversations.list({ date })`, and `client.events.on("voice.transcription.final")`. | Chat transcript preserves user/assistant role, source type, ordering from backend timestamps when exposed, and never invents remote/RAG provenance absent backend evidence. | Supported for local chat/history; richer history/RAG provenance waits for `UIA-006`/`BE-017`. |
| `transcription_received` Qt signal | legacy declared signal; bridge currently routes final STT text through `ui_window.signals.message_received` from `STTMethods.USER_SPEECH_CAPTURED` | `STTUserSpeechCaptured(text, is_final=True, confidence, session_id)` | `client.events.on("voice.transcription.final")` with session ID, text, confidence, local/remote provider, consent/privacy evidence when exposed. | Voice transcript appears as a user message only for final backend transcription; partial text requires a separate event-stream contract before UI may show it as live text. | Declared but not emitted directly today; preserve through SDK event stream rather than a dedicated screen signal. |
| `tts_started` Qt signal | subscribes to `TTSMethods.STARTED` | `TTSStarted(text)` and status `"speaking"` | `client.events.on("voice.tts.started")` with text preview only when safe to display and provider/target evidence for remote/native playback. | Speaking state and stop control are backend-proven; remote playback requires explicit target/consent before the UI claims a peer/device is speaking. | Supported locally by `UIA-004`; remote playback remains privacy-blocked until audio session contracts prove target and consent. |
| `tts_stopped` Qt signal | subscribes to `TTSMethods.STOPPED` | no payload consumed; status `"idle"` | `client.events.on("voice.tts.stopped")` with reason/request ID when backend exposes them. | UI exits speaking state only from the backend stop/completed/error event and should show reason when available. | Supported locally; reason display is a non-blocking SDK enhancement. |
| `status_changed` Qt signal and `ui_window.signals.status_changed.emit(...)` | derived from `STTMethods.SESSION_STARTED`, `STTMethods.USER_SPEECH_CAPTURED`, `OrchestratorMethods.RESPONSE`, `TTSMethods.STARTED`, `TTSMethods.STOPPED` | `"listening"`, `"processing"`, `"idle"`, `"speaking"` | `client.events.on("assistant.status")` as a normalized view model derived from backend STT/orchestrator/TTS events with correlation/session IDs where available. | Status labels must stay evidence-backed: listening from STT session, processing from final transcription or accepted text request, speaking from TTS started, idle from response/stop completion. | Supported locally; cross-transport stream belongs to `SDK-011`/`BE-003`. |
| Startup history load | requests `DBMethods.GET_MESSAGES_FOR_DATE` | `DBGetMessagesForDateRequest(date=None)` and response messages list | `client.history.listToday()` or conversation history SDK method over Gateway/local transport. | Assistant history screen restores today's local messages without exposing raw DB paths or raw SQL; remote memory/RAG provenance remains gated. | Supported locally; production memory/RAG UX waits for `UIA-006`/`BE-017`. |
| STT session started handler | subscribes to `STTMethods.SESSION_STARTED` | payload not consumed; status `"listening"` | `client.events.on("voice.session.started")` with session ID/wake evidence when available. | Voice UI may show listening only after backend STT session evidence; remote/live audio requires privacy indicator and consent evidence. | Supported locally; remote/live claims remain privacy-blocked. |
| STT final transcription handler | subscribes to `STTMethods.USER_SPEECH_CAPTURED` | `STTUserSpeechCaptured(is_final=True)`; status `"processing"`; user message source `"STT"` | `client.events.on("voice.transcription.final")`; optional `client.assistant.events` correlation to orchestrator processing. | Final transcript is added once, with source and session/correlation metadata when available. Partial or non-final events must not be committed as final chat messages. | Supported locally; partial transcript UI is deferred to `SDK-011`/voice tasks. |
| LLM response handler | subscribes to `OrchestratorMethods.RESPONSE` | `LLMResponseReady(text, session_id, metadata)`; status `"idle"`; assistant message | `client.events.on("assistant.response")` with result envelope/error/audit metadata from `SDK-003`. | Assistant response appears only from backend event evidence; retry/cancel/transport-loss states are separate `UIA-002` work. | Supported by `UIA-001`; streaming/cancel parity waits for `UIA-002`/`BE-009`. |

## Unsupported Or Deprecated Behavior

| Legacy behavior | Decision | Rationale and production alternative |
| --- | --- | --- |
| Direct screen access to Qt bridge internals such as `_stop_tts_callback` | Deprecated outside the PyQt fallback | Production controls call `AuroraClient`; native/Tauri adapters may call bus/Gateway internally but screens must not mutate backend state through UI object callbacks. |
| Dedicated `transcription_received` Qt signal as the primary transcription surface | Deprecated as a screen contract | The bridge already renders final STT through chat/status signals. Production UI should consume typed SDK voice events so it can represent final, partial, denied, privacy-blocked, and remote/provider states. |
| Inferring service state from local UI transitions alone | Unsupported | UI state must come from backend events/responses. Optimistic labels would violate the UI SDK contract and can hide transport, policy, or remote playback failures. |
| Treating browser-only smoke as Tauri desktop parity | Unsupported | Tauri local mode must validate the native/local transport boundary and real backend evidence. Browser tests can cover isolated UI rendering only. |

## Required SDK Event Stream Coverage

Before PyQt can be removed from release packaging, SDK/Tauri tests must cover
these legacy-equivalent flows:

- Text send: `OrchestratorMethods.USER_INPUT` request path to
  `OrchestratorMethods.RESPONSE`.
- Final STT: `STTMethods.SESSION_STARTED` to listening, then
  `STTMethods.USER_SPEECH_CAPTURED` final text to processing and transcript.
- TTS lifecycle: `TTSMethods.STARTED` to speaking and `TTSMethods.STOPPED` to
  idle, including stop playback through `TTSMethods.STOP` or the newer
  interrupt contract.
- Startup history: `DBMethods.GET_MESSAGES_FOR_DATE` maps to the SDK history
  method without exposing raw SQL, paths, or unredacted metadata.
- Status normalization: listening, processing, speaking, and idle are derived
  from backend events and include session/correlation/provider metadata when the
  backend provides it.

## Tauri Boundary

Tauri commands/native events replace Qt signals only inside SDK/native adapter
implementations. Production screens remain SDK-only and may not call direct
Python services, raw bus topics, or broad `invoke` commands. Desktop local mode
must use typed commands with redacted errors and backend evidence; remote/mesh
audio or tool actions require explicit target, policy, consent, and audit data.

## Settings/About Requirement

While PyQt and Tauri coexist, the settings/about surface should expose a build
channel such as `PyQt fallback`, `Tauri local`, `Desktop thin`, or `Server web`.
The label must be backed by SDK/native capability evidence and must not expose
Redis URLs, filesystem paths, peer secrets, tokens, private model paths, or
unredacted diagnostics.
