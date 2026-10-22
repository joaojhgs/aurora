# Six closed worker–desktop conditions

Only six worker-desktop service-boundary conditions; not full13, all surfaces, all directed pairs or all concurrency scenarios.

Saved-report extraction for owner review; no inference, network traffic, new quantiles or historical reruns.

| Condition | Attempts | Correct audio | Failed | Timeout flags within failures |
| --- | ---: | ---: | ---: | ---: |
| K1 HTTP | 900 | 899 | 1 | 0 |
| K1 P2P | 900 | 885 | 15 | 1 |
| K2 HTTP | 900 | 797 | 103 | 0 |
| K2 P2P | 900 | 774 | 126 | 0 |
| K3 HTTP | 900 | 885 | 15 | 0 |
| K3 P2P | 900 | 773 | 127 | 1 |

Successful full-audio latency, milliseconds. Each row uses its own successful-response denominator and retained Hyndman–Fan Type7 statistics. Failed attempts remain in the outcome table. Epoch distributions remain separate.

| Condition / epoch | Successful n | p50 ms | p90 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: |
| K1 HTTP / V1197 | 179 | 50322.932153 | 57463.302423199995 | 60305.3512957 |
| K1 HTTP / V2234 | 270 | 50957.1080565 | 58608.017694199996 | 60103.400722399994 |
| K1 HTTP / V2296 | 450 | 55696.430387500004 | 63354.6776362 | 64783.729364499995 |
| K1 P2P / first20 | 19 | 43657.277037 | 48616.7359926 | 49321.44234509999 |
| K1 P2P / next689 | 678 | 44990.468276 | 51271.1096626 | 53838.35479685 |
| K1 P2P / remaining191 | 188 | 44781.190986 | 49884.9047023 | 51352.36127465001 |
| K2 HTTP | 797 | 28967.940839 | 31730.1032776 | 33246.1032976 |
| K2 P2P | 774 | 16524.5190135 | 19429.4432782 | 20761.114956149995 |
| K3 HTTP | 885 | 30277.170251 | 31243.1636454 | 31787.947598400002 |
| K3 P2P | 773 | 12482.77534 | 13919.323345600002 | 14665.765187399998 |

HTTP includes the existing Orca intermediary; these results do not isolate protocol overhead or establish a causal transport-speed advantage. K1 source/authorization/model-residency epochs are not pooled. K1 V1197 statistics are retained original aggregates; later K1 epochs were recomputed by their named saved-data analyzers. This index recomputes none.

All inputs are physically retained under inputs/ with SHA256s in inventory.json. Existing raw case/stage/audio/resource histories remain at their canonical thesis paths, referenced by those reports. No old index or failed case is replaced.

Sources:

- K1 HTTP: `thesis/results/worker-desktop-k1-http-full900-v2403/FULL900-SUMMARY.json`
- K1 P2P: `thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v2153/CONDITION-CLOSURE-v2201.json`
- K2 HTTP: `thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/FINAL-VALIDATION-v1472.json`
- K2 P2P: `thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/CONDITION-CLOSURE-v1906.json`
- K3 HTTP: `thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682/condition-900-analysis/SUMMARY.json`
- K3 P2P: `thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043/CONDITION-CLOSURE-v2134.json`

Reproduce the exact saved extraction into a new empty directory:

```bash
python3 thesis/analysis/index_worker_desktop_closed_core_v2463.py --input-inventory thesis/results/worker-desktop-closed-core-v2463/inventory.json --output-dir thesis/results/<new-empty-directory>
```
