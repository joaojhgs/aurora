-- Migration 014: independent Tooling export authority and bilateral mesh switches
--
-- Export decisions are intentionally not approval grants.  Rules survive a
-- temporarily missing tool/group and therefore have no identity foreign key.

CREATE TABLE tooling_export_policy (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    default_state TEXT NOT NULL CHECK (default_state IN ('shared', 'unshared')),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    initialized INTEGER NOT NULL CHECK (initialized IN (0, 1)),
    migrated_from_legacy INTEGER NOT NULL CHECK (migrated_from_legacy IN (0, 1)),
    updated_at REAL NOT NULL
);

INSERT INTO tooling_export_policy (
    singleton_id, default_state, revision, initialized,
    migrated_from_legacy, updated_at
) VALUES (1, 'shared', 0, 0, 0, unixepoch('subsec'));

CREATE TABLE tooling_export_rules (
    rule_id TEXT PRIMARY KEY,
    peer_id TEXT CHECK (peer_id IS NULL OR (length(peer_id) > 0 AND trim(peer_id) = peer_id)),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('group', 'tool')),
    scope_id TEXT NOT NULL CHECK (length(scope_id) > 0 AND trim(scope_id) = scope_id),
    state TEXT NOT NULL CHECK (state IN ('shared', 'unshared')),
    actor_principal_id TEXT NOT NULL CHECK (length(actor_principal_id) > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE UNIQUE INDEX uq_tooling_export_rules_global_scope
    ON tooling_export_rules(scope_type, scope_id)
    WHERE peer_id IS NULL;
CREATE UNIQUE INDEX uq_tooling_export_rules_peer_scope
    ON tooling_export_rules(peer_id, scope_type, scope_id)
    WHERE peer_id IS NOT NULL;
CREATE INDEX idx_tooling_export_rules_scope
    ON tooling_export_rules(scope_type, scope_id);
CREATE INDEX idx_tooling_export_rules_peer_scope
    ON tooling_export_rules(peer_id, scope_type, scope_id);

CREATE TABLE tooling_export_policy_audit (
    audit_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    action TEXT NOT NULL,
    rule_id TEXT,
    peer_id TEXT,
    scope_type TEXT,
    scope_id TEXT,
    previous_state TEXT,
    new_state TEXT,
    actor_principal_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    correlation_id TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX idx_tooling_export_policy_audit_revision
    ON tooling_export_policy_audit(revision, created_at);

-- These are independent directional controls.  G012 persists and reports
-- them; runtime enforcement is deliberately deferred to G013.
CREATE TABLE tooling_mesh_switches (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    provider_mesh_tooling_enabled INTEGER NOT NULL
        CHECK (provider_mesh_tooling_enabled IN (0, 1)),
    consumer_mesh_tooling_enabled INTEGER NOT NULL
        CHECK (consumer_mesh_tooling_enabled IN (0, 1)),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    updated_at REAL NOT NULL
);

INSERT INTO tooling_mesh_switches (
    singleton_id, provider_mesh_tooling_enabled,
    consumer_mesh_tooling_enabled, revision, updated_at
) VALUES (1, 1, 1, 0, unixepoch('subsec'));

CREATE TABLE tooling_mesh_switch_audit (
    audit_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    provider_mesh_tooling_enabled INTEGER NOT NULL,
    consumer_mesh_tooling_enabled INTEGER NOT NULL,
    actor_principal_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    correlation_id TEXT,
    created_at REAL NOT NULL
);
