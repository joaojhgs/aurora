# Proposed original Root measurement reservation

Status: reviewable scheduling proposal; Root has not reserved or started the main cohort. Same original Run `run_e6054e76e9fc`, Root thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`, monitor Task `task_d7ea336050cf` / Dispatch `ctx_37b4d0a3c14f`. Root alone owns executable validation and `/tmp/aurora-global-build.lock`; no new worker, Run, host, project or access change is proposed.

## Evidence and prerequisites

Local-only V291: two correct requests, 31.875364506 and 32.551674965 seconds. API V292: two correct requests, 33.605087017 and 30.230665018 seconds. All four actual provider-input hashes match `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`, with matched messages and validated parameters. These are loaded-condition cold/warm readiness observations. Mesh V293 is pending and capped at 600 seconds through 05:08:43 UTC. Final reservations require correct mesh replies, durable safe raw rows, matched provider inputs and the same dispatch-to-typed-reply boundary.

At 04:38:21 UTC the one-second resource snapshot had 2 CPUs, approximately 91% busy, 6.188 GB available memory and 3.202 GB available disk. It establishes neither an exclusive slot nor the required five-minute baseline. Root chose a loaded readiness pilot; the main resource label must follow its actual baseline. Do not stop other workers, protected previews or user processes to manufacture idle conditions.

## Finite schedule

Use three independently restarted epochs. Each epoch contains one serial block for each condition: local-only, API and paired SDK mesh. Each condition block has 5 excluded warmups followed by 100 measured requests with fresh conversations. Total: 900 measured attempts plus 45 warmups, 300 measured attempts per condition. Root should freeze a counterbalanced condition order in the manifest before starting.

At the observed approximately 32 seconds/request, 945 requests imply 30,240 seconds (8 h 24 min) of request time before restart/setup and baseline overhead. This is a scheduling estimate from four observations, not a throughput or tail result. Recalculate after the mesh pilot.

Provisional ceiling for review: 80 minutes per condition block, nine blocks totaling 12 hours; allow up to 30 additional minutes for the three resource-baseline windows and campaign setup, giving a 12 h 30 min campaign ceiling. Root must confirm or revise these caps using actual mesh runtime and declare them before execution. No calendar time or host-exclusive reservation is claimed here.

Root holds the existing global reservation for the serial executable campaign and records actual acquisition, block start/finish and release. Only private source preparation can run alongside it; freeze the measured production/SDK/test adapter sources and settings during collection. Restart owned provider/client sessions independently between epochs and conditions, with run-owned database/profile scopes and verified scoped cleanup.

## Admission and completion

Collect the prescribed five-minute 1 Hz CPU/RAM/disk/network pre-run baseline; preserve 1 Hz run observations. Keep loaded/exclusive labels factual. Check disk before each block against Root's 512 MiB reserve and declare a log/artifact budget. Request deadlines remain 180 seconds. Overall/block timeouts, resource stops and unattempted requests must be recorded; a truncated block does not count as 100 completed measured attempts.

Persist every warmup, measured success, failure, timeout/cancellation and input-match result, with raw monotonic spans, clock domains, settings/source/model/task hashes and request/session association. Missing or multiple provider invocations and input mismatches fail admission. Separate cold/warm conditions and preserve failed pilot history. Report Type 7 p90/p95 with actual conditional sample counts and failure denominators; qualify p99. The proposal does not authorize a stable-tail claim from the two-request pilots, resolve unknown host geography, or imply native/mobile/cross-region/physical-phone evidence.

Thesis application/submission, publication and formal named external delivery acknowledgements remain separately gated.
