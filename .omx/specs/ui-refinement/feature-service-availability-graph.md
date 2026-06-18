# Feature And Service Availability Graph Semantics

## Purpose

Future UI should render service availability from backend graph and diagnostic data, not from hardcoded feature flags. The graph is a UI interpretation layer over `Gateway.GetCapabilityGraph`, `Gateway.GetMeshStatus`, Auth peer state, and domain-specific service contracts.

## Availability Inputs

| Input | Use |
|---|---|
| `CapabilityGraph.peers` | Peer identity, provider kind, lifecycle status, latency, provenance. |
| `CapabilityGraph.services` | Service instance identity, module, version, methods, capacity, routability, blockers, policy. |
| `CapabilityGraph.resources` | Explicitly addressable resource placeholders and future resource ownership. |
| `provider_index` | Routable providers by module. |
| `candidate_provider_index` | All known provider candidates, including blocked/degraded candidates. |
| `GetMeshStatus.routes` | Current routing decisions and provider eligibility reasons. |
| Auth peer state | Trust, inbound/outbound approval, permissions, connection state. |
| Domain responses | Tool execution status, scheduler job state, DB query results, audio service events, audit records. |

## Availability State Model

| State | Definition | Common backend evidence |
|---|---|---|
| available-local | Local provider exists and policy allows local use. | Local graph provider, local route decision, healthy service. |
| available-remote | Negotiated remote provider is eligible and policy allows remote use. | Route target remote, eligible provider, capability policy allows. |
| pending | Waiting for pairing, approval, manifest, confirmation, consent, or in-flight request completion. | Auth pending state, request correlation ID, policy preflight. |
| denied | Backend rejected by trust, permission, selector, policy, or auth. | Denial response, audit event, provider reason code. |
| degraded | Usable through fallback, reduced capacity, compatibility warning, or stale secondary provider. | Fallback route, compatibility failure, capacity warning. |
| stale | Known provider is stale and must not be selected. | Peer status `stale`, ping/manifest age. |
| privacy-blocked | Feature needs explicit consent/selector/privacy indicator before use. | Capability policy flags or data/audio policy. |
| unsupported | No backend contract exists in this checkout. | Backend gap crosswalk entry. |

## Rendering Rules

- Show provider and selector identity close to the feature action.
- Separate "known candidate" from "currently selectable" providers.
- Keep `route_blockers` and provider `reason_code` available for diagnostics.
- Treat `secrets_redacted=true` as a property of the diagnostic snapshot; never render secret-like fields even in debug views.
- Prefer stable peer IDs and service instance IDs for tooltips/details, with node names as labels.

## Domain-Specific Graph Notes

### Mesh Core

`GetMeshStatus` is the source for operational route diagnostics. `GetCapabilityGraph` is the source for inspectable service/method/resource topology.

### Tooling And Orchestrator

Remote tool availability depends on Tooling metadata and policy:

- Standard, authorized remote tools can be selectable.
- Sensitive, dangerous, or confirmation-required tools are visible only through an explicit preflight/approval path.
- Orchestrator auto-binding is limited to remote tools that backend metadata marks safe.

### DB/Data

DB availability must be labeled by mode: remote-query-only, export/import planned, replication deferred, or never-share. Raw SQL is always unavailable for mesh UI.

### Audio

Audio availability must distinguish batch operations from physical-device playback and live streams. Playback/streaming require selector, consent, and privacy UI before becoming selectable.

### Scheduler

Scheduler availability is ownership-scoped. A remote scheduler capability is not enough to list/cancel/execute all jobs; namespace and owner filters must be backend-authorized.

### Auth And Config

Auth/Config broad admin and mutation surfaces remain local-admin surfaces. Pairing/login infrastructure is not evidence that Auth or Config are transparently mesh-shareable.
