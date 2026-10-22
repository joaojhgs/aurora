# K1 HTTP saved epoch results

Cohort: `aurora-worker-desktop-k1-orca-relayed-http-first270-v2234`; frozen SHA256 `11bbea3fc1e45e65da1ecb7b501aee77739870cb087d792e5bc5197f9b1027be`.

Measured attempts: 270; correct audio: 270; failed/interrupted: 0; timeout flags: 0. Excluded warmups: 15. Unattempted in this planned epoch: 0.

Terminal status: `completed_all_correct`; stop reason: `None`. No other epoch is pooled into these latency distributions.

| Measured population | n | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Correct full audio | 270 | 50957.1080565 | 58608.017694199996 | 60103.400722399994 |
| All attempts, time to outcome | 270 | 50957.1080565 | 58608.017694199996 | 60103.400722399994 |
| Failures, time to outcome | 0 | unknown | unknown | unknown |
| Native stt, all invoked | 270 | 7926.228072 | 10759.1213811 | 11749.20194635 |
| Native assistant, all invoked | 270 | 28514.326805999997 | 36969.3496457 | 38620.99770435 |
| Native tts, all invoked | 270 | 1660.6508105 | 1827.1452456 | 1994.4703917499999 |

Hyndman-Fan Type7; h=(n-1)*p with linear interpolation; ms.

Actual native joins including warmups: 855; positive-flow native gaps: 0. Provider resource data present: True.

Same-host sample brackets with explicit slack; RSS uses actual-window samples. Missing observations stay unknown. Parent CPU excludes Piper child; host GPU/network counters are contextual, not exclusive request attribution.

No cross-host timestamp subtraction; no sum or subtraction of independently computed percentiles

CASE-HISTORY.jsonl retains every selected case and its recorded failures, NATIVE-STAGES.jsonl retains the correlated stages/resources, and INPUTS.json pins actual source inputs. This analysis performs zero inference or network calls. A warmup-only report has zero measured observations and unknown measured quantiles; it does not establish completion of the planned condition.
