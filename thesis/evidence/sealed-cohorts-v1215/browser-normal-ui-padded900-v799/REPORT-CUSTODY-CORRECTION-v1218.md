# Browser full-audio V799 result

**Status: Partial feature.** This individual browser condition finished naturally at2026-10-16T06:46:06.441052Z and was sealed once at06:52:21. Its saved-ZIP integrity/hash/outcome audit passed. All original raw data and incorrect outcomes remain preserved.

| Population | Planned | Attempted | Correct | Incorrect | Other failure | Timeout | Interrupted | Unattempted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Excluded warmups | 15 | 15 | 15 | 0 | 0 | 0 | 0 | 0 |
| Measured | 900 | 900 | 889 | 11 | 0 | 0 | 0 | 0 |

The900-case collection is complete; this does not claim900 successful flows or functional acceptance. Finite diagnosis below is complete; all eleven incorrect cases are retained. No repeat or top-up is queued.

Correct full-flow latency uses Type7 on N889 measured outcomes labeled passed: p9019297.6ms and p9519503.4ms. Its Node performance-clock endpoint includes recording, actual STT, visible correct reply, real TTS WAV and connected software playback completion. Other outcomes retain their own raw history and denominators.

Native spans use their own backend monotonic clock; they are not summed or subtracted from another host clock.

| Stage / exact handler | One valid span | Missing | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| llm / resolved_chat_model.astream | 900 | 0 | 318.4108255 | 394.0403657499996 |
| stt / Transcription.Transcribe | 900 | 0 | 3373.6866282 | 3415.06362785 |
| stt / stt.model_invoke | 900 | 0 | 3365.1185497 | 3403.9108729 |
| tts / TTS.Synthesize | 889 | 11 | 1723.374904 | 1865.9596987999994 |
| tts / tts.model_invoke | 889 | 11 | 1722.8522654 | 1865.0841541999996 |

All handler metrics have900 attempted measured cases as context; missing TTS spans remain explicit. There are no multiple spans, invalid boundaries or unmatched starts. Cause of incorrect outcomes is not inferred from these aggregate rows. Queue, TTFT, streamed-first-audio, physical microphone/acoustic capture and physical speaker output remain unknown.

[Compact original control receipt](FINALIZATION-CONTROL-RECEIPT.json) contains the remote audit receipt and original bindings; [semantic audit copy](AUDIT.json) retains metric values. The archive remains on Personal at /tmp/aurora-root-padded-browser900-v799/export-v888/aurora-browser-normal-ui-padded-full-audio-v799.zip, 130072923bytes, SHA256 489404814e7667b4c85d371e9e2e895372dc075d1e310669593dff47b1f56e72, 2765members. It has not been copied to worker custody. Later transfer requires actual destination free bytes covering the archive plus80000000reserve and a resource window that does not perturb the CPU campaign.

Frozen manifest e67f8f98830ef0ceb978590bbe6b8b496ada2ad4ddd05bc34fb22248c65c10b8; remote audit receipt SHA256 99dc2183c3b733e6dda6664d6be65fa6589a057c3b11ad5c9043a932feed2441. Exclusive retirement receipt SHA256 ec801e0bb19a35a009174894bcd8a1736072e915da6e43b0bdf12637224f099d confirms original owner identity/absence and required locks before export; no process was signalled and no model/benchmark was launched.

This browser result does not supply Tauri/on-device/mobile/cross-host acceptance. It adds no first-headless-HTTP gate or further individual scientific baseline. V737 subsequently finished naturally and sealed at09:46:42UTC; both baseline reservations are released.

Finite diagnosis: all eleven original strict failures have the same recorded31-character reply hash a1b7eb2ee7a6aded8dda4e6cf30826f5afffb28a5597ee9389e91eb326d4e319, matching “The capital of France is Paris.” All eleven transcripts match the frozen reference. The task explicitly requested only the city name, so these remain strict-format failures; factual correctness does not erase them. The driver did not request TTS after those incorrect replies. [Recorded-case diagnosis](FORMAT-DIAGNOSIS.json) preserves the eleven actual case records. No predicate, raw outcome, model, fixture or setting changed, and no rerun is queued for these extra words. Earlier unaffiliated HTTP401 observations are not asserted as their cause.

## Current custody correction —2026-10-17

The earlier dated seal describes the original archive, not its currently verified physical retention. The original130,072,923-byte ZIP remains UNKNOWN/unrecovered after the two known temporary paths became absent. The [bounded known-repo audit](../../../../../thesis/evidence/sealed-cohorts-v1215/monitor/KNOWN-REPO-CUSTODY-AUDIT-20261017T2021.json) found6metadata files/24,753bytes and zero raw archive/audio/JSONL in this known local condition directory. Those exact metadata files are now physically copied under thesis; they do not constitute recovered raw outcomes/audio. No global/irreversible loss claim or closed-run rerun is made.900attempted/889strict-correct/11strict-format failures+15excluded warmups remain the historical sealed outcome.
