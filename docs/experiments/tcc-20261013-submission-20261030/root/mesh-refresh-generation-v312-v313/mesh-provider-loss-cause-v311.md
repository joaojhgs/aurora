# V310 provider-readiness loss: source cause

Bounded source/log investigation only. No code changes or executable checks were made.

## Current evidence

The V310 safe receipt (SHA-256 `5d91f6510c8534b7630229c3dcc639a40e1de6b454f057708451a3f09cd5f8da`) shows attempt 1 passed provider preflight after 1,884 ms, completed the exact typed response in 38,229 ms, and remained authorized at terminal. Attempt 2 failed preflight immediately as `manifest_unavailable` before dispatch; the peer remained authorized before and after. This is a provider-manifest/readiness loss, not a new authorization denial and not a second model failure.

The retained Python service log (SHA-256 `5beda4968a7e1e3f05c1e1bd3afb51fa367a4a5119d85db5d4fd366c3468f86c`) shows the initial usable manifest ACK around 06:28:22–24. During the first request it then records three route regenerations, at 06:28:39, 06:28:40, and 06:28:41, each still reporting 191 routes and 15 services. No later manifest-ACK marker appears in that log. Orchestrator model initialization and tool-catalog failure are also present in this interval, but neither by itself proves the invalidation cause.

## Source-grounded loss mechanism

In `app/services/gateway/registry_aggregator.py` (SHA-256 `306f731721f9f0daf309cc4c3ee1bc60dd4ad3f747b7e604523258e81ddab1de`), changed service announcements notify registry callbacks only when the route-bearing registry snapshot changes (`_on_service_announce`, lines 263–306). The Gateway route generator’s repeated regeneration is evidence that these change notifications occurred. RTC registers its provider-export callback on that registry at `app/services/gateway/webrtc/rtc_client.py:2755–2759` (SHA-256 `e7614c0725cc5e0dfe9d08a7c3b60c6d1dc66dc4450029df9d05b4efd9f293d0`).

That callback invalidates the provider export and schedules refresh (`rtc_client.py:2802–2804`). `_invalidate_provider_export_all` explicitly sends provider-unavailable to every currently ready peer and resets the readiness/ACK state (`rtc_client.py:2831–2847`). The follow-up refresh is coalesced per peer at `rtc_client.py:2806–2829`: if a refresh task is already running, a new invalidation simply `continue`s. There is no dirty-generation marker or trailing refresh scheduled when the active task exits. Therefore a second registry change that lands while a peer refresh is running can clear the newer readiness state while its refresh request is dropped; the earlier task can finish with a manifest from an older registry generation, leaving the peer authorized but without a usable current manifest/lease.

This coalescer is a concrete source-level race consistent with V310: multiple registry changes happened during the first provider request, the second preflight found the manifest unavailable, and the authenticated peer remained present. However, the existing logs do not expose refresh task overlap or ACK generation, so they do not prove which of the three registry changes hit the in-flight window. Treat the race as the leading source-supported cause, not as a directly captured per-attempt event.

## Minimal safe repair boundary

Make per-peer refresh coalescing generation-aware: a registry invalidation arriving during an active refresh must leave one trailing refresh pending for the latest registry/provider generation. Continue sending unavailable and clearing readiness on every invalidation; restore availability only through the existing fresh ACK/lease protocol. Do not preserve stale readiness, bypass the RPC guard, change permissions, or infer readiness from the authorized peer roster.

A focused existing RTC-client regression should pause the first peer refresh, apply another registry invalidation, release the first refresh, and assert that a trailing latest-generation manifest is sent and readiness is re-established only through its normal ACK/lease. No broader mesh matrix is recommended by this evidence.

## Evidence sources

- `app/services/gateway/registry_aggregator.py`: changed-snapshot callback semantics, lines 263–306.
- `app/services/gateway/webrtc/rtc_client.py`: callback registration, lines 2755–2759; invalidation/refresh coalescing, lines 2802–2847.
- `app/services/gateway/service.py` (SHA-256 `2748b265c6b6a59b9176fe36fa8af0bcac7d230ada7b77c5fbe5e6a27bc472d5`): Gateway service wiring and registry state.
- V310 safe receipt and retained Python service log hashes above.

The precise in-flight refresh overlap remains unobserved; no auth, policy, model, or peer state was changed during this investigation.
