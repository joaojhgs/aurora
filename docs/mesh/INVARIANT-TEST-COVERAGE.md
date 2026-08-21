# Invariant test coverage

The plan lists nine security properties under *Invariants — each needs a test that fails
loudly*. This is the ledger of where each one is enforced, which test holds it, and how that
test was confirmed to bite. Two levels of confirmation are distinguished, because they are not
the same thing:

- **mutation-confirmed** — the enforcement was deliberately broken and the named test failed,
  then the break was reverted and it passed again. This proves the test bites.
- **read-and-run** — the test passes and its assertions were read to confirm they assert on an
  *effect* rather than on a function returning early. Weaker: a passing test that asserts
  nothing meaningful also passes.

| # | Invariant | Enforced at | Test | Status |
|---|---|---|---|---|
| 1 | Room membership is not authority; every peer needs its own SAS pairing and explicit approval | Rust authority | `grants nothing on room membership alone` (WASM), `a_credential_without_a_grant_authorizes_nothing` (Rust corpus) | read-and-run |
| 2 | A per-session allowlist replaces `expectedStablePeerId` | `signaling-allowlist.ts`, consulted in `signaling-mqtt.ts` `handleRawMessage` | `refuses forged signaling that names an established session's device` + 4 allowlist unit tests | **mutation-confirmed** |
| 3 | One stable id, one session | `MeshPeerSessionRegistry.add()` and `.bindPeerId()` | `refuses a second session for a stable peer id the registry already holds`, `refuses a known stable identity that presents on a second transport` | read-and-run |
| 4 | Reconnect challenges stay single-use per peer | Rust authority challenge store | `reconnect_challenges_are_single_use_per_peer`, `reconnect_challenge_replay_guard_matches` | **mutation-confirmed** |
| 5 | Authority contexts never cross peers | Rust authority, keyed by peer identity, holds no transport state | 6 corpus cases driven by `manifest_snapshots_match` and friends; `authority_holds_no_transport_state` covers the structural half | **mutation-confirmed** |
| 6 | One Aurora in the notification shade | `AuroraRuntimeForegroundLedger`, reference-counted reasons | `android-runtime-foreground-service.test.ts` (5 tests) | **mutation-confirmed** |
| 7 | Runtime is chosen by platform, never by lifecycle | `aurora-mesh-session` registry | `ping_is_answered_the_same_way_in_both_lifecycles` (Rust), which cites the invariant in its failure message | read-and-run |
| 8 | Shedding a peer is distinguishable from losing one and costs no re-pair | R6's budget + the "going away, keep my credential" signal | — | **pending (M7/R6 not built)** |
| 9 | Product copy stays product copy | `product-copy-forbidden-terms.ts` + rendered-copy tests | forbidden-term sweeps across mesh, onboarding and foreground-service copy | **mutation-confirmed** |

## How the mutation confirmations were done

**#2** — neutering the allowlist call in `handleRawMessage` made a forged `offer`/`answer`/
`candidate`/`presence`/`presence_departed` from a room member claiming an established
session's stable id drive that live session into `reconnecting`. 2 of 7 tests failed; restored,
7 passed. The forged-envelope test asserts on effect across all five vectors: no SDP applied,
no ICE candidate added, no state transition, no reconnect, and the roster neither polluted nor
retired.

**#6** — deleting the branch that keeps the service alive while another reason is held failed
the reference-counting test; separately, changing the device-link notification string to name a
transport failed the product-copy assertion. Both restored.

**#9** — same run as #6: the forbidden-term sweep caught `transport` in notification copy.

**#4** — neutering the `record.consumed_at_ms.is_some()` replay branch in
`authority.rs::consume_challenge` failed both invariant-named tests,
`reconnect_challenges_are_single_use_per_peer` and
`reconnect_challenge_replay_guard_matches`. Restored, 21 passed.

**#5** — neutering the `context.selector.claimant_peer_id != remote_peer_id` guard in
`authorization.rs` failed `manifest_snapshots_match`. Worth recording precisely, because the
naming misleads: `authority_holds_no_transport_state` is a *structural* test asserting the
context carries no transport-derived members, and it does **not** catch this. The cross-peer
denial is enforced by six corpus cases — `denies_a_context_belonging_to_another_peer`,
`grant_for_another_peer_is_invisible`, `grant_for_another_peer_is_skipped`,
`another_peers_grants_are_not_advertised`, `advertises_nothing_when_the_context_is_another_peers`,
`rejects_proof_replayed_for_another_peer` — driven by the iterating corpus tests. The invariant
is covered; it is just not covered by the test whose name suggests it is.

## Where the remaining two stand

**#7** landed with R3. `ping_is_answered_the_same_way_in_both_lifecycles` drives the same
registry through `SurfaceLifecycle::Foreground` and `Background` and asserts the answer does
not change shape. Worth noting what that does and does not prove: it pins that *behaviour* is
lifecycle-independent, which is the observable half. It does not assert on which implementation
is selected, so a future "background mode" that swapped runtimes but happened to produce an
identical pong would still pass. Adequate today because there is only one implementation; it
should be tightened if a second ever appears.

**#8** is R6's, in M7, and is not built. It needs the contract change first: an explicit
"going away, keep my credential" signal so Python distinguishes intentional absence from a lost
peer instead of evicting at the 120 s stale window. Until that exists there is nothing to test
against, and the plan is explicit that this is a contract change requiring regenerated
cross-language fixtures.

## Reading this honestly

Seven of nine are enforced and covered, five of those mutation-confirmed. One is pending on
work that has not landed (#8, R6's). #4 and #5 have since been mutation-confirmed, closing two of the three gaps this
ledger originally flagged. **#3 — one stable id, one session — is the last read-and-run row
guarding impersonation, and still deserves confirmation.** It was not done here because
`peer-registry.ts` is being extended for R6's budget policy, and corrupting a working tree
mid-run costs more than the confirmation is worth in that moment. It should be closed once M7
lands.
