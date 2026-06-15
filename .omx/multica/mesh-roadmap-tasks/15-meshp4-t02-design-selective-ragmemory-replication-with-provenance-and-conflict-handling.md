## Objective
Enable peers to share useful memory/RAG data without blindly merging entire databases. This should support selective replication with provenance, conflict handling, delete semantics, and privacy controls.

## Context
This task is part of the Aurora mesh-polishing roadmap derived from `.omx/specs/deep-interview-mesh-distributed-integration.md`.

Current confirmed baseline:
- Targeted mesh/gateway tests previously passed: `88 passed, 13 warnings`.
- `MeshBus` already routes commands and mesh events through routing/peer bridge paths.
- WebRTC pairing, manifest exchange, service negotiation, and service sharing are implemented to a working baseline.
- Orchestrator already uses the bus for Tooling discovery/execution, and Tooling exposes `GetTools`/`ExecuteTool` as mesh-shareable methods.

Roadmap constraints:
- Preserve Aurora's privacy-first, message-bus-first microservice architecture.
- Use pragmatic security tiers across home LAN/VPN, Docker/process clusters, and internet-crossing peers.
- Use hybrid addressing: transparent routing is allowed for low-risk service dependencies, but explicit peer/resource addressing is required for tools, DB/data, hardware, scheduler ownership, remote playback, and safety-sensitive actions.
- Prefer existing contracts/utilities and typed topic constants; avoid exposing raw internal/admin capabilities by default.

Current baseline:
- DB exposes RAG search as mesh-shareable, while most write/list/get operations are internal.
- Current mesh can route DB calls but does not define replication semantics.

Relevant code anchors:
- `app/services/db/rag_service.py`
- `app/services/db/service.py`
- `app/shared/messaging/models/db_models.py`
- Future data policy from `[MESH][P4-T01]`.

## Initial implementation plan
1. Define replicated item metadata: namespace, owner peer, source peer, version/vector clock or timestamp strategy, tombstone, visibility, encryption/redaction flags.
2. Choose initial replication mode: likely explicit export/import or selective one-way sync before bidirectional sync.
3. Add sync contracts only for the approved RAG/memory subset.
4. Implement conflict resolution policy appropriate for personal assistant memories.
5. Add privacy controls for sensitive memories and deletion propagation.

## Acceptance criteria
- RAG/memory replication has a documented and tested conflict model.
- Sync is namespace-scoped and opt-in.
- Deletes/tombstones are represented.
- Provenance is queryable.
- No raw SQL or auth/credential data is replicated.

## Suggested verification
- Unit tests for merge/conflict/tombstone behavior.
- Integration test for two peers syncing a small namespace.
