# Auth and permissions

**Status:** Current source of truth

Aurora separates identity, permission policy, and service execution. External callers enter through Gateway/Auth boundaries; service work still happens through typed bus contracts.

## Components

| Component | Path | Responsibility |
| --- | --- | --- |
| AuthService | `app/services/auth/` | Pairing records, token/principal records, auth audit events, and auth contract methods. |
| Gateway ACL | `app/services/gateway/acl/` | Request identity extraction, permission checks, audit context, and route enforcement. |
| Gateway auth proxy | `app/services/gateway/auth_proxy.py` | Gateway-to-AuthService request boundary. |
| Contract metadata | `@method_contract(... required_perms=...)` | Declares required permission strings for exposed methods. |
| Shared auth models | `app/shared/auth/` and `app/shared/contracts/models/auth.py` | Typed principal/token/pairing/audit payloads. |

## Principal and token model

Aurora uses principals to represent authenticated users, devices, peers, or service actors. Tokens are tied to principals and are checked at Gateway/API boundaries. Mesh pairing flows also create or negotiate peer trust material before service access is allowed.

The exact token/pairing payloads live in `app/shared/contracts/models/auth.py` and are served through AuthService contract methods.

## Permission strings

Permissions are service/topic oriented. Method contracts may declare required permissions such as:

```python
@method_contract(
    method_id=BackupMethods.CREATE,
    exposure="external",
    method_type="manage",
    required_perms=["Backup.manage"],
)
```

Common forms:

| Form | Meaning |
| --- | --- |
| `Service.use` | Permission to invoke normal/use methods for a service area. |
| `Service.manage` | Permission to invoke administrative or mutating methods. |
| `Service.*` | Service-wide wildcard where policy permits it. |
| Explicit method/topic permission | Fine-grained method control for sensitive surfaces. |

Contract-required permissions are additive with Gateway/Auth policy. Do not bypass them by calling service methods directly.

## External request flow

```text
HTTP/SSE/WebRTC request
  -> Gateway identity extraction
  -> Auth/ACL permission check
  -> generated route or mesh peer bridge
  -> bus request/event with typed model
  -> service method contract
  -> audit/result metadata returned to caller
```

## Mesh and peer trust

Mesh access is not equivalent to local trust. A peer must pass pairing/authentication and still satisfy capability, permission, routing, and data-sharing policy checks. For mesh-specific flow details, see [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md) and [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md).

## Admin and sensitive surfaces

Admin-style surfaces must declare `method_type="manage"` and explicit permissions. Examples include backup/restore, config mutation, peer management, and high-risk tooling. Destructive operations should also expose dry-run/impact-plan behavior where practical.

## Configuration security

Configuration reads/writes are mediated by ConfigService and Gateway/Auth policy. Sensitive values should be redacted externally and sourced from `.env` where appropriate. See [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md) for service access rules.

Historical config-security investigation artifacts are archived in `docs/archive/` and are not current policy.

## Validation references

- Contract models: `app/shared/contracts/models/auth.py`, `app/shared/contracts/models/gateway.py`.
- Gateway ACL: `app/services/gateway/acl/`.
- Auth service tests: `tests/unit/services`, `tests/unit/gateway`, and integration/e2e auth coverage where present.
- SDK/backend conformance: [`SDK_BACKEND_CONFORMANCE_CI.md`](SDK_BACKEND_CONFORMANCE_CI.md).
