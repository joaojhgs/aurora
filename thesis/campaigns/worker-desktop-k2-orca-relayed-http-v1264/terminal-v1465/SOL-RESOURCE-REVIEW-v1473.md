# Bounded K2 resource/report review

Verdict: resource helper, saved-data computation scope and unit-normalization provenance PASS. One concrete reporting-scope correction is required (R1). No source, data, measurement or analysis rerun is requested.

Original Run run_e6054e76e9fc; Task task_d7ea336050cf; Dispatch ctx_37b4d0a3c14f. Request: msg_cce391effd8a. Root remains sole execution/source owner; this is the original monitor's one bounded read-only review.

R1 — clarify resource interval coverage in `thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/RESULTS.md:23`.

The sentence saying resource sampling covers the full observed request window on both devices can imply the same end-to-end interval and full endpoint coverage. The helper uses requester flow start/end, but provider bounds are the minimum/maximum retained provider-native span times (`thesis/analysis/k2_saved_resource_windows.py:151` and `:154`). It selects samples inside those intervals, without endpoint interpolation (`:83`–`:103`). These are separate same-host observation windows. Provider samples before its first native span and after its last native span are not included in this derived window.

Replace the first sentence with: “Recorded samples are present inside the requester’s full-attempt interval for900/900 cases and inside the provider’s native-span envelope for900/900 cases; these are separate same-host windows. Worker STT model windows contain samples for900/900 cases.” Preserve the existing sparse-LLM/TTS counts and following scope paragraph. This is a report-only clarification; the existing numerical outputs remain usable with their observed-window labels. It does not add a measurement-admission gate, and no second source review is needed for this exact wording fix.

Evidence read and findings

- Exact executed resource source: `resource-analysis-v1471/ANALYSIS-SOURCE-AS-EXECUTED.py`, 10913 bytes, SHA256 6fdb7c4d815b000889fd975e094887e22ecc8bfa0217a7f0531f5ce17f4a8f73.
- Canonical helper: `thesis/analysis/k2_saved_resource_windows.py`, 11441 bytes, SHA256 32c4b6bbcf01bbd9b381ed54f18ed629f616094458dce0c81abf199475875b8e. The full diff is confined to generic quantile-key/unit presentation; sampling/window arithmetic is unchanged. No helper was imported or executed during this review.
- Original resource summary: 6254 bytes, SHA256 a0e53f3c7b651cb47d33c61250715feeb294aa25647a5f47635d97491f9fc798. Normalized summary: 7567 bytes, SHA256 560366e0fa92fceb6bc00843afd69f118f4a73c24fd0aa367146c52db507c731. Its unitNormalization pins the original summary, preserves executed-source identity and explicitly states no values/cases/samples/quantiles were recalculated. The published values and code diff support the label-only change; the reviewer did not rerun Root's recorded20-metric equivalence check.
- Resource rows are filtered by original PID and start ticks. Chunk lengths/hashes and contiguous byte ranges are checked by the executed helper. Same-host timestamps are used; no cross-host duration subtraction or interpolation is introduced. Representative requester/provider retained row schemas contain numeric CPU ticks,100Hz, RSS in /proc/status kB and byte-valued available memory. This was a schema spot-read, not a second full-prefix/hash audit.
- CPU deltas require two sampled timestamps, consistent positive tick rate and nondecreasing counters; CPU seconds and mean cores describe only the first-to-last observed sample span. Parent CPU excludes Piper subprocesses. Namespace network deltas stay per-interface; DRM observations stay per recorded device. Counter-error and unsampled fields remain visible; generic future input sanitation was outside this frozen-cohort review.
- The summaries expose actual sparse denominators: provider LLM samples285/900, at least two29/900; invoked TTS samples797/797, at least two583/797. These subsets are not900-case CPU/GPU estimates. Full requester and provider-native windows each contain samples900/900.
- RESULTS.md 6059 bytes/SHA256 bcd42c0f4c9b0a2e72b837a8cf8e0e455aa4bf1f6df9e01d63d5908378b0edd4 and FINAL-VALIDATION-v1472.json 4389 bytes/SHA256 910992937bdd8235d01d953eb9ac771df2c5409466ad2f075230bf020f64b8d4 preserve900=797 strict-correct+103 failures and15 excluded warmups. The frozen predicate is not weakened; public-candidate hash classification does not create regenerated replies or explain why formatting changed. First audio/token, queue and playback remain unknown. No all-surface, actual P2P or aggregate completion is claimed.

Boundaries

Only the new190-line canonical helper, its180-line exact-executed counterpart/diff, small report/validation/summaries/classification and two representative resource schemas were read. No tests, models, builds, new agents, source edits, inference, WAV decoding, raw archive rehash, unchanged latency-source review or resource-data rerun occurred. The source and numerical review is CLOSED. This review does not approve future unsupported inputs, full thesis packaging or the remaining matrix.

The repository's GitNexus exploring skill was read. The context lookup returned unknown MCP server 'gitnexus'; no graph access, reindex or installation was claimed. Review therefore used the supplied current source and pinned artifacts directly.

RecordedAt: 2026-10-18T07:43:18.902938+00:00
