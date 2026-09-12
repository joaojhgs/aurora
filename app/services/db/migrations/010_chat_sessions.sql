-- Migration 010: Principal-owned persisted sessions
--
-- Session ``type`` intentionally has no database default. Every producer must
-- make the session kind explicit so future non-chat session types cannot be
-- silently stored as chat.

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (length(trim(type)) > 0),
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_principal_active
    ON sessions(principal_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_principal_type_active
    ON sessions(principal_id, type, last_active_at DESC);

-- Existing message history predates authenticated session ownership. Preserve
-- each existing thread as a local SYSTEM-owned chat session. New writes are
-- always assigned from the authenticated principal by the session service.
INSERT OR IGNORE INTO sessions (
    id,
    principal_id,
    type,
    title,
    created_at,
    updated_at,
    last_active_at
)
SELECT
    legacy.session_id,
    'system',
    'chat',
    substr((
        SELECT first_message.content
        FROM messages AS first_message
        WHERE first_message.session_id = legacy.session_id
          AND first_message.message_type IN ('user_text', 'user_voice')
        ORDER BY first_message.timestamp ASC
        LIMIT 1
    ), 1, 80),
    MIN(legacy.timestamp),
    MAX(legacy.timestamp),
    MAX(legacy.timestamp)
FROM messages AS legacy
WHERE legacy.session_id IS NOT NULL
  AND trim(legacy.session_id) <> ''
GROUP BY legacy.session_id;

-- Very old rows may not have had any session identifier. Keep them together in
-- one explicit chat thread instead of leaving history unreachable.
INSERT OR IGNORE INTO sessions (
    id,
    principal_id,
    type,
    title,
    created_at,
    updated_at,
    last_active_at
)
SELECT
    'legacy-chat',
    'system',
    'chat',
    'Legacy chat',
    MIN(timestamp),
    MAX(timestamp),
    MAX(timestamp)
FROM messages
WHERE session_id IS NULL OR trim(session_id) = ''
HAVING COUNT(*) > 0;

UPDATE messages
SET session_id = 'legacy-chat'
WHERE session_id IS NULL OR trim(session_id) = '';
