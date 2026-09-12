# Bus Topic Permissions Unification Plan

## Problem Statement

Aurora currently has **two disconnected permission namespaces**:

1. **Bus topics** (PascalCase): `Auth.PairingApprove`, `TTS.Request`, `Config.Set`
2. **Permission strings** (lowercase dotted): `auth.approve`, `tts.request`, `config.write`

This creates several problems:
- The route generator injects `scopes = [method_id] + required_perms` — mixing PascalCase bus topics with lowercase permission strings
- `identity.can("Auth.PairingApprove")` fails for non-admins because users hold `auth.approve`, not `Auth.PairingApprove`
- Two parallel taxonomies to maintain, keep in sync, and reason about
- Granting fine-grained per-method permissions requires knowing the bus topic name — which IS the unique identifier for the action already

## Design Goals

1. **Bus topics ARE permissions** — a single namespace, no translation layer
2. **`method_type` on contracts** — categorize methods as `"manage"` or `"use"` for coarse-grained access
3. **Backward compatible** — existing `"*"` and wildcard `"Auth.*"` patterns keep working
4. **Version-resilient** — `Auth.use` and `Auth.manage` work even when service versions differ and specific method topics may not exist in the Permission type yet
5. **No cross-service imports for type resolution** — JSON Schema carries enum values over the wire

## New Permission Model

### Permission Format

Permissions are now bus topic strings. Three levels of granularity:

| Level | Example | Grants |
|-------|---------|--------|
| **Superuser** | `*` | Everything |
| **Service wildcard** | `Auth.*` | All Auth methods |
| **Service + type** | `Auth.use` | All Auth methods with `method_type="use"` |
| **Service + type** | `Auth.manage` | All Auth methods with `method_type="manage"` |
| **Granular method** | `Auth.PairingApprove` | Only that specific method |

### How `method_type` Works

Each `@method_contract` gets a new `method_type` parameter:
- `"use"` — core functionality consumers need (send TTS, query LLM, list items)
- `"manage"` — administrative actions (create/delete users, change config, approve peers)

The `method_type` is **NOT stored as a permission string itself**. Instead, it's metadata on the contract that the permission engine uses during matching:

```
User has: ["TTS.use"]
Request needs: ["TTS.Request"]  (TTS.Request has method_type="use")
→ "TTS.use" matches because TTS.Request's type IS "use"
→ ✅ GRANTED
```

```
User has: ["TTS.use"]
Request needs: ["TTS.Stop"]  (TTS.Stop has method_type="manage")
→ "TTS.use" does NOT match "manage" methods
→ ❌ DENIED
```

### Matching Rules (ordered by priority)

1. `"*"` in user perms → always granted (superuser)
2. `"Auth.*"` in user perms → any `Auth.X` method granted (full service wildcard)
3. `"Auth.use"` in user perms → any `Auth.X` where `method_type="use"` granted
4. `"Auth.manage"` in user perms → any `Auth.X` where `method_type="manage"` granted
5. `"Auth.PairingApprove"` in user perms → exact match only (granular)

### Why This Is Version-Resilient

When service v2 adds `Auth.NewMethod(method_type="use")`:
- Users with `Auth.use` automatically get access — no permission update needed
- Users with `Auth.*` automatically get access
- Users with only `Auth.Login` (granular) don't get access — correct behavior

When a service is down and the gateway doesn't know about `Auth.NewMethod`:
- `Auth.use` and `Auth.manage` still work as permission strings — they don't require knowing every method
- The permission engine doesn't need the registry to validate them — it pattern-matches on the prefix

---

## Changes Required

### Phase 1: Add `method_type` to Contract System

#### 1.1 `app/shared/contracts/registry.py`

**MethodContract model** — add `method_type` field:
```python
class MethodContract(BaseModel):
    # ... existing fields ...
    method_type: str = "use"  # "use" or "manage"
```

**`method_contract` decorator** — accept `method_type`:
```python
def method_contract(
    method_id: str,
    summary: str = "",
    input_model: type[IOModel] | None = None,
    output_model: type[IOModel] | None = None,
    exposure: str = "internal",
    default_priority: int = 50,
    method_type: str = "use",  # NEW
    **kwargs,
):
```

#### 1.2 `app/shared/contracts/models/gateway.py`

**MethodInfo** — add `method_type` to wire format:
```python
class MethodInfo(IOModel):
    # ... existing fields ...
    method_type: str = "use"
```

#### 1.3 `app/shared/services/base_service.py`

Update `_publish_service_announcement()` to include `method_type` in the MethodInfo.

#### 1.4 `app/services/gateway/registry_aggregator.py`

Update `_method_info_from_contract()` to pass through `method_type`.

---

### Phase 2: Update Permission Engine

#### 2.1 `app/shared/auth/permissions.py`

**Key design**: `KNOWN_PERMISSIONS` and `KNOWN_PERMISSION_PREFIXES` are **not manually maintained**.
They are **auto-generated** by importing the existing `*Methods` classes that every service already
declares in `app/shared/contracts/models/`. All services already import these classes to make bus
calls, so this creates no new coupling.

```python
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.config import ConfigMethods
from app.shared.contracts.models.db import DBMethods
from app.shared.contracts.models.gateway import GatewayMethods
from app.shared.contracts.models.orchestrator import OrchestratorMethods
from app.shared.contracts.models.scheduler import SchedulerMethods
from app.shared.contracts.models.stt import STTMethods, WakeWordMethods, TranscriptionMethods
from app.shared.contracts.models.supervisor import SupervisorMethods
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods

# All *Methods classes that declare bus topics
_ALL_METHOD_CLASSES: tuple[type, ...] = (
    AuthMethods, ConfigMethods, DBMethods, GatewayMethods,
    OrchestratorMethods, SchedulerMethods, STTMethods,
    WakeWordMethods, TranscriptionMethods, SupervisorMethods,
    ToolingMethods, TTSMethods,
)


def _collect_permissions(*method_classes: type) -> tuple[set[str], set[str]]:
    """Build KNOWN_PERMISSIONS and KNOWN_PERMISSION_PREFIXES from *Methods classes.

    Extracts every string constant of the form "Service.Action" from each
    class, then auto-generates:
    - Per-service wildcards: "Auth.*", "TTS.*", ...
    - Per-service type permissions: "Auth.use", "Auth.manage", ...
    - The superuser wildcard: "*"

    Returns:
        (known_permissions, known_prefixes)
    """
    permissions: set[str] = {"*"}
    prefixes: set[str] = set()

    for cls in method_classes:
        for attr in dir(cls):
            if attr.startswith("_"):
                continue
            val = getattr(cls, attr)
            if isinstance(val, str) and "." in val:
                permissions.add(val)
                prefixes.add(val.split(".")[0])

    # Auto-generate wildcard and type-based permissions per service prefix
    for prefix in prefixes:
        permissions.add(f"{prefix}.*")
        permissions.add(f"{prefix}.use")
        permissions.add(f"{prefix}.manage")

    return permissions, prefixes


KNOWN_PERMISSIONS, KNOWN_PERMISSION_PREFIXES = _collect_permissions(*_ALL_METHOD_CLASSES)
```

**Why this works**:
- When a service adds a new method to its `*Methods` class, `KNOWN_PERMISSIONS` picks it up automatically on next import — zero manual maintenance.
- `{Prefix}.use` and `{Prefix}.manage` are auto-generated for every discovered service prefix — version-resilient.
- Event topics (e.g. `TTS.Started`) are included harmlessly — they'll never be checked as permissions but don't hurt.
- The set is frozen at import time (same as before), which is correct for `WithJsonSchema(enum)`.
- This imports from `app/shared/contracts/models/` which is the **shared folder** — all services already depend on it for bus calls, so no new coupling is introduced.

**`validate_permission()` stays the same** but now operates on auto-generated sets:
```python
def validate_permission(perm: str) -> str:
    if perm == "*":
        return perm
    if perm in KNOWN_PERMISSIONS:
        return perm
    prefix = perm.split(".")[0]
    if prefix in KNOWN_PERMISSION_PREFIXES:
        return perm  # Unknown specific method under known service — OK
    raise ValueError(...)
```

**Update `has_permission()`** — add `method_type` awareness:
```python
def has_permission(
    required: str,
    granted_perms: set[str],
    method_type: str | None = None,
) -> bool:
    # 1. Superuser
    if "*" in granted_perms:
        return True
    # 2. Exact match
    if required in granted_perms:
        return True
    # 3. Service wildcard: "Auth.*" matches any "Auth.X"
    if "." in required:
        parts = required.split(".")
        for perm in granted_perms:
            if perm.endswith(".*"):
                prefix_parts = perm[:-2].split(".")
                if len(prefix_parts) < len(parts) and parts[:len(prefix_parts)] == prefix_parts:
                    return True
    # 4. Type-based: "Auth.use" matches "Auth.PairingApprove" if method_type="use"
    if method_type and "." in required:
        service_prefix = required.split(".")[0]
        type_perm = f"{service_prefix}.{method_type}"
        if type_perm in granted_perms:
            return True
    return False
```

#### 2.2 `app/shared/auth/identity.py`

Update `Identity.can()` to optionally accept `method_type`:
```python
def can(self, *permissions: str, method_type: str | None = None) -> bool:
    if self.is_admin:
        return True
    return check_access(set(self.effective_perms), list(permissions), method_type=method_type)
```

---

### Phase 3: Update Auth Check in Gateway

#### 3.1 `app/services/gateway/route_generator.py`

**Current** (broken):
```python
scopes = [method_id]
if method_info.required_perms:
    scopes.extend(method_info.required_perms)
```

**New** — bus topic IS the permission, `required_perms` is removed:
```python
scopes = [method_id]  # Bus topic = permission. That's it.
```

The `method_type` is passed as metadata so `check_auth_enabled` knows what type to check:

```python
# In create_typed_handler:
# Store method_type for the auth dependency to use
typed_handler._method_type = method_info.method_type
```

#### 3.2 `app/services/gateway/auth.py`

**Update `check_auth_enabled()`** to pass `method_type` to `identity.can()`:

```python
async def check_auth_enabled(...) -> Identity:
    # ... existing auth resolution ...

    # Permission check — method_type enables "Auth.use" / "Auth.manage" matching
    if security_scopes.scopes:
        method_type = getattr(request.state, "method_type", None)
        if not identity.can(*security_scopes.scopes, method_type=method_type):
            raise HTTPException(status_code=403, ...)

    return identity
```

#### 3.3 Remove `required_perms` from all `@method_contract` decorators

All 12 existing `required_perms=["auth.manage"]` etc. are **removed**. The `method_type` field replaces their purpose.

---

### Phase 4: Annotate Every Service Method with `method_type`

Below is every service with every method and its correct `method_type`:

---

#### AuthService (39 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `Auth.Login` | `use` | Core auth flow — any user |
| `Auth.Logout` | `use` | Core auth flow — any user |
| `Auth.ValidateToken` | `use` | Internal validation — any service |
| `Auth.RefreshToken` | `use` | Token rotation — any authenticated user |
| `Auth.WhoAmI` | `use` | Self-query — any authenticated user |
| `Auth.PairingStart` | `use` | Initiate pairing — any device (even unauthenticated) |
| `Auth.PairingConnect` | `use` | Poll pairing — any device (even unauthenticated) |
| `Auth.PairingApprove` | **`manage`** | Approve a pairing — admin action |
| `Auth.PairingExchange` | `use` | Exchange code for token — any device |
| `Auth.ListPrincipals` | **`manage`** | List all users — admin |
| `Auth.CreatePrincipal` | **`manage`** | Create user — admin |
| `Auth.GetPrincipal` | **`manage`** | View user details — admin |
| `Auth.UpdatePrincipal` | **`manage`** | Modify user — admin |
| `Auth.DeletePrincipal` | **`manage`** | Delete user — admin |
| `Auth.SetPermissions` | **`manage`** | Replace user permissions — admin |
| `Auth.PatchPermissions` | **`manage`** | Modify user permissions — admin |
| `Auth.ChangePassword` | `use` | Change own password — any user |
| `Auth.ListTokens` | **`manage`** | List all tokens — admin |
| `Auth.CreateToken` | **`manage`** | Create token — admin |
| `Auth.UpdateTokenScopes` | **`manage`** | Modify token scopes — admin |
| `Auth.RevokeToken` | **`manage`** | Revoke token — admin |
| `Auth.ListDevices` | **`manage`** | List devices — admin |
| `Auth.DeleteDevice` | **`manage`** | Delete device — admin |
| `Auth.AuditLog` | **`manage`** | View audit log — admin |
| `Auth.SaveMeshCredential` | `use` | Internal mesh operation |
| `Auth.LoadMeshCredential` | `use` | Internal mesh operation |
| `Auth.DeleteMeshCredential` | `use` | Internal mesh operation |
| `Auth.LoadMeshIdentity` | `use` | Internal mesh operation |
| `Auth.SaveMeshIdentity` | `use` | Internal mesh operation |
| `Auth.MeshUpsertPeer` | `use` | Internal mesh operation |
| `Auth.MeshListPeers` | `use` | List peers — any user |
| `Auth.MeshGetPeer` | `use` | View peer — any user |
| `Auth.MeshApprovePeer` | **`manage`** | Approve peer — admin |
| `Auth.MeshDenyPeer` | **`manage`** | Deny peer — admin |
| `Auth.MeshUpdatePeerPermissions` | **`manage`** | Change peer perms — admin |
| `Auth.MeshRemovePeer` | **`manage`** | Remove peer — admin |
| `Auth.MeshSaveInboundCredential` | `use` | Internal mesh operation |
| `Auth.MeshLoadInboundCredentials` | `use` | Internal mesh operation |
| `Auth.MeshUpdatePeerConnection` | `use` | Internal mesh operation |

**Summary**: 22 `use`, 17 `manage`

---

#### ConfigService (6 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `Config.Get` | `use` | Read config — any user |
| `Config.Set` | **`manage`** | Write config — admin |
| `Config.Validate` | `use` | Validate config — any user |
| `Config.GetPlugin` | `use` | Check plugin status — any user |
| `Config.SetPlugin` | **`manage`** | Activate/deactivate plugin — admin |
| `Config.ReloadService` | **`manage`** | Trigger service reload — admin |

**Summary**: 3 `use`, 3 `manage`

---

#### DBService (34 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `DB.SaveMessage` | `use` | Store message (internal) |
| `DB.GetMessages` | `use` | Read messages |
| `DB.GetMessagesForDate` | `use` | Read messages |
| `DB.SaveCronJob` | **`manage`** | Create cron job (internal) |
| `DB.GetCronJobs` | `use` | Read cron jobs (internal) |
| `DB.DeleteCronJob` | **`manage`** | Delete cron job (internal) |
| `DB.RAGStore` | `use` | Store in vector DB (internal) |
| `DB.RAGDelete` | **`manage`** | Delete from vector DB (internal) |
| `DB.RAGSearch` | `use` | Search vector DB |
| `DB.RAGGet` | `use` | Get from vector DB (internal) |
| `DB.RAGList` | `use` | List vector DB items (internal) |
| `DB.CreateUser` | **`manage`** | Create user row (internal) |
| `DB.GetUserByUsername` | `use` | Read user (internal) |
| `DB.GetUserById` | `use` | Read user (internal) |
| `DB.CountUsers` | `use` | Count users (internal) |
| `DB.ListUsers` | `use` | List users (internal) |
| `DB.UpdateUser` | **`manage`** | Modify user (internal) |
| `DB.DeleteUser` | **`manage`** | Delete user (internal) |
| `DB.CreateDevice` | **`manage`** | Create device (internal) |
| `DB.GetDeviceById` | `use` | Read device (internal) |
| `DB.ListDevices` | `use` | List devices (internal) |
| `DB.DeleteDevice` | **`manage`** | Delete device (internal) |
| `DB.CreateToken` | **`manage`** | Create token (internal) |
| `DB.GetTokenByHash` | `use` | Read token (internal) |
| `DB.GetTokenById` | `use` | Read token (internal) |
| `DB.ListTokens` | `use` | List tokens (internal) |
| `DB.UpdateTokenScopes` | **`manage`** | Modify token (internal) |
| `DB.RevokeToken` | **`manage`** | Revoke token (internal) |
| `DB.GetAuditLog` | `use` | Read audit log (internal) |
| `DB.CountAuditEvents` | `use` | Count audit events (internal) |
| `DB.SaveMeshCredential` | `use` | Store credential (internal) |
| `DB.GetMeshCredentialByRoom` | `use` | Read credential (internal) |
| `DB.DeleteMeshCredential` | **`manage`** | Delete credential (internal) |
| `DB.ExecuteSQL` | **`manage`** | Raw SQL execution (internal, dangerous) |

**Summary**: 20 `use`, 14 `manage`

---

#### OrchestratorService (3 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `Orchestrator.UserInput` | `use` | Send message to LLM (internal) |
| `Orchestrator.ExternalUserInput` | `use` | Send message to LLM (external API) |
| `Orchestrator.ToolResult` | `use` | Receive tool result (internal) |

**Summary**: 3 `use`, 0 `manage`

---

#### SchedulerService (5 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `Scheduler.Schedule` | **`manage`** | Create scheduled job |
| `Scheduler.Cancel` | **`manage`** | Cancel scheduled job |
| `Scheduler.Pause` | **`manage`** | Pause scheduled job |
| `Scheduler.Resume` | **`manage`** | Resume scheduled job |
| `Scheduler.ListJobs` | `use` | List jobs |

**Summary**: 1 `use`, 4 `manage`

---

#### TTSService (5 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `TTS.Request` | `use` | Synthesize and play audio |
| `TTS.Synthesize` | `use` | Synthesize and return audio data |
| `TTS.Stop` | `use` | Stop playback |
| `TTS.Pause` | `use` | Pause playback |
| `TTS.Resume` | `use` | Resume playback |

**Summary**: 5 `use`, 0 `manage`

---

#### STTCoordinatorService (4 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `STTCoordinator.Listen` | `use` | Start listening |
| `STTCoordinator.StopListening` | `use` | Stop listening |
| `STTCoordinator.Audio` | `use` | Process audio chunk |
| `STTCoordinator.Control` | **`manage`** | start_session / end_session / reset |

**Summary**: 3 `use`, 1 `manage`

---

#### TranscriptionService (3 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `Transcription.ProcessAudio` | `use` | Feed audio for transcription |
| `Transcription.Control` | **`manage`** | pause/resume/set_language |
| `Transcription.Transcribe` | `use` | Transcribe complete audio |

**Summary**: 2 `use`, 1 `manage`

---

#### WakeWordService (3 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `WakeWord.ProcessAudio` | `use` | Feed audio for detection |
| `WakeWord.Control` | **`manage`** | start/stop/pause/resume detection |
| `WakeWord.Detect` | `use` | Check audio for wake word |

**Summary**: 2 `use`, 1 `manage`

---

#### ToolingService (6 methods)

| method_id | method_type | Rationale |
|---|---|---|
| `Tooling.GetTools` | `use` | List available tools |
| `Tooling.GetToolByName` | `use` | Get tool details |
| `Tooling.GetStats` | `use` | Get statistics |
| `Tooling.GetMCPStatus` | `use` | Get MCP server status |
| `Tooling.ExecuteTool` | `use` | Execute a tool (core functionality) |
| `Tooling.ReloadMCPTools` | **`manage`** | Hot-reload MCP connections |

**Summary**: 5 `use`, 1 `manage`

---

### Grand Summary

| Service | Total | `use` | `manage` |
|---------|:-----:|:-----:|:--------:|
| Auth | 39 | 22 | 17 |
| Config | 6 | 3 | 3 |
| DB | 34 | 20 | 14 |
| Orchestrator | 3 | 3 | 0 |
| Scheduler | 5 | 1 | 4 |
| TTS | 5 | 5 | 0 |
| STTCoordinator | 4 | 3 | 1 |
| Transcription | 3 | 2 | 1 |
| WakeWord | 3 | 2 | 1 |
| Tooling | 6 | 5 | 1 |
| **TOTAL** | **108** | **66** | **42** |

---

### Phase 5: Create AuthMethods Constants

Auth service is the only service without a `*Methods` class. Create one:

#### 5.1 `app/shared/contracts/models/auth.py`

Add `AuthModule` and `AuthMethods` with all 39 bus topic constants, mirroring the pattern used by every other service.

---

### Phase 6: Wire Format Updates

#### 6.1 `app/shared/services/base_service.py`

In `_publish_service_announcement()`, include `method_type` in each `MethodInfo`:

```python
MethodInfo(
    name=method.name,
    summary=method.summary,
    bus_topic=method.bus_topic,
    exposure=method.exposure,
    method_type=method.method_type,  # NEW
    required_perms=method.required_perms,
    input_model=method.input_model.__name__ if method.input_model else None,
    # ...
)
```

#### 6.2 `app/services/gateway/registry_aggregator.py`

Pass `method_type` through from contract → MethodInfo.

---

### Phase 7: Route Generator — Method Type in Auth

#### 7.1 `app/services/gateway/route_generator.py`

Store `method_type` on `request.state` so the auth dependency can access it:

```python
# In create_typed_handler:
async def typed_handler(request: Request, ...):
    request.state.method_type = method_info.method_type
    # ... rest of handler
```

Simplify scopes to ONLY the bus topic:
```python
scopes = [method_id]  # No more required_perms concatenation
```

#### 7.2 `app/services/gateway/auth.py`

Read `method_type` from `request.state` and pass to `identity.can()`:

```python
method_type = getattr(request.state, "method_type", None)
if not identity.can(*security_scopes.scopes, method_type=method_type):
    raise HTTPException(403, ...)
```

---

### Phase 8: Swagger UI Improvements

#### 8.1 Route description updates

Show `method_type` badge in Swagger descriptions:

```python
if method_info.method_type == "manage":
    description_parts.append("🔧 **Type**: `manage` — requires `{Module}.manage` or higher\n")
else:
    description_parts.append("📡 **Type**: `use` — requires `{Module}.use` or higher\n")
```

---

### Phase 9: Remove Old Permission System

#### 9.1 Remove `required_perms` from all `@method_contract` decorators

All 12 existing `required_perms=["auth.manage"]`, `required_perms=["auth.approve"]`, `required_perms=["auth.audit"]` are **deleted** from `app/services/auth/service.py`.

The `method_type="manage"` on those same contracts replaces their function.

#### 9.2 Remove old lowercase constants

Remove from `permissions.py`:
```python
# DELETE these:
PERM_AUTH_MANAGE = "auth.manage"
PERM_AUTH_APPROVE = "auth.approve"
PERM_AUTH_AUDIT = "auth.audit"
PERM_SYSTEM_CONTROL = "system.control"
```

---

### Phase 10: Migration Path for Existing Data

#### 10.1 DB migration for stored permissions

Users in the database currently have permissions like `["auth.manage", "auth.approve"]`. These need migrating to `["Auth.manage"]` (or granular equivalents).

**Migration map** (old → new):
| Old Permission | New Permission |
|---|---|
| `auth.manage` | `Auth.manage` |
| `auth.approve` | `Auth.manage` (approve IS a manage action) |
| `auth.audit` | `Auth.manage` (audit IS a manage action) |
| `auth.*` | `Auth.*` |
| `tts.request` | `TTS.use` |
| `tts.*` | `TTS.*` |
| `stt.*` | `STTCoordinator.*` |
| `config.read` | `Config.use` |
| `config.write` | `Config.manage` |
| `config.*` | `Config.*` |
| `system.control` | `Config.manage` (closest equivalent) |
| `orchestrator.*` | `Orchestrator.*` |
| `db.*` | `DB.*` |
| `tooling.*` | `Tooling.*` |
| `scheduler.*` | `Scheduler.*` |
| `mesh.*` | `Auth.*` (mesh is under Auth module) |
| `gateway.*` | `Gateway.*` |
| `*` | `*` (unchanged) |

**Implementation**: Add a one-time migration function in AuthService's `on_start()` that checks and converts old-format permissions to new-format.

---

## Implementation Order

1. **Phase 1**: Add `method_type` to MethodContract, decorator, MethodInfo (pure additions, no breaking changes)
2. **Phase 5**: Create AuthMethods constants class (pure addition)
3. **Phase 2**: Update permission engine (has_permission gains method_type param, backward compatible via default None)
4. **Phase 4**: Add `method_type` to all 108 method contracts across all 10 services
5. **Phase 6**: Wire format updates (base_service, registry_aggregator)
6. **Phase 3 + 7**: Gateway auth flow (route_generator scopes, auth.py method_type)
7. **Phase 8**: Swagger UI badge
8. **Phase 9**: Remove old `required_perms` and lowercase constants
9. **Phase 10**: DB migration for stored permissions

---

## Example Permission Assignments

### Regular User (voice assistant consumer)
```python
permissions = [
    "TTS.use",              # Can use TTS
    "Orchestrator.use",     # Can chat with LLM
    "Tooling.use",          # Can use tools (via LLM)
    "Auth.Login",           # Can log in (granular)
    "Auth.WhoAmI",          # Can check identity (granular)
    "Auth.ChangePassword",  # Can change own password (granular)
]
```

### Power User (can also manage schedules)
```python
permissions = [
    "TTS.use",
    "Orchestrator.use",
    "Tooling.use",
    "Scheduler.*",          # Full scheduler access
    "Auth.use",             # All auth use methods
]
```

### Admin
```python
permissions = ["*"]  # or is_admin=True
```

### Device / IoT Token (limited scope)
```python
permissions = [
    "TTS.Request",          # Only play audio
    "STTCoordinator.Listen", # Only listen
]
```
