-- Migration 002: Scheduler Tables
-- Created at: Aurora Scheduler Database Schema

-- Create cron_jobs table for storing scheduled jobs
CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('relative', 'absolute', 'cron')),
    schedule_value TEXT NOT NULL,
    next_run_time TEXT,
    callback_module TEXT NOT NULL,
    callback_function TEXT NOT NULL,
    callback_args TEXT, -- JSON string for arguments
    is_active INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    last_run_time TEXT,
    last_run_result TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    metadata TEXT -- JSON string for additional data
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run_time ON cron_jobs(next_run_time);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_is_active ON cron_jobs(is_active);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_status ON cron_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_schedule_type ON cron_jobs(schedule_type);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_created_at ON cron_jobs(created_at);

-- Create view for active jobs
CREATE VIEW IF NOT EXISTS active_cron_jobs AS
SELECT 
    id,
    name,
    schedule_type,
    schedule_value,
    next_run_time,
    status,
    last_run_time,
    retry_count,
    max_retries,
    created_at
FROM cron_jobs
WHERE is_active = 1
ORDER BY next_run_time ASC;

-- Create view for job execution history
CREATE VIEW IF NOT EXISTS cron_job_history AS
SELECT 
    id,
    name,
    schedule_type,
    status,
    last_run_time,
    last_run_result,
    retry_count,
    created_at
FROM cron_jobs
WHERE last_run_time IS NOT NULL
ORDER BY last_run_time DESC;
