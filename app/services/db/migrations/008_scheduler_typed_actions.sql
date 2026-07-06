-- Migration 008: Scheduler typed action columns
-- Keeps legacy callback columns for compatibility while new jobs persist typed action specs.

ALTER TABLE cron_jobs ADD COLUMN action_kind TEXT;
ALTER TABLE cron_jobs ADD COLUMN action_spec TEXT;
ALTER TABLE cron_jobs ADD COLUMN action_spec_version INTEGER DEFAULT 1;
ALTER TABLE cron_jobs ADD COLUMN prepared_binding TEXT;
ALTER TABLE cron_jobs ADD COLUMN policy_decision_id TEXT;

CREATE INDEX IF NOT EXISTS idx_cron_jobs_action_kind ON cron_jobs(action_kind);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_policy_decision_id ON cron_jobs(policy_decision_id);
