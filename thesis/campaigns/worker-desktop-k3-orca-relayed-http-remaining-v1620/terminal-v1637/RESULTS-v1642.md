# V1620 saved terminal results

**Status: Current bounded check — terminal partial, not 900-request acceptance.**

V1620 naturally stopped at 2026-10-18 22:56:07 UTC after global indices 717–740. Its 24 measured attempts contain 11 correct complete audio flows, 12 strict reply-format failures before TTS, and one assistant transport failure (`http.client.RemoteDisconnected`). All 15 warmups were correct and excluded. No explicit timeout flags were set. The previous 716 attempts and two failures remain: combined counts are 740 attempted, 725 correct and 15 failed; 160 requests remain unattempted. No old requests were repeated.

| Saved requester population | n | p50 (ms) | p90 (ms) | p95 (ms) |
| --- | ---: | ---: | ---: | ---: |
| Complete correct audio flows | 11 | 30361.644802 | 31998.645717 | 32039.286506 |
| Reply-format failures, observed partial duration | 12 | 22354.418882 | 24127.043096 | 25396.517027 |
| All observed attempts, including partial failures | 24 | 25530.829474 | 31459.313129 | 31946.163978 |

Quantiles were recomputed from retained raw rows with Hyndman–Fan Type 7 (`h=(n-1)p`, linear interpolation), independently matching the retained runner's complete-flow summary. These populations remain separate. Partial failures did not complete an audio flow and must not be presented as successful end-to-end latency; the 11 successful observations are a small conditional population. No cross-epoch percentile pooling occurred.

All 12 rejected assistant replies have the retained 31-character content hash of “The capital of France is Paris.” This exact hash identification supports a factually correct full sentence that violates the frozen one-word instruction. It is not recovery of an unretained raw server response. All 12 remain format failures, with the underlying cause of the response transition unknown. STT passed for all 24; assistant HTTP responses completed for 23; TTS completed for 11 and was not reached for 13. No predicate, model, input or setting was changed.

Local requester custody is sealed at EOF: 39 cases, 26 generated audio references, 161 indexed files and 3,096,631 bytes. The original 160 files were hash-verified once; the only final addition was a 433-byte copier log tail, checked by the existing copier. All four requester/controller/copy/finalizer PIDs are absent. Raw cases, frozen inputs/harness, audio, append logs and requester resources remain physically under this thesis campaign folder. [EOF receipt](REQUESTER-EOF-SEAL-v1641.json).

The actual setup, condition and shutdown charge is 1,121.556635285 seconds. With all prior charges retained, cumulative use is 24,715.685852618 seconds of the unchanged 57,600-second cap. Remaining budget is 32,884.314147382 seconds; this does not extend the original provider's fixed lifetime.

Measured provider native spans/resources are pending retrieval from the original Personal custody, and provider current liveness is unknown. The 45 native warmup joins prove the admission only. Queue time, first token/audio, playback and relay-only attribution are not inferred from requester HTTP durations. The failed assistant call has no returned server correlation ID and must not be force-joined by time/order.

The post-terminal passive command was explicitly rejected `terminal_not_writable` despite connected/writable metadata; its original-output reconciliation showed no execution. One authenticated saved-session application read also returned `RemoteDisconnected`. A refreshed 301-command public Orca catalog exposes no same-SSH write restoration operation. Restoration of the existing Personal terminal write route is required before saved provider retrieval or the single approved ordinary MQTT/pairing/consent check. No new worker, provider, forward, credentials, inference or retry was created during this analysis.

Reproduce the saved-data analysis into a new destination with:

```bash
.venv/bin/python thesis/analysis/k3_requester_terminal_v1641.py \
  --custody thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1620 \
  --output thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1620/terminal-v1637/requester-analysis-reproduction
```

[Machine summary](requester-analysis-v1642/SUMMARY.json), [case history](requester-analysis-v1642/CASE-HISTORY.json), [source identities](requester-analysis-v1642/SOURCE-IDENTITIES.json), and [exact executed analysis source](requester-analysis-v1642/ANALYSIS-SOURCE.executed.py). The initial pre-import-format analysis remains separately retained in `requester-analysis-v1641`; its outputs are not additional measurements. The final entrypoint passes Ruff. The global documentation check remains failed on existing experiment-report placement and historical broken-link findings; no bulk history relocation or deletion was attempted.
