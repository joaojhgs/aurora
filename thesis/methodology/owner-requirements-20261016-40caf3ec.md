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


### 30.16 Revisão APLICADA: piloto correto, NOVO cohort congelado e900 em execução — recibos de15out2026

Aplica30.15 com evidência efetiva, não só aceite de guidance. Root original retomou o MESMO nativegoal01a112a5-d6bb-74e2-bf7c-ace73cb513b5 ACTIVE/full13/unbudgeted após /goal resume suportado, sem novoGoal/Root/worker/estado oculto. Monitorgoal01a123ff-19ba-7332-a2f7-346a722af79f segue ACTIVE. Nova autoridade resolveu a antiga escolha de modelo/fixture; correções de qualidade/harness continuam autônomas e finitas.

**Cohort congelado:** aurora-full-audio-capital-v1-desktop-gpu-local-20261015; família aurora-full-audio-capital-base-qwen-piper-v1. Freeze2026-10-15T03:22:36.295174Z, depois de UM piloto real correto. Manifesto acessível: /home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/root/full-audio-capital-v481/raw/candidate-v481/frozen-manifest-v1.json, SHA256 **d34d21d1a9b1a2db03be2ad64c096e77082168b3bcc09c28d442b4a61eaff3d7**. Registry aplicado: mesmo diretório/cohort-replacements-v1.json, SHA256 **cda9eb1931def2c1a177a13b69b6c8d6dd9a58e9a7135d50e51c43721c514cc5**. São cópias byte-exatas dos originais de execução, não hashes inventados/projeções substituídas.

Registry marca o setup comparativo ORBIT antigo SUPERSEDED_COMPARATIVE_SETUP_FAILURES_RETAINED, ligado ao novo cohort/hash; o antigo piloto não tinha measuredcohortID e continuaNULL+motivo. Referências antigas manifestV477 bcca2e64746b8b9f3f251abf9c4ee3d9714a6e4cb3b1d56f81f2c4ea288d7b21/raw530ee72a4d76fa7e97760ee25e53255c979094ffcc0b062dc038cd32a03698e2 preservadas. CPU EXTRA6ce98ae97d594d9fafcd1ff9ad4b9b1c e GPUtypedlocal/API permanecem retained_supplemental nos seus escopos originais. Nenhum dado antigo apagado/rebatizado/agrupado em percentis novos; apenas células afetadas serão substituídas. Nota de proveniência: o rótulo agregado voice1–9 do registryv1 não muda os modelos históricos: seis primeiros eramTiny e os posterioresaccurate/base, como30.8–30.9 registram; não descrever todos comoBase nem como nove cadeias completas.

Tarefa útil pré-declarada: “What is the capital of France? Answer with only the city name.”; transcript inteiro normalizado exato e única palavraParis. Áudio sintéticoPiper novo153644bytes/76800frames/22050monoPCM16/3.482993197s/SHA139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3; transcriptSHA34b681e385feb3500c9e9849d30f5bac982716c4e4938cdb04c5fdc617cff624. Mesmo modeloSTTbaseCPU, QwenQ4_0 e Piper; não foi preciso trocar pesos nesta primeira correção. ModeloSTTd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9, LLM57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf, TTS6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22; configs/tokenizer/vocab/executável/13sources/harnesses e versões exatas no manifesto. Versões faster-whisper1.1.1/ctranslate2 4.7.1/llama-cpp-python0.3.19/piper-tts1.2.0/onnxruntime1.20.1/numpy2.2.6. Congelar a semântica comum e declarar hardware/backenddifferent conditions; não reduzir modelos escondido em fracos.

PilotoV481 REAL: controller2903659/Python2903675, naturalEXIT0 às03:14:48.886545/26.082992s;1attempt/1correct/0failed/0timeout/0warmup/0MEASURED, ordinal lógico global10. STT3357.917059ms → transcript real exato → Assistant8401.700594ms/Paris → Piper1563.726817ms → WAV válido/não silencioso31276bytes/15616frames/708.208617ms/SHA c45b4cc7d8e6edbc4722f4a87ffd235cc25a550cbe90c777cfe4863ef84dc430. Caller13512.828985ms=file-ready→saída validada incluindo manejo de artefacto do piloto, excluindo gravação/setup9014.893017ms/shutdown; NÃO sensorEOS/playback/p95. Runner medido registra saída validada antes da persistência, com limite próprio declarado; não juntar tempos desse piloto excluído a percentis da campanha.

Offload LLM REAL25/25layers viaVulkan/RX7600, construtor/wrapper efetivosseed42/n_threads2/n_gpu_layers100/temperature0/top_k1/top_p1/max_tokens128/n_ctx4096/n_batch64/repeat_penalty1; STTCPU int8_float32/beam5/vadtrue, PiperCLIuseCudaFalse. Só LLM tem essa provaGPU; não chamar toda a pipelineGPU. Correlation wav-flow-05d5e0dcb8374de4af7d7ce570cd8616/requestwav-request-34c4e335bf90469fbeb6daa9c1ce0c19,20eventos/7spans mesmosPID/clock, zeroerros/capturacompleta. Queue/TTFT/firststreamaudio/playback permanecemNULL+motivo, parentlinksNULL, hashnumpyprocessado não capturado, tráfego somente agregado namespace; nenhum zero/overhead/firsttoken inventado. Microfone físico, audibilidade/reprodução/native/browser/Android não são aceitos por esse headlessPASS. AmbosPIDs ausentes e locks global/GPU livres03:22:35.799683.

Pacote acessível root/full-audio-capital-v481/manifest.json SHA695245c5f4b75a45e462d4c2b8302b4dea8e281bf756c8f8b7c06e68f039b4a9,30membros listados/31arquivos observados; raw195329bytes/255frames/19ZIPmembers/SHAa39ae341d2adf2d18d12e934083cd511c64f1dbf1a9fefe80a78419e6c575eb5. Root verificou transfer/rawuma vez; monitor verificou bytes/hashes dos30membros UMA vez e leu integralmente manifesto/registry/README/pilotresult/retirement/implementation, sem testes/modelcalls. Receipt monitor/full-audio-capital-v481-verified-20261015T0337.json SHA d9375b50eae1937672777a33e6b1bb3bbf5b824c46ae155e37b00dca1288b760. Os originais de falhas/passes/sourceincident e4preimages restauradas continuam preservados.

Primeiras entradas de mediçãoV482/V484 foram SETUP-ONLY:0warmup/0audio/0measured/900unattempted. V482 guard detectou normalização de config pelo Supervisor; diagnóstico separou credenciais da fixture/branches não usados/taglinguagem de parâmetros ativos inalterados. AmbosPIDs2907500/2907520 ausentes/locksfree03:33:32.205598. V484 terminou12.537s/exit1, retirado03:39:04/locksfree, por predicado incorretoen vsvalor realen-us. V485 corrigiu SOMENTE predicado contra config real, preservando igualdade exata do perfil ativo e guardraw por tentativa; sourceSolcf394862. Não são falhas de modelo nem justificam escalada de frase/modelo/timeout; não se repetiu o piloto aprovado.

**CONDIÇÃO900 EFETIVAMENTE EM EXECUÇÃO:** desktopV485 controller2910571/Python2910591 live, iniciado03:41:25.686258Z;26pinsPASS/offloadatual25layers/reserva exclusivaRootGPU+buildlock. Receipt Rootmsg_d364ab03758b observa03:42:23.324445Z três tentativas corretas, todaswarmupsEXCLUÍDAS;0medidas naquele instante/900porfazer. Totalcongelado15warmups adicionais+900MEDIDAS LocalBusfullaudio,180sflow/12600scondição/12780souter, deadline máximo07:14:25.686258Z. Usar MESMOS handles, sem relaunch/alteração em lugar/novosource durante campanha. Contagens futuras só por recibos reais; esses3warmups não são900começados/completos nem p90/p95.

CPU individual disjunto: privadoenv/cópia de399sources/6.68MB+13corehashes+7modelhashes/WAV/voz exatos preparados, .venv original intacta;2CPUthreads/noGPU. CPU483 terminou37.791s comSTTexato, mas marcadorpyproject ausente impediu construtorLLM;TTS causa não juntada,1nonpass/0measured preservado/PIDs-lockfree03:41:46.109236, sem inferir qualidade. CPU486 adiciona pyproject existente byte-exato c335d253 em novospaths, controller2218352 começou03:42:18.151602, UMpiloto180flow/300outer/deadline03:47:18.151602, mesmoenv/modelos/áudio/settingsCPU0. Resultado/freezeCPU aindaPENDING, nenhuma condiçãoCPU900 iniciada por esse receipt. Root controla as duas reservas físicas sem GPU compartilhada/tráfego medido entre nós; preparação CPU não é nova sessão/worker. BackendARM/recursos/capacidades reais devem ser comprovados e limites honestos mantidos.

Próximos gates concretos: acompanhar desktopMESMOcontroller até900+15/terminal/raw/resultados quantis/demaisdenominadores; receber pilotoCPU real/retirada e manifesto de condição CPU correspondente antes900CPU. Mesma família sem poolinghardware/estágios/superfícies. Completar todas as superfícies individuais não-iOS e métricas aplicáveis/unknowns explícitos; T0–T13,BR/PT/US/Android reais/capacidades verificados não dispensados. **whole_gpu_acceptance=false; requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false**. Só após selos individuais exigidos e transiçãoRoot iniciar crossdevice/APIdeployed/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT com900porcondição; loopback/sameworker não conta. iOS excluído ativo, história mantida.

Root original único integrador/executor/manifestos/reservas; monitor único planwriter, sem fonte/teste/modelo/lock/commit/push/newPR/submissão/adoption/interrupt por monitor. Mesmos Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/guidehermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4. Plano completo preservado por backup/prefixo/diff, objetivos nativos ACTIVE e matriz integral NÃO concluída.


### 30.17 CPU áudio correto/congelado e duas condições900 realmente iniciadas —15out2026 04:05UTC

Este checkpoint atualiza os PENDING históricos de30.16 sem os apagar. Root original confirmou por msg_cd23dbfdeab2 (04:03:07Z) o PASS realCPU490, freeze e inícioCPU491; monitor leu os dois JSON completos e os resultados/retirada e verificou uma vez todos os74membros listados/75arquivos do pacote. Nenhum teste/modelcall pelo monitor.

**NOVO cohortCPU:** aurora-full-audio-capital-v1-worker-cpu-local-20261015, família aurora-full-audio-capital-base-qwen-piper-v1. Pacote acessível /home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/root/full-audio-worker-cpu-v490/; manifest.json SHA3176d21181acc8c8998e9bc48a11771eb94e716728abe6ea86f541ab6bc4bf94. frozen-manifest-v1.json SHA **364832a627e2f45b4b1c2b80ca05739f809132a28ff26511f0eda5e30f89127a**; cohort-replacements-v1.json SHA **2d1610a0bc2794ba26acd8aa3e21e130a4b6a8202b946408008b2761ba6c345e**. Freeze03:57:38.621750Z, depois do piloto correto e da retirada confirmada. Cópias byte-exatas, não projeções futuras.

CPU490 executou UM WAV real→STT→LLMParis→TTS/WAV válido e não silencioso, sem transcript/resposta injetados:1attempt/1correct/0failed/0timeout/0warmup/**0MEASURED**. Caller49633.587315ms, STT6301.671373/Assistant39262.118801/TTS4065.091185ms; setup16054.304219ms separado. Saída31276bytes/15616frames/22050monoPCM16/708.208617ms/SHA45d5e347c90051de387ce874cdfac50e12980b7d3d8d2f602225b42b0f713f05. Naturalexit0 às03:55:10.323625,76.393626s; ambosPIDs2226013/2226057ausentes/localgloballockfree03:57:38.621262. A duração do piloto não é p90/p95 nem se incorpora às900medidas.

CPU efetivo ARM64/2threads/offload0/NEON/buffersCPU, core6versões e13sources/modelhashes/áudio/transcript/decoding iguais à famíliaGPU, diferenças arquitetura/backendbuild/pathmapping explicitadas. Mesmo inputSHA139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3 e pesos30.16; não houve redução oculta. PiperCLI1.2.0 do envprivado previamente fixado, playbacklibs também privadas, sem instalação de sistema/driver/segurança.20eventos/7spans correlacionados no mesmoPID/clock/capturacompleta/zeroerros; fila/TTFT/firststreamaudio/playback/peakRSSfilhoPiper/arrayprocessado permanecemNULL+motivo. Rede namespace não é tráfego individual. Headless não prova captura física, reprodução/audibilidade ou superfície nativa/browser/Android.

FalhasCPU483/486/488 continuam completas em raw/ e registryRUNTIME_READINESS_FAILURES_RETAINED, ligadas ao novo freeze: marcador de raiz ausente, dependências playback ausentes e consoleentry incorreto, respectivamente; não inferir baixa qualidade de modelo. O registry remete ao registryGPUv1 de30.16 e mantémCPUtypedEXTRA6ce98ae97d594d9fafcd1ff9ad4b9b1c retained_supplemental. Nenhum resultado antigo sobrescrito, rebatizado ou combinado em percentis novos. Novos settings/input/modelos exigiriam novo cohort e só comparações afetadas.

**CPU491 INICIADO:** controller2232517, início04:00:53.523642Z,15warmups adicionais/excluídos +900MEDIDAS desta condiçãoheadlessLocalBus,180s/request,57600s/condição,57840s/outer. LimiteCPU próprio:915×49.633587315s×1.25=56768.4s, arredondado16h; não herdou o limiteGPU. Outer máximo2026-10-15T20:04:53.523642Z. Source/reviewc9815f93, runnerSHAe3348ca0c064679f1c88e7bdc8fdec0942fda24b43fe7fdba2fa9f924d7d7dd9; source490privado fixo/envreadonly, sem outrobuild/testeCPU. measurement-admission/controller-launch.json SHA2a6370e25a8dc5e220b450569a25e13b6c1847c6e177f4fb9652baa8fc63550a. Launch não prova contagem medida; contagemCPU atual ainda NÃO recebida neste checkpoint. Ao atingir cap, registrar incomplete/unattempted/denominadores, sem extensão silenciosa nem900sucessos fabricados.

**DesktopGPU485 continua MESMO controller2910571/Python2910591**, sem relaunch/inputchange: Root observou04:00:58.573679Z15warmups concluídos +**91/900MEDIDAS/809unattempted**, última correta/offload25layers. Não assumir todas91corretas sem agregação de outcomes. ReservaGPU continua exclusiva; preparaçãoHTTP493 somente source e fisicamente isolada, nenhum HTTP medido antes do término natural/retirada da condiçãoLocal900. CPU eGPU operam em hardware disjunto, sem tráfico medido entre nós. Seus samples/percentis permanecem separados; diferença entre máquinas não é overhead de protocolo.

Checklist efetivo: [x] autoridade revisionada aplicada; [x] pilotoGPU correto/freeze/registry; [x] pilotoCPU correto/freeze/registry; [x] duas condições900 realmente iniciadas em paralelo; [ ]900por condição concluídos/quantis/outcomes/raw/seals; [ ]telemetria aplicável/superfícies individuais completas; [ ]transiçãoRoot; [ ]matriz real completa. Type7 por condição com warmups excluídos, failure/timeout denominators e censura; preservar todas as novas falhas/timeout/unattempted. Campos não medidos continuam desconhecidos.

**BARREIRA MANTIDA:** requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false. Nenhum headlessPASS/typedpass/subconjunto900 dispensa as demais superfícies não-iOS nem autoriza cross-device. Depois dos selos e transiçãoRoot, todos os pares/superfícies reais aprovados, localPython/HTTPdeployed/P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT com pipeline inteira/stageProviderMap/900por nova condição, recursos/ICE/carga/concurrency/recovery/privacy/feasibility continuam mandatórios. iOS fora do denominador ativo, história mantida.

Mesmo projeto/branch/Root/monitor/Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/guidehermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4; ambosnativegoalsACTIVE, Root único integrador/executor/reservas, monitor único planwriter. Backup1697linhas/prefixo preservado/diff/receipt em monitor/plan-cpu-audio-running-20261015T0405/; sem fonte/testes/commit/push/novaPR/submissão/interrupt.


### 30.18 Recuperação da coordenação e diagnóstico UI V601 encerrado como FALHA — 2026-10-15 14:17 UTC

**Estado atual deste checkpoint; histórico30.15–30.17 preservado.** O relay original voltou a responder às14:04:48.621902UTC sob runtime de controle b026a9c4-d059-4de4-be65-4dbfed6729cc; o runtime anterior5168da61-e878-402a-92a3-5ea447243a89 esteve indisponível nas observações registradas. Isso não significou término/cancelamento de sessões. Read-only SHOW e mailbox confirmaram MESMOS Run/Dispatch/terminais/incarnações: Rootfe7e63c7-d260-465f-b37e-f6fc78f8a1af, monitor37e50d9c-6cf5-4e28-a63b-f2bc3eed5661 e desktop pessoal9a6a4e5a-d9db-4d83-ae31-907ff2149dd1 (este confirmado por Root). Não houve adoção, novoRoot/worker/Run/conta/acesso/interrupt. Root confirmou nativeget_goal ACTIVE/unbudgeted/full13 em msg_77dae0f4f506 às14:10:35Z; monitor segue ACTIVE. Delivery antigo4a87006f6473 e mensagens atuais foram integralmente lidos/ACK; heartbeats originais voltaram a ser aceitos. Falha de escalação13:20 sem deliveryID continua histórica, nunca convertida em entrega. Root reconheceu o nudge de recuperação e obteve UMA nova leitura suportada; operações antigas7fa4acf2-8f1b-4899-b79f-03d1e8c22eb0 ead7c5b93-f364-4916-a859-0ca8c4082e30 com operation_unknown NÃO foram reenviadas.

**Primário V601 recuperado e lido uma vez:** /home/developer/projects/aurora/.git/aurora-handoff-import-20261006/desktop-trace-post-recovery-v631.json,5173bytes/SHA256 **4c334393a6cf1fac14bad11397e57894a01fcb491dda46847f962bda051e7d83**; Root msg_603ce9480605 às14:15:34Z. É receipt read-only do runtime pessoal existente /home/developer/projects/aurora/.git/aurora-handoff-import-20261006/product-voice-runtime-v601, host personal.skyron-server, não novo caso. Monitor verificou bytes/hash e conteúdo dessa cópia acessível; não executou coleta remota independente. terminal.json original SHA7a476bca6372b11c72968d89ccf826d96e2b2312f018ac8aaf726b0902dc4d2a: início11:52:08.581069Z, término11:55:57.087074Z,228.506143475s; readiness11:52:20.973809Z. É diagnóstico **NÃO MEDIDO/FAILED**, não condição900, percentil ou PASS de superfície.

Resultado real: failed_wait_for_assistant_reply/flow_deadline_exceeded. Conexão/Login/Assistant/consentimento normais e controle Stop-listening foram atingidos; apareceu uma linha de usuário93caracteres/SHA6df0d97b27425d11640980de6fe5c6ddb06f454a370b4c666b88199c36a619ed que NÃO correspondeu à pergunta congelada. Esse texto visível não prova retorno STT efetivo correto, input microfone capturado ou seleção correta da mensagem nova pelo driver. Nenhuma resposta Assistant verificada (status absent/0caracteres); TTS/áudio de saída, stage telemetry, playback/microfone físico e fluxo áudio→áudio desta superfície continuam NÃO ACEITOS. Mesmo inputWAV153644bytes/SHA139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3, sem autorização implícita para mudar tarefa/modelo/critério ou reutilizar headlessPASS como UI.

**UNKNOWN preservado:** microphoneObservation=NULL porque inspeção final expirou; checks.microphoneCalled=false é campo antigo/não confirmação de zero chamadas getUserMedia. V597 zeroGUM é observação histórica distinta. Passive Profiler iniciou, mas cdp_timeout/selectedScriptCount0/examinedSourceBytes0/selectedCoverageBytes2; nenhuma cobertura de branch ou causa de produto/modelo foi estabelecida.24badResponses/11requestFailures não demonstram causalidade/auth/model-quality por contagem. cleanup.contextClosed=false/profileRemoved=false/failureClassTimeoutError permanecem como falhas de cleanup do driver; não declarar perfil removido nem apagar artefactos automaticamente. Exitcodes dos filhos130/-15/-2 refletem o encerramento pelo controller no caso histórico; a leitura pós-recuperação não matou processos e não prova shutdown normal de cada filho.

**Retirada agora PROVADA no receipt Root às14:12:37.633823UTC:** controller3037101/web3037121/backend3037122/driver3037182 todos ausentes; /tmp/aurora-global-build.lock e /tmp/aurora-desktop-gpu-baseline.lock livres; retainedDBSHA911f10f5808a312ad7712daefab7b47a404966ae58a14c7e95090408fc40d52e igual ao preimage. RAMdisponível2863226880bytes/rootFree167743488bytes/shmFree560443392bytes nesse instante, não admissão futura. Resolve UNKNOWN de término/retirada deV601, sem preencher aceite funcional ou liberar novo caso por monitor. Root permanece único dono da próxima reserva/admissão/executable; nenhum novo teste/modelcase foi lançado por este receipt.

Para não deixar30.17 como estado corrente: GPUheadlessLocalV485 foi concluído/selado900medidos+15warmups,878corretos/22incorretos estritos/0executionfail/0timeout, p90Type7ALL90011970.216910ms/p9512421.6015565ms; evidência legível root/desktop-gpu-full-audio-local900-v485/REPORT.md e verification-v522.json sob docs/experiments/tcc-20261013-submission-20261030/. GPUheadlessHTTPV497 também concluído/selado900+15,853corretos/47incorretos estritos/0executionfail/0timeout, p90Type7ALL90011637.4428838ms/p9512029.8744915ms; root/desktop-gpu-full-audio-http900-v497/REPORT.md, verification-v563.json e EVIDENCE-LOCATION.json. Ambas condições tiveram saída terminal com incorreções; respostas longas em vez de sóParis continuam falha, critério não foi relaxado. RawZIP íntegros permanecem nos locais pessoais exatos declarados nos respectivos EVIDENCE-LOCATION; monitor não repetiu ZIPaudit, inferência,900ou revisão desses selos fechados. Não juntar percentisCPU/GPU/rotas nem chamar diferença de overhead puro/efeito causalHTTP; fila/TTFT/firstaudio/playback não medidos permanecemNULL.

CPU491 segue MESMO cohort/manifesto/processos2232517/2232566,15warmups excluídos e900planejados, sem extensão/settingschange/restart/expansão de campanha anterior. Observação direta de monitor14:15:42.272046UTC: **814/900medidos/86unattempted**, ambosprocessos originais vivos, RAM4937379840bytes/freevolume10304507904bytes. É contagem de tentativas medidas, não814sucessos nem selo/p90/p95; este número é snapshot datado, futuras contagens pertencem aos receipts. Outer20:04:53.523642Z de30.17 mantido. CollectorCPU V607 está SOURCE-CLOSED/Solfix-only02994ed9 e NÃO executado; Root coleta somente após término natural+prova de retirada/PIDs/locks/storage. Nenhuma ação de monitor interfere no frozenrun.

**Próximo gate finito concreto, sem escada de retries:** Root reutiliza o MESMO helperLuna já existente para até180s READ-ONLY da página de falha redigida e da seleção exata de nova mensagem/driver/UI; nenhum novo worker, teste/build/model/source edit durante esse diagnóstico. Distinguir texto anterior/placeholder/predicado errado de STT real, sem afirmar causa antes da evidência. Um eventual conserto/novo piloto exige delta sustentado, fontes/manifesto/input/modelos efetivos/caps/admissãoRoot; preservarV601 e todos os anteriores e não repetir loops idênticos, revisões fechadas ou matrizes extras. Qualidade de modelo continua engenharia autônoma sob30.15 quando demonstrada; este timeout de harness/UI NÃO demonstra essa causa e não exige owner escolher fixture/modelo.

Checklist atualizado: [x] mesmas identidades/Run e nativegoalsACTIVE recuperados; [x] RootACK de recuperação; [x] dois selos headlessGPU900 com denominadores/falhas preservados; [x] resultadoV601FAILED e retirada documentados; [ ] CPU900terminal/raw/quantis/seal; [ ] UI/microfone/áudio final/playback/telemetria e demais superfícies individuais não-iOS aceitas; [ ] transiçãoRoot; [ ] matriz real completa. **requiredIndividualAudioAndSurfaceSealsComplete=false; wholeGpuAcceptance=false; phase2MeasuredAllowed=false; full13Complete=false.** Mesmo após CPU900, dois selos headless não bastam para liberar tráfego medido cross-device. BR/PT/US/Android elegíveis, native/local/desktop/browser/mobile e localPython/HTTPAPIreal/P2P cumulativoTTS-only→TTS+LLM→TTS+LLM+STT,900porNOVAcondiçãoaplicável/warmupsextras/recursos/corretude/telemetria/rotas/concurrency/recovery/privacy/feasibility permanecem obrigatórios. iOS fora do denominador ativo; sem networkscope/driver/security/provider/credenciais/corporativo novos.

Linhas anteriores permanecem byte-exatas e com datas; esta seção atualiza seus estados PENDING sem apagar história nem alterar critérios/metodologia congelada. Backup integral/diff reversível/receipt/sourcecheck em /home/developer/projects/aurora/.omx/evidence/orca-monitor-20261010/plan-v601-closeout-20261015T1417/. Relatório de incidente/recuperação: .omx/evidence/orca-monitor-20261010/orca-disconnect-20261015T1320.md; fleet completa14:07:25 em fleet-20261015T1407.json no mesmo diretório. Sem mudança de produto/AGENTS/goals.json/ledger/branch/index/commit/push/PR/submissão por monitor; Root único integrador/executor/reservas e monitor único planwriter sob Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/guidehermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4.


### 30.19 CPU original: 900 corretos, selo fechado; correção Android e barreira restante — 2026-10-15 15:33 UTC

**Atualização factual dos checkpoints datados anteriores, sem apagar sua história.** Root confirmou término natural CPU V491 em msg_9b70b5f83a5a (15:27:25Z) e fechamento do selo em msg_d43c738b55ce (15:29:41Z). O cohort continua aurora-full-audio-capital-v1-worker-cpu-local-20261015, família original de30.16–30.17, como comparação EXTRA CPU separada do desktop GPU: **900/900 medidas estritamente corretas; 0 incorretas, falhas, timeouts ou não tentadas; 15 warmups adicionais corretos, excluídos dos percentis**. Não houve alteração do áudio, modelos, critérios, settings, contagem ou fonte congelada durante a campanha.

Execução registrada: 2026-10-15T04:00:53.581864Z→15:21:29.783085Z, saída natural0. Root comprovou os PIDs originais2232517/2232566 ausentes e o lock local global-build disponível/liberado às15:22:40.833212Z, sem matar processos; storage livre10.260.238.336bytes. Receipt de retirada informado por Root: SHA764f249bf13d4006ee01b6ed1b2125f05a65c9a155ac29e3343729fab27c065b. Isso libera os recursos desta campanha no coding-worker, NÃO a reserva pessoal V641 nem o gate de todas as superfícies.

**Evidência acessível:** /home/developer/projects/aurora/docs/experiments/tcc-20261013-submission-20261030/root/worker-cpu-full-audio-local900-v491/ contém REPORT.md (4387bytes/SHA d71932dbb8a6d75c23836a73ef7c235110bb107b82e35dc70a0a3369911f7300), verification-v652.json (5082bytes/SHA ec94a94cfe8e7ee4de65a59cfe7990fd02eac94c33c91370c17d5da7ffb77478) e aurora-worker-cpu-full-audio-local900-v491.zip (33.027.484bytes/1865membros incluindo manifesto/SHA83b9084a09abfe641968b2958e210ed589dbcd655f0a9a26c18f2bc4dd80d897). Manifesto do arquivo SHA cfcec63729d52a8c59a03efdae52a1ea7cee8bdb9403e662dcac8295f8ea9165; freeze CPU364832a627e2f45b4b1c2b80ca05739f809132a28ff26511f0eda5e30f89127a e WAV139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3 preservados.

Root executou o collector aprovado UMA vez e UMA reconciliação salva de ZIP/membros/raw/outcomes/915referências de áudio/Type7, sem repetir decode/inferência/campanha. Todas915referências de saída conferem bytes/hashes; o próprio runner original validou áudio decodificado/não silencioso. Oito omissões privadas têm path/motivo/tamanho/hash; pesos são referenciados, não recopiados. SourceHashValidation=collector_only permanece explícito. O monitor leu apenas REPORT e recibo JSON uma vez, verificou seus hashes e NÃO repetiu ZIPaudit/rawscan/teste. Sol fez somente consistência numérica/proveniência de REPORT/CURRENT, APPROVE b13c82a87099142d66aeed78c4a8d0ed94057cd4874756d1446c6fe16e618117; selo/review fechados, sem novos ciclos.

| Limite medido, mesma condição CPU | n medido | p90 Type7 (ms) | p95 Type7 (ms) |
| --- | ---: | ---: | ---: |
| Fluxo completo até áudio validado | 900 | 49936.7875221 | 52595.9486264 |
| Caller STT | 900 | 10630.5304123 | 11274.44997995 |
| Caller Assistant | 900 | 37560.8704425 | 40089.5693048 |
| Caller TTS | 900 | 3928.0318947 | 4677.26998075 |

Type7 interpola os valores ordenados na posição zero-based (n−1)×p. Denominadores all-flow e correct-only são900; warmups não entram. Os três estágios têm900registros correlacionados cada. Quantis de etapas são independentes, NÃO somáveis. Este limite é arquivo disponível→STT real→LLM real→TTS real→WAV validado; não inclui captura física/EOS do sensor, UI, speaker playback ou audibilidade. Queue/TTFT/first-stream-audio/playback permanecem NULL+motivo; p50/p99 integrais não são projetados por este recibo, não são zero nem números inferidos. Duracões por caso estão retidas para a análise reprodutível exigida antes de reivindicar métricas adicionais. Manifesto/readiness/harnessV490 são históricos e não substituem o binding real V491; o log CPU projetado no terminal é vazio e não prova backend novo.

CPU ARM64/two logical CPUs/2threads/LLMoffload0/WhisperbaseCPU int8_float32/beam5/VAD/PiperCPU permanecem distintos do desktop Vulkan LLM25layers. Comparar descritivamente cohort/settings/hardware declarados; não juntar amostras/percentis CPU-GPU/rotas nem chamar diferenças de overhead puro de protocolo ou efeito causal isolado da GPU. O resultado aceita somente este headless original; o novo áudio acolchoado e as superfícies produto não ganham aceite por herança.

**CORREÇÃO de proveniência Android:** referências históricas que atribuíam a tela preta a “V448 Android” devem ser lidas com esta correção: o screenshot Waydroid retido é V445; o inspector WebView falho é V446; web-product-build-v448 é build web/desktop, NÃO primário Android. Fonte fechada /home/developer/projects/aurora/.git/aurora-handoff-import-20261006/android-v448-mainflow-triage-v646/REPORT.md (2955bytes/SHA8c753980a0587d9aaa58450df52505b46c9a64a8e189f2ac68efa7bbbef5de85), integralmente lida pelo monitor. O nome legado da pasta não muda a classificação dos artefatos. ScreenshotV445 SHAa6b821d79535ded5d93a2ca6aec30fe27fa6be35970668316d3890562d9df41d mostra conteúdo preto; inspectorV446 SHA295e7247272b7751d488bc6d37eb2b53da4aaa0b2eddc0230a1934d546933ce3 expirou antes de DOM/resourceTree/exceções, com zero eventos capturados. Isso NÃO prova erro de asset/React ou ausência de eventos reais. Source-mapSHA41310a3de6407a24d96a42acbfe216394c78cda7086531f153eb9f55f4e12103 não correlaciona erro nativo de profile refresh ao caller/tela. **Causa UNKNOWN, nenhum patch de produto sustentado**; próxima observação útil é snapshot limitado do mesmo cold launch com readyState/root/resources/exceções. Nada de novo teste/build/ADB/device/source foi executado por essa revisão. Rejeição real “Unknown command: adb use” é mismatch da superfície CLI, NÃO prova de emulador ausente. Android continua gate independente e não é pré-requisito causal para esta pipeline headless já concluída; Waydroid não prova bateria/radio/thermal/Doze/mic físico.

**Estado restante da UI:** V635 falhou strict transcript com GUM confirmado; V638 falhou startup antes de qualquer TranscriptionPOST/STT, sem avaliar o candidato. V641 realmente iniciou14:54:55.885521Z/controller3073968, mesmo candidato da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb, mas resultado/PIDs-filhos/retirada seguem UNKNOWN. Tool primário file-open d9fe8628-4c71-4ace-9399-eb9eedb14e2e relata conexão SSH original caída e exige Reconnect do target existente; o método GUI computer.listWindows é forbidden à CLI em hostSSH (78c2b6a0-73dd-45db-9581-e4b5dc026211). Relay/app disponível e metadata writable NÃO provam target/conclusão. Root reconheceu evidência, fechou probes e pediu ao owner somente Reconnect original, sem escolha de modelo/acesso/segurança nova. Reserva pessoal desktop/GPU/Waydroid retida até prova real; nada de replay da operação97c755f8-3935-4104-b63a-c2afcfd1fe3b/operation_unknown, novoRoot/worker/rota/conta ou interrupção. Detalhes em .omx/evidence/orca-monitor-20261010/v641-ssh-target-disconnect-20261015T1507.md. Candidato acolchoado continua NÃO QUALIFICADO; nenhum freeze/registry de comparação novo inventado. Ao passar efetivamente, aplicar30.15: novo manifesto e mapa das células afetadas/replacement links, preservando este CPU e os controles anteriores no escopo correto, sem pooling ou rerun de células não afetadas.

Checklist: [x] CPU original900+15 concluído/retirado/selado com raw, denominadores e p90/p95; [x] GPU headless local/API selados com incorreções preservadas; [x] correção documental Android sustentada; [ ] V641 resultado/retirada via conexão original; [ ] áudio/UI/mic/playback/telemetria e TODAS as superfícies individuais não-iOS exigidas; [ ] transição Root; [ ] matriz real entre dispositivos/superfícies. **requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false.** Root reportou nativegoalACTIVE/unbudgeted e ledgerV654 aceito,13metas com1complete/1in_progress/11pending; monitor NÃO escreve goals.json/ledger nem rebaixa escopo. Gate de900POR CADA NOVA condição aplicável/localPython/HTTPAPIreal/P2P cumulativo TTS-only→TTS+LLM→TTS+LLM+STT, BR/PT/US/Android reais/capacidades verificadas, failures/timeouts, clock-safe stage/provider/resource/ICE/load/recovery/privacy/feasibility e ausência de iOS ativo permanecem intactos.

Backup integral/diff/recibos e cópias exatas das três fontes em /home/developer/projects/aurora/.omx/evidence/orca-monitor-20261010/plan-cpu-audio-sealed-20261015T1533/. Prefixo1743linhas preservado; esta é atualização do plano completo, não substituição abreviada. Root único integrador/executor/reservas; monitor único planwriter, mesmos Runrun_e6054e76e9fc/Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/guidehermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4. Root relatou docscheckexit2/1031findings (1030existentes+1JSON requerido),30links própriosPASS; não há PASS global ou checker enfraquecido, e o monitor não repetiu a checagem. Sem fonte de produto, Git/index/commit/push/PR/submissão, testes ou execução por monitor.

## 30.20 Correção de recuperação: desktop alcançável, terminal de controle novo e V641 ainda por reconciliar (2026-10-15)

**Autoridade e mudança material:** o proprietário corrigiu explicitamente o diagnóstico de recuperação. O desktop está alcançável pela MESMA bridge Orca do worker; o estado desconectado do terminal retirado não estabelece indisponibilidade atual do host. O diagnóstico anterior de que Reconnect era o bloqueio atual está SUPERSEDED por esta evidência. Os relatos datados de bloqueio nativo V667 e os recibos anteriores são preservados como história; não devem ser repetidos como condição atual. Esta correção operacional não substitui resultados/coortes experimentais nem autoriza descartá-los.

**Controle atual verificado independentemente pelo monitor:** terminal PLAIN `term_00a86bfb-1ede-4fbf-8b5e-72e2a2629f62`, incarnation `9d7a67b9-7786-4073-8c58-b9c260aa643f`, host `ssh:ssh-1786238480967-semdev`, workspace desktop existente `ce8df754-5c48-4296-83bd-452a5b99942f::/home/developer/projects/aurora`. SHOW `22c86fc1-2b2f-4599-95fe-4a17cb0037ac` devolveu connected=true/writable=true, mesmo path e branch de receiver `refs/heads/main`; isto não muda a branch canónica do worker nem substitui o mapa de fontes congeladas. READ `8d829754-174a-483f-8717-6e69e16ee4ea` leu a prova existente `ORCA_DESKTOP_CONTROL_OK`, `personal.skyron-server`, `/home/developer/projects/aurora`. O monitor não enviou comandos a esse shell. É controle shell aprovado, não novo agente/Root/monitor ou transferência de ownership.

**Causa e reparação reportadas pelo proprietário, com atribuição:** um Python morto por OOM levou `ssh-rescue-persistent.service`, então com `OOMPolicy=stop`, a matar o cgroup inteiro e reiniciar às15:35:43UTC. A política agora é persistentemente `OOMPolicy=continue`; o proprietário informa PID SSH inalterado nessa reparação, sem reinício de serviço/agente ou mudança de permissões. O monitor não executou nem verificou de novo a configuração systemd/journal: este detalhe de causa/política vem da correção direta do proprietário; Root recebeu a evidência completa e é único integrador da reconciliação. A causa da perda do terminal não prova por si só o resultado/causa do piloto V641; horários, resultado e spans do piloto precisam de correlação própria. Nada de novo ajuste de serviço, credencial, driver, conta, segurança ou permissão por esta atualização.

**Próxima ação concreta e finita:** Root consome a correção e verifica seu estado nativo real; se necessário, coordena UM `/goal resume` suportado no MESMO goal original, com um único remetente, request/incarnation e prova fresca de get_goal. O monitor também mantém seu goal original e verifica a retomada real, sem criar outro goal/worker ou duplicar comandos. Aceitação de input não equivale a estado nativo retomado. O audit de bloqueio anterior não é transportado para esta condição materialmente alterada. Não repetir o terminal retirado como teste de reachability ou probes GUI negados.

**V641 é a primeira reconciliação, antes de qualquer rerun:** resultado e retirada continuam NÃO VERIFICADOS nesta atualização. O proprietário confirma arquivos originais presentes; Root deve recuperar os arquivos existentes, manifesto exato, resultado/terminal, PIDs/filhos e estado de locks/reservas e conferir persistência/efeitos da tentativa. Manter reserva desktop/GPU/Waydroid até prova efetiva, sem assumir que OOM, deadline, silêncio ou perda da sessão provam conclusão/retirada do piloto. Não reenviar operação ambígua, recriar a tentativa, alterar áudio/modelo/predicado ou admitir outra medição antes desta reconciliação. Root sozinho controla esse shell, a execução, o lock global e a admissão posterior; o monitor acompanha recibos e escreve o plano.

**Coortes e escopo preservados:** CPU V491 original900+15, GPU headless local V485 e HTTP V497 permanecem selados nos seus modelos/áudio/settings originais, com falhas estritas e raw intactos. O candidato UI acolchoado da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb e manifesto candidato4284c4904d17f5411a6b9cf8bcc68e4dcfb5ac00b94fac6ec87ab67792452f06 continuam NÃO QUALIFICADOS até resultado real/telemetria; não há novo freeze ou replacement inventado. Registrar política OOM/estado de memória e demais diferenças ambientais em readiness/manifesto posterior. Se áudio/modelo/settings efetivos mudarem, seguir30.15: nova coorte qualificada, hashes exatos e replacement links apenas das células afetadas; preservar toda evidência anterior. A política de persistência não rebatiza comparações antigas nem cria um speedup.

Checklist atual: [x] controle shell desktop alcançável pela bridge existente verificado; [x] diagnóstico atual baseado no terminal retirado corrigido; [ ] Root e monitor get_goal retomados realmente se ainda necessário; [ ] resultado/retirada V641 e mapa de artefatos existentes reconciliados; [ ] áudio/UI/mic/playback/telemetria e todas as superfícies individuais não-iOS aceites/seladas; [ ] transição Root; [ ] matriz real entre dispositivos/superfícies. `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Continuam900 MEDIDAS POR CADA nova condição aplicável, aquecimentos adicionais excluídos, p90/p95 e denominadores/falhas/timeouts, Python local/HTTP real/P2P cumulativo TTS-only→TTS+LLM→TTS+LLM+STT, mesmo pipeline completo, dispositivos/países/rotas verificados, clock-safe stage/provider/resource/ICE/load/recovery/privacy/feasibility e nenhum iOS ativo. A autorização de testes permanece; a reconciliação é dependência técnica, não pedido de nova permissão.

Backup completo1773linhas, versão atual, diff reversível e recibos de controle em `/home/developer/projects/aurora/.omx/evidence/orca-monitor-20261010/plan-fresh-desktop-control-20261015T1718/`. Todo o prefixo anterior é preservado byte a byte. Mesmos Run`run_e6054e76e9fc`/Task`task_d7ea336050cf`/Dispatch`ctx_37b4d0a3c14f`/guide`hermes:42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4`, Root único integrador e monitor único planwriter. Nenhum source/Git/index/commit/push, teste/build/benchmark, novo agente, alteração canónica da tese ou submissão pelo monitor. A revisão Markdown entregue no Telegram128 conserva seus bytes como snapshot anterior; esta correção tem recibo próprio e não é reenvio da revisão.

## 30.21 V641 retirado incompleto; V675 concluiu áudio completo no browser e foi retirado; medições900 e demais superfícies pendentes (2026-10-15)

**Retomada e plano efetivos:** Root confirmou get_goal ACTIVE no goal original `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`, full13/unbudgeted, snapshotV675; o monitor verificou seu get_goal ACTIVE original `01a123ff-19ba-7332-a2f7-346a722af79f`. Um único resume por goal nesta recuperação: Root recebeu request`c1c5c7b7-0817-4f8a-9170-ecf68b803343` e enviou ao monitor request`334122f2-b2bd-4d0b-adfa-0b701554c00b`; nenhum outro input é necessário. Root deu full-read ACK real da seção30.20,1791linhas/SHA3f8af7ce10df44f7c49073b37341006dfed3166ec58dc8ae8670a88bb0472f11, prefixo271465bytes e diffae5f657c1a727df08234dfa1b4691adfe1ace7aee7f97b3ea94d28a6ccaac887, resposta`msg_1b69a31bfcf8`. Não é aceitação apenas de guidance.

**V641 agora reconciliado e retirado por Root:** o manifesto original exato154763bytes/SHA4ea13d6065fa6a15d9d1e0439aa2a66896e0bd59dbaad6d833f2a0a591d8f6b9 foi recuperado; a observação registra transcrição integral correta da pergunta congelada, linha de utilizador no DB e início de span LLM sem fim, sem resposta do Assistant/TTS/saída/final voice-flow JSON. O último checkpoint preservado é14:55:53.049Z; captura181120bytes PCMmono16000 SHAfbac381f4e58d40f045638ff5b700b562f170dc0fbbfe8b4c26ec5018744ad4f, um GUM bem-sucedido e fases AudioContext/worklet resolvidas. Isso é entrada pré-gravada pelo fluxo do browser, não prova de microfone físico ou pipeline completo bem-sucedido, nem diagnóstico de baixa qualidade do modelo.

Retirement suplementar real em`personal.skyron-server` às17:28:17.594940UTC, path desktop `.git/aurora-handoff-import-20261006/product-voice-runtime-v641/retirement-after-recovery-v674.json`,1211bytes/SHAe376657f622efe46d3c26c6f1d141c342a6dc8983b93514ecb473948e3e0914a. Recibo worker `.git/aurora-handoff-import-20261006/v674-v641-retirement-RESULT.json`,1241bytes/SHA47877049f37a52fc945c61884c7cf00f3a0f3ca636117b8199d13b837562d60a. Outcome=`incomplete_interrupted_no_final_result`, acceptedFullVoiceFlow=false; originalExitCode=null/originalExitTime=null, sem inventar falha/timeout/exit a partir de deadline ou OOM. PIDs3073968/3073988/3073989/3074063 ausentes, nenhum processo correspondente e locks `/tmp/aurora-global-build.lock` e `/tmp/aurora-desktop-gpu-baseline.lock` livres. DB retido permanece SHA911f10f5808a312ad7712daefab7b47a404966ae58a14c7e95090408fc40d52e. Root não matou processos, não sobrescreveu evidência nem alterou serviço/acesso. Reserva V641 encerrada pelo único dono Root; somente Root admite/reserva a próxima execução. A tentativa não produz amostras medidas aceites ou freeze comparativo novo.

**Disponibilidade e mudança de runtime:** o controle segue no PLAIN shell`term_00a86bfb-1ede-4fbf-8b5e-72e2a2629f62`, incarnation`9d7a67b9-7786-4073-8c58-b9c260aa643f`, workspacece8df754-5c48-4296-83bd-452a5b99942f::/home/developer/projects/aurora. Após `_meta.runtimeId` mudar para`a3460407-e6ff-44ef-ad18-b919a19551ce`, o monitor revalidou os mesmos Root/controle e incarnations; Root enviou/leu a admissão read-only real às17:35:03.901156Z. Cursor antigo747 devolveu vazio e foi recuperado relendo o MESMO resultado a partir de0, sem reenviar comando; vazio não é host indisponível, saída ou necessidade de resume. O terminal antigo retirado não voltou a ser usado. Fonte Root`msg_4667e51d3497`/`msg_cda081a6cf08` e`v675-desktop-admission-RESULT.json`.

**Recursos e limites declarados em BYTES DECIMAIS:** na admissão observada17:35:03, RAM disponível12624863232B, projeto livre137388032B e shm livre3044438016B; GPU AMDdevice0x7480 com VRAM total8573157376B/usada48050176B e2%busy, ambos locks livres. Isto confirma inventário/folga observada, não offload real durante inferência nova. Root confirmou`msg_a9803f74bd88`: orçamento de crescimento do novo case32000000B + reserva100000000B =132000000B mínimos no projeto ANTES de escrever o case; contador tem de ser fresco e campos explícitos no recibo, sem interpretar MB como MiB. Supervisor tem admissão independente130000000B, reserva viva100000000B e cap de crescimento32000000B. RAM inicial2800000000B/floor runtime2000000000B; shm inicial500000000B/reserva runtime100000000B, com profile/temp novos emshm. Esses são limites de UM PILOTO, não autorização para reduzir ou encerrar as900requisições por condição do estudo. Guardas/falhas devem manter razões e denominadores, sem forçar OOM, matar workloads alheios ou fazer cleanup amplo. Novos cohorts900 precisam de orçamento próprio derivado de pilotos e manifesto reproduzível; esta admissão não o substitui.

**V675 efetivamente lançado, concluído e retirado:** a fotografia anterior desta própria seção, ainda não entregue para ACK Root, dizia NOT_LAUNCHED até17:40:12 e está preservada byte a byte em`initial-unsubmitted-plan.after.md` SHA3dd455f9fd8e53a55adc570199e0089e4466c05544da30e71258160b5a58e4d0. Ela foi superada pelo lançamento real17:41:21.871975Z, controller3100740, recibo worker`v675-ui-full-audio-actual-launch-small-RESULT.json`1248bytes/SHA0a9ba3fc0789358666e18f870b58844106e8308a2a80b9918792f1179885e636. Antes do case Root observou projeto137302016B>=132000000B, RAM12643102720B/shm3044438016B/VRAMtotal8573157376B/usada27262976B. A correção de driver mudou SOMENTE o namespace641→675, SHA9f9d51cdf0fe36212ae3863661f3c42496b6e41219bc1c46cddd15e1dfbb49b3; original preservado, única revisão SolAPP46ab306d686a5b14923d1c4a32ec64d05f3dcb2e155327e75bf64b67b10d49c3. Não houve alteração de áudio/modelo/predicado nem novo build. Manifesto de admissão3047B/SHAdb6f0b1747d07b064850ea38c76a93c9815181cb26459dc92f2e52abf29efabb, supervisor13e4251d8eb4734947f09f8abea4ef2e6fe5c75ce64c44ac8bf272e794830171, bootstrap0cdc6afa0c1f2888ba3431eb9ad31cac84d4d8b577cd2a5b5164e857f8d0d893. Limites main180s/driver190s/outer420s e guardas declarados acima efetivamente mantidos. A falha ARG_MAX ocorreu antes de qualquer SEND Orca; o payload aceito não foi reenviado.

O resultado real`ui-case/voice-flow.json` terminou17:42:25.115Z, outcome=passed, TODOS16checks true; terminal17:42:27.708572Z com driverExitCode0. Houve normal connection/login/consent, UMA chamada getUserMedia bem-sucedida com áudio sintético pré-gravado, AudioContext/worklet efetivos, UMA requisição STT com191360B PCMmono16000 SHA73ae5df883f48c6589f3cf0cc6bf7fbd1f0af9aae8bbf7d29a498710727c45ed, transcrição integral62caracteres SHA34b681e385feb3500c9e9849d30f5bac982716c4e4938cdb04c5fdc617cff624, resposta visível estrita Paris/5caracteres e UM TTS real correspondente com WAVválido31788B/SHA2a84df0b3e9a7d0c463789c9d2b082a46a1f6734c89f017c2065fe82b043ce5d. Eventos do elemento media_playing e media_ended foram observados; contexto e profile foram limpos. O fluxo NORMAL inclui ação Read aloud DEPOIS da STT e LLM reais, portanto não é simples reprodução de resposta pré-injetada; tampouco prova resposta falada automática sem essa ação. Este piloto prova somente fluxo browser completo nessas condições; não prova microfone físico, reprodução acústica ou aceite Tauri/Android. Há23eventos correlacionados de estágios preservados; campos ausentes, incluindo request_id/trace_id em alguns eventos, continuam desconhecidos e não viram correlação global ou zero. Instrumentação necessária para a campanha deve ser auditada antes de novo cohort900, sem repetir o piloto funcional aprovado como enchimento. elapsedSeconds65.10181326698512 mede o supervisor/harness, NÃO latência pura áudio→áudio nem p90/p95. measuredRequests=0; esta foi UMA prontidão, não900 amostras, estimativa de quantis ou aceite de todas as superfícies.

Fonte selecionada já coletada por Root`v676-ui-full-audio-progress-3-RESULT.json`9003B/SHA814f8343126f4fee3caca0148ea1421a79395fcc92ffff8f538bc5a52c9902ed. Coleta única`v676-retire-freeze-v675-RESULT.json`66866B/SHAabfcf45174c6530bbd706ed93826894d0838695e2b9f47855a84778a621288b5 preserva manifesto completo155436B/SHA35d56a4e833d8d385b0a20252c45b983a8d03bfbe8cbafcefa854e8b5f4b226f, raw23eventos18651B/SHAd32879097ebe3645f5f928a32901d19744ec0bafd340787e260d43c8eeeb3feb e logs/recursos. Backend deste próprio piloto observou offloaded25/25layersVulkan0; hardwareAMD Ryzen53400G, AMDdevice0x7480/VRAM8573157376B. Isso confirma aceleração LLM efetiva neste caso, NÃO aceleração de todos os estágios STT/TTS, eficiência isolada da GPU ou equivalência com CPU. O log selecionado preserva também NativeContextUnavailableError no close; não foi apagado nem convertido em falha do pedido já concluído, e driverExitCode0 não significa que todos os processos auxiliares saíram com0. childExitCodes=[130,0,0] e demais limitações permanecem no terminal original.

Retirada efetiva Root17:43:47.523141Z, `retained-v675-qualified-v676/retirement.json`757B/SHAf42f356c184e765d51f9062ca2939d05f4d38bbc31562e88c37cb23e5f8e61f1: quatroPIDs3100740/3100760/3100761/3100939 ausentes, ambos locks observados livres/liberados, sem processos terminados pela retirada, DBoriginal911f10f5808a312ad7712daefab7b47a404966ae58a14c7e95090408fc40d52e inalterado. Terminal1625B/SHAd4efe15c7007e1c7342dc8f014862a8e051f29f058ab918266b6db2c056e46d8, voiceflow6001B/SHA096d142e087227f4c99762466b4e6a7e2c780e94455534ce11cedfa415bc1de0. Esses são recibos reais de conclusão/retirada, não inferência de silêncio ou deadline. Reserva V675 encerrada pelo Root. Luna existente empacota documentação/manifesto qualificado; a versão comparativa congelada e links de substituição das células afetadas ainda exigem recibo próprio. O manifesto do piloto acima não deve ser renomeado silenciosamente freeze900. Preservar V641 e todas as falhas anteriores, headlessCPU/GPU e controles typed; a adição de padding ao áudio muda cohort e impede pooling com os anteriores.

**Android segue dependência própria:** Root17:45:09 observou `orca adb use --help` desconhecido e lista adb local vazia no controle pessoal; isso é incompatibilidade de superfície CLI/visibilidade, não prova de Waydroid inexistente. O monitor consultou UMA vez o schema real`orca agent-context --json`: operação suportada`orca emulator devices --json` lista dispositivos locais e Android aprovados em hostsSSH conectados; screenshot/ax/logcat/exec são operações documentadas para Root. O inventário read-only retornou exit0/oktrue/result[] request3ddfb5f0-29f0-494e-81c2-f2df8083c08d, runtimea346, stdoutSHA8058cf1742d853a496ced19046b3abfe6ca358b1c96fbb2464cd977fcd565572; não há alvo verificado nesse recibo. Root conserva operação/reserva exclusiva; monitor pediu metadata da rota ALREADY-APPROVED ao PersonalHermes existente, identidade468a0928-9867-4612-b5f2-e7631784582d revalidada, inputaccepted2fe92750-f8a0-4bfd-8543-3d3e739d3f43, NÃO resposta/rota aceita ainda. Sem attach/start/connect/grants, novos workers, security/access ou CompanyWork. A ausência de alvo verificável deve ficar explícita; Android UI não bloqueia campanhas independentes desktop/headless. Sem tráfego medido cross-device enquanto barreira global não concluída.

Checklist atualizado: [x] controle desktop disponível e mesmos goals efetivamente ACTIVE; [x] V641 reconciliado/retirado incompleto; [x] admissão finita/launch V675 reais; [x] uma prontidão browser full-audio com STT+LLM+TTS e software playback reais; [x] coleta única23estágios/manifests/logs e retirada V675; [ ] freeze comparativo qualificado novo e replacement links recebidos; [ ] instrumentação integral auditada para condições900 sem fabricar campos desconhecidos; [ ]900MEDIDAS POR CADA nova condição/superfície/pair/mode/stage-set aplicável, warmups extras/quantisType7p90p95/denominadores; [ ] Android Waydroid rota/alvo aprovado e mainflow; [ ] Tauri e demais superfícies individuais aplicáveis aceites/seladas; [ ] transição Root; [ ] matriz real entre dispositivos TTS-only→TTS+LLM→TTS+LLM+STT com os mesmos workloads/modelos/settings e recursos/caminhos efetivos. `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Não ampliar o CPUextra original nem misturar hardware/stages/áudio. Sem iOS ativo, inferência de região/telefone físico ou alegação de aceitação global a partir de um piloto.

As fontes primárias e versões completas antes/depois/diff/recibo desta atualização ficam em`/home/developer/projects/aurora/.omx/evidence/orca-monitor-20261010/plan-v641-retired-bounded-pilot-20261015T1741/`. Prefixo1791linhas/277997bytes preservado integralmente. Monitor continua único planwriter, Root único integrador/executor/reservas, mesmos Run`run_e6054e76e9fc`/Task`task_d7ea336050cf`/Dispatch`ctx_37b4d0a3c14f` e guidehermes42a80e3a07e6d612ba5a491a74f42ff98a0098e316694808df506ddf430cb7d4. Nenhum teste ou comando no desktop, mutaçãoSource/Git/serviço/acesso/modelo ou aplicação/submissão da tese pelo monitor. Case history bruta e receipts seguintes continuam nos docs Root; não repetir resultados/auditorias fechados para cada contador ou criar matriz estética extra.

## 30.22 Freeze qualificado V681 e recibo pessoal real; próxima campanha900 ainda em preparação (2026-10-15)

**ACK efetivo do plano anterior:** resposta à pergunta única`msg_46befdffac4b`, answer`msg_f9a8efb65b9f`, confirma delta30.21 integralmente lido, canonicalfeef4aa26ccc19bb548c25bc2104d1669296ce5d28db2b9d987f3e2a92f439c8/1817linhas, prefixo277997B e diffe56876e7c6e345ecfa05e8dcca9a5cbddcc0eb1375e695d5a51bdb12deeb2aa1 verificados diretamente por Root. Fonte`monitor-plan-section3021-root-read-v683.json`,308B/SHA9acbca71bf6a814065e1b00361bbedeb61473d71e8dd4944ef6e21262d95fa5f. Não é apenas input aceito ou orientação reconhecida. O prefixo desta nova adição preserva TODAS1817linhas/291179B anteriores.

**Freeze existente agora verificado:** `docs/experiments/tcc-20261013-submission-20261030/root/ui-full-audio-readiness-v675/qualified-manifest.json`,12832B/SHAb36d6585b8f7fb4b87b54dceda813eaa42b0bd03c62ee3209bed1e0755a26ae3, freezeVersion=`v681-exact-setup-and-raw-custody`, frozenAt17:54:32.575471Z. Status=`QUALIFIED_SINGLE_READINESS_ONLY`; cohortId=`v675-padded-input-ui-readiness`, UMA prontidão completa já aprovada, measuredRequests=0/warmupRequests=0/p90=null/p95=null. Filemanifest5dbf421e6572510ddb15c28899ebedb07b5e6be847f4c98098756c833ebae134 e report55cb15ddfb8d990e1a6983929ee77a08a88bb8b81c4dbfcd4a8458d9066c72af. Review de artefato única do Sol existenteAPPd7dcd2612f75c2cd6aad0341e13951c0010d8fd67dfc18ae3f9dd956562fb238; nenhuma segunda auditoria de raw/ZIP/piloto é necessária pelo monitor.

Recebimento PESSOAL real no MESMO`personal.skyron-server`: `v681-personal-qualified-manifest-RESULT.json`,398B/SHA9bfe7a520bbc0d8550d0c5c262b9b2eb746683cd14395ea8ce72e869f47cd4da, filesVerified=23 e mesmos hashes de manifesto/filemanifest/report, allOriginalCaseEvidencePreserved=true/noInferenceOrCaseRerun=true. Root reconciliou o SEND já aceito`531f02ac-c5fe-411b-b366-85da997bcced` a partir dos reads existentes451→468/markerAURORA_QUALIFIED_V681; não reenviou a publicação após timeout de observação. A falha local de quoting e a correção de somente seu próprio input de metadata ficaram preservadas; nenhum worker/campanha/sessão foi parado. Raw-pessoalV680 guarda17arquivos de áudio/PCM/saída/checkpoints/estágios/recursos/metadados e logs redigidos, sem inferência nova. Um timeout de coleta não é falha do pipeline ou autorização de replay.

**Setup efetivo congelado para as comparações afetadas:** áudio219794B/109875frames/22050Hz monoPCM16/4.982993197s SHAda0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb,1000ms de silêncio inicial e500ms final, sem loop; pergunta62caracteres SHA34b681e385feb3500c9e9849d30f5bac982716c4e4938cdb04c5fdc617cff624 e resposta estrita Paris, sem enfraquecer critério. STT=faster-whisperbase/ctranslate2CPU, requestedint8/actualint8_float32, beam5/VADtrue/languageunknown; model.bin145217532B/SHAd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9 e config/tokenizer/vocabulary exatos no manifesto. LLM=Qwen3.5-0.8B-Q4_0,563036064B/SHA57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf, ChatLlamaCpp/Vulkan25/25layers efetivos, ctx4096/max128/batch64/threads2/temp0/seed42/topK1/topP1/minP0/repeatPenalty1/chatml-function-calling. Piper en_US-ljspeech-mediumONNX63531379B/SHA6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22/CPUuseCudafalse, voiceconfigSHA141d612cc0a95ed7efc1ca936b845c2364967f2e9217c5dbfcf69fc4d6c65860. Sete assets conferidos com o freeze pai; versõesctranslate24.7.1/faster-whisper1.1.1/llama-cpp-python0.3.19/numpy2.2.6/onnxruntime1.20.1/piper-tts1.2.0. Hardware pessoalAMD Ryzen53400G/RX7600device0x7480/VRAM8573157376B; não é aceleração STT/TTS ou efeito GPU isolado.

O freeze registra `SUPERSEDED_FOR_NEW_PADDED_AUDIO_SETUP_ONLY` para antigas comparaçõesGPUheadlessV485/V497, com resultados/raw originais ainda válidos no áudio e escopo originais; replacement900-measured=PENDING. CPUV491 permanece `RETAINED_EXTRA_CPU_ORIGINAL_AUDIO_LIMITED_SCOPE`. Nunca alterar o cohortCPU concluído, substituir dados lentos/incorretos, chamar resultados antigos de nova amostra ou juntar percentis/setup/hardware. V641 permanece incompleto preservado. Aplicar o MESMO setup efetivo nas condições novas compatíveis e futuras superfícies/devices/modos/stage sets, com diferenças de aceleração declaradas; capacidade fraca mantém infeasible/unsupported/timeout com denominadores honestos, sem modelos menores silenciosos ou OOM forçado. Baseline local só pode ser reutilizada quando todos os campos de identidade experimental forem idênticos e a reutilização estiver mapeada.

**Instrumentação é o próximo gate concreto, antes de900:** oito pares de spans entre23eventos incluem TTSstartup; são durações descritivas em monotonic do mesmo backend, não soma e2e, clock global ou percentis. O manifesto admite STT/TTS request-sessionIDs nativos ausentes, ligaçãoN1 pela única requisição/hashes, providerArrayHash não capturado e `queueDelay/firstToken/firstStreamedAudio/physicalAudibility=null`. Nome astream não prova streaming nativo. Uma ligação de pedido único não satisfaz correlaçãoN>1. Root prepara IDs explícitos por case/attempt/operation, sem inventar IDs nativos; impedir mistura de completions tardias após timeout, preservar stage_provider_map efetivo, relógio/uncertainty/overlap e limites de cada superfície. Capturar fronteiras reais STT/LLM/TTS/arquivoáudio/playback onde o fluxo as expõe, resource rows e full e2e com setup-vs-warm separado. Queue/TTFT/firstaudio indisponíveis ficam NULL+motivo/capability, não0 ou alegação de cobertura. Instrumentação deve usar o fluxo real de cada modo, não injetar transcrição/resposta. Preparação privada Luna existente e uma revisão delta Sol, Root único executor; piloto funcional V675 aprovado fica fechado, sem repetições irrelevantes ou novas matrizes de edge cases.

**900 por condição, orçamento novo ainda PROVISÓRIO e não lançado:** Root informou preparação NOW de somente fontes parentHTTPcontroller/runner/observer/bindings versionadas e counters de armazenamento pelo controle pessoal existente. Declaração provisória180s/request,12600s/condição,900medidas+15warmups excluídos, baseada em pilotoheadlesscold13.5s retido, NÃO nos65.10s que incluem setupUI. O cap é limite finito de sessão, não estimativa garantida/critério para aceitar menos900 ou esconder timeout/falhas; validar adequação por superfície/condição e registrar final incompleto se o cap for atingido. O ponto de partida com padding e fronteirasUI pode diferir: não transferir throughput automaticamente nem somar stages sobrepostos. Toda condição nova aplicável mantém900medidas independentes, Type7p90/p95/denominadores completos, warmups extras, manifesto/source/app/model idênticos ou novo cohort explícito. orçamento de disco novo REQUIRED porque o projeto pessoal tinha aproximadamente134MB livres; cap32MB de UM PILOTO não é orçamento de900. Usar somente capacidade já aprovada e recursos reservados sem apagar evidência/modelos/inputs; falha real de armazenamento deve ser específica, não limpeza ampla/novo acesso. Preparação/budget não são launch; recibo futuro de admissão/execução e resultados ainda pendentes.

**Android separado e limite atual exato:** Root fez UMA screenshot read-only no alvo histórico aprovado192.168.240.112:5555, comando documentado`orca emulator screenshot --device 192.168.240.112:5555 --worktree id:ce8df754-5c48-4296-83bd-452a5b99942f::/home/developer/projects/aurora --json`, request7f30494b-4d79-44d7-a2ed-404ca133cea3/runtimea346. Exit1/emulator_error: Android SDK not found, com sugestão genérica de instalação/ANDROID_HOME. A ferramenta não confirmou owning-host efetivo e já havia SDK binário pessoal observado; portanto é falha de resolução/capacidade da ferramenta, NÃO prova de SDK ausente/dispositivo parado, nem autorização de instalação/config/segurança. Não executar nova escada de probes, conectar/grantar, reiniciar ou usar CompanyWork. Root preserva esse blocker específico da superfícieAndroid e avança desktop/headless independente. Waydroid não gera bateria/thermal/radio/mic físico e iOS continua fora do denominador.

Checklist: [x] plano30.21 Root ACK real; [x] V675 readiness encerrada/retirada; [x] freeze exato e receipt pessoal23arquivos; [x] antigas comparações afetadas marcadas com replacementpending/CPUextra retido; [ ] instrumentaçãoN>1/clock-safe/provider/resource e gaps explicitados; [ ] orçamento armazenamento/tempo/recursos admitido; [ ] launch real de nova condição900; [ ]900medidas e resultados/denominadores por condição aplicável; [ ] todas as superfícies individuais não-iOS/audio aceites e seladas, incluindo Android; [ ] transição Root explícita; [ ] toda matriz interdispositivos/rotas/superfícies real com localPython/HTTPgateway/TTS-only→TTS+LLM→TTS+LLM+STT. `phase2MeasuredAllowed=false; requiredIndividualAudioAndSurfaceSealsComplete=false; full13Complete=false`. Conclusão global não é provada por um freeze ou um piloto. Mesma linhagem Root/monitor/Run/Task/Dispatch; sem novo worker, stop/adoption, source/Git/service/security mutation ou aplicação/submissão de tese pelo monitor. Fonte/snapshot/diff e recibos desta adição: `/home/developer/projects/aurora/.omx/evidence/orca-monitor-20261010/qualified-audio-next-gate-20261015T1758/`.

## 30.23 Execução HTTP áudio900 realmente iniciada; gate de warmups e resultados ainda não aceites (2026-10-15)

**Lançamento real, não apenas preparação:** Root iniciou o controller PID3108591 em `personal.skyron-server` às **18:20:41.660560 UTC**. Cohort `aurora-padded-http900-v684`; conditionId `aurora-full-audio-capital-padded-v1-desktop-gpu-http-20261015`; rawRoot `/tmp/aurora-root-padded-http900-v684`. Recibo original `.git/aurora-handoff-import-20261006/v684-actual-launch-padded-http900-RESULT.json`, 771 bytes, SHA256 `ba5e7686dc2bc4146f01eb7db6af83437845389c5681037e52c3e607d548079e`, actualRuntimeLaunched=true. Mensagem Root `msg_348493a75fb3` às18:21:35 e ACK monitor `msg_0a61ff398322`. Manifesto congelado de147035 bytes, SHA256 `f1c270de7ef94b867f2f969f763b0c4c9a46a66f5329b8b3b011b7926f30c626`, ancorado no setup qualificado `b36d6585b8f7fb4b87b54dceda813eaa42b0bd03c62ee3209bed1e0755a26ae3`. Modelos, áudio padded, pergunta, predicado Paris e versões efetivas são os da seção30.22; não houve troca silenciosa de modelo ou relaxamento de correção. País físico não é inferido de alias/SSH; usar somente o inventário já verificado do plano.

**Escopo desta condição:** headless, mesmo desktop, sequência real de requisições HTTP com WAV de arquivo → STT → LLM → TTS → WAV válido. Não é o fluxo browser/getUserMedia/Read aloud/playback do piloto V675, não prova captura física, e não conta como API implantada entre dispositivos, P2P ou offload cumulativo. O requester e os provedores desta condição estão no mesmo host; a prova de placement de cada estágio deve vir dos registros efetivos, separando STT/TTS CPU e LLM Vulkan. O corpus, tarefas e parâmetros comparativos permanecem os mesmos. Não somar900 desta condição a outros modos/superfícies para satisfazer seus denominadores; não juntar a GPU original, CPU extra ou áudio anterior.

**Revisão fonte encerrada e versão exata:** arquivo `qualified-900-prep-v684/SOL-SOURCE-REVIEW.md`, 10210 bytes, SHA256 `5b102dd3c83e05dd293ad86fa20c2525ac4753c79b4d8265d05a8eab6e688d8a`, conclui APPROVE somente de fonte. Encontrou e fechou dois problemas materiais: exigir identidade real LLM antes da primeira inicialização lazy; e prosseguir para outro case após timeout HTTP504/408 ou timeout encapsulado. A correção posterior ajustou os códigos efetivos para os denominadores de timeout; falhas de transporte incertas continuam incertas e param o fluxo, sem inventar causa. O histórico REQUEST_CHANGES foi preservado. O monitor não repetiu auditoria de código, AST, raw ou modelo: leu o resultado existente e pediu encerramento da revisão já aprovada, mensagem `msg_8cbb69328f91`. Uma revisão aprovada não é autorização para repetir checks inalterados ou executar piloto funcional extra.

Pins finais: runner `cb44324ecab66f08c88695363ab2dbfc37f43ce14d3f71d3c66f75cf1b3508fd`; controller `52bf4360026571af5d95686be75187ffd035a7fab388a14dd690cfe2eebddf9c`; bootstrap `18e710677bee8ee8a968f0c1a107cb94204977ad5aa306d4c8864729810e37b2`; observer `ce614d6e00bfd425a966eb3165f8b75e3269b956ef288c15f0cf31fd96e4e51a`; telemetry `4d2e92a55dbdfd281ddadbe0c51378205164107d56d64e5fb1101757337a0103`; bindings `d4a2ee4b9419b3be9713c55c5ffbdb3cdf29847f7a4be44e22ae64458d2471e0`. Measurement admission4962 bytes, SHA256 `afb2096d9aab297c5b0136b1df5e6145b3b17589f6ec40eaba8edece948370b1`. Base de aplicação permanece o snapshot HTTP497 existente; a instrumentação privada foi versionada, sem editar produto ou branch canônico. Não alterar fonte/manifesto/modelo/settings/contagens no bloco vivo. Qualquer reparo subsequente precisa primeiro de conclusão/retirada e novo versionamento com histórico/replacement, não mudança em voo.

**Contrato real de contagem e gate:** n_planned=900 requisições MEDIDAS desta condição, além de15 warmups excluídos dos quantis. Antes de measured1, UM gate verifica todos os15 warmups planejados: etapas HTTP STT/assistant/TTS completas e spans nativos STT/LLM/TTS correlacionados sob seus cases distintos, identidade efetiva completa/fixa e log deste próprio processo comprovando AMD RX7600 e25/25 camadas offloaded. Identidade inicial incompleta antes do primeiro warmup lazy pode ser desconhecida; após a inicialização real é congelada e comparada, sem preload/inferência escondida. Guardar bytes/hash do prefixo do log de backend. Pedidos/stages gerados pelo harness são campos próprios, não IDs nativos inventados. Native request/session/operation/attempt IDs ausentes continuam NULL, com razões. Timeout/falha de transporte ambígua para a condição antes de emitir outro case, para evitar atribuir resultado tardio ao seguinte; reter status/erro real e recomputar denominadores. Não ocultar falhas nem fabricar900 sucessos ou marcar casos não tentados como executados. Gate falho ou cap atingido deixa condição incompleta e exige motivo específico.

**Snapshot efetivo de progresso, com horário:** Root `msg_97be1d2c8289` relata observação às **18:21:14 UTC**: controller3108591 e bootstrap3108620 vivos; `runtime/launch.json` verificou418 arquivos pinados, globalBuildLockHeld e reserva GPU exclusiva. Os primeiros **2/15 warmups foram completed_correct**, e **n_measured=0/900 naquele snapshot**. Havia labels distintos de case/stage e headers reais de correlação Gateway, raw-stage40689 bytes e gravação de bindings. Warmup2 descritivo: e2e10054.336ms; HTTP STT3252.330ms, assistant5289.767ms e TTS1506.856ms. Não são p90/p95, tempos puros do modelo, percentis de uma população ou prova de overhead isolado. A chamada assistant pode incluir fila/histórico e durações sobrepostas; não somar spans aninhados como componentes independentes. **Gate15, measured1 e contagens posteriores ainda não estão verificados nesta atualização**; o valor0 pertence ao snapshot citado, não é afirmação sobre o contador atual. Não extrapolar observações iniciais para900 pedidos ou aceite de toda superfície.

**Orçamento desta campanha, separado do piloto:**900+15; cap180s por pedido,12600s por condição e12780s outer. Root declarou outerdeadline **21:53:41 UTC**; preservar o deadline exato do controller, seus clocks e eventual incerteza, sem deduzir término de um timeout de observação. Raw em `/tmp` tem cap512000000B e reserva livre1000000000B; projeto exige120000000B na admissão e reserva viva80000000B; archive final tem cap40000000B **somente após término natural**, sem compressão pesada durante referência isolada. RAM:4000000000B de admissão,2000000000B floor runtime. São BYTES DECIMAIS, não MB/MiB ambíguos. Recursos frescos no spawn: projeto128208896B livres, tmp6951383040B livres, RAM12560629760B disponível. Em18:21:14: projeto128204800B/tmp6950354944B/RAM11282833408B. Preservar contadores contínuos, razões de parada, dados/áudio/raw e processo por host, sem cleanup amplo, alteração de segurança, OOM forçado ou interrupção de workloads alheios. Export/arquivo limitado não autoriza apagar originais, truncar logs ou declarar evidência completa se faltar material; requer receipts/hash/custódia e limitação honesta ao final.

**Isolamento físico e supervisão:** Root é o único dono da execução e reservas global/GPU/Waydroid. Durante esta referência individual não lançar Android, screenshots de dispositivo, inferência paralela, offload, builds ou tráfego cross-device no desktop. Preparação de metadata pode ocorrer sem interferência. Monitor permanece somente leitura/coordenação e escritor deste plano; nenhum worker novo, novo Root/goal/Run, dispositivo/teste/build/modelo/process-stop ou mudança de serviço/acesso foi iniciado pelo monitor. O tool blocker Android SDK resolver continua separado e não bloqueou esta execução. Não retomar a busca de rota durante a referência. Supervisão existente: native goal monitor `01a123ff-19ba-7332-a2f7-346a722af79f` ACTIVE, Orca terminal `term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc`, task_d7ea336050cf/ctx_37b4d0a3c14f e Run run_e6054e76e9fc. Eventos usam mailbox durável da MESMA Run, espera finita45s e heartbeat a cada5min, sem restart a partir de silêncio. Root lê UM gate após os15 warmups e faz acompanhamento finito da campanha. Dez minutos sem avanço de source/result/milestone exigem nudge com evidência; cold load progredindo não é stall.

**Telemetria e limites explícitos:** manter tempo e2e observado no requester, etapas HTTP, spans nativos e providers efetivos, setup/cold/warm, recursos e custódia raw. Monotonic vale no seu próprio processo; browser e outros hosts têm outros clocks, sem subtração direta ou correlação fabricada. Nesta condição HTTP não streaming, firstToken, firstStreamedAudio e queueWait não são expostos na fronteira; playbackStart/End não existem no fluxo headless. Ficam NULL+motivo, não0 ou prova de que esses gates de outras superfícies foram cumpridos. O nome astream de um observer não prova streaming nativo. Todos os campos adicionais requeridos no plano continuam aplicáveis nas superfícies que os expõem, incluindo first audio, playback, render/history, discovery/setup e ICE/network para a fase real entre dispositivos.

| Célula/superfície | Estado no novo setup padded | Contagem/evidência aceita agora |
|---|---|---|
| HTTP headless, requester/provider no desktop | Controller lançado; gate runtime pendente |900 planejadas +15 warmups; snapshot18:21:14 tem2 warmups corretos e0 medidas; contagem atual/quantis ainda desconhecidos |
| Local Python, mesmo requester/workload/model/settings | Comparação nova ainda pendente |900 por condição aplicável; antigas900 GPU de outro áudio preservadas, não reutilizadas silenciosamente |
| Browser, áudio de arquivo pelo fluxo UI | V675 readiness completa, fora desta condição HTTP |Uma prontidão/0 medidas; futura medição de superfície independente, sem alegar mic físico |
| Desktop nativo/local/thin e demais superfícies individuais não-iOS | Gates completos ainda abertos conforme plano |900 por condição aplicável; não substituir por headless ou browser |
| Android Waydroid | Capacidade de rota atual não verificada; erro SDK resolver preservado |Nenhuma aceitação runtime nova decorrente deste HTTP; sem phone battery/thermal/radio claim |
| Dispositivos reais e P2P TTS-only → TTS+LLM → TTS+LLM+STT | Medição HELD pela barreira de baselines individuais |900 por condição/superfície/par aplicável, warmups adicionais; não aceitar loopback como implantado/cross-device |

Checklist: [x] qualificaçãoN1/modelos/áudio preservados; [x] revisão fonte final encerrada e pinada; [x] admissão e lançamento reais/Root único; [x] bootstrap e dois warmups observados; [ ] gate15 e primeiro medido verificados; [ ]900 medidas desta condição com falhas/timeouts/unsupported/unattempted claros; [ ] término e retirada naturais, raw/logs/áudio/manifests/case history e relatório legível em docs com receipts; [ ] p90/p95 Type7 por condição e denominadores, sem pooling; [ ] demais baselines individuais de áudio/superfícies e Root transition; [ ] matriz completa real não-iOS/cumulativa. `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. CPUextra original, GPU antigos e falhas históricas permanecem válidos no escopo original. Fonte, before/after integrais, diff e recibo desta atualização: `/home/developer/projects/aurora/.omx/evidence/orca-monitor-20261010/plan-http900-actual-launch-20261015T1826/`. Prefixo1837 linhas/300680 bytes preservado integralmente; mesmo projeto/branch/dirty state/guia/lineage, sem aplicação ou submissão da tese.

## 30.24 Gate runtime real aprovado; medições HTTP900 iniciadas, sem resultado agregado final (2026-10-15)

O estado pendente da seção30.23 é superado pelo recibo Root `.git/aurora-handoff-import-20261006/v686-padded-http900-warmup-gate-RESULT.json`,6164 bytes/SHA256 `3566d7f19d4c5763eb810f69174cb02aa62dd25bc9be0d562dd1a8ebe9879751`. Observação real **18:24:52.581458 UTC**, `personal.skyron-server`, mensagem `msg_47592146e264` entregue às18:30:52 após compaction. Os **15 warmups excluídos** possuem seus cases distintos com as três etapas nativas STT/LLM/TTS completas, readback457 raw rows; IDs nativos ausentes permanecem desconhecidos. O próprio backend mostra AMD Radeon RX7600/RADV NAVI33, Vulkan0 e `offloaded25/25 layers`. Fonte/provider real `lastAttempt.actualProviderBindings` tem complete=true, SHA256 `bbfe63686818717d1ecf709b49603590679a2a1e5e179d2aaa33ba14c12a1aed`: STT faster-whisper/ctranslate2 CPU int8_float32 e LLM ChatLlamaCpp/AuroraOwnedLlama Qwen3.5-0.8B-Q4_0, ctx4096/batch64/threads2/seed42. RequestedGpuLayers100 por si só não é a prova; as linhas efetivas25/25 são. Os aliases snake_case nulos no resumo não substituem o campo camelCase efetivamente completo.

**Medição realmente iniciada:** `runtime/campaign/progress.json` estava running, attempted22=15warmups+**7 medidas de900**, com893 medidas ainda não tentadas. Último arquivo `attempts/attempt-0022-measured.jsonl`, case `padded-audio-v684-0022`, completed_correct, failure=null/timeout=false somente para essa última tentativa. **Não inferir sete sucessos, zero falhas agregadas, percentis ou900 concluídas.** Esta é a contagem daquele snapshot, não promessa sobre o contador atual. `runtime/launch.json` contém measurementStarted=false/measuredRequests0 porque é o registro imutável do startup; não o usar como status vivo nem editar fonte por esse campo. O progresso de campanha e as linhas imutáveis de tentativa são as autoridades dos contadores/denominadores. Fim natural, retirada, export/custódia, resultado agregado e Type7p90/p95 continuam pendentes; Root fará uma coleta/verificação final, sem reabrir revisões/pilotos já encerrados.

Bootstrap3108620 estava vivo; controller original3108591, manifesto `f1c270de7ef94b867f2f969f763b0c4c9a46a66f5329b8b3b011b7926f30c626` e418 pins permanecem, caminho exato `/tmp/aurora-root-padded-http900-v684/input/frozen-http-manifest.json`. Config launch/runtime idêntica SHA256 `0b0c85e9969fac797ac97af21111327ae1c24eef3d63e709a9805b1a70ad5a1c`. Recursos desse snapshot: projeto127410176B livres/tmp6947684352B livres/RAM11368001536B; reserva global/GPU exclusiva Root preservada, outerdeadline21:53:41UTC. Sem Android/screenshot/build/offload ou outro compute no desktop durante a referência. Os limites,900+15 e fonte/settings não mudam no bloco vivo. Continua **somente HTTP headless no mesmo host**; a prova nova de gate não satisfaz browser playback, microfone físico, todas as superfícies ou cross-device. Demais baselines e a matriz completa não-iOS/cumulativa seguem obrigatórias, com barreira de fase2 mantida.

Root confirmou seu native get_goal ACTIVE/unbudgeted no mesmo goal; o monitor também permanece ACTIVE no original. O relay passou a runtime `c056e640-4085-4377-83d5-c299190ee880`; SHOWs `689d97ed-bbc4-4e49-b0f3-5f2df6ca84b7` e `d5af69c8-c2d5-4fc3-aee2-34eebb67018b` revalidaram os MESMOS Root/controle desktop, incarnations inalteradas, connected/writable. Compaction/stream reset não foi interpretado como host morto ou autorização de relançar; monitor não enviou resume, replay, interrupção ou comando no desktop. Root leu/verificou integralmente a seção30.22: recibo494B/SHA256 `c2f0c5d7d2c6179df34a168550c04cfdbde020f0fde99858003c1cb46910445b`, `monitor-plan-section3022-root-read-v687.json`, mensagem `msg_389973a18add`; ACK da seção30.23 segue separado, não presumido. Fonte selecionada/sem repetir auditoria raw, before/after/diff e recibo desta adição ficam no mesmo pacote `.omx/evidence/orca-monitor-20261010/plan-http900-actual-launch-20261015T1826/`. Prefixo1868linhas/312389B preservado. `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`; nenhuma conclusão global, substituição de histórico ou aplicação/submissão de tese.

## 30.25 V684 terminou incompleto por guard de volume; próxima condição exige versão nova (2026-10-15)

**Estado terminal real substitui o snapshot running anterior:** V684 terminou às **18:28:34.388484 UTC**, exit1/elapsed472.66740756994113s/resourceCap=true. Resultado preservado: **29/900 medidas tentadas =28 corretas +1 falha/interrupção,0 incorrect_completed,0 timeouts;871 não tentadas;15/15 warmups corretos excluídos**. Status original shutdown_failed/http_call_URLError; não renomear como900 concluídas, falha de modelo ou condição aceita. Fonte Root `v688-http900-stop-RESULT.json`,25526B/SHA256 `40e46869ecfea2faee76540b6a0005ac7c9ed56b22afd20520234555c59fbcaa`, observada18:32:44.126813Z; mensagens `msg_fb519bd54846` e `msg_36fcd80f6086`. Case44 completou STT/assistant e encontrou URLError na TTS depois do shutdown acionado pelo controller; conservar a falha, sem reaproveitar só as28 boas ou completar/top-up silenciosamente esse run. Nenhum p90/p95 agregado900 está estabelecido. Os sete pedidos da seção30.24 eram um snapshot anterior legítimo, não estado atual.

**Causa imediata e limites:** apenas a última de467 amostras violou o guard: project/rootFree18980864B<80000000B. Tmp mínimo6944964608B, RAM mínima9135144960B e raw máximo6664048B não violaram seus limites. Projectfree recuperou para127164416B no retirement. A sequência controller resourceCap → owned stop → Gateway shutdown → TTS URLError suporta interrupção por política de recurso; **o writer da queda transitória permanece UNKNOWN**. GPU counter OSError errno16 é diagnóstico, não predicado demonstrado da parada. Não atribuir a outro usuário/serviço/modelo/processo sem evidência. Retirement SHA256 `1fb73e885a984ac7c9e83d8855762ba482698a325e0c3b9b842043b6b5c5d226`: controller3108591 e bootstrap3108620 ausentes, locks global/GPU observados livres/liberados e DB original911f10... inalterado. A reserva deste run encerrou pelo Root; o arquivo bruto/frozenmanifest permanecem imutáveis, e uma exportação final é trabalho do Root, sem nova execução ou segundo audit pelo monitor.

**Próxima correção limitada, ainda sem launch:** review fonte existente `resource-stop-v688/SOL-RESOURCE-REVIEW.md`,5283B/SHA256 `2b2303b0fd907bbde6228b2889e0f581ef7b9821e5f6f314c834097fdb5193b0`, mapeia os writes próprios de config/DB/áudio/log/cache/harness para/tmp; source e modelos são read inputs, com PYTHONDONTWRITEBYTECODE. Isso não certifica todos os caches default de terceiros. Root prepara NOVO namespace/freeze de controller que grava read/write roots e st_dev, vincula TMPDIR/XDG caches próprios a/tmp e aplica o guard ao volume de escrita real. Mantém1GB tmp reserve,512MB raw cap,4GB RAM admission/2GB floor, locks,180s/request/12600s condition/12780s outer,900 medidas+15 warmups e gate real provider/GPU/correlação. Projectfree permanece telemetria; export após terminal exige espaço real >= tamanho do archive limitado +80MB de reserva antes de gravar. Não é threshold0, autorização de cleanup ou mudança no run V684 encerrado. Versão/hash/cache placement e replacement link novos são obrigatórios; áudio/modelos/settings/predicados efetivos ficam iguais. Novo launch/resultados ainda não verificados nesta seção; não juntar resultados entre políticas/cohorts como se fossem um único900. Guard correto de filesystem não prova host unloaded: preservar contexto host/process/GPU/disk-I/O e unknowns de instrumentação. ToolCatalog5s timeout é overhead real retido, não causa demonstrada da reserva; não subtrair5s, mudar tools/modelos ou abrir outra matriz de testes a partir desta observação.

**Coordenação e status:** Root pediu somente metadata de interferência de disco ao Coding/Personal existente. Monitor revalidou Personal Hermes `term_8109a3ac-570e-4c3f-a7ac-e68e36764b2b`/inc468a0928-9867-4612-b5f2-e7631784582d e enviou o pedido; input_accepted `31a15f3f-8297-43f4-9c85-fba8630b6920`, resposta/cause ainda pendentes. Sem novo worker, shell/rota/acesso, CompanyWork, cleanup, device/model/build/test ou interrupção de usuário; isso não bloqueia Root de executar sua correção técnica já fundamentada. ACK Root da seção30.23 real:307B/SHA256 `e8c6aacdfa938d1aa5c233f1dc006d4e380567e461db83a98a62bedee93ee329`, `monitor-plan-section3023-root-read-v687.json`, delta lido/hash/prefixo/diff verificados; ACK30.24 separado ainda não presumido. Mesmos goals ACTIVE/Root integrador/monitor sole planwriter. Todas as outras superfícies e a matriz real não-iOS continuam obrigatórias; `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Fontes selecionadas/sem auditoria raw repetida, before/after/diff e recibos desta adição no pacote `.omx/evidence/orca-monitor-20261010/plan-http900-actual-launch-20261015T1826/`; prefixo1878linhas/316711B preservado.

## 30.26 Nova condição V692 realmente lançada; V684 permanece histórico incompleto (2026-10-15)

**Launch real às18:41:33.062932UTC**, `personal.skyron-server`, controller3116872, novo cohort `aurora-padded-http900-v692`, rawRoot `/tmp/aurora-root-padded-http900-v692`. Fonte `v693-actual-launch-padded-http900-writevolume-RESULT.json`,771B/SHA256 `32239038407bd770d75c24b39d4f1e7a6701663436d2d6e24429ce87082f2f34`, mensagem Root `msg_1e142295410e`. Frozen manifest novo148014B/SHA256 `81c25bd59323b1d515d20f9ea154868640e0f0d55b04cb39e77e88fb414aa78f`; controller `2e9a34e998bfd95fb92d4f0eef3c0f9fddc7eeb43c3d3b5ccb764a71e05aa083`, runner prefixe0a388 (hash completo no manifesto), revisão fonte Sol final `2b22d7dd7c1a8f49844ee69149be159f201c523f5c33e889b0df156497d34357` encerrada. A autoridade do manifesto pai foi estruturada antes do freeze; nenhum reparo em voo, novo modelo ou piloto extra. Audio padded, modelos, settings, workload e predicado estrito permanecem iguais; o novo controller/cache placement é versionado explicitamente, sem top-up/pooling com V684.

900MEDIDAS desta nova condição +15 warmups excluídos; caps180s/request/12600s condition/12780s outer; **outerdeadline22:14:33.062932UTC**. Guard acompanha o volume realmente gravável: tmp reserve1GB/raw cap512MB, RAM floor2GB/admission4GB, TMPDIR/XDG próprios; projectfree continua observacional e export final exige tamanho real do archive+80MB de reserva. Fresh spawn: projeto125145088B livres/tmp6944358400B livres/RAM12588183552B disponível. Confirmar write/read filesystem identities e recursos contínuos no registro runtime; fonte de writes externos continua UNKNOWN e não vira prova de host quieto. **Warmups completos, GPU/provider/correlation gate e contagens medidas deste novo cohort ainda não estão verificados nesta adição.** Exigir o gate dos15 warmups planejados com STT/LLM/TTS e RX7600Vulkan25/25 antes de measured1; constructor requested layers não basta. Não deduzir0 atual ou sucesso900 a partir do launch. Root guarda reserva exclusiva global/GPU/Waydroid: sem Android, build, offload ou tráfego cross-device no desktop; readonly metadata permanece permitido sem interferência.

V684 já teve **uma exportação e uma verificação final** encerradas: archive pessoal1759811B/111members/SHA256 `53396a777a5f1edef786c48b2e5897bd05fc3b449c2ebe6999a87f7af86fa541`, raw original retido. Relatório legível worker `docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-http-incomplete-v684/REPORT.md`,3349B/SHA256 `300cd779ac797afe3f0f9bdd4575df0d1546c66b7dc845a1e9bd80a92d7e28b1`. Seus28 completos têm Type7p90=10983.5844039ms/p95=11296.08444285ms, **somente descrição parcial**, mantendo a interrupção no denominador29,871 não tentadas e15 warmups fora dos quantis; não satisfaz900 nem é combinado com V692. Logs/config/DB omitidos do pacote público por sensibilidade continuam em custódia original indicada nos receipts. Não repetir ZIP/raw/source/model audits já encerrados pelo monitor.

Pedido metadata Coding/Personal concluído, sem atribuir writer: `/home/developer/.hermes/profiles/personal/cache/scratch/tcc-desktop-disk-write-inventory-v684.json`,2335B/SHA256 `6c37153496fde495927dd80da9fe5b7b1fb33d731acfde38b0ae0e34410fb4ba`. Inventário registrado não expõe mount/per-writer IO/owner de campanha e não há receipt independente de atribuição; sem novas rondas de rota, cleanup, CompanyWork, nova sessão/worker ou interrupção. Root get_goal original foi verificado ACTIVE em `native-goal-writevolume-live-v694.json`; mesmos goal/Run/Task/Dispatch/identidades e monitor sole planwriter. A preparação LocalBusV689 pelo Coding-worker existente tem review de fonte encerrado, **não launch de condição ou permissão de compute concorrente no desktop**; Root admite o futuro controller somente em fronteira/reserva apropriada. Atual execução continua HTTP headless same-host, sem substituir outros modos/superfícies, áudio UI, device real ou offload cumulativo. `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Antes/depois/diff/recibos desta adição no mesmo pacote `.omx/evidence/orca-monitor-20261010/plan-http900-actual-launch-20261015T1826/`;1888linhas/321611B anteriores preservados.

## 30.27 V692 gate real concluído; seis medidas no snapshot, condição900 ainda aberta (2026-10-15)

Root confirmou o gate final no recibo `v697-http900-writevolume-final-warmup-gate-RESULT.json`,6784B/SHA256 `ba29a7c94a527a73580426bc9ba46cb333e7de18de52b2f7fda9831ae3f51c11`, observado às **18:45:20.665045UTC**, mensagem `msg_fd165aec9761`. Todos os15 warmups excluídos possuem cases distintos com native STT/LLM/TTS completos, readback424 raw rows; backend desta execução confirma RX7600Vulkan25/25, actualProviderBindings complete=true/SHA bbfe63686818717d1ecf709b49603590679a2a1e5e179d2aaa33ba14c12a1aed. Progress running=21tentativas,15warmups+**6/900 medidas**,894 ainda não tentadas; última completed_correct/failure=null/timeout=false SOMENTE para essa tentativa. Não inferir seis sucessos agregados,900 concluídas ou quantis. Ambos controller3116872/backend3116892 vivos; RAM11329277952B disponível/tmp6937526272B livres/projeto125071360B livres. Manifesto81c25bd5... e fonte/settings/counts/caps continuam congelados. A flag0/false em launch.json permanece snapshot startup, não contador vivo.

Placement runtime observado no receipt anteriorV696: read-only project/source st_dev2082 e writable/tmp st_dev82, diretórios TMPDIR/XDG próprios, policy actual_write_volume_v1; isso distingue filesystems e guard de saída, não prova drives físicos independentes ou host sem carga alheia. Root monitora um progresso a cada5min/evento/terminal; nudge após10min sem avanço real, sem restart por silêncio. Outerdeadline22:14:33.062932UTC, reserva exclusiva global/GPU/Waydroid, sem Android/build/offload/crossdevice no desktop. Nenhum novo piloto/review de fonte/raw; um outcome/retirement/export/Type7audit ao término, depois próxima condição sob admissão Root. Contadores intermediários seguintes ficam na case history/receipts, sem churn do plano a cada pedido. ACK Root da seção30.25 foi verificado em receipt307B/SHA256 `41207b0ea6cc966bb460bdf0bc6e4584bd3a020142097dabd7c64cbabe084899`; ACK30.26 segue separado, não presumido. V684 segue falha incompleta selada e nunca é combinado com V692. Todos os demais modos/superfícies e900 por condição/par/remote-stage set continuam necessários, iOS excluído; `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Prefixo1898linhas/325929B preservado; snapshots/diff/receipts desta adição no mesmo pacote de monitor.

## 30.28 Custódia final e futura admissão no filesystem realmente usado (2026-10-15)

**Preparação de fonte concluída, execução final ainda não observada:** Root confirmou em `msg_bafa13452198` que a revisão finita do finalizador está APPROVED/CLOSED. Fonte `http900-finalize-prep-v715/post_terminal.py`,17699B/SHA256 `4db1040b7814ffea9cfdef4c2c28121fcbcec8b8d76e2ed0366aad98f4eb0018`; review Sol4224B/SHA256 `c5249c78a3dea8a142db85e3169619fb24f5d27cbd8eb16826e332e7413d2a33`; `FINALIZE-COMMAND.txt`,9116B/SHA256 `0990d2b0501ff1aef00e0519ed95f8825d74a7a8a2ec6544e7b88642089bf14f`, sob `.git/aurora-handoff-import-20261006/`. Comando apenas gerado, não staged/enviado/executado nesta evidência. Após terminal real e ausência comprovada de ambos os owners originais, Root verifica locks/DB/pins congelados e realiza UMA reconciliação outcome/contagens/Type7/native-stage/áudio, salvando receipt antes da publicação. Arquivo limitado fica primeiro no/tmp próprio e os raws originais permanecem; se a admissão real tamanho do arquivo+80MB de reserva no destino desktop falhar, manter custódia/tmp e usar somente a rota Orca já aprovada de transferência do MESMO arquivo salvo para docs do MESMO projeto canônico no coding-worker, com hash/receipt do receptor, sem repetir auditoria de outcomes. Timeout de observação exige reconciliar a MESMA operação aceita, não replay do finalizador ou nova execução. Todos os passes de fonte atuais encerrados: sem nova revisão/piloto/matriz estética por mera espera.

**Próxima variante LocalBus é preparação futura, não freeze/launch ou alteração do V692:** Root `msg_a38d137a07ca` observou projeto desktop70049792B livres no V717 e coding-worker10116141056B livres; propõe substituir a antiga hipótese de archive no projeto desktop/120MB pela admissão no volume do receptor realmente escolhido. Runtime continuará integralmente no/tmp próprio com os mesmos guards tmp/RAM/raw, modelos/áudio/settings/900+15/caps; futura custódia primária de arquivo será docs do projeto canônico no coding-worker, exigindo receipt novo de capacidade e tamanho REAL do arquivo+80MB antes da cópia. A alternativa não zera reserva e não autoriza cleanup, mudança de fonte em voo ou compute adicional no desktop. Registrar nova versão/hash/placement/receipts da variante quando efetivamente congelada/admitida; V689 aprovado anteriormente permanece histórico e V692 congelado permanece intacto. Próxima condição só depois do terminal natural, retirada e exportação/custódia verificados de V692 e nova admissão exclusiva pelo Root. No snapshot salvo V719 de19:49:06.385392UTC, V692 ainda running373/900 medidas+15 warmups,527 não tentadas, owners3116872/3116892 vivos; isso prova avanço, não correção agregada/quantis/fim da condição. Fonte `v719-http900-bounded-progress-RESULT.json`,17555B/SHA256 `8cbf9fda2b7786b666d7c5f8c449a8edaf97fc0c51194c1e372d7c5c6e1e2d4b`; próximos contadores ficam somente na case history, salvo mudança material.

**Correção explícita do histórico30.26, sem reescrever seu prefixo:** o archive V684 INCLUI logs backend/controller com credenciais redigidas; configs privados/DB foram omitidos. Originais privados/unredacted permanecem na custódia original. A frase anterior “Logs/config/DB omitidos” era excessiva; esta correção usa `msg_11e2056fd8d6` e o resultado de auditoria já encerrada, sem segundo ZIP/raw audit. Fonte/receipts/before/after/diff desta adição no pacote de monitor já existente. Root continua único integrador/executor/reservas; monitor único escritor deste plano, ambos nos goals originais ACTIVE/unbudgeted, mesmo Run/Task/Dispatch/branch/lineage. Nenhuma nova sessão/worker, commit/push/submissão, CompanyWork, credencial/permissão/provider/driver ou interrupção. Todas as superfícies aplicáveis não-iOS,900 medidas POR condição+warmups extras, áudio real STT→LLM→TTS, estágios cumulativos e pares reais de devices continuam obrigatórios; `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Esta custódia não aceita HTTP same-host como browser/microfone físico/cross-device, nem mistura CPU/GPU/cohorts. Prefixo1904linhas/328386B/SHA256463247c7ce3ab1d6e592d1326f5690643f63f94d97f892a77096374a5b53c71f preservado byte a byte; ACK Root deste novo delta ainda deve ser obtido, não presumido.

## 30.29 LocalBus futuro: fonte da custódia qualificada, admissão positiva preservada (2026-10-15)

Complemento material de30.28 antes de qualquer launch futuro: Root `msg_98029f40bb06` confirmou fonte APPROVED/CLOSED da variante `qualified-local900-storage-v719/controller.py`,26886B/SHA256 `6174836e94884cf92423537bec3bdc7d148f118a61b715a213d7c1ad7ffea839`, review Sol2811B/SHA256 `f5dd29dc70380c19f78b7f9221ef568ec149f06624781c8b41a3950d44552584`; stager `stage_source.py`,11448B/SHA256 `12818845fb4fd9db3bd64d10e0131b24582e8fda04ac9567847c9a2fa11e091e`, somente syntax checked, NÃO executado. Caminhos sob `.git/aurora-handoff-import-20261006/`. Metadados/hash locais confirmados pelo monitor, sem nova revisão de implementação, teste ou piloto. ParentV689 e liveV692 permanecem byte-inalterados. Labels/namespace v689 ainda não usados pelo runner/hook são preservados para manter essa fonte fechada idêntica; o NOVO frozen cohort deve identificar explicitamente a política de custódia v719 e seus pins, sem confundir com execução anterior.

A admissão inicial continua POSITIVA **120000000B no filesystem real de destino docs do coding-worker**, sustentada por observação Root local fresca de idade<=300s, pinada no SHA do novo manifesto externo congelado. Posteriormente, antes da cópia, revalidar archive salvo<=40MB e destino com tamanho REAL do arquivo+80000000B de reserva; não usar observação antiga ou capacidade de outro volume. A observação já salva `worker-capability-observation.json`,464B/SHA256 `1386c548606584c219c3818fc38d16cdf5af41a13c5a831ca4546c9399168cec`, é evidência de preparação, não substitui o futuro receipt fresco. Runtime permanece no/tmp próprio com1GB reserve/512MB raw cap/RAM4GB admission2GB floor,900 medidas+15 warmups,180s/request/12600s condition/12780s outer e gate real de GPU/provider/correlação. Áudio/modelos/settings/typed LocalBus contracts iguais; nenhum reserve zero, cleanup, acesso novo, conta/provider/driver ou tráfego adicional no desktop. Arquivo primário será entregue pela rota Orca existente ao MESMO projeto Aurora no coding-worker, com receipt/hash do receptor e custódia/tmp preservada em falha de publicação.

Esta é prontidão de FONTE, não launch nem resultado. Gerar/congelar/admitir a condição requer terminal REAL, retirement/owners/locks e export/custódia V692 concluídos e vinculados ao novo manifesto, recursos novos e reserva Root; a publicação desta seção não os satisfaz. Fonte/review/prep encerrados, sem passes idênticos adicionais. Snapshot running373/900 de30.28 continua histórico até próximo receipt; não se interpreta ausência de update como exit. ACK Root30.28/30.29 ainda separado de fonteAPP, deve registrar leitura real no checkpoint. Before/after/diff/receipt deste delta no pacote de monitor existente; prefixo1912linhas/332810B/SHA2569feb4240b79445f720e78a68ada4a830025317a1fc0ae5f63e42595a7a34a9e4 intacto. Goal completo não-iOS/900 POR condição/áudio real/cross-device e sole-writer/Root executor sem mudança; `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`.

## 30.30 Browser futuro: política de custódia qualificada, sem execução nem novo piloto (2026-10-15)

Root `msg_28fef4e6f2b4` encerrou UMA revisão finita exclusivamente do delta de recurso/custódia: `browser900-storage-v721/controller.py`,31627B/SHA256 `ba5aa5cb2999dc2e5fc2ded1e706e545f976cd2e706b86282273c99a34578ae8`; review Sol2591B/SHA256 `6626f8de499d33319d4690bff89227c62f8e9153960488b9c9d5e52f6bb27fa6`, APPROVED/CLOSED. Mesmo predicado de admissão de LocalBus30.29, destino específico browser em docs do MESMO projeto canônico coding-worker:120000000B positivos mediante observação Root fresca/pinada e posterior arquivo real<=40MB+80000000B de reserva antes da cópia/hash/receipt. Nova versão futura `aurora-normal-ui-padded-file-mic-full-audio-worker-custody-v721`; namespace/interface V704 fixo ainda não usado permanece para reter driver/bootstrap/hook/gate de fonte já encerrada. Não confundir o label V704 preservado com run/resultado anterior ou sobrescrever freeze. Guard browser original preservado: raw/shorttmp cap2GB, tmp reserve1GB/admission3GB, RAM admission5GB/floor2GB, shm500MB;900 medidas+15 warmups extras, caps de tempo previamente declarados, mesma captura/UI/modelos/gate nativo e cleanup de descendants exatos. Preparação não implica recurso disponível, launch, runtime de captura repetida aprovado ou resultado900.

`browser900-storage-v721/stage_source.py`,15995B/SHA256 `6f9b2c4188e5d92115400efa8503b93b71936ce6fdc56bcda507bfc0c1bdf3de`, está implementado e source/remote-freeze-body syntax checked, NÃO executado. Exige receipts REAIS de terminal/retirement/export de AMBOS predecessores HTTP e LocalBus, capacidade Root fresca no destino e hash mais recente deste plano realmente lido pelo Root, antes de gerar três payloads limitados; conferir hashes staged antes de novo manifesto. Copiar apenas fonte/modelo/versões/hardware/authority compatíveis do parent; declarar ingress/browser-visible-answer/playback e domínios de clock específicos, sem herdar label de medição headless. Captured PCM real é artefato distinto do WAV-fonte; fake-file prerecorded capture não prova microfone físico. Código normal de UI/inputs/predicados permanece fechado, com o gate real planejado de15 warmups antes da medição, não outro piloto auxiliar. Métodos de estágio/sourceAPP não equivalem a verificação dos gates runtime. Caminhos de preparação sob `.git/aurora-handoff-import-20261006/`, somente hashes/metadados locais conferidos pelo monitor.

Atualização factual de30.29 também recebida em `msg_683900580960`: stager LocalBus mudou de histórico12818845 para SHA256 `6a01bd61828f75e04cb142a345167c53dd9f6f9f7e6963130bff70404d9c0ce8` apenas para exigir/pinar o plano mais recente realmente Root-read no novo freeze. Syntax passa/generator NÃO executado, controller6174836e/runner/modelos inalterados, sem necessidade de outro review. Root leu de fato30.28/30.29 e verificou prefixes/hashes, receipts `monitor-plan-section3028-root-read-v720.json`498B/SHA256 `4e747f6e10788fe4fe9f1f96e607e3d732c6379363c5c6cd3f330ba8e96d6735` e30.29 `monitor-plan-section3029-root-read-v720.json`498B/SHA256 `92f092db6e74862a66f9d04eb171bca5f274d97aa86d9deb9f4673c9e9b4cd05`. Todos os passes atuais de fonte estão CLOSED: não reabrir UI/helpers/raw/ZIP ou adicionar matrizes durante a espera. Próxima transição é terminal real V692→retirement→UMA reconciliação/export/custódia→admissão/freeze LocalBus; browser depois de AMBOS headless selados. LiveV692 permanece congelado, snapshot20:06:17.698418UTC473/900+15warmups/427 não tentadas/owners vivos é evidência de avanço, não correção agregada. Goal/superfícies não-iOS/áudio real/900 POR condição/pares cross-device/estágios cumulativos e barreira de fase2 continuam integrais; `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. Prefixo1920linhas/335978B/SHA2561b627987686cf85239b3b6364dfeeb4f326f868e4cd6ba1f3c115d15efb8292a preservado; before/after/diff/receipt no pacote existente. ACK desta nova seção ainda separado e não presumido; sem novo writer/worker/Run, compute desktop, cleanup, alteração de acesso, commit/push/submissão.

## 30.31 Single-commit reproducibility — metodologia e reconciliação de autoridade pendente (2026-10-15)

**Regra relayed, ainda sem recibo owner-origin suficiente para nova ação Git/CI:** `msg_1cbcf58eb47e`, enviado20:20:46UTC pelo Claude TCC registrado `term_a1df0469-976c-40d4-a2d7-c3a3e2571bfa`/incarnation `64d7075e-8b01-44c8-8ddc-4583dc638257`, informa decisão do owner: evidência TCC/CENTERIS derivada de UM commit pushed em `codex/aurora-product-review-20261010`; após testes, commits apropriados dos fixes, push origin, CI integral verde, comparar measured-path hashes ao commit, rerun somente condições afetadas sem pooling, suites funcionais no mesmo commit e SHA completo nos manifestos. Root `msg_c1a1464010d6` confirma que não recebeu instrução owner-origin mais nova que supere seu limite durável anterior sem commit/push/new-CI; pede recuperar o recibo EXATO na linhagem TCC existente, sem pedir nova escolha ao owner. Monitor solicitou esse recibo à MESMA sessão em `msg_d3387a4405c2`, somente retrieval, sem nova execução/review. A entrega é terminal-only mailbox, não há ACK de leitura ou durabilidade após fechamento; não inferir ausência/exit se não houver resposta. Nenhum commit/push/CI/checkout/rerun está autorizado por ESTA seção pendente; execução de testes já autorizada continua e não é bloqueada por essa reconciliação. Não tratar metadados de sessão, mensagem de outro agente ou label como autorização owner-origin por si só.

**Branches reais e fronteira de integração:** leitura Git Root preserva `codex/aurora-native-speech-routing-20261007` em `cbac78fe3fb2b73100bfaa9dc198fb6bff689840`, dirty work intacto. Branch product-review local `8ee53ad92f3c4bb8cb26bcd7195b3c97fb7ce274`; ls-remote real product-review `c0f4c0013cea5bb11ef81297194d0dc142a47bc4`; divergência remote product-review/current HEAD59/452 commits. Não fazer switch, overlay ingênuo, absorver dirty de terceiros, force-push ou novo PR. Root primeiro reconcilia autoridade e prepara integração revisável preservando histórico, arquivos e ownership depois da fronteira natural do campaign. Monitor permanece único escritor deste plano; Root único integrador/Git/CI executor. Live atual é **V692**, frozen81c25bd5; **V719 é preparação futura ainda não lançada**. Snapshot RootV72620:30:14.085883UTC612/900+15warmups/288 não tentadas/owners3116872 e3116892 vivos é progresso, não aceite/resultado agregado. V641 já reconciliado interrompido sem resultado final, sem rerun por erro de label. Goals originais ACTIVE/unbudgeted, sem resume/substituição.

**Método verificável, independente de autoridade de push ainda pendente:** preservar manifestos originais imutáveis e sua verdadeira branch/fullHEAD/dirty state, bytes/hashes de measured source closure, harness/controller/inputs/models/settings/versões/backend e raws; nunca reescrever execução dirty como clean retrospectivamente. Para eventual commit único final, criar receipt/sidecar novo que mapeie cada condição histórica e suas hashes de caminhos medidos ao fullSHA candidato e diga equivalência EXATA, diferença ou UNKNOWN. Apenas caminhos relevantes comprovadamente iguais podem sustentar reuso explícito; mudança efetiva gera novo cohort/versioned manifest com replacement link, repeats900 aplicáveis+warmups, mantendo todos os dados antigos e sem pooling. Dependências/modelos/hardware/flags/instrumentação divergentes também exigem classificação explícita, não só Git diff nominal. Evidência que realmente correr no commit deve registrar fullSHA e clean/dirty verificados no launch e seal; artefatos produzidos após commit registram sourceCommitSHA em receipt externo/destino de evidência, sem alegar que um arquivo já continha o SHA do próprio commit antes de ele existir. Com autoridade resolvida, Root registra commits purpose-based/owned paths, integração revisável, UM destino pushed, CI run IDs/SHAs/conclusões reais e suites funcionais citadas com comandos/env/deps/checksums no mesmo source commit; sem repetir suites idênticas já demonstradas para o mesmo código ou multiplicar PRs. Falhas/unknowns permanecem visíveis. Monitor acompanha milestone de integração/publicação, exige hash mapping antes de alegar reprodutibilidade e não cobra push antes da fronteira autorizada ou inventa CIpass.

**Proveniência TCC limitada, agora observada:** SHOW `dd24f35c-fd20-4249-949e-8304cb87c31e` e screen `4e8f7b5b-435f-4629-9a60-d681c61bfc75` verificam sessão Claude atualmente registrada no projeto TCC canônico `846e3e40-f48b-4e20-8aa7-88ef55b67da3::/home/developer/projects/tcc`, host `ssh:ssh-1786238480967-semdev`, connected/writable, e atividade visível de revisão/relay. Isso NÃO verifica classe de conta PERSONAL/UNIVERSITY, autoria/sessão histórica exata do white paper ou versão-fonte histórica; CompanyWorkClaude permanece proibido. A revisão entregue corretamente dizia live lineage unverified naquele instante; não foi retroativamente alterada nem reenviada. Bounded stream `481dc91e-ab83-4885-9e18-b94d961f40ea` retém só resumo do agente, não a fala original do owner; draft de UI não é instrução submetida. Nenhum comando/input foi enviado à sessão paper, apenas pergunta interna Orca de receipt retrieval. Fontes selecionadas e nota standalone `tcc-live-session-20261015T2021/PROVENANCE-AND-REPRODUCIBILITY-NOTE.md`, com before/after/diff/receipt desta adição no mesmo pacote de monitor `.omx/evidence/orca-monitor-20261010/`. Prefixo1928linhas/340212B/SHA25624968434b27de95272b1fa636f88be07352a58365a0ed149a5bc6ba40c9885af byte-intacto. Toda a matriz não-iOS/900 POR condição/áudio real/estágios cumulativos/pares reais continua; `requiredIndividualAudioAndSurfaceSealsComplete=false; phase2MeasuredAllowed=false; full13Complete=false`. ACK Root desta seção ainda pendente.

## 30.32 CORREÇÃO OWNER: barreira de PERFORMANCE, blockers por célula, sem gate global de UI (2026-10-15)

**Esta instrução mais nova SUPERA expressamente as cláusulas anteriores que faziam todos os resultados individuais AUDIO+SURFACE/product, Android rendering, captura física/getUserMedia ou playback uma barreira global à fase distribuída.** O owner exige como fronteira de PERFORMANCE: **arquivo de áudio controlado/licenciado → STT real → LLM real → TTS real → áudio válido**, com os mesmos inputs/modelos/settings e telemetria correlacionada. Cada pedido executa os três estágios; transcript injetado, resposta salva/cached ou somente read-aloud não satisfazem a fronteira. Decodificação/validade/não-silêncio/correção do áudio produzido permanecem exigidas. Microfone físico, permissões/getUserMedia, playback e renderização Android são aceites próprios e blockers APENAS das células que realmente dependem desses componentes. Não suspender uma célula de performance ou distribuída válida por bug de UI em outra superfície. Manter cobertura de performance das superfícies não-iOS aplicáveis; headless não passa a provar browser/native/mobile ou captura física. Célula de superfície sem ingresso determinístico/saída válidos fica explicitamente blocked/unsupported nesse caminho, sem virar bloqueio universal.

Origem: instrução direta do owner recebida neste monitor nativo; encaminhada Root em `msg_1378a4c1a283`21:09:47UTC. **Root ACEITOU realmente em `msg_5b5401a1170a`21:13:45UTC**, preservando monitor sole planwriter e comprometendo correção do CURRENT/routing/steering sob sua ownership. O CURRENT anterior13007B/SHA256 `94e78ac073b9d6dcb70ad30d65b9aa7ca288778b8ef5300e4aff82f5406a704f`, gates2–3, ainda continha a barreira excessiva; cópia preservada, não reescrita pelo monitor. A pergunta operacional única `msg_8d4208498b48` pede lista exata restante/equivalência/caps/rotas/instrumentação; Root faz UM read limitado dos manifestos/receipts existentes. Aceite de orientação não é lançamento nem conclusão. A enumeração operacional adicional ainda pendente deve ser anexada com evidência, não inventada.

### Checklist de performance: evidência atual e lacunas explícitas

| Célula/cohort e executor | Estado verificável | n_planned / n_measured / n_success | Dependência e papel na transição |
| --- | --- | --- | --- |
| Worker ARM64 CPU LocalBus V491, original-audio, extraCPU | SEALED, saída real STT/LLM/TTS; término15:21:29/retirement/export/audit único já encerrados |900 /900 /900;15 warmups extras | Histórico independente. WAV153644B/3.482993s/SHA139fa0c34b6d18600ad9608fd2d11c9389cae2f5f548ce0f4f23b735b176f0b3 difere do padded; não o relabelar baseline comparável do novo input sem prova exata de equivalência efetiva. |
| Desktop originais LocalBus V485 e HTTP V497 | SEALED no setup original, falhas estritas preservadas |900/900/878 e900/900/853;22 e47 incorretas | Controles históricos úteis no seu setup, sem pooling com padded/hardware diferente, sem rerun cosmético ou descartar números ruins. |
| Desktop padded HTTP V692, Root | REALMENTE LANÇADO/RUNNING;21:11:18.154913UTC852/900+15 warmups, owners3116872/3116892 vivos |900 /852 /agregado ainda UNKNOWN;48 não tentadas | Terminar congelado81c25bd5, retirement e UMA reconciliação/Type7/custódia; não mudar input/settings/counts ou interromper. WAV219794B/4.982993s/SHAda0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb; qualified parentb36d6585. |
| Desktop matching padded Python LocalBus, variante de custódiav719 | SOURCE-READY/CLOSED; controller6174836e, stager6a01bd61; NÃO staged/frozen/lançado |900 /0 verificado /0 medido;15 warmups planejados | Após V692 naturalterminal/retirement/custódia, novo freeze/reserva/admissão de recursos e receiver120MB fresco; depois archive real+80MB. Conta900 separadamente de HTTP; mesmos input/modelos/settings e diferenças reais de backend/rota declaradas. |
| Worker matching padded control, SE requerido para comparação/par aplicável | Necessidade/equivalência e preparação ainda NÃO verificadas; não presumir launch nem chamar V491 novo-audio |900 POR condição realmente requerida; medida nova não verificada | Root deve enumerar explicitamente requisito versus reuso justificável. Inputs/cohorts diferentes não são comparabilidade automática. Uma condição CPU necessária pode ocorrer no worker existente em paralelo a desktop isolado após reservas físicas não interferentes; sem novo worker ou tráfego medido cross-device na fase1. |
| Browser full UI V721/V704 e demais controles específicos de superfície | Browser source-ready, gate runtime15 e900 NÃO executados; V675 é somenteN1/0medidas. Outras compute-baselines exigem enumeração concreta Root |900 por condição/superfície aplicável; números adicionais UNKNOWN | Preservar cobertura, mas separar normal mic/UI/playback de ingresso determinístico de performance. Exigir baseline distinto só quando o caminho de compute/transporte/cliente relevante muda ou o contraste o requer. Reuso somente mesmo requester/surface/workload/model/settings com mapa de evidência explícito, sem headless masquerading como superfície. Bug de captura/render/playback não segura outras células elegíveis. |
| Distribuído real TTS-only; TTS+LLM; TTS+LLM+STT | NÃO lançado/medido na nova configuração; provas de rota e instrumentação ainda a enumerar |900 CADA configuração/par/requester/surface/modo aplicável +warmups extras; nenhum agregado900 serve | Root faz transição explícita após os baselines individuais COMPARÁVEIS DE PERFORMANCE requeridos worker/desktop e readiness da célula/rota. Depois iniciar células elegíveis sem esperar todo product/UI. Células bloqueadas ficam individualmente listadas, sem retirar escopo. |

Os relatórios históricos são fontes de outcomes no escopo original, não autoridade para antigos gates de UI: `root/worker-cpu-full-audio-local900-v491/REPORT.md`,4387B/SHAd71932dbb8a6d75c23836a73ef7c235110bb107b82e35dc70a0a3369911f7300; `root/future-local-worker-custody-v719/REPORT.md`,3940B/SHAe578c412879c6b65d4947c1216a9c90d81103f16a9c9a594cf7086280187bbec; `root/browser900-source-preparation-v713/REPORT.md`,4485B/SHA750f9eac9221bd52a9f55dc71c71fde9b2d012f550668e4f22001eda63219e5e, sob docs/experiments/tcc-20261013-submission-20261030/. Não repetir audits/rawZIP/model review já fechados para redigir checklist. Falhas/timeouts/incorretos/unattempted permanecem denominadores; sem forçar OOM ou900sucessos artificiais.

### Dependências concretas antes de cada célula distribuída

1. **Identidade/rota autorizada REAL:** Root deve ligar requester/provider/host/surface/runtime/source/model hashes e disponibilidade aos receipts existentes, sem inventar BR/PT/US/country ou dispositivo. Confirmar sessão/pareamento/grant existente, serviço STT/LLM/TTS efetivamente invocável e transporte do áudio/resultado. Ping/status ou dois peers same-worker/loopback não comprovam offload entre devices. ICE direct/relay/NAT/fallback deve usar selected-candidate-pair/relay receipt real; se a operação não é WebRTC, registrar transporte real e ICE não aplicável, não fabricar ICE. Acesso/credencial/security/network scope continua inalterado.
2. **Placement cumulativo sem substituição:** manter a MESMA pipeline inteira por pedido. TTS-only: STT+LLM locais, TTS remoto; TTS+LLM: STT local, ambos remotos; TTS+LLM+STT: os três remotos. `stage_provider_map` com request/span/session/model/backend proves cada localidade, origem do input e retorno de áudio. Demais estágios locais, sem inventar autorização de wakeword remoto. Local Python e HTTP gateway REAL também900 por condição aplicável; comparação igual em task/model/input/settings, falha local honesta e benefício de weak-device somente após resultados.
3. **Readiness de instrumentação limitada e baseada em evidência:** auditar emissão requester+provider correlacionada e clocks monotônicos com domínio/uncertainty antes da coorte; setup/discovery/handshake separado de warm dispatch; queue/load/STT/LLM/TTS/first-token/first-audio quando expostos; bytes/encode/serialize/encrypt/transport/relay, recursos CPU/GPU/VRAM/RAM/network/storage e contexto RTT/bandwidth/loss por device/processo. Não subtrair timestamps monotônicos de máquinas distintas como se tivessem um clock; durações locais e bounds de sincronização declarados. Campo não exposto é UNKNOWN/null+motivo, nunca0; não fingir playback/captura física na fronteira file→valid-audio. Incapacidade real de provar freshSTT/LLM/TTS/placement/correlação bloqueia a respectiva célula; ausência de um produto/UI não relacionado não bloqueia toda a fase.
4. **Freeze/admissão/caps/transição:** nova versão por mudança real de input/model/settings/caminho, manifests com n_planned900, warmups adicionais excluídos, raw/schema/case history/custos/recursos/deadlines e stop rules finitas; p90/p95 Type7 por condição sem pooling. Root único integrador/reservas, sem duplicate workers e sem produto-detour. Após seals comparáveis de PERFORMANCE e readiness da rota elegível, receipt explícito da fase2 e executar cumulativos. Mixed local-user+mesh load na fase2 continua cenário esperado explicitamente declarado e instrumentado; manter referência controlada separada, sem esconder competição ou matar sessões para fabricar host quieto. Demais superfícies/voz/privacy/recovery continuam no fullmatrix não-iOS, mas blockers por dependência real.

**GPU e Android:** usar somente flag/config de aceleração JÁ suportada quando pertinente; caso contrário manter setup híbrido rotulado corretamente. Atual desktop tem LLM RX7600Vulkan25/25, Whisper e Piper CPU; não chamar all-GPU, não instalar/trocar backend/driver/código ou rerun apenas para GPU, nem mudar V692. Owner CONFIRMA emulator na personal distrobox pela rota Orca ADB JÁ existente. Inventário local vazio/erro antigo de resolução SDK não é device ausente. Root deverá usar esse relay/target existente na célula Android; sem novas permissões/SDK/network/conta. Android rendering segue aceite de superfície, sem bloquear file-audio/headless ou outra célula distribuída válida. Waydroid não prova telefone físico/bateria/thermal/radio.

**ETA sustentada, não promessa de fase2:** entre V731b21:06:14/823 e V731c21:11:18/852 foram29 medidas em304.126880s; cadência recente~10.49s/tentativa. No snapshot852 restavam48: projeção linear de~8.4min até~21:19:42UTC, condicional a cadência/recursos, não contagem atual nem garantia de sucesso. Outerdeadline V692 continua22:14:33.062932UTC. Matching LocalBus ainda não lançado:900+15/cap12600s condition/12780s outer; usar cadência HTTP apenas como surrogate indicaria~2h40 de execução, NÃO piloto ou ETA validada de LocalBus; readmissão/seal/custódia somam tempo desconhecido. Não há ETA global distribuída confiável até Root fechar a lista worker/surface realmente necessária e readiness de rota/instrumentação. Uma necessidade adicional não verificada não pode ser ocultada nem inflada em requisito universal de UI. Atualizar ETA somente com receipts/primeiros warmups planejados, não abrir pilotos/reviews repetidos para melhorar previsão.

Estado corrente separado: `comparableIndividualPerformanceSealsComplete=false` enquanto as células requeridas não selarem; `individualProductSurfaceAcceptanceComplete=false` permanece independente e NÃO é barreira global; `distributedMeasuredAllowed=false` neste snapshot, passará a elegibilidade por célula após transição Root/evidência; `full13Complete=false`. Nenhum resultado anterior é descartado, renomeado clean ou combinado com outro áudio/hardware. Branch/worktree/dirty/lineage/Run/Task/Dispatch/Root/monitor preservados; sem commit/push/submissão ou nova autorização Git/CI inferida. Prefixo1938linhas/346102B/SHA25689fc2c36b54ca0110d5047a7bd45391466ebe9aa7cf55912f355a950a741aa16 intacto. Antes/depois/diff/receipt/fontes desta correção: `.omx/evidence/orca-monitor-20261010/performance-phase-amendment-20261015T2112/`. ACK do aceite da orientação já real, ACK Root deste delta completo ainda separado/pendente; enumeração final operacional da pergunta existente também pendente.

## 30.33 OWNER: pacote manual reprodutível em UM diretório canônico thesis/ (2026-10-15)

**Novo deliverable autorizado, sem mudar a prioridade de coleta/performance distribuída:** consolidar TUDO estritamente específico da tese dentro de UM diretório canônico de topo `thesis/` no MESMO repositório Aurora, salvo equivalente canônico já existente realmente justificado no inventário. Read-only inicial21:21UTC não encontrou `thesis/` no topo; `benchmarks/`, `.benchmarks/`, `docs/experiments/` e `scripts/experiments/` existem, mas seus conteúdos não foram todos classificados e não são automaticamente tese. **Root é implementation/integration owner desta consolidação; monitor continua único escritor do plano.** Instrução owner encaminhada por `msg_160c6327ca0f`21:21:30UTC, recebimento/leitura Root e execução ainda não comprovados nesta seção. Não criar projeto/worker/writer concorrente, não tocar repo/sessão/manuscrito TCC separado846e3e40..., nem inferir nova autoridade de commit/push/PR/CI/publicação/submissão. `thesis/` é destino proposto/autorizado, NÃO diretório já criado ou pacote concluído.

### Escopo e mapa de migração obrigatório

Inventariar fontes customizadas de experimentos/harness/controller/análise, fixtures, templates de config seguros, frozen manifests, metodologia/matriz, relatórios, retained-evidence index e demais source estritamente thesis-only existentes em docs/experiments/scripts/outros caminhos e nos harnesses privados retidos. Para CADA item registrar: caminho original e referência/revisão, classificação thesis-only versus production/shared/runtime, bytes/SHA256/identidade congelada, destino canônico, owner, leitores/writers/runs ativos/dependências, custódia e estado (`inventoried`, `active-deferred`, `canonical`, `external-custody`, `compatibility-pointer`, `shared-retained`), ação e receipt. Classificar é necessário: não mover automaticamente toda uma árvore experiments/benchmarks nem incluir dados CompanyWork. Production/shared source e seus testes ficam nos lugares normais e são referenciados por full revision/path/hash; não duplicar implementação Aurora dentro de thesis/.

O pacote inclui, em estrutura simples documentada pelo Root, `thesis/README.md`, entry points manuais portáveis de execução/análise/preflight, fixtures pequenas licenciadas com hashes/licença, templates sem segredo, frozen inputs/manifests imutáveis ou referências de custódia, metodologia/matrix/coverage, reports, migration map e evidence index. A origem owner-authoritative externa deste plano no Vault permanece preservada/sole-writer; a versão do repositório pode conter snapshot COMPLETO pinado por hash/path/versão e política explícita de sincronização, não uma metodologia abreviada ou segunda autoridade silenciosa. Não mover nem editar o Vault/TCC/manuscrito para fabricar o pacote. Guardar source customizado reprodutível versionável no canônico: mera referência a scripts absolutos privados em `.git/aurora-handoff-import...` não satisfaz reprodução manual. Originais privados/frozen continuam íntegros e identificados; nunca versionar `.git` como conteúdo do pacote.

### README: contrato de reprodução manual e honestidade

Documentar comandos REAIS e relativos ao checkout canônico para setup/preflight/launch/analyse, seleção explícita/opt-in da condição, recursos e limites de sessão, dependencies/versões/Python/ambiente e backend compatível, modelos/weights/hash/licença/download ou custódia existente, hardware/VRAM/RAM/CPU/armazenamento/rede, configuração segura/env exigida e entradas/saídas esperadas. Cobrir condições originais e changed-audio separadas, Local Python/HTTP/cumulativos distribuídos, requester/provider/surface/stage map,900 medidas POR condição e warmups extras, p90/p95 Type7/denominadores/timeouts/correção, seed/decoding e limitações de nondeterminism por hardware/backend/scheduling. Indicar o que não foi medido, requisitos realmente indisponíveis e como obter/referenciar as evidências conservadas. Não prometer que uma cópia de source ou um `--help` passa a reproduzir resultados900; receipts devem distinguir offline/preflight de smoke e medição.

Campanhas longas são **MANUAIS/OPT-IN**, sem integração automática no CI padrão/test discovery/import-time e sem full rerun só por empacotamento. Exemplos README não disparam900 implicitamente. Root valida os entry points documentados com bounded offline/preflight; somente se realmente necessário e resource-safe pode usar tiny smoke explicitamente NON-MEASURED, fora das reservas/células correntes e sem pooling. Registrar command/env/exit/duration/sourceSHA/result/output e o que o check cobre; nenhum modelo/build/device/benchmark é lançado apenas para demonstrar embalagem enquanto o recurso não estiver livre. Não adicionar dependencies/backend/driver/install ou mudar testes por estética da estrutura. Mudança efetiva de semântica medida segue cohort/version/replacement rules; simples relocação idêntica não exige rerun900 e não altera manifestos históricos.

### Conservação, custódia e fronteira segura

Antes de mover, Root comprova release dos leitores/writers/owners e referências de paths do run; não renomear source, fixtures, input/output/raw/config/harness de V692 ou futuros freeze ativos em voo. Preparação inofensiva/inventário pode ocorrer sem interferência, mas coleta terminal/retirement/UMA reconciliação/custódia e sequência de PERFORMANCE/distribuído têm prioridade. Adiar itens ativos nominalmente com release condition e hash, sem virar escopo esquecido. Preservar todos os frozen source/manifests/raw/hash identities, original path labels, falhas/incorretos/interrupções/superseded links e históricos. Compatibility pointers mínimos fora do canônico podem manter referências antigas; o índice declara a localização autoritativa atual sem editar bytes históricos ou apagar prova. Não mover goal/ledger/runtime-owned state em uso; inventariar referências de proveniência com custódia/adiamento seguros.

Versionar assets pequenos e seguros. Arquivos grandes de áudio/raw/model/ZIP ficam em custódia durável indexada por URI/path aprovado, owner/host, bytes/checksum/content identity, retenção/acesso autorizado e instruções concretas de retrieval/hashverify, sem cópia massiva no disco restrito. Custódia fora de thesis/ para grandes archives é permitida via índice, não exige duplicação física. Credenciais, tokens, configs privados e DBs pessoais NÃO entram no pacote; usar templates sanitizados e razões de omissão, sem expor segredos. Nada de broad deletion, cache/container prune ou git-clean. Não declarar archive ausente/exited por inventário incompleto. Entrega aponta caminho canônico REAL e receipts de migração/entry points/custódia; plano aceito/source-ready não é pacote pronto.

### Aceitação verificável do deliverable

- [ ] Root ACK da instrução e destino canônico escolhido, com justificativa se equivalente pré-existente for usado; mesma linhagem/projeto e ownership preservados.
- [ ] Inventário/migration map cobre tudo thesis-only no repo e custom source privado retido; produção/shared explicitamente mantidos, itens ativos adiados com condição de release.
- [ ] Um único diretório canônico contém os assets pequenos seguros e fontes/entry points manuais portáveis; não depende apenas de paths privados absolutos.
- [ ] README cobre requisitos/commands/saídas/modelos/hardware/seed/decoding/nondeterminism/original+distributed e limites honestos de reprodução.
- [ ] Metodologia/matrix/manifests/reports/retained-evidence index completos ou snapshots full/pinados; sem segunda autoria do TCC/Vault nem perda do histórico.
- [ ] Grandes archives indexados com custódia durável/checksums/retrieval reais; nenhuma duplicação massiva ou credencial/private DB versionada.
- [ ] Moves só após release observado, frozen identities/compatibility pointers/histórico preservados; sem rename de run ativo, broad delete ou source contamination.
- [ ] Nenhuma campanha900 incluída no CI/test discovery por padrão; commands são opt-in e checks offline/preflight ou tiny NON-MEASURED smoke têm receipts e recursos seguros.
- [ ] Resultado real reporta path/manifest/migration/verification receipts e limitações; nenhum rerun completo só por packaging e nenhuma nova autorização push/PR/publicação presumida.

Estado nesta gravação: **NOT STARTED/INVENTORY REQUESTED**, todos os itens de aceitação ainda abertos; `packagingComplete=false`. Correção de PERFORMANCE30.32 continua prioritária e vigente: UI/mic/playback/Android são dependências por célula, não barreira global; fullmatrix não-iOS/900 POR condição/cumulativos reais mantidos. Root recebido/implementação deve ser verificado; monitor apenas persistiu escopo e critérios. Prefixo1971linhas/358479B/SHA256dc7c3deda47b6acb7d4c4019ebda909956a0840137c3e9e4b425088799019d2c byte-intacto. Before/after/diff/receipt desta adição em `.omx/evidence/orca-monitor-20261010/thesis-packaging-amendment-20261015T2122/`; ACK Root deste delta ainda pendente. Nenhuma pasta de produto/manuscrito foi alterada ou movida pelo monitor.

## 30.34 V692 MEDIÇÃO concluída; checklist Root de performance e dependências distribuídas reais (2026-10-15)

**Resultado terminal real substitui os snapshots running anteriores:** V692 terminou naturalmente às **21:19:38.110691UTC**, exit1 pela classificação `completed_with_failures_or_incorrect`, não por interrupção/timeout.900/900 medidas tentadas = **854 corretas +46 completed_incorrect,0 failed/interrupted,0timeouts,0unattempted**;15/15 warmups corretos extras/excluídos. Fonte Root `v732-http900-bounded-terminal-check-RESULT.json`,30826B/SHA256 `c5074605a9a11fb1a3815e7726a870f69e21ea1a892a4c024a5a3c0c011ebb0c`, observado21:21:39.251033UTC, owners3116872/3116892 ambos ausentes e shutdown_completed=true. Manifesto81c25bd5 e todos os inputs/falhas permanecem congelados; não chamar900success nem repetir o run para melhorar score. Não inferir a causa das46 incorretas só do label. Type7 full-flow inclui as900 completas, inclusive incorretas: p50=10218.320628ms, **p90=10779.086541ms/p95=11515.7969795ms**. Correct-only854: p90=10749.8105892ms/p95=11413.8626138ms, população distinta explicitada. Não somar percentis de estágios nem misturar original/padded/CPU/GPU.

Root executou o finalizador previamente CLOSED uma vez; receipt `v732-http900-finalize-RESULT.json`,8866B/SHA256 `c6354ebb3828ef42e98c134a29e94fcc5163f8e52197036107580c52024cdb0e`, às21:22:27.480120UTC, `savedZipIntegrityHashesAndOutcomeAuditPassed=true`. Retirement604B/SHA256 `5be32c9a16a383764bd96a56cb5864ff4694d22c9660c9af272fe77e2b2425a7`; detalhes adicionais de lock/DB ficam no receipt próprio, não inferidos aqui. Archive **34691761B/SHA256 `7f1438bd700d5a794a879f5a38d7293275acf4d827289a50c6c49e01dc1a1870`**, custódia atual `/tmp/aurora-root-padded-http900-v692/export-v715/aurora-desktop-gpu-padded-http900-v692.zip`, raws originais preservados. Projeto desktop53022720B livres não satisfaz arquivo+reserva80000000B; status `project_storage_admission_unmet`. Transferência do MESMO archive salvo pela rota Orca aprovada ao destino worker/docs e receipt de capacidade/hash ainda pendentes; não é falha da medição nem permissão de cleanup/baixar guard. Não repetir outcome/ZIP/raw audit já PASS. Esta célula está MEASURED/RETIRED/AUDITED, custódia/publicação durável final ainda OPEN.

### Checklist operacional Root efetivamente encontrado, sem UI como gate universal

Fonte completa: `docs/experiments/tcc-20261013-submission-20261030/root/performance-transition-v732/REPORT.md`,10545B/SHA256 `c65c619577461713339fc2ef897260b72a97ec61bd3b65e4a89350792417b5c0`, lida integralmente pelo monitor. O snapshot852/881 dentro da preparação é histórico, substituído pelo terminal acima; não reescrever evidência congelada. CURRENT Root agora14761B/SHA256 `794472742abcadac2969d27dba23ecc50b86bf3dd1940a542612b8a389ec4734` contém **Current performance transition** e gates2–3 corrigidos: apenas performance comparável worker/desktop, blockers por célula. A antiga barreira de UI/Android foi realmente removida do status corrente, não só aceita verbalmente. Plano30.32 segue a autoridade metodológica.

| Condição requerida | Estado real/n_planned/n_measured | Bounds e ação restante |
| --- | --- | --- |
| Desktop padded HTTP V692 |900 planejadas/900 medidas/854corretas;15warmups extras; terminal/retirement/ONEaudit concluídos | Completar transferência/custódia indexada acima, sem rerun. |
| Desktop matching padded typed LocalBus, futurav719 | **SOURCE-READY,0medidas; NÃO lançado/frozen/staged**;900+15 |180s/request,12600s condition/12780s outer; tmp1.512GB admission/1GB reserve/raw512MB, RAM4GB admission/2GB floor; worker archive admission120MB fresco e cópia actualarchive+80MB. Root admite após V692custódia/recursos/locks e novo freeze, executa warmups planejados e900. |
| Worker ARM64 CPU matching padded typed LocalBus | **REQUIRED novo cohort comparável,0medidas; NÃO frozen/lançado**;900+15 | Mesmo áudio/weights/ref/settings; CPU offload0 e diferenças architecture/backend explicitas.180s/request, provisório57600s condition/57840s outer baseado SOMENTE no pilot original49.633587315s; não é throughput do padded. Existing Luna lane prepara adaptação privada mínima, sem novo worker; Root executa após source/input/env/resource/lock admission e freeze exatos. |
| CPUoriginal V491 e desktoporiginais V485/V497 | Sealed originais; não preenchem as duas linhas padded novas | Manter originalinput139fa0c3 e todos os números/falhas. V491900corretas é extraCPU histórico; input diferente impede usá-lo como padded comparável. Sem top-up/relabel/pooling. |
| Outras baselines de superfície/API realmente distintas | BrowserV704/V721 somente source-ready/0medidas; nativeRust/Tauri/browser-local/Android-local equivalência `readiness_unknown` | Não há prova de backend/input/model iguais; não inventar equivalência ou unsupported por renderização. Registry deve enumerar células aplicáveis/APIcontrols adicionais,900 cada, e quais pré-requisitos realmente dependem da superfície. Sua ausência não reintroduz bloqueio universal de mic/UI/playback. |

O worker padded novo é necessário ao par planejado worker requester/desktop provider e ao gate comparável exigido pelo owner. Fonte pronta NÃO é execução lançada. Os dois novos runs podem ocorrer em paralelo em hardware worker/desktop DISJUNTO, sob Root e reservas físicas existentes, sem tráfego medido interdevice antes da fase2. A antiga condição CPU terminou/liberou recursos; não migrar/expandir seu frozenmanifest. Prioridade é admitir/executar as condições de performance já necessárias; packaging30.33 fica em preparação inofensiva/fronteira segura e não as segura. Permanecem contagens próprias900 para outros controles API/cumulativos realmente aplicáveis; a registry ainda não enumera prova de todas as suas capacidades/launches e não pode ser declarada completa.

### Dependências distribuídas que ainda NÃO estão prontas

- Hosts distintos já admitidos: `code-worker` ARM64 e `personal.skyron-server` x86_64. Controle SSH/Orca conectado não é data-plane Aurora. Notebook receiver/backend/reserva e mapeamento countryBR/PT/US não verificados; exigir inventário aprovado, sem inventar região ou ausência.
- API atual prova apenas auth HTTP loopback same-host. Falta endpoint cross-host JÁ autorizado, auth e pedido/resposta real por par. Não abrir porta/firewall/credencial/provider novo para preencher checklist.
- MeshV319 é texto/same-worker; falta sessão/grants existentes, selected ICEcandidatepair/direct/relay e prova de áudio STT/LLM/TTS entre hosts. Config signaling/TURN não prova uso real de relay.
- K1TTS remoto; K2TTS+LLM/orquestração remotos; K3TTS+LLM+STT remotos: falta execução real/contratos/grants específicos e `stage_provider_map`. Estágios restantes locais, mesma pipeline completa/input/model/settings; sem wakeword remoto inventado.900 por configuração/surface/par/modo aplicável+warmups extras.
- Falta prova requester/provider de IDsrequest/trace/attempt/stage e recursos correlacionados/clocks próprios, setup versus warm, realstage-recipient e contexto de rede. Perf de um host não é span cross-device. Queuing/TTFT/streamedfirstaudio não expostos permanecem null+razão; network aggregate não prova atribuição por rota. No finalizador V692, STT/TTS têm múltiplos native spans por case e seus quantis single-span são null/denom0; LLM nativeoperationID ausente não é substituído por harnesslabel. Full-flow/caller spans válidos continuam distintos dessas limitações; não fabricar métrica, excluir em silêncio ou reauditar raw900 apenas para esconder unknown. Auditoria limitada da instrumentação antes de novas células segue requerida, sem loop de UI/edge-case.

**Timing com limites honestos:** V692 efetivamente encerrou21:19:38, consistente com a projeção, mas isso não inicia distribuído. LocalBus desktop tem outer3h33 APÓS admissão mais custódia; worker padded tem provisório outer16h04 APÓS launch, oldCPU levou~11h21, não extrapolar como prazo garantido da nova entrada. Execuções disjuntas podem sobrepor; CPU é potencial critical path, ambas ainda não lançadas neste receipt. Preparação/admissão/custódia e readiness de route/instrumentation têm tempos ainda não demonstrados. **Não há ETA global incondicional de início distribuído**; publicar horário só após launch receipts e cadência/recursos observados. AndroidUI/mic/playback e packaging não podem virar atraso artificial desse critical path.

Esta é leitura/registro dos resultados salvos e do checklist Root, NÃO novo teste, revalidação do archive ou execução pelo monitor. Fonte/selected receipts/fullbefore/after/diff em `.omx/evidence/orca-monitor-20261010/performance-phase-amendment-20261015T2112/`. Prefixo2007linhas/367779B/SHA25676e4419ed1c376ff67263e0b166d66981f1999c8c7731bc01f682fe19d0193a6 intacto; Root ACK dos novos deltas30.32–30.34 deve ser verificado separado de guidanceACK. `comparableIndividualPerformanceSealsComplete=false; distributedMeasuredAllowed=false; packagingComplete=false; full13Complete=false`; UIproduct acceptance separado não é gate universal. Mesma linhagem/projeto/Root/monitor, sem source/Git/backend/security mutation ou novo worker/manuscrito pelo monitor.


## 30.35 — Custódia V692 concluída, análise salva por handler e lançamentos reais dos baselines comparáveis (2026-10-15 22:02 UTC)

**Atualização material do mesmo objetivo, sem nova medição pelo monitor.** Complementa os snapshots históricos30.34: a cópia pendente efetivamente terminou, o CPU padded foi lançado e o segundo desktop LocalBus recebeu um novo launch receipt após falha pré-backend preservada. Não declara900 resultados novos, GPU observada no novo processo, readiness distribuída ou conclusão do pacote `thesis/`. Root continua integrador/executor/implementador do pacote; monitor é o único escritor deste plano externo. Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`; mesmos projeto, branch e ownership, sem commit/push/PR/CI, nova sessão/worker ou tese canônica alterada.

### Custódia durável V692 efetivamente fechada

- Resultado original preservado:900 measured,854 correct+46 strict incorrect,0 execution failure,0 timeout,15 warmups excluídos; término natural21:19:38.110691Z. Incorreção permanece no denominador e sua causa não foi demonstrada. Não repetir benchmark ou auditar novamente para melhorar o número.
- O driver original de cópia `69253` encerrou0 segundo Root `msg_862c254e0939` (21:59:29Z). Receiver `docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-http900-v692/WORKER-CUSTODY-RECEIPT.json`:3325B, SHA256 `8e84508e312c464d08def00a44d102da1665bd4c3fd8d7bb345818d4da8b628f`, `status=complete`, `updatedAt=2026-10-15T21:54:40.832065Z`, antes do cap21:57:04.276050Z, `originalAuditRerun=false`. Campo residual de erro de paginação é história da tentativa anterior, não sobrepõe complete/verificação dos cinco arquivos.
- Arquivo `aurora-desktop-gpu-padded-http900-v692.zip`:34691761B, SHA256 `7f1438bd700d5a794a879f5a38d7293275acf4d827289a50c6c49e01dc1a1870`. Original `/tmp/aurora-root-padded-http900-v692/export-v715/` e raw original permanecem preservados; receiver acima constitui custódia adicional com recibo, não autorização para apagar/mover origem.
- Os outros quatro arquivos tiveram tamanho/SHA verificados pela mesma cópia: `ARCHIVE-MANIFEST.json`690579B/SHA `d87abd77df46d68fba1a4c420d411a95776026430b7100817aa1bf83f5d63605`; `NATIVE-STAGE-CASE-HISTORY.json`2128044B/SHA `cc4aead5d0650ee8ae667e509b72bf01d6adbdf80de962cb47a1311ecb601158`; `audit-verification.json`12033B/SHA `9658f29dfc939083445a98f26d222df3b622ac0cba5cc8396d5c22a09a342a6a`; `verification.json`12399B/SHA `199ee53e338185d2e4222b98e88816beee5575cdfdaf9a49499198ce14d36ac2`.
- Monitor leu somente recibos/relatórios salvos; não abriu/recalculou hash do ZIP, não repetiu finalizador/auditoria. Root notificado `msg_aaa0a4eab671`22:01:13Z, informando remoção dessa dependência e acompanhamento do próximo lançamento. Cópia não é execução distribuída.

### Addendum de spans nativos por handler: análise salva, zero novos requests

No mesmo receiver V692, `ANALYSIS-RECEIPT-v733.json`1819B/SHA `e8def36251c28f884553a559d8b4c5530ed2f909793dc2aa7dcd7ebb19972886` registra21:38:06.770539Z, exit0 e `newMeasurements=0`: análise dos dados existentes, sem serviços/modelos/benchmark ou nova auditoria de outcomes. Fonte portátil `thesis/analysis/native_span_metrics.py` SHA `38de2aa542f6c9a47c12f5c10a276daee2c273dc691347648d49b893c78c1d62`. Saídas `NATIVE-SPAN-METRICS-v733.json`2961B/SHA `651d2834e914f526c77f70b26b8c50b334224fd847a7fea3b1882f7099583aa0` e `native-span-durations-v733.csv`961770B/SHA `746c192f9eb35ef88d3c8ab6dca39896ad48e51b46e766d4b48d28835b057aef`.

Agrupamento explícito pelo handler, mesmo processo/clock/PID3116892, medidos completos incluindo incorretos, warmups15 excluídos, quantilType7. Cada linha temN900,0missing,0multiple-within-handler e0invalidboundaries:

| Escopo nativo distinto | p90 ms | p95 ms | N |
| --- | ---: | ---: | ---: |
| STT `stt.model_invoke` |3463.3750054|3538.07191285|900|
| Serviço `Transcription.Transcribe` |3473.8818394|3558.532779|900|
| LLM `resolved_chat_model.astream` |303.4011624|396.76407415|900|
| TTS `tts.model_invoke` |1742.556882|1881.70846575|900|
| Serviço `TTS.Synthesize` |1743.2337898|1882.55398295|900|

Modelo e wrapper de serviço são escopos diferentes e potencialmente contidos: **não somar durações/quantis** nem chamar diferença cross-hardware de overhead de protocolo. A auditoria anterior com requisito de um único span não qualificado por STT/TTS manteveN0/null corretamente; o addendum identifica handlers sem reescrever essa história. Native operation/attempt IDs existem nos model-invoke STT/TTS900, mas estão ausentes nos wrappers/LLM900; harness request/case correlation não fabrica native IDs. Queue/TTFT/streamed first-audio/playback permanecem null+razão; nenhuma prova de captura física, áudio audível, rede por rota, host descarregado ou clocks cruzados. Duração do próprio script não foi capturada e não vira latência de inferência. Percentis full-flow V692 continuam p90=10779.086541ms/p95=11515.7969795ms para todos900, separados dos grupos acima.

### Baselines individuais comparáveis: recebido versus realmente executado

| Célula/estado observado | Receipt e identidade exata | Próximo limite/aceitação |
| --- | --- | --- |
| Worker CPU padded: **LANÇADO**, primeiro warmup correto; medidos0 no snapshot21:56:47.925795Z | `worker-padded900-prep-v732/spawn.json`,803B/SHA `9fbafeac0b5e7cd46a47510372528388fd4b1c09c2ec3d44b38fa9526d34447d`; lançamento21:54:44.822403Z, controller3021111, backend3021188 informado pelo Root; `startup-observation-v734.json`3725B/SHA `332ff9d430ee2f111a3607ee25220f691bb7a6ce1e89772b46f7ba1d4c333928` prova warmup1 completed_correct,900 measured ainda não tentados. Diretório base `.git/aurora-handoff-import-20261006/`. |900 measured+15 warmups extras,180s/request,condition57600s/outer57840s; gate de warmup/recursos e contagem real por eventos, não contar spawn como900. Preservar dados antigos CPU como cohort separado. |
| Desktop LocalBus V719: **FALHA PRÉ-BACKEND preservada**, zero modelos/warmups/measured | `v734-local900-launch-RESULT.json`515B/SHA `b2fe331671578b06acc532b07b95c7538d120c71ab4fef2ebed2c960ef2c2a6f`; controller3293376 em21:55:49.258058Z, raw `/tmp/aurora-root-padded-local900-v689`, freeze `c2c9a104f1ea3e17f1b8323bc5a0e53efbd5b87299b5c3a3ee82ce518a80deb8`. Root reportou saída natural~0.006s `existing_gateway_fixture_key_unavailable_or_ambiguous`: launcher omitiu env de fixture existente. |Correção finita do launcher, sem inferir falha de modelo/qualidade, sem alterar credenciais/grants/backend/modelo. Não ocultar/reescrever tentativa antiga. |
| Desktop LocalBus V735: **NOVO LANÇAMENTO REAL**, gate/runtime GPU ainda não comprovados neste snapshot | `v735-local900-launch-RESULT.json`515B/SHA `a67e1e0ecf47c828e22f07f7e72752d4c7f7e07f82a541d40c95f49bf1bd2933`;22:00:59.007996Z, controller3295193, raw `/tmp/aurora-root-padded-local900-v735`, cohort `aurora-padded-local900-worker-custody-v735`, freeze `be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5`. |900 measured+15 extras,180s/request,12600scondition/12780souter. Aguardar primeira observação/backend e gate de aceleração/stages planejados; spawn NÃO demonstra Vulkan25 ou medição concluída. Mesmo áudio/model/settings, somente remapeamento futuro + fixture env existente. |

Preparação CPU já fechada: controller `e4821ec398c57158650768b94de744cdbf4b56f7f3bffc89cddd490563969480`, revisão Sol `4efe65b35e5a098cfc91f87d7303248d1ebc54acb41873c6e2a4504ba5d06a99`. Root `msg_782648311979`/`msg_fa4b8401f32a` confirmou comparação400sourcefiles/6708922B idênticos ao inventário congelado V692,313packageversions normalizadas e seis backends/modelos pinned; diferenças de arquitetura/Python/build/CPU0vsGPU25 e metadata-only explicitadas. Receipt `SOURCE-EQUIVALENCE-v734.json`24492B/SHA `bdfee18b409e4a9dfbe1af5e018e1cd351397ed795e2be174bebda3ec6159a95`; admission `7bac89c26dd6a1c7f338d8b9c44c57ed9ecfd7acf176c56ec0cf5a0131c0a1e6`. Monitor verificou metadados desse receipt, não reexecutou comparação400files. Não repetir review/pilot só para reconfirmar fonte já fechada. Novos launch/runtime receipts e failed-attempt history devem entrar no índice de reprodução/custódia Root.

**Fases mantidas sem gate artificial de UI:** CPU e desktop individuais podem progredir em paralelo nos hosts físicos distintos sob reservas/contadores Root. Antes de cross-device medido: completar/selar performance comparável requerida, depois transição explícita Root. Prerecorded fixed-file→actualSTT→actualLLM→actualTTS→áudio válido é a fronteira; microfone/getUserMedia/playback/Android rendering bloqueiam somente células dependentes. Outras superfícies não-iOS aplicáveis conservam estados/condições próprias, sem fingir que headless cobre todas. Hipótese atual desktop permanece LLMVulkan25/STT+TTSCPU até novo runtime provar; nenhuma instalação/mudança/rerun só para GPU.

Luna concluiu lookup finito, sem tráfego: `.git/aurora-handoff-import-20261006/distributed-admission-readonly-v734/REPORT.md`7195B/SHA `92415b1fb11ced946e92bb85be0aa3568b59ebad7f9025c62cc5a5fb5c296e6d`. Contratos expressam K1TTS remoto, K2TTS+LLM remoto, K3TTS+LLM+STT remoto; **não há receipt retido de origem Aurora cross-host/peer+grant para o par real nem notebook backend/reserva**. SSHalias/boolean authorized/countsinglepeer não provam data-plane. Próxima admissão é recuperar metadados/rotas/grants já autorizados e stage-provider/correlation/ICE real, não ampliar segurança. Scope900 **por condição** mantém falhas/timeouts no denominador, warmups extras e baseline reutilizável somente com equivalência explícita. Relay OrcaADB na distrobox pessoal teve retorno ok:true/empty[] segundo Root: lacuna de inventário relay, não ausência de emulador e não dependência do áudio/headless independente. Regiões continuam não inventadas.

**ETA limitada pelo receipt:** CPU começou21:54:44.822403Z com outer16h04 (teto de sessão aproximado16/10 13:58:44Z, não previsão de sucesso); desktopV735 começou22:00:59.007996Z com outer3h33 (teto16/10 01:33:59Z). Nenhuma cadência paddedCPU atual medida foi estabelecida neste snapshot. Quantidade final, feasibility/falhas, recursos e contratos de rota ainda podem impedir selos. Portanto início distribuído continua sem horário garantido; não alegar que AndroidUI ou packaging explica espera de performance independente.

### `thesis/`: caminho canônico existe, consolidação ainda parcial

Root ACK `msg_4f82763d4b7e` e read receipt `monitor-plan-sections3032-through3034-root-read-v732.json`806B/SHA `584c7aa420ddb12dc259c613528b4cfbb898ec194971302a349b9786c22283df` confirmam leitura integral/prefixos30.32–30.34 e ownership Root do pacote. Caminho real **`/home/developer/projects/aurora/thesis/`**, sem mover active raw/controller/source pins. Assets observados: `README.md`2649B/SHA `a47bbb2f88441ba355f03fa6f3569c0324c3c82ba906333fb7c9b4b6aa790252`; `analysis/native_span_metrics.py` acima; `inventory/migration-index-v734.json`14252B/SHA `f4d741e8954ab56ebbd50dacc70915936ac1c475cb29bd4cfa2ee97449f0a152`; `methodology/CUSTODY.json`808B/SHA `e10d30df124083e98fd71d56415881dc8dd21c8c2c4a837ad59f10bdf8d073aa`; snapshot `methodology/owner-requirements-20261015-5a622bc7.md` do prefixo anterior. Snapshot pinado é histórico; este Vault continua autoridade, não segunda autoria.

README declara literalmente pacote parcial. A única entrada portátil executada demonstrada é análise salva, exit0/zero new measurements; isso **não** valida setup/launch de experimento inteiro. Critérios completos30.33 permanecem abertos: inventário integral/old→canonical+release conditions; custom source/controllers/fixtures/templates seguros e manifests; comandos manuais reais setup/launch/analyse+requisitos/modelhashes/hardware/seed/decoding/limitações; condições original/distribuída+failed history; custody/checksum/retrieval para grandesraw sem duplicação; refs production exactrevision/path; opt-in fora CI/testdiscovery; preflight offline/smoke não medido só resource-safe. Não renomear activepaths, não copiar segredos/DB privada, não tocar repoTCC/manuscrito, não fullrerun só packaging. **`packagingComplete=false`** até recibos concretos de todos esses itens; coleta/distribuição mantém prioridade.

Backup integral/prefixo imutável377142B/SHA256 `5a622bc7021b31857f090e57c25b6211badec2393b5e632db2318d03ac3413e9`, after/diff/receipt e selected-source pins em `.omx/evidence/orca-monitor-20261010/custody-launch-plan-20261015T2202/`. Root deve confirmar delta30.35 em checkpoint seguro, sem replay de auditoria/teste. `comparableIndividualPerformanceSealsComplete=false; distributedMeasuredAllowed=false; packagingComplete=false; full13Complete=false`; objetivos nativos Root/monitor continuamACTIVE.


## 30.36 — V737 admitiu medição; ambos os gates normais passaram; pacote portátil continua parcial (2026-10-15 22:32 UTC)

**Atualização material coalescida do mesmo objetivo.** Fonte Root `msg_55d216acbb14`22:30:19Z e recibos salvos: o reparo único de alias Piper foi fechado e ambos os baselines individuais estão medindo. Nenhuma correção/pilot adicional está pendente nesse gate. Não são900 novos resultados completos nem selo da fase1. Mesmos Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`, Root/monitor/projeto/worktree/dirty state; Root permanece único integrador/executor/implementador de `thesis/`, monitor único escritor do plano externo. Sem novo worker/sessão, live source edit, credencial/driver/provider/security change, commit/push/PR/CI ou manuscrito alterado pelo monitor.

### Tentativa CPU anterior preservada; nova versão com identidade e denominadores separados

CPU V734 encerrou naturalmente22:06:31Z com **15 warmups corretos,0 measured,900 unattempted**. Motivo `actual_cpu_provider_identity_incomplete`: comparação textual de caminhos canônicos registrados versus symlink aliases admitidos para modelo/config Piper que resolvem aos mesmos arquivos. STT/LLM reais/options estavam corretos; Root corrigiu explicitamente sua interpretação inicial de STT. Não é evidência de falha de qualidade/modelo nem razão para nova investigação de observer/import/modelo. Owners3021111/3021188 ausentes, lock liberado, `retirement-v736.json` e todos os cases/áudios/freeze anteriores preservados segundo Root. Warmups antigos não são medição nem são adotados na tentativa nova.

V737: runtime launch **22:15:27.058533Z**, spawn metadata22:15:26.954582Z, controller3038114/backend3038148; attemptId **`aurora-worker-cpu-padded-v737-20261015`**. O controller mantém um label histórico de condition-family: label não substitui attemptId/frozenmanifest. Raw/fonte `.git/aurora-handoff-import-20261006/worker-padded900-prep-v737/`; `spawn.json`803B/SHA `b0a07e7191230562425302135002c757c2aaeec492ffdaf09b89dd0c908309c9`. Admission/freeze **`acbdc1d3827502513237220fcc3bf60cc3a007b7dc246b1a4b21b1a0ef8ce5fc`**; runner `d17a7dcb9aa2c57aaf8c83f2fb15505da9bfd73572f73cb9ebd841eb425c62e3`, controller `90ff9b9014b6648f34a7e9310b9129a9218bc0ce91bf5449e5c7dfb7cf0b7040`, SolAPP `e677082419ca276af968110a05c482648b2ce2a0a6be6058bb2eff24fac2de13`. Única mudança executada: igualdade de caminhos canônicos actual/config Piper, mantendo hashes/predicados/correctness/native stages, áudio, modelos/settings e CPU. Campo STT não suportado foi detectado/removido **antes** da execução; observer não mudou. Sete pins de modelo/config e seis runtime versions admitidos. Nenhuma alteração em source/model/config do run congelado posterior ao launch.

| Célula individual / observação | Progresso real separado | Gate/estado |
| --- | --- | --- |
| Worker CPU V737,22:28:56Z |15 warmups corretos excluídos+**2/900 measured**,898 unattempted;3038114/3038148 live |Gate normal native/provider passou após reparo de alias; última tentativa correta não estabelece acerto de900. |
| Desktop LocalBus V735,22:27:00Z |15 warmups excluídos+**136/900 measured**;3295193/3295224 live |Gate native/provider/GPU já passou; mesmo freeze `be108882b3024b33545f1484da00a56dccc5993e5c441b3eb3854102e7f14ac5`, LLM Vulkan e STT/Piper CPU, sem renomear como all-GPU. |

Monitor confirmou separadamente em22:28:55.252702Z os dois PIDs CPU presentes/stateS/startticks88098754/88098925 e progress15+2; receipt `.omx/evidence/orca-monitor-20261010/cpu-v737-gate-watch-20261015T2228.json`, mensagem `msg_c5a2f19b481e`. Isso é leitura de dados/PIDs, não nova execução/auditoria. Root mantém reservas de hosts físicos distintos e configurações congeladas; CPU180s/request,57600scondition/57840souter até **2026-10-16T14:19:27.058533Z**; desktop180/12600/12780 até **01:33:59.081641Z**. Teto não é ETA garantida. Próxima observação ordinária Root22:34, nudge de verdadeiro no-advance22:39, cursor91781, nenhum accepted operation pendente no receipt22:30. Ausência de resposta/observação não é exit; preservar mesmo handle, não restart/resume por silêncio.

Native Root snapshot `.git/aurora-handoff-import-20261006/native-goal-both-measuring-v739.json`497B/SHA `1ad7a8ef0afb0eefd8427a60727b622eb67b91c9251f56eaba8554d9c819d93d`: original thread `01a112a5-d6bb-74e2-bf7c-ace73cb513b5`, ACTIVE/unbudgeted. Nenhum goal recriado/adotado; full13 permanece aberto. Histórico CPU original, GPU original, áudio alterado, falhas pré-launch e warmups mantêm versões/rótulos; não pool CPU/GPU ou entradas/model/settings incompatíveis, não reauditar V692 ou repetir900 apenas por packaging. Correção de harness não transforma warmups/falhas em sucessos medidos.

### Coordenação cross-host/relay: pergunta encaminhada, capacidade ainda não comprovada

Read-only em22:19:58Z: `orca host list` retornou `forbidden` porque atua no Orca host e não pode rodar deste SSH worker. Isso é limite da superfície de observação, não host offline. Companion `emulator list` do workspace pessoal aprovado `ce8df754-5c48-4296-83bd-452a5b99942f::/home/developer/projects/aurora` retornou ok:true/running:false, receipt `84002c3f-f441-45a6-a134-c2788fb78282`, complementando devices[]. **Não identifica nem nega** emulador confirmado pelo owner em outra distrobox pessoal. Relatório `.omx/evidence/orca-monitor-20261010/approved-relay-readonly-result-20261015T2220.json`; escalada same-Run `msg_eb5e9f9e886b` pediu binding já existente host/distrobox/worktree/device e metadata Aurora origin/peer+grant aprovada, sem attach/start/SDK/access/security change.

Root confirmou em `msg_55d216acbb14` encaminhamento assíncrono das perguntas não secretas ao owner pelo canal existente; isso não comprova resposta/capacidade e não suspende baselines individuais. Não duplicar pergunta/probe ou usar account/session company. Origin cross-host, peers/grants existentes, notebook/backend/reserva, relaybinding e regiões mantêm estado não verificado até receipts reais. Depois dos selos de performance individuais requeridos e transição Root explícita: K1TTS remoto→K2TTS+LLM remoto→K3TTS+LLM+STT remoto, pipeline completa mesma tarefa/áudio/model/settings,900 measured por condição/modo/surface/par+warmups extras, stage-provider-map/ICE/telemetria correlacionada clocks próprios/recursos/denominadores. Microfone/playback/render Android bloqueiam células dependentes, não áudio headless independente; cobertura compute das superfícies não-iOS continua obrigatória. Nenhuma rede cross-device medida admitida neste snapshot.

### Novo preflight portátil real, com escopo pequeno explicitamente limitado

`thesis/validation/preflight-v738.json`1754B/SHA **`1b6a69ec0a520ecfbfee23b1916c55546cfeadfc3d12fd115bcdb07423e1e8da`** registra execução Root22:19:49.858189–22:19:49.861902Z, exit0,0newMeasuredRequests, modelsOrServicesLoaded=false, modelAvailabilityChecked=false, hardwareOrRoutesAdmitted=false. Command manual da raiz, com ambiente existente: `uv run --no-sync python thesis/preflight.py --output thesis/validation/preflight-v738.json`. Fonte4537B/SHA `838bb393f19cc979c59ebd6c09e75aeb635311f6647f69d4250213fde7aa4e3d`. Valida somente perfil/WAV e pins locais; duration0.003714228980243206s é tempo do preflight, **não** inferência/performance.

Assets pequenos reais: `thesis/profiles/padded-capital-v1.json`2813B/SHA `ab954e3b9b8e989bc5954d62b675f60b393a6f657459e1f8e0038221c1c1d110`; `thesis/fixtures/capital-padded-v1/fixture.json`1157B/SHA `27e183777f446b7ed8f860b8f0512da97a438d489e9fb60b5c00f42e71459637`; WAV219794B/SHA `da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb`,22050Hz/mono/16bit/109875frames; referenceTranscriptSHA `34b681e385feb3500c9e9849d30f5bac982716c4e4938cdb04c5fdc617cff624`. Áudio novo continua distinto do original139fa0c3. Preflight não comprova captura física/playback/LLM/STT/TTS ou modelos instalados. Monitor apenas leu receipt, não repetiu command/teste/campanha.

`thesis/evidence/custody-index-v738.json`16404B/SHA `c1aff9f6b35c44b4bab7ac516624b1d4e28b01a57af5565f449a03a6b0729279` indexa **quatro condições900 seladas**; inventário de failed/readiness/text/mesh/active ainda pendente, metadata não é nova archive audit, grandesarchives não duplicados. Snapshot completo30.35 `thesis/methodology/owner-requirements-20261015-4f558bfe.md`390082B/2092linhas/hash4f558bfe… com `CUSTODY-v737.json`590B/SHA `80e33898427245ca0f48960d26ec3f2c368f9035a9a3a70a44259afe0ceda239`; snapshot anterior intacto, Vault permanece autoridade/monitor único escritor. Root reporta Ruff direcionado e40ownedlinks pass; não representam full reproduction, full CI ou nova medição.

**`/home/developer/projects/aurora/thesis/` continua PARCIAL:** source/controllers completos e entrypoints setup/launch manuais, licenças/proveniência de redistribuição, matriz e inventário/migration map integrais ainda abertos. Requisitos30.33 continuam necessários: paths liberados antes de mover, compat pointers/frozen hashes/failure history preservados, modelos/ambiente/hardware/decoding/seed/limitações documentados, production/shared refs exactrevision/path, safe templates sem segredos/DB, grandesraw com custódia/checksum/retrieval, opt-in sem default CI/testdiscovery e sem fullrerun apenas empacotar. Análise salva+preflight são entradas portáteis verificadas em seus escopos, não alegação de setup/launch reproduzível completo.

Root FULLREAD30.35 comprovado pelo receipt `monitor-plan-section3035-root-read-v737.json`476B/SHA `4889e21d5b5e0d090fb329654b85a422f2ca22ad458dfc2799f248b534a82ea8`:12940bytes novos lidos,377142Bprefixo5a622bc7 verificado, full390082B4f558bfe às22:14:42.477628Z. Este30.36 preserva todo esse prefixo. Backup integral/after/diff/receipt e selected metadata em `.omx/evidence/orca-monitor-20261010/cpu-v737-measuring-plan-20261015T2231/`; novo ACK Root em checkpoint seguro, sem reexecutar verificações. `comparableIndividualPerformanceSealsComplete=false; distributedMeasuredAllowed=false; packagingComplete=false; full13Complete=false`; ambos native goals ACTIVE. Não há blocker global do monitor enquanto campanhas vivas progridem.


## 30.37 — V735 parcial auditado; recuperação segmentada compatível274+626, sem replay900 (2026-10-15 23:00 UTC)

**Decisão operacional explícita Root, não nova escolha pendente do owner.** Root `msg_bbd164634701`22:51:59Z identificou término real; `msg_6acddc622e44`22:56:34Z confirmou ONEaudit e compatibilidade para completar a MESMA condição por segmento distinto V745. Original Root executa/integra, monitor é único escritor do plano; mesmos Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`, projeto/branch/worktree/dirty files. Sem novo agent/Run, source edit no run vivo, reset de goal, segurança/credencial/provider/driver/CI/commit/push/PR ou tese canônica modificada pelo monitor.

**Falha e evidência preservadas:** desktop V735 terminou22:50:20.981352Z. Observação22:51:26.609389Z confirmou controller3295193/backend3295224 ausentes,274/900 medidos,626 não tentados,15warmups. `CancelledError` foi a razão do run; exceção do controller foi `FileNotFoundError` de `runtime/data/aurora.db-wal` durante `raw_bytes()` entre `is_file()` e `stat()`. Não inferir falha de qualidade/modelo. Fonte `.git/aurora-handoff-import-20261006/v742-local900-bounded-progress-RESULT.json`66639B/SHA `1ab8d3da06bdd8736d5e454d9943e32f4d9cf5f78246c63f3379ae8b9785f9df`.

Retirement real22:54:12Z: ambosPIDs ausentes, locks quiescentes/reservados para export e DB retido inalterado segundo Root. Receipt605B/SHA `f4494ea43b5475f724a26f58c48c7306c39b9fcc0f2a86c79598a1d164a85322`. **ÚNICA auditoria do parcial PASS:**273correct+1interrupted=274,0success fabricado para626unattempted,15warmups corretos excluídos. ZIP604members/10064090B/SHA `1ef1dbd55dde983aea97852dadbeebd7f5540285655a0cbbd447b73b5784db33`, original `/tmp/aurora-root-padded-local900-v735/export-v744/aurora-desktop-gpu-padded-local900-v735.zip`. Resultado salvo `.git/aurora-handoff-import-20261006/v744-local900-partial-finalize-RESULT.json`8966B/SHA `efb9fdae133e91181995c077dee0b2d24d97be58fa75f6f4627456e8298c0c75`, `savedZipIntegrityHashesAndOutcomeAuditPassed=true`. Raw/original freeze e falha intactos. **Cópia para custódia worker ainda pendente neste receipt**; não alegar receipt de receiver, apagar origem ou reabrir ZIP/auditoria fechada. Parcial não é quinto selo900; índice de retenção deve distinguir esse estado.

Reparo V743 altera somente collector `raw_bytes()`, **fora do SUT**: `lstat` de arquivo regular não-symlink; ignora exclusivamente entrada que desapareceu (`FileNotFoundError`); permission/outros I/O continuam propagando. Mantém gates de recursos/caps, runner, observer, modelos e SUT. Report1129B/SHA `6b0b3a21d6ea0145b7905248fde5a47fe1fb0b4b5b14bbec58a9aab5229e3e2f`; candidato controller `72d2ee90be2d17a3bd1615b8e1b0af9e4f08ff3b9de598f323e652441e1ddeb5`. Root executou regressão determinística isolada, exit0,0measured/sem modelo/backend/service, receipt596B/SHA `a39e8aac6ad9110473ffbcc895c761a843c33535b8259165cb2f4e5e57c710c7`,22:52:59.285742Z. SolAPP do reparo/finalizador `ade24befbe7527056d95bece3897154aa3a52436dcfb1d445c25b2c5a9df5c45`; somente delta futuro namespace/count/deadline V745 segue review finito do MESMO Sol. Nada de nova matriz de edge-cases. Monitor leu receipts; não reexecutou regressão/audit.

### Contrato explícito da MESMA condição por segmentos

| Segmento | Measured / outcome | Warmups excluídos | Estado |
| --- | --- | --- | --- |
| OriginalV735 |274=273correct+1interrupted; todos mantidos no denominador |15 corretos executados |Terminal,retired,ONEauditPASS; receivercopy pendente |
| RecuperaçãoV745 |**626 planejados**, IDs/prefixos/manifest/sourcehash próprios;0novo sucesso presumido |15 NOVOS planejados, além dos antigos; não reusar warmups |Preparação/review, **NÃO lançado** neste receipt |
| Total da condição ao completar |**900=274+626** tentativas medidas, preservando a interrupção como falha |Warmups de cada segmento fora dos quantis/denominador; total executado só após receipts |Ainda incompleto; não exigir900sucessos nem declarar900já coletados |

Root estabeleceu compatibilidade explícita: mesmas hashes de áudio/weights,400productionfiles/runtimeversions/constructors/correctness/spanobserver, rota/principal LocalBus e Gateway idle; somente collector externo reparado. Preservar comparação/manifest de ponte entre segmentos e cada raw ID, sem sobrescrever V735/fingir um único processo ininterrupto. Antes de measured1V745: freeze/namespace/sourceAPP, admissão real de recursos/locks/mesma aceleração efetiva e15warmups/gate normais. Registrar reinício, ordem temporal, setup/cold→warm e inicialização/continuidade de estado na metodologia; clocks permanecem próprios, durações por request/span, sem subtrair monotônicos de processos distintos. Reportar resultados por segmento e total compatível com mapping explícito; não pool CPU/GPU, outros áudios/modelos/surfaces/stages/dispositivos ou qualificar recovery como uninterrupted baseline. Casos interrompidos/unknown conservam motivo/denominador; quantisType7 sobre população completada identificada,Nsuccess/Nfailure/Ntimeout/Nmissing explícitos, nunca zero inventado para métrica não medida.

**Teto absoluto original preservado:2026-10-16T01:33:59.081641Z.** Recuperação não reseta orçamento total; usar saldo real antes da admissão/requests e manter180s/request/recursos requeridos. Se o saldo não permitir concluir, registrar parcial/limite real, não fabricar900/reduzir amostragem ou entrar em retries ilimitados. Não repetir900globalmente:626 são complemento justificado desta condição compatível, não waiver do contrato900por condição. Outros novos modos/superfícies/pares/stages continuam900cada, salvo baseline local reutilizado por equivalência já autorizada. V692 audit/custody permanece fechado sem replay.

Root verificou read-only que controller CPU V737 **não faz traversal `rglob`/raw-artifact-size** e não compartilha esta race. CPU permanece inalterado; monitor confirmou ambos3038114/3038148 live22:57:02.577386Z,40/900+15warmups,último correto,860não tentados. Isso não prova acerto de900. `.omx/evidence/orca-monitor-20261010/cpu-v737-progress-20261015T2256.json` é receipt de leitura/proc, não nova execução. PrazoCPU14:19:27.058533Z/freezeacbdc1d3… intactos. Root retomou a MESMA sessão após compaction, native aggregate ACTIVE/unbudgeted; não criar/resume/duplicar.

`thesis/` ganhou cinco fontes canônicas source-only via lane existente e source-lock/overlay que reconstrói12dirtyfiles enquanto388 correspondem ao basecbac78fe… (400total); isso é progresso de packaging, não bench novo/fullreproduction completo. **Setup/launch/licenças/matriz/inventário integral e liberação de paths ativos seguem pendentes**; prioridade atual é preservar parcial e recuperar condição, sem mover source/raw ativos, refazer testes/audits ou copiar grandesarchives. Metadata origin/peer/grant/Personalrelay segue pergunta Root existente, sem presumir resposta/acesso ou emulador ausente. Fase2cross-device continua aguardando selos individuais de PERFORMANCE comparável e transição Root; mic/playback/renderAndroid não são gate universal; sem iOS.

Root FULLREAD30.36 comprovado por `monitor-plan-section3036-root-read-v742.json`466B/SHA `6c4342a98c289e9f6db37662a62019f6a04b88558b3480c532e03c0e68911de2`,22:51:36.841954Z:delta10320B completo,390082Bprefixo4f558bfe…verificado,400402B/2130linhas/fullSHA8462255d… Este30.37 preserva todos400402B. Backup/after/diff/receipt em `.omx/evidence/orca-monitor-20261010/v735-segment-plan-20261015T2300/`; novo RootACK em checkpoint seguro, sem bloquear recuperação. `comparableIndividualPerformanceSealsComplete=false; distributedMeasuredAllowed=false; packagingComplete=false; full13Complete=false`; monitor/root goals ACTIVE. Nova decisão de owner não é necessária para executar o reparo/segmento já integrado por Root.


## 30.38 — LocalBus900 selado; browser V791/V792 lançado e parado antes de warmup; limite exato do CLI Android (2026-10-16, receipts até01:45 UTC)

**Checkpoint de evidência e de cobertura, sem nova metodologia ou redução de escopo.** Mantém este plano completo como autoridade do owner, monitor original como único escritor, Root original como integrador/executor e reservador de recursos. Mesmos projeto/worktree/branch/dirty files, Run `run_e6054e76e9fc`, Task `task_d7ea336050cf`, Dispatch `ctx_37b4d0a3c14f`; nenhum novo Root/monitor/Run/worker, goal substituto, commit/push/PR/CI, credencial, permissão, driver ou tese canônica. A execução autorizada continua; o ACK documental não exige parar o Root nem aguardar nova autorização para corrigir problemas técnicos dentro do escopo. iOS permanece fora da execução e do denominador, com história preservada.

### Selo da condição LocalBus compatível V735+V745 e custódia

V745 terminou naturalmente em2026-10-16T00:51:46.036410Z, exit0. Receipt `.git/aurora-handoff-import-20261006/v775-desktop-terminal-check-RESULT.json`11599B/SHA `b4fbffafd5a28328044effc6699d78251aea46d74356616836bcba29000ef688` observado00:52:56.953560Z confirma controller3312910/backend3312941 ausentes,626/626 measured corretos,0incorrect/failed/timeouts/unattempted e15warmups corretos separados. Não altera o parcial V735:274 tentativas=273corretas+1interrupção. **Total compatível:900 tentativas,899corretas,1interrupção original,0incorrect/timeouts/unattempted;15+15warmups excluídos.** Não são900sucessos nem um processo ininterrupto. O prazo absoluto original foi respeitado; não houve replay900 ou expansão da campanhaCPU.

Root executou UMA auditoria do NOVO segmento V745 em00:53:31.300983Z: PASS,641WAVs de saída conferidos,1309members; `.git/aurora-handoff-import-20261006/v775-segment-finalize-RESULT.json`8996B/SHA `9c9b43edf605d1bb8aaa8f665f73db4a6c3b2c7b28712b617f658eaa8847b9b1`. ZIP22099986B/SHA `8442f975cc23a273d10088de11357bd4eabccd15cccca11477f7c4a84c316cf2`; retirement605B/SHA `7eb0124812bd514fcffe9b0780cff21de676318209852eb67cb1c181d4f74afe`. Warmupgate registra15casos nativos e RX7600/Vulkan25/25; STT/PiperCPU, LLMGPU, não all-GPU. Artefatos brutos e falha V735 intactos. Auditorias anteriores V735/V692 continuam fechadas, sem replay.

Publicação no volume desktop foi corretamente recusada por capacidade; não se reduziu o reserve. Cópia por rota já aprovada,98304B/página e teto1800s, terminou01:16:23.674293Z:5arquivos/24138559B, size+SHA verificados UMA vez. Custódia `docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-local900-v745/WORKER-CUSTODY-RECEIPT.json`2550B/SHA `3b82b38d0a1dc446af8f6232092ee56d9be71cea6cd0d08209dd0518bb922b00`. Monitor leu receipt, sem rehash de ZIP, auditoria própria ou consumo do handle nativo66250 de Root. Root reconciliou a operação e liberou o controle antes dos próximos comandos; a cópia está FECHADA e não requer polls adicionais.

### Análise salva, uma execução, populações e limites

`thesis/analysis/join_local_segments.py`/SHA `6d5304090d091467f409ee0b1ab51e3baac53e8df0fbbe2ef452b4897d780272` executou UMA vez no desktop já ocioso,01:17:00.558657–00.926617Z, exit0/0.367907s,0models/0newMeasurements/sem repetir audits. Isso preserva a CPU worker ainda ocupada. O stdout completo excedeu a história do terminal; Root recuperou o MESMO receipt/outputs salvos, sem rerodar o analisador. Receipt compacto `.git/aurora-handoff-import-20261006/v782-saved-join-compact-receipt-RESULT.json`8007B/SHA `8df4366d1e0b21557d481aa317dcd08ee1b2f8af00d80d9cdccd1d0203140698`; receipt completo592093B/SHA `0e384cfb178501db701e98bbb67d1cefa5a4c52a794e98de90114e980cb9b6eb`.

Relatório legível e custódia derivada: `docs/experiments/tcc-20261013-submission-20261030/root/desktop-gpu-padded-local900-joined-v779/REPORT.md`3856B/SHA `09d1dc94fbb9371fd77fad89d7cd59c7413f888b90820622fcc21a58197854fd`, com `results/attempt-outcomes.csv`, `results/native-stage-spans.csv`, `results/joined-stage-history.json`, `results/summary.json`, `ANALYSIS-RECEIPT.json` e `DERIVED-OUTPUT-CUSTODY.json`. Root confirma5outputs derivados copiados/extraídos e SHA verificados; monitor leu relatório/receipt compacto, não repetiu os cálculos nem reabriu arquivos-fonte auditados.

| Condição/população declarada | N | p90 ms | p95 ms |
| --- | ---: | ---: | ---: |
| LocalBus V735+V745, corretamente completados |899|10400.2423806|10595.4863518|
| LocalBus, tempo observado de todas tentativas incluindo interrupção |900|10400.1774513|10594.9246484|
| HTTP V692, corretamente completados |854|10749.8105892|11413.8626138|
| HTTP V692, completados incluindo46incorrect |900|10779.086541|11515.7969795|

Hyndman-Fan Type7, h=(N−1)p/interpolação linear; warmups fora. Tempo de interrupção não vira resposta corretamente completada. Comparação descritiva do mesmo áudio padded/modelos/settings, não custo causal puro de protocolo: reinício, repetição de warmup, inicialização/ordem temporal/carga/termal e populações de corretude distintas continuam explícitos. Não pool CPU/GPU, áudio original/padded, hardware/modelo/surface/stage distintos; sem promessa de speedup do fraco ou mesh ainda não medido. p50/p99 e demais tabelas originalmente exigidas continuam no checklist de consolidação; este recorte publica os p90/p95 comprovados, não inventa os demais nem exige rerun para deriváveis dos dados salvos.

Cinco handlers exatos têm900spans pareados válidos cada,0missing/multiple/invalid, incluindo estágios completados do request global interrompido: `resolved_chat_model.astream`, `Transcription.Transcribe`, `stt.model_invoke`, `TTS.Synthesize`, `tts.model_invoke`. Pareamento por caso/correlação/receiverPID/clock, duração dentro do próprio processo; não somar quantis nem subtrair monotônicos entre processos. Isso não prova900pipelines corretos. IDs operation/attempt ausentes em LLM/wrappers; request/session STT/TTS ausentes nessas fronteiras, com todos denominadores no summary. Queue wait/TTFT/first-streamed-audio/playback continuam null+motivo; não zeros nem prova de captura física/audibilidade/UI/Android/cross-device. Os stage quantiles exatos permanecem no relatório/CSV, sem reclassificar outcomes dos audits.

### Browser: preparação, tentativa real e término conhecido — não confundir com gate passado

Upload dos11inputs/9passos terminou01:30:18.972593Z, sem runtime; primeiro upload aceito recuperado, sem replay. V787 foi recusado ANTES de criar runroot/runtime às01:31:24Z por `inventory_root_missing_or_symlinked`. Root verificou read-only o alias V472 existente para `/dev/shm/aurora-root-accurate-base-v443/web-next-output-v472`, mesma identidade source/build; V789 corrige somente binding canônico, mantendo V772 e preflight falho. SourceAPP pelo mesmo Sol, prefixo744905b4, não nova matriz/pilot ou mudança de modelo/áudio/settings/build. Não inferir produto/modelo ausente ou causa de qualidade.

Freeze REAL V791 exit0 em01:41:55.643313Z; `.git/aurora-handoff-import-20261006/v791-browser-actual-freeze-RESULT.json`871B/SHA `8196e88257bf7324eb9ab0121326317c22b6b82e90d4f885a26b08807c2c82df`. `/tmp/aurora-root-padded-browser900-v704/frozen-manifest.json`312693B/SHA `7f00c037ea241403bf9194e70f8b452266c185379b1a9362dd867b356c240a1d`, inputda0ecc4a…219794B;900measured+15warmups,3predecessors. Freeze por si não lançou runtime. Spawn REAL separado01:42:39.437013Z: controller3409829/startTicks74326789, hashcontroller `68096214890bbab8353ba6b1a13743789e54212996cc26fae685cb03fe489f99`; `.git/aurora-handoff-import-20261006/v792-browser-actual-spawn-RESULT.json`442B/SHA `1fc1c23083f9829a7ef42255c48048f42532be095fb5c3b6f3b35bcbf00dbe5f`.

**Observação mais forte substitui a alegação apenas de launch:** `.git/aurora-handoff-import-20261006/v792-browser-first-observe-RESULT.json`2230B/SHA `532a562e06c969be2ed3e590db9b373d7a6c5e7f5771cc0a055446e98c9d3b0a`,01:42:55.088257Z, já contém término01:42:52.019450Z/driverExit1 e ausência dos4PIDs controller3409829/web3409860/backend3409861/driver3409927. Browser fechado/profile removido. Campaign `stopped`, `fatalStop=operation_failed`,0/15warmups/0passed,0/900measured/0success/0incorrect/0failed-measured,15+900unattempted. **Nenhum gate native/provider/GPU ou aceitação900 browser comprovado.** Serviços chegaram a ready, mas isso não prova full audio flow. Não inferir0model-loads apenas de0requests, nem qualidade de STT/LLM como causa do erro genérico. Monitor enviou correção `msg_1f36b0e69333`01:45:58Z; Root deve fazer diagnóstico finito do PRIMEIRO erro concreto/runtime e reparo necessário, sem retries idênticos/matrizes ou pedir escolha de fixture/modelo para erro de harness. Manifest/source/raw/falha preservados; futura tentativa tem receipt/identidade/namespace e admissão verificáveis, sem sobrescrever este freeze.

Esta família continua browserUI→HTTPloopback→backend desktop, input de arquivo via Chromium file-mic, STT→LLM→TTS reais esperados com reply/WAV e playback de software quando medidos. Não é mic físico, inferência local do browser, API deployed/cross-host ou mesh. Mesmos áudio/weights/settings efetivos precisam permanecer explicitamente mapeados; newfreeze não autoriza qualquer substituição silenciosa. Caps declarados180s/request,57600s/condição,57840s/outer e recursos/gate15normais continuam, sem nova pilot extra nem900success quota. Backend esperado híbrido: LLMRX7600/Vulkan25/25 e STT/TTSCPU, somente gate real pode confirmar a execução desta tentativa.

### Capacidade Android e checklist restante, sem gate universal

Receipt Root `.git/aurora-handoff-import-20261006/v789-approved-adb-use-capability.json`25966B/SHA `0d270f016dc3246c3f1a93e986b55dd4e6ec0661220e807bbb742075119bacf3` registra code-worker,01:34:25.555865Z, comando EXATO `/home/developer/.orca-relay/bin/orca adb use --help`, exit1/`Unknown command: adb use`, handshake0.1.0+5cdca4731a41. Leitura do MESMO stdout retido anuncia apenas MobileEmulator(iOSSimulator); não anuncia Android/ADB. Não prova ausência de rotas ocultas, SDK, emulador ou device, nem foi device-test. Root reportou mesma recusa no segundo `.local/bin/orca`; não reivindicar receipt independente dessa segunda chamada. Nenhum attach/select/install/update/acesso/credencial/segurança alterado. Emulador pessoal confirmado pelo owner continua existente conforme autorização; binding/rota suportada e owninghost real permanecem questão anterior pendente, sem repetir perguntas/probes ou executar iOS. Capability gap depende de Android, não bloqueia outras células válidas de performance.

- **Fechado:** V692HTTP900 audit/custody; V735partial+V745626 audit/custody; uma junção900 compatível e derivados. Esses audits/análise não devem ser repetidos. V485/V497 de áudio ORIGINAL e V491CPU-extra permanecem comparações históricas separadas.
- **CPU padded obrigatório ainda vivo/incompleto:** monitor01:44:34.490679Z confirmou258/900,15warmups e3038114/3038148 com startTicks88098754/88098925 inalterados, último correto;642unattempted. Freezeacbdc1d3… e deadline14:19:27.058533Z intactos. Não estender/migrar/resetar campanha nem declarar CPU900 pelo contador parcial.
- **Browser:**900planejados,0medidos nesta tentativa parada; diagnóstico/reparo finito e nova evidência de admissão/execução/gate, depois coleta requerida. Outras superfícies não-iOS aplicáveis conservam cobertura por surface/requester/provider/rota/workload com model/source/app exatos e estado separado; headless não substitui todas superfícies. Mic/getUserMedia/playback/renderAndroid bloqueiam apenas células dependentes, nunca viram gate geral para performance válida.
- **Transição ainda não autorizada por conclusão:** CPU comparável e performance individual aplicável não estão todos selados; Root precisa de transição explícita. Nenhum tráfego cross-device medido agora. Depois: localPython/APIreal e P2P cumulativo TTS→TTS+LLM→TTS+LLM+STT,900MEASURED por cada condição aplicável/surface/par, warmups extras, falhas/timeouts no denominador, equivalência de baseline local só quando provada. Same-host/loopback não aceita deployed/cross-device. BR/PT/US/M dependem de identidades/capacidades/país verificados, sem região inventada.
- **Instrumentação e cargas:** manter stage_provider_map esperado+observado, requester/provider/case/span/correlation, clocks pareados com incerteza, setup/discovery separado de warm dispatch, queue/inference/render/history/audio quando expostos e missingness explícita. TelemetriaCPU/GPU/VRAM/RAM/storage/network/termal por dispositivo e ICEreal direto/relay; fases de carga/concurrency/local-user+mesh declaradas e distintas de referência descarregada. Sem preencher limites não medidos ou começar nova matriz de edge-cases.
- **Packaging:** `/home/developer/projects/aurora/thesis/` continua PARCIAL. Novas fontes/analyser/modelmetadata são progresso, não prova de setup/launch portátil completo. §30.33 continua exigindo manual opt-in sem defaultCI/testdiscovery, reprodução/setup/modelos/hardware/seed/decoding/nondeterminismo, mapa completo de migração/retained-evidence index, safe templates/licenças e hashes/retrieval dos grandesraw. Paths de custódia/docs acima são compatibilidade histórica até Root liberar leitores/escritores e integrar a consolidação; não mover source ativo, duplicar grandesZIPs ou tocar credenciais/DB/manuscritoTCC. Gaps de proveniência não justificam parar coleta já autorizada quando não são dependência real da execução.

Esta adenda preserva todos408357B/2159linhas anteriores/fullSHAb78c0c8e… como prefixo byte-exato. Backup completo/after/diff/receipt e referências em `.omx/evidence/orca-monitor-20261010/sealed-local-browser-plan-20261016T0147/`; verificação documental por hash/prefixo/seção única, sem executar testes/benchmarks/audits pelo monitor. Root deve ler delta integral em checkpoint seguro e confirmar novo hash, mantendo execução autorizada. `comparableIndividualPerformanceSealsComplete=false; distributedMeasuredAllowed=false; packagingComplete=false; full13Complete=false`; Root e monitor nativos continuam ACTIVE. Prazo owner2026-10-30 America/Sao_Paulo/cutoff exato desconhecido permanece; nenhum resultado foi convertido em tese final ou submissão.


### 30.38.1 — Causa concreta recebida e capacidade Personal verificada, sem repetir execução (2026-10-16 01:54 UTC)

A causa estava desconhecida no primeiro receipt de término acima. Nova evidência substitui esse desconhecido: Root `msg_8fd17baa81a6` criado01:46:02Z, recebido/reconciliado pelo monitor em replay01:52:06Z, identificou uso inválido de `--user-data-dir` com `chromium.launch`. O monitor leu o receipt instalado `.git/aurora-handoff-import-20261006/v794-playwright-installed-source-RESULT.json`3936B/SHA `d4ecc7286bc97b197ba7fa5d21d72cb1ea125c7a5d01365f826d5e34cd14239e`, observado01:44:57.639137Z no mesmo desktop: Playwright `1.57.0-beta-1764944708000`, fonte `lib/server/chromium/chromium.js`279 rejeita explicitamente o argumento e `lib/client/browserType.js`52/75 e `lib/server/browserType.js`292/298 indicam `launchPersistentContext(userDataDir, options)`. Não é inferência de falha STT/modelo/qualidade. Root confirmou4PIDs ausentes e amboslocks livres no v793; não interrompeu processo.

O reparo continua limitado à API de lançamento/perfil e NOVO namespace V794, pelas mesmas lanes Luna/Sol e Root integrador: preservar V791/V792/falha0warmup0measured, mesmos input/modelos/settings/predicados/900+15/caps. Review/source closure, novo freeze e receipts de execução devem preceder alegação de gate/medição; esta adenda não diz que o reparo já rodou nem pede owner para escolher modelo/fixture diante de erro de harness. Nenhum teste/pilot/campanha/audit/analisador foi repetido pelo monitor.

A chamada read-only no Personal também foi verificada, não apenas no Coding-worker: `.git/aurora-handoff-import-20261006/v794-personal-orca-adb-help-RESULT.json`25926B/SHA `3031a65fb5a5eeb5156edda0ef5627d405f578dc853e533745ef47ffc2598d81`, host `personal.skyron-server`,01:46:22.161102Z, PATH existente resolveu `/home/developer/.orca-relay/bin/orca adb use --help`, exit1/`Unknown command: adb use`, mesma versão0.1.0+5cdca4731a41. Escopo é somente help/capacidade instalada, sem attach/select/test/install/config/security/access change, sem bypass host-only. Continua NÃO provando emulador/SDK ausente ou rota oculta impossível. A questão anterior de binding/rota Personal permanece pendente, sem novas perguntas/probes idênticos; a limitação afeta células Android dependentes, não vira bloqueio geral para performance válida.

Este follow-up preserva também todos422796B/2212linhas/9072c001… como prefixo byte-exato; backup/diff/receipt adicionais em `.omx/evidence/orca-monitor-20261010/cause-verification-plan-20261016T0154/`. Root pode confirmar leitura cumulativa de30.38+este trecho no hash atual, sem testes nem reexecução da análise fechada. Mesmo objetivo/lineage/roles, ambos nativegoals ACTIVE.


### 30.38.2 — V794 real: um warmup audio-to-audio completo, segundo capture falhou;0/900 measured (2026-10-16 02:02 UTC)

Root comprovou FULLREAD de30.38 em01:52:45.790377Z: `.git/aurora-handoff-import-20261006/monitor-plan-section3038-root-read-v796.json`489B/SHA `34be428e54835adbf44ef5a5d839b5d5a98908b8d03d93ca397d11416835d9c8`,delta14439B/913041e9… integral,full422796B/9072c001… e408357Bprefixob78intacto. ACK das adendas posteriores depende de leitura cumulativa atual; não considerar aprovação de guidance como execução nem bloquear o Root pela documentação.

O reparo de lançamento persistente foi sourceAPP pelo mesmo Sol/SHA `33b0094bff0570dd7d4bbad0ec85989233800545d6d215de18cb04172dae5014`; fontes canônicas `thesis/harness/browser-ui-v794/`. Freeze REAL em01:52:49.108860Z,exit0: `.git/aurora-handoff-import-20261006/v796-browser794-actual-freeze-RESULT.json`871B/SHA `07472218a94cca0284eae4ffe65a4a4e290fcfae8c8ce6de1e01b3f348c4af99`; NOVO `/tmp/aurora-root-padded-browser900-v794/frozen-manifest.json`312693B/SHA `dd5c142e700cd4f19e064f07790b0f15aacf56db49a70bdfc7ea7b699cc1b437`. Controller11a0f3aa4df927af88e2b94fb879dfe4ca70d5d90dfd33b4c73618536ba22676,stagerd26ade38…,driveraafc4b24…; mesmas tarefas/áudio/modelos/settings/predicados,900+15 e caps, sem editar run anterior. Spawn REAL01:53:07.846276Z/controller3413562/startTicks74389630; receipt `.git/aurora-handoff-import-20261006/v796-browser794-actual-spawn-RESULT.json`442B/SHAd9966cfd935b9a1399943dab298e2070a5afbc554884018059bcd52200907cc4. Ready01:53:16.980597Z; primeira observação01:53:37.501274Z confirmou4PIDs vivos, mas esse estado foi depois superado pelo término.

**Estado mais forte:** V794 terminou naturalmente01:54:12.553415Z/driverExit1. `.git/aurora-handoff-import-20261006/v797-browser794-ordinary-observe-RESULT.json`2622B/SHA `def08fa2c67990c56c12d02d6ae6832fd55acdd6b3bb0280d5d1db7b00408647`,01:55:43.370003Z, registra controller3413562/web3413593/backend3413594/driver3413657 ausentes, browser fechado/profile removido,2warmups tentados/1pass,13não tentados,0measured/0success/0incorrect/0failed-measured,900measurednão tentados. Não é campanha900 coletada nem15warmups/gate aprovado.

Root `msg_43d150768857` e diagnóstico salvo `.git/aurora-handoff-import-20261006/v797-browser794-second-case-failure-RESULT.json`17429B/SHA `997de303064db690bef907342e2fabfde75f8594bac92a8d022396e8d3fe184d`,01:56:15.902754Z, confirmam amboslocks livres/4PIDs ausentes. Root reporta PRIMEIRO warmup `FULL_FLOW_PASSED`/13checks: STTreal/exactquestion→LLM/Parisvisível→TTSreal/WAVválido/softwareplaying-ended. Esse N1excluído é readiness real, não900medidos, captura física/audibilidade ou aceitação de repetição. Segundo warmup falhou `capture_started` após25681ms: getUserMedia2sucessos e AudioContext/worklet iniciados, mas0PCMcapturado/0STTrequests; TimeoutError/operation_failed. O fix de launch funcionou, porém causa subjacente da segunda captura AINDA não foi estabelecida. StopListening após5483ms é hipótese de Root, não conclusão; não inferir Whisper/modelo/transcrição ruins nem substituir áudio/predicados para esconder falta de input.

Próxima ação já autorizada: MESMA Luna faz diagnóstico finito do fluxo repetido/fonte; MESMO Sol verifica fatos oficiais Chromium fake-file/noloop; Root integra apenas correção fundada em evidência, nova tentativa/manifest/recursos e gate normal quando pronto. Repetir a voz no segundo turno é fluxo principal, não nova matriz de edge-cases. Não refazer audits/análise/headless900 nem iniciar retry idêntico ou rebaixar contrato de mesma tarefa/modelos/settings. Preservar V704/V794/manifests/primeiro sucesso/falha de captura; mudanças de fixture/modelo/settings seguem a regra versionada e comparação afetada, nunca pooling silencioso. Android/CLI não é causa demonstrada desta falha browser nem gate universal.

Este checkpoint preserva integralmente425562B/3334a2d7…; backup/after/diff/receipt `.omx/evidence/orca-monitor-20261010/browser794-outcome-plan-20261016T0202/`. Demais requisitos30.33/30.38 permanecem, ambos nativegoals ACTIVE; Root único executor, monitor único escritor; CPU segue campanha congelada e cross-device medido continua aguardando os selos individuais de performance e transição explícita.


### 30.39 — Correção expressa do owner: padding não exige novo CPU900; transição distribuída por performance/isolações concretas (2026-10-16)

Esta emenda SUPERA interpretações anteriores30.34–30.38.2 que tornavam CPU com padding, qualquer superfície/UI ou todos os13stories um gate global adicional. Leading/trailing silence é detalhe menor de entrada/captura: reter WAV/hash/duração e fronteiras factuais, mas padding sozinho NÃO justifica novo full900/coorteCPU obrigatório. V491900 original já está selado e continua válido. Nenhum novo full coding-worker/CPU900, restart, top-up ou repetição automática sem razão concreta documentada de validade/cobertura. Sem subtração/pooling silencioso de tempos ou exclusão de números ruins.

V737 foi introduzido historicamente para comparaçãoCPU com inputpadded exatamente igual ao desktop; isso não prova necessidade científica adicional após esta correção. Preservar campanha saudável congelada, sem interromper/parar/migrar/alterar. Ao02:15:11.847811Z havia299/900medidos,15warmups extras, owners3038114/startTicks88098754 e3038148/88098925 vivos. Prazo original14:19:27.058533Z inalterado; taxa recente285→299/638s sugere término aproximadamente09:30–10:30Z se mantida, previsão incerta, NÃO ETA de distributed. Root deve declarar quais recursos físicos/reservas ativos realmente conflitam com o primeiro par; separar esse conflito da alegação de padding como gate.

Selos já concluídos: CPUV491900; desktopLocalV735+745900attempts/899corretos/1interrupção original; desktopHTTPV692900attempts/854corretos/46incorretos. Conservar raw/hashes/warmups/populações de percentis e limitações; não repetir audits/análises/pilots/reviews de evidência fechada. Mantém-se regra original de DUAS FASES: Root explicita quais selos individuais de PERFORMANCE comparável satisfazem a barreira e quais isolamentos atuais realmente impedem iniciar o par; nenhuma expansão nem dispensa silenciosa.

BrowserV794:1warmupfullaudio bem-sucedido e segundo warmupfalho no capture/StopListening antesSTT;0medidos/900nãoexecutados. N1 não aceita repetição900. Possível raceCreateSession/reset que cancela captura identificada em source, causalidade exata ainda não provada; diagnóstico finito específico. Cobertura browser de performance continua requerida, mas captura/mic/UI/playback/renderAndroid/product fixes, thesis packaging, reviews genéricos e13stories NÃO bloqueiam universalmente células distribuídas suportadas de fileaudio→STTreal→LLMreal→TTSreal→áudioválido. NãoiOS.

Checklist finito durável `.omx/evidence/orca-monitor-20261010/phase-transition-20261016T0216/CHECKLIST.md` SHA400383120c0080ca6258dd13da8dbe367aa8225ee39b17dc9950609dc4ee3ac2 contém selos, reservaV737, primeira célula e readiness pendentes. Root deve responder agora: primeiro requester/provider autorizado+surface+TTS-only, endpointHTTP ou meshpeer/grant/session/provider realmente observado, stage_provider_map completo, spans correlacionados requester/provider/clockdomains/setup-vs-warm, recursos/network/ICE, limites finitos e dependência exata; source-ready/SSH não prova execução. ETA distribuída permanece desconhecida até tais fatos, sem launchfabricado. PedidoOrca originalRun msg_dab3f5b9d92b02:15:29Z enviado; ACK/resposta desta correção pendente, não inferida de mensagens anteriores.

Ao terminar isolamento necessário e admitir rota/instrumentação concreta, Root faz transição explícita para TTSremoto → TTS+LLMremotos → TTS+LLM+STTremotos, demaisestágioslocais/mesmofullpipeline/modelos/settings,900MEDIDOS por condição aplicável/par/superfície, warmupsextrasexcluídos, p90/p95+métodoquantil/denominadores de erro/timeout. Não inserir pacoteTCC, Androidproduct, source review genérico ou CPUopcional como novosgates. Root único integrador/executor, monitor único planwriter, mesmoRun/goal/branch/worktree; nenhuma execução/teste/source/segurança/Git foi alterada por esta emenda.


#### 30.39.1 — ACK real Root e primeira célula nomeada; execução ainda não admitida (02:18–02:19Z)

Root msg_d396cba17600 criado02:16:40Z/recebido02:18:17Z CONFIRMA correção owner: nenhum CPUrepeat/topup por padding, sem gate universalbrowser/Android/mic/package/13stories, V737 extra sob antiga30.34 preservado, desktopLocal/HTTPfechados. Não é ainda FULLREAD da30.39. Primeiro alvo concreto: coding-worker HEADLESS/native requester→Personaldesktop TTSprovider, K1HTTP POST`/api/TTS/Synthesize`, TTSremoto eSTT/LLMlocais;900medidos, warmupsextras. DepoisK1mesh separado: falta de peer/grantmesh não bloqueiaHTTP admitido. NÃO lançado; faltam origemHTTPcrosshost real+auth/permissionexistentes, adapter executável ejoincorrelacionadorequester/provider. Root prepara source desse alvo; nada de tráfego medido competindo com baselines.

Root reporta V799 browser realmente lançado02:11:57Z,4ownersvivos02:14,6/15warmups6pass/0fail/0medidos; não apenas source-ready nem900aceito. Primeiro par reutiliza hosts ocupados porV737 eV799; requer disposição concreta de reservas/isolações porRoot sem interromper sessões, sem transformar padding em necessidade científica. PrevisãoV73709:30–10:30Z continua condicional, NÃO launchETA. Browser falho continua específico, e nenhum CPU900adicional deve seguir automaticamente.

Checklist inicial40038312… preservado como `.omx/evidence/orca-monitor-20261010/phase-transition-20261016T0216/CHECKLIST-initial.md`; checklist com respostaRoot `CHECKLIST.md`8598B/SHA4eb44c4cf750b6eb59d995f052c987b4f6fdfb66f882b55e68be4b29fccf8654, receipt `root-response.receipt.json`. Assim a referência histórica30.39não perde seu conteúdo original. Resposta exata de reserva/barreira eFULLREADlatest ainda pendentes; nenhuma autorização/grant/launch inferido.


#### 30.39.2 — Resposta EXATA Root: barreira científica satisfeita, conflito físico específico permanece (02:33–02:35Z)

Questão originalmsg_835c859e432d RESOLVIDA pelo answerOrca msg_08c81d1d5039 às02:33:29Z, receipt `.git/aurora-handoff-import-20261006/v806-reply-original-transition-question.json`7754B/SHAd7d1ea6f904083c7da9bbb0eca84d956e35557f3638690eea689e1a291580a02. Root confirma V491CPU900+desktopLocal900/HTTP900 já satisfazem os selos individuais existentes; NENHUM baseline individual adicional é obrigatório antes do primeiro par HEADLESS/fileaudio. V737 é comparação SUPLEMENTAR, não obrigação científica nova. BrowserV799 é900própriosurface, não gate universal; se naturalmente falhar/retirar, cobertura900segueaberta mas host liberado podeadmitirK1. Nenhum terceiro par livre realmente admitido foi verificado.

Este primeiro par específico requer AMBOShosts naturalmente liberados: V737usaCPU/RAMworker paraSTT/LLM/TTS medidos; V799usaCPU/RAMdesktopSTT/TTS eGPU/VRAMLLM. MesmoPiperCPUremoto competiria com browserSTT/TTS; executarSTT/LLMrequester competiria comV737. Esse é conflito físico comprovado de colocação, não padding nem nova exigência científica; sem parar/interromper campanhas. Preservar regra de isolar baselines. Após release eadmissão concreta, transição executável sem inventar UI/Android/package/13stories/CPUrepeat.

Primeira célula PLANEJADA, NÃO medida/lançada: workerS-Nheadless→Personaldesktop K1HTTP`POST/api/TTS/Synthesize`, mapa esperadoSTT=workerCPU/LLM=workerCPU/TTS=PersonalPiperCPU,900medidos+15warmupsexcluídos. HTTPICE=N/A; mesh exigepeer/grant/session/ICEpróprios, nunca bloqueiaHTTPadmitido. Ainda faltam origemGatewaycrosshost real/reachability/identidade+permissionexistentes, controller/bootstrap/freeze e15warmupscomreturnedservercorrelations pareados comreceiverTTS/modelspans/PID/source/model/hardware; clocks próprios/missingness, sem IDsforjados/subtraçãocrossclock. Requester sourceAPPa679a690/runner45d2c3f4/adapter81a44fb0 é fonte aprovada, não readinessruntime. Janela09:30–10:30UTC continua previsãoV737+sealing SEdesktopliberado/rota+instrumentaçãoadmitidas, NÃO launchETAfixa.

Root FULLREAD435740B/257fded… verificado em `monitor-plan-section30391-root-read-v806.json`449B/SHAae3f24378e34ee52800e59b2e97332b8969ee6521a744c15dd156e451e1fac01:02:32:38.234910Z,10178Bnovos lidos/prefix425562B3334inalterado. Resolução e backup/diff completos em `.omx/evidence/orca-monitor-20261010/phase-transition-resolution-20261016T0235/ROOT-ANSWER.json` e`ROOT-ANSWER.md`; substituem estados de resposta/ACKpendentes anteriores. BrowserV799latest60/900corretos/0falhas+15warmupsàs02:34:06Z,4PIDsoriginaisvivos, coleta congelada preservada. Demais escopo/lineage/900porcondição/sem iOS inalterados.


### 30.40 — Admissão K1 sem circularidade: binding/recursos antesstart, proofreal nos warmups; SourceAPP não é launch (2026-10-16 03:12Z)

Root msg_7eda659c4b0a03:12:05Z reporta provider818APP e integrated822/requester+provider/resources source823APP3dccb56f concluídos; são SOURCEONLY, sem runtime/listener/model/test/newnetwork. Autoridade owner de TESTDEPLOYMENTnecessário já cobre preparar serviço no MESMOhost/identidade Personal. Exigir ANTESstart: bindingprivadoaprovado/config/auth/source/model/resourcepins congelados, porta/interface realmente admitidas e reservas físicas liberadas. Exigir DEPOISstart: HTTP/auth/TTSreais ecorrelação requester/provider nos15warmupsnormais, antes medido1. NÃO exigir Gateway novo já vivo antes de permitirstart; NÃO apresentar sourceapproval ou candidateaddress como reachability/runtimeaceito. Sem rodada extra de pilot/review de evidência fechada.

Candidato futuro explicitado porRoot: interfacePersonalexistente100.64.0.3/API8000; aindaNÃOadmitido/reachableprovado/lançado, freshfreebinding/resources/exactconfigauthpendentes. SóbindingAurora confirmado127.0.0.1:55741. DoisTCP22refused já retidos não provam ausência dehost/todosports. Não repetir probes inalterados nem inventar tunnel/proxy/hostlistbypass. `orca host list` emSSHforbidden temreceiptv816; reutilizar, sem criarhost/client/worker, firewall/Tailnet/account/grant/credentialchange. Env atual sem hostedfixturekey não é ausência da credencial; Root localiza bindingprivado V692existente, nunca novo segredo/key/report de valor.

Telemetria naSource: CPU/childRAM/networknamespace/AMDcontext; validação real ainda futura. Payloadtotal fornecido pelo adapter não é persistido pelo runner inalterado: limitação explícita/unknown, nunca0 ou claim de cobertura completa. Clockdomains/IDs/requester+receiverstage_provider_map/missingness permanecemcontrato. K2/K3typedHTTPadapterSource819pronta, NÃOcomposta/gated/lançada; não substitui cumulativosmeshK1→K2→K3 nem900MEDIDOS por condição/par/surface aplicável, warmupsextras. Cientificbaselinejá satisfeita porV491+desktopLocal/HTTP; V737extra eV799owncoverage/ocupaçõesfísicas preservados. No iOS/globalUI/package/13stories/CPUrepeatgate.

Receiptdurável ebackup/diff `.omx/evidence/orca-monitor-20261010/k1-admission-20261016T0313/admission.receipt.json`; mesmaRoot/monitor/Run/task/dispatch, nenhum Sourceedit/test/runtime/network por monitor. Atualização coalescida de admissão, não novo gate de permissão ou pedido owner. Root nextmetadata03:15/watch03:20.


### 30.41 — Registro existente de aplicabilidade: duas campanhas ativas não são o total da matriz (2026-10-16)

PedidoRoot msg_e9d24c7ec6d5 reconciliado nos MESMOS IDs§14/§26.3, sem condição nova/waiver/cartesiano/gate extra. Registro completo `.omx/evidence/orca-monitor-20261010/surface-applicability-20261016T0353/REGISTRY.md` (hash no registry.receipt.json); Root promove cópia exata à matriz canônica thesis/ sem escritor concorrente. São EXATAMENTE2campanhasmedidas atuais, V737CPUextra eV799browsercliente/server-offload, com finalização natural+umseal; ZERO novos baselines científicos obrigatórios antes do primeiro S-N. V491+desktopLocal/HTTP900 jáselados, sem repetir/topup/audit. Restam4famíliasexistentes NÃOadmitidas, e totalexpandido de células elegíveis NÃOestabelecido:

| Registro existente | Boundary ainda não admitida | Evidência específica pendente; nunca gate universalS-N |
|---|---|---|
| C06/S-DL desktopTaurilocal | Mesma ação desktop porlocal/API/mesh | App/build/source/runtime role reais+fileaudio→STT/LLM/TTS→áudioválido/modelos/mapa/spans; headless não viraTauriporrenomeação |
| C06/S-DC remote-console | Console→server/homepeer; local condicional | Cliente/profile/role/rota+autoridadeexistentes, fullpipeline/mapa; provarcapacidadelocal ou registrarunsupported/infeasible, não inventar backend |
| C07/S-B on-device e rotas separatehost | Compute browserlocal; V799 não o prova | Engine/modelos/assetseexecutadosnoprópriobrowser ou evidênciacondicional; APIdeployed/meshpeer reais emrowsremotos, sem mocks/surfaceoverride |
| C08/S-A Waydroidnative/WebView | App/ABI/engine e local/API/mesh | RelayADBaprovado/reservaRoot+appsource/modelos/mapalocalidade/spans; CLIgap não é emulatorausente; phonebattery/thermal/radio sóM-Pverificado |

C05nativeengine/crate continua distinto deAssistant/fullflow; demaisdireçõesBR/PT/US/M e geografias/capacidades desconhecidas preservadas. Aplicabilidade usaexecuçãoreal/modelo/role/rota, não permite reduzircobertura nem gerar900sucessos quando impossível. Mesmas famíliasK0/K1/K2/K3HTTP/P2P/load/recovery/privacy jáautorizadas,900MEDIDOS porcondiçãoaplicável+warmupsextras/caps/denominadores/p90/p95, sem pooling; iOSexcluído. UI/render/mic/playback/history bloqueiam sóclaimsdependentes; registrarmissingness quandoexposto, não bloquearfilecomputeválido. PrimeiroS-NK1HTTPworkerSTT+LLM→PersonalPiperTTS aguardaapenasreleasesfísicosespecíficos+admissãobinding/config/auth/source/model/resources e15warmupsreaispósstart, depoismeshK1→K2→K3. Nenhuma famíliaacima vira baselineglobal novo.

Originalbinding API692 RESOLVIDO porRoot antes da receita posterior do monitor: v832redactedmetadata1148B/SHAd7848e597a32144e3f6809eb99c986ba9b0e781a4160137befe5ba40a49e344e mostra input/launch-config.json privado existente com1key/fingerprint igualfixtureV737, versusruntime/config.json0keys. Nenhumvalor foi extraído/enviado pelo monitor, nenhumcredentialnovo; msg38ae fechado, sem decisãoowner. Source403inventário/v826falhaanteswrite reconciliado. Sourceaprovada/staged continua NÃOlaunch/runtimeaceito. FULLREADRoot30.40verificado; novasreceipts não autorizamreplaySource/benchmark. MesmoRoot/monitor/Run/branch/worktree, nenhumSourceedit/test/runtime/network/worker por esta reconciliação.


#### 30.41.1 — C07 mantém mobile browser explícito

S-MB já está em C07 (§26.3), como subcaso browser/mobileWebView distinto deS-BdesktopV799, não nova família/condição. Registry.md agora explicita device/browserreal+capacidadelocalcondicional/API/mesh/mapa/spans; viewportphone/debugoverride não é execução mobile, Waydroidco-localizado não vira crosshost/phone/radio. Nenhuma cobertura removida/nova, nem gateS-N. registry.receipt.json registra hash corrente e REGISTRY-initial.md preserva o primeiro conteúdo. Root promove somente versão corrente completa.


### 30.42 — C06: capacidade de source não é ingresso/runtime admitido; nenhum gate extra S-N (2026-10-16)

Receipt Root `msg_562ac8bdb5c7` (05:01:20Z), FULLREAD/ACK `delivery_162494d81a4b`, fornece a revisão condicional `thesis/matrix/desktop-surface-source-capabilities-v884.md`, **11481B/SHA256 `6808510a606c36509fcc7e78d2abad18ffedaadf1c33e0198966a663e2659912`**; conteúdo completo/hash conferidos pelo monitor. É mapa de source com pins, NÃO teste/runtime/modelo/dispositivo admitido. As seis linhas do relatório refinam **C06/S-DL+S-DC existentes**; não criam condições/contagem, waiver, novas engines, ingressos presumidos ou baseline obrigatório antes do primeiro S-NHTTP.

- PTT desktop nativo usa **CPAL** e start/finish nativos; fake-WAV do Chromium e debug square-wave não provam ingresso do áudio congelado nessa captura. Falta admitir ação real/handle do app com WAV controlado suportado, ou ação finite-audio SDK exercida pela superfície desktop real. Gateway headless/sidecar sozinho não conta como desktop app; microfone físico permanece evidência separada.
- Rotas SDK STT→Assistant→TTS locais/API/mesh são condicionais a app/build/profile/runtime/servidor/autoridade efetivos. Desktop console-only não fornece Python/faster-whisper/llama.cpp/Piper local automaticamente; conservar unsupported/infeasible quando essa capacidade faltar, sem trocar modelos para fabricar comparação.
- Selecionar mesh para STT/TTS nativos não prova LLM mesh: no caminho nativo inspecionado, Assistant ainda usa Gateway. Cumulativo K3 só é claim com **stage_provider_map e spans reais de cada stage**; não supor all-three-stage exact-peer pela UI. Isso não elimina K1→K2→K3 exigidos nas rotas/superfícies aplicáveis nem autoriza desvio de conta/grant.
- Native Gateway STT default é realtime; o caminho accurate e pesos BASE precisam identidade/runtime efetivos. Gateway TTS depende do Piper default real do servidor; pack nativo/Piper label não prova o CLI congelado. Binding STT e pedido TTS nativos usam **16kHz**; registrar conversão/preprocessing versus file input22.05kHz, sem alegar bytes idênticos por igualdade de pesos. Validar áudio PCM não vazio/não silencioso e output real; WAV estrutural sozinho não prova acústica/playback/first-audio.

Esses itens permanecem **admissão específica C06**, não razão para atrasar S-N file-audio suportado. Reafirmados pelo Root: selos científicos V491+desktopLocal/HTTP já suficientes, V737 suplementar sem repeat/topup, releases naturais dos dois hosts selecionados + startup autorizado/HTTPauth/15warmups nativos correlacionados antes do primeiro900. Nenhum novo source review/test/pilot/campanha/model/backend/driver/credencial/worker foi iniciado por esta atualização. Packaging, mic/UI/Android e13stories não viram gate universal. iOS excluído. Root único executor/promotor canônico; monitor único escritor do plano; versão/hash/custódia antigos preservados.


### 30.43 — C07/S-B V799:900 medidos concluídos;889 corretos/11 incorretos; selo local único (2026-10-16)

Atualização de evidência da **condição C07/S-B já existente**, sem condição/linha de matriz/metodologia/gate novo. Fullread do relatório Root `docs/experiments/tcc-20261013-submission-20261030/root/browser-normal-ui-padded900-v799/REPORT.md`,3325B/SHA256`68e394a8e49c6d468b3ea77cdebda137a8d5208f06d6b90afbae7c833aa80608`; Root msg_f90b3037fea8 confirma resultado e liberação da reservaGPU após selo. Esse path de evidência existente não afirma que a consolidação completa em thesis/ já terminou.

Terminal natural **2026-10-16T06:46:06.441052Z**,900/900 medidos,**889 corretos+11 incorretos**,0 outras falhas/timeouts/interrupções/não tentados;15 warmups corretos EXCLUÍDOS. Não são900 sucessos/fullflows corretos nem aceitação funcional. Todos4 owners originais ausentes na receipt terminalV940,3424B/SHA`5162e7a74f01c536495e0767abc97af1824a4da3409834a455e937929675547d`. Fonte/freeze`e67f8f98830ef0ceb978590bbe6b8b496ada2ad4ddd05bc34fb22248c65c10b8` preservado; capturas anteriores879/879 e847/847 corretos eram fatos datados, não o resultado900.

Collector aprovado896 executado **UMA vez** porRoot941,06:52:01.535874Z→06:52:21.514776Z,exit0/sem nova medição/modelo/benchmark. Receipt `.git/aurora-handoff-import-20261006/v941-browser-once-finalize-RESULT.json`,5573B/SHA`879e4da96cfe1cfbdf635c0b595898db034e85b373b2ce9d35d0d820de38116b`; integridade ZIP/hashes/audit de outcomes aprovados, ausência de owners/descendentes e locks verificados. Raw incorreto preservado. Não repetir audit,900 ou topup automaticamente.

**Fullflow correto:** Type7,**N889**,p90=**19297.6ms**,p95=**19503.4ms**. Clock monotônico Node de início runAttempt até captura,STT real,reply correto visível,TTS WAV real válido e fim de playback conectado em software. Denominador de outcomes continua900, incluindo11 incorretos; não chamar esses percentis de900fullflows corretos. Limite inclui UI/gravação/playback, portanto diferença versus headless com outro endpoint não é overhead puro de protocolo nem efeito CPU-vs-GPU isolado. Não somar percentis de stages nem subtrair clocks diferentes.

Spans nativos no próprio clock/backend/case+span/correlation: LLM`resolved_chat_model.astream`900 válidos,p90/p95318.4108255/394.0403657499996ms; STT`Transcription.Transcribe`900 válidos,3373.6866282/3415.06362785ms; TTS`TTS.Synthesize`889 válidos/**11 ausentes**,1723.374904/1865.9596987999994ms. Ausência não é0 e não identifica causa. Queue,TTFT,streamed-first-audio,microfone/acústica/speaker físicos permanecemUNKNOWN/null; p50/p99 não emitidos nesta receipt compacta, sem inventar valores. Browser usa file-mic→servidor no mesmo host e software playback; não prova compute on-device,Tauri,mobile/crosshost,microfone físico ou speaker real.

Diagnóstico RootV944 somente de registros já salvos,7737B/SHA`ef5c50beb17e044a1a35c1cbe417fbb05e4487067cf18e4e38bd5ac8e880ed7a`:case0904 passed,0905/0915`incorrect_reply`; há401 eERR_ABORTED na amostra, sem ligação causal demonstrada entre status,IDs e incorreções. Não inferir qualidade/modelo/harness/auth-expiry como causa; aceitação funcional C07 permanece **OPEN/Partial feature**. Nenhum Source/fixture/model/settings foi mudado nem predicate relaxado por esta nota. Reparo/novo cohort exige evidência e contrato versionado já aprovado, nunca rebatizar/pool de dados antigos.

Arquivo local desktop: `/tmp/aurora-root-padded-browser900-v799/export-v888/aurora-browser-normal-ui-padded-full-audio-v799.zip`,**130072923B**,2765 membros,SHA`489404814e7667b4c85d371e9e2e895372dc075d1e310669593dff47b1f56e72`. **Custódia worker/publicação ainda não copiada na receipt941**; Root adia transferência pesada enquanto CPU mede. Transferência posterior exige espaço real ≥arquivo+80000000B e janela sem interferência. Selo local não equivale a arquivo já replicado/durável no worker nem pacote de reprodução completo; manter índice/pins/localização/custódia explícitos, sem duplicação pesada/segredos.

V737CPU suplementar continua congelado sob reserva até terminar naturalmente e selar; sem novo CPU900 por padding. Primeiro S-NHTTP espera ambos recursos físicos liberados/selados e admissão real/freeze+15warmups HTTP/auth/native correlacionados antes de900; nenhum baseline científico extra ou gate universal browser/UI/mic/Android/pacote/13stories. Depois permanecem cumulativos meshTTS→TTS+LLM→TTS+LLM+STT e900 por célula aplicável não-iOS, sem pooling.

Após liberaçãoGPU, Root fez uma admissão pela EXATA rota screenshot histórica aprovadaV330. ReceiptV943,330B/SHA`583302f06c2748965aa1d14b5f3e8aa823cc67696e971b90b6a8a190cc3ae7a5`,retornou `runtime_error`/`Execution-host observation failed`; nenhum screenshot/device state foi obtido. É falha da observação corrente, não ausência do emulator/host nem prova de permissão/ADB/voz. Sem retry idêntico/bypass/novo acesso por esta nota; tratar no owning context aprovado, separado do primeiro S-NHTTP. Monitor mantém só plano/receipts; Root único executor/promotor canônico.
### 30.43.1 — Diagnóstico finito dos onze registros: formato da resposta, sem replay (2026-10-16)

RootV947 extraiu SOMENTE os onze registros existentes0905–0915, sem chamar modelos/medição novamente. Fonte `.git/aurora-handoff-import-20261006/v947-existing-approved-waydroid-connect-and-format-records-RESULT.json`,5319B/SHA256`2040c0bff94143834374f30a236b9567eff43270d1da1ef4adde756494cb4eb4`,observedAt2026-10-16T07:16:17.402826Z. Em todos onze: transcript estrito correto,reply31 caracteres exatamente **“The capital of France is Paris.”**,SHA`a1b7eb2ee7a6aded8dda4e6cf30826f5afffb28a5597ee9389e91eb326d4e319`;`exactParis=false`,`matchesFullSentence=true`,terminal`incorrect_reply`,zero requestsTTS. Assim há resposta semanticamente correta em frase completa que não satisfaz o formato exato congelado. A própria verificação interrompeu o caminho antes deTTS; estes onze NÃO demonstram áudio→áudio completo nem900 sucessos. Manter labels/predicate/raw/freeze e889+11 originais; uma análise semântica secundária pode ser descrita separadamente, nunca substituir a análise primária/denominador. Os401/ERR_ABORTED anteriores não são causa demonstrada dessas onze respostas. Esta identificação por dados salvos encerra o diagnóstico solicitado sem novo900/topup/pilot; não autoriza relaxar critério ou criar outra condição.

CPU observado pelo monitor2026-10-16T07:17:40.753610Z:V737699/900,201 não tentados,15warmups,último correto;controller3038114/start88098754 ebackend3038148/start88098925 originais vivos. O run foi introduzido anteriormente como comparaçãoCPU suplementar com input padded; não é reparação deV491900 nem baseline científico adicional obrigatório. Padding isoladamente é razão insuficiente para outro900. Preservar execução atual sem interromper/reiniciar/topup/expandir. Estimativa condicional Root09:30–10:30UTC para terminar, mais selo único; não é ETA garantida de admissão/lançamento distribuído. Não inserir novos CPU900, product/UI/mic/Android, embalagem thesis/ ou review genérico no caminho crítico.

Checklist finito para o PRIMEIRO par S-N: [concluído]V491CPU900 original; [concluído]desktopLocal899corretos+1interrompido/900 eHTTP854corretos+46incorretos/900, sem esconder falhas; [concluído]browserV799900 terminal/selo local/liberaçãoGPU, mas funcionalmentePartial feature; [em execução]V737 suplementar precisa apenas terminar naturalmente, selo único e liberação da reservaCPU deste requester; [source-ready, NÃO lançado]worker/headless file-audio actualSTT+LLM locais→PersonalPiperCPU TTS porHTTP autenticado`POST /api/TTS/Synthesize`,mesmo setup,900+15warmups; [pendente]admissão metadata/source/model/config/resources/bind/freeze em janela liberada, startup Root, depois15warmups reais com HTTP/auth/provider/native stage joins antes de medido1. Nenhum baseline científico extra para esse primeiro par. Peer/grant/session/lease/catalog/ICE são admissão concreta das célulasmesh posteriores, não bloqueio universal ao primeiroHTTP. Executar cumulativosTTS→TTS+LLM→TTS+LLM+STT com900 por condição aplicável; sem resultados/launch/ETA inventados. Instrumentação ausente permaneceUNKNOWN/null.

Android/admissão isolada: RootV946,533B/SHA`e5070b3d9417b2c2c5a2a785cf31ad5a5cd128903171bd2d3f0c83c7cb77e322`,listagem do servidorADB já existente127.0.0.1:5037 retornou0rows; isso não prova ausência física. V947 tentou uma conexão normal à MESMA rota previamente aprovada192.168.240.112:5555;stdout **No route to host**,get-state não encontrou device. É falha corrente dessa rota/contexto, sem inferir host offline, device parado ou permissão negada. Sem segundo connect/instalação/pairing/chaves/security/grants por esta nota; não usar como impedimento de S-NHTTP/headless. Root mantém integração/execução e promoção canônica; monitor mantém documento/receipts.

### 30.44 — CPU suplementar selado; primeiro lançamento distribuído e bloqueio de rota observado (2026-10-16)

**Estado vigente, sem nova condição nem novo gate científico.** Root confirmou término NATURAL deV737 em2026-10-16T09:46:30.884010Z,exit0:900/900 medidos corretos,15/15 warmups adicionais corretos excluídos,0 incorretos/falhas/timeouts/interrupções/não tentados. O único finalizador autorizado iniciou09:46:34.490463Z e publicou liberação09:46:42.101792Z, dentro do orçamento externo de observação600s; processo/descendentes originais ausentes COM terminal/release positivos. Observação expirada jamais equivaleria a saída. Nenhum restart/topup/expansão/repetição900CPU foi solicitado. V491 original permanece válido; V737 é comparação CPU full-stack suplementar, não reparação exigida por padding. Não criar mais CPU900 sem razão concreta de validade/cobertura documentada; padding isoladamente é insuficiente.

Fonte de selo: `.git/aurora-handoff-import-20261006/worker-padded900-prep-v737/export-v762/verification.json`,291918B,SHA256`76c3951237070a5c4b2aa18bca604d6d50361c5a24ecba4ada6231c65b1cc1d7`,at09:46:41.620392Z,integridade/auditoria PASS e originais preservados. ManifestV737`acbdc1d3827502513237220fcc3bf60cc3a007b7dc246b1a4b21b1a0ef8ce5fc`;cohort`aurora-full-audio-capital-v1-worker-cpu-padded-20261015`,ARM64CPU/n_gpu_layers0/n_threads2. Arquivo32740359B,1858membros,SHA`8647715e745b7a49f8fb270730312909be3918fa7e87900b3174dbf2f8dc2f99`; publicação worker confirmada em`docs/experiments/tcc-20261013-submission-20261030/root/worker-cpu-padded-local900-v737/`,sem nova cópia/re-hash por esta nota. Resumo auditado compacto do monitor: `.omx/evidence/orca-monitor-20261010/cpu-v737-compact-sealed-metrics-20261016T0950.json`,5897B/SHA`b5489a4a9b5a2f547a7fcd547451cd32f06f92e04f77c390f2d585439db7b343`.

Latência full file-audio→STT→LLM→TTS→WAV válido,Type7,N900: **p90=51533.1898556ms;p95=54152.799883299995ms**. Populações completados/corretos/tentados observados coincidem apenas neste cohort sem falhas. Spans selecionados de MESMO processo/clock receptor e identidade case/correlation/span,N900 cada: STT`Transcription.Transcribe`p90/p95=10601.935136/11490.17697279999ms;LLM`resolved_chat_model.astream`33208.5676245/36202.32170259999ms;TTS`TTS.Synthesize`3961.0224797/4607.933079049997ms. Cada subconjunto exato possui0 spans ausentes/múltiplos/boundaries inválidos. Preservar também diagnóstico GLOBAL`invalidBoundaries=1830`,`unmatchedStarts=0`; não esconder, não inventar causa nem estender validade dos subconjuntos ao conjunto global. Native harness-case ID ausente900 em cada handler; attempt/op IDs ausentes nos wrappers citados, presentes nos model_invoke STT/TTS. TTFT,primeiro áudio transmitido,playback equeueWait permanecemnull/UNKNOWN; sem prova de microfone/speaker físicos,p50/p99 não emitidos neste resumo. Não somar percentis nem comparar relógios distintos. O REPORT.md Root ainda era snapshot antigo de lançamento na leitura09:48; atualizar de auditoria SALVA no checkpoint, sem repetir análise/modelos e sem bloquear execução distribuída.

**Barreira de duas campanhas individuais encerrada para o primeiro par admitido:** desktopLocal/HTTP já selados,CPU737 agora selado/liberado. Não restam baselines científicos headless extras para esse par. BrowserV799 continua900tentados/889corretos+11falhas estritas de formato,com diagnóstico finito encerrado conforme30.43.1; seus onze caminhos não executaramTTS. Browser/mobile/Tauri/Android e demais células aplicáveis continuam devidas, mas microfone/getUserMedia/renderização/playback físico,aceitação genérica13stories,embalagem thesis/ e promoção documental não são gates universais do file-audio distribuído suportado. Não renomear CPU/GPU/browser/cohorts anteriores nem ocultar resultados inconvenientes.

**Lançamento distribuído REAL, não só source-ready:** Rootmessage`msg_53ca6f4a6c6b`09:49:58Z confirma provider Personal iniciado09:47:18.317042Z,controller3561795/start77234677,receiver3561815/start77234688,TCPready09:47:55;manifest`249ac590069f37199913f609d75243e4a831edd26bdb12352b49f4d8329f5f55`. Provider Piper CPU classe esperada`app.services.tts.providers.piper.PiperTTSProvider`,useCuda=false,22050Hz; readinessTCP é apenas transporte local, não prova HTTP/auth/inferência remota. Requester worker iniciou09:48:52.941804Z,controller3598345/start92259353,runner3598346;manifest`02fc8d165aa01e81113c0dc6f51c6ed845c1924e8fbf630ee6916d529f0b151e`. Célula headless nativePython file-audio:STT+LLM locaisCPU→TTS remoto no Personal porHTTP autenticado`POST /api/TTS/Synthesize`,mesmo WAV padded/modelos/configuração congelados,15warmups excluídos+900medidos,180s/request/57600s condition. Não é P2P/ICE nem aceite de outra surface.

**Primeira tentativa TERMINAL emwarmup1,0medidos:** terminou09:50:15.846352Z,exit1,status`stopped_system_failure`,reason`remote_transport_error`,shutdown_completed=true;controller/runner ausentes com terminal positivo. Denominadores:1warmup tentado falhou,14warmups não tentados;900medidos planejados,0tentados/0corretos/900não tentados,0timeouts. p90/p95 sãonull por população medida inexistente, nunca0. Fonte`.git/aurora-handoff-import-20261006/distributed-k1-launch-operations-v994/requester-progress-0951.json`,9294B/SHA`e8dd8df686324f412dd977d081ae323f103c6c04452a2196b28a9d71beb94660`. Guardar manifesto/raw/falha originais de`distributed-k1-http-cell-v994`,sem sobrescrever ou apresentar tentativa como900 concluídos.

Rootmessage`msg_05a96c0dab3a`09:55:32Z esclarece:STT gerou transcript correto eLLM respondeuParis;TTS remoto falhou antes de obter statusHTTP,transport_error2.543579ms. Provider desktop permanecia vivo/TCPready em09:53:10 no MESMO controle Personal. Diagnóstico worker salvo`.git/aurora-handoff-import-20261006/distributed-k1-launch-operations-v994/transport-diagnosis-worker.json`,3069B/SHA`0d65facfe8e791111a12413ee5bdcf62f729e7918c31a8d26b4c90aa7476b564`,observedAt09:53:07.612903Z:conexão100.64.0.3:8000 retornou`ConnectionRefusedError`errno111;rota usaenp0s6 via10.0.2.1/src10.0.2.123,interfaces locaislo/enp0s6,sem interfaceTailnet observada. Root conferiu adapterProxyHandler({}) e ambiente sem proxy. Isso demonstra falha concreta de alcance TCP desse endpoint a partir deste requester; não demonstra falha de modelo,ausência desktop,auth inválido ou causa física além da evidência. Não instalar/ligarTailnet,mudar firewall/credenciais/grants/contas/security/rede por inferência.

Checklist executável finito: [DONE]V491CPUoriginal900;[DONE]desktopLocal899+1interrompido/900 eHTTP854+46incorretos/900,selados;[DONE]browser799889+11/900 selado localmente,funcionalPartial;[DONE]V737900corretos+selo único+liberação;[LAUNCHED_THEN_FAILED_WARMUP]primeiroHTTPK1,0medidos;[BLOCKED_EXACT_CAPABILITY]reconciliar origem Gateway autenticada JÁ aprovada e alcançável pelo worker ou TCPforwardSSH/Orca JÁ suportado/aprovado,sem novo acesso/host/worker/segurança;[PENDING_ROOT]manter/reconciliar MESMO provider vivo e reservas,diagnóstico finito da rota,versionar eventual binding/manifest de nova tentativa sem apagar994;[PENDING]startup/readiness real+15warmups HTTP/auth/nativeSTT/LLM/TTS correlacionados completos antes de900medidos;[PENDING]900medidosHTTPK1,p90/p95+denominadores ejoins recíprocos clock-safe;[PENDING]K1mesh compeer/grant/session/lease/catalog eICE direct/relay reais;[PENDING]K2TTS+LLM eK3TTS+LLM+STT cumulativos ecomparações local/API/mesh emcada surface/par aplicável,900PERcondição. Não inserir nova revisão genérica,pilot idêntico,repetiçãoCPU/UI/Android/pacote como gate. ETA de novo lançamento/medição éUNKNOWN até receipt de rota autorizada alcançável; não prometer janela baseada só no antigo términoCPU. Scope completo não-iOS e demarcação de capacidades/países desconhecidos continuam vigentes.

Root term_6a00d9ee-792a-4daf-8578-236290e33108 permanece único integrador/executor;monitor term_2eab47ed-ab9b-4e35-bd9b-fc068c60e3fc,Tasktask_d7ea336050cf/Dispatchctx_37b4d0a3c14f/Runrun_e6054e76e9fc mantém somente plano/receipts e native goalACTIVE. Esta atualização append-only preserva plano integral/histórico e não cria nova campanha/autoridade ou projetoTCC. Promoção canônica pelo Root no checkpoint seguro, sem segurar reparo/execução por documentação.

