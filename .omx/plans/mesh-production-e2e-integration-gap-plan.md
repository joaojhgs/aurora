# Mesh Production E2E Integration Gap Plan

Date: 2026-06-18
Scope: Reconcile the original mesh roadmap with the current remote-branch implementation state and define requirements for a production-grade cross-peer capability fabric.
Evidence source: `origin/feat/migration-to-modular-services-architecture` reviewed via `/tmp/aurora-mesh-review` at `5e670fa` plus original roadmap tasks under `.omx/multica/mesh-roadmap-tasks/`. The active local checkout at `/home/developer/projects/aurora` was behind the remote migration branch during review; implementation tasks must first normalize the target branch before treating any remote-branch primitive as available.

## Executive finding

The mesh implementation has advanced beyond the original baseline, but it is not yet the full target described by the roadmap. Generic service sharing/routing already existed before this roadmap. The completed work added important primitives: stable selectors, capability graph diagnostics, provider candidate diagnostics, tool provenance metadata, explicit remote tool execution, scheduler ownership policy, DB/RAG sharing policy docs, audio capability policy metadata, Auth/Config exposure docs, tracing, and chaos tests.

The remaining gap is the production integration layer: a caller should be able to discover, reason about, approve, route, execute, audit, and observe local plus multiple remote peer capabilities as one coherent capability graph. That is not complete yet.

Branch-state warning: in the remote branch, `Gateway.GetCapabilityGraph`, provider candidates, selectors, and tool metadata exist as primitives. In the local checked-out branch, several of those primitives may be absent or stale. The first production task must select and update the canonical implementation branch, then re-run the evidence checks before coding follow-up work.

## Verified current behavior

Fresh targeted verification run in `/tmp/aurora-mesh-review`:

```bash
uv run --extra gateway --extra service-tooling --extra service-orchestrator --extra service-scheduler --extra test-integration pytest \
  tests/unit/gateway/test_routing_table.py \
  tests/unit/gateway/test_peer_registry.py \
  tests/unit/gateway/test_capability_graph.py \
  tests/unit/tooling/test_service.py \
  tests/unit/orchestrator/test_tool_bindings.py \
  tests/unit/orchestrator/test_graph.py \
  tests/unit/app/config/test_mesh_sharing_schema.py \
  tests/unit/app/scheduler/test_scheduler_remote_policy.py -q
```

Result: `107 passed, 4 warnings`.

The first attempt without service extras failed collection on missing optional dependencies (`langchain_core`, `croniter`), then passed with the correct extras.

## Original roadmap intent recap

The original mesh roadmap required:

1. Capability graph: peers, services, methods, tools, resources, trust tiers, policies, selectors, provenance.
2. Hybrid addressing: transparent routing only for low-risk service dependencies; explicit peer/resource selectors for tools, DB/data, hardware, scheduler ownership, remote playback, and privacy-sensitive flows.
3. Provider aggregation: list all eligible providers, not just the best provider for a module.
4. Tooling discovery: stable remote tool IDs, provenance, collision handling, policy metadata.
5. Tool execution: explicit remote provider/tool routing, audit provenance, policy denial, structured errors.
6. Orchestrator integration: bind local plus authorized remote tools safely in one context.
7. DB/RAG data policy: no raw SQL, per-domain sharing modes, future selective memory/RAG sync with provenance and tombstones.
8. Audio/STT/TTS boundaries: batch operations can be shared more safely; live mic/playback/wakeword/streaming require explicit target/consent/indicators.
9. Scheduler policy: remote jobs need namespace, owner, target peer, delegated permission context.
10. Auth/Config boundaries: pairing infra is allowed; broad Auth/Config admin is not transparent mesh sharing by default.
11. Observability: correlation IDs, route diagnostics, audit views, chaos/failure tests.

## Current implementation by area

### 1. Generic service sharing and routing

Status: Works as baseline primitive.

Implemented:
- `MeshBus` routes commands/requests by module using `RoutingTable`.
- `PeerBridge` sends JSON-RPC calls over WebRTC DataChannels.
- `RPCHandler` gates remote calls by service `share`, `allowed_peers`, capacity, auth identity, and method permissions.
- `PeerRegistry.get_best_provider()` still supports legacy one-provider routing.

Gap:
- Generic routing is not the production target by itself. It cannot represent local plus multiple peer capabilities as one plan/execution surface.

Production requirement:
- Preserve generic service routing for low-risk module dependencies, but require capability graph / explicit selectors for user-visible capabilities, tools, data, hardware, scheduler, and audio control.

### 2. Hybrid addressing and selectors

Status: Partially implemented.

Implemented:
- `MeshAddressSelector` exists with `peer_id`, `provider_id`, `service_instance_id`, `resource_namespace`, `tool_id`, `hardware_target`, `data_scope`.
- `MeshBus` extracts `mesh_selector` from typed payloads.
- `RoutingTable.resolve()` validates explicit peer/provider selectors before generic module routing.
- Explicit selector failures return structured route errors such as peer not found, stale, unauthorized, missing service, version/capability mismatch, capacity, and target failed.
- Explicit routes do not silently fall back to a different peer.

Gap:
- Config parity must be verified against the canonical target branch. In the reviewed remote branch, `allowed_peers`, `min_version`, and `required_capabilities` are present in generated config, but `require_explicit_selector` is still runtime-only. In the stale local branch, even more runtime fields may be missing from generated config. Operators must not lose mesh policy fields during `MeshSharing` -> `MeshServiceConfig` rehydration.
- `require_explicit_selector` exists in runtime `MeshServiceConfig` but is not exposed in generated config schema/defaults/models/keys on the reviewed remote branch. Operators cannot set it through normal config.
- Selector semantics are not consistently added to every sensitive request model beyond the first wave.
- `resource_namespace`, `hardware_target`, and `data_scope` are mostly carried for policy/audit intent, not enforced by centralized policy.

Production requirements:
- Define the canonical `MeshSharing` schema as the source for every runtime `MeshServiceConfig` field: `share`, `max_concurrent`, `allowed_peers`, `prefer`, `fallback`, `min_version`, `required_capabilities`, `require_explicit_selector`, and any future per-operation policy fields.
- Add `require_explicit_selector` to config schema/defaults/generated models/keys and verify `GatewayService._get_gateway_config()` preserves every field when validating into `MeshServiceConfig`.
- Add per-method/operation selector requirement metadata, not only per-module config.
- Enforce selector-resource semantics centrally for data, hardware, scheduler, and audio operations.
- Add route-explain endpoint response for selector failure reasons consumable by UI/SDK.

### 3. Capability graph

Status: Diagnostic graph exists on the reviewed remote branch; production capability catalog does not. If implementation starts from the stale local checkout, the capability graph endpoint itself must first be ported/merged from the remote branch.

Implemented on reviewed remote branch:
- `Gateway.GetCapabilityGraph` exists as external/manage.
- `CapabilityGraph` includes peers, services, methods, policies, addresses, provenance, provider indexes.
- Graph is built from local registry and remote manifests.
- Policy metadata includes `explicit_selector_required`, `confirmation_required`, `consent_required`, `privacy_indicator_required`, `bandwidth_check_required`, operation/resource scope.

Gap:
- The graph is read-only diagnostic/planning data. It does not aggregate live Tooling results, DB namespaces, RAG namespaces, hardware resources, model runtimes, or scheduler resources.
- `resources=[]` is currently a placeholder.
- No canonical `CapabilityCatalog` API maps graph nodes to executable SDK actions and approval requirements.

Production requirements:
- Convert capability graph from diagnostic-only to canonical capability catalog source.
- Add resource producers for Tooling tools, DB/RAG namespaces, scheduler jobs/namespaces, audio devices, TTS outputs, STT inputs, model/runtime capabilities.
- Add freshness, stale marker, last probe, auth scope, and redaction metadata.
- Add SDK contract: `listCapabilities`, `listProviders`, `explainRoute`, `executeCapability`, `requestApproval`.

### 4. Provider aggregation

Status: Provider candidate diagnostics exist; aggregate consumer flow missing.

Implemented:
- `PeerRegistry.get_provider_candidates()` returns all candidates with eligibility and exclusion reasons.
- `Gateway.GetMeshStatus` route diagnostics include provider inclusion/exclusion.
- `get_best_provider()` remains for legacy transparent routing.

Gap:
- ToolingService does not use provider candidates to aggregate local plus remote tools.
- Orchestrator currently asks `Tooling.GetTools` once. Depending on routing, that returns local tools or one selected peer's tools, not local plus all eligible remote providers.
- No multi-provider fanout endpoint exists.

Production requirements:
- Add backend aggregate discovery method, preferably `Tooling.GetToolCatalog` or `Gateway.GetCapabilityCatalog`, that fans out to all eligible Tooling providers plus local tools.
- It must include local tools even when network providers exist.
- It must include eligible and excluded provider/tool entries with reasons so UI can explain unavailable capabilities.
- It must cache per-peer tool discovery with TTL and invalidate on manifest/service/tool changes.
- It must enforce peer allowlists, permissions, trust tier, capability/version, capacity, explicit selector policy, and per-tool sharing policy before advertising to orchestrator/UI.

### 5. Tooling discovery

Status: Per-provider metadata exists; full sharing policy does not.

Implemented:
- Tool discovery serializes `local_name`, `global_tool_id`, provider peer/service, namespace/display name, source type, execution location, safety class, required permissions, confirmation_required, provenance.
- Remote-selected tools are namespaced to avoid collisions.
- Tests cover local metadata and remote provider collision metadata.

Gap:
- This metadata only describes tools returned by the Tooling service instance that receives the request.
- There is no per-tool operator sharing config. Current sharing is service-level: if Tooling is shared, all loaded tools may be discoverable unless Tooling itself filters them.
- No deny/allow policy per tool, toolkit, MCP server, safety class, resource scope, or peer.
- No first-class confirmation UX state; only `confirmation_required` boolean.

Production requirements:
- Add per-tool/toolkit/MCP sharing policy config:
  - default `share=false` for sensitive integrations.
  - allow by tool ID, source type, toolkit, safety class, resource namespace, peer/principal.
  - expose policy in capability catalog.
- Add discovery filtering based on per-tool policy.
- Add share audit: when a tool is advertised to a peer, record provider/caller/tool/policy decision.
- Add UI/admin endpoints for tool sharing policy management.

### 6. Tooling execution and confirmation

Status: Remote execution primitive exists; approval protocol incomplete.

Implemented:
- `Tooling.ExecuteTool` accepts `mesh_selector`, `resource_selector`, `confirmed`, `dry_run`, `caller_peer_id`, `caller_principal_id`, `correlation_id`.
- Remote RPC handler injects trusted caller peer/principal/correlation instead of trusting spoofed fields.
- ToolingService enforces remote resource selector for sensitive/dangerous tools.
- ToolingService denies tools requiring confirmation unless `confirmed` or `dry_run` is set.
- Tool execution audits status/errors/correlation/provider/global tool ID.

Gap:
- `confirmed=True` is just a request field, not a cryptographically or server-bound human approval.
- No approval challenge endpoint.
- No exact-args approval binding.
- No approval expiry, nonce, replay protection, approver identity, or revocation.
- No UI flow to request approval from the target device owner.

Production requirements:
- Add `Tooling.PrepareExecution` / `Tooling.RequestApproval` / `Tooling.ConfirmExecution` or equivalent AdminAction draft-confirm pattern.
- Confirmation token must bind: caller, target peer, tool ID, resource selector, normalized/redacted args hash, requested action, expiry, nonce, approver principal, policy decision ID.
- Execute must require valid approval token for sensitive/dangerous/confirmation-required remote tools, not raw `confirmed=True`.
- Keep `dry_run` for previews and model planning.
- Add tests for denial without token, token mismatch, replay, expiry, peer mismatch, args mismatch, and successful confirmed execution.

### 7. Orchestrator local plus remote tool binding

Status: Safe binding primitives exist; aggregate discovery missing.

Implemented:
- `tool_bindings.py` hides remote execution metadata from the LLM while preserving provider/global ID in hidden binding.
- Remote sensitive/dangerous/confirmation-required tools are not automatically bound for model selection.
- Graph execution builds `ToolingExecuteToolRequest` with hidden mesh selector.
- Tests cover safe remote binding and remote execution request construction.

Gap:
- Chatbot still performs one `Tooling.GetTools` call. It does not call an aggregate catalog or all provider candidates.
- There is no model-facing distinction for unavailable tools needing approval, suggested approval actions, or user-mediated tool enablement.
- No orchestrator planning over peer/provider/resource alternatives.

Production requirements:
- Replace chatbot single-provider `GetTools` with aggregate catalog filtered for the current principal/session.
- Include local + authorized safe remote tools in the bindable set.
- Include blocked tools as non-bindable capabilities in UI/explain surfaces.
- Add approval-interrupt path: when user asks for an unsafe remote action, orchestrator should return an approval request instead of silently hiding or executing.
- Add policy-based prompt context telling the model which remote capabilities are available, unavailable, or approval-required.

### 8. DB, RAG, memory, and data sharing

Status: Mostly policy documentation, not implemented sync.

Implemented:
- `docs/DATA_SHARING_POLICY.md` defines domain matrix.
- DB exposes `GetMessages`, `GetMessagesForDate`, and `RAGSearch` as `both` query surfaces.
- Raw SQL and DB write contracts remain internal.
- RAG request models include optional `mesh_selector`.

Gap:
- No RAG export/import contract.
- No selective replication.
- No tombstones/delete propagation.
- No namespace ownership enforcement beyond carried fields.
- No cross-peer audit query/export implementation.
- No UI/admin data-sharing policy management.

Production requirements:
- Add `RAG.ListNamespaces`, `RAG.ExportNamespace`, `RAG.ImportNamespace`, `RAG.SyncPull`, `RAG.SyncPush` only after policy is explicit.
- Add provenance fields: source peer, owner peer, namespace, record ID, schema version, created/updated timestamps, policy decision/correlation, tombstone.
- Add remote query policy enforcement for `RAGSearch` and message reads: explicit namespace selector, peer/principal authorization, redaction, result limit, audit.
- Add tests for no raw SQL exposure, remote query denial without selector/policy, export/import provenance, tombstone behavior.

### 9. STT, WakeWord, TTS, and audio boundaries

Status: Contracts and graph metadata partly updated; runtime consent not complete.

Implemented:
- `Transcription.ProcessAudio` and `Transcription.Transcribe` remain `both`.
- `WakeWord.ProcessAudio` and `WakeWord.Detect` remain `both`.
- `STTCoordinator.Listen/StopListening/Audio/Control` remain internal.
- STT/TTS request models include `mesh_selector`.
- Routing table can require explicit selectors for selected audio topics when network routing is preferred.
- Capability graph annotates audio operations with operation/resource class and flags consent/privacy/bandwidth requirements.

Gap:
- No actual consent/indicator/bandwidth runtime gate for remote mic/wakeword/streaming paths.
- Streaming `ProcessAudio` returns events, but no complete remote event subscription/stream bridging exists for HTTP/API clients.
- Wakeword streaming and transcription streaming are still exposed as `both` if service sharing is enabled; policy is not strong enough for production privacy.
- Remote playback controls are internal at contract exposure level except `TTS.Synthesize`; TTS playback `Request/Stop/Pause/Resume` are internal, so remote playback is mostly blocked by exposure, not a complete explicit target-device UX.

Production requirements:
- Classify methods:
  - Safe batch remote: `TTS.Synthesize`, `Transcription.Transcribe`, `WakeWord.Detect` with submitted audio.
  - Restricted streaming: `Transcription.ProcessAudio`, `WakeWord.ProcessAudio`, live mic paths.
  - Local-only/default-denied: raw mic stream, coordinator listen/control, remote playback unless explicit target UX exists.
- Add explicit audio session contracts with consent, privacy indicator, bandwidth check, target device selector, session lifecycle, event stream subscription.
- Add HTTP/WebSocket/SSE bridge for transcription/wakeword result events if streaming methods remain external.
- Add tests proving remote peers cannot start mic capture/playback/streaming without explicit selector + consent token.

### 10. Scheduler remote delegation

Status: Policy enforcement improved; full delegated execution not complete.

Implemented:
- Scheduler requests include namespace/owner/target selector/caller fields.
- Remote callers are scoped by namespace/owner logic.
- Scheduler tests pass for remote policy.

Gap:
- No durable delegated permission token for future tool-invoking scheduled jobs.
- No UI/admin flow for remote job ownership and target peer selection.
- No cross-peer job execution handoff or event audit loop beyond current policy.

Production requirements:
- Add delegated action token/approval model for scheduled jobs that invoke tools/orchestrator flows.
- Add explicit target peer/resource selectors for remote schedule creation.
- Add list/cancel permissions scoped to namespace/owner/target peer.
- Add audit for schedule/create/execute/cancel/deny with correlation ID.

### 11. Auth and Config boundaries

Status: Boundary docs and gateway map updated; HTTP/admin exposure remains broad.

Implemented:
- Gateway mesh config intentionally wires STT/WakeWord/Transcription/DB/TTS/Tooling/Scheduler/Orchestrator, not Auth/Config.
- Docs state Auth/Config are not ordinary transparent mesh providers.
- Pairing/login infrastructure is special-cased by RPC.
- Auth mesh peer management methods remain HTTP/admin `both` surfaces.

Gap:
- Auth and Config service method exposures are still broad over HTTP dynamic API. That may be okay for admin dashboard, but must be gated by auth/RBAC and not confused with mesh service sharing.
- No production admin-action confirmation for high-risk Auth/Config mutations unless handled elsewhere.
- The route generator and permission metadata need audit to ensure admin endpoints cannot be called anonymously when gateway auth is enabled/disabled.

Production requirements:
- Keep Auth/Config out of mesh service sharing by default.
- Add explicit admin-dashboard contracts/RBAC for Auth and Config changes.
- Add AdminAction draft-confirm-audit for high-risk changes: token creation/revoke, permission changes, peer approval, config mutation, plugin enable/disable.
- Add tests for remote RPC denial of broad Auth/Config when not infra methods.

### 12. Observability and production E2E proof

Status: Unit/integration primitives tested; live production flow not fully proven.

Implemented:
- Correlation ID tracing helpers.
- Mesh route diagnostics.
- Capability graph diagnostics.
- Chaos/failure tests.

Gap:
- No live two-node process-mode/docker e2e proof for remote aggregate tool discovery + approval + execution + audit + UI/API observation.
- No final checklist tying config, endpoint, event stream, audit, and user-visible state together.

Production requirements:
- Add e2e harness with two Aurora peers, process mode, Gateway+WebRTC+Mesh, one provider peer with selected tools/STT/RAG, one consumer peer with orchestrator/UI SDK.
- Scenarios:
  1. Pair peers and approve permissions.
  2. Provider shares Tooling but only selected tools.
  3. Consumer capability catalog shows local + remote safe tools and blocked unsafe tools with reasons.
  4. Safe remote tool executes and audits.
  5. Dangerous remote tool requires approval token and fails without it.
  6. RAG remote query works only with namespace selector and logs provenance.
  7. Transcription batch remote works; streaming/mic path denied without consent/session.
  8. Scheduler remote job creation/list/cancel respects namespace/owner.
  9. Auth/Config broad mesh calls are denied except pairing/auth infra.
  10. Route explain shows provider inclusion/exclusion.

## Required backend endpoints/contracts to add or harden

0. Branch normalization / primitive porting:
   - Choose the canonical target branch for mesh+UI work.
   - If starting from the stale local checkout, port or merge the remote-branch primitives first: `MeshAddressSelector`, explicit selector routing, provider candidates, capability graph, Tooling metadata/execution policy, scheduler policy, tracing, and chaos tests.

1. `Gateway.GetCapabilityCatalog` or expanded `Gateway.GetCapabilityGraph`:
   - Returns executable capability catalog with local + remote providers, resources, policies, freshness, route explanations.
   - Required typed models/methods: `GatewayMethods.GET_CAPABILITY_CATALOG`, `GatewayMethods.EXPLAIN_ROUTE`, `CapabilityCatalogRequest`, `CapabilityCatalogResponse`, `CapabilityProviderInfo`, `CapabilityActionInfo`, `CapabilityResourceInfo`, `CapabilityPolicyDecisionInfo`, `CapabilityFreshnessInfo`, `RouteExplainRequest`, `RouteExplainResponse`, `RouteCandidateDecision`, `RouteBlockerInfo`.
   - Catalog actions must include stable IDs, module/method/tool/resource selectors, provider peer/service IDs, source provenance, bindability, approval requirement, redacted schema, last_seen/ttl/stale status, and executable SDK operation hints.
2. `Tooling.GetToolCatalog`:
   - Aggregates local tools + all eligible remote Tooling providers.
   - Includes excluded tools/providers with reasons.
3. Tool sharing policy contracts:
   - `Tooling.GetSharingPolicy`, `Tooling.SetSharingPolicy`, `Tooling.TestSharingPolicy`.
   - Per tool/toolkit/MCP/source/safety/peer/principal/resource namespace.
4. Tool approval contracts:
   - `Tooling.PrepareExecution`, `Tooling.RequestApproval`, `Tooling.ConfirmExecution` or AdminAction-based equivalent.
   - Approval token binding and replay protection.
5. Route explain contract:
   - `Gateway.ExplainRoute` with selector/module/method/provider diagnostics.
6. Data/RAG sharing contracts:
   - namespace list, export/import, future one-way sync, tombstones.
7. Audio session contracts:
   - explicit remote audio session prepare/consent/start/stop/status/events.
8. Scheduler delegated action contracts:
   - delegated permission token and target selector policy.
9. AdminAction contracts:
   - draft/confirm/audit for Auth/Config/Tooling/Scheduler/mesh high-risk actions.
10. Unified event stream:
   - HTTP/SSE/WebSocket events for capability changes, approvals, audits, transcription results, route failures.

## Required config additions

1. Normalize mesh config parity across runtime and generated config. Every `MeshServiceConfig` field must exist in `app/services/config/config_schema.json`, `app/services/config/config_defaults.json`, `app/shared/config/models.py`, `app/shared/config/keys.py`, and the `GatewayService._get_gateway_config()` translation path.
2. Add `require_explicit_selector` to generated `mesh_sharing` schema/defaults/models/keys.
2. Add per-method or operation-level sharing policy where module-level is too coarse.
3. Add Tooling sharing policy defaults:
   - service share=false by default.
   - per-tool share=false for sensitive/dangerous by default.
   - safe/core tools may be opt-in by toolkit/source.
4. Add audio policy config:
   - allow batch transcription/synthesis.
   - default-deny remote mic/wakeword streaming/playback.
   - require consent/privacy indicator/bandwidth for streaming if enabled.
5. Add RAG/data namespace sharing config:
   - namespace allowlist, mode, peers, retention/delete policy.
6. Add scheduler namespace/delegation config.
7. Keep Auth/Config no ordinary mesh sharing blocks unless a strict admin-specific design is implemented.

## Immediate corrective task set before UI implementation

1. Normalize branch/release state: ensure completed mesh work is on the branch that UI tasks will target; current local branch divergence is a release risk. Re-run the mesh primitive tests after normalization.
2. Add full mesh config schema/runtime parity, including `require_explicit_selector`, and regression-test that no runtime policy field is dropped during config loading.
3. Define typed `CapabilityCatalog` and `RouteExplain` contract models/method constants before UI/SDK wiring.
4. Implement aggregate capability/tool catalog backend.
5. Implement per-tool sharing policy.
6. Implement approval token protocol for remote sensitive tool execution.
7. Implement route explain endpoint and SDK shape.
8. Add remote RAG query policy enforcement and namespace catalog; defer replication until explicit sync tasks.
9. Harden audio/STT sharing: batch allowed, streaming/session gated.
10. Add AdminAction draft-confirm-audit for Auth/Config/Tooling/Scheduler high-risk changes.
11. Add full two-node production e2e harness.
12. Update UI roadmap/tasks to depend on the capability catalog and approval/event contracts instead of assuming generic service sharing is enough.

## RALPLAN decision

Decision: Treat the current mesh work as a primitive foundation, not as completion of the product-level cross-peer capability fabric.

Drivers:
- The original objective was local+remote capability aggregation and policy-aware execution, not simple remote service redirection.
- Service-level sharing is too coarse for tools, DB/data, audio, scheduler, Auth/Config, and hardware capabilities.
- UI implementation must not wire itself directly to underpowered primitives that will be replaced.

Rejected:
- Treating `Tooling.GetTools` + mesh routing as sufficient, because it selects one provider path and does not aggregate local plus all eligible remote providers.
- Treating `confirmed=True` as production approval, because it is not bound to a human decision, exact args, resource, nonce, expiry, or approver identity.
- Treating DB/RAG docs as implementation, because sync/export/import/tombstone/enforcement contracts are not present.

Confidence: high
Scope-risk: broad
Directive: Generate new implementation tasks from this gap plan before starting UI backend integration tasks.
Tested: Targeted primitive tests passed: 107 passed, 4 warnings.
Not-tested: Live two-node Docker/process-mode production e2e remains unproven.
