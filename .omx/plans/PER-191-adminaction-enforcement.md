# PER-191 AdminAction Enforcement Plan

## Requirements Summary

- Source issue: PER-191 / BE-004, `admin.action.envelope`.
- Scope: backend Gateway/AdminAction contract only; no production UI wiring.
- Sources read: root/service/gateway/auth/shared/contracts/tests `AGENTS.md`, UI SDK/UX/availability specs, backend gap crosswalk, and `docs/GATEWAY.md`.
- Invariants: generated Gateway routes remain bus-only, use typed contract constants/models, preserve PascalCase permissions, and pass `method_type` into auth checks.

## Acceptance Criteria

- Gateway registry/OpenAPI includes typed `Gateway.AdminActionDraft` and `Gateway.AdminActionConfirm` methods.
- Draft returns action ID, nonce, digest, affected resources, required phrase/reason/reauth flags, expiry, and matching confirmation header names.
- Generated high-risk routes enforce an unexpired server-issued nonce/digest before forwarding to the service bus.
- `method_type="manage"` generated routes are protected unless explicitly read-only/allowlisted; raw `confirmed=true` payloads or arbitrary headers cannot bypass enforcement.
- Confirmed actions persist an Auth audit event and return an audit receipt/correlation header in the generated route response.

## Implementation Steps

1. Extend `app/shared/contracts/models/gateway.py` with `AdminActionDraft/Confirm` request and response models plus `GatewayMethods.ADMIN_ACTION_DRAFT` and `GatewayMethods.ADMIN_ACTION_CONFIRM`.
2. Add GatewayService contract handlers in `app/services/gateway/service.py` for draft/confirm, backed by a process-local pending-action store with nonce, digest, expiry, principal, reason, and affected resources.
3. Update `app/services/gateway/route_generator.py` so generated manage routes require `AdminActionConfirm` header fields, validate nonce/digest/expiry/reason, consume the confirmation once, block header-only bypasses, and audit via `Auth.StoreAuditEvent` before forwarding.
4. Update `tests/unit/gateway/test_route_generator_adminaction.py` and add service-level tests if needed for draft/confirm models and route enforcement.
5. Update `docs/GATEWAY.md` with the AdminAction route flow and run targeted gateway tests plus ruff on touched files.

## Risks And Mitigations

- Risk: generated Auth/Gateway admin routes could deadlock if AdminAction itself requires AdminAction. Mitigation: explicitly exempt `Gateway.AdminActionDraft`, `Gateway.AdminActionConfirm`, read-only manage inventory/log methods, and `Auth.AuditLog`.
- Risk: confirmation state is process-local. Mitigation: document it as short-lived Gateway state and keep expiry short; no persistence or secrets in pending records.
- Risk: audit failure could permit sensitive mutation. Mitigation: make failed audit storage block the forwarded mutation.

## Verification

- `uv run pytest tests/unit/gateway/test_route_generator_adminaction.py -q`
- `uv run ruff check app/services/gateway/route_generator.py app/services/gateway/service.py app/shared/contracts/models/gateway.py tests/unit/gateway/test_route_generator_adminaction.py`

