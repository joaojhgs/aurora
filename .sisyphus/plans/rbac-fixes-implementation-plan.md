# RBAC Post-Review Fixes — Implementation Plan

**Status**: 🟡 In Progress
**Date**: 2026-02-08
**Branch**: `feature/webrtc-gateway-setup-integration`
**Base**: `feat/migration-to-modular-services-architecture`
**Owner**: Core Platform
**Depends On**: `rbac-full-implementation-plan.md` (complete)

---

## Overview

This plan addresses all issues, bugs, missing features, and improvements identified during the comprehensive review of the RBAC implementation against the original `rbac-full-implementation-plan.md`.

Issues are categorized by severity:
- 🔴 **Critical Bug** — incorrect runtime behavior or security issue
- 🟠 **Missing Feature** — plan item not implemented
- 🟡 **Improvement** — code quality, safety, or robustness enhancement
- 🔵 **Test Gap** — missing test coverage

---

## Issue Inventory

### 🔴 Critical Bugs

#### C1. `update_peer_permissions` loses original token scopes
**File**: `app/services/gateway/webrtc/rtc_client.py` → `update_peer_permissions()`
**Problem**: When re-resolving Identity for a peer after a permission change, the method passes `list(identity.effective_perms)` as `token_scopes` (line 136). But `effective_perms` are already the *resolved* intersection of user perms and token scopes. This means:
- If user permissions are **expanded**, the new effective perms won't include the new user perms because the "token scopes" (which are actually old effective perms) will restrict them.
- The original token scopes are lost once stored as Identity.

**Fix**: Store the original token scopes alongside the Identity (or store the Token object) so that `update_peer_permissions` can re-resolve correctly from the original token scopes + updated user permissions.

**Approach**:
1. Add `_peer_tokens: dict[str, Token]` to `RTCClient` to store the validated Token for each peer.
2. On auth → store `self._peer_tokens[peer] = token` alongside the Identity.
3. In `update_peer_permissions()` → use `self._peer_tokens[peer].scopes` as the token_scopes parameter.
4. On reauth → update the stored token.
5. Cleanup on disconnect.

---

#### C2. `revoke_token` / `delete_user` / `delete_device` don't verify the row existed
**Files**: `app/services/db/manager.py` → `revoke_token()`, `delete_user()`, `delete_device()`
**Problem**: These methods execute `DELETE` and always return `True` even if the ID doesn't match any row. This means the HTTP endpoints return 204 even for non-existent resources instead of 404.

**Fix**: Check `cursor.rowcount` after the DELETE and return `False` when 0 rows were affected.

---

#### C3. `PRAGMA foreign_keys = ON` only set in delete methods, not globally
**File**: `app/services/db/manager.py`
**Problem**: `PRAGMA foreign_keys = ON` is only set inside `delete_user()` and `delete_device()`. It needs to be set per-connection because SQLite defaults to `foreign_keys = OFF`. If any other code path deletes rows or relies on FK cascading (e.g., via `revoke_token` or manual cleanup), the cascade won't fire.

**Fix**: Set `PRAGMA foreign_keys = ON` in a consistent way, either:
- Option A: In `initialize()`, add a helper method that all connections use.
- Option B: Set it in every connection that performs writes.
- Option C (recommended): Create a helper `_connect()` method that returns a connection with `foreign_keys = ON` already set.

---

#### C4. Default pairing permissions don't fall back to config defaults
**File**: `app/services/gateway/auth_service.py` → `approve_pairing()`
**Problem**: When `permissions=None` is passed to `approve_pairing()`, it stores `[]` (empty list) instead of falling back to `PermissionSettings.default_device_permissions` from config. The plan says: "If `None`, use config default (`gateway.auth.default_pairing_permissions`)".
**Line**: `request["granted_permissions"] = permissions or []`

**Fix**: `AuthService` needs access to the gateway config (or receive `default_device_permissions` at init/reload) so that `approve_pairing()` can fall back to the configured defaults when `permissions is None`.

**Approach**:
1. Add `_default_device_permissions: list[str]` to `AuthService.__init__()`.
2. Add `update_config(permissions_settings: PermissionSettings)` method.
3. In `GatewayService._reload_auth_config()`, call `auth_service.update_config(perm_settings)`.
4. In `approve_pairing()`, change `permissions or []` to `permissions if permissions is not None else self._default_device_permissions`.

---

### 🟠 Missing Features

#### M1. Missing `POST /api/auth/login` endpoint
**Plan reference**: §4 Phase 5 — Auth Routes
**Problem**: The plan specifies a `POST /api/auth/login` endpoint (username/password → token), and `AuthService.login()` is implemented, but no endpoint is wired in `fastapi_app.py`.

**Fix**: Add the login endpoint to `fastapi_app.py` using `LoginRequest`/`LoginResponse` schemas. Add it to bypass paths. Add audit events for `login.success` and `login.failure`.

---

#### M2. Missing `POST /api/auth/logout` endpoint
**Plan reference**: §4 Phase 5 — Auth Routes
**Problem**: No logout endpoint to revoke the current token.

**Fix**: Add `POST /api/auth/logout` that revokes the token used for the current request. Requires extracting the token from the Authorization header and revoking it. Add `token.revoked` audit event.

---

#### M3. Missing `GET /api/auth/me` endpoint
**Plan reference**: §4 Phase 5 — Auth Routes
**Problem**: No `/api/auth/me` endpoint to get the full current identity with both user-level permissions and effective permissions. The existing `GET /api/auth/verify` partially covers this but doesn't include user-level permissions separately.

**Fix**: Add `GET /api/auth/me` that returns a full `IdentityResponse` including user-level permissions (from the DB, not just effective_perms). Alternatively, enhance the existing `/api/auth/verify` endpoint to include this.

---

#### M4. Missing `POST /api/auth/token/refresh` endpoint
**Plan reference**: §4 Phase 5 — Token Routes
**Problem**: `AuthService.refresh_token()` is implemented but no endpoint is wired.

**Fix**: Add `POST /api/auth/token/refresh` that calls `auth_service.refresh_token()` with the current token and returns the new token string. This should be accessible with any valid token.

---

#### M5. Missing token scope validation on create/update
**Plan reference**: §4 Phase 5 checklist — "Validate: token scopes cannot exceed principal permissions (enforce on create/update)"
**Problem**: When creating or updating token scopes, there is no validation that the requested scopes are a subset of (or covered by) the principal's permissions. An admin could accidentally create a token with scopes broader than the user has, which wouldn't grant extra access (effective perms = intersection), but is semantically confusing and violates the plan's specification.

**Fix**:
1. In `AuthService.create_token_for_principal()`, after loading the user, validate that each scope in `scopes` is covered by `user.permissions` (using `has_permission()`). Reject with an error if not.
2. In `AuthService.update_token_scopes()`, load the token's user and validate similarly.
3. Skip validation if user is admin (they have `*`).
4. Return descriptive error on violation.

---

#### M6. `PairingExchangeResponse` doesn't include `permissions`
**Plan reference**: §4 Phase 4 — "Update `PairingExchangeResponse`: add `permissions: list[str]`"
**Problem**: The `PairingExchangeResponse` schema only has `token`, `device_id`, `user_id` but not `permissions`. The endpoint doesn't return the assigned permissions.

**Fix**: Add `permissions: list[str]` to `PairingExchangeResponse` and return it from the exchange endpoint.

---

#### M7. Missing `IdentityResponse` schema
**Plan reference**: §4 Phase 5 — Schemas
**Problem**: The plan specifies an `IdentityResponse` Pydantic model for endpoints that return identity information. Currently, `/api/auth/verify` returns a raw dict.

**Fix**: Create `IdentityResponse` schema and use it as the response model for `/api/auth/verify` and the planned `/api/auth/me`.

---

### 🟡 Improvements

#### I1. Audit event failures are silently swallowed
**Files**: `app/services/gateway/acl/audit.py`, `auth.py`, `rpc.py`, `rtc_client.py`
**Problem**: All audit calls have broad `except Exception: pass` or `log_debug` on failure. While audit failures should never break request flow (correct design), silently swallowing them makes operational debugging difficult.

**Fix**: Use `log_warning` (not `log_debug`) for audit failures so they appear in standard log output. The `audit.py` module already does `log_debug` — change to `log_warning`.

---

#### I2. Redundant `import asyncio` inside function bodies
**Files**: `app/services/gateway/auth.py` (lines 214, 299), `app/services/gateway/webrtc/rpc.py` (line 84)
**Problem**: `asyncio` is imported inside function bodies. In `rpc.py`, `asyncio` is already imported at module level (line 10). In `auth.py`, it's not imported at module level at all — inconsistent.

**Fix**: Add `import asyncio` at module level in `auth.py` and remove the inline imports in both files.

---

#### I3. `asyncio.ensure_future()` used instead of `asyncio.create_task()`
**Files**: `auth.py` (lines 216, 300), `rtc_client.py` (lines 211, 230)
**Problem**: `asyncio.ensure_future()` is deprecated in favor of `asyncio.create_task()`. Tasks created with `ensure_future` can be garbage-collected before completion.

**Fix**: Replace `asyncio.ensure_future()` with `asyncio.create_task()`. For fire-and-forget audit tasks, store the task references to prevent GC (or use a `TaskGroup` / background set).

---

#### I4. `should_bypass()` uses `startswith` — overly permissive path matching
**File**: `app/services/gateway/auth.py` → `should_bypass()`
**Problem**: Path bypass check uses `path.startswith(bypass_path)` which would incorrectly match paths like `/api/auth/login-debug` or `/api/auth/login/extra` against bypass `/api/auth/login`.

**Fix**: Use exact match or add a trailing delimiter check: `path == bypass_path or path.startswith(bypass_path + "/")`.

---

#### I5. Missing audit events for several operations
**Files**: Various
**Problem**: The plan lists audit events for operations that are not currently audited:

| Event | Status | Where it should go |
|:---|:---:|:---|
| `login.success` | ❌ | Login endpoint (to be added, M1) |
| `login.failure` | ❌ | Login endpoint (to be added, M1) |
| `token.created` | ❌ | `POST /api/admin/tokens` in `fastapi_app.py` |
| `token.revoked` | ❌ | `DELETE /api/admin/tokens/{id}` in `fastapi_app.py` |
| `token.scopes_updated` | ❌ | `PATCH /api/admin/tokens/{id}/scopes` in `fastapi_app.py` |
| `pairing.started` | ❌ | `POST /api/auth/pairing/start` in `fastapi_app.py` |
| `pairing.exchanged` | ❌ | `POST /api/auth/pairing/exchange` in `fastapi_app.py` |
| `password.changed` | ❌ | `POST /api/auth/change-password` in `fastapi_app.py` |

**Fix**: Add `audit_event()` calls at each of these points.

---

#### I6. `Identity` dataclass missing user-level `permissions` field
**File**: `app/services/gateway/acl/identity.py`
**Problem**: The plan's design for `Identity` includes both `permissions: set[str]` (user-level) and `effective_perms: set[str]` (resolved). The implementation only has `effective_perms`. This means you can't tell the user's full permission set from the Identity alone. Relevant for `/api/auth/me` and `IdentityResponse`.

**Fix**: Add `permissions: frozenset[str]` field to `Identity` (default `frozenset()`). Populate it in `build_identity()` from `user_permissions`. Update `ANONYMOUS` and `SYSTEM` constants. Update tests.

---

#### I7. `exchange_pairing` gives empty-permission device token `scopes=["*"]`
**File**: `app/services/gateway/auth_service.py` → `exchange_pairing()`
**Problem**: Line 300: `token_scopes = ["*"] if granted_is_admin else (granted_perms or ["*"])`. When `granted_perms` is `[]` (empty), the fallback `or ["*"]` sets token scopes to `["*"]`. While this doesn't grant extra access (effective = intersection of `[]` ∩ `["*"]` = `{}`), having `scopes=["*"]` on a token for a zero-permission user is semantically confusing and misleading.

**Fix**: Change to: `token_scopes = ["*"] if granted_is_admin else granted_perms` — no fallback to `["*"]`. A device with no permissions gets a token with no scopes.

---

#### I8. Auth timeout task not cancelled on peer disconnect
**File**: `app/services/gateway/webrtc/rtc_client.py` → `_auth_timeout_check()`
**Problem**: The auth timeout coroutine created via `asyncio.ensure_future(_auth_timeout_check())` is not tracked or cancelled when the peer disconnects before the timeout fires. If the peer disconnects early, the timeout task still runs, tries to access `self._peer_acl` (which may have been cleaned up), and calls `chan.close()` on an already-closed channel.

**Fix**:
1. Store the timeout task in `_peer_timeout_tasks: dict[str, asyncio.Task]`.
2. Cancel it when the peer authenticates successfully or disconnects.
3. Add a guard in `_auth_timeout_check()` to check if the peer is still connected.

---

#### I9. Missing rate limiting on login endpoint
**Plan reference**: §7 Security Considerations — "Rate limiting: IP-based for pairing (already ✅); extend to login endpoint"
**Problem**: The pairing flow has IP-based rate limiting, but the login endpoint (to be added) has none.

**Fix**: Add similar IP-based rate limiting to the login endpoint using the same pattern as `pairing_attempts`.

---

#### I10. `FOREIGN_KEYS` pragma should be enabled globally
**File**: `app/services/db/manager.py`
**Problem**: See C3. Beyond the delete methods, any future code that depends on FK behavior won't get it.

**Fix**: (Covered by C3) Create a `_connect()` helper that enables FK pragma on every write connection.

---

### 🔵 Test Gaps

#### T1. Smoke tests not implemented
**Plan reference**: §6 Full Implementation Checklist — Final Validation
**Problem**: 8 smoke tests from the plan remain unchecked:
1. Bootstrap → admin has `*` → can access everything
2. Create principal with `["TTS.*", "STT.*"]` → can only call TTS/STT methods
3. Create token with `scopes=["TTS.Request"]` for principal with `["TTS.*"]` → only TTS.Request works
4. Pairing flow → new device gets assigned permissions → verify enforcement
5. WebRTC peer connects → authenticates → RPC calls enforce permissions
6. WebRTC peer with no auth → times out → disconnected
7. Admin revokes token → next request denied
8. Admin changes principal permissions → reflected immediately on next request

**Fix**: Create `tests/integration/test_rbac_smoke.py` implementing all 8 scenarios.

---

#### T2. Missing tests for login/logout/me/refresh endpoints
**Problem**: Since these endpoints don't exist yet (M1-M4), there are no tests for them.

**Fix**: Write tests alongside the endpoints in existing integration test files.

---

#### T3. Missing test for token scope validation
**Problem**: No test verifying that creating a token with scopes exceeding user permissions is rejected (M5).

**Fix**: Add test cases in `tests/integration/test_token_management.py`.

---

#### T4. Missing test for pairing default permissions from config
**Problem**: Plan says "pairing with default permissions from config" should be tested. The test currently uses explicit permissions but doesn't test the config fallback.

**Fix**: Add a test where `permissions=None` during approve causes the config's `default_device_permissions` to be used.

---

## Implementation Phases

### Phase A: Critical Bug Fixes (C1–C4)

**Priority**: Highest — fix first
**Estimated effort**: 2–3 hours

#### A.1 Fix `update_peer_permissions` token scope loss (C1)

**Files to modify**:
- `app/services/gateway/webrtc/rtc_client.py`

**Changes**:
1. Add `_peer_tokens: dict[str, Token] = {}` to `__init__`.
2. In auth handler (`validate_peer`), store `self._peer_tokens[peer] = token`.
3. In reauth handler (`reauth_peer`), update `self._peer_tokens[peer] = token`.
4. In `update_peer_permissions()`:
   ```python
   token = self._peer_tokens.get(peer_id)
   if not token:
       return False
   new_identity = build_identity(
       user_id=user.id,
       username=user.username,
       user_permissions=user.permissions or [],
       user_is_admin=user.is_admin,
       token_scopes=token.scopes or [],
       device_id=identity.device_id,
       source="webrtc_peer",
   )
   ```
5. Cleanup `_peer_tokens` on disconnect/close.
6. Update `tests/unit/gateway/test_rtc_client_lifecycle.py`.

#### A.2 Fix delete/revoke returning True for non-existent rows (C2)

**Files to modify**:
- `app/services/db/manager.py` — `revoke_token()`, `delete_user()`, `delete_device()`

**Changes**:
```python
async def revoke_token(self, token_id: str) -> bool:
    try:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("DELETE FROM tokens WHERE id = ?", (token_id,))
            await db.commit()
            return cursor.rowcount > 0
    except Exception as e:
        log_error(f"Error revoking token {token_id}: {e}")
        return False
```
Apply the same pattern to `delete_user()` and `delete_device()`.

#### A.3 Enable PRAGMA foreign_keys globally (C3)

**Files to modify**:
- `app/services/db/manager.py`

**Changes**:
1. Add helper method:
   ```python
   async def _connect(self) -> aiosqlite.Connection:
       db = await aiosqlite.connect(self.db_path)
       await db.execute("PRAGMA foreign_keys = ON")
       return db
   ```
2. Optionally update write methods to use this helper (can be done incrementally).
3. At minimum, remove the redundant `PRAGMA` calls from `delete_user()` and `delete_device()` and ensure they go through the helper.

#### A.4 Default pairing permissions from config (C4)

**Files to modify**:
- `app/services/gateway/auth_service.py`
- `app/services/gateway/service.py`

**Changes**:
1. `AuthService.__init__`: add `self._default_device_permissions: list[str] = []`.
2. Add `update_permission_defaults(default_perms: list[str])` method.
3. `approve_pairing()`: change `permissions or []` to `permissions if permissions is not None else self._default_device_permissions`.
4. `GatewayService._reload_auth_config()`: call `self._auth_service.update_permission_defaults(perm_settings.default_device_permissions)`.
5. `GatewayService._init_auth_service()`: also set initial defaults after loading config.

---

### Phase B: Missing Endpoints (M1–M4, M6–M7)

**Priority**: High — core API functionality missing
**Estimated effort**: 3–4 hours

#### B.1 Add `POST /api/auth/login` (M1)

**Files to modify**:
- `app/services/gateway/fastapi_app.py`
- `app/services/gateway/schemas/auth.py` (update `LoginResponse`)

**Changes**:
1. Add endpoint using `LoginRequest` → call `auth_service.login()`.
2. Return `LoginResponse` with `token`, `user_id`, `expires_at`, `permissions`, `is_admin`.
3. Add `/api/auth/login` to bypass paths.
4. Add rate limiting (IP-based, similar to pairing).
5. Add audit: `login.success` / `login.failure`.

**Updated `LoginResponse`**:
```python
class LoginResponse(BaseModel):
    token: str
    user_id: str
    username: str
    permissions: list[str]
    is_admin: bool
    expires_at: str | None = None
```

#### B.2 Add `POST /api/auth/logout` (M2)

**Files to modify**:
- `app/services/gateway/fastapi_app.py`

**Changes**:
1. Endpoint extracts current token from request.
2. Revokes it via `auth_service.db_manager.revoke_token()`.
3. Requires authentication (any valid token).
4. Audit: `token.revoked`.

#### B.3 Add `GET /api/auth/me` (M3)

**Files to modify**:
- `app/services/gateway/fastapi_app.py`
- `app/services/gateway/schemas/auth.py` (add `IdentityResponse`)

**Changes**:
1. Endpoint returns full identity + user-level permissions.
2. Uses `IdentityResponse` schema.
3. Loads user from DB to get full `permissions` (not just effective).

#### B.4 Add `POST /api/auth/token/refresh` (M4)

**Files to modify**:
- `app/services/gateway/fastapi_app.py`

**Changes**:
1. Endpoint accepts current token (from header), calls `auth_service.refresh_token()`.
2. Returns new token string.
3. Old token is revoked.

#### B.5 Add `permissions` to `PairingExchangeResponse` (M6)

**Files to modify**:
- `app/services/gateway/schemas/auth.py`
- `app/services/gateway/fastapi_app.py`

**Changes**:
```python
class PairingExchangeResponse(BaseModel):
    token: str
    device_id: str
    user_id: str
    permissions: list[str] = []
```
Update the exchange endpoint to include `permissions=result["permissions"]`.

#### B.6 Create `IdentityResponse` schema (M7)

**Files to modify**:
- `app/services/gateway/schemas/auth.py`

**Changes**:
```python
class IdentityResponse(BaseModel):
    principal_id: str
    principal_name: str
    device_id: str | None = None
    is_admin: bool
    permissions: list[str]      # user-level
    effective_perms: list[str]  # resolved (user ∩ token)
    source: str
```
Use for `/api/auth/me` and optionally update `/api/auth/verify`.

---

### Phase C: Token Scope Validation (M5)

**Priority**: Medium — prevents confusing/invalid token states
**Estimated effort**: 1 hour

**Files to modify**:
- `app/services/gateway/auth_service.py`
- `app/services/gateway/acl/permissions.py` (may need `validate_scopes_subset()` helper)

**Changes**:
1. In `create_token_for_principal()`:
   ```python
   # Validate scopes ⊆ user permissions
   if not user.is_admin and scopes and scopes != ["*"]:
       for scope in scopes:
           if not has_permission(scope, set(user.permissions or [])):
               raise ValueError(f"Scope '{scope}' exceeds principal's permissions")
   ```
2. Same check in `update_token_scopes()` (load token → load user → validate).
3. Endpoints catch `ValueError` and return 400 Bad Request.

---

### Phase D: Code Quality Improvements (I1–I4, I7–I8)

**Priority**: Medium — improves robustness and maintainability
**Estimated effort**: 1–2 hours

#### D.1 Upgrade audit failure logging (I1)

**Files to modify**:
- `app/services/gateway/acl/audit.py` — change `log_debug` to `log_warning` on failure.

#### D.2 Clean up asyncio imports (I2)

**Files to modify**:
- `app/services/gateway/auth.py` — add `import asyncio` at module level, remove inline imports.
- `app/services/gateway/webrtc/rpc.py` — remove inline `import asyncio` (already at module level).

#### D.3 Replace `asyncio.ensure_future` with `asyncio.create_task` (I3)

**Files to modify**:
- `app/services/gateway/auth.py` — both occurrences.
- `app/services/gateway/webrtc/rtc_client.py` — lines 211, 230.

For fire-and-forget tasks in `auth.py`, wrap in a helper:
```python
def _fire_and_forget(coro):
    """Schedule a coroutine as a fire-and-forget task."""
    task = asyncio.create_task(coro)
    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
```

#### D.4 Fix bypass path matching (I4)

**File**: `app/services/gateway/auth.py` → `should_bypass()`

**Change**:
```python
def should_bypass(self, path: str) -> bool:
    return any(
        path == bp or path.startswith(bp + "/")
        for bp in self._bypass_paths
    )
```

#### D.5 Fix exchange_pairing token scopes fallback (I7)

**File**: `app/services/gateway/auth_service.py` → `exchange_pairing()`

**Change** (line 300):
```python
# Before:
token_scopes = ["*"] if granted_is_admin else (granted_perms or ["*"])
# After:
token_scopes = ["*"] if granted_is_admin else granted_perms
```

#### D.6 Track and cancel auth timeout tasks (I8)

**File**: `app/services/gateway/webrtc/rtc_client.py`

**Changes**:
1. Add `_peer_timeout_tasks: dict[str, asyncio.Task] = {}` to `__init__`.
2. Store timeout task: `self._peer_timeout_tasks[peer] = asyncio.create_task(_auth_timeout_check())`.
3. Cancel on successful auth:
   ```python
   # In validate_peer(), after successful auth:
   timeout_task = self._peer_timeout_tasks.pop(peer, None)
   if timeout_task:
       timeout_task.cancel()
   ```
4. Cancel on disconnect:
   ```python
   # In connectionstatechange handler:
   timeout_task = self._peer_timeout_tasks.pop(peer, None)
   if timeout_task:
       timeout_task.cancel()
   ```
5. Guard in `_auth_timeout_check`:
   ```python
   async def _auth_timeout_check():
       await asyncio.sleep(self._auth_timeout)
       if peer not in self._pcs:
           return  # Already disconnected
       identity = self._peer_acl.get(peer, ANONYMOUS)
       if identity == ANONYMOUS:
           ...
   ```
6. Cleanup in `close()`.

---

### Phase E: Missing Audit Events (I5)

**Priority**: Medium — security observability
**Estimated effort**: 1 hour

**Files to modify**:
- `app/services/gateway/fastapi_app.py`

**Add audit events to these endpoints**:

| Endpoint | Event | Details |
|:---|:---|:---|
| `POST /api/auth/login` (new) | `login.success` | `principal_id`, `username`, `ip` |
| `POST /api/auth/login` (new) | `login.failure` | `username`, `ip` |
| `POST /api/admin/tokens` | `token.created` | `principal_id`, `token_id`, `scopes` |
| `DELETE /api/admin/tokens/{id}` | `token.revoked` | `token_id`, `by_principal_id` |
| `PATCH /api/admin/tokens/{id}/scopes` | `token.scopes_updated` | `token_id`, `new_scopes` |
| `POST /api/auth/pairing/start` | `pairing.started` | `device_name`, `ip` |
| `POST /api/auth/pairing/exchange` | `pairing.exchanged` | `user_id`, `device_id` |
| `POST /api/auth/change-password` | `password.changed` | `principal_id` |

---

### Phase F: Identity Enhancement (I6)

**Priority**: Low — nice-to-have for API completeness
**Estimated effort**: 1 hour

**Files to modify**:
- `app/services/gateway/acl/identity.py`
- `tests/unit/gateway/test_acl_identity.py`

**Changes**:
1. Add `permissions: frozenset[str] = field(default_factory=frozenset)` field to `Identity`.
2. Update `build_identity()` to populate it: `permissions=frozenset(user_permissions)`.
3. Update `ANONYMOUS`: `permissions=frozenset()`.
4. Update `SYSTEM`: `permissions=frozenset(["*"])`.
5. Update tests.

---

### Phase G: Smoke Tests (T1) and Integration Tests (T2–T4)

**Priority**: Medium — validation completeness
**Estimated effort**: 2–3 hours

#### G.1 Smoke tests

**New file**: `tests/integration/test_rbac_smoke.py`

Implement all 8 smoke scenarios listed in T1. These should use the test client and real DB (like existing integration tests).

#### G.2 Login/Logout/Me/Refresh endpoint tests

**Files to modify**: `tests/integration/test_auth_endpoints.py` (new)

Test the new endpoints added in Phase B.

#### G.3 Token scope validation tests

**File**: `tests/integration/test_token_management.py`

Add test: creating a token with scopes exceeding user permissions → 400.

#### G.4 Pairing default permissions test

**File**: `tests/unit/gateway/test_auth_service.py`

Add test: approve pairing with `permissions=None` → uses config default permissions.

---

## Full Implementation Checklist

### Phase A: Critical Bug Fixes
- [x] A.1: Fix `update_peer_permissions` to use original token scopes
- [x] A.2: Fix `revoke_token` / `delete_user` / `delete_device` to check `rowcount`
- [x] A.3: Enable `PRAGMA foreign_keys = ON` globally via helper
- [x] A.4: Fall back to config `default_device_permissions` when pairing permissions are `None`

### Phase B: Missing Endpoints
- [x] B.1: Add `POST /api/auth/login` with rate limiting and audit
- [x] B.2: Add `POST /api/auth/logout`
- [x] B.3: Add `GET /api/auth/me` with `IdentityResponse`
- [x] B.4: Add `POST /api/auth/token/refresh`
- [x] B.5: Add `permissions` field to `PairingExchangeResponse`
- [x] B.6: Create `IdentityResponse` schema

### Phase C: Token Scope Validation
- [x] C.1: Validate token scopes ⊆ user permissions on create
- [x] C.2: Validate token scopes ⊆ user permissions on update
- [x] C.3: Handle `ValueError` in endpoints → 400

### Phase D: Code Quality Improvements
- [x] D.1: Upgrade audit failure log level to `log_warning`
- [x] D.2: Clean up redundant `import asyncio` in `auth.py` and `rpc.py`
- [x] D.3: Replace `asyncio.ensure_future` with `asyncio.create_task`
- [x] D.4: Fix bypass path matching to prevent prefix false positives
- [x] D.5: Fix `exchange_pairing` token scopes fallback
- [x] D.6: Track and cancel auth timeout tasks on disconnect/auth success

### Phase E: Missing Audit Events
- [x] E.1: Add `login.success` / `login.failure` audit events
- [x] E.2: Add `token.created` audit event
- [x] E.3: Add `token.revoked` audit event
- [x] E.4: Add `token.scopes_updated` audit event
- [x] E.5: Add `pairing.started` audit event
- [x] E.6: Add `pairing.exchanged` audit event
- [x] E.7: Add `password.changed` audit event

### Phase F: Identity Enhancement
- [x] F.1: Add `permissions` field to `Identity` dataclass
- [x] F.2: Populate `permissions` in `build_identity()`
- [x] F.3: Update `ANONYMOUS` and `SYSTEM` constants
- [x] F.4: Update identity tests

### Phase G: Tests
- [ ] G.1: Write 8 smoke tests in `tests/integration/test_rbac_smoke.py`
- [ ] G.2: Write integration tests for login/logout/me/refresh
- [ ] G.3: Write token scope validation tests
- [ ] G.4: Write pairing default permissions test

### Final
- [ ] `make format` passes
- [ ] `make lint` passes
- [ ] `make unit` passes (gateway tests: 0 new failures)
- [ ] `make integration` passes (gateway tests: 0 new failures)
- [ ] Update `rbac-full-implementation-plan.md` checklist

---

## File Map (All Changes)

### New Files
```
tests/integration/test_rbac_smoke.py       # 8 smoke test scenarios
tests/integration/test_auth_endpoints.py   # Login/logout/me/refresh tests
```

### Modified Files
```
app/services/gateway/acl/audit.py           # I1: log_warning on failure
app/services/gateway/acl/identity.py        # I6: add permissions field
app/services/gateway/auth.py                # I2, I3, I4: asyncio cleanup, bypass fix
app/services/gateway/auth_service.py        # C4, M5, I7: config defaults, scope validation, exchange fix
app/services/gateway/config.py              # (no changes needed — already has PermissionSettings)
app/services/gateway/dependencies.py        # (no changes needed)
app/services/gateway/fastapi_app.py         # M1-M4, M6, E1-E7: new endpoints, audit events
app/services/gateway/schemas/auth.py        # M6, M7, B.1: PairingExchangeResponse, IdentityResponse, LoginResponse
app/services/gateway/service.py             # C4: pass config defaults to AuthService
app/services/gateway/webrtc/rtc_client.py   # C1, I8: token storage, timeout task tracking
app/services/gateway/webrtc/rpc.py          # I2, I3: asyncio cleanup
app/services/db/manager.py                  # C2, C3: rowcount checks, FK pragma helper

tests/unit/gateway/test_acl_identity.py     # I6: updated for permissions field
tests/unit/gateway/test_rtc_client_lifecycle.py  # C1, I8: updated tests
tests/unit/gateway/test_auth_service.py     # C4, M5: pairing defaults, scope validation
tests/integration/test_token_management.py  # M5: scope validation test
```

---

## Dependencies

No new Python packages required.

---

## Execution Order

Recommended order for implementation:
1. **Phase A** (Critical bugs) — fixes incorrect behavior
2. **Phase D** (Code quality) — many of these are simple and improve safety
3. **Phase B** (Missing endpoints) — completes the API surface
4. **Phase C** (Scope validation) — enforces plan's security requirements
5. **Phase E** (Audit events) — fills observability gaps
6. **Phase F** (Identity enhancement) — supports `/api/auth/me` properly
7. **Phase G** (Tests) — validates all the above

Phases D and E can be done in parallel with B since they touch different code sections.

---

**End of Plan**
