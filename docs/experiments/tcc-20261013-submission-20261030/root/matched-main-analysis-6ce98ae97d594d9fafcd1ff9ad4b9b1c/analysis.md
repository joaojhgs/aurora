# Matched Assistant main analysis

Campaign: `6ce98ae97d594d9fafcd1ff9ad4b9b1c`

Latency quantiles use the archived Type 7 helper and successful measured requests only. Warmups are excluded; failures and missing cells remain in denominators/statuses. Session ranges and matched deltas are descriptive across three clusters, not confidence intervals or causal estimates.

| Route | Sessions with rows | Success / measured | p50 ms | p90 ms (primary) | p95 ms (primary) | p99 ms (descriptive) |
|---|---:|---:|---:|---:|---:|---:|
| local-only | 3 | 300 / 300 | 30756.523106 | 35437.982592 | 37635.40468775 | 40397.34417451999 |
| api | 3 | 300 / 300 | 31800.7875045 | 35711.055822300004 | 37399.58333755 | 42385.00700217 |
| mesh | 3 | 300 / 300 | 34669.5 | 40876.1 | 42178.65000000001 | 45792.22 |

Full 300 measured rows per route eligible: `True`. This means actual row-count/source/terminal gates only; it does not claim every attempt succeeded.

Per-cell statuses, outcome counts, session ranges, and three matched-block quantile differences are retained in `analysis.json`. p90/p95 are the primary quantiles; p50 and p99 are secondary, with p99 descriptive only across these three observed sessions and no stable-tail, precision, or causal-speedup claim.
