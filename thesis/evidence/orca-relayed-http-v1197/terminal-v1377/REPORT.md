# K1 Orca-relayed HTTP: terminal partial result

The original frozen V1197 run ended naturally at **2026-10-17 22:54:31 UTC**, controller exit1. It attempted180 of900 planned measured requests:179 completed correctly and1 failed during remote TTS. All15 excluded warmups completed correctly.720 measured requests were not attempted. This is an incomplete condition; no replay or top-up was launched.

The physical pair was coding-worker requester → Personal desktop provider. STT and Qwen LLM ran on the worker CPU; Piper TTS ran on the Personal CPU. The HTTP path was worker127.0.0.1:18000 → existing Orca intermediary → Personal100.64.0.3:8000. This result supplies neither actual P2P coverage nor a pure protocol-overhead estimate.

## Outcomes and quantiles

The final request completed STT and LLM with the expected transcript and Paris answer. TTS failed with `transport_error`, no HTTP status,11315.780ms observed TTS duration and52568.260ms observed full-flow duration. Its raw timeout flag is false. No completed native receiver TTS span was found for that request in the retained prefix. These facts do not establish the transport failure's cause or a model-quality failure.

Quantiles below are recomputed from saved raw rows using **Hyndman–Fan Type7**, `h=(n-1)*p`, linear interpolation. Units are milliseconds. Warmups are excluded. Native completed spans can belong to an otherwise failed full request and do not change its outcome.

| Population / boundary | n | p50 | p90 | p95 |
| --- | ---: | ---: | ---: | ---: |
| Full flow, correctly completed |179|50322.932|57463.302|60305.351|
| Full flow, all observed attempts including failure |180|50328.764|57434.565|60300.758|
| Requester harness STT duration |180|8093.280|10472.163|11559.661|
| Requester harness Assistant duration |180|33296.697|40467.153|42371.559|
| Requester harness TTS duration, including failure |180|8247.697|9082.336|9367.340|
| Native worker STT model invocation, completed |180|8077.568|10039.750|10769.203|
| Native worker LLM stream, completed |180|28121.902|35359.278|36828.291|
| Native Personal TTS service, completed |179|1696.466|1932.816|2065.221|
| Native Personal TTS model invocation, completed |179|1695.830|1932.054|2064.414|

These boundaries use their own host/process clocks. Do not subtract uncorrelated host timestamps, add independent stage quantiles or interpret the end-to-end difference as transport cost. The HTTP duration includes relay, server and other observed request work. Uninstrumented relay-only time is unknown. Resource histories and concurrent copy IO remain available as context and possible confounding.

## Retained data and limits

The [partial seal](SEAL.json) binds final summary/progress/control documents and the immutable requester custody snapshot. All195 case records and194 generated WAV files are physically retained. The failed TTS request produced no output WAV; this is distinct from losing a previously generated artifact. All three requester raw prefixes reach their terminal source sizes.

The [provider coverage chain](../provider-transfer-delta-v1372/COVERAGE-CHAIN.json) resolves456 physical raw files/79,276,145bytes across three immutable transfers, through checkpoint148 at22:57:38.966787UTC. Provider stage, binding and resource prefixes are separately timestamped. The last delta added289 files/26,338,404bytes with zero baseline raw recopied; its transfer completed23:13:17UTC. The original provider remained alive with manifest450ee5af; neither provider liveness nor a public health200 diagnoses the failed request.

The [saved-data summary](analysis/SUMMARY.json), [case history](analysis/CASE-HISTORY.json), [source identities](analysis/SOURCE-IDENTITIES.json) and [analysis custody](analysis/CUSTODY.json) preserve denominators, exact values, stage joins and input identities. Reproduce this analysis without model calls:

```bash
python3 thesis/analysis/k1_saved_case_history.py \
  --requester-custody thesis/evidence/orca-relayed-http-v1197 \
  --provider-extracted thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1372/extracted \
  --provider-coverage-chain thesis/evidence/orca-relayed-http-v1197/provider-transfer-delta-v1372/COVERAGE-CHAIN.json \
  --requester-snapshot thesis/evidence/orca-relayed-http-v1197/terminal-v1377/REQUESTER-CURRENT.snapshot.json \
  --output-dir thesis/evidence/orca-relayed-http-v1197/terminal-v1377/new-analysis-directory
```

The existing analysis was executed once on this final180-attempt dataset; the example requires a new output directory and is not a request to repeat it. The observed partial populations support only the stated partial-run descriptive results. They do not satisfy the900-request coverage target or justify pooling another stage, transport, device or changed cohort. All prior failures and the720-unattempted gap remain explicit.
