# PER-138 Remote Tooling Execution Routing Plan

## Scope
- Issue: PER-138 `[MESH][P3-T02] Implement explicit remote Tooling execution routing and audit provenance`.
- Source docs read: issue description/metadata/comments, `AGENTS.md`, `app/services/AGENTS.md`, `app/shared/AGENTS.md`, `app/shared/contracts/AGENTS.md`, `app/messaging/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/services/auth/AGENTS.md`, `tests/AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/GATEWAY.md`, `docs/SERVICE_METHODS_REFERENCE.md`, `docs/MESSAGING_ARCHITECTURE.md`, `.omx/plans/PER-137-tooling-discovery-metadata.md`.
- Source docs named by the issue but missing in this checkout: `.omx/specs/deep-interview-mesh-distributed-integration.md`, `.omx/multica/mesh-roadmap-tasks/P3-T02*`, `.omx/multica/mesh-roadmap-tasks/task-index.json`.

## Requirements
- Preserve local Tooling execution compatibility.
- Let explicit `mesh_selector` requests route to the selected peer/provider through existing MeshBus routing.
- Deny unsafe remote executions before tool invocation when the request lacks required confirmation/resource selection.
- Persist audit provenance without leaking raw arguments or secrets.
- Preserve actual inbound remote caller provenance by injecting WebRTC peer/principal/correlation context server-side.

## Implementation Steps
1. Extend `app/shared/contracts/models/tooling.py` with execution context, resource selector, confirmation/dry-run flags, structured status/error codes, and audit metadata fields.
2. Update `app/services/tooling/service.py` to:
   - resolve local names/global IDs/namespaced names as before;
   - compute deterministic argument fingerprints with key redaction;
   - enforce remote policy for sensitive/dangerous tools before invocation;
   - return structured denial/not-found/execution errors;
   - write `Auth.StoreAuditEvent` records with caller peer, caller principal, target peer, tool IDs, resource selector, correlation ID, outcome, and denial reason.
3. Update `app/services/gateway/webrtc/rpc.py` to inject trusted `caller_peer_id`, `caller_principal_id`, and `correlation_id` into inbound `Tooling.ExecuteTool` payloads before model construction.
4. Add focused unit tests in `tests/unit/tooling/test_service.py`, `tests/unit/gateway/test_rpc.py`, and, if needed, `tests/unit/gateway/test_mesh_bus.py`.
5. Update `docs/SERVICE_METHODS_REFERENCE.md` with the remote Tooling execution contract additions.

## Acceptance Criteria
- Explicit remote Tooling requests still route by `mesh_selector`.
- Dangerous/sensitive remote tools require confirmation and resource context before execution.
- Policy denial returns a structured response and does not invoke the tool.
- Audit writes include provenance and a redacted argument hash, not raw argument values.
- Local execution remains backward compatible.

## Verification
- `uv run pytest tests/unit/tooling/test_service.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_mesh_bus.py -q`
- Add narrower retries if dependency import issues require isolating files.
