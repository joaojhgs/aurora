-- Migration 006: Mesh credentials table
-- Created at: 2026-02-10
-- Purpose: Store outbound authentication tokens received from remote mesh peers
-- after a successful pairing exchange, so this instance can re-authenticate
-- on reconnect without re-pairing.

CREATE TABLE IF NOT EXISTS mesh_credentials (
    id TEXT PRIMARY KEY,
    room_name TEXT NOT NULL UNIQUE,           -- WebRTC room used to reach the peer
    token TEXT NOT NULL,                       -- Plaintext token received from remote peer
    remote_device_id TEXT,                     -- Device ID assigned by the remote peer
    remote_user_id TEXT,                       -- User ID assigned by the remote peer
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mesh_credentials_room ON mesh_credentials(room_name);
