# Peer Pairing & Resource Access — Complete Flow

> This document describes the full lifecycle of peer pairing in Aurora: how a new device becomes a trusted peer, how it authenticates, how permissions are resolved, and how it accesses Aurora services through both the HTTP API and WebRTC DataChannels.

---

## Table of Contents

1. [Overview](#overview)
2. [Actors & Terminology](#actors--terminology)
3. [Data Model](#data-model)
4. [Pairing Flow (Step-by-Step)](#pairing-flow-step-by-step)
5. [Authentication After Pairing](#authentication-after-pairing)
6. [Permission Resolution](#permission-resolution)
7. [Resource Access Patterns](#resource-access-patterns)
8. [WebRTC Peer Lifecycle](#webrtc-peer-lifecycle)
9. [Permission Updates & Re-resolution](#permission-updates--re-resolution)
10. [Token Lifecycle](#token-lifecycle)
11. [Security Controls](#security-controls)
12. [Audit Trail](#audit-trail)
13. [Sequence Diagrams](#sequence-diagrams)
14. [Configuration](#configuration)
15. [P2P Mesh Networking](#p2p-mesh-networking)

---

## Overview

Aurora uses a **pairing-code handshake** (similar to Bluetooth pairing) to establish trust between the Aurora Gateway and a new device (mobile app, desktop client, IoT device, etc.). Once paired, the device receives a **bearer token** scoped to specific permissions. This token is used for all subsequent communication — whether over the REST API or WebRTC DataChannels.

The system enforces a **principal-based RBAC model** where:

- Every entity (human user, device, WebRTC peer) is a **principal** with a set of **permissions**.
- Every token has **scopes** that restrict what subset of the principal's permissions it can exercise.
- **Effective permissions** = intersection of principal permissions and token scopes.

---

## Actors & Terminology

| Actor | Description |
|---|---|
| **New Device** | A client (phone, tablet, browser, IoT device) that wants to join the Aurora network. Acts as the pairing initiator. |
| **Admin User** | An already-authenticated human who approves or rejects pairing requests. Must hold the `auth.approve` permission. |
| **Aurora Gateway** | The server-side FastAPI application that brokers pairing, issues tokens, and enforces access control. |
| **WebRTC Peer** | A device connected via WebRTC DataChannel for real-time, peer-to-peer communication with Aurora services. |
| **RTCClient** | The server-side WebRTC manager that handles peer connections, authentication, and RPC dispatch. |

| Term | Definition |
|---|---|
| **Principal** | A `User` record in the database. Represents any authenticated entity (human or device). |
| **Device** | A `Device` record linked to a principal. Represents a physical or virtual device. |
| **Token** | A `Token` record with a SHA-256 hash. Used as a bearer credential for API/WebRTC auth. |
| **Permissions** | A list of strings on the `User` record (e.g., `["TTS.*", "STT.*", "chat.send"]`). |
| **Scopes** | A list of strings on the `Token` record that restrict the token's reach. |
| **Effective Permissions** | The resolved set: `intersection(user.permissions, token.scopes)`. |
| **Identity** | An in-memory dataclass that carries the resolved principal info + effective permissions for a single request or connection. |

---

## Data Model

```
┌────────────────────┐      1:N      ┌────────────────────┐
│       User         │──────────────▶│      Device        │
│ (Principal)        │               │                    │
├────────────────────┤               ├────────────────────┤
│ id (PK)            │               │ id (PK)            │
│ username           │               │ user_id (FK→User)  │
│ password_hash      │               │ name               │
│ permissions [JSON] │               │ public_key         │
│ is_admin           │               │ is_trusted         │
│ role               │               │ last_seen          │
│ created_at         │               │ created_at         │
└────────────────────┘               └────────────────────┘
        │                                     │
        │ 1:N                                 │ 1:N
        ▼                                     ▼
┌────────────────────────────────────────────────────────┐
│                       Token                            │
├────────────────────────────────────────────────────────┤
│ id (PK)                                                │
│ token_hash (SHA-256)                                   │
│ prefix (first 8 chars for display)                     │
│ user_id (FK→User) — ON DELETE CASCADE                  │
│ device_id (FK→Device) — ON DELETE CASCADE              │
│ scopes [JSON]                                          │
│ expires_at                                             │
│ created_at                                             │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                     Audit Log                          │
├────────────────────────────────────────────────────────┤
│ id (PK)                                                │
│ event (e.g., "pairing.started", "login.success")       │
│ principal_id (nullable)                                │
│ details [JSON]                                         │
│ ip_address                                             │
│ created_at                                             │
└────────────────────────────────────────────────────────┘
```

**Key constraints:**
- `PRAGMA foreign_keys = ON` is enforced on every DB connection.
- Deleting a `User` cascades to all their `Device` and `Token` records.
- Deleting a `Device` cascades to all its `Token` records.

---

## Pairing Flow (Step-by-Step)

The pairing process is a **4-phase handshake** between the new device, the Gateway, and an admin user.

### Phase 1: Initiation (Device → Gateway)

**Endpoint:** `POST /api/auth/pairing/start` *(no auth required — bypass path)*

The new device sends its name to the Gateway to begin pairing.

```json
// Request
{ "device_name": "John's iPhone" }

// Response (200)
{ "code": "482937", "expires_in_seconds": 300 }
```

**What happens server-side:**
1. **Rate limiting** — max 5 attempts per client IP. Returns `429` if exceeded.
2. A random 6-digit pairing code is generated.
3. A pairing request object is created in memory:
   ```python
   {
       "id": "<uuid>",
       "device_name": "John's iPhone",
       "client_ip": "192.168.1.42",
       "status": "pending",            # Waiting for admin approval
       "expires_at": <now + 5 min>,
       "approved_by": None,
   }
   ```
4. **Audit event:** `pairing.started` with device name and IP.

**Device action:** Display the 6-digit code to the user and begin polling.

---

### Phase 2: Polling (Device → Gateway)

**Endpoint:** `GET /api/auth/pairing/connect/{pairing_code}` *(no auth required — bypass path)*

The device polls this endpoint to check whether the admin has approved the request.

```json
// Response while pending (200)
{ "request_id": "<uuid>", "device_name": "John's iPhone", "status": "pending" }

// Response after approval (200)
{ "request_id": "<uuid>", "device_name": "John's iPhone", "status": "approved" }

// Response if expired or invalid (404)
{ "error": "Pairing code not found or expired" }
```

**What happens server-side:**
1. Looks up the pairing code in the in-memory store.
2. Checks expiration (5-minute TTL).
3. Returns current status.

**Device action:** Poll every 2-5 seconds until `status` becomes `"approved"`, then proceed to exchange.

---

### Phase 3: Approval (Admin → Gateway)

**Endpoint:** `POST /api/auth/pairing/approve` *(requires auth + `auth.approve` permission)*

The admin (on a separate already-authenticated session — e.g., web dashboard or CLI) reads the 6-digit code displayed on the new device and approves it with optional permission restrictions.

```json
// Request
{
    "code": "482937",
    "permissions": ["TTS.*", "STT.*", "chat.send"],  // Optional — defaults to config
    "is_admin": false                                  // Optional — defaults to false
}

// Response (200)
{ "success": true }
```

**What happens server-side:**
1. Validates the admin's identity and `auth.approve` permission.
2. Looks up the pairing code; returns `404` if not found or expired.
3. Updates the pairing request:
   ```python
   request["status"] = "approved"
   request["approved_by"] = "<admin_user_id>"
   request["granted_permissions"] = permissions or config_defaults
   request["granted_is_admin"] = is_admin
   ```
4. **Permission fallback:** If `permissions` is `None` (not provided), the system uses `_default_device_permissions` from the Gateway config. If `permissions` is `[]` (explicitly empty), the device gets zero permissions.
5. **Audit event:** `pairing.approved` with the approving admin's ID, granted permissions, and admin flag.

**Admin action:** Enter the code displayed on the device, optionally customize permissions, and click approve.

---

### Phase 4: Exchange (Device → Gateway)

**Endpoint:** `POST /api/auth/pairing/exchange` *(no auth required — bypass path)*

Once the device detects `status: "approved"`, it exchanges the code for a permanent token.

```json
// Request
{ "code": "482937" }

// Response (200)
{
    "token": "aB3x...long_base64_token...Qz9",
    "device_id": "<uuid>",
    "user_id": "<uuid>",
    "permissions": ["TTS.*", "STT.*", "chat.send"]
}
```

**What happens server-side (this is the most complex step):**

1. **Validates** the code exists, is approved, and hasn't expired.

2. **Creates a device-principal** — a `User` record representing the device:
   ```
   User {
       id: <uuid>,
       username: "device_John's iPhone_a3f1c2",
       password_hash: "DEVICE_NO_PASSWORD",
       role: "device" (or "admin" if granted),
       permissions: ["TTS.*", "STT.*", "chat.send"],
       is_admin: false,
   }
   ```

3. **Creates a device record** linked to the principal:
   ```
   Device {
       id: <uuid>,
       user_id: <above user id>,
       name: "John's iPhone",
       is_trusted: true,
   }
   ```

4. **Creates a scoped token** (valid 1 year):
   ```
   Token {
       id: <uuid>,
       token_hash: SHA-256(raw_token),
       prefix: <first 8 chars>,
       device_id: <device id>,
       user_id: <user id>,
       scopes: ["TTS.*", "STT.*", "chat.send"],  // Matches granted permissions
       expires_at: <now + 365 days>,
   }
   ```
   - **Admin devices** get `scopes: ["*"]` (full access).
   - **Non-admin devices** get `scopes` = exactly the granted permissions.

5. **Cleanup:** Removes the pairing request from memory and resets the IP rate limit counter.

6. **Audit event:** `pairing.exchanged` with the new device_id and user_id.

**Device action:** Securely store the token, device_id, and user_id. Use the token for all future API calls.

---

## Authentication After Pairing

Once paired, the device authenticates using its bearer token in one of two ways:

### HTTP API Authentication

Include the token in the `Authorization` header:

```
GET /api/services
Authorization: Bearer aB3x...long_base64_token...Qz9
```

**Server-side flow:**
1. `GatewayAuth` middleware intercepts the request.
2. `should_bypass()` checks if the path is exempt (public endpoints).
3. Token is hashed with SHA-256 and looked up in the database.
4. Expiration is checked — expired tokens are auto-revoked.
5. `build_identity_from_token()` loads the associated `User` and resolves effective permissions.
6. The `Identity` object is attached to `request.state.identity`.
7. The `check_auth_enabled` FastAPI Security dependency reads the `Identity` and checks any required scopes for the endpoint.

### WebRTC Peer Authentication

For real-time connections, the device connects via WebRTC and authenticates over the DataChannel:

```
Device ──[WebRTC offer/answer]──► Aurora RTCClient
Device ──[DataChannel open]────► Aurora RTCClient
Device ──[auth message]────────► Aurora RTCClient
         { "type": "auth", "token": "aB3x..." }
```

**Server-side flow:**
1. `RTCClient._ensure_pc()` creates the peer connection and sets `ANONYMOUS` identity.
2. An **auth timeout task** is started (default: 10 seconds).
3. On receiving `{"type": "auth", "token": "..."}`:
   - Token is validated via `AuthService.authenticate_token()`.
   - `build_identity_from_token()` resolves the full `Identity`.
   - The `Identity` is stored in `_peer_acl[peer_id]`.
   - The `Token` object is stored in `_peer_tokens[peer_id]` (for later re-resolution).
   - The auth timeout task is **cancelled**.
   - **Audit:** `peer.authenticated`.
4. If auth fails: `ANONYMOUS` identity stays, DataChannel is closed.
5. If auth times out: peer is disconnected, **audit:** `peer.auth_timeout`.

---

## Permission Resolution

Permission resolution is the core algorithm that determines what a principal can actually do. It follows a strict **intersection model**.

### Algorithm

```
Input:
  user_permissions = ["TTS.*", "STT.*", "chat.send"]   (from User record)
  user_is_admin    = false
  token_scopes     = ["TTS.*", "chat.send"]             (from Token record)

Step 1: Admin shortcut
  If user_is_admin → effective = {"*"} → DONE

Step 2: Full-access token
  If "*" or "all" in token_scopes → effective = user_permissions → DONE

Step 3: Wildcard intersection
  For each scope in token_scopes:
    If scope is covered by user_perms → include scope
    If scope is a wildcard → pick user_perms that fall under it

Output:
  effective_perms = {"TTS.*", "chat.send"}
```

### Wildcard Matching Rules

| Pattern | Matches | Does NOT Match |
|---|---|---|
| `"*"` | Everything | — |
| `"TTS.*"` | `"TTS.Request"`, `"TTS.Stop"` | `"STT.Start"`, `"TTS"` |
| `"device.status.*"` | `"device.status.get"`, `"device.status.set"` | `"device.control"` |
| `"chat.send"` | `"chat.send"` (exact only) | `"chat.send.bulk"` |

### Identity Object

The resolved identity carries everything needed for access decisions:

```python
Identity(
    principal_id   = "user-abc-123",
    principal_name = "device_John's iPhone_a3f1c2",
    is_admin       = False,
    permissions    = frozenset({"TTS.*", "STT.*", "chat.send"}),  # User-level
    effective_perms = frozenset({"TTS.*", "chat.send"}),           # After intersection
    device_id      = "device-xyz-789",
    source         = "http_bearer",  # or "webrtc_peer"
)
```

---

## Resource Access Patterns

### Pattern 1: HTTP REST API

```
Device                           Gateway
  │                                │
  │  GET /api/services/TTS/Say     │
  │  Authorization: Bearer <token> │
  │ ──────────────────────────────►│
  │                                │ 1. Middleware resolves Identity
  │                                │ 2. Endpoint checks scopes: ["TTS.Say"]
  │                                │ 3. identity.can("TTS.Say") → True
  │                                │ 4. Route generator forwards to bus
  │                                │ 5. TTSService handles request
  │  200 OK { result: ... }        │
  │ ◄──────────────────────────────│
```

**Access check:** The `RouteGenerator` decorates each dynamic route with a `Security(check_auth_enabled, scopes=[...])` dependency that maps the contract's `required_perms` to FastAPI security scopes.

### Pattern 2: WebRTC RPC

```
Device                           RTCClient                     Bus
  │                                │                            │
  │  DataChannel message:          │                            │
  │  {"type":"call",               │                            │
  │   "method":"TTS.Say",          │                            │
  │   "params":{...},              │                            │
  │   "id":"req1"}                 │                            │
  │ ──────────────────────────────►│                            │
  │                                │ 1. RPCHandler receives     │
  │                                │ 2. Looks up method meta    │
  │                                │ 3. Gets Identity from ACL  │
  │                                │ 4. identity.can("TTS.Say") │
  │                                │ 5. Forwards to bus ───────►│
  │                                │                            │ TTSService
  │                                │ 6. Gets response ◄────────│
  │  {"type":"result",             │                            │
  │   "id":"req1",                 │                            │
  │   "result":{...}}              │                            │
  │ ◄──────────────────────────────│                            │
```

**Access check:** `RPCHandler._handle_call()` reads `meta.required_perms` from the contract registry and calls `identity.can(*perms_needed)`. Denied calls produce `{"type":"error", "error": {"code": 403, "message": "Forbidden"}}` and an audit event.

### Pattern 3: Streaming over WebRTC

For streaming responses (e.g., LLM output), the RPC handler sends chunked messages:

```
Device                           RTCClient
  │  {"type":"call", ...}          │
  │ ──────────────────────────────►│
  │                                │ (bus returns async iterator)
  │  {"type":"chunk", "data":...}  │
  │ ◄──────────────────────────────│
  │  {"type":"chunk", "data":...}  │
  │ ◄──────────────────────────────│
  │  {"type":"eof", "id":"req1"}   │
  │ ◄──────────────────────────────│
```

---

## WebRTC Peer Lifecycle

```
                      ┌──────────────┐
                      │   Unknown    │
                      │  (no peer)   │
                      └──────┬───────┘
                             │ Offer/Answer exchange via
                             │ MQTT signaling (AEAD-encrypted)
                             ▼
                      ┌──────────────┐
                      │  Connected   │     Identity = ANONYMOUS
                      │ (DataChannel │     Auth timeout started
                      │    open)     │     (10s default)
                      └──────┬───────┘
                             │
                    ┌────────┴────────┐
                    │                 │
             auth message        timeout (10s)
             received            │
                    │                 ▼
                    │         ┌──────────────┐
                    │         │ Disconnected │  Audit: peer.auth_timeout
                    │         │  (kicked)    │
                    │         └──────────────┘
                    ▼
            ┌───────────────┐
     ┌──────│  Validating   │──────┐
     │      │  (async)      │      │
     │      └───────────────┘      │
     │                             │
  token valid                 token invalid
     │                             │
     ▼                             ▼
┌──────────────┐           ┌──────────────┐
│ Authenticated│           │ Disconnected │  Audit: peer.auth_failed
│              │           │  (rejected)  │
│ Identity =   │           └──────────────┘
│ resolved     │
│ Token stored │
│ Timeout      │
│ cancelled    │
└──────┬───────┘
       │
       │ Can send RPC calls
       │ (permission-checked per call)
       │
       ├─── Re-auth message ──► Updates Identity & stored Token
       │
       ├─── Permission refresh ──► Re-resolves Identity from DB
       │    (admin API trigger)     using original token scopes
       │
       ├─── Connection state:
       │    "failed"/"closed"
       │
       ▼
┌──────────────┐
│ Disconnected │  Cleanup: ACL, tokens, timeout tasks
│  (normal)    │  Audit: peer.disconnected
└──────────────┘
```

### Cleanup on Disconnect

When a peer disconnects (or is force-disconnected), the following resources are cleaned up:
- `_pcs[peer_id]` — RTCPeerConnection closed and removed
- `_peer_acl[peer_id]` — Identity removed
- `_peer_tokens[peer_id]` — Stored Token reference removed
- `_peer_timeout_tasks[peer_id]` — Auth timeout task cancelled and removed

---

## Permission Updates & Re-resolution

Permissions can change after a device is paired. Aurora supports **live permission updates** for both HTTP and WebRTC connections.

### For HTTP Clients

No special handling needed. Each HTTP request re-resolves the `Identity` from the database (token → user → permissions → effective perms). Permission changes take effect on the next request.

### For WebRTC Peers

Since WebRTC peers maintain long-lived connections, an admin can trigger a **live permission refresh**:

**Endpoint:** `POST /api/admin/peers/{peer_id}/refresh-permissions`

**What happens:**
1. `RTCClient.update_peer_permissions()` is called.
2. The user record is **re-loaded from the database** (picks up permission changes).
3. The **original token scopes** (stored in `_peer_tokens[peer_id]`) are used for re-resolution — NOT the previously resolved effective permissions. This is critical because:
   - If an admin *expands* a user's permissions (e.g., adds `"DB.*"`), re-resolving with the original token scopes correctly picks up the expansion.
   - Using old effective permissions would incorrectly "freeze" the intersection.
4. A new `Identity` is built and stored in `_peer_acl[peer_id]`.

```
Admin                    Gateway                     RTCClient
  │                        │                            │
  │ POST /peers/X/refresh  │                            │
  │ ──────────────────────►│                            │
  │                        │ update_peer_permissions(X) │
  │                        │ ──────────────────────────►│
  │                        │                            │ 1. Load user from DB
  │                        │                            │ 2. Get original token.scopes
  │                        │                            │ 3. Re-resolve effective perms
  │                        │                            │ 4. Update _peer_acl[X]
  │  200 {"success": true} │                            │
  │ ◄──────────────────────│                            │
```

### Re-authentication

A connected WebRTC peer can also **re-authenticate** with a new token:

```json
// Device sends over DataChannel:
{ "type": "reauth", "token": "<new_token_string>" }
```

This validates the new token, rebuilds the `Identity`, and updates the stored token — useful when a device receives a refreshed token.

---

## Token Lifecycle

```
                      ┌──────────────┐
                      │   Created    │
                      │  (pairing    │
                      │   exchange   │
                      │   or admin)  │
                      └──────┬───────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Used for        Refreshed       Expires
         auth             │              │
              │              ▼              ▼
              │       ┌──────────────┐  ┌──────────┐
              │       │ Old revoked  │  │ Expired  │
              │       │ New issued   │  │ (auto-   │
              │       │ (same scopes)│  │  revoked │
              │       └──────────────┘  │  on use) │
              │                         └──────────┘
              │
              ├─── Scopes updated (admin) ───► Validated against user perms
              │
              ├─── Revoked (admin/logout) ──► Deleted from DB
              │
              └─── User/device deleted ─────► CASCADE deleted
```

### Token Scope Validation

When creating or updating token scopes, the system **validates that scopes don't exceed the principal's permissions**:

```
User permissions: ["TTS.*", "STT.*", "chat.send"]

✅ Token scopes: ["TTS.*"]              — subset, allowed
✅ Token scopes: ["TTS.Request"]         — covered by TTS.*, allowed
✅ Token scopes: ["*"]                   — intersection will limit anyway
❌ Token scopes: ["DB.Query"]            — not covered by user perms → 400 error
❌ Token scopes: ["TTS.*", "DB.Query"]   — DB.Query exceeds → 400 error
```

Admin users are exempt from this validation (they can create any scopes).

---

## Security Controls

| Control | Implementation |
|---|---|
| **Pairing rate limiting** | Max 5 attempts per IP. Resets on successful exchange. |
| **Login rate limiting** | Max 10 attempts per IP. Resets on successful login. |
| **Pairing code expiry** | 5-minute TTL for pairing codes. |
| **Token expiry** | Device tokens: 1 year. Session tokens: 1 day. |
| **Auth timeout** | WebRTC peers must authenticate within 10s (configurable). |
| **Token scope validation** | Token scopes ⊆ user permissions (enforced on create/update). |
| **AEAD encryption** | WebRTC signaling messages are AEAD-encrypted. |
| **App-layer E2EE** | Optional end-to-end encryption for DataChannel messages. |
| **Cascade deletion** | Deleting a user cascades to all devices and tokens via FK. |
| **Password hashing** | Argon2id via passlib. |
| **Precise path bypass** | Auth middleware uses exact + delimiter matching (no prefix false positives). |

---

## Audit Trail

Every significant action in the pairing and auth flow is recorded to the audit log:

| Event | When | Details |
|---|---|---|
| `pairing.started` | Device initiates pairing | device_name, IP |
| `pairing.approved` | Admin approves code | code, permissions, is_admin, admin ID |
| `pairing.exchanged` | Device exchanges code for token | device_id, user_id |
| `login.success` | User logs in | username, IP |
| `login.failure` | Login attempt fails | username, IP |
| `login.rate_limited` | Login rate limit hit | IP, username |
| `token.created` | New token issued | token_id, for_principal, scopes |
| `token.revoked` | Token revoked | token_id, reason |
| `token.scopes_updated` | Token scopes changed | token_id, new_scopes |
| `password.changed` | Password changed | principal_id |
| `peer.connected` | WebRTC peer connects | peer_id |
| `peer.authenticated` | Peer auth succeeds | peer_id, principal_name |
| `peer.auth_failed` | Peer auth fails | peer_id, token_prefix |
| `peer.auth_timeout` | Peer didn't auth in time | peer_id |
| `peer.disconnected` | Peer disconnects | peer_id, reason |
| `peer.force_disconnected` | Admin disconnects peer | peer_id, by_principal_id |
| `access.denied.auth` | HTTP auth fails | path, reason |
| `access.denied.permission` | Insufficient perms (HTTP) | path, required, effective |
| `access.denied.rpc` | Insufficient perms (WebRTC) | method, required, effective |

**Query the audit log:**
```
GET /api/admin/audit?event=pairing.started&limit=50
```

---

## Sequence Diagrams

### Complete Pairing + First Resource Access

```
New Device              Gateway                    Admin (Web UI)
    │                      │                           │
    │ ① POST /pairing/start│                           │
    │  {device_name}       │                           │
    │ ────────────────────►│                           │
    │                      │ Generate 6-digit code     │
    │                      │ Store pairing request     │
    │                      │ 🔒 Audit: pairing.started │
    │  {code: "482937"}    │                           │
    │ ◄────────────────────│                           │
    │                      │                           │
    │ Display "482937"     │                           │
    │ to user              │                           │
    │                      │                           │
    │ ② GET /pairing/connect/482937                    │
    │ ────────────────────►│                           │
    │  {status: "pending"} │                           │
    │ ◄────────────────────│                           │
    │                      │                           │
    │   ... polling ...    │    User reads code from   │
    │                      │    device screen           │
    │                      │                           │
    │                      │ ③ POST /pairing/approve   │
    │                      │   {code:"482937",         │
    │                      │    permissions:["TTS.*"]}  │
    │                      │ ◄─────────────────────────│
    │                      │ Validate admin identity    │
    │                      │ Check auth.approve perm    │
    │                      │ Mark request approved      │
    │                      │ 🔒 Audit: pairing.approved │
    │                      │  {success: true}           │
    │                      │ ─────────────────────────►│
    │                      │                           │
    │ ② GET /pairing/connect/482937 (poll again)       │
    │ ────────────────────►│                           │
    │ {status: "approved"} │                           │
    │ ◄────────────────────│                           │
    │                      │                           │
    │ ④ POST /pairing/exchange                         │
    │  {code: "482937"}    │                           │
    │ ────────────────────►│                           │
    │                      │ Create User (device principal)
    │                      │ Create Device record       │
    │                      │ Create Token (scoped)      │
    │                      │ Cleanup pairing request    │
    │                      │ 🔒 Audit: pairing.exchanged│
    │ {token, device_id,   │                           │
    │  user_id, perms}     │                           │
    │ ◄────────────────────│                           │
    │                      │                           │
    │ Store token securely │                           │
    │                      │                           │
    │ ⑤ GET /api/services/TTS/Say                      │
    │   Authorization: Bearer <token>                  │
    │ ────────────────────►│                           │
    │                      │ Middleware: resolve Identity
    │                      │ Check: identity.can("TTS.Say")
    │                      │ Forward to bus → TTSService
    │  200 OK              │                           │
    │ ◄────────────────────│                           │
```

### WebRTC Peer Connection + RPC

```
Paired Device            MQTT Broker              RTCClient (Gateway)
    │                        │                         │
    │ Presence announcement  │                         │
    │ ──────────────────────►│ ────────────────────────►│
    │                        │                         │
    │ ← Offer (AEAD encrypted)                        │
    │ ◄─────────────────────────────────────────────────│
    │                        │                         │ _ensure_pc():
    │                        │                         │   Create PC
    │                        │                         │   Set ANONYMOUS
    │                        │                         │   Start auth timeout
    │ Answer (AEAD encrypted)│                         │
    │ ──────────────────────────────────────────────────►│
    │                        │                         │
    │ ICE candidates ◄──────────────────────────────────►│
    │                        │                         │
    │     === DataChannel opens ===                    │
    │                        │                         │
    │ Gateway sends its auth │                         │
    │ ◄───────────────────── (DataChannel) ────────────│
    │ {"type":"auth",        │                         │
    │  "token":"GATEWAY_INTERNAL_TOKEN"}               │
    │                        │                         │
    │ Device sends its auth  │                         │
    │ ───────────────────── (DataChannel) ────────────►│
    │ {"type":"auth",        │                         │ validate_peer():
    │  "token":"<device_token>"}                       │   Authenticate token
    │                        │                         │   Build Identity
    │                        │                         │   Store in _peer_acl
    │                        │                         │   Store Token in _peer_tokens
    │                        │                         │   Cancel timeout
    │                        │                         │   🔒 Audit: peer.authenticated
    │                        │                         │
    │ RPC call               │                         │
    │ {"type":"call",        │                         │
    │  "method":"TTS.Say",   │                         │
    │  "params":{...}}       │                         │
    │ ───────────────────── (DataChannel) ────────────►│
    │                        │                         │ RPCHandler:
    │                        │                         │   Lookup method
    │                        │                         │   Check perms
    │                        │                         │   Forward to bus
    │                        │                         │
    │ {"type":"result",      │                         │
    │  "result":{...}}       │                         │
    │ ◄───────────────────── (DataChannel) ────────────│
```

---

## Configuration

### Gateway Config (config.json)

```json
{
    "gateway": {
        "api": {
            "enabled": true,
            "host": "0.0.0.0",
            "port": 8000,
            "auth_enabled": true,
            "api_keys": ["your-api-key-here"]
        },
        "webrtc": {
            "enabled": true,
            "strategy": "mqtt",
            "app_id": "aurora",
            "room": "default",
            "password": "shared-room-secret",
            "enable_app_layer_e2ee": false,
            "stun_servers": ["stun:stun.l.google.com:19302"]
        },
        "signaling_mqtt": {
            "brokers": ["wss://broker.emqx.io:8084/mqtt"],
            "username": null,
            "password": null
        },
        "permissions": {
            "default_device_permissions": ["TTS.*", "STT.*", "chat.send"],
            "webrtc_auth_timeout_seconds": 10.0
        }
    }
}
```

### Key Configuration Points

| Setting | Effect |
|---|---|
| `api.auth_enabled` | Master switch for authentication. When `false`, all endpoints get `SYSTEM` identity. |
| `api.api_keys` | Static API keys that grant `SYSTEM` access (useful for internal tools). |
| `permissions.default_device_permissions` | Default permissions assigned to devices when admin doesn't specify custom ones during pairing. |
| `permissions.webrtc_auth_timeout_seconds` | How long a WebRTC peer has to authenticate before being disconnected. |
| `webrtc.password` | Shared secret used to derive AEAD keys for signaling encryption. |
| `webrtc.enable_app_layer_e2ee` | When `true`, DataChannel messages are additionally encrypted with AEAD. |

---

## Summary

The peer pairing system in Aurora provides a **secure, auditable, and permission-granular** way to onboard new devices:

1. **Pairing** is a 4-step code-based handshake: start → poll → approve → exchange.
2. **Authentication** uses bearer tokens (HTTP) or DataChannel auth messages (WebRTC).
3. **Authorization** uses a wildcard-aware intersection of user permissions and token scopes.
4. **Live updates** are supported for WebRTC peers via admin-triggered permission refresh.
5. **Every action** is recorded in the audit log for security compliance.
6. **All secrets** (tokens, passwords) are hashed/encrypted — raw values are never stored.

---

## P2P Mesh Networking

After a peer has been authenticated and established a DataChannel connection (as described above), Aurora can optionally enable **mesh networking** to share services across peers.

### Overview

The mesh layer extends the peer lifecycle with a **manifest negotiation** protocol. After mutual authentication, each peer advertises which services it is willing to share, and the other side acknowledges which of those services it finds compatible and wants to use.

This allows multiple Aurora instances (or compatible clients) to form a dynamic mesh where service calls are transparently routed to local or remote providers based on configuration, availability, and latency.

### Mesh Peer Lifecycle (Extended)

```
┌────────────┐     ┌──────────────┐     ┌────────────┐     ┌──────────────┐
│  Connected │────►│ Authenticated│────►│ Negotiated │────►│    Stale      │
│ (WebRTC)   │     │ (token OK)   │     │ (manifests │     │ (no pong for │
│            │     │              │     │  exchanged) │     │  timeout_s)  │
└────────────┘     └──────────────┘     └────────────┘     └──────────────┘
                          │                    ▲                    │
                          │                    │ pong received      │
                          ▼                    └───────────────────-┘
                   Register in PeerRegistry
                   Send manifest ──►
                   ◄── Receive manifest
                   ◄── Receive manifest ACK
                   Send manifest ACK ──►
                   Begin ping/pong loop
```

### Manifest Exchange Protocol

After successful authentication, the following messages are exchanged over the DataChannel:

| Message Type | Direction | Purpose |
|---|---|---|
| `manifest` | Bidirectional | Advertises shared services with version and capability info |
| `manifest_ack` | Bidirectional | Reports compatibility of received manifest services |
| `manifest_request` | Either peer | Request the other peer to re-send their manifest |
| `ping` | Either peer | Latency measurement (sends monotonic timestamp) |
| `pong` | Either peer | Latency measurement response (echoes ping ID) |
| `capacity_update` | Either peer | Notifies peer of a change in available capacity |
| `call` | Either peer | JSON-RPC call to a shared service on the remote peer |
| `result` | Either peer | Successful response to a remote `call` |
| `error` | Either peer | Error response to a remote `call` |

### Manifest Structure

```json
{
  "type": "manifest",
  "peer_id": "abc123",
  "node_name": "aurora-desktop",
  "aurora_version": "1.0.0",
  "shared_services": [
    {
      "module": "TTS",
      "version": "1.0.0",
      "capabilities": ["streaming", "multilingual"],
      "methods": [
        {
          "name": "Request",
          "summary": "Request TTS synthesis",
          "bus_topic": "TTS.Request",
          "exposure": "both",
          "required_perms": ["TTS.*"],
          "input_model": "TTSRequest",
          "output_model": "TTSResponse"
        }
      ],
      "max_concurrent": 5,
      "digest": "sha256..."
    }
  ],
  "timestamp": "2026-01-15T10:30:00+00:00"
}
```

### Mesh Routing

Once manifests are exchanged, the **MeshBus** transparently routes messages:

- **Events** (`event=True`): Always delivered locally (broadcasts).
- **Commands/Requests** (`event=False`): Routed based on per-module `routing` config:
  - `local_only` / `local`: Always deliver locally.
  - `network`: Prefer remote peer, fall back based on `fallback` config.
  - `network_only`: Remote peer only, fail if unavailable.

Peer selection among multiple providers uses the configured `peer_selection` strategy:
- `lowest_latency`: Pick the peer with the lowest measured RTT.
- `round_robin`: Rotate among available peers.
- `random`: Random selection.

### Security Controls

- **Sharing gate**: Remote peers can only call services explicitly marked `share: true`.
- **Allowed peers**: Each shared service can restrict which peer IDs may call it via `allowed_peers`.
- **Capacity limits**: Each shared service specifies `max_concurrent`; calls beyond that limit get HTTP 429.
- **Permission checks**: Standard RBAC permission checks apply to all inbound RPC calls.
- **Version compatibility**: Configurable version matching policies (`exact`, `compatible`, `any`).

### Mesh Configuration

```json
{
  "gateway": {
    "mesh": {
      "enabled": true,
      "node_name": "aurora-desktop",
      "sharing": {
        "TTS": { "share": true, "max_concurrent": 5, "allowed_peers": null },
        "Orchestrator": { "share": true, "max_concurrent": 2 }
      },
      "routing": {
        "TTS": { "prefer": "network", "fallback": "local", "min_version": "1.0.0" },
        "STT": { "prefer": "local_only" }
      },
      "version_policy": "compatible",
      "peer_selection": "lowest_latency",
      "ping_interval_s": 30.0,
      "stale_peer_timeout_s": 120.0,
      "remote_timeout_s": 30.0
    }
  }
}
```

### Key Mesh Components

| Component | Location | Purpose |
|---|---|---|
| **PeerRegistry** | `app/services/gateway/mesh/peer_registry.py` | Tracks connected peers, manifests, latency, stale detection |
| **RoutingTable** | `app/services/gateway/mesh/routing_table.py` | Resolves bus topics to local/remote targets |
| **PeerBridge** | `app/services/gateway/mesh/peer_bridge.py` | Sends outbound RPC calls via DataChannels |
| **MeshBus** | `app/messaging/mesh_bus.py` | Transparent routing wrapper around the inner bus |
| **LatencyMonitor** | `app/services/gateway/mesh/latency.py` | Periodic ping/pong RTT measurement |
| **Negotiation** | `app/services/gateway/mesh/negotiation.py` | Manifest generation, parsing, ACK logic |
| **VersionCompat** | `app/services/gateway/mesh/version_compat.py` | Semantic version comparison |
