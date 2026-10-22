# V312 independent bounded refresh-generation source review

2026-10-14 UTC. **APPROVE, source-only**, for the frozen minimal production refresh/test candidate. It repairs a demonstrated lost-invalidation scheduling path; V310 runtime overlap and full repeated-request recovery remain unproven until Root's validation.

| Anchor | SHA256 |
|---|---|
| rtc_client.py canonical base | e7614c0725cc5e0dfe9d08a7c3b60c6d1dc66dc4450029df9d05b4efd9f293d0 |
| rtc_client.py private candidate | ecc207cd7a164959e2bec0aa1e0dcd90af7e3790c8eed418563c610e64dcbd40 |
| test_rtc_client_lifecycle.py canonical base | 5b5604dcb2d29a5e4293052ce754e681c4828b3f26ecfec1d5a39e9a8ce6e0df |
| test_rtc_client_lifecycle.py private candidate | f165e5b7c7ec8d93681e01803390c1bdeda51bd14913da5abbc8ae0456369d0d |
| candidate.patch | 3fa0d59956ea98adae23ca6fcf815a0a2c1624f4287be715a02978d4e61f0c0b |
| REPORT.md | 2f7c9f6ea2f8a2978f769281a8b0f4b3d6b2aa436dc283981d2b6df306920b1f |

Independently verified exact hashes/bases and reviewed the patch, task lifecycle/generation mutation seams and existing test fixtures. No tests/Ruff/compiler/build/services/models/network/browser/devices/source/index/goals/ledger/vault mutations, commits or agents. Only this private report is written; Root owns serial integration/execution.

## Actual scheduler and generation behavior

The existing invalidation callback increments the global generation, clears projection/ACK state and sends/reset unavailable readiness, then calls a scheduler that coalesces active peer tasks. The old one-shot task could complete a refresh while a second invalidation occurred during its awaits and then remove itself without another refresh. The candidate captures both global and that peer's generation before the existing unavailable-drain/reannouncement awaits, and returns only if both remain equal afterward. A newer generation therefore receives a trailing refresh rather than being lost through the scheduler's active-task coalescing.

The current reannouncement path remains unchanged: authenticated stable-peer/open-session checks, current policy pair, existing recipient projection generation checks and actual manifest send. No readiness/grant/ACK/lease state is set directly by this loop. Failed reannouncement still follows its existing bounded retry scheduling; the loop is generation-driven, not an unconditional model/transport retry. Tombstone drain precedes every reannouncement as before.

The unchanged finally block removes the task only if its map entry still refers to the current task, preserving replacement ownership. Cancellation/error propagates through the existing awaits and finally cleanup. RTC close already cancels and gathers every refresh task before clearing the map; the candidate does not detach extra workers or introduce a new queue. After a stable generation comparison, there is no intervening await before return/finally, so an event-loop callback cannot interleave a lost invalidation there; a later invalidation can schedule the next task normally.

This is catch-up until invalidations settle, not a guarantee of a fixed maximum iteration count during continuing legitimate invalidation. It remains cancellable at the existing async boundaries and does not make stale projection data active. No self-generating unconditional generation increment was introduced in the loop or reannouncement function.

## Focused regression value

The one new lifecycle test uses the real _invalidate_provider_export_registry and scheduler, not a mirrored loop. It pauses the first reannounce with asyncio events, triggers a second legitimate invalidation while the same task is active, releases it, awaits that original task and requires two reannouncements plus an empty task map. The old code would perform only one reannouncement and fail that assertion. Existing imports/fixture already supply asyncio, AsyncMock, MagicMock and SimpleNamespace; the production generation maps are initialized by RTCClient.

This unit isolates scheduling with a reannounce spy. It does not prove real ACK/lease delivery, authorization or model execution; those guards are preserved in production source and Root's actual repeated-request flow supplies integration evidence. The test does not waive unavailable-before-reannounce ordering, which remains exercised by the neighboring existing test and unchanged source.

## Limits and bounded handoff

V310's first readiness/ORBIT and second authorized-but-manifest-unavailable observations remain actual outcomes. Registry generations were logged, but their overlap with an active refresh was not; this review identifies a real causal source mechanism without labelling it the proven runtime cause. Root owns targeted pytest/Ruff and one unchanged-options two-request flow under original flock/monitor resources. Success/count/provider-input hash eligibility and MAIN hold remain intact. No model resend, lease/ACK timeout relaxation, grant/auth change, observer field expansion or broader matrix is requested. Old local/API/full-history/component passes remain closed without replay.
