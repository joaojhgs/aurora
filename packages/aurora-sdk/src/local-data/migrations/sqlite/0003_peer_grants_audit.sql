PRAGMA foreign_keys = ON;

CREATE TABLE aurora_peer_grant_metadata (
  grant_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  claimant_peer_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  scope_envelope_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  revoked_at_ms INTEGER
);

CREATE TABLE aurora_local_audit (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  peer_id TEXT,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  result_status TEXT NOT NULL,
  connection_epoch TEXT,
  method_id TEXT,
  tool_contract_id TEXT,
  correlation_id TEXT,
  redacted_detail_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_aurora_grants_profile_node_claimant_active
  ON aurora_peer_grant_metadata (profile_id, local_node_id, claimant_peer_id, token_id, revoked_at_ms, expires_at_ms);

CREATE INDEX idx_aurora_audit_profile_node_created
  ON aurora_local_audit (profile_id, local_node_id, created_at_ms DESC);
