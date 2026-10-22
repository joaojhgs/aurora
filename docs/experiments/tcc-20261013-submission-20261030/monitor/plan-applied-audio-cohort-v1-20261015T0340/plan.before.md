# Aurora Future Work Test Requirements

> The owner designated this existing full document authoritative and the original Aurora monitor its sole document writer. Original T0–T13 requirements remain preserved; Sections 25–29 now govern execution and acceptance. Latest owner scope excludes iOS and makes real non-iOS cross-device/surface cumulative offload mandatory: TTS-only → TTS+LLM → TTS+LLM+STT, with 900 measured requests PER CONDITION. Canonical thesis application/submission remains owner-review gated. Earlier HELD, reduced/optional scope and n=300/condition proposals are superseded where they conflict; historical results are never current validation.
> The owner designated this existing full document authoritative and the existing Aurora monitor its document writer. The complete original T0–T13 plan remains below; Sections 12–27 govern the October 30 evaluation. Latest owner authorization in Section 25 permits Aurora tests, benchmarks, builds and necessary test deployments through existing sessions; canonical thesis application and submission remain gated. Earlier HELD wording is historical and superseded within that exact scope. June results remain historical evidence, not validation of the October checkout.

Revision provenance:
- Original 829-line document: SHA256 `323e3926af9d0e2cb23a3bf7eb3438e292fe56c55d8fd7b45d1ef18f164e6a00`; original material passport dated 2026-06-16.
- Reversible backup and review package: `.omx/artifacts/tcc-20261013-submission-20261030-monitor-ctx_37b4d0a3c14f/`.
- Target: 2026-10-30, `America/Sao_Paulo`; exact submission cutoff UNKNOWN. Proposed freeze dates below are planning choices, not institution deadlines.
- Canonical TCC project remains `846e3e40-f48b-4e20-8aa7-88ef55b67da3`, workspace `846e3e40-f48b-4e20-8aa7-88ef55b67da3::/home/developer/projects/tcc`, host `ssh:ssh-1786238480967-semdev`. The personal synced document is the owner-approved editing surface; this does not transfer project ownership or authorize remote manuscript writes.
- Coordination: original Aurora Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`; original Root `term_6a00d9ee-792a-4daf-8578-236290e33108`; guide lineage `hermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4`.
- Owner reports Manager verified `obsidian-sync-status` with `readyForUse=true` and `inSyncWithHub=true`. This is attributed owner/Manager evidence; this writer did not independently invoke that sync check.
- Owner-authoritative update permission resolves question `msg_372d81958aa2` and blocker `msg_5964c9dfcad2`. Unknown host countries, phone capabilities, and missing live paper-session evidence are conditional readiness items, not drafting blockers.

Material passport:
- Origin skill: academic-research-suite experiment-agent, plan mode
- Date: 2026-06-16
- Verification status: requirements artifact, no experiments executed here
- Target use: future works section, experiment backlog, and final report evidence plan

## 1. Purpose

This document defines the tests that the Aurora project should add before a final performance and deployment comparison can support strong claims in the thesis. It focuses on requirements, task boundaries, inputs, metrics, and report artifacts. It does not implement the tests.

The future work should compare three deployment families:

1. **100 percent local execution**: wake word, STT, orchestrator, LLM, tools, and TTS run on the user device.
2. **100 percent remote deployed server execution**: the client sends requests to a deployed server that performs STT, orchestration, LLM execution, tool calls, and TTS. The client captures input and plays output.
3. **P2P staged offload**: the client uses authorized peers through the Aurora mesh. Each single-resource level runs the complete assistant flow end to end while moving only one named resource to the peer: orchestrator, STT, TTS, or wake word. The test must keep capture, routing, fallback, response generation, and playback active so the measurement reflects real user-visible latency rather than isolated microbenchmarks.

The report must separate a deployed server from a P2P peer. A deployed server represents a centralized service endpoint. A P2P provider represents a user-authorized device that joins the mesh and receives requests under Aurora contracts and permissions. The P2P tests should show how latency changes as the mesh carries resources with different compute demand: orchestrator and LLM first, then STT, then TTS, then wake word. Wake-word offload is not a likely production default, because small IoT devices can run wake-word models and commercial assistants such as Alexa commonly keep wake-word detection local. It remains useful as an end-to-end stress case and as a cloud-assistant comparison where the system sends more of the voice pipeline away from the client.

## 2. Historical June 2026 test coverage (retained provenance)

The final thesis evidence records these current results:

- Syntax check of the main contribution paths passed with `python -m compileall`.
- A targeted Python 3.11 unit run passed with `151 passed, 8 skipped, 17 warnings in 16.03 s`.
- The inspected test tree contains 82 `test_*.py` files: 63 unit tests, 18 integration tests, and 1 fixture data file.
- No end-to-end or performance test file was found in the inspected tree.

The current tests already cover several architectural risks:

| Area | Existing coverage | Evidence value |
|---|---|---|
| Contract registry | Registration and export tests | Confirms that services can declare contracts in the shared model. |
| MeshBus | Local routing, remote routing, events, and fallback tests | Confirms basic request routing behavior. |
| Peer registry and routing table | Peer choice, latency, capacity, and fallback tests | Supports claims about routing data structures, not live network behavior. |
| ACL and identity | Permission matching, scope checks, and identity flow tests | Supports the security model at unit level. |
| RPC authentication | Authenticated and rejected calls | Supports trust-boundary behavior for RPC handlers. |
| RTC auth enforcement | WebRTC auth gate and client auth tests | Supports the gate before live peer transport validation. |
| Pairing flow | Integration-level pairing acceptance and rejection | Supports enrollment semantics, subject to full environment rerun. |
| Process mode | Existing tests for services in processes | Needs rerun in a complete environment with Redis and process orchestration. |

The current tests do not yet support performance claims. They also do not prove live Redis/BullMQ operation, full process-mode execution, NAT traversal, real WebRTC behavior under network loss, or voice-pipeline quality.

## 3. Evidence needed for a strong final-report write-up

The final report should include these evidence classes before it compares local, remote, and P2P deployment:

1. **Reproducible environment**
   - Aurora commit hash.
   - Python, `uv`, OS, kernel, browser/runtime, Redis, WebRTC, and model versions.
   - Hardware specs for client, P2P provider, and remote server.
   - Network shape for each run: LAN, WAN, RTT, jitter, packet loss, bandwidth cap, NAT type when available.

2. **Functional integration evidence**
   - Full unit suite, full integration suite, Redis-backed services, process mode, pairing, revocation, failover, and fallback.
   - Test results in JUnit or equivalent machine-readable format.
   - Logs that show request IDs across gateway, mesh, provider, and local fallback.

3. **Performance traces**
   - One JSONL trace per request with stage timestamps.
   - CSV summaries for median, p90, p95, p99, error rate, timeout rate, and fallback rate.
   - Plots for latency distribution, stage waterfall, resource usage, and quality trade-offs.

4. **Quality measurements**
   - STT word error rate on a fixed audio set.
   - Wake word false accept rate and false reject rate.
   - Orchestrator task success rate and tool-call correctness.
   - TTS first-audio latency, total synthesis time, and a perceptual quality proxy or small human rating protocol.

5. **Security and privacy checks**
   - Permission-denied cases for each offloaded stage.
   - Evidence that revoked peers cannot receive work.
   - Transport metadata inventory: what the client sends, what the peer receives, and what the signaling layer can observe.

## 4. Deployment matrix to test

Active scope note: the original single-resource P1–P5 taxonomy is retained below. Sections 26–28 require the cumulative K1 TTS-only, K2 TTS+LLM, K3 TTS+LLM+STT sweep across applicable same-device and real cross-device surfaces; these original isolated-resource examples cannot substitute for it.

| Code | Topology | Wake word | STT | Orchestrator and LLM | TTS | Tool execution | Main question |
|---|---|---|---|---|---|---|---|
| L0 | 100 percent local | Client | Client | Client | Client | Client | Can Aurora run without remote compute, and what does it cost? |
| R0 | 100 percent remote server | Client by default, optional server condition | Server | Server | Server | Server | How does a centralized Aurora deployment behave as a cloud-assistant baseline? |
| P1 | E2E P2P orchestrator only | Client | Client | P2P peer | Client | Client or peer by contract | What user-visible cost and benefit appear when the mesh carries the heaviest reasoning resource? |
| P2 | E2E P2P STT only | Client | P2P peer | Client | Client | Client | What happens when the mesh carries speech recognition but the rest of the flow stays local? |
| P3 | E2E P2P TTS only | Client | Client | Client | P2P peer | Client | What happens when the mesh carries speech synthesis but the rest of the flow stays local? |
| P4 | E2E P2P wake word only | P2P peer or edge satellite | Client | Client | Client | Client | Can the infrastructure still complete the full flow when the smallest resource moves off-device? |
| P5 | E2E P2P cloud-like full voice pipeline | Client by default, optional peer condition | P2P peer | P2P peer | P2P peer | P2P peer by contract | How close can user-owned P2P infrastructure get to a commercial cloud-assistant pattern? |

P1 through P4 are single-resource offload tests. Each one must execute the whole assistant flow from audio capture or wake trigger to final playback while outsourcing only the named resource. P5 is the combined cloud-like comparison. The report should treat wake-word offload as experimental because the wake-word stage listens before explicit user intent and needs stronger privacy evidence than later stages.

## 5. Shared instrumentation requirements

Each test task should produce the same artifact structure:

```text
evidence/performance/<task-id>/<run-id>/
  config.json
  environment.json
  traces.jsonl
  summary.csv
  junit.xml
  logs/
  figures/
  README.md
```

Each request trace must include:

- `run_id`, `request_id`, topology code, client ID, provider ID, commit hash.
- Audio sample ID or text prompt ID.
- Network profile ID.
- Timestamps for capture start, wake-word trigger, STT start, STT end, orchestrator receive, first token, final token, TTS start, first audio, final audio, playback start, playback end.
- Transport timings: peer discovery, pairing reuse or new pairing, WebRTC setup, data-channel open, first byte sent, first byte received, retry count.
- Result status: success, timeout, permission denied, fallback used, provider unavailable, malformed response, or test harness error.
- Resource samples: CPU, RAM, GPU, VRAM, network bytes, and power or battery drain if the hardware exposes it.

Each run should use at least five warm-up requests and at least thirty measured requests per workload item. If hardware time limits force a smaller sample, the report must state the reduced sample size and avoid broad performance claims.

## 6. Workload requirements

Create fixed workloads so each topology receives the same inputs.

### Voice workload

Use audio files with stable hashes and transcripts:

- Short command: one sentence, no tool call.
- Medium command: two or three sentences with context.
- Long command: a paragraph-length instruction.
- Tool command: asks Aurora to use one tool or service.
- RAG command: asks a question that requires retrieval if the project enables RAG.
- Noisy command: background noise at controlled SNR levels.
- Accented or non-native speech sample, if the consent and dataset license allow it.
- Silence and non-command speech for wake-word and false activation tests.

### Text workload

Use text prompts for orchestrator tests so the report can isolate orchestration from STT and TTS:

- Direct assistant question.
- Tool-call request.
- Multi-step planning request.
- Permission-sensitive request that a peer must reject without the required scope.
- Timeout-prone request that triggers fallback.

### Network profiles

Run each topology under these profiles when possible:

| Profile | RTT | Jitter | Packet loss | Bandwidth | Purpose |
|---|---:|---:|---:|---:|---|
| N0 LAN | under 10 ms | under 5 ms | 0 percent | no cap | Best-case local network. |
| N1 WAN low | 50 ms | 10 ms | 0 percent | no cap | Common remote-server path. |
| N2 WAN medium | 100 ms | 20 ms | 1 percent | moderate cap | Usable but stressed network. |
| N3 WAN high | 200 ms | 50 ms | 3 percent | moderate cap | Degraded network. |
| N4 Loss stress | 100 ms | 30 ms | 5 percent | cap set | Reconnect and fallback stress. |

## 7. Task specifications

### T0. Reproducible environment and instrumentation

Objective:
- Build the measurement harness used by every performance task.

Setup:
- Client device, P2P provider device, and remote server provisioned with pinned Aurora commit.
- Redis, process mode, WebRTC dependencies, STT model, TTS model, LLM backend, and monitoring tools installed.

Inputs:
- Hardware inventory script.
- Network profile definitions.
- Workload manifest with audio hashes and text prompt IDs.

Metrics:
- Harness overhead in milliseconds.
- Clock synchronization error between machines.
- Missing metric count per request.

Procedure:
1. Capture environment data into `environment.json`.
2. Run a no-op request through each process boundary.
3. Verify monotonic timestamps and shared request IDs.
4. Export JSONL and CSV artifacts.

Pass criteria:
- The harness records all required timestamps for at least 95 percent of requests.
- Clock error stays below the smallest latency bucket used in the report, or the analysis computes only single-host intervals for affected stages.
- The harness overhead report exists.

Artifacts:
- `environment.json`, `config.json`, `traces.jsonl`, `summary.csv`, harness overhead report.

Report use:
- Supplies the methods subsection and supports reproducibility.

### T1. Full baseline functional validation

Objective:
- Rerun the existing Aurora test suite in a complete environment before performance tests begin.

Setup:
- Python 3.11, `uv`, Redis server, WebRTC dependencies, and any optional extras required by integration tests.

Inputs:
- Existing test tree.
- Service configuration for local, process, Redis, and mesh modes.

Metrics:
- Passed, failed, skipped, and warning counts.
- Runtime per suite.
- Failure category if any test fails.

Procedure:
1. Run full unit tests.
2. Run full integration tests.
3. Run process-mode tests with Redis.
4. Run pairing, revocation, and RTC auth tests.
5. Store JUnit output and logs.

Pass criteria:
- No failing test in the required baseline group.
- Skips require written justification.
- Redis and process-mode groups must run, not only collect.

Artifacts:
- JUnit files, logs, command transcript, skip justification table.

Report use:
- Extends the current evidence beyond the 151-test targeted unit run.

### T2. 100 percent local performance baseline

Objective:
- Measure Aurora when every assistant stage runs on the client.

Setup:
- One client device.
- Wake word, STT, orchestrator, LLM, TTS, tools, and local storage enabled on the client.

Inputs:
- Full voice workload.
- Text workload for orchestrator isolation.
- Network profile N0 only, unless the local system still uses networked dependencies.

Metrics:
- End-to-end latency.
- Wake-word detection delay.
- STT latency and real-time factor.
- Orchestrator first-token and final-token latency.
- TTS first-audio and final-audio latency.
- CPU, RAM, GPU, VRAM, network bytes, and power draw.
- STT WER, TTS quality proxy, wake-word false accept and false reject.

Procedure:
1. Warm up all models.
2. Run each workload item with repeated trials.
3. Capture stage traces and resource samples.
4. Record model load time separately from request latency.

Pass criteria:
- At least 95 percent of measured requests complete without timeout.
- The trace contains all stage timestamps for each successful request.
- The report records any client resource saturation.

Artifacts:
- Local traces, resource time series, summary tables, latency plots.

Report use:
- Serves as the baseline for privacy-preserving and offline operation claims.

### T3. 100 percent remote deployed server baseline

Objective:
- Measure Aurora when a deployed server performs the assistant pipeline after client capture.

Setup:
- One client device.
- One deployed server with documented CPU, GPU, RAM, region, and network path.
- Server hosts STT, orchestrator, LLM, TTS, and tools.
- Wake word stays on the client in the default condition. Add a separate remote wake-word condition only if the thesis wants to discuss always-on remote audio.

Inputs:
- Same voice and text workloads as T2.
- Network profiles N1 through N4, plus N0 if the server sits on the same LAN for a lab condition.

Metrics:
- End-to-end latency.
- Upload time, server processing time, download time.
- STT, orchestrator, LLM, and TTS stage times on the server.
- Server CPU, GPU, RAM, VRAM, and network bytes.
- Client CPU, RAM, network bytes, and power draw.
- Error rate and timeout rate.

Procedure:
1. Deploy the server with a pinned image or setup script.
2. Run health checks and model warm-up.
3. Execute the workload under each network profile.
4. Store server logs with request IDs that match client traces.

Pass criteria:
- The server processes all stages assigned to it.
- Request IDs match across client and server logs.
- The test records network profile settings and measured RTT.

Artifacts:
- Client traces, server traces, deployment manifest, network measurements, summary plots.

Report use:
- Gives the centralized baseline for the comparison against P2P.

### T4. E2E P2P orchestrator-only offload

Objective:
- Measure the complete assistant flow while the mesh outsources only the orchestrator and LLM resource to an authorized peer.

Setup:
- Client runs wake word, STT, TTS, and local tools.
- P2P provider runs orchestrator and LLM service contract.
- Aurora pairing, peer identity, ACL scopes, MeshBus routing, and fallback enabled.

Inputs:
- Text workload.
- Full voice workload, including local STT before peer orchestration and local TTS after the peer response.
- Permission-sensitive prompts.
- Network profiles N0 through N4.

Metrics:
- Peer discovery time.
- Pairing reuse or setup time.
- WebRTC data-channel setup time.
- Orchestrator first-token and final-token latency.
- Mesh routing overhead versus direct local orchestration.
- Fallback rate when peer fails.
- Permission-denied latency for rejected requests.

Procedure:
1. Pair client and provider.
2. Run the full voice flow: local wake word, local STT, peer orchestrator and LLM, local TTS, and playback.
3. Repeat after provider removal or ACL revocation.
4. Inject provider timeout and verify local fallback.

Pass criteria:
- Authorized requests reach the peer and return valid responses.
- Unauthorized requests receive permission denial without provider execution.
- Fallback works after timeout or provider removal.

Artifacts:
- Mesh traces, ACL decisions, provider logs, fallback logs, comparison with T2 orchestrator timings.

Report use:
- Tests the heaviest single-resource P2P offload claim while keeping audio stages local.

### T5. E2E P2P STT-only offload

Objective:
- Measure the complete assistant flow while the mesh outsources only speech recognition.

Setup:
- Client runs wake word, orchestrator, LLM, tools, TTS, and playback.
- P2P provider runs only the STT service contract.
- Aurora pairing, peer identity, ACL scopes, MeshBus routing, and fallback remain enabled.

Inputs:
- Voice workload with reference transcripts.
- Silence and non-speech samples for rejection behavior.
- Network profiles N0 through N4.

Metrics:
- End-to-end latency from captured speech to playback.
- Audio upload time.
- STT processing time on provider.
- Transcript return time.
- Local orchestrator and local TTS latency after the remote transcript returns.
- STT WER.
- Client resource reduction versus T2.
- Provider resource usage.
- Failure and fallback rate.

Procedure:
1. Run the full voice flow locally as the L0 baseline.
2. Run the full voice flow again with only STT routed to the P2P provider.
3. Compare transcripts against references.
4. Run with provider permission granted, then denied.
5. Run degraded network profiles to find the point where local STT wins.

Pass criteria:
- P2P STT returns transcripts within the configured WER tolerance while the full assistant flow completes.
- The test records when network latency cancels provider compute gains.
- The system falls back or fails with a typed error when the provider cannot respond.

Artifacts:
- Audio manifest, transcript outputs, WER table, resource traces, latency distributions.

Report use:
- Supports or rejects claims that a stronger peer can help low-power clients with speech recognition.

### T6. E2E P2P TTS-only offload

Objective:
- Measure the complete assistant flow while the mesh outsources only speech synthesis.

Setup:
- Client runs wake word, STT, orchestrator, LLM, tools, and playback.
- P2P provider runs only the TTS service contract.
- Aurora pairing, peer identity, ACL scopes, MeshBus routing, and fallback remain enabled.

Inputs:
- Full voice workload that produces fixed short, medium, and long response texts.
- Text-only workload for isolating TTS after local orchestration.
- Multilingual or accented voice output if Aurora supports it.
- Network profiles N0 through N4.

Metrics:
- End-to-end latency from captured speech to playback.
- Text upload time.
- TTS first-audio latency.
- TTS final-audio latency.
- Audio download time.
- Audio duration and generated file size.
- TTS quality proxy or human rating score.
- Client resource reduction versus T2.

Procedure:
1. Run the full voice flow locally as the L0 baseline.
2. Run the full voice flow again with only TTS routed to the P2P provider.
3. Stream audio if supported, otherwise return complete files.
4. Test provider timeout and local fallback.
5. Compare first-audio latency, not only total synthesis time.

Pass criteria:
- P2P TTS returns playable audio while the full assistant flow completes.
- The trace separates synthesis time from transfer time.
- Quality differences and voice-model differences appear in the report.

Artifacts:
- Generated audio files or hashes, latency traces, quality scores, resource traces.

Report use:
- Shows whether P2P helps speech output or only shifts compute cost.

### T7. E2E P2P wake-word-only offload

Objective:
- Measure the complete assistant flow while the mesh outsources only wake-word detection.

Setup:
- Client captures microphone input, then uses a P2P edge peer or satellite device for wake-word detection.
- Client runs STT, orchestrator, LLM, tools, TTS, and playback after activation.
- Condition W0 keeps wake word on the client.
- Condition W1 runs wake word on a P2P edge peer on the same LAN.
- Condition W2 runs wake word on a remote server only if the ethics and privacy section allows it.

Inputs:
- Wake-word dataset with positive, negative, noisy, and near-miss samples.
- Full voice workload after accepted wake events.
- Long background audio segments for false activation measurement.
- Network profiles N0 through N4 for W1 and W2.

Metrics:
- End-to-end latency from wake event to playback.
- False accept rate.
- False reject rate.
- Detection delay.
- Network bytes before activation.
- Audio exposure duration before user intent.
- Client power draw.
- Privacy inventory: who receives pre-activation audio.

Procedure:
1. Run the full assistant flow with local wake word as W0.
2. Run the full assistant flow again with only wake-word detection routed to the P2P edge peer as W1.
3. Run W2 only if the project accepts the privacy cost of remote pre-activation audio.
4. Record detection decisions, timing, and pre-activation network exposure.
5. Continue the flow through STT, orchestration, TTS, and playback for accepted wake events.

Pass criteria:
- W0 establishes the safe default baseline.
- W1 or W2 must show measured benefit large enough to justify the privacy cost before the report can recommend it.
- The report must identify wake-word offload as an infrastructure stress test rather than a production recommendation.

Artifacts:
- Confusion matrix, detection-delay table, full-flow traces, network-exposure table, privacy notes.

Report use:
- Shows whether Aurora's mesh can support the smallest voice resource end to end, while explaining why local wake word remains the practical default.

### T8. E2E P2P cloud-like full voice pipeline

Objective:
- Measure the full P2P assistant pipeline when a peer handles the resources that a commercial cloud assistant would normally handle.

Setup:
- Client runs wake word by default and handles capture and playback.
- P2P provider runs STT, orchestrator, LLM, tools if permitted, and TTS.
- Add an optional condition where the peer also handles wake word, matching the most aggressive cloud-like design.
- ACL contracts specify which stage each peer can execute.

Inputs:
- Full voice workload.
- Permission-sensitive commands.
- Network profiles N0 through N4.

Metrics:
- End-to-end latency from captured speech to playback.
- Stage-level latencies.
- Total bytes sent and received.
- Peer CPU, GPU, RAM, VRAM.
- Client power draw reduction versus T2.
- Success, timeout, retry, and fallback rates.

Procedure:
1. Pair client and peer.
2. Run the complete voice workload with client wake word and peer STT, orchestration, tools, and TTS.
3. Repeat with optional peer wake word if approved for the experiment.
4. Repeat with one service contract removed at a time.
5. Test provider shutdown mid-request.
6. Compare against T2 and T3 under the same workload.

Pass criteria:
- The pipeline completes with typed traces for all stages.
- Contract removal prevents the matching stage from running on the peer.
- Provider failure triggers the designed fallback or error path.
- The analysis separates client-local wake word from optional peer wake word.

Artifacts:
- Full pipeline traces, contract logs, failure injection logs, comparison plots.

Report use:
- Gives the main evidence for a user-owned P2P alternative to a centralized voice-assistant pipeline.

### T9. Network degradation, NAT, and reconnect tests

Objective:
- Measure how Aurora behaves when P2P connectivity degrades.

Setup:
- Client and provider behind different network configurations where possible: same LAN, home NAT, carrier-grade NAT or mobile hotspot, and relay/TURN if supported.

Inputs:
- Subset of workloads from T4 through T8.
- Network profiles N0 through N4.
- NAT scenario manifest.

Metrics:
- Pairing success rate.
- WebRTC connection success rate.
- Data-channel open time.
- Reconnect time.
- Request success rate after loss injection.
- Fallback time.

Procedure:
1. Run P2P pairing for each NAT scenario.
2. Execute a small workload after connection.
3. Inject loss, delay, peer restart, and client restart.
4. Record reconnect and fallback behavior.

Pass criteria:
- The test distinguishes pairing failure, transport failure, service failure, and permission denial.
- The report states which network cases Aurora supports and which remain future work.

Artifacts:
- NAT matrix, connection logs, failure taxonomy, reconnect plots.

Report use:
- Bounds claims about P2P deployment outside a lab LAN.

### T10. Security, permission, and fallback tests during performance runs

Objective:
- Verify that performance paths do not bypass Aurora permissions.

Setup:
- Same as T4 through T8.
- At least two peers: one authorized and one unauthorized.

Inputs:
- Permission-sensitive requests for STT, TTS, orchestrator, and tool execution.
- Revocation event during active session.
- Expired token and malformed token cases.

Metrics:
- Rejection rate for unauthorized calls.
- Time to reject.
- Post-revocation acceptance count, which should be zero.
- Fallback choice after denial.
- Audit-log completeness.

Procedure:
1. Route authorized and unauthorized requests through the same performance harness.
2. Revoke permissions during repeated runs.
3. Attempt stage execution after revocation.
4. Compare audit logs against request traces.

Pass criteria:
- Unauthorized peers execute zero protected stages.
- Revoked permissions take effect within the documented window.
- Each denial appears in logs with request ID, peer ID, and reason.

Artifacts:
- ACL trace table, denial logs, revocation timeline, security summary.

Report use:
- Connects performance claims to the project security model.

### T11. E2E stress test with many clients sharing one peer resource

Objective:
- Measure how end-to-end latency grows when many clients send work to one peer that provides a resource, with orchestrator and LLM as the primary stress target.

Setup:
- One P2P provider advertises one resource contract, starting with orchestrator and LLM.
- Multiple clients run the full assistant flow and route only the selected resource to that provider.
- Use the same harness as T4 through T8 so each request still captures full-flow latency.
- Repeat the test later for STT, TTS, and wake word if the project needs resource-specific saturation curves.

Inputs:
- Fixed voice workload and text workload.
- Client concurrency levels such as 1, 2, 5, 10, 20, and the highest level the lab hardware can sustain.
- Ramp profile: warm-up, steady load, burst load, and cooldown.
- Network profiles N0 through N3 for the main experiment, with N4 as an optional failure stress profile.

Metrics:
- End-to-end latency per client.
- Orchestrator queue time, processing time, and response time.
- Throughput in completed requests per minute.
- Success rate, timeout rate, retry rate, and fallback rate.
- Provider CPU, GPU, RAM, VRAM, queue depth, and active request count.
- Client-side fairness: median and p95 latency per client ID.
- Backpressure behavior: rejected requests, delayed requests, or local fallback.

Procedure:
1. Pair all clients with the same provider.
2. Run the single-client baseline with full traces.
3. Increase client concurrency one level at a time.
4. Keep the workload, model, provider, and network profile fixed while concurrency changes.
5. Record the point where p95 latency, timeout rate, or provider resource use crosses the chosen threshold.
6. Repeat with provider shutdown during load to measure fallback behavior under pressure.

Pass criteria:
- The test records full-flow traces for every successful request.
- The report identifies the first concurrency level where latency or timeout rate becomes unacceptable under the chosen threshold.
- The system reports overload as a typed timeout, rejection, queue delay, or fallback event.
- No client should starve without an explicit error or fallback trace.

Artifacts:
- Concurrency matrix, load traces, provider resource time series, queue-depth plot, throughput and p95 latency curves.

Report use:
- Shows how Aurora behaves when a single user-owned peer becomes a shared resource for many clients.
- Gives the future works section a concrete path for capacity planning and overload handling.

### T12. E2E latency-aware peer redirection test

Objective:
- Verify that Aurora routes a request to the lower-latency peer when two peers advertise the same resource.

Setup:
- One requesting client or peer runs the full assistant flow.
- Two provider peers advertise the same resource contract, starting with orchestrator and LLM.
- Provider A and Provider B have identical permissions and compatible service contracts.
- The test harness controls or measures latency to each provider.
- Aurora routing-table updates, peer latency measurements, and MeshBus decisions are logged with request IDs.

Inputs:
- Full voice workload for E2E behavior.
- Text workload for isolating orchestrator routing.
- Latency scenarios:
  - A faster than B.
  - B faster than A.
  - A starts faster, then becomes slower.
  - B starts slower, then becomes faster.
  - A becomes overloaded while B remains available.
- Network profiles N0 through N4, or equivalent controlled latency injection.

Metrics:
- Selected provider per request.
- Measured RTT or service latency to each provider.
- Routing decision latency.
- Time to converge after latency changes.
- Wrong-peer selection rate under the expected policy.
- Route oscillation count when peers have similar latency.
- End-to-end latency difference between chosen peer and non-chosen peer.
- Fallback rate after selected-peer failure.

Procedure:
1. Pair the requester with both provider peers.
2. Confirm that both peers can execute the same resource contract.
3. Run the workload when Provider A has lower measured latency and verify that Aurora selects A.
4. Swap the latency conditions and verify that Aurora selects B after the routing table updates.
5. Add load to the faster peer and verify whether Aurora uses effective latency, queue delay, or the documented routing score.
6. Shut down the selected peer and verify fallback or redirection to the remaining peer.
7. Repeat with similar peer latencies to detect route oscillation.

Pass criteria:
- Aurora selects the peer that the documented routing policy ranks first for the measured condition.
- The trace records the metrics that explain each routing decision.
- After latency changes, the route converges within the documented update window.
- Selected-peer failure redirects or falls back with a typed event.
- Similar-latency peers do not cause harmful oscillation or duplicate execution unless the routing policy allows it.

Artifacts:
- Peer-selection trace table, latency-injection manifest, routing-table snapshots, convergence plot, oscillation report, fallback logs.

Report use:
- Supports claims that Aurora can choose between equivalent peers based on measured performance instead of static configuration.
- Shows how mesh routing behaves when resource availability and latency change during operation.

### T13. Analysis and report-writing package

Objective:
- Produce the tables, figures, and text evidence needed for the thesis chapter.

Setup:
- Completed artifacts from T0 through T12.
- Analysis scripts with pinned dependencies.

Inputs:
- All `traces.jsonl`, `summary.csv`, JUnit files, logs, workload manifests, routing snapshots, and stress-test traces.

Metrics:
- Median, p90, p95, and p99 latency.
- Bootstrap confidence intervals for main comparisons.
- Effect sizes between L0, R0, and P2P levels.
- Stress-test capacity points and latency slopes.
- Peer-selection correctness and convergence time.
- Error and fallback rates.
- WER, wake-word error rates, and TTS quality scores.

Procedure:
1. Validate that every run has environment and config files.
2. Join traces by topology, workload, and network profile.
3. Generate tables and plots.
4. Write a claims table that maps each thesis claim to evidence.
5. Write a limitations table that lists missing scenarios.

Pass criteria:
- The artifact package can regenerate all figures from raw traces.
- Each figure has a source script and input path.
- The claims table contains no claim without a linked artifact.

Artifacts:
- `analysis-notebook` or script directory, generated figures, summary tables, claim-to-evidence matrix.

Report use:
- Supplies the evaluation chapter, future work section, and limitations section.

## 8. Required tables and figures for the final report

Tables:

1. Hardware and software configuration table.
2. Deployment topology matrix for L0, R0, P1, P2, P3, P4, and P5.
3. Workload manifest with sample count and purpose.
4. Network profile table with configured and measured values.
5. Functional test summary, including current 151-test result and the new full-suite result.
6. Latency summary table with median, p95, and timeout rate.
7. Quality summary table for STT WER, TTS quality, and wake-word error rates.
8. Security and fallback table with denied requests, revocations, and fallback outcomes.
9. Stress-test table with concurrency level, throughput, p95 latency, timeout rate, and saturation point.
10. Peer-redirection table with selected peer, measured latency, routing score, and convergence time.

Figures:

1. End-to-end latency boxplot by topology.
2. Stage waterfall for one representative voice command.
3. Client resource usage by topology.
4. Provider or server resource usage by topology.
5. Network degradation curve showing latency and failure rate.
6. STT quality versus latency plot.
7. TTS first-audio latency versus quality plot.
8. Wake-word false accept and false reject plot for W0, W1, and W2.
9. Single-resource P2P overhead plot for orchestrator-only, STT-only, TTS-only, and wake-word-only.
10. Cloud-like comparison plot for L0, R0, and P5.
11. Stress-test curve for concurrency versus p95 latency and throughput.
12. Peer-redirection convergence plot for two providers advertising the same resource.

## 9. Claims the report can make after these tests

The report can make a claim only when the claim links to a task artifact.

Allowed claim examples after evidence exists:

- Aurora's local mode completed the fixed workload on the client hardware with the measured latency and resource cost.
- The deployed server reduced client compute use under the measured network profiles, with the recorded latency trade-off.
- P2P orchestrator offload worked for authorized peers and rejected unauthorized peers in the tested cases.
- P2P STT-only, TTS-only, or wake-word-only offload helped only under the network and hardware conditions shown in the plots.
- One shared orchestrator peer supported the measured concurrency level before the recorded saturation point.
- Aurora redirected to the lower-latency peer under the documented routing policy in the tested scenarios.
- Remote or peer wake-word detection increased pre-activation audio exposure compared with client wake word.

Claims to avoid without more evidence:

- Aurora performs better than centralized assistants in general.
- P2P is secure under all network conditions.
- Remote wake-word detection is safe for all users.
- The measured hardware represents all low-power clients.
- A small workload proves production readiness.

## 10. Minimum future-work backlog

If time permits only a reduced implementation, prioritize these tasks:

1. T0: instrumentation and reproducible environment.
2. T1: full baseline functional validation with Redis and process mode.
3. T2: local performance baseline.
4. T3: remote deployed server baseline.
5. T4: P2P orchestrator-only offload.
6. T5 and T6: STT-only and TTS-only end-to-end offload.
7. T8: cloud-like P2P full voice pipeline, if the single-resource tests pass.
8. T11: stress test for many clients sharing one orchestrator peer.
9. T12: latency-aware peer redirection between equivalent providers.
10. T13: analysis package and claim-to-evidence matrix.

Add T7, T9, and T10 when the project needs wake-word evidence, NAT claims, or stronger security evidence. The future implementer can decide later whether T11 and T12 run in CI, a local lab, or a dedicated performance environment.

## 11. Final-report wording guidance

The future works section should say that the current thesis validated the architecture through syntax checks, a targeted unit subset, and an inventory of relevant tests. It should also say that performance, live distributed execution, Redis-backed process mode, NAT behavior, and full voice-pipeline quality need controlled experiments.

The final evaluation chapter should write results in measured terms:

- Name the hardware.
- Name the network profile.
- Name the topology.
- Report medians and p95 values.
- Report errors and skipped cases.
- Link each conclusion to raw artifacts.

A strong write-up should avoid treating P2P as a faster version of a server. The useful comparison asks which deployment gives the best trade-off for a specific user constraint: offline use, low client power, ownership of compute, privacy, latency, or reliability. The single-resource P2P tests should show how much end-to-end latency the mesh adds for each outsourced resource, from orchestrator and LLM down to wake word. The stress tests should show how latency grows when many clients share a peer. The redirection tests should show whether Aurora chooses the lower-latency provider when two peers offer the same resource. The L0, R0, and P5 comparison should show where Aurora gains or loses against its own local mode and its own centralized server mode.

## 12. October 30 scope, approval, and evidence states

This amendment applies to every original task T0–T13. Their original procedures are preserved; current owner-authorized execution and mandatory cumulative non-iOS scope follow Sections 25–27. Preserve local-only, centralized deployed API, and authorized P2P staged offload as distinct families. Include Brazil, Portugal, the United States, and a physical phone, with native/local, desktop, browser, and mobile entry points. Do not compress the study into the already-passing historical unit subset or an isolated inference example.

Evidence states are `planned`, `readiness_unknown`, `ready_documented`, `approved_for_specific_stage`, `executed_pass`, `executed_fail`, `inconclusive`, `unsupported`, and `not_run`. Approval, a configured route, a passing unit test, a live emulator, or a source review cannot become `executed_pass` for an end-to-end experiment. Each result records its exact source version, environment, execution date, command, raw artifact hashes, and scope. Known historical counts must be dated June 2026; a current test inventory remains unmeasured here.

The owner has authorized scoped execution through existing sessions in Sections 25–27; Root documents each finite stage with exact authorized hosts, client surfaces, tasks, model manifests, privacy/resource limits, reservations and stop conditions without redundant permission requests. A date or silence is not approval. Root remains the sole serial Aurora executable validator and resource-reservation owner. This document creates no worker, Run, project, deployment, privileged access, network impairment, or device reservation. Reuse existing agents and supported routes only. No company Work Claude may process TCC material.

## 13. Four-node inventory and conditional readiness

Use stable pseudonymous IDs in traces; keep exact authorized host identities in the private environment manifest. Do not derive a country's location from a hostname, IP prefix, timezone, or assumed provider region.

| Node | Owner-requested placement | Authorized inventory/documentation | Still required before execution |
|---|---|---|---|
| BR | Brazil semdev server | Registered `ssh:ssh-1786238480967-semdev`; existing Aurora and TCC folder registrations inspected on 2026-10-13 | Independent country/region record, CPU/RAM/storage/GPU/ABI, current Aurora version, approved executable owner and available reservations |
| PT | Portugal notebook-personal | Existing `ssh:ssh-sem-notebook-personal` and Aurora repository registration | Country evidence, physical device/OS/ABI/specifications, personal account boundary, power state, usable native/desktop/browser clients |
| US | United States VPS | Owner identifies US VPS; canonical Aurora coding workspace is registered on `ssh:ssh-oci-coding-worker` | Explicit proof that the requested US VPS is that host, country/provider region, machine limits and deployed API/mesh capability; do not silently equate them |
| M | Mobile phone, country unknown | Physical phone identity/capabilities not yet verified. Authorized inventory separately shows booted personal-distrobox Waydroid on semdev | Phone model, Android version, ABI/RAM, country/network, native app version, browser/WebView, consent, cellular/Wi-Fi, permitted battery/thermal observability |

Inventory status is readiness, not experiment output. Waydroid is the owner-accepted Android-surface target through its approved relay; it cannot stand in for phone battery, thermal, radio, Doze, OEM lifecycle, or physical-device claims. iOS is excluded from active scope and denominators by the latest owner amendment; existing receipts are historical only and no additional iOS work runs. If a device or measurement is unavailable, retain its matrix rows as `readiness_unknown` or `not_run` and explain the limitation rather than blocking the document or inventing success.

Owner-supplied readiness sample: `observedAt=1791931061526`, 2026-10-13 22:37:41.526 UTC / 19:37:41.526 America/Sao_Paulo. US disk 93.918%, US CPU 83.181%, PT notebook CPU 96.332%. These snapshots identify possible load/storage confounding; CPU aggregation, sampling interval, workloads, and host mapping are not established. They authorize neither cleanup nor benchmarking. Obtain owner-agreed idle/exclusive slots or document unavoidable background load; never stop another workload or remove data to make a run pass.

## 14. Client-surface and deployment matrix

Transport, execution role, and physical surface are independent factors. Use centralized Aurora surface detection and runtime profile roles; never bake an offload role into an APK or invent platform support from source inspection.

| Surface ID | Client entry point | L0 local baseline | R0 deployed API baseline | P1–P5 mesh baseline | Required limitation |
|---|---|---|---|---|---|
| S-N | Native/headless local node | Production local engine/service call with exact backend | Production authenticated API client | Production authorized native mesh call | Crate-only inference is an engine measurement, not Assistant/UI/history proof |
| S-DL | Desktop Tauri local | Daemon/native ownership as implemented | Same desktop user action to API server | Same action to mesh peer | Distinguish daemon capture from focused WebView push-to-talk |
| S-DC | Desktop remote-console client | Capability conditional; do not invent local backend | Deployed server | Authorized home-peer route | Record runtime role independently of desktop hardware |
| S-B | Browser/web client | Only genuinely supported on-device browser execution | Authenticated deployed API | Browser mesh authority and supported peer session | Browser local inability is not a local performance failure |
| S-A | Authorized Waydroid Android native app/WebView; physical Android only when eligible | Supported native inference and local speech only | Same app/task to API server | Native foreground/background mesh according to implemented policy | Genuine capture, rendered reply and saved history must be separately evidenced |

Add text-engine, text-Assistant/UI/history, focused voice, and permitted background-voice rows separately. Run local save/reopen/history checks for the Assistant claim; a nonempty synthetic message or a tool proposal is not tool execution. Background mobile tool access and deferred orchestration must follow implemented Rust-owned authorization and lifecycle policy. P4 always-on wake-word offload remains optional and separately privacy-approved.

Every planned experiment row has `(source_commit, node_requester, node_provider, surface, runtime_role, workload, deployment_family, route_class, network_profile, thermal/power_state, cold/warm_state, concurrency)`. This is an explicit matrix, not an instruction to execute the full Cartesian product. Sections 26–28 require every applicable approved non-iOS surface/device/mode/cumulative-stage cell in a finite registry; capability gaps remain explicit and no same-host result substitutes for cross-device acceptance.

## 15. Pairwise, multi-hop, cross-region, NAT, and fallback routes

Plan all twelve directed requester/provider pairs; do not treat opposite directions as equivalent:

| Requester | Planned providers |
|---|---|
| BR | PT, US, M |
| PT | BR, US, M |
| US | BR, PT, M |
| M | BR, PT, US |

For every directed pair record actual geographic evidence, workload eligibility, supported client surface, API endpoint eligibility, mesh capability, permission, and readiness. A phone cannot be assigned a provider role that its native policy or hardware does not support. API rows use only an actually deployed authorized endpoint; necessary scoped test deployments are authorized by Section 25 through original Root, without expanding network/security boundaries. Local L0 has no provider edge. Same-LAN controls are additional location-labelled conditions, not substitutions for cross-region rows.

| Route class | Planned comparison | Evidence needed |
|---|---|---|
| D | Direct selected ICE peer connection | Actual selected candidate-pair type/protocol, local/remote candidate classes, bytes and setup intervals; redact IPs |
| R | TURN/relay-assisted peer transport | Selected relay candidate, relay region/protocol, encrypted payload/metadata exposure boundary, relay bytes and billing assumptions |
| A | Centralized deployed API | Endpoint/provider region, TLS/authentication, client/server intervals, payload sizes, queue delay; do not relabel it P2P |
| F-L | Failed remote route to local fallback | Trigger, deadline, authorized local capability, feasibility, fallback result, no duplicated side effects |
| F-P | Failed route redirected to another authorized peer | Original/selected peer, scheduler decision, permissions and convergence window |
| F-E | No feasible/authorized fallback | Bounded typed failure or retained/deferred work according to product policy; do not count as local success |

NAT categories are observed same-LAN, distinct home NAT, cellular/CGNAT, IPv4/IPv6, and unknown. Document the measured selected path; a configured TURN URL or successful signaling is insufficient to prove relay/direct use. STUN supports candidate discovery, TURN can relay packets, ICE chooses connectivity candidates, and application signaling is a separate function. Retain actual signaling dependence and metadata in the privacy/cost analysis.

Plan two kinds of multi-hop distinctly: (a) network relay, such as M → authorized TURN region → BR, where the intermediary forwards encrypted transport; (b) application-stage composition, such as M capture → PT STT → BR orchestration/LLM → US TTS → M playback, or requester → authorized forwarding node → provider. The latter is `unsupported/readiness_unknown` until the production contracts, routing and every-hop grants document it. Do not implement new forwarding or present multiple sockets/routers as an application multi-hop experiment. Include an alternative three-node PT requester with BR/US equivalent providers for T12 scheduling and failover.

Natural cross-region RTT/bandwidth/loss is the primary network condition. N0–N4 impairment profiles from Section 6 are optional, separately approved, isolated experiments. Never alter host routes, firewall/NAT, production interfaces, permissions, or background services to force a route. Log configured and observed RTT, bandwidth, jitter/loss and route class independently; unavailable measurements stay null.

## 16. Matched workloads and fair baselines

Freeze a workload manifest before the first approved pilot. Include at least short bounded text answer, bounded context answer, deterministic tool request, a fixed retrieval case if enabled, fixed prerecorded voice with reference transcript, and separate genuine microphone workflow where voice/capture claims require it. Use synthetic/public-consented material, stable hashes, expected task outcomes, deterministic owned tools, and an explicit language profile. Never mix private transcripts or uncontrolled external tools into a benchmark.

For L0/R0/P1–P5 use the same task, prompt/context, model weights/hash/version, quantization, tokenizer, context limit, decoding parameters/seed where supported, maximum input/output tokens, tool schema/data, audio sample rate/duration, STT language/model, TTS voice/model, deadlines, permissions and success predicate. Record batch size, thread count, acceleration, cache state, streaming and output counts. If the model/backend cannot match, label a separate system-level comparison; never attribute that difference solely to mesh.

Match API and mesh on the same provider hardware and backend whenever supported; only the route and required production authentication differ. Measure provider-local execution as an additional diagnostic control to decompose transport overhead. L0 runs on the requester and honestly includes its weaker compute. Normalize task correctness and requested work rather than assigning the weak device a smaller model to make the baseline feasible. An equal-model comparison and a best-supported-per-device comparison are separate analyses.

Distinguish engine completion, Assistant completion, executed tool correctness, saved/reopened history, and full voice capture-to-playback success. Predefine exact-answer or tool predicates; open-ended answer quality uses a declared blinded rubric and accountable reviewer, not output length alone. Check truncation, empty outputs, unauthorized tool effects, hallucinated tool results, STT WER and output/audio validity. Never hide a failure by treating an error message as a generated answer.

Report fallback-disabled offload to isolate its path and fallback-enabled user behavior as separate conditions. Record actual provider execution and response locality on every request. The API/mesh provider must not silently use a third-party model; if it does, record that separate cloud-dependent condition and its privacy/cost effects.

## 17. Weak-device feasibility and correctness limits

Predefine W-FIT and W-HEAVY tasks with the same exact manifests across L0/API/mesh. W-FIT is locally feasible according to documented budgets. W-HEAVY is a useful fixed job that may exceed requester memory/context/compute capacity but fit an authorized provider. Examples are an exact larger local model or a fixed long-context task; actual choices await capability inventory and owner approval.

Compare admission, load/start failure, memory/resource budget, elapsed time, timeout, result correctness, and completion rate. Distinguish `preflight_infeasible`, `unsupported_backend`, `load_failed`, `observed_OOM`, `timeout`, `permission_denied` and `correct_completion`. An actual OOM claim requires an authorized bounded attempt plus attributable process/OS evidence; a memory estimate is only predicted infeasibility. Do not deliberately cause host-wide OOM, evict other workloads or fill disks. If safe admission rejects the job, preserve that result and evaluate offload feasibility instead.

A useful weak-device benefit is a correctly completed mesh job under the same task/model/settings that the local device cannot safely admit or finish within the fixed budget. API success is a competing explanation and must be compared. Report feasibility improvement separately from latency speedup: there is no finite latency ratio for an uncompleted/OOM local job. Give successful-request latency plus failure/timeout denominators; do not drop infeasible local cases or invent an infinite speedup. Correct offload may still cost more time, bandwidth or energy.

## 18. Sampling, cold/warm, load, and statistical protocol

The sampling unit is a request nested in workload, device/provider pair, route, and independent session. Randomize or counterbalance topology order within each matched session. Do not treat tokens/audio frames or repeated requests on one session as independent devices or regions. Hardware/regions are purposively selected case studies, not random population samples.

Proposed finite sampling tiers, subject to explicit stage approval:

| Tier | Repeats and warmup | Permitted inference |
|---|---|---|
| Connectivity/correctness readiness | 10 bounded requests per eligible directed edge and route; 3 setup repetitions | Descriptive route/readiness and correctness only; no stable tail-latency claim |
| Main matched comparisons — current owner rule | 900 measured requests PER applicable surface/requester-provider/mode/cumulative-stage/workload/model condition; additional excluded warmups and finite restarted session subdivision fixed from pilots | Raw p90/p95 per condition, n_planned/n_measured/n_success and failed outcomes; no pooled device/stage percentile; qualified p50/p99 secondary |
| Optional tail precision | At least 1,000 measured requests per fixed workload/condition across at least 5 sessions | p99 with uncertainty; small upper-tail sample and heterogeneity limitations remain explicit |
| Cold starts | 5 approved independent cold process/model starts per selected condition | Descriptive cold-start median/range, not a stable cold p99 |
| Capacity | Concurrency 1, 2, 4 initially; 3 steady blocks of at least 60 completed requests or a fixed 10-minute cap per level | Offered/completed rate, queueing, p95, bounded saturation; expand only after approval |
| Failure/reconnect/security | At least 10 recovery cycles per chosen failure; 30 unauthorized attempts and 10 revocation cycles per exercised boundary | Observed rates and uncertainty only; zero observed violations is not security certification |

Use the same warmup count everywhere and keep warmup/cold traces with labels. Cold means documented process/model/cache state, not a destructive cache-clearing command. Warm means the specified models and connections are already ready; distinguish a warm model from reused versus new pairing/transport. Do not alter global system caches or force-stop another application.

Compute empirical p50/p90/p95/p99 with a declared quantile estimator; report successful-completion latency alongside all-request errors/timeouts and right-censored deadlines. Do not replace timeout durations with the successful median or remove them as outliers. Report denominators and confidence intervals for completion/denial/fallback rates. Use paired session-level differences/ratios and a declared cluster bootstrap (proposed 2,000 resamples, fixed seed), with a separate descriptive view when sessions are too few. Avoid declaring equivalence from a non-significant difference or multiplying exploratory comparisons into a headline.

Predefine exclusions for harness corruption/clock failure and retain the excluded raw record/reason. Background load is measured and reported, not excluded after seeing results. Proposed clean-slot eligibility: five-minute pre-run window with recorded CPU/RAM/disk/network and no identified competing heavy job; numerical thresholds must be defined using that host's metric semantics and approved before the pilot. If exclusivity is impossible, label the loaded condition and match/control it; do not pretend the owner's 83–96% samples describe clean slots.

Keep power source, battery state/charge, screen brightness, app foreground/background, Wi-Fi/cellular, governor/power mode, ambient conditions and native thermal state fixed or recorded. Pause an approved run on documented thermal/resource limits, correctness regression, other-owner reservation conflict, insufficient artifact space or expiration of time/cost caps. Requests, warmups and failed attempts count toward the budget. After an approved pilot, estimate the remaining runtime from observed request duration before authorizing the main sample; reduce optional scope through a documented amendment, not hidden deletion of failing cells.

## 19. Metrics and overhead decomposition

Report metrics on requester, each provider, and relay where authorized. All intervals use explicit start/end definitions and units.

| Metric | Definition/boundary |
|---|---|
| End-to-end latency p50/p90/p95/p99 | Client submission or capture/wake boundary to final correct result/playback; text, voice and engine boundaries stay separate |
| TTFR / TTFT / first audio | First valid response event, first model token, and first playable audio are distinct; record streaming/buffering policy |
| Tokens and throughput | Exact input/output token counts when backend exposes them; decode tokens/s and correct completed requests/s with offered arrival rate |
| Concurrency/capacity/fairness | In-flight and offered load, completed rate, per-client delay, queue depth, backpressure/rejection, saturation within fixed budgets |
| CPU/RAM | Host and owned-process CPU with core-count semantics; RSS/PSS/peak RAM where available; GPU/VRAM optional and supported-only |
| Network/storage | Directional application/wire bytes including retransmits/relay duplication, network rate, disk reads/writes, artifact growth, persisted conversation size |
| Battery/thermal | Physical-phone/notebook charge/energy and thermal state only if permitted sensors and suitable duration/control exist; otherwise unavailable |
| Quality/reliability | Correct task/tool outcome, WER, playable audio, error/timeout/fallback rate, reconnect/recovery time, persisted history correctness |
| Cost/locality/privacy | Provider/relay/egress cost, energy if measured, compute/storage/data residency per stage, observer-visible metadata and content recipients |

Record separate spans for discovery/presence, pairing/authentication, capability/permission checks, scheduler/peer selection, serialization/deserialization, encryption/decryption, upload, relay traversal, queue wait, model load, backend inference, tool execution, response deserialization, client rendering/persistence, TTS and playback. Attribute overlapped intervals with critical-path or exclusive-span rules; do not add overlapping spans into an inflated latency total. Unsynchronized host timestamps cannot establish one-way latency; use same-host monotonic intervals or bounded clock uncertainty and round-trip measures.

Compare matched provider-local/API/mesh traces and idle/no-op diagnostic paths only within the explicitly approved stage. Estimated mesh overhead is matched total minus comparable compute/service intervals, with uncertainty and any omitted spans declared. Never claim a residual is pure encryption/transport cost when clocks, queueing, batching, backend/model differences, cache state or rendering differ. If a component is not instrumented, its contribution is unknown rather than zero.

For network context include measured RTT distribution, direction-specific bandwidth estimate and loss/jitter method/capture period; use only already-authorized bounded network observation/probes; no impairment or network-scope broadening is granted by this amendment. Separate scheduler policy correctness from fastest-peer outcome; T12 evaluates the documented score, including load, availability and permissions, not RTT alone. Record signaling/relay availability as external dependencies even when content remains peer-encrypted.

## 20. Observability, raw schema, retention, and reproducibility

Extend the artifact structure in Section 5 with `workloads.json`, `approval.json`, `route-manifest.json`, `requests.jsonl`, `spans.jsonl`, `resources.jsonl`, `events.jsonl`, `costs.csv`, `claims.csv`, `limitations.csv`, `artifact-manifest.json` and analysis-script versions. These are proposed outputs, not already-produced experimental evidence. Preserve immutable raw records and record transformations, exclusions and hashes. Redacted support exports must not contain credentials, private audio, raw prompts, IPs or personal history.

Required schema (all unobserved optional fields are null with an unavailable reason; examples are field specifications, not fabricated records):

```text
environment:
  schema_version, experiment_id, source_commit, dirty_diff_sha256,
  approval_id, host_id_pseudonym, authorized_host_ref, country_evidence_ref,
  hardware/OS/ABI/runtime/browser/app versions, cores, RAM, storage_free_bytes,
  model_manifest_sha256, backend/version, sampling_interval, clock_method/error_ms,
  power/thermal/background_load state, observed_at_utc, timezone
request:
  request_id, experiment_id, session_id, repeat_index, order_seed,
  workload_id/hash, expected_result_id, surface, runtime_role, topology,
  requester/provider_ids, stage_provider_map, route_class, route_evidence_ref,
  network_profile, cold_model/cold_process/new_pairing/reused_connection flags,
  input/output_tokens, deadline_ms, start/end_monotonic_ns, wall_time_utc,
  correctness/status, error_category, retry_count, fallback_destination,
  actual_tool_executed, history_save/reopen_result, included/exclusion_reason
span:
  span_id, parent_span_id, request_id, host_id, stage, start/end_monotonic_ns,
  same_host_duration_ms, overlap_group, clock_error_ms, bytes_in/out,
  queue_depth, selected_peer, scheduling_reason, permission_decision_ref
resource:
  host_id, owned_process_id_pseudonym, session_id, observed_at_utc,
  cpu_percent/definition, rss/pss/peak_bytes, disk_free/read/write_bytes,
  network_tx/rx_bytes, GPU/VRAM where exposed, battery/energy/thermal,
  background_load_description, missing_reason
event:
  request/session_id, event_type, host_id, monotonic_ns, redacted_error_id,
  pairing/route/lifecycle/revocation/reconnect state, cause_evidence_ref
claim:
  claim_id, exact_text_hash, manuscript/chapter/locator, hypothesis_id,
  workload/topology/surface/route coverage, n_success/n_total, effect/uncertainty,
  raw_artifact_refs/hashes, figure/table/script_refs, evidence_date/version,
  observed/planned/historical status, limitation_ids, owner_review_status
```

Raw schema completeness is a prerequisite: identify missingness and units before comparing results. Resource sampling is proposed at 1 Hz for owned processes/hosts, with higher-frequency sensors optional only after overhead assessment. Save cumulative counter baselines and restart/reset semantics. Pair client/provider/relay events through stable request IDs, never by matching unredacted content. Verify capture continuity, duplicate/retry identifiers and cancellation semantics.

Pin source version, dirty diff, lockfiles, app binaries, backend/model/tokenizer hashes, data licenses/consent, exact command and approved host route, seeds, time/cost caps, timeout behavior and analysis version. Reproducibility is documentation plus retained inputs; no reproduction is claimed by this document review. An unavailable model/license or consent record makes that cell conditional. Use only existing authorized models/tools/hosts and necessary scoped test setup under Section 25; no paid-provider enablement, credential/security change, company execution or network broadening is authorized.

Estimate cost separately from measurement: existing VPS sunk/reservation cost, incremental API/provider compute, TURN and egress bytes/billing, storage, energy if measured, owner setup time, and test duration. Record currency, tariff source/date and allocation assumptions; unavailable prices remain unknown. "No additional server cost" and "negligible TURN cost" require evidence and cannot be assumed. A user-owned provider can still require signaling/relay infrastructure and expose network metadata.

## 21. Hypotheses, acceptance, failure, and privacy limits

| ID | Falsifiable question and acceptance/evidence |
|---|---|
| H1 | For an equal task/model on the same provider, does mesh change client-observed latency/resources versus deployed API? Report paired effects and uncertainty; no required winner or predetermined improvement |
| H2 | Can mesh correctly complete W-HEAVY when local execution is safely infeasible or fails its fixed budget? Require matching manifests, attributable infeasibility/failure and correct provider result; compare API feasibility too |
| H3 | How much discovery/auth/scheduling/serialization/encryption/transport/relay/queue overhead appears on the measured critical path? Require span coverage and honest unknown residuals |
| H4 | Does the documented scheduler choose the eligible ranked provider and recover after loss/revocation? Compare decisions to the actual policy, documented convergence/deadlines and typed outcomes |
| H5 | What is the effect of cross-region direct/relay/NAT conditions on completion, tail latency and bandwidth? Require selected-route evidence and measured network context; no universal NAT-success claim |
| H6 | What local compute, stored data and content/metadata exposure shift across L0/API/mesh? Require stage-locality inventory and actual measured/observed boundaries; encryption is not an endpoint-trust guarantee |

Instrumentation acceptance retains T0's minimum 95% coverage but reports every missing field and can reject a comparison when its primary interval is unavailable. Task correctness is the predefined workload predicate; resource/latency quality does not override an incorrect answer. T2's proposed 95% completion target is a study operating target, not evidence that all platforms meet it. Set workload-specific latency/queue/reconnect SLOs and timeouts before approval/pilot; use identical limits across matched modes and report failure when they are exceeded. No numeric product SLO is invented here.

Test privacy and failure only within the approved boundary: permission denial, revocation, offline requester/provider, interrupted connection, bounded retry/reconnect, background/foreground transitions where supported, and no feasible fallback. Do not use destructive host termination, credential changes, real sensitive tools or network mutations. Require zero observed unauthorized protected executions and no duplicate deterministic tool effects; report the tested sample and remaining security uncertainty. Background mobile orchestration may be deferred by policy; it must not be scored as a successful foreground reply.

Document content recipients/storage for audio, transcript, prompt/context, tool data/results, model output and history; signal/relay-visible timing, addresses and traffic volumes; owner/provider trust; retention/deletion policy; and regional storage/logging. L0 privacy needs documented local-only configuration, not the label "local". Mesh removes compulsory centralized inference only for the tested route; compromised authorized endpoints, external tool providers, telemetry, signaling and relay metadata remain relevant. Consent and rights are readiness prerequisites for personal capture or human ratings; default to fixed synthetic/consented data.

## 22. Thesis table, figure, and claim traceability

Extend T13; do not insert planned numbers into Chapter 5. Maintain one claim/evidence registry across Portuguese and English abstracts, Chapters 1–6, appendices, diagrams and white-paper drafts.

| Output ID | Planned display | Claim/inputs | Minimum annotation |
|---|---|---|---|
| TAB-ENV | Four-node environment/readiness inventory | H1–H6; environment and country/device evidence | Exact source/app/model/date, unknowns and load/power states |
| TAB-COV | Surface × directed pair × family × actual route coverage | H1/H4/H5; route manifests and status | Run/not-run/unsupported cells, approval and denominators |
| TAB-LAT / FIG-LAT | Matched L0/API/mesh latency and distributions | H1; request raw records and script | Workload-specific n, p50/p95/p99 quality, errors, confidence/clock limits |
| FIG-STAGE | Critical-path stage/overhead waterfall | H3; spans | Overlap rules, instrumentation omissions and queueing |
| TAB-FEAS / FIG-FEAS | Weak-device admission/completion/resources | H2; task correctness and budget outcomes | Same model/settings; predicted versus observed OOM; no invented speedup |
| FIG-CAP | Offered/completed rate, concurrency, queue and per-client latency | H4; request/resource records | Actual physical clients versus simulated clients, steady-state window/cap |
| FIG-NET / TAB-REC | Route/network degradation and recovery | H4/H5; route/events/network records | Direct versus TURN versus app multi-hop; unknown NAT and recovery failures |
| TAB-PRIV / TAB-COST | Stage-locality, metadata exposure and cost | H6; permissions/locality/cost records | Measured versus estimated costs, trust/retention assumptions |
| TAB-VOICE | Genuine/prerecorded voice outcomes and quality | H1/H6; audio/transcript/correctness records | Consent, model, WER/first-audio, physical versus emulator coverage |
| TAB-LIMIT | Missing cells and limitations | All hypotheses | Why unavailable, affected claims and future work, not concealed skips |

Every caption identifies input path/hash, script/version, units, success/all-request denominator and scope. Negative/failed/inconclusive results remain visible. A paper's motivation or architectural drawing cannot support a performance/privacy result. The June `151 passed, 8 skipped` and test inventory belong in a dated historical subsection; code/build/source reviews and current device observations have separate evidence classes.

Apply the study learning throughout the thesis: Chapter 1 states bounded research questions; Chapter 2 separates signaling/NAT/transport and reviews literature without borrowing empirical claims; Chapter 3 defines actors/trust/routes and evaluation design; Chapter 4 names the exact implemented version and unsupported client/forwarding features; Chapter 5 contains only actual results and reproducible methods; Chapter 6 answers each question within measured coverage. Abstracts summarize completed evidence, and appendices hold commands, raw schema, approvals and missing-cell tables. Update both languages consistently as reversible drafts until the accountable owner approves application to the canonical TCC project.

## 23. Must-have, optional, and staged approval schedule

The full applicable non-iOS scope is owner-authorized and mandatory under Sections 26–27. This earlier prioritization does not permit dropping real cross-device/surface or cumulative-stage coverage; iOS alone is removed from active acceptance. An unavailable essential cell yields a narrower explicitly labelled evidence coverage and future-work entry, with owner review; it never becomes an invented result.

Must-have proposed evidence by October 30:
1. Frozen environment/workload/model/privacy manifest, approvals, observability schema, raw artifact integrity and historical/current evidence separation (T0/T13).
2. Functional correctness of each selected production entry point and its authorization/failure boundary (T1/T10), using existing exact-version evidence where applicable. Do not reflexively rerun the entire unchanged Aurora suite or CI matrix; reuse scoped valid evidence and obtain only missing necessary gates after approval.
3. A matched L0/API/P1 comparison on one supported personal native/desktop requester and the same eligible provider, across all applicable approved real requester/provider and non-iOS surface/cumulative-stage rows under Sections 26–27. Each core condition uses the declared main sample; if local capability is infeasible, keep the feasibility outcome instead of replacing L0 with a smaller task (T2/T3/T4).
4. Owner-accepted Android Waydroid surface and each actual eligible physical Android requester API/mesh cumulative-stage outcome, local capability or explicit infeasibility, and genuine capture only when voice/capture is claimed. If physical phone readiness is unresolved, state mobile evidence missing and keep the row conditional; Waydroid is separate emulator evidence.
5. Directed BR/PT/US/phone coverage table, including documented eligibility and bounded readiness for all twelve pairs; at least one actual direct cross-region path and one actual relay or an honest relay-not-observed limitation. No multi-hop claim without an implemented/granted route (T9).
6. One W-FIT/W-HEAVY feasibility comparison, error/timeout denominators, cold/warm observations, resource/network and overhead breakdown, and a bounded concurrency/queueing comparison (T2–T4/T11).
7. At least one supported reconnect/offline/fallback/revocation sequence with correct policy outcomes; locality/privacy/cost and limitations tables, all figures traceable to raw artifacts (T9/T10/T13).

Mandatory applicable non-iOS voice/offload and surface families now include the cumulative K1/K2/K3 full pipeline, same-device and real cross-device modes, feasibility and concurrency/recovery/privacy. Preserve capability-specific gaps. Optional additions only beyond essential coverage: wake-word offload solely with actual privacy authority (not granted here); new unsupported-to-supported forwarding implementation only after appropriate authority; dense N0–N4 impairment; n≥1,000 p99 precision; concurrency above four, prolonged stress, broad energy/thermal/Doze/OEM/device coverage and full T12 load/oscillation cases. These cannot launch automatically to fill time or improve aesthetics.

Proposed schedule in America/Sao_Paulo, contingent on explicit owner approval:

| Window | Stage and reviewable deliverable | Gate before action |
|---|---|---|
| Oct 13–15 | Complete plan/review/diffs; confirm submission cutoff, inventory, source/model/workload and selected cells | Owner approves document; no execution |
| Oct 15–17 | Bounded readiness/correctness and instrumentation pilot; runtime/storage/cost estimate | Separate approval naming hosts, data, client routes, pilot caps and reservations |
| Oct 18–23 | Main matched baseline/offload and selected mobile/cross-region cells | Pilot evidence reviewed; exact samples/slots/deadlines/cost approved |
| Oct 24–26 | Approved missing must-have recovery/feasibility/queue cells; optional experiments only if time remains | Actual gap, no unchanged passing rerun; optional scope separately approved |
| Oct 27 | Proposed data freeze, immutable manifest, exclusions and figure/table generation | Approve analysis of actual retained inputs; no new experiments by default |
| Oct 28–29 | Chapter-wide claim/citation/language reconciliation and accountable owner review | Apply drafts to canonical project through existing authorized owner only |
| Oct 30 | Owner checks exact institutional cutoff, files, accessibility and submission decision | Explicit submission approval; this monitor never submits |

Execution HELD was lifted by Section 25 and the current owner continuation; Root advances the full applicable non-iOS matrix under Sections 26–27. If approval arrives late, retain optional/missing cases and publish an honest limitations account instead of launching a parallel fleet or an unbounded test loop. Each stage has one predefined stop rule and a recorded outcome. The plan proposes a ten-request or ten-minute pilot cap per main workload/condition, and main-run caps are set from that pilot before approval. Resource conflicts go to the existing Root/owner; no killing, cleanup, permission changes, new deployment or automated restart is implied.

## 24. Document review, reversibility, and remaining readiness decisions

The associated review package records exact personal white-paper/thesis source paths and hashes, citation-key checks, claim/evidence correctness, prioritized edits, chapter-by-chapter drafts, and unified diffs. It does not claim an existing PERSONAL/UNIVERSITY Claude paper session exited when it is not registered. Current registered company Claude is excluded; no TCC material is routed to it. Existing approved Personal/Manager routing retains guide lineage and Telegram topic2 destination; artifact enqueue/acceptance must not be reported as owner receipt or manuscript application.

Original plan backup and unified before/after diff make this edit reversible. The historical `.omx/artifacts/future-work-tests/future-work-test-requirements.md` copy remains frozen; this top-level document is the updated owner-authoritative plan. Thesis correction drafts do not overwrite the canonical semdev TCC manuscript or adopt its lifecycle/project ownership. Report any changing source hash or concurrent writer before overwriting; rebase a document diff against the changed source only with the existing designated owner.

Remaining decisions are explicit: exact October 30 institutional cutoff/format, independently documented countries/US host mapping, phone hardware/runtime/consent, actual deployed API/mesh routes/models, application multi-hop support, permitted sensors/relay accounting, exclusive load slots, existing paper-session identity and source-version freshness. They do not block completing this plan and review. They gate only affected execution/claims. No experiment, benchmark, deployment, product test, commit, push, submission or external follow-up was performed by this document update.


## 25. Owner execution authorization update — 2026-10-13

This section supersedes prior HELD wording for Aurora tests, benchmarks, builds and necessary **test** deployments only. The owner explicitly lifted that gate for the SAME tcc:20261013:submission-20261030 objective. Canonical thesis application remains owner-review gated; no company Work Claude, submission, competing writer/session, lifecycle adoption, commits, pushes or new PRs are authorized. Original Root remains the execution coordinator and physical-resource reservation owner and reserves global build/Waydroid resources. Existing original monitor, Run, Task and Dispatch are retained.

Execution now advances through the existing sessions rather than awaiting redundant approval. Root acknowledged the new authorization in message msg_6133ebc484cc (V235); the declared first prerequisite is runtime/route readiness and an at-most-ten-request or ten-minute matched-model pilot. Routine scoped technical fixes and necessary test deployments are authorized. Unsupported routes or missing real evidence remain actual blockers, not excuses to mark a case passed or create a replacement project.

Android target is **desktop Waydroid through the approved Orca emulator relay**, replacing physical phone for Android surface evaluation. This suffices for observed Android app/WebView/native behavior on that emulator and exact app/source version. It does not support physical-phone battery, thermal, radio, Doze/OEM or physical-device generalization. Keep those outcomes explicitly excluded/unmeasured. Other planned native/local/desktop/browser/API/P2P and cross-region cases remain in the complete plan, each with actual readiness and evidence status.

Primary comparison is **raw p90 and p95** latency and matched differences among local-only, deployed API and mesh with the same task/model/settings. Retain p50 and qualified p99 as secondary metrics. Quantile method is prespecified Type 7 linear interpolation on sorted observed successful-request latencies: for probability p, h=(n-1)*p, interpolate between floor(h) and ceil(h). Publish n_success and n_total separately, all timeout/failure/cancellation/infeasibility outcomes, fixed deadlines and any censoring. Do not convert a failed local/OOM job into a finite speedup or a success-only denominator. A <=10-request pilot is readiness/descriptive evidence, not a stable tail estimate.

After attributable local admission/load infeasibility is established, close that infeasible local cell; do not repeatedly cause OOM or replay an impossible load for the full successful-request sample. Measure correct API/mesh completions separately under the same job manifest and keep the infeasibility classification and sample basis visible.

Store full execution logs, raw request/span/resource data, reproducible source/model/workload manifests, chronological case outcomes and readable methodology/results Markdown under the owner-requested Aurora project documentation study area docs/experiments/tcc-20261013-submission-20261030/. Root owns executable case outputs; the existing monitor owns only monitor/ and the designated personal plan/review. The owner's explicit storage request overrides the local guidance that ordinarily places temporary run reports outside docs; no commit or publication is implied. Retain redacted/pseudonymous identifiers and the approved local data boundary; never print credentials or private user capture into a report.

Durable event-driven monitor identity: native thread 01a123ff-19ba-7332-a2f7-346a722af79f, original terminal term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc, incarnation 37e50d9c-6cf5-4e28-a63b-f2bc3eed5661, effective gpt-6.1-sol/xhigh, original Run run_e6054e76e9fc / Task task_d7ea336050cf / Dispatch ctx_37b4d0a3c14f. Installed CLI0.160.0 and existing daemon0.162.1 were inspected. Supported native /goal resume was invoked once and actual get_goal confirmed ACTIVE/full/unbudgeted; /go alias was not verified or invented. Native persisted Goal safe-boundary continuations and original durable FIFO Orca event waits (<=45 seconds) form the verified mechanism, with preamble heartbeats and exact delivery ACKs. No extra daemon/manager/worker was created. This monitor's Manager credential is not configured; the existing Personal Manager is coordinating its own event-service identity/cursor rather than transferring credentials.

The new Personal coordination Run run_8e16b490b21b, Task task_c2f1ff86c6f3, is owner-reported; launch refusal workspace_occupied does not authorize another writer or worker. Fresh registered inventory still has no identified PERSONAL/UNIVERSITY Claude paper session, and university scope is omitted. That is unverified live lineage, not proof of exit. Source-supported re-review proceeds on exact-hash personal synced originals and is returned as a **standalone uncompressed Markdown** document through existing Personal/Telegram topic2. Original review's lineage caveat is preserved until an actual registered terminal/incarnation/provider/source receipt proves it.

Tests or benchmarks are not completed by authorization, native goal resume, a configured route or an accepted guide. Each case must end in actual pass/fail/inconclusive/not-run/blocked evidence. Preserve the entire original plan, failed outcomes and remaining limitations; advance until required tests complete or a genuine bounded blocker, with no unchanged passing reruns or extra edge-case matrices as filler.

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

Root derives finite per-condition and per-session wall/request/CPU/RAM/disk/device/network caps from bounded pilots before launching a new main cohort, and publishes the eligible cell count and projected total runtime against Oct 30. Session/restart/warmup allocation is prespecified before measurement. For the matched personal-desktop GPU rerun, Root accepted three FRESH Supervisor/model/process epochs, each with 300 measured requests and five additional excluded warmups per applicable condition (900 measured plus 15 warmups), as recorded in Section 30. This is accepted methodology, not an executed main cohort; other workload/load/recovery conditions retain explicit applicable session semantics and the independent 900-per-condition rule. If the required sample cannot fit actual reservations/capability/caps, report the specific budget/access blocker without reducing n_planned or claiming completion. Inventory and instrumentation audit continue; the sampling ambiguity is resolved and is no longer a blocker.

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

## 28. Owner execution correction — separate primary GPU cohort and physical-resource scheduling

This section records the latest precise owner correction, relayed as `msg_44ce7f457752`, and supersedes any earlier implication to migrate a block or expand the current frozen manifest. Root remains the existing integrator/execution coordinator; this monitor remains the designated plan writer. No replacement Root/monitor or duplicate source writer is created.

**Finish the ENTIRE existing coding-worker campaign unchanged**, through its natural whole-campaign terminal boundary: original source/model/workload/settings, nine cells, 900 measured total plus 45 excluded warmups. Do not interrupt a user session, move a cell, reconfigure sampling or extend this manifest mid-flight. Preserve/seal its raw outcomes and labels as an **EXTRA CPU-loaded full-stack typed-request comparison**. It is not a cumulative speech-stage sweep, not 900 per condition, and not the primary GPU baseline. Coding-worker benchmark compute is available for other matrix lanes only after this campaign naturally finishes and its owned cleanup/reservations are reconciled.

The personal-desktop rerun is a **SEPARATE PRIMARY verified-GPU cohort**, using the same e2e setup/model/workload/settings for its matched CPU-versus-GPU comparison and full stage telemetry. All applicable new local/HTTP/cumulative-P2P surface/device conditions use Section 27's 900 measured PER CONDITION, additional excluded warmups, raw per-condition p90/p95 and failed denominators. Preserve both cohorts and do not pool CPU/GPU samples, substitute an accelerated number for a slow CPU result, or call cross-hardware differences protocol overhead. Text controls and the required full voice/cumulative stage workloads keep distinct manifests and claim boundaries.

### 28.1 Actual GPU readiness and receiver proof

The owner reports a personal desktop with an 8 GB GPU. **Exact desktop identity, GPU model/VRAM, backend accelerator/offloaded layers and actual accelerator use are currently unverified in this plan.** The retained host-list attempt was forbidden from the current route; it is not proof that a desktop is absent. Existing Root must obtain supported authorized Personal host/inventory receipts and start eligible read-only GPU preparation now. No GPU execution or lane launch is claimed by this document.

Before calling a run a GPU baseline, retain: exact personal physical host and device identity; GPU vendor/model/identifier and observed total/free/used VRAM; installed existing runtime/backend and accelerator support; model/backend hash/settings; requested and actual GPU/offloaded-layer/tensor allocation from backend evidence; per-process GPU identity and continuous GPU/VRAM activity during the actual request; CPU/RAM and e2e request stage traces. Merely finding a GPU or a compiled backend flag is not observed accelerator use. Partial/hybrid offload is labelled with actual layer/compute placement. No driver/security/provider/permission change is authorized to make it work.

Exact-version transfer remains within the SAME canonical Aurora project and approved existing routes. Root seals a transfer manifest with source commit, dirty patch/file hashes, app/binary/ABI/runtime, setup/config projection, dependencies, models/tokenizer/audio/workload hashes and owner-approved data boundary. The receiver returns actual path/host/project, bytes/hashes and installed version/capability checks before use. Never overwrite another dirty checkout, copy credentials/company data or treat message acceptance as receiver installation. Preserve source/model/licensing evidence; a missing approved receiver/install route is a specific blocker.

### 28.2 Physical-resource conflict graph

Resolve alias/distrobox/container identities to actual physical hosts before reservation. D (personal desktop), C (coding worker), N (personal notebook), B (semdev), A (Waydroid host), S (shared signaling/relay/API/storage services) are **logical inventory roles, not proven independent machines**. Merge vertices when inventory shows the same physical host, GPU, shared service or resource. Notebook personal/work distroboxes share N; they are not independent compute, and no company account/data/session is inspected, used or stopped.

| Lane | Physical resources reserved | Cannot overlap |
|---|---|---|
| CPU-FROZEN | Current C CPU/RAM/storage/host network and owned campaign services | Any new C inference, heavy build/transfer, shared-provider/service contention or source/config mutation |
| GPU-PRIMARY | Verified D CPU/GPU/VRAM/RAM/storage/thermal and workload network/services | Any API/mesh lane using D inference/GPU/provider; another D build/model load or contending service |
| X-D | Requester plus D provider and all shared paths/services | GPU-PRIMARY and any other contending D inference lane |
| X-N-B | Verified separate N requester and B provider, plus network/S | CPU-FROZEN or GPU-PRIMARY if alias/resource/service inventory reveals overlap or measured interference; other N workloads remain untouched |
| X-C-N / X-C-B | C plus verified other provider | CPU-FROZEN until it naturally ends; any shared provider/resource contention |
| PREP | Supported inventory/source/hash/manifest preparation on existing Personal placements | Heavy GPU/model load, unreserved builds/transfers, sensitive/company inspection or measured strain; prep is not a measured launch |

An edge exists whenever two lanes share CPU/GPU/VRAM/RAM, storage device/I/O, network interface/path budget, thermal/power limit or inference/signaling/Redis/relay/shared service. Unknown alias/shared-resource mapping produces a provisional conflict, not a declaration of independence. Disjoint graph vertices alone are insufficient: non-interference must be empirically checked.

### 28.3 Evidence-gated concurrent schedule and finite caps

1. **Now:** keep CPU-FROZEN running unchanged. Root starts eligible low-impact personal-desktop/notebook inventory, accelerator capability and exact-version receiver/manifest preparation through existing routes. No measured cross-device lane starts during phase 1, even if physically disjoint. Only the separate isolated desktop GPU individual baseline may start in parallel with the unchanged coding CPU campaign; harmless non-interfering preparation is allowed. Do not serialize harmless preparation behind the entire CPU campaign.
2. Capture a measured prebaseline window (proposed 300 s with 1 Hz host/process counters, GPU/VRAM when exposed) for each lane and every shared host/service. Define numerical CPU/RAM/VRAM/storage/network/thermal/queue limits using that host's metric semantics and pilot, before launch. Record aggregate unknown background load; do not kill workloads or touch company sessions to manufacture quiet.
3. Reserve physical host/GPU/service identities, CPU/core/accelerator budget, VRAM/RAM/disk floors, network/port limits, thermal/power state, time range and owner/case IDs. Maintain continuous per-host/process/GPU counters during measured work. Concurrent measured execution requires actual reservations plus process/job/container start receipts and first raw samples; input/dispatch acceptance alone is not launched execution.
4. Start GPU-PRIMARY after actual GPU/receiver readiness and reservation proof. It may overlap CPU-FROZEN only if resources/services are truly distinct and measured non-interference is established. Cross-device tests sharing desktop inference provider/GPU do not overlap this baseline. Cross-device measured lanes wait for the dual-completion barrier in Section 29. In phase 2, explicitly declared provider-sharing local-plus-mesh conditions are valid study scenarios, not categorically forbidden interference.
5. At CPU-FROZEN's natural whole terminal, seal its EXTRA CPU outputs and release only its owned reservation through the existing owner. C may join matrix lanes only after BOTH C CPU and D GPU individual campaigns have actually finished and sealed, as required by Section 29. No process/session interruption or mid-flight migration is authorized.
6. Derive each 900-request condition's finite per-session/total wall/request/resource cap from pilots and projected remaining Oct 30 time. Predetermine stop/invalidation thresholds for resource floors, sustained contention, queue/correctness regression, clock/span loss and reservation expiry. On violation, stop only the owned case at its supported boundary or cease new admissions, preserve failed/partial/contended samples and report the exact reason; never stop another user's workload. Do not secretly replace invalid samples or decrease the required 900 target.

Required lane manifest: `lane_id`, original Run/Task/Dispatch, exact physical host/device/GPU and alias proof, cell/cohort/source/app/model IDs, receiver/transfer hashes, resource reservation IDs and intervals, conflict edges/shared-service ownership, prebaseline/continuous counters, contention rules, pilot-derived caps, execution owner, actual launch PID/start/job receipt, first raw sample, terminal/cleanup result, n_planned/n_measured/n_success and affected limitations. CPU and GPU cohort IDs and artifact directories remain separate; any optional comparison joins summaries with explicit hardware/backend/source limits, never mixed raw percentiles.

At this amendment write, only the original CPU campaign is verified launched. Personal-desktop GPU model/backend/use, receiver receipts and new measured-lane reservations/launches remain pending actual Root evidence. The monitor requests and records those receipts, rather than inventing readiness from authorization. Missing approved host access, accelerator/backend support, physical alias proof, receiver route or non-interference is an exact stage-specific blocker. All prior non-iOS real-device cumulative stage, 900-per-condition, telemetry, privacy and owner-review requirements remain mandatory.

## 29. FINAL owner scheduling clarification — two phases and dual-completion barrier

Exact final instruction was relayed as `msg_921fa4ac89c3`. This overrides earlier permission to begin disjoint measured cross-device lanes during individual baselines. No iOS, replacement Root, competing source writer, credential/security change, company access or user-session interruption is authorized.

**Phase 1: individual full-surface/full-stack baselines.** Finish the ENTIRE existing coding-worker CPU campaign unchanged, and launch the SEPARATE personal-desktop verified-GPU individual e2e campaign IN PARALLEL when exact host/receiver/accelerator/resource readiness is proven. Desktop need not wait for coding completion. Each individual baseline is isolated from measured cross-device traffic; inventory/preparation may run only without baseline interference. New applicable individual conditions use900 measured PER CONDITION, extra excluded warmups, same pinned workload/setup/model and full clock-safe stage metrics. The existing CPU campaign stays its declared900 total/45 warmups as extra evidence, never expanded in place or pooled with GPU.

**Phase 2: cross-device/cross-surface matrix.** Start measured cross-device traffic ONLY AFTER BOTH CPU and GPU individual campaigns have finished naturally AND sealed their actual result artifacts. Even an otherwise disjoint cross-device lane waits for this barrier. It is not satisfied by queue/dispatch acceptance, a passing pilot, an initial GPU sample, a screenshot or the completion of only one campaign.

Barrier fields: `cpu_campaign_id`, actual terminal status/date/receipt, sealed result/raw/manifest hashes and owned-resource reconciliation; `gpu_campaign_id`, actual GPU/backend/use and launch/reservation receipts, terminal status/date/receipt, sealed result/raw/manifest hashes and resource reconciliation; `barrier_ready=(cpu_finished_and_sealed AND gpu_finished_and_sealed)`; original Root-authorized phase-2 transition receipt. Historical supported state at the original 2026-10-14 15:42 UTC document checkpoint: CPU original campaign still running; GPU individual campaign identity/accelerator/launch/terminal/seal UNVERIFIED; barrier_ready=false. The later evidence-backed checkpoint in Section 30 supersedes these execution-status fields without rewriting historical artifacts. Unverified GPU status is not proof of absent/stopped equipment.

During phase 2, concurrent mesh requests AND local user workloads sharing provider compute are natural expected study scenarios. Prespecify separate controlled-unloaded reference and mixed-local-plus-mesh load/concurrency conditions, each with applicable900-request budgets, actual stage_provider_map, per-device CPU/GPU/VRAM/RAM/network/thermal counters, queues, correctness, failures/timeouts and per-condition p90/p95. Provider contention in a DECLARED mixed-load condition is measured study behavior, not automatically an invalid experiment. Do not call it an isolated baseline or hide resource competition.

The Section 28 graph is phase-aware: GPU baseline versus any desktop cross-device inference is a hard phase-1 conflict; notebook distrobox physical aliases remain shared hardware. In phase 2, provider-sharing edges define explicit controlled load/concurrency factors and finite resource reservations. Stop/invalidation rules distinguish expected declared contention from unknown competing load, breached safety/resource budgets, lost primary telemetry, wrong stage placement or expired reservations. Preserve partial/failed/contended records and all denominator effects; never kill another user's workload to make a reference quiet. Same local/API/P2P full pipeline and cumulative TTS-only → TTS+LLM → TTS+LLM+STT plus eligible non-iOS surfaces remain mandatory.

Record actual primary-GPU launch evidence NOW when available; if blocked, give the exact authorized desktop/receiver/backend/accelerator/reservation capability gap. Preparation/input acceptance is not a launch. Root remains execution integrator and owns the phase transition; monitor is sole plan writer and records receipts without adopting execution ownership.

## 30. Matched fresh-session lifecycle and actual phase-one checkpoint — 2026-10-14

This update implements the owner's already-accepted requirement to preserve methodology and rerun the SAME e2e setup/workload/model/settings. Monitor nudge `msg_17eaedaa09f9` identified persistent logical GPU blocks as different from the three fresh CPU sessions; original Root FULLREAD/ACK `delivery579572a5a2c3` and response `msg_4d23640a566f` accepted the correction. Root messages `msg_c7bc22ef71d4` and `msg_131ab04ffb57` report its private-driver implementation and bounded correction-only approval. No new Run, project, source writer, optional matrix or owner-confirmation gate is introduced.

### 30.1 Fresh epochs for the matching desktop GPU rerun

For each applicable matching individual desktop GPU condition, use **three fresh Supervisor/model/process epochs**, indexed1–3, with **300 measured requests plus five excluded warmups in each epoch**: n_planned=900 measured independently per condition, with15 additional warmups. The source-approved driver rejects persistent900 mode as matching acceptance. Preserve actual cold setup/model loading/discovery intervals separately from warm dispatch/reply/render/history and, where applicable, speech/audio/playback. Starting a new logical label while retaining the same application/model/process is not a fresh epoch.

Record process/parent/session IDs and start times, application/service/model-instance evidence, source/app/backend hashes, startup/setup/warm boundary, requested and observed stage-provider map, warmup/measured ordinal counts, actual resource reservation/counters and supported natural lifecycle/cleanup receipts. Root starts and reconciles only its owned cases; never interrupt another user's session or worker, delete another dirty tree or manufacture quiet load. A failed startup is a failed session/admission attempt with zero actual request rows when none were emitted, not900 manufactured failures or successes.

All three epochs contribute to one condition's900 actual measured requests; do not allocate900 across local/HTTP/P2P conditions, devices, surfaces or cumulative remote-stage sets. Preserve each epoch's raw data and compute separate per-condition p90/p95 with Type7 and explicit actual outcome denominators, plus descriptive per-epoch distributions. Reuse an identical local baseline only through Section27.2's exact requester/surface/workload/model/settings/source/load/session mapping; do not rerun it gratuitously or double-count reused samples.

The sealed coding-worker control remains its original **three fresh100-measured/five-warmup sessions per route**,300 measured per route/900 total/45 warmups, as EXTRA loaded CPU typed evidence. It is not extended, replaced, pooled with GPU or admitted as900perNEWcondition. Different hardware/accelerator compilation and requested offload settings are declared factors, not protocol overhead or guaranteed speedup. Keep decoding/workload/model/audio/tool settings equal where applicable and record deliberate accelerator options and actual hybrid placement; an identical version string alone does not establish a matching binary/runtime.

Typed-request components do not close full voice/surface acceptance. Applicable full-pipeline voice and non-iOS native/headless, desktop, browser/mobile conditions retain mandatory stage-resolved measurements, cumulative TTS-only→TTS+LLM→TTS+LLM+STT placement and raw evidence requirements. Other declared recovery/concurrency/load conditions may need different session semantics; those differences must be prespecified, applicable and separately labelled, never substituted for this matched fresh-epoch rerun.

### 30.2 Actual checkpoint and remaining work

**CPU completed, sealed and independently approved.** Original campaign `6ce98ae97d594d9fafcd1ff9ad4b9b1c` naturally finished17:01:15.602941Z, driver result0/all9cells completed/source+driver+protected unchanged. Existing Sol whole retained-data review APPROVE SHA256 `1aabfab6bc7f7d4e753818f666508abf5c615c1ad72a7b9e85cc663772955ec5` confirms945raw=900correct measured+45excluded warmups,300perroute, with no removed slow/failed-preparation context. Export manifest `4058af37439c0a51ae39b99faf70fbeae277dec666e7ffc2efbe43d30ea60530`; analysisJSON `0c119998fe9c07a96dfb4d9780a769aad48c2ae8acae354ac516684431e1e360`. Readable results and review: `docs/experiments/tcc-20261013-submission-20261030/root/matched-main-analysis-6ce98ae97d594d9fafcd1ff9ad4b9b1c/`. CPU p90/p95ms local35437.982592/37635.40468775, HTTP35711.0558223/37399.58333755, same-host typed mesh40876.1/42178.65. These are descriptive loaded control results; mesh preflight readiness is outside the reply interval. Wrapper OS exit, internal threads/final containers and stable-tail/causal claims remain unverified. Retained ancillary exporterRuffF401 and10-second failed-source-pack context do not become all-checks-pass or new replay requirements.

**Desktop preparation verified, actual GPU acceptance pending.** Existing approved personal host `personal.skyron-server` on `ssh:ssh-1786238480967-semdev` has actual AMD Radeon RX7600/RADV discrete selection and8GB-class observed VRAM, compiled0.3.19 Vulkan backend, exact563036064-byte model/SHA256 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf`, frozen app dependency setup with numpy2.2.6, and verified21-source-file receiver/runtime-tree equivalence. Receiver actualGitbase is `c0f4c0013cea5bb11ef81297194d0dc142a47bc4` plus verified overlay matching Root578 runtime; do not invent578 Git object availability. Existing desktopmain2a7 and dirty state remain preserved. Hardware selection/compiled support is not actual model offload. Physical country and eligible other hosts/devices still require their own authoritative inventory, not this hostname.

The first readiness attempt actually started17:37:31.394278Z (PID2699838/start62775984), naturally failed17:37:36.414161Z/exit1/5.0199s, with zero request/capture rows and no deadline kill. Root diagnosed generated config n_gpu_layers ge0/le100 rejecting-1. Failed artifacts stay immutable. Private corrected runner requests100 layers, preserving schema/app/CPU source and recording actual settings; actual backend X/X layers, GPU/VRAM process activity and full correlated spans still require proof. V413 correction-only SourceAPPROVE `18dadfdaa5a357a8745c4930f12d650a8d095e16b91969a0d4ad97eb4c1fe71a`, runner `8c88d84f18b1f56898ccb55580c7e4f0eb24169c7651e5d4804f5187a501e6be`; receiver verified17:42:31.877732Z. A second two-request excluded readiness command is sent, capped300s/outer350s, with diagnostic initialization verbosity explicitly declared. At this checkpoint its PID/outcome/main launch is NOT verified. Do not turn command acceptance, source approval or requested100 layers into actual offload/900-sample acceptance.

Remaining sequence: exact startup correction→actual bounded readiness/correctness/history/offload/span/resource proof→finite matched fresh-epoch900-per-condition individual GPU execution across all applicable full surfaces/voice→actual full individual terminal/seals/resource reconciliation→Root-authorized phase2 transition and real-device cumulative/load/recovery/privacy matrix. Unknown metrics stay null with reasons, not zero. **CPUfinishedsealedreviewed=true; GPUfinishedsealed=false; barrier_ready=false; measured cross-device/cross-surface traffic prohibited until BOTH individual campaigns finish and seal.** Later declared shared-provider local+mesh contention remains required, separate from unloaded reference. No iOS, new company/provider/security scope, canonical thesis commit/submission or external follow-up is authorized by this document.

Original lineage remains Run `run_e6054e76e9fc` / monitorTask `task_d7ea336050cf` / Dispatch `ctx_37b4d0a3c14f`; Rootterm `term_6a00d9ee-792a-4daf-8578-236290e33108`, verified incarnation `fe7e63c7-d260-465f-b37e-f6fc78f8a1af`; monitor retains native active Goal `01a123ff-19ba-7332-a2f7-346a722af79f`. Monitor writes this full existing plan and evidence reports only; Root alone integrates source/execution/resources and owns leader goals/ledger. Earlier snapshots/manifests and the historical151pass/8skip evidence remain history, never current validation. Actual raw and human-readable artifacts remain in existing project docs.

### 30.3 Next individual full-voice gate: T0 admission followed by T2/K0

This is the bounded response to original Root request `msg_45314e6f92da`, derived from existing T0/T2, Sections 26–30 and coverage C02/C05–C09. It adds no optional matrix, new writer or execution permission. Finish the current six typed desktop epochs unchanged and retain their actual terminal/raw/analysis receipts before desktop voice/model/build work. Their completion is a typed local/API control milestone, not the full GPU individual seal.

**Next required gate:** admit correlated production full-voice instrumentation, then measure the T2/K0 all-local complete pipeline on the verified personal desktop and each applicable individual non-iOS surface. Use the original Section 6 hashed audio/workload categories, actual STT/TTS/model/voice admission, the pinned matched LLM/settings and the same complete job later compared with HTTP and cumulative mesh. Start with the existing bounded readiness allowance (at most ten requests or ten minutes per eligible condition, with prescribed setup accounting), then derive finite voice-specific request/session/resource caps from actual pilot data. Typed-request timing is not a measured voice-cap basis. Applicable new main conditions retain 900 measured requests, three fresh 300-measured/five-warmup processes where the matched lifecycle applies, excluded additional warmups, Type 7 p90/p95 and all failed/timeout denominators. Preserve all remaining voice workloads and surfaces; a first short-command gate does not replace them.

The maintained production backend entrypoint is **`uv run python main.py` in the existing pinned Python 3.11 environment**, with actual production typed message-bus contracts and the selected SDK/UI client. Do not instantiate services or invoke service methods directly. Desktop daemon/wake/background capture remains `STTCoordinator`-owned; focused push-to-talk follows the actual surface's capture adapter. Existing contracts include `Transcription.Transcribe`, `Orchestrator.ExternalUserInput`/`Orchestrator.Response`, `TTS.Synthesize` and, where actually available, `TTS.StreamStart`/`TTS.StreamChunk`/`TTS.StreamEnd`/`TTS.AudioChunk`. SDK `assistant.streamMessage()` or `streamVoiceAssistantResponses()` carries client updates; the actual surface adapter owns playback. A final-response fallback is not observed token streaming. Finite TTS metadata does not prove streaming-provider readiness.

No inspected maintained command is established as a ready 900-request production full-voice benchmark with all required telemetry. Root must admit or instrument the existing production flow after the frozen block, using the same source/execution owner, and pin resulting source/app hashes before any new main measurement. The following maintained commands have useful, narrower scopes and cannot silently substitute for T0/T2:

| Existing entrypoint | Source-supported scope and limitation |
|---|---|
| `pnpm --filter @aurora/tauri-ui test:desktop-native-voice:live` | Package script → `scripts/desktop_native_voice_e2e.sh` → `tests/e2e/desktop_native_voice/desktop-native-voice-e2e.mjs`. The live runner explicitly starts a **fake loopback Gateway**, returns fixed STT/assistant text and synthesized silence, and uses a sidecar sentinel. This is native routing/lifecycle contract evidence, not real STT/LLM/TTS inference or primary full-stack latency. Do not replay it to fill the missing voice baseline. |
| `pnpm --filter @aurora/voice-web test:browser:voice:real-api` | Production browser capture/AudioContext/Worker/WASM exercise with Chromium fake media; its mobile project is browser emulation. Here “real-api” means browser APIs, not a deployed Aurora HTTP API or a complete real-model Python assistant pipeline. It does not establish physical microphone/Android/full-stack inference evidence. |
| `pnpm test:hosted-peer:live` | Maintained real `main.py` hosted-shell boundary. Preserve existing source-specific passes. Its same-host typed Assistant/history result alone is not STT/TTS placement, a full-voice benchmark, deployed cross-device acceptance or 900 samples per new condition. Root must admit the missing actual voice flow rather than rerun an unchanged passing shell case. |
| `pnpm --filter @aurora/tauri-ui android:voice:live` and current x86_64 voice-live APK build entrypoint | Existing packaged Android gate, subject to current APK/source/SDK/model/Waydroid/broker capability receipts. `AURORA_ANDROID_MAIN_FLOW_ONLY=1` narrows the maintained successful-turn/event-bridge mode and excludes repeated-reopen/slow-consumer/physical-microphone scenarios; it also requires an authenticated hosted speech consumer. That connected hosting leg is not an isolated all-local T2/K0 baseline and must obey the phase-two cross-surface barrier. No unsupported raw ADB/CDP/install route is assumed. |

**Expected T2/K0 stage-provider map** is below. These are expected actors, not observed execution claims. Root records every stage's actual host, process/app, source/model identity, stable request/trace/span IDs and local clock domain. “Local” means the verified requester's physical host; a remote Python process is not local Python.

| Stage | Expected actor for the desktop Python all-local condition | Required observation / currently missing full-voice evidence |
|---|---|---|
| Capture | Same-host selected native/WebView/daemon capture adapter | Audio hash/format and capture start/end, adapter and microphone-versus-injected-audio label; no synthetic-input physical-microphone claim |
| Wake, when the workload uses it | Same-host admitted coordinator/KWS owner | Actual model/phrase and detection span; focused PTT explicitly records wake not applicable, never zero; no remote wake/pre-activation privacy expansion |
| STT | Same-host production `Transcription` provider | Actual admitted STT model/revision/language, audio/transcript correctness and correlated inference begin/end/RTF |
| Orchestration/LLM | Same-host production orchestrator/selected inference backend | Exact model/settings/input hash and GPU/CPU hybrid placement; queue, first/final token only when exposed, actual same-clock inference spans |
| Tools, when invoked | Same-host actually authorized tool handlers | Per-tool request/queue/start/end/outcome and side-effect predicate; no invented tool execution or permission changes |
| TTS | Same-host ready selected production TTS voice/provider | Actual model/voice/revision, text receipt, synthesis start/first audio/end; finite-versus-streaming capability and output hash/format |
| Render/history/playback | Same-host actual client/storage/audio owner | Correct reply/transcript, render and save/readback/reopen spans, client first audio and full playback; daemon server playback and client playback labelled separately |

For native/WASM-only surfaces, retain their actual local backend as a separately labelled applicable condition. A Rust/WASM engine or remote Python binding cannot be relabelled as local Python. Unsupported Python execution, mismatched model formats or absent ready speech stages remain explicit capability/comparability outcomes, not manufactured 900-success runs. STT/TTS pack hashes, logical voices, current audio/runtime capability and exact installed app/binary remain conditional readiness until actual receipts exist; the verified Qwen LLM alone does not admit the speech pipeline.

**T0 instrumentation admission:** publish stage/field availability before voice main samples. Current typed GPU metadata proves actual LLM pairs and history events, not complete capture/wake/STT/tool/TTS/queue/render/playback timing. Retain `null` with reason for absent fields. Demonstrate stable request/trace/span/attempt correlation across the actual flow; monotonic timestamps and boot/process-clock identity; setup/model-load/discovery versus warm dispatch; queue/inference/serialization and actual HTTP/mesh transport boundaries; requester submit→correct render/history/playback interval; per-host/owned-process CPU/RAM/storage/network and GPU/VRAM activity. Compute same-clock spans only and retain overlap/critical-path/uncertainty limits. No subtraction of unrelated monotonic clocks and no “pure protocol overhead” claim from unexplained residuals. All required primary voice boundaries must be measured before their latency/overhead claim; T0's overall 95% coverage target does not erase a missing primary field.

**Execution and completion checklist:** (1) current six typed epochs terminal and raw/source reviews retained; (2) actual all-local stage/model/audio/surface admission and resource reservation; (3) bounded production voice instrumentation/correctness pilot; (4) pinned finite full-voice condition manifest and 900-per-condition execution; (5) all applicable individual native/headless/desktop/browser/Android voice/surface evidence and actual seals; (6) original Root's dual-completion transition receipt; only then the mandatory real-device/cross-surface HTTP and cumulative K1→K2→K3, load/recovery/privacy/feasibility matrix. Waydroid remains an Android-surface target, not phone battery/thermal/radio or physical-microphone evidence. Original CPU extra cohort remains sealed unchanged. No iOS, new fleet/project, company access, permission/security change, driver change or submission follows from this gate description.

Source mapping was read only at Root branch `codex/aurora-native-speech-routing-20261007`, HEAD `5782746afba213f6b36907db2f09f0017625e218`, with 43 normal-status dirty rows preserved before this document edit. Relevant hashes: `main.py` `83c3f5dbcf939339e7643a46188acda4dd47b0bf3a78c13e2c087564c6d3730b`; desktop runner `796de627aca4ac86192a239ad4f9899a88bbb727d9aa92566192f352dc231df6`; desktop native harness `5142657c6f6ebe8c0d41c0a993a312a3761a7a79d4c284045c8c6e064210a4d1`; Android smoke `cb5c86d8929e1db16b9acb1664e00627b1ecdaa76f6859d804a4d209491e47f4`; browser realstack spec `a498c6bfad57e148f96dd01fc14905aed5be0c9b307805987a89ab59a1c12229`; API contracts doc `c4b4031e64c647dbff99ec6b3f24bd628edcd463bbf9f5795b7a8d61840ab2cd`. This bounded source/plan mapping is not executed validation. GitNexus context/tool was not exposed in the current tool/resource inventory, so no graph freshness or graph-assisted completeness is claimed and no index rebuild was launched.

### 30.4 Actual typed-control terminal checkpoint and remaining acceptance — 20:44:51 UTC

Original Root `msg_a71ecf4b05d9` reports the actual terminal gate at **2026-10-14 20:44:51.432825 UTC**. Monitor fully read and acknowledged `delivery_e7600048f206`, independently read the complete `.git/aurora-handoff-import-20261006/desktop-all6-actual-terminal-gate-v425.json`, and verified SHA256 `f1f1c8b15b0e00425363de3231fc5d46ab032333786f7c4380b49329d1c1c465`. All six planned typed epochs completed naturally with exit 0 and no deadline action or unattempted epoch. Each listed launcher and driver, plus original controller `2707431`, was absent at the gate. This is the named-process gate, not proof of cleanup of every host service/thread/container; retained internal cleanup limitations remain explicit.

| Cohort/component | Actual checkpoint | Scope and next required proof |
|---|---|---|
| Original coding-worker EXTRA CPU cohort | Previously sealed/reviewed unchanged: 900 measured total plus 45 excluded warmups, 300 per local/API/same-host typed mesh route | Preserve the loaded typed controls and their limits; no extension, replay, CPU/GPU pooling or staged-voice claim |
| Desktop primary typed local condition | 900 measured plus 15 excluded warmups across three fresh 300-request processes; all three terminal exit 0 | Typed Python Assistant/model/history control only; exact raw custody, Type 7 p90/p95 and outcome/input/source reconciliation remain pending at this dated gate |
| Desktop primary typed HTTP condition | 900 measured plus 15 excluded warmups across three fresh 300-request processes; all three terminal exit 0 | Actual same-desktop Gateway HTTP control, not deployed/cross-device acceptance or the full voice/surface baseline; separate raw/percentile reconciliation required |
| Full individual GPU voice/surfaces | **Unfinished/unsealed** | T0 instrumentation admission then real T2/K0 production audio flow, all applicable individual non-iOS surfaces, 900 per new condition and actual seals under section 30.3 |
| Phase-two measured matrix | **Held; dual-completion barrier false** | Original Root transition only after both required individual campaign seals; retain real-device HTTP/cumulative K1→K2→K3, declared load/queue, feasibility/recovery/privacy and all applicable surfaces |

Final API driver actually finished **20:43:53.031250 UTC**, exit 0, no deadline action, 300 measured plus five excluded warmups and 1,673 resource samples; final manifest SHA256 `e01052e5ac3ea45f705c161adec373d212a2b728ac669e5772b411c4981365eb`. Earlier local manifests are `dc185c057cc9a1f55a5ba346e3c9ef0e14a4c7592c5c3d74780ebb11793b8f4d`, `de6770fcabfe676e8c884ae1bf1ccddd15b603a9147585ca692d85c0aecbdef6`, `38162b54fee3ff417c1cdb6af65fbb929b50020fbab59bdd14ceb2ea48792e92`; API one/two manifests are `ac2c68c7bbdedc6e0dac66c6156ac78e38d85b9c2833310715b9e0e076152e71` and `1c943b2f27d68ad7fc414d2be6390748b7cf004132ec72f93b254e14f31ec251`. Keep per-condition sample populations separate. No GPU p90/p95, speedup or pure-protocol claim is invented from terminal counts or a hardware difference.

Root may now perform the already approved **private** pack/full-provider-metadata/frame reassembly/member extraction, then the retained analyzer and bounded data review. The process gate admits those operations; it does not prove they have executed or that the archive/data are verified. Require actual whole-archive and original ordered full-sidecar/member hashes, source/input/outcome/session reconciliation and readable results before a data-acceptance claim. The compact four-key receiver receipt is insufficient for member verification. Private raw logs/transport frames remain private; publish only the separately reviewed projection. No model/case replay is needed to recover retained data. Root retains its desktop GPU/Waydroid reservation for the next required gate; it has not released it to cross-device measurements.

The bounded voice-readiness inventory is also complete, with no further inventory round requested. Actual selected-config/known-path metadata at 20:07:53 and corrected STT-key addendum at 20:08:27 are copied byte-identically with readable limits in `docs/experiments/tcc-20261013-submission-20261030/monitor/voice-readiness-metadata-20261014T2010/`. Piper candidate/config files exist (63,201,294 and 4,885 bytes, 22,050 Hz/en_US/one speaker); corrected `services.stt.transcription` selects enabled tiny/base CPU/int8, while inspected caches are empty. This does not establish global model absence, exact model hashes/terms, a current logical voice, admitted fixed audio or runtime readiness. The voice's locale is not host-country proof. Actual hash/terms/corpus/stage admission and the production pilot remain necessary. Parent/synthesis/software-completion source preparation is closed and unapplied at this checkpoint; software completion is not first-audio or acoustic playback evidence. Avoid further micro-patches or optional edge expansion before Root's one connected main correlation check.

**Current checkpoint fields:** `typed_execution_complete=true`; `named_process_terminal_gate=true`; `raw_transfer_and_member_verification=not_yet_verified_at_gate`; `typed_percentiles=not_yet_verified_at_gate`; `full_individual_GPU_voice_surface_seal=false`; `phase2_measured_allowed=false`; original Root and monitor native goals **ACTIVE**. All original 900-per-condition, workload/model/surface/stage/telemetry, weak-device, concurrency/recovery/privacy, no-iOS, source ownership, country/device readiness, canonical-thesis review and October 30 requirements remain intact. This dated progress record neither replaces the full plan nor retires any missing essential coverage.


### 30.5 Checkpoint de evidência tipada aceita — 2026-10-14 21:10 UTC

Este checkpoint fecha somente os componentes tipados local e HTTP API do desktop GPU. Não fecha a campanha individual completa de voz/superfícies, não representa API implantada entre dispositivos e não libera a fase 2. A campanha CPU extra permanece selada, separada e inalterada; nenhuma nova execução dos componentes tipados aceitos é necessária.

| Condição tipada no desktop GPU | Tentativas medidas / corretas | Aquecimentos excluídos | Processos novos | p90 (ms), Tipo 7 | p95 (ms), Tipo 7 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local | 900 / 900 | 15 | 3 × (300 medidas + 5 aquecimentos) | 5457.4062129 | 5497.37067295 |
| HTTP API no mesmo host | 900 / 900 | 15 | 3 × (300 medidas + 5 aquecimentos) | 5582.3453308 | 5849.051791299999 |

Falhas, timeouts, cancelamentos e respostas incorretas medidos: zero nessas duas condições específicas. Quantis descritivos condicionais ao sucesso, com todas as tentativas medidas bem-sucedidas; três clusters de processo por condição, sem promessa de estabilidade de cauda, causalidade ou overhead puro. Não agregar CPU/GPU, condições, dispositivos ou estágios. Lacunas anteriores ao LLM permanecem não classificadas, e campos de voz/STT/TTS/playback/render/primeiro token ausentes continuam desconhecidos.

Recibos verificados: ZIP privado de 1.771.374 bytes, SHA-256 `510490b012dd80a031a41941bb5eddab8ce67024198f4601d0095a111b71137f`; 1.730 frames recebidos e 65 membros extraídos/verificados, sem sobrescrever/excluir arquivos. A primeira transferência truncada foi preservada; o reparo alterou somente o enquadramento, sem repetir inferência. Revisão independente dos dados reais: `.git/aurora-handoff-import-20261006/desktop-gpu-retained-data-v425-sol-review.md`, SHA-256 `934ae1231ed9b5981abe312253c887c89bf7a23fe5e477263cb5914595d7ff71`, APPROVE/PASS tipado local/API. Campanha exportada SHA-256 `993123f2afb40d9c8477ed40b86ee41a407d0513f3b74104083c35f1ab0f0c48`; manifesto `4963ab9b1f30a743ef97f8c0f828a0ff92d9934fac1c75f36019c6f1798faf82`.

A projeção documental determinística recebeu aprovação final em `.git/aurora-handoff-import-20261006/desktop-gpu-public-projection-v426-final-review.md`, SHA-256 `dbe56386e0d2f54516bc45ead895202c87e88f5ecff35dda6521526c117511dc`: 1.830 registros de requisição, 10.980 eventos de estágio e 9.976 amostras de recursos; manifesto projetado `7f4066db854a96e72cef353de80871b025a89a361b47511495a5d89ccd25f5ed`. A aprovação refere-se aos bytes do draft privado inspecionado; o recibo final de promoção/caminho em docs ainda deve ser confirmado. Logs/configurações/mensagens privadas não são autorizados para publicação por essa aprovação.

O mapa de proveniência permanece o da execução congelada aceita (base desktop `c0f4c0013cea5bb11ef81297194d0dc142a47bc4` + overlay verificado equivalente a `5782746afba213f6b36907db2f09f0017625e218`), não um commit posterior. Todas as seis épocas têm evidência efetiva de 25/25 camadas GPU e buffers CPU_Mapped; isso não demonstra que toda a pilha executou na GPU. O teste conectado posterior de correlação LocalBus/BaseService usa síntese/PCM controlados: suporta o seam de software, não áudio real, primeiro áudio ou aceitação e2e de voz.

Próxima admissão obrigatória: seção 30.3, identidade/capacidade efetiva dos modelos STT/TTS, corpus fixo autorizado com idioma/duração/hash/termos, captura/saída e cada estágio local do mesmo fluxo completo; telemetria correlacionada por domínio de relógio e limites finitos derivados do piloto de voz. A inspeção do Root informa que o ambiente congelado tipado não contém pacotes de voz; verificar o ambiente desktop existente antes de instalar ou alterar dependências. Nenhuma medição de voz foi comprovada neste checkpoint. Completar todas as condições/superfícies não-iOS aplicáveis com 900 medidas por condição nova e aquecimentos adicionais; os demais critérios T0–T13, papéis BR/PT/US/Android elegíveis e as limitações físicas permanecem integrais.

Barreira inalterada: `whole_gpu_acceptance=false`, `individual_gpu_condition_finished_and_sealed=false`, `phase2_measured_allowed=false`. Somente após CPU e campanha individual GPU completa efetivamente terminarem e selarem resultados, com transição explícita do Root, executar a matriz real entre dispositivos/superfícies, TTS remoto → TTS+LLM remoto → TTS+LLM+STT remoto, incluindo referência controlada e condições declaradas de carga local+mesh. Root segue integrador/executor; monitor é o único escritor do plano; sem iOS, novos workers concorrentes, mudanças de credenciais/segurança, acesso corporativo, commits/push/submissão ou interrupção de sessões do usuário.


### 30.6 Checkpoint do bloco diagnóstico de voz — 2026-10-14 21:56 UTC

O bloco limitado de admissão/diagnóstico foi encerrado pelo Root com **quatro fluxos lógicos excluídos, todos NONPASS, e zero amostras de voz aceitas para qualquer condição de 900**. O encerramento deste bloco não sela voz/superfícies individuais GPU nem libera fase 2. Evidência principal: mensagem Root `msg_4f6795e0326a` (21:53:48 UTC), ACK `delivery_98d61c6d3061`; histórico completo de processos, fontes, resultados e intervenções em `docs/experiments/tcc-20261013-submission-20261030/monitor/production-voice-backend-ready-pilot-pending-20261014T2135.md`.

| Fluxo lógico excluído | Resultado efetivo preservado | Estágios seguintes |
| --- | --- | --- |
| 1, V427 | 247,9 ms; sessão criada; STT falhou em runtime com locale `en-us` não suportado pelo engine | Assistant/TTS/playback/history não alcançados |
| 2, V428 | 935,6 ms; STT efetivo completou em 916,3 ms após correção, mas predicado estrito de transcrição falhou | Demais estágios não tentados pelo curto-circuito diagnóstico |
| 3, V429 | 845,7 ms; STT completou com referência falsa; Assistant falhou porque o piloto criou sessão `voice-pilot` em vez de `chat` | TTS/playback/history não alcançados |
| 4, V431 | Sessão correta; STT completou em 821,7 ms com referência falsa; Assistant real executou em 6977,2 ms, metadados de modelo válidos, resposta da tarefa incorreta | Tarefa-pai permanece falha; continuação separada abaixo |

Resultados SHA-256 dos quatro fluxos: `af7159ff04c95dba559b18a17f058ec51ba516c1b90d062010b86e83ab80bdf6`, `fbd95eddf551f4f79052ef75608f09ead965e88af3063787f75ba750c56ca6a8`, `ff9ae92dfb7f42966fb2aa312766ed1cb81e0dae11b1beb10e07cd5da5e7b459`, `4e4039299d80b455a4533e5478df274517a5bf99b9d63e950e8b26e07225961b`. Preservar input reconhecido, referência, predicados, erros, estágios não alcançados e versões de cada tentativa; não substituir a transcrição pelo texto esperado nem reclassificar falhas como sucesso. Chamadas de estágio/API e preflights de metadados não são requisições e2e medidas independentes.

O Root continuou apenas a saída já salva do caso 4, sem novo STT, LLM ou fluxo lógico: PID 2790442, início 21:51:41.805255 UTC, três chamadas de estágio/API para história -> Piper real -> AudioContext Chrome -> leitura final da história. A síntese, reprodução por software/onended e persistência completaram; resultado `downstream_completed_parent_task_failed`, NONPASS, SHA-256 `6c289b4665718f679dc57ed45e74525d2a30a95b5d623f318debba2101e3b43c`. Áudio por software: 2,27555556 s, 44100 Hz, 100352 frames, origem Piper 22050 Hz. Isto não é quinto sample, prova de microfone/audibilidade física, React UI ou latência e2e contínua: houve outro cliente/intervalo diagnóstico entre os segmentos. Não somar esses trechos nem extrair p90/p95 de voz deste bloco.

O valor bruto `output_bytes=0` foi preservado com motivo explícito de ArrayBuffer destacado depois da decodificação, sem inferir áudio vazio ou fabricar quantidade de bytes. A duração/frames efetivos são observações separadas; o tamanho pós-detach não mede o payload original. Não repetir o caso para embelezar esse campo. Falha local de transporte ArglistTooLong antes de execução Orca e dois erros de observação de arquivo/chave também permanecem como histórico, sem serem contados como novas execuções da tarefa.

Proveniência da nova admissão de voz permanece separada dos controles tipados CPU/GPU: faster-whisper tiny CPU int8 no revision `d90ca5fe260221311c53c58e660288d3deb8d356`, model.bin SHA-256 `dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1`; Piper LJspeech medium no revision/card `c10ece1aade47bb51c153c893d14e5bf8e5b7117`, ONNX SHA-256 `6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22`; WAV sintético de instrução autoral en-US, 4,376961451 s, 193068 bytes, SHA-256 `2f6361506708d0a3065a339d168c9db5412e343683dd9b4080471d8948bf82ae`. A geração única da fixture é setup excluído, não amostra. Revisões, cards/termos efetivos, hashes de configuração/fonte e mapa de estágios devem acompanhar os manifests; o status dos dados de treino no card não autoriza inferir licença universal. STT/TTS CPU com LLM Vulkan não equivale à pilha inteira em GPU.

A correção de produção STT ficou restrita ao mapeamento locale-base no engine e resampling finito para 16000 Hz, preservando duração no relógio da fonte e locale do produto. Revisão de fonte `212dbfdaac0ccf4a657ba35032a68064d023634fcd6fdbff840438efd89414b1`, STT source `4723b798b2643cee262e3d1d0ad28114305c3e83c8ef5bae5becd790aac5f888`; um regression de handler passou em 0,35 s com quatro warnings, sem matriz extra. O erro de sessão posterior foi corrigido somente no piloto. Essas evidências não convertem as tentativas originais em passadas.

O próximo gate obrigatório é T0: correlação efetiva entre ID servidor/response header, Envelope da chamada e observações lifecycle/LLM/history, com relógios, fila/setup/warm/inferência/render/history e limitações explícitas; o candidato privado do helper existente é somente fonte e não foi aplicado/medido neste checkpoint. Corrigir/admitir a tarefa completa com critérios explícitos antes de iniciar condições de 900, sem laço de perfeição da mesma frase/modelo, reexecução dos controles aceitos ou novos painéis especulativos. Manter todas as falhas, custos e limites na evidência da tese.

Root solicitou encerramento somente do próprio backend após a continuação; o recibo real de saída/ausência do backend corrigido ainda está pendente neste checkpoint, e silêncio não é término. Captura física/audibilidade, React UI, demais superfícies não-iOS e matriz real BR/PT/US/Android elegível permanecem não concluídas. `whole_gpu_acceptance=false`, `individual_gpu_condition_finished_and_sealed=false`, `phase2_measured_allowed=false`: manter a barreira CPU+GPU completos/selados e todos os requisitos das seções 29–30.5/T0–T13, 900 medidos por condição nova, modelos/workload/settings iguais entre comparações, sem iOS, pooling CPU/GPU, novos workers concorrentes, commits/push/submissão ou alterações de credenciais/segurança. Root continua integrador/executor e monitor único escritor do plano; ambos os goals nativos permanecem ativos.


### 30.7 Checkpoint verificável Android e gates de voz — 2026-10-14 23:10 UTC

A seção 30.6 é histórico datado, não o estado final da campanha. Os dois diagnósticos T0 posteriores elevam o histórico a **seis fluxos lógicos Tiny excluídos/NONPASS, zero amostras de voz aceitas**; não há sétima tentativa automática, redefinição do contador ou amostragem de 900 autorizada por esses resultados. O fluxo 5 teve captura servidor parcial e wrapper cliente incorreto; o fluxo 6 completou o caminho STT → Assistant/LLM → Piper → AudioContext → história, mas falhou na tarefa e na junção cliente/servidor. Recibo Root `msg_06bd0a096724`, resultado SHA-256 `0d632f7fdea1ed3c87a91cc1640b9f5ab5bd2ca6c6fe86b1f1f988d4654aed`; os quatro PIDs próprios estavam ausentes em 22:08:17.024185 UTC. A captura completa de 23 registros sem erros não converte tarefa/junção em PASS. Histórico e limites: `docs/experiments/tcc-20261013-submission-20261030/monitor/t0-instrumented-flow-global-budget-20261014T2202.md`.

A correção posterior do facade SDK preserva audit/metadados no requestResult e compatibilidade dos requesters existentes: `packages/aurora-sdk/src/generated-contracts.ts`, SHA-256 `696fc4fa11d095655718da263951d3a4c1aa69c5bbfe67d4b1b1ae01d867f3b7`. O Root informa oito checks direcionados PASS e typecheck exit 0; isso prova apenas a correção testada, **não uma nova junção efetiva do fluxo de voz nem validação e2e posterior**. Não repetir controles tipados aceitos ou requisitos já satisfeitos para obter outra aparência de sucesso. A projeção tipada aprovada está disponível em `docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-typed-primary-v426/README.md`, SHA-256 `b3224d7dda6966d771438380ca51bdf5df81d6730b3634057a96ff7a492f08e0`; isto atualiza somente o recibo de promoção que estava pendente em 30.5.

O build Android concluiu suas etapas nativa, WASM e UI e produziu o APK na terceira tentativa limitada da etapa de empacotamento. Preservar a primeira falha de linker SIGBUS (sem ENOSPC literal) e a segunda falha de execução em devshm noexec; não atribuir causalidade definitiva a disco nem apagá-las. O perfil final distinto usa debug-zero/strip/incremental-zero/jobs-one e NDK efetivo 27.2; a biblioteca LLAMA nativa usou o toolchain declarado 27.0. Manifesto de seis overlays prefixo `b299`, feature `android-voice-live-test`, SDK acima; não afirmar igualdade de toolchain/perfil com CI nem agrupar medições de artefatos diferentes. O nome histórico de um crate/helper contendo iOS não adiciona iOS ao escopo ativo.

Recibo Root `msg_0fdcc9ced253`: APK exit 0 em 23:02:28.212033 UTC, duração 1053.0225 s; controlador terminal 23:02:28.615177, sem atingir o cap. Em 23:05:59.451077, controlador 2819757 ausente e grupo próprio 2819778 vazio. APK `/dev/shm/aurora-root-android-resume-v441/gradle-project-outputs/app/build/outputs/apk/universal/debug/app-universal-debug.apk`, 194968469 bytes, SHA-256 `e031b391a29740d00e4e6177d56e0e8ea34dc1abf5f9f01e60d2d572265f791e`; log 167487 bytes, SHA-256 `3ad97884f5f87a3fb632da1a71a3d01dd46b7bf1657939a4b4fd737c70c7ca6c`. Falhas de observação/relay foram recuperadas no terminal/incarnation existente e permanecem no histórico; silêncio ou metadado writable isolado não provaram saída ou execução.

Recibo Root `msg_0a7f3856c322`, observação real 23:07:20.764319 UTC: o ADB existente no desktop pessoal confirma somente o serial aprovado `192.168.240.112:5555`, estado device, produto `lineage_waydroid_x86_64`, modelo `WayDroid_x86_64_Device`, ABI `x86_64`, pacote existente `dev.aurora.desktop`; hash do APK reverificado e bibliotecas x86_64 presentes. Sem adb connect/reverse, novas rotas, grants ou mudança de segurança. Esse recibo não valida um telefone físico, país, bateria/temperatura/radio/Doze/OEM, captura de microfone ou audibilidade.

Recibo Root `msg_cac0d708e059`: deployment próprio 2838776 iniciou 23:08:57.485547, terminou naturalmente 23:09:00.802477, controlador ausente 23:09:29.545952. Atualização `adb install -r -t` do APK exato retornou Success/exit 0 às 23:08:59.082990 preservando dados; `am start -W dev.aurora.desktop/.MainActivity` retornou Status ok/exit 0, COLD, TotalTime 1633 ms e WaitTime 1653 ms às 23:09:00.772365, app PID 109913 observado. **Uma observação de instalação/partida, n=1; não percentis, amostra de voz, história principal completa ou condição de 900.** Screenshot/estado renderizado e funcionalidade local Android ainda exigem recibos reais próprios; não usar smoke, mocks, transportes simulados ou o caminho hosted-consumer como aceitação K0 isolada.

O mapa somente de fonte do frontend foi encerrado: servir o dist Tauri no Chromium comum selecionaria Mock transport e não prova produto; o browser real é `apps/aurora-web`, com onboarding/perfil/endereço e controles PTT/história/ReadAloud normais. Não falsificar superfície, inserir shim ou substituir Python local/Android local por gateway remoto. Fluxo local impossível/não suportado requer estado e evidência de aplicabilidade explícitos, não 900 sucessos fabricados. A condição separada accurate/base permanece preparação de metadados/script, sem asset baixado/carregado ou inferência provada neste checkpoint; revisão `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`, CPU int8/beam5, admissão finita de assets de 180 s e orçamento de I/O/recursos após handoff real do build. Não reinterpretar Tiny antigo ou abrir uma escada de modelos/frases.

Checklist restante obrigatório: comprovar T0 cliente/servidor/estágios e tarefa completa no produto real; admitir modelos/corpus/settings fixos, áudio/render/história e métricas primárias com relógios/unknown explícitos; completar e selar a campanha individual GPU em todas as superfícies não-iOS aplicáveis. CPU extra congelado e controles GPU tipados local/API já encerrados não precisam ser repetidos sem nova causa; não são substitutos de voz/superfícies. **900 medidos por condição nova aplicável**, aquecimentos adicionais excluídos, falhas/timeouts no denominador, manifests/versionamento/limites finitos, modelos e tarefas comparáveis e separação CPU/GPU permanecem integrais.

Barreira sem alteração: `whole_gpu_acceptance=false`, `individual_gpu_condition_finished_and_sealed=false`, `phase2_measured_allowed=false`. Somente depois dos dois campaigns individuais completos/selados e transição explícita do Root, executar o conjunto real entre dispositivos/superfícies BR/PT/US/Android elegíveis, local Python/API HTTP/P2P cumulativo TTS → TTS+LLM → TTS+LLM+STT, mais casos T0–T13 aplicáveis, referência controlada e carga local+mesh declarada. Nenhuma medição cross-device anterior à barreira; nenhuma redução silenciosa a same-host, iOS ativo, pooling, novo worker/writer, credencial/segurança, acesso corporativo, commit/push/submissão ou interrupção de sessões do usuário. Root continua executor/integrador e dono dos recursos; monitor único escritor do plano, goals nativos ativos. Histórico detalhado/recibos: `docs/experiments/tcc-20261013-submission-20261030/monitor/waydroid-toolchain-disk-admission-20261014T2212.md`.


### 30.8 Produto web real: sete fluxos excluídos e bloqueio CORS — 2026-10-14 23:50 UTC

Atualização do checkpoint 30.7, preservado integralmente como histórico. Os cinco assets accurate/base foram verificados no revision `ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66`: 147884932 bytes no total; model.bin 145217532 bytes, SHA-256 `d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9`, README MIT efetivamente retido. Setup terminou exit 0 em 5,177 s às 23:19:35.988784, sem atingir o cap; recibo Root `msg_6ab006227386`. O carregamento CPU posterior não demonstra inferência, acerto ou admissão de 900. A condição base continua separada dos seis fluxos Tiny, sem substituir seus resultados/modelos.

O componente web de produção V450 passou na terceira tentativa, exit 0 às 23:34:52.989177 após 65,3264 s, build ID `UBSgEGgCRuvqTsFtR7xbp`; controlador ausente em 23:35:14.571002, recibo `msg_d50dbccfd8a5`. Preservar a primeira parada por espaço em disco e a segunda falha de resolução de módulo na coleta de páginas, apesar de compile/typecheck já passados. A correção moveu somente quatro novos arquivos de cache com SHA/bytes verificados e zero descarte; config privada `1bf3295f877ab9335a3384476f18522a9f6d917c7908f2948bf37aed7b95f7ae` e NODE_PATH dos node_modules existentes são proveniência de build. Não repetir os pré-requisitos nativos/WASM/UI já passados nem confundir este artefato novo com o controle GPU tipado congelado ou o APK.

Root lançou UM supervisor de web normal + main.py em 23:38:10.161668, pacote `f529f3fa47a2f8f7bdbeaf3917ba4aa1571e8685d9d243ad65c39c2717737c4e`; readiness efetiva 23:38:25.773015 dentro do cap de startup180 s. Backend source-v436/config `848103cdd1d2295f453de94bcf75b899c9458264f819c682b985cc687a32e455`, web V450/SDK e modelos devem constar do mesmo manifesto. Base CPU carregou às 23:38:17, não foi inferência; RX7600/8573157376 bytes VRAM/device1002:7480 foram observados, mas **offload LLM deste novo fluxo não foi provado**. Recibos `msg_df0e2d29051a`/`msg_661e7501c81f`; credenciais aleatórias somente do bootstrap normal no banco novo de fixture, privadas, sem bypass do guard ou mudança de conta/segurança do host.

| Caso de produto real excluído | Observação efetiva | Contador de voz / limite |
| --- | --- | --- |
| Primeiro browser, driver revisado fe156564 | Exit 1 após 5,002 s às 23:42:15.632890; Chrome SIGABRT/Unix socket path too long; zero API, sem Transcribe | Não é fluxo 7; falha de setup preservada, sem segunda execução do comando de receipt atrasado |
| V451, mesmo driver/app/modelos, TMPDIR curto privado | Setup UI normal completou45,779 s; POST cliente Transcription.Transcribe com payload raw16kmono/accurate foi observado; resposta falsa após timeout120 s; exit 1/174,078 s às 23:46:56.926670 | **Fluxo lógico global7 NONPASS**, seis Tiny anteriores preservados; sem transcrição renderizada/LLM/TTS/história ou amostra aceita |

Recibos `msg_f00b0ac24261`, `msg_309ffc99bd53`, `msg_aba04ae36e0c` e `msg_9bbd9077ed61`. A correção específica de TMPDIR não alterou sandbox, app, modelos ou segurança e não é escada de engines/flags. Os **400 requests API** do segundo caso incluem preflight401, eventos e reconnect: não são400 fluxos de voz, amostras de inferência ou condição de 900. Manter cada request/caso/erro e denominadores distintos. Pedido cliente/timeout não prova por si só ausência de inferência no servidor; validar pela junção de spans/network, mantendo o desconhecido explícito. Não converter timeout120 s em latência de inferência bem-sucedida nem atribuir overhead puro de protocolo.

O primário do browser mostra OPTIONS configurados para Orchestrator/GetModelCatalog e DB/ListSessions retornando401. Root inspecionou fastapi_app.py: CORS registrado antes de auth torna auth externo e rejeita preflight antes de CORS, embora a origem configurada esteja presente. Recibo `msg_a311ac781c37`; não é a causa estabelecida do Android preto. Próxima correção mínima de produto, ainda não validada neste checkpoint: Root preserva TODO WIP atual, move o middleware CORS para fora de auth, verifica no app ASGI real preflight da origem já configurada, POST protegido sem credencial ainda401 e rota normal autenticada200, revisão somente do delta e uma reentrada UI. Não ampliar origens/grants, pular autenticação, trocar Gateway por mock ou lançar matriz de segurança/edge cases. Mudança de fonte exige manifesto novo, sem relabel do caso falho antigo.

Após o fim natural do caso, Root solicitou limpeza somente do próprio teste. Recibo `msg_456517f8768f`: supervisor terminal às 23:48:09.720139 por Root_requested_own_test_cleanup, main child exit 0, observer completo3eventos/2286bytes/zero erros de escrita/flush/reject; observação23:48:36.316396 mostra os seis PIDs enumerados ausentes e globalLockAvailable=true. Isso comprova a retirada observada deste conjunto, não limpeza universal do host nem captura T0 completa do pipeline. Não houve patch ao runtime congelado em execução. Fonte corrigida/novo runtime somente após esse gate; nenhum pedido STOP/silêncio isolado foi usado como prova de saída.

Estado obrigatório: **sete fluxos lógicos excluídos/NONPASS; zero amostras de voz aceitas e nenhum p90/p95 de voz válido deste bloco**. Controles tipados CPU EXTRA e GPU local/API permanecem íntegros, separados e já selados no seu escopo limitado. Android instalado/partida n=1 continua com UI preta/essencial executed_fail; não virou voz/main PASS e a inspeção de DOM ausente não significa dispositivo Orca/ADB ausente. Nenhuma aceitação física de microfone/audibilidade/telefone/bateria/temperatura/radio, país ou rota cross-device é inferida.

Checklist restante integral: fixar/validar o caminho real principal de produto e T0 com tarefa correta, headers/Envelope/spans por estágio/clock/setup/fila/inferência/render/história/áudio e unknown+motivo; comprovar colocação/modelos/offload efetivos; congelar source/app/model/input/settings e manifestos; executar **900 MEDIDAS POR CADA CONDIÇÃO NOVA APLICÁVEL**, warmups adicionais excluídos, falhas/timeouts no denominador, sem pooling/escada/counter reset. Este browser é **same-host HTTP**, não K0 local Python/native, desktop Tauri local, API deployed ou medida cross-device. Completar todas as superfícies individuais não-iOS aplicáveis, com lacunas de capacidade explícitas, antes de selo GPU completo.

`whole_gpu_acceptance=false`, `individual_gpu_condition_finished_and_sealed=false`, `phase2_measured_allowed=false`. Preservar a barreira dos DOIS campaigns individuais completos/selados e transição Root antes de tráfego medido real entre dispositivos/superfícies; depois cumprir BR/PT/US/Android elegíveis, local Python/API/P2P cumulativo TTS → TTS+LLM → TTS+LLM+STT e todos os casos aplicáveis T0–T13, referência controlada e carga local+mesh declarada, recovery/privacidade/viabilidade/telemetria. Não retirar o objetivo por900 agregados same-host ou converter capacidades desconhecidas em completas. Sem iOS ativo, novo Root/monitor/writer/fleet/projeto, acesso corporativo, mudanças de credencial/segurança/provider/driver, commit/push/submissão ou interrupção de sessões do usuário. Root segue executor/integrador/dono de recursos; monitor único escritor do plano, goals nativos ativos. Evidência e intervenções: `docs/experiments/tcc-20261013-submission-20261030/monitor/real-product-web-voice-readiness-20261014T2338.md` e `root/android-build-and-startup-v448/README.md`; próximos dados só entram como resultados após recibos efetivos.


### 30.9 Oitavo fluxo real: STT correlacionado, tarefa falha e voz ainda obrigatória — 2026-10-15 00:20 UTC

O bloco posterior à seção30.8 trouxe evidência de transporte/estágio, **não aceitação e2e**. Primeiro, a captura diagnóstica dentro do contexto Playwright mostrou página focada/visível, estado member/Limited access/Assistant request denied e401 após o driver fazer reload completo depois de Login. Revisão existente confirmou usar a navegação SPA visível Assistant, preservando a sessão em memória; correção do harness, sem patch de auth/storage/grants. O diagnóstico fechou em15,036 s, sem STT/nova ordem de voz; não repetir probes de microfone/browser/flags. V455 provou factory/import, mas falhou num nome de receipt .installed versus .installed.json; setup preservado, zero fluxo novo. As duas falhas não são execuções de inferência nem autorização para uma escada de modelos.

V456 corrigiu somente esse nome/caminhos de artefatos, reutilizando o web de produçãoV450, c90 backend, modelos/settings/WAV/predicado. Factory de Gateway foi efetivamente chamada e retornou às00:11:25.590578, arquivo importado `app/services/gateway/fastapi_app.py`, SHA-256 `c90ade3dc52f1dfdf3840225894d24cefa530b063b2b32e1b289139772e65273`, PID2857078 igual ao observer instalado. Readiness00:11:27.430803; caso UI normal SPA, exit1 natural às00:11:59.401744, 24,004570 s, setup11,798 s. Recibos Root `msg_a113db6ce4f8`/`msg_b711106bc9ac`/`msg_9dab5b1d9815`; nenhuma mudança ao runtime congelado durante o caso.

No **fluxo lógico global8**, Transcription.Transcribe real, accurate/base CPU int8, recebeu HTTP200 em4346,288 ms no browser. `X-Correlation-ID=f772d5c33dc9e26481ef7e9dd963ee74` coincide exatamente com handler/modelo no mesmo PID importado. Modelo:651421991651356→651425836552663, 3844,901307 ms; handler:651421982822788→651425908607432, 3925,784644 ms, relógio monotônico do mesmo processo. É junção T0 parcial comprovada para STT; sem LLM/TTS/render/história completos, sem prova de offload LLM nesta campanha. Não subtrair relógios distintos, somar intervalos ou chamar a diferença de fila/overhead puro. **n=1 de estágio em readiness excluído não sustenta p90/p95, throughput ou sucesso de voz.**

A fonte WAV fixa tem4,376961 s, SHA-256 `2f6361506708d0a3065a339d168c9db5412e343683dd9b4080471d8948bf82ae`. O browser efetivamente submeteu PCM mono16kHz110080 bytes/3,440 s, SHA-256 `3677efe205ddc821ac591b7b9b714fc6cbf7eb83fc34c3b78f44ddeedcf77ab4`. STT retornou “Apply with exactly this single word and no punctuation.”, enquanto a referência contém “Reply” e a palavra final “ORBIT”. Predicado original falso; nenhuma resposta/LLM/TTS/história aceita. Duração/input diferente é observação, **causa ainda desconhecida**, não prova isolada de falha do modelo nem motivo para ajustar frase/predicado/modelo até passar. Preservar PCM, referência, resposta, spans e todos os casos de setup; 8=6Tiny+7transport+8transcrição, todos excluídos/NONPASS, zero amostras medidas de voz admitidas.

Após o caso natural, Root solicitou somente sua limpeza às00:13:00.041281; runtime terminal00:13:02.708816, intervalo relatado107,85199 s, antes do cap. Às00:14:27.809388 sete PIDs enumerados ausentes/global lock disponível, observer completo11eventos/9053bytes/zero erros. Recibo `msg_87fe55d44f62`. Isso prova o conjunto observado, não limpeza universal/telemetria completa de todos os estágios. CPU EXTRA original permanece naturalmente terminado/selado/revisado900medidos+45warmups/300porrota, no seu escopo tipado carregado; não ampliar em lugar/repetir/rotular como voz. Controles GPU tipados local900/API900 também ficam separados e imutáveis.

Evidência acessível: `docs/experiments/tcc-20261013-submission-20261030/root/real-product-main-v456/README.md`, SHA-256 `6155a9fb48bfd94f42e1ef3aac7cd87d8d36d66406e4d7c913f4946c78686078`; manifesto97arquivos SHA-256 `7cf4d692f2c99c2dbfa82ca64b1d87eb908484bf2ebca277f274a96d15603434`. ZIP311951bytes SHA-256 `d52f43a2266bfbd5acc39080268ad4e7de4d4e5fdc6f2581ac5dd6d04c85a051`, 813frames completos. Inclui builds falhos/passado, assets/licença, setups/probes, requests/network/bodies/spans/header7+8 e retirada. Credenciais/config/DB/logs privados integrais não foram projetados; originais privados preservados. Root `msg_c8095e18f5a8` e verificação local do monitor `monitor/real-product-v456-package-verified-20261015T0019.json` confirmam hashes/bytes de todos97membros; não repetiram testes/modelos/análise de campanha nem transformaram falhas em sucesso.

Próximo main independente: **UI normal com input digitado original → resposta correta → Piper real/read-aloud completo → história salva/reaberta**, classificado typed-UI readiness, sem mic/STT/ordem global de voz. Fonte do driver candidato39d3140f teve checks estáticos e duas correções concretas antes de execução; closure estreita e launch/readiness ainda pendentes neste checkpoint, sem alegar PASS de modelo/app por preparação. É trabalho útil nos componentes restantes, não substituto de voz ou selo GPU completo. Root `msg_b0f960a1d141` reconhece que **captura/fidelidade/input e full pipeline de voz continuam OBRIGATÓRIOS**: depois desse main, uma ação finita de alinhamento do MESMO PCM já retido com a fonte, sem nova chamada STT/escada de modelos/frases, deve informar o próximo conserto ou bloqueador real. Fechou o diagnóstico falho, não a obrigação da matriz; não marcar voz como opcional/unsupported por esses resultados.

Checklist/aceitação mantidos: T0 e tarefa completos por superfície/clock/stage_provider_map; source/app/model/settings/input e GPU/offload efetivos; **900 medidos POR CADA CONDIÇÃO NOVA APLICÁVEL**, warmups extras excluídos e falhas/timeouts no denominador; todas as superfícies individuais não-iOS, lacunas Android preta/fone físico/capacidades reais explícitas. `whole_gpu_acceptance=false`, `individual_gpu_condition_finished_and_sealed=false`, `phase2_measured_allowed=false`. Same-host browser HTTP não equivale a K0 Python local/native, API deployed ou cross-device. Depois dos DOIS campaigns individuais completos/selados e transição Root, cumprir as combinações reais aprovadas BR/PT/US/Android elegíveis/local/API/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT e T0–T13 aplicáveis, inclusive carga/concorrência/recovery/privacidade/viabilidade. Sem pooling CPU/GPU, iOS, nova frota/root/writer, fonte concorrente, credenciais/segurança/providers/driver/rotas ampliadas, acesso corporativo, commit/push/submissão ou interrupção de sessões do usuário. Root único integrador/executor/dono de recursos; monitor único escritor do plano e ambos goals ativos. Trilhas exatas: `monitor/real-product-web-voice-readiness-20261014T2338.md`, `monitor/cpu-frozen-seal-reconfirmed-20261015T0016.md`; sem aposentadoria antecipada do objetivo.


### 30.10 Main digitado parcial e retirada comprovada; voz/áudio continuam obrigatórios — 2026-10-15 00:51 UTC

Atualiza30.9 sem substituir o plano completo ou apagar falhas. Os casos digitados V457/V459 falharam antes de enviar o prompt. No segundo, o catálogo real contém Orchestrator.ExternalUserInput autorizado; ausência da rota/negação não explica o composer desabilitado. Também são necessários sessão persistida e carregamento da história. Duas ListSessions200 sem Create/Get/SetActive foram retidas, mas não bastam para atribuir causa à inicialização automática. Fechar probes repetidos de catálogo/browser/log/flags; não forçar gates/storage nem criar patch de produto por associação.

V461 usou a ação visível normal **New conversation**: DB.CreateSession200, ListSessions200 com sessão ativa, prompt digitado original enviado por Orchestrator.ExternalUserInput200, texto do usuário e resposta exata ORBIT renderizados e gravações de história no servidor. É progresso real no fluxo suportado; a causa da criação automática inicial continua qualificada. Driver terminou EXIT1 em00:38:28.923150 após48,006895 s; result.json registra46.938,784 ms de intervalo próprio e13.467,097 ms de setup, domínios/limites distintos. Não houve mic/STT/novo ordinal de voz nem amostra medida admitida.

Read aloud chamou TTS.Synthesize; o pacote registra LLM/header correlation70ad44f3d0b54b75c9c31efefdb66b39 juntando estágios LLM/história, span LLM1.276,180649 ms; TTS correlation05acca3c1010de89674a5b9e193ee10e, handler/modelo7.240,342263/7.239,723995 ms, sem junção aceita ao header do browser. Browser WAV/playback completo/reabertura da história NÃO aceitos; failure assistant_reply_and_history/driver_TimeoutError e captura TargetClosedError preservados. Captura TTS0bytes após fechar contexto **não prova áudio vazio do serviço**, ausência real de som ou causa de playback. Nenhum p90/p95, overhead puro, fila ou offload GPU deste caso é inferido; 25/25layers dos controles GPU anteriores não são prova deste runtime.

Runtime próprio V461 terminou00:40:42.860453 após247,965876 s, por Root_requested_own_test_cleanup, antes do cap. Root observou os7PIDs enumerados ausentes/lock disponível em00:47:32.625055; receipt projetado retirement-v461.json registra nova observação00:48:09.480500, allEnumeratedOwnedPIDsAbsent=true, globalLockAvailable=true, observer completo15eventos/11815bytes/zero erros de flush/reject/write. Pedido STOP isolado, silêncio e timeout de observação não foram tratados como saída. Não equivale a limpeza universal do host ou pipeline completo.

Evidência acessível: docs/experiments/tcc-20261013-submission-20261030/root/typed-product-main-v462/README.md, SHA-2563f891936f394f40308fa13cda101d82a01c6b716820c80df19d7f7d6e6e72a32; manifest922b0ae743cff3e699052adfba1d652731db4e15108169298fcbc746ea3cbfe6,66membros listados+manifest=67, README separado. ZIP405389bytes SHA-256181666beac5af3aac07b93cb871a21f330100d973db3b64fa791a28879a98a78/528frames completos pelo Root. Monitor verificou uma vez bytes/hashes dos66membros e leu README/result/retirement; receipt monitor/typed-v462-package-verified-20261015T0051.json. Credenciais/config/DB/logs privados integrais excluídos da projeção e preservados na origem. Recibos Root msg_e0788b40ebe1/msg_06e718210261, monitor msg_7d35a22f936d.

A comparação offline finita do MESMO PCM retido com a fonte já terminou em0,283 s, sem STT/model request: retained-input-alignment-v458.json, pacote root/typed-product-main-v460. Correlação moderada0,657562, fase0,0884375s/janela3,44s não provam identidade da entrada, causalidade da diferença de duração ou qualidade do modelo. Root relata source trace6c0671: PTT anuncia listening antes de runtime.start/getUserMedia/worklet pronto e stop entra stopping antes do acknowledgement do processor, podendo perder PCM enfileirado. **Não prova a causa do fluxo8.** Mesmo lane Luna prepara somente readiness verdadeiro+stop drain,4arquivos/2regressões e timeout de release original<=250ms; patch/checks/revisão final ainda PENDENTES neste checkpoint. Root único executor e revisão Sol existente; checkpoint finito10min desde00:48:10 ou bloqueador exato, sem nova matriz/aesthetic/replay/escada de modelo/frase/timeout.

Checklist obrigatório permanece: entrada/captura fiel e tarefa full-stack de voz correta; browser áudio válido/playback/história reaberta; Android atual com UI preta ainda executed_fail apesar de install/startn1PASS; T0/stage_provider_map/setup-warm/fila/inferência/render/história/áudio, clocks/unknown+motivo e aceleração efetiva por runtime. **8fluxos de voz excluídos/NONPASS, zero medidos admitidos**;3tentativas typed-UI separadas, a terceira parcial/NONPASS. Fechar diagnóstico não torna esses gates opcionais/unsupported/completos. Nenhum nonpass foi removido ou convertido em sucesso; nenhum9ºSTT/900 foi lançado por este checkpoint.

CPU EXTRA original900total/300porrota+45warmups permanece congelado/selado; GPU typed local900/API900 permanece separado/selado no escopo tipado. **900 MEDIDOS POR CADA CONDIÇÃO NOVA APLICÁVEL**, warmups extras/excluídos, falhas/timeouts no denominador, sem pooling entre modos/estágios/dispositivos/CPU-GPU; local idêntico só reutilizado com mapa explícito. Modelos/tarefas/inputs/settings comparáveis, limites finitos, todas as superfícies individuais não-iOS e lacunas reais explícitas. Este browser same-host HTTP não é K0 local Python/native, desktop Tauri, API deployed, voz aceita ou cross-device.

whole_gpu_acceptance=false; individual_gpu_condition_finished_and_sealed=false; phase2_measured_allowed=false. Manter DUAS FASES e os DOIS campaigns individuais completos/selados antes da transição Root para tráfego medido real entre dispositivos/superfícies; depois cumprir BR/PT/US/Android elegíveis, local Python/API HTTP/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT e T0–T13 aplicáveis, incluindo referência controlada e carga local+mesh/concorrência/recovery/privacidade/viabilidade. Sem iOS ativo, nova frota/Root/monitor/writer/projeto, credenciais/segurança/driver/provider/rotas ampliadas, acesso corporativo, commit/push/submissão ou interrupção de sessões do usuário. Root integrador/executor/dono dos recursos; monitor único escritor deste plano, goals originais ativos. Evidência formal de entrega/PR/CI com lacunas não transforma este resultado em campanha concluída.


### 30.11 Captura corrigida em fonte, startup ainda falho e diagnóstico finito encerrado — 2026-10-15 01:16 UTC

Atualização factual de30.10, cujo estado “patch/checks/revisão pendentes” é histórico. Root aplicou4preimagens verificadas em2026-10-15 00:53:04.300231 UTC, preservando WIP: UI cef59aa2f2ddbc0774099ebcce27e92159734d9028ad56e09bf3ecb8efe57fd5; worklet af88cb9a88bdc8887ac6edfcd26f4dc6bb59d75bec84a5da3418c9453b6bc643; testes finais599f004438d7fdd2f444cb40944e1a8769acb70e891b747798ebf9926430ab74/53a3e4898f59606a736b572d77699fa4c8fdb9d8967d86eab8d9d7245e41c274. Dois arquivos afetados passaram6UI/26worklet; typecheck voice-web7,865600s e UI final48,526733s PASS, Root serial/global lock. Falha inicial de fixture sem foco e TS2322 do novo mock foram retidas; corrigiu somente fixture/tipagem, repetindo apenas UI alterado/typecheck, sem repetir worklet inalterado. O recibo inicial documenta logfile reutilizado; não alegar logfile original independente byte a byte. Sol aprovou hashes finais, report44d7e50bd040f3403c795c07a6e125dff34e0476de837a9250cac2070fec892e. **Esses passes são de fonte/regressão; não demonstram causa do fluxo8 ou sucesso de voz.**

Build isoladoV463 reutilizou WASM existente e preservou fontes/builds AndroidV438/V448 e webV450. VoiceTS3,003118s, bundle worker1,002878s, web66,219949s, todos exit0; conjunto terminal00:57:58.542490/74,013918s, BUILD_ID CujxufTIY73eYYc6iXAj1, controlador2870376 ausente. UI/worklet finais e compiledworklet cd7d76cd foram verificados no recibo. O leitor de status atrasado recuperou o MESMO resultado, sem reenviar/rebuild. Nenhum teste nativo/WASM/deps antigo foi repetido; novo artefato não altera coortes congeladas anteriores.

Único mainV464: onboarding/SPA/New conversation normais, depois PTT; driver naturalEXIT1 às01:01:12.719213/53,045190s, setup38,691391s. Espera original12s não observou listening;52API/134networkrecords, zero Transcribe/Assistant/TTS, ordinalNULL. Erro do produto/startup não foi capturado porque outerfinally executou depois do fechamento Playwright (TargetClosedError), repetindo defeito de harness já conhecido. Isso não prova causa em auth/modelo/mic físico nem autoriza aumentar timeout/relaxar predicado. Runtime terminal01:02:49.096226/200,449193s após Root_requested_own_test_cleanup;7PIDs enumerados ausentes/globalLock disponível01:03:45.994690, projeção observa novamente01:04:26.425731; observer3eventos/2286bytes/zero erros.

Monitor nudge msg_bec4f63ed8ab, confirmado por Root msg_e635fdfbf13c, fechou mais fullflows cegos e exigiu reparo PRIVATE do harness usando captura em contexto já funcionalV454. Mesma lane existente, sem writer de produto concorrente; staticchecks e revisão fonte limitada Sol f5b3db1f5dc1e4a5c7b0d3251685c3c678f460531a33b106440573020ab6fd08, sem nova suíte/painel. Driver startup-only964fa5af79f363c2040ba2d500d301d6e1e9fdfdefe4d3357aa6fdfe1741f5d6 remove Stop/STT/Assistant/TTS/história; maxUM90s, parent reduzido300s, mesmo build/modelos/options/flags e espera original12s. Primary limitado3s evaluate/5sPNG/até30erros redigidos antes de fechar contexto. É diagnóstico de startup, não nova condição/voz medida.

V466 cumpriu esse limite: controller2874927/child2874941 iniciado01:09:40.026541, naturalEXIT1 às01:10:14.082289/34,005534s, setup19,249055s, antes do cap01:11:10.026541. Primary REAL em contexto foi capturado: página visível/focada, PTT idle/habilitado “Push to talk”, mensagem “Microphone capture failed. Try again.” Console404/401 genéricos sem junção de URL não estabelecem causa. **Probe encerrado UNKNOWN; startup permanece REQUIRED/executed_fail, sem waiver/unsupported/completion.** Zero Stop/STT/model requests/ordinal novo;8fluxos de voz anteriores excluídos/NONPASS, zero medidos admitidos. Não há p90/p95/TTFT/throughput de voz a relatar deste bloco, nem offload GPU atual, captura física ou audibilidade comprovados.

Root solicitou apenas sua limpezaV466 após o caso; parent terminal01:11:17.650838/138,846265s,7PIDs enumerados ausentes/global lock disponível01:11:56.381065; receipt projetado observa novamente01:12:30.319988, observer completo3eventos/2286bytes/zero erros. Isso fecha os recursos observados antes do cap300s01:13:58.455567, sem inferir saída por silêncio/timeout/STOP. Nenhum outro runtime/probe foi lançado neste checkpoint. Novo conserto de produto exige causa/evidência nova sustentada antes de reentrar no fluxo; não repetir logging/browser/flags/modelos/frases/waits ou fullflows cegos deste ramo.

Pacotes acessíveis sob docs/experiments/tcc-20261013-submission-20261030/root/: voice-capture-fix-v462/manifest.json SHA925fbd9da19c619d8bcad8ace722127a9412f0431b918a6ff62734ae9250d93e/22membros; capture-build-and-main-v465/manifest.json SHA8fe1923e2b017285bf6a0787b5c2a33bb9c2f662052f78841f45831eaa596d09/25membros; startup-primary-v467/manifest.json SHAa418d59f3cdc7dae8f2affbb572a9ecc1a8623a96f34933928b50f87a2c80f98/20membros. Cada conta exclui o manifesto e README separado. Root verificou transfers/ZIP/membros uma vez; monitor verificou uma vez hashes/bytes, README e4hashes canônicos da correção, sem testes/modelcalls. Recibos monitor/capture-fix-v462-verified-20261015T0058.json, capture-build-v465-verified-20261015T0106.json, startup-primary-v467-verified-20261015T0115.json. Último ZIP63564bytes/83frames/SHA465c09e565419cdcc520eaf747f0d582159ddc6c31041dfb4aa74dbf5e985035, README474c0e44a4db1d0816ea4f2d190fc7cbcb94f26c820c5b86205397be6a653eac. JSON/PNG primários/network/result/retirement preservados; credenciais/config/DB/logs privados integrais excluídos da projeção e retidos na origem.

Root msg_ee52556cc114 reconhece probe encerrado e move mesma lane para mapa READONLY G008/PER285 de lacuna real de telemetria de produção, independente deste erro de mic, sem instrumentação para outra pescaria de logs. G010arquivo e G013DB/config têm fundamentos aceitos; G011notificação ainda depende de UI Android utilizável, G012conteúdo de plano completo tem gates Stage2/QA/arquitetura/entrega condicionais; não inventar defeito para repetir passes. Artefatos aceitos não equivalem a todas as metas finalizadas: goals.json SHA7c5333454d3175758d9daa8b898ff865a6059f1cfc4cec4481160315526b60f1 ainda1complete(G005)/1in_progress(G001)/11pending nesta leitura. Root único dono de transições/integrador; monitor único escritor deste plano, goals originais ACTIVE.

Checklist essencial integral: causa/conserto sustentado e startup/captura fiel/full pipeline de voz com tarefa correta; áudio browser válido/playback/história reaberta; Android atual UI preta ainda executed_fail apesar de install/startn1PASS e rota Orca/ADB PRESENT; todas as superfícies individuais não-iOS, T0/requester/provider/stage_provider_map/clock/setup-warm/fila/inferência/render/história/STT/TTSprimeiroáudio/playback/resources/network/ICE e unknown+motivo. **900 MEDIDOS POR CADA CONDIÇÃO NOVA APLICÁVEL**, warmups adicionais excluídos, falhas/timeouts no denominador, limites finitos/modelos/tarefas/settings comparáveis e sem pooling. CPU EXTRA original e GPU typed local900/API900 selados somente no escopo original, sem expansão em lugar/replay/coorte CPU-GPU agregada.

whole_gpu_acceptance=false; individual_gpu_condition_finished_and_sealed=false; phase2_measured_allowed=false. Manter DUAS FASES: somente após DOIS campaigns individuais completos/selados e transição Root iniciar medidas reais cross-device/cross-surface BR/PT/US/Android elegíveis/local Python/API HTTP/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT/T0–T13 aplicáveis, referência controlada e carga local+mesh/concorrência/recovery/privacidade/viabilidade. Não substituir por loopback/same-host ou reduzir900 por condição. Sem iOS ativo, nova frota/Root/monitor/writer/projeto, credenciais/segurança/provider/driver/rotas ampliadas, empresa, commit/push/submissão ou interrupção de sessões do usuário. Encerrar um diagnóstico não encerra a obrigação da matriz; original Root e monitor continuam sob a mesma linhagem.


### 30.12 Fonte TTS validada e reabertura normal de história comprovada — 2026-10-15 02:01 UTC

V469 corrigiu lacuna funcional independente de PER286: interromper TTS agora pausa/libera áudio browser ativo e enfileirado, revoga URLs, invalida geração local pendente e rejeita sucesso/falha SDK tardios que poderiam falar depois. Root retirou cancelamento novo do runtime compartilhado para não sobrepor o início de captura fire-and-forget; isso não identifica a causa do erro de microfone. Duas fontes canônicas: use-assistant-tts.ts SHAe5caa61b1158946b4e9f0d274a898c3e2c6b538cff5b4aef941d474ee3a08745; teste existente SHAa176e81d7a45ae511bb36183d19620d9ece8598fabd9b8c3680da39f5268635f. Duas regressões principais adicionadas; arquivo afetado11/11PASS3,537079s e UItscPASS49,503722s, Root serial/global lock, ambos exit0, sem suíte maior/replay dos32checks anteriores. Sol aprovou integração final8a0d422b0926b6e9e58f100fa9cd71bdb996d571bf565356fdb73a7fa5e48b0a. Fonte/regressão aceita neste escopo; playback vivo/fullPER286/mic/fullGPU não decorrem dela.

Próximo main existente30.9–30.11 foi recomendado pelo monitor msg_79b4392d7843 e aceito por Root msg_3bb572ab66b6: reabrir conversa sintéticaV461 persistida, sem gerar outra resposta. Banco original548864bytes SHA1e9cddbf311bc9b43c7fa9afefc6f8315e2a8f75ae9e35a89540faeb5c113ae7 copiado byte a byte/semWAL, original preservado; sessão6201eb4f… mantém prompt exato e ORBIT. Login normal com identidade original privada de fixture; nada de mensagens injetadas, conta/grant/política do host ou credencial nova. BuildV463 CujxufTIY73eYYc6iXAj1 foi reutilizado com hashes de sessionactions/AssistantView/Webclient compatíveis comV461. **Esse build não incorpora o TTS V469**; compatibilidade do caminho de história não é deploy/aceitação do novo áudio.

Setup privadoV470 terminou01:39:59.210013/1,137075s com IndexError no helper que indexava api_keys sanitizado/vazio; zero browser/driver/caso de história. Os4PIDs antigos ficaram ausentes/lock disponível01:41:35, banco original inalterado. Backend mostrou apenas KeyboardInterrupt de limpeza Root, sem exceção independente estabelecida. V471 corrigiu somente setup: recuperou valores DECLARADOS originais da MESMA fixture preservada por AST e usou GET de health público existente sem lookup de array auth; originais/host/contas/permissões/credenciais/grants não foram alterados. Sourceclosure Sol do delta privado, falha inicial e reparo preservados, sem ladder de auth/flags/modelos/probes/builds.

V471 parent2883032 iniciou01:43:55.207105/cap300; readiness01:44:05.980867 e sourceguard do Python2883063/c90 igual ao observer antes da UI. Único driver2883394 iniciou01:44:49.591731/cap90 e terminou naturalEXIT0 às01:45:13.640430/24,004917s. result.json: completed=true, expected_prompt_match/expected_reply_match/persisted_session_selected/db_get_session_succeeded/db_set_active_session_succeeded todos true. GetSession200 preservou conteúdo e SetActiveSession200 confirmou ativação; UI renderizou prompt original+ORBIT. **Fecha somente a perna obrigatória de reabertura de história salva**, não reescreve V461audioFAIL ou qualquer falha de voz. Intervalo interno23289,447ms e processo24,004917s têm limites distintos; não são latência de inferência ou p90/p95.

Browser:48requests/39responses, forbidden_requests=[], assistant_or_speech_write_seen=false, assistant_turn_created=false, microphone_used/stt_used/tts_used=false. Listagem de história401 antes do Login não foi usada como causa; ListSessions/GetSession/SetActiveSession autenticados sucederam. Separadamente, servidor emitiu TTS.Request start/lifecycle/end ANTES do browser, span não correlacionado0,839018ms/providerNULL. Esses3eventos/2286bytes são preservados com captura completa/zero erros; **não provam síntese/playback nem ausência global de inferência** e não entram como amostra medida. Não apagar eventos por não corresponderem à previsão do harness.

Root solicitou somente sua limpeza às01:45:15.842486; runtime terminal01:45:18.715447/83,440368s, antes do cap. Às01:46:29.257070 todos7PIDs enumerados ausentes/global lock disponível/originalV461DB inalterado. Isso fecha recursos observados e o caso único de história; não presume saída por silêncio/timeout nem limpeza universal. Nenhum novo turno, ordinal de voz, amostra/condição de latência ou selo GPU foi admitido. Continuam **8fluxos de voz excluídos/NONPASS e zero amostras medidas de voz**; história readinessPASSn=1 é separada, class history_reopen_only_not_new_turn/superfície web de produção same-host HTTP.

Evidência em docs/experiments/tcc-20261013-submission-20261030/root/: tts-interruption-fix-v469/manifest.json SHAe30541bebf5e8311ccc9f4e79df9c1442438bcb5741c7e8d68bc272c556624a4 lista11membros INCLUINDOREADME/review,12com manifesto; retained-history-main-v471/manifest.json SHAf806f8764c69bab0ef90bc97c80cf5ab5234257656c2800f5b80b159a36db9d8 lista43membros/44com manifesto, README242845d943b97fdb3ee0591f70e3cb28d179051b2b9701a05f7e5eb85331d334. Root verificou140frames/arquivo107482bytes SHA942312a42a7fda793dd17828c502cf19cb9132d480cd75c773e9f697d101c651/rawmanifest4b27b42e96910c63a9b2312db48c35ac6961837f6e229535665b323bd66825ae e membros uma vez. Monitor verificou uma vez ambos manifests/membros/2hashes canônicosV469 e leu README/review/validation/result/retirement; receipts monitor/tts-interruption-v469-verified-20261015T0132.json SHA910a70930056966a0c640d1fb5bd77cddd3e54d9c30ead4b8a30ca458b3e3e9f e monitor/retained-history-v471-verified-20261015T0156.json SHA9111ff07400d67f5e683da89742b6d54e7651ecf32920267d898a75cba59fc0d. Credenciais/config/DB/logs privados integrais excluídos da projeção/preservados na origem, scanner de segredos da fixture aplicado. JSON/PNG/network/guard/stage/retirement e setup falho retidos; sem aprovação estética/Astra inferida.

Próximo gate normal requerido, proposto por Root msg_4175985fd2ac/msg_9376dbf73179 e coordenado por monitor msg_3509d024d0d9: **mesmo ORBIT salvo → Read aloud uma vez → resposta real WAV válida/não vazia + primeiro evento/software playback completo**, sem novo prompt/LLM/PTT/mic/STT, frases/modelos/flags alternativos ou substituição de provider/fallback. BuildUI-only necessário para incorporar TTS e5caa61b foi SUBMETIDO no mesmo desktop privado, sourceoverlay preservandoV463 e alterando só esse arquivo, cap300/uma execução; início/PASS ainda NÃO verificados neste checkpoint. Não repetir voiceTS/worker/native/WASM/SDK/deps/testes inalterados. Mesma lane existente prepara driver privado em3min e Sol revisão final única; após buildPASS/retirada, sugeridos parent300/driver90/maxUMcaso. Admitir recursos reais antes do build; insuficiência exige bloqueador exato/ação finita, sem prunes ou replays cegos.

No futuro main de áudio, reter body/header/WAV/qualquer erro ANTES de fechar contexto e drenar captures; zero bytes capturados após teardown não provam áudio vazio. Usar observer privado passivo já aprovado para joins TTS/header/stage e clocks browser, mantendo unknown+motivo/clock-domain/fila/TTFA/ended e limites explícitos. Software playback não é audibilidade física. Esse futuro caso é readiness excluído/não900, não P2P TTS-only cumulativo, pipeline de voz completo, novo p90 ou aceitação fullGPU. Sua preparação não é execução concluída; não repetir o PASS de história.

Checklist integral mantido: conserto sustentado de startup/captura fiel e full pipeline de voz correto; áudio browser ainda aberto; Android UI preta ainda executed_fail com rota Orca/ADB PRESENT; native/headless/desktop/browser/mobile não-iOS e papéis/hosts/capacidades reais; T0/clock-safe requester-provider/stage_provider_map/setup-warm/fila/inferência/render/história/STT/TTSprimeiroáudio/playback/resources/network/ICE, unknowns e limitações. **900 MEDIDOS POR CADA CONDIÇÃO NOVA APLICÁVEL**, warmups extras excluídos, falhas/timeouts no denominador, mesmo task/model/input/settings e sem pooling. CPU EXTRA congelado900total/300porrota+45warmups e GPU typed local900/API900 ficam imutáveis/separados em seus escopos; não somar readiness/CPU/GPU/superfícies.

whole_gpu_acceptance=false; individual_gpu_condition_finished_and_sealed=false; phase2_measured_allowed=false. DUAS FASES e DOIS campaigns individuais completos/selados antes da transição Root para medidas cross-device/cross-surface; depois cumprir BR/PT/US/Android elegíveis/local Python/API HTTP/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT/T0–T13 aplicáveis e carga/concorrência/recovery/privacidade/viabilidade. Loopback/same-host não conta como API deployed/cross-device. Sem iOS ativo, nova frota/Root/monitor/writer/projeto, mudanças de segurança/credenciais/provider/driver/networkscope, empresa, commit/push/submissão ou interrupção de sessões do usuário. Root permanece integrador/executor/dono dos recursos e transições; monitor único escritor deste plano, goals originais ACTIVE/objetivo integral não concluído.


### 30.13 PRIORIDADE DO OWNER: áudio real completo antes de matriz entre dispositivos — 2026-10-15 02:26 UTC

**Instrução explícita mais recente do owner, obrigatória e superior à ordem de prontidão anterior:** texto→texto é controle útil, mas não satisfaz o objetivo; a próxima prioridade de execução é **ÁUDIO REAL → STT REAL → LLM REAL → TTS REAL → ÁUDIO REAL**, nas condições individuais CPU/GPU. Não repetir história, testes unitários, leitura de resposta salva ou inventários de UI como substitutos desse avanço. Monitor msg_70dc6efe57d3 encaminhou a correção ao Root original; ACK efetivo e recibos de execução devem ser registrados separadamente, nunca inferidos de envio.

Separar dependências/aceitação: **(A)** headless/desktop com áudio pré-gravado determinístico completo, STT/LLM/TTS reais e saída válida; **(B)** captura física/microfone/UI ao vivo; **(C)** Android/Waydroid e demais superfícies nativas/browser. Falha de microfone browser e tela preta Android NÃO são pré-requisitos causais de A e não autorizam adiar sua medição. A não comprova B/C. Playback de software não comprova audibilidade física; headless sem dispositivo de saída registra playback unknown/not_applicable+motivo e conserva a fronteira de geração/decodificação, sem alegar playback que não ocorreu. Aceitação de reprodução onde aplicável continua exigida.

Conservar o MESMO WAV sintético fixo de autoria do agente, referência/tarefa/modelos/backend/settings comparáveis: WAV SHA2562f6361506708d0a3065a339d168c9db5412e343683dd9b4080471d8948bf82ae,193068bytes/4,376961451s/mono22050HzPCM16; referência “Reply with exactly this single word and no punctuation: ORBIT”, resposta esperada ORBIT. Reter licença/proveniência exata e qualquer ressalva; não inferir licença de modelo/voz a partir do texto sintético ou de corpus de treinamento. Entregar o áudio completo à rota suportada e verificar fidelidade/transformação/resampling/bytes/duração reais; não repetir a entrada truncada3,44s como se fosse fonte integral. Não alterar frase/predicado/modelos até passar. accurate/base, Qwen3.5-0.8B-Q4_0 e Piper declarados devem ter hashes/settings/revisão e engine efetivamente comprovados por estágio; divergência vira condição distinta explicitamente autorizada/comparável, nunca troca silenciosa.

Cada request deve executar os três estágios reais em sequência causal do MESMO fluxo: transcript STT efetivo alimenta LLM efetivo, resposta LLM efetiva alimenta TTS efetivo, áudio final é retido/decodificado/validado e reproduzido onde reivindicado. Proibidos transcript injetado, resposta em cache, saved-answer/read-aloud substituindo LLM, mock, bypass de serviço, chamada direta entre serviços ou provider silencioso. Usar os caminhos de produção main.py/bus/contratos tipados/HTTP conforme modo; comprovar stage_provider_map por request, IDs de request/spans/pais, host/processo/engine/modelo/backend/localidade e qualquer cache explicitamente medido. Uma coleção de três probes desconectados não é pipeline completo.

**Admissão e piloto finitos ANTES das900 medidas:** Root determina o bloqueador exato de áudio headless/desktop e usa a rota existente apropriada, sem depender de APK/Tauri/microfone. Verifica recursos/isolamento, manifestos, entrada completa, providers/modelos, aceleração real por runtime e observador privado passivo já autorizado; um piloto pequeno e declarado prova correção, ligação causal dos estágios, saída válida e cobertura de telemetria. Piloto/warmups excluídos da distribuição medida; preservar todos os fracassos/tentativas/ordinais globais e limites, sem ladder de modelos/flags/retries infinita. Declarar n de piloto, timeout por request, cap por condição/sessão e critério de parada a partir da admissão/piloto, antes do bloco caro; valores ainda desconhecidos permanecem PENDING, não números inventados. Corrigir bloqueadores técnicos concretos no escopo Root, sem ampliar acesso/segurança/rede/provider ou interromper sessões.

**900 REQUESTS MEDIDOS POR CADA CONDIÇÃO NOVA DE ÁUDIO APLICÁVEL**, separadamente CPU/GPU, superfície/requester/provider, modo e conjunto cumulativo de estágios; warmups adicionais excluídos. Conservar n_planned=900, n_attempted/n_measured/n_success/n_correct/n_failed/n_timeout/n_invalid/excluded+motivo e todos os denominadores. p90/p95 por condição, método de quantil explícito e tempos/fracassos censurados separados; não omitir falhas, fabricar900sucessos em rota inviável, dividir900entre modos nem juntar hardware/estágios. Baseline idêntico só reutilizado com mapeamento explícito de fonte/input/model/settings/requester/superfície. Manifesto mínimo: surface/requester/provider/mode/remote_stage_set/stage_provider_map/source_app_model_input_settings/n_planned/n_measured/n_success/p90/p95/clock_domains/raw_paths/limitations.

Telemetria correlacionada obrigatória: input/END_OF_SPEECH→STT, setup/discovery/fronteira warm, fila/carregamento/inferência/TTFT quando exposto, STT transcript/final, LLM output, TTS primeiro áudio/geração completa, playback início/fim e latência áudio→áudio completa, render/história onde aplicáveis. Registrar intervalos monotônicos por processo/dispositivo, offsets/incertezas/overlap; não subtrair relógios sem relação provada nem somar spans sobrepostos. CPU/RAM/rede/storage e GPU/VRAM/backend/layers/offload por host/processo no prebaseline e contínuo; bateria/thermal/radio somente capazes e realmente medidos. Campos não expostos são NULL+motivo, não zero; endpoint/controladora deve provar uso real do acelerador, sem emprestar25/25layers de outro cohort. Pure protocol overhead exige compute matched spans; diferenças de hardware/carga não o são.

Estado histórico novo, limitado: V474 saved-answer Read aloud PASS de readiness, EXIT0 natural2026-10-15T02:03:59.832245/56,034267s; TTS.Synthesize200 e WAV21548bytes/SHAf00344a020a8ba4006d159b0a70dd179a7ede653e21f7558508a660628e9558c,10752frames/mono22050HzPCM16. Software playing13236ms/ended14020ms no MESMO relógio da página; header5d1e095f7bbac70bbdd6bfbe7fca78bc junta handler6716,926428ms/model_invoke6669,907545ms no mesmo Python. selected_provider=NULL: Piper declarado NÃO estabelece engine efetivo. Corpo JSONHTTP integral não retido separadamente, WAV/hash/bytes/headers retidos; sem rerun para enriquecer esse PASS. Zero novo STT/LLM/mic, portanto NÃO áudio→áudio, NÃO amostra medida/p90/p95/seal. Runtime terminou02:04:03.853398;7PIDs ausentes/lock livre/DB original inalterado02:06:23.421375. Evidência root/retained-audio-main-v474/manifest.json SHA026b96eb6cf070b266e971234abb75da5bf5af953b17d2a8a457814af5223868/44membros listados+manifesto, READMEa980b0fb9e5b5eca8fcb1e6aa1686043d08c2a09494c4270dbb501d28ef12572; Root msg_34a853d8a91a. Artefato disponível não significa revisão independente de todos44membros pelo monitor já realizada.

Native/Tauri permanece lacuna separada: Root msg_d7326cd27916/desktop02:21:51 comprova GTK/WebKit/GUItools presentes, nenhum binário/bundle encontrado NAS DUAS RAÍZES DECLARADAS e diretórios owned correspondentes (não ausência global), isolamento nativo de app_data/config/keyring/single-instance ainda não provado. Nenhuma execução nativa/build começou. Home324681728B/shm560443392B/RAM3303190528B livres nesse instante são readiness/confundidores, não autorização para cleanup nem prova de impossibilidade headless. Encerrar esse inventário não dispensa a superfície; tampouco o torna gate do áudio local independente. Não lançar build amplo ou outro probe de first-paint antes da prioridade A por conveniência.

**Barreira HARD:** phase2_measured_allowed=false até **evidência individual AUDIO E SUPERFÍCIES obrigatórias completas, aceitas/seladas** e transição explícita do Root. Controles typedCPUEXTRA original900total/300porrota+45warmups e GPUtyped900local/900API permanecem íntegros/separados; terminaram no escopo tipado, NÃO são selo áudio. Nova condição CPUáudio separada, sem expandir/reconfigurar campanha CPU congelada em lugar; GPUáudio primário separado, sem pooling/descartar números feios. CPU/GPU individuais podem executar em paralelo se recursos realmente isolados; nenhum tráfego medido cross-device durante essa fase. Preparação sem interferência permitida, sem assumir hardware ou isolamento.

Após a barreira, cumprir matriz real não-iOS aprovada BR/PT/US/Android elegíveis, native/headless/desktop/browser/mobile/localPython/HTTPgatewayreal/P2P cumulativo remoto **TTS-only → TTS+LLM → TTS+LLM+STT**, mesma pipeline completa e restantes estágios locais,900por condição, ICE direto/relay/NAT/fallback, load/concorrência/recovery/privacidade/viabilidade/custos e todos os casos T0–T13 aplicáveis do plano. Loopback/same-worker não aceita deployedAPI/cross-device. Carga local+mesh concorrente é condição de estudo declarada, não baseline isolado ou motivo para esconder competição. Capacidades/país/telefone físico desconhecidos permanecem explícitos; iOS excluído do denominador ativo/histórico preservado.

Checklist de execução/aceitação deste amendment: [ ] Root ACK da prioridade e dependências separadas; [ ] bloqueador/rota áudio desktop concreta e admissão real; [ ] piloto áudio completo correto/STT→LLM→TTS causal e engines/GPU comprovados; [ ] manifesto+telemetria/caps congelados; [ ]900por nova condição individual áudio CPU/GPU aplicável; [ ] mic/UI/superfícies separadas completas; [ ] selos individuais e transição Root; [ ] matriz entre dispositivos cumulativa completa. Evidência atual não marca nenhum desses itens completo por aceitação de orientação. Checklist detalhado em docs/experiments/tcc-20261013-submission-20261030/monitor/plan-audio-priority-hard-gate-20261015T0226/audio-priority-checklist.md.

Root original term_6a00d9ee-792a-4daf-8578-236290e33108 único integrador/executor/dono de recursos; monitor term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc único escritor do plano. Run run_e6054e76e9fc/Task task_d7ea336050cf/Dispatch ctx_37b4d0a3c14f e linhagem hermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4 preservados; goals nativos ACTIVE/objetivo integral não concluído. Sem iOS ativo, nova sessão/worker/writer/projeto, mudança de credencial/segurança/provider/driver/networkscope, acesso corporativo, commit/push/submissão ou interrupção de usuário. Plano completo preservado por backup/prefixo/diff; esta correção substitui somente a ordem incompatível de próximos readiness slices.


### 30.14 Piloto real áudio→áudio executado, tarefa falha e gates explícitos — 2026-10-15 02:48 UTC

Root reconheceu integralmente30.13/1620linhas/hash/prefixo/diff/checklist em msg_220b63283244 às02:31:47. O runtime headless independente usou produção main.py/LocalBus, sem Android/browser/microfone como pré-requisito. V476 iniciou controller2894885 às02:33:58.278413, mas terminou setup-only às02:33:58.480831/0,012655s/EXIT-2: contador opcional gpu_busy_percent retornou OSError16EBUSY, backendlog0bytes/sem observer/piloto/estágios. AmbosPIDs ausentes/global+GPUlocks livres02:35:14; erro não prova GPU indisponível nem conta tentativa de áudio. V477 corrigiu somente contador indisponível→NULL+path/errno, mantendo fontes/modelos/settings/locks/caps; ambos históricos retidos.

**V477 executou uma cadeia REAL completa**, controller2896027/Python2896043,2026-10-15T02:36:30.277105→02:37:02.371832,32,094766s/EXIT1natural. Mesmo WAV integral193068bytes/96512frames/4,376961451s/monoPCM16/22050Hz/SHA2f6361506708d0a3065a339d168c9db5412e343683dd9b4080471d8948bf82ae. STT efetivo3385,510006ms retornou “apply with exactly this single word and no punctuation or bit.”; texto passado INALTERADO ao Assistant real, que respondeu em11164,148923ms “I am ready to apply the requested tool. Please specify the tool name or action you wish to perform.”. Essa resposta INALTERADA alimentou Piper real2222,815357ms, gerando WAV válido/não silencioso246316bytes/123136frames/22050monoPCM16/duração5584,399093ms/SHA7557b916c4bd4087f10f06cb41a156cada24f43c9e80deb71624cc4088cff63e. Sem transcript/reply injetados/cache/serviço direto ou troca silenciosa. **Tarefa esperada ORBIT falhou:1tentativa/0corretas/1falha/0timeouts/0MEDIDAS; tentativa global de voz9**, V476 soma zero.

Intervalo do caller16854,171509ms é **submissão de arquivo disponível→validação da saída**, exclui duração de gravação/input, setup10432,664834ms e shutdown. Não é sensor/end-of-speech real, playback, TTFA, latência de inferência isolada ou p90/p95. Correlation wav-flow-564fc2196d6e4d91a3c77ef08c7dcc16 une7pares de spans no MESMO Python2896043/clock monotônico e sequência causal retida; parentSpanId=NULL permanece limitação explícita, sem links inventados. Model spans STT3374,399990ms/LLM1425,107026ms/TTS2216,709570ms e history144,200985/202,255406ms têm limites próprios. Não somar spans ou chamar diferenças de fila/setup/protocolo sem intervalos medidos. Queue,TTFT,firstaudio,networkbytes,playback/render independentes continuam NULL+motivo. Áudio final foi decodificado/validado, NÃO reproduzido; captura física/audibilidade/softwareplayback não comprovados.

Actual-provider-bindings6eventos comprovam FasterWhisper/CTranslate2CPU int8_float32/modelpath e PiperCLI/executável/modelo/config/saída efetivos. QwenChatLlamaCpp pediu100layers no construtor; **zero linhas de offload capturadas**, VRAM RX7600 somente27262976→721244160bytes/32amostras não prova kernels/layers/GPUusada. Não aceitar este caso como baselineGPUverificado nem emprestar25layers dos controles tipados. Seed/n_threads ausentes/NULL no construtor apesar de config declarada42/2: equivalência de settings com outro cohort NÃO estabelecida; preservar declaração e efetivo separados. Falha ASR não é causada/provada por essa lacuna LLM. Observer20eventos16641bytes completo/zero erros de escrita/flush/reject. AmbosPIDs ausentes/global+GPUlocks livres02:38:55.532689; RAMmínima disponível2239414272bytes, home323420160bytes/shm560443392bytes nesse momento; não implica cleanup autorizado nem recursos suficientes para900.

Evidência acessível em docs/experiments/tcc-20261013-submission-20261030/root/headless-full-audio-v477/: manifest.json SHAbcca2e64746b8b9f3f251abf9c4ee3d9714a6e4cb3b1d56f81f2c4ea288d7b21 lista31membros INCLUINDOREADME; com manifesto externo+raw/manifest.json são33arquivos observados. README SHA bde7191e099cb95ea8b0c304f06bbdc77c4cced4c547e41c14e6b53e8e88762b. ZIP408646bytes/533frames/SHA530ee72a4d76fa7e97760ee25e53255c979094ffcc0b062dc038cd32a03698e2/18membros raw; rawmanifest43d9b587a14a61a12d1aa2dfd98db68a0561bf88be3280d6fde67fe06ba6d678. Root verificou transfer/archive/membros uma vez; monitor verificou uma vez bytes/hashes dos31listados+README e leu sourceaudit/spananalysis/retirement, receipt monitor/headless-full-audio-v477-verified-20261015T0248.json SHA1dc95716250931ecc4e0fb207ddf5d43f773d6b35a5890506bf6eaf4528e743d. Input/outputWAV/transcript/reply/bindings/spans/resources/fontes/reviews/setupfalho/retirada retidos. Configs/DB/credenciais/backendlogs integrais privados não projetados; ausência pública de log não é ausência de runtime.

Audit source-only finito DECODE-BOUNDARY.md SHAb6de9346c0d58ab4062a302d2890f72321454cd29c1845a9908571e8b2d3bc6e encontrou header/request22050Hz concordantes e exatamente uma conversão esperada22050→16000; nenhum erro determinístico de decode/resample estabelecido. Não executou novo decode/modelo/teste/device. **Causa ASR UNKNOWN**; não inferir modelo incapaz de todos os casos, culpar Android ou abrir escada de frases/modelos/gain/flags/timeouts. Outra tentativa idêntica não corrige um defeito desconhecido. Atual gate real é tarefa correta para WAV/accuratebase fixos, além de provaGPU/settings/telemetria; nenhum900de condição conhecida-falha foi admitido.

Separadamente Root msg_29577e0c5b26 relata V478 após retirada: reparou schema tipado que descartava seed42/thread2/verboseTrue, regenerou models/keys/defaults e preservou defaults do wrapper -1/auto/false. Um novo teste dirigido typedconfig→construtor REAL ChatLlamaCpp com backend controlado PASS1/32,78s/38,635souter, Ruff/generationPASS e SolAPPbbc89368. É evidência de propagação/configuração relatada, NÃO rerun de inferência, conserto do ASR, prova de offload ou upgrade de resultados históricos. Manifesto/receipt final próprio do delta deve ser ligado antes de declarar revisão independente completa pelo monitor. Próximo cohort deve registrar efetivos e exibir offload real, não apenas config.

Próximo branch exige decisão/correção sustentada pela coordenação original: resolver ASR/entrada/modelo sem mascarar a falha; qualquer alteração metodológica de áudio/modelos/settings deve ser declarada e comparável entre CPU/GPU em condição distinta, com aprovação/autoridade adequada e preservação dos originais, nunca troca silenciosa. Monitor encaminhou pergunta durável ao Root, aguardando resposta real; não presume autorização por timeout/silêncio. Não repetir piloto cego nem substituir por história/read-aloud/UI/Android enquanto gate de áudio permanece aberto. Preparações/diagnósticos finitos somente quando mudarem a próxima ação; arquivar UNKNOWN com bloqueador preciso quando necessário.

**Aceitação inalterada:**900MEDIDAS POR CADA NOVA CONDIÇÃO APLICÁVEL de áudio/modo/superfície/par/estágios, warmups extras/excluídos, denominadores íntegros e p90/p95 por condição/quantilmétodo explícito; sem pooling CPU/GPU, sem expandir CPU EXTRA antigo em lugar, sem fabricar900sucessos em inviável. Controles tipados CPU/GPU originais são históricos válidos no escopo próprio, não áudio ou equivalência de settings automaticamente. Completar áudio correto e telemetria clock-safe/stage_provider_map, mic/UI/superfícies individuais separadas, selos aceitos antes da transição Root. **whole_gpu_acceptance=false; individual_gpu_condition_finished_and_sealed=false; phase2_measured_allowed=false**. Nenhum tráfego medido cross-device até fullindividualAUDIO+SURFACEaceitos/selados; depois cumprir matriz real não-iOS BR/PT/US/Android elegíveis/localPython/APIHTTP/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT/T0–T13 com900porcondição/load/concurrency/recovery/privacy/feasibility/rotas/custos/telemetria integral.

Checklist operacional vivo e receipts em monitor/plan-audio-priority-hard-gate-20261015T0226/. Fleet02:41:45 completa129únicos/2páginas/hasMorefalse:1monitor original confirmado live,53exited,75unverifiable (não presumir saída/ausência); Root nativeleader confirmado running separadamente. Root original único integrador/executor/dono de locks/validações; monitor único planwriter; Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/linhagemhermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4 preservados/goals ACTIVE. Sem iOS ativo, novoRoot/monitor/worker/writer/projeto, acesso/credenciais/segurança/provider/driver/networkscope/corporativo, commit/push/submissão ou interrupção de usuário. Encerrar audit/fixture não encerra objetivo integral.


### 30.15 OWNER AUTORIZA revisão metodológica e calibração local finita — 2026-10-15 03:04 UTC

**Nova autorização EXPLÍCITA do owner, mesma Aurora/matriz/objetivo, supersede o gate de aprovação de modelo/fixture em30.13–30.14:** falha de qualidade/transcrição é trabalho de engenharia a resolver, NÃO bloqueador a devolver ao owner. Pode escolher áudio fixo mais claro/licenciado/sintético e/ou modelo LOCAL compatível melhor, inclusive Whisper maior, quando a evidência apontar baixa qualidade. Erro de harness/runtime não prova causa de qualidade. Root deve avançar autonomamente com pilotos finitos e sustentados, sem pedir escolha ao owner para cada áudio/modelo. Somente falta real de autoridade/segurança/capacidade inacessível exige escalação; não usar desconhecido de qualidade para aposentar matriz ou bloquear artificialmente.

Preservar a história: Root efetivamente entrou nativeBLOCKED em02:56:40/msg_f400db3ab069 apósV478/V479/V480 e uma pergunta de calibração pendente; **essa barreira de autoridade foi agora resolvida pelo owner**. Bloqueio anterior não era conclusão/cancelamento e não reduz13metas. Relay originalrun msg_92e2e65958c0 e input NORMAL/não interruptor no MESMO Root aceitos, request619d7117-45ab-4595-a622-bbd5c60a466a/input_accepted+turn_started/incarnationfe7e63c7-d260-465f-b37e-f6fc78f8a1af. Isso prova retomada do turno, não nativegoalACTIVE ou piloto lançado; exigir get_goal efetivo do Root e continuação/resume suportado do MESMO goal. UI original mostrou literalmente /goal resume; não inventar /go, criar novo goal/Root/projeto, editar estado oculto ou interromper sessões.

Próximo branch concreto autorizado: Root inventaria capacidade/artefactos LOCAIS aprovados no desktop e escolhe UMA hipótese de correção por bloco de readiness, com proveniência do áudio/modelo, identidade/source/versão e recursos admitidos ANTES de execução. Pode melhorar fixture e/ou modelo de forma explícita, preservar a combinação antiga como falha e separar a nova. Selecionar tarefa útil e representativa de assistente com referência/transcript e critérios de conteúdo/ação/saída declarados antes do piloto. NÃO escolher frase mágica/predicado fácil para maquilhar PASS, injetar transcript/reply, relaxar correção, trocar provider silencioso ou usar saved-answer/read-aloud como pipeline.

Piloto deve executar entrada de ÁUDIO REAL → STT efetivo → transcript retornado → LLM efetivo → resposta real → TTS efetivo → ÁUDIO válido/não silencioso/correto, com reprodução somente onde reivindicada. Prerecorded determinístico não prova captura física. Verificar decodificação/resampling/fidelidade, bindings/localidade/modelos/quantização/configuração EFETIVOS e aceleração por runtime; modelos de baseline não podem ser presumidos por config ou herdados de logs de outro cohort. Deploy da correção V478 deve ter receipt/hash correspondente no runtime novo. Android preto, nativeprofile e micbrowser continuam gates de superfície SEPARADOS e não adiam esse branch independente.

Finito por projeto/sessão/condição: declarar candidato(s), n de pilotos, warmups, timeoutrequest, capflow/controller/download/carga e orçamento CPU/GPU/VRAM/RAM/storage/rede antes de iniciar; adaptar caps a evidência de admissão/piloto, não escada cega de timeout. Checks de correção/instrumentação antes de900; fracassos/timeouts/setupfalhos preservados com estágio/categoria/causa conhecida ou UNKNOWN. Download/coldbuild que progride não é stall; recurso insuficiente deve nomear falta exata e próximo passo limitado. Usar somente identidades/ferramentas/localbackend aprovados; sem provider pago/driver/segurança/conta/credencial/acesso/networkscope novos ou recursos corporativos. Root único dono de execuções/locks/reservas; não lançar nova frota/writers concorrentes.

**Congelar NOVO manifesto versionado SOMENTE depois do candidato passar cadeia áudio→áudio real com telemetria e correção exigidas.** Antes disso, artefactos são candidate/readiness e não campanha aceita. Manifesto deve registrar cohort_id/version/status/freeze_at/sourcecommit+overlay/appbuild/sourcehashes; áudio original/decodificado/reference_transcript/task/correctness/licença/proveniência/hashes; modelos por etapa/pesos/revisões/hash/executável/bibliotecas/versões/quantização/decoding; backend/configdeclared vs effective/seed/threads/generationlimits; surface/requester/provider/stage_provider_map; hardware/CPU/GPU/VRAM/RAM/capacidades/aceleração efetiva e diferenças CPU-GPU; clocks/telemetryschema/latencyendpoints/setup-warm/overlaps/unknowns; caps/pilotproof/rawpaths/failurehistory;900n_planned por cada condição aplicável+warmups adicionais/excluídos. Freeze não é execução de900 nem selo de todas as superfícies.

A partir desse freeze, aplicar MESMO setup EFETIVO de tarefa/áudio/modelos/configuração em TODAS as superfícies não-iOS aplicáveis e depois dispositivos/modos/etapas cumulativas. Diferenças de hardware/aceleração são explícitas; modelo menor escondido para dispositivo fraco é proibido. Fracos mantêm inviável/timeout honesto conforme cap/admissão, sem forçarOOM/fabricar900sucessos. CPU EXTRA tipado antigo e outros controlos de texto não afetados permanecem suplementares no escopo original, nunca renomeados como áudio novo nem expandidos em lugar.

**Mudou áudio/modelo/settings = NOVO COHORT.** Root mantém registry/receipt de substituição com old_cohort_id/condition_id/oldmanifestSHA+rawhashes/disposition/reason/affected_cells/replacement_cohort_id/newmanifestpath+SHA/replacementstatus/time. Marcar comparações antigas AFETADAS como SUPERSEDED com links reais de reposição; preservar bytes/resultados/falhas anteriores e rótulos/fontes. Enquanto candidato/manifesto de reposição não existir, replacementstatus=PENDING e IDs/hashes desconhecidos=NULL+motivo, nunca receipt inventado. Rerodar SOMENTE células comparativas necessárias afetadas; controlos não afetados ficam retained_supplemental com mapa explícito. Não sobrescrever dados nem juntar percentis de setups incompatíveis; localbaseline idêntico só reutilizado com prova/mapeamento de igualdade.

**900 MEDIDOS POR CADA NOVA CONDIÇÃO APLICÁVEL**, warmups adicionais/excluídos, p90/p95 por condição/quantilmétodo e todos os denominadores/erros/timeouts continuam obrigatórios. Correlacionar request/spans/stages/provider/clock-safe: input/EOS→STT, fila/load/inference/TTFTseexposto, TTSfirstaudio/fullgeneration/playbackiníciofim onde aplicável, render/history e e2e; resources/rede/GPU por host/processo, unknown=NULL+motivo, nenhum somatório/subtração indevidos. Pilot descritivo não gera p95; telemetria incompleta continua gate explícito antes da campanha, sem inventarparentlinks/zero.

**Prioridade e BARREIRA INALTERADAS:** áudio completo individual CPU/GPU/headless/desktop primeiro; requiredindividualAUDIO+SURFACES aceitos/selados e transição Root antes de QUALQUER tráfego MEDIDO cross-device. Depois cumprir todos os pares/superfícies reais autorizados não-iOS, localPython/APIHTTPdeployed/P2P cumulativo remoto TTS-only→TTS+LLM→TTS+LLM+STT com restante local e pipelinecompleta,900porcondição/carga/concorrência/recovery/privacy/feasibility/ICE/networkresources. Loopback/same-worker não é deployed/crossdevice. iOS fora do denominador ativo, história preservada.

Checklist atual: [x] autoridade nova recebida/persistida/relayed; [x] turno originalRoot aceito sem interrupt; [ ] nativegoalstatus efetivo e ACK Root; [ ] candidato/recurso/caps selecionados de fato; [ ] piloto real correto+telemetria; [ ] NOVOfreezehash/cohort; [ ] registrySUPERSEDED+replacementlinks afetados/retainedsupplemental não afetados; [ ]900por condições novas e selos individuais; [ ] matrizrealposterior completa. Aceitação de guidance não preenche itens de execução. Manifesto/candidato/receipt de substituição ainda NÃO existem neste checkpoint; Root executor produzirá exatos IDs/caminhos/hashes e monitor os ligará no checklist sem fingir aplicação.

Mesmos Rootterm_6a00d9ee-792a-4daf-8578-236290e33108 e monitorterm_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc; Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/guidehermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4. Root único integrador/executor/dono de manifestos de execução e reservas; monitor único escritor do plano. Branch/worktree/WIP/evidência preservados; nenhuma alteração de fonte/teste/modelcall/lock/conta por monitor, commit/push/submissão ou nova sessão. Native monitor goal continua ACTIVE; objetivo integral não concluído.
