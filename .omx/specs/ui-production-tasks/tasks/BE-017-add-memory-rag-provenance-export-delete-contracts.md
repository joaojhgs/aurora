# BE-017 — Add memory/RAG provenance, export, and delete contracts


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/db-rag
- **Depends on:** P0-002, BE-004, MESH-GAP-007
- **Parallelizable with:** BE-006, UIA-006
- **Coverage matrix rows:** assistant.memory_rag, admin.backup_restore
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Expose safe, permissioned memory/RAG read/provenance/export/delete surfaces so the assistant memory UI does not rely on internal-only DB methods.

## User-visible outcome

Users can inspect memory/RAG provenance, understand what context was used, export permitted records, and request deletion through auditable flows.

## Backend/API implementation details

- Inventory existing `DBMethods.RAG_SEARCH`, `RAG_GET`, `RAG_DELETE`, store/list behavior, and exposure levels before changing any route.
- Decide explicit public/manage contracts for memory list/search/get/provenance/export/import/delete/tombstone behavior, or mark each unsupported state in the executable capability catalog.
- Wrap delete/export/manage operations in AdminAction/audit where user data or admin-critical data is affected.
- Add provenance fields: source type, namespace, key/id, created/updated when available, privacy class, retention policy, embedding/model metadata when safe, and citation/source links when available.
- Do not expose raw embeddings, secret namespaces, private filesystem paths, or unrelated users/peers memory data.

## SDK integration details

- Add SDK types for `MemoryItem`, `RagProvenance`, `MemoryExport`, retention/deletion results, and degraded unsupported states.
- Capability catalog must distinguish `search_only`, `provenance_available`, `delete_available`, `export_available`, `import_available`, `tombstone_supported`, and `retention_policy_available`.

## Tauri/native integration details

- No direct native work; Tauri/mobile transports consume the same SDK contract and native file-save/share dialogs only for export artifacts.

## UI/UX implementation details

- `UIA-006` must use this contract for memory details/provenance/delete/export states.
- Admin backup/restore remains in `BE-006`/`ADM-010`; this task owns user-visible memory governance, not whole-database backup.

## Code references to inspect first

- `app/services/db/service.py` RAG methods and exposure levels
- `app/shared/contracts/models/db.py` DB/RAG topics and IO models
- `app/shared/messaging/models/db_models.py` RAG payload models
- `app/services/orchestrator/` memory/RAG usage if present
- `tests/unit/services/db` or nearest DB service tests

## Mock/component references

- `modules/ui-mock-reference/app/(cockpit)/memory/page.tsx`
- `modules/ui-mock-reference/components/aurora/assistant/assistant-view.tsx`
- `modules/ui-mock-reference/components/aurora/admin/overview.tsx`

## Data, permissions, and privacy contract

- Use typed topic constants, Pydantic/IOModel payloads, registered method contracts, and PascalCase permissions.
- Treat personal memory, schedules, job payloads, RAG namespaces, and tool arguments as sensitive unless explicitly public.
- Mutations require AdminAction/audit when method type is manage/admin-critical.

## Acceptance criteria

- Backend contract explicitly covers memory/RAG list/search/get/provenance/export/delete or returns capability-gated unsupported states.
- Delete/export operations are permissioned, audited, and do not bypass AdminAction where required.
- UIA-006 can implement every visible memory/RAG action without inventing backend behavior.

## Verification commands / evidence

- Targeted DB/RAG contract tests for exposed methods and denied/internal-only paths.
- Gateway/OpenAPI/registry inventory includes exposure and permission metadata.
- Privacy tests prove no embeddings/secrets/other-user memory records leak.

## Risks and guardrails

- Do not make internal-only methods public without permission/audit review.
- Do not fake UI support by silently ignoring unsupported backend actions.
- Do not leak personal data, job arguments, model paths, embeddings, or peer-owned records.

## Handoff notes

- Added by full coverage review after Critic rejection identified this backend contract as implicit/weak.

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This task is expanded by `MESH-GAP-007` for remote DB/RAG usage.

Additional backend requirements:

- Add remote RAG namespace/catalog contracts that list namespace owner, peer/provider, sharing policy, privacy class, freshness, embedding/model compatibility, allowed operations, and export/delete support.
- Add explicit `mesh_selector`/resource selector support to allowed read/query operations where remote execution is supported.
- Add export/import contracts for user-approved sharing of RAG/memory subsets; raw DB write/admin operations remain non-default and AdminAction-gated.
- Define tombstone/delete semantics for any exported/imported namespace; UI must not promise delete propagation unless backend exposes it.
- Include provenance in every remote RAG result: peer/provider, namespace, source document/conversation, privacy class, route path, audit/correlation ID, and redaction status.
- Add denial reasons for unavailable namespace, incompatible embeddings, insufficient permission, explicit selector missing, and policy block.

Additional acceptance criteria:

- UI can safely show remote memory search results without implying local ownership.
- Export/import/delete flows are auditable and cannot run via transparent fallback.
