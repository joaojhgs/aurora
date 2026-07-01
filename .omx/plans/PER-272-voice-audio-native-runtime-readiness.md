# PER-272 Voice, Audio, And Native Runtime Readiness Plan

## Source Scope

- Multica issue: PER-272 `[UI-GAP] Close voice, audio, and native runtime event readiness gaps`.
- Required specs read: `.omx/specs/ui-refinement/index.md`, `aurora-ui-sdk-contract.md`, `aurora-ui-ux-flows.md`, `feature-service-availability-graph.md`, `.omx/specs/ui-production-tasks/index.md`, `backend-gap-crosswalk.md`, and `.omx/specs/mesh-ui-roadmap-integration-review.md`.
- Code paths: `packages/aurora-sdk/src/events.ts`, `packages/aurora-sdk/src/types.ts`, `packages/aurora-sdk/src/client.ts`, `packages/aurora-ui/src/assistant-view.tsx`, `packages/aurora-ui/src/shell-data.ts`, `packages/aurora-ui/tests/shell.test.tsx`, and SDK tests.

## Constraints

- Keep voice/audio states driven by backend/native evidence, not static UI fixtures.
- Preserve privacy defaults: raw audio, wakeword, remote microphone, and remote playback remain target/consent/policy gated.
- Do not claim iOS default assistant replacement or mobile/native success from static fixtures when runtime manifest evidence exists.
- Do not add backend models unless existing STT/TTS/AudioSession contracts lack a required topic or payload. Current read shows STT session/partial/final/error/timeout, TTS lifecycle, and AudioSession consent/event models already exist.

## Implementation Steps

1. Add SDK types and normalization helpers for voice/audio evidence events covering `voice.session.started`, `voice.session.ended`, STT partial/final/error/timeout/cancelled/disconnected, TTS started/stopped/paused/resumed/error, and AudioSession consent/policy events.
2. Add an SDK `assistant.streamVoiceEvents()` or equivalent focused surface that subscribes to typed STT/TTS/AudioSession topics and preserves session ID, correlation ID, peer/device provenance, privacy class, policy/consent, and transport audit fields.
3. Update assistant voice UI model to accept normalized voice evidence rows and render actual event statuses/details when provided; keep the existing unsupported/pending rows as explicit no-evidence fallback.
4. Extend tests for SDK voice event normalization and UI event-driven state mapping, including partial/final transcription, TTS control evidence, denied/disconnected outcomes, and native runtime capability truth.
5. Run targeted `pnpm --filter @aurora/client typecheck`, `pnpm --filter @aurora/client test -- --runInBand`, `pnpm --filter @aurora/ui test:qa004`, and focused UI tests if full QA004 is too broad for the environment.

## Verification Strategy

- SDK unit tests prove raw backend/Tauri/mock events normalize without inventing missing success.
- UI tests prove visible voice states can be backend/native-evidence-driven.
- Native hardware/device-lab coverage remains explicitly deferred; manifest/runtime payload tests are the local proof.
