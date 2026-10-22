## 26. Owner scope amendment — 2026-10-14: complete the applicable non-iOS matrix

This is a direct owner continuation of the SAME Aurora/TCC evaluation objective, not a replacement study. It supersedes earlier optional/reduced-scope wording where it conflicts. The owner requires continued work until the full applicable approved non-iOS matrix is done. Real cross-device measurements and native/headless, desktop, browser and Android/mobile surfaces are essential. The current 900-request same-host study cannot close this scope.

**iOS is excluded from active execution, required coverage and acceptance denominators.** Do not run additional iOS builds, device tests, voice work or CI. Retain existing iOS artifacts unchanged as `historical_excluded_by_owner`; they are neither current passes nor missing active requirements. An existing helper whose old name mentions iOS may perform its already-authorized generic retained-data review, without starting iOS work or a new worker. Product source contracts are not altered by this testing-scope amendment.

### 26.1 Authority, coordination and preserved work

- Original Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`, Root `term_6a00d9ee-792a-4daf-8578-236290e33108` and monitor `term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc` are retained. No new monitor/Root session, project or writer is created.
- Exact owner amendment was relayed as `msg_bb31f4d08581`. Root fully read it and acknowledged delivery `delivery_dd55668f8f41`; Root's explicit acceptance is `msg_e316c48f1b20` (2026-10-14T15:19:32Z). This monitor fully read that response and acknowledged `delivery_4276f7c99fa3`.
- This existing monitor remains the sole owner-authorized writer of this personal synced full plan. Root remains sole executable validator, integration owner and owner of `/tmp/aurora-global-build.lock` and Waydroid reservations. Canonical TCC manuscript application/submission remains owner-review gated. Company Work Claude remains excluded.
- Finish frozen campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c` without changing its source or inputs mid-run. Retain its approved cell outcomes, raw failures, warmups, resource events and analysis limits. Execute its already-approved exporter/analyzer only after the actual whole-campaign terminal result. Do not restart because an observation wait expires or retired tool 33217 returned 143.
- Frozen source is `5782746afba213f6b36907db2f09f0017625e218`; model SHA-256 is `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`. At the reviewed checkpoint, 700/900 measured requests from cells 01–07 are complete and independently reviewed; cell 08 is progressing and cell 09 remains scheduled. This is a dated checkpoint, not current full-matrix validation.
- Core cohort source/data: `.git/aurora-handoff-import-20261006/matched-main-campaign-v317-6ce98ae97d594d9fafcd1ff9ad4b9b1c/`; exported actual cells: `docs/experiments/tcc-20261013-submission-20261030/root/matched-main-campaign-v319/`. Android read-only route receipt: `root/platform-next-main-v320/android-route-readonly-v330.json` under the same study directory. A screenshot establishes route access, not current app/SDK/install/source acceptance.

### 26.2 Eligible nodes, geography and exact versions

The labels BR/PT/US are owner-requested placements. Their country/provider-region proof is still a readiness requirement, not a fact inferred from SSH names. Preserve Section 13's exact registered references and obtain current authorized inventory/documentation through existing tools. A missing inventory entry is not evidence that a device/session stopped or does not exist.

| Node | Existing identity evidence | Required capability proof / present state |
|---|---|---|
| BR | Registered `ssh:ssh-1786238480967-semdev`; owner-requested Brazil server | Country/region, physical host, OS/ABI, CPU/RAM/storage, installed source and models, API/mesh service capability and reservation remain to be verified for each stage |
| PT | Registered `ssh:ssh-sem-notebook-personal`; owner-requested Portugal personal notebook | Country, device/OS/ABI, native/headless/desktop/browser capabilities, local model admission, source/app versions and load/power state remain to be verified |
| US | Registered `ssh:ssh-oci-coding-worker` is the current coding host; owner-requested US VPS | Explicit mapping to the requested VPS, country/provider region and actual deployed API/mesh capabilities remain to be verified; do not equate a coding host with a US deployment by name |
| A-W | Authorized Waydroid through semdev Orca emulator relay; serial `192.168.240.112:5555` in the retained discovery receipt | Verify current relay discovery, exact app/package/binary/source/ABI and supported native/WebView roles through the approved route; no raw ADB/SDK/install capability is assumed |
| M-P | Actual personal physical Android phone, if eligible; exact identity not verified | Identify authorized device/host/OS/app/source, supported requester/provider roles and sensor/network access. Report a specific unavailable device or capability; do not replace physical claims with emulator evidence |

Waydroid remains the accepted Android-surface target under Section 25. It cannot prove physical-phone battery, thermal, cellular radio, Doze/OEM or physical-microphone performance. A-W→BR on the same physical semdev host is labelled co-located/emulated; it does not prove a cross-region or separate-physical-host route. A-W→PT/US counts as cross-device only after actual separate provider identity and route are observed. All physical-phone eligible roles remain in the readiness/coverage registry. A missing physical device is an explicit claim-specific gap, never an invented pass or reason to retire essential cross-device coverage.

Every executed cell pins requester and provider host/device references, source commit and dirty-diff hash, installed app/binary SHA/version, ABI/runtime/browser, backend and model/tokenizer hashes, prompts/audio/tool inputs, generation settings, grants, timeout/sample budget, load/power/thermal state and network/route proof. Different source/model/app conditions are separate cells. A valid source-specific pass is preserved; a later change requires only its affected missing gates, not a reflexive full passing-suite replay.

### 26.3 Concrete coverage registry and remaining work

Create one finite `coverage.jsonl`/`coverage.csv` manifest before new cross-device cohorts. Key each row by `(requester_node, provider_node, physical_host_relation, requester_surface, runtime_role, workload, L0/R0/P1–P5, direct/relay/API/fallback, source/app/model_manifest, cold/setup_or_warm, concurrency)`. Include applicable states and rationale, exact authority/evidence paths and hashes, stage caps, actual sample counts, outcome denominators and next action. Never manufacture pass states from source review, registration, successful signaling or a same-host result.

States are `readiness_unknown`, `instrumentation_gap`, `ready_documented`, `queued_with_budget`, `running`, `executed_pass`, `executed_fail`, `inconclusive`, `unsupported_documented`, `blocked_specific`, `not_run`, and `historical_excluded_by_owner`. Unavailability or a failed outcome stays visible; `unsupported_documented` requires real capability/policy evidence. Neither unsupported nor blocked essential coverage becomes completed acceptance automatically.

| Coverage ID / required work | Current supported state | Next bounded action / evidence needed |
|---|---|---|
| C00 Frozen same-host matched text cohort | 700/900 reviewed; 08 running, 09 scheduled; same-host control only | Finish original process/files; retain whole terminal, actual counts/Type 7 analysis and limits without replay |
| C01 BR/PT/US/Android/phone inventory | Registered references and Android relay access; exact countries/app roles remain unknown | Read authorized existing inventory/documents; publish actual node/country/capability/source/app map, not guessed placement |
| C02 Correlated instrument coverage | Current reply duration, effective input hashes and total-host samples measured; cross-device spans not established | Complete T0 audit below before new cross-device cohorts; repair only gaps through Root after frozen campaign |
| C03 BR→PT, BR→US, PT→BR, PT→US, US→BR, US→PT | No current cross-device acceptance proven by this monitor | For every applicable directed pair, measure actual deployed API and authorized mesh with matched task/model/settings; preserve provider-local/requester-local baseline and real route/source evidence |
| C04 Mobile→BR/PT/US and BR/PT/US→mobile | Waydroid route available; actual app/provider eligibility and physical-phone identity unresolved | Record each eligible A-W/M-P direction and surface separately; supported requester/provider policy only, explicit gaps for missing roles |
| C05 Native/headless S-N | Frozen Python study supplies a scoped same-host control | Actual eligible host-to-host Assistant/engine/tool/voice rows, keeping engine and full-flow outcomes distinct |
| C06 Desktop-local S-DL and desktop-console S-DC | Exact installed app/source/runtime capabilities not established here | Same real user action on eligible personal desktop; L0/deployed API/mesh, rendered reply and persisted/reopened history |
| C07 Desktop browser S-B and mobile browser S-MB | Same-worker hosted browser flow is scoped evidence only | Real browser requester on separate authorized provider host, UI/render/history and focused voice where supported; mobile WebView/browser listed separately |
| C08 Android native/WebView S-A | Read-only emulator access; current APK/source/install gate unresolved | Use existing Waydroid reservation and supported broker route for actual foreground/native behavior, voice and history; physical claims only on verified M-P |
| C09 Non-iOS cumulative voice/offload T2–T8 | Fixed matched text is a same-host control, not a stage-placement sweep | Mandatory SAME full pipeline: K1 TTS-only remote, K2 TTS+LLM remote, K3 TTS+LLM+STT remote, actual local Python/HTTP API/P2P modes; stage_provider_map proves remaining stages local, no new wake-word privacy approval |
| C10 Direct/relay/NAT/multi-hop T9 | No actual cross-device selected ICE pair proven here | Selected candidate pair and route proof per cell; existing authorized relay only. Every-hop stage composition only if implemented and granted; missing relay/forwarding stays a specific gap |
| C11 W-FIT/W-HEAVY feasibility T2–T4 | Cross-device weak-requester benefit unmeasured | Exact equal-job/model admission and local outcomes versus correct API/mesh; preserve infeasibility rather than repeatedly loading an impossible job |
| C12 Concurrency/queue/recovery T9–T12 | Serial frozen study cannot establish capacity/recovery | Initial concurrency 1/2/4 and finite recovery/revocation/redirect cycles within existing permissions; queue, offered/completed rate, fairness and duplicate-effect evidence |
| C13 Locality/privacy/resource/network/cost | Frozen total-host load exists; per-device cross-route boundaries incomplete | Device/process counters, actual stage recipients/storage, auth/denials, signaling/relay metadata and measured/estimated cost separation |
| C14 Analysis and bilingual claim reconciliation T13 | Main cohort unfinished; canonical manuscript unchanged | Trace each actual cell and figure to inputs/scripts; update PT/EN reversible drafts and limitations; owner reviews canonical application |
| H-IOS Historical archive only | Excluded by this owner amendment | Preserve old receipts; zero new active cells and zero active iOS denominator |

These are mandatory coverage families, not permission to invent an unbounded Cartesian product or extra edge cases. Enumerate all applicable approved combinations, including all six directed BR/PT/US edges and all eligible mobile directions. Surface, role and stage unsupported on a verified device are explicit capability outcomes. Do not replace real cross-device rows with loopback API, same-worker browser peers, a co-located emulator, a source guard or the 900-request control cohort. Core non-iOS voice/offload, feasibility, recovery/concurrency and privacy families cannot be silently demoted to optional.

### 26.4 Instrumentation gate before new cross-device cohorts

Audit current retained traces and production instrumentation before a new measured cohort. Publish `instrumentation-coverage.csv` keyed by stage, requester/provider/surface, actual source/app/backend, correlation mechanism, event boundary, unit, clock domain, availability, missing reason and repair/owner. Source inspection is instrument-readiness evidence only; a short authorized audit pilot must demonstrate correlation and raw field capture. No mid-run source change is permitted in the frozen campaign.

| Required telemetry | Frozen-cohort evidence / gap | New-cohort requirement |
|---|---|---|
| Request reply interval, task predicate and input fingerprints | Actual reply durations, correctness and provider-input hashes retained | Same fields for each exact cross-device surface/mode/stage cell, with n_total and all failed outcomes |
| Requester/provider stage correlation | Native capture request ordinals; mesh capture association is ordered serial count | Stable request/trace/span/attempt IDs across every actual stage and device; a provider call must be attributable to the request, not only to aggregate count |
| Discovery/setup versus warm dispatch | Mesh readiness wait excluded from current dispatch clock | Separate submission/capture→correct rendered/playback result including discovery/auth/setup, warm dispatch→reply, and cold model/process/connection intervals; explicit start/end labels |
| Queue/inference/render/history | No complete matching provider compute and UI-span proof in this cohort | Requester submit/send/render/history-save/reopen; provider admission/queue/inference/tool/serialization/response; TTFT when exposed; unknown fields remain null |
| Voice/audio | Current fixed text is not an STT/TTS placement sweep | Capture/wake/STT begin/end and transcript correctness, TTS text receipt/first audio/final synthesis, playable client first audio/full playback; local/remote stage map and audio/model hashes |
| Transport/ICE and network | Same-host success and completionKind labels do not prove selected direct/relay route | Correlated selected ICE candidate pair, host/srflx/relay class, protocol, bytes and renegotiation; existing API endpoint proof and measured RTT/bandwidth/loss context, with privacy redaction |
| Resource/locality | Total-host 1 Hz load samples and cleanup interval retained | Requester and each provider owned-process and host CPU/RAM/storage/network counters, reset semantics, queue depth, app/lifecycle state; permitted physical sensors only |

Each event records `host_id`, `boot/process_clock_id`, `clock_domain`, `request_id`, `trace_id`, `span_id`, `parent_span_id`, `attempt_id`, local monotonic start/end, wall-time observation, units and uncertainty/missing reason. Compute durations only within a clock domain. Correlating IDs does not synchronize clocks. Never subtract raw requester and provider monotonic clocks for one-way latency. Use requester round trips, provider same-clock spans and separately bounded synchronization uncertainty; retain unknown transport residuals and overlap/critical-path rules. Missing queue/inference/first-audio or cross-device counters are not zero and prevent the corresponding overhead or voice claim.

New cohorts require instrumentation on every primary boundary and T0's declared coverage accounting; report field-level missingness even if total capture coverage meets 95%. Do not call a total-latency difference pure protocol overhead without comparable matched compute spans. Actual ICE path is evidence; configured TURN, signaling success or a delivery-kind label is not a selected relay proof. Existing approved access only: no firewall/NAT changes, credential or security changes, paid-provider enablement, network-scope broadening or forced relay with new infrastructure.

### 26.5 Finite continuation and completion gate

1. Finish the unchanged frozen cohort and actual terminal export/analysis. Its valid passes remain controls; they do not satisfy new cross-device/surface/stage cells.
2. Read and publish the existing authorized node/device/app/model and route inventory. Record inaccessible physical device, missing install/SDK route, unsupported contract or unresolved country mapping with exact receipt and affected rows.
3. Audit the above instrumentation and repair only necessary gaps through original Root after source freeze ends. Pin a new source/app version for resulting cohorts; retain earlier source-specific results without relabelling them.
4. Seal the full applicable non-iOS coverage and workload manifest. Apply Section 27's accepted 900 measured requests per condition and derive finite session budgets from pilots before new cohorts. Root names each stage's wall/request/CPU/RAM/disk/port/device budgets, source/model/task, existing authorized hosts and stop conditions.
5. Run bounded readiness (at most ten requests or ten minutes per eligible condition; three setup repetitions), followed by the explicitly allocated main sample. No optional n≥1,000 tail matrix, dense impairment, unlimited concurrency or passing rerun as filler. Initial capacity remains 1/2/4 with finite blocks; failure/recovery counts and identical request deadlines are prespecified.
6. Execute all applicable mandatory same-device and real cross-device surfaces/modes/cumulative-stage rows, plus feasibility, recovery, concurrency and privacy gates. Root alone reserves executable resources. Preserve all failure/timeouts/admission outcomes and avoid repeated impossible local loads.
7. Generate actual raw p90/p95, separate setup and warm tables, n_planned/n_measured/n_success, per-stage/resource/route summaries and PT/EN claim/limitation drafts. Canonical thesis changes and submission remain owner-review gated.

The Oct 30 America/Sao_Paulo target and unknown institutional cutoff remain. Proposed schedule windows do not override essential scope or justify claiming missing cells complete. The existing full aggregate and native monitor remain ACTIVE while essential non-iOS coverage is incomplete or unverified. Report genuine capability/access/budget blockers specifically; do not infer absence from silence, create a replacement fleet, or declare the entire objective done because the same-host cohort ends.

## 27. Owner critical clarification — cumulative feature offload and 900-request allocation

Exact owner clarification was relayed to original Root as `msg_2829bfde1e6e`. This section governs the active feature-placement comparison and supersedes earlier single-resource-only/optional scope wording. Original T0–T13 specifications are retained for provenance and reusable methods; a T4 LLM-only or T5 STT-only diagnostic is not a substitute for the owner-required cumulative conditions.

The frozen mesh specification repeats `runAssistant` with fixed text and requires orchestration enabled. It does not sweep STT/TTS/LLM placement. Retain its results only as **same-host typed-request/local-network controls**, not staged feature outsourcing and not pure protocol overhead without matched compute spans. Successful matched inputs alone do not establish matched compute timing or execution locality for every stage.

### 27.1 Mandatory cumulative stage sets

For every applicable non-iOS surface and eligible same-device or real cross-device requester/provider condition, complete the SAME full pipeline and frozen workload with the SAME models, inputs and generation/audio settings. Capture, wake detection, other unassigned stages, playback and tools remain local unless their actual contract and existing authorization explicitly assign them elsewhere. Do not invent wake-word/pre-activation audio privacy approval.

| Condition | Remote stage set | Stages that must remain local unless separately authorized | Required comparable modes |
|---|---|---|---|
| K0 | Empty | Entire supported pipeline | Local Python calling through the production path; record actual backend and surface, not a crate-only substitute |
| K1 | TTS only | Capture/wake, STT, orchestration/LLM, tool execution, playback/history | Actual HTTP gateway calls for assigned stage(s), and production P2P mesh TTS; same full workload |
| K2 | TTS + LLM/orchestration | Capture/wake, STT, unassigned tools, playback/history | Actual HTTP gateway and P2P cumulative offload; both TTS and LLM remote in the same complete flow |
| K3 | TTS + LLM/orchestration + STT | Capture/wake, unassigned tools, playback/history | Actual HTTP gateway and P2P cumulative offload, with correlated speech/text/audio stages |
| K4+ | Further explicitly applicable plan stages only | Every stage not explicitly authorized/assigned | Existing capabilities, contracts and privacy authorization first; no automatic wake-word or new forwarding approval |

Order the staged placement sweep K1→K2→K3. Counterbalance matched mode/device sessions within each prespecified stage without dropping a stage. Run BOTH same-device controls and real cross-device sweeps. A complete centralized-server condition may be retained as an additional explicitly mapped R0 reference, not substituted for partially offloaded K1/K2. Local Python availability and client-to-local production binding must be evidenced for each surface. If a surface lacks that capability, preserve its specific local infeasibility/unsupported outcome and any separately labelled native baseline; do not silently call Rust, browser code or a remote Python process local Python execution.

Each request's `stage_provider_map` lists capture, wake, STT, orchestration/LLM, each tool, TTS, render, history and playback, with expected local/remote actor and observed host/process/app/model/span evidence. Record provider grants, actual execution and result return for every stage. Configured stage placement is not observed placement. Missing stage execution/correlation is `instrumentation_gap` or `inconclusive`, not a pass.

### 27.2 Accepted sample rule: 900 measured requests PER CONDITION

The owner explicitly resolved the allocation: **900 MEASURED REQUESTS PER CONDITION**, independently for local Python calling, actual HTTP API gateway, and EACH cumulative staged P2P configuration (K1 TTS-only, K2 TTS+LLM, K3 TTS+LLM+STT), for each applicable non-iOS surface/requester-provider pair and fixed workload/model/settings condition. The exact decision was relayed as `msg_4ebcc94f9c09`; it supersedes the earlier unresolved-allocation entry and Section 18's proposed n=300/condition.

Set `n_planned=900` and `allocation_status=owner_accepted_per_condition` in every applicable main coverage cell. Warmups are additional and excluded from p90/p95. Do not divide 900 among modes, split it among surfaces/stages/devices, or pool different devices/stage sets into one percentile. The frozen nine-cell study remains its approved 900 measured total/45 warmups: at full completion it provides 300 per route, not 900 per condition, and only its limited same-host typed-request control scope. Finish it unchanged; do not relabel it as a cumulative stage sweep or full acceptance.

An identical local baseline may be reused across provider comparisons only with explicit evidence mapping to the same requester, surface, runtime/backend/source/app, workload/model/settings, sample population and declared load/session conditions. Record `baseline_dataset_id`, source hashes, actual n, reused-in cell IDs and comparability limits. Reuse refers to one actual retained population; do not count reused requests multiple times as new executed samples or reflexively rerun an unchanged valid baseline. A partial 300-request control cannot be labelled a 900-request baseline.

Infeasible or unsupported local execution retains its bounded admission/failure outcome and affected condition; never manufacture 900 successes or repeatedly force OOM. Keep nominal required n_planned and actual n_measured/n_success separate, with `infeasible_before_main` or `unsupported_documented` evidence and owner-visible acceptance gap. Failures, timeouts, cancellations and incorrect answers among attempted measured requests remain in n_measured/n_total; successful-request percentiles use n_success and never conceal failed denominators. Additional attempts, retries and exclusions consume the declared budget and cannot silently replace failures.

Root derives finite per-condition and per-session wall/request/CPU/RAM/disk/device/network caps from bounded pilots before launching a new main cohort, and publishes the eligible cell count and projected total runtime against Oct 30. Session/restart/warmup allocation is prespecified from pilots; for example, three independently restarted sessions of 300 measured requests may be considered, but that proposed subdivision is not yet an executed design. If the required sample cannot fit actual reservations/capability/caps, report the specific budget/access blocker without reducing n_planned or claiming completion. Inventory and instrumentation audit continue; the sampling ambiguity is resolved and is no longer a blocker.

Publish per-condition Type 7 p90/p95, n_planned=900, n_measured, n_success, warmup/session counts, exact boundary, failed-outcome denominators and clock/route/load limitations. Separate discovery/setup-to-render/playback from warm dispatch-to-reply. No promised speedup precedes actual evidence, especially for local infeasibility.

### 27.3 Required coverage manifest fields and acceptance

```text
cell_id, owner_authorization_ref, allocation_decision_ref, applicability_reason,
requester_surface, runtime_role, requester_host/device_id, provider_host/device_id,
physical_host_relation, country_evidence_refs, local_python/http_api/p2p_mesh_mode,
cumulative_condition(K0/K1/K2/K3/K4+), remote_stage_set,
expected_stage_provider_map, observed_stage_provider_map_refs,
source_commit/dirty_diff_sha, app/binary/backend/model/tokenizer_manifest_sha,
workload/input/audio/tool_hashes, fixed_generation_settings, permissions,
n_planned(900_per_applicable_condition), allocation_status(owner_accepted_per_condition), baseline_dataset_id/reuse_mapping, n_measured, n_success, outcome_denominators,
warmup/cold/setup/session/concurrency_counts, timeout/resource/wall_budget,
p90_ms, p95_ms, quantile_method, latency_boundary, clock_domains/uncertainty,
requester/provider_stage_trace_refs, first_token/first_audio/playback_refs,
ICE_selected_pair/API_endpoint_evidence, per_device_resource/network_refs,
raw_artifact_refs/sha256, execution_state, limitation_ids, next_action
```

Use `null` plus missing reason for unobserved telemetry; applicable main n_planned remains 900, not zero. Correlated clock-safe telemetry from Section 26 is mandatory: discovery/setup and warm intervals, requester/provider queues and inference, render/history, STT/TTS first-audio/full playback where voice applies, per-device resources, actual ICE/API path and network context. Current same-host results cannot populate these fields for a different surface/device/stage set.

Completion requires actual evidence for all applicable approved non-iOS surfaces/modes/cumulative sets and the real cross-device weak-device/feasibility, concurrency/recovery/privacy families, plus explicit source/app/model and raw-evidence mappings. No promised speedup precedes results. Missing physical-device capability, inaccessible authorized host, stage contract or instrumentation is reported specifically and prevents the corresponding claim/acceptance; it is not silently waived. Root's existing objective/acceptance must retain this scope without a new session or ownership transfer. This monitor changes documents only and does not mutate leader goals/ledger or run new cohorts.
