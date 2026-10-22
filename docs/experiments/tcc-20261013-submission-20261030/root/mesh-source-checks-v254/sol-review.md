# V252 independent real mesh ORBIT main source review

Verdict: **REQUEST CHANGES for two launch fixes and one measurement-label correction.** Review covers only the four owned diffs and necessary existing runtime source. No test/build/service/network/browser/device execution occurred and no runtime/mesh/nativeRust acceptance is claimed. Previous V248 product normalization review remains closed.

## Required bounded corrections

1. **Custom Next output is packaged at the wrong static path.** scripts/hosted_peer_e2e.sh:107–116 builds with a unique NEXT_DIST_DIR, then copies static assets into standalone `.next/static`. Actual next.config.mjs:16 preserves the custom distDir in the build configuration. Locally installed Next16.2.6 source, server/lib/router-utils/filesystem.js:146–148, resolves static assets as `opts.dir/config.distDir/static`. Thus the new standalone server expects `$WEB_STANDALONE_DIR/$NEXT_DIST_DIR/static`, not `.next/static`; missing JavaScript/CSS can prevent hydration and the actual mesh main. Copy into the matching custom distDir. Retain the isolated output directory so the protected debug preview's `.next` is not overwritten/deleted.

2. **Python launch does not isolate the writable secrets/backup paths.** The existing launch sets scratch config/data but omits AURORA_ENV_FILE and AURORA_BACKUP_DIR. main.py:35 loads AURORA_ENV_FILE or ambient `.env`; ConfigManager.migrate_secrets_to_env (:1185–1215) likewise writes `.env` by default, including effective auth/token credentials migrated from config. BackupService defaults to ambient AURORA_BACKUP_DIR or `.aurora/backups` and creates it on startup. This does not satisfy the run's private-state isolation even though config/data are temporary. Set both paths under this run's RUNTIME_DIR before starting Python, as in the prior approved pilot. Do not modify the production services or ambient private files to accommodate the fixture.

3. **Provider span is labelled as request latency.** The added RPC observer records started_monotonic_ms when the provider receives the RPC; completion elapsed_ms is computed before/around provider event send. New spec summaries call that request_elapsed_ms. It excludes requester submit/transport and UI receipt, so it is not requester end-to-end latency and cannot be compared as the same boundary as the prior CLI endpoint reply latency. Root has requested the bounded correction: rename this span provider_processing_ms and retain one requester/browser monotonic observation for the existing case, explicitly labelled UI-visible latency/observation. Preserve the separate boundaries; do not infer mesh overhead from their unpaired difference or introduce production telemetry/a new matrix.

## Connected main fidelity

The selected case uses the same fixed ORBIT prompt/expected reply and configured llama options128 tokens, seed42, threads2, CPU layers0, context4096, batch64 and decoding options as the prior pilot. Root must pass/hash the same actual model artifact; the generic model-path variable alone does not verify the weights. Source/model/options receipts belong with the actual run. SDK stream request now explicitly uses180000ms. This is also a production foreground-hook deadline change for remote dispatch calls, not a purely test-local timeout; lightweight-local selection and the prompt/model/auth gates are otherwise untouched by that one-line diff.

Existing connectHostedPeer performs real Gateway status/invite/pending pairing/admin approval/UI approval and waits for an authenticated open WebRTC data channel. The added hook delegates to original RPC/event handlers; it observes only the exact fixed task and never synthesizes an assistant response. The case requires one visible exact ORBIT answer, one actually sent final assistant.completed event, matching request/session/correlation IDs, final flag, nonempty message/frame identifiers and bounded elapsed provider span. This is meaningful final-result evidence, not an ACK. Existing SDK foreground completion persists through the client-local history facade; the case selects saved conversation, opens a fresh one, reopens the saved one and requires the exact answer and prompt. It does not require/claim provider DB writes from a peer and introduces no ownership bypass.

Safe attachments contain finite outcomes/booleans/counts/randomized correlation metadata, not the prompt/response body, credentials or raw backend error. A failure before/within later assertions remains an actual failed test; partial backend/history evidence does not make the main pass. Existing failure trace/screenshots can contain pairing/auth material, so Root must keep those original artifacts private or redact support exports; the new safe JSON is not a certification that all Playwright trace/network artifacts are redacted.

## Owned resources and scope limits

Unique NEXT_DIST_DIR cleanup targets the run's output and protects the ordinary debug `.next`. Existing setsid launch/recorded Python and web PIDs constrain process-group cleanup. Docker cleanup remains keyed by inherited/default COMPOSE_PROJECT_NAME, not independently proven ownership: Root must use its isolated owned project or the existing externally-managed services mode when reusing a broker. A global build lock does not authorize deletion of another owner's compose project. No processes/containers were inspected or changed here.

The script forwards arguments to Playwright; Root's planned exact --grep selects one case, and the existing config has retries0/workers1. Without that launch argument the script still runs its configured broader file; no single-case enforcement is inferred from source alone. Test timeout240s and provider request180s do not prove pairing/startup/history/build fit a600-second external cap. Root must retain actual timeout/incomplete results and owned cleanup limitations, not assume a600-second PASS. This is browser/SDK real mesh Assistant evidence if it succeeds, not nativeRust/mobile/three-route statistical acceptance or stable p90/p95 inference.

## Exact reviewed hashes

| File | Independently verified SHA-256 |
| --- | --- |
| scripts/hosted_peer_e2e.sh | `d1dcb23e3cc6af2bb0525348c43a11a9623cffcf42d90dcbf9a56503c2f8ae8b` |
| tests/e2e/hosted_peer/hosted-peer-live-shell.spec.ts | `24741c46c5530fdcd75945260159bfbc842e75590a92b9cd7851c2f6bf81ffa6` |
| tests/e2e/hosted_peer/hosted-peer-live-helpers.ts | `357e975d6c05a8d598a9486cf7b56ded9ceb30fb73311d223b91b1e9a52e8e57` |
| packages/aurora-ui/src/use-assistant-foreground-turn.ts | `dae3bdf7ab9baaeffd8d9ae0339b7200e520ec5f0c64e1bdb461d967e85fdcbb` |

Only this private report under canonical Root .git was written. No candidate/source/index/goal/vault changes, executions/tests/build/services/network/browser/device, commits/push, agents or recursive orchestration. No ownership conflict/resource exhaustion; bounded review ends at the three corrections above. Root owns cheap parse/affected UI checks and one600-second actual runner after integration, retaining the exact amended hashes. Native independent Sol evidence is relayed through the original Orca run/monitor without fabricated dispatch, external approval or assumed runtime success.

## 2026-10-14 — V253 bounded correction delta

Delta verdict: **REQUEST CHANGES solely for the actual mesh receiver budget.** The original three corrections and compose ownership condition are closed. Independently verified corrected hashes:

| File | SHA-256 |
| --- | --- |
| scripts/hosted_peer_e2e.sh | `8c1d7aba3021f9c12a19ee936a0360bc206b45b29a4b446a54371d4a8e21ee0a` |
| hosted-peer-live-shell.spec.ts | `55bd43c825efd2dc8c2efb8129468a77c9186ce464a69d7cb731309158364021` |
| hosted-peer-live-helpers.ts | `e782858aa3bccce8c0bac0334bac30028443ca8a4651619b86463ed6337f4a75` |
| use-assistant-foreground-turn.ts (unchanged) | `dae3bdf7ab9baaeffd8d9ae0339b7200e520ec5f0c64e1bdb461d967e85fdcbb` |

Static assets now go to standalone/$NEXT_DIST_DIR/static, matching the custom Next configuration and retaining protected-debug isolation. Python launch now supplies scratch AURORA_ENV_FILE and AURORA_BACKUP_DIR. The new BASHPID-suffixed COMPOSE_PROJECT_NAME is actually exported; scripts/webrtc_interop_services.sh:4–5 consumes that same variable in docker compose -p, and both up/down use that array. Cleanup therefore does not silently fall back to the helper's shared/default project. Existing external-service mode still supports explicitly managed broker reuse; fixed host-port conflicts can fail startup and do not authorize stopping another owner's service.

Provider elapsed fields/types/summaries now use provider_processing_ms, with explicit receive-to-completion-event-send boundary. The existing case captures performance.now before browser submit and after polling observes visible completion, labels requester_submit_to_visible_completion_ms, and sets requester_latency_is_cli_comparable=false. It includes click/observer overhead and is not an exact instrumented arrival timestamp or a matched CLI endpoint boundary. This closes the prior misleading request-latency label without inventing cross-route comparisons.

**Remaining requested receiver check:** hosted_peer_e2e.sh:235 sets gateway.api.request_timeout_s=180. That setting controls the HTTP API, not the WebRTC RPC dispatch used by this case. Actual app/services/gateway/webrtc/rpc.py:1752 still invokes bus.request(...timeout=30.0) for the normal ExternalUserInput call. RTCClient's handler construction (:5841 onward) does not supply an API request-timeout override. The diagnostic hook delegates to that original handler. Thus the provider receiver can fail the real mesh request after30 seconds despite the client180-second option; it does not implement the stated same180-second request-budget condition.

Root must resolve that actual receiver policy before claiming the matched180-second mesh condition, using a bounded real production/configurable route correction or explicitly amending and disclosing the protocol as a30-second receiver condition. Do not silently monkeypatch away this production limit, relabel it180, weaken acceptance or attribute the mismatch to the model/transport. This is a direct verification of the requested receiver budget, not a new edge or retry matrix. No production source was changed by this reviewer.

Only this delta was appended to the existing report. No tests/parse/typechecks/build/runtime/network/device/source/index/goal/vault/commit/agent actions occurred; Root owns its serial checks and actual run. V250 passing evidence remains closed. Three-minute delta cap honored; no conflicts/resource exhaustion or runtime-pass inference.

## 2026-10-14 — V254 exact receiver closure

Final delta verdict: **APPROVE the exact receiver correction; the sole remaining V253 budget finding is closed.** Independently verified:

| File | SHA-256 |
| --- | --- |
| app/services/gateway/webrtc/rpc.py | `68cdd7c932c23e5054d53013a57f2c39c923d0d4fde98077953c9a665d4cb005` |
| tests/unit/gateway/test_rpc.py | `50ed8a0e7a19b0c2344a2de6589eb7dee9c6409dfc420fb774e002811e971c29` |

The normal real RPC bus dispatch now uses180 seconds only for the typed OrchestratorMethods.EXTERNAL_USER_INPUT topic; all other topics retain30 seconds. This is the actual receiver used by the ORBIT foreground stream request, not an HTTP-only setting or test monkeypatch. Auth identity, effective permissions, projection/authority/correlation fields, actual bus payload, response/error/fatal handling and other request gates are unchanged. Streaming inference's separate existing timeout is outside this correction and is not labelled180 by this approval.

The single added assertion belongs to the existing allowed ExternalUserInput permission/typed-request success test and checks the actual mocked bus dispatch timeout180. Its existing principal/permission/response assertions remain; no new matrix or coverage claim is added. Tests were inspected only, not executed.

The four frozen V253 candidate anchors and their closed static-path/private-path/measurement/owned-compose findings remain as recorded above. Root owns six-file integration, targeted receiver test and one600-second real mesh case. No full runtime/platform acceptance, guaranteed startup fit, nativeRust/mobile result or CLI-comparable latency is inferred. Only this closure was appended; no source/index/goal/vault/commit/agent or executable actions occurred. Two-minute cap honored; no conflict/resource exhaustion. Earlier V250 evidence remains closed.
