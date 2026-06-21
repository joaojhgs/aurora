# PER-128 Mesh Diagnostics Plan

## Requirements Summary

- Source issue: PER-128 `[MESH][P0-T02] Add mesh status and route diagnostic surface`.
- The referenced committed `.omx/specs/deep-interview-mesh-distributed-integration.md` and mesh task bundle are not present on the checked-out feature branch; scope is therefore constrained to the Multica issue body and existing mesh implementation.
- Add a read-only diagnostic surface that explains local mesh state, peers, negotiated services, compatibility failures, route decisions, capacity, active calls, and recent ping/latency state.
- Preserve privacy-first defaults: do not expose tokens, credentials, MQTT passwords, WebRTC room passwords, API keys, or raw secrets.

## Implementation Steps

1. Extend `app/shared/contracts/models/gateway.py` with `Gateway.GetMeshStatus` and typed response models for local state, peers, services, compatibility, capacity, and route diagnostics.
2. Implement `GatewayService.get_mesh_status` in `app/services/gateway/service.py` using existing mesh components only: `PeerRegistry`, `RoutingTable`, mesh config, local peer id, and live manifest ACK generation.
3. Include route diagnostics for configured modules and peer-provided modules so operators can see whether Tooling/DB/TTS route local, remote, none, or error, and why.
4. Document the dynamic HTTP/API usage in `docs/GATEWAY.md`.
5. Add focused unit tests for serialization, disabled mesh state, peer diagnostics, route decisions, compatibility failures, capacity, and secret redaction.

## Acceptance Criteria

- `Gateway.GetMeshStatus` returns JSON that answers which peer provides a configured module and why the route goes local, remote, none, or error.
- Peer lifecycle states include authenticated, negotiated, and stale.
- Compatibility failures are visible from both the locally generated ACK and the remote ACK stored on peer state.
- Capacity and active calls are visible per peer service.
- The response contains no token/password/secret/API-key fields or raw credentials.
- Targeted tests pass.

## Verification

- `uv run pytest tests/unit/gateway/test_mesh_diagnostics.py -q`
- If practical after the focused tests pass: targeted mesh/gateway tests that touch routing, negotiation, and gateway service behavior.
