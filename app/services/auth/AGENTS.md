# Auth Service -- Agent Guide

> **Scope**: `app/services/auth/` -- Authentication, authorization, pairing, mesh peer trust.
> **Parent**: [Services AGENTS.md](../AGENTS.md); [Root AGENTS.md](../../../AGENTS.md).
> **Related**: [Gateway AGENTS.md](../gateway/AGENTS.md) for how Gateway uses Auth; [Contracts AGENTS.md](../../shared/contracts/AGENTS.md) for `AuthMethods` constants. **Config**: use **ConfigAPI.aget** (never sync **get** in async code) — [CONFIG_SERVICE_PATTERN.md](../../../docs/CONFIG_SERVICE_PATTERN.md).

---

## Files

| File | Purpose |
|------|---------|
| `service.py` | Auth service with all method contracts (pairing, principals, tokens, devices, audit, mesh peers) |
| `auth_manager.py` | Core auth logic: pairing state machine, token issuance, principal CRUD, mesh peer management |

---

## CRITICAL RULES

### 1. ALL DB Access Goes Through the Bus

Auth service NEVER imports DB service directly. All database operations use bus requests:

```python
# Standard CRUD -- use DBMethods constants
result = await self.bus.request(DBMethods.CREATE_USER, CreateUserRequest(...))
result = await self.bus.request(DBMethods.GET_USER_BY_ID, GetUserByIdRequest(...))

# Complex mesh SQL -- use DBExecuteSQLRequest
from app.shared.contracts.models.db import DBExecuteSQLRequest, DBMethods
await self.bus.request(
    DBMethods.EXECUTE_SQL,
    DBExecuteSQLRequest(sql="INSERT INTO mesh_peers ...", params=[...]),
)
```

### 2. Use Typed Topic Constants

All bus topics MUST use `AuthMethods.*`, `MeshEvents.*`, or `DBMethods.*` constants:

```python
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.mesh import MeshEvents

# CORRECT
await self.bus.publish(AuthMethods.PAIRING_REQUESTED, event_payload, event=True)
await self.bus.publish(MeshEvents.PEER_APPROVED, approval_event, event=True)

# WRONG
await self.bus.publish("Auth.PairingRequested", event_payload, event=True)
```

### 3. Permission Strings are PascalCase

All permission strings follow the bus topic format: `Service.Action` in PascalCase.

```python
# CORRECT
permissions=["TTS.Request", "Auth.manage", "Orchestrator.*"]

# WRONG
permissions=["tts.request", "auth.manage"]
```

---

## Pairing Flow

Device pairing is an in-memory state machine with 5-minute expiry:

```
1. Remote device calls Auth.PairingStart
   -> Returns 6-digit pairing code
   -> Publishes Auth.PairingRequested event (for UI notification)

2. Remote device sends code to local admin (out-of-band)

3. Local admin calls Auth.PairingConnect with the code
   -> Returns request details (device name, IP)

4. Local admin calls Auth.PairingApprove with code + permissions
   -> Marks pairing as approved with specified permissions

5. Remote device calls Auth.PairingExchange with the code
   -> Creates User, Device, Token in DB
   -> Returns token + device_id + user_id + permissions
```

Pairing state is in-memory (`_pending_pairings` dict). Expired pairings are cleaned on access.

### Bilateral Mesh Pairing

When a mesh peer authenticates with a `remote_peer_id`, RTCClient auto-triggers `_reverse_pairing()` so both admins independently approve each other.

---

## Principal/Token Management

### Principals (Users)

- `Auth.CreatePrincipal` -- create user with username, optional password, permissions, is_admin
- `Auth.GetPrincipal`, `Auth.UpdatePrincipal`, `Auth.DeletePrincipal` -- CRUD
- `Auth.SetPermissions` -- replace entire permission set
- `Auth.PatchPermissions` -- grant/revoke individual permissions
- `Auth.ChangePassword` -- requires old password verification

### Tokens

- `Auth.CreateToken` -- scoped token for a principal, optional device binding
- `Auth.ListTokens` -- list by principal_id or device_id
- `Auth.UpdateTokenScopes` -- modify token permissions
- `Auth.RevokeToken` -- soft-revoke

### Token Validation

`Auth.ValidateToken` resolves effective permissions:
1. Look up token by hash
2. Look up user by token's user_id
3. Compute `effective_perms = wildcard_intersection(user.permissions, token.scopes)`
4. Return validation response with principal info

---

## Audit Event Handling

The `Auth.StoreAuditEvent` contract persists audit events:

```python
@method_contract(
    method_id=AuthMethods.STORE_AUDIT_EVENT,
    input_model=StoreAuditEventRequest,
    output_model=MeshBoolResponse,
    exposure="internal",
)
async def handle_store_audit_event(self, data):
    # Persists via DB.ExecuteSQL -> audit_log table
```

Gateway's `_AuditDBProxy` calls this via bus request (not fire-and-forget event).

`Auth.AuditLog` is a separate query contract for reading audit entries.

---

## Mesh Peer Management

### Trust Store

The `mesh_peers` table tracks peer trust state:
- `outbound_status`: `pending` | `approved` | `denied` (what WE decided about THEM)
- `inbound_status`: `unknown` | `pending` | `approved` | `denied` (what THEY decided about US)
- `outbound_permissions`: permissions we grant to them
- `inbound_permissions`: permissions they grant to us
- `connection_status`: `connected` | `disconnected`

### Permission Sync

When a mesh peer is approved (`Auth.MeshApprovePeer`):
1. `approve_mesh_peer()` sets `outbound_status = "approved"` with permissions
2. Syncs permissions to the linked `User.permissions` and `Token.scopes`
3. Publishes `MeshEvents.PEER_APPROVED` event

When permissions are updated (`Auth.MeshUpdatePeerPermissions`):
1. Updates `outbound_permissions` in mesh_peers
2. Syncs to User and Token
3. Publishes `MeshEvents.PEER_PERMISSIONS_UPDATED` event

### Inbound Credentials

When a remote peer grants US a token (during pairing), it's saved via `Auth.MeshSaveInboundCredential`:
- Stored in `mesh_peers.inbound_token` column
- Loaded on reconnect via `Auth.MeshLoadInboundCredentials`
- Keyed by `remote_peer_id`

### Mesh Identity

Each Aurora instance has a stable `peer_id` stored via `Auth.SaveMeshIdentity`:
- Generated once: `aurora-{random_hex}`
- Persisted in `mesh_identity` table
- Loaded on startup via `Auth.LoadMeshIdentity`

---

## Events Published

| Event | Topic Constant | When |
|-------|---------------|------|
| Pairing requested | `AuthMethods.PAIRING_REQUESTED` | Remote device calls PairingStart |
| Peer approved | `MeshEvents.PEER_APPROVED` | Admin approves a mesh peer |
| Permissions updated | `MeshEvents.PEER_PERMISSIONS_UPDATED` | Admin changes peer permissions |

---

## Internal Patterns

### `_MeshSQL` Helper

`auth_manager.py` uses `_MeshSQL` class to build `DBExecuteSQLRequest` payloads for mesh-specific SQL operations (mesh_peers, mesh_identity tables). This avoids needing per-operation DB contracts for mesh tables.

### Config Reload

Auth service reloads on `auth` or `gateway.permissions` config changes:
- Updates default permissions for new devices
- Updates admin bootstrap settings
