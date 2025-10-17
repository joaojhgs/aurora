# Commit Plan for Modular Services Architecture Migration

This document outlines the proposed commits for the massive architectural refactoring on branch `feat/migration-to-modular-services-architecture`.

**Total Changes:**
- ~66 new Python files added
- ~40+ files deleted (old architecture)
- ~30 files modified
- 3 new documentation files

---

## Commit Strategy

The commits are organized to maintain a logical progression and make the changes reviewable. Each commit should be self-contained where possible, though the final integration happens in the main.py refactor.

---

## Proposed Commits (in order)

### 1. `feat(contracts): add service contracts and registry`
**Description:** Add contract interfaces and registry system for service discovery

**Files:**
```
A  app/contracts/__init__.py
A  app/contracts/registry.py
```

**Rationale:** Contracts are the foundation - establish interfaces first

---

### 2. `feat(messaging): add message bus architecture`
**Description:** Implement message bus with local and BullMQ backends, event registry, and message type definitions

**Files:**
```
A  app/messaging/__init__.py
A  app/messaging/bus.py
A  app/messaging/local_bus.py
A  app/messaging/bullmq_bus.py
A  app/messaging/bus_runtime.py
A  app/messaging/event_registry.py
A  app/messaging/service_topics.py
A  app/messaging/audio_messages.py
A  app/messaging/transcription_messages.py
A  app/messaging/README.md
A  tests/unit/app/messaging/
A  tests/integration/test_message_flow.py
```

**Rationale:** Message bus is the communication backbone - needed before services

---

### 3. `feat(services): add base service layer and supervisor`
**Description:** Add base service abstraction and service supervisor for lifecycle management

**Files:**
```
A  app/services/__init__.py
A  app/services/supervisor.py
```

**Rationale:** Service layer foundation before implementing specific services

---

### 4. `refactor(database)!: migrate to new database architecture`
**Description:** Remove old database implementation and add new modular database service with improved migration management

**Breaking Change:** Database module moved from `app/database` to `app/db`

**Files:**
```
D  app/database/__init__.py
D  app/database/database_manager.py
D  app/database/message_history_service.py
D  app/database/migration_manager.py
D  app/database/migrations/001_initial_schema.sql
D  app/database/migrations/002_scheduler_tables.sql
D  app/database/models.py
D  app/database/scheduler_service.py

A  app/db/__init__.py
A  app/db/manager.py
A  app/db/service.py
A  app/db/migration_manager.py
A  app/db/models.py
A  app/db/scheduler_db_service.py
A  app/db/migrations/001_initial_schema.sql
A  app/db/migrations/002_scheduler_tables.sql

M  tests/unit/app/database/test_database_manager.py
M  tests/unit/app/database/test_db_models.py
M  tests/integration/test_db_config_integration.py
M  tests/integration/test_db_integration_final.py
M  tests/integration/test_fix_db_config.py
M  tests/integration/test_integration_complete.py
M  tests/integration/test_scheduler_database_integration.py
```

**Rationale:** Database is a core dependency for other services

---

### 5. `refactor(stt)!: migrate to modular STT architecture`
**Description:** Split monolithic STT into modular components: audio input, coordinator, transcription, and wakeword detection services

**Breaking Change:** STT moved from `app/speech_to_text` to modular `app/stt_*` structure

**Files:**
```
D  app/speech_to_text/__init__.py
D  app/speech_to_text/audio_recorder.py
D  app/speech_to_text/stt.py

A  app/stt_audio_input/
A  app/stt_coordinator/
A  app/stt_transcription/
A  app/stt_wakeword/

D  tests/unit/app/speech_to_text/test_ambient_transcription.py
D  tests/integration/test_speech_basic.py
```

**Rationale:** STT modularization enables independent service testing and scaling

---

### 6. `refactor(tts)!: migrate to modular TTS architecture`
**Description:** Refactor TTS into service-based architecture with improved Piper engine integration

**Breaking Change:** TTS moved from `app/text_to_speech` to `app/tts` with new service pattern

**Files:**
```
D  app/text_to_speech/__init__.py
D  app/text_to_speech/piper_engine.py
D  app/text_to_speech/tts.py

A  app/tts/
```

**Rationale:** TTS service pattern aligns with new architecture

---

### 7. `feat(orchestrator): add orchestrator service`
**Description:** Add LangGraph-based orchestrator service for LLM workflow management, migrated from app/langgraph with service integration

**Files:**
```
D  app/langgraph/ChatLlamaCpp.py
D  app/langgraph/ChatLlamaCppFnHandler.py
D  app/langgraph/__init__.py
D  app/langgraph/agents/chatbot.py
D  app/langgraph/graph.py
D  app/langgraph/mcp_client.py
D  app/langgraph/mcp_discovery.py
D  app/langgraph/memory_store.py
D  app/langgraph/message_types.py
D  app/langgraph/state.py
D  app/langgraph/tools/__init__.py
D  app/langgraph/tools/brave_search.py
D  app/langgraph/tools/current_screen.py
D  app/langgraph/tools/duckduckgo_search.py
D  app/langgraph/tools/gcalendar_toolkit.py
D  app/langgraph/tools/github_toolkit.py
D  app/langgraph/tools/gmail_toolkit.py
D  app/langgraph/tools/jira_toolkit.py
D  app/langgraph/tools/openrecall_search.py
D  app/langgraph/tools/pomodoro_tool.py
D  app/langgraph/tools/resume_tts.py
D  app/langgraph/tools/scheduler_tool.py
D  app/langgraph/tools/slack_toolkit.py
D  app/langgraph/tools/stop_tts.py
D  app/langgraph/tools/tools.py
D  app/langgraph/tools/upsert_memory.py

A  app/orchestrator/
A  app/orchestrator/service.py
A  app/orchestrator/graph.py
A  app/orchestrator/state.py
A  app/orchestrator/memory_store.py
A  app/orchestrator/message_types.py
A  app/orchestrator/chat_llama_cpp.py
A  app/orchestrator/chat_llama_cpp_fn_handler.py
A  app/orchestrator/agents/chatbot.py

M  tests/unit/app/langgraph/test_mcp_client.py
```

**Rationale:** Orchestrator is the brain - needs tooling and services in place

---

### 8. `feat(tooling): add modular tooling architecture with MCP support`
**Description:** Add comprehensive tooling system with MCP integration, tool discovery, and individual tool implementations

**Files:**
```
A  app/tooling/
A  app/tooling/service.py
A  app/tooling/tools_manager.py
A  app/tooling/mcp/
A  app/tooling/mcp/mcp_client.py
A  app/tooling/mcp/mcp_discovery.py
A  app/tooling/tools/
A  app/tooling/tools/*.py  (all individual tools)
```

**Rationale:** Tools enable orchestrator capabilities

---

### 9. `feat(ui): add UI bridge service`
**Description:** Add UI bridge service for communication between Qt UI and backend services

**Files:**
```
A  app/ui/
A  app/ui/bridge_service.py
M  modules/ui  (submodule update)
```

**Rationale:** UI integration for user interaction

---

### 10. `refactor(scheduler): update scheduler for new architecture`
**Description:** Update scheduler to use new service pattern and database service

**Files:**
```
M  app/scheduler/__init__.py
M  app/scheduler/cron_service.py
M  app/scheduler/scheduler_manager.py
A  app/scheduler/service.py
M  tests/unit/app/scheduler/test_scheduler_manager.py
```

**Rationale:** Scheduler integrates with database and service layer

---

### 11. `refactor(config): update configuration schema for modular architecture`
**Description:** Extend configuration schema to support new services, messaging, and modular components

**Files:**
```
M  app/config/config_api.py
M  app/config/config_defaults.json
M  app/config/config_schema.json
M  tests/unit/app/config/test_field_metadata.py
```

**Rationale:** Configuration updates support all new services

---

### 12. `refactor(logger): enhance logger for service architecture`
**Description:** Update Aurora logger with service-aware logging capabilities

**Files:**
```
M  app/helpers/aurora_logger.py
```

**Rationale:** Improved logging for distributed services

---

### 13. `refactor(main)!: migrate to service-based architecture`
**Description:** Complete refactor of main.py to use service supervisor, message bus, and modular service initialization

**Breaking Change:** Application initialization completely restructured

**Files:**
```
M  main.py
```

**Rationale:** Main integration point for entire architecture

---

### 14. `test: update tests for modular architecture`
**Description:** Update and remove obsolete tests, add new integration tests

**Files:**
```
M  tests/conftest.py
M  tests/fixtures/test_data.py

D  tests/e2e/test_configuration_flow.py
D  tests/e2e/test_configuration_flow_simple.py
D  tests/e2e/test_conversation_flow.py
D  tests/e2e/test_voice_interaction_flow.py
D  tests/e2e/test_voice_interaction_flow_simple.py

M  tests/e2e/test_mcp_e2e.py
M  tests/integration/test_mcp_integration.py

M  tests/performance/test_performance.py
M  tests/performance/test_performance_metrics.py
M  tests/performance/test_performance_simple.py
```

**Rationale:** Tests validate new architecture

---

### 15. `docs: add architectural documentation`
**Description:** Add comprehensive documentation for messaging architecture, UI integration, and testing plan

**Files:**
```
A  TESTING_PLAN.md
A  docs/MESSAGING_ARCHITECTURE.md
A  docs/UI_INTEGRATION.md
D  docs/ambient_transcription.md
A  docs/AMBIENT_TRANSCRIPTION.md
M  assets/graph.png
```

**Rationale:** Documentation for new architecture

---

### 16. `chore: update dependencies and gitignore`
**Description:** Update runtime dependencies and gitignore for new architecture

**Files:**
```
M  requirements-runtime.txt
M  .gitignore
M  tests/test_scheduler.db
```

**Rationale:** Dependency and tooling updates

---

## Execution Commands

Once you've reviewed this plan, you can execute the commits with:

```bash
# 1. Contracts
git add app/contracts/
git commit -m "feat(contracts): add service contracts and registry"

# 2. Messaging
git add app/messaging/ tests/unit/app/messaging/ tests/integration/test_message_flow.py
git commit -m "feat(messaging): add message bus architecture"

# 3. Services
git add app/services/
git commit -m "feat(services): add base service layer and supervisor"

# 4. Database refactor
git rm -r app/database/
git add app/db/
git add tests/unit/app/database/ tests/integration/test_db*.py tests/integration/test_integration_complete.py tests/integration/test_scheduler_database_integration.py
git commit -m "refactor(database)!: migrate to new database architecture

BREAKING CHANGE: Database module moved from app/database to app/db with improved service pattern"

# 5. STT refactor
git rm -r app/speech_to_text/
git add app/stt_audio_input/ app/stt_coordinator/ app/stt_transcription/ app/stt_wakeword/
git rm tests/unit/app/speech_to_text/test_ambient_transcription.py
git rm tests/integration/test_speech_basic.py
git commit -m "refactor(stt)!: migrate to modular STT architecture

BREAKING CHANGE: STT split into modular components: audio_input, coordinator, transcription, and wakeword"

# 6. TTS refactor
git rm -r app/text_to_speech/
git add app/tts/
git commit -m "refactor(tts)!: migrate to modular TTS architecture

BREAKING CHANGE: TTS moved from app/text_to_speech to app/tts with new service pattern"

# 7. Orchestrator
git rm -r app/langgraph/
git add app/orchestrator/
git add tests/unit/app/langgraph/test_mcp_client.py
git commit -m "feat(orchestrator): add orchestrator service

Migrate LangGraph-based orchestration to service architecture with improved modularity"

# 8. Tooling
git add app/tooling/
git commit -m "feat(tooling): add modular tooling architecture with MCP support"

# 9. UI
git add app/ui/
git add modules/ui
git commit -m "feat(ui): add UI bridge service"

# 10. Scheduler
git add app/scheduler/
git add tests/unit/app/scheduler/test_scheduler_manager.py
git commit -m "refactor(scheduler): update scheduler for new architecture"

# 11. Config
git add app/config/
git add tests/unit/app/config/test_field_metadata.py
git commit -m "refactor(config): update configuration schema for modular architecture"

# 12. Logger
git add app/helpers/aurora_logger.py
git commit -m "refactor(logger): enhance logger for service architecture"

# 13. Main
git add main.py
git commit -m "refactor(main)!: migrate to service-based architecture

BREAKING CHANGE: Application initialization completely restructured for service supervisor pattern"

# 14. Tests
git add tests/conftest.py tests/fixtures/test_data.py
git rm tests/e2e/test_configuration_flow*.py tests/e2e/test_conversation_flow.py tests/e2e/test_voice_interaction_flow*.py
git add tests/e2e/test_mcp_e2e.py tests/integration/test_mcp_integration.py
git add tests/performance/
git commit -m "test: update tests for modular architecture"

# 15. Docs
git add TESTING_PLAN.md docs/MESSAGING_ARCHITECTURE.md docs/UI_INTEGRATION.md docs/AMBIENT_TRANSCRIPTION.md assets/graph.png
git rm docs/ambient_transcription.md
git commit -m "docs: add architectural documentation

Add comprehensive documentation for messaging architecture, UI integration, testing plan, and ambient transcription"

# 16. Chore
git add requirements-runtime.txt .gitignore tests/test_scheduler.db
git commit -m "chore: update dependencies and gitignore"
```

---

## Review Checklist

Before executing commits, verify:
- [ ] All breaking changes are marked with `!` and have BREAKING CHANGE footer
- [ ] Commit messages follow conventional commits format
- [ ] Logical progression (foundations → services → integration)
- [ ] Each commit is focused and atomic where possible
- [ ] Tests are grouped with their related functionality
- [ ] Documentation is committed separately
- [ ] No files are accidentally omitted

---

## Notes

- **Total: 16 commits** - Balances granularity with reviewability
- **Breaking changes**: Commits 4, 5, 6, and 13 contain breaking changes
- **Dependencies**: Later commits depend on earlier ones (especially messaging and services)
- **Test isolation**: Most test updates are grouped with related functionality
- **Documentation**: Separate commit for easier review

This structure makes the migration reviewable while maintaining logical cohesion.
