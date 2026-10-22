# Second mesh main session: verified terminal checkpoint

Snapshot: 2026-10-14 12:51 UTC. Existing campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c`; no new test or replay.

Cell 05 completed at **2026-10-14T12:48:33.381881+00:00**, recorded child exit 0 and cell exit 0. The existing receipt validates **105 requests and 105 provider captures** via `ordered_serial_count`, with no failure classes and raw artifacts retained.

The monitor decoded only the fixed-name approved JSON attachments from the original private Playwright report. Exactly **100 measured replies and five excluded warmups** have outcome `completed_exact`, exactResponse=true, one completion, unique nonempty request/message/correlation identifiers and dispatch-to-typed-completion durations within the 180-second deadline. There are zero recorded measured failures, timeouts, cancellations or infeasibility outcomes.

All 105 captures are captured=true and match the frozen combined input, messages and validated-options fingerprints. Capture ordinals cover 0–104. Mesh does not provide request_ordinal; the actual association is ordered serial count, not an invented provider request-ID join.

## Latency and denominator

Success-only **Hyndman–Fan Type 7**, n_success=100, n_total=100; five warmups are excluded.

| Statistic | Seconds |
|---|---:|
| p50 | 35.105 |
| p90 | 41.006 |
| p95 | 42.095 |
| p99 | 44.526 |

p90/p95 are primary; p99 is a secondary descriptive observation at n=100 and does not establish a stable tail. **Readiness/preflight waiting precedes the mesh requester-dispatch clock** and is excluded from these intervals; discovery-to-answer latency and total cell wall-clock time are separate quantities.

The first mesh session's p90/p95 were 40.538/41.759 seconds. Session 2 differs by +0.468/+0.337 seconds. This is a descriptive loaded-host session comparison; order and unknown background activity remain confounders. It is not a causal penalty, speedup, pooled n=300-per-route result or completed study.

Across all 105 attachments, terminal delivery kinds are fallback=83 and completed=22. These are completion-delivery fields, not proof of transport relay use or failure; all 105 outcomes are completed_exact.

## Counts, cleanup and continuation

**500/900 measured requests are actually complete**, with 25 excluded warmups across five cells. Independent artifact acceptance was observed for the first 400; this fifth cell's ordinary review was pending at this snapshot. The prescribed local/API/mesh third sessions and remaining counterbalanced cells are unfinished.

The actual receipt records five detached groups as owned, leader-verified and reaped. Root's exact terminal status qualifies compose-down as command exit 0 with reaped=null and final container inspection unverified. No all-container/service/thread cleanup is inferred.

The original timeout PID/PGID 1305953/start_ticks 74126867 and driver PID 1305954 remain live; cell 05 child PID/PGID 1475575/start_ticks 75671637 has exited. Cell 06 local-only resources were observed at 2026-10-14T12:50:40.485105Z in prebaseline, with 128 retained samples, 2,313,551,872 free artifact-disk bytes and 5,825,424 KiB MemAvailable. Its terminal result was absent. This is the existing planned five-minute baseline, not a stall.

Root owns execution, the global lock and Waydroid reservation. The same campaign's original deadline remains 2026-10-14T23:11:48.079900Z plus ten-second grace. Retired native handle 33217 is not a live observation target.

## Exact provenance

- Run `run_e6054e76e9fc`; Task `task_d7ea336050cf`; Dispatch `ctx_37b4d0a3c14f`.
- Native monitor `01a123ff-19ba-7332-a2f7-346a722af79f`: ACTIVE, gpt-6.1-sol/xhigh.
- Original Root native thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`; full aggregate remains open.
- Frozen runner SHA-256 `c372126ca09f5f0f184f59fc7e2874f7f009125b210b1cc7ba4b96ce9141658f`.
- Actual retained private cell: `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/05-mesh/`.
- `artifacts/playwright-report.json` SHA-256 `5063f5ce308111f3d7cf2256b4184e2d34e89e4071f64abcb49d4aeff5226441`.
- `result.json` SHA-256 `dbc7bfe9e243f4b743ccd8cac792953315652aa8e0a8a56f0bf5c8118ab61b50`.
- `provider-inputs.jsonl` SHA-256 `94826b93435f5c1fa5866d1496481e8036e941c3cab98c0e940ccae7defc0c3e`. This hash-only capture journal contains the same accepted inputs at each ordinal; byte identity with another session does not itself establish replay.
- Matching combined input `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`; messages `b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde`; validated options `2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9`.
- Root terminal message `msg_0841cf3c683e`, fully read and ACKed as `delivery_8ab7f9de3bdf`.
- Monitor typed-outcome notification `msg_f479531645ec`: enqueued; read not yet established at this snapshot.
- Companion safe projection: `mesh-cell-05-terminal-20261014T1251.json`.

Full original logs/report remain private. No raw prompts/replies, identifiers, DOM, stdout or credentials are reproduced here. These results do not establish cross-region, weak-device, native mobile or physical-phone battery/thermal/radio acceptance. Full aggregate native/platform/story scope remains open; canonical thesis edits remain owner-review gated. Historical 151 passed / 8 skipped is not current validation.

## Export update: 2026-10-14 12:56 UTC

The monitor fully read Root's [cell-05-mesh export README](../root/matched-main-campaign-v319/cell-05-mesh/README.md) and exact status `msg_1bcaa901486b`, acknowledged through `delivery_987c168cf633`. Final data-manifest SHA-256 is `746477b6353415b728b65021872063f4c2c1ffda209452274224bfc553122891`. Its ordinary independent Sol artifact review is pending; 500 actual completed measurements and 400 independently accepted measurements remain distinct.

Each measured request starts a fresh conversation inside the same fresh service epoch. Root's initial export incorrectly asserted one conversation and failed before creating the export; the assertion was removed and its receipt retained, preserving raw records. This was an exporter observation error, not a product failure or reason to rerun the model/test cohort.

Root confirms the same full native aggregate ACTIVE/unbudgeted at post-cell snapshot v365, with all native/platform/story scope retained. Local-only cell06 child PID/PGID 1527139/start_ticks 76087462, parent driver 1305954, was observed live at 12:53:43Z after its original baseline; no reply row was yet observed at that instant. No campaign terminal or full-study acceptance is claimed.

## Independent closure update: 2026-10-14 12:58 UTC

Root's existing Sol independently approved the actual cell05 data and final export. The monitor fully read [independent-sol-review.md](../root/matched-main-campaign-v319/cell-05-mesh/independent-sol-review.md), SHA-256 `bd94d172bd65dda0358dd618a1bce21ec38abd40e32eaf181a27af9fc35a6fad`, and Root status `msg_9b83750484ec`, acknowledged through `delivery_3cf563f0493c`. The review independently decodes all original attachments, recomputes Type 7 statistics, verifies capture association, source/settings continuity, export hashes and qualified cleanup/privacy evidence. The final data manifest remains unchanged.

**All 500/900 actual completed measured requests are now independently reviewed.** The historical 12:51/12:56 pending snapshots above and immutable safe projection remain preserved. Root confirmed the same full native aggregate ACTIVE/unbudgeted at v365-final, with full13/native/G8/Astra scope open, and confirmed it fully read and acknowledged monitor closure `msg_f479531645ec`.

At 12:57:55Z, the original timeout/driver and local06 child remained live, with five correct warmups, two correct measured rows in progress and eight observed provider captures matching all accepted input/settings fingerprints. Cell06 and the whole campaign remain unfinished. No replay, new worker, repeated source review or additional test matrix is requested.
