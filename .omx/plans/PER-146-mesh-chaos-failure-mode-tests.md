# PER-146 Mesh Chaos and Failure-Mode Test Suite

## Requirements Summary

- Source issue: PER-146 `[MESH][P6-T02] Build mesh chaos and failure-mode test suite`.
- Scope: deterministic unit/integration-style tests only; no external MQTT, WebRTC broker, Redis, Docker, or live peer dependencies.
- Mesh invariants: preserve message-bus-first routing, privacy-first defaults, typed mesh models/selectors, explicit peer/resource addressing for risky remote actions, and no transparent fallback for explicit selectors.
- Relevant code anchors:
  - `app/messaging/mesh_bus.py:189` forwards mesh events only when `mesh=True`, service sharing is enabled, and origin is not `mesh_forwarded`.
  - `app/messaging/mesh_bus.py:399` routes remote requests through `PeerBridge.call()` and then applies fallback.
  - `app/services/gateway/mesh/routing_table.py:109` chooses remote providers for `network` and `network_only` preferences.
  - `app/services/gateway/mesh/routing_table.py:192` rejects explicit selectors whose peer is not negotiated.
  - `app/services/gateway/mesh/routing_table.py:203` rejects explicit selectors blocked by `allowed_peers`.
  - `app/services/gateway/mesh/routing_table.py:261` rejects explicit selectors at capacity.
  - `app/services/gateway/mesh/routing_table.py:299` blocks transparent fallback after an explicit selector target fails.
  - `app/services/gateway/mesh/peer_registry.py:270` exposes negotiated peers only.
  - `app/services/gateway/webrtc/rpc.py:126` republishes forwarded events with `origin="mesh_forwarded"`.

## Acceptance Criteria

- Add a CI-friendly chaos suite covering both successful fallback and safe hard failure.
- Provider disappearance, stale manifests, capacity exhaustion, latency preference changes, token/auth expiry, denied policy, and service restart/reannouncement have explicit expected behavior.
- Unauthorized, stale, or explicitly denied peers are not selected after policy/status changes.
- Mesh-forwarded events are delivered locally without being re-forwarded, preventing forwarding loops.
- Existing targeted mesh/gateway tests remain green.

## Implementation Steps

1. Add `tests/integration/test_mesh_chaos_failure_modes.py` with local fakes around `MeshBus`, `RoutingTable`, `PeerRegistry`, `PeerBridge`-like behavior, and `RPCHandler`.
2. Cover fallback-success scenarios:
   - primary provider disappears mid-request and fallback uses local.
   - primary provider fails and fallback chooses the next eligible network provider.
   - latency updates change remote provider selection.
   - service restart/reannouncement reintroduces a negotiated provider.
3. Cover safe-hard-failure scenarios:
   - stale explicit selector is rejected and does not call local or remote.
   - denied explicit selector is rejected after `allowed_peers` policy changes.
   - at-capacity explicit selector is rejected.
   - `network_only` service with no eligible peer returns a hard error/no-route.
   - authentication expiry/anonymous RPC calls are rejected before bus dispatch.
4. Cover forwarding-loop prevention:
   - normal mesh event forwards once to negotiated peers.
   - received `mesh_forwarded` event publishes locally but does not re-forward.
5. Run targeted verification and the existing mesh/gateway suite listed in the issue.

## Risks and Mitigations

- Risk: overly brittle timing in failure tests. Mitigation: use deterministic fake bridge results instead of sleeps where possible.
- Risk: tests accidentally validate raw string topics as acceptable production patterns. Mitigation: tests may use topic strings to exercise routing module extraction, but no service code is changed.
- Risk: broad external dependencies slow CI. Mitigation: all new tests run with mocks/fakes only.

## Verification Strategy

- `uv run pytest tests/integration/test_mesh_chaos_failure_modes.py -q`
- Existing target suite:
  `uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py tests/integration/test_mesh_chaos_failure_modes.py -q`

## Stop Condition

- Stop after tests and directly affected OMX artifacts are updated, targeted verification passes or the remaining blocker is documented, PR is opened/updated, and QA handoff is posted.
