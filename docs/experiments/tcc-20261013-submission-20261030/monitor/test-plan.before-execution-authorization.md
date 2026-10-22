# Aurora Future Work Test Requirements

> OWNER REVIEW DRAFT — revision 2026-10-13, objective `tcc:20261013:submission-20261030`.
> The owner designated this existing full document authoritative and the existing Aurora monitor its document writer. The complete original T0–T13 plan remains below; Sections 12–24 extend it and govern the October 30 evaluation. This document authorizes no execution. Tests, benchmarks, builds, deployments, cleanup, commits, pushes, and submission remain HELD until explicit owner approval of the relevant stage. The June results below are historical evidence, not validation of the October checkout.

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

## 2. Current test coverage already available

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

This amendment applies to every original task T0–T13. Their procedures are proposed future procedures, never an instruction to run them now. Preserve local-only, centralized deployed API, and authorized P2P staged offload as distinct families. Include Brazil, Portugal, the United States, and a physical phone, with native/local, desktop, browser, and mobile entry points. Do not compress the study into the already-passing historical unit subset or an isolated inference example.

Evidence states are `planned`, `readiness_unknown`, `ready_documented`, `approved_for_specific_stage`, `executed_pass`, `executed_fail`, `inconclusive`, `unsupported`, and `not_run`. Approval, a configured route, a passing unit test, a live emulator, or a source review cannot become `executed_pass` for an end-to-end experiment. Each result records its exact source version, environment, execution date, command, raw artifact hashes, and scope. Known historical counts must be dated June 2026; a current test inventory remains unmeasured here.

The owner approves each execution stage with exact hosts, client surfaces, tasks, model manifests, limits, privacy scope, time/cost reservation, and stop conditions. A date or silence is not approval. Root remains the sole serial Aurora executable validator and resource-reservation owner. This document creates no worker, Run, project, deployment, privileged access, network impairment, or device reservation. Reuse existing agents and supported routes only. No company Work Claude may process TCC material.

## 13. Four-node inventory and conditional readiness

Use stable pseudonymous IDs in traces; keep exact authorized host identities in the private environment manifest. Do not derive a country's location from a hostname, IP prefix, timezone, or assumed provider region.

| Node | Owner-requested placement | Authorized inventory/documentation | Still required before execution |
|---|---|---|---|
| BR | Brazil semdev server | Registered `ssh:ssh-1786238480967-semdev`; existing Aurora and TCC folder registrations inspected on 2026-10-13 | Independent country/region record, CPU/RAM/storage/GPU/ABI, current Aurora version, approved executable owner and available reservations |
| PT | Portugal notebook-personal | Existing `ssh:ssh-sem-notebook-personal` and Aurora repository registration | Country evidence, physical device/OS/ABI/specifications, personal account boundary, power state, usable native/desktop/browser clients |
| US | United States VPS | Owner identifies US VPS; canonical Aurora coding workspace is registered on `ssh:ssh-oci-coding-worker` | Explicit proof that the requested US VPS is that host, country/provider region, machine limits and deployed API/mesh capability; do not silently equate them |
| M | Mobile phone, country unknown | Physical phone identity/capabilities not yet verified. Authorized inventory separately shows booted personal-distrobox Waydroid on semdev | Phone model, Android/iOS version, ABI/RAM, country/network, native app version, browser/WebView, consent, cellular/Wi-Fi, permitted battery/thermal observability |

Inventory status is readiness, not experiment output. Waydroid can establish emulator protocol checks only after approval; it cannot stand in for phone battery, thermal, radio, Doze, OEM lifecycle, or physical-device claims. Native iOS requires the actual phone or an approved macOS/Xcode route; Linux policy checks cannot support iOS runtime results. If a device or measurement is unavailable, retain its matrix rows as `readiness_unknown` or `not_run` and explain the limitation rather than blocking the document or inventing success.

Owner-supplied readiness sample: `observedAt=1791931061526`, 2026-10-13 22:37:41.526 UTC / 19:37:41.526 America/Sao_Paulo. US disk 93.918%, US CPU 83.181%, PT notebook CPU 96.332%. These snapshots identify possible load/storage confounding; CPU aggregation, sampling interval, workloads, and host mapping are not established. They authorize neither cleanup nor benchmarking. Obtain owner-agreed idle/exclusive slots or document unavoidable background load; never stop another workload or remove data to make a run pass.

## 14. Client-surface and deployment matrix

Transport, execution role, and physical surface are independent factors. Use centralized Aurora surface detection and runtime profile roles; never bake an offload role into an APK or invent platform support from source inspection.

| Surface ID | Client entry point | L0 local baseline | R0 deployed API baseline | P1–P5 mesh baseline | Required limitation |
|---|---|---|---|---|---|
| S-N | Native/headless local node | Production local engine/service call with exact backend | Production authenticated API client | Production authorized native mesh call | Crate-only inference is an engine measurement, not Assistant/UI/history proof |
| S-DL | Desktop Tauri local | Daemon/native ownership as implemented | Same desktop user action to API server | Same action to mesh peer | Distinguish daemon capture from focused WebView push-to-talk |
| S-DC | Desktop remote-console client | Capability conditional; do not invent local backend | Deployed server | Authorized home-peer route | Record runtime role independently of desktop hardware |
| S-B | Browser/web client | Only genuinely supported on-device browser execution | Authenticated deployed API | Browser mesh authority and supported peer session | Browser local inability is not a local performance failure |
| S-A | Physical Android native app/WebView | Supported native inference and local speech only | Same app/task to API server | Native foreground/background mesh according to implemented policy | Genuine capture, rendered reply and saved history must be separately evidenced |
| S-I | Physical iOS native app/WebView | Supported native backend only | Same app/task to API server | Actual iOS native mesh route | Record unavailable native speech/runtime evidence explicitly |

Add text-engine, text-Assistant/UI/history, focused voice, and permitted background-voice rows separately. Run local save/reopen/history checks for the Assistant claim; a nonempty synthetic message or a tool proposal is not tool execution. Background mobile tool access and deferred orchestration must follow implemented Rust-owned authorization and lifecycle policy. P4 always-on wake-word offload remains optional and separately privacy-approved.

Every planned experiment row has `(source_commit, node_requester, node_provider, surface, runtime_role, workload, deployment_family, route_class, network_profile, thermal/power_state, cold/warm_state, concurrency)`. This is an explicit matrix, not an instruction to execute the full Cartesian product. Section 23 selects finite must-have cells and leaves all other rows visible as optional or not run.

## 15. Pairwise, multi-hop, cross-region, NAT, and fallback routes

Plan all twelve directed requester/provider pairs; do not treat opposite directions as equivalent:

| Requester | Planned providers |
|---|---|
| BR | PT, US, M |
| PT | BR, US, M |
| US | BR, PT, M |
| M | BR, PT, US |

For every directed pair record actual geographic evidence, workload eligibility, supported client surface, API endpoint eligibility, mesh capability, permission, and readiness. A phone cannot be assigned a provider role that its native policy or hardware does not support. API rows use only an actually deployed authorized endpoint; no deployment is authorized by this plan. Local L0 has no provider edge. Same-LAN controls are additional location-labelled conditions, not substitutions for cross-region rows.

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
| Main matched comparisons | 5 excluded warmups per workload/condition/session, then 100 measured requests in each of 3 independently restarted/reserved sessions; n=300 per workload/condition | p50/p95, explicit sample sizes and session-cluster uncertainty; p99 descriptive and unstable |
| Optional tail precision | At least 1,000 measured requests per fixed workload/condition across at least 5 sessions | p99 with uncertainty; small upper-tail sample and heterogeneity limitations remain explicit |
| Cold starts | 5 approved independent cold process/model starts per selected condition | Descriptive cold-start median/range, not a stable cold p99 |
| Capacity | Concurrency 1, 2, 4 initially; 3 steady blocks of at least 60 completed requests or a fixed 10-minute cap per level | Offered/completed rate, queueing, p95, bounded saturation; expand only after approval |
| Failure/reconnect/security | At least 10 recovery cycles per chosen failure; 30 unauthorized attempts and 10 revocation cycles per exercised boundary | Observed rates and uncertainty only; zero observed violations is not security certification |

Use the same warmup count everywhere and keep warmup/cold traces with labels. Cold means documented process/model/cache state, not a destructive cache-clearing command. Warm means the specified models and connections are already ready; distinguish a warm model from reused versus new pairing/transport. Do not alter global system caches or force-stop another application.

Compute empirical p50/p95/p99 with a declared quantile estimator; report successful-completion latency alongside all-request errors/timeouts and right-censored deadlines. Do not replace timeout durations with the successful median or remove them as outliers. Report denominators and confidence intervals for completion/denial/fallback rates. Use paired session-level differences/ratios and a declared cluster bootstrap (proposed 2,000 resamples, fixed seed), with a separate descriptive view when sessions are too few. Avoid declaring equivalence from a non-significant difference or multiplying exploratory comparisons into a headline.

Predefine exclusions for harness corruption/clock failure and retain the excluded raw record/reason. Background load is measured and reported, not excluded after seeing results. Proposed clean-slot eligibility: five-minute pre-run window with recorded CPU/RAM/disk/network and no identified competing heavy job; numerical thresholds must be defined using that host's metric semantics and approved before the pilot. If exclusivity is impossible, label the loaded condition and match/control it; do not pretend the owner's 83–96% samples describe clean slots.

Keep power source, battery state/charge, screen brightness, app foreground/background, Wi-Fi/cellular, governor/power mode, ambient conditions and native thermal state fixed or recorded. Pause an approved run on documented thermal/resource limits, correctness regression, other-owner reservation conflict, insufficient artifact space or expiration of time/cost caps. Requests, warmups and failed attempts count toward the budget. After an approved pilot, estimate the remaining runtime from observed request duration before authorizing the main sample; reduce optional scope through a documented amendment, not hidden deletion of failing cells.

## 19. Metrics and overhead decomposition

Report metrics on requester, each provider, and relay where authorized. All intervals use explicit start/end definitions and units.

| Metric | Definition/boundary |
|---|---|
| End-to-end latency p50/p95/p99 | Client submission or capture/wake boundary to final correct result/playback; text, voice and engine boundaries stay separate |
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

For network context include measured RTT distribution, direction-specific bandwidth estimate and loss/jitter method/capture period; no active bandwidth probe or impairment is authorized now. Separate scheduler policy correctness from fastest-peer outcome; T12 evaluates the documented score, including load, availability and permissions, not RTT alone. Record signaling/relay availability as external dependencies even when content remains peer-encrypted.

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

Pin source version, dirty diff, lockfiles, app binaries, backend/model/tokenizer hashes, data licenses/consent, exact command and approved host route, seeds, time/cost caps, timeout behavior and analysis version. Reproducibility is documentation plus retained inputs; no reproduction is claimed by this document review. An unavailable model/license or consent record makes that cell conditional. No new model download, dependency install, CI workflow or deployment is authorized.

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

The full scope above remains planned. Must-have means required for the proposed October comparative claim, not permission to execute or a condition for silently dropping the remainder. An unavailable essential cell yields a narrower explicitly labelled evidence coverage and future-work entry, with owner review; it never becomes an invented result.

Must-have proposed evidence by October 30:
1. Frozen environment/workload/model/privacy manifest, approvals, observability schema, raw artifact integrity and historical/current evidence separation (T0/T13).
2. Functional correctness of each selected production entry point and its authorization/failure boundary (T1/T10), using existing exact-version evidence where applicable. Do not reflexively rerun the entire unchanged Aurora suite or CI matrix; reuse scoped valid evidence and obtain only missing necessary gates after approval.
3. A matched L0/API/P1 comparison on one supported personal native/desktop requester and the same eligible provider, plus one cross-region alternative provider. Each core condition uses the declared main sample; if local capability is infeasible, keep the feasibility outcome instead of replacing L0 with a smaller task (T2/T3/T4).
4. Physical mobile requester API/mesh outcomes, local capability or explicit infeasibility, and genuine capture only when voice/capture is claimed. If physical phone readiness is unresolved, state mobile evidence missing and keep the row conditional; Waydroid is separate emulator evidence.
5. Directed BR/PT/US/phone coverage table, including documented eligibility and bounded readiness for all twelve pairs; at least one actual direct cross-region path and one actual relay or an honest relay-not-observed limitation. No multi-hop claim without an implemented/granted route (T9).
6. One W-FIT/W-HEAVY feasibility comparison, error/timeout denominators, cold/warm observations, resource/network and overhead breakdown, and a bounded concurrency/queueing comparison (T2–T4/T11).
7. At least one supported reconnect/offline/fallback/revocation sequence with correct policy outcomes; locality/privacy/cost and limitations tables, all figures traceable to raw artifacts (T9/T10/T13).

Optional additions preserve their full rows: STT-only/TTS-only offload (T5/T6); combined full voice P5 (T8); wake-word offload with separate consent/privacy approval (T7); unsupported-to-supported application multi-hop only as later approved implementation work; every client-surface × route permutation; dense N0–N4 impairment; n≥1,000 p99 precision; concurrency above four, prolonged stress, broad energy/thermal/Doze/OEM/device coverage and full T12 load/oscillation cases. These cannot launch automatically to fill time or improve aesthetics.

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

Execution is still HELD at the document stage. If approval arrives late, retain optional/missing cases and publish an honest limitations account instead of launching a parallel fleet or an unbounded test loop. Each stage has one predefined stop rule and a recorded outcome. The plan proposes a ten-request or ten-minute pilot cap per main workload/condition, and main-run caps are set from that pilot before approval. Resource conflicts go to the existing Root/owner; no killing, cleanup, permission changes, new deployment or automated restart is implied.

## 24. Document review, reversibility, and remaining readiness decisions

The associated review package records exact personal white-paper/thesis source paths and hashes, citation-key checks, claim/evidence correctness, prioritized edits, chapter-by-chapter drafts, and unified diffs. It does not claim an existing PERSONAL/UNIVERSITY Claude paper session exited when it is not registered. Current registered company Claude is excluded; no TCC material is routed to it. Existing approved Personal/Manager routing retains guide lineage and Telegram topic2 destination; artifact enqueue/acceptance must not be reported as owner receipt or manuscript application.

Original plan backup and unified before/after diff make this edit reversible. The historical `.omx/artifacts/future-work-tests/future-work-test-requirements.md` copy remains frozen; this top-level document is the updated owner-authoritative plan. Thesis correction drafts do not overwrite the canonical semdev TCC manuscript or adopt its lifecycle/project ownership. Report any changing source hash or concurrent writer before overwriting; rebase a document diff against the changed source only with the existing designated owner.

Remaining decisions are explicit: exact October 30 institutional cutoff/format, independently documented countries/US host mapping, phone hardware/runtime/consent, actual deployed API/mesh routes/models, application multi-hop support, permitted sensors/relay accounting, exclusive load slots, existing paper-session identity and source-version freshness. They do not block completing this plan and review. They gate only affected execution/claims. No experiment, benchmark, deployment, product test, commit, push, submission or external follow-up was performed by this document update.
