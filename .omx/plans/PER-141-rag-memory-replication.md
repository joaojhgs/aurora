# PER-141 Plan: Selective RAG/Memory Replication

## Requirements Summary

- Source issue: PER-141 `[MESH][P4-T02] Design selective RAG/memory replication with provenance and conflict handling`.
- Scope: RAG/memory replication semantics only. Do not replicate raw SQL, Auth credentials, mesh secrets, scheduler ownership, config, hardware/audio streams, or unrelated UI/P5/P6 work.
- Policy source: `docs/DATA_SHARING_POLICY.md` permits remote-query-only by default, export/import for curated RAG namespaces, and one-way replication for explicitly published namespaces. Bidirectional sync remains deferred.
- Missing referenced artifacts in this checkout: `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/*`.

## Acceptance Criteria

- RAG/memory replication has a documented and tested conflict model.
- Sync is namespace-scoped and opt-in.
- Deletes/tombstones are represented.
- Provenance is queryable through returned item metadata.
- No raw SQL, Auth credential, token, password hash, or mesh secret data is exported or imported.

## Implementation Steps

1. Extend `app/shared/contracts/models/db.py` with internal-only RAG namespace snapshot/import/change models carrying provenance, tombstones, visibility, policy/correlation IDs, schema version, and conflict mode.
2. Add pure RAG sync helpers in `app/services/db/rag_service.py` for metadata normalization, tombstone creation, conflict resolution, export snapshot creation, import application, and namespace-scoped change listing.
3. Add internal DB methods in `app/services/db/service.py` for `DB.RAGExportNamespace`, `DB.RAGImportNamespace`, and `DB.RAGListChanges`.
4. Document the concrete RAG sync model in `docs/DATA_SHARING_POLICY.md` and update `docs/SERVICE_METHODS_REFERENCE.md`.
5. Add targeted unit coverage for merge/conflict/tombstone behavior and mocked two-peer import/export flow.

## Verification Strategy

- `uv run pytest tests/unit/db/test_rag_service.py tests/unit/db/test_service.py -q`
- `git diff --check`

## Risks and Mitigations

- Vector-store delete behavior is best-effort today. Mitigation: tombstones are explicit records, so delete propagation does not rely only on physical deletion.
- Bidirectional convergence can be overbuilt. Mitigation: contracts include deterministic conflict metadata, but exposed service methods remain internal and support export/import plus one-way change listing first.
- Sensitive fields could be copied accidentally. Mitigation: shared helpers reject values containing obvious credential/secret keys before export/import.
