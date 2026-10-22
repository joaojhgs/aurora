# First mesh main cell: verified terminal checkpoint

Snapshot: 2026-10-14 10:40 UTC. This is a monitoring report for the existing campaign, not a new test or plan.

## Outcome

Cell 03 mesh completed at **2026-10-14T10:36:52.948081Z**, with recorded child exit 0 and cell exit 0. The 105 approved JSON attachments contain **100 measured completed_exact replies and five excluded warmups**, all with exactResponse=true, one completion, nonempty identifiers, unique request/message/correlation IDs and dispatch-to-typed-completion intervals within the 180-second request deadline.

All 105 provider captures are captured=true and match the same three task/input/settings fingerprints as the completed local-only and API cells. The actual receipt validates **ordered_serial_count** joining. Capture ordinal covers 0–104; mesh does not provide request_ordinal, so no request-ordinal join is claimed.

**300/900 measured requests are now closed**, with 15 warmups excluded. No measured failure, timeout, cancellation or infeasibility is recorded in these first three complete cells. Six predeclared cells remain. The aggregate native/platform/story goal remains active.

## First-session latency observations

Success-only quantiles use **Hyndman–Fan Type 7**, with n_success=100 and n_total=100 per condition. Five warmups per condition are excluded from measured quantiles. These are one loaded-host session per condition, not pooled three-session estimates.

| Condition | Measured correct / total | Warmups excluded | p50 (s) | p90 (s) | p95 (s) |
|---|---:|---:|---:|---:|---:|
| Local-only, cell 01 | 100 / 100 | 5 | 30.492 | 34.628 | 36.738 |
| API, cell 02 | 100 / 100 | 5 | 31.676 | 36.514 | 38.344 |
| Mesh, cell 03 | 100 / 100 | 5 | 34.571 | 40.538 | 41.759 |

Mesh p99 is 45.167 seconds, a secondary descriptive observation at this sample count. It does not establish a stable tail.

| Descriptive difference | p90 (s) | p95 (s) |
|---|---:|---:|
| Mesh minus local-only | +5.911 | +5.021 |
| Mesh minus API | +4.024 | +3.415 |

The conditions execute serially on a loaded host. Session order, client boundary overhead and uncontrolled background activity can affect the differences. These observations do not establish a causal transport penalty or mesh speedup; they do not provide cross-region, native mobile, weak-device feasibility, physical-phone battery, thermal or radio evidence.

All terminal delivery kinds are retained: 74 fallback and 31 completed across the 105 attachments. This is a completion-delivery field, not evidence that 74 requests used a transport relay or failed. Every recorded attachment was completed_exact.

## Current continuation and cleanup

The original timeout PID/PGID 1305953, start_ticks 74126867, and original driver PID 1305954 remained live in the terminal checkpoint. The mesh child PID 1388842, start_ticks 74889283, was absent after its recorded exit. This proves this cell terminated, not that the whole campaign ended.

The receipt records three detached groups as group_owned=true, leader_verified=true and reaped=true. It does not establish unrelated process cleanup or physical-device behavior.

Cell 04 API resources were observed at **2026-10-14T10:40:15.090975Z**, phase **prebaseline**, with 203 retained samples, 2,356,076,544 free artifact-disk bytes and 6,030,304 KiB MemAvailable. Its provider capture journal and terminal result were not yet present. The existing five-minute baseline is planned work, not a stall.

The original 56700-second hard cap remains 2026-10-14T23:11:48.079900Z plus ten-second kill grace. Root owns execution, the global build lock and device reservations. The retired native tool handle 33217 must not be repolled or used to restart this campaign.

## Exact evidence and lineage

- Run: run_e6054e76e9fc; Task: task_d7ea336050cf; Dispatch: ctx_37b4d0a3c14f.
- Monitor native thread: 01a123ff-19ba-7332-a2f7-346a722af79f, ACTIVE, gpt-6.1-sol/xhigh.
- Root native thread: 01a112a5-d6bb-74e2-bf7c-ace73cb513b5; terminal term_6a00d9ee-792a-4daf-8578-236290e33108.
- Campaign: 6ce98ae97d594d9fafcd1ff9ad4b9b1c, private retained root .git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/.
- Frozen runner SHA-256: c372126ca09f5f0f184f59fc7e2874f7f009125b210b1cc7ba4b96ce9141658f.
- Mesh private raw report: 03-mesh/artifacts/playwright-report.json, SHA-256 6176293be40fe97653a15863a21c3815da33770436a6e237ace8799bc74ca9af.
- Mesh private terminal receipt: 03-mesh/result.json, SHA-256 6d899a7f36b7d76c9d06101c18b2603ef1d3164919733db9094415a0fc02e9f1.
- Mesh private capture journal: 03-mesh/provider-inputs.jsonl, SHA-256 94826b93435f5c1fa5866d1496481e8036e941c3cab98c0e940ccae7defc0c3e.
- Matching provider_input_sha256: 5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac.
- Matching messages_sha256: b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde.
- Matching validated_params_sha256: 2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9.
- Root notification: msg_45e70fcb6a42, enqueued; read acknowledgment not yet verified in this snapshot.
- Companion safe projection: mesh-cell-03-terminal-20261014T1040.json.

Only approved finite fields from the JSON attachments were inspected. No raw Playwright text, stdout, DOM, prompts, reply text, credentials or request identifiers are exported in this report. The first flat-journal probe found no mesh requests.jsonl; the corrected observer used the existing approved attachments. This was an observation-shape correction, not a product test failure, new validation run or campaign replay.

## Remaining acceptance

Root still needs the ordinary per-cell document export and existing receipt review, the remaining six predeclared cells, and actual campaign-terminal export/analysis. No extra test, reviewer, worker, matrix or campaign is requested. Native Android/iOS, broader platform/client/region/weak-device cases and durable story acceptance remain separate open scope. Canonical thesis changes remain owner-review gated; historical 151 passed / 8 skipped is not current validation.

## Closure update: 2026-10-14 10:45 UTC

Root exported the actual cell and its existing Sol independently approved the original attachments, exported rows, capture association, hashes, Type 7 arithmetic, cleanup qualifications and source/settings freeze. The monitor read the full review at `../root/matched-main-campaign-v319/cell-03-mesh/independent-sol-review.md`, SHA-256 `c4314fbdd3451c1169f83bebf96e4d013954a65b93c1736505e00ba2666e56ad`; final export manifest SHA-256 is `974a74f90069dd108df67632dc17d75bbbad96292e44ea76781cd9c53241ed57`. Root message `msg_1361fb474f63` was fully read and acknowledged through `delivery_4073469ebd42`. First-epoch local-only/API/mesh acceptance is closed; the whole campaign remains unfinished.

**Timing boundary:** the mesh metric starts at requester dispatch and ends at typed completion. The readiness/preflight wait precedes that clock. The figures above therefore exclude readiness wait and must not be described as full discovery-to-answer latency. Readiness and other overhead fields remain separate evidence; cell wall-clock duration is not reply latency.

Cell 04's original child is PID/PGID `1434016`, start_ticks `75297420`, parent driver `1305954`. At 10:43:57Z it had three correct warmup rows with outcome `correct_success`, predicates true and no terminal result. The monitor briefly compared this native raw success label against the normalized export label `correct`; reading the recorded rows resolved the observer mistake, and its finite projection now accepts both recorded success labels. This was not a product failure or justification for replay. No current cell 04 provider-input journal was observed at that instant; live capture matching remains unverified rather than inferred from an empty set.
