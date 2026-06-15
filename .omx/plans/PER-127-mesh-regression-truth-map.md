# PER-127 Mesh Regression Truth Map

## Scope

This file captures the current Aurora mesh/gateway regression baseline for
PER-127 only. It is a truth map and test matrix, not an implementation plan for
P0-T02 diagnostics or later identity, config, tooling, data, scheduler, or audio
mesh work.

Sources read:

- `.omx/multica/mesh-roadmap-tasks/01-meshp0-t01-establish-mesh-regression-truth-map-and-baseline-test-matrix.md`
- `.omx/multica/mesh-roadmap-tasks/created-issues.json`
- `.omx/specs/deep-interview-mesh-distributed-integration.md`
- `AGENTS.md`
- `app/services/gateway/AGENTS.md`
- `tests/AGENTS.md`

GitNexus MCP resources were unavailable in this session, so this matrix is based
on direct repository inspection.

## Execution Plan

Acceptance criteria:

- Regression matrix references concrete mesh/gateway test files and test names.
- Current supported behavior is separated from inferred or desired behavior.
- Uncovered areas are listed as follow-up test tasks or sections.
- The targeted mesh/gateway suite remains green, or failures are documented with
  exact cause and the maximal deterministic subset.

Verification strategy:

```bash
uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q
```

No production code changes are planned for this issue. If a test must be added,
it should be a narrow matrix/provenance assertion only; roadmap behavior belongs
to its own follow-up issue.

## Current Supported Behavior

These rows are supported by concrete tests in the required baseline suite.

| Area | Current supported behavior | Concrete regression coverage |
| --- | --- | --- |
| Manifest generation | A node advertises only services with `share=True`, includes node/version/service metadata, preserves service capacity, and excludes internal-only methods from advertised method lists. | `tests/unit/gateway/test_negotiation.py::TestGenerateManifest` (`test_generates_manifest_for_shared_services`, `test_excludes_non_shared_modules`, `test_excludes_internal_methods`) |
| Manifest ACK compatibility | A received manifest is classified into compatible, incompatible, or unused services based on local routing interest, version policy, local-only preference, and required capabilities. | `tests/unit/gateway/test_negotiation.py::TestGenerateManifestAck` |
| Manifest serialization | Manifest and manifest ACK payloads round-trip through dict parse/serialize helpers, with invalid manifest payloads rejected and ACK defaults tolerated. | `tests/unit/gateway/test_negotiation.py::TestSerialization` |
| Topic-to-module routing | Dotted and plain topics resolve to the module prefix used by routing decisions. | `tests/unit/gateway/test_routing_table.py::TestExtractModule` |
| Local and network routing preferences | Unknown modules and `prefer=local`/`local_only` route locally; `prefer=network` routes to a negotiated peer when one exists and falls back locally when none exists; `network_only` without a provider returns no/error routing. | `tests/unit/gateway/test_routing_table.py::TestRoutingTableResolve` |
| Peer exclusion and fallback routing | Failed or excluded peers are skipped; `fallback=local`, `fallback=network`, and `fallback=error` resolve to the expected route classes. | `tests/unit/gateway/test_routing_table.py::TestRoutingTableResolveFallback` |
| Outbound peer RPC bridge | Peer calls serialize Pydantic or dict payloads, register pending calls, resolve result/error responses, report send failures/timeouts, route pong frames to the latency monitor, and cancel pending calls during shutdown. | `tests/unit/gateway/test_peer_bridge.py::TestPeerBridgeCall`, `TestPeerBridgeOnResponse`, `TestPeerBridgeOnPong`, `TestPeerBridgeCancelAll` |
| WebRTC RPC basic handling | Invalid/non-call messages are ignored, missing or unknown methods return errors, forbidden methods return 403, bus successes/errors/timeouts map to JSON-RPC responses, streams emit chunks plus EOF, and datetimes serialize to ISO-8601. | `tests/unit/gateway/test_rpc.py` pre-mesh tests |
| Inbound mesh sharing gate | With mesh enabled, unshared services are rejected, shared services pass through, Auth pairing/login infrastructure methods bypass the sharing gate, and per-service capacity returns 429. | `tests/unit/gateway/test_rpc.py` mesh gate tests; `tests/integration/test_mesh_permissions.py::TestSharingGate` |
| WebRTC auth enforcement | With `require_auth=True`, anonymous non-auth traffic is dropped, auth and pairing RPCs are allowed, non-pairing RPCs are blocked, valid DB tokens grant scoped identities, saved tokens auto-authenticate on open, and anonymous peers are disconnected after auth/pairing timeouts. | `tests/unit/gateway/test_rtc_auth_enforcement.py` |
| WebRTC weak-room safeguards | Empty WebRTC password blocks startup when auth is required, logs a warning when auth is disabled, and public MQTT broker use logs a warning while auth is enabled. | `tests/unit/gateway/test_rtc_auth_enforcement.py` |
| MeshBus local/remote routing | Local-preferred topics bypass remote peers; network-preferred topics call remote peers when a negotiated provider exists; missing providers fall back locally; events publish locally regardless of routing config. | `tests/integration/test_mesh_routing.py::TestMeshRoutingEndToEnd` |
| Registry-driven route selection | Stale peers are excluded, lower-latency peers win with `lowest_latency`, and peers at capacity are not selected. | `tests/integration/test_mesh_routing.py::TestMeshRegistryToRouting` |
| Remote failure fallback | Remote timeouts, send failures, and error responses fall back to local for `fallback=local`; peer removal causes local fallback; `network_only` with no provider returns failure. | `tests/integration/test_mesh_failover.py::TestRemoteFailureFallback`, `TestNetworkOnlyWithNoFallback`, `TestPeerLifecycleImpactsRouting` |
| Network fallback mode | `fallback=network` attempts another provider after the first provider fails. The current assertion only requires a successful result because response timing can choose the second peer or another successful path. | `tests/integration/test_mesh_failover.py::TestNetworkFallbackToAnotherPeer` |

## Supporting Coverage Outside Required Suite

These tests are useful for interpreting the baseline but are not part of the
issue's required command:

| Area | Supporting coverage |
| --- | --- |
| Peer registry lifecycle and provider selection | `tests/unit/gateway/test_peer_registry.py` covers peer registration/removal, manifest updates, latency state, active-call capacity, provider lookup, lowest-latency/round-robin/random selection, negotiated peer filtering, and stale-peer checks. |
| Gateway room/password generation | `tests/unit/gateway/test_room_autogen.py` covers WebRTC room/password auto-generation paths when optional WebRTC dependencies are installed. |
| Auth/principal HTTP integration | `tests/integration/test_auth_endpoints.py` and `tests/integration/test_principal_management.py` cover principal permissions and pairing-token behavior outside the mesh routing suite. |

## Current Behavior Not Fully Proven By Required Suite

These items are present or implied by source/docs, but the required baseline
suite does not prove them end to end.

| Area | Status | Follow-up owner/task |
| --- | --- | --- |
| Stable multi-peer identity across WebRTC peer IDs, Auth principal/device IDs, registry peer IDs, and manifests | Desired/inferred, not fully proven. Existing tests use simple `peer1`/`remote-1` IDs and do not validate identity consistency across subsystems. | PER-129 `[MESH][P1-T01]` |
| Saved WebRTC tokens are peer-scoped and multi-peer safe | Partially covered. `test_on_open_sends_saved_token_if_available` proves a saved token is sent for one peer key, but not collision resistance or token lookup for multiple peers. | PER-130 `[MESH][P1-T02]` |
| Bilateral reverse pairing is peer-specific | Desired/inferred. Pairing RPC allowlisting is covered, but reverse-pairing persistence and peer-specific routing are not. | PER-131 `[MESH][P1-T03]` |
| Mesh runtime config parity with schema/defaults | Gap. Runtime `MeshServiceConfig` fields such as `allowed_peers`, `min_version`, and `required_capabilities` participate in policy/negotiation, but schema/default parity is not asserted by the required suite. | PER-132 `[MESH][P1-T04]` |
| DataChannel application-layer E2EE semantics | Gap. Tests cover room password and signaling warnings, but not app-layer E2EE on/off semantics or distinction from WebRTC DTLS transport security. | PER-133 `[MESH][P1-T05]` |
| Manifest ACK diagnostics surface | Gap. ACK classification is tested, but no status/diagnostic endpoint or persisted compatibility report is covered. | PER-128 `[MESH][P0-T02]` |
| Service re-announcement after restart or registry churn | Desired/inferred from service/registry design, not proven by the required suite. | PER-128 or PER-146 depending on whether the test is diagnostic or chaos/failure-mode focused |
| Process-mode Gateway restart and mesh state rebuild | Desired/inferred. Required suite uses mocked in-memory components, not process-mode Redis/Gateway restart. | PER-146 `[MESH][P6-T02]` |
| Explicit peer/resource selectors and provider aggregation | Desired future behavior. Current transparent module routing is covered, but explicit selectors and multi-provider aggregation are not implemented/tested here. | PER-135, PER-136 |
| Remote tooling discovery/execution provenance | Desired future behavior. Current mesh baseline does not prove peer/source metadata, stable remote tool IDs, explicit execution routing, or audit provenance. | PER-137, PER-138, PER-139 |
| DB/RAG, scheduler, TTS/STT/audio cross-peer privacy boundaries | Desired future behavior. Current suite has no DB replication, scheduler namespace, remote playback, or microphone/audio sharing assertions. | PER-140, PER-141, PER-142, PER-143 |
| Auth and Config mesh exposure boundaries | Desired future behavior. Current Auth pairing/login bypass exists as infrastructure, but broad Auth/Config exposure policy is not established here. | PER-144 |
| Distributed tracing, audit views, and chaos/failure-mode matrix | Desired future behavior. Current suite proves selected fallback mechanics but not cross-peer correlation IDs, route traces, audit views, or broader chaos scenarios. | PER-145, PER-146 |

## Baseline Test Matrix

Run this command before downstream mesh work starts:

```bash
uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q
```

Expected baseline at the time this roadmap task was created was `88 passed, 13
warnings`. Treat any different result as signal: either update this truth map
with exact cause/evidence or fix the regression in the owning task.

## Verification Evidence

2026-06-15 local verification:

- `uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q` failed before test execution in the fresh sandbox: first because `/home/developer/.cache/uv` was read-only, then because the minimal environment did not include `pytest`.
- `uv run --extra test-integration pytest ... -q` installed the declared test dependencies but failed during collection because `test_rtc_auth_enforcement.py` imports `aiortc`, which is owned by the repo's `gateway` extra.
- `uv run --extra gateway --extra test-integration pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q` passed: `88 passed, 13 warnings in 13.49s`.

## Stop Rules For Future Work

- Do not treat a roadmap row above as implemented just because it is desired.
- Do not broaden transparent routing to tools, DB/data, hardware, scheduler,
  remote playback, Auth, or Config mutation without an explicit scoped task and
  policy test.
- Do not remove or weaken any baseline test without replacing its truth-map row
  with an equivalent concrete assertion.
- Keep mesh sharing opt-in and message-bus-first.
