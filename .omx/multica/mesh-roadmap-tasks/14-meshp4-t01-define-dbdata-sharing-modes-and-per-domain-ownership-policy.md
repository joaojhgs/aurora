## Objective
Create an explicit DB/data sharing policy before implementing replication. Each data domain needs a chosen mode: remote query only, export/import, one-way replication, bidirectional eventual sync, or never share.

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

Roadmap constraint:
- Avoid raw cross-peer SQL as a shared capability.
- Keep Auth and mesh credential tables local-authoritative unless a separate trust model is approved.

Relevant code anchors:
- `app/services/db/service.py`
- `app/shared/messaging/models/db_models.py`
- `app/services/db/rag_service.py`
- `app/services/scheduler/service.py`
- `app/services/auth/service.py`

## Initial implementation plan
1. Inventory DB-backed data domains and current contract exposures.
2. For each domain, document allowed sharing modes and non-goals.
3. Define namespace ownership and identity/provenance fields required for shared data.
4. Decide deletion/forget semantics and whether redaction is needed before cross-peer sync.
5. Produce implementation follow-up tasks only after policy is explicit.

## Acceptance criteria
- A data-domain matrix exists and is reviewed.
- Raw SQL is explicitly excluded from mesh sharing.
- Auth credentials and mesh secrets are marked local-authoritative by default.
- RAG/memory/chat/scheduler data have concrete candidate sharing modes.

## Suggested verification
- Documentation review.
- Contract exposure audit to ensure current `both` methods align with intended policy.
