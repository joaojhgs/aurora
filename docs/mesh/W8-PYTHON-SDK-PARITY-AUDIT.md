# W8 — Per-Peer Parity Audit: Python node vs TypeScript SDK

The plan's instruction for W8: *walk the Python per-peer state map
(`app/services/gateway/webrtc/rtc_client.py:391-515`) subsystem by subsystem; every row green
or a written exclusion.*

This is that walk. The Python node keeps its per-peer state as ~59 parallel dictionaries keyed
by signaling peer id. The SDK does not mirror that shape and should not: it composes one
object per peer (`MeshPeerSessionEntry`, holding a `WebRtcPeerSession`, a
`WebRtcMeshPeerBridge`, a `SignalingSessionAllowlist`), so state that Python keeps in a dict
keyed by peer is state the SDK keeps in a field of that peer's object. **Parity is about the
behaviour being present and per-peer, not about the data structure matching.**

Legend: **green** = present and per-peer in the SDK. **gap** = missing or not yet per-peer.
**excluded** = deliberately not applicable, with the reason.

---

## A. Transport and session lifecycle

| Python row | SDK home | Verdict |
|---|---|---|
| `_pcs` | `MeshPeerSessionEntry.session` → `WebRtcPeerSession`'s `PeerConnectionLike` | green |
| `_peer_data_channels` | the session's bound data channel | green |
| `_peer_send_fns` | `session.sendFrame` per entry | green |
| `_peer_send_queues`, `_peer_send_workers`, `_peer_send_locks` | `DataChannelFlowController` (`datachannel-flow.ts`), held per session as `channelFlow` (`peer-session.ts:321`) | green |
| `_flow_controllers` | same — one controller per session, limits from `dataChannelFlowLimits` | green |
| `_negotiation_watchdogs`, `_negotiation_retry_pcs` | per-session timers (`armTimeout('negotiation', …)`, `negotiationMs`) | green |
| `_peer_timeout_tasks` | per-session `authMs` / `pairingMs` timers | green |
| `_offer_in_progress` | session state machine (`negotiating`) is per session | green |
| `_peer_reconnect_tasks` | `PeerSessionReconnectOptions` per session | green |
| `_reconnect_suppressed_pcs` | `close()` is explicit per entry; `disconnectPeer()` removes the entry | green |

Python ties several of these to the exact `RTCPeerConnection` object rather than the peer id,
specifically so a late callback cannot act on a replacement connection. The SDK gets the same
property structurally: the timers and the flow controller are fields of the session instance,
and a replacement session is a new instance. `isCurrentTransport(pc, generation)`
(`peer-session.ts:1146`) is the explicit generation guard.

## B. Identity and binding

| Python row | SDK home | Verdict |
|---|---|---|
| `_peer_stable_ids`, `_stable_peer_sessions` | `MeshPeerSessionRegistry` keyed by stable id; `bindPeerId()` | green |
| `_peer_acl` | the Rust authority, keyed by peer identity | green |
| `_peer_names` | `MeshPeerRosterEntry.nodeName` | green |
| `_peer_claimed_stable_ids`, `_peer_claimed_names` | `MeshPeerRosterSnapshot.discovered` — observation, explicitly not authority | green |

**The one-stable-id-one-session rule is enforced in both.** Python rejects a stable identity
presenting on a second transport; the SDK refuses it at `registry.add()` and again at
`registry.bindPeerId()` when a live session reports an id another entry holds.

Python's separation of *claimed* from *verified* identity is the anti-impersonation control
W3 had to preserve when `expectedStablePeerId` left the signaling filter. The SDK keeps the
same split: `discovered` holds what a peer announced, the registry holds what was verified,
and `SignalingSessionAllowlist` decides which of them may drive an established session.

## C. Credentials and reconnect

| Python row | SDK home | Verdict |
|---|---|---|
| `_peer_tokens`, `_saved_auth_tokens` | `PeerCredentialStore`, keyed by peerId | green |
| `_peer_auth_challenges` | Rust authority's reconnect challenge store | green |
| `_used_peer_auth_challenges` | same — the replay guard | green |
| `_reconnect_proof_tasks` | `reconnect-proof.ts` + the authority's verify path | green |

Covered by `reconnect_challenges_are_single_use_per_peer` and
`reconnect_challenge_replay_guard_matches` in `rust/crates/aurora-mesh-authority/tests/parity_corpus.rs`,
both passing. Python binds a validation to its exact transport so a late result cannot
authenticate a replacement PC; the Rust store is keyed per peer and single-use, which denies
the same attack by a different route.

## D. Pairing

| Python row | SDK home | Verdict |
|---|---|---|
| `_peer_pairing_active`, `_pairing_tasks` | `MeshPeerSessionEntry.pendingPairing`, per entry | green |
| `_pairing_handshakes`, `_pairing_result_futures`, `_pairing_results` | `pairing.ts` handshake state, per session auth port | green |
| `_pairing_transports` | the auth port is constructed per session | green |
| `_pairing_commits_sent`, `_pairing_bootstrapped` | per-session auth port state | green |
| `_peer_pairing_directions` | `RuntimePeerAuth.pairingHandle` (outbound) vs `inboundPairingHandle` + `issuedInboundCredential` (inbound), per session auth port | green |

**`_peer_pairing_directions` deserves a note, because it looks like a gap and is not.**
Python keeps inbound and outbound pairing as separate directions per peer, with a comment
explaining why: pairing is symmetric, each endpoint owns an outbound credential request and
receives an inbound one over the same channel, and one direction completing must not cancel
the other side's still-pending approval.

The SDK's `MeshPeerSessionEntry.pendingPairing` is a single slot, which invites the conclusion
that the two directions share state. They do not. `pendingPairing` is the *user-facing SAS
prompt*, and SAS is one verification code per handshake covering both directions — not one
code per direction. The directions themselves are separate fields on the session's auth port:
`pairingHandle` for outbound, `inboundPairingHandle` and `issuedInboundCredential` for inbound
(`runtime.ts:864-866`). `confirmPairing` validates the single code, marks
`localSasConfirmed`, confirms the handshake, and only then polls the *outbound* handle
(`runtime.ts:1010-1015`); it never clears the inbound fields. The "is a pairing outstanding"
check ORs all three (`runtime.ts:970-973`), so an outstanding inbound request keeps the peer
in a pairing state after the outbound one resolves, and `resetTransport` clears all three
together only because a dropped transport invalidates both.

So Python's requirement holds in the SDK by different means. Recorded explicitly because the
single `pendingPairing` slot makes this worth checking rather than assuming, in either
direction.

## E. Protocol negotiation and fragmentation

| Python row | SDK home | Verdict |
|---|---|---|
| `_peer_protocol_hellos`, `_peer_protocols` | `WebRtcMeshPeerBridge.remoteProtocol` per bridge | green |
| `_fragment_reassemblers` | `bridge.reassembler`, rebuilt on renegotiation (`setRemoteProtocol`, `mesh-peer-bridge.ts:691`) | green |
| `_local_protocol_hello` | `entry.localProtocolHello` | green |
| `_fragment_reassembler` (global default) | the bridge's initial reassembler before negotiation | green |

Per R0 §4, once Rust fragments it owns the negotiated limits and is the sole enforcer. That
is an M6/R3 change; today both sides enforce in TypeScript, which is correct for the current
seam.

## F. RPC

| Python row | SDK home | Verdict |
|---|---|---|
| `_pending_rpc`, `_pending_rpc_peers` | `bridge.pending`, `pendingSubscribes`, `pendingManifests`, `streams`, `rpcStreams` — all per bridge | green |
| `_rpc_handlers` | `WebRtcPeerHost` inbound dispatch, per bridge via `peerHost` | green |
| `_rpc_send_tasks` | awaited sends per bridge | green |

Python needs `_pending_rpc_peers` as a second dict because `_pending_rpc` is global and has to
be reverse-mapped to a peer. The SDK does not: the pending map is a field of the peer's own
bridge, so the association is structural. **W2's router** is what makes that safe with several
peers — it dispatches on `request.peerId`, and an unroutable id fails with a typed
`peer_not_registered` error rather than falling through to whichever peer happens to be default.

## G. Manifest, provider lease, projection

| Python row | SDK home | Verdict |
|---|---|---|
| `_manifest_ack_expectations` | `bridge.incomingManifestAck`, `peerHost.pendingManifest` | green |
| `_local_provider_ready`, `_local_provider_lease_revisions` | `ProviderLeaseController` per peer host epoch | green |
| `_local_provider_lease_tasks`, `_provider_lease_tasks` | `bridge.localProviderLeaseTimer` / `remoteLeaseTimer` | green |
| `_local_provider_unavailable_tasks` | `handleProviderLease` / `clearRemoteAvailability` | green |
| `_manifest_reannounce_retry_tasks` | `retryManifestAfterStaleAcknowledgement` | green |
| `_provider_export_cache`, `_provider_export_generation`, `_provider_export_peer_generations`, `_provider_export_active`, `_provider_export_authority*`, `_provider_export_tasks`, `_provider_export_diagnostics`, `_provider_export_registry_callback_registered` | — | **excluded** |

**Exclusion, provider export.** The provider-export machinery projects a Python node's own
service registry to peers, with a cache and generation counters because the source registry is
large and changes under it. A thin client's provider surface is its local tool registry, which
it already projects through the peer host's manifest with `admittedServices` and the provider
lease. Reproducing the cache and generation counters would be reproducing a solution to a
problem the SDK does not have. If a thin peer ever exports a registry of comparable size, this
row reopens.

## H. Tooling projection

| Python row | SDK home | Verdict |
|---|---|---|
| `_tooling_remote_authority_revisions`, `_tooling_remote_authority_grants` | Rust authority decisions carry `grantedToolContractIds`; consumer projects labels | green |
| `_tooling_projection_refresh_tasks`, `_tooling_projection_sync_after_lease`, `_tooling_outbound_manifest_revisions` | manifest revision + lease renewal per bridge | green |
| `_latest_tooling_projection_invalidations_by_peer`, `_tooling_invalidation_retry_tasks` | **unresolved — see below** | unresolved |
| `_latest_tooling_projection_invalidation` (global) | — | excluded (global cursor, not per-peer) |

**Unresolved, and deliberately not called a gap.** Python sends a metadata-only invalidation
to exactly one authenticated peer (`send_tooling_projection_invalidation`,
`rtc_client.py:3586`), carrying `manifest_revision`, `authority_revision` and
`auth_grant_revision`, and retries delivery per peer on failure
(`_tooling_invalidation_retry_tasks[recipient_peer_id]`, line 3680).

What I could verify: a repository-wide search finds no SDK code referencing projection
invalidation by name. What I could **not** verify: how the SDK consumes it. The payload has no
bespoke frame type, so it is most likely delivered as a typed `event`, which the bridge does
dispatch through its per-peer subscription registry — in which case there may be no gap at all,
only a different mechanism. Confirming this needs a trace of the sending topic through to the
SDK subscriber, which I did not complete.

Recorded as unresolved rather than asserted as a defect. An audit that overstates a gap costs
as much as one that misses it.

## I. Events

| Python row | SDK home | Verdict |
|---|---|---|
| `_event_subscriptions` | `MeshEventSubscriptionRegistry`, keyed by peer, per bridge | green |

## J. Not per-peer

`_auth_timeout`, `_pairing_timeout`, `_pairing_retry_delay`, `_offer_timeout`,
`_pairing_handshake_timeout`, `_closing`, `_system_token`, `_on_token_saved`, `_mesh_enabled`,
`_mesh_config`, `_mesh_policy_provider`, `_peer_registry`, `_peer_bridge`,
`_diagnostic_errors`, `_authority_refresh_callback` — process-level configuration, callbacks
and singletons. The SDK's equivalents are constructor options and runtime-level fields.
**Excluded: not per-peer state, so not in scope for a per-peer parity audit.**

---

## Summary

- **Rows walked:** 83 fields across `rtc_client.py:391-515`.
- **Green:** every per-peer subsystem except the two below — transport, session lifecycle,
  identity binding, credentials, reconnect replay, pairing, protocol negotiation,
  fragmentation, RPC correlation, manifest, provider lease, tooling authority, events.
- **Gaps: none.** The one row that looked like a gap — `_peer_pairing_directions` against a
  single `pendingPairing` slot — resolves green on inspection: the slot is the SAS prompt, and
  SAS is one code per handshake, while the two credential directions are separate fields on the
  auth port that do not cancel each other.
- **Unresolved (1):** tooling projection invalidation — no SDK code references it by name, but
  its delivery mechanism was not traced end to end, so whether that is a gap is genuinely open.

The unresolved row needs a trace of the sending topic through to its SDK subscriber before it
can be called green or a gap. If it turns out to be a gap, it needs a failing test before a
fix, per the plan's standard for the invariants.
