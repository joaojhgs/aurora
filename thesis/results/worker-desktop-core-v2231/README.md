# Worker–desktop core conditions: saved-results index

Only six worker-desktop service-boundary conditions; not full13, all surfaces, all directed pairs or all concurrency scenarios.

This index extracts retained results. It performs no inference or network requests and recomputes no historical quantiles.

| Condition | Attempts /900 | Correct audio | Failed | Timeout flags within failures | Unattempted |
| --- | ---: | ---: | ---: | ---: | ---: |
| K1 HTTP | 180 | 179 | 1 | 0 | 720 |
| K1 P2P | 900 | 885 | 15 | 1 | 0 |
| K2 HTTP | 900 | 797 | 103 | 0 | 0 |
| K2 P2P | 900 | 774 | 126 | 0 | 0 |
| K3 HTTP | 900 | 885 | 15 | 0 | 0 |
| K3 P2P | 900 | 773 | 127 | 1 | 0 |

The active K1HTTP epoch is recorded separately in inventory.json. Its270 planned attempts are not completed measurements; the original900 target remains open.

Latency populations, milliseconds, per-epoch policies and input SHA256s are retained in inventory.json. No latency distributions are pooled by this index.

Sources:

- `K1 HTTP`: `thesis/evidence/orca-relayed-http-v1197/terminal-v1377/summary.json`
- `K1 P2P`: `thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v2153/CONDITION-CLOSURE-v2201.json`
- `K2 HTTP`: `thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/FINAL-VALIDATION-v1472.json`
- `K2 P2P`: `thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/CONDITION-CLOSURE-v1906.json`
- `K3 HTTP`: `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/condition-900-analysis/SUMMARY.json`
- `K3 P2P`: `thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043/CONDITION-CLOSURE-v2134.json`

Reproduce with the same saved inputs:

```bash
python3 thesis/analysis/index_worker_desktop_core_v2229.py --output-dir thesis/results/<new-empty-directory>
```

To reproduce this exact saved snapshot, add `--input-inventory thesis/results/worker-desktop-core-v2231/inventory.json`. All12 inputs are physically retained with hashes under inputs/. A run without that option reads the current saved reports and custody checkpoint.
