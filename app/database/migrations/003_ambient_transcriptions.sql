-- Migration 003: Ambient Transcriptions Table
-- Created at: 2024-12-19
-- Description: Add support for ambient transcription storage with vector similarity search

-- Create ambient_transcriptions table for storing continuous background audio transcriptions
CREATE TABLE IF NOT EXISTS ambient_transcriptions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    chunk_id TEXT NOT NULL UNIQUE,
    duration REAL NOT NULL, -- Duration of audio chunk in seconds
    confidence REAL, -- Transcription confidence score (0.0 to 1.0)
    embedding TEXT, -- JSON-encoded vector embedding for similarity search
    metadata TEXT, -- JSON string for additional data
    session_id TEXT, -- Optional session grouping
    source_info TEXT, -- JSON string for source audio information
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_ambient_timestamp ON ambient_transcriptions(timestamp);
CREATE INDEX IF NOT EXISTS idx_ambient_chunk_id ON ambient_transcriptions(chunk_id);
CREATE INDEX IF NOT EXISTS idx_ambient_session_id ON ambient_transcriptions(session_id);
CREATE INDEX IF NOT EXISTS idx_ambient_date ON ambient_transcriptions(date(timestamp));
CREATE INDEX IF NOT EXISTS idx_ambient_confidence ON ambient_transcriptions(confidence);
CREATE INDEX IF NOT EXISTS idx_ambient_duration ON ambient_transcriptions(duration);

-- Create view for daily ambient transcription summaries
CREATE VIEW IF NOT EXISTS daily_ambient_summary AS
SELECT 
    date(timestamp) as transcription_date,
    COUNT(*) as total_transcriptions,
    SUM(duration) as total_audio_duration,
    AVG(duration) as avg_chunk_duration,
    AVG(confidence) as avg_confidence,
    COUNT(CASE WHEN confidence > 0.8 THEN 1 END) as high_confidence_count,
    MIN(timestamp) as first_transcription_time,
    MAX(timestamp) as last_transcription_time,
    GROUP_CONCAT(DISTINCT session_id) as sessions
FROM ambient_transcriptions
WHERE confidence IS NOT NULL
GROUP BY date(timestamp)
ORDER BY transcription_date DESC;

-- Create view for session-based ambient transcription grouping
CREATE VIEW IF NOT EXISTS session_ambient_summary AS
SELECT 
    session_id,
    COUNT(*) as total_transcriptions,
    SUM(duration) as total_audio_duration,
    AVG(confidence) as avg_confidence,
    MIN(timestamp) as session_start,
    MAX(timestamp) as session_end,
    date(MIN(timestamp)) as session_date
FROM ambient_transcriptions
WHERE session_id IS NOT NULL
GROUP BY session_id
ORDER BY session_start DESC;