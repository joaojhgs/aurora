-- Migration 017: retain first-seen permission-blocked mesh tools for management UI.
--
-- Blocked definitions remain non-bindable. The projection protocol carries
-- them separately from callable tools, and staging records their explicit
-- availability before atomic promotion.

ALTER TABLE tooling_remote_catalog_stage_tools
    ADD COLUMN availability TEXT NOT NULL DEFAULT 'active'
    CHECK (availability IN ('active', 'permission_blocked'));

ALTER TABLE tooling_remote_catalog_stage_tools
    ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'projection_active';

ALTER TABLE tooling_remote_catalog_stage_tools
    ADD COLUMN missing_permissions_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE tooling_remote_catalog_tools
    ADD COLUMN missing_permissions_json TEXT NOT NULL DEFAULT '[]';
