# V289 bounded matched-pilot source review

2026-10-14 UTC. **REQUEST_CHANGES / final shared-hook review pending.** This verdict binds only to the exact available candidates below. It does not approve their later replacements, claim a matched measurement run, or reopen V281 functional acceptance.

Read both private author reports/patches, the relevant added pilot paths and maintained provider conversion seam. No tests/parsing/builds/services/models/network/browser/device/source/index/goal/ledger/vault mutations, commits or recursive agents. Only this private report is written. Root owns final integration and separate subprocess/serial execution.

## Exact reviewed anchors

Local/API script: `26adfada706eeb82e0c74e19a22f2107b04a4dcb6ba5cedb5c79a5a9f3fab9ba`.
Local/API patch: `ce72aa1f806392a6f38dc5d16337600259c9fa460e637ac5e71dbd1995d15dbb`.
Local/API REPORT.md: `50c2549803ede03b53432b4518fc6b6f3305866cfebc58b10cc2ce1c50b05c3d`.
Mesh bridge browser-shell-runtime.tsx: `e78d206dd21bcdb0d2e2e39146d04f2d4b8349d90b110c6e3a064151a591f31a`.
Mesh spec: `2f1c49c4dc8126192b220e9f0224d531c08d5263ef59189f6984fd78b3db5972`.
Mesh runner: `887c545c60010c9ec3540fb59290ab72ba9a4bb3021e87e54a94d7b14497b78e`.
Mesh REPORT.txt: `4864c7be7fe2ce379b64237d18f7cd9407ccefa66a11eaeebd92bc283157a4a7`.

## Concrete required corrections / exact scope

1. **New demonstrated fingerprint-artifact route mismatch.** Script attempt registration stores actual route names `python_local_bus` or `python_gateway_api` in _FINGERPRINT_ROUTES (:898 onward), but artifact selection (:1070) requires that stored value equal pilot_route `local-only` or `api`. Both single-route artifacts therefore select zero records even if the provider call was captured. Align the recorded condition identity and selection with the actual route, or delegate all capture/selection coherently to the shared hook. Root was notified immediately; this is an important main-output defect, not an expanded matrix.

2. **Root-identified request context boundary remains a blocker in this frozen script.** _PROVIDER_REQUEST_ID is set in the requesting task around _request_and_check_history, while HTTP/uvicorn handles the API request in an independent task. The provider wrapper reads that ContextVar and returns without recording when it is unset. A shared installed hook must bind the actual receiving request/turn context rather than assume the HTTP caller's Python context crosses that boundary. API capture cannot be inferred from same-process execution.

3. **Root's separate-process restriction is necessary.** The candidate's default both path calls _run twice within one Python process while reusing imported config/model/service globals and the wrapper. It is not two independently restarted process conditions. Root explicitly selects one `--pilot-route` per separate subprocess and forbids interpreting the both path as a matched comparison. That executable restriction is outside this reviewer’s execution authority; the author’s fresh-runtime wording must not be borrowed as proof.

4. **Known mesh exactness/timer corrections remain unapproved until their exact bytes arrive.** This bridge uses `update.text.trim() === 'ORBIT'`, whereas the current intended exact predicate rejects extra whitespace. Use direct exact text equality. The mesh pilotStartedAt is set after connect/onboarding, so its arithmetic excludes setup even though the Playwright test timeout starts earlier. The owner’s prescribed correction starts the timer before setup and retains the full test deadline. No request timeout or functional success criterion should be relaxed.

5. **The external shared hook is not present in this reviewed package.** Mesh runner loads an install() from a private caller-supplied module; its author explicitly disclaims validating that module. The local script’s current wrapper hashes original converted messages/params, but checks caller basename rather than exact maintained source identity. Final approval must inspect the delivered shared hook for exact caller/source/validated-parameter compatibility, effective empty-tool provenance, request binding, strict private artifact guard, hash-only output and unchanged model invocation. No fake approval of an absent hook or invocation capture.

## Preserved useful source behavior and limits

The mesh bridge uses the same paired runtime.client.assistant.streamMessage and existing authenticated SDK route, fixed public task, fresh IDs,180s timeout and abort signal. It counts typed completions, requires exact matching IDs, and returns outcomes/codes/IDs/timing rather than reply text. Its page bridge is gated by the existing hosted-test build setting. The spec attaches each outcome before assertions and stops on first failed predicate; passing samples require a retained JSON reporter, unlike V281's buffer-only line attachments. This new SDK-boundary pilot does not claim client/UI history acceptance or replace the closed full UI main.

The local script pins Qwen artifact and llama-cpp-python0.3.19, keeps existing model options/task/auth and retained final-response/history predicate, uses isolated scratch config/data and disabled ToolingService, and preserves immutable immediate journal plus pre-shutdown manifest/final cleanup reporting. Failure/timeout/cancellation must stay in denominators; the separate-process caller must keep a real total owned cap because route-loop600s alone is not a complete startup/cleanup bound. No run occurred here.

Hashing final actual provider message/parameter sequences can establish input equality only if capture is complete and associated with each measured attempt. Disabled ToolingService alone is not a retained effective-tool-schema proof; final hook artifacts must report/check the actual empty tool input. Fixed prompt time is experimental process-local behavior, not production telemetry/G8. A <=10-attempt readiness pilot remains descriptive, not stable quantiles, full study, native/mobile/mesh authority, or thesis acceptance. Local/API reply and mesh typed-completion timing boundaries require matching declared clocks/endpoint scope; earlier total runtime is not response latency.

## Bounded handoff

Return the exact corrected local script/shared hook and corrected mesh bytes for a delta-only source verdict. Root already owns single-route separate subprocess invocation and serial checks/execution; no new agent, test matrix, model replay or production framework is requested. Source review stops here at the bounded dependency/finding result; old functional success remains closed and cannot substitute for new hash/provenance completeness.
