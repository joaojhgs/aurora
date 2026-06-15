# Deep Interview Spec: Aurora Mesh / Distributed Service Integration Roadmap

## Metadata
- Profile: standard
- Context type: brownfield
- Final ambiguity: 0.18
- Threshold: 0.20
- Context snapshot: `.omx/context/mesh-distributed-integration-20260528T202635Z.md`
- Transcript: see latest `.omx/interviews/mesh-distributed-integration-*.md`
- Verification evidence: targeted mesh/gateway suite passed (`88 passed, 13 warnings`).
- GitNexus: unavailable in this session; direct repo/docs inspection used.

## Clarity breakdown
| Dimension | Score | Notes |
|---|---:|---|
| Intent | 0.90 | Understand the branch's mesh/distributed readiness and produce a deeper-integration roadmap. |
| Outcome | 0.92 | Roadmap/gap map only; no implementation in this pass. |
| Scope | 0.82 | Broad across mesh, WebRTC, service announcements, Tooling, DB, Orchestrator, STT/TTS/Scheduler/Auth/Config, and security. |
| Constraints | 0.85 | Privacy-first, existing bus/contracts architecture, pragmatic trust tiers, all topologies covered, hybrid addressing. |
| Success criteria | 0.78 | Evidence-backed gaps, phased roadmap, security/RBAC model, module-by-module opportunities. |
| Brownfield context | 0.86 | Docs/code inspected; targeted mesh/gateway tests pass. |

## Intent
The user wants a high-confidence architectural checkpoint for the distributed Aurora branch before deeper peer-sharing work continues. The goal is to understand what is already solid, what gaps remain, and how to evolve from “mesh can route services” toward “peers form a secure shared capability fabric.”

## Desired outcome
Produce a comprehensive roadmap and gap map, grounded in current code/docs, for deeper cross-peer integration across Aurora services. The roadmap should support all relevant deployment topologies and use a pragmatic tiered security model with hybrid transparent/explicit addressing.

## In scope
- Current-state assessment of microservice, process-mode, mesh, WebRTC, service announcement, manifest negotiation, and service routing design.
- Gap map across foundations, remote Tooling, Orchestrator integration, DB/data sharing, Scheduler, TTS/STT, Auth/Config, Gateway/observability, and tests.
- Roadmap phases from hardening to capability graph, remote tools, DB replication, module-specific integrations, and operational readiness.
- Security/RBAC/policy recommendations for cross-peer services and hardware/resource-sensitive capabilities.
- Deployment considerations for home LAN/edge mesh, Docker/process-mode clusters, and internet-crossing peers.

## Out of scope / non-goals
- No code implementation in this pass.
- No single-topology-only roadmap; home edge, process cluster, and internet mesh should all be considered.
- No assumption that all shared services should be fully transparent.
- No recommendation to expose internal/admin/raw DB/Auth/Config capabilities broadly by default.
- No new dependency decision unless later planning selects an implementation lane.

## Decision boundaries
OMX may decide without further confirmation:
- Rank gaps by architectural risk and dependency order.
- Recommend phased roadmap items and acceptance checks.
- Classify methods/services into safe transparent routing vs explicit addressing vs non-shareable by default.
- Propose security tiers, policy primitives, and test coverage targets.

Needs later confirmation before implementation:
- Exact first implementation phase.
- New persistence/replication technology or dependency choices.
- Breaking API/schema changes.
- Exposing high-risk services such as Auth, Config mutation, DB writes, hardware actuators, or raw audio streams.

## Key brownfield evidence
- `MeshBus` routes commands via a routing table and forwards mesh events when `mesh=True`: `app/messaging/mesh_bus.py:86`, `app/messaging/mesh_bus.py:283`.
- `RoutingTable` resolves local/network/network-only/local-only behavior and fallback: `app/services/gateway/mesh/routing_table.py:35`, `app/services/gateway/mesh/routing_table.py:130`.
- `PeerRegistry` selects remote providers by negotiated manifest, version/capability checks, capacity, peer filters, and latency/round-robin/random policy: `app/services/gateway/mesh/peer_registry.py:318`.
- Manifest generation advertises only `external`/`both` methods from shared services: `app/services/gateway/mesh/negotiation.py:89-97`.
- WebRTC RPC enforces service-sharing gates, allowed peers, capacity, auth, and permissions before local bus invocation: `app/services/gateway/webrtc/rpc.py:155-225`.
- `BaseService.bus` dynamically reads the global singleton, so thread-mode services can see MeshBus replacement: `app/shared/services/base_service.py:106`.
- Services re-announce every 30 seconds to keep Gateway discovery warm: `app/shared/services/base_service.py:220-239`.
- Registry aggregation subscribes to announce/depart/heartbeat and prunes stale process-mode services: `app/services/gateway/registry_aggregator.py:71`, `app/services/gateway/registry_aggregator.py:272`.
- Gateway mesh config wires STT, DB, TTS, Tooling, Scheduler, and Orchestrator, but not Auth/Config, into mesh routing: `app/services/gateway/service.py:157-174`.
- Runtime mesh config supports `allowed_peers`, `min_version`, and `required_capabilities`: `app/services/gateway/config.py:10-36`.
- Generated config schema currently exposes only `share`, `max_concurrent`, `prefer`, and `fallback`: `app/services/config/config_schema.json:1198-1226`.
- Orchestrator already gets tools and executes tools via bus: `app/services/orchestrator/agents/chatbot.py:477-485`, `app/services/orchestrator/graph.py:113-119`.
- Tooling exposes `GetTools` and `ExecuteTool` as mesh-advertisable `both` methods: `app/services/tooling/service.py:204-212`, `app/services/tooling/service.py:469-477`.

## Roadmap-only acceptance criteria
A complete downstream roadmap should:
1. Identify current working foundations and targeted test evidence.
2. Separate confirmed code facts from inference/risk.
3. Rank gaps by dependency and architectural risk.
4. Define a pragmatic security-tier model.
5. Define hybrid addressing semantics.
6. Provide module-by-module integration opportunities and cautions.
7. Include acceptance checks for each phase.
8. Preserve no-implementation scope.

## Assumptions exposed and resolutions
- Broad service sharing should not mean universal transparency. Resolved as hybrid: transparent defaults for low-risk cases, explicit peer/resource addressing for sensitive domains.
- Security should not be one-size-fits-all. Resolved as pragmatic tiers across home, cluster, and internet deployments.
- The first deliverable is not a first implementation slice. Resolved as roadmap-only.

## Recommended roadmap structure
Use these phases when converting this spec into a planning artifact:

### Phase 0 — Foundation truth map and regression safety
- Preserve current passing mesh tests.
- Add explicit tests/diagnostics for multi-peer stable identity, token scoping, reverse pairing, manifest ACKs, config schema parity, service reannouncement, and process-mode Gateway restart.
- Produce a mesh status/debug endpoint or CLI summary showing local identity, connected peers, negotiated services, route decisions, compatibility failures, and active calls.

### Phase 1 — Mesh identity, reconnection, and policy hardening
- Align WebRTC signaling peer identity, stable mesh identity, registry identity, manifest identity, and persisted credential lookup.
- Replace global saved-token shortcuts with peer-scoped token lookup and re-auth.
- Make reverse pairing peer-specific.
- Surface `allowed_peers`, `min_version`, and `required_capabilities` in config schema/defaults or intentionally remove them from runtime config.
- Clarify DataChannel app-layer E2EE behavior versus WebRTC DTLS-only transport.

### Phase 2 — Capability graph and hybrid addressing
- Introduce a first-class capability graph over peers, services, methods, tools, resources, trust tier, latency, version, and policy.
- Keep module-level transparent routing for simple services.
- Add explicit selectors for sensitive operations: peer ID, service instance, resource namespace, tool ID, hardware target, data scope.
- Support provider aggregation rather than only one provider per module.

### Phase 3 — Remote Tooling / Orchestrator integration
- Make Tooling discovery return peer/source metadata, stable tool IDs, namespace/collision policy, safety class, required permissions, schemas, and execution location.
- Let orchestrators bind local + remote tools in one view while preserving provenance.
- Route execution by explicit tool/provider identity when necessary.
- Add per-tool policy: allow/deny, confirmation required, rate limits, human-in-the-loop, dry-run, and hardware safety labels.
- Ensure remote execution audit logs include caller peer, caller principal, target peer, tool, resource, arguments hash/redaction, result status, and correlation ID.

### Phase 4 — DB/data sharing modes
- Define data domains: chat history, memories/RAG, scheduler state, auth/audit, mesh credentials, app config.
- For each domain choose one mode: remote query only, explicit export/import, selective one-way replication, bidirectional eventual sync, or never share.
- Avoid raw cross-peer SQL as a shared capability.
- Design replication with namespaces, tombstones, conflict resolution, provenance, encryption-at-rest, redaction, and delete/forget semantics.
- Keep Auth/mesh credential DB tables local-authoritative unless a separate trust model is approved.

### Phase 5 — Module-specific deeper integrations
- TTS: remote synthesize is safe; remote playback needs explicit target peer/output device.
- STT/Wakeword/Transcription: remote batch transcription is safer than streaming microphone/audio; streaming needs consent, bandwidth, and privacy indicators.
- Scheduler: remote list/schedule/cancel should be namespace-aware; actions that invoke tools need delegated policy.
- Orchestrator: remote user input and sub-orchestrator delegation need loop prevention, budget limits, and transcript privacy controls.
- Config: safe read-only config export may be useful; remote mutation should be admin-only and usually explicit.
- Auth: pairing/peer management already crosses mesh, but broad Auth admin exposure should not be part of transparent service sharing.

### Phase 6 — Operations, observability, and failure modes
- Add route tracing, correlation IDs across peer calls, distributed audit views, compatibility reports, and synthetic mesh health checks.
- Add chaos tests for peer disconnect, stale manifest, service restart, partial capacity, latency changes, token expiry, denied permissions, and fallback routing.
- Define safe degraded behavior when a remote provider disappears mid-orchestration or mid-tool-call.

## Security model: pragmatic tiers
1. **Tier A — Personal trusted LAN / VPN**
   - Default: paired-admin trust, service-level grants, transparent routing for low-risk services.
   - Explicit addressing required for hardware, DB writes, scheduler mutations, remote playback, and config/auth changes.
2. **Tier B — Shared household / team process cluster**
   - Default: peer + service + method grants, namespace-aware data scopes, per-tool policy, audit required.
   - Transparent routing only for read/query/synthesize-type operations.
3. **Tier C — Internet-crossing / multi-user mesh**
   - Default: zero-trust-leaning, narrow grants, short-lived tokens, revocation checks, capability attestations, explicit resource selectors, stricter rate limits.
   - No transparent high-risk actions.

## Hybrid addressing target
- Transparent bus routing remains useful for local-like service dependencies and fallback.
- Explicit addressing becomes mandatory when caller intent depends on *which peer/resource* is used: remote tools, DB namespaces, hardware controls, audio devices, scheduler ownership, and privacy-sensitive data.
- Capability-marketplace behavior can be layered on top: planners discover candidate providers, but policy decides which can be invoked and whether confirmation is required.

## Residual risks
- Broad roadmap still needs conversion into phased PRD/test specs before code changes.
- Some findings are inferred from source inspection and should be validated with focused tests before implementation.
- No external best-practice research was performed; use a bounded research pass before choosing DB replication technology or distributed policy framework.
