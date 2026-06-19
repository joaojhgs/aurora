# PER-157 Tool Sharing Policy And Approval Protocol

## Requirements Summary

- Source of truth: Multica issue PER-157 / MESH-GAP-005 and `.omx/multica/mesh-production-gap-tasks/05-mesh-gap-005-mesh-gap-p2-implement-tool-sharing-policy-and-approval-protocol-for-local-and-mesh-tools.md`.
- Context: `.omx/plans/mesh-production-e2e-integration-gap-plan.md`, `.omx/specs/deep-interview-mesh-distributed-integration.md`, BE-004, and BE-011.
- Preserve bus-only service boundaries, typed Tooling/Auth contracts, Pydantic IO models, and privacy-first defaults.
- Replace raw `confirmed=true` authorization with server-issued approval tokens for approval-required local and remote tools.

## Implementation Steps

1. Extend `app/shared/contracts/models/tooling.py` with policy, decision, preparation, approval, confirmation, and token-bound execution models.
2. Implement in-memory Tooling policy and approval state in `app/services/tooling/service.py`, including audit events through `Auth.StoreAuditEvent`.
3. Filter `GetTools` discovery by sharing policy and expose policy decisions through new manage contracts.
4. Enforce token validation in `ExecuteTool` for sensitive, dangerous, or explicitly approval-required local and remote tools. Keep dry-run previews available.
5. Add focused unit tests in `tests/unit/tooling/test_service.py` for all approval modes, raw confirmed bypass denial, token mismatch/replay/expiry, discovery filtering, and audit evidence.

## Acceptance Criteria

- Local/internal tools can require approval and can use approve-all modes.
- Remote tools can require approval with token-bound execution.
- Dangerous remote tool execution fails without a valid approval token, even if `confirmed=true`.
- Token replay, expiry, peer mismatch, args mismatch, tool mismatch, and resource mismatch are denied.
- Sharing policy can hide or expose tools independently of service-level Tooling share.
- Approve-all modes are visible through policy/decision contracts and audited.

## Verification

- `uv run pytest tests/unit/tooling/test_service.py -q`
- `uv run pytest tests/unit/gateway/test_rpc.py -q`
- `uv run ruff check app/shared/contracts/models/tooling.py app/services/tooling/service.py tests/unit/tooling/test_service.py`

## Risks

- Policy persistence is intentionally in-memory for this slice; later config/schema persistence can build on the typed contract.
- Orchestrator approval UX remains a downstream integration; this task enforces backend safety and exposes contracts.
