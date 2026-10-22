# Padded desktop LocalBus / HTTP results

**Status: Current bounded check.** The retained V735274-attempt segment and V745626-attempt continuation were joined once on `personal.skyron-server` at2026-10-16T01:17:00.926617+00:00. The approved saved-data analyser exited0 in 0.367907seconds with zero new measurements/model loads and no prior archive-audit replay. All five derived files are now in verified worker custody.

The LocalBus condition has900 attempted,899correct,one original interruption,0incorrect,0timeouts and0unattempted. Its original15 and additional15 warmups are excluded separately. Restart, repeated warmup, fresh state, ordering and thermal limitations remain; this is a segmented aggregate and the table is descriptive, not a pure protocol causal comparison. The matching V692 HTTP condition has900 attempted,854correct,46incorrect,0failed/timeouts/unattempted and15 excluded warmups.

| Condition and population | N | p90 ms | p95 ms |
| --- | ---: | ---: | ---: |
| LocalBus correctly completed | 899 | 10400.242381 | 10595.486352 |
| HTTP correctly completed | 854 | 10749.810589 | 11413.862614 |
| HTTP completed, including incorrect | 900 | 10779.086541 | 11515.796980 |
| LocalBus observed attempts, including interrupted elapsed time | 900 | 10400.177451 | 10594.924648 |

Percentiles use Hyndman-Fan Type7 interpolation, h=(n-1)p. Correct/completed/observed populations remain separate. Interrupted elapsed time is not a successfully completed response. No CPU/GPU, changed-audio or different-model cohort is pooled. Both conditions use the pinned padded question and matching desktop models/settings; STT and TTS run on CPU, with actual RX7600 Vulkan25/25 LLM offload. The worker CPU900 condition remains separate and is still running.

## Exact native handlers

| Stage / handler | Completed paired spans / attempted cases | p90 ms | p95 ms |
| --- | ---: | ---: | ---: |
| llm / `resolved_chat_model.astream` | 900 / 900 | 281.219200 | 295.523269 |
| stt / `Transcription.Transcribe` | 900 / 900 | 3371.264491 | 3447.718303 |
| stt / `stt.model_invoke` | 900 / 900 | 3363.445156 | 3434.450020 |
| tts / `TTS.Synthesize` | 900 / 900 | 1671.176484 | 1756.503040 |
| tts / `tts.model_invoke` | 900 / 900 | 1670.482611 | 1755.754366 |

All five exact handlers have900 valid paired spans,0missing cases,0multiple completed spans and0invalid boundaries. Durations are paired within the actual receiver process/clock/case/correlation; their quantiles are not added. Completed native spans belonging to the interrupted overall request remain included in their declared native populations.

Native operation/attempt IDs are absent at the LLM and service wrappers; STT/TTS request/session IDs are absent at those native boundaries. The [summary](results/summary.json) preserves every missing-ID count. Queue wait, first-token, first-streamed-audio and playback metrics remain null because this headless boundary does not expose them. This is not packaged UI, physical audio, Android, mesh or cross-device acceptance.

## Raw history and custody

- [All900 attempt outcomes](results/attempt-outcomes.csv) and [4500 exact native span rows](results/native-stage-spans.csv).
- [Joined stage history](results/joined-stage-history.json), [full input bindings/summary](results/summary.json), [actual analyser receipt](ANALYSIS-RECEIPT.json) and [derived byte custody](DERIVED-OUTPUT-CUSTODY.json).
- Separate original archives/audits: [V735](../desktop-gpu-padded-local900-v735/REPORT.md), [V745](../desktop-gpu-padded-local900-v745/REPORT.md), [V692 HTTP](../desktop-gpu-padded-http900-v692/REPORT.md).

The first full terminal response exceeded retained history. Root recovered the same stored receipt with a compact read; the analyser was not rerun. Original results, failed response fragments and every source archive remain preserved.
