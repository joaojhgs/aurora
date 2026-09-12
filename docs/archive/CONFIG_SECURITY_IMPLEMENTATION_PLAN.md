# Aurora Config Security — Implementation Plan

**Source**: `docs/CONFIG_SECURITY_REPORT.md`
**Date**: 2026-03-08
**Branch**: `feature/webrtc-gateway-setup-integration`
**Target**: Fix all 11 security findings (4 Critical, 3 High, 4 Medium)

---

## Table of Contents

1. [Change Overview & Dependency Graph](#1-change-overview--dependency-graph)
2. [Blast Radius Summary (GitNexus)](#2-blast-radius-summary-gitnexus)
3. [Phase 1 — P0 Critical Fixes](#3-phase-1--p0-critical-fixes)
   - [Task 1.1: Config.Get Secret Redaction](#task-11-configget-secret-redaction)
   - [Task 1.2: ConfigChangedEvent Secret Redaction](#task-12-configchangedevent-secret-redaction)
   - [Task 1.3: BaseService Origin Enforcement](#task-13-baseservice-origin-enforcement)
   - [Task 1.4: Auth-Disabled Startup Warning](#task-14-auth-disabled-startup-warning)
4. [Phase 2 — P1 High Fixes](#4-phase-2--p1-high-fixes)
   - [Task 2.1: Field-Level ACL for Config.Set Sensitive Keys](#task-21-field-level-acl-for-configset-sensitive-keys)
   - [Task 2.2: Route Generator — Honor required_perms](#task-22-route-generator--honor-required_perms)
   - [Task 2.3: Restrict Default CORS Origins](#task-23-restrict-default-cors-origins)
   - [Task 2.4: Process-Mode .env Loading](#task-24-process-mode-env-loading)
5. [Phase 3 — P2 Medium Fixes](#5-phase-3--p2-medium-fixes)
   - [Task 3.1: Docker config.json Writable Mount](#task-31-docker-configjson-writable-mount)
   - [Task 3.2: Bypass Paths Use ANONYMOUS Identity](#task-32-bypass-paths-use-anonymous-identity)
   - [Task 3.3: Audit Logging for Config.Set](#task-33-audit-logging-for-configset)
6. [Testing Plan](#6-testing-plan)
7. [Migration & Backwards Compatibility](#7-migration--backwards-compatibility)

---

## 1. Change Overview & Dependency Graph

### Execution Order

Tasks **must** be executed in phase order. Within each phase, tasks can be parallelized unless noted.

```
Phase 1 (P0 — Critical)
  ├── Task 1.1: Config.Get redaction ──────────────┐
  ├── Task 1.2: ConfigChangedEvent redaction         │ (independent)
  ├── Task 1.3: BaseService origin enforcement ──────┤
  └── Task 1.4: Auth-disabled warning                │
                                                     │
Phase 2 (P1 — High)                                  │
  ├── Task 2.1: Field-level ACL ─── depends on 1.3 ─┘
  ├── Task 2.2: Route generator required_perms
  ├── Task 2.3: CORS restriction
  └── Task 2.4: Process-mode .env
                    │
Phase 3 (P2 — Medium)
  ├── Task 3.1: Docker writable mount
  ├── Task 3.2: Bypass paths ANONYMOUS
  └── Task 3.3: Audit logging ─── depends on 1.3 (envelope context)
```

### Files Changed Summary

| File | Tasks | Change Type |
|------|-------|-------------|
| `app/services/config/service.py` | 1.1, 1.2, 2.1, 3.3 | Modified |
| `app/services/config/config_manager.py` | 1.1 | Modified |
| `app/services/config/env_config.py` | 1.1, 2.1 | Modified |
| `app/services/config/messages.py` | — | No change |
| `app/shared/services/base_service.py` | 1.3 | Modified |
| `app/shared/contracts/registry.py` | 1.3 | Modified (documentation/defaults) |
| `app/services/gateway/service.py` | 1.4 | Modified |
| `app/services/gateway/config.py` | 2.3 | Modified |
| `app/services/gateway/route_generator.py` | 2.2 | Modified |
| `app/services/gateway/auth.py` | 3.2 | Modified |
| `app/services/gateway/webrtc/rpc.py` | 2.2 | Modified (related) |
| `app/services/config/__main__.py` | 2.4 | Modified |
| `docker-compose.process.yml` | 2.4, 3.1 | Modified |
| `app/shared/contracts/models/config.py` | 2.1 | Modified |
| `tests/unit/app/config/` | 1.1, 1.2, 2.1 | New + Modified |
| `tests/unit/gateway/` | 1.3, 2.2, 3.2 | New + Modified |

---

## 2. Blast Radius Summary (GitNexus)

Analysis performed via `mcp_gitnexus_impact` on each target symbol. This measures what breaks or is affected by changes at depth 1 (direct), 2 (indirect), and 3 (transitive).

### BaseService (`_subscribe_registered_contracts`)

| Metric | Value |
|--------|-------|
| **Risk** | **CRITICAL** |
| **Impacted symbols** | 6 direct, 20 processes affected |
| **Direct dependents (d=1)** | `main_async()` in `main.py`, `start()` in `base_service.py` |
| **Indirect (d=2)** | `main()` in `main.py`, `_start_audio_capture()` in STT coordinator, `_start_processing_thread()` in STT transcription, `reload()` in orchestrator |
| **Affected modules** | Services (5 hits), Setup (1 hit) |
| **All 12 services extend BaseService** | Supervisor, TTSService, ToolingService, WakeWordService, STTCoordinatorService, TranscriptionService, OrchestratorService, SchedulerService, DBService, GatewayService, ConfigService, AuthService |

**Risk mitigation**: Changes to `_subscribe_registered_contracts` affect the **message dispatch path for every service**. The origin enforcement must be:
- **Opt-in via contract metadata** (not blanket-reject) to avoid breaking internal calls.
- **Default `allow_origins = ["internal", "external"]`** for backward compatibility, with explicit opt-in for restriction.
- **Thoroughly tested** with each service's startup flow.

### ConfigManager

| Metric | Value |
|--------|-------|
| **Risk** | **HIGH** |
| **Impacted symbols** | 36 upstream, 11 direct |
| **Direct dependents (d=1)** | `scripts/config_updater.py` (6 functions), `app/services/gateway/config.py` (2 functions), `ConfigService` |
| **Affected modules** | Scripts (8 hits), Gateway (4 hits), Config (2 hits) |
| **Processes** | `Main → ConfigManager`, `Main → Get`, `Main → Log_info/Log_error` |

**Risk mitigation**: Redaction must happen in `ConfigService` (the bus-facing layer), **not** in `ConfigManager`. This preserves `ConfigManager`'s behavior for all direct callers (scripts, gateway config, etc.) that need unredacted values internally.

### ConfigService

| Metric | Value |
|--------|-------|
| **Risk** | LOW |
| **Impacted symbols** | 1 downstream (BaseService) |
| **Direct dependents** | Only BaseService (via extends) |
| **Modules** | STT Transcription (1 hit — likely index artifact) |

**Risk mitigation**: ConfigService changes are low-risk because it's called exclusively via the message bus. Changes to its handlers don't affect other code directly — only the bus response format changes.

### RouteGenerator

| Metric | Value |
|--------|-------|
| **Risk** | LOW |
| **Impacted symbols** | 2 upstream |
| **Direct dependents (d=1)** | `create_gateway_app()` in `fastapi_app.py` |
| **Indirect (d=2)** | `_start_gateway()` in `GatewayService` |
| **Modules** | Gateway (1 hit), DB (1 hit — indirect) |

**Risk mitigation**: Scope change in `create_typed_handler` only affects how FastAPI security scopes are built. Must test that existing token scoping still works when `required_perms` is populated.

### GatewayAuth

| Metric | Value |
|--------|-------|
| **Risk** | LOW |
| **Impacted symbols** | 2 upstream |
| **Direct dependents (d=1)** | `create_gateway_app()` in `fastapi_app.py` |
| **Indirect (d=2)** | `_start_gateway()` in `GatewayService` |

**Risk mitigation**: The middleware change (ANONYMOUS on bypass paths) is isolated. Test health endpoint still works, docs still accessible, pairing still functions.

### Identity

| Metric | Value |
|--------|-------|
| **Risk** | **CRITICAL** |
| **Impacted symbols** | 15 upstream, 17 processes |
| **Direct dependents** | `build_identity()`, `build_identity_from_token()` (auth proxy), `_initiate_pairing()` (WebRTC) |
| **Modules** | Gateway (5 hits), WebRTC (3 hits), Auth (1 hit) |
| **Processes** | Token validation flows, WebRTC on_open/on_message, peer auth |

**Risk mitigation**: We are **not changing Identity itself** — only how it's consumed. The `identity.can()` method is unmodified. The changes are in callers (route generator, BaseService), not the Identity model.

### ConfigChangedEvent

| Metric | Value |
|--------|-------|
| **Risk** | LOW |
| **Impacted symbols** | 1 upstream |
| **Direct dependents** | `on_config_change()` in ConfigService |
| **Modules** | DB (1 hit — indirect) |

**Risk mitigation**: The event model itself is unchanged. We only modify the data put into it before publishing. Services that subscribe to `Config.Updated` will see redacted values for sensitive keys — they should already handle this gracefully since they re-read config via `Config.Get`.

### Envelope

| Metric | Value |
|--------|-------|
| **Risk** | LOW |
| **Impacted symbols** | 4 upstream |
| **Direct dependents** | `publish()` in LocalBus, `_processor()` in BullMQBus |
| **Modules** | Messaging (4 hits) |

**Risk mitigation**: We are **not changing the Envelope model**. We only read the existing `envelope.origin` field in `_subscribe_registered_contracts`. No model changes, no serialization changes.

---

## 3. Phase 1 — P0 Critical Fixes

### Task 1.1: Config.Get Secret Redaction

**Finding**: §2.2 — Full config including secrets exposed via API
**Severity**: Critical
**Effort**: Medium

#### Goal

External callers (HTTP, WebRTC) calling `Config.Get` must receive config with `SENSITIVE_KEYS` replaced by `"***REDACTED***"`. Internal callers (other services via bus) receive full unredacted config.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/config/config_manager.py` | Add `redact_config()` method |
| `app/services/config/service.py` | Pass `envelope` to handler, branch on `envelope.origin` |

#### Detailed Changes

##### 1. `app/services/config/config_manager.py` — Add `redact_config()`

Add the following method to the `ConfigManager` class, after `get_config_dict()` (around line 298):

```python
def redact_config(self, config: dict[str, Any], key_prefix: str = "") -> dict[str, Any]:
    """Return a deep copy of config with SENSITIVE_KEYS values replaced.

    Args:
        config: The config dict to redact.
        key_prefix: Current dot-notation prefix for recursion.

    Returns:
        A new dict with sensitive values replaced by "***REDACTED***".
    """
    from app.services.config.env_config import SENSITIVE_KEYS

    result: dict[str, Any] = {}
    for k, v in config.items():
        full_path = f"{key_prefix}.{k}" if key_prefix else k
        if full_path in SENSITIVE_KEYS:
            if isinstance(v, list):
                result[k] = ["***REDACTED***"] if v else v
            elif isinstance(v, str) and v:
                result[k] = "***REDACTED***"
            else:
                result[k] = v  # Keep empty/None as-is
        elif isinstance(v, dict):
            result[k] = self.redact_config(v, full_path)
        else:
            result[k] = v
    return result
```

##### 2. `app/services/config/service.py` — Redact in `_handle_get_config`

The handler must accept the `envelope` parameter to inspect `origin`. Modify `_handle_get_config`:

**Before:**
```python
async def _handle_get_config(self, query: GetConfigQuery) -> GetConfigResponse:
    try:
        section = query.section
        log_debug(f"[GetConfig] section='{section}'")
        if section:
            config = self.config_manager.get(section, {})
        else:
            config = self.config_manager.get_config_dict()
        response = GetConfigResponse(config=config)
        return response
```

**After:**
```python
async def _handle_get_config(self, query: GetConfigQuery, envelope=None) -> GetConfigResponse:
    try:
        section = query.section
        is_external = envelope and getattr(envelope, "origin", "internal") == "external"
        log_debug(f"[GetConfig] section='{section}' external={is_external}")

        if section:
            config = self.config_manager.get(section, {})
            # For external callers, redact if section is a dict
            if is_external and isinstance(config, dict):
                config = self.config_manager.redact_config(config, section)
        else:
            config = self.config_manager.get_config_dict()
            if is_external:
                config = self.config_manager.redact_config(config)

        response = GetConfigResponse(config=config)
        return response
```

**How `envelope` is passed**: `BaseService._subscribe_registered_contracts` already supports passing envelope to methods. It checks `_wants_envelope(method)` by inspecting the `envelope` parameter name in the method signature. By adding `envelope=None` to the method signature, the wrapper will automatically pass the full `Envelope` object.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Call Config.Get with `origin="internal"` and `section=None` | Full config returned, including all secrets |
| 2 | Call Config.Get with `origin="external"` and `section=None` | Config returned with all SENSITIVE_KEYS as `"***REDACTED***"` |
| 3 | Call Config.Get with `origin="external"` and `section="gateway"` | `token_secret`, `webrtc.password`, `auth.api_keys` all redacted |
| 4 | Call Config.Get with `origin="external"` and `section="gateway.token_secret"` | Returns `"***REDACTED***"` (leaf value) |
| 5 | Call Config.Get with `origin="external"` and `section="ui"` | No redaction (no sensitive keys in `ui`) |
| 6 | `redact_config()` preserves empty/None values | Empty strings stay empty, None stays None |
| 7 | `redact_config()` handles nested dicts correctly | Deeply nested secrets are found and redacted |

---

### Task 1.2: ConfigChangedEvent Secret Redaction

**Finding**: §2.3 — ConfigChangedEvent leaks secrets over mesh
**Severity**: Critical
**Effort**: Small

#### Goal

When a sensitive key is changed, the `ConfigChangedEvent` published to the bus (including mesh peers) must have `old_value` and `new_value` replaced with `"***REDACTED***"`.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/config/service.py` | Redact event payload in `_setup_config_observers` |

#### Detailed Changes

##### `app/services/config/service.py` — Redact in `on_config_change`

**Before** (inside `_setup_config_observers`, the `on_config_change` inner function):
```python
def on_config_change(key_path: str, old_value: Any, new_value: Any) -> None:
    ...
    try:
        event = ConfigChangedEvent(
            affected_sections=affected_sections,
            key_path=key_path,
            old_value=old_value,
            new_value=new_value,
        )
```

**After:**
```python
def on_config_change(key_path: str, old_value: Any, new_value: Any) -> None:
    ...
    try:
        from app.services.config.env_config import SENSITIVE_KEYS

        # Redact sensitive values before broadcasting
        if key_path in SENSITIVE_KEYS:
            publish_old = "***REDACTED***"
            publish_new = "***REDACTED***"
        else:
            publish_old = old_value
            publish_new = new_value

        event = ConfigChangedEvent(
            affected_sections=affected_sections,
            key_path=key_path,
            old_value=publish_old,
            new_value=publish_new,
        )
```

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Set non-sensitive key `"ui.dark_mode"` | Event contains actual `old_value` and `new_value` |
| 2 | Set sensitive key `"gateway.token_secret"` | Event contains `"***REDACTED***"` for both values |
| 3 | Set sensitive key `"gateway.auth.api_keys"` | Event contains `"***REDACTED***"` for both values |

---

### Task 1.3: BaseService Origin Enforcement

**Finding**: §2.4 — No bus-level access control; `allow_origins` is dead code
**Severity**: Critical
**Effort**: Medium
**Blast Radius**: **CRITICAL** — affects all 12 services

#### Goal

When a message arrives at a service via the bus, `BaseService._subscribe_registered_contracts` must check `envelope.origin` against the contract's `allow_origins`. Messages from disallowed origins are rejected with a 403 error response.

#### Design Decisions

1. **Default `allow_origins`**: Change from `["internal"]` to `["internal", "external"]` for backward compatibility. This means existing contracts work as-is. Services explicitly restrict methods by setting `allow_origins=["internal"]` in their `@method_contract`.
2. **The check runs AFTER input validation** — so the error response format is consistent.
3. **`origin="system"` always passes** — system-level messages (e.g., lifecycle commands) are never blocked.

#### Files to Modify

| File | Change |
|------|--------|
| `app/shared/services/base_service.py` | Add origin check in `_subscribe_registered_contracts` wrapper |
| `app/shared/contracts/registry.py` | Update default `allow_origins` to `["internal", "external"]` |

#### Detailed Changes

##### 1. `app/shared/contracts/registry.py` — Update default

**Before:**
```python
allow_origins: list[str] = ["internal"]
```

**After:**
```python
allow_origins: list[str] = ["internal", "external"]
```

This avoids breaking every existing contract. Methods that must be internal-only will explicitly set `allow_origins=["internal"]`.

##### 2. `app/shared/services/base_service.py` — Add origin check in wrapper

Inside `_subscribe_registered_contracts`, in the `create_wrapper` function, add the origin check at the top of the `wrapper` body, **before** input validation.

Find the section (approximately line 335):
```python
async def wrapper(envelope: Envelope) -> None:
    try:
        # 1. Unpack and validate input
```

Insert **before** the comment `# 1. Unpack and validate input`:
```python
        # 0. Origin enforcement
        allowed_origins = metadata.get("allow_origins", ["internal", "external"])
        msg_origin = getattr(envelope, "origin", "internal")
        if msg_origin != "system" and msg_origin not in allowed_origins:
            log_warning(
                f"Origin '{msg_origin}' blocked for {method_name} "
                f"(allowed: {allowed_origins})"
            )
            if envelope.reply_to:
                from app.shared.contracts.models.common import ErrorOutput
                error_response = ErrorOutput(
                    error=f"Origin '{msg_origin}' not allowed for this method",
                    code="ORIGIN_DENIED",
                )
                await self.bus.publish(
                    envelope.reply_to,
                    error_response,
                    event=False,
                    origin=self.module,
                )
            return
```

##### 3. Update `create_wrapper` closure to capture `allow_origins`

In the `create_wrapper` function signature, add `allow_origins` parameter:

**Before:**
```python
async def create_wrapper(
    method=attr,
    model=input_model,
    method_name=attr_name,
    pass_envelope=_wants_envelope(attr),
):
```

**After:**
```python
async def create_wrapper(
    method=attr,
    model=input_model,
    method_name=attr_name,
    pass_envelope=_wants_envelope(attr),
    allow_origins=metadata.get("allow_origins", ["internal", "external"]),
):
```

And pass it into the wrapper:
```python
async def wrapper(envelope: Envelope) -> None:
    try:
        # 0. Origin enforcement
        msg_origin = getattr(envelope, "origin", "internal")
        if msg_origin != "system" and msg_origin not in allow_origins:
            ...
```

#### Contracts to Restrict

After this is in place, the following methods should be updated to `allow_origins=["internal"]` (internal-only):

| Contract | Current | Should Be | Reason |
|----------|---------|-----------|--------|
| `ConfigMethods.RELOAD_SERVICE` | default | `["internal"]` | Service lifecycle is internal |
| Auth internal methods (token internals) | default | `["internal"]` | Auth internals should not be externally callable |

**No contracts need to change immediately** for the security fix — the goal is to enforce the mechanism. Restricting specific methods is follow-up work.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Internal message (`origin="internal"`) to default contract | Passes, method executes |
| 2 | External message (`origin="external"`) to default contract | Passes, method executes (default allows both) |
| 3 | External message to contract with `allow_origins=["internal"]` | Blocked, 403-like error response, method NOT executed |
| 4 | System message (`origin="system"`) to restricted contract | Passes (system always allowed) |
| 5 | All existing services start correctly | No regressions from default change |

---

### Task 1.4: Auth-Disabled Startup Warning

**Finding**: §2.1 — Authentication disabled by default
**Severity**: Critical
**Effort**: Small

#### Goal

When the gateway starts with `auth_enabled=False` and the API is binding to a non-localhost address (e.g., `0.0.0.0`), emit a prominent warning. Do NOT change the default (breaking local development), but make the risk visible.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/gateway/service.py` | Add warning in `_start_gateway` |

#### Detailed Changes

##### `app/services/gateway/service.py` — Add warning after gateway starts

After the gateway is started (after the `_start_gateway` method creates and starts the app), add:

```python
if not auth_enabled and settings.api.host in ("0.0.0.0", "::"):
    log_warning(
        "⚠️  SECURITY WARNING: Gateway authentication is DISABLED and binding to "
        f"{settings.api.host}:{settings.api.port}. All endpoints are open to any "
        "network client with SYSTEM-level access. Set gateway.auth.enabled=true "
        "in config.json or AURORA_AUTH_ENABLED=true in .env for production use."
    )
```

Also add an `AURORA_ENV` check:
```python
import os
if os.environ.get("AURORA_ENV") == "production" and not auth_enabled:
    log_error(
        "🚨 CRITICAL: Gateway auth is DISABLED in production mode! "
        "This exposes all secrets and API endpoints. Set gateway.auth.enabled=true."
    )
```

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Start gateway with `auth_enabled=False`, host `0.0.0.0` | Warning logged |
| 2 | Start gateway with `auth_enabled=True` | No warning |
| 3 | Start gateway with `auth_enabled=False`, host `127.0.0.1` | No warning (localhost is safe) |
| 4 | `AURORA_ENV=production` + auth disabled | Error-level log |

---

## 4. Phase 2 — P1 High Fixes

### Task 2.1: Field-Level ACL for Config.Set Sensitive Keys

**Finding**: §2.5 — Config.Set allows overwriting security-critical settings
**Severity**: High
**Effort**: Medium
**Depends on**: Task 1.3 (envelope context available)

#### Goal

When an external caller attempts to `Config.Set` a key in `SENSITIVE_KEYS` or a security-critical prefix (e.g., `gateway.auth.*`), the request is rejected unless the caller has `Config.admin` scope.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/config/env_config.py` | Add `SECURITY_CRITICAL_PREFIXES` set |
| `app/services/config/service.py` | Add ACL check in `_handle_update_config` |
| `app/shared/contracts/models/config.py` | Add `Config.admin` permission constant |

#### Detailed Changes

##### 1. `app/services/config/env_config.py` — Add critical prefixes

Add after the `SENSITIVE_KEYS` definition:

```python
# Config path prefixes that control security-critical behavior.
# Changes to these require elevated (admin) permissions from external callers.
SECURITY_CRITICAL_PREFIXES: tuple[str, ...] = (
    "gateway.auth.",
    "gateway.token_secret",
    "gateway.webrtc.password",
)
```

##### 2. `app/shared/contracts/models/config.py` — Add admin permission

```python
class ConfigMethods:
    """Full method identifiers for Config service."""
    ...
    # Permission constants
    ADMIN_PERM = "Config.admin"
```

##### 3. `app/services/config/service.py` — ACL check in `_handle_update_config`

Modify `_handle_update_config` to accept `envelope` and check permissions:

**Before:**
```python
async def _handle_update_config(self, cmd: UpdateConfigCommand) -> UpdateConfigResponse:
    try:
        self.config_manager.set(cmd.key_path, cmd.value)
        log_info(f"Updated config: {cmd.key_path}")
        return UpdateConfigResponse(success=True)
```

**After:**
```python
async def _handle_update_config(self, cmd: UpdateConfigCommand, envelope=None) -> UpdateConfigResponse:
    try:
        from app.services.config.env_config import SECURITY_CRITICAL_PREFIXES, SENSITIVE_KEYS

        is_external = envelope and getattr(envelope, "origin", "internal") == "external"

        # Check if key is security-sensitive
        is_sensitive = (
            cmd.key_path in SENSITIVE_KEYS
            or any(cmd.key_path.startswith(p) for p in SECURITY_CRITICAL_PREFIXES)
        )

        if is_external and is_sensitive:
            # For external callers, require elevated principal permissions.
            # The principal_id is set by the gateway from the authenticated Identity.
            # We check the principal has admin-level access via the bus.
            principal_id = getattr(envelope, "principal_id", None)
            log_warning(
                f"External Config.Set attempt on sensitive key '{cmd.key_path}' "
                f"by principal '{principal_id}'. Requires Config.admin scope."
            )
            return UpdateConfigResponse(
                success=False,
                error=(
                    f"Permission denied: writing to '{cmd.key_path}' requires "
                    f"Config.admin scope. Use .env for secret management or "
                    f"authenticate with an admin token."
                ),
            )

        self.config_manager.set(cmd.key_path, cmd.value)
        log_info(f"Updated config: {cmd.key_path}")
        return UpdateConfigResponse(success=True)
```

**Note**: This implementation blocks **all** external writes to sensitive keys. A future enhancement can add a bus round-trip to `Auth.CheckPermission` to allow admin-scoped principals. For now, secrets should be managed via `.env` (and `migrate_secrets_to_env()`), not via the API.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Internal Config.Set on `"gateway.token_secret"` | Succeeds (internal callers trusted) |
| 2 | External Config.Set on `"gateway.token_secret"` | Rejected with error message |
| 3 | External Config.Set on `"gateway.auth.enabled"` | Rejected (matches prefix) |
| 4 | External Config.Set on `"ui.dark_mode"` | Succeeds (not sensitive) |
| 5 | External Config.Set on `"general.llm.provider"` | Succeeds (not sensitive) |
| 6 | External Config.Set on `"plugins.jira.api_token"` | Rejected (in SENSITIVE_KEYS) |

---

### Task 2.2: Route Generator — Honor `required_perms`

**Finding**: §2.6 — `required_perms` is dead code on HTTP path
**Severity**: High
**Effort**: Small

#### Goal

When a contract declares `required_perms`, the HTTP route should use those as the required scopes (in addition to the bus topic). This enables fine-grained permission control per-method.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/gateway/route_generator.py` | Use `required_perms` when populated |

#### Detailed Changes

##### `app/services/gateway/route_generator.py` — Update scope generation

**Before** (line ~563):
```python
        # Bus topic IS the permission — single namespace, no required_perms
        scopes = [method_id]
```

**After:**
```python
        # Use contract's required_perms if populated; fallback to bus topic
        scopes = list(method_info.required_perms) if method_info.required_perms else [method_id]
```

This is a simple, localized change. When `required_perms` is empty (current default for all contracts), behavior is unchanged. When a contract specifies `required_perms`, those become the required scopes.

The WebRTC RPC handler (`rpc.py`) already checks `required_perms` correctly:
```python
perms_needed = meta.required_perms or []
if perms_needed and not identity.can(*perms_needed):
    self._send_error(req_id, 403, "Forbidden")
```

So the WebRTC path is already consistent. This change aligns the HTTP path.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Route with `required_perms=[]` | Scope falls back to `[method_id]` — no behavior change |
| 2 | Route with `required_perms=["Config.admin"]` | Scope is `["Config.admin"]`, checked via `identity.can()` |
| 3 | Token with `Config.use` accessing a route requiring `Config.admin` | 403 Forbidden |
| 4 | Token with `*` accessing a route requiring `Config.admin` | Passes (superuser) |
| 5 | Swagger UI still shows correct auth badges | Manual verification |

---

### Task 2.3: Restrict Default CORS Origins

**Finding**: §2.7 — CORS defaults to `["*"]`
**Severity**: High
**Effort**: Small

#### Goal

Change the CORS default so that production deployments don't accidentally allow cross-origin requests from any website.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/gateway/config.py` | Change default `cors_origins` |

#### Detailed Changes

##### `app/services/gateway/config.py` — Restrict CORS default

**Before:**
```python
class APISettings(BaseModel):
    ...
    cors_origins: list[str] = ["*"]
```

**After:**
```python
class APISettings(BaseModel):
    ...
    cors_origins: list[str] = []  # Empty = same-origin only; set explicitly for cross-origin
```

Also update `config_defaults.json` and `config_schema.json` to reflect the new default:

```json
"cors": {
    "origins": [],
    "allow_credentials": true
}
```

**Backward compatibility**: Users who need cross-origin access (e.g., separate frontend) must explicitly set `gateway.cors.origins` in `config.json`. This is documented in the schema description.

Also add a startup log in `GatewayService`:
```python
if settings.api.cors_origins == ["*"]:
    log_warning(
        "CORS is configured with wildcard origins ['*']. "
        "This allows any website to make API requests. "
        "Restrict to specific origins for production."
    )
```

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Default config, browser cross-origin request | Blocked (no CORS headers) |
| 2 | Config with `cors_origins: ["http://localhost:3000"]` | Allowed for that origin |
| 3 | Config with `cors_origins: ["*"]` | Allowed with warning log |

---

### Task 2.4: Process-Mode .env Loading

**Finding**: §2.8 — Process-mode services do not load `.env`
**Severity**: Medium (promoted to P1 because it breaks secrets in process mode)
**Effort**: Small

#### Goal

Process-mode entry points load `.env` before starting services, so environment variables are available to `ConfigManager.get()`.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/config/__main__.py` | Add `load_dotenv()` call |
| `docker-compose.process.yml` | Add `env_file: .env` to config-service |

#### Detailed Changes

##### 1. `app/services/config/__main__.py` — Add `load_dotenv()`

Add at the top of `main()` function, before any service creation:

```python
async def main():
    """Main entry point for ConfigService process."""
    # Load .env for secret resolution (in case env_file is not used)
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass  # python-dotenv is optional if env is injected via Docker

    service_name = "ConfigService"
    ...
```

**Note**: Only the ConfigService entry point needs this — it's the only process-mode service that directly reads `.env` values via `ConfigManager`. Other services get their config from ConfigService via the bus.

##### 2. `docker-compose.process.yml` — Add `env_file`

Under the `config-service` definition, add:

```yaml
  config-service:
    ...
    env_file:
      - .env
    environment:
      - AURORA_ENV=production
      ...
```

The `env_file` directive loads `.env` into the container's environment. The `environment:` block still overrides specific variables.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Start ConfigService standalone with `.env` on disk | Secrets from `.env` resolve correctly |
| 2 | Start ConfigService without `.env` file | No crash (graceful fallback) |
| 3 | Docker config-service with `env_file: .env` | Container sees `.env` variables |

---

## 5. Phase 3 — P2 Medium Fixes

### Task 3.1: Docker config.json Writable Mount

**Finding**: §2.9 — config.json mounted read-only in Docker
**Severity**: Medium
**Effort**: Small

#### Goal

Allow `Config.Set` to persist changes in Docker deployments by mounting `config.json` as writable, or using a separate writable path.

#### Files to Modify

| File | Change |
|------|--------|
| `docker-compose.process.yml` | Change `:ro` to writable mount |

#### Detailed Changes

##### `docker-compose.process.yml` — Remove `:ro` from config-service

**Before:**
```yaml
    volumes:
      - ./config.json:/app/config.json:ro
```

**After (config-service only):**
```yaml
    volumes:
      - ./config.json:/app/config.json  # Writable for Config.Set persistence
```

**Other services** can keep `config.json:ro` since they don't write to it — they read config via the bus.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Config.Set in Docker config-service | Changes saved to `config.json`, persist across restart |
| 2 | Non-config services still read config.json | Read-only mount works for reading |

---

### Task 3.2: Bypass Paths Use ANONYMOUS Identity

**Finding**: §2.10 — Bypass paths get SYSTEM identity when auth is enabled
**Severity**: Medium
**Effort**: Small

#### Goal

Bypass paths (`/api/health`, `/api/docs`, pairing endpoints) should receive `ANONYMOUS` identity when auth is enabled but the path is bypassed. This prevents accidental admin privileges on public endpoints.

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/gateway/auth.py` | Change `SYSTEM` to `ANONYMOUS` for bypass paths |

#### Detailed Changes

##### `app/services/gateway/auth.py` — Fix `auth_middleware`

**Before:**
```python
async def auth_middleware(request: Any, call_next: Callable) -> Any:
    from fastapi.responses import JSONResponse

    if not auth.is_enabled() or auth.should_bypass(request.url.path):
        request.state.identity = SYSTEM
        return await call_next(request)
```

**After:**
```python
async def auth_middleware(request: Any, call_next: Callable) -> Any:
    from fastapi.responses import JSONResponse

    if not auth.is_enabled():
        # Auth disabled entirely — full access (development mode)
        request.state.identity = SYSTEM
        return await call_next(request)

    if auth.should_bypass(request.url.path):
        # Auth enabled but path is public — use ANONYMOUS, not SYSTEM
        request.state.identity = ANONYMOUS
        return await call_next(request)
```

Also update `_resolve_identity_and_check` to match:

**Before:**
```python
if auth.should_bypass(request.url.path):
    return SYSTEM
```

**After:**
```python
if auth.should_bypass(request.url.path):
    return ANONYMOUS
```

#### Impact Assessment

- **`/api/health`**: Returns health status. Doesn't check identity — no impact.
- **`/api/docs`, `/api/redoc`, `/api/openapi.json`**: Swagger UI. No identity checks — no impact.
- **`/api/auth/login`**: Routes to Auth.Login handler. The handler itself authenticates the user — doesn't rely on `request.state.identity` for authorization.
- **`/api/auth/pairing/*`**: Pairing endpoints. The WebRTC RPC handler already allows ANONYMOUS for pairing methods via `_ANON_ALLOWED_METHODS`.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | `GET /api/health` with auth enabled, no credentials | 200 OK (bypass, ANONYMOUS identity) |
| 2 | `GET /api/docs` with auth enabled, no credentials | 200 OK |
| 3 | `POST /api/auth/login` with auth enabled | Works (login handler authenticates independently) |
| 4 | `POST /api/auth/pairing/start` with auth enabled | Works (pairing is public) |
| 5 | `POST /api/Config/Get` with auth enabled, no credentials | 401 (not a bypass path) |

---

### Task 3.3: Audit Logging for Config.Set

**Finding**: Report §7, P2 recommendation
**Severity**: Medium
**Effort**: Medium
**Depends on**: Task 1.3 (envelope context for principal_id)

#### Goal

All `Config.Set` operations are logged with: timestamp, principal_id, key_path, old_value (redacted if sensitive), new_value (redacted if sensitive).

#### Files to Modify

| File | Change |
|------|--------|
| `app/services/config/service.py` | Add audit logging in `_handle_update_config` |

#### Detailed Changes

##### `app/services/config/service.py` — Add audit log in `_handle_update_config`

After the successful `self.config_manager.set()` call:

```python
# Audit log
principal_id = getattr(envelope, "principal_id", "system") if envelope else "system"
origin = getattr(envelope, "origin", "internal") if envelope else "internal"
is_sensitive = cmd.key_path in SENSITIVE_KEYS or any(
    cmd.key_path.startswith(p) for p in SECURITY_CRITICAL_PREFIXES
)
log_info(
    f"[AUDIT] Config.Set: key='{cmd.key_path}' "
    f"principal='{principal_id}' origin='{origin}' "
    f"old_value={'***REDACTED***' if is_sensitive else repr(old_value)} "
    f"new_value={'***REDACTED***' if is_sensitive else repr(cmd.value)}"
)
```

Where `old_value` is obtained by adding `self.config_manager.get(cmd.key_path)` before the set.

#### Test Cases

| # | Test | Expected |
|---|------|----------|
| 1 | Config.Set on `"ui.dark_mode"` | Audit log shows actual old/new values |
| 2 | Config.Set on `"gateway.token_secret"` | Audit log shows `***REDACTED***` for values |
| 3 | Internal Config.Set | Audit log shows `principal='system'` `origin='internal'` |
| 4 | External Config.Set | Audit log shows actual `principal_id` and `origin='external'` |

---

## 6. Testing Plan

### Unit Tests to Add/Modify

| Test File | Task | Tests |
|-----------|------|-------|
| `tests/unit/app/config/test_config_redaction.py` | 1.1 | New file: 7 tests for `redact_config()` |
| `tests/unit/app/config/test_config_service.py` | 1.1, 1.2, 2.1, 3.3 | Add tests for external redaction, event redaction, ACL, audit |
| `tests/unit/app/services/test_base_service_origin.py` | 1.3 | New file: 5 tests for origin enforcement |
| `tests/unit/gateway/test_route_scopes.py` | 2.2 | New file: 4 tests for `required_perms` scoping |
| `tests/unit/gateway/test_auth_middleware.py` | 3.2 | Add tests for ANONYMOUS on bypass paths |
| `tests/unit/gateway/test_cors_config.py` | 2.3 | Test default CORS is empty |

### Integration Tests

| Test | Task | Description |
|------|------|-------------|
| Config.Get external redaction | 1.1 | Full flow: HTTP request → gateway → bus → ConfigService → response with redacted secrets |
| Config.Set ACL rejection | 2.1 | Full flow: HTTP request for sensitive key → rejected |
| Service startup with origin enforcement | 1.3 | Start all services, verify bus communication still works |
| Process-mode .env loading | 2.4 | Start ConfigService as process, verify secrets resolve |

### Manual Validation

| # | Scenario | Steps |
|---|----------|-------|
| 1 | Thread mode with auth disabled | `python main.py` → verify startup warning if bound to 0.0.0.0 |
| 2 | Thread mode with auth enabled | Set `gateway.auth.enabled=true` → verify Config.Get redacts for HTTP |
| 3 | Process mode with Docker | `docker compose -f docker-compose.process.yml up` → verify config-service loads `.env` |
| 4 | Swagger UI documentation | Visit `/api/docs` → verify auth badges show correct permissions |

---

## 7. Migration & Backwards Compatibility

### Breaking Changes

| Change | Impact | Migration Path |
|--------|--------|----------------|
| CORS default `[]` (was `["*"]`) | Frontends on different origins will fail | Add explicit `gateway.cors.origins` in `config.json` |
| External Config.Set for secrets blocked | UIs that set secrets via API will fail | Use `.env` for secret management; admin UI can set non-sensitive keys |
| Bypass paths get ANONYMOUS | Code relying on `request.state.identity.is_admin` for bypass paths will fail | Such code should not exist (bypass paths are public), but audit all bypass path handlers |

### Non-Breaking Changes

All other changes are backward-compatible:

- Config.Get redaction only affects external callers — internal services see full config.
- Origin enforcement defaults to `["internal", "external"]` — all existing contracts work.
- `required_perms` fallback to `[method_id]` — all existing contracts work.
- Startup warning is log-only — no behavior change.
- Process-mode `load_dotenv()` is additive — doesn't change existing env.
- Docker config.json writable — relaxes a restriction, doesn't add one.
- Audit logging — additive, log-only.

### Configuration Changes

Users upgrading should:

1. **Set `gateway.auth.enabled: true`** in `config.json` for any network-exposed deployment.
2. **Set `gateway.cors.origins`** explicitly if cross-origin access is needed.
3. **Run `migrate_secrets_to_env()`** to move secrets from `config.json` to `.env` (already done automatically on startup).
4. **Ensure `.env` is present** for process-mode Docker deployments (add `env_file: .env` to compose).

---

## Appendix A: Full File Change Matrix

| # | File | Lines Changed (est.) | Tasks |
|---|------|---------------------|-------|
| 1 | `app/services/config/config_manager.py` | +30 | 1.1 |
| 2 | `app/services/config/service.py` | +60 | 1.1, 1.2, 2.1, 3.3 |
| 3 | `app/services/config/env_config.py` | +8 | 2.1 |
| 4 | `app/shared/services/base_service.py` | +25 | 1.3 |
| 5 | `app/shared/contracts/registry.py` | +1 (default change) | 1.3 |
| 6 | `app/shared/contracts/models/config.py` | +3 | 2.1 |
| 7 | `app/services/gateway/service.py` | +15 | 1.4 |
| 8 | `app/services/gateway/config.py` | +2 | 2.3 |
| 9 | `app/services/gateway/route_generator.py` | +1 | 2.2 |
| 10 | `app/services/gateway/auth.py` | +8 | 3.2 |
| 11 | `app/services/config/__main__.py` | +5 | 2.4 |
| 12 | `docker-compose.process.yml` | +3 | 2.4, 3.1 |
| 13 | New test files (4 files) | +250 | All |
| **Total** | | **~410 lines** | |

## Appendix B: Checklist

- [ ] **Phase 1.1** — Config.Get redaction (`config_manager.py`, `service.py`)
- [ ] **Phase 1.2** — ConfigChangedEvent redaction (`service.py`)
- [ ] **Phase 1.3** — BaseService origin enforcement (`base_service.py`, `registry.py`)
- [ ] **Phase 1.4** — Auth-disabled warning (`gateway/service.py`)
- [ ] **Phase 2.1** — Field-level ACL for Config.Set (`service.py`, `env_config.py`, `config.py`)
- [ ] **Phase 2.2** — Route generator required_perms (`route_generator.py`)
- [ ] **Phase 2.3** — CORS restriction (`gateway/config.py`)
- [ ] **Phase 2.4** — Process-mode .env loading (`config/__main__.py`, `docker-compose.process.yml`)
- [ ] **Phase 3.1** — Docker writable mount (`docker-compose.process.yml`)
- [ ] **Phase 3.2** — Bypass paths ANONYMOUS (`gateway/auth.py`)
- [ ] **Phase 3.3** — Audit logging (`service.py`)
- [ ] **Tests** — All new and modified test files passing
- [ ] **Format & Lint** — `make format && make lint` clean
- [ ] **Manual Validation** — All 4 scenarios verified
