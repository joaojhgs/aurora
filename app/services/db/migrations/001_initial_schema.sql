-- Migration 001: Initial Schema
-- Created at: Aurora Database Initial Setup

-- Create messages table for storing conversation history
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('user_text', 'user_voice', 'assistant', 'system')),
    timestamp TEXT NOT NULL,
    session_id TEXT,
    metadata TEXT, -- JSON string for additional data
    source_type TEXT, -- 'Text', 'STT', etc.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date(timestamp));

-- Create view for daily message summaries
CREATE VIEW IF NOT EXISTS daily_message_summary AS
SELECT 
    date(timestamp) as message_date,
    COUNT(*) as total_messages,
    COUNT(CASE WHEN message_type IN ('user_text', 'user_voice') THEN 1 END) as user_messages,
    COUNT(CASE WHEN message_type = 'assistant' THEN 1 END) as assistant_messages,
    MIN(timestamp) as first_message_time,
    MAX(timestamp) as last_message_time
FROM messages
GROUP BY date(timestamp)
ORDER BY message_date DESC;
