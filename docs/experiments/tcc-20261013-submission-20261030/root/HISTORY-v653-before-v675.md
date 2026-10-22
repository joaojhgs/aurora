# Aurora validation status — 2026-10-15

**Status: Current bounded check.** Updated at the 15:27:11 UTC evidence boundary. The original full thirteen-story native goal remains active in thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`; formal statuses remain **1 complete, 1 in progress and 11 pending**. This results index does not close unfinished product or delivery gates or replace the original monitor's authoritative methodology plan.

The original Root, branch/worktree, dirty work and all imported recovery refs remain preserved. Root owns serial executable/build/device validation and reservations. The original Orca monitor in `run_e6054e76e9fc` remains the sole methodology-plan writer.

**Later recovery update:** the owner-authorized attempt resumed this same native goal to **active**, verified by `get_goal`. After three resumed turns with the same missing capability, its actual native status is now **blocked** again. The existing personal SSH target remains disconnected; supported GUI/status controls reject this SSH caller with `forbidden`. Exact commands, receipts, original monitor identity and the still-unknown V641 result are recorded in the [recovery history](ORCA-RECOVERY-20261015.md). No pilot was rerun.

## Completed measurements

| Condition | Measured outcomes; 15 additional warmups excluded | Type 7 p90 / p95 ms | Report |
| --- | --- | --- | --- |
| Desktop GPU Python LocalBus V485 | 878 correct / 22 strict incorrect / 0 execution failures / 0 timeouts / 0 unattempted | 11970.216910 / 12421.601557 | [Local audio](desktop-gpu-full-audio-local900-v485/REPORT.md) |
| Desktop GPU authenticated loopback HTTP V497 | 853 correct / 47 strict incorrect / 0 execution failures / 0 timeouts / 0 unattempted | 11637.4428838 / 12029.8744915 | [HTTP audio](desktop-gpu-full-audio-http900-v497/REPORT.md) |
| Worker ARM64 CPU LocalBus V491, separate extraCPU | **900 correct / 0 incorrect / 0 failures / 0 timeouts / 0 unattempted** | **49936.7875221 / 52595.9486264** | [CPU audio](worker-cpu-full-audio-local900-v491/REPORT.md) |

Each condition contains 900 measured real-audio STT → Assistant → Piper TTS cases through checked non-silent PCM. These are headless caller boundaries. UI capture, browser/native playback and physical audibility are separate gates. Type 7 interpolates at sorted position `(n - 1) * p`; the table includes incorrect completed cases and excludes warmups. Each report retains stage denominators and independent quantiles, which must not be added. Queue delay, first token and first streamed audio remain unknown here.

The two desktop conditions used RX7600 Vulkan with 25/25 LLM layers offloaded, with STT/TTS on CPU. All 69 strict incorrect replies were the extra-word sentence “The capital of France is Paris.”; exact reference transcripts and request/session/correlation checks passed. Those failures remain failures. The worker used the same original audio/model weights and explicit CPU settings, with different hardware/architecture/backend builds recorded as a separate cohort. No incompatible CPU/GPU percentiles are pooled, and no 900-case repeat was used to make these outcomes look better.

The worker finished naturally at 15:21:29 UTC; both exact owners were absent and its local build lock was free at 15:22:40 UTC. One approved export and one saved-archive/raw/Type7 reconciliation passed. Its [raw ZIP and verification](worker-cpu-full-audio-local900-v491/REPORT.md) are on coding-worker in project docs. The two desktop raw ZIPs remain in personal-desktop project docs: [local custody](desktop-gpu-full-audio-local900-v485/EVIDENCE-LOCATION.json), [HTTP custody](desktop-gpu-full-audio-http900-v497/EVIDENCE-LOCATION.json). Sol's desktop report reviews were bounded consistency reviews, not independent remote-ZIP audits.

## Product main flows still open

Saved-answer browser [read-aloud V474](retained-audio-main-v474/README.md) passed normal Login/history reopen, an actual TTS request, valid PCM and browser `playing`/`ended`. It did not include new microphone/STT/LLM input or physical audibility.

The old V601 voice trace was retrieved after the original Orca client recovered. It failed its visible-reply wait; its actual user transcript repeated the opening question, while same-session “Paris” was persisted. Its exact owners later retired. Chromium's documented single-play file input removed looping in V635; that run acquired the microphone but transcribed a sentence missing its opening “What,” failed the unchanged strict transcript check and stopped before LLM/TTS. No model-quality cause was established.

A new explicitly separate candidate adds one second of silence before and half a second after the byte-identical original speech. Its WAV hash is `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb`. V638 acquired the microphone but failed capture startup before any STT request; its exact owners retired. **The padded candidate is still unqualified.** No old measured result is overwritten, pooled or claimed replaced by this preparation.

V641 actually launched one full UI-audio pilot at 14:54:55 UTC with unchanged candidate/models/predicates and a passive browser startup-phase observer. Its outcome and process retirement remain **unknown**. Root retains its personal-desktop global/GPU/Waydroid reservation; an elapsed deadline is not proof of exit. No replacement case has launched.

The current access failure is specific: Orca's original personal SSH target `ssh-1786238480967-semdev` reports **“Remote connection dropped. Click Reconnect on the SSH target before retrying.”** The original Orca app/runtime is reachable; connected/writable terminal metadata is insufficient. This SSH CLI has no reconnect command and denies GUI-window access. The owner has been asked only to reconnect that existing target, preserving its terminal. Unknown-acceptance commands are not replayed, and no account/permission/security change or new worker is being used to bypass this boundary.

Android's [retained packaged startup](android-build-and-startup-v448/README.md) passed build/update/cold-launch boundaries but showed black app content. The actual retained screenshot is V445 and failed WebView inspection is V446; the V448 web build is not Android runtime evidence. Inspection timed out before DOM/resource/exception observations, so the cause remains unknown and no speculative source patch is grounded. The approved personal Orca/Waydroid route remains required. Neither this connection failure nor local worker ADB visibility establishes that the emulator is absent.

## Next gates

1. Recover the existing V641 result and exact retirement after the existing personal SSH target reconnects. Follow a real failure with only the grounded main-flow fix; follow a pass by moving on. Do not repeat closed source reviews, passed checks, flag/CDP matrices or edge cases.
2. Complete important individual AUDIO and SURFACE flows, including normal browser audio and Android rendering. Once real audio → actual STT → actual LLM → actual TTS → valid audio passes with telemetry, freeze the exact new manifest, weights/settings/backend/hardware and replacement links. Changed audio/settings require a new cohort; rerun only affected comparison cells and preserve every prior raw result. PER-286 remains open; private benchmark stage observers do not close PER-285 product telemetry.
3. Keep measured cross-device/cross-surface traffic held until all required individual AUDIO + SURFACE results finish and seal, followed by Root's explicit phase transition. Subsequent applicable new conditions require 900 measured samples each, additional warmups, comparable effective setup, cumulative **TTS → TTS+LLM → TTS+LLM+STT**, correlated stages/resources and honest failure/timeout denominators. Controlled simultaneous local-user/mesh provider contention belongs to that phase.
4. Retain technically accepted archive/settings/database foundations and original QA-before-architecture, linked-delivery/tracker and source Astra aesthetic gates. PER-291 remains conditional plan only: no transcript-library screen. PER-287 and active iOS execution remain excluded. Commit/push/new-PR/CI/merge/publication holds remain unchanged.

Earlier snapshots are preserved in [HISTORY-v618-before-v653.md](HISTORY-v618-before-v653.md) and [HISTORY-before-v618.md](HISTORY-before-v618.md). Their old scheduling and connectivity claims are historical. No old case, evidence, model, campaign artifact or worktree was removed.
