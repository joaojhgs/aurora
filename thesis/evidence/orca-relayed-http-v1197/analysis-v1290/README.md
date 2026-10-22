# Saved K1 analysis: the existing 51-case snapshot

**Status: Current bounded check.** This offline replay contains the same36measured cases and15excluded warmups as [analysis V1240](../analysis-v1240/SUMMARY.json). It is not the final900-case result. No new experiment requests, model runs, audio validation or outcome changes occurred.

The [validation receipt](VALIDATION.json) records identical flow, harness-stage and requester-native metrics. The later provider copy supplies the previous12missing measured-case joins: both provider TTS boundaries now cover36/36cases instead of24/36. The earlier gap described incomplete copied prefixes, not model failures. Earlier reports remain unchanged; this revision updates provider coverage for this fixed requester snapshot only.

[SUMMARY.json](SUMMARY.json) records p50/p90/p95 in milliseconds, Type7 interpolation, separate outcome populations and exact denominators. [CASE-HISTORY.json](CASE-HISTORY.json) preserves request/server correlations and original same-process native spans. [SOURCE-IDENTITIES.json](SOURCE-IDENTITIES.json) fingerprints every consumed input. Unknown queue, first-token, playback and relay-only measurements remain unknown.

The [provider coverage chain](../provider-transfer-delta-v1261/COVERAGE-CHAIN.json) resolves raw files across the retained baseline and delta locations. The delta extraction directory alone is incomplete. The analyzer checks that the chain matches the selected provider snapshot and verifies each consumed stage chunk against its recorded bytes/SHA256. It does not reread resource payloads or model weights.

From the repository root, reproduce the saved-data analysis using a new output directory:

```sh
nice -n19 uv run --no-sync python thesis/analysis/k1_saved_case_history.py \
  --requester-custody thesis/evidence/orca-relayed-http-v1197 \
  --requester-snapshot thesis/evidence/orca-relayed-http-v1197/analysis-v1240/REQUESTER-CURRENT.snapshot.json \
  --provider-extracted thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1261/extracted \
  --provider-coverage-chain thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1261/COVERAGE-CHAIN.json \
  --output-dir thesis/evidence/orca-relayed-http-v1197/analysis-manual-1
```

The output directory must not already exist. The executed analyzer and unchanged Type7 helper bytes are retained here, with source identities in `VALIDATION.json`; the canonical entrypoint is `thesis/analysis/k1_saved_case_history.py`. Retained historical source can be restored to that canonical layout for an exact-version replay while preserving any later local work. Reproducible analysis consumes retained measurements; it does not recreate measurements that were never retained.
