# V1481 requester terminal partial results

The frozen condition stopped after **513/900 measured attempts**: **512 correct and 1 transport failure**; 387 requests were unattempted. All 15 warmups are excluded. No requests timed out.

Correct completed flows (n=512, milliseconds, Hyndman-Fan Type 7): p50=30319.603404, p90=31478.860090, p95=31878.257710. These are conditional partial-cohort results, not a completed 900-request population. Failure-observation durations and per-stage outcome groups are separate in REQUESTER-RESULTS.json.

The failed request had a correct transcript and answer before TTS transport_ambiguous. Its failure-observation duration was 49164.008980 ms; it did not produce a retained requester audio response. This is a transport outcome, not evidence of a model-quality failure. Provider log-tail TTS completion is separately retained; the failed request's missing TTS server ID prevents a strict client-header join. The underlying delivery failure remains unknown.

All 528 case files and 527 unique WAVs are physically retained and checksum-verified. All 1342 indexed payload files (41009448 bytes) match their copied hashes. Local retired-source prefixes cover EOF; their original incomplete flags are preserved. The exact frozen manifest and final controller/summary/progress records are copied under ../final-artifacts/.

This is file-audio to validated WAV receipt/decoding, without physical microphone, playback or audibility measurement. The HTTP route includes an Orca intermediary hop. Requester stage wall time is not native model latency. Full provider-native/resource joining remains pending; the provider resource source is still live. The 900-request target and full 13-goal objective remain incomplete.

Reproduce from saved repo data into a new output directory:
\`uv run --no-sync python thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481/terminal-v1506/analyze_saved_requester.py --output /tmp/aurora-v1481-saved-analysis-UNIQUE\`

The analysis makes no application/model requests and does not reconstruct unretained historical measurements. Preserve every failed row and keep unlike cohorts separate.
