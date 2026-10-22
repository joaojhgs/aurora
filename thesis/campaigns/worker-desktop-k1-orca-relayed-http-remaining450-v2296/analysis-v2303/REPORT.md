# K1 HTTP saved epoch results

Cohort: `aurora-worker-desktop-k1-orca-relayed-http-remaining450-v2296`; frozen SHA256 `9adbf9ba3a7ec0948a087edad3655cf94ee344b3a2371a78d15f188f44150d42`.

Measured attempts: 450; correct audio: 450; failed/interrupted: 0; timeout flags: 0. Excluded warmups: 15. Unattempted in this planned epoch: 0.

Terminal status: `completed_all_correct`; stop reason: `None`. No other epoch is pooled into these latency distributions.

| Measured population | n | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| Correct full audio | 450 | 55696.430387500004 | 63354.6776362 | 64783.729364499995 |
| All attempts, time to outcome | 450 | 55696.430387500004 | 63354.6776362 | 64783.729364499995 |
| Failures, time to outcome | 0 | unknown | unknown | unknown |
| Native stt, all invoked | 450 | 8610.3320365 | 11310.6639567 | 12609.900460049985 |
| Native assistant, all invoked | 450 | 32115.559166 | 40252.2355933 | 41718.31005649999 |
| Native tts, all invoked | 450 | 1677.5962220000001 | 1903.7987256000004 | 2133.979736699999 |

Hyndman-Fan Type7; h=(n-1)*p with linear interpolation; ms.

Actual native joins including warmups: 1395; positive-flow native gaps: 0. Provider resource data present: True.

Same-host sample brackets with explicit slack; RSS uses actual-window samples. Missing observations stay unknown. Parent CPU excludes Piper child; host GPU/network counters are contextual, not exclusive request attribution.

No cross-host timestamp subtraction; no sum or subtraction of independently computed percentiles

CASE-HISTORY.jsonl retains every selected case and its recorded failures, NATIVE-STAGES.jsonl retains the correlated stages/resources, and INPUTS.json pins actual source inputs. This analysis performs zero inference or network calls. A warmup-only report has zero measured observations and unknown measured quantiles; it does not establish completion of the planned condition.
