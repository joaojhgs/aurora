-- Migration 004: Replace role with granular permissions
-- Created at: 2026-02-08
-- Purpose: Add per-principal permissions and is_admin flag to users table

-- Add permissions column (JSON list of permission strings)
ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]';

-- Add is_admin flag (convenience shortcut for superuser)
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0;

-- Migrate existing data: admin role → is_admin=true, permissions=["*"]
UPDATE users SET is_admin = 1, permissions = '["*"]' WHERE role = 'admin';

-- Note: 'role' column is kept for backward compatibility but ignored by new code.
-- It can be dropped in a future migration.
