# PER-140 Plan: DB/Data Sharing Modes and Ownership Policy

## Requirements Summary

- Source issue: PER-140 `[MESH][P4-T01] Define DB/data-sharing modes and per-domain ownership policy`.
- Scope: documentation and contract exposure audit only.
- Constraints: no replication implementation, no raw cross-peer SQL, Auth credentials and mesh secrets local-authoritative by default, concrete modes for RAG/memory/chat/scheduler.
- Available source docs in this checkout: `docs/PEER_PAIRING_FLOW.md`, `docs/ARCHITECTURE.md`, `docs/SERVICE_METHODS_REFERENCE.md`, root and subsystem `AGENTS.md` files.
- Missing referenced artifacts in this branch: `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/*`.

## Acceptance Criteria

- A data-domain matrix exists and covers Auth, mesh secrets, mesh peer state, audit, chat/history, RAG/memory, tool index RAG, scheduler jobs, config, raw SQL, and hardware/audio-derived data.
- Raw SQL is explicitly excluded from mesh sharing.
- Auth credentials and mesh secrets are local-authoritative by default.
- RAG/memory/chat/scheduler domains have concrete candidate sharing modes.
- Current mesh-shareable DB/Scheduler/Auth surfaces are audited against the policy.
- Documentation links point reviewers to the policy.

## Implementation Steps

1. Audit current method exposure in `app/services/db/service.py`, `app/shared/contracts/models/db.py`, `app/services/auth/service.py`, and `app/services/scheduler/service.py`.
2. Add `docs/DATA_SHARING_POLICY.md` with policy principles, sharing mode definitions, data-domain matrix, required provenance fields, exposure audit, and follow-up gates.
3. Link the policy from `docs/ARCHITECTURE.md`.
4. Update `docs/SERVICE_METHODS_REFERENCE.md` so DB and Scheduler exposure notes point to the data-sharing policy.
5. Run docs-oriented verification: contract exposure searches, markdown sanity checks, and `git diff --check`.

## Verification Strategy

- `rg -n "ExecuteSQL|RAGSearch|GetMessages|Scheduler.Schedule|MeshCredential|MeshIdentity" app/services app/shared/contracts/models docs`
- `rg -n "raw SQL|local-authoritative|Remote query only|Bidirectional eventual sync|DATA_SHARING_POLICY" docs/DATA_SHARING_POLICY.md docs/ARCHITECTURE.md docs/SERVICE_METHODS_REFERENCE.md`
- `git diff --check`

## Risks

- The referenced roadmap/spec files are absent from the checked-out branch. Mitigation: use the Multica issue body as the source of truth and state this in the plan.
- Existing `both` read exposures could be mistaken for replication permission. Mitigation: policy states they are remote-query-only unless future sync contracts exist.
- Scheduler `both` manage methods are safety-sensitive. Mitigation: policy requires explicit target peer/resource selection and keeps execution ownership local.
