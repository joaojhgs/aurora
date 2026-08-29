PRAGMA foreign_keys = ON;

CREATE TABLE aurora_local_tool_state (
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  tool_contract_id TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  descriptor_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  settings_envelope_json TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, local_node_id, tool_contract_id)
);

CREATE INDEX idx_aurora_local_tools_profile_node_enabled
  ON aurora_local_tool_state (profile_id, local_node_id, enabled);
