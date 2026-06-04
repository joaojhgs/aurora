-- Migration 007: Mesh peer lifecycle tables
-- Created at: 2026-02-21
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
    inbound_token TEXT,                                  -- Token THEY issued to US (encrypted at rest
                                                        -- via AuthManager using gateway.token_secret)
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
