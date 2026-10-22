# Browser speech interruption main-flow fix

PER-286 source slice, 2026-10-15 UTC. Starting voice capture now synchronously stops active and queued browser audio, revokes the owned URLs, invalidates pending local speech playback, and rejects interrupted SDK speech responses/failure fallback. Existing server TTS cancellation remains. The shared capture runtime is not newly cancelled by this TTS-only action.

Root validation held the sole global build lock: affected TTS test file 11/11 PASS (3.537079 seconds wall time), then UI TypeScript check PASS (49.503722 seconds). Both exited zero; actual commands, timestamps, logs and original/final source hashes are retained. Independent Sol source review APPROVE, SHA256 8a0d422b0926b6e9e58f100fa9cd71bdb996d571bf565356fdb73a7fa5e48b0a. No broader tests or runtime/build/model requests were run.

This fixes a demonstrated independent playback cancellation gap. It does not identify the previous microphone startup failure, prove live audio playback, accept PER-286 as a whole, seal the full GPU baseline, or permit measured cross-device traffic. Original worker CPU and GPU typed cohorts remain separate and sealed; all prior failed main flows remain unchanged. Canonical changes are uncommitted and all prior dirty work is preserved.
