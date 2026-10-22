# V1481 K3 terminal partial result

The worker-to-Personal Orca-relayed HTTP condition stopped at **513/900 measured attempts:512 correct,1 TTS transport failure,387 unattempted**. All15 warmups are excluded. The source harness sets zero timeout flags; the underlying transport exception detail is unavailable. The full900 target remains open.

The requester controller recorded exit1 at2026-10-18T12:52:50.522700UTC, with shutdown complete. All528 case files and527 WAVs are retained. The failed request had a correct transcript and answer but no retained requester audio response. Its failure-observation duration is49164.008980ms; that is not a completed-flow latency.

## Observed latency

All values below are milliseconds; estimator is Hyndman–Fan Type7, h=(n−1)p with linear interpolation. Populations remain separate.

| Boundary | n | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Correct full flow, validated WAV received/decoded | 512 | 30319.603404 | 31478.860090 | 31878.257710 |
| Provider native STT model | 513 | 3264.940583 | 3461.637825 | 3517.486832 |
| Provider native LLM generation | 513 | 259.396520 | 278.065900 | 291.684098 |
| Provider native TTS model | 512 | 1689.040851 | 1899.413018 | 2018.755892 |

These are partial-cohort measurements. Native models use provider-process clocks; the full flow uses the requester clock. Do not subtract clocks across hosts or sum independent percentiles. The HTTP path includes the existing Orca intermediary; it is not actual P2P or an isolated estimate of protocol overhead. Physical microphone, playback and audibility are outside this file-audio boundary.

## Native stage and resource coverage

STT and LLM join strictly for all513 measured attempts. TTS joins strictly for512; the failed client request has no received TTS server ID. A final completed provider TTS invocation appears after the last correlated LLM in the bounded provider log, but associating it with the failed request is an inference, not a strict response-ID join. It does not turn the failed client flow into success. The delivery cause is unknown.

| Saved resource interval | Joined case windows | With ≥1 sample | With ≥2 samples |
| --- | ---: | ---: | ---: |
| provider.llm_model | 513 | 126 | 2 |
| provider.native_case_window | 513 | 513 | 513 |
| provider.stt_model | 513 | 513 | 513 |
| provider.tts_model | 512 | 512 | 355 |
| requester.full_attempt | 513 | 513 | 513 |

Samples are observations inside recorded same-host intervals, without interpolation or exclusive per-request attribution. Provider native-case envelopes cover the strictly joined spans; the failed case omits the unjoined TTS interval. Parent-process CPU excludes separately spawned Piper processes. Interface counters are namespace aggregates and must not be summed across interfaces. GPU observations are per recorded DRM device. Sparse LLM windows limit CPU summaries to two cases with two samples. Resource units are explicit in the JSON; Linux proc RSS is KiB. Queue, first-token, first-audio, playback and relay-only metrics remain unknown.

The frozen/admission-native setup is Whisper base on CPU/effective int8_float32; Qwen3.5-0.8B-Q4_0 on RX7600 Vulkan25/25 layers; Piper CPU,22050Hz monoPCM16. The requester’s unused local n_gpu_layers=0 configuration is not the invoked provider backend. Native admission and unchanged provider manifest/config evidence are retained.

## Physical custody and reproducibility

The requester seal verified1342 indexed files/41,009,448bytes, all528 case files and527 WAVs, with zero copier errors. Retired local append sources are covered through EOF; original incomplete flags remain unchanged.

The immutable provider checkpoint was exported after requester termination and imported here: **880 raw files/92,612,561bytes**, archive6,280,537bytes. All archive/file hashes passed. Provider snapshot time:2026-10-18T13:24:23.934984+00:00. The provider resource sampler remains live; snapshot incomplete flags are preserved. Reused V1413 provider-prefix records are retained but excluded from this cohort’s metrics by exact request/server correlation IDs.

- [Requester seal and latency result](requester-analysis-v1506/REQUESTER-RESULTS.md)
- [Requester seal](requester-analysis-v1506/LOCAL-CUSTODY-SEAL.json)
- [Native summary](native-analysis-v1509/SUMMARY.json)
- [Per-case native history](native-analysis-v1509/CASE-HISTORY.json)
- [Resource summary with explicit units](resource-analysis-v1510/SUMMARY.json)
- [Per-case resource windows](resource-analysis-v1510/RESOURCE-CASE-HISTORY.json)
- [Full provider copy receipt](../provider-transfer-v1508/CUSTODY.json)
- [Provider source/file coverage chain](../provider-transfer-v1508/COVERAGE-CHAIN.json)
- [Bounded failure log excerpt](../provider-observations/failure-tail-v1506/RECEIPT.json)
- [Single worker-journal check](RELAY-JOURNAL-BOUNDED.json)
- [Validation receipt](VALIDATION-v1511.json)

Saved-data entrypoints are `analyze_saved_requester.py`, `thesis/analysis/k3_saved_case_history_v1509.py`, and `thesis/analysis/k3_saved_resource_windows_v1510.py`; exact executed-source copies and source hashes are retained beside their outputs. They make no app/model requests. Preserve every failed row; do not pool unlike CPU/GPU, fixtures, models, devices, modes or epochs.

## Remaining execution

The frozen original runner has MEASURED_COUNT=900 and no documented resume/count/ordinal-offset input; it creates a new output directory and restarts counters at1. Running it unchanged would start another900. No successor,top-up,baseline or new inference has been launched. A separately versioned remaining387 epoch needs explicit same-condition lineage and count accounting, unchanged workload/model/effective setup, fresh ordinary native warmup admission and source/model/resource verification; the original513 and failure remain immutable. Full900 and the original full13 objective remain incomplete.
