# Peer Pairing & Resource Access — Complete Flow

> This document describes the full lifecycle of peer pairing in Aurora: how a new device becomes a trusted peer, how it authenticates, how permissions are resolved, and how it accesses Aurora services through both the HTTP API and WebRTC DataChannels.

---

## Table of Contents

1. [Overview](#overview)
2. [Actors & Terminology](#actors--terminology)
3. [Data Model](#data-model)
4. [Pairing Flow (Step-by-Step)](#pairing-flow-step-by-step)
5. [Bilateral Mesh Pairing](#bilateral-mesh-pairing)
6. [Consolidated Trust Stores](#consolidated-trust-stores)
7. [Authentication After Pairing](#authentication-after-pairing)
8. [Permission Resolution](#permission-resolution)
9. [Resource Access Patterns](#resource-access-patterns)
10. [WebRTC Peer Lifecycle](#webrtc-peer-lifecycle)
11. [Permission Updates & Re-resolution](#permission-updates--re-resolution)
12. [Token Lifecycle](#token-lifecycle)
13. [Security Controls](#security-controls)
14. [Audit Trail](#audit-trail)
15. [Sequence Diagrams](#sequence-diagrams)
16. [Configuration](#configuration)
17. [P2P Mesh Networking](#p2p-mesh-networking)

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

### Mesh Peer Tables

The mesh layer adds two additional tables that track this instance's stable identity and all known remote peers. These tables form a **bidirectional link** to the auth tables above via outbound foreign keys.

```
┌─────────────────────────────────────────────────────────────────┐
│                      mesh_identity                              │
│ (Singleton — this instance's stable identity)                   │
├─────────────────────────────────────────────────────────────────┤
│ key TEXT PRIMARY KEY DEFAULT 'self'                              │
│ peer_id TEXT NOT NULL              -- Our stable UUID            │
│ node_name TEXT DEFAULT ''          -- Human-readable name        │
│ created_at TIMESTAMP                                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                       mesh_peers                                │
│ (One row per known remote peer — bilateral relationship state)  │
├─────────────────────────────────────────────────────────────────┤
│ id TEXT PRIMARY KEY                                             │
│ peer_id TEXT NOT NULL              -- Remote peer's stable UUID  │
│ node_name TEXT DEFAULT ''          -- Remote peer's human name   │
│ room_name TEXT NOT NULL                                          │
│                                                                 │
│ ── OUTBOUND: what WE granted to THEM ──                         │
│ outbound_status TEXT DEFAULT 'pending'  -- pending|approved|denied│
│ outbound_permissions TEXT DEFAULT '[]'  -- JSON permission array │
│ outbound_token_id TEXT             -- FK → tokens.id (we issued) │
│ outbound_device_id TEXT            -- FK → devices.id            │
│ outbound_user_id TEXT              -- FK → users.id              │
│ outbound_approved_at TIMESTAMP                                  │
│ outbound_approved_by TEXT                                        │
│                                                                 │
│ ── INBOUND: what THEY granted to US ──                          │
│ inbound_status TEXT DEFAULT 'pending'                            │
│ inbound_token TEXT                 -- Raw token they issued to us│
│ inbound_permissions TEXT DEFAULT '[]'                            │
│ inbound_device_id TEXT             -- Device ID they assigned us │
│ inbound_user_id TEXT               -- User ID they assigned us   │
│                                                                 │
│ ── Connection tracking ──                                       │
│ connection_status TEXT DEFAULT 'never_connected'                 │
│ first_seen_at TIMESTAMP                                         │
│ last_seen_at TIMESTAMP                                          │
│ updated_at TIMESTAMP                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Key design principles:**
- **All mesh state is in DB, never in `config.json`.** Config only stores operator preferences (routing, sharing).
- **Outbound FKs** (`outbound_token_id`, `outbound_device_id`, `outbound_user_id`) link `mesh_peers` back to the auth tables. When a mesh peer is approved and a pairing exchange completes, these FKs are written so that permission changes in `mesh_peers` can be synced to the corresponding `User` and `Token` records.
- **Peer records never expire.** Even if a pairing code times out, the `mesh_peers` row persists with `outbound_status = 'pending'`. An admin can always approve later via the Peer Management API.
- **`mesh_identity`** ensures a stable `peer_id` across restarts, preventing tie-breaker instability.

### Stable Identity vs Signaling Session IDs

WebRTC signaling peers also have a per-session MQTT/WebRTC identifier used for
presence, SDP, ICE, and DataChannel transport addressing. That value is allowed
to change on reconnect and is not a trust or policy identity. Mesh manifests,
`mesh_peers` rows, saved inbound credentials, peer permissions, and diagnostics
use the stable `mesh_identity.peer_id` instead. `RTCClient` keeps a runtime
mapping from active signaling session ID to stable peer ID so routed mesh calls
can use stable peer IDs while DataChannel sends still target the live session.

---

## Auth and Config Mesh Exposure Boundaries

Auth and Config are not ordinary transparent mesh providers. Gateway does not wire
`services.auth` or `services.config` into `gateway.mesh.services`, and the config
schema intentionally does not expose `services.auth.mesh_sharing` or
`services.config.mesh_sharing`.

Exposure categories:

| Category | Methods / data | Mesh behavior |
|----------|----------------|---------------|
| Pairing/login infrastructure | `Auth.PairingStart`, `Auth.PairingConnect`, `Auth.PairingExchange`, `Auth.Login` | Allowed through the WebRTC RPC infrastructure bypass so unauthenticated peers can pair or authenticate. |
| Local peer administration | Auth mesh peer list/get/approve/deny/update/remove contracts | Local admin surface with normal permissions; not advertised as a shareable mesh provider by default. |
| Broad Auth administration | Principals, tokens, permissions, devices, audit log, password changes | Not transparently routed by default. |
| Config diagnostics and mutation | Config get/validate/plugin reads, Config set/plugin writes | Not transparently routed by default. |
| Secrets and credentials | API keys, token hashes, inbound mesh tokens, raw credential material | Never shared as mesh data or ordinary RPC payloads. |

If a future remote-admin policy intentionally exposes any Auth or Config surface,
it must be explicit, peer-scoped, permission-checked, and audited. A generic
service-sharing toggle is not enough to make Auth or Config safe to route.

---

## Pairing Flow (Step-by-Step)

The pairing process is a **4-phase handshake** between the new device, the Gateway, and an admin user.

### Phase 1: Initiation (Device → Gateway)

**Endpoint:** `POST /api/auth/pairing/start` *(no auth required — bypass path)*

The new device sends its name to the Gateway to begin pairing. When the request comes from a mesh peer (via WebRTC RPC), additional fields identify the remote peer.

```json
// Request (basic — from HTTP client)
{ "device_name": "John's iPhone" }

// Request (mesh peer — from WebRTC DataChannel RPC)
{
    "device_name": "John's iPhone",
    "remote_peer_id": "a1b2c3d4-...",   // Stable UUID of the requesting peer
    "remote_node_name": "living-room"     // Human-readable peer name
}

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
       "remote_peer_id": "a1b2c3d4-...",    # Empty string if not a mesh peer
       "remote_node_name": "living-room",    # Empty string if not a mesh peer
   }
   ```
4. **Bus event:** `Auth.PairingRequested` is published with `PairingRequestedEvent` payload so the UI and mesh subsystem can react (e.g., display a notification to the admin).
5. **Audit event:** `pairing.started` with device name and IP.

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
5. **Mesh peer sync:** If the pairing request has a `remote_peer_id` (i.e., it came from a mesh peer), the system also updates the `mesh_peers` table — setting `outbound_status = 'approved'` and `outbound_permissions` to the granted permissions. This ensures the mesh peer table stays in sync with the pairing approval.
6. **Audit event:** `pairing.approved` with the approving admin's ID, granted permissions, and admin flag.

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
    "permissions": ["TTS.*", "STT.*", "chat.send"],
    "token_id": "<uuid>"
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

5. **Outbound FK linking (mesh peers):** If the pairing request has a `remote_peer_id`, the system writes the outbound foreign keys to `mesh_peers`:
   ```sql
   UPDATE mesh_peers SET
       outbound_token_id = <token.id>,
       outbound_device_id = <device.id>,
       outbound_user_id = <user.id>
   WHERE peer_id = <remote_peer_id>
   ```
   These FKs create a bidirectional link between the `mesh_peers` table and the auth tables (`users`, `devices`, `tokens`). This enables permission sync: when mesh peer permissions are updated later, the corresponding `User.permissions` and `Token.scopes` are also updated.

6. **Cleanup:** Removes the pairing request from memory and resets the IP rate limit counter.

7. **Audit event:** `pairing.exchanged` with the new device_id, user_id, and token_id.

**Device action:** Securely store the token, device_id, user_id, and token_id. Use the token for all future API calls.

---

## Bilateral Mesh Pairing

When two Aurora instances connect via WebRTC, the standard 4-phase pairing flow described above is executed **twice** — once in each direction. This creates a **bilateral trust relationship** where each instance independently decides what permissions to grant the other.

### Why Bilateral?

In a standard device pairing, trust is **one-directional**: the device gets a token from Aurora. But in a peer-to-peer mesh, **each peer is an independent authority** over its own services:

- **Peer A** decides what Peer B can access on A's services (e.g., `TTS.*`, `STT.*`).
- **Peer B** independently decides what Peer A can access on B's services (e.g., `Orchestrator.*`).

These are two completely independent admin decisions, potentially with different permission sets.

### Two-Phase Flow

```
PHASE 1 — FORWARD PAIRING (Initiator requests access to Responder's services):

  Initiator (RTCClient)                 Responder (Auth Service)
  ─────────────────────                 ────────────────────────
  1. RPC: Auth.PairingStart
     {device_name, remote_peer_id,
      remote_node_name} ──────────────► 2. Creates code, status=pending
                                           Creates/updates mesh_peers row
                                           Publishes Auth.PairingRequested
                                        3. Responder admin approves with perms
  4. RPC: Auth.PairingConnect ────────► 5. Returns status=approved
  6. RPC: Auth.PairingExchange ───────► 7. Issues Token_A (carries P_resp)
                                           Links outbound FKs to mesh_peers
  8. Receives Token_A
     Saves inbound credential to DB
  9. Sends auth msg {token: Token_A} ─► 10. validate_peer() authenticates initiator
                                             Initiator now trusted with P_resp

PHASE 2 — REVERSE PAIRING (triggered by validate_peer):

  Responder (now initiating)            Initiator (Auth Service)
  ─────────────────────────             ────────────────────────
  11. _reverse_pairing() triggers
  12. RPC: Auth.PairingStart
      {device_name, remote_peer_id,
       remote_node_name} ─────────────► 13. Creates code, status=pending
                                            Publishes Auth.PairingRequested
                                        14. Initiator admin approves with perms
  15. RPC: Auth.PairingConnect ───────► 16. Returns status=approved
  17. RPC: Auth.PairingExchange ──────► 18. Issues Token_B (carries P_init)
                                            Links outbound FKs to mesh_peers
  19. Receives Token_B
      Saves inbound credential to DB
  20. Sends auth msg {token: Token_B} ─► 21. Responder now trusted with P_init

RESULT:
  • Initiator holds Token_A (issued by Responder, carries Responder-granted perms)
  • Responder holds Token_B (issued by Initiator, carries Initiator-granted perms)
  • Both tokens persisted in mesh_peers table → survive restart
  • Each admin independently chose what to share
  • Permission sets can be asymmetric
```

### How Phase 2 is Triggered

Phase 2 (`_reverse_pairing`) is automatically triggered inside `validate_peer()` when a remote peer authenticates to us:

1. Remote peer sends `{"type": "auth", "token": "..."}` over DataChannel.
2. `validate_peer()` validates the token, builds an `Identity`, and stores it in `_peer_acl`.
3. If mesh is enabled, the peer is registered in `PeerRegistry` and manifests are exchanged.
4. `_reverse_pairing(peer)` is called as an `asyncio.create_task()`.
5. `_reverse_pairing()` checks if we already have an auth token for that remote peer's stable `peer_id` (meaning we initiated the forward pairing with this same peer). If so, it skips — the reverse direction is not needed because we already hold a peer-specific token. Legacy/default tokens or tokens for other peers do not suppress reverse pairing for this peer.
6. If we don't have a token, it calls `_initiate_pairing(peer, chan)` which runs the standard 4-phase flow (PairingStart → PairingConnect → PairingExchange) on the **remote peer's** auth service via DataChannel RPC.

### Partial Completion

If only one phase completes (admin on one side didn't approve in time), the system degrades gracefully:

| Forward (Phase 1) | Reverse (Phase 2) | Result |
|:-:|:-:|---|
| ✅ Approved | ✅ Approved | Full bilateral mesh — both peers access each other's services |
| ✅ Approved | ❌ Pending/Denied | One-directional: Initiator can use Responder's services, but not vice versa |
| ❌ Denied | N/A | Pairing fails entirely — no trust established |

The `mesh_peers` row persists even when a phase is incomplete. The admin can always come back later and approve via the **Peer Management API** (`POST /mesh/peers/{peer_id}/approve`), at which point the next WebRTC reconnection will complete the missing phase.

---

## Consolidated Trust Stores

Aurora maintains **two trust stores** that are now bidirectionally synchronized:

1. **Auth tables** (`users`, `devices`, `tokens`) — The authoritative identity/credential store, used by the auth middleware for all permission checks.
2. **Mesh tables** (`mesh_peers`) — The peer relationship store, tracking bilateral pairing state, connection history, and the operator's intent for what each peer can do.

### Bidirectional Sync via Outbound FKs

When a mesh peer completes pairing (Phase 4: Exchange), the system writes **outbound foreign keys** to the `mesh_peers` row:

```
mesh_peers.outbound_token_id  →  tokens.id
mesh_peers.outbound_device_id →  devices.id
mesh_peers.outbound_user_id   →  users.id
```

These FKs create a bridge between the two stores, enabling:

### Approve Mesh Peer → Also Approves Pairing Code

`AuthManager.approve_mesh_peer(peer_id, permissions)` is the canonical admin action for the Peer Management API. It:

1. Sets `mesh_peers.outbound_status = 'approved'` with the specified permissions.
2. **Finds any pending pairing code** linked to this `peer_id` (via `remote_peer_id` in the in-memory pairing request) and approves it with the same permissions. This means admins can approve via the Peer Management API instead of (or in addition to) the `POST /auth/pairing/approve` endpoint.
3. **Syncs permissions to auth principal** — if outbound FKs exist (i.e., a prior exchange completed), updates `User.permissions` and `Token.scopes` for the corresponding auth records.

### Update Mesh Peer Permissions → Syncs to Auth

`AuthManager.update_mesh_peer_permissions(peer_id, permissions)` updates the mesh peer's `outbound_permissions` and — if outbound FKs exist — also updates the corresponding `User.permissions` and `Token.scopes`. This ensures permission changes made through the Peer Management API are immediately effective for auth checks.

### Flow Diagram

```
Admin updates permissions via Peer Management API
    │
    ▼
┌──────────────────────────────┐
│  mesh_peers table            │
│  outbound_permissions = [..] │
│  outbound_user_id = X ───────┼──► ┌─────────────────┐
│  outbound_token_id = Y ──────┼──► │ users table      │
│                              │    │ permissions = [..]│ ← synced
└──────────────────────────────┘    └─────────────────┘
                                    ┌─────────────────┐
                                    │ tokens table     │
                                    │ scopes = [..]    │ ← synced
                                    └─────────────────┘
```

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

**Server-side flow (auth enabled):**
1. `RTCClient._ensure_pc()` creates the peer connection and sets `ANONYMOUS` identity.
2. An **auth timeout task** is started (default: 10 seconds).
3. On DataChannel open, the Gateway sends its own auth token to the peer and extends the timeout for peers in active pairing flow (`webrtc_pairing_timeout_seconds`, default 300s).
4. **Auth gate enforcement**: All incoming DataChannel messages are checked. Only `auth` and `reauth` messages are allowed from `ANONYMOUS` peers — all other message types are silently dropped.
5. On receiving `{"type": "auth", "token": "..."}`:
   - Token is validated via `AuthService.authenticate_token()`.
   - `build_identity_from_token()` resolves the full `Identity`.
   - The `Identity` is stored in `_peer_acl[peer_id]`.
   - The `Token` object is stored in `_peer_tokens[peer_id]` (for later re-resolution).
   - The auth timeout task is **cancelled**.
   - **Audit:** `peer.authenticated`.
6. If auth fails: `ANONYMOUS` identity stays, DataChannel is closed.
7. If auth times out: peer is disconnected, **audit:** `peer.auth_timeout`.

**Server-side flow (auth disabled):**
1. `RTCClient._ensure_pc()` creates the peer connection.
2. On DataChannel open, the peer is immediately assigned the `OPEN_PEER` identity (full permissions, `source="open_network"`).
3. **No auth message is sent** to the peer — the connection is open by design.
4. The peer is immediately registered in the mesh (if mesh is enabled).
5. All DataChannel messages are processed normally (no auth gate).

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

### Auth Enabled Mode

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
                      │ (DataChannel │     Auth timeout started (10s default)
                      │    open)     │     Auth gate active: only auth/reauth
                      └──────┬───────┘     messages accepted
                             │
                    ┌────────┴────────┐
                    │                 │
             auth message        timeout expires
             received            (heartbeat loop
                    │             for pairing peers)
                    │                 │
                    │                 ▼
                    │         ┌──────────────┐
                    │         │ Disconnected │  Audit: peer.auth_timeout
                    │         │  (kicked)    │         or peer.pairing_timeout
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
│              │
│ If mesh:     │
│ → register   │
│   peer       │
│ → send       │
│   manifest   │
│ → trigger    │
│   reverse    │
│   pairing    │
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
│ Disconnected │  Cleanup: ACL, tokens, timeout tasks,
│  (normal)    │  data channels, peer names, pairing tasks
│              │  Audit: peer.disconnected
└──────────────┘
```

### Smart Auth Timeout (Heartbeat Loop)

The auth timeout uses a **heartbeat-style extension** for peers in an active pairing flow:

1. When a DataChannel opens, a timeout task starts with the **base auth timeout** (default 10s).
2. After the base timeout expires, if the peer is still `ANONYMOUS`:
   - **Not pairing** → disconnect immediately (`peer.auth_timeout` audit event).
   - **Pairing active** (`peer in _peer_pairing_active`) → enter heartbeat loop:
     - Check every 10 seconds whether the peer is still pairing.
     - If the peer authenticates during a heartbeat sleep, the loop exits gracefully.
     - If the total elapsed time exceeds `webrtc_pairing_timeout_seconds` (default 300s) and the peer is still `ANONYMOUS`, disconnect (`peer.pairing_timeout` audit event).
3. This approach avoids a single rigid timeout and instead gives the admin realistic time to approve while still enforcing an upper bound.

### Peer Identification in Logs

Peers are identified in log messages using a **human-readable label** via `_peer_label(peer)`:

```
# If peer has a known node_name:
"living-room (a1b2c3d4)"

# If node_name is unknown:
"a1b2c3d4…"
```

Node names are stored in `_peer_names` when received in `auth` messages (via the `peer_name` field) or from manifest exchanges.

### Auth Disabled Mode

When `api.auth_enabled` is `false`, the peer lifecycle is simplified:

```
                      ┌──────────────┐
                      │   Unknown    │
                      │  (no peer)   │
                      └──────┬───────┘
                             │ Offer/Answer exchange via
                             │ MQTT signaling
                             ▼
                      ┌──────────────┐
                      │  Connected   │     Identity = OPEN_PEER
                      │ (DataChannel │     (full permissions,
                      │    open)     │      source="open_network")
                      └──────┬───────┘     No auth gate, no timeout
                             │
                             │ Immediately registered in mesh
                             │ All messages processed normally
                             │
                             ├─── Connection state:
                             │    "failed"/"closed"
                             │
                             ▼
                      ┌──────────────┐
                      │ Disconnected │  Cleanup: ACL
                      │  (normal)    │
                      └──────────────┘
```

### DataChannel Auth Gate (Auth Enabled)

When authentication is enabled, the RTCClient enforces a strict **auth gate** on incoming DataChannel messages:

| Peer Identity | Message Type | Action |
|---|---|---|
| `ANONYMOUS` | `auth`, `reauth` | ✅ Processed (authentication flow) |
| `ANONYMOUS` | `call` (PairingStart, PairingConnect, PairingExchange, Login) | ✅ Processed (RPC allowlist) |
| `ANONYMOUS` | `call` (any other method) | ❌ Rejected with 401 error |
| `ANONYMOUS` | `event` | ❌ Silently dropped |
| `ANONYMOUS` | `manifest`, `ping`, `pong`, etc. | ❌ Silently dropped |
| Authenticated | Any | ✅ Processed normally |

### Pairing Over WebRTC DataChannel

Devices that connect via WebRTC can complete the pairing flow directly over the DataChannel using RPC calls, without needing the HTTP API. For mesh peers, `remote_peer_id` and `remote_node_name` are included to enable bilateral pairing and mesh_peers DB tracking.

```
New Device              RTCClient (Gateway)          Admin
    │                        │                         │
    │ DataChannel opens      │                         │
    │ ──────────────────────►│ Identity = ANONYMOUS    │
    │                        │ Heartbeat timeout starts │
    │                        │                         │
    │ RPC: Gateway.PairingStart                        │
    │ {"device_name":"Phone",│                         │
    │  "remote_peer_id":     │                         │
    │    "<stable_uuid>",    │                         │
    │  "remote_node_name":   │                         │
    │    "living-room"}      │                         │
    │ ──────────────────────►│                         │
    │                        │ Publish Auth.PairingRequested
    │                        │ Returns {code, expires}  │
    │ ◄──────────────────────│                         │
    │                        │                         │
    │ Display code to user   │     Admin approves code │
    │                        │     (or via Peer Mgmt API)
    │                        │                         │
    │ RPC: Gateway.PairingConnect                      │
    │ {"code":"482937"}      │                         │
    │ ──────────────────────►│ Returns {status}        │
    │ ◄──────────────────────│                         │
    │                        │                         │
    │ RPC: Gateway.PairingExchange                     │
    │ {"code":"482937"}      │                         │
    │ ──────────────────────►│                         │
    │                        │ Returns {token, ...,    │
    │                        │         token_id}       │
    │ ◄──────────────────────│                         │
    │                        │                         │
    │ auth message with token│                         │
    │ ──────────────────────►│ Authenticate + resolve  │
    │                        │ Identity = resolved      │
    │                        │ Trigger reverse pairing │
    │                        │ (if mesh enabled)        │
    │                        │                         │
```

### Cleanup on Disconnect

When a peer disconnects (or is force-disconnected), the following resources are cleaned up:
- `_pcs[peer_id]` — RTCPeerConnection closed and removed
- `_peer_acl[peer_id]` — Identity removed
- `_peer_tokens[peer_id]` — Stored Token reference removed
- `_peer_timeout_tasks[peer_id]` — Auth timeout task cancelled and removed
- `_peer_data_channels[peer_id]` — DataChannel reference removed
- `_peer_names[peer_id]` — Human-readable node name removed
- `_peer_send_fns[peer_id]` — Send function removed
- `_pairing_tasks[peer_id]` — Any in-flight pairing task cancelled
- `_peer_pairing_active` — Peer removed from pairing set

---

## Permission Updates & Re-resolution

Permissions can change after a device is paired. Aurora supports **live permission updates** for both HTTP and WebRTC connections, and **consolidated mesh permission sync**.

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

### For Mesh Peers (Consolidated Sync)

When permissions are updated through the **Peer Management API** (`POST /mesh/peers/{peer_id}/permissions`), the update propagates to both stores:

1. `mesh_peers.outbound_permissions` is updated in the database.
2. If outbound FKs exist (`outbound_user_id`, `outbound_token_id`):
   - `User.permissions` is updated to match the new permissions.
   - `Token.scopes` is updated (using `["*"]` if wildcard, otherwise the permission list).
3. This ensures that the next auth check (HTTP middleware or WebRTC RPC handler) sees the updated permissions immediately.

Similarly, `MeshApprovePeer` (used when approving a peer for the first time or re-approving a denied peer) syncs permissions to the auth principal if outbound FKs already exist from a prior exchange.

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
| **Pairing code expiry** | Configurable via `webrtc_pairing_timeout_seconds` (default 300s / 5 min). |
| **Token expiry** | Device tokens: 1 year. Session tokens: 1 day. |
| **Auth timeout** | WebRTC peers must authenticate within 10s (configurable via `webrtc_auth_timeout_seconds`). |
| **Smart pairing timeout** | Peers in active pairing get a heartbeat-loop extension up to `webrtc_pairing_timeout_seconds` (default 300s). Heartbeat checks every 10s. |
| **DataChannel auth gate** | All non-auth messages from `ANONYMOUS` peers are dropped. Only `auth` and `reauth` messages pass through. |
| **RPC anonymous allowlist** | Anonymous peers may only call pairing/login RPC methods (`PairingStart`, `PairingConnect`, `PairingExchange`, `Login`). All other RPC calls return 401. |
| **Anonymous event blocking** | Events from `ANONYMOUS` peers are silently dropped by RPCHandler. |
| **Bilateral pairing** | Mesh peers must complete a two-phase pairing (forward + reverse). Each admin independently grants permissions. Partial approval degrades gracefully. |
| **Consolidated trust sync** | Mesh peer permissions are synced to auth tables via outbound FKs. Updates through any admin interface (Peer Mgmt API or pairing approval) propagate to both stores. |
| **Persistent peer records** | Mesh peer records never expire. Admins can approve pending peers at any time. |
| **Stable peer identity** | `peer_id` is generated once and stored in `mesh_identity` DB table. Survives restarts, prevents tie-breaker instability. |
| **Token scope validation** | Token scopes ⊆ user permissions (enforced on create/update). |
| **AEAD-encrypted signaling** | WebRTC signaling/presence messages are AEAD-encrypted using room key derivatives when `encrypt_signaling` is enabled. |
| **Encrypted MQTT presence** | Room presence announcements are sealed with `aead_seal(k_sig, payload)`. Receivers fall back to plaintext if decryption fails (backward compatibility). |
| **App-layer E2EE** | Optional end-to-end encryption for DataChannel messages. |
| **Room auto-generation** | Empty or default room names and empty passwords are auto-generated on startup using `secrets.token_hex`/`secrets.token_urlsafe` and persisted to config. |
| **Public broker warning** | A warning is logged when auth is enabled but a public MQTT broker (e.g., `broker.emqx.io`) is configured. |
| **Password validation** | Empty passwords block startup when auth is enabled. A warning is logged when auth is disabled with empty password. |
| **Cascade deletion** | Deleting a user cascades to all devices and tokens via FK. |
| **Password hashing** | Argon2id via passlib. |
| **Precise path bypass** | Auth middleware uses exact + delimiter matching (no prefix false positives). |
| **Audit proxy** | `_AuditDBProxy.store_audit_event()` routes audit writes via the message bus to the Auth service, ensuring audit events work from the Gateway's auth proxy. |

---

## Audit Trail

Every significant action in the pairing and auth flow is recorded to the audit log:

| Event | When | Details |
|---|---|---|
| `pairing.started` | Device initiates pairing | device_name, IP |
| `pairing.requested` | PairingRequestedEvent published | code, remote_peer_id, remote_node_name, device_name, IP, expires_at |
| `pairing.approved` | Admin approves code | code, permissions, is_admin, admin ID |
| `pairing.exchanged` | Device exchanges code for token | device_id, user_id, token_id |
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
| `peer.pairing_timeout` | Pairing heartbeat loop expired | peer_id |
| `peer.disconnected` | Peer disconnects | peer_id, reason |
| `peer.force_disconnected` | Admin disconnects peer | peer_id, by_principal_id |
| `mesh.peer_approved` | Mesh peer approved via Peer Mgmt API | peer_id, permissions, approved_by |
| `mesh.peer_permissions_updated` | Mesh peer permissions changed | peer_id, new_permissions |
| `mesh.peer_removed` | Mesh peer removed | peer_id |
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
    │  {device_name,       │                           │
    │   remote_peer_id?,   │                           │
    │   remote_node_name?} │                           │
    │ ────────────────────►│                           │
    │                      │ Generate 6-digit code     │
    │                      │ Store pairing request     │
    │                      │ Publish Auth.PairingRequested
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
    │                      │ Sync to mesh_peers (if     │
    │                      │   remote_peer_id present)  │
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
    │                      │ Link outbound FKs to       │
    │                      │   mesh_peers (if mesh peer)│
    │                      │ Cleanup pairing request    │
    │                      │ 🔒 Audit: pairing.exchanged│
    │ {token, device_id,   │                           │
    │  user_id, perms,     │                           │
    │  token_id}           │                           │
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
    │ Answer (AEAD encrypted)│                         │     (heartbeat loop)
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
    │  "peer_name":"...",    │                         │   Authenticate token
    │  "token":"<device_token>"}                       │   Build Identity
    │                        │                         │   Store in _peer_acl
    │                        │                         │   Store Token in _peer_tokens
    │                        │                         │   Store name in _peer_names
    │                        │                         │   Cancel timeout
    │                        │                         │   🔒 Audit: peer.authenticated
    │                        │                         │   If mesh enabled:
    │                        │                         │     Register in PeerRegistry
    │                        │                         │     Send manifest
    │                        │                         │     Trigger _reverse_pairing()
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
| `api.auth_enabled` | Master switch for authentication. When `false`, all endpoints get `SYSTEM` identity; WebRTC peers get `OPEN_PEER` identity (full permissions). |
| `api.api_keys` | Static API keys that grant `SYSTEM` access (useful for internal tools). |
| `permissions.default_device_permissions` | Default permissions assigned to devices when admin doesn't specify custom ones during pairing. |
| `permissions.webrtc_auth_timeout_seconds` | How long a WebRTC peer has to authenticate before being disconnected (default: 10s). |
| `permissions.webrtc_pairing_timeout_seconds` | Extended timeout for peers in active pairing flow (default: 300s / 5 min). Range: 30–3600s. |
| `webrtc.room` | WebRTC room name. If set to `"default"` or empty, a random room name is auto-generated on startup and persisted to config. |
| `webrtc.password` | Shared secret used to derive AEAD keys for signaling encryption. If empty and auth is enabled, startup is blocked with an error. If empty and auth is disabled, a warning is logged. Auto-generated if empty on startup. |
| `webrtc.encrypt_signaling` | When `true`, MQTT presence announcements are AEAD-encrypted using room key derivatives. Receivers fall back to plaintext if decryption fails. |
| `webrtc.enable_app_layer_e2ee` | When `true`, all Aurora DataChannel JSON messages are additionally sealed with AEAD and sent as binary frames. Both peers must enable it and derive the same room data key; plaintext messages are dropped rather than downgraded. When `false`, DataChannel messages are JSON text protected by WebRTC DTLS. |

---

## Summary

The peer pairing system in Aurora provides a **secure, auditable, and permission-granular** way to onboard new devices and mesh peers:

1. **Pairing** is a 4-step code-based handshake: start → poll → approve → exchange.
2. **Bilateral mesh pairing** extends this to a 2-phase process (forward + reverse) for P2P mesh connections, each phase requiring independent admin approval.
3. **Authentication** uses bearer tokens (HTTP) or DataChannel auth messages (WebRTC).
4. **Authorization** uses a wildcard-aware intersection of user permissions and token scopes.
5. **Consolidated trust stores** — mesh_peers and auth tables (users/devices/tokens) are bidirectionally synced via outbound FKs. Permission changes through any admin interface propagate to both stores.
6. **Live updates** are supported for WebRTC peers via admin-triggered permission refresh and mesh peer management API.
7. **Every action** is recorded in the audit log for security compliance.
8. **All secrets** (tokens, passwords) are hashed/encrypted — raw values are never stored.
9. **All mesh state** is in the database, never in config files — peer records never expire.

---

## P2P Mesh Networking

After a peer has been authenticated and established a DataChannel connection (as described above), Aurora can optionally enable **mesh networking** to share services across peers.

### Overview

The mesh layer extends the peer lifecycle with a **manifest negotiation** protocol. After mutual authentication, each peer advertises which services it is willing to share, and the other side acknowledges which of those services it finds compatible and wants to use.

This allows multiple Aurora instances (or compatible clients) to form a dynamic mesh where service calls are transparently routed to local or remote providers based on configuration, availability, and latency.

### Mesh Peer Lifecycle (Extended)

```
┌────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Connected │────►│ Authenticated│────►│  Bilateral   │────►│  Negotiated  │
│ (WebRTC)   │     │ (token OK)   │     │  Pairing     │     │ (manifests   │
│            │     │              │     │ (reverse dir │     │  exchanged)  │
│            │     │              │     │  if needed)  │     │              │
└────────────┘     └──────────────┘     └──────────────┘     └──────┬───────┘
                          │                                         │
                          │                                    ┌────┴────┐
                          ▼                                    │         │
                   Register in PeerRegistry               ping/pong  no pong
                   Store peer_name in _peer_names         loop OK    timeout
                   Send manifest ──►                          │         │
                   ◄── Receive manifest                       ▼         ▼
                   ◄── Receive manifest ACK              ┌────────┐ ┌──────┐
                   Send manifest ACK ──►                 │ Active │ │ Stale│
                   Trigger _reverse_pairing()            └────────┘ └──────┘
                   Begin ping/pong loop                       ▲         │
                                                              │ pong    │
                                                              └─────────┘
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
| `event` | Sender → Receiver | Forwards a bus event to the remote peer (fire-and-forget) |
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

- **Commands/Requests** (`event=False`): Routed based on per-module `routing` config:
  - `local_only` / `local`: Always deliver locally.
  - `network`: Prefer remote peer, fall back based on `fallback` config.
  - `network_only`: Remote peer only, fail if unavailable.
- **Events** (`event=True`): Always delivered to the local bus. Additionally forwarded to peers when the publish call opts in via `mesh=True` and the module has `share: true` (see [Event Forwarding](#event-forwarding) below).

Peer selection among multiple providers uses the configured `peer_selection` strategy:
- `lowest_latency`: Pick the peer with the lowest measured RTT.
- `round_robin`: Rotate among available peers.
- `random`: Random selection.

### Hybrid Addressing

Mesh routing supports two addressing modes:

- **Transparent module routing** remains the default for low-risk, local-like service dependencies. Existing callers that publish or request `TTS.Request`, `Orchestrator.UserInput`, or similar module topics without a selector continue to use the module's `prefer`, `fallback`, version, capability, latency, and capacity policy.
- **Explicit selector routing** is used when a caller must choose the remote authority or resource. Typed payloads can include `mesh_selector` with `peer_id`, `provider_id`, `service_instance_id`, `resource_namespace`, `tool_id`, `hardware_target`, or `data_scope`. `peer_id`, `provider_id`, and `service_instance_id` are binding route targets; `resource_namespace`, `tool_id`, `hardware_target`, and `data_scope` preserve the caller's resource intent for policy and audit surfaces.

When an explicit selector names a peer/provider, `RoutingTable.resolve()` validates that the peer exists, is negotiated, is allowed by per-service policy, shares the requested module, satisfies version/capability requirements, and has capacity. Selector failures return actionable error codes such as `selector_peer_not_found`, `selector_peer_unauthorized`, `selector_peer_stale`, `selector_service_missing`, or `selector_incompatible_capabilities`.

Per-service mesh config can set `require_explicit_selector: true` for safety-sensitive categories. This is intended for tools, DB/data namespaces, hardware controls, scheduler ownership, remote playback, and privacy-sensitive data. Transparent routing is still appropriate for low-risk module dependencies where any compatible provider can satisfy the request.

Explicit selector routes do not silently fall back to a different peer or local service after selector validation or target transport failure. A caller that chooses a specific tool/resource/provider receives an error if that target cannot satisfy the call.

### Event Forwarding

#### The Problem

Aurora's voice pipeline is almost entirely **event-driven**. When a user speaks, the audio chain produces a sequence of broadcast events:

```
Audio.Stream.Microphone  →  WakeWord.Detected
  →  STT.SessionStarted  →  Transcription.Result
    →  STT.UserSpeechCaptured  →  Orchestrator processes  →  LLM.ResponseReady
      →  TTS.Request (command)  →  TTS.Started / TTS.Stopped (events)
```

Every step in that chain except `TTS.Request` is an **event** (broadcast). Without event forwarding, if any service in the pipeline runs on a remote peer, the downstream event subscribers on the other instance never receive the event. The pipeline silently breaks — no errors, no logs, just silence.

**Concrete example**: Suppose Instance A offloads its `Orchestrator` to Instance B. The Orchestrator on B processes the user's speech and publishes `LLM.ResponseReady` locally on B's bus. Instance A's UI bridge, TTS service, and DB service never see that event. The user gets no response, no audio, and no history entry — with zero indication that anything went wrong.

#### How It Works

Event forwarding is a lightweight extension to the MeshBus that solves this problem:

1. **Sender side** (`MeshBus.publish`): When a service publishes an event with `mesh=True`, and the event's module has `share: true` in the mesh config, the MeshBus forwards the event to all **negotiated** peers via the WebRTC DataChannel using a `event` message type. This is fire-and-forget — no response is expected.  The `mesh` parameter is a **publish-site declaration**: each individual `bus.publish()` call decides whether the event has cross-instance relevance.

2. **Receiver side** (`RPCHandler._handle_event`): The receiving peer publishes the event on its **local** bus with `origin="mesh_forwarded"`, so all local services react to it (e.g., UI bridge displays the response, TTS starts speaking).

3. **Loop prevention**: Events with `origin="mesh_forwarded"` are **never re-forwarded**. This prevents infinite echo loops between peers.

```
Instance A (shares TTS)                    Instance B (routes TTS → remote)
─────────────────────────                  ──────────────────────────────────
TTS publishes TTS.Started with mesh=True
  → local bus delivery (A's subscribers)
  → MeshBus sees mesh=True + TTS share=true
  → fire_event() via DataChannel ─────────► RPCHandler receives "event"
                                             → publishes TTS.Started locally
                                               with origin="mesh_forwarded"
                                             → B's UI bridge updates state ✅
                                             → NOT re-forwarded (loop prevention)
```

#### DataChannel Protocol

Event forwarding adds one new message type to the DataChannel protocol:

| Message Type | Direction | Purpose |
|---|---|---|
| `event` | Sender → Receiver | Forwards a bus event to the remote peer |

**Event message structure:**

```json
{
  "type": "event",
  "topic": "TTS.Started",
  "params": { ... }
}
```

Events are fire-and-forget: no `id` field, no response expected. If delivery fails (peer disconnected, DataChannel closed), the failure is logged at DEBUG level and silently ignored — this matches the best-effort semantics of events on the local bus.

#### Configuration

Event forwarding is controlled at two levels:

1. **Publish-site (code)**: The developer passes `mesh=True` on each `bus.publish()` call that has cross-instance relevance. Events without `mesh=True` (the default) stay local.

2. **Mesh config (config.json)**: The module must have `share: true` in the `gateway.mesh.sharing` section. This acts as an operator-level gate — even if code says `mesh=True`, the event won't forward unless the module is shared.

**Publish-site example:**
```python
# This event will be forwarded to mesh peers (if TTS share=true)
await self.bus.publish(
    TTSMethods.STARTED,
    TTSStarted(request_id=request_id, text=text),
    event=True,
    mesh=True,  # ← opt-in to mesh forwarding
    origin="internal",
)

# This event stays local (hardware-bound, high-frequency)
await self.bus.publish(
    AudioTopics.STREAM_MICROPHONE,
    AudioChunk(data=chunk),
    event=True,
    # mesh=False is the default — no forwarding
    origin="internal",
)
```

**Sharing config:**
```json
{
  "TTS": {
    "share": true,
    "max_concurrent": 10
  }
}
```

Event forwarding **only activates** when all of the following are true:
- The publish call passes `mesh=True`
- The module is marked `share: true` in mesh config
- The event's `origin` is not `"mesh_forwarded"` (loop prevention)
- At least one negotiated peer is connected

#### Which Events Use `mesh=True`

| Service | Events with `mesh=True` | Events without (local-only) |
|---|---|---|
| **TTS** | `STARTED`, `STOPPED`, `PAUSED`, `RESUMED`, `ERROR` | — |
| **Orchestrator** | `RESPONSE` (LLM response) | — |
| **STTCoordinator** | `SESSION_STARTED`, `USER_SPEECH_CAPTURED`, `SESSION_ENDED` | `Audio.Started`, `Audio.Stopped`, `Audio.Stream.Microphone` |
| **Config** | `UPDATED` | — |
| **Tooling** | `TOOLS_INITIALIZED`, `TOOLS_RELOADED` | — |

#### When to Share Modules

Since event forwarding is now handled per-publish-call via `mesh=True`, the only config decision is whether to **share** a module with peers:

| Scenario | Recommendation | Reason |
|---|---|---|
| Remote TTS | ✅ **Share** | `TTS.Started` / `TTS.Stopped` events (tagged `mesh=True`) drive UI state on the consumer. |
| Remote Orchestrator | ✅ **Share** | `LLM.ResponseReady` (tagged `mesh=True`) is how the UI and TTS know the LLM responded. |
| Remote STT services | ✅ **Share** | `STT.UserSpeechCaptured` (tagged `mesh=True`) drives the Orchestrator and UI. Audio stream events stay local automatically. |
| Remote DB | ⚠️ **Optional** | DB events are less common. Share if you want cross-instance notifications. |
| Remote Scheduler | ⚠️ **Optional** | `Sched.JobFired` events may need to reach the Orchestrator on another instance. |
| Remote Config | ⚠️ **Optional** | `Config.Changed` events trigger service reloads. Share if you want config propagation across peers. |

#### Performance Considerations

- **Bandwidth**: Each forwarded event is a single JSON message over the DataChannel. For typical Aurora events (transcription results, TTS state changes), this is negligible — a few KB per interaction.
- **Latency**: Events are forwarded asynchronously. The local bus delivery is never blocked by event forwarding; remote delivery happens in the background.
- **Failure tolerance**: If forwarding fails for a peer (e.g., DataChannel closed), the error is silently logged and the other peers still receive their copies. Local delivery is always guaranteed regardless of forwarding outcome.
- **No back-pressure**: Event forwarding is fire-and-forget. There is no acknowledgement or retry. If a peer is too slow to process events, they will be silently dropped by the DataChannel buffer. This is intentional — events are ephemeral notifications, not durable commands.

### Security Controls

- **Sharing gate**: Remote peers can only call services explicitly marked `share: true`.
- **Allowed peers**: Each shared service can restrict which peer IDs may call it via `allowed_peers`.
- **Capacity limits**: Each shared service specifies `max_concurrent`; calls beyond that limit get HTTP 429.
- **Permission checks**: Standard RBAC permission checks apply to all inbound RPC calls.
- **Version compatibility**: Configurable version matching policies (`exact`, `compatible`, `any`).
- **Event forwarding scope**: Only events published with `mesh=True` from modules marked `share: true` are forwarded. A module that is not shared will never leak events to peers. Events without `mesh=True` (like audio streams) stay local regardless of config.

### Mesh Configuration

All nine Aurora service modules are pre-populated in the default configuration with safe defaults (`share: false`, `prefer: "local"`), so users do not need to guess module names or write configuration objects from scratch — they only need to toggle the settings they want to change.

```json
{
  "gateway": {
    "mesh": {
      "enabled": true,
      "node_name": "aurora-desktop",
      "sharing": {
        "TTS": { "share": true, "max_concurrent": 10 },
        "STTCoordinator": { "share": false, "max_concurrent": 10 },
        "WakeWord": { "share": false, "max_concurrent": 10 },
        "Transcription": { "share": false, "max_concurrent": 10 },
        "DB": { "share": false, "max_concurrent": 10 },
        "Orchestrator": { "share": true, "max_concurrent": 2 },
        "Tooling": { "share": false, "max_concurrent": 10 },
        "Scheduler": { "share": false, "max_concurrent": 10 },
        "Config": { "share": false, "max_concurrent": 10 }
      },
      "routing": {
        "TTS": { "prefer": "network", "fallback": "local", "min_version": "1.0.0" },
        "STTCoordinator": { "prefer": "local", "fallback": "local" },
        "WakeWord": { "prefer": "local", "fallback": "local" },
        "Transcription": { "prefer": "local", "fallback": "local" },
        "DB": { "prefer": "local", "fallback": "local" },
        "Orchestrator": { "prefer": "local", "fallback": "local" },
        "Tooling": { "prefer": "local", "fallback": "local" },
        "Scheduler": { "prefer": "local", "fallback": "local" },
        "Config": { "prefer": "local", "fallback": "local" }
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
| **PeerBridge** | `app/services/gateway/mesh/peer_bridge.py` | Sends outbound RPC calls and forwards events via DataChannels |
| **MeshBus** | `app/messaging/mesh_bus.py` | Transparent routing wrapper; handles command routing and event forwarding |
| **RPCHandler** | `app/services/gateway/webrtc/rpc.py` | Receives inbound RPC calls and forwarded events from peers |
| **RTCClient** | `app/services/gateway/webrtc/rtc_client.py` | WebRTC peer management, auth gate, bilateral pairing, heartbeat timeout |
| **AuthManager** | `app/services/auth/auth_manager.py` | Pairing flow, mesh peer CRUD, consolidated trust store sync |
| **AuthProxy** | `app/services/gateway/auth_proxy.py` | Gateway-side auth proxy with audit event routing via bus |
| **LatencyMonitor** | `app/services/gateway/mesh/latency.py` | Periodic ping/pong RTT measurement |
| **Negotiation** | `app/services/gateway/mesh/negotiation.py` | Manifest generation, parsing, ACK logic |
| **VersionCompat** | `app/services/gateway/mesh/version_compat.py` | Semantic version comparison |
