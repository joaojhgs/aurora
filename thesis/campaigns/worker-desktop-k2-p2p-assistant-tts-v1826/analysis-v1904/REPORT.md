# K2 worker to Personal desktop: completed 900-attempt condition

**Status: Current bounded check.**

All 900 declared measured attempts completed naturally: 774 correct full-audio results, 115 strict city-only reply-format failures and 11 preaccept rejections. Zero timeouts or unattempted cases. Fifteen additional correct warmups are excluded.

The unchanged pipeline was actual fixed WAV → worker CPU faster-whisper base → Personal Vulkan Qwen3.5-0.8B Q4_0 → Personal CPU Piper → valid WAV. Requester/receiver correlated native records and before/after ICE snapshots establish the production PeerBridge route. The readiness GPU record confirms configured100 and actual25/25 layers on RX7600; CPU/GPU cohorts are separate.

| Measured boundary | n | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Correct full-audio end to end | 774 | 16524.519 | 19429.443 | 20761.115 |
| All observed attempts, including failures/skipped TTS | 900 | 16347.153 | 19255.173 | 20585.018 |
| Native stt: all measured invocations | 900 | 8107.444 | 10647.768 | 11766.733 |
| Native assistant: all measured invocations | 900 | 253.442 | 381.360 | 573.287 |
| Native tts: all measured invocations | 774 | 1651.409 | 1873.784 | 1975.127 |

Percentiles are recomputed from retained rows with Hyndman–Fan type7 interpolation. The all-attempt distribution is not a 900-success full-pipeline distribution. Native STT/LLM include failed-output cases; native TTS has774 measured invocations. Correct-full-audio native subsets are separately available in SUMMARY.json.

All2619 current native stage pairs join uniquely: 45 excluded-warmup stages plus2574 measured stages. 30 earlier provider correlation/stage pairs are excluded. All1715 requester remote calls, including warmups and rejections, join to route snapshots. Resource brackets attach within each host clock only; sampled process CPU/RSS and host/device GPU/network context are not exclusive per-request costs. See SUMMARY.json for missing-counter observations and bracket slack.

The115 format failures retained a factually correct31-byte sentence instead of the required city-only response; no TTS call/audio is expected after that predicate fails. The cause of this output change and the11 receiver capability rejections remains UNKNOWN. Neither samples nor failure predicates were changed. Failed observations remain in cases.jsonl.

Requester cases/audio and all raw stream EOFs are sealed under ../terminal-v1899/. Provider raw12 files (87266093 bytes) are retained physically in ../provider-transfer-terminal-v1902/provider-eof-v1901.tar.gz, with archive and every member checksummed. Original Desktop sources remain preserved. INPUTS.json pins every analysis input; no inference, builds, downloads or reruns are performed by this analysis.

Reproduce into a fresh output directory:

```sh
python3 thesis/harness/analyze_k2_mesh_saved_v1904.py --out /tmp/aurora-k2-v1904-reproduction
```

This condition covers fixed-file audio submission to returned valid audio. It does not prove physical microphone capture, playback/audibility, Android/iOS acceptance, all concurrency conditions or the full matrix. K1 remaining191 and subsequent matrix conditions remain open.
