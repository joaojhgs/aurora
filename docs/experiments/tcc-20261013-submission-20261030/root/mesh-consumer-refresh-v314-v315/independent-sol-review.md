# V314 bounded authenticated-consumer refresh review

2026-10-14 UTC. **APPROVE, source-only**, for the exact recipient-union/test delta. It repairs a concrete source eligibility gap without declaring the retained V313 failure recovered.

| Anchor | SHA256 |
|---|---|
| rtc_client.py current base | ecc207cd7a164959e2bec0aa1e0dcd90af7e3790c8eed418563c610e64dcbd40 |
| rtc_client.py candidate | d3a5ee5e02c976839d221ba7a4996a30f074b42a53fc25530b987879e7dc58b7 |
| lifecycle test current base | f165e5b7c7ec8d93681e01803390c1bdeda51bd14913da5abbc8ae0456369d0d |
| lifecycle test candidate | a9dfed7df2411d7434df10c17826ea2a9f69964819e0f5a4db48505641079664 |
| candidate.patch | b2b4ef775d1f59b16dfe9b3d92d571271802d2798e92adb263f11dee65238900 |
| REPORT.md | 5159bb0f70938a444e8c6d574289d966e0884364b572eb2c77c3a3b9e540e1f1 |

Independently verified all hashes/bases; read the exact patch and necessary existing recipient/auth/session guards plus fixtures. No tests/Ruff/compiler/build/services/models/network/browser/device/source/index/goals/ledger/vault edits, commits or agents. Only this private report is written; Root owns serial integration and execution.

## Important source checks

PeerRegistry.get_negotiated_peers selects only status negotiated. That inbound-provider eligibility is narrower than an authenticated active recipient consuming this node's exported manifest. The existing global invalidator clears all local-ready recipients, so refreshing only negotiated providers can leave an authenticated consumer unavailable after its earlier manifest was invalidated.

Candidate retains old negotiated targets (same str(peer.peer_id) conversion), deduplicates them preserving their order, then adds mapped stable recipients only through the existing _can_reannounce_manifest_for_peer. The mapping is typed dict[str,str], not a new trust source. That guard requires mesh/registry, consistent forward/reverse stable/session IDs, active open DataChannel and nonterminal peer connection, matching session/stable ACL identities, exclusion of ANONYMOUS/OPEN_PEER, both identity sources webrtc_peer, and an existing session send function. Stored mapping alone cannot pass it.

Union ordering is deterministic for unchanged ordered registry/session inputs; no lexical sorting is added or needed, and prior target order is retained. Deduplication prevents duplicate tasks for the same stable ID. Recipient enumeration/guard checks are synchronous before any refresh task awaits. Existing active-task coalescing, V312 global+peer generation catch-up, unavailable-before-refresh sequence, replacement-safe finally and close cancellation remain byte-preserved outside the target enumeration.

Actual reannounce still revalidates its existing auth/session guard at execution, then uses current mesh policy/recipient-specific projection, send/ACK/lease admission. Scheduling a consumer refresh grants no permission, role, provider readiness or method access. No trust/admission/model retry or runtime-role change is introduced.

## Focused regression

The new test sets negotiated peers empty while establishing real existing identity/reverse-map/ACL/open-channel/connection/send-function inputs. It does not stub _can_reannounce or _has_authenticated/_is_peer_session_active. The real invalidation/scheduler must create and finish the consumer task, call reannounce once and clear the map; the old negotiated-only scheduler creates no task and fails. The reannounce itself is a spy, so the test proves recipient selection/cleanup, not live auth/manifest/ACK/model acceptance. Existing generation/order tests remain applicable without expansion.

## Limits and bounded handoff

V313 first exact reply then manifest-unavailable/no-second-dispatch remains an actual failed flow. This source mechanism is concrete; its runtime attribution/recovery requires Root's affected tests/Ruff and one same-options two-request flow. Closed local/API/UI/history gates need no replay. Existing count/input-hash eligibility and MAIN hold remain; no new fields, broader edge matrix or speculative security repair requested. This review is actual native independent source evidence for Root's original Orca relay, not a platform/full-study acceptance.
