# Second API main session: verified terminal checkpoint

Snapshot: 2026-10-14 11:42 UTC. Same campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c`; no new test or replay.

Cell 04 API completed at **2026-10-14T11:39:15.053469+00:00**, with recorded child exit 0, cell exit 0 and an existing receipt validating 105 request rows plus 105 provider captures through **request_ordinal**, with no failure classes.

The monitor read the actual native raw journal: first five correct warmups followed by **100/100 correct measured replies**, outcome `correct_success`, all predicates true, unique nonempty request IDs and every monotonic request interval within its 180-second deadline. Both provider ordinal sets cover 0–104; every captured input matches the frozen task/settings fingerprints. Zero measured failure, timeout, cancellation or infeasibility is recorded in this complete cohort.

## Latency

Success-only **Hyndman–Fan Type 7**, n_success=100, n_total=100, five warmups excluded. These are requester measurement intervals from recorded monotonic start/end timestamps, not cell wall-clock time.

| Statistic | Seconds |
|---|---:|
| p50 | 31.975 |
| p90 | 36.251 |
| p95 | 37.587 |
| p99 | 42.562 |

p90/p95 are primary; p99 is a secondary descriptive observation at this sample count. No stable-tail, pooled n=300-per-route or causal claim is made.

The first API session had p90 36.514 s and p95 38.344 s. The second session differs by -0.263 s and -0.757 s respectively. This is a descriptive session difference on a loaded host; order, client/service overhead and unknown background activity remain confounders. The prescribed third API session remains open; these two sessions are not a completed study.

## Counts, cleanup and continuation

Actual completed measurements are **400/900** across four cells; 20 warmups are excluded. Independent artifact approval was observed for the first 300 measured requests. API04's ordinary artifact review was pending in this snapshot.

The actual cell recorded `detached_group_cleanup=[]`. Root's exported README explicitly qualifies the child cleanup as Supervisor return with internal threads unverified; no all-thread/process cleanup is inferred.

The original timeout PID/PGID 1305953/start_ticks 74126867 and original driver PID 1305954 remain live. API04 child PID/PGID 1434016/start_ticks 75297420 has exited. Cell 05 mesh was observed in prebaseline at 2026-10-14T11:41:45.158049Z with 151 samples, 2,339,356,672 free artifact-disk bytes and 5,921,072 KiB MemAvailable. Its terminal result and capture journal were not yet present. This is the original planned five-minute baseline, not a stall.

The whole campaign and full aggregate native/platform/story goal remain unfinished. Root retains execution, global-lock and Waydroid ownership. Original hard deadline remains 2026-10-14T23:11:48.079900Z plus ten-second grace. Retired native handle 33217 is not a live observation target.

## Exact sources and lineage

- Run `run_e6054e76e9fc`; Task `task_d7ea336050cf`; Dispatch `ctx_37b4d0a3c14f`.
- Monitor native thread `01a123ff-19ba-7332-a2f7-346a722af79f`, ACTIVE, gpt-6.1-sol/xhigh.
- Root native thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`.
- Frozen runner SHA-256 `c372126ca09f5f0f184f59fc7e2874f7f009125b210b1cc7ba4b96ce9141658f`.
- Private retained cell: `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/04-api/`.
- Actual `requests.jsonl` SHA-256 `a581da30801319172e040fbcc521c2f9dda737a6e7dc408c6cb63439b7d5a678`.
- Actual `result.json` SHA-256 `f5d13343cd95ee8609295dadda16c110e8a2fdad373eb70a3eace5c7a9301b4f`.
- Actual `requests.jsonl.provider-inputs.jsonl` SHA-256 `fadc779e24b0adc04de7db6bc23581a321c8d7ee7636e6318ccb2adb1e5301af`.
- Matching combined input SHA-256 `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`; messages `b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde`; validated options `2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9`.
- Root's exported cohort: [cell-04-api README](../root/matched-main-campaign-v319/cell-04-api/README.md), fully read by the monitor. At this snapshot no independent-review file was observed there.
- Root notification `msg_be6bb43a809b`: enqueued; read acknowledgement not yet established in this snapshot.
- Companion safe projection: `api-cell-04-terminal-20261014T1142.json`.

Raw prompts, replies, credentials, identifiers and original logs are not reproduced here. Root retains its raw/redacted logs and receipt history. Current results do not establish cross-region, weak-device, native mobile or physical-phone battery/thermal/radio acceptance. Canonical thesis changes remain owner-review gated. Historical 151 passed / 8 skipped is not current validation.

## Closure update: 2026-10-14 11:52 UTC

Root resumed from observed context compaction and confirmed independent acceptance through `msg_79717dd9dd39`, fully read and acknowledged as `delivery_7394c2681801`. The monitor read the complete [independent Sol review](../root/matched-main-campaign-v319/cell-04-api/independent-sol-review.md), SHA-256 `5bc20fae16edea900817d1846b6da0e18ae02a74d44bf00d6b6d5beb43c4516b`. It approves the actual raw cohort, matching captures, Type 7 arithmetic, final export hashes, protected/source continuity and qualified cleanup/log evidence. Final data manifest SHA-256 remains `948f0c8ce81ce8e3c7bc0f9460592879596f446b032f5f76997799a4379b176e`.

**All 400/900 actual completed measured requests are now independently reviewed.** Root confirmed a fresh native snapshot v342 of the same full aggregate goal, ACTIVE and unbudgeted. The same mesh05 child PID/PGID 1475575/start_ticks 75671637 was live under driver 1305954 at 11:51:25Z, with nine matching provider captures; its typed outcomes and terminal acceptance were still unverified. No replay, new worker, additional review iteration or matrix is requested.

Root also confirmed it fully read and acknowledged the monitor's API04 closure and report messages `msg_be6bb43a809b` and `msg_03f315aafd22`. This supersedes the notification/review-pending fields in the historical 11:42 snapshot and its immutable companion JSON; those original observations remain preserved.
