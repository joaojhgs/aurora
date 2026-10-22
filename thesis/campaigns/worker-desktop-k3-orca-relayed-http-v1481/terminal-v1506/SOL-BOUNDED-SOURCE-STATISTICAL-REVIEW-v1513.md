# Bounded saved-source and statistical assessment — K3 V1481

Disposition: archived-output statistical/count assessment complete with no blocking correction identified. The folded-in launcher/custody assessment has one medium custody item to cover or resolve and one resource-lease clarification; neither requests a workload/test rerun. This is one direct source/statistical assessment requested by Root message msg_13555f538041, not merge approval or an additional execution gate. Do not repeat it without substantive changed source or contradictory evidence.

## Scope and exact versions

Read both new analyzers in full and only the imported pairing, prefix/custody, phase-count and quantile functions needed to assess their results. Compared the actual outputs, validation and readable results. No analyzer, workload, test, build, benchmark, pilot or raw-archive rehash was run. No product/source/manifest file was edited and no new agent was created.

| Source | SHA256 |
| --- | --- |
| thesis/analysis/k3_saved_case_history_v1509.py (11994 B) | 28370bdfd79a585d9fe337e7769200dca9a4f3c4c50f5960cceb92972db30fac |
| thesis/analysis/k3_saved_resource_windows_v1510.py (11280 B) | da45e6241a572c004a3d793bdb401d2402044731cf15357c7bb2eec25b14ab3b |
| thesis/analysis/k1_saved_case_history.py, imported functions only | 4a406dd330e2396d38a6ce3b8b5a38362a7727058aff644d0232bdff54474608 |
| thesis/analysis/native_span_metrics_v2.py, Type 7 function | b8fc433bae6e941bd8829df1fa65a5df42af94f2a45d1f3e7174aca8767a7932 |

The two retained ANALYSIS-SOURCE-AS-EXECUTED.py copies are byte-identical to the reviewed analyzers by hash. The imported-source hashes match the native summary. GitNexus was not exposed by the available tool/resource catalog; direct source was used without reindexing. The merge-oriented code-review card's independent-agent workflow was not used, because this request explicitly forbids new workers and asks a bounded statistical assessment.

## Evidence and conclusions

1. Population accounting is consistent with this partial. Native analyzer lines 61–78 bind case bytes/hashes and unique harness/correlation IDs. Lines 110–168 select measured rows separately from warmups, retain the original outcome counts, and distinguish successful, completed and all-observed duration populations. Shared phase_counts at lines 144–150 counts the harness timeout boolean; it does not infer an unavailable lower-level transport exception. Actual summaries show 513 attempts = 512 correct + 1 failed, 387 unattempted and 15 excluded warmups. The readable result uses that narrower timeout wording.

2. Type 7 is correctly implemented for the fixed p50/p90/p95 probabilities: native_span_metrics_v2.py lines 10–17 sorts values and interpolates at (n−1)p. Shared distribution lines 29–36 excludes invalid/nonfinite/negative values and reports its actual numeric denominator. The recorded populations have n512 successful durations and n513 observed-attempt durations; the latter includes failure-observation time and is not called completed audio-to-audio latency. No independent numerical re-execution was performed.

3. Pairing is clock- and identity-scoped. Shared paired_spans lines 86–140 keys receiver, recorder process, clock, stage, handler, span and correlation; requires monotonic completed pairs and equal boundary request/session/operation/attempt IDs. Native analyzer lines 85–96 joins provider records through the received server-correlation IDs, rather than time/order. Lines 115–135 expose multiple invocations separately from exactly-one-span cases. History has 1026 invocations across 513 cases; these are not 1026 measured requests. Two unattributed provider boundaries belong to the reused whole prefix and are not silently added to this cohort. The final missing TTS response ID remains a gap; candidate provider completion does not relabel the caller failure.

4. Resource windows use the saved process generation and within-host intervals. Resource analyzer lines 25–73 validates prefix hashes/contiguity and exact PID/startTicks. Lines 80–116 use samples inside the window without interpolation; observed CPU is first-to-last sample delta divided by the observed interval, with seconds versus CPU-core units distinguished. Interface counters remain separate namespace observations and GPU records remain per device. Lines 145–176 exclude warmups and report window/sample denominators. The failed provider envelope omits unjoined TTS, as the report states.

5. Limitations are material and already disclosed, not reasons to replay this cohort: provider LLM windows 513 but only126 with a sample and2 with two; parent receiver CPU excludes separately spawned Piper; network counters are not per-request bytes; short/unsupported fields stay null; queue/first-token/first-audio/playback/relay-only metrics are unknown. These results cover file audio to validated WAV receipt/decoding, not physical capture, playback, actual P2P or pure protocol overhead.

## Output pins and applicability

- Native SUMMARY.json: 65537 B, SHA256 c12e813cd10255f9dd1b11c18f7cc6727c1055d9b56b83e77158c54b6afb5692.
- Resource SUMMARY.json: 6608 B, SHA256 dd645d4aa531f151097d8d22f25da63beea8b37728b21f189aa53c515e9b4923.
- VALIDATION-v1511.json: 4033 B, SHA256 3c4bf3d5151ec1d0e451cc905af0f149711a36ed495804241841085becd3da03.
- RESULTS.md: 5954 B, SHA256 ec53a6ebf8da50f6e72fd3d7a97554a32052d20878d7576e3a074ad3f7d22db7.
- Root's requester seal/hash validation and provider archive import are consumed as retained evidence; this assessment did not independently rehash all raw files or reproduce the numeric reports.

Both analyzers are intentionally cohort-specific: case analyzer lines 22–24/145 pin the manifest, PIDs and target; resource lines16/170 pin identities and513 cases. They must not be repointed unchanged at a new387 epoch or relabelled as a900-case analysis. Freeze any new epoch analyzer/explicit condition combiner separately; retain these exact executed versions and results.

## Continuity interpretation supplied to the sole plan writer lane

The condition's target is900 measured ATTEMPTS, with failures retained. Original epoch A remains513 attempted =512 correct+1 failed. If Root proves the new epoch has the same actual requester/provider direction, models/weights, fixed audio/task, decoding, effective backend, stage placement, route and declared load/measurement setup, epoch B may cover only the remaining387 new attempts. Keep its own manifest, raw IDs, process/clock identities, fresh15 excluded warmups and result files. Do not edit A or retry its failed sample as a replacement.

Keep epoch-level results separate. An explicitly labelled condition-level descriptive union is permissible only with exact eligibility/lineage mapping and retained epoch stratification; it is not silent pooling of unlike conditions or a claim of stationarity. Derive quantiles from eligible raw rows, never average epoch percentiles. Measured global indices resume514–900; original raw harness ordinal528 includes15 warmups and must not be mistaken for513 measured attempts. Preserve both ordinal schemes via mapping rather than rewriting old rows. If all387 new attempts are correct, the condition would have899 correct+1 failed, not900 successes; no outcome is promised in advance.

Any material audio/model/settings/device/stage/route change remains a distinct cohort under owner instructions. No successor launch is proved by this review. Root owns implementation/admission and the full non-iOS matrix; this review introduces no source, test, packaging or generic product gate.

## Folded-in V1513 actual delta/count assessment

Root msg_b49fbb909c92 added this concrete prepared delta to the SAME bounded assessment. Read SOURCE-DELTA.diff in full and the affected preflight/loop/controller context; verified the prepared file hashes and parent artifact hashes without running its offline count proof or any runtime.

- PREPARATION.json:3645B, SHA256834110e50c22b60d53edf27dcd6ee20a6946343c8dc0d2c4c594d07073c106bc.
- EPOCH-LINEAGE.json:1418B, SHA256a915ed2af9658ebea141e2dd04ff8dc740d3734efac20c6db6e26cd2e469519e.
- SOURCE-DELTA.diff:6229B, SHA256217de4b0be1f20b924ae3a65f4e04b9ff7cfda561167819f541467c9e6b0438a.
- Canonical source root:thesis/harness/distributed-k3-http-remaining-v1513/. Runner SHA256a1d39df18f20a37cd97e94eeba858ebee6b1874b4be00b235fb31b7db0e48954; controller94252f741f4df014fe882b4ad08d2b8ce3540ba3f4f85c3cb8c71cc05ab9c6e9; receiver_proof40ac64685ffb078b9d9aa983916d20df9c218badc40ae46b29c7398e4a0d259f.
- Parent measured rows hash6c02415fb32763eeb2878e914799d991ff7738469f7aa667f079f913d27a1a37 and validation hash3c4bf3d5151ec1d0e451cc905af0f149711a36ed495804241841085becd3da03 match the actual retained files.

No blocking count/offset issue found in this delta. Runner preflight407–420 distinguishes condition900 from epoch387 and preserves the parent failure. Runner583–625 loops15+387; phase_index is ordinal minus15 only for measured rows, so condition_measured_index=513+phase_index covers514–900 while warmups get null. New harness IDs are namespaced V1513; receiver proof expects the same warmup namespace. Controller118–152/249–254 agrees on condition900/epoch387 and retains hash/route/backend bindings. The delta changes three files; prepared hashes match the inspected files. Adapter/composition/bootstrap/bindings/observer/telemetry/resource sampler and candidate fixture/inventory pins are unchanged in the preparation record.

Applicability/operational limits: this is SOURCE_PREPARED_NOT_LAUNCHED, not a runtime pass or same-process resume. Fresh provider identity/config/manifest evidence and15 excluded/45 strictly joined warmups remain Root's existing admission contract. The inherited57600s requester cap does not extend the existing provider reservation/deadline of2026-10-19T00:08:53.328388UTC; Root's launcher must respect the actual remaining reservation. No added pilot or replay is requested.

Root msg_710f9178812d reports read-only requestcdac7533-7309-4015-be6f-69bae4a8f0ee first returned terminal_not_writable and the supported SAME-ID retry returned uncertain_delivery/may_have_reached_before_restart. Root alone reconciles original control47858; no inference of host/model exit and no fresh resend/competing control. Preserve the compact accepted-operation receipts in canonical thesis/ as well as any transient .git working copies under the owner storage rule. This control uncertainty is distinct from the earlier12:52 TTS delivery failure.

Assessment scope is now complete for both analyzers and this exact delta. No implementation, model, measurement, test, merge, publication or independent-agent approval was performed.

## Closed helper assessment — current operational findings upward

Root msg_ac6b551a48ef additionally requested the concrete five V1513 helper sources. Read each once, including the launch/admission/finalizer/custody paths. No helper was executed. Source pins as inspected:
- prepare_k3_remaining_v1513.py: cbe77c21d3cfc105fba0c4a95130443fe2c9b8a6795af6b25a03518d9dd1443e.
- k3_warmup_finalize_v1513.py: cf68c7c5e7893e5c0939afa479741bf4c6e82eaa069937b4448241307a4d7266.
- k3_remote_warmup_proof_v1513.py: fed0a8815ea1436b1b29e39fbda32e4bc04b4424694d0813eef1cddddf75e327.
- k3_remaining_root_v1513.py: initial inspected ac9c24a39de001e5024a33eb8f1dc10dd8f629c5f0126715745bf206519c4f4b; Root corrected only the health header before traffic, and the closing source hash97f5beb7404d985f32f38a4cd5d40af13c6f73be2912016dab9f411d952562df has line144 X-API-Key. No health/model request was run by this assessment.
- custody_k3_requester_v1513.py: 9a99ff7df27f344fa5edd31c793aa0063427fe99de6c082125b05abee21aec57.

Positive findings: preparation checks513 unique parent requests and indices1–513, retains512correct+1failed and produces a disjoint514–900 mapping. Draft/launch compare the explicit scientific parameter set to the parent and require current same-provider PID/config/manifest evidence; they do not extend its deadline. The actual workload remains behind15 new strict warmups/45 native model joins, with frozen model/constructor/GPU proof. The finalizer observes the same cases and same accepted proof output, never creates model requests or blindly resends an ambiguous command, and publishes a fully written proof. The copier binds a supplied frozen manifest, keeps complete case rows/audio hashes, uses atomic checksummed writes with a2GiB floor and contiguous line-ended telemetry prefixes, and exposes errors/pending inputs rather than inventing data.

Operational findings sent upward once as msg_e108aa243160:
1. MEDIUM — incomplete standalone full-log custody coverage. custody_k3_requester_v1513.py lines122–139/181–204 includes condition/proof/harness and three telemetry prefixes, but not the backend/controller stdout and all process/runtime/final summary records. The root launcher writes canonical REQUESTER-LAUNCH.json, which does not cover every omitted record. Under the owner's full-logs/no-.git-only rule, Root should wire incremental canonical retention or identify an already-wired equivalent before claiming full durable-log coverage. Preserve privacy checks and original bytes; no data rerun or packaging matrix is requested.
2. WATCH — flock is an availability check, not a retained lease. k3_remaining_root_v1513.py lines115–116 exits its lock context before subsequent launch steps. Existing actual Root resource reservations may supply the exclusion; do not describe this transient check as holding an OS lease. If OS exclusion is intended, retain/hand off ownership through the protected lifecycle. This is not a new demand for synthetic contention testing.

Current readmission remains an independent capability issue. Root's canonical provider-readmission/PENDING-RECEIPT.json is1719B/SHA256bc64ca86bde48eef6670cbbfe90baf7ff592638d8728ef138b00462496cf0438, statusPENDING_ORCA_TERMINAL_PROMPT_NO_READMISSION_RESULT_NO_LAUNCH, exactrequestcdac7533-7309-4015-be6f-69bae4a8f0ee, original term_d565/inc034ff/cursor47858, one supported same-ID retry, zero fresh resends, zero new model requests. Root confirms five compact CLI receipts9258B are now canonical as well as original private copies. Same-Run escalationmsg_dcb99ddc85f9 was received by Root; owning-Orca capability correction is not proved by that acknowledgment.

This is the completed ONE requested source/statistical/count/helper assessment, not merge approval, an execution command, or a generic gate. Current findings apply to the pinned versions; Root owns any narrow fix or equivalent-coverage receipt. Do not repeat closed archived-data checks or add test matrices.
