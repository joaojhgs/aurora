# PER-142 Audio Capability Boundaries Plan

## Sources Read

- Multica issue `PER-142` title, description, labels, metadata, and full comment history.
- Runtime and repo guidance: root `AGENTS.md`, `app/services/AGENTS.md`, `app/messaging/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/services/auth/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, `tests/AGENTS.md`.
- Existing mesh policy context: `docs/PEER_PAIRING_FLOW.md` hybrid addressing section.
- Existing code anchors: `app/services/gateway/config.py`, `app/services/gateway/mesh/routing_table.py`, `app/services/gateway/mesh/capability_graph.py`, `app/shared/contracts/models/{gateway,mesh,tts,stt}.py`, `app/messaging/audio_messages.py`, `app/services/tts/service.py`, `app/services/stt_transcription/service.py`, `app/services/stt_wakeword/service.py`.
- Required runtime mesh spec/task files were absent in this checkout: `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/*PER-142*`.

## Requirements Summary

- Document audio sharing boundaries for TTS, transcription, wakeword, and raw audio streams.
- Preserve transparent mesh routing for lower-risk remote synthesize and batch transcription.
- Prevent implicit transparent routing for remote playback and raw microphone/audio streaming.
- Represent audio policy in capability graph metadata so callers can distinguish batch, playback, streaming, and wakeword behaviors.
- Cover allowed/denied routing and capability metadata in tests.

## Implementation Steps

1. Extend `CapabilityPolicyInfo` with compact audio policy metadata fields that are diagnostic only, preserving existing defaults for non-audio capabilities.
2. Update `capability_graph.py` audio classification:
   - `TTS.Synthesize` => low-risk batch output, no explicit selector by default.
   - `TTS.Request`, `TTS.Stop`, `TTS.Pause`, `TTS.Resume` => remote playback/control, explicit selector and remote confirmation required.
   - `Transcription.Transcribe` => lower-risk batch transcription, no explicit selector by default.
   - `Transcription.ProcessAudio`, `WakeWord.ProcessAudio`, `WakeWord.Detect`, coordinator audio/listen/control, and `Audio*` modules/topics => streaming/privacy-sensitive, explicit selector and remote confirmation required.
3. Update audio request models to carry optional `mesh_selector` where explicit peer/device intent is needed and keep lower-risk batch APIs selector-capable without forcing transparent-route denial.
4. Add routing-table tests proving playback/streaming configs with `require_explicit_selector=True` deny implicit routing and allow explicit selected peer routing.
5. Add capability-graph tests proving method-level policy differs between `TTS.Synthesize` and `TTS.Request`, and between `Transcription.Transcribe` and streaming/wakeword audio methods.
6. Add a short docs section in `docs/PEER_PAIRING_FLOW.md` describing audio sharing boundaries and operator expectations.

## Acceptance Criteria

- `TTS.Synthesize` and `Transcription.Transcribe` remain shareable/routable without an explicit selector when operator mesh config permits transparent routing.
- `TTS.Request`/playback controls and streaming audio/wakeword methods are marked `explicit_selector_required=True` and `confirmation_required=True` for remote providers in the capability graph.
- Routing tests demonstrate `require_explicit_selector=True` rejects implicit remote playback/streaming and explicit selectors route only to the selected negotiated peer.
- Documentation names safe batch operations, explicit target operations, and non-default raw microphone/audio streaming constraints.

## Verification Strategy

- Run targeted tests:
  - `uv run pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_capability_graph.py -q`
- Run focused mesh baseline if time permits:
  - `uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q`

## Risks

- Existing `require_explicit_selector` is module-level, while this issue needs method-level policy. Mitigation: enforce hard routing denial via operator module config and expose finer method semantics through capability graph metadata and docs.
- Some existing integration tests use literal topics. This task will not broaden that legacy surface; new tests should use typed constants where available.
