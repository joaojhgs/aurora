# PER-160 Audio Session Consent And Event Streaming Plan

## Requirements Summary

- Source of truth: Multica PER-160 / MESH-GAP-008.
- Preserve batch remote candidates: `TTS.Synthesize`, `Transcription.Transcribe`, and `WakeWord.Detect`.
- Require explicit target selector plus consent token for streaming methods: `Transcription.ProcessAudio`, `WakeWord.ProcessAudio`, and future live mic stream paths.
- Keep `STTCoordinator.Listen`, `STTCoordinator.Audio`, `STTCoordinator.Control`, and playback controls local-only/internal by default.
- Expose typed session lifecycle methods and status/events for UI/SDK consumption without raw microphone stream exposure.

## Implementation Steps

1. Add typed audio session contract models and topic constants in `app/shared/contracts/models/stt.py`.
2. Register `AudioSession.Prepare`, `RequestConsent`, `Start`, `Stop`, `Status`, and `Events` on `GatewayService`, backed by an in-memory session registry suitable for process-local Gateway runtime.
3. Add consent/session fields to streaming audio payloads, validate selector/session/token/sample format in STT transcription and wakeword streaming handlers, and publish typed `AudioSession.Events` updates for accepted/denied/result events.
4. Keep batch TTS/transcription/wakeword request behavior unchanged and update capability catalog/graph policy metadata where needed so UI sees session/privacy/TTL requirements.
5. Add focused unit tests for contract classification, session lifecycle, streaming denial without selector/token, approved event publication, and route/catalog policy visibility.

## Verification

- `uv run pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_capability_graph.py tests/unit/gateway/test_capability_catalog.py -q`
- `uv run pytest tests/unit/gateway/test_audio_session_contracts.py tests/unit/stt_transcription/test_audio_session_policy.py tests/unit/stt_wakeword/test_audio_session_policy.py -q`
- `uv run ruff check app/shared/contracts/models/stt.py app/services/gateway/service.py app/services/stt_transcription/service.py app/services/stt_wakeword/service.py tests/unit/gateway/test_audio_session_contracts.py tests/unit/stt_transcription/test_audio_session_policy.py tests/unit/stt_wakeword/test_audio_session_policy.py`

## Risks

- Consent tokens in this slice are process-local and intentionally not durable across Gateway restarts.
- The event stream is a bus-level unified contract; full HTTP SSE/WebSocket transport can build on it without changing STT/TTS service internals.
