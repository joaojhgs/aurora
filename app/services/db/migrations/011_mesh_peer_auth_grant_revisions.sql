-- Migration 011: Durable per-peer mesh authority revisions
--
-- One stable peer can have multiple mesh_peers rows (one per signaling room),
-- so the monotonic authority generation cannot live on those rows.  This
-- table deliberately has no foreign key to mesh_peers: a removal leaves a
-- tombstone whose revision prevents delayed pre-removal events from becoming
-- current after the peer is discovered again.

CREATE TABLE IF NOT EXISTS mesh_peer_auth_grant_revisions (
    peer_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    disposition TEXT NOT NULL DEFAULT 'present'
        CHECK (disposition IN ('present', 'removed')),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO mesh_peer_auth_grant_revisions (
    peer_id,
    revision,
    disposition,
    updated_at
)
SELECT DISTINCT
    peer_id,
    0,
    'present',
    CURRENT_TIMESTAMP
FROM mesh_peers;
