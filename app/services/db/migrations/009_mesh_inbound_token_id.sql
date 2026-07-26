-- Migration 009: Persist public token selectors for mesh reconnect proofs
-- The bearer remains encrypted in inbound_token. token_id is a non-secret
-- selector that lets the issuing peer locate its stored token hash without the
-- bearer ever crossing the DataChannel again.

ALTER TABLE mesh_peers ADD COLUMN inbound_token_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mesh_peers_inbound_token_id
    ON mesh_peers(inbound_token_id);
