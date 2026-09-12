-- Migration 012: Durable immutable Tooling identities and compatibility aliases
--
-- Tool contract identity is authority-bearing.  Boot/session service instance IDs
-- deliberately do not appear in these keys.  The compatibility tables below are
-- also created here (rather than only by Tooling startup) so the typed DB
-- reconciliation transaction is available on fresh and upgraded databases.

CREATE TABLE IF NOT EXISTS tooling_tool_identities (
    canonical_global_tool_id TEXT PRIMARY KEY,
    stable_peer_id TEXT NOT NULL,
    identity_version INTEGER NOT NULL CHECK (identity_version = 1),
    tool_contract_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    stable_source_id TEXT NOT NULL,
    provider_tool_id TEXT NOT NULL,
    share_group_id TEXT NOT NULL,
    share_group_label TEXT NOT NULL,
    current_local_name TEXT NOT NULL,
    identity_status TEXT NOT NULL DEFAULT 'canonical'
        CHECK (identity_status IN ('canonical', 'collision', 'tombstoned')),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(stable_peer_id, tool_contract_id),
    UNIQUE(stable_peer_id, source_kind, stable_source_id, provider_tool_id)
);

CREATE INDEX IF NOT EXISTS idx_tooling_tool_identities_source
    ON tooling_tool_identities(stable_peer_id, source_kind, stable_source_id);
CREATE INDEX IF NOT EXISTS idx_tooling_tool_identities_group
    ON tooling_tool_identities(stable_peer_id, share_group_id);

CREATE TABLE IF NOT EXISTS tooling_tool_identity_aliases (
    legacy_global_tool_id TEXT PRIMARY KEY,
    canonical_global_tool_id TEXT NOT NULL,
    alias_kind TEXT NOT NULL DEFAULT 'legacy_name_derived',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(canonical_global_tool_id)
        REFERENCES tooling_tool_identities(canonical_global_tool_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_tooling_tool_identity_aliases_canonical
    ON tooling_tool_identity_aliases(canonical_global_tool_id);

CREATE TABLE IF NOT EXISTS tooling_tool_identity_conflicts (
    conflict_id TEXT PRIMARY KEY,
    requested_canonical_global_tool_id TEXT NOT NULL,
    existing_canonical_global_tool_id TEXT,
    conflicting_legacy_global_tool_id TEXT,
    reason_code TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (review_status IN ('pending', 'resolved', 'dismissed')),
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tooling_tool_identity_conflicts_pending
    ON tooling_tool_identity_conflicts(review_status, created_at);

CREATE TABLE IF NOT EXISTS tooling_approval_grants (
    grant_id TEXT PRIMARY KEY,
    grant_scope TEXT NOT NULL,
    grant_type TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    principal_id TEXT,
    caller_device_id TEXT,
    caller_peer_id TEXT,
    provider_peer_id TEXT,
    provider_service_instance_id TEXT,
    global_tool_id TEXT,
    local_tool_name TEXT,
    args_hash TEXT,
    resource_selector_hash TEXT,
    route_decision_id TEXT,
    schedule_id TEXT,
    trust_tier TEXT,
    capability_class TEXT,
    resource_scope TEXT,
    include_future_tools INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at REAL NOT NULL,
    expires_at REAL,
    revoked_at REAL,
    reason TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tooling_approval_requests (
    approval_request_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    prepared_json TEXT NOT NULL,
    expires_at REAL NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tooling_approval_tokens (
    token_hash TEXT PRIMARY KEY,
    claims_json TEXT NOT NULL,
    expires_at REAL NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS tooling_remote_catalog_snapshots (
    peer_id TEXT NOT NULL,
    service_instance_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    catalog_epoch INTEGER NOT NULL,
    generated_at TEXT NOT NULL,
    full_schema_hash TEXT NOT NULL,
    tools_json TEXT NOT NULL,
    shared_by_policy INTEGER NOT NULL DEFAULT 1,
    stale INTEGER NOT NULL DEFAULT 0,
    removed_at REAL,
    updated_at REAL NOT NULL,
    PRIMARY KEY(peer_id, service_instance_id)
);

CREATE TABLE IF NOT EXISTS tooling_remote_catalog_tombstones (
    global_tool_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    service_instance_id TEXT,
    reason TEXT,
    removed_at REAL NOT NULL
);
