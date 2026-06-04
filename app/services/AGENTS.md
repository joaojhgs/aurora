# Service Development -- Agent Guide

> **Scope**: `app/services/` -- All Aurora services, their lifecycle, and development patterns.
> **Parent**: [Root AGENTS.md](../../AGENTS.md) for global rules.
> **Related**: [Messaging AGENTS.md](../messaging/AGENTS.md) for bus rules; [Contracts AGENTS.md](../shared/contracts/AGENTS.md) for topic constants and IO models; [Shared AGENTS.md](../shared/AGENTS.md) for shared code rules. **Config**: [CONFIG_SERVICE_PATTERN.md](../../docs/CONFIG_SERVICE_PATTERN.md).
> **Service-specific guides**: [Gateway](gateway/AGENTS.md), [Auth](auth/AGENTS.md).

---

## Service Lifecycle

Every service inherits from `BaseService` (`app/shared/services/base_service.py`):

```python
from app.shared.services.base_service import BaseService
from app.shared.contracts.registry import method_contract

class MyService(BaseService):
    def __init__(self):
        super().__init__(
            module="MyService",
            summary="Description",
            capabilities=["cap1", "cap2"]
        )

    async def on_start(self):
        """Service-specific startup. Bus and contracts are already registered."""
        pass

    async def on_stop(self):
        """Clean up resources: close connections, cancel tasks, release locks."""
        pass

    async def reload(self, config_section: str | None = None):
        """Handle config hot-reload. Called when Config.Updated fires."""
        if config_section == "my_section" or config_section is None:
            from app.shared.config.interface import ConfigAPI

            self._setting = await ConfigAPI().aget(
                "my_section.setting",
                default=None,
                config_timeout=15.0,
            )
```

### What BaseService Does Automatically

1. Calls `register_module()` in the contract registry
2. Scans for `@method_contract` decorated methods
3. Subscribes each contract method to its bus topic on `start()`
4. Subscribes to `Config.Updated` for hot-reload
5. Publishes `Gateway.ServiceAnnounce` in process mode
6. Publishes `Gateway.ServiceDepart` on stop

---

## Startup Order

The Supervisor starts services in strict dependency order:

```
1. ConfigService          (no dependencies -- starts first)
2. DBService              (depends on Config)
3. AuthService            (depends on Config, DB)
4. ToolingService         (depends on Config, DB)
5. SchedulerService       (depends on Config, DB)
6. STT Services           (depends on Config)
   - STTCoordinator
   - WakeWordService
   - TranscriptionService
7. TTSService             (depends on Config)
8. OrchestratorService    (depends on Config, DB, Tooling)
9. GatewayService         (depends on Config, Auth -- starts last)
```

---

## Service Communication Rules

1. **Bus only** -- NEVER import or call another service directly
2. **Pydantic models** -- NEVER pass raw dicts as bus payloads
3. **Typed topic constants** -- NEVER use literal string topics (see [Messaging AGENTS.md](../messaging/AGENTS.md))
4. **Priority helpers** -- Use `get_interactive_priority()`, `get_system_priority()`, `get_external_priority()`

```python
# CORRECT
from app.shared.contracts.models.tts import TTSMethods, TTSRequest
await self.bus.publish(TTSMethods.REQUEST, TTSRequest(text="Hello"), event=False, priority=10)

# WRONG -- literal string, raw dict
await self.bus.publish("TTS.Request", {"text": "Hello"}, event=False)
```

---

## Contract Registration

Every public service method MUST have a `@method_contract` decorator:

```python
from app.shared.contracts.models.my_service import MyServiceMethods, MyRequest, MyResponse

@method_contract(
    method_id=MyServiceMethods.DO_SOMETHING,  # Typed constant
    summary="Do something",
    input_model=MyRequest,
    output_model=MyResponse,
    exposure="internal",        # "internal" | "external" | "both"
    method_type="use",          # "use" | "manage"
)
async def do_something(self, data: MyRequest) -> MyResponse:
    ...
```

Topic constants and IO models MUST be defined in `app/shared/contracts/models/` BEFORE use. See [Contracts AGENTS.md](../shared/contracts/AGENTS.md).

---

## Adding a New Service

### 1. Create Topic Constants and IO Models

In `app/shared/contracts/models/my_service.py`:

```python
class MyServiceModule:
    NAME = "MyService"

class MyServiceMethods:
    DO_SOMETHING = f"{MyServiceModule.NAME}.DoSomething"
    HEALTH_CHECK = f"{MyServiceModule.NAME}.HealthCheck"

class MyRequest(BaseModel):
    param: str

class MyResponse(BaseModel):
    result: str
```

### 2. Create Service Directory

```
app/services/my_service/
├── __init__.py
├── __main__.py      # Entry point for process mode
├── service.py       # Service class
└── (other files)
```

### 3. Implement Service

See "Service Lifecycle" above.

### 4. Register in Supervisor

In `app/services/supervisor.py`, add to `_start_services_threads()`:

```python
from app.services.my_service import MyService

my_service = MyService()
await my_service.start()
self.services.append(my_service)
```

### 5. Add Docker Support (process mode)

- Create `docker/services/Dockerfile.my-service`
- Add to `docker-compose.process.yml`
- Add console_scripts entry in `pyproject.toml`

---

## Adding a New Tool

### 1. Create Tool File

In `app/services/tooling/tools/my_tool.py`:

```python
from langchain_core.tools import tool

@tool
def my_tool(param: str) -> str:
    """Description of what the tool does.

    Args:
        param: Parameter description

    Returns:
        Result description
    """
    return f"Result: {param}"
```

### 2. Register in ToolsManager

In `app/services/tooling/tools_manager.py`, in `_load_core_tools()`:

```python
from .tools.my_tool import my_tool
self._tools.append(my_tool)
```

---

## Adding a Plugin

### 1. Create Plugin Directory

```
app/services/tooling/tools/plugins/my_plugin/
├── __init__.py
└── tools.py
```

### 2. Add Config

In `config.json`:
```json
{ "plugins": { "my_plugin": { "activate": true } } }
```

### 3. Add Dependencies

In `pyproject.toml`:
```toml
[project.optional-dependencies]
my-plugin = ["my-plugin-dependency>=1.0.0"]
```

### 4. Load Conditionally

In ToolsManager:
```python
from app.shared.config.interface import config_api
from app.shared.config.keys import ConfigKeys

if await config_api.aget(ConfigKeys.services.tooling.plugins.my_plugin.activate, default=False):
    from .tools.plugins.my_plugin.tools import my_plugin_action
    self._tools.append(my_plugin_action)
```

---

## Per-Service Summary

| Service | Directory | Topics Class | Dependencies | Key Patterns |
|---------|-----------|-------------|-------------|-------------|
| **Config** | `config/` | `ConfigMethods` | None (starts first) | Publishes `Config.Updated` with `mesh=True`; all other services depend on it |
| **DB** | `db/` | `DBMethods` | Config | SQLite + aiosqlite; migrations in `migrations/`; RAG with sqlite-vec |
| **Auth** | `auth/` | `AuthMethods` | Config, DB | All DB via bus; pairing in-memory (5min expiry); see [Auth AGENTS.md](auth/AGENTS.md) |
| **Tooling** | `tooling/` | `ToolingMethods` | Config, DB | Core -> plugins -> MCP load order; `always_active_tools`; `mesh=True` on init/reload |
| **Scheduler** | `scheduler/` | `SchedulerMethods` | Config, DB | Cron + absolute time; retries (5min, 3x); callbacks as module.function strings |
| **TTS** | `tts/` | `TTSMethods` | Config | Piper TTS engine; `asyncio.to_thread()` for blocking audio; `mesh=True` on status events |
| **STTCoordinator** | `stt_coordinator/` | `STTMethods` | Config | Audio capture (PyAudio); state machine (IDLE->LISTENING->TRANSCRIBING); publishes audio chunks |
| **WakeWord** | `stt_wakeword/` | `WakeWordMethods` | Config | OpenWakeWord or Porcupine backends; subscribes to audio stream |
| **Transcription** | `stt_transcription/` | `TranscriptionMethods` | Config | faster-whisper; dual models (realtime + accurate); VAD segmentation; daemon thread |
| **Orchestrator** | `orchestrator/` | `OrchestratorMethods` | Config, DB, Tooling | LangGraph agent; tool calls via bus; `"END"` sentinel response skips TTS |
| **Gateway** | `gateway/` | `GatewayMethods` | Config, Auth | FastAPI + WebRTC + Mesh; see [Gateway AGENTS.md](gateway/AGENTS.md) |
| **Supervisor** | `supervisor.py` | `SupervisorMethods` | None (top-level) | Bus init; startup order; graceful shutdown |
| **UIBridge** | `../ui/bridge_service.py` | -- | All user-facing | Qt signals bridge; runs in background thread |

---

## Config Reload Pattern

Services automatically receive reload calls when `Config.Updated` fires:

```python
async def reload(self, config_section: str | None = None):
    if config_section == "my_section" or config_section is None:
        self._setting = await config_api.aget("my_section.setting")
```

Some services (like Orchestrator) stop and restart themselves on LLM config changes.

---

## Resource Cleanup

Every service MUST clean up in `on_stop()`:

```python
async def on_stop(self):
    if self._db_connection:
        await self._db_connection.close()
    for task in self._background_tasks:
        task.cancel()
```

For threads, always set `daemon=True` so they don't hang the process:
```python
self._thread = threading.Thread(target=self._worker, daemon=True)
```
