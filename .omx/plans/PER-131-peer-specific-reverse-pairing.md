# PER-131 Peer-Specific Reverse Pairing Plan

## Sources
- Multica issue PER-131, metadata, and empty comment history.
- Repo guidance: root `AGENTS.md`, `app/services/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/services/auth/AGENTS.md`, and `tests/AGENTS.md`.
- Code paths: `app/services/gateway/webrtc/rtc_client.py`, gateway RTC auth tests.
- Docs: `docs/PEER_PAIRING_FLOW.md`, `docs/MESH_PAIRING_FIX_PLAN.md`.

## Scope
- Ensure `_reverse_pairing()` skips only when this node already holds a saved credential keyed to the current remote stable peer.
- Preserve reconnect auth fallback behavior that can still use legacy `_default` tokens before the remote stable peer is known.
- Add focused multi-peer coverage and update bilateral pairing docs.

## Implementation Steps
1. Keep stable-peer lookup through `_stable_peer_id_for_session(peer)`.
2. Change reverse-pairing skip logic to check only the current peer's stable token key, not `_default` or unrelated tokens.
3. Expand log messages to include the stable peer key used for the start/skip decision.
4. Add unit tests covering peer A already saved and peer B newly authenticated, including legacy `_default` presence.
5. Update docs so Phase 2 says the skip is peer-specific.
6. Run targeted RTC auth tests.

## Verification
- `uv run pytest tests/unit/gateway/test_rtc_client_auth.py tests/unit/gateway/test_rtc_auth_enforcement.py -q`

## Notes
- The branch checkout lacks the committed `.omx/specs/deep-interview-mesh-distributed-integration.md` and per-task mesh task bundle named by the issue, so the Multica issue body and available docs are the task source of truth for this run.
