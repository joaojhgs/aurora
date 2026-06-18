# [MESH-GAP][P3] Implement DB/RAG remote query, namespace catalog, export/import policy, and provenance

## Execution metadata

- **Task ID:** MESH-GAP-007
- **Phase:** P3
- **Labels:** db, rag, memory, mesh, privacy
- **Depends on:** MESH-GAP-002, MESH-GAP-003
- **Parallelizable with:** Can run with MESH-GAP-006/MESH-GAP-008 after catalog contracts
- **Project:** 5345dd7c-2f0b-4a4b-b636-c1db93067f0a

## Shared context

This task is part of the Mesh Production E2E Gap Plan in `.omx/plans/mesh-production-e2e-integration-gap-plan.md`.

Context summary:
- The original mesh roadmap intended a production-grade cross-peer capability fabric, not generic remote service redirection.
- Generic MeshBus/PeerBridge/RPC service routing is a foundation only.
- Production must support local + multiple remote peer capability discovery, provider aggregation, route explanation, per-tool/per-resource sharing policy, approval/confirmation, auditability, and UI/SDK-visible degraded/blocked states.
- Reviewed implementation evidence came from `/tmp/aurora-mesh-review` at `origin/feat/migration-to-modular-services-architecture` commit `5e670fa`; the active local checkout was stale/diverged during review. Normalize branch state before implementation.
- Preserve Aurora's bus-first architecture, typed topic constants, Pydantic/IOModel contracts, generated config pattern, and privacy-first defaults.


<!-- BRANCH-POLICY -->
## Branch policy

- **Base / integration branch:** `feat/mesh-full-services-integrations`.
- Create implementation branches from `origin/feat/mesh-full-services-integrations`, not from `main` and not from `feat/migration-to-modular-services-architecture`.
- Pull requests for this task must merge back into `feat/mesh-full-services-integrations` unless the architect explicitly retargets the batch.
- Do not merge directly to `main` from these mesh-gap tasks. `main` receives the integrated mesh work only after the full mesh production sequence is accepted.

## Objective
Turn DB/RAG data-sharing policy into enforceable contracts. Remote data access must be namespace-scoped, provenance-preserving, and audited. Replication can remain deferred unless explicitly implemented here as export/import or one-way sync.

## Backend/API requirements
Add contracts for safe data surfaces:
- `DB/RAG.ListNamespaces` or `Memory.ListNamespaces`
- `RAG.SearchRemote` or hardened `DB.RAGSearch` with explicit namespace selector policy
- `RAG.GetProvenance`
- `RAG.ExportNamespace`
- `RAG.ImportNamespace`
- optional `RAG.SyncPull` / `RAG.SyncPush` only if one-way replication is implemented
- `ChatHistory.Export` / `ChatHistory.Query` if message history is included

Required provenance fields:
- `source_peer_id`
- `owner_peer_id`
- `namespace`
- `record_id`
- `origin_principal_id` or redacted marker
- `created_at`, `updated_at`
- `schema_version`
- `policy_decision_id`
- `correlation_id`
- tombstone fields for deletes/export-import if applicable

Policy requirements:
- Raw SQL remains internal-only.
- Auth credentials, mesh secrets, trust state remain local-authoritative and never replicated.
- Remote query requires explicit namespace/data scope selector for sensitive namespaces.
- Export/import requires permission and AdminAction/approval where personal data or peer-owned data is involved.
- Results must redact embeddings, secrets, private filesystem paths, unrelated users, and unauthorized peer records.

## Code references
- `docs/DATA_SHARING_POLICY.md`
- `app/services/db/service.py`
- `app/services/db/rag_service.py`
- `app/shared/contracts/models/db.py`
- `app/shared/messaging/models/db_models.py`
- `.omx/specs/ui-production-tasks/tasks/BE-017-add-memory-rag-provenance-export-delete-contracts.md`
- `.omx/specs/ui-production-tasks/tasks/UIA-006-wire-conversation-history-memory-and-rag-provenance-ui.md`

## Acceptance criteria
- UI/SDK can list available local/remote RAG namespaces with availability and policy.
- Remote RAG search works only when selector/policy permits.
- Export/import preserves provenance and cannot overwrite another owner namespace silently.
- Delete/tombstone behavior is defined for any imported/exported data path.
- Raw SQL is not mesh-exposed.

## Verification
- Unit tests for namespace policy, denied remote query, allowed remote query, redaction, export/import provenance.
- Integration test with two peers and one namespace.
- Negative tests for raw SQL and credential namespace leakage.
