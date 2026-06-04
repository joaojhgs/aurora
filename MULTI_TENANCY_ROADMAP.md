# Multi-Tenancy Roadmap

> **Status**: Planning document — not for immediate implementation.  
> **Prerequisite**: [Auth Service Migration](AUTH_SERVICE_MIGRATION_PLAN.md) must be completed first.  
> **Purpose**: Capture the long-term vision for multi-principal, multi-tenant Aurora so that architectural decisions made today don't close off this path.

---

## Vision

Aurora is heading toward a **multi-principal architecture** where HTTP clients, WebRTC devices, mesh peers, and API tokens are all first-class "principals." Each principal can have:

- Their own conversations and chat history
- Their own scheduled tasks
- Their own tool configurations and plugin access
- Their own RAG/memory store
- Custom permissions per resource type

Mesh peers (remote Aurora instances) become users on the local instance, and local users become users on remote instances. This enables collaborative, distributed voice assistant networks.

---

## Terminology

| Term | Definition |
|------|-----------|
| **Principal** | Any authenticated entity: human user, API token, WebRTC device, mesh peer |
| **principal_id** | Stable, opaque identifier for a principal (e.g., `usr_abc123`, `tok_xyz`, `peer_node42`) |
| **Resource** | Any scoped entity: conversation, scheduled job, tool config, RAG document |
| **Ownership** | A principal_id foreign key on a resource row in the database |
| **Delegation** | A principal granting another principal access to their resources |
| **System principal** | `principal_id=None` — internal service-to-service operations |

---

## Phases

### Phase 0: Foundation (completed via Auth Service Migration)

- [x] `principal_id: str | None = None` on Envelope
- [x] Transport layers inject `principal_id` (HTTP, WebRTC, mesh)
- [x] Auth service owns all identity/token/permission logic
- [x] BaseService contract wrapper can pass Envelope to handlers
- [x] Gateway is transport-only, no auth business logic

**After Phase 0**: The bus carries identity. Services *can* read `principal_id` but don't use it yet. All existing behavior is unchanged (everything is effectively single-tenant).

---

### Phase 1: Multi-User Conversations

**Goal**: Each principal has their own conversation history. When User A talks to Aurora, User B doesn't see User A's messages, and the LLM doesn't mix contexts.

**Changes**:

#### DBService
- Add `principal_id TEXT` column to `messages` table
- `DB.StoreMessage` reads `envelope.principal_id` and stores it
- `DB.GetRecentMessages` filters by `envelope.principal_id`
- Migration: existing messages get `principal_id = "default"` (backwards-compatible)

#### OrchestratorService
- Conversation context scoped by `principal_id`
- Each principal has independent conversation state
- System prompt can be customized per principal (future)

#### UIBridge
- UI shows only the current principal's messages
- Login flow sets the UI's principal context

#### Migration strategy
- Default principal `"default"` for backwards compatibility
- Single-user installations: everything works as before (one principal, one conversation)
- Multi-user: each authenticated user gets isolated conversations

**Estimated scope**: ~200 lines changed across 3-4 files.

---

### Phase 2: Multi-User Resources

**Goal**: Scheduled tasks, tool configurations, and RAG documents are owned by principals.

#### SchedulerService
- Add `principal_id TEXT` column to `cron_jobs` table
- `Sched.Schedule` stores `envelope.principal_id` as owner
- `Sched.List` returns only the caller's jobs
- `Sched.Cancel` only allows cancelling own jobs (or admin override)
- When a cron job fires, the resulting bus message carries the original `principal_id`

#### ToolingService
- Plugin activation can be scoped per principal
- Example: User A has Jira enabled, User B doesn't
- Tool execution carries `principal_id` for audit and access control
- MCP server access can be gated per principal

#### DBService (RAG)
- Add `principal_id TEXT` column to RAG document tables
- Vector search scoped by `principal_id`
- Each principal has their own knowledge base
- Shared knowledge: `principal_id = "shared"` or `NULL`

#### Migration strategy
- Existing resources: `principal_id = "default"`
- New resources: inherit from `envelope.principal_id`
- Admin APIs can reassign ownership

**Estimated scope**: ~400 lines across 5-6 files.

---

### Phase 3: Per-Principal Configuration

**Goal**: Principals can customize their Aurora experience.

#### What's configurable per principal
- LLM provider and model (e.g., User A uses GPT-4, User B uses local llama)
- TTS voice (e.g., User A uses English, User B uses Portuguese)
- System prompt / personality
- Wake word sensitivity
- Plugin activation
- Notification preferences

#### Implementation approach
- New DB table: `principal_configs` with `principal_id`, `key`, `value`
- Config resolution: principal config → global config → default
- Services call `Config.GetForPrincipal(principal_id, key)` — falls back to global if not set

#### ConfigService changes
- New contract: `Config.GetForPrincipal`
- New contract: `Config.SetForPrincipal`
- Config change events include `principal_id` scope

**Estimated scope**: ~300 lines, mainly ConfigService + DB schema.

---

### Phase 4: Cross-Principal Collaboration

**Goal**: Principals can share resources and delegate access.

#### Delegation tokens
- A principal can create a scoped delegation token:
  ```
  Auth.CreateDelegation(
      grantor="usr_alice",
      grantee="usr_bob",
      resource_type="conversation",
      resource_id="conv_123",
      scopes=["read"]
  )
  ```
- Delegation tokens are time-limited and revocable
- Stored in the auth database

#### Resource-level ACLs
- Beyond principal ownership, individual resources can have ACLs:
  ```
  {
      "resource_type": "cron_job",
      "resource_id": "job_456",
      "acls": [
          {"principal_id": "usr_alice", "scopes": ["read", "write", "delete"]},
          {"principal_id": "usr_bob", "scopes": ["read"]}
      ]
  }
  ```
- Services check ACLs when accessing resources

#### Shared workspaces
- Groups of principals can share a conversation context
- Use case: family/team Aurora instances
- Shared conversations have a special `principal_id` (e.g., `group_family`)

**Estimated scope**: ~600 lines, significant DB schema changes.

---

### Phase 5: Mesh Peers as Principals

**Goal**: When Aurora Instance B connects to Aurora Instance A via mesh, Instance B's users can interact with Instance A's services as recognized principals.

#### How it works today (after Auth Service Migration)
- Mesh peers authenticate via the pairing flow
- Each peer gets a `MESH_PEER` identity with negotiated permissions
- Events forwarded via mesh carry `origin="mesh_forwarded"`
- `principal_id` does NOT cross the mesh boundary

#### What changes
- Mesh peers register as principals on the remote instance: `peer_instanceB`
- Requests from peer B's users carry `peer_instanceB:usr_alice` as `principal_id`
- Remote instance resolves this to a local principal mapping

#### Principal mapping
```json
{
    "mesh_principal_mappings": {
        "peer_instanceB:usr_alice": {
            "local_principal_id": "mesh_usr_alice_from_B",
            "scopes": ["conversations.read", "conversations.write", "tts.request"],
            "auto_create": true
        }
    }
}
```

#### Trust model
- Instance A decides what Instance B's users can do
- Scopes are intersection of: peer permissions ∩ user-level mapping ∩ resource ACLs
- Audit trail shows cross-instance operations

**Estimated scope**: ~500 lines, mesh protocol changes, new DB tables.

---

## Database Ownership Model

### Schema pattern

Every resource table gets a `principal_id` column:

```sql
-- Messages
ALTER TABLE messages ADD COLUMN principal_id TEXT DEFAULT 'default';
CREATE INDEX idx_messages_principal ON messages(principal_id);

-- Cron jobs
ALTER TABLE cron_jobs ADD COLUMN principal_id TEXT DEFAULT 'default';
CREATE INDEX idx_cron_jobs_principal ON cron_jobs(principal_id);

-- RAG documents
ALTER TABLE rag_documents ADD COLUMN principal_id TEXT DEFAULT 'default';
CREATE INDEX idx_rag_docs_principal ON rag_documents(principal_id);

-- Principal configs
CREATE TABLE principal_configs (
    id INTEGER PRIMARY KEY,
    principal_id TEXT NOT NULL,
    config_key TEXT NOT NULL,
    config_value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(principal_id, config_key)
);

-- Delegations
CREATE TABLE delegations (
    id INTEGER PRIMARY KEY,
    grantor TEXT NOT NULL,
    grantee TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    scopes TEXT NOT NULL,  -- JSON array
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Migration strategy
1. Add columns with `DEFAULT 'default'` — zero downtime
2. Backfill existing rows
3. Update queries to filter by `principal_id`
4. Index for performance

---

## Service Impact Summary

| Service | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|---------|---------|---------|---------|---------|---------|
| **Auth** | — | — | — | Delegation APIs | Mesh principal mapping |
| **DB** | Message scoping | RAG scoping | Principal configs table | ACL storage | — |
| **Orchestrator** | Conversation scoping | — | Per-principal LLM config | Shared conversations | — |
| **TTS** | — | — | Per-principal voice | — | — |
| **Scheduler** | — | Job ownership | — | Delegated jobs | — |
| **Tooling** | — | Per-principal plugins | — | — | — |
| **Config** | — | — | Config.GetForPrincipal | — | — |
| **Gateway** | — | — | — | — | Mesh principal forwarding |
| **STT** | — | — | Per-principal wake word | — | — |

---

## Decision Log

| Decision | Rationale | Alternatives considered |
|----------|-----------|----------------------|
| `principal_id` is a string, not a structured object | Keeps the bus simple; services that need more context call `Auth.ResolveIdentity` | Embedding full Identity in Envelope (too heavy, couples all services to auth schema) |
| `principal_id` defaults to `None` | Zero-breakage for existing code; `None` means "system/internal" | Requiring principal_id everywhere (too invasive) |
| Per-principal config is DB-backed, not file-backed | Scales to many principals; doesn't require config.json per user | Separate config files per user (doesn't scale) |
| Mesh peers don't forward `principal_id` automatically | Security: remote instance shouldn't blindly trust identity claims | Auto-forwarding (trust issues, identity spoofing) |
| Backwards-compatible `"default"` principal for existing data | Zero-migration for single-user installations | Requiring migration before upgrade (too disruptive) |
| Phases are independent and incremental | Can ship value at each phase; no big-bang migration | Single massive migration (too risky) |

---

## Open Questions

1. **Principal quotas**: Should there be resource limits per principal? (e.g., max conversations, max scheduled jobs)
2. **Principal groups/roles**: Do we need groups (admin, user, guest) or is per-principal scoping sufficient?
3. **Principal lifecycle**: What happens when a principal is deleted? Soft delete? Cascade?
4. **Cross-principal search**: Should admins be able to search across all principals' conversations?
5. **Billing/metering**: If Aurora-as-a-service becomes a thing, do we need per-principal usage tracking?
6. **STT scoping**: How do multiple principals share the microphone? (Only relevant for local multi-user)
7. **Mesh trust bootstrapping**: How does Instance A verify that Instance B's user claims are legitimate?

---

## Implementation Order Recommendation

```
Auth Service Migration (prerequisite)
    ↓
Phase 1: Multi-User Conversations (highest user value)
    ↓
Phase 2: Multi-User Resources (completes per-user isolation)
    ↓
Phase 3: Per-Principal Configuration (personalization)
    ↓
Phase 4: Cross-Principal Collaboration (advanced use cases)
    ↓
Phase 5: Mesh Peers as Principals (distributed multi-tenancy)
```

Each phase is independently shippable. Phase 1 alone delivers significant value for multi-user households. Phases 4-5 are "horizon" features that may evolve significantly before implementation.

---

**Last Updated**: January 2026  
**Status**: Planning — not approved for implementation  
**Prerequisite**: AUTH_SERVICE_MIGRATION_PLAN.md
