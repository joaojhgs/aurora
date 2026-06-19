# Aurora UI SDK Contract

## Contract Rule

The UI SDK must be a typed adapter over Gateway/service truth. It may cache responses for rendering, but it must not invent service state, peer state, pairing success, route success, tool execution, audio activity, DB replication, or scheduler delegation.

## Backend Truth Sources

| UI concern | Backend source | UI may claim | UI must not claim |
|---|---|---|---|
| Local mesh runtime | `Gateway.GetMeshStatus.local` | Mesh enabled/started, WebRTC started, stable peer ID, node name, configured shared/routed modules. | Remote connectivity or sharing success without peer/route evidence. |
| Peer lifecycle | `Gateway.GetMeshStatus.peers`, Auth `MeshListPeers`/`MeshGetPeer` | connected, authenticated, negotiated, stale, disconnected, outbound/inbound pending/approved/denied. | A peer is trusted, usable, or paired based only on presence. |
| Route/provider choice | `Gateway.GetMeshStatus.routes`, PeerRegistry provider diagnostics | local, remote, none, or error route decision with eligible/ineligible providers and reason codes. | Silent fallback success for explicit selectors. |
| Capability availability | `Gateway.GetCapabilityCatalog` for execution; `Gateway.GetCapabilityGraph` only as diagnostic/topology input if still exposed. | provider peer, service instance, methods/actions/resources, policy flags, address fields, freshness/provenance, provider/candidate indexes, bindability, approval/selector blockers. | That a diagnostic graph node is executable when the catalog/policy flags require missing consent, approval token, selector, or permission. |
| Explicit targeting | `MeshAddressSelector` fields on typed payloads | Selected peer/provider/service/resource/tool/data scope when present and backend-accepted. | Resource targeting from display name alone. |
| Tool discovery/execution | `Tooling.GetToolCatalog`, `Tooling.PrepareExecution`, `Tooling.RequestApproval`, `Tooling.ConfirmExecution`, `Tooling.ExecuteTool`; legacy `Tooling.GetTools` remains per-provider/backward-compatible only. | local/remote location, provider identity, stable global tool ID, safety class, approval mode, approval token status, resource selector, status/error, correlation ID. | Treating one-provider `Tooling.GetTools` as the full mesh catalog, or executing approval-required local/remote tools with raw `confirmed=true`. |
| Orchestrator remote tools | Tooling metadata plus Orchestrator binding behavior | Standard remote tools can be included in planning context when authorized. | That dangerous or confirmation-required remote tools are auto-bound to the LLM. |
| DB/data | `docs/DATA_SHARING_POLICY.md`, DB query contracts | Remote-query-only or export/import planning states where backend contracts exist. | Raw cross-peer SQL, active replication, or delete propagation. |
| Scheduler | Scheduler ownership/delegation contract fields | Namespace, owner, target selector, delegated permissions, policy decision, correlation. | Ownership transfer or cross-peer job sync. |
| Audio | Capability policy metadata and TTS/STT typed selectors | Batch synthesize/transcribe availability; explicit target/consent requirements for playback/streaming. | Remote microphone/listening/speaking/playback state without backend event and consent evidence. |
| Auth/Config | Auth mesh peer contracts, Config local API policy | Local peer administration and local config state. | Broad transparent Auth/Config sharing or remote config mutation. |
| Tracing/audit | `correlation_id`, Auth audit records, redacted diagnostics | Correlate a user-visible failure to logs/audit with redacted details. | Raw secrets, tokens, passwords, API keys, or unredacted tool arguments. |

## SDK Shapes Future UI Should Preserve

The SDK should normalize backend responses into small view models without discarding raw IDs:

- `PeerSummary`: `peer_id`, `node_name`, lifecycle state, trust state, latency, stale age, service count, last evidence source.
- `RouteSummary`: module, decision target, provider peer, reason, fallback, provider candidates, error code.
- `CapabilitySummary`: service instance, provider peer, method/resource, selector address, policy flags, routable/blockers.
- `RemoteActionPreflight`: target selector, policy flags, required confirmation/consent/resource fields, expected audit/correlation fields.
- `ToolApprovalRequest`: approval request ID, correlation ID, policy decision ID, global tool ID, provider peer/service IDs, mesh/resource selectors, args schema/hash, approval mode, expiry, status, denial reason, and required follow-up action.
- `AuditReference`: correlation ID, event kind, peer, method/tool/resource, status, redacted detail availability.

Required high-level client namespaces once `@aurora/client` is implemented:

- `client.capabilities.listCatalog()` over `Gateway.GetCapabilityCatalog`.
- `client.routes.explain()` over `Gateway.ExplainRoute`.
- `client.tools.listCatalog()` over `Tooling.GetToolCatalog`.
- `client.tools.prepareExecution()`, `client.tools.requestApproval()`, `client.tools.confirmExecution()`, and `client.tools.execute()` over the matching Tooling contracts.
- Approval/tool execution events for requested, approved, denied, executed, and failed states, correlated by backend IDs.

## Privacy And Redaction

- The SDK must preserve `secrets_redacted=true` as a displayable diagnostic assertion.
- Never log or render token values, room passwords, API keys, credential hashes, or unredacted tool arguments.
- Use hashes/fingerprints only when they come from backend audit details.

## Error Handling

Map backend reason codes directly before adding user-facing copy:

- selector failures: missing target, peer not found, unauthorized, stale/not ready, service missing, incompatible capabilities, at capacity.
- policy failures: permission denied, confirmation missing, resource selector missing, privacy blocked.
- routing failures: no route, network-only no provider, explicit selector target failed, fallback used or blocked.
- transport failures: timeout, send failure, app-layer E2EE mismatch/drop, auth expiry.

## Tauri Boundary

Future Tauri commands should be typed and minimal. They should call Gateway/service APIs or orchestrate Python sidecars, then return backend evidence to the frontend. Tauri IPC must not become a second source of truth for services, mesh, auth, tools, DB, scheduler, or audio.
