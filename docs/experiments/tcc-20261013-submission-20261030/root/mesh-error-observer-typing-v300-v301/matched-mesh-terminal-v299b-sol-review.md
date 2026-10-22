# V299b bounded typed-error observer review

2026-10-14 UTC. **REQUEST_CHANGES — one literal status type guard is required.** The observation/success/privacy changes otherwise meet this bounded source scope; no runtime cause or pass is asserted.

Exact anchors: current bridge base `4b1793afd1f2833b07315326f4dc5b58180800238815a3e7125191bc1ea9d602`; private bridge candidate `07e271c85ec51ccdfee01c66e8589ff813154f82ad5d4c84b7f7ff0156a118c9`; patch `ba27abb81f94f1eec769f9d3e73ac54582f9b33ca0c7e2f0615e52ac0dfee8b0`; REPORT.txt `f6b4f2880ed650f2b8b7120b61e44d022020ff176bda936abc2fca11c775c99f`. Independently hashed and read the exact patch plus actual SDK error/terminal seam. No tests/compiler/build/services/models/network/browser/device/source/index/goals/ledger/vault mutation, commits or agents; only this private report is written.

## Required minimal correction

Actual packages/aurora-sdk/src/errors.ts:26 declares AuroraError.status as `number | undefined`. Candidate typed-error branch sets `const status = update.error.status`, then computes `Number.isInteger(status) && status >= 100 && status <= 599 ? status : null`. Number.isInteger is not a TypeScript narrowing predicate, so the range comparisons still use possibly undefined status under strict null checking. Add `typeof status === 'number'` before the integer/range checks. No additional schema, predicate or diagnostics redesign is needed. This is a source-identified typing issue, not an executed compiler result.

## Accepted source observations

SDK client.ts:1416 can emit `streamFailure(fallback.error, transport, 'fallback')`; fallback kind alone is therefore not a successful response. Candidate checks any update.error before success, creates typed_error and breaks, preventing an error-bearing fallback from passing exact ORBIT/terminal gates. Successful completed|fallback still requires no error, exact response, matching IDs/message and one completion through the unchanged spec. Finite update-kind observations are retained; old V296 update shape does not retrospectively establish its exact category/cause.

The error code/detail projection uses the fixed ten-code allowlist; unknown detail strings are not exported. Intended HTTP status projection is integer100..599/null after the requested guard. Message is hashed through Web Crypto SHA256 only; no raw message, stack, body or arbitrary detail is returned. Hash failure yields null. Elapsed time is sampled before awaiting hashing, preserving the observed-error boundary. Existing IDs/model fields and request limit remain; no production auth/model/method/route/retry/security/G8 behavior changes.

V296's one correct reply and one failed request remain actual facts, not a full pilot/main acceptance. Root's backend seam finding that stream.close only removes a scoped subscription does not justify an auth/RTC teardown repair. Root owns the one corrected finite observer run under600s/global flock/new build fingerprint and later any demonstrated product repair. MAIN remains held; local/API/full-UI history checks remain closed without replay. Exact guard-only correction may close this source finding; no new matrix or fixture is requested.
