# Manual saved-data analysis

**Status: Partial feature.** These standard-library tools analyse retained results. They do not start Aurora, load models or generate measurements. Preserve existing output directories and use a fresh version for each analysis.

The original [native span tool](native_span_metrics.py) remains pinned to its earlier analysis receipts. The [v2 tool](native_span_metrics_v2.py) labels each exact stage/handler population across declared attempted cases, including completed native spans belonging to an interrupted overall request. Wrapper and model spans remain separate; missing native operation/attempt IDs and unknown queue, first-token, streamed-audio and playback metrics remain explicit.

## Compatible V735 + V745 join

The [segment join](join_local_segments.py) accepts only the owner-authorized frozen V735/V745 pair from methodology section30.37. It requires V735's 274 retained attempts, including its original interruption, and V745's complete626-attempt continuation. Both segments must already have passed their one archive/outcome audit and have verified saved custody. Each segment's15 additional excluded warmups remain separate. An incomplete second segment is not a full900 condition.

After the second segment has finished, retired and reached verified custody, supply its exact frozen manifest and the two existing audit/history/archive sets:

```bash
uv run --no-sync python thesis/analysis/join_local_segments.py \
  --first-archive /path/to/verified-v735.zip \
  --first-audit /path/to/v735/audit-verification.json \
  --first-manifest thesis/evidence/frozen-manifests/desktop-local-v735.json \
  --first-history /path/to/v735/NATIVE-STAGE-CASE-HISTORY.json \
  --second-archive /path/to/verified-v745.zip \
  --second-audit /path/to/v745/audit-verification.json \
  --second-manifest /path/to/exact-v745-frozen-manifest.json \
  --second-history /path/to/v745/NATIVE-STAGE-CASE-HISTORY.json \
  --output-dir /path/to/fresh-versioned-analysis
```

The required manifest hashes are `be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5` and `31dea74bf4587e7bef60c44ef28c2b3f7a2da73a69891df27bc318b9819d505d`. The [frozen metadata custody record](../evidence/frozen-manifests/CUSTODY-v760.json) retains the exact V735 input and the separate V692 HTTP manifest; the HTTP manifest cannot substitute for V745. No model, audio, settings or CPU/GPU cohort is pooled by this tool.

The join reads only already-audited attempt JSON members and the saved paired-span histories. It reconciles selected outcomes with prior audit counts and records their source bindings. It does not run a ZIP-wide integrity/hash check, repeat transcript/audio correctness audits, decode WAVs or infer a successful request from completed native spans.

Outputs are `summary.json`, `attempt-outcomes.csv`, `native-stage-spans.csv` and `joined-stage-history.json`. Request distributions keep correct-only, completed including incorrect, and observed attempts including failures separate. Exact stage/handler metrics retain their own completed-span denominators. Case, receiver process, clock and correlation must match; present request/session IDs must match too. STT/TTS IDs absent from the original native boundary stay null and are counted; LLM request/session IDs remain required. No cross-process clock subtraction or independent-quantile sum is used.

The [source custody and review record](SOURCE-CUSTODY-v761.json) binds the implementation and independent review. The [finite synthetic main-flow check](../validation/segmented-join-main-v761.json) passed with900 synthetic measured rows,30 excluded warmups and4,500 separate paired spans, preserving incorrect/interrupted outcomes and distinct Type7 denominators. These are algorithm test inputs, not new benchmark samples or actual joined results. The initial check/review remain retained separately; the follow-up corrects a real nullable-ID mismatch in the saved data.

V745 naturally finished at 2026-10-16 00:51:46Z, its one saved-result audit passed at 00:53:31Z, and all five raw export files reached verified worker custody at 01:16:23Z. The approved analyser ran once on the idle desktop at 01:17:00Z (exit 0, 0.368 seconds, no models or new measurements). The [actual joined report](../../docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-local900-joined-v779/REPORT.md) links all derived outputs and their verified custody. There are 900 attempts: 899 correct and the original interruption. Correct/completed N=899 gives Type7 p90 10400.242381 ms and p95 10595.486352 ms. Five exact native handlers each have 900 paired spans; this does not turn the interrupted overall request into a success. Both excluded warmup sets and process restart, state initialization, ordering and thermal limitations remain explicit. No benchmark, prior archive audit or analyser was repeated.
