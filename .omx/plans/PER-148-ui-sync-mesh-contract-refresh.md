# PER-148 UI Sync: Mesh Contract Refresh Plan

## Requirements Summary

- Source issue: PER-148 `[UI-SYNC-001] Refresh UI roadmap, contracts, and mock references against stabilized mesh contracts`.
- Scope is documentation/spec synchronization only. Do not implement production UI, redesign mock references, or reopen completed mesh work without a concrete inconsistency.
- Backend evidence read from completed mesh plans `PER-128` through `PER-146`, current Gateway/Auth/Tooling/Scheduler/DB contract models, and mesh docs.
- The checkout does not contain the previously referenced UI spec files or `modules/ui-mock-reference/`; this task recreates the minimum committed UI planning artifacts and records the missing mock-reference status.

## UX Flow Plan

1. Treat Gateway and service contracts as UI truth sources:
   - `Gateway.GetMeshStatus` for local mesh state, peer lifecycle, route diagnostics, compatibility failures, provider eligibility, capacity, and stale state.
   - `Gateway.GetCapabilityGraph` for addressable capabilities, policy metadata, provider/resource identity, and explicit-selector requirements.
   - Auth mesh peer contracts for stable peer identity, outbound/inbound approval, denial, permissions, and connection state.
   - Tooling, Orchestrator, DB, Scheduler, TTS/STT, and audit contracts for domain-specific states.
2. Model distributed UI status as explicit state families: backend-proven, pending, denied, degraded, stale, privacy-blocked, and deferred.
3. Keep mesh-dependent controls disabled or in a diagnostics-only state unless the backend exposes the target peer/resource, policy decision, and correlation/audit trail needed to support the claim.

## Component Boundaries

- Mesh status surface: consumes `GetMeshStatus`; renders lifecycle and route diagnostics without mutating mesh state.
- Capability explorer: consumes `GetCapabilityGraph`; shows providers, services, methods, resources, policy flags, and selectors.
- Peer administration: consumes Auth mesh peer APIs; limited to local admin/trust state, not transparent Auth sharing.
- Remote action preflight: consumes Tooling/Scheduler/audio policy metadata; requires explicit target selectors and confirmation when policy says so.
- Diagnostics/audit panel: consumes correlation IDs and redacted audit records; no raw secret or argument display.

## Backend Truth Sources

- Stable identity and bilateral pairing: Auth/Gateway peer records and DataChannel auth/manifest state.
- Routing and provider state: MeshBus, RoutingTable, PeerRegistry, `GetMeshStatus`, and capability graph output.
- Tool and orchestrator provenance: `ToolingToolInfo`, `ToolingExecuteToolRequest/Response`, and Orchestrator hidden remote binding semantics.
- Data/scheduler/audio policy: `docs/DATA_SHARING_POLICY.md`, scheduler ownership fields, and capability graph audio policy metadata.
- Tracing/audit: `correlation_id` fields propagated through MeshBus, PeerBridge, RPCHandler, service execution, and Auth audit records.

## Accessibility And Focus Behavior

- Distributed-state controls must expose text labels and machine-readable status, not color alone.
- Any confirmation flow for remote tools, scheduler delegation, playback, or streaming must trap focus in the dialog, return focus to the invoking control, and keep the selected peer/resource visible.
- Denied, stale, degraded, and privacy-blocked states must include an actionable explanation from backend reason codes where available.
- Diagnostics can be dense, but tables/lists must keep keyboard navigation and copyable correlation IDs.

## Tauri Readiness

- Future Tauri UI must call local Gateway/service APIs or typed native bridge commands backed by Python services. It must not simulate peer state, route success, pairing success, audio activity, tool execution, DB sync, or scheduler delegation in frontend state alone.
- True Tauri E2E must exercise the native shell, backend sidecars/services, Gateway/WebRTC/mesh state, isolated profiles, and real correlation/audit paths. Browser-only Playwright can cover isolated UI behavior but cannot prove Tauri IPC or mesh behavior.

## Implementation Steps

1. Recreate missing UI refinement specs:
   - `.omx/specs/ui-refinement/index.md`
   - `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md`
   - `.omx/specs/ui-refinement/aurora-ui-ux-flows.md`
   - `.omx/specs/ui-refinement/feature-service-availability-graph.md`
2. Recreate missing production sequencing specs:
   - `.omx/specs/ui-production-tasks/index.md`
   - `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`
3. Recreate `.omx/specs/mesh-ui-roadmap-integration-review.md` as the bridge from completed mesh contracts to future UI production tasks.
4. Note that `modules/ui-mock-reference/` is absent in this checkout and therefore no visual/component inventory was possible or needed.
5. Verify by searching for the new spec anchors, checking the doc diff, and confirming no production UI files changed.

## Acceptance Criteria

- UI specs reflect completed mesh surfaces for diagnostics, stable identity, credentials, reverse pairing, sharing config, E2EE, capability graph, hybrid addressing, provider aggregation, remote Tooling/Orchestrator, DB policy, audio boundaries, scheduler delegation, Auth/Config boundaries, tracing/audit, and chaos/failure expectations.
- Feature/service availability semantics distinguish backend-proven, pending, denied, degraded, stale, privacy-blocked, and deferred states.
- Future UI tasks can reference these specs without re-litigating mesh roadmap decisions.
- Missing UI spec files are recreated and missing mock references are explicitly noted.
- No production UI wiring is introduced.

## Verification

- `rg -n "backend-proven|privacy-blocked|GetMeshStatus|GetCapabilityGraph|MeshAddressSelector|correlation_id|modules/ui-mock-reference" .omx/specs`
- `git diff --check`
- `git status --short`
