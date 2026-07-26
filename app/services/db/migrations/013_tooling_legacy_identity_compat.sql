-- Migration 013: restart-safe IDs for unstamped/name-only Tooling providers
--
-- Migration 012 shipped aliases as globally unique. Legacy remote providers can
-- announce the same old identifier, so aliases must be scoped by authenticated
-- stable peer. Rebuild the table rather than mutating 012 so already-upgraded
-- databases receive the compatibility contract on their next startup.

CREATE TABLE tooling_tool_identity_aliases_v2 (
    stable_peer_id TEXT NOT NULL,
    legacy_global_tool_id TEXT NOT NULL,
    canonical_global_tool_id TEXT NOT NULL,
    alias_kind TEXT NOT NULL DEFAULT 'legacy_name_derived',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(canonical_global_tool_id)
        REFERENCES tooling_tool_identities(canonical_global_tool_id)
        ON DELETE RESTRICT,
    PRIMARY KEY(stable_peer_id, legacy_global_tool_id)
);

INSERT INTO tooling_tool_identity_aliases_v2 (
    stable_peer_id, legacy_global_tool_id, canonical_global_tool_id,
    alias_kind, created_at, updated_at
)
SELECT identity.stable_peer_id, alias.legacy_global_tool_id,
       alias.canonical_global_tool_id, alias.alias_kind,
       alias.created_at, alias.updated_at
FROM tooling_tool_identity_aliases AS alias
JOIN tooling_tool_identities AS identity
  ON identity.canonical_global_tool_id = alias.canonical_global_tool_id;

DROP TABLE tooling_tool_identity_aliases;
ALTER TABLE tooling_tool_identity_aliases_v2 RENAME TO tooling_tool_identity_aliases;

CREATE INDEX idx_tooling_tool_identity_aliases_canonical
    ON tooling_tool_identity_aliases(canonical_global_tool_id);

-- Compatibility allocation is keyed by an authenticated peer plus a durable
-- legacy locator. The contract ID is random once and reused forever; display
-- names and service-instance IDs never enter the authority key.
CREATE TABLE tooling_tool_identity_allocations (
    stable_peer_id TEXT NOT NULL,
    legacy_identity_locator TEXT NOT NULL,
    allocated_tool_contract_id TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL,
    stable_source_id TEXT NOT NULL,
    provider_tool_id TEXT NOT NULL,
    share_group_id TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(stable_peer_id, legacy_identity_locator)
);

CREATE INDEX idx_tooling_tool_identity_allocations_contract
    ON tooling_tool_identity_allocations(stable_peer_id, allocated_tool_contract_id);
