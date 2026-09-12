-- Migration 016: bounded remote Tooling lifecycle and provider-scoped aliases.

CREATE TABLE tooling_remote_tool_aliases (
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    legacy_global_tool_id TEXT NOT NULL,
    canonical_global_tool_id TEXT NOT NULL,
    first_seen_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    PRIMARY KEY (peer_id, provider_id, legacy_global_tool_id),
    FOREIGN KEY (peer_id, provider_id)
        REFERENCES tooling_remote_catalog_headers(peer_id, provider_id) ON DELETE CASCADE
);

CREATE INDEX idx_tooling_remote_alias_canonical
    ON tooling_remote_tool_aliases(peer_id, provider_id, canonical_global_tool_id);

CREATE TABLE tooling_remote_tool_identity_conflicts (
    conflict_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    sync_id TEXT NOT NULL,
    legacy_global_tool_id TEXT,
    requested_canonical_global_tool_id TEXT,
    existing_canonical_global_tool_id TEXT,
    reason_code TEXT NOT NULL,
    projection_revision TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'resolved', 'rejected')),
    created_at REAL NOT NULL,
    resolved_at REAL
);

CREATE INDEX idx_tooling_remote_identity_conflicts_pending
    ON tooling_remote_tool_identity_conflicts(peer_id, provider_id, review_status, created_at);

-- Non-bindable management tombstones survive full-row compaction. They retain
-- labels/provenance/group context, but no description, callable schema,
-- arguments, or provider secrets. Maintenance bounds that rich metadata tail
-- by replacing old/excess JSON with `{}` while retaining the stable ID and
-- accepted schema hash needed for retirement validation and schema review.
CREATE TABLE tooling_remote_catalog_retention_tombstones (
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    global_tool_id TEXT NOT NULL,
    management_metadata_json TEXT NOT NULL,
    accepted_schema_hash TEXT NOT NULL,
    last_availability TEXT NOT NULL
        CHECK (last_availability IN ('unshared', 'permission_blocked', 'removed', 'stale')),
    reason_code TEXT NOT NULL,
    compacted_at REAL NOT NULL,
    PRIMARY KEY (peer_id, provider_id, global_tool_id),
    FOREIGN KEY (peer_id, provider_id)
        REFERENCES tooling_remote_catalog_headers(peer_id, provider_id) ON DELETE CASCADE
);

CREATE INDEX idx_tooling_remote_retention_tombstones_provider
    ON tooling_remote_catalog_retention_tombstones(peer_id, provider_id, compacted_at);
