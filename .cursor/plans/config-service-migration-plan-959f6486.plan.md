<!-- 959f6486-898e-4dec-a83f-b44f20249dac eb6845e0-6ad8-4d5f-b0c0-f0948150a459 -->
# Config Service Migration and Codebase Reorganization Plan

## Overview

This plan details the migration of the config and config_api into a dedicated config service, while maintaining the existing interface used across the codebase. The plan also includes creating a shared folder structure, reorganizing payload validation models, and moving services into a services directory.

## Architecture Changes

### Current Structure

```
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

```
app/
├── shared/              # NEW: Shared interfaces and utilities
│   ├── config/          # Default config interface for all services
│   ├── messaging/       # Bus initialization interfaces
│   │   └── models/      # NEW: Payload validation models per service
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

### Phase 1: Create Shared Folder Structure

**Goal**: Establish the shared folder structure with default interfaces

**Tasks**:

1. Create `app/shared/` directory
2. Create `app/shared/config/` with default config interface
3. Create `app/shared/messaging/` with bus initialization interfaces
4. Create `app/shared/messaging/models/` directory for payload models
5. Move `app/contracts/` to `app/shared/contracts/`
6. Create `__init__.py` files for all new directories

**Files to Create**:

- `app/shared/__init__.py`
- `app/shared/config/__init__.py`
- `app/shared/config/interface.py` - Default config interface
- `app/shared/messaging/__init__.py`
- `app/shared/messaging/bus_init.py` - Bus initialization utilities
- `app/shared/messaging/models/__init__.py`
- `app/shared/contracts/__init__.py` (moved from `app/contracts/__init__.py`)

**Files to Move**:

- `app/contracts/registry.py` → `app/shared/contracts/registry.py`

**Checklist**:

- [ ] Create `app/shared/` directory structure
- [ ] Create default config interface in `app/shared/config/interface.py`
- [ ] Create bus initialization utilities in `app/shared/messaging/bus_init.py`
- [ ] Move contracts folder to shared
- [ ] Create all `__init__.py` files
- [ ] Update imports in `app/contracts/registry.py` (if any internal references)

### Phase 2: Create Config Service

**Goal**: Extract config functionality into a dedicated service

**Tasks**:

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

### Phase 3: Create Config Interface in Shared

**Goal**: Create a config API interface that uses the bus under the hood

**Tasks**:

1. Create `app/shared/config/interface.py` with ConfigAPI class
2. Implement all existing ConfigAPI methods using bus requests
3. Maintain exact same interface as current `app/config/config_api.py`
4. Use bus.request() for queries and bus.publish() for commands
5. Handle async methods properly

**Files to Create**:

- `app/shared/config/interface.py` - ConfigAPI implementation using bus

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

**Checklist**:

- [ ] Create ConfigAPI class in `app/shared/config/interface.py`
- [ ] Implement all synchronous methods using bus.request()
- [ ] Implement all async methods using bus.request() or bus.publish()
- [ ] Maintain exact same method signatures
- [ ] Handle errors and edge cases
- [ ] Test interface with existing codebase

### Phase 4: Move Payload Models to Shared/Messaging/Models

**Goal**: Centralize all payload validation models

**Tasks**:

1. Create service-specific model files in `app/shared/messaging/models/`
2. Move models from service files to shared models
3. Update imports across codebase

**Models to Move**:

**From `app/db/service.py`**:

- StoreMessage, GetRecentMessages, GetMessagesForDate, MessagesResponse
- StoreCronJob, GetCronJobs, DeleteCronJob
- RAGStoreCommand, RAGDeleteCommand, RAGSearchQuery, RAGGetQuery, RAGListQuery, RAGItemResponse

→ Move to: `app/shared/messaging/models/db_models.py`

**From `app/tts/service.py`**:

- TTSRequest, TTSStop, TTSPause, TTSResume
- TTSEvent, TTSStarted, TTSStopped, TTSPaused, TTSResumed, TTSError

→ Move to: `app/shared/messaging/models/tts_models.py`

**From `app/tooling/service.py`**:

- ToolsInitialized, ToolsReloaded, GetToolsQuery, GetToolsResponse
- GetToolByNameQuery, ReloadMCPToolsCommand, GetToolStatsQuery
- GetMCPStatusQuery, GetMCPStatusResponse, ExecuteToolCommand, ExecuteToolResponse

→ Move to: `app/shared/messaging/models/tooling_models.py`

**From `app/orchestrator/service.py`**:

- UserInput, LLMResponseReady, ToolRequest, ToolResult

→ Move to: `app/shared/messaging/models/orchestrator_models.py`

**From `app/orchestrator/message_types.py`**:

- MessageSource, AuroraMessage (if still used)

→ Move to: `app/shared/messaging/models/orchestrator_models.py`

**From `app/stt_wakeword/messages.py`**:

- WakeWordBackendType, WakeWordDetected, WakeWordTimeout, WakeWordControl

→ Move to: `app/shared/messaging/models/stt_wakeword_models.py`

**From `app/stt_coordinator/service.py`**:

- STTState, STTSessionStarted, STTSessionEnded, STTUserSpeechCaptured, STTCoordinatorControl

→ Move to: `app/shared/messaging/models/stt_coordinator_models.py`

**From `app/scheduler/models.py`**:

- ScheduleType, JobStatus, CronJob (if used for messaging)

→ Keep in scheduler for now, create `app/shared/messaging/models/scheduler_models.py` for message models only

**From `app/messaging/audio_messages.py`**:

- AudioEncoding, AudioFormat, AudioChunk, AudioStreamState, AudioStreamControl
- AudioStreamStarted, AudioStreamStopped, AudioTopics

→ Keep in `app/messaging/audio_messages.py` (generic protocol)

**From `app/messaging/transcription_messages.py`**:

- TranscriptionType, TranscriptionResult, TranscriptionControl, TranscriptionError

→ Keep in `app/messaging/transcription_messages.py` (generic protocol)

**Files to Create**:

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

**Goal**: Replace all config imports with shared interface

**Tasks**:

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

**Goal**: Consolidate all services in app/services/

**Tasks**:

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

**Goal**: Update all service files to import from shared models

**Tasks**:

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

**Goal**: Ensure all topics are properly registered with new structure

**Tasks**:

1. Update `app/messaging/service_topics.py` to import from shared models
2. Verify all topic definitions reference correct payload classes
3. Update event registry registrations

**Checklist**:

- [ ] Update service_topics.py imports
- [ ] Verify all payload_class references match shared model names
- [ ] Update event registry imports
- [ ] Test topic registration
- [ ] Verify no topic registration errors

### Phase 9: Cleanup and Final Verification

**Goal**: Remove old files and verify everything works

**Tasks**:

1. Delete old `app/config/` directory (if empty)
2. Delete old `app/contracts/` directory (if exists)
3. Run full test suite
4. Verify all imports work
5. Verify config service works via bus
6. Verify all services can start

**Files to Delete**:

- `app/config/` (entire directory)
- `app/contracts/` (if not already moved)

**Checklist**:

- [ ] Delete old app/config directory
- [ ] Delete old app/contracts directory
- [ ] Run all unit tests
- [ ] Run all integration tests
- [ ] Verify config service responds to bus requests
- [ ] Verify all services start correctly
- [ ] Verify config API interface works
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

### Backward Compatibility

- The ConfigAPI interface in `app/shared/config/interface.py` must maintain exact same method signatures
- All existing code using `config_api` should work without changes
- The interface should handle both sync and async methods appropriately

### Import Strategy

- Use absolute imports: `from app.shared.messaging.models.db_models import StoreMessage`
- Update all relative imports to absolute
- Ensure no circular dependencies

## Testing Strategy

### Unit Tests

- Test config service handlers independently
- Test config interface methods
- Test model imports and validation

### Integration Tests

- Test config service via bus
- Test config API interface via bus
- Test service startup with new structure
- Test cross-service communication

### Migration Verification

- Verify all services can access config via interface
- Verify config changes propagate correctly
- Verify observers still work
- Verify MCP integration still works

### To-dos

- [ ] Create app/shared/ directory structure with config, messaging, and contracts folders
- [ ] Create default config interface in app/shared/config/interface.py
- [ ] Create bus initialization utilities in app/shared/messaging/bus_init.py
- [ ] Move app/contracts/ to app/shared/contracts/
- [ ] Create app/services/config/ directory and move config_manager.py and JSON files
- [ ] Create config service message models (GetConfigQuery, UpdateConfigCommand, etc.)
- [ ] Create ConfigTopics class and register in service_topics.py
- [ ] Implement config service with bus handlers for all config operations
- [ ] Create ConfigAPI class in app/shared/config/interface.py using bus under the hood
- [ ] Create all model files in app/shared/messaging/models/ for each service
- [ ] Move all payload validation models from service files to shared/messaging/models/
- [ ] Update all service file imports to use shared models
- [ ] Replace all app.config imports with app.shared.config.interface across codebase
- [ ] Move all service folders to app/services/ directory
- [ ] Update all imports referencing moved services
- [ ] Update all service files to import models from shared and services from new locations
- [ ] Update service_topics.py to import from shared models and verify registrations
- [ ] Delete old directories (app/config/, app/contracts/) and run full test suite