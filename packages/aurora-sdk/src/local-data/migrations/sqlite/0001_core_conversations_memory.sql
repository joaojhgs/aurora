PRAGMA foreign_keys = ON;

CREATE TABLE aurora_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE aurora_database_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  local_node_id TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE aurora_storage_meta (
  profile_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (profile_id, key)
);

CREATE TABLE aurora_conversations (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  title_envelope_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER
);

CREATE TABLE aurora_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL
    REFERENCES aurora_conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content_envelope_json TEXT,
  tool_envelope_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed', 'cancelled')),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE aurora_memory_items (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  payload_envelope_json TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER
);

CREATE INDEX idx_aurora_conversations_profile_node_updated
  ON aurora_conversations (profile_id, local_node_id, updated_at_ms DESC);

CREATE INDEX idx_aurora_memory_profile_node_namespace_expiry
  ON aurora_memory_items (profile_id, local_node_id, namespace, expires_at_ms);
