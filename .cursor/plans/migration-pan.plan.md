# Config Service Migration and Codebase Reorganization Plan

## Overview

This plan details the migration of the config and config_api into a dedicated config service, while maintaining the existing interface used across the codebase. The plan also includes creating a shared folder structure, reorganizing payload validation models, moving services into a services directory, standardizing bus access with singleton pattern, implementing config reload mechanism, and fully supporting process mode.

## Architecture Changes

### Current Structure

```javascript
app/
├── config/              # Config manager and API (to become service)
├── contracts/           # Contract registry
├── messaging/           # Bus infrastructure
├── db/                  # DB service
├── orchestrator/        # Orchestrator service
├── scheduler/           # Scheduler service
├── stt_*/              # STT services
├── tts/                 # TTS service
├── tooling/             # Tooling service
└── services/            # Supervisor only
```



### Target Structure

```javascript
app/
├── shared/              # NEW: Shared interfaces and utilities
│   ├── config/          # Default config interface for all services
│   ├── messaging/       # Bus initialization interfaces
│   │   └── models/      # NEW: Payload validation models per service
│   ├── services/        # NEW: Base service abstraction
│   └── contracts/       # Contract skeleton (moved from app/contracts)
├── services/            # All services (except supervisor)
│   ├── config/          # NEW: Config service
│   ├── db/              # Moved from app/db
│   ├── orchestrator/    # Moved from app/orchestrator
│   ├── scheduler/       # Moved from app/scheduler
│   ├── stt_*/           # Moved from app/stt_*
│   ├── tts/             # Moved from app/tts
│   ├── tooling/         # Moved from app/tooling
│   └── supervisor.py    # Supervisor (stays in services/)
└── messaging/           # Bus infrastructure (stays in app/)
```



## Migration Phases

### Phase 1: Create Shared Folder Structure and Service Abstraction

**Goal**: Establish the shared folder structure with default interfaces and create base service abstraction**Tasks**:

1. Create `app/shared/` directory
2. Create `app/shared/config/` with default config interface
3. Create `app/shared/messaging/` with bus initialization interfaces
4. Create `app/shared/messaging/models/` directory for payload models
5. Create `app/shared/services/` for service abstraction
6. Move `app/contracts/` to `app/shared/contracts/`
7. Create `__init__.py` files for all new directories

**Files to Create**:

- `app/shared/__init__.py`
- `app/shared/config/__init__.py`
- `app/shared/config/interface.py` - Default config interface
- `app/shared/messaging/__init__.py`
- `app/shared/messaging/bus_init.py` - Bus initialization utilities with singleton pattern
- `app/shared/messaging/models/__init__.py`
- `app/shared/services/__init__.py`
- `app/shared/services/base_service.py` - Base service class with bus access and config reload
- `app/shared/contracts/__init__.py` (moved from `app/contracts/__init__.py`)

**Files to Move**:

- `app/contracts/registry.py` → `app/shared/contracts/registry.py`

**Service Abstraction Design**:

- Base class `BaseService` with:
- Standardized bus access via singleton pattern
- Config reload capability via abstract method
- Lifecycle methods (start, stop)
- Config observer registration
- Singleton pattern for bus access:
- Threads mode: Global singleton (shared across all services in same process)
- Processes mode: Per-service singleton (each service process has its own instance)
- Config reload mechanism:
- Threads mode: Config service notifies supervisor, supervisor reloads services
- Processes mode: Config service publishes reload events, services subscribe and reload themselves

**Checklist**:

- [ ] Create `app/shared/` directory structure
- [ ] Create default config interface in `app/shared/config/interface.py`
- [ ] Create bus initialization utilities with singleton pattern in `app/shared/messaging/bus_init.py`
- [ ] Create base service class with bus access and config reload in `app/shared/services/base_service.py`
- [ ] Move contracts folder to shared
- [ ] Create all `__init__.py` files
- [ ] Update imports in `app/contracts/registry.py` (if any internal references)

### Phase 2: Create Config Service

**Goal**: Extract config functionality into a dedicated service**Tasks**:

1. Create `app/services/config/` directory
2. Move `app/config/config_manager.py` → `app/services/config/config_manager.py`
3. Move `app/config/config_defaults.json` → `app/services/config/config_defaults.json`
4. Move `app/config/config_schema.json` → `app/services/config/config_schema.json`
5. Create `app/services/config/service.py` - Config service implementation
6. Create `app/services/config/messages.py` - Config service payload models
7. Create `app/services/config/topics.py` - Config service topics
8. Update `app/messaging/service_topics.py` to include ConfigTopics
9. Register ConfigTopics in event registry

**Files to Create**:

- `app/services/config/__init__.py`
- `app/services/config/service.py` - Config service with bus handlers
- `app/services/config/messages.py` - GetConfig, UpdateConfig, ValidateConfig, etc.
- `app/services/config/topics.py` - ConfigTopics class

**Files to Move**:

- `app/config/config_manager.py` → `app/services/config/config_manager.py`
- `app/config/config_defaults.json` → `app/services/config/config_defaults.json`
- `app/config/config_schema.json` → `app/services/config/config_schema.json`

**Files to Delete**:

- `app/config/__init__.py` (after migration)
- `app/config/config_api.py` (will be replaced by interface)

**Checklist**:

- [ ] Create `app/services/config/` directory
- [ ] Move config_manager.py and JSON files
- [ ] Create config service with bus handlers
- [ ] Create config message models (GetConfigQuery, UpdateConfigCommand, etc.)
- [ ] Create ConfigTopics class
- [ ] Update service_topics.py to include ConfigTopics
- [ ] Register ConfigTopics in event registry
- [ ] Update config_manager imports to use new path
- [ ] Test config service independently

### Phase 3: Create Config Interface and Reload Mechanism

**Goal**: Create a config API interface that uses the bus under the hood and implement config reload mechanism**Tasks**:

1. Create `app/shared/config/interface.py` with ConfigAPI class
2. Implement all existing ConfigAPI methods using bus requests
3. Maintain exact same interface as current `app/config/config_api.py`
4. Use bus.request() for queries and bus.publish() for commands
5. Handle async methods properly
6. Implement config reload mechanism in config service
7. Create reload topics and messages for service reloading

**Files to Create**:

- `app/shared/config/interface.py` - ConfigAPI implementation using bus

**Files to Update**:

- `app/services/config/service.py` - Add config change observers and reload event publishing
- `app/services/config/messages.py` - Add reload messages (ReloadServiceCommand, ConfigChangedEvent)
- `app/services/config/topics.py` - Add reload topics (Config.ReloadService, Config.Changed)

**Interface Methods to Implement**:

- `get_config(section: str = None) -> dict[str, Any]`
- `update_config(key_path: str, value: Any) -> bool`
- `update_plugin_status(plugin_name: str, active: bool) -> bool`
- `get_plugin_status(plugin_name: str) -> bool`
- `validate_config() -> list[str]`
- `add_config_observer(callback)`
- `remove_config_observer(callback)`
- `get_mcp_status() -> dict[str, Any]` (async)
- `reload_mcp_servers() -> dict[str, Any]` (async)
- `update_mcp_config(servers_config: dict[str, Any]) -> dict[str, Any]` (async)
- `discover_mcp_servers() -> dict[str, Any]`
- `add_discovered_servers_to_config(server_names: list[str] = None) -> dict[str, Any]` (async)

**Config Reload Mechanism**:

- Config service monitors config changes via observers
- When config changes, config service publishes `Config.Changed` event with affected sections
- Threads mode: Supervisor subscribes to `Config.Changed` and calls `reload()` on affected services
- Processes mode: Services subscribe to `Config.Changed` and call their own `reload()` method
- Config service publishes `Config.ReloadService` command for explicit reload requests
- Services implement `reload()` abstract method from BaseService

**Checklist**:

- [ ] Create ConfigAPI class in `app/shared/config/interface.py`
- [ ] Implement all synchronous methods using bus.request()
- [ ] Implement all async methods using bus.request() or bus.publish()
- [ ] Maintain exact same method signatures
- [ ] Add config reload messages to config service
- [ ] Add config reload topics to ConfigTopics
- [ ] Implement config change observer in config service
- [ ] Implement reload event publishing in config service
- [ ] Update supervisor to subscribe to config changes (threads mode)
- [ ] Handle errors and edge cases
- [ ] Test interface with existing codebase

### Phase 4: Move Payload Models to Shared/Messaging/Models

**Goal**: Centralize all payload validation models**Tasks**:

1. Create service-specific model files in `app/shared/messaging/models/`
2. Move models from service files to shared models
3. Update imports across codebase

**Models to Move**:**From `app/db/service.py`**:

- StoreMessage, GetRecentMessages, GetMessagesForDate, MessagesResponse
- StoreCronJob, GetCronJobs, DeleteCronJob
- RAGStoreCommand, RAGDeleteCommand, RAGSearchQuery, RAGGetQuery, RAGListQuery, RAGItemResponse

→ Move to: `app/shared/messaging/models/db_models.py`**From `app/tts/service.py`**:

- TTSRequest, TTSStop, TTSPause, TTSResume
- TTSEvent, TTSStarted, TTSStopped, TTSPaused, TTSResumed, TTSError

→ Move to: `app/shared/messaging/models/tts_models.py`**From `app/tooling/service.py`**:

- ToolsInitialized, ToolsReloaded, GetToolsQuery, GetToolsResponse
- GetToolByNameQuery, ReloadMCPToolsCommand, GetToolStatsQuery
- GetMCPStatusQuery, GetMCPStatusResponse, ExecuteToolCommand, ExecuteToolResponse

→ Move to: `app/shared/messaging/models/tooling_models.py`**From `app/orchestrator/service.py`**:

- UserInput, LLMResponseReady, ToolRequest, ToolResult

→ Move to: `app/shared/messaging/models/orchestrator_models.py`**From `app/orchestrator/message_types.py`**:

- MessageSource, AuroraMessage (if still used)

→ Move to: `app/shared/messaging/models/orchestrator_models.py`**From `app/stt_wakeword/messages.py`**:

- WakeWordBackendType, WakeWordDetected, WakeWordTimeout, WakeWordControl

→ Move to: `app/shared/messaging/models/stt_wakeword_models.py`**From `app/stt_coordinator/service.py`**:

- STTState, STTSessionStarted, STTSessionEnded, STTUserSpeechCaptured, STTCoordinatorControl

→ Move to: `app/shared/messaging/models/stt_coordinator_models.py`**From `app/scheduler/models.py`**:

- ScheduleType, JobStatus, CronJob (if used for messaging)

→ Keep in scheduler for now, create `app/shared/messaging/models/scheduler_models.py` for message models only**From `app/messaging/audio_messages.py`**:

- AudioEncoding, AudioFormat, AudioChunk, AudioStreamState, AudioStreamControl
- AudioStreamStarted, AudioStreamStopped, AudioTopics

→ Keep in `app/messaging/audio_messages.py` (generic protocol)**From `app/messaging/transcription_messages.py`**:

- TranscriptionType, TranscriptionResult, TranscriptionControl, TranscriptionError

→ Keep in `app/messaging/transcription_messages.py` (generic protocol)**Files to Create**:

- `app/shared/messaging/models/db_models.py`
- `app/shared/messaging/models/tts_models.py`
- `app/shared/messaging/models/tooling_models.py`
- `app/shared/messaging/models/orchestrator_models.py`
- `app/shared/messaging/models/stt_wakeword_models.py`
- `app/shared/messaging/models/stt_coordinator_models.py`
- `app/shared/messaging/models/scheduler_models.py` (for message models)

**Checklist**:

- [ ] Create all model files in `app/shared/messaging/models/`
- [ ] Move models from db/service.py to db_models.py
- [ ] Move models from tts/service.py to tts_models.py
- [ ] Move models from tooling/service.py to tooling_models.py
- [ ] Move models from orchestrator/service.py to orchestrator_models.py
- [ ] Move models from stt_wakeword/messages.py to stt_wakeword_models.py
- [ ] Move models from stt_coordinator/service.py to stt_coordinator_models.py
- [ ] Create scheduler_models.py for scheduler message models
- [ ] Update all imports in service files
- [ ] Update all imports in tests
- [ ] Verify no circular imports

### Phase 5: Update All Imports to Use Shared Config Interface

**Goal**: Replace all config imports with shared interface**Tasks**:

1. Find all files importing from `app.config.config_api` or `app.config.config_manager`
2. Replace with imports from `app.shared.config.interface`
3. Update direct config_manager usage to use ConfigAPI interface
4. Ensure backward compatibility

**Files to Update** (29+ files found):

- `app/config/config_api.py` (will be removed)
- `app/tooling/tools_manager.py`
- `app/orchestrator/agents/chatbot.py`
- `app/db/rag_service.py`
- `tests/unit/tooling/test_mcp_client.py`
- `app/tts/piper_engine.py`
- `app/stt_transcription/service.py`
- `app/tts/service.py`
- `app/stt_audio_input/service.py`
- `app/stt_coordinator/service.py`
- `main.py`
- `app/stt_wakeword/service.py`
- `app/messaging/priority_helpers.py`
- `app/services/supervisor.py`
- `tests/integration/test_mcp_integration.py`
- `tests/integration/test_db_config_integration.py`
- `tests/unit/app/config/test_field_metadata.py`
- `tests/integration/test_integration_complete.py`
- `tests/integration/test_fix_db_config.py`
- `app/tts/tts_engine.py`
- `app/tooling/tools/brave_search.py`
- `app/tooling/mcp/mcp_client.py`
- `modules/ui/aurora_ui.py`
- `tests/unit/app/config/test_config_manager.py`
- `tests/unit/app/config/test_file_fields.py`
- `app/helpers/getUseHardwareAcceleration.py`
- `app/__init__.py`
- `scripts/config_updater.py`
- `app/helpers/getGoogleCredentials.py`
- `modules/ui/config_modal.py`
- `docs/INSTALL.md` (if references exist)

**Checklist**:

- [ ] Identify all files importing from app.config
- [ ] Replace `from app.config.config_api import config_api` with `from app.shared.config.interface import ConfigAPI; config_api = ConfigAPI()`
- [ ] Replace `from app.config.config_manager import config_manager` with interface usage
- [ ] Update direct config_manager.get() calls to config_api.get_config()
- [ ] Update direct config_manager.set() calls to config_api.update_config()
- [ ] Handle async methods properly
- [ ] Update all test files
- [ ] Verify no direct config_manager imports remain (except in config service itself)

### Phase 6: Move Services to Services Directory

**Goal**: Consolidate all services in app/services/**Tasks**:

1. Move each service folder to app/services/
2. Update all imports across codebase
3. Update supervisor service references

**Services to Move**:

- `app/db/` → `app/services/db/`
- `app/orchestrator/` → `app/services/orchestrator/`
- `app/scheduler/` → `app/services/scheduler/`
- `app/stt_audio_input/` → `app/services/stt_audio_input/`
- `app/stt_coordinator/` → `app/services/stt_coordinator/`
- `app/stt_transcription/` → `app/services/stt_transcription/`
- `app/stt_wakeword/` → `app/services/stt_wakeword/`
- `app/tts/` → `app/services/tts/`
- `app/tooling/` → `app/services/tooling/`

**Files to Update**:

- `app/services/supervisor.py` - Update service imports
- `main.py` - Update service imports
- All test files importing services
- All files importing from service directories

**Checklist**:

- [ ] Move `app/db/` to `app/services/db/`
- [ ] Move `app/orchestrator/` to `app/services/orchestrator/`
- [ ] Move `app/scheduler/` to `app/services/scheduler/`
- [ ] Move `app/stt_audio_input/` to `app/services/stt_audio_input/`
- [ ] Move `app/stt_coordinator/` to `app/services/stt_coordinator/`
- [ ] Move `app/stt_transcription/` to `app/services/stt_transcription/`
- [ ] Move `app/stt_wakeword/` to `app/services/stt_wakeword/`
- [ ] Move `app/tts/` to `app/services/tts/`
- [ ] Move `app/tooling/` to `app/services/tooling/`
- [ ] Update `app/services/supervisor.py` imports
- [ ] Update `main.py` imports
- [ ] Update all test imports
- [ ] Update all other file imports
- [ ] Verify no broken imports

### Phase 7: Update Service Imports and Model References

**Goal**: Update all service files to import from shared models**Tasks**:

1. Update each service file to import models from shared
2. Update service files to import from new service locations
3. Update all cross-service imports

**Services to Update**:

- `app/services/config/service.py`
- `app/services/db/service.py`
- `app/services/orchestrator/service.py`
- `app/services/scheduler/service.py`
- `app/services/stt_*/service.py` (all STT services)
- `app/services/tts/service.py`
- `app/services/tooling/service.py`

**Checklist**:

- [ ] Update config service imports
- [ ] Update db service imports
- [ ] Update orchestrator service imports
- [ ] Update scheduler service imports
- [ ] Update all STT service imports
- [ ] Update TTS service imports
- [ ] Update tooling service imports
- [ ] Update supervisor imports
- [ ] Verify all services can import their models
- [ ] Test service startup

### Phase 8: Update Messaging Topic Registrations

**Goal**: Ensure all topics are properly registered with new structure**Tasks**:

1. Update `app/messaging/service_topics.py` to import from shared models
2. Verify all topic definitions reference correct payload classes
3. Update event registry registrations

**Checklist**:

- [ ] Update service_topics.py imports
- [ ] Verify all payload_class references match shared model names
- [ ] Update event registry imports
- [ ] Test topic registration
- [ ] Verify no topic registration errors

### Phase 9: Standardize Bus Access with Singleton Pattern

**Goal**: Implement standardized bus access using singleton pattern for both threads and processes modes**Tasks**:

1. Update `app/shared/messaging/bus_init.py` with enhanced singleton pattern
2. Support threads mode (global singleton) and processes mode (per-service singleton)
3. Create service-aware bus initialization
4. Update all services to use singleton pattern instead of DI
5. Update supervisor to initialize bus singleton appropriately

**Files to Create**:

- `app/shared/messaging/service_bus.py` - Service-aware bus initialization utilities

**Singleton Pattern Implementation**:

- **Threads mode**:
- Global singleton shared across all services
- Supervisor initializes once via `set_bus()`
- Services access via `get_bus()` singleton
- **Processes mode**:
- Per-service singleton (each process has its own instance)
- Each service entry point initializes its own bus instance
- Service entry points call `initialize_bus_for_service(service_name)` to set up per-service singleton
- Bus instance is isolated per process

**Files to Update**:

- `app/shared/messaging/bus_init.py` - Enhanced singleton with mode detection
- `app/shared/services/base_service.py` - Use singleton for bus access
- All service files - Remove bus parameter from constructors, use singleton
- `app/services/supervisor.py` - Initialize singleton appropriately

**Checklist**:

- [ ] Enhance bus_init.py with mode-aware singleton
- [ ] Create service_bus.py for per-service initialization
- [ ] Update BaseService to use singleton pattern
- [ ] Remove bus parameter from all service constructors
- [ ] Update all services to use `get_bus()` singleton
- [ ] Update supervisor to initialize global singleton (threads mode)
- [ ] Create service entry points that initialize per-service singleton (processes mode)
- [ ] Test singleton pattern in threads mode
- [ ] Test singleton pattern in processes mode
- [ ] Verify no circular dependencies

### Phase 10: Implement Process Mode Support

**Goal**: Fully support process mode with per-service entry points and process launcher**Tasks**:

1. Create per-service entry points (`__main__.py` for each service)
2. Create process launcher script
3. Create Docker Compose configuration for process mode
4. Update supervisor to support process mode (optional launcher)
5. Implement service discovery and health checks
6. Create process mode startup scripts

**Files to Create**:

- `app/services/config/__main__.py` - Config service entry point
- `app/services/db/__main__.py` - DB service entry point
- `app/services/orchestrator/__main__.py` - Orchestrator service entry point
- `app/services/scheduler/__main__.py` - Scheduler service entry point
- `app/services/tts/__main__.py` - TTS service entry point
- `app/services/tooling/__main__.py` - Tooling service entry point
- `app/services/stt_audio_input/__main__.py` - Audio Input service entry point
- `app/services/stt_coordinator/__main__.py` - STT Coordinator service entry point
- `app/services/stt_transcription/__main__.py` - Transcription service entry point
- `app/services/stt_wakeword/__main__.py` - Wake Word service entry point
- `scripts/run_processes.py` - Process launcher script
- `docker-compose.processes.yml` - Docker Compose for process mode
- `app/shared/services/entry_point.py` - Common entry point utilities

**Service Entry Point Behavior**:

- Each entry point:
- Reads config/env for Redis URL and mode
- Determines service name from entry point location
- Initializes per-service bus singleton via `initialize_bus_for_service(service_name)`
- Registers service topics
- Starts the service
- Subscribes to config changes for reload
- Handles graceful shutdown

**Process Launcher**:

- Spawns subprocesses for each service
- Manages lifecycle (start, stop, restart)
- Handles logs and signals
- Configurable via CLI flags (which services to run)
- Supports both local development and production

**Checklist**:

- [ ] Create **main**.py for config service
- [ ] Create **main**.py for db service
- [ ] Create **main**.py for orchestrator service
- [ ] Create **main**.py for scheduler service
- [ ] Create **main**.py for tts service
- [ ] Create **main**.py for tooling service
- [ ] Create **main**.py for all STT services
- [ ] Create common entry point utilities
- [ ] Create process launcher script
- [ ] Create Docker Compose configuration
- [ ] Update supervisor to support process mode (optional)
- [ ] Implement service health checks
- [ ] Test each service entry point independently
- [ ] Test process launcher
- [ ] Test Docker Compose setup
- [ ] Verify config reload works in process mode
- [ ] Verify bus communication works across processes

### Phase 11: Update Services to Use Base Service Abstraction

**Goal**: Migrate all services to use BaseService and implement config reload**Tasks**:

1. Update all services to inherit from BaseService
2. Implement `reload()` method in each service
3. Subscribe to config changes in each service
4. Remove bus parameter from service constructors
5. Use singleton pattern for bus access
6. Ensure all services follow standard lifecycle

**Services to Update**:

- `app/services/config/service.py` - Config service
- `app/services/db/service.py` - DB service
- `app/services/orchestrator/service.py` - Orchestrator service
- `app/services/scheduler/service.py` - Scheduler service
- `app/services/tts/service.py` - TTS service
- `app/services/tooling/service.py` - Tooling service
- `app/services/stt_*/service.py` - All STT services

**Base Service Implementation**:

- Each service inherits from BaseService
- Constructor takes no bus parameter (uses singleton)
- Implements `async def reload()` method to handle config changes
- Subscribes to `Config.Changed` events for affected config sections
- Implements standard lifecycle methods

**Checklist**:

- [ ] Update config service to inherit from BaseService
- [ ] Update db service to inherit from BaseService
- [ ] Update orchestrator service to inherit from BaseService
- [ ] Update scheduler service to inherit from BaseService
- [ ] Update tts service to inherit from BaseService
- [ ] Update tooling service to inherit from BaseService
- [ ] Update all STT services to inherit from BaseService
- [ ] Implement reload() method in each service
- [ ] Subscribe to config changes in each service
- [ ] Remove bus parameter from all service constructors
- [ ] Update supervisor to not pass bus to services
- [ ] Test service lifecycle
- [ ] Test config reload in threads mode
- [ ] Test config reload in processes mode

### Phase 12: Cleanup and Final Verification

**Goal**: Remove old files and verify everything works**Tasks**:

1. Delete old `app/config/` directory (if empty)
2. Delete old `app/contracts/` directory (if exists)
3. Run full test suite
4. Verify all imports work
5. Verify config service works via bus
6. Verify all services can start
7. Verify bus singleton works in both modes
8. Verify config reload works in both modes
9. Verify process mode works end-to-end

**Files to Delete**:

- `app/config/` (entire directory)
- `app/contracts/` (if not already moved)

**Checklist**:

- [ ] Delete old app/config directory
- [ ] Delete old app/contracts directory
- [ ] Run all unit tests
- [ ] Run all integration tests
- [ ] Test threads mode end-to-end
- [ ] Test processes mode end-to-end
- [ ] Verify config service responds to bus requests
- [ ] Verify all services start correctly in threads mode
- [ ] Verify all services start correctly in processes mode
- [ ] Verify config API interface works
- [ ] Verify bus singleton works in threads mode
- [ ] Verify bus singleton works in processes mode
- [ ] Verify config reload works in threads mode
- [ ] Verify config reload works in processes mode
- [ ] Check for any remaining old imports
- [ ] Update documentation if needed

## Implementation Notes

### Config Service Topics

Create the following topics:

- `Config.GetConfig` - Query for getting config
- `Config.UpdateConfig` - Command for updating config
- `Config.ValidateConfig` - Query for validating config
- `Config.GetPluginStatus` - Query for plugin status
- `Config.UpdatePluginStatus` - Command for updating plugin status
- `Config.Changed` - Event emitted when config changes (includes affected sections)
- `Config.ReloadService` - Command to reload a specific service

### Config Service Messages

- `GetConfigQuery(section: str | None = None)`
- `GetConfigResponse(config: dict[str, Any])`
- `UpdateConfigCommand(key_path: str, value: Any)`
- `UpdateConfigResponse(success: bool, error: str | None = None)`
- `ValidateConfigQuery()`
- `ValidateConfigResponse(errors: list[str])`
- `GetPluginStatusQuery(plugin_name: str)`
- `GetPluginStatusResponse(active: bool)`
- `UpdatePluginStatusCommand(plugin_name: str, active: bool)`
- `ConfigChangedEvent(affected_sections: list[str], key_path: str, old_value: Any, new_value: Any)`
- `ReloadServiceCommand(service_name: str, reason: str | None = None)`

### Service Abstraction Design

- **BaseService** abstract class:
- Abstract methods: `async def start()`, `async def stop()`, `async def reload(config_section: str | None = None)`
- Bus access via `get_bus()` singleton
- Config observer registration via `_register_config_observer()`
- Automatic subscription to `Config.Changed` events
- Helper methods for common patterns
- **Bus Singleton Pattern**:
- Threads mode: Global singleton initialized by supervisor
- Processes mode: Per-service singleton initialized by service entry point
- Service-aware initialization via `initialize_bus_for_service(service_name)`
- Mode detection via environment variable or config

### Process Mode Architecture

- Each service runs in its own OS process
- Each service has its own bus instance (BullMQBus connected to Redis)
- Services communicate via Redis queues
- Config service publishes reload events, services subscribe and reload themselves
- Process launcher manages service lifecycle
- Docker Compose for containerized deployment

### Backward Compatibility

- The ConfigAPI interface in `app/shared/config/interface.py` must maintain exact same method signatures
- All existing code using `config_api` should work without changes
- The interface should handle both sync and async methods appropriately

### Import Strategy

- Use absolute imports: `from app.shared.messaging.models.db_models import StoreMessage`
- Update all relative imports to absolute
- Ensure no circular dependencies

### Decision: Service Abstraction vs Module Contract Registry

The **Service Abstraction** (BaseService) and **Module Contract Registry** serve different but complementary purposes:

- **Service Abstraction**: Provides lifecycle management, bus access, and config reload capability. This is infrastructure-level functionality that all services need.
- **Module Contract Registry**: Provides API contracts, versioning, and exposure policies. This is API-level functionality for defining and exposing service methods.

**Recommendation**: Keep them separate but ensure they work together:

1. Services inherit from BaseService for infrastructure
2. Services can optionally use Module Contract Registry for API contracts
3. BaseService can provide utilities to work with contract registry if needed

This separation allows:

- Services to use BaseService without requiring contract registry
- Contract registry to work with services that don't inherit from BaseService
- Clear separation of concerns (infrastructure vs API contracts)

## Testing Strategy

### Unit Tests

- Test config service handlers independently
- Test config interface methods
- Test model imports and validation
- Test bus singleton pattern in both modes
- Test BaseService functionality

### Integration Tests

- Test config service via bus
- Test config API interface via bus
- Test service startup with new structure
- Test cross-service communication
- Test config reload in threads mode
- Test config reload in processes mode
- Test process mode communication

### Migration Verification

- Verify all services can access config via interface
- Verify config changes propagate correctly
- Verify observers still work
- Verify MCP integration still works