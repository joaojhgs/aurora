# PER-130 Peer-Scoped WebRTC Token Plan

## Sources
- Multica issue PER-130 and empty comment history.
- Repo guidance: root, services, gateway, auth, and tests AGENTS files.
- Available mesh context: `.omx/plans/PER-129-stable-mesh-identity.md`; the issue-named mesh roadmap files are not present in this checkout.
- Code paths: `app/services/gateway/webrtc/rtc_client.py`, `app/services/gateway/service.py`, `app/services/gateway/auth_proxy.py`, `app/services/auth/service.py`, `tests/unit/gateway/test_rtc_client_auth.py`.

## Acceptance Criteria
- Saved token lookup is peer-specific.
- Multi-peer reconnects authenticate with the correct token.
- Missing or ambiguous peer identity fails safe into pairing rather than sending a random token.
- Tests cover two or more saved peer credentials.

## Implementation Steps
1. Add an `RTCClient` helper that resolves a saved token by known stable remote peer ID or active session ID.
2. Preserve `_default` only as a legacy single-credential fallback when no peer-specific tokens are loaded.
3. Remove arbitrary single-token fallback from channel-open auth.
4. Make reverse-pairing skip only when the resolver can safely identify a saved credential for the peer.
5. Add tests for exact stable-peer selection, ambiguous unknown peer safe-fail, and legacy `_default` fallback.
6. Run targeted gateway auth tests.

## Verification Strategy
- `uv run pytest tests/unit/gateway/test_rtc_client_auth.py tests/unit/gateway/test_rtc_auth_enforcement.py -q`
