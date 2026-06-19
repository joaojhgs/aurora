# PER-159 DB/RAG Namespace Provenance Plan

## Requirements Summary

- Add DB/RAG contracts for namespace catalog, provenance lookup, namespace export, namespace import, and policy-aware remote search.
- Preserve Aurora bus-first contracts: typed `DBMethods`, `IOModel` request/response models, and `@method_contract` handlers.
- Keep raw SQL internal-only and do not expose Auth credentials, mesh secrets, trust state, embeddings, private filesystem paths, or unrelated peer/user records.
- Make remote RAG access explicit: sensitive namespace remote searches require a namespace/data-scope selector and return a policy denial instead of silently falling back.
- Export/import snapshots preserve source/owner peer, namespace, record ID, principal marker, timestamps, schema version, policy decision, correlation ID, and tombstone metadata.

## Source Context

- Issue PER-159 acceptance criteria and backend requirements.
- `docs/DATA_SHARING_POLICY.md`: domain matrix and no-raw-SQL/privacy requirements.
- `.omx/specs/deep-interview-mesh-distributed-integration.md`: Phase 4 data-sharing mode guidance.
- `.omx/plans/mesh-production-e2e-integration-gap-plan.md`: DB/RAG production gap requirements.
- `.omx/specs/ui-production-tasks/tasks/BE-017-add-memory-rag-provenance-export-delete-contracts.md`: UI/SDK contract expectations.
- `app/shared/contracts/models/db.py`: current DB/RAG method constants and IO models.
- `app/services/db/service.py`: current internal RAG store/get/list/delete, external RAG search, and internal SQL execution.
- `tests/unit/db/test_service.py`: current DB service unit-test pattern.

## Acceptance Criteria

- `DBMethods` includes namespace list, remote search, provenance, export namespace, and import namespace contracts.
- Namespace catalog response reports namespace, owner/source peer, availability, policy, allowed operations, export/import support, privacy class, and explicit-selector requirement.
- Remote search denies sensitive namespace requests when no explicit `mesh_selector.resource_namespace` or `mesh_selector.data_scope` matches the requested namespace.
- Allowed search returns redacted items with provenance and no raw embeddings, secrets, credential material, private paths, or unrelated peer records.
- Export returns a provenance-preserving snapshot with tombstone fields when present.
- Import refuses to overwrite an existing owner namespace unless explicitly allowed and preserves imported provenance in a separate namespace.
- `DB.ExecuteSQL` remains internal/manage.

## Implementation Steps

1. Extend `app/shared/contracts/models/db.py` with RAG sharing policy/provenance/snapshot models and new typed methods.
2. Add DB service helpers for namespace normalization, provenance construction, redaction, policy checks, export/import metadata, and conflict detection.
3. Register new `@method_contract` handlers in `app/services/db/service.py` with appropriate `both` read/search exposure and `manage` export/import permissions.
4. Add focused tests in `tests/unit/db/test_service.py` covering catalog, denied/allowed remote search, redaction, export/import provenance/conflict behavior, and raw SQL exposure inventory.
5. Update `docs/DATA_SHARING_POLICY.md` to document implemented contract names, policy behavior, and deferred replication/sync semantics.

## Verification

- `uv run pytest tests/unit/db/test_service.py -q`
- `uv run pytest tests/unit/contracts -q` if contract registry tests are impacted.
- Manual registry assertions in unit tests for exposure and raw SQL internal-only behavior.

## Risks And Mitigations

- RAG store has limited native namespace inventory. Mitigation: catalog known local namespaces plus imported/export metadata and include unavailable state when RAG is disabled.
- Existing RAG items may lack provenance metadata. Mitigation: synthesize safe fallback provenance with redacted principal marker and current local owner marker.
- Export/import is a snapshot path, not full replication. Mitigation: document one-way/bidirectional sync as deferred and make tombstone behavior explicit.
