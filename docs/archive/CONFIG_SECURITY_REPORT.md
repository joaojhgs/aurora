# Aurora Configuration Security & Maintainability Report

**Roles**: Security analyst and project maintainer
**Scope**: Config service, .env vs config.json, distributed vs local deployment, external API exposure
**Audited Commit**: `feature/webrtc-gateway-setup-integration` branch
**Date**: 2026-03-08

---

## Executive Summary

The current config setup is **not suitable for secure deployment** as-is. The system has **4 critical**, **3 high**, and **4 medium** severity findings across authentication, authorization, secret management, and deployment configuration:

| Severity | Count | Summary |
|----------|-------|---------|
| **Critical** | 4 | Secret exposure via API, auth disabled by default, config change events leak secrets over mesh, no bus-level ACL |
| **High** | 3 | Config.Set allows overwriting security settings, `required_perms` is dead code on HTTP, CORS wide open |
| **Medium** | 4 | Process-mode .env not loaded, config.json read-only in Docker, `allow_origins` unenforced, bypass paths get SYSTEM identity |

The architecture's **design** (centralized config + message bus + gateway auth) is sound. The **implementation** has gaps that must be closed before any external-facing deployment.

---

## 1. Current Architecture

### 1.1 Config Data Flow

```
                   ┌─────────────────────┐
                   │     ConfigAPI        │  app/shared/config/interface.py
                   │  (bus-based proxy)   │  Global singleton in app/__init__.py
                   └────────┬────────────┘
                            │ bus.request()
                            ▼
                   ┌─────────────────────┐
                   │   ConfigService      │  app/services/config/service.py
                   │  (BaseService)       │  Handles Get/Set/Validate/Plugin contracts
                   └────────┬────────────┘
                            │ delegates to
                            ▼
                   ┌─────────────────────┐
                   │   ConfigManager      │  app/services/config/config_manager.py
                   │  (thread-safe        │  Loads/saves config.json, schema validation
                   │   singleton)         │  Reads ENV_CONFIG_MAP for .env fallback
                   └────────┬────────────┘
                            │ reads
               ┌────────────┼───────────────┐
               ▼            ▼               ▼
        config.json    config_schema.json  os.environ (via ENV_CONFIG_MAP)
                       + config_defaults.json
```

| Component | File | Responsibility |
|-----------|------|----------------|
| **ConfigManager** | `app/services/config/config_manager.py` | Thread-safe singleton. Loads `config.json`, validates against JSON Schema, resolves env fallbacks via `ENV_CONFIG_MAP`. Provides `get()`, `set()`, `get_config_dict()`. |
| **ConfigService** | `app/services/config/service.py` | `BaseService` subclass. Subscribes to bus topics `Config.Get`, `Config.Set`, etc. Publishes `Config.Updated` events (including to mesh). |
| **ConfigAPI** | `app/shared/config/interface.py` | Client wrapper. Uses `bus.request(Config.Get, ...)` for async access. Global singleton `config_api`. |
| **ENV_CONFIG_MAP** | `app/services/config/env_config.py` | Maps 40+ dot-notation config paths to `(ENV_VAR_NAME, converter)` tuples. |
| **SENSITIVE_KEYS** | `app/services/config/env_config.py` | `frozenset` of 10 sensitive config paths. Used **only** for schema annotation and `migrate_secrets_to_env()` — **not** for runtime redaction. |

### 1.2 Value Resolution Order

```
config.json value (if "set") > os.environ (via ENV_CONFIG_MAP) > default argument
```

The `_is_value_set()` helper treats `None`, empty strings, and empty collections as "unset". This means **config.json always wins** when populated — environment variables are fallbacks, not overrides.

### 1.3 .env Loading

| Mode | How .env is loaded | Status |
|------|--------------------|--------|
| **Thread mode** | `main.py` calls `load_dotenv()` at startup | ✅ Works |
| **Process mode** | `app/services/config/__main__.py` does **not** call `load_dotenv()` | ❌ Broken |
| **Docker** | `docker-compose.process.yml` has no `env_file:` directive; uses only `environment:` blocks | ⚠️ Partial — secrets must be hardcoded in compose or injected externally |

### 1.4 External Exposure via Gateway

| Method | `exposure` | `method_type` | HTTP Route | WebRTC | Auth Gate |
|--------|-----------|---------------|------------|--------|-----------|
| Config.Get | `both` | `use` | `POST /api/Config/Get` | ✓ | `Config.use` scope (when auth enabled) |
| Config.Set | `both` | `manage` | `POST /api/Config/Set` | ✓ | `Config.manage` scope (when auth enabled) |
| Config.Validate | `both` | `use` | `POST /api/Config/Validate` | ✓ | `Config.use` scope |
| Config.GetPlugin | `both` | `use` | `POST /api/Config/GetPlugin` | ✓ | `Config.use` scope |
| Config.SetPlugin | `both` | `manage` | `POST /api/Config/SetPlugin` | ✓ | `Config.manage` scope |

Note: `required_perms` on all contracts is `[]` (default). The gateway route generator **ignores `required_perms`** and uses `scopes = [method_id]` (the bus topic) instead. The `method_type` field (`"use"` / `"manage"`) is the only access control distinction.

---

## 2. Security Findings

### 2.1 CRITICAL: Authentication Disabled by Default

**Location**: `app/services/gateway/config.py` line 93: `auth_enabled: bool = False`

**Issue**: The gateway's default configuration has authentication **disabled**. When auth is disabled, `_resolve_identity_and_check()` returns `SYSTEM` (admin with `{"*"}` permissions) for every request.

**Proof of exploit**:
```bash
# No auth headers needed — anyone on the network can do this:
curl -X POST http://aurora-host:8000/api/Config/Get -H 'Content-Type: application/json' -d '{}'
# Returns: full config including all secrets
```

**Impact**: In the default deployment, **every HTTP/WebRTC caller automatically has full administrator access** to every API endpoint, including reading and writing configuration, secrets, and all other service methods.

**Risk level**: **Critical**

---

### 2.2 CRITICAL: Full Config (Including Secrets) Exposed via Config.Get

**Location**: `app/services/config/service.py` lines 109–124

**Issue**: The `_handle_get_config` handler returns raw config data without any redaction:

```python
async def _handle_get_config(self, query: GetConfigQuery) -> GetConfigResponse:
    if section:
        config = self.config_manager.get(section, {})
    else:
        config = self.config_manager.get_config_dict()  # ← includes env fallbacks
    return GetConfigResponse(config=config)
```

`get_config_dict()` calls `_resolve_env_fallbacks()` which merges **all** environment variable values into the config copy — including secrets loaded from `.env`. The `SENSITIVE_KEYS` frozenset exists but is **never consulted** during response generation.

**Impact**: Any caller with `Config.use` scope (or any caller when auth is disabled) receives:

| Exposed Secret | Config Path |
|----------------|-------------|
| OpenAI API key | `general.llm.third_party.openai.options.api_key` |
| HuggingFace access token | `general.llm.third_party.huggingface_endpoint.options.access_token` |
| Gateway token secret | `gateway.token_secret` |
| Gateway API keys | `gateway.auth.api_keys` |
| WebRTC password | `gateway.webrtc.password` |
| Jira API token | `plugins.jira.api_token` |
| Brave Search API key | `plugins.brave_search.api_key` |
| GitHub app private key | `plugins.github.app_private_key` |
| Slack user token | `plugins.slack.user_token` |
| Google credentials file path | `plugins.google.credentials_file` |

Even targeted requests like `{"section": "gateway"}` return nested secrets.

**Risk level**: **Critical**

---

### 2.3 CRITICAL: ConfigChangedEvent Leaks Secrets Over Mesh

**Location**: `app/services/config/service.py` lines 90–93

**Issue**: When any config value is changed via `Config.Set`, the `ConfigChangedEvent` includes both `old_value` and `new_value` and is published with `mesh=True`:

```python
async def _publish_config_change(self, event: ConfigChangedEvent) -> None:
    await self.bus.publish(ConfigMethods.UPDATED, event, event=True, mesh=True)
```

The `ConfigChangedEvent` model contains:
```python
class ConfigChangedEvent(Event):
    affected_sections: list[str]
    key_path: str
    old_value: Any    # ← secret plaintext
    new_value: Any    # ← secret plaintext
```

**Impact**: When an admin rotates a secret (e.g., changes `gateway.token_secret`), the **old and new secret values are broadcast** to:
1. All local services via the bus
2. All connected mesh peers via WebRTC data channels
3. In process mode, through Redis (where they can be observed)

**Risk level**: **Critical**

---

### 2.4 CRITICAL: No Bus-Level Access Control

**Location**: `app/shared/services/base_service.py` — `_subscribe_registered_contracts()` method

**Issue**: The `BaseService` message handler wrapper performs input validation and method dispatch but **never checks** `envelope.origin`, `envelope.principal_id`, or permissions. Any code with bus access can call any topic with `origin="internal"`, completely bypassing gateway authentication.

**Impact**:
- In thread mode: Any service (or any code in the same process) can call `Config.Set` directly.
- In process mode: Any process with Redis access can publish to `Config.Set` with `origin="internal"`.
- The `MethodContract.allow_origins` field (defaulting to `["internal"]`) is **declared but never enforced** — it is dead code.

**Risk level**: **Critical** (in process mode with shared Redis)

---

### 2.5 HIGH: Config.Set Allows Overwriting Security-Critical Settings

**Location**: `app/services/config/service.py` lines 125–140

**Issue**: `Config.Set` accepts any `key_path` and `value`. There is no field-level ACL — any caller with `Config.manage` scope can write to any config path, including security-critical ones.

**Attack scenarios** (assuming attacker has `Config.manage` or auth is disabled):

| Attack | Payload | Impact |
|--------|---------|--------|
| Disable auth | `{"key_path": "gateway.auth.enabled", "value": false}` | Turns off all authentication |
| Replace API keys | `{"key_path": "gateway.auth.api_keys", "value": ["attacker-key"]}` | Attacker gains permanent admin access |
| Replace token secret | `{"key_path": "gateway.token_secret", "value": "attacker-secret"}` | Attacker can forge valid tokens |
| Replace LLM provider | `{"key_path": "general.llm.provider", "value": "openai"}` + set endpoint to attacker server | LLM traffic exfiltrated |

**Risk level**: **High**

---

### 2.6 HIGH: `required_perms` is Dead Code on HTTP Path

**Location**: `app/services/gateway/route_generator.py` line 570

**Issue**: The route generator ignores the contract's `required_perms` field:

```python
# In route generation:
scopes = [method_id]   # ← hardcoded to bus topic, ignores required_perms
```

The `method_type` field provides the only distinction (`"use"` vs `"manage"`). The WebRTC RPC handler *does* check `required_perms`, but since no contract populates it, the check is always a no-op.

**Impact**: Even if developers add `required_perms` to contracts, HTTP routes will not enforce them. This creates a false sense of security.

**Risk level**: **High**

---

### 2.7 HIGH: CORS Defaults to `["*"]`

**Location**: `app/services/gateway/config.py` line 90: `cors_origins: list[str] = ["*"]`

**Issue**: The default CORS configuration allows requests from any origin. Combined with the auth-disabled default, this means any website can make cross-origin requests to the Aurora API and read the responses (including full config with secrets).

**Attack**: A malicious website visited by someone on the same network as an Aurora instance can silently exfiltrate all configuration and secrets via JavaScript.

**Risk level**: **High**

---

### 2.8 MEDIUM: Process-Mode Services Do Not Load .env

**Location**: `app/services/config/__main__.py` — no `load_dotenv()` call

**Issue**: Thread mode calls `load_dotenv()` in `main.py`, but process-mode entry points do not. `ConfigManager.get()` uses `os.environ.get()` which requires the `.env` file to already be loaded into the environment.

**Impact**: In process mode without Docker `env_file`, all `.env`-based secrets (API keys, tokens) resolve to `None`. ConfigService will return empty values for secrets even though `.env` is present on disk.

**Risk level**: **Medium**

---

### 2.9 MEDIUM: config.json Mounted Read-Only in Docker

**Location**: `docker-compose.process.yml` — `./config.json:/app/config.json:ro`

**Issue**: `ConfigManager.save_config()` writes to `config.json`. With a read-only mount, `Config.Set` will succeed in memory but silently fail to persist, or raise an error that returns `success=False`.

**Impact**: Runtime config changes are lost on container restart. No data loss, but confusing behavior.

**Risk level**: **Medium**

---

### 2.10 MEDIUM: Bypass Paths Get SYSTEM Identity When Auth is Enabled

**Location**: `app/services/gateway/auth.py` lines 189–191

**Issue**: Even when auth is enabled, bypass paths (`/api/health`, `/api/docs`, `/api/auth/login`, pairing endpoints) receive the full `SYSTEM` identity instead of `ANONYMOUS`:

```python
if not auth.is_enabled() or auth.should_bypass(request.url.path):
    request.state.identity = SYSTEM
```

**Impact**: Any downstream code that branches on `request.state.identity.is_admin` will incorrectly treat health/doc/pairing requests as admin-level. Currently harmless because bypass paths don't forward to sensitive handlers, but it's a latent risk if new bypass paths are added.

**Risk level**: **Medium**

---

### 2.11 MEDIUM: `allow_origins` is Declared but Never Enforced

**Location**: `app/shared/contracts/registry.py` line 61

**Issue**: `MethodContract` declares `allow_origins: list[str] = ["internal"]` — suggesting methods should only accept internal messages by default. However, no code path in `BaseService`, the gateway, or the bus ever checks this field against `envelope.origin`.

**Impact**: The contract metadata implies a security boundary that does not exist. Developers may assume methods marked `allow_origins=["internal"]` are protected from external access, but they are not.

**Risk level**: **Medium**

---

## 3. Authentication & Authorization Deep Dive

### 3.1 Auth Flow (When Enabled)

```
HTTP Request → Auth Middleware → Scoped Auth Check → Bus → ConfigService
                    │                    │
                    ├─ API Key? → SYSTEM identity (full admin)
                    ├─ Bearer token? → Auth.ValidateToken via bus → Identity
                    └─ Neither? → 401

                                         │
                                         ├─ identity.can(scopes, method_type) → ✅ proceed
                                         └─ insufficient → 403
```

### 3.2 Permission Engine

The permission engine in `app/shared/auth/permissions.py` uses a priority-ordered matching system:

1. `"*"` in granted permissions → always allowed (superuser)
2. Exact match: `"Config.Get"` in granted → allowed
3. Wildcard prefix: `"Config.*"` matches `"Config.Get"`
4. Type-based: `"Config.use"` matches `"Config.Get"` when `method_type="use"`

This means a token with scope `["Config.use"]` can call `Config.Get`, `Config.Validate`, `Config.GetPlugin` (all `method_type="use"`) but **not** `Config.Set` or `Config.SetPlugin` (both `method_type="manage"`). A token with `["Config.*"]` or `["*"]` can call everything.

### 3.3 Gap Analysis

| What Works | What's Missing |
|------------|----------------|
| `method_type` provides read/write distinction | No field-level ACL (any `manage` user can write secrets) |
| Token scoping with intersection logic | `required_perms` ignored on HTTP path |
| API key → SYSTEM is correct for server-to-server | No differentiation between "admin who can read secrets" and "admin who can change settings" |
| `origin` is set correctly by gateway | `origin` is never checked by receiving services |
| `allow_origins` is declared | `allow_origins` is never enforced |

---

## 4. Centralized vs Per-Service .env

### 4.1 Centralized (Config Service Only Has .env)

**Flow**:
1. Only ConfigService has `env_file: .env` (or equivalent).
2. Other services get config via `bus.request(Config.Get, ...)`.
3. ConfigService merges env into config and returns it.

| Pros | Cons |
|------|------|
| Single source of truth for secrets | ConfigService is a high-value target |
| Easier secret rotation (restart one service) | Config (including secrets) sent over the bus |
| Fewer containers with secrets | In process mode, secrets travel through Redis |
| Simpler operational model | Single point of failure for config |

### 4.2 Per-Service .env

**Flow**:
1. Each service has its own `env_file: .env` or env injection.
2. Services use `config_api.aget()` for non-secret config and `os.getenv()` for secrets.
3. Secrets never leave the process that needs them.

| Pros | Cons |
|------|------|
| Secrets stay local to each process | Every service needs env injection |
| No secrets traverse the bus | Secret rotation requires restarting multiple services |
| Defense in depth | More complex deployment configuration |
| Redis compromise doesn't leak secrets | Duplicated secret management |

### 4.3 Recommendation: Hybrid with Redaction

| Mode | Approach |
|------|----------|
| **Thread mode** | Single process; one `.env` file loaded by `main.py`. No bus exposure risk. |
| **Process mode** | ConfigService loads `.env` centrally. Internal `Config.Get` returns full config (services are trusted). External `Config.Get` redacts `SENSITIVE_KEYS`. Services that directly need a secret (e.g., orchestrator needs OpenAI key) should also have the specific env var injected directly — defense in depth. |

**Why centralized-with-redaction wins**: The bus is an internal trusted channel. Services already communicate all data over it (audio, transcriptions, LLM responses). Adding config data doesn't materially increase the attack surface. The real risk is **external exposure**, which is solved by redaction + auth.

---

## 5. Database vs File Config

| Aspect | File (`config.json`) | Database |
|--------|---------------------|----------|
| **Setup complexity** | Zero — just a file | Needs DB, migrations, connection management |
| **Version control** | Git-friendly | Requires export/import tooling |
| **Audit trail** | None | Can log every change with who/when |
| **Access control** | Coarse (file permissions, OS-level) | Fine-grained (per-key, per-user, per-role) |
| **Hot-reload** | Supported via observer pattern | Supported via change notifications |
| **Secrets storage** | Mixed with non-secrets (unless migrated) | Can separate secret store/encryption at rest |
| **Backup/restore** | File copy | DB backup; more complex |
| **Multi-instance** | File conflicts on shared volumes | DB handles concurrent writes |
| **Existing integration** | Fully integrated with schema validation, migration, observer pattern | Would require significant refactoring |

### Recommendation

**Keep file-based config.** The current system with `config.json` + `.env` + JSON Schema validation is well-suited for Aurora's use case:

- Single-instance deployments (thread mode) are the primary target.
- The existing schema validation, observer pattern, and migration tooling work well.
- The DB service (SQLite) is already a dependency — but adding config to it couples two critical subsystems.

**Add these improvements without changing the storage layer:**
1. Runtime redaction of `SENSITIVE_KEYS` for external callers.
2. Audit logging for `Config.Set` operations (log to file or bus event).
3. Field-level permission checks for sensitive paths.

**Consider database config later** if/when:
- Multi-tenant deployments require per-tenant config isolation.
- Regulatory compliance requires immutable audit trails.
- Multiple Aurora instances need shared, consistent config.

---

## 6. Secure Deployment Model

### 6.1 Target Architecture

```
┌──────────────────────────────────────────────────────┐
│                  .env (secrets only)                  │
│  OPENAI_API_KEY, AURORA_TOKEN_SECRET, etc.            │
│  → Loaded by ConfigService (centralized)              │
│  → Optionally injected per-service (defense-in-depth) │
└──────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│               config.json (non-secrets)              │
│  UI settings, LLM provider choice, model paths, etc. │
│  → Can be in container, version-controlled            │
│  → Runtime overrides via Config.Set (non-sensitive)    │
└──────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────┐
│                   ConfigService                       │
│  Internal callers → full config (trusted bus)         │
│  External callers → redacted config (SENSITIVE_KEYS   │
│                     replaced with "***REDACTED***")    │
│  Config.Set on SENSITIVE_KEYS → requires Config.admin │
└──────────────────────────────────────────────────────┘
```

### 6.2 Usability Preservation

| User Scenario | How It Works |
|---------------|-------------|
| **First-time setup** | `./setup.sh` → generates `.env` template → user fills in API keys → `main.py` loads `.env` + `config.json` defaults. Zero config for thread mode. |
| **UI settings changes** | UI calls `Config.Set` for non-sensitive keys (theme, model selection, plugin toggles). Works without admin privileges with `Config.manage` scope. |
| **Secret management** | Admin with `Config.admin` scope can update secrets via UI or API. Or: edit `.env` directly and restart. |
| **Hot-reload** | `config.json` changes take effect immediately via observer pattern. `.env` changes require restart (standard behavior). |
| **Docker deployment** | `env_file: .env` on config-service container. Other services get config via bus. `config.json` mounted read-write for persistence. |
| **Local dev** | Auth disabled by default → full access. No CORS restrictions. No redaction needed (everything is local). |

### 6.3 Thread Mode vs Process Mode

| Aspect | Thread Mode (dev/local) | Process Mode (production/Docker) |
|--------|------------------------|----------------------------------|
| **Auth** | Disabled by default (acceptable for local) | **Must be enabled** for any external exposure |
| **.env loading** | `main.py` calls `load_dotenv()` | Each `__main__.py` must call `load_dotenv()`, OR docker-compose uses `env_file:` |
| **Bus security** | In-memory (`asyncio` queues) — no external attack surface | Redis — must be on private network, ACL-protected |
| **Config.Get** | Returns full config (local, single user) | Redacts secrets for external callers |
| **CORS** | `["*"]` acceptable for localhost | Must be restricted to known origins |
| **Persistence** | `config.json` on local filesystem | Docker volume or `config.json` mounted read-write |

---

## 7. Implementation Priorities

### P0 — Must Fix Before Any External Deployment

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 1 | Auth disabled by default (§2.1) | Change default to `True` for process mode. Add startup warning when auth is disabled and gateway is binding to `0.0.0.0`. | Small |
| 2 | Config.Get leaks secrets (§2.2) | In `_handle_get_config`, check `envelope.origin`. If `"external"`, call `_redact_sensitive(config)` before returning. Use `SENSITIVE_KEYS` to replace values with `"***REDACTED***"`. | Medium |
| 3 | ConfigChangedEvent leaks secrets (§2.3) | In `_publish_config_change`, check if `event.key_path` is in `SENSITIVE_KEYS`. If so, replace `old_value`/`new_value` with `"***REDACTED***"` before publishing. Or: don't publish change events for sensitive keys at all (just publish the key_path without values). | Small |
| 4 | No bus-level origin check (§2.4) | In `BaseService._subscribe_registered_contracts()`, check `envelope.origin` against `contract.allow_origins`. Reject messages from disallowed origins. | Medium |

### P1 — Should Fix Before Production

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 5 | Config.Set allows overwriting security settings (§2.5) | Add field-level ACL: if `key_path` is in `SENSITIVE_KEYS` or in a security-critical list (e.g., `gateway.auth.*`), require `Config.admin` scope (checked via `envelope.principal_id` + bus request to Auth). | Medium |
| 6 | `required_perms` dead code (§2.6) | In route generator, use `contract.required_perms` as additional scopes (merged with `[method_id]`). | Small |
| 7 | CORS `["*"]` default (§2.7) | Change default to `[]` (empty = same-origin only). Document how to configure for external access. | Small |
| 8 | Process-mode .env not loaded (§2.8) | Add `load_dotenv()` to `app/services/config/__main__.py`. Also add `env_file: .env` to config-service in docker-compose. | Small |

### P2 — Recommended Improvements

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 9 | Docker config.json read-only (§2.9) | Mount as read-write, or use a writable path (e.g., `/app/data/config.json`) for runtime changes. | Small |
| 10 | Bypass paths get SYSTEM (§2.10) | Set `request.state.identity = ANONYMOUS` for bypassed paths. Middleware already skips auth — SYSTEM is unnecessary. | Small |
| 11 | `allow_origins` unenforced (§2.11) | Enforce in `BaseService._subscribe_registered_contracts()` (see P0 #4). Update contracts to explicitly set `allow_origins=["internal", "external"]` for methods intended for external use. | Medium |
| 12 | Audit logging | Log all `Config.Set` calls: timestamp, principal_id, key_path, old_value (redacted if sensitive), new_value (redacted if sensitive). Publish as an audit event. | Medium |

---

## 8. Risk Assessment: Centralized Config Serving Secrets

### Question

If ConfigService is the only service with `.env` and serves config to others via the bus, how big of a security risk is it?

### Answer

| Consumer | Transport | Risk | Justification |
|----------|-----------|------|---------------|
| Internal services (thread mode) | In-memory queue | **Low** | Same process space. No network exposure. If process is compromised, attacker already has memory access. |
| Internal services (process mode) | Redis | **Medium** | Redis must be on private network. Redis ACLs should restrict access. An attacker with Redis access can read **all** bus traffic, not just config. |
| External HTTP callers | FastAPI → bus → response | **Critical (current)** / **Low (with fixes)** | Currently returns full config with secrets (§2.2). With redaction, external callers only see `"***REDACTED***"` for sensitive fields. |
| WebRTC mesh peers | Data channel | **Critical (current)** / **Low (with fixes)** | `ConfigChangedEvent` with `mesh=True` broadcasts secret changes to all peers (§2.3). With redaction in events, secrets don't leave the local bus. |
| UI (PyQt6, local) | Bus (in-process) | **Low** | Same process, same user, local machine. |

### Architecture Decision

**Centralized config with redaction is the right approach.** Reasons:

1. **Secrets already traverse the bus** in other forms (LLM API calls carry API keys in headers; auth tokens are validated via bus). Config is not uniquely dangerous.
2. **Defense in depth** is achieved by (a) redaction for external callers, (b) field-level ACL for writes, (c) optional per-service env injection for critical services.
3. **Operational simplicity** matters for an assistant that targets local/small-team deployment. One `.env` file is vastly simpler than per-service secret management.

---

## 9. Specific Code Fixes (Reference)

### 9.1 Redact Config.Get for External Callers

```python
# In ConfigService._handle_get_config():

from app.services.config.env_config import SENSITIVE_KEYS

def _redact_config(self, config: dict, key_prefix: str = "") -> dict:
    """Deep-copy config with SENSITIVE_KEYS values replaced."""
    result = {}
    for k, v in config.items():
        full_path = f"{key_prefix}.{k}" if key_prefix else k
        if full_path in SENSITIVE_KEYS:
            result[k] = "***REDACTED***" if isinstance(v, str) else ["***REDACTED***"]
        elif isinstance(v, dict):
            result[k] = self._redact_config(v, full_path)
        else:
            result[k] = v
    return result
```

### 9.2 Redact ConfigChangedEvent for Sensitive Keys

```python
# In ConfigService._publish_config_change():

if event.key_path in SENSITIVE_KEYS:
    event = ConfigChangedEvent(
        affected_sections=event.affected_sections,
        key_path=event.key_path,
        old_value="***REDACTED***",
        new_value="***REDACTED***",
    )
```

### 9.3 Field-Level ACL for Config.Set

```python
# In ConfigService._handle_update_config():

SECURITY_CRITICAL_PREFIXES = ("gateway.auth.", "gateway.token_secret", "gateway.webrtc.")

if cmd.key_path in SENSITIVE_KEYS or any(
    cmd.key_path.startswith(p) for p in SECURITY_CRITICAL_PREFIXES
):
    # Require elevated permission — checked via envelope context
    # (requires passing envelope to handler, which is a BaseService change)
    raise PermissionError("Config.admin scope required for sensitive keys")
```

### 9.4 Process-Mode .env Loading

```python
# Add to app/services/config/__main__.py, before service creation:

from dotenv import load_dotenv
load_dotenv()  # Load .env for secrets resolution
```

---

## 10. Summary Matrix

| Goal | Current State | Target State | Priority |
|------|---------------|-------------|----------|
| Secrets not exposed via API | ❌ Full config returned including secrets | ✅ SENSITIVE_KEYS redacted for external callers | P0 |
| Auth enforced on external endpoints | ❌ Disabled by default | ✅ Enabled by default in production; warning when disabled | P0 |
| Config change events don't leak secrets | ❌ old_value/new_value published to mesh | ✅ Sensitive values redacted in events | P0 |
| Bus-level origin enforcement | ❌ `allow_origins` is dead code | ✅ BaseService checks envelope.origin vs contract.allow_origins | P0 |
| Field-level write ACL for secrets | ❌ Any `Config.manage` user can write anything | ✅ SENSITIVE_KEYS require `Config.admin` scope | P1 |
| `required_perms` enforced | ❌ Ignored on HTTP path | ✅ Merged with scopes in route generator | P1 |
| CORS restricted | ❌ `["*"]` default | ✅ Empty default (same-origin) | P1 |
| Process-mode .env loaded | ❌ Not loaded | ✅ load_dotenv() in __main__.py | P1 |
| Docker config.json writable | ❌ Read-only mount | ✅ Writable volume or path | P2 |
| Audit logging | ❌ None | ✅ Config.Set logged with principal, key, timestamp | P2 |
| Bypass paths use ANONYMOUS | ❌ SYSTEM identity | ✅ ANONYMOUS identity | P2 |
| File vs DB config | File (config.json) | Keep file — sufficient for current architecture | N/A |
| Centralized vs per-service .env | Centralized but unredacted | Centralized with external redaction + optional per-service injection | P0/P1 |
