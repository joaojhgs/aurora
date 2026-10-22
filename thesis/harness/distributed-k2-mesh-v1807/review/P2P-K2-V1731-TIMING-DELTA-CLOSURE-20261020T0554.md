# Future K2 V1731: requested timing correction closed by bounded source inspection

Observed at: 2026-10-20T05:53:05.777310+00:00. Original Run run_e6054e76e9fc; monitor Task task_d7ea336050cf / Dispatch ctx_37b4d0a3c14f; execution Root term_6a00d9ee-792a-4daf-8578-236290e33108 remains sole execution/source integrator.

**Verdict: the one prospective setup-timing finding is closed.** This extends the prior source-scope identity, routing and failure-policy review; it does not claim runtime admission or authorize overlap with the active K1 campaign.

## Exact source and scope

- Inspected only `thesis/harness/distributed-k2-mesh-v1731/SETUP-TIMING-ONLY.diff`: 9441 bytes; SHA-256 `646c12ed81de712773d439e52a59bac6a304ef4a2dd1417323ffa14805d71e7e` and relevant setup/finalization context.
- Resulting `runner.py`: 69328 bytes; SHA-256 `8347fc103a11ca6c9d0c3686b442bd2e4236a4122c668a42bcc10944b7408285`.
- Full cumulative qualification diff: SHA-256 `daf984ae7428334e18cbbab7e961125a09d5273018a068c6f8e26e45173b5ef7`.
- Original reviewed runner `d031a116f02a17ef0a60a9b62f4729119dfa2f0466d4cd5f5bd6822e3f9dccd9` is retained by Root under `source-before-setup-timing/runner.py`.

## Finding resolved

Route-admission timing now records real monotonic start, end and duration, process PID/clock domain, status and error class in `mesh-route-admission-timing.json` from a `finally` block. Success, finite admission deadline, unexpected exception and cancellation retain their actual interval. Not-started fields remain null; absence is not zero.

Successful total setup now ends at condition start after both the ordinary route wait and provider-binding collection. Failure before condition start records partial setup through shutdown start with `setup_completed=false`; shutdown is timed separately. The setup clock starts after Supervisor construction at runner line647: it is runner/Supervisor initialization-to-condition timing, not the entire outer controller/OS/model-artifact transfer lifecycle. No cross-host subtraction is implied.

The small delta preserves existing routing, exact-peer checks, task permissions, model/audio/settings, request counts, warmup exclusion and measured-denial policy. Inspection is source evidence only. Root reports syntax/AST PASS; the monitor ran no model, benchmark, runtime import, network/device probe, old classifier smoke, full source-review replay or product test.

## Live K1 and full-plan mirror remain separate

At repository custody checkpoint 2026-10-20T05:52:21.879424+00:00, new epoch has85 measured=83correct+2failed; original20=19correct+1failed remains preserved. Combined105/900=102correct+3failed,795unattempted. All15 new warmups correct and excluded. Global98 is another isolated exact-class preaccept denial (case0093 SHA-256 `cfb718bd320c899ef52f95e11fa3a734ed977d39e67f68a25731d85dd416fe0e`); later105 is correct with consecutive rejections reset0. No rerun/top-up is requested.

The existing full671800-byte plan mirror at `thesis/methodology/owner-requirements-20261020-7d3b48a5.md` independently matches owner-authoritative Vault bytes and SHA-256 `7d3b48a58cc6125c00d0fdf4adde1c17c5deb03bed178c5aaca98c915b04b69c`, preserving the complete662114-byte prior prefix. Root receipt `MIRROR-RECEIPT-7d3b48a5.json` is dated05:46:19UTC. This mirror is closed, not a measurement gate.

Future K2 remains unlaunched. Actual fresh receiver/native joining, ordinary warmups, actual accelerator/layer use, telemetry admission and finite pilot-based duration/resource admission remain execution requirements at the natural K1 boundary. No closed baseline repeat, extra reviewer matrix or Android/product/packaging gate is added.
