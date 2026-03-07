# Shared Code -- Agent Guide

> **Scope**: `app/shared/` -- Interfaces, models, and stateless utilities shared across all services.
> **Parent**: [Root AGENTS.md](../../AGENTS.md) for global rules.
> **Related**: [Contracts AGENTS.md](contracts/AGENTS.md) for the contract system; [Messaging AGENTS.md](../messaging/AGENTS.md) for bus rules.

---

## CRITICAL RULES

### What Belongs in `app/shared/`

- Pydantic models (contracts, IO models, message payloads)
- Abstract interfaces and protocols
- Stateless, pure utility functions
- Dataclass entity models (User, Token, Device, etc.)
- Type definitions and constants

### What NEVER Belongs in `app/shared/`

- Service logic or business rules
- Utility classes with mutable state
- Complex dependencies or heavy imports
- Database connections or network clients
- Anything that breaks Process Mode (distributed architecture)

**Why**: Services must remain decoupled. In Process Mode, each service runs in a separate OS process. Shared code that holds state or heavy dependencies couples services and breaks isolation.

---

## Subpackage Guide

### `shared/contracts/` -- Contract Registry and IO Models

The API surface of every service. See [Contracts AGENTS.md](contracts/AGENTS.md) for full details.

- `registry.py` -- `@method_contract` decorator, `register_module()`, `MethodContract`, `ModuleContract`
- `models/` -- One file per service module with `*Methods` classes and Pydantic IO models

### `shared/auth/` -- Identity, Permissions, Audit

The ACL subsystem used by Gateway, Auth, and any permission-checking code.

**`identity.py`**:
- `Identity` dataclass: `principal_id`, `principal_name`, `is_admin`, `permissions`, `effective_perms`, `device_id`, `source`
- `can(*perms, method_type=None)` -- check if identity has all required permissions
- Sentinel identities:
  - `ANONYMOUS` -- no permissions, used for unauthenticated bypass paths
  - `SYSTEM` -- admin, full access, used when auth is disabled entirely
  - `OPEN_PEER` -- full permissions, used for WebRTC peers when auth is disabled
- `build_identity(user, token, source)` -- construct identity from user + token scope intersection

**`permissions.py`**:
- `Permission` type alias with `validate_permission()` validator
- `PERM_ALL = "*"` -- superuser wildcard
- `has_permission(required, granted_set)` -- single permission check with wildcard support
- `check_access(effective_perms, required_perms)` -- check multiple permissions
- `wildcard_intersection(user_perms, token_scopes)` -- compute effective permissions
- `resolve_effective_permissions(is_admin, user_perms, token_scopes)` -- full resolution
- Permission format: `Service.Action` (PascalCase), e.g., `TTS.Request`, `Auth.manage`
- Wildcards: `*` (all), `Service.*` (all in service), `Service.use`/`Service.manage` (type-based)
- **IMPORTANT**: Permission matching is case-sensitive. Always use PascalCase (`Auth.manage`, not `auth.manage`)

**`audit.py`**:
- `audit_event(db_manager, event, principal_id, details, ip_address)` -- log audit event
- Failures are logged but never raise (audit must not break the request)

### `shared/config/` -- ConfigAPI

- `interface.py` -- `ConfigAPI` singleton for bus-backed config access
- Sync: `config_api.get("general.llm.provider")`, `config_api.get_config()`
- Async: `await config_api.aget("general.llm.provider")`
- Global instance: `from app.shared.config.interface import config_api`

### `shared/services/` -- BaseService

- `base_service.py` -- `BaseService` base class for all services
  - Lifecycle: `start()` -> `on_start()`, `stop()` -> `on_stop()`, `reload()`
  - Auto-registers `@method_contract` methods
  - Auto-subscribes to registered contracts on start
  - Config observer for hot-reload
  - Gateway announce/depart in process mode
- `health.py` -- `check_service_health()` helper
- `process_launcher.py` -- `ProcessLauncher` for process mode

### `shared/messaging/` -- Bus Singleton Setup

- `bus_init.py` -- Mode-aware bus singleton (`get_bus_singleton()`)
  - Thread mode: single global bus
  - Process mode: per-service buses

### `shared/messaging/models/` -- Legacy Payload Models

Older message payload models. New code should define IO models in `shared/contracts/models/` instead.

### `shared/models/` -- DB Entity Models

- `db.py` -- Dataclass models: `Message`, `User`, `Device`, `Token`, `CronJob`, `MeshCredential`
- Enums: `MessageType`, `ScheduleType`, `JobStatus`
- Factory methods: `Message.create_user_text_message()`, `Message.create_assistant_text_message()`

---

## Import Rules

**Always use absolute imports**:

```python
# CORRECT
from app.shared.config.interface import ConfigAPI
from app.shared.contracts.models.auth import AuthMethods
from app.shared.auth.identity import Identity, ANONYMOUS, SYSTEM

# WRONG
from ..config.interface import ConfigAPI
from .models.auth import AuthMethods
```

**Avoid circular imports** with `TYPE_CHECKING`:

```python
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.db import DBService
```

---

## Naming Conventions

| Entity | Convention | Example |
|--------|-----------|---------|
| Files | `snake_case.py` | `base_service.py` |
| Classes | `PascalCase` | `BaseService`, `ConfigAPI` |
| Functions | `snake_case()` | `get_bus_singleton()` |
| Constants | `UPPER_SNAKE_CASE` | `PERM_ALL`, `SYSTEM` |
| Private | `_leading_underscore` | `_state_lock` |
| Services | `{Name}Service` | `TTSService`, `DBService` |
| Models | `{Name}Request/Response/Event` | `TTSRequest`, `LoginResponse` |
| Topics | `{Service}.{Action}` | `TTS.Request`, `Auth.Login` |

---

## Structured Logging

Always use the project logger, never `logging.getLogger()`:

```python
from app.helpers.aurora_logger import log_info, log_error, log_debug, log_warning

log_info("Service started")
log_error("Failed to connect", exc_info=True)
log_debug(f"Processing: {message_id}")
```
