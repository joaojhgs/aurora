# Mesh UI Roadmap Integration Review

## Summary

The mesh roadmap through PER-146 gives future UI work enough backend contract surface to start with diagnostics, capability discovery, peer trust state, safe remote-tool flows, ownership-aware scheduler views, data policy explanations, and failure diagnostics. UI production must still be sequenced carefully because several high-risk claims remain intentionally blocked or deferred.

## Completed Mesh Surface To UI Mapping

| Mesh issue | Backend result | UI implication |
|---|---|---|
| PER-128 | `Gateway.GetMeshStatus` route/status diagnostics. | UI can render backend-proven mesh status, route decisions, provider eligibility, compatibility, capacity, and stale state. |
| PER-129 | Stable peer identity separate from WebRTC signaling session IDs. | UI can use stable peer IDs for trust, provenance, and selectors; signaling IDs stay transport-only. |
| PER-130 | Peer-scoped saved WebRTC tokens. | UI can explain credential reuse per stable peer only after backend auth resolves that peer. |
| PER-131 | Peer-specific reverse pairing skip. | UI should show bilateral pending/approved/denied state per peer, not global paired/unpaired state. |
| PER-132 | Mesh sharing config schema/runtime parity. | UI can expose share/capacity/allowlist/version/capability/prefer/fallback/explicit-selector fields when production config UI is in scope. |
| PER-133 | Optional app-layer DataChannel E2EE and mismatch drop. | UI can surface E2EE enabled/mismatch failure states from diagnostics; no plaintext downgrade claims. |
| PER-134 | Capability graph core. | UI can build a capability explorer backed by provider/service/method/resource/policy/provenance models. |
| PER-135 | Hybrid addressing primitives. | UI can build explicit target selectors for peer/provider/service/resource/tool/hardware/data scope. |
| PER-136 | Provider aggregation diagnostics. | UI should show all candidates and reason codes, not only the selected provider. |
| PER-137 | Tooling discovery metadata. | UI can show stable tool IDs, provider identity, display aliases, safety class, and provenance. |
| PER-138 | Remote Tooling execution routing and audit provenance. | UI can execute remote tools only through explicit selector/resource/confirmation paths where policy requires them. |
| PER-139 | Orchestrator authorized remote tool binding. | UI can show safe remote tools in assistant context; unsafe/confirmation-required remote tools stay gated. |
| PER-140 | DB/data-sharing policy. | UI can explain remote-query-only and export/import planning states; replication and raw SQL stay blocked. |
| PER-142 | Audio capability boundaries. | UI must separate batch synthesize/transcribe from remote playback and live audio streaming consent flows. |
| PER-143 | Scheduler delegation policy. | UI can show namespace, owner, target selector, delegated permissions, policy decision, and correlation. |
| PER-144 | Auth/Config mesh boundaries. | UI must keep Auth/Config broad admin/mutation local unless future policy exists. |
| PER-145 | Distributed tracing/audit. | UI can present copyable correlation IDs and redacted audit diagnostics for remote actions and denials. |
| PER-146 | Chaos/failure-mode coverage. | UI state language must preserve fallback vs explicit hard failure, stale, denied, capacity, auth expiry, and no-route behavior. |

## UI Claims Allowed Now

- "This peer is negotiated/stale/denied/pending" when backed by Gateway/Auth state.
- "This route is local/remote/none/error" when backed by `GetMeshStatus.routes`.
- "This provider is ineligible because ..." when backed by provider diagnostics.
- "This capability requires explicit selector/confirmation/consent/privacy indicator" when backed by capability policy metadata.
- "This remote tool execution succeeded/failed/was denied/dry-ran" when backed by Tooling response and correlation/audit evidence.
- "This data feature is remote-query-only or deferred" when backed by data policy.

## UI Claims Still Blocked Or Deferred

- Pairing success from presence alone.
- Transparent fallback after explicit target failure.
- Raw SQL, credential, token, config secret, or mesh secret sharing.
- Bidirectional RAG/chat/scheduler replication.
- Remote Auth/Config admin as a transparent mesh provider.
- Dangerous remote tool auto-execution.
- Remote playback, microphone, wakeword, or live stream state without consent and backend audio evidence.
- True Tauri E2E from browser-only tests.

## Production Sequencing Recommendation

Start with SDK adapters, mesh diagnostics, peer trust state, and capability explorer. Add remote action preflight before any Tooling, scheduler, data, or audio execution surface. Defer Tauri until the SDK and Gateway-backed UI surfaces have enough fixtures and integration coverage to justify native E2E.

## Verification Notes

This review was produced from the PER-128 through PER-146 plan files, current Gateway/Auth/Tooling/Scheduler/DB/audio contract models, and current docs. On `feat/ui-multi-platform-integration`, `modules/ui-mock-reference/` exists as a visual/component reference only; production mesh UI truth must still come from `AuroraClient`, capability catalog/route diagnostics, native manifests, or explicit unsupported/degraded states.
