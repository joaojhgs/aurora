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
| 4 | Reconnect challenges stay single-use per peer | Rust authority challenge store | `reconnect_challenges_are_single_use_per_peer`, `reconnect_challenge_replay_guard_matches` | read-and-run |
| 5 | Authority contexts never cross peers | Rust authority, keyed by peer identity, holds no transport state | `never lets an authority context cross peers` (WASM), `authority_holds_no_transport_state` (Rust corpus) | read-and-run |
| 6 | One Aurora in the notification shade | `AuroraRuntimeForegroundLedger`, reference-counted reasons | `android-runtime-foreground-service.test.ts` (5 tests) | **mutation-confirmed** |
| 7 | Runtime is chosen by platform, never by lifecycle | R3's session ownership | — | **pending (M6/R3 in flight)** |
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

## Where the remaining two stand

**#7** is R3's, currently being implemented. The property is that a native shell uses the Rust
session in foreground and background alike — no implementation swap keyed on lifecycle. The
test has to fail if someone adds a "background mode" that selects a different runtime, which
means asserting on which implementation is *selected*, not on behaviour that happens to match
in both.

**#8** is R6's, in M7, and is not built. It needs the contract change first: an explicit
"going away, keep my credential" signal so Python distinguishes intentional absence from a lost
peer instead of evicting at the 120 s stale window. Until that exists there is nothing to test
against, and the plan is explicit that this is a contract change requiring regenerated
cross-language fixtures.

## Reading this honestly

Six of nine are enforced and covered, three of those mutation-confirmed. Two are pending on
work that has not landed. The read-and-run rows are real tests asserting real effects, but they
have not been proven to bite; **#3, #4 and #5 in particular guard impersonation, replay and
cross-peer authority leakage, and deserve mutation confirmation before this work is considered
finished.** They were not mutation-tested here only because the files involved were held by an
agent working in that lane at the time, and corrupting its working tree would have cost more
than the confirmation was worth in that moment.
