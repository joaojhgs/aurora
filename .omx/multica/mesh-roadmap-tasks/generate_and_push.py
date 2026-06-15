#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import textwrap
from pathlib import Path

PROJECT_ID = "5345dd7c-2f0b-4a4b-b636-c1db93067f0a"
OUT = Path(".omx/multica/mesh-roadmap-tasks")
OUT.mkdir(parents=True, exist_ok=True)

COMMON_CONTEXT = """
This task is part of the Aurora mesh-polishing roadmap derived from `.omx/specs/deep-interview-mesh-distributed-integration.md`.

Current confirmed baseline:
- Targeted mesh/gateway tests previously passed: `88 passed, 13 warnings`.
- `MeshBus` already routes commands and mesh events through routing/peer bridge paths.
- WebRTC pairing, manifest exchange, service negotiation, and service sharing are implemented to a working baseline.
- Orchestrator already uses the bus for Tooling discovery/execution, and Tooling exposes `GetTools`/`ExecuteTool` as mesh-shareable methods.

Roadmap constraints:
- Preserve Aurora's privacy-first, message-bus-first microservice architecture.
- Use pragmatic security tiers across home LAN/VPN, Docker/process clusters, and internet-crossing peers.
- Use hybrid addressing: transparent routing is allowed for low-risk service dependencies, but explicit peer/resource addressing is required for tools, DB/data, hardware, scheduler ownership, remote playback, and safety-sensitive actions.
- Prefer existing contracts/utilities and typed topic constants; avoid exposing raw internal/admin capabilities by default.
""".strip()

tasks = [
    {
        "title": "[MESH][EPIC] Mesh polishing roadmap: secure cross-peer service fabric",
        "phase": "EPIC",
        "labels": ["mesh", "mesh-roadmap", "mesh-epic"],
        "summary": "Parent task for polishing Aurora mesh into a secure, observable, hybrid-addressed cross-peer service fabric.",
        "description": """
## Objective
Coordinate the full mesh-polishing roadmap as a parent issue. The outcome is a secure and observable peer service fabric where Aurora peers can safely share selected services, tools, data capabilities, and device-specific resources.

## Context
{context}

## Scope
This epic tracks the child tasks from foundation regression safety through identity hardening, capability graph/addressing, remote Tooling/Orchestrator integration, DB/data sharing design, module-specific integrations, and operational readiness.

## Definition of done
- Every child `[MESH][P#]` task has either been completed or intentionally deferred with a documented reason.
- Mesh functionality has a validated safety baseline for multi-peer pairing, service negotiation, routing, and observability.
- The next implementation roadmap can be created from the completed child-task evidence.
""",
    },
    {
        "title": "[MESH][P0-T01] Establish mesh regression truth map and baseline test matrix",
        "phase": "P0",
        "labels": ["mesh", "mesh-roadmap", "mesh-p0", "test-coverage"],
        "summary": "Convert the current passing mesh state into an explicit regression matrix and documented truth map.",
        "description": """
## Objective
Capture the current working mesh state as a regression truth map before making additional changes. This prevents later polishing work from accidentally regressing WebRTC pairing, manifest negotiation, mesh routing, service announcements, or permission gates.

## Context
{context}

Important anchors:
- `tests/unit/gateway/test_negotiation.py`
- `tests/unit/gateway/test_routing_table.py`
- `tests/unit/gateway/test_peer_bridge.py`
- `tests/unit/gateway/test_rpc.py`
- `tests/unit/gateway/test_rtc_auth_enforcement.py`
- `tests/integration/test_mesh_routing.py`
- `tests/integration/test_mesh_permissions.py`
- `tests/integration/test_mesh_failover.py`

## Initial implementation plan
1. Inventory existing gateway/mesh unit and integration tests and map each to the feature it proves.
2. Add a markdown truth map under `docs/` or `.omx/plans/` describing current expected behavior for pairing, authentication, manifests, routing, fallback, and permissions.
3. Identify uncovered assertions for multi-peer identity, peer-scoped tokens, manifest ACK diagnostics, config schema parity, service re-announcement, and DataChannel E2EE behavior.
4. Add targeted TODO test cases or pending test-plan sections for uncovered areas.
5. Ensure all existing targeted tests still pass unchanged before downstream work starts.

## Acceptance criteria
- A regression matrix exists and references concrete tests/files.
- Current supported behavior is distinguished from inferred or desired behavior.
- Existing targeted mesh/gateway suite passes.
- Uncovered areas are listed as follow-up test tasks rather than silently assumed.

## Suggested verification
- `uv run pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q`
""",
    },
    {
        "title": "[MESH][P0-T02] Add mesh status and route diagnostic surface",
        "phase": "P0",
        "labels": ["mesh", "mesh-roadmap", "mesh-p0", "observability"],
        "summary": "Expose a concise mesh status/debug view for identity, peers, manifests, routing, failures, and active calls.",
        "description": """
## Objective
Make the current mesh state inspectable. Operators and developers need a single diagnostic surface that explains local mesh identity, connected peers, negotiated services, route decisions, compatibility failures, capacity, active calls, and recent ping/latency state.

## Context
{context}

Relevant code anchors:
- `app/services/gateway/service.py` mesh startup and component wiring.
- `app/services/gateway/mesh/peer_registry.py` peer/service/capacity state.
- `app/services/gateway/mesh/routing_table.py` route decisions and fallback.
- `app/services/gateway/mesh/negotiation.py` manifests and compatibility ACKs.
- `docs/GATEWAY.md` for gateway API documentation.

## Initial implementation plan
1. Decide whether the first diagnostic surface is a Gateway endpoint, internal contract method, CLI-friendly JSON dump, or all of the above.
2. Define a typed response model with local mesh identity, WebRTC status, peer list, peer statuses, negotiated services, manifests/ACK compatibility diagnostics, route preferences, and active remote calls.
3. Add read-only implementation with no mutation side effects.
4. Include safe redaction: never expose tokens, secrets, broker passwords, or raw credentials.
5. Document how to use the diagnostic output to troubleshoot service sharing and routing.

## Acceptance criteria
- A developer can answer: “which peer provides Tooling/DB/TTS and why did this route go local/remote/fail?”
- Secrets are redacted.
- Stale/negotiated/authenticated peer states are visible.
- Compatibility failures are visible without searching logs.
- The diagnostic surface is covered by tests or snapshot assertions.

## Suggested verification
- Unit tests around serialization/redaction.
- Manual or integration smoke test with at least one mocked negotiated peer.
""",
    },
    {
        "title": "[MESH][P1-T01] Align stable mesh identity across WebRTC, Auth, registry, and manifests",
        "phase": "P1",
        "labels": ["mesh", "mesh-roadmap", "mesh-p1", "identity", "webrtc"],
        "summary": "Ensure the same stable peer identity is used consistently across signaling/auth/registry/manifest paths.",
        "description": """
## Objective
Remove identity ambiguity between ephemeral WebRTC signaling IDs and stable mesh identities. Multi-peer reconnection, persisted credentials, registry records, and manifests should all refer to the correct stable peer identity where security or policy depends on identity.

## Context
{context}

Observed risk:
- The roadmap investigation found evidence that WebRTC signaling peer IDs may be session-ephemeral while Auth/DB mesh identities are stable.
- Persisted tokens and peer registry updates need stable IDs to avoid multi-peer confusion.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py`
- `app/services/gateway/service.py` `_start_mesh`
- `app/services/auth/service.py` mesh identity/peer methods
- `app/shared/contracts/models/mesh.py`

## Initial implementation plan
1. Trace all peer ID fields and meanings: signaling session peer, stable mesh peer, principal/user/device IDs, manifest peer ID, registry peer ID.
2. Document the canonical identity model in code comments and docs.
3. Update WebRTC auth/manifest paths so stable peer ID is available and used for persisted credentials, registry records, manifests, ACL checks, and diagnostics.
4. Keep ephemeral signaling IDs only where transport/session addressing requires them.
5. Add migration-safe handling for existing saved credentials keyed by older IDs.

## Acceptance criteria
- Stable peer ID is consistently used for persisted credential lookup and mesh policy.
- Session/signaling ID is clearly separated from stable identity.
- Manifest and peer registry records expose stable identity.
- Tests cover reconnect and manifest exchange with distinct stable vs session IDs.

## Suggested verification
- Unit tests for identity mapping.
- Integration/mocked test with two peers reconnecting after signaling ID changes.
""",
    },
    {
        "title": "[MESH][P1-T02] Make saved WebRTC mesh tokens peer-scoped and multi-peer safe",
        "phase": "P1",
        "labels": ["mesh", "mesh-roadmap", "mesh-p1", "auth", "webrtc"],
        "summary": "Replace global saved-token shortcuts with peer-specific token selection and re-auth behavior.",
        "description": """
## Objective
Prevent wrong-token reuse when multiple peers exist. Returning-peer authentication should select the token for the specific remote peer, not the first saved token in memory.

## Context
{context}

Observed risk:
- Investigation found a channel-open path that selects `next(iter(self._saved_auth_tokens.values()), None)`, which is only safe for a single-peer mesh.
- Multi-peer topologies are explicitly in scope.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py` saved token send path.
- `app/services/auth/service.py` mesh credential persistence methods.
- `app/services/db/service.py` mesh credential storage methods.

## Initial implementation plan
1. Define saved credential keying by stable remote peer ID and, if necessary, room/signaling context.
2. During channel open, resolve the remote stable peer identity before sending a saved token; if not known, use a safe handshake to request/derive identity without leaking unrelated tokens.
3. Remove global “first token” behavior.
4. Add explicit logging/diagnostics for token lookup miss, peer mismatch, revoked token, and successful peer-scoped re-auth.
5. Add tests for two saved peers and ensure peer A never receives peer B's token.

## Acceptance criteria
- Saved token lookup is peer-specific.
- Multi-peer reconnects authenticate with the correct token.
- Missing or ambiguous peer identity fails safe into pairing rather than sending a random token.
- Tests cover two or more saved peer credentials.

## Suggested verification
- Unit tests around token map lookup and channel-open auth.
- Integration-style mocked RTCClient test with two peers.
""",
    },
    {
        "title": "[MESH][P1-T03] Make bilateral reverse pairing peer-specific",
        "phase": "P1",
        "labels": ["mesh", "mesh-roadmap", "mesh-p1", "auth", "pairing"],
        "summary": "Fix reverse pairing skip logic so one saved token does not suppress pairing for unrelated peers.",
        "description": """
## Objective
Ensure bilateral pairing completes independently for each peer. A saved credential for one peer must not cause reverse pairing to be skipped for another peer.

## Context
{context}

Observed risk:
- Investigation found reverse pairing checks whether any saved token exists, not whether the current peer already has a valid saved token.
- This can break multi-peer bilateral trust establishment.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py` `_reverse_pairing`.
- `docs/MESH_PAIRING_FIX_PLAN.md` bilateral pairing expectations.
- `docs/PEER_PAIRING_FLOW.md` pairing flow documentation.

## Initial implementation plan
1. Change reverse pairing precondition from “any saved tokens exist” to “a valid token exists for this stable remote peer”.
2. Reuse the peer-scoped identity model from `[MESH][P1-T01]` and saved-token work from `[MESH][P1-T02]`.
3. Add tests for peer A already paired, peer B newly authenticating, and reverse pairing still starting for peer B.
4. Update docs to describe peer-specific bilateral pairing state.

## Acceptance criteria
- Reverse pairing skip is peer-specific.
- Existing single-peer flow still works.
- Multi-peer reverse pairing is covered by tests.
- Logs explain why reverse pairing starts or skips for each peer.

## Suggested verification
- Unit tests for `_reverse_pairing` conditions.
- Mocked bilateral pairing integration flow.
""",
    },
    {
        "title": "[MESH][P1-T04] Bring mesh sharing config schema to parity with runtime policy fields",
        "phase": "P1",
        "labels": ["mesh", "mesh-roadmap", "mesh-p1", "config", "security"],
        "summary": "Expose or intentionally remove advanced mesh policy fields so config schema/defaults match runtime behavior.",
        "description": """
## Objective
Fix the mismatch between runtime `MeshServiceConfig` and generated config schema/defaults. Operators need supported config knobs for peer allowlists, version requirements, and required capabilities if those fields are part of the intended policy model.

## Context
{context}

Observed facts:
- Runtime config supports `allowed_peers`, `min_version`, and `required_capabilities`.
- Generated schema currently exposes only `share`, `max_concurrent`, `prefer`, and `fallback`.

Relevant code anchors:
- `app/services/gateway/config.py`
- `app/services/config/config_schema.json`
- `app/services/config/config_defaults.json`
- `app/shared/config/models.py`
- `app/shared/config/keys.py`
- `docs/CONFIG_SERVICE_PATTERN.md`

## Initial implementation plan
1. Decide which runtime fields are officially supported for the next mesh phase.
2. Add supported fields to `config_schema.json` with safe defaults and descriptions.
3. Run config generation (`make generate-config`) so models, keys, and defaults stay schema-first.
4. Update docs with examples for home, process-cluster, and internet-crossing trust tiers.
5. Add tests or validation checks for schema/model parity.

## Acceptance criteria
- Runtime mesh config and generated schema/defaults agree.
- Unsupported fields are removed or documented as intentionally internal.
- Config examples cover `allowed_peers`, version policy, and required capabilities if supported.
- `make generate-config` outputs are included when schema changes.

## Suggested verification
- `make generate-config`
- Targeted config validation tests.
- `make lint` and relevant unit tests.
""",
    },
    {
        "title": "[MESH][P1-T05] Clarify and test DataChannel app-layer E2EE behavior",
        "phase": "P1",
        "labels": ["mesh", "mesh-roadmap", "mesh-p1", "security", "webrtc"],
        "summary": "Determine whether DataChannel RPC uses app-layer E2EE or WebRTC DTLS only, then align code/docs/tests.",
        "description": """
## Objective
Resolve ambiguity around `enable_app_layer_e2ee`. If app-layer E2EE is intended for DataChannel RPC, outbound send paths must seal payloads and inbound paths must consistently unseal them. If WebRTC DTLS is the intended protection, config/docs should not imply an additional DataChannel encryption layer.

## Context
{context}

Observed risk:
- Investigation found inbound binary decrypt logic, while common send paths send JSON strings directly.
- Signaling encryption and DataChannel transport security should be documented separately.

Relevant code anchors:
- `app/services/gateway/webrtc/rtc_client.py`
- `app/services/gateway/mesh/peer_bridge.py`
- `app/services/gateway/utils/crypto.py`
- `docs/GATEWAY.md`

## Initial implementation plan
1. Trace all DataChannel send/receive paths: auth messages, RPC calls, results, errors, manifests, ping/pong, capacity updates, mesh events.
2. Decide the supported modes: DTLS-only, app-layer E2EE, or both.
3. Align implementation with the chosen mode and fail safely on mixed-mode peers.
4. Add compatibility diagnostics in manifest/ACK or mesh status if E2EE settings mismatch.
5. Update docs and tests.

## Acceptance criteria
- Config option behavior is unambiguous.
- Send and receive paths are symmetric for the chosen mode.
- Mismatched peers fail safely or negotiate a documented fallback.
- Tests cover encrypted and non-encrypted paths.

## Suggested verification
- Unit tests for `send_to_peer`/receive encoding behavior.
- Mocked peer bridge RPC round trip under both modes.
""",
    },
    {
        "title": "[MESH][P2-T01] Design and implement mesh capability graph core models",
        "phase": "P2",
        "labels": ["mesh", "mesh-roadmap", "mesh-p2", "capability-graph", "contracts"],
        "summary": "Create first-class models for peers, services, methods, tools, resources, trust tiers, policies, and provider metadata.",
        "description": """
## Objective
Move beyond module-level provider selection by introducing a first-class capability graph. The graph should describe what each peer can provide, under which trust/policy constraints, and how callers should address those capabilities.

## Context
{context}

Current limitation:
- `MeshBus` and `RoutingTable` select a provider for a whole service module.
- Desired remote Tooling and DB/data sharing require provider aggregation and explicit resource identity.

Relevant code anchors:
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/negotiation.py`
- `app/shared/contracts/models/mesh.py`
- `app/shared/contracts/models/gateway.py`

## Initial implementation plan
1. Define typed capability graph models: peer, service instance, method, tool, resource, safety class, trust tier, policy requirements, latency/capacity, version, capabilities, and provenance.
2. Decide whether graph state lives in Gateway only, Auth/DB persistence, or a shared registry module.
3. Populate graph from local registry, remote manifests, Tooling discovery metadata, and future DB/resource descriptors.
4. Expose read-only graph query methods for Gateway/Orchestrator diagnostics.
5. Keep backward-compatible module-level routing while graph consumers are introduced.

## Acceptance criteria
- Capability graph can represent multiple peers providing the same module with different capabilities.
- Graph includes enough metadata for remote Tooling, DB namespaces, hardware tools, and scheduler ownership.
- Existing routing continues to work.
- Graph query output is redacted and safe for diagnostics.

## Suggested verification
- Model validation tests.
- Graph construction tests from local and remote manifests.
""",
    },
    {
        "title": "[MESH][P2-T02] Add hybrid addressing primitives for peer, provider, resource, and namespace selectors",
        "phase": "P2",
        "labels": ["mesh", "mesh-roadmap", "mesh-p2", "addressing", "contracts"],
        "summary": "Add typed selectors so sensitive operations can target explicit peer/resource identities while low-risk routing stays transparent.",
        "description": """
## Objective
Introduce hybrid addressing primitives that let callers choose explicit peers/resources when needed without breaking transparent module routing for simple local-like dependencies.

## Context
{context}

Roadmap decision:
- Target addressing model is hybrid.
- Transparent routing remains useful for low-risk service dependencies.
- Explicit peer/resource addressing is required for tools, DB/data, hardware controls, scheduler ownership, remote playback, and privacy-sensitive data.

Relevant code anchors:
- `app/messaging/mesh_bus.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/shared/contracts/models/mesh.py`
- `app/shared/contracts/models/tooling.py`
- `app/shared/contracts/models/db.py`

## Initial implementation plan
1. Define common selector models: `peer_id`, `provider_id`, `service_instance_id`, `resource_namespace`, `tool_id`, `hardware_target`, `data_scope`.
2. Decide where selectors live in request payloads vs envelope metadata.
3. Update routing resolution to honor explicit selectors before transparent routing preferences.
4. Add clear errors when explicit selectors reference missing, unauthorized, stale, or incompatible providers.
5. Document which services remain transparent and which require explicit selectors.

## Acceptance criteria
- Explicit selector paths are typed and validated.
- Transparent routing remains backward compatible.
- Selector failures return actionable errors.
- Safety-sensitive categories can require explicit selectors by policy.

## Suggested verification
- Routing table tests for explicit peer/resource selection.
- MeshBus tests for transparent vs explicit routing precedence.
""",
    },
    {
        "title": "[MESH][P2-T03] Support provider aggregation instead of one-provider-per-module routing",
        "phase": "P2",
        "labels": ["mesh", "mesh-roadmap", "mesh-p2", "routing", "capability-graph"],
        "summary": "Allow discovery and planning across multiple providers of the same service rather than selecting only one module provider.",
        "description": """
## Objective
Enable Aurora to see capabilities from multiple peers at once. This is essential for the target where one computer can use tools from multiple peer devices, such as a Raspberry Pi with physical-switch tools and another workstation with GPU/LLM capabilities.

## Context
{context}

Current limitation:
- `PeerRegistry.get_best_provider()` selects one best provider for a module.
- Remote Tooling needs aggregation of local and remote tools across all authorized peers.

Relevant code anchors:
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/services/gateway/mesh/negotiation.py`
- Future capability graph from `[MESH][P2-T01]`.

## Initial implementation plan
1. Add APIs to list all eligible providers for a service/capability rather than only the best provider.
2. Include filtering by trust tier, permissions, version, required capabilities, latency, capacity, and explicit selectors.
3. Preserve best-provider selection for legacy transparent routing.
4. Use aggregation APIs as the basis for remote Tooling discovery and DB namespace discovery.
5. Add route diagnostics explaining why providers were included or excluded.

## Acceptance criteria
- Multiple Tooling providers can be represented and queried simultaneously.
- Legacy `get_best_provider` behavior remains available.
- Exclusion reasons are testable and visible in diagnostics.
- Provider aggregation respects peer allowlists and capability/version policy.

## Suggested verification
- PeerRegistry unit tests with 3+ peers providing overlapping services.
- Diagnostics snapshot tests for provider inclusion/exclusion.
""",
    },
    {
        "title": "[MESH][P3-T01] Extend Tooling discovery with peer/source metadata and stable remote tool IDs",
        "phase": "P3",
        "labels": ["mesh", "mesh-roadmap", "mesh-p3", "tooling", "orchestrator"],
        "summary": "Make local and remote tools distinguishable, stable, policy-aware, and safe for Orchestrator binding.",
        "description": """
## Objective
Make Tooling discovery return enough metadata for an orchestrator to safely bind local and remote tools in a single view while preserving provenance and avoiding name collisions.

## Context
{context}

Current baseline:
- Orchestrator requests tools over the bus.
- Tooling exposes `GetTools` as `both`.
- Current tool payloads are oriented around local tool names/descriptions and do not fully encode peer/source/provenance/policy.

Relevant code anchors:
- `app/services/tooling/service.py`
- `app/shared/contracts/models/tooling.py`
- `app/services/orchestrator/agents/chatbot.py`
- Capability graph tasks `[MESH][P2-T01]` through `[MESH][P2-T03]`.

## Initial implementation plan
1. Add stable tool identity fields: local name, provider peer ID, provider service instance, global tool ID, namespace/display name.
2. Include metadata: source type, execution location, safety class, required permissions, confirmation requirement, rate-limit hints, schema, description, and provenance.
3. Define name-collision policy: namespace remote tools, expose aliases, or require explicit selection.
4. Update Tooling serialization to preserve backward compatibility where possible.
5. Add docs showing examples like `raspi-lab.switch_on` and `workstation.gpu_search`.

## Acceptance criteria
- Remote tools are not confused with local tools of the same name.
- Orchestrator can display or bind tools with provenance.
- Tool identity is stable across rediscovery when peer identity is stable.
- Tooling discovery response remains typed and tested.

## Suggested verification
- Contract/model tests.
- Tooling discovery tests with local + two remote providers and colliding tool names.
""",
    },
    {
        "title": "[MESH][P3-T02] Implement explicit remote Tooling execution routing and audit provenance",
        "phase": "P3",
        "labels": ["mesh", "mesh-roadmap", "mesh-p3", "tooling", "audit", "security"],
        "summary": "Execute selected remote tools by explicit provider/tool ID with full audit trail and policy checks.",
        "description": """
## Objective
Allow a caller to execute a specific remote tool on a specific peer/provider while preserving auditability, policy enforcement, and safe failure behavior.

## Context
{context}

Example target:
- A computer peer should be able to call a Raspberry Pi peer's physical-switch tool over the mesh, but only if policy allows that peer/principal/tool/resource combination.

Relevant code anchors:
- `app/services/tooling/service.py` `ExecuteTool`.
- `app/services/orchestrator/graph.py` tool execution.
- `app/messaging/mesh_bus.py` remote request routing.
- `app/services/gateway/webrtc/rpc.py` auth/permission gate.
- `app/shared/auth/permissions.py`.

## Initial implementation plan
1. Extend execute request models to support stable tool/provider selectors while preserving simple local execution.
2. Route explicit remote execution to the selected provider instead of generic module best-provider routing.
3. Enforce policy before execution: peer trust tier, principal permissions, tool safety class, resource selector, confirmation/dry-run requirements, and rate limits.
4. Add audit events with caller peer, caller principal, target peer, tool ID, resource, argument hash/redaction, result status, correlation ID, and denial reason.
5. Return structured errors for missing provider, stale provider, policy denial, timeout, and remote execution failure.

## Acceptance criteria
- Explicit remote tool execution works with mocked remote providers.
- A wrong/unauthorized peer/tool/resource is denied before execution.
- Audit records contain enough provenance without leaking secrets.
- Local tool execution remains backward compatible.

## Suggested verification
- Unit tests for request validation and policy denial.
- Integration tests for explicit remote Tooling execution over MeshBus/PeerBridge mocks.
""",
    },
    {
        "title": "[MESH][P3-T03] Teach Orchestrator to bind local plus authorized remote tools safely",
        "phase": "P3",
        "labels": ["mesh", "mesh-roadmap", "mesh-p3", "orchestrator", "tooling"],
        "summary": "Expose authorized remote tools to Orchestrator with provenance, collision handling, and safety prompts where required.",
        "description": """
## Objective
Let Aurora orchestrators see and use tools across peers without hiding provenance or bypassing safety policy. The orchestrator should understand which tools are local, which are remote, which require confirmation, and which are unavailable due to policy.

## Context
{context}

Current baseline:
- `app/services/orchestrator/agents/chatbot.py` calls `Tooling.GetTools`.
- `app/services/orchestrator/graph.py` calls `Tooling.ExecuteTool`.
- This can become mesh-aware once Tooling discovery/execution models carry provider and policy metadata.

Relevant code anchors:
- `app/services/orchestrator/agents/chatbot.py`
- `app/services/orchestrator/graph.py`
- `app/services/tooling/service.py`
- `app/shared/messaging/models/tooling_models.py`

## Initial implementation plan
1. Update tool binding logic to preserve provider/source metadata in tool names or hidden execution metadata.
2. Decide how LLM-visible names should encode provenance without becoming unwieldy.
3. Add filtering so only authorized and safe-to-advertise remote tools are provided to the model.
4. Add confirmation hooks or blocked placeholders for high-risk tools when policy requires human approval.
5. Ensure execution uses explicit provider/tool ID rather than ambiguous display name.

## Acceptance criteria
- Orchestrator can bind tools from multiple peers in one planning context.
- Tool provenance is retained through model selection and execution.
- Colliding names are resolved deterministically.
- High-risk tools can require confirmation or be hidden based on policy.
- Existing local-only orchestrator behavior still works.

## Suggested verification
- Unit tests for tool binding with local and remote tools.
- End-to-end mocked graph test where the model selects a remote tool and execution routes to the intended peer.
""",
    },
    {
        "title": "[MESH][P4-T01] Define DB/data-sharing modes and per-domain ownership policy",
        "phase": "P4",
        "labels": ["mesh", "mesh-roadmap", "mesh-p4", "db", "data-policy"],
        "summary": "Classify chat, memory/RAG, scheduler, auth/audit, mesh credentials, and config data into safe sharing modes.",
        "description": """
## Objective
Create an explicit DB/data sharing policy before implementing replication. Each data domain needs a chosen mode: remote query only, export/import, one-way replication, bidirectional eventual sync, or never share.

## Context
{context}

Roadmap constraint:
- Avoid raw cross-peer SQL as a shared capability.
- Keep Auth and mesh credential tables local-authoritative unless a separate trust model is approved.

Relevant code anchors:
- `app/services/db/service.py`
- `app/shared/messaging/models/db_models.py`
- `app/services/db/rag_service.py`
- `app/services/scheduler/service.py`
- `app/services/auth/service.py`

## Initial implementation plan
1. Inventory DB-backed data domains and current contract exposures.
2. For each domain, document allowed sharing modes and non-goals.
3. Define namespace ownership and identity/provenance fields required for shared data.
4. Decide deletion/forget semantics and whether redaction is needed before cross-peer sync.
5. Produce implementation follow-up tasks only after policy is explicit.

## Acceptance criteria
- A data-domain matrix exists and is reviewed.
- Raw SQL is explicitly excluded from mesh sharing.
- Auth credentials and mesh secrets are marked local-authoritative by default.
- RAG/memory/chat/scheduler data have concrete candidate sharing modes.

## Suggested verification
- Documentation review.
- Contract exposure audit to ensure current `both` methods align with intended policy.
""",
    },
    {
        "title": "[MESH][P4-T02] Design selective RAG/memory replication with provenance and conflict handling",
        "phase": "P4",
        "labels": ["mesh", "mesh-roadmap", "mesh-p4", "db", "rag", "replication"],
        "summary": "Plan and then implement selective cross-peer memory/RAG sync with namespaces, tombstones, conflicts, and privacy controls.",
        "description": """
## Objective
Enable peers to share useful memory/RAG data without blindly merging entire databases. This should support selective replication with provenance, conflict handling, delete semantics, and privacy controls.

## Context
{context}

Current baseline:
- DB exposes RAG search as mesh-shareable, while most write/list/get operations are internal.
- Current mesh can route DB calls but does not define replication semantics.

Relevant code anchors:
- `app/services/db/rag_service.py`
- `app/services/db/service.py`
- `app/shared/messaging/models/db_models.py`
- Future data policy from `[MESH][P4-T01]`.

## Initial implementation plan
1. Define replicated item metadata: namespace, owner peer, source peer, version/vector clock or timestamp strategy, tombstone, visibility, encryption/redaction flags.
2. Choose initial replication mode: likely explicit export/import or selective one-way sync before bidirectional sync.
3. Add sync contracts only for the approved RAG/memory subset.
4. Implement conflict resolution policy appropriate for personal assistant memories.
5. Add privacy controls for sensitive memories and deletion propagation.

## Acceptance criteria
- RAG/memory replication has a documented and tested conflict model.
- Sync is namespace-scoped and opt-in.
- Deletes/tombstones are represented.
- Provenance is queryable.
- No raw SQL or auth/credential data is replicated.

## Suggested verification
- Unit tests for merge/conflict/tombstone behavior.
- Integration test for two peers syncing a small namespace.
""",
    },
    {
        "title": "[MESH][P5-T01] Add explicit remote TTS/STT/audio capability boundaries",
        "phase": "P5",
        "labels": ["mesh", "mesh-roadmap", "mesh-p5", "tts", "stt", "privacy"],
        "summary": "Define and implement safe remote audio semantics for synthesize, playback, transcription, wakeword, and streaming boundaries.",
        "description": """
## Objective
Clarify which audio capabilities can be shared safely and which require explicit peer/device consent. Remote synthesize and batch transcription are lower risk; remote playback, microphone streaming, and wakeword/audio streaming require explicit target devices and privacy indicators.

## Context
{context}

Relevant code anchors:
- `app/services/tts/service.py`
- `app/services/stt_transcription/service.py`
- `app/services/stt_wakeword/service.py`
- `app/services/stt_coordinator/service.py`
- Audio contract models under `app/shared/contracts/models/` and `app/shared/messaging/models/`.

## Initial implementation plan
1. Classify audio operations: safe transparent, explicit target required, or non-shareable by default.
2. TTS: keep remote synthesize as shareable; require explicit peer/output device for remote playback.
3. STT/Transcription: prefer remote batch transcription; require consent, indicators, and bandwidth checks for streaming audio.
4. Wakeword: require explicit privacy policy before remote wakeword processing.
5. Add policy metadata to capability graph for audio resources.

## Acceptance criteria
- Audio sharing boundaries are documented.
- Remote playback cannot occur implicitly through transparent routing.
- Microphone/audio streaming requires explicit policy and target selection.
- Tests cover safe/denied routing for audio operations.

## Suggested verification
- Contract tests for explicit target requirements.
- Policy tests for denied remote playback/streaming without consent.
""",
    },
    {
        "title": "[MESH][P5-T02] Add namespace-aware remote Scheduler and delegated action policy",
        "phase": "P5",
        "labels": ["mesh", "mesh-roadmap", "mesh-p5", "scheduler", "policy"],
        "summary": "Make remote scheduling explicit about owner namespace, target peer, and delegated tool/action permissions.",
        "description": """
## Objective
Support remote scheduling without creating ambiguous ownership or bypassing tool policy. Jobs that run on a peer or invoke remote tools must carry namespace, owner, target peer, and delegated permission context.

## Context
{context}

Current baseline:
- Scheduler exposes schedule/cancel/list as `both` for mesh-advertisable access.
- Scheduled actions may eventually invoke tools, making policy delegation important.

Relevant code anchors:
- `app/services/scheduler/service.py`
- `app/services/scheduler/scheduler_manager.py`
- `app/services/db/scheduler_db_service.py`
- Tooling policy tasks `[MESH][P3-T01]` through `[MESH][P3-T03]`.

## Initial implementation plan
1. Define scheduler namespaces and ownership model for local vs remote jobs.
2. Add explicit target peer/resource selectors for jobs that execute on a remote peer.
3. Add delegated action policy for jobs that call tools or orchestrator flows later.
4. Ensure cancellation/listing respects owner namespace and permissions.
5. Add audit logs for remote schedule creation, execution, cancellation, and denial.

## Acceptance criteria
- Remote jobs are namespace-aware.
- A peer cannot cancel or list jobs outside authorized scopes.
- Tool-invoking jobs preserve delegated permission context.
- Audit events show who scheduled what, where, and under which policy.

## Suggested verification
- Unit tests for scheduler namespace authorization.
- Integration tests for remote schedule/list/cancel through mesh mocks.
""",
    },
    {
        "title": "[MESH][P5-T03] Define Auth and Config mesh exposure boundaries",
        "phase": "P5",
        "labels": ["mesh", "mesh-roadmap", "mesh-p5", "auth", "config", "security"],
        "summary": "Separate required pairing/peer-management RPC from broad Auth/Config service sharing and document safe exposure rules.",
        "description": """
## Objective
Clarify what Auth and Config functionality is allowed across the mesh. Pairing and peer management are necessary infrastructure; broad transparent Auth admin or Config mutation should remain non-default and explicit.

## Context
{context}

Observed fact:
- Gateway mesh config currently wires STT/DB/TTS/Tooling/Scheduler/Orchestrator into mesh services, but not Auth/Config, even though some defaults/schema include mesh sharing blocks.
- RPCHandler has special handling for pairing/auth infrastructure methods.

Relevant code anchors:
- `app/services/gateway/service.py`
- `app/services/gateway/webrtc/rpc.py`
- `app/services/auth/service.py`
- `app/services/config/service.py`
- `docs/PEER_PAIRING_FLOW.md`

## Initial implementation plan
1. Document Auth/Config mesh exposure categories: infra-required, read-only diagnostics, admin mutation, never-share.
2. Decide whether Auth/Config `mesh_sharing` config should remain, be hidden, or be implemented with strict explicit behavior.
3. Ensure Gateway config behavior matches docs and schema.
4. Add tests that broad Auth/Config calls are denied unless explicitly enabled and authorized.
5. Update pairing docs to explain infra methods that bypass ordinary service sharing gates.

## Acceptance criteria
- Auth/Config sharing policy is explicit.
- Config schema/defaults do not imply unsupported broad sharing.
- Pairing/login infrastructure remains functional.
- High-risk Auth/Config mutations are not transparently routed by default.

## Suggested verification
- RPC auth/config access tests.
- Config schema validation.
- Docs review.
""",
    },
    {
        "title": "[MESH][P6-T01] Add distributed tracing, correlation IDs, and mesh audit views",
        "phase": "P6",
        "labels": ["mesh", "mesh-roadmap", "mesh-p6", "observability", "audit"],
        "summary": "Make cross-peer requests traceable from caller through routing, WebRTC RPC, remote service execution, and response.",
        "description": """
## Objective
Improve operational observability for cross-peer workflows. A remote tool call or DB query should be traceable across local orchestrator, MeshBus route resolution, PeerBridge, WebRTC RPC, remote service method, audit logging, and response handling.

## Context
{context}

Relevant code anchors:
- `app/messaging/mesh_bus.py`
- `app/services/gateway/mesh/peer_bridge.py`
- `app/services/gateway/webrtc/rpc.py`
- `app/shared/services/base_service.py`
- `app/services/auth/service.py` audit methods.

## Initial implementation plan
1. Standardize correlation ID propagation across MeshBus, PeerBridge, WebRTC messages, and remote bus envelopes.
2. Include route decision metadata and peer IDs in debug logs and audit events.
3. Add a distributed audit query/view for mesh actions and denials.
4. Redact sensitive arguments while preserving hashes and enough metadata for debugging.
5. Document how to debug a failed remote action using correlation IDs.

## Acceptance criteria
- A single correlation ID can connect local request, remote RPC, service execution, and result/error.
- Access denied and timeout paths are auditable.
- Sensitive arguments and tokens are not logged raw.
- Tests verify correlation ID propagation.

## Suggested verification
- Unit tests for envelope/message correlation fields.
- Integration test with a mocked remote call and audit capture.
""",
    },
    {
        "title": "[MESH][P6-T02] Build mesh chaos and failure-mode test suite",
        "phase": "P6",
        "labels": ["mesh", "mesh-roadmap", "mesh-p6", "testing", "resilience"],
        "summary": "Add hostile tests for disconnects, stale manifests, service restart, capacity, latency, token expiry, denied permissions, and fallback routing.",
        "description": """
## Objective
Validate safe degraded behavior under realistic distributed-system failure modes. Mesh should handle peer disconnects, stale manifests, service restarts, partial capacity, latency changes, token expiry, denied permissions, and fallback routing without unsafe behavior.

## Context
{context}

Relevant code anchors:
- `app/messaging/mesh_bus.py`
- `app/services/gateway/mesh/peer_registry.py`
- `app/services/gateway/mesh/routing_table.py`
- `app/services/gateway/mesh/latency.py`
- `app/services/gateway/registry_aggregator.py`
- Existing tests under `tests/unit/gateway/` and `tests/integration/`.

## Initial implementation plan
1. Define chaos scenarios and expected safe outcomes.
2. Use mocks/fakes where full WebRTC is too heavy for unit/integration tests.
3. Add tests for provider disappearing mid-request, stale manifest exclusion, capacity rejection, fallback provider selection, auth token expiry, permission denial, and service reannouncement after restart.
4. Add regression tests for no duplicate event loops and no mesh-forward loops.
5. Keep tests deterministic and fast enough for CI.

## Acceptance criteria
- Failure scenarios have explicit expected behavior.
- Tests cover both successful fallback and safe hard failure.
- Unauthorized or stale peers are never used after policy/status changes.
- CI-friendly suite can be run without real external MQTT/WebRTC brokers.

## Suggested verification
- New unit/integration chaos suite.
- Existing targeted mesh/gateway suite remains green.
""",
    },
]

# Materialize markdown files and JSON index.
index = []
for i, task in enumerate(tasks, start=0):
    slug = task["title"].lower()
    for ch in "[]:/—–,.()":
        slug = slug.replace(ch, "")
    slug = "-".join(slug.split())[:96]
    path = OUT / f"{i:02d}-{slug}.md"
    desc = textwrap.dedent(task["description"]).strip().format(context=COMMON_CONTEXT)
    path.write_text(desc + "\n", encoding="utf-8")
    item = {k: v for k, v in task.items() if k != "description"}
    item["description_file"] = str(path)
    index.append(item)
(OUT / "task-index.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
print(f"Wrote {len(index)} task descriptions under {OUT}")

# CLI helpers.
def run(cmd: list[str], *, input_text: str | None = None) -> dict | list | str:
    proc = subprocess.run(cmd, input=input_text, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}")
    out = proc.stdout.strip()
    if not out:
        return ""
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out

label_specs = {
    "mesh": "#2563eb",
    "mesh-roadmap": "#7c3aed",
    "mesh-epic": "#9333ea",
    "mesh-p0": "#0ea5e9",
    "mesh-p1": "#0284c7",
    "mesh-p2": "#0891b2",
    "mesh-p3": "#059669",
    "mesh-p4": "#65a30d",
    "mesh-p5": "#d97706",
    "mesh-p6": "#dc2626",
    "test-coverage": "#64748b",
    "observability": "#14b8a6",
    "identity": "#1d4ed8",
    "webrtc": "#06b6d4",
    "auth": "#be123c",
    "pairing": "#f97316",
    "config": "#8b5cf6",
    "security": "#e11d48",
    "capability-graph": "#10b981",
    "contracts": "#6366f1",
    "addressing": "#0f766e",
    "routing": "#0369a1",
    "tooling": "#16a34a",
    "orchestrator": "#4f46e5",
    "audit": "#b91c1c",
    "db": "#ca8a04",
    "data-policy": "#a16207",
    "rag": "#84cc16",
    "replication": "#22c55e",
    "tts": "#ec4899",
    "stt": "#06b6d4",
    "privacy": "#db2777",
    "scheduler": "#f59e0b",
    "testing": "#475569",
    "resilience": "#ef4444",
    "policy": "#f43f5e",
}

existing_labels = run(["multica", "label", "list", "--output", "json"])
label_by_name = {lbl["name"]: lbl for lbl in existing_labels}
for name, color in label_specs.items():
    if name not in label_by_name:
        created = run(["multica", "label", "create", "--name", name, "--color", color, "--output", "json"])
        label_by_name[name] = created

created_issues = []
parent_id = None
for idx, item in enumerate(index):
    cmd = [
        "multica", "issue", "create",
        "--project", PROJECT_ID,
        "--title", item["title"],
        "--description-file", item["description_file"],
        "--allow-duplicate",
        "--output", "json",
    ]
    if parent_id and item["phase"] != "EPIC":
        cmd.extend(["--parent", parent_id])
    issue = run(cmd)
    issue_id = issue["id"]
    if item["phase"] == "EPIC":
        parent_id = issue_id
    for label_name in item["labels"]:
        label_id = label_by_name[label_name]["id"]
        run(["multica", "issue", "label", "add", issue_id, label_id, "--output", "json"])
    created_issues.append({
        "title": item["title"],
        "id": issue_id,
        "phase": item["phase"],
        "labels": item["labels"],
        "description_file": item["description_file"],
    })

summary_path = OUT / "created-issues.json"
summary_path.write_text(json.dumps(created_issues, indent=2), encoding="utf-8")
print(json.dumps({"project_id": PROJECT_ID, "created_count": len(created_issues), "parent_id": parent_id, "summary": str(summary_path), "issues": created_issues}, indent=2))
