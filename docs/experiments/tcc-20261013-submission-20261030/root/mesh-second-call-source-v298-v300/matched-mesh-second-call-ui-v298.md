# V298 second-request source attribution

## Finding

The available evidence establishes that the second SDK call returned a typed `fallback` update after 156 ms and did not start a second model-provider invocation. It does not establish whether the cause was a changed browser runtime, a request/transport response before inference, or the SDK's no-stream fallback path. The underlying reply text and detailed response status were intentionally not retained, so the second-request cause remains **UNKNOWN**.

The retained V296 safe receipt at `matched-readiness-v296-mesh/safe-measurement-receipt.json` reports one correct first result and a second `fallback`/exact-mismatch result; its update-kind summary does not identify the SDK fallback branch. Root's safe provider summary says only one provider input was captured. Neither proves a mock, a runtime replacement, or a specific route failure.

## Source trace

- `apps/aurora-web/app/aurora-client.ts:434-444` reuses a cached runtime when its key and local-assistant identity match; otherwise it closes the previous cached runtime. `:478-482` constructs a normal `AuroraClient` unless the explicit debug-demo condition is active. There is no source evidence that the successful first request changes the profile, transport factory, or demo condition before the second call.
- `packages/aurora-ui/src/web-thin-runtime.ts:424-430` returns the `sdkRuntime.client` created for that runtime. The test-only probe closes over the runtime supplied to `BrowserShellRuntimeProvider`; its effect is keyed by `[runtime]` (`apps/aurora-web/app/browser-shell-runtime.tsx:23-32`). The receipt does not record runtime identity or replacement, so replacement cannot be ruled in or out from this run.
- `packages/aurora-sdk/src/client.ts:1220-1227` synthesizes `fallback` when there is no assistant-stream transport and the request succeeds. `:1321-1323` synthesizes it after stream idle timeout when the request response is successful. `:1392-1410` can also produce it after an exception before any stream event, either from the successful request result or a separate successful `sendMessage` fallback. All these paths represent a successful typed response but do not identify which one occurred in the safe receipt.
- `fallbackUpdateFromResponse()` at `packages/aurora-sdk/src/client.ts:1830-1851` takes its `text` and model label from the successful response; it uses the call's request ID and supplied session ID as fallbacks. Model label can legitimately be null when none of the recognized metadata keys is present. Thus a missing model label alone is not evidence of a mock or runtime switch.

The source supports a useful next discriminator, not a causal repair: retain only the existing finite `assistant_stream_fallback` flag/transport from the SDK update metadata plus a small allowlisted response/provider outcome already available at the actual fallback site. That would distinguish fallback classes without recording message content. No source defect has been demonstrated, so no patch is proposed in this read-only slice.

## Hashes and limits

- Safe V296 receipt: `56daf50f93c0db616b8c93312dd6cc4bd4d35f1adae1e75549021467bb1fe4c1`
- `apps/aurora-web/app/aurora-client.ts`: `4bb5ef286e0f4de6c86460679951474b96b8715299aec602f9ea55418fd70b57`
- `packages/aurora-ui/src/web-thin-runtime.ts`: `8034f4f1e7b1545851fe1c5f14bc8aac3f9e6ad90a389ce7962d41dc356d667d`
- `packages/aurora-sdk/src/client.ts`: `252df51b7a86b1b6595f75c542dd2d797d2a39b10ec1faa15f736c4094a46491`
- `apps/aurora-web/app/browser-shell-runtime.tsx`: `4b1793afd1f2833b07315326f4dc5b58180800238815a3e7125191bc1ea9d602`

No tests, builds, runtime requests, or source edits were made. The successful V281 UI/history case remains closed and is not being reclassified. Root owns any next bounded measurement run.
