# Mesh Pairing — Comprehensive Fix Plan (v2)

> **Status**: ✅ ALL 9 FIXES IMPLEMENTED (January 2026)  
> **Scope**: WebRTC mesh pairing, DB-backed persistence, mutual trust, peer management API, logging, typed permissions  
> **Affected files**: ~20 files across `app/services/gateway/`, `app/services/auth/`, `app/services/db/`, `app/shared/`  
> **Estimated effort**: 5–7 days of focused implementation  
> **v2 changes**: ALL state persisted to DB (not config files), stateful peer lifecycle, peer management API with CRUD  
> **Previous version**: `docs/MESH_PAIRING_FIX_PLAN_v1.md`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Fix 1 — Stable Peer Identity (DB-Backed)](#fix-1--stable-peer-identity-db-backed)
4. [Fix 2 — Bilateral Pairing (Both Peers Approve Each Other)](#fix-2--bilateral-pairing-both-peers-approve-each-other)
5. [Fix 3 — DB-Backed Peer Lifecycle](#fix-3--db-backed-peer-lifecycle)
6. [Fix 4 — Mutual Approval Is the Default](#fix-4--mutual-approval-is-the-default)
7. [Fix 5 — Smart Pairing Timeout](#fix-5--smart-pairing-timeout)
8. [Fix 6 — Node Name in Logs & Presence](#fix-6--node-name-in-logs--presence)
9. [Fix 7 — Typed Permissions](#fix-7--typed-permissions)
10. [Fix 8 — Audit Proxy Fix](#fix-8--audit-proxy-fix)
11. [Fix 9 — Peer Management API](#fix-9--peer-management-api)
12. [Migration & Rollout](#migration--rollout)
13. [File Change Summary](#file-change-summary)

---

## 1. Executive Summary

The mesh pairing system has three fundamental architectural flaws:

1. **Trust is one-directional and ephemeral.** After pairing, only the *initiator* receives a token (issued by the responder's auth service). The responder is trusted in-memory only. On restart, the initiator can re-authenticate to the responder, but the responder has no credential to authenticate back — creating a deadlock where the initiator's auth gate drops all messages from the still-ANONYMOUS responder.

2. **Approval is one-sided.** Only the responder's admin approves and grants permissions. The initiator never gets a say in what the responder can do on *its* services. In a real mesh, **each peer is an independent authority** that must independently decide what permissions to grant to the other. Peer A decides what Peer B can access on A's services, and Peer B independently decides what Peer A can access on B's services. Two separate admin approval decisions, two separate tokens, two separate permission sets.

3. **All state is ephemeral or stored in the wrong place.** `peer_id` is a random UUID4 regenerated on every restart, pairing requests live in an in-memory dict lost on restart, and the existing `mesh_credentials` table only stores one token per room. There is **no persistent record of peer relationships**, no way to list known peers, no way to manage permissions after initial pairing, and no way to resume partial approvals.

Compounding all three problems, the `peer_id` is regenerated on every restart, so the tie-breaker that determines initiator vs. responder can **flip**, meaning the side that previously saved a token may become the responder (and thus never send it).

**This plan proposes 9 coordinated fixes:**

| Fix | Summary |
|-----|---------|
| **Fix 1** ✅ | Stable peer_id — persisted to **DB** (not config file) |
| **Fix 2** ✅ | Bilateral pairing — both admins independently approve with specific permissions |
| **Fix 3** ✅ | `mesh_peers` + `mesh_identity` DB tables — full peer lifecycle in SQLite |
| **Fix 4** ✅ | Mutual approval is the default — no auto-approve concept exists |
| **Fix 5** ✅ | Smart pairing timeout — heartbeat loop, indefinite peer records in DB |
| **Fix 6** ✅ | Node name in logs & presence — human-readable peer identification |
| **Fix 7** ✅ | Typed permissions — validated permission strings with known prefixes |
| **Fix 8** ✅ | Audit proxy fix — `_AuditDBProxy.store_audit_event()` routed via bus |
| **Fix 9** ✅ | **Peer Management API** — list peers, approve/deny, update permissions, remove |

### Critical Design Principle: Everything in DB, Nothing in Config

**ALL mesh peer state is stored in SQLite, NEVER in `config.json`.**

- `peer_id` → `mesh_identity` table
- Peer relationships → `mesh_peers` table
- Tokens (inbound) → `mesh_peers.inbound_token` column
- Tokens (outbound) → `tokens` table (existing auth system)
- Pairing approval state → `mesh_peers.outbound_status` / `inbound_status`
- Permissions → `mesh_peers.outbound_permissions` / `inbound_permissions`

`config.json` only stores **operator preferences** (room config, routing, version policy) — never runtime state.

---

## 2. Root Cause Analysis

### 2.1 The Deadlock (why peers re-pair on every restart)

```
RESTART SCENARIO (same tie-breaker winner):

  Initiator (has saved token)          Responder (no saved token)
  ─────────────────────────          ──────────────────────────
  1. DataChannel opens
  2. Sends saved token ──────────▶   3. Validates token ✓
                                     4. Sets _peer_acl[initiator] = trusted
                                     5. Sends manifest ──────────▶  6. Auth gate: responder
                                                                       is ANONYMOUS → DROP ✗
  7. Auth timeout fires for
     responder (still ANONYMOUS)
  8. Disconnects responder
  ─── cycle repeats forever ───


RESTART SCENARIO (tie-breaker FLIPS — peer_id changed):

  New Initiator (was responder,       New Responder (was initiator,
  has NO saved token)                  HAS saved token)
  ─────────────────────────          ──────────────────────────
  1. DataChannel opens
  2. No saved token → starts          3. Has saved token → sends it
     pairing from scratch                BUT is not initiator, so also
                                         just waits
  4. Both sides race: initiator
     pairing + responder auth
  ─── unpredictable behavior ───
```

### 2.2 Individual Root Causes

| # | Bug | Root Cause | File(s) |
|---|-----|-----------|---------|
| 1 | Re-pairing on restart | One-directional trust: only initiator gets a token; responder trusted in-memory only | `rtc_client.py` `_initiate_pairing()` |
| 2 | Tie-breaker flip | `peer_id = uuid4()` regenerated every restart; lexicographic comparison changes winner | `rtc_client.py` `__init__` |
| 3 | Single credential per room | `mesh_credentials.room_name` is UNIQUE — only ONE token per room | `006_mesh_credentials.sql` |
| 4 | No mutual approval | Only responder's admin approves; initiator auto-trusts via `_peer_acl` without own admin's input | `rtc_client.py`, `auth_manager.py` |
| 5 | Ephemeral pairing state | `AuthManager.pairing_requests` is an in-memory dict; lost on restart | `auth_manager.py` |
| 6 | Rigid timeout | Fixed `_pairing_timeout` with one extension; admin delays cause disconnect | `rtc_client.py` `_auth_timeout_check()` |
| 7 | No node_name in logs | Presence only carries `peer_id`; logs show `peer[:8]` UUIDs | `rtc_client.py`, MQTT presence |
| 8 | Untyped permissions | `permissions: list[str]` accepts any string; no validation | `models/auth.py`, `config.py` |
| 9 | Broken audit | `_AuditDBProxy` doesn't implement `store_audit_event()`; errors silently suppressed | `auth_proxy.py` |
| 10 | No peer management | No way to list known peers, update permissions, or approve pending peers after code expiry | Gateway API — missing entirely |

---

## Fix 1 — Stable Peer Identity (DB-Backed) ✅ IMPLEMENTED

### Problem
`peer_id` is `uuid4()` regenerated every restart. This causes:
- Tie-breaker instability (different initiator each restart)
- Inability to key stored credentials by peer_id
- Log correlation loss across restarts

### Solution
Generate `peer_id` once, persist it to the **`mesh_identity` DB table**, and reuse it on every startup.

> **Why DB and not `config.json`?** Config files are for operator preferences. Runtime identity is state that belongs in the database. This also avoids race conditions with concurrent config writes and keeps `config.json` clean.

### DB Schema

```sql
-- Part of migration 007 (see Fix 3 for full migration)
CREATE TABLE IF NOT EXISTS mesh_identity (
    key TEXT PRIMARY KEY DEFAULT 'self',
    peer_id TEXT NOT NULL,
    node_name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Changes

**`app/services/gateway/webrtc/rtc_client.py`** — Accept `peer_id` parameter:
```python
# BEFORE (line ~40)
self._peer_id = str(uuid.uuid4())

# AFTER
self._peer_id = peer_id  # Must be provided by caller (loaded from DB)
```

**`app/services/gateway/service.py`** — Load-or-create stable peer_id from DB:
```python
async def _get_or_create_peer_id(self) -> str:
    """Load persistent peer_id from DB, or generate and save one."""
    resp = await self.bus.request(
        "Auth.LoadMeshIdentity",
        MeshIdentityLoadRequest(),
        timeout=5.0,
    )
    if resp and resp.peer_id:
        log_info(f"Loaded persistent peer_id: {resp.peer_id}")
        return resp.peer_id

    # First run — generate and persist
    peer_id = str(uuid.uuid4())
    node_name = self._config.mesh.node_name or ""
    await self.bus.request(
        "Auth.SaveMeshIdentity",
        MeshIdentitySaveRequest(peer_id=peer_id, node_name=node_name),
        timeout=5.0,
    )
    log_info(f"Generated new persistent peer_id: {peer_id}")
    return peer_id
```

**New contracts** (`app/shared/contracts/models/auth.py`):
```python
class MeshIdentityLoadRequest(BaseModel):
    pass  # No params — always loads 'self'

class MeshIdentityLoadResponse(BaseModel):
    peer_id: str | None = None
    node_name: str = ""

class MeshIdentitySaveRequest(BaseModel):
    peer_id: str
    node_name: str = ""
```

**`app/services/auth/service.py`** — New handlers:
```python
@method_contract(
    method_id="Auth.LoadMeshIdentity",
    summary="Load this instance's stable mesh identity from DB",
    input_model=MeshIdentityLoadRequest,
    output_model=MeshIdentityLoadResponse,
    exposure="internal",
)
async def load_mesh_identity(self, envelope: Envelope) -> None:
    result = await self.auth_manager.load_mesh_identity()
    await self.bus.publish(envelope.reply_to, result, event=False)

@method_contract(
    method_id="Auth.SaveMeshIdentity",
    summary="Save this instance's stable mesh identity to DB",
    input_model=MeshIdentitySaveRequest,
    output_model=None,
    exposure="internal",
)
async def save_mesh_identity(self, envelope: Envelope) -> None:
    req = envelope.payload
    await self.auth_manager.save_mesh_identity(req.peer_id, req.node_name)
```

**`app/services/auth/auth_manager.py`** — DB operations:
```python
async def load_mesh_identity(self) -> MeshIdentityLoadResponse:
    row = await self.db.fetch_one(
        "SELECT peer_id, node_name FROM mesh_identity WHERE key = 'self'"
    )
    if row:
        return MeshIdentityLoadResponse(peer_id=row["peer_id"], node_name=row["node_name"])
    return MeshIdentityLoadResponse()

async def save_mesh_identity(self, peer_id: str, node_name: str) -> None:
    await self.db.execute(
        """INSERT INTO mesh_identity (key, peer_id, node_name)
           VALUES ('self', ?, ?)
           ON CONFLICT(key) DO UPDATE SET peer_id = ?, node_name = ?""",
        (peer_id, node_name, peer_id, node_name),
    )
```

### Impact
- `peer_id` is stable across restarts → tie-breaker is deterministic
- Credentials can be keyed by `remote_peer_id` reliably
- Logs are correlatable across sessions
- No pollution of `config.json` with runtime state

---

## Fix 2 — Bilateral Pairing (Both Peers Approve Each Other) ✅ IMPLEMENTED

### Problem
After pairing, only the initiator holds a token. The responder is trusted via an in-memory `_peer_acl` entry that doesn't survive restart. More critically, only the **responder's** admin ever approves the pairing — the initiator's admin is never consulted. Each peer is an independent authority that must independently decide what permissions to grant to the other.

### Design Principle
**Each peer is a sovereign authority over its own services.** Peer A's admin decides what Peer B can do on A. Peer B's admin decides what Peer A can do on B. These are two completely independent decisions with potentially different permission sets.

### Solution: Two-Phase Bilateral Pairing

The pairing flow has two phases, each requiring admin approval on one side. Both phases happen over the same DataChannel. Neither side is fully trusted until BOTH phases complete.

### Flow

```
PHASE 1 — FORWARD PAIRING (Initiator requests access to Responder's services):

  Initiator                              Responder
  ─────────                              ─────────
  1. RPC Auth.PairingStart ──────────▶   2. Creates code C1, status=pending
                                            Creates/updates mesh_peers row for
                                            initiator (outbound_status=pending)
                                         3. ┌─────────────────────────────────────┐
                                            │ RESPONDER ADMIN PROMPT:             │
                                            │ Peer "office-pc" wants access.      │
                                            │ Grant permissions: [TTS.*, STT.*]   │
                                            │ [Approve] [Deny]                    │
                                            └─────────────────────────────────────┘
                                         4. Admin approves with permissions P_resp
                                            Updates mesh_peers: outbound_status=approved
  5. RPC Auth.PairingConnect ────────▶   6. Returns status=approved
  7. RPC Auth.PairingExchange ───────▶   8. Issues Token_A (carries P_resp)
  9. Receives Token_A
     Updates own mesh_peers row:
     inbound_status=approved,
     inbound_token=Token_A
  10. Sends auth msg {token: Token_A} ─▶ 11. Validates Token_A ✓
                                              Initiator now trusted on Responder
                                              with permissions P_resp

  ── Phase 1 complete: Initiator can access Responder's services ──
  ── But Responder is still ANONYMOUS on Initiator's auth gate ──

PHASE 2 — REVERSE PAIRING (Responder requests access to Initiator's services):

  Responder                              Initiator
  ─────────                              ─────────
  12. RPC Auth.PairingStart ─────────▶   13. Creates code C2, status=pending
                                              Creates/updates mesh_peers row for
                                              responder (outbound_status=pending)
                                         14. ┌─────────────────────────────────────┐
                                             │ INITIATOR ADMIN PROMPT:             │
                                             │ Peer "living-room" wants access.    │
                                             │ Grant permissions: [Orch.*]         │
                                             │ [Approve] [Deny]                    │
                                             └─────────────────────────────────────┘
                                         15. Admin approves with permissions P_init
                                              Updates mesh_peers: outbound_status=approved
  16. RPC Auth.PairingConnect ───────▶   17. Returns status=approved
  18. RPC Auth.PairingExchange ──────▶   19. Issues Token_B (carries P_init)
  20. Receives Token_B
      Updates own mesh_peers row:
      inbound_status=approved,
      inbound_token=Token_B
  21. Sends auth msg {token: Token_B} ─▶ 22. Validates Token_B ✓
                                              Responder now trusted on Initiator
                                              with permissions P_init

  ── Phase 2 complete: Responder can access Initiator's services ──

RESULT:
  • Initiator holds Token_A (issued by Responder, carries Responder-granted perms)
  • Responder holds Token_B (issued by Initiator, carries Initiator-granted perms)
  • Both tokens persisted in mesh_peers table → survive restart
  • Each admin independently chose what to share
```

### State Machine

The pairing flow is modeled as a state machine tracked per-peer **in the `mesh_peers` DB table** (not in-memory):

```
                    ┌──────────────┐
        ┌──────────│  DISCOVERED  │──────────┐
        │          └──────────────┘          │
        │ (we are initiator)    (we are responder)
        ▼                                    ▼
┌───────────────┐                  ┌──────────────────┐
│ FORWARD_SENT  │                  │ FORWARD_RECEIVED │
│ (waiting for  │                  │ (waiting for our │
│  remote admin)│                  │  admin to approve│
└───────┬───────┘                  │  remote's code)  │
        │ remote approved          └────────┬─────────┘
        │ + token exchanged                 │ our admin approved
        ▼                                   │ + token received
┌───────────────┐                           ▼
│ FORWARD_DONE  │                  ┌──────────────────┐
│ (we have      │                  │ FORWARD_DONE     │
│  Token_A)     │                  │ (remote has      │
└───────┬───────┘                  │  Token_A)        │
        │ remote starts                     │
        │ reverse pairing          ┌────────┘
        ▼                          ▼ we start reverse pairing
┌───────────────┐          ┌──────────────────┐
│ REVERSE_RECV  │          │ REVERSE_SENT     │
│ (our admin    │          │ (waiting for     │
│  must approve)│          │  remote admin)   │
└───────┬───────┘          └────────┬─────────┘
        │ approved                  │ approved
        ▼                          ▼
┌───────────────┐          ┌──────────────────┐
│   COMPLETE    │◄─────────│   COMPLETE       │
│ Both tokens   │          │ Both tokens      │
│ saved in DB   │          │ saved in DB      │
└───────────────┘          └──────────────────┘
```

**Partial completion is valid and persistent.** If Phase 1 completes but Phase 2 doesn't (admin didn't approve in time), the `mesh_peers` row persists with:
- `inbound_status = approved` (we have their token)
- `outbound_status = pending` (we haven't approved them yet)

The admin can **always come back later** and approve via the Peer Management API (Fix 9), at which point the next connection will complete Phase 2.

### Changes

**`app/services/gateway/webrtc/rtc_client.py`** — Bilateral pairing orchestration:

```python
# NEW: Per-peer pairing state (tracks in-flight pairing, NOT persisted — 
# the DB is the source of truth for the durable state)
class PairingPhase(str, Enum):
    """Tracks where we are in the bilateral pairing for the current session."""
    NONE = "none"
    FORWARD_SENT = "forward_sent"
    FORWARD_DONE = "forward_done"
    REVERSE_SENT = "reverse_sent"
    REVERSE_RECEIVED = "reverse_received"
    COMPLETE = "complete"

# In __init__:
self._pairing_phase: dict[str, PairingPhase] = {}  # peer_id → phase (session-only)

# Initiator's flow (called when DataChannel opens and no saved credential):
async def _initiate_bilateral_pairing(self, peer: str, chan: Any) -> None:
    """Full bilateral pairing: forward then reverse."""
    try:
        # Ensure mesh_peers row exists in DB
        await self._ensure_peer_record(peer)

        # ── Phase 1: Forward (we request access to THEIR services) ──
        self._pairing_phase[peer] = PairingPhase.FORWARD_SENT
        token_a = await self._do_pairing_exchange(peer, direction="forward")
        if not token_a:
            log_warning(f"Forward pairing failed with {self._peer_label(peer)}")
            return

        self._pairing_phase[peer] = PairingPhase.FORWARD_DONE

        # Persist Token_A to mesh_peers (inbound side)
        await self._save_inbound_credential(peer, token_a)

        # Send auth with Token_A so we're trusted on THEIR side
        chan.send(json.dumps({
            "type": "auth",
            "peer_name": self._peer_id,
            "node_name": self._node_name,
            "token": token_a["token"],
        }))

        log_info(
            f"Forward pairing complete with {self._peer_label(peer)}. "
            f"Waiting for reverse pairing (their admin must approve us)…"
        )

        # ── Phase 2: Wait for reverse pairing from responder ──
        # Responder will call PairingStart RPC on OUR auth service.
        # Our admin must approve via API or UI.
    except Exception as exc:
        log_error(f"Bilateral pairing failed with {self._peer_label(peer)}: {exc}")
    finally:
        if self._pairing_phase.get(peer) != PairingPhase.COMPLETE:
            self._peer_pairing_active.discard(peer)

# Responder's trigger (called when remote authenticates to us):
async def _on_peer_authenticated(self, peer: str, chan: Any, identity: Identity) -> None:
    """Called when a peer successfully authenticates to us.
    
    If we have no saved credential keyed to this remote stable peer_id
    (no inbound token for this peer), start reverse pairing to get OUR token
    from THEIR auth service. Credentials for other peers or legacy/default
    fallback tokens must not suppress this step.
    """
    peer_record = await self._load_peer_record(peer)
    if not peer_record or not peer_record.get("inbound_token"):
        log_info(
            f"Peer {self._peer_label(peer)} authenticated to us. "
            f"Starting reverse pairing to request access to their services…"
        )
        self._pairing_phase[peer] = PairingPhase.REVERSE_SENT
        self._peer_pairing_active.add(peer)
        task = asyncio.create_task(self._do_reverse_pairing(peer, chan))
        self._pairing_tasks[peer] = task

async def _do_reverse_pairing(self, peer: str, chan: Any) -> None:
    """Reverse pairing: we request access to the remote peer's services."""
    try:
        token_b = await self._do_pairing_exchange(peer, direction="reverse")
        if not token_b:
            log_warning(f"Reverse pairing failed with {self._peer_label(peer)}")
            return

        # Persist Token_B to mesh_peers (inbound side)
        await self._save_inbound_credential(peer, token_b)

        # Send auth with Token_B
        chan.send(json.dumps({
            "type": "auth",
            "peer_name": self._peer_id,
            "node_name": self._node_name,
            "token": token_b["token"],
        }))

        self._pairing_phase[peer] = PairingPhase.COMPLETE
        log_info(f"✅ Bilateral pairing COMPLETE with {self._peer_label(peer)}")
    except Exception as exc:
        log_error(f"Reverse pairing failed with {self._peer_label(peer)}: {exc}")
    finally:
        self._peer_pairing_active.discard(peer)
        self._pairing_tasks.pop(peer, None)
```

**Key: `_do_pairing_exchange`** is the common flow used by both phases — it calls PairingStart, polls PairingConnect, and calls PairingExchange on the **remote peer's auth service** via RPC. Same code as today's `_initiate_pairing()` inner logic, extracted into a reusable method.

### Handling the Approval Prompts

Each side's admin approval is handled by their **own local Auth service**. When the remote peer calls `Auth.PairingStart` via DataChannel RPC:

1. The RPC arrives at the local RPCHandler
2. RPCHandler routes it to the local Auth service via the bus
3. Auth service creates a pairing request AND updates `mesh_peers.outbound_status = 'pending'`
4. The admin must approve via:
   - The **Peer Management API**: `POST /mesh/peers/{peer_id}/approve` (Fix 9)
   - The **Gateway HTTP API**: `POST /auth/pairing/approve` (existing endpoint)
   - The **UI**: PyQt6 UI shows a pairing notification (via UIBridge bus event)
5. The remote peer is polling `Auth.PairingConnect` and sees `status=approved`
6. Remote peer calls `Auth.PairingExchange` to get the token

### Admin Notification Event

To make approval seamless, publish a bus event when a pairing request arrives:

```python
# In auth_manager.py start_pairing():
await self.bus.publish(
    "Auth.PairingRequested",
    PairingRequestedEvent(
        code=pairing_code,
        remote_peer_id=remote_peer_id,
        remote_node_name=remote_node_name,
        device_name=device_name,
        client_ip=client_ip,
        expires_at=request["expires_at"].isoformat(),
    ),
    event=True,
    mesh=False,  # Local-only event
    origin="internal",
)
```

### What if Admin Denies, Ignores, or Misses the Window?

- **Admin denies**: `mesh_peers.outbound_status = 'denied'`. One-directional trust only. Admin can later change status to approved via Peer Management API.
- **Admin doesn't respond in time**: Pairing code expires (5 min). `mesh_peers` row persists with `outbound_status = 'pending'`. **The peer record NEVER expires.** Admin can approve later via the Peer Management API (Fix 9), and next time the remote peer connects, the approved credentials are exchanged automatically.
- **Only one side approves**: System degrades gracefully to one-directional trust. The approved side works, the unapproved side doesn't. Both sides see the partial state in their `mesh_peers` table.

| Forward Approved? | Reverse Approved? | Result |
|:-:|:-:|---|
| ✅ | ✅ | Full bilateral mesh. Both peers access each other's services. |
| ✅ | ❌/pending | Initiator can access Responder's services. Responder cannot access Initiator's. |
| ❌ | N/A | Pairing fails entirely. No trust established. |

### Result
- Both admins independently decide what to share
- Both peers end up with tokens carrying independently-chosen permissions
- Both tokens persist to `mesh_peers` DB table → survive restart
- Permission sets can be asymmetric
- Partial approval persists indefinitely — second admin can always approve later

---

## Fix 3 — DB-Backed Peer Lifecycle ✅ IMPLEMENTED

### Problem
The existing system has:
- `mesh_credentials` table with `room_name TEXT NOT NULL UNIQUE` — only ONE token per room
- `AuthManager.pairing_requests` — in-memory dict, lost on restart
- `_peer_acl` — in-memory dict, lost on restart
- No record of known peers, their status, or history
- No way to list, manage, or update peer permissions

### Solution
Replace `mesh_credentials` with two new tables that form the complete peer lifecycle:

1. **`mesh_identity`** — This instance's stable identity (peer_id + node_name)
2. **`mesh_peers`** — Every known remote peer and the full bilateral relationship state

### New Migration: `007_mesh_peer_lifecycle.sql`

```sql
-- Migration 007: Mesh peer lifecycle tables
-- Created at: 2026-XX-XX
-- Purpose: Replace mesh_credentials with comprehensive peer state management.
--          Store this instance's stable identity. Track bilateral pairing state,
--          permissions, tokens, and connection history for every known peer.
--          ALL mesh state lives in DB — not config files, not in-memory dicts.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. LOCAL IDENTITY — this instance's stable peer_id
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS mesh_identity (
    key TEXT PRIMARY KEY DEFAULT 'self',     -- Always 'self' (singleton row)
    peer_id TEXT NOT NULL,                   -- Our stable UUID, generated once
    node_name TEXT NOT NULL DEFAULT '',       -- Human-readable name (e.g. "office-pc")
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. KNOWN REMOTE PEERS — bilateral relationship state
-- ═══════════════════════════════════════════════════════════════════════
-- Each row represents ONE remote peer from THIS instance's perspective.
-- Contains two "directions" of the trust relationship:
--   OUTBOUND = what WE granted to THEM (our admin's decision)
--   INBOUND  = what THEY granted to US (we store the token they gave us)
--
-- A fully-paired peer has both outbound_status=approved AND inbound_status=approved.
-- A partially-paired peer has one side approved and the other pending/denied.
-- Peer records NEVER expire — admin can always come back to approve.
CREATE TABLE IF NOT EXISTS mesh_peers (
    id TEXT PRIMARY KEY,                                -- Internal row ID (uuid)
    peer_id TEXT NOT NULL,                              -- Remote peer's stable UUID
    node_name TEXT NOT NULL DEFAULT '',                  -- Remote peer's human-readable name
    room_name TEXT NOT NULL,                             -- WebRTC room used to reach them

    -- ── Network info ──
    ip TEXT,                                             -- Last known IP/host
    port INTEGER,                                        -- Last known port

    -- ── OUTBOUND: what WE granted to THEM (our admin's decision) ──
    outbound_status TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | denied
    outbound_permissions TEXT NOT NULL DEFAULT '[]',     -- JSON array of permission strings
    outbound_token_id TEXT,                              -- FK → tokens.id (token we issued)
    outbound_device_id TEXT,                             -- FK → devices.id (device we created)
    outbound_user_id TEXT,                               -- FK → users.id
    outbound_approved_at TIMESTAMP,                      -- When our admin approved
    outbound_approved_by TEXT,                            -- Which local admin approved

    -- ── INBOUND: what THEY granted to US (we store their token) ──
    inbound_status TEXT NOT NULL DEFAULT 'unknown',      -- unknown | pending | approved | denied
    inbound_token TEXT,                                  -- Plaintext token THEY issued to US
    inbound_permissions TEXT NOT NULL DEFAULT '[]',       -- JSON: permissions THEY granted US
    inbound_device_id TEXT,                               -- Device ID they assigned us
    inbound_user_id TEXT,                                 -- User ID they assigned us
    inbound_approved_at TIMESTAMP,                        -- When their admin approved

    -- ── Connection / lifecycle ──
    connection_status TEXT NOT NULL DEFAULT 'disconnected', -- connected | disconnected
    first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP,
    last_status_change_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(peer_id, room_name)
);

CREATE INDEX IF NOT EXISTS idx_mesh_peers_peer_id ON mesh_peers(peer_id);
CREATE INDEX IF NOT EXISTS idx_mesh_peers_room ON mesh_peers(room_name);
CREATE INDEX IF NOT EXISTS idx_mesh_peers_outbound ON mesh_peers(outbound_status);
CREATE INDEX IF NOT EXISTS idx_mesh_peers_inbound ON mesh_peers(inbound_status);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. MIGRATE OLD DATA (best-effort)
-- ═══════════════════════════════════════════════════════════════════════
-- Old mesh_credentials rows lack remote_peer_id — migrate with placeholder.
-- Admin will need to re-pair for full functionality.
INSERT OR IGNORE INTO mesh_peers
    (id, peer_id, room_name, inbound_token, inbound_status,
     inbound_device_id, inbound_user_id, created_at, updated_at)
SELECT
    id,
    COALESCE(remote_device_id, 'legacy-' || id),  -- Best-effort peer_id
    room_name,
    token,
    'approved',                                      -- Was working before
    remote_device_id,
    remote_user_id,
    created_at,
    updated_at
FROM mesh_credentials;

-- 4. Drop old table
DROP TABLE IF EXISTS mesh_credentials;
```

### Pydantic Models

**`app/shared/contracts/models/mesh.py`** (NEW file — mesh-specific models):

```python
"""Pydantic models for mesh peer management contracts."""
from pydantic import BaseModel, field_validator
from typing import Optional


# ── Peer Info (returned by queries) ──

class MeshPeerInfo(BaseModel):
    """Full peer state as seen from this instance."""
    id: str
    peer_id: str
    node_name: str
    room_name: str
    ip: str | None = None
    port: int | None = None

    # Outbound: what WE granted to THEM
    outbound_status: str                    # pending | approved | denied
    outbound_permissions: list[str] = []
    outbound_approved_at: str | None = None
    outbound_approved_by: str | None = None

    # Inbound: what THEY granted to US
    inbound_status: str                     # unknown | pending | approved | denied
    inbound_permissions: list[str] = []
    inbound_approved_at: str | None = None

    # Connection state
    connection_status: str                  # connected | disconnected
    first_seen_at: str
    last_seen_at: str | None = None
    last_status_change_at: str


# ── List Peers ──

class MeshPeerListRequest(BaseModel):
    room_name: str | None = None            # Filter by room
    outbound_status: str | None = None      # Filter: pending, approved, denied
    include_disconnected: bool = True

class MeshPeerListResponse(BaseModel):
    peers: list[MeshPeerInfo]
    total: int


# ── Get Single Peer ──

class MeshPeerGetRequest(BaseModel):
    peer_id: str
    room_name: str | None = None

class MeshPeerGetResponse(BaseModel):
    peer: MeshPeerInfo | None = None


# ── Approve Peer (set outbound to approved + permissions) ──

class MeshPeerApproveRequest(BaseModel):
    peer_id: str
    permissions: list[str]
    approved_by: str | None = None          # Admin username

    @field_validator("permissions", mode="before")
    @classmethod
    def validate_permissions(cls, v):
        from app.shared.auth.permissions import validate_permission
        return [validate_permission(p) for p in v]


# ── Deny Peer ──

class MeshPeerDenyRequest(BaseModel):
    peer_id: str


# ── Update Permissions (change outbound perms for an already-approved peer) ──

class MeshPeerUpdatePermissionsRequest(BaseModel):
    peer_id: str
    permissions: list[str]                  # Replaces existing set entirely

    @field_validator("permissions", mode="before")
    @classmethod
    def validate_permissions(cls, v):
        from app.shared.auth.permissions import validate_permission
        return [validate_permission(p) for p in v]


# ── Remove Peer ──

class MeshPeerRemoveRequest(BaseModel):
    peer_id: str
    revoke_token: bool = True               # Also revoke token we issued


# ── Save/Load Inbound Credential (used internally by pairing flow) ──

class MeshPeerSaveInboundRequest(BaseModel):
    """Save the token a remote peer issued to US."""
    remote_peer_id: str
    room_name: str
    token: str
    permissions: list[str] = []
    remote_device_id: str | None = None
    remote_user_id: str | None = None
    remote_node_name: str | None = None

class MeshPeerLoadInboundRequest(BaseModel):
    """Load saved inbound tokens for reconnection."""
    room_name: str
    remote_peer_id: str | None = None       # None = all peers in room

class MeshPeerLoadInboundResponse(BaseModel):
    """Map of remote_peer_id → inbound_token."""
    credentials: dict[str, str] = {}        # peer_id → token


# ── Upsert Peer Record (create or update on discovery) ──

class MeshPeerUpsertRequest(BaseModel):
    peer_id: str
    room_name: str
    node_name: str = ""
    ip: str | None = None
    port: int | None = None

class MeshPeerUpdateConnectionRequest(BaseModel):
    peer_id: str
    connection_status: str                  # connected | disconnected
```

### Auth Manager — DB Operations

**`app/services/auth/auth_manager.py`** — New methods for `mesh_peers` CRUD:

```python
async def upsert_mesh_peer(self, peer_id: str, room_name: str,
                            node_name: str = "", ip: str | None = None,
                            port: int | None = None) -> str:
    """Create or update a mesh_peers row on peer discovery. Returns row id."""
    import uuid as _uuid
    row_id = str(_uuid.uuid4())
    await self.db.execute(
        """INSERT INTO mesh_peers (id, peer_id, room_name, node_name, ip, port)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(peer_id, room_name) DO UPDATE SET
             node_name = COALESCE(NULLIF(excluded.node_name, ''), mesh_peers.node_name),
             ip = COALESCE(excluded.ip, mesh_peers.ip),
             port = COALESCE(excluded.port, mesh_peers.port),
             last_seen_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP""",
        (row_id, peer_id, room_name, node_name, ip, port),
    )
    return row_id

async def list_mesh_peers(self, room_name: str | None = None,
                           outbound_status: str | None = None,
                           include_disconnected: bool = True) -> list[dict]:
    """List all known mesh peers with optional filters."""
    query = "SELECT * FROM mesh_peers WHERE 1=1"
    params = []
    if room_name:
        query += " AND room_name = ?"
        params.append(room_name)
    if outbound_status:
        query += " AND outbound_status = ?"
        params.append(outbound_status)
    if not include_disconnected:
        query += " AND connection_status = 'connected'"
    query += " ORDER BY last_seen_at DESC"
    return await self.db.fetch_all(query, tuple(params))

async def get_mesh_peer(self, peer_id: str, room_name: str | None = None) -> dict | None:
    """Get a single mesh peer by peer_id."""
    if room_name:
        return await self.db.fetch_one(
            "SELECT * FROM mesh_peers WHERE peer_id = ? AND room_name = ?",
            (peer_id, room_name),
        )
    return await self.db.fetch_one(
        "SELECT * FROM mesh_peers WHERE peer_id = ? ORDER BY last_seen_at DESC LIMIT 1",
        (peer_id,),
    )

async def approve_mesh_peer(self, peer_id: str, permissions: list[str],
                              approved_by: str | None = None) -> bool:
    """Set outbound_status=approved with permissions. Returns True if row existed."""
    import json
    result = await self.db.execute(
        """UPDATE mesh_peers SET
             outbound_status = 'approved',
             outbound_permissions = ?,
             outbound_approved_at = CURRENT_TIMESTAMP,
             outbound_approved_by = ?,
             last_status_change_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE peer_id = ?""",
        (json.dumps(permissions), approved_by, peer_id),
    )
    return result.rowcount > 0

async def deny_mesh_peer(self, peer_id: str) -> bool:
    """Set outbound_status=denied."""
    result = await self.db.execute(
        """UPDATE mesh_peers SET
             outbound_status = 'denied',
             last_status_change_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE peer_id = ?""",
        (peer_id,),
    )
    return result.rowcount > 0

async def update_mesh_peer_permissions(self, peer_id: str,
                                        permissions: list[str]) -> bool:
    """Update outbound permissions for an already-approved peer."""
    import json
    result = await self.db.execute(
        """UPDATE mesh_peers SET
             outbound_permissions = ?,
             updated_at = CURRENT_TIMESTAMP
           WHERE peer_id = ? AND outbound_status = 'approved'""",
        (json.dumps(permissions), peer_id),
    )
    return result.rowcount > 0

async def remove_mesh_peer(self, peer_id: str) -> bool:
    """Delete a mesh peer record entirely."""
    result = await self.db.execute(
        "DELETE FROM mesh_peers WHERE peer_id = ?",
        (peer_id,),
    )
    return result.rowcount > 0

async def save_inbound_credential(self, remote_peer_id: str, room_name: str,
                                    token: str, permissions: list[str] | None = None,
                                    remote_device_id: str | None = None,
                                    remote_user_id: str | None = None,
                                    remote_node_name: str | None = None) -> None:
    """Save the token a remote peer issued to us (inbound side)."""
    import json
    perms_json = json.dumps(permissions or [])
    await self.db.execute(
        """UPDATE mesh_peers SET
             inbound_status = 'approved',
             inbound_token = ?,
             inbound_permissions = ?,
             inbound_device_id = ?,
             inbound_user_id = ?,
             inbound_approved_at = CURRENT_TIMESTAMP,
             node_name = COALESCE(NULLIF(?, ''), node_name),
             last_status_change_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE peer_id = ? AND room_name = ?""",
        (token, perms_json, remote_device_id, remote_user_id,
         remote_node_name, remote_peer_id, room_name),
    )

async def load_inbound_credentials(self, room_name: str,
                                     remote_peer_id: str | None = None) -> dict[str, str]:
    """Load inbound tokens for reconnection. Returns {peer_id: token}."""
    if remote_peer_id:
        row = await self.db.fetch_one(
            """SELECT peer_id, inbound_token FROM mesh_peers
               WHERE room_name = ? AND peer_id = ? AND inbound_token IS NOT NULL""",
            (room_name, remote_peer_id),
        )
        return {row["peer_id"]: row["inbound_token"]} if row else {}
    rows = await self.db.fetch_all(
        """SELECT peer_id, inbound_token FROM mesh_peers
           WHERE room_name = ? AND inbound_token IS NOT NULL""",
        (room_name,),
    )
    return {r["peer_id"]: r["inbound_token"] for r in rows}

async def update_peer_connection_status(self, peer_id: str, status: str) -> None:
    """Update connection_status and last_seen_at."""
    await self.db.execute(
        """UPDATE mesh_peers SET
             connection_status = ?,
             last_seen_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE peer_id = ?""",
        (status, peer_id),
    )
```

### GatewayService — Loading Per-Peer Credentials on Startup

**`app/services/gateway/service.py`**:
```python
# In _start_mesh(), replace single-token load with per-peer load:
async def _load_mesh_credentials(self, room_name: str) -> dict[str, str]:
    """Load all saved inbound mesh tokens for this room, keyed by remote_peer_id."""
    resp = await self.bus.request(
        "Mesh.LoadInboundCredentials",
        MeshPeerLoadInboundRequest(room_name=room_name),
        timeout=5.0,
    )
    return resp.credentials  # dict[remote_peer_id, token]

# Pass to RTCClient:
self._rtc_client.set_saved_credentials(credentials)  # dict[peer_id, token]
```

### RTCClient — Per-Peer Token Storage

**`app/services/gateway/webrtc/rtc_client.py`**:
```python
# BEFORE
self._saved_auth_token: str | None = None

# AFTER
self._saved_credentials: dict[str, str] = {}  # remote_peer_id → inbound_token

def set_saved_credentials(self, creds: dict[str, str]) -> None:
    self._saved_credentials = creds

# In setup_channel.on_open:
if peer in self._saved_credentials:
    token = self._saved_credentials[peer]
    chan.send(json.dumps({
        "type": "auth",
        "peer_name": self._peer_id,
        "node_name": self._node_name,
        "token": token,
    }))
elif is_initiator:
    # Start bilateral pairing
    await self._initiate_bilateral_pairing(peer, chan)
```

### RTCClient — Connection Status Updates

```python
# When DataChannel opens:
await self._update_peer_connection("connected", peer)

# When peer disconnects:
await self._update_peer_connection("disconnected", peer)

async def _update_peer_connection(self, status: str, peer: str) -> None:
    """Update mesh_peers connection_status via bus."""
    await self._bus.publish(
        "Mesh.UpdatePeerConnection",
        MeshPeerUpdateConnectionRequest(peer_id=peer, connection_status=status),
        event=False,
        priority=50,
    )
```

### What the `mesh_peers` Table Looks Like in Practice

After a full bilateral pairing between office-pc and living-room:

**On office-pc's DB:**
```
┌────────────┬──────────────┬──────────────┬───────────┬──────────────────────┬───────────┬──────────────────┬────────────────┐
│ peer_id    │ node_name    │ room_name    │ outbound  │ outbound_permissions │ inbound   │ inbound_token    │ connection     │
│            │              │              │ _status   │                      │ _status   │                  │ _status        │
├────────────┼──────────────┼──────────────┼───────────┼──────────────────────┼───────────┼──────────────────┼────────────────┤
│ uuid-lr-.. │ living-room  │ aurora-37f.. │ approved  │ ["tts.*","stt.*"]    │ approved  │ tok_abc123...    │ connected      │
└────────────┴──────────────┴──────────────┴───────────┴──────────────────────┴───────────┴──────────────────┴────────────────┘
```

**On living-room's DB:**
```
┌────────────┬──────────────┬──────────────┬───────────┬──────────────────────┬───────────┬──────────────────┬────────────────┐
│ peer_id    │ node_name    │ room_name    │ outbound  │ outbound_permissions │ inbound   │ inbound_token    │ connection     │
│            │              │              │ _status   │                      │ _status   │                  │ _status        │
├────────────┼──────────────┼──────────────┼───────────┼──────────────────────┼───────────┼──────────────────┼────────────────┤
│ uuid-op-.. │ office-pc    │ aurora-37f.. │ approved  │ ["orchestrator.*"]   │ approved  │ tok_xyz789...    │ connected      │
└────────────┴──────────────┴──────────────┴───────────┴──────────────────────┴───────────┴──────────────────┴────────────────┘
```

Note the asymmetry: office-pc granted `tts.*, stt.*` to living-room, but living-room only granted `orchestrator.*` to office-pc. Each admin made an independent decision.

---

## Fix 4 — Mutual Approval Is the Default ✅ IMPLEMENTED

### Problem (from the old plan)
The old plan proposed auto-approving the reverse pairing. This is **wrong** because each peer must independently decide what permissions to grant. Auto-approve would grant `default_device_permissions` without the admin's input.

### Corrected Design
**Both phases ALWAYS require human approval.** There is no auto-approve. Each admin:
1. Sees a pairing request from the remote peer
2. Decides which permissions to grant (or deny entirely)
3. Explicitly approves with their chosen permission set

This is already handled by Fix 2's bilateral flow. The approval mechanism is the **existing `Auth.PairingApprove` contract** plus the new **Peer Management API** (Fix 9).

### Graceful Degradation
The system supports asymmetric approval:

| Forward Approved? | Reverse Approved? | Result |
|:-:|:-:|---|
| ✅ | ✅ | Full bilateral mesh. Both peers access each other's services. |
| ✅ | ❌/pending | Initiator can access Responder's services. Responder cannot access Initiator's. |
| ❌ | N/A | Pairing fails entirely. No trust established. |

### Indefinite Pending State

**Peer records NEVER expire from the DB.** If one admin approved but the other didn't:
1. The `mesh_peers` row persists with `outbound_status = 'pending'`
2. The admin can approve at any time via `POST /mesh/peers/{peer_id}/approve`
3. On next WebRTC connection, the approved credentials are exchanged automatically
4. The pairing CODE expires (5 min security window), but the peer RELATIONSHIP is permanent

### No Code Changes Beyond Fix 2
Fix 4 is a **design clarification**, not additional code. The bilateral flow in Fix 2 already requires both admins to approve via `Auth.PairingApprove` or the Peer Management API. The `auto_approve_for_peer` concept from the old plan is **deleted entirely**.

---

## Fix 5 — Smart Pairing Timeout ✅ IMPLEMENTED

### Problem
`_auth_timeout_check()` extends the timeout once by `_pairing_timeout - _auth_timeout` seconds. If the admin takes longer, the peer disconnects.

### Solution
Replace the fixed extension with a **heartbeat loop** that keeps the timeout alive as long as the pairing code exists and is not expired in the remote AuthManager.

### Changes

**`app/services/gateway/webrtc/rtc_client.py`** — Replace `_auth_timeout_check`:

```python
async def _auth_timeout_check(peer: str) -> None:
    """Auth timeout with indefinite pairing extension.

    While the peer is in active pairing, we poll and never timeout.
    Once pairing completes or the code expires, normal timeout applies.
    """
    await asyncio.sleep(self._auth_timeout)

    if peer not in self._pcs:
        return

    identity = self._peer_acl.get(peer, ANONYMOUS)
    if identity != ANONYMOUS:
        return  # Already authenticated

    if peer not in self._peer_pairing_active:
        # Not pairing → hard timeout
        log_warning(f"Peer {self._peer_label(peer)} did not authenticate within {self._auth_timeout}s")
        await self._audit("peer.auth_timeout", details={"peer_id": peer})
        chan.close()
        return

    # Pairing is active — extend indefinitely via heartbeat
    log_info(f"Peer {self._peer_label(peer)} is in pairing flow — timeout suspended")
    heartbeat = 10.0  # Check every 10s
    while peer in self._pcs and peer in self._peer_pairing_active:
        await asyncio.sleep(heartbeat)
        identity = self._peer_acl.get(peer, ANONYMOUS)
        if identity != ANONYMOUS:
            return  # Authenticated during wait

    # Pairing ended but still not authenticated
    if peer in self._pcs:
        identity = self._peer_acl.get(peer, ANONYMOUS)
        if identity == ANONYMOUS:
            log_warning(f"Peer {self._peer_label(peer)} pairing ended without authentication")
            await self._audit("peer.pairing_failed", details={"peer_id": peer})
            chan.close()
```

### Interaction with Persistent Peer Records

Even if the WebRTC connection closes due to timeout, the `mesh_peers` DB row persists. When the remote peer reconnects:
- If the admin approved via the Peer Management API while the peer was disconnected, the approval is already in the DB
- The new connection picks up the approved state and exchanges credentials immediately
- No new pairing code needed — the approval is durable

---

## Fix 6 — Node Name in Logs & Presence ✅ IMPLEMENTED

### Problem
- MQTT presence only carries `{type, app_id, room, peer_id}` — no human-readable name
- All logs show `peer[:8]` UUIDs which are meaningless to operators
- No way to correlate a UUID with a configured node name

### Solution
1. Add `node_name` to MQTT presence payload
2. Store `(peer_id → node_name)` mapping in RTCClient and PeerRegistry
3. Create a `_peer_label(peer_id)` helper for log messages
4. Include node_name in `mesh_peers` DB for offline reference

### Changes

**`app/services/gateway/config.py`** — Ensure `node_name` is in config:
```python
class MeshConfig:
    node_name: str = ""  # Human-readable name (e.g., "living-room", "office")
```

**`app/services/gateway/webrtc/rtc_client.py`** — Presence and logging:

```python
# 1. Add node_name to presence
def _publish_presence(self):
    presence_msg = {
        "type": "presence",
        "app_id": app_id,
        "room": room,
        "peer_id": peer_id,
        "node_name": self._node_name,  # NEW
    }

# 2. Store node_name on receipt and update DB
async def _on_presence(self, msg):
    remote_peer = msg.get("peer_id")
    node_name = msg.get("node_name", "")
    if node_name:
        self._peer_names[remote_peer] = node_name
    # Also upsert the mesh_peers row so node_name is in DB
    await self._ensure_peer_record(remote_peer, node_name=node_name)

# 3. Helper for log messages
def _peer_label(self, peer_id: str) -> str:
    """Return 'node_name (peer_id[:8])' or just 'peer_id[:8]'."""
    name = self._peer_names.get(peer_id, "")
    short = peer_id[:8]
    return f"{name} ({short})" if name else short

# 4. Auth message includes node_name
auth_msg = {
    "type": "auth",
    "peer_name": self._peer_id,
    "node_name": self._node_name,  # NEW
    "token": token,
}
```

**`app/services/gateway/mesh/models.py`** — PeerState gets node_name:
```python
@dataclass
class PeerState:
    peer_id: str
    node_name: str = ""  # NEW
    # ... existing fields
```

### Log Before/After

```
# BEFORE
INFO  DataChannel 'aurora-rpc' open with peer a1b2c3d4…
INFO  Pairing approved by peer a1b2c3d4…

# AFTER
INFO  DataChannel 'aurora-rpc' open with peer office-pc (a1b2c3d4)
INFO  Pairing approved by peer office-pc (a1b2c3d4)
```

---

## Fix 7 — Typed Permissions ✅ IMPLEMENTED

### Problem
`permissions: list[str]` in all Pydantic models accepts arbitrary strings. No compile-time or runtime validation. Swagger docs show no enum.

### Solution
1. Define well-known permissions as constants (already partially exists in `permissions.py`)
2. Create a `validate_permission()` function with Pydantic integration
3. Add a `KNOWN_PERMISSIONS` registry for documentation and soft validation
4. Allow wildcards (`TTS.*`) but validate prefixes against known modules

### Changes

**`app/shared/auth/permissions.py`** — Expand known permissions:
```python
# Well-known permission constants (extend existing)
PERM_ALL = "*"
PERM_AUTH_MANAGE = "auth.manage"
PERM_AUTH_APPROVE = "auth.approve"
PERM_AUTH_AUDIT = "auth.audit"
PERM_SYSTEM_CONTROL = "system.control"

# NEW: Complete registry of known permissions
KNOWN_PERMISSION_PREFIXES = {
    "auth",       # auth.manage, auth.approve, auth.audit
    "tts",        # tts.request, tts.stop, etc.
    "stt",        # stt.start, stt.stop, etc.
    "orchestrator", # orchestrator.query, etc.
    "db",         # db.read, db.write, etc.
    "config",     # config.read, config.write
    "system",     # system.control, system.restart
    "gateway",    # gateway.mesh, gateway.api
    "tooling",    # tooling.execute, tooling.list
    "scheduler",  # scheduler.create, scheduler.delete
    "mesh",       # mesh.list, mesh.approve, mesh.manage
}

KNOWN_PERMISSIONS = {
    "*",
    "auth.manage", "auth.approve", "auth.audit",
    "tts.request", "tts.stop", "tts.pause", "tts.resume", "tts.*",
    "stt.start", "stt.stop", "stt.*",
    "orchestrator.query", "orchestrator.*",
    "db.read", "db.write", "db.*",
    "config.read", "config.write", "config.*",
    "system.control", "system.restart", "system.*",
    "gateway.mesh", "gateway.api", "gateway.*",
    "tooling.execute", "tooling.list", "tooling.*",
    "scheduler.create", "scheduler.delete", "scheduler.*",
    "mesh.list", "mesh.approve", "mesh.manage", "mesh.*",
}


def validate_permission(perm: str) -> str:
    """Validate a permission string. Returns the permission if valid, raises ValueError otherwise."""
    if perm == PERM_ALL:
        return perm
    if perm in KNOWN_PERMISSIONS:
        return perm
    # Check if prefix is known (for new specific permissions under a known prefix)
    prefix = perm.split(".")[0].lower()
    if prefix in KNOWN_PERMISSION_PREFIXES:
        return perm
    raise ValueError(
        f"Unknown permission '{perm}'. Must start with a known prefix: "
        f"{sorted(KNOWN_PERMISSION_PREFIXES)} or be a known permission."
    )
```

**`app/shared/contracts/models/auth.py`** — Add Pydantic validator:
```python
from pydantic import field_validator

class PairingApproveRequest(BaseModel):
    code: str
    permissions: list[str] | None = None
    is_admin: bool = False

    @field_validator("permissions", mode="before")
    @classmethod
    def validate_permissions(cls, v):
        if v is None:
            return v
        from app.shared.auth.permissions import validate_permission
        return [validate_permission(p) for p in v]
```

---

## Fix 8 — Audit Proxy Fix ✅ IMPLEMENTED

### Problem
`_AuditDBProxy` in `auth_proxy.py` does not implement `store_audit_event()`. The `audit_event()` function in `audit.py` calls `db_manager.store_audit_event()` which raises `AttributeError`, silently caught by `contextlib.suppress(Exception)` in RTCClient's `_audit()`.

### Solution
Route audit events through the message bus instead of direct DB calls.

### Changes

**`app/services/gateway/auth_proxy.py`** — Fix `_AuditDBProxy`:

```python
class _AuditDBProxy:
    """Minimal proxy that routes audit events through the bus."""

    def __init__(self, bus: MessageBus) -> None:
        self._bus = bus

    async def store_audit_event(
        self, event: str, principal_id: str | None = None,
        details: dict | None = None, ip: str | None = None
    ) -> None:
        """Route audit event to the DB service via bus."""
        from app.shared.contracts.models.db import DBStoreAuditEventRequest, DBMethods
        await self._bus.publish(
            DBMethods.STORE_AUDIT_EVENT,
            DBStoreAuditEventRequest(
                event=event,
                principal_id=principal_id,
                details=details or {},
                ip=ip,
            ),
            event=False,
            priority=50,
        )
```

---

## Fix 9 — Peer Management API ✅ IMPLEMENTED

### Problem
There is no way to:
- List all known mesh peers with their status, permissions, and connection state
- Approve a pending peer after the initial pairing code expires
- Update permissions for an already-approved peer
- Deny or remove a peer
- View the full bilateral relationship state

Admins are currently blind to the mesh state and have no post-pairing management.

### Solution
Add a **Peer Management API** exposed via the Gateway HTTP router with full CRUD operations on the `mesh_peers` table.

### Method Contracts

**`app/services/auth/service.py`** — New mesh peer management contracts:

```python
# ── List Peers ──
@method_contract(
    method_id="Mesh.ListPeers",
    summary="List all known mesh peers with status, permissions, and connection state",
    input_model=MeshPeerListRequest,
    output_model=MeshPeerListResponse,
    exposure="both",
    default_priority=50,
)
async def list_mesh_peers(self, envelope: Envelope) -> None:
    req = envelope.payload
    rows = await self.auth_manager.list_mesh_peers(
        room_name=req.room_name,
        outbound_status=req.outbound_status,
        include_disconnected=req.include_disconnected,
    )
    peers = [self._row_to_peer_info(r) for r in rows]
    await self.bus.publish(
        envelope.reply_to,
        MeshPeerListResponse(peers=peers, total=len(peers)),
        event=False,
    )

# ── Get Single Peer ──
@method_contract(
    method_id="Mesh.GetPeer",
    summary="Get detailed information about a specific mesh peer",
    input_model=MeshPeerGetRequest,
    output_model=MeshPeerGetResponse,
    exposure="both",
    default_priority=50,
)
async def get_mesh_peer(self, envelope: Envelope) -> None:
    req = envelope.payload
    row = await self.auth_manager.get_mesh_peer(req.peer_id, req.room_name)
    peer = self._row_to_peer_info(row) if row else None
    await self.bus.publish(
        envelope.reply_to,
        MeshPeerGetResponse(peer=peer),
        event=False,
    )

# ── Approve Peer ──
@method_contract(
    method_id="Mesh.ApprovePeer",
    summary="Approve a pending peer and set outbound permissions",
    input_model=MeshPeerApproveRequest,
    output_model=None,
    exposure="both",
    default_priority=10,
)
async def approve_mesh_peer(self, envelope: Envelope) -> None:
    req = envelope.payload
    success = await self.auth_manager.approve_mesh_peer(
        peer_id=req.peer_id,
        permissions=req.permissions,
        approved_by=req.approved_by,
    )
    if success:
        # Publish event so RTCClient can issue the token on next connection
        await self.bus.publish(
            "Mesh.PeerApproved",
            MeshPeerApprovedEvent(
                peer_id=req.peer_id,
                permissions=req.permissions,
            ),
            event=True,
            mesh=False,
            origin="internal",
        )

# ── Deny Peer ──
@method_contract(
    method_id="Mesh.DenyPeer",
    summary="Deny a pending peer",
    input_model=MeshPeerDenyRequest,
    output_model=None,
    exposure="both",
    default_priority=10,
)
async def deny_mesh_peer(self, envelope: Envelope) -> None:
    req = envelope.payload
    await self.auth_manager.deny_mesh_peer(req.peer_id)

# ── Update Permissions ──
@method_contract(
    method_id="Mesh.UpdatePeerPermissions",
    summary="Update outbound permissions for an approved peer",
    input_model=MeshPeerUpdatePermissionsRequest,
    output_model=None,
    exposure="both",
    default_priority=10,
)
async def update_mesh_peer_permissions(self, envelope: Envelope) -> None:
    req = envelope.payload
    success = await self.auth_manager.update_mesh_peer_permissions(
        peer_id=req.peer_id,
        permissions=req.permissions,
    )
    if success:
        # Publish event so token scopes can be updated on next connection
        await self.bus.publish(
            "Mesh.PeerPermissionsUpdated",
            MeshPeerPermissionsUpdatedEvent(
                peer_id=req.peer_id,
                permissions=req.permissions,
            ),
            event=True,
            mesh=False,
            origin="internal",
        )

# ── Remove Peer ──
@method_contract(
    method_id="Mesh.RemovePeer",
    summary="Remove a peer record and optionally revoke its token",
    input_model=MeshPeerRemoveRequest,
    output_model=None,
    exposure="both",
    default_priority=10,
)
async def remove_mesh_peer(self, envelope: Envelope) -> None:
    req = envelope.payload
    if req.revoke_token:
        peer = await self.auth_manager.get_mesh_peer(req.peer_id)
        if peer and peer.get("outbound_token_id"):
            await self.auth_manager.revoke_token(peer["outbound_token_id"])
    await self.auth_manager.remove_mesh_peer(req.peer_id)
```

### HTTP Routes

**`app/services/gateway/routes/mesh_routes.py`** (NEW file):

```python
"""HTTP routes for mesh peer management."""
from fastapi import APIRouter, Depends, HTTPException
from app.shared.contracts.models.mesh import (
    MeshPeerListRequest, MeshPeerListResponse,
    MeshPeerGetRequest, MeshPeerGetResponse,
    MeshPeerApproveRequest, MeshPeerDenyRequest,
    MeshPeerUpdatePermissionsRequest, MeshPeerRemoveRequest,
)

router = APIRouter(prefix="/mesh/peers", tags=["Mesh Peers"])


@router.get("/", response_model=MeshPeerListResponse)
async def list_peers(
    room_name: str | None = None,
    status: str | None = None,
    include_disconnected: bool = True,
):
    """List all known mesh peers.

    Returns peer_id, node_name, IP, port, outbound/inbound status,
    permissions, connection state, first_seen, last_seen, and timestamps.
    """
    resp = await bus.request(
        "Mesh.ListPeers",
        MeshPeerListRequest(
            room_name=room_name,
            outbound_status=status,
            include_disconnected=include_disconnected,
        ),
        timeout=5.0,
    )
    return resp


@router.get("/{peer_id}", response_model=MeshPeerGetResponse)
async def get_peer(peer_id: str, room_name: str | None = None):
    """Get detailed information about a specific mesh peer."""
    resp = await bus.request(
        "Mesh.GetPeer",
        MeshPeerGetRequest(peer_id=peer_id, room_name=room_name),
        timeout=5.0,
    )
    if not resp.peer:
        raise HTTPException(status_code=404, detail="Peer not found")
    return resp


@router.post("/{peer_id}/approve", status_code=204)
async def approve_peer(peer_id: str, permissions: list[str], approved_by: str | None = None):
    """Approve a pending peer and set the permissions we grant to them.

    This is the primary mechanism for completing pairing when the admin
    missed the initial pairing code window. The approval persists in DB
    and takes effect on the next WebRTC connection.
    """
    await bus.request(
        "Mesh.ApprovePeer",
        MeshPeerApproveRequest(
            peer_id=peer_id,
            permissions=permissions,
            approved_by=approved_by,
        ),
        timeout=5.0,
    )


@router.post("/{peer_id}/deny", status_code=204)
async def deny_peer(peer_id: str):
    """Deny a pending peer. Can be reversed later by calling approve."""
    await bus.request(
        "Mesh.DenyPeer",
        MeshPeerDenyRequest(peer_id=peer_id),
        timeout=5.0,
    )


@router.patch("/{peer_id}/permissions", status_code=204)
async def update_permissions(peer_id: str, permissions: list[str]):
    """Update the permissions we grant to an already-approved peer.

    Replaces the entire permission set. Takes effect on the next
    connection or token refresh.
    """
    await bus.request(
        "Mesh.UpdatePeerPermissions",
        MeshPeerUpdatePermissionsRequest(
            peer_id=peer_id,
            permissions=permissions,
        ),
        timeout=5.0,
    )


@router.delete("/{peer_id}", status_code=204)
async def remove_peer(peer_id: str, revoke_token: bool = True):
    """Remove a peer record and optionally revoke the token we issued.

    WARNING: This is destructive. The peer will need to re-pair from scratch.
    """
    await bus.request(
        "Mesh.RemovePeer",
        MeshPeerRemoveRequest(peer_id=peer_id, revoke_token=revoke_token),
        timeout=5.0,
    )
```

### Example API Responses

**`GET /mesh/peers/`**:
```json
{
  "peers": [
    {
      "id": "row-uuid-1",
      "peer_id": "a1b2c3d4-...",
      "node_name": "living-room",
      "room_name": "aurora-37fe8117799c19bf",
      "ip": "192.168.1.42",
      "port": 8001,
      "outbound_status": "approved",
      "outbound_permissions": ["tts.*", "stt.*"],
      "outbound_approved_at": "2026-02-15T14:30:00Z",
      "outbound_approved_by": "admin",
      "inbound_status": "approved",
      "inbound_permissions": ["orchestrator.*"],
      "inbound_approved_at": "2026-02-15T14:31:00Z",
      "connection_status": "connected",
      "first_seen_at": "2026-02-15T14:28:00Z",
      "last_seen_at": "2026-02-15T16:45:00Z",
      "last_status_change_at": "2026-02-15T14:31:00Z"
    },
    {
      "id": "row-uuid-2",
      "peer_id": "e5f6g7h8-...",
      "node_name": "bedroom",
      "room_name": "aurora-37fe8117799c19bf",
      "ip": "192.168.1.43",
      "port": 8002,
      "outbound_status": "pending",
      "outbound_permissions": [],
      "outbound_approved_at": null,
      "outbound_approved_by": null,
      "inbound_status": "approved",
      "inbound_permissions": ["tts.request"],
      "inbound_approved_at": "2026-02-16T09:00:00Z",
      "connection_status": "disconnected",
      "first_seen_at": "2026-02-16T08:55:00Z",
      "last_seen_at": "2026-02-16T09:10:00Z",
      "last_status_change_at": "2026-02-16T08:55:00Z"
    }
  ],
  "total": 2
}
```

The second peer (`bedroom`) has `outbound_status: "pending"` — the local admin hasn't approved it yet. The admin can approve anytime via `POST /mesh/peers/e5f6g7h8-.../approve`.

### "Deferred Approval" Flow (Admin Missed the Pairing Window)

```
1. Remote peer "bedroom" connects, initiates pairing
2. Pairing code C1 created, Auth.PairingRequested event fires
3. Admin is AFK — code expires after 5 minutes
4. WebRTC connection may close (timeout)
5. BUT mesh_peers row persists:
   {peer_id: "bedroom-uuid", outbound_status: "pending", ...}

--- Hours later ---

6. Admin opens dashboard, sees pending peer "bedroom"
   GET /mesh/peers/?status=pending
7. Admin approves with permissions:
   POST /mesh/peers/bedroom-uuid/approve
   {"permissions": ["tts.*", "orchestrator.*"]}
8. mesh_peers.outbound_status → "approved"
9. Mesh.PeerApproved event fires

--- Next time bedroom connects ---

10. RTCClient checks DB: outbound_status=approved for bedroom
11. Automatically issues token with approved permissions
12. bedroom authenticates → full bilateral trust
```

---

## Migration & Rollout

### Deployment Order

1. **Database migration first** (`007_mesh_peer_lifecycle.sql`)
   - Creates `mesh_identity` and `mesh_peers` tables
   - Migrates old `mesh_credentials` data (best-effort)
   - Drops old `mesh_credentials` table
2. **Deploy new Pydantic models** (`app/shared/contracts/models/mesh.py`)
3. **Deploy auth service changes** (new mesh peer management contracts + DB operations)
4. **Deploy gateway service changes** (stable peer_id from DB, load per-peer credentials)
5. **Deploy RTCClient changes** (bilateral pairing, smart timeout, node_name, connection tracking)
6. **Deploy HTTP routes** (`mesh_routes.py` registered in gateway router)
7. **Test**: Run bilateral pairing between two instances

### Backward Compatibility

- Old peers without `node_name` in presence → `_peer_names` dict returns `""` → logs fall back to `peer[:8]`
- Old `mesh_credentials` rows migrated best-effort (remote_peer_id falls back to device_id or legacy prefix)
- First restart after migration: peers will re-pair once (expected — old tokens keyed differently)
- After first successful bilateral pairing: all subsequent restarts reconnect from DB-stored tokens

### Testing Plan

| Test | Validates |
|------|-----------|
| **Unit: `test_stable_peer_id_from_db`** | peer_id generated once, stored in mesh_identity, reused on restart |
| **Unit: `test_bilateral_pairing_both_approve`** | Both peers get tokens with independent permission sets |
| **Unit: `test_bilateral_pairing_one_denies`** | Graceful degradation to one-directional trust |
| **Unit: `test_bilateral_pairing_both_deny`** | No trust established; both peers stay ANONYMOUS |
| **Unit: `test_per_peer_credentials`** | Multiple inbound tokens per room stored/loaded from mesh_peers |
| **Unit: `test_pairing_phase_state_machine`** | Correct phase transitions: FORWARD_SENT → FORWARD_DONE → REVERSE → COMPLETE |
| **Unit: `test_smart_timeout`** | Timeout suspended during active pairing, resumes when pairing ends |
| **Unit: `test_typed_permissions`** | Invalid permissions rejected; known permissions accepted |
| **Unit: `test_pairing_requested_event`** | `Auth.PairingRequested` bus event fires with remote_peer_id and node_name |
| **Unit: `test_deferred_approval`** | Admin approves pending peer via API after code expiry; next connection issues token |
| **Integration: `test_restart_reconnect`** | Both peers reconnect without re-pairing (inbound_tokens in mesh_peers) |
| **Integration: `test_mutual_auth`** | Both sides authenticate with their saved inbound tokens |
| **Integration: `test_tiebreaker_stable`** | Same initiator across restarts (stable peer_id from DB) |
| **Integration: `test_asymmetric_permissions`** | Peer A grants TTS.* to B, B grants Orch.* to A — enforced correctly |
| **Integration: `test_peer_management_api`** | GET/POST/PATCH/DELETE on /mesh/peers/ work end-to-end |
| **Integration: `test_partial_approval_persists`** | Phase 1 completes, Phase 2 admin ignores; restart; admin approves via API; reconnect completes |
| **E2E: `test_full_mesh_lifecycle`** | Discover → pair (both approve) → restart → reconnect → manifests → commands |
| **E2E: `test_deferred_bilateral_pairing`** | Pair Phase 1 → restart → admin approves Phase 2 via API → reconnect → full trust |

---

## File Change Summary

| File | Changes | Priority |
|------|---------|----------|
| **`app/services/db/migrations/007_mesh_peer_lifecycle.sql`** | NEW: `mesh_identity` + `mesh_peers` tables, migrate old `mesh_credentials`, drop old table | **P0** |
| **`app/shared/contracts/models/mesh.py`** | NEW: All Pydantic models for mesh peer management (MeshPeerInfo, List/Get/Approve/Deny/Update/Remove requests) | **P0** |
| **`app/services/gateway/webrtc/rtc_client.py`** | Accept peer_id param, per-peer saved_credentials dict, bilateral pairing (`_initiate_bilateral_pairing`, `_on_peer_authenticated`, `_do_reverse_pairing`, `_do_pairing_exchange`), `PairingPhase` enum, smart timeout, node_name in presence/auth/logs, `_peer_label()`, connection status updates via bus, `_ensure_peer_record()`, `_save_inbound_credential()` | **P0** |
| **`app/services/gateway/service.py`** | Load peer_id from DB (`_get_or_create_peer_id`), load per-peer inbound credentials, pass credentials dict to RTCClient | **P0** |
| **`app/services/auth/auth_manager.py`** | All `mesh_peers` CRUD: `upsert_mesh_peer`, `list_mesh_peers`, `get_mesh_peer`, `approve_mesh_peer`, `deny_mesh_peer`, `update_mesh_peer_permissions`, `remove_mesh_peer`, `save_inbound_credential`, `load_inbound_credentials`, `update_peer_connection_status`, `load_mesh_identity`, `save_mesh_identity` | **P0** |
| **`app/services/auth/service.py`** | New contracts: `Auth.LoadMeshIdentity`, `Auth.SaveMeshIdentity`, `Mesh.ListPeers`, `Mesh.GetPeer`, `Mesh.ApprovePeer`, `Mesh.DenyPeer`, `Mesh.UpdatePeerPermissions`, `Mesh.RemovePeer`, `Mesh.LoadInboundCredentials`, `Mesh.SaveInboundCredential`, `Mesh.UpdatePeerConnection`, `Mesh.UpsertPeer` | **P0** |
| **`app/services/gateway/routes/mesh_routes.py`** | NEW: HTTP routes for peer management — `GET /mesh/peers/`, `GET /mesh/peers/{id}`, `POST .../approve`, `POST .../deny`, `PATCH .../permissions`, `DELETE ...` | **P1** |
| **`app/shared/auth/permissions.py`** | `KNOWN_PERMISSIONS` registry, `KNOWN_PERMISSION_PREFIXES`, `validate_permission()` | **P1** |
| **`app/shared/contracts/models/auth.py`** | `MeshIdentityLoad/SaveRequest`, `PairingRequestedEvent`, `MeshPeerApprovedEvent`, `MeshPeerPermissionsUpdatedEvent`, permission validators | **P1** |
| **`app/services/gateway/config.py`** | `MeshConfig.node_name`, remove `MeshConfig.peer_id` (now in DB) | **P1** |
| **`app/services/gateway/mesh/models.py`** | `PeerState.node_name` field | **P2** |
| **`app/services/gateway/mesh/peer_registry.py`** | `register_peer()` accepts node_name | **P2** |
| **`app/services/gateway/auth_proxy.py`** | `_AuditDBProxy.store_audit_event()` implementation via bus | **P2** |
| **`app/services/gateway/mesh/negotiation.py`** | No changes — "unused" behavior is correct given `prefer: local` routing config | — |

### Priority Legend
- **P0**: Must fix — directly causes re-pairing bug, enables bilateral pairing and DB persistence
- **P1**: Should fix — completes the model (HTTP API, typed permissions, logging)
- **P2**: Nice to have — improves DX and security

---

## Implementation Sequence

```
Phase 1 (P0 — Fix the deadlock + DB-backed peer lifecycle):
  ├─ Migration 007: mesh_identity + mesh_peers tables
  ├─ Fix 1: Stable peer_id (DB-backed via mesh_identity)
  ├─ Fix 3: mesh_peers CRUD in AuthManager + contracts
  ├─ Fix 2: Bilateral pairing (both admins approve, state in mesh_peers)
  └─ Update GatewayService + RTCClient to use mesh_peers

Phase 2 (P1 — Complete the model):
  ├─ Fix 9: Peer Management API (HTTP routes + contracts)
  ├─ Fix 6: Node name in logs & presence
  ├─ Fix 7: Typed permissions
  └─ Fix 4: (Design only — mutual approval inherent in Fix 2)

Phase 3 (P2 — Polish):
  ├─ Fix 5: Smart pairing timeout
  └─ Fix 8: Audit proxy fix
```

---

## Note on "unused" Services in Manifest ACK

The log showing `unused=['TTS', 'Orchestrator', 'Transcription']` is **NOT a bug**. It's the correct behavior given both peers' routing config:

```json
// Both peers have:
"routing": {
  "TTS": { "prefer": "local" },
  "Orchestrator": { "prefer": "local" },
  "Transcription": { "prefer": "local" }
}
```

`negotiation.py`'s `generate_manifest_ack()` correctly puts services in `unused` when `routing_config.prefer` is `"local"` or `"local_only"`. To actually USE remote services, change the consumer's routing to:
```json
"TTS": { "prefer": "network", "fallback": "local" }
```

This is an operator configuration choice, not a code fix.
