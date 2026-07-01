# Aurora UI Refinement Index

## Purpose

This directory is the planning source for future Aurora UI production work after the mesh roadmap completed through PER-146. It keeps UI state language tied to backend evidence instead of frontend-only assumptions.

Aurora does not currently have a Tauri client. Current production truth is the Python service layer, Gateway APIs, optional PyQt/UIBridge, WebRTC mesh runtime, Auth/RBAC, and typed message-bus contracts.

## Required Reading For UI Tasks

- `aurora-ui-sdk-contract.md` for backend truth sources, typed surfaces, and claims the UI may or may not make.
- `aurora-ui-ux-flows.md` for expected user flows, state language, focus behavior, and failure handling.
- `feature-service-availability-graph.md` for availability semantics and how to render provider/capability state.
- `../mesh-ui-roadmap-integration-review.md` for how PER-128 through PER-146 changed UI sequencing.
- `../ui-production-tasks/index.md` and `../ui-production-tasks/backend-gap-crosswalk.md` before starting implementation work.

## Current Mesh-Backed UI Contract Surface

The following backend surfaces are considered stabilized enough for UI planning:

- Mesh status and route diagnostics via `Gateway.GetMeshStatus`.
- Stable peer identity and bilateral peer trust state via Auth mesh peer contracts.
- Peer-scoped inbound WebRTC tokens and peer-specific reverse pairing semantics.
- Mesh sharing config parity for share, capacity, peer allowlists, version, capabilities, route preference, fallback, and explicit selector requirements.
- Optional DataChannel app-layer E2EE with safe mismatch/drop behavior.
- Executable capability catalog output via `Gateway.GetCapabilityCatalog`; `Gateway.GetCapabilityGraph` may remain a derived diagnostic/topology view, but production UI execution decisions must use the catalog.
- Hybrid addressing through `MeshAddressSelector`.
- Provider aggregation with eligible and ineligible provider reason codes.
- Aggregate Tooling discovery/execution metadata via `Tooling.GetToolCatalog` and approval/execution APIs, with provider identity, stable tool IDs, safety class, token-bound approval, resource selector, provenance, status, and `correlation_id`.
- Orchestrator binding for safe remote tools only, with unsafe/confirmation-required remote tools hidden from automatic model selection.
- DB/data-sharing policy that prohibits raw cross-peer SQL and defers replication.
- Audio boundaries that distinguish batch synthesis/transcription from remote playback and live audio streams.
- Scheduler delegation fields for namespace, owner, target selector, delegated permissions, policy decision, and correlation.
- Auth/Config mesh boundaries that keep broad admin/mutation local unless future explicit policy exists.
- Distributed tracing/audit with correlation propagation and redacted diagnostics.
- Chaos/failure-mode expectations for stale providers, denied selectors, capacity exhaustion, auth expiry, network-only no-route, fallback, and forwarding-loop prevention.

## State Vocabulary

Use this vocabulary consistently in UI specs and future copy:

| State | UI meaning | Required backend evidence |
|---|---|---|
| backend-proven | The UI can present the state as true. | Fresh Gateway/Auth/service response or subscribed event with matching identity/correlation. |
| pending | The operation is requested but not yet completed. | Backend request accepted, pending peer/policy/action state, or in-flight correlation ID. |
| denied | The backend rejected the request by auth, permission, sharing, selector, or policy. | Structured denial response, reason code, or audit event. |
| degraded | The feature is available with reduced capability or fallback. | Route diagnostic, health state, compatibility warning, or fallback result. |
| stale | The peer/provider/service is known but not currently fresh enough to trust. | PeerRegistry/Gateway stale status or heartbeat/manifest age beyond policy. |
| privacy-blocked | The action is intentionally unavailable until consent, explicit target, or policy is satisfied. | Capability policy flags, data-sharing policy, audio policy, or explicit selector requirement. |
| deferred | The backend contract for the claim does not exist yet. | Listed in `backend-gap-crosswalk.md`. |

## Mock Reference Status

`modules/ui-mock-reference/` exists on `feat/ui-multi-platform-integration` and remains a visual/component reference only. Production UI truth comes from `AuroraClient`, capability graph/catalog data, native manifests, or explicit unsupported/degraded states. Mock-reference data must not be imported by production screens as live state.
