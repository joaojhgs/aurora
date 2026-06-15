## Objective
Clarify which audio capabilities can be shared safely and which require explicit peer/device consent. Remote synthesize and batch transcription are lower risk; remote playback, microphone streaming, and wakeword/audio streaming require explicit target devices and privacy indicators.

## Context
This task is part of the Aurora mesh-polishing roadmap derived from `.omx/specs/deep-interview-mesh-distributed-integration.md`.

Current confirmed baseline:
- Targeted mesh/gateway tests previously passed: `88 passed, 13 warnings`.
- `MeshBus` already routes commands and mesh events through routing/peer bridge paths.
- WebRTC pairing, manifest exchange, service negotiation, and service sharing are implemented to a working baseline.
- Orchestrator already uses the bus for Tooling discovery/execution, and Tooling exposes `GetTools`/`ExecuteTool` as mesh-shareable methods.

Roadmap constraints:
- Preserve Aurora's privacy-first, message-bus-first microservice architecture.
- Use pragmatic security tiers across home LAN/VPN, Docker/process clusters, and internet-crossing peers.
- Use hybrid addressing: transparent routing is allowed for low-risk service dependencies, but explicit peer/resource addressing is required for tools, DB/data, hardware, scheduler ownership, remote playback, and safety-sensitive actions.
- Prefer existing contracts/utilities and typed topic constants; avoid exposing raw internal/admin capabilities by default.

Relevant code anchors:
- `app/services/tts/service.py`
- `app/services/stt_transcription/service.py`
- `app/services/stt_wakeword/service.py`
- `app/services/stt_coordinator/service.py`
- Audio contract models under `app/shared/contracts/models/` and `app/shared/messaging/models/`.

## Initial implementation plan
1. Classify audio operations: safe transparent, explicit target required, or non-shareable by default.
2. TTS: keep remote synthesize as shareable; require explicit peer/output device for remote playback.
3. STT/Transcription: prefer remote batch transcription; require consent, indicators, and bandwidth checks for streaming audio.
4. Wakeword: require explicit privacy policy before remote wakeword processing.
5. Add policy metadata to capability graph for audio resources.

## Acceptance criteria
- Audio sharing boundaries are documented.
- Remote playback cannot occur implicitly through transparent routing.
- Microphone/audio streaming requires explicit policy and target selection.
- Tests cover safe/denied routing for audio operations.

## Suggested verification
- Contract tests for explicit target requirements.
- Policy tests for denied remote playback/streaming without consent.
