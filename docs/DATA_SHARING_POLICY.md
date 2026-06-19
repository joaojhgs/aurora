# Aurora Mesh DB/Data Sharing Policy

This document defines the data-sharing policy that must exist before any DB or
RAG replication work is implemented. It applies to mesh routing, WebRTC RPC, and
future data-sync contracts.

## Policy Principles

1. Aurora never exposes raw cross-peer SQL as a mesh capability.
2. Auth credentials, mesh secrets, stable peer identity, and trust decisions are
   local-authoritative unless a separate trust model is approved.
3. Data sharing is opt-in per domain, namespace, and peer policy. Default
   behavior is local-only.
4. Safety-sensitive data access uses explicit mesh selectors. Transparent module
   routing is not enough for DB/data namespaces, scheduler ownership, tools,
   hardware controls, remote playback, or privacy-sensitive content.
5. Shared data must carry provenance: source peer, owning authority, caller
   principal when known, target peer/resource, policy decision, correlation ID,
   and sync/import operation ID where applicable.
6. Deletion and forget semantics must be defined before replication. If Aurora
   cannot propagate a delete safely, the domain must remain remote-query-only or
   export/import-only.

## Sharing Modes

| Mode | Meaning | When Allowed |
|------|---------|--------------|
| Never share | No mesh read, write, export, or sync contract. Local APIs only. | Secrets, credentials, trust anchors, local-only hardware state. |
| Remote query only | A peer may request a filtered result from the owning peer. No copy is retained except transient response/cache data. | Low-risk reads where the owner can enforce policy at query time. |
| Export/import | A user or policy-approved automation creates a bounded snapshot that another peer imports into a separate namespace. | Portable memories, curated knowledge packs, diagnostics bundles. |
| One-way replication | A single authoritative source publishes changes to subscribed peers. Subscribers do not write back. | Curated data with clear source authority and delete propagation. |
| Bidirectional eventual sync | Multiple peers can create/update/delete records and converge through conflict policy. | Only after per-domain IDs, conflict resolution, tombstones, and privacy rules are specified. |

## Domain Matrix

| Domain | Current storage/contracts | Allowed mode | Ownership and namespace | Delete/forget semantics | Notes |
|--------|---------------------------|--------------|-------------------------|-------------------------|-------|
| Auth users, devices, tokens, permissions | Auth service owns principal/token/device contracts; DB exposes internal CRUD for persistence. | Never share by DB/data sync. | Local Auth service is authoritative for local principals, devices, tokens, and effective permissions. | Local revoke/delete only. Peer access must be changed through Auth mesh permission contracts, not data replication. | Credential material and token hashes must not be exported or replicated. |
| Mesh identity and credentials | Auth mesh identity/peer credential contracts; DB mesh credential storage is internal. | Never share by DB/data sync. | Local Auth/Gateway own stable peer ID, outbound/inbound credentials, room material, and trust status. | Local delete/revoke only, with explicit peer-deny/remove flows for trust changes. | Mesh secrets are local-authoritative even when a paired peer knows its own reciprocal credential. |
| Mesh peer registry and trust state | Auth `MeshListPeers`, `MeshGetPeer`, `MeshApprovePeer`, `MeshDenyPeer`, `MeshUpdatePeerPermissions`, `MeshRemovePeer`. | Remote query only for redacted peer status; never replicate trust tables. | Each node owns its view of remote peers, approvals, permissions, connection state, and inbound grants. | Removal/deny applies to the local trust store; reciprocal cleanup requires peer-side action. | Query responses must redact stored tokens and credential material. |
| Audit log | Auth `StoreAuditEvent` internal write; `AuditLog` manage read. | Remote query only, or export/import for support bundles. | Event owner is the peer that observed and stored the event. | Audit events are append-only unless a local retention/erasure policy explicitly removes them. | Cross-peer audit views must preserve source peer and correlation ID. |
| Chat/message history | DB `SaveMessage` internal write; `GetMessages` and `GetMessagesForDate` are currently `both`. | Remote query only by default; export/import for user-approved history moves. Bidirectional sync is deferred. | Owner is the peer/session that captured the conversation. Shared namespace must include source peer and session/user scope. | User forget/delete must create a tombstone or remain local-only. Imported copies must retain origin metadata so deletes can be evaluated. | External read exposure is acceptable only as filtered history retrieval, not replication. |
| RAG/memory user knowledge | DB `RAGSearch` is `both`; `RAGStore`, `RAGDelete`, `RAGGet`, and `RAGList` are internal. | Remote query only by default; export/import for curated namespaces; one-way replication allowed for explicitly published namespaces; bidirectional sync deferred. | Namespace owner is the peer that created the namespace. Shared namespace format should include `peer_id`, data domain, and user/project scope. | Deletes require tombstones per key/namespace before replication. Export/import snapshots must record source and import time. | Existing `mesh_selector` fields support explicit peer/namespace intent, but no sync contract exists yet. |
| Tool index RAG namespace | Tooling writes `main.tools`-style RAG data via DB internal RAG contracts. | One-way replication from the tool provider, or remote query only. | Tool provider peer owns its advertised tool index. | Provider withdrawal or tool deletion must invalidate subscriber copies. | This is derived metadata; never treat it as a source for executing a tool without Tooling policy. |
| Scheduler jobs and ownership | Scheduler `Schedule`, `Cancel`, `ListJobs` are `both`; DB cron-job persistence is internal. | Remote query only for listing. Export/import is allowed for user migration. One-way replication is allowed only for passive calendar/reminder mirrors. | Job owner is the peer that will execute the job. Resource namespace must include executing peer and job ID. | Cancel/delete belongs to the executing peer. Imported jobs are new local jobs with new IDs unless a future scheduler sync contract defines ownership transfer. | Remote scheduling must use explicit target peer/resource selection and policy, not transparent routing. |
| Config values and feature flags | Config has external get/set/validate contracts. | Never share by DB/data sync. Remote query/manage only through Config contracts and permissions. | Local Config service owns local settings. | Local set/delete/reset semantics only. | Config mutation is administrative and outside DB replication scope. |
| Raw DB tables and SQL results | DB `ExecuteSQL` exists as an internal manage contract for service internals. | Never share. | Local DB service only. | Not applicable. | No mesh route, export, sync, or RPC wrapper may expose arbitrary SQL or table dumps. |
| Hardware, audio, playback, and microphone-derived streams | STT/TTS/audio services, not DB domains. | Never share as DB/data. | Local device owner controls hardware and live streams. | Local session cleanup only. | Referenced here because derived transcripts/messages may be shareable only after capture and policy filtering. |

## Required Fields for Future Shared Data

Any future export/import, replication, or sync contract must include:

- `source_peer_id`
- `owner_peer_id`
- `namespace`
- `record_id` stable within the namespace
- `origin_principal_id` or an explicit redacted/unknown marker
- `created_at` and `updated_at`
- `schema_version`
- `policy_decision_id` or equivalent audit reference
- `correlation_id`
- optional `tombstone` with `deleted_at`, `deleted_by`, and reason class

The contract must not include raw SQL, table names as authority boundaries, token
values, password hashes, mesh room secrets, or unredacted credential material.

## Current Contract Exposure Audit

The current code aligns with a policy-first posture, with caveats for future
implementation:

- `DB.ExecuteSQL` is `internal` and `manage`; it must remain internal-only and
  must not be mesh-shareable.
- `DB.GetMessages`, `DB.GetMessagesForDate`, and `DB.RAGSearch` are `both`.
  These are read/query surfaces and are compatible with remote-query-only policy
  when protected by peer permissions and explicit selectors for remote DB/data
  access.
- `DB.RAGListNamespaces` is `both` and returns a policy-aware namespace catalog:
  availability, source/owner peer, allowed operations, privacy class, explicit
  selector requirement, and export/import support.
- `DB.RAGSearchRemote` is `both` and enforces explicit remote namespace intent.
  When a request carries a remote mesh selector, the selector must include
  `resource_namespace` or `data_scope` matching the requested namespace. Denied
  requests return a typed policy denial instead of falling back to another
  namespace/provider.
- `DB.RAGGetProvenance` is `both` and returns record provenance without exposing
  internal RAG metadata.
- `DB.RAGExportNamespace` and `DB.RAGImportNamespace` are `both`/`manage` with
  `DB.manage` permission. They implement bounded export/import snapshots, not
  continuous replication.
- `DB.RAGStore`, `DB.RAGDelete`, `DB.RAGGet`, `DB.RAGList`, and DB cron-job
  persistence methods are internal. They are not current replication contracts.
- RAG request models already include optional `mesh_selector`; this preserves
  caller intent for explicit peer/namespace targeting but does not by itself
  authorize sync.
- Scheduler scheduling/cancel/list contracts are `both`, but scheduler ownership
  remains the executing peer's responsibility. Replication must not copy jobs
  across peers without ownership-transfer policy.
- Auth principal/token/device management and mesh peer management are controlled
  through Auth contracts. The underlying DB rows are not DB/data-sharing domains.

## Implemented RAG Namespace Contracts

The implemented RAG namespace contracts use schema version
`rag-provenance.v1` for records and `rag-export.v1` for namespace snapshots.
Each exported/imported or remote-search result carries:

- `source_peer_id`
- `owner_peer_id`
- `namespace`
- `record_id`
- `origin_principal_id`, using `redacted` when no safe principal can be exposed
- `created_at` and `updated_at`
- `schema_version`
- `policy_decision_id`
- `correlation_id`
- tombstone fields when a delete marker is present

Search and export responses redact raw embeddings, vector fields, secrets,
credential material, tokens/passwords, internal Aurora metadata, and private
filesystem path fields before returning records to a peer or UI.

Import preserves the source and owner provenance while writing into the target
namespace with an `import_operation_id` and `imported_at` timestamp. It refuses
to write into a non-empty target namespace unless the caller explicitly sets the
overwrite flag, preventing silent owner-namespace replacement.

One-way and bidirectional sync remain deferred. Future sync contracts must add
source authority, subscription, conflict resolution, delete propagation, and
retention semantics before copying data continuously across peers.

## Follow-up Gates

Before implementing P4 data sync or replication work, create explicit follow-up
contracts/specs for:

1. RAG one-way published namespace replication with tombstones.
2. Chat history export/import with user-scoped redaction and delete handling.
3. Scheduler migration/import that creates new local jobs unless ownership
   transfer is explicitly approved.
4. Redacted cross-peer audit query/export for diagnostics.
