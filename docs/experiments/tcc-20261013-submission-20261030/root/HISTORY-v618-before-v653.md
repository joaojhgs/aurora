**Status: Historical/provenance.** This index ended at the 12:41 UTC evidence boundary and is superseded by CURRENT.md. The original body follows unchanged.

# Aurora validation status — 2026-10-15

**Status: Current bounded check.** Updated at 12:41 UTC evidence boundary. This is a results index, not the authoritative methodology plan or a real-time monitor. The original full thirteen-story native goal remains active in thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`; formal statuses remain **1 complete, 1 in progress and 11 pending**. No benchmark result below closes an unverified product or delivery gate.

The same Root, branch/worktree, dirty work and imported recovery refs remain preserved. Root owns serial executable/build/device validation and reservations. The original Orca monitor in `run_e6054e76e9fc` remains the sole methodology-plan writer. This index changes no plan, model, campaign, permission or publication decision.

## What has run

| Boundary | Actual result | Limit |
| --- | --- | --- |
| Desktop GPU production Python local-bus full audio, V485 | **900 measured + 15 excluded warmups:** 878 strict correct, 22 strict incorrect, zero execution failures/timeouts/unattempted | Headless STT → Assistant → Piper TTS; no product UI, physical microphone or acoustic playback claim |
| Desktop GPU authenticated loopback HTTP full audio, V497 | **900 measured + 15 excluded warmups:** 853 strict correct, 47 strict incorrect, zero execution failures/timeouts/unattempted | Same-host authenticated HTTP; no native/mobile/cross-device acceptance or causal Gateway-overhead claim |
| Worker CPU full audio, V491 | At **12:41:40 UTC: 680/900 measured attempted**, all 15 warmups attempted; original PIDs 2232517/2232566 live, no terminal | Separate extraCPU cohort, still frozen and running. Progress is not an aggregate correctness count or a completed percentile result |
| Saved-answer browser read-aloud, V474 | Normal Login/history reopen, one actual TTS request, valid PCM WAV, browser `playing` and `ended`; owned processes retired | Saved answer only; no new STT/LLM request or physical audibility claim |
| Android packaged startup, V448 | APK build/update installation and cold launch passed on the existing Waydroid route; product content was blank with no accessibility children | Rendered UI **failed**; cause remains unknown. Speech/history/full pipeline were not executed by that case |
| Transcript archive foundation | Existing source/contract/backend/encryption reviews and packaged scoped archive create/append/finalize/reopen/read/decrypt/delete main flow accepted technically | Synthetic archive input is not microphone/notification capture. Original linked-delivery, QA/architecture and tracker gates remain |

The two sealed desktop audio conditions used the same frozen real WAV, model weights, versions and effective inference settings. LLM execution used RX7600 Vulkan with **25/25 layers offloaded**; STT and TTS ran on CPU. Every strict incorrect reply returned “The capital of France is Paris.” rather than only “Paris”; its reference transcript and request/session/correlation checks passed. Preserve these as strict failures. No model/predicate change, repeat900 or CPU/GPU pooling was used to improve the results.

| Sealed condition | All-measured denominator | Type 7 p90 ms | Type 7 p95 ms | Detailed report |
| --- | ---: | ---: | ---: | --- |
| Desktop local V485 | 900 | 11970.216910 | 12421.601557 | [Local audio report](desktop-gpu-full-audio-local900-v485/REPORT.md) |
| Desktop HTTP V497 | 900 | 11637.4428838 | 12029.8744915 | [HTTP audio report](desktop-gpu-full-audio-http900-v497/REPORT.md) |

These percentiles include incorrect completed requests and exclude warmups. Type 7 interpolates at sorted position `(n - 1) * p`. Correct-only subsets and the 900 samples per caller stage are reported separately in the linked reports; stage percentiles must not be added. Queue, first token, first streamed audio, playback and physical audibility remain unknown at this caller boundary.

The raw ZIPs remain in **project docs on the personal desktop**, with exact locations, hashes and custody limits in the [local evidence location](desktop-gpu-full-audio-local900-v485/EVIDENCE-LOCATION.json) and [HTTP evidence location](desktop-gpu-full-audio-http900-v497/EVIDENCE-LOCATION.json). They have not been copied to coding-worker. Root performed one saved-archive/member/raw/outcome/audio/Type7 reconciliation per condition. Sol approved bounded report consistency; that review was not an independent remote-ZIP audit.

Related existing evidence: [saved-answer read-aloud](retained-audio-main-v474/README.md), [Android artifact/startup failure](android-build-and-startup-v448/README.md), and [worker CPU frozen audio setup/readiness](full-audio-worker-cpu-v490/README.md). Older readiness reports retain the limits and launch state observed at their own timestamps; this page supersedes their scheduling statements.

## Product voice and access are still unfinished

The latest retrieved normal browser voice case, V597, completed Login/Assistant/consent but timed out waiting for capture. It recorded **zero `getUserMedia` calls, successes or failures**, with the page visible/focused, consent still enabled, no alert/page error and no Assistant answer. All owned PIDs were absent, both locks were free and the retained original DB was unchanged at 11:41:07 UTC. Resource guards passed. This is an unresolved pre-microphone product/harness path, not evidence of model or transcription quality failure.

One unmeasured passive branch trace, V601, actually launched at 11:52:08 UTC on the original personal terminal. Its result, child PIDs and retirement remain **unknown** because the existing Orca route stopped delivering results. Its deadline passing does not establish exit. The global/GPU/Waydroid reservation stays held until actual retirement is verified; no replacement case or worker has started.

The supported existing `orca open` attempt returned `runtime_open_timeout`; subsequent `orca status --json` calls return **“No owning Orca client is connected to the relay”** after the relay handshake. Source inspection confirmed the installed bridge forwards CLI commands to an owning client and cannot dispatch them without that client. Original-client connectivity is the missing capability. This is not evidence that Waydroid or the emulator is absent. No restart, new identity, access/security change, or replay of unknown-acceptance terminal requests is authorized by this status.

The exact current routing, original monitor/terminal identities, private receipts and pending trace handles remain in Root's repository-local handoff artifacts. Their absence from this public index must not be represented as a retrieved trace result or released reservation.

## Remaining gates and next actions

1. Let the original worker CPU V491 campaign finish naturally, unchanged. Then verify its exact PIDs/locks/resources, invoke the already approved post-terminal collector once, and reconcile the saved data once. Retain all failures and keep extraCPU separate from GPU.
2. When the original Orca client reconnects, recover the existing V601 result and actual retirement through the same route. Use its retained branch evidence for the next bounded product fix/main-flow gate; do not restart the trace or repeat closed source reviews.
3. Finish the important individual product AUDIO and SURFACE flows, including the unresolved browser microphone path and blank Android UI. PER-286 speech-routing/platform prerequisites remain open; benchmark observer spans do not constitute PER-285 product-telemetry acceptance.
4. Keep measured cross-device/cross-surface traffic held until **all required individual AUDIO + SURFACE results finish and seal** and Root makes the existing phase transition. Later applicable new conditions retain 900 measured samples each, additional excluded warmups, the same effective setup, and cumulative offload **TTS → TTS+LLM → TTS+LLM+STT** with correlated stages/resources and honest outcome denominators. Controlled simultaneous local-user/mesh provider contention belongs to that later phase.
5. Preserve original QA-before-architecture, linked-delivery/tracker and source Astra aesthetic gates. PER-291 remains an approved **conditional plan only**, awaiting Stage 2 acceptance and its original workflow gates; do not implement the transcript-library screen. PER-287 and active iOS execution remain excluded, with historical evidence retained. Commit/push/new-PR/CI/merge/publication holds remain unchanged.

The old mixed progress journal is preserved byte-for-byte beneath a historical banner in [HISTORY-before-v618.md](HISTORY-before-v618.md). It is history, not current launch or acceptance state. No old evidence, failed case, model, campaign artifact or worktree was removed.
