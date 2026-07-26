-- Migration 015: normalized, recipient-specific Tooling projection retention
--
-- Pages are staged outside the bindable registry.  Only a verified complete
-- promotion advances current_generation.  Retained metadata is not authority.

CREATE TABLE tooling_remote_catalog_headers (
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    service_instance_id TEXT NOT NULL,
    protocol_tier TEXT NOT NULL CHECK (protocol_tier IN ('legacy_unsupported', 'projection_v1')),
    projection_revision TEXT,
    projection_digest TEXT,
    catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0),
    export_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK (export_policy_revision >= 0),
    auth_grant_revision INTEGER NOT NULL DEFAULT 0 CHECK (auth_grant_revision >= 0),
    manifest_revision INTEGER NOT NULL DEFAULT 0 CHECK (manifest_revision >= 0),
    switch_revision INTEGER NOT NULL DEFAULT 0 CHECK (switch_revision >= 0),
    protocol_revision INTEGER NOT NULL DEFAULT 1 CHECK (protocol_revision >= 1),
    current_generation INTEGER NOT NULL DEFAULT 0 CHECK (current_generation >= 0),
    sync_state TEXT NOT NULL DEFAULT 'idle'
        CHECK (sync_state IN ('idle', 'syncing', 'committed', 'failed', 'legacy_stale')),
    availability TEXT NOT NULL DEFAULT 'stale'
        CHECK (availability IN ('active', 'provider_unavailable', 'stale', 'protocol_unsupported')),
    last_error_reason TEXT,
    committed_at REAL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (peer_id, provider_id)
);

CREATE TABLE tooling_remote_catalog_tools (
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    global_tool_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    accepted_schema_hash TEXT NOT NULL,
    availability TEXT NOT NULL
        CHECK (availability IN ('active', 'unshared', 'permission_blocked',
            'provider_unavailable', 'removed', 'stale', 'schema_changed',
            'protocol_unsupported')),
    reason_code TEXT NOT NULL,
    active_generation INTEGER,
    projection_revision TEXT,
    catalog_revision INTEGER NOT NULL DEFAULT 0,
    export_policy_revision INTEGER NOT NULL DEFAULT 0,
    auth_grant_revision INTEGER NOT NULL DEFAULT 0,
    manifest_revision INTEGER NOT NULL DEFAULT 0,
    switch_revision INTEGER NOT NULL DEFAULT 0,
    protocol_revision INTEGER NOT NULL DEFAULT 1,
    review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
    first_seen_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (peer_id, provider_id, global_tool_id),
    FOREIGN KEY (peer_id, provider_id)
        REFERENCES tooling_remote_catalog_headers(peer_id, provider_id) ON DELETE CASCADE
);

CREATE INDEX idx_tooling_remote_catalog_tools_active
    ON tooling_remote_catalog_tools(peer_id, provider_id, availability, active_generation);

CREATE TABLE tooling_remote_catalog_syncs (
    sync_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    service_instance_id TEXT NOT NULL,
    protocol_tier TEXT NOT NULL CHECK (protocol_tier = 'projection_v1'),
    projection_revision TEXT NOT NULL,
    projection_digest TEXT NOT NULL,
    catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 0),
    export_policy_revision INTEGER NOT NULL CHECK (export_policy_revision >= 0),
    auth_grant_revision INTEGER NOT NULL CHECK (auth_grant_revision >= 0),
    manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 0),
    switch_revision INTEGER NOT NULL CHECK (switch_revision >= 0),
    protocol_revision INTEGER NOT NULL CHECK (protocol_revision >= 1),
    page_size INTEGER NOT NULL CHECK (page_size BETWEEN 1 AND 256),
    expected_base_generation INTEGER NOT NULL CHECK (expected_base_generation >= 0),
    state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'complete')),
    final_page_index INTEGER,
    total_count INTEGER,
    final_checksum TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    FOREIGN KEY (peer_id, provider_id)
        REFERENCES tooling_remote_catalog_headers(peer_id, provider_id) ON DELETE CASCADE
);

CREATE INDEX idx_tooling_remote_catalog_provider_staging
    ON tooling_remote_catalog_syncs(peer_id, provider_id, state);

CREATE TABLE tooling_remote_catalog_stage_pages (
    sync_id TEXT NOT NULL,
    page_index INTEGER NOT NULL CHECK (page_index >= 0),
    page_hash TEXT NOT NULL,
    item_count INTEGER NOT NULL CHECK (item_count >= 0),
    complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
    next_cursor_hash TEXT,
    created_at REAL NOT NULL,
    PRIMARY KEY (sync_id, page_index),
    FOREIGN KEY (sync_id) REFERENCES tooling_remote_catalog_syncs(sync_id) ON DELETE CASCADE
);

CREATE TABLE tooling_remote_catalog_stage_tools (
    sync_id TEXT NOT NULL,
    global_tool_id TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    metadata_json TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    PRIMARY KEY (sync_id, global_tool_id),
    FOREIGN KEY (sync_id) REFERENCES tooling_remote_catalog_syncs(sync_id) ON DELETE CASCADE
);

CREATE TABLE tooling_remote_catalog_stage_retirements (
    sync_id TEXT NOT NULL,
    global_tool_id TEXT NOT NULL,
    page_index INTEGER NOT NULL,
    availability TEXT NOT NULL
        CHECK (availability IN ('unshared', 'permission_blocked', 'removed', 'stale')),
    reason_code TEXT NOT NULL,
    last_schema_hash TEXT,
    PRIMARY KEY (sync_id, global_tool_id),
    FOREIGN KEY (sync_id) REFERENCES tooling_remote_catalog_syncs(sync_id) ON DELETE CASCADE
);

-- Provider-side monotonic disclosure history.  A retirement is legal only for
-- an ID already exposed to this exact stable recipient/provider pair.
CREATE TABLE tooling_tool_exposure_ledger (
    recipient_peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    global_tool_id TEXT NOT NULL,
    first_exposed_at REAL NOT NULL,
    last_exposed_at REAL NOT NULL,
    last_schema_hash TEXT,
    PRIMARY KEY (recipient_peer_id, provider_id, global_tool_id)
);

CREATE TABLE tooling_remote_catalog_audit (
    audit_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    sync_id TEXT,
    action TEXT NOT NULL,
    previous_generation INTEGER,
    generation INTEGER,
    projection_revision TEXT,
    reason_code TEXT,
    correlation_id TEXT,
    actor_principal_id TEXT,
    detail_reason TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX idx_tooling_remote_catalog_audit_provider
    ON tooling_remote_catalog_audit(peer_id, provider_id, created_at);

-- The G013 enforcement cutover is one durable, monotonic security boundary.
-- A singleton row survives restart and makes a partially activated binary
-- distinguishable from one that has atomically retired the legacy guard.
CREATE TABLE tooling_mesh_activation_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
    legacy_guard_retired INTEGER NOT NULL DEFAULT 0 CHECK (legacy_guard_retired IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    component_schema_versions_json TEXT NOT NULL,
    activated_at REAL,
    audit_id TEXT,
    updated_at REAL NOT NULL,
    CHECK (active = legacy_guard_retired),
    CHECK ((active = 0 AND activated_at IS NULL AND audit_id IS NULL) OR
           (active = 1 AND activated_at IS NOT NULL AND audit_id IS NOT NULL))
);

INSERT INTO tooling_mesh_activation_state (
    singleton_id, active, legacy_guard_retired, revision,
    component_schema_versions_json, activated_at, audit_id, updated_at
) VALUES (
    1, 0, 0, 0,
    '{"conditional_legacy_retirement":0,"consumer_binding":0,"exact_method_set":0,"execute_enforcement":0,"execution_rpc_evidence":0,"inbound_sync_bridge":0,"mutation_invalidation":0,"normalized_catalog":0,"prepare_enforcement":0,"projection_transport":0,"provider_discovery":0,"startup_downgrade_guard":0,"targeted_invalidation":0,"typed_exposure_ledger":0}',
    NULL, NULL, unixepoch('subsec')
);

CREATE TABLE tooling_mesh_activation_audit (
    audit_id TEXT PRIMARY KEY,
    previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    component_schema_versions_json TEXT NOT NULL,
    actor_principal_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    correlation_id TEXT,
    created_at REAL NOT NULL
);
