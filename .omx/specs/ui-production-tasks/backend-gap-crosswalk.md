# UI Backend Gap Crosswalk

## Purpose

This file lists what UI can rely on now and what must remain blocked or deferred until backend contracts exist.

## Backend-Proven Now

| Area | Proven surface | UI can build |
|---|---|---|
| Mesh diagnostics | `Gateway.GetMeshStatus` | Status, route, peer lifecycle, compatibility, provider eligibility, capacity, stale/degraded diagnostics. |
| Capability topology | `Gateway.GetCapabilityGraph` | Capability explorer, policy flag display, provider/service/method/resource graph. |
| Stable peer identity | Auth mesh identity and peer records | Peer identity, node name, inbound/outbound trust state, peer-specific credential state after backend auth. |
| Hybrid addressing | `MeshAddressSelector` on typed payloads | Explicit peer/provider/service/resource/tool/data-scope preflight. |
| Provider aggregation | PeerRegistry diagnostics projected through Gateway | Candidate vs eligible provider views with reason codes. |
| Remote tools | Tooling discovery/execution models | Standard remote tools, safe execution status, provider provenance, correlation/audit references. |
| Orchestrator remote tools | Tooling metadata plus Orchestrator binding semantics | Display which safe remote tools are eligible for assistant planning. |
| Data policy | `docs/DATA_SHARING_POLICY.md`, DB query contracts | Remote-query-only language, policy education, disabled replication/raw SQL controls. |
| Scheduler delegation | Scheduler ownership/delegation fields | Namespace/owner/target/delegated-permission/correlation display. |
| Audio boundaries | Capability graph policy metadata and typed audio selectors | Batch operation availability and explicit privacy/consent requirements. |
| Auth/Config boundaries | Auth/Config docs and schema defaults | Local peer-admin and local config language; no broad remote sharing. |
| Tracing/audit | `correlation_id`, Auth audit details | Copyable diagnostics, redacted failure explanations. |
| Failure behavior | PER-146 chaos expectations and tests | Fallback vs hard-failure state language. |

## Blocked Or Deferred Claims

| Claim | Status | Required backend evidence before UI enables it |
|---|---|---|
| Raw SQL across peers | Blocked | This is explicitly prohibited by data-sharing policy. |
| Bidirectional chat/RAG/scheduler sync | Deferred | Domain sync contracts with namespaces, conflict/delete/tombstone semantics, provenance, and tests. |
| Remote Auth/Config transparent admin | Blocked by current policy | Explicit remote-admin policy and permission model. |
| Remote microphone/live listening | Deferred/privacy-blocked | Consent contract, privacy indicator events, bandwidth/capacity checks, backend stream state. |
| Remote playback/control without target | Privacy-blocked | Explicit peer/device selector, confirmation, backend playback state. |
| Dangerous remote tool auto-binding | Blocked | Explicit confirmation/resource approval flow and backend decision event. |
| Peer pairing success from presence alone | Blocked | Authenticated, bilateral trust, manifest negotiation, and stable peer identity evidence. |
| Tauri E2E from browser tests | Blocked | Native Tauri shell plus backend/native/WebRTC verification harness. |
| UI mock as production source | Deferred | Restored `modules/ui-mock-reference/` and an issue explicitly authorizing production UI implementation. |

## Current Missing Artifacts

- `.omx/specs/ui-refinement/*` and `.omx/specs/ui-production-tasks/*` were absent before PER-148 and are recreated in this branch.
- `modules/ui-mock-reference/` is absent in this checkout, so no component inventory was performed.
- `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/*` are absent in this checkout; PER-128 through PER-146 plan files, current docs, and committed code contracts were used as evidence.
