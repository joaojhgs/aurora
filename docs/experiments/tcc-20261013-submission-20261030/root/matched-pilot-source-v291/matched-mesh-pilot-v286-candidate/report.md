# V286 matched mesh pilot source finding

## Result

No Playwright case was added. The existing hosted browser is paired through the real `AuroraBrowserRuntime`, but no supported test surface exposes that runtime's SDK client. The current test-only `window.__auroraHostedPeerSpeech` bridge is speech-only. A direct Assistant pilot cannot safely reuse the paired browser transport without a small test-only bridge change and a new browser build; creating another SDK client from Playwright would not represent the authenticated, already-paired session.

## Source evidence

- `apps/aurora-web/app/browser-shell-runtime.tsx` creates `BrowserRuntimeContext` and supplies the `AuroraBrowserRuntime` to UI components. Its hosted-test effect (lines 23–32) publishes only `__auroraHostedPeerSpeech`; `createHostedPeerSpeechProbe` (lines 86–115) has `run` and `close`, with `run` invoking the speech check. It does not expose `runtime.client` or an Assistant call.
- `apps/aurora-web/app/aurora-client.ts` declares `AuroraBrowserRuntime` with the paired runtime and client, while its runtime cache remains module-private. The existing React hook `useBrowserShellRuntime()` in `browser-shell-runtime.tsx` is the supported consumer boundary; Playwright cannot call it outside React.
- The SDK already has the correct production request boundary: `AuroraClient.assistant.streamMessage()` in `packages/aurora-sdk/src/client.ts:1064` publishes `Orchestrator.ExternalUserInput`, accepts `requestId`, `sessionId`, and `timeoutMs`, subscribes to typed Assistant events, and yields `AssistantStreamUpdate` values. `AssistantStreamUpdate` in `packages/aurora-sdk/src/types.ts:270` carries request/message/session IDs, completion kind, model label, and metadata. This makes a minimal test-only bridge feasible without a new transport or mock, but the current window bridge does not provide it.
- Hosted test support is enabled in the built app by `NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST=1` in `scripts/hosted_peer_e2e.sh:107`. The existing pairing/onboarding helper uses the actual browser and waits for writable local data; the prior successful V281 main already covers the separate visible reply/history flow.
- The Playwright config currently selects only the line reporter (`tests/e2e/hosted_peer/playwright.config.ts:25`). V284 established that the installed JSON reporter can retain test attachments via the existing CLI reporter option and `PLAYWRIGHT_JSON_OUTPUT_FILE`; use that for allowlisted records rather than changing reporter configuration.

## Smallest next implementation seam

Extend the existing hosted-test-only bridge in `apps/aurora-web/app/browser-shell-runtime.tsx` with one fixed-workload Assistant operation that calls the same `runtime.client.assistant.streamMessage()` instance used by the mounted application. Keep it behind the existing `NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST` gate. Have the operation accept only the harness-generated request/session identifiers and fixed pilot options, apply the bounded request deadline, and return a finite record derived from typed updates: outcome, completion count/kind, request/session/correlation identifiers, model label, resolved non-sensitive route/config fingerprint, exact-response predicate, and monotonic duration. Do not expose the client object or arbitrary prompt/options to `window`, and do not change production behavior. The existing hosted Playwright test can then run one fixed public request per trial through that bridge and attach the allowlisted record for the JSON reporter.

The request-specific prompt may be kept as the fixed synthetic workload already used by the pilot; record its predeclared workload identifier/hash rather than collecting arbitrary message bodies. Resolve model, route, context/toolset, and provider configuration from the same paired runtime before dispatch and record only categorical identifiers/hashes needed to prove that Local/API/Mesh trials match. The available SDK update metadata is the current source for returned model metadata; whether it supplies every required configuration fingerprint must be confirmed when implementing the bridge.

## Hashes and limits

Source hashes at inspection:

- `apps/aurora-web/app/browser-shell-runtime.tsx`: `079bd1309a19f578d4c5c5cdbc69f033446290fa08fcf6db32d2bed528b1f9a4`
- `apps/aurora-web/app/aurora-client.ts`: `4bb5ef286e0f4de6c86460679951474b96b8715299aec602f9ea55418fd70b57`
- `packages/aurora-sdk/src/client.ts`: `252df51b7a86b1b6595f75c542dd2d797d2a39b10ec1faa15f736c4094a46491`
- `packages/aurora-sdk/src/types.ts`: `31c26f3b5fa84103bd899e16afd6f6b46c1351ada796b3ee11da292b88edfcdc`
- `tests/e2e/hosted_peer/playwright.config.ts`: `a4ce9cec6c0877126a99eb91318f42f5a11481fec8b3abc637e4a976aa547aeb`
- `scripts/hosted_peer_e2e.sh`: `36d9e2907d9f19590f3552d2ea2aefad27cdb6f2c09d8e2cdfac748dccf0a267`

This is a source-only blocker report, not a pilot candidate or acceptance result. No source, test, build, service, browser, or network command was run. Existing V281 functional main remains closed as passed; this work does not repeat it or claim matched measurement data.
