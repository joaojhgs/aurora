PRAGMA foreign_keys = ON;

CREATE TABLE aurora_transcript_sessions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  local_node_id TEXT NOT NULL,
  capture_mode TEXT NOT NULL CHECK (capture_mode IN ('ambient', 'notification')),
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'completed', 'interrupted', 'failed')),
  terminal_reason TEXT,
  expires_at_ms INTEGER,
  language TEXT,
  model_provenance_json TEXT NOT NULL,
  diarization_state TEXT NOT NULL CHECK (diarization_state IN ('not_requested', 'pending', 'available', 'unavailable')),
  CHECK (started_at_ms >= created_at_ms),
  CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
  CHECK ((lifecycle = 'active' AND ended_at_ms IS NULL AND terminal_reason IS NULL) OR (lifecycle <> 'active' AND ended_at_ms IS NOT NULL AND terminal_reason IS NOT NULL AND length(trim(terminal_reason)) > 0))
);

CREATE TABLE aurora_transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES aurora_transcript_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  start_at_ms INTEGER NOT NULL,
  end_at_ms INTEGER NOT NULL CHECK (end_at_ms >= start_at_ms),
  text_envelope_json TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  speaker_id TEXT,
  speaker_label TEXT,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE INDEX idx_aurora_transcript_sessions_profile_node_created
  ON aurora_transcript_sessions (profile_id, local_node_id, created_at_ms DESC, id ASC);

CREATE INDEX idx_aurora_transcript_segments_session_order
  ON aurora_transcript_segments (session_id, sequence ASC, id ASC);
