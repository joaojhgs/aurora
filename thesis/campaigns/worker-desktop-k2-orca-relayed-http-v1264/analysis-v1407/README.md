# K2 saved checkpoint analysis

**Current bounded check; not a900-request seal.** This one analysis reads the immutable requester snapshot at2026-10-17T23:50:51.033858+00:00 and provider checkpoint202 at2026-10-17T23:51:53.882199+00:00. It retains13 measured requests, all correct, and15 correct excluded warmups. All six expected native boundaries join all13 measured requests: worker STT service/model and Personal LLM/history/TTS service/model. History has26 invocations across13 cases; its per-invocation quantiles are not a per-case duration.

| Boundary, milliseconds | n | p50 | p90 | p95 |
| --- | ---: | ---: | ---: | ---: |
|Full flow, correctly completed|13|28805.857|30305.054|32367.811|
|Requester STT wrapper|13|8337.588|10339.592|12409.934|
|Requester remote Assistant wrapper|13|11641.731|12546.397|12722.982|
|Requester remote TTS wrapper|13|8307.633|9197.846|9300.246|
|Native requester stt.model_invoke|13|8332.120|10333.624|12403.805|
|Native provider resolved_chat_model.astream|13|253.893|264.243|264.372|
|Native provider tts.model_invoke|13|1725.648|2246.542|2489.133|

Quantiles use Hyndman–Fan Type7, `h=(n-1)*p`, linear interpolation. All denominators and units come from actual saved rows. This small checkpoint does not establish the final900-request tails or completion. The active frozen run continues; do not rerun the workload to reproduce this report.

Assistant and TTS have separate Gateway correlations. Native spans pair the same host/process/recorder/clock/stage/handler/span/correlation and retain actual IDs. Service and model spans remain separate; no duplicate service span is counted as another model invocation. Do not subtract different host clocks, sum independent quantiles or label full-flow differences as pure protocol overhead. Unknown queue/first-token/first-audio/playback/relay-only timing stays unknown. Native completed spans do not convert an otherwise failed full request to success. Resource prefix custody and operation IO context remain explicit.

[Summary](SUMMARY.json), [case history](CASE-HISTORY.json), [source identities](SOURCE-IDENTITIES.json), [custody](CUSTODY.json). Reproduce into a new output directory with saved data only:

```bash
nice -n 15 python3 thesis/analysis/k2_saved_case_history.py \
  --requester-custody /home/developer/projects/aurora/thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264 \
  --requester-snapshot thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/REQUESTER-CURRENT-before-provider-delta-v1401.json \
  --provider-extracted thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1402/extracted \
  --provider-coverage-chain thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1402/COVERAGE-CHAIN.json \
  --output-dir thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/new-analysis-directory
```

The analyzer imports only the existing saved-data/clock-pairing/Type7 helpers. It never imports Aurora, loads a model or sends a request. Exactly one main-flow checkpoint analysis was executed. Later final analysis must bind later matching immutable requester/provider snapshots and preserve this checkpoint.
