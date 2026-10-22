# Original monitor: mesh readiness closure and approved Android route

Observed at: 2026-10-14T07:00:12.546460+00:00. Objective: `tcc:20261013:submission-20261030`.
Original Run `run_e6054e76e9fc`; Task `task_d7ea336050cf`; Dispatch `ctx_37b4d0a3c14f`.
Monitor terminal `term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc`, incarnation `37e50d9c-6cf5-4e28-a63b-f2bc3eed5661`, native thread `01a123ff-19ba-7332-a2f7-346a722af79f`, goal ACTIVE, effective verified model `gpt-6.1-sol/xhigh`.
Root terminal `term_6a00d9ee-792a-4daf-8578-236290e33108`, original native aggregate `01a112a5-d6bb-74e2-bf7c-ace73cb513b5` remains ACTIVE. Root alone owns serial executable/device validation and `/tmp/aurora-global-build.lock`.

## Current verified result

V315 terminal exit 0 at 2026-10-14T06:54:28.214686Z, elapsed 180.397770846 seconds, bounded 600-second wrapper, deadline not reached. Protected config/.env/uv.lock unchanged. Playwright report: one selected case, expected=1, unexpected=0, skipped=0. Actual two requests both completed_exact, exact response true, exactly one typed completion each, all four identifiers present and request=correlation=message. Readiness preflight took 1928ms then 0ms; reply latency took **49,178ms then 33,531ms**, measured before typed dispatch through typed completion. Readiness and build time are separate. Two actual captured provider invocations, ordinals 0 and 1, match every local/API readiness input:

- provider input SHA256 `5a95a2f1b72dc76f3f875d7759c7926b3b06d4736e7a8a08fcc8144706b48fac`
- messages SHA256 `b65cbaff90f6dc8875d93914fc34a52d288427f7c28691ae7f8b15a8f6ae7fde`
- validated parameters SHA256 `2e8bc1ea2a932715d302bf954699fbe70526b8713fce3e461eb50f1c400dc7b9`

**The important two-request mesh readiness gate is CLOSED. Do not repeat it.** This is n=2 descriptive readiness evidence on a loaded host, not stable p90/p95/p99, native/cross-region evidence, or the full parent goal. Previous diagnostic cohorts and failures remain separate.

Exact private source artifacts under `.git/aurora-handoff-import-20261006/matched-readiness-v315-mesh/`: `root-result.json`, `live-handle.json`, `safe-measurement-receipt.json`, `provider-inputs.jsonl`, `resources.jsonl`, `artifacts/playwright-report.json`. Raw Playwright report SHA256 `70b2b97d69e590b74b281dc595e647c0a11ce39401c5b7ddbae5bedb85392d73`. The report was parsed locally with only approved attachment fields projected; private reporter stdout/stderr/DOM are not exported by this monitor. Root is exporting safe complete evidence to project docs.

## Failure history and actual advances

V302: first correct 49,846ms, second typed unavailable_service at 214ms, one model input; second failed interval excludes success quantiles. Its original cause remains unverified. V306: ENOSPC before any model request; no mesh outcome. Root recovered only receipt-owned webpack cache directories, preserving raw histories/source/other workers. V307: remote provider_not_ready before model request, authorized peer intact. V310 and V313: first correct, second real manifest unavailable before model dispatch. Existing source review found generation-coalescing and consumer-recipient refresh defects. Root integrated independently reviewed minimal guarded repairs, ran the one focused race regression and three affected consumer checks, and V315 now passes. No claim that every older failure had this cause.

## Selected finite main window

Root selected nine serial counterbalanced cells: epoch1 local/API/mesh, epoch2 API/mesh/local, epoch3 mesh/local/API. Each cell has five excluded warmups and 100 measured requests; totals 900 measured and 45 warmups, n=300 per condition across three restarts. Each request cap is 180 seconds; each whole cell cap 6000 seconds with owned ten-second cleanup grace, plus one five-minute 1Hz resource baseline before each cell: declared operational upper window **15h45**, excluding the separately recorded cleanup grace. No main cell is claimed launched in this report.

Only Root may reserve and execute. Preserve global lock, two-GiB start guard and 512MiB runtime artifact reserve; record all attempts/failures/timeouts and unattempted denominator on early stop. Stop at first correctness/resource/cap failure. Collect CPU/RAM/network/disk and queue/start/preflight timing throughout. One passing two-request gate does not prove main tail eligibility. Compute declared quantile method on actual successful rows, with full failure denominators and separate cold/warm/session strata. Never mix failed 214ms, preflight-infeasible zero/one-ms rows, warmups, build time or earlier pilot cohorts into success quantiles.

No exclusive/quiet-host claim follows from a global advisory build lock or a single resource snapshot. If the recorded resource window does not meet clean criteria, label and report the actual loaded condition. Do not stop other sessions, change permissions, repeatedly wait for silence, or create a new monitor to manufacture exclusivity. Android/native gates and the rest of the full parent scope remain preserved.

## Fresh approved Waydroid route

Actual read-only command `/home/developer/.orca-relay/bin/orca emulator devices --json` returned receipt `7288cce6-312e-4894-afc1-45b1d52bedd3`, runtime `5168da61-e878-402a-92a3-5ea447243a89`, backend android, **booted**, isAvailable=true, name `personal-distrobox · WayDroid_x86_64_Device`.
Owning host: `ssh-1786238480967-semdev`; serial `192.168.240.112:5555`.
Use the full device identifier:

```text
ssh-adb:WyJzc2gtMTc4NjIzODQ4MDk2Ny1zZW1kZXYiLCIxOTIuMTY4LjI0MC4xMTI6NTU1NSJd
```

The FULLREAD version-matched guide `.git/aurora-handoff-import-20261006/ORCA-EMULATOR-ANDROID-SKILL-V211.md` documents approved controller relay calls. They are guidance, not freshly executed device tests:

```sh
/home/developer/.orca-relay/bin/orca emulator screenshot --device 'ssh-adb:WyJzc2gtMTc4NjIzODQ4MDk2Ny1zZW1kZXYiLCIxOTIuMTY4LjI0MC4xMTI6NTU1NSJd' --json
/home/developer/.orca-relay/bin/orca emulator ax --device 'ssh-adb:WyJzc2gtMTc4NjIzODQ4MDk2Ny1zZW1kZXYiLCIxOTIuMTY4LjI0MC4xMTI6NTU1NSJd' --json
/home/developer/.orca-relay/bin/orca emulator logcat --lines 200 --device 'ssh-adb:WyJzc2gtMTc4NjIzODQ4MDk2Ny1zZW1kZXYiLCIxOTIuMTY4LjI0MC4xMTI6NTU1NSJd' --json
```

The guide also supports explicit-device launch, approved per-app permissions, GUI inputs and rotation. Root reserves the device and selects the actual package from source before any app launch or input. The proxy explicitly **does not expose raw exec, APK install, ADB connect/pair or arbitrary ports**. Full install/CDP/SDK owning-host route remains unverified. The older `orca adb use` receipt returned unknown command before reaching host selection; do not repeat unsupported syntax or infer absent device. Recover using existing original authorized owning-host coordination only, not permission bypass or new worker/project. Existing actual screenshot receipt `.git/aurora-handoff-import-20261006/ORCA-ANDROID-REOPEN-20261010-V1.json` was exit0 at Oct10 02:59:53; it is historical, not current app acceptance.

Owner accepts Waydroid for Android surface testing. It supplies no physical-phone battery/thermal/radio/Doze/OEM-kill claim. Native iOS remains a genuine macOS/Xcode execution gate. This monitor performed no device test, installation, deployment, product-source edit or worker lifecycle mutation.

## Lineage and coordination receipts

Current branch `codex/aurora-native-speech-routing-20261007`, HEAD `5782746afba213f6b36907db2f09f0017625e218`, dirty Root work preserved. Formal durable plan still 13 goals: 1 complete, 1 in progress, 11 pending; do not convert sub-gate acceptance into full goal completion. TCC guide lineage `hermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4`. Canonical thesis project `846e3e40-f48b-4e20-8aa7-88ef55b67da3` remains owner-review gated, unchanged by this report; no company Work Claude or submission.

Actual same-run monitor messages: heartbeat `msg_c110bb13512a` at06:55:25; recovered FIFO fully acknowledged through `delivery_d2ce8d6d3852`, `delivery_ca6601d5fafd`, `delivery_f86bbb811f5c`; resource/main ACK `msg_585fb5659047`; independent mesh gate closure `msg_7fb1ca230f8b`. Successful sends prove durable enqueue, not recipient readback. Reporting lapse acknowledged; no duplicate monitoring worker introduced. Live Personal/University white-paper session lineage remains unverified; completed standalone review and Telegram document receipt are recorded separately, with no live-session claim.
