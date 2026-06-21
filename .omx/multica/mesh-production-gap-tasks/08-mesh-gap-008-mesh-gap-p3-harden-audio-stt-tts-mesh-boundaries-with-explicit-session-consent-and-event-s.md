# [MESH-GAP][P3] Harden audio/STT/TTS mesh boundaries with explicit session consent and event streaming

## Execution metadata

- **Task ID:** MESH-GAP-008
- **Phase:** P3
- **Labels:** audio, stt, tts, mesh, privacy
- **Depends on:** MESH-GAP-002, MESH-GAP-003
- **Parallelizable with:** Can run with MESH-GAP-006/MESH-GAP-007 after catalog contracts
- **Project:** 5345dd7c-2f0b-4a4b-b636-c1db93067f0a

## Shared context

This task is part of the Mesh Production E2E Gap Plan in `.omx/plans/mesh-production-e2e-integration-gap-plan.md`.

Context summary:
- The original mesh roadmap intended a production-grade cross-peer capability fabric, not generic remote service redirection.
- Generic MeshBus/PeerBridge/RPC service routing is a foundation only.
- Production must support local + multiple remote peer capability discovery, provider aggregation, route explanation, per-tool/per-resource sharing policy, approval/confirmation, auditability, and UI/SDK-visible degraded/blocked states.
- Reviewed implementation evidence came from `/tmp/aurora-mesh-review` at `origin/feat/migration-to-modular-services-architecture` commit `5e670fa`; the active local checkout was stale/diverged during review. Normalize branch state before implementation.
- Preserve Aurora's bus-first architecture, typed topic constants, Pydantic/IOModel contracts, generated config pattern, and privacy-first defaults.


<!-- BRANCH-POLICY -->
## Branch policy

- **Base / integration branch:** `feat/mesh-full-services-integrations`.
- Create implementation branches from `origin/feat/mesh-full-services-integrations`, not from `main` and not from `feat/migration-to-modular-services-architecture`.
- Pull requests for this task must merge back into `feat/mesh-full-services-integrations` unless the architect explicitly retargets the batch.
- Do not merge directly to `main` from these mesh-gap tasks. `main` receives the integrated mesh work only after the full mesh production sequence is accepted.

## Objective
Make audio sharing production-safe. Batch transcription/synthesis can be remote capabilities; live microphone, wakeword streaming, transcription streaming, and remote playback/control require explicit target device, consent, privacy indicators, and session lifecycle.

## Backend/API requirements
Classify audio methods:
- Safe/batch remote candidates:
  - `TTS.Synthesize`
  - `Transcription.Transcribe`
  - `WakeWord.Detect` for submitted audio
- Restricted streaming/session candidates:
  - `Transcription.ProcessAudio`
  - `WakeWord.ProcessAudio`
  - future live mic stream paths
- Local-only/default-denied unless explicit product flow exists:
  - `STTCoordinator.Listen/Audio/Control`
  - remote playback and playback controls

Add session contracts:
- `AudioSession.Prepare`
- `AudioSession.RequestConsent`
- `AudioSession.Start`
- `AudioSession.Stop`
- `AudioSession.Status`
- `AudioSession.Events` over unified event stream/SSE/WebSocket

Session policy must include:
- caller principal/peer/device
- target peer/device/resource selector
- privacy indicator state
- bandwidth/capacity check
- sample format limits
- expiry/session timeout
- audit correlation ID

## Event requirements
- Streaming transcription/wakeword results must be deliverable to HTTP/UI clients through unified event stream, not only local bus events.
- Event payloads must carry session ID, source peer, target peer, privacy class, and redaction where needed.

## Code references
- `app/shared/contracts/models/stt.py`
- `app/shared/contracts/models/tts.py`
- `app/services/stt_transcription/service.py`
- `app/services/stt_wakeword/service.py`
- `app/services/stt_coordinator/service.py`
- `app/services/tts/service.py`
- `app/services/gateway/mesh/routing_table.py`
- `.omx/specs/ui-production-tasks/tasks/UIA-004-wire-voice-ptt-wake-transcription-and-tts-playback-per-mode.md`
- `.omx/specs/ui-production-tasks/tasks/BE-003-add-unified-event-stream-contract.md`

## Acceptance criteria
- Batch remote transcription/synthesis works when provider policy allows.
- Live/streaming audio remote calls fail without explicit selector and consent token.
- UI can subscribe to transcription/wakeword events for approved sessions.
- Privacy indicator and session status are exposed to capability catalog/UI.
- No raw microphone stream is accidentally exposed by generic service sharing.

## Verification
- Unit tests for method classification and selector/consent denial.
- Integration tests for batch remote transcription.
- Event-stream tests for approved streaming session.
- Negative tests for mic/wakeword streaming without consent.
