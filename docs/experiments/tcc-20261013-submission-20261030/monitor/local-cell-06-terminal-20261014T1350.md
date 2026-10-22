# Local-only cell 06 terminal observation

Observed 2026-10-14T13:51:12.055456+00:00. Original monitoring Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`; original Root owns execution and integration.

Cell `06-local-only` has recorded status `completed`, child exit `0`, and recorded cell exit `0`. It finished 2026-10-14T13:49:04.951833+00:00, after 3331.353 seconds. There are 100 measured requests and 5 excluded warmups; all 105 raw request outcomes are `correct_success`, with passing predicates, unique nonempty request identifiers, and intervals within the declared 180-second deadline. All 105 captures match the three provider-input fingerprints, with both capture ordinals and request ordinals covering 0–104.

Success-only latency from raw monotonic request intervals uses Hyndman–Fan Type 7: p50 30729.797 ms, p90 35445.629 ms, p95 37635.405 ms, and descriptive p99 40331.352 ms. This is one loaded-host service session, not a pooled, causal, or stable-tail result. Five warmups are excluded; n_success/n_measured is 100/100, with zero observed measured failure or timeout outcomes. Resource observations include benchmark load and do not identify unrelated background load.

Cleanup reports `supervisor_returned_unverified` and the cell records no detached groups. This does not establish that every service thread was verified stopped. The original timeout/driver remained live at the terminal observation, and the declared cell-07 baseline exists; the whole campaign has no terminal result. Retired outer tool handle 33217 remains terminal 143 and does not supply a recoverable original-wrapper exit code.

Root message `msg_d1ca9865493c` was fully read and acknowledged via `delivery_d9b8d4d6cac1`. Independent retained-data review is pending; prior reviewed acceptance stays 500/900 until that gate closes. No product source changes, replay, new worker, reservation change, or additional matrix was performed by this monitor.

The adjacent JSON contains the finite audit projection and exact SHA-256 hashes. Raw sources are `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/06-local-only/requests.jsonl`, `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/06-local-only/requests.jsonl.provider-inputs.jsonl`, `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/06-local-only/result.json`, and `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/06-local-only/requests.jsonl.cleanup.json`; retain these files rather than treating this summary as a substitute.

## Independent closure update

At 2026-10-14T13:55:37.632682+00:00, Root closure message `msg_e1b2613a5152` was fully read and acknowledged via `delivery_79a759663059`. The existing native Sol retained-data review was read in full and its actual SHA-256 matched `e758a47c10f006976accb49ba082eac4acebeea332cc90459b082eb60a5a7135`; it approves this closed cell and sealed export manifest `f35e565f6462e0deeb2478bfd2cdaa361edeb16c3077512b612da94dab94f9da`. All six completed cohorts now total 600/900 measured samples independently reviewed. This does not complete pooled n=300 per route or the full original aggregate goal. Root confirms reading monitor report message `msg_803c4e4a9b6b`.

The initial adjacent JSON remains an immutable pending-review snapshot. Whole-campaign terminal output is named `campaign-result.json`; the original snapshot inspected `result.json` at the campaign root. Both paths were absent at the recorded follow-up, so the continuing-state conclusion is unchanged; subsequent observation uses the canonical filename. No runtime replay or product change followed this observer correction.

The next mesh session child was observed live at 2026-10-14T13:54:58.135574Z: PID/PGID 1571122, start ticks 76450668, parent original driver 1305954. Original timeout 1305953 and driver 1305954 retain start ticks 74126867. Captures were not yet present, so input matching for the new session was unknown, not passed.
