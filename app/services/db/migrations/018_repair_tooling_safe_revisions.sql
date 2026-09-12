-- Migration 018: quarantine legacy Tooling authority revisions outside JavaScript's safe integer range.
--
-- Older providers derived catalog_revision from a 60-bit hash prefix. Those
-- values cannot cross the JSON/TypeScript boundary without precision loss and
-- now violate ToolingProjectionAuthorityRevision. Retain the catalog only as
-- non-bindable management history and require a fresh provider projection.

CREATE TEMP TABLE tooling_unsafe_legacy_providers (
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    PRIMARY KEY (peer_id, provider_id)
);

INSERT OR IGNORE INTO tooling_unsafe_legacy_providers (peer_id, provider_id)
SELECT peer_id, provider_id
FROM tooling_remote_catalog_headers
WHERE catalog_revision > 9007199254740991
   OR export_policy_revision > 9007199254740991
   OR auth_grant_revision > 9007199254740991
   OR manifest_revision > 9007199254740991
   OR switch_revision > 9007199254740991
   OR protocol_revision > 9007199254740991;

INSERT OR IGNORE INTO tooling_unsafe_legacy_providers (peer_id, provider_id)
SELECT peer_id, provider_id
FROM tooling_remote_catalog_tools
WHERE catalog_revision > 9007199254740991
   OR export_policy_revision > 9007199254740991
   OR auth_grant_revision > 9007199254740991
   OR manifest_revision > 9007199254740991
   OR switch_revision > 9007199254740991
   OR protocol_revision > 9007199254740991;

UPDATE tooling_remote_catalog_headers
SET catalog_revision = CASE WHEN catalog_revision > 9007199254740991 THEN 0 ELSE catalog_revision END,
    export_policy_revision = CASE WHEN export_policy_revision > 9007199254740991 THEN 0 ELSE export_policy_revision END,
    auth_grant_revision = CASE WHEN auth_grant_revision > 9007199254740991 THEN 0 ELSE auth_grant_revision END,
    manifest_revision = CASE WHEN manifest_revision > 9007199254740991 THEN 0 ELSE manifest_revision END,
    switch_revision = CASE WHEN switch_revision > 9007199254740991 THEN 0 ELSE switch_revision END,
    protocol_revision = CASE WHEN protocol_revision > 9007199254740991 THEN 1 ELSE protocol_revision END,
    current_generation = 0,
    sync_state = 'failed',
    availability = 'stale',
    last_error_reason = 'unsafe_legacy_authority_revision',
    updated_at = unixepoch('subsec')
WHERE (peer_id, provider_id) IN (
    SELECT peer_id, provider_id FROM tooling_unsafe_legacy_providers
);

UPDATE tooling_remote_catalog_tools
SET catalog_revision = CASE WHEN catalog_revision > 9007199254740991 THEN 0 ELSE catalog_revision END,
    export_policy_revision = CASE WHEN export_policy_revision > 9007199254740991 THEN 0 ELSE export_policy_revision END,
    auth_grant_revision = CASE WHEN auth_grant_revision > 9007199254740991 THEN 0 ELSE auth_grant_revision END,
    manifest_revision = CASE WHEN manifest_revision > 9007199254740991 THEN 0 ELSE manifest_revision END,
    switch_revision = CASE WHEN switch_revision > 9007199254740991 THEN 0 ELSE switch_revision END,
    protocol_revision = CASE WHEN protocol_revision > 9007199254740991 THEN 1 ELSE protocol_revision END,
    availability = 'stale',
    reason_code = 'unsafe_legacy_authority_revision',
    active_generation = NULL,
    review_required = 1,
    updated_at = unixepoch('subsec')
WHERE (peer_id, provider_id) IN (
    SELECT peer_id, provider_id FROM tooling_unsafe_legacy_providers
);

CREATE TEMP TABLE tooling_unsafe_legacy_syncs (
    sync_id TEXT PRIMARY KEY
);

INSERT INTO tooling_unsafe_legacy_syncs (sync_id)
SELECT sync_id
FROM tooling_remote_catalog_syncs
WHERE catalog_revision > 9007199254740991
   OR export_policy_revision > 9007199254740991
   OR auth_grant_revision > 9007199254740991
   OR manifest_revision > 9007199254740991
   OR switch_revision > 9007199254740991
   OR protocol_revision > 9007199254740991;

DELETE FROM tooling_remote_catalog_stage_retirements
WHERE sync_id IN (SELECT sync_id FROM tooling_unsafe_legacy_syncs);

DELETE FROM tooling_remote_catalog_stage_tools
WHERE sync_id IN (SELECT sync_id FROM tooling_unsafe_legacy_syncs);

DELETE FROM tooling_remote_catalog_stage_pages
WHERE sync_id IN (SELECT sync_id FROM tooling_unsafe_legacy_syncs);

DELETE FROM tooling_remote_catalog_syncs
WHERE sync_id IN (SELECT sync_id FROM tooling_unsafe_legacy_syncs);

DROP TABLE tooling_unsafe_legacy_syncs;
DROP TABLE tooling_unsafe_legacy_providers;
