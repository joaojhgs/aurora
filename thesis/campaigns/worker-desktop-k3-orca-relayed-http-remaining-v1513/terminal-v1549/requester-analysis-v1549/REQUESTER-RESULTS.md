# V1513 requester terminal partial results

The frozen condition stopped after **203/387 new measured attempts**: **202 correct and 1 transport failure**; 184 requests were unattempted. All 15 warmups are excluded. No requester harness timeout flag was set; the underlying transport exception detail is unavailable.

Correct completed flows (n=202, milliseconds, Hyndman-Fan Type 7): p50=30281.020010, p90=31085.717741, p95=31503.681829. These are conditional partial-cohort results, not a completed 900-request population. Failure-observation durations and per-stage outcome groups are separate in REQUESTER-RESULTS.json.

The failed new request (epoch index203, global condition index716) completed STT, then the assistant request returned transport_ambiguous. TTS was not reached and no output audio was received. Its observed failure duration was 39988.429547ms. The underlying delivery/runtime cause is unknown. No failed assistant server response ID is available for a strict native header join; do not infer model quality or force a join from timing alone.

The original V1481 remains513attempts=512correct+1failure. Combined counts only are716/900 attempts=714correct+2failures, with global indices717–900 (184requests) unattempted. Keep epochs and percentile distributions separate; no summary-percentile pooling or replay of prior measured requests.

All 218 case files and 217 unique WAVs are physically retained and checksum-verified. All 807 indexed payload files (17498814 bytes) match their copied hashes. Local retired-source prefixes plus the441-byte final copier status tail cover EOF; their original incomplete flags are preserved. The exact frozen manifest and final controller/summary/progress records are copied under ../final-artifacts/.

This is file-audio to validated WAV receipt/decoding, without physical microphone, playback or audibility measurement. The HTTP route includes an Orca intermediary hop. Requester stage wall time is not native model latency. Full provider-native/resource joining remains pending; the provider resource source is still live. The 900-request target and full 13-goal objective remain incomplete.

Reproduce from saved repo data into a new output directory:
\`uv run --no-sync python thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1513/terminal-v1549/analyze_saved_requester.py --output /tmp/aurora-remaining-v1513-saved-analysis-UNIQUE\`

The analysis makes no application/model requests and does not reconstruct unretained historical measurements. Preserve every failed row and keep unlike cohorts separate.
