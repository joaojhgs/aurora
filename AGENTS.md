# Aurora AI Agent Development Guide

**ALWAYS FOLLOW THESE INSTRUCTIONS FIRST**. This is the top-level guide for AI coding agents. Detailed subsystem guidance lives in focused sub-files -- see the routing table below.

---

## Sub-Agent Guides

Detailed guidance lives next to the code it describes. **Always read the relevant sub-guide before working on a subsystem.**

| Working On | Read This |
|------------|-----------|
| Any service (lifecycle, startup, adding services/tools) | [`app/services/AGENTS.md`](app/services/AGENTS.md) |
| Gateway (HTTP API, WebRTC, mesh, ACL, RPC) | [`app/services/gateway/AGENTS.md`](app/services/gateway/AGENTS.md) |
| Auth (pairing, tokens, principals, mesh peers) | [`app/services/auth/AGENTS.md`](app/services/auth/AGENTS.md) |
| Message bus (topics, events, commands, priorities) | [`app/messaging/AGENTS.md`](app/messaging/AGENTS.md) |
| Shared code (what belongs, imports, models) | [`app/shared/AGENTS.md`](app/shared/AGENTS.md) |
| Contracts (topic constants, IO models, registry) | [`app/shared/contracts/AGENTS.md`](app/shared/contracts/AGENTS.md) |
| **Configuration (ConfigAPI vs ConfigManager, process mode)** | [`docs/CONFIG_SERVICE_PATTERN.md`](docs/CONFIG_SERVICE_PATTERN.md) |
| Tests (structure, markers, mocking patterns) | [`tests/AGENTS.md`](tests/AGENTS.md) |

---

## Project Overview

Aurora is a **privacy-first, modular voice assistant** for local automation and productivity. It uses real-time speech-to-text, LLMs, and various productivity tools in a microservices architecture.

### Key Characteristics

- **Language**: Python 3.10-3.11 (3.12+ causes dependency conflicts)
- **Architecture**: Microservices with message bus communication
- **Privacy**: Local-first processing, optional cloud integrations
- **Modularity**: Plugin-based system with optional dependencies
- **Deployment**: Supports both thread mode (development) and process mode (production)

### Technology Stack

- **Audio**: PyAudio, RealtimeSTT, faster-whisper, OpenWakeWord
- **TTS**: Piper TTS, RealtimeTTS
- **LLM**: LangChain, LangGraph, OpenAI, HuggingFace, llama.cpp
- **Database**: SQLite with sqlite-vec for vector storage
- **UI**: PyQt6 (optional)
- **Messaging**: LocalBus (threads) or BullMQBus (processes with Redis)
- **MCP**: Model Context Protocol for external tool integration

---

## Architecture

### Architecture Modes

#### Threads Mode (Default)
- All services in one process, communication via `LocalBus` (asyncio queues)
- **Use case**: Development, testing, single-machine deployments

#### Processes Mode (Production)
- Each service in separate OS process, communication via `BullMQBus` (Redis)
- **Use case**: Production, distributed deployments, Docker
- **Requirements**: Redis server

```bash
export AURORA_ARCHITECTURE_MODE=processes  # or "threads"
export REDIS_URL=redis://localhost:6379
```

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Supervisor                             │
│  - Service lifecycle management                            │
│  - Architecture mode selection (threads/processes)          │
│  - Graceful startup/shutdown coordination                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Message Bus Layer                        │
│  - LocalBus (threads mode): asyncio queues                  │
│  - BullMQBus (processes mode): Redis queues                 │
│  - Priority-based routing (Interactive > System > External) │
│  - Concurrent message delivery to all subscribers           │
└─────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ ConfigService│   │  DBService   │   │ToolingService│
│              │   │              │   │              │
│ - Config API │   │ - SQLite     │   │ - Core tools │
│ - Reload     │   │ - Vector DB  │   │ - Plugins    │
│   events     │   │ - RAG store  │   │ - MCP tools  │
└──────────────┘   └──────────────┘   └──────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│SchedulerSvc  │   │  TTSService  │   │ STT Services │
│              │   │              │   │              │
│ - Cron jobs  │   │ - Piper TTS  │   │ - Coordinator│
│ - Scheduled  │   │ - Audio out  │   │ - Wakeword   │
│   tasks      │   │ - Playback   │   │ - Transcribe │
└──────────────┘   └──────────────┘   └──────────────┘
                            │
                            ▼
                   ┌──────────────┐
                   │ Orchestrator │
                   │   Service    │
                   │              │
                   │ - LangGraph  │
                   │ - LLM coord  │
                   │ - Tool calls │
                   └──────────────┘
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
       ┌──────────────┐       ┌──────────────┐
       │  UI Bridge   │       │   Gateway    │
       │  (Optional)  │       │   Service    │
       │              │       │              │
       │ - PyQt6 UI   │       │ - FastAPI    │
       │ - Qt signals │       │ - WebRTC     │
       └──────────────┘       │ - Mesh P2P   │
                              └──────────────┘
```

### Core Concepts

1. **Services**: All functionality organized into services inheriting `BaseService`
2. **Message Bus**: The ONLY communication mechanism between services (see [`app/messaging/AGENTS.md`](app/messaging/AGENTS.md))
3. **Contracts**: Typed method definitions with IO models (see [`app/shared/contracts/AGENTS.md`](app/shared/contracts/AGENTS.md))
4. **Configuration**: Centralized via ConfigService, hot-reloadable
5. **Plugins**: Optional integrations loaded conditionally via config

---

## Development Workflows

### Environment Setup

**CRITICAL**: Use `uv` for environment management. Do NOT use Conda.

```bash
uv sync                         # Install dependencies
source .venv/bin/activate        # Activate environment
```

**Python Version**: 3.10-3.11 only (managed by `uv` in `.python-version`)

### Running Aurora

```bash
python main.py                   # CLI mode (threads, default)
python main.py                   # UI mode (set ui.activate=true in config.json)
make docker-process-mode         # Docker process mode
```

### Code Quality

**Before committing, ALWAYS run**:
```bash
make format  # Auto-format code (ruff)
make lint    # Check code style
make check   # Run all quality checks
make unit    # Run unit tests
```

### Testing

```bash
make test              # All tests except performance
make unit              # Unit tests only
make integration       # Integration tests
make coverage          # Coverage report
```

See [`tests/AGENTS.md`](tests/AGENTS.md) for test patterns and markers.

---

## Directory Structure

```
aurora/
├── app/
│   ├── helpers/                 # Utility functions (aurora_logger.py)
│   ├── messaging/               # Bus implementations (AGENTS.md inside)
│   ├── services/                # Service implementations (AGENTS.md inside)
│   │   ├── config/              │   ├── gateway/ (AGENTS.md inside)
│   │   ├── db/                  │   ├── auth/ (AGENTS.md inside)
│   │   ├── orchestrator/        │   ├── scheduler/
│   │   ├── tooling/             │   ├── tts/
│   │   ├── stt_coordinator/     │   ├── stt_transcription/
│   │   ├── stt_wakeword/        │   └── supervisor.py
│   ├── shared/                  # Shared code (AGENTS.md inside)
│   │   ├── auth/                │   ├── config/
│   │   ├── contracts/ (AGENTS.md inside)
│   │   ├── messaging/           │   ├── models/
│   │   └── services/
│   └── ui/                      # UIBridge
├── tests/ (AGENTS.md inside)
├── modules/                     # Optional modules (UI, OpenRecall)
├── docker/                      # Docker configs
├── docs/                        # Documentation
├── main.py                      # Entry point
├── config.json                  # Local only (gitignored): created from config_defaults.json if missing
└── pyproject.toml               # Package config
```

---

## Configuration

**Source of truth**: `app/services/config/config_schema.json` (JSON Schema).
Run `make generate-config` after editing the schema to regenerate:
- `app/shared/config/models.py` — Pydantic models (via `datamodel-code-generator`)
- `app/shared/config/keys.py` — nested `ConfigKeys` path object (every dot-path)
- `app/services/config/config_defaults.json` — default values

**Primary**: `config.json` (structured settings, **not committed** — first run copies `config_defaults.json`)
**Secondary**: `.env` (sensitive credentials, gitignored)

```python
from app.shared.config.interface import config_api
from app.shared.config.keys import ConfigKeys
from app.shared.config.models import Tts as TtsConfig

# Typed section access (returns Pydantic model)
tts_cfg = await config_api.aget(ConfigKeys.services.tts, TtsConfig)
model_path = tts_cfg.model_file_path

# Scalar/leaf access (returns plain value)
provider = await config_api.aget(
    ConfigKeys.services.orchestrator.llm.provider,
    default="openai",
)
config_api.set("ui.dark_mode", True)
```

**Resolution**: values set in `config.json` win; otherwise mapped `.env` vars apply; see `ENV_CONFIG_MAP` in `app/services/config/env_config.py`. Example env vars:
```bash
AURORA_ARCHITECTURE_MODE=processes
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=sk-...
```

---

## Deployment

### Thread Mode (Development)
```bash
python main.py  # Default, no external deps
```

### Process Mode (Production)
```bash
docker run -d -p 6379:6379 redis:7-alpine
export AURORA_ARCHITECTURE_MODE=processes
export REDIS_URL=redis://localhost:6379
python main.py
```

### Docker
```bash
make docker-process-mode     # Build and start
make docker-process-up       # Start services
make docker-process-down     # Stop services
make docker-process-logs     # View logs
```

**Process-mode Compose** (`docker-compose.process.yml`) runs **separate containers** per service. There is **no supervisor image**: **Auth** (`Dockerfile.auth`, `python -m app.services.auth`) and **Gateway** (`Dockerfile.gateway`, `python -m app.services.gateway`) are first-class services alongside DB, Orchestrator, etc.

### Tilt (Compose + dev UX)

- **Doc**: [`docs/TILT.md`](docs/TILT.md) — `tilt up`, merge `docker-compose.tilt.yml` (per-service log levels + `working_dir` `/app/host` + `watchmedo` on `app/`/`modules/` under that mount), log-level UI buttons, optional ngrok.
- **MCP**: Use **`.cursor/mcp.json`** — **`tilt-mcp`** via **`uvx --from tilt-mcp==0.1.3`** (requires **`tilt`** on PATH and usually **`tilt up`**). For stack health without Tilt, use **`docker compose`** / **`curl`** (e.g. `http://127.0.0.1:${GATEWAY_HOST_PORT:-8000}/api/health`) or **`./scripts/compose-docker.sh`** if the Compose plugin is missing.

---

## Critical Rules

These rules apply to ALL code in the project. Violations cause real bugs.

### 1. **ALWAYS Use Message Bus for Communication**

**NEVER** call service methods directly. **ALWAYS** use the message bus.

```python
# ❌ BAD
from app.services.tts import TTSService
tts = TTSService()
tts.play("Hello")

# ✅ GOOD
from app.messaging.bus_runtime import get_bus
bus = get_bus()
await bus.publish(TTSMethods.REQUEST, TTSRequest(text="Hello"), event=False, priority=10)
```

### 2. **ALWAYS Use Typed Topic Constants**

**NEVER** use literal string topics. **ALWAYS** use constants from `app/shared/contracts/models/`. See [`app/messaging/AGENTS.md`](app/messaging/AGENTS.md) and [`app/shared/contracts/AGENTS.md`](app/shared/contracts/AGENTS.md).

```python
# ❌ BAD -- typos go undetected, grep misses usages
await bus.publish("Auth.AuditEvent", payload)

# ✅ GOOD -- typed, autocomplete-friendly, refactor-safe
from app.shared.contracts.models.auth import AuthMethods
await bus.request(AuthMethods.STORE_AUDIT_EVENT, payload)
```

### 3. **ALWAYS Use `uv` Environment**

```bash
source .venv/bin/activate    # Or: uv run <command>
```

### 4. **ALWAYS Use Python 3.10-3.11**

Python 3.12+ causes dependency conflicts.

### 5. **NEVER Block the Event Loop**

All service methods must be `async`. Use `asyncio.to_thread()` for blocking operations.

```python
# ❌ BAD
time.sleep(5)

# ✅ GOOD
await asyncio.sleep(5)

# ✅ GOOD (CPU-bound)
result = await asyncio.to_thread(cpu_intensive_function)
```

### 6. **ALWAYS Handle Concurrent Message Delivery**

Messages are delivered concurrently. Use locks for shared state.

```python
async with self._state_lock:
    self.state = "processing"
```

### 7. **ALWAYS Use Pydantic Models for Messages**

```python
# ❌ BAD
await bus.publish(TTSMethods.REQUEST, {"text": "Hello"})

# ✅ GOOD
await bus.publish(TTSMethods.REQUEST, TTSRequest(text="Hello"))
```

### 8. **ALWAYS Register Method Contracts**

```python
@method_contract(
    method_id=MyServiceMethods.DO_SOMETHING,
    summary="Do something",
    input_model=MyRequest,
    output_model=MyResponse,
    exposure="internal"
)
async def do_something(self, data: MyRequest) -> MyResponse:
    ...
```

### 9. **ALWAYS Clean Up Resources**

```python
async def on_stop(self):
    if self._db_connection:
        await self._db_connection.close()
    for task in self._background_tasks:
        task.cancel()
```

### 10. **ALWAYS Use Absolute Imports**

```python
# ✅ GOOD
from app.services.tts import TTSService

# ❌ BAD
from ..services.tts import TTSService
```

### 11. **ALWAYS Test Before Committing**

```bash
make format && make lint && make unit
```

### 12. **NEVER Commit Sensitive Data**

API keys go in `.env` (gitignored). Use `config.json` for structure only.

### 13. **ALWAYS Use Structured Logging**

```python
from app.helpers.aurora_logger import log_info, log_error, log_debug
```

Never use `logging.getLogger()`.

### 14. **ALWAYS Handle Config Reload**

```python
async def reload(self, config_section: str | None = None):
    if config_section == "my_section" or config_section is None:
        self._setting = config_api.get("my_section.setting")
```

### 15. **ALWAYS Use Priority Helpers**

```python
from app.messaging.priority_helpers import get_interactive_priority, get_system_priority
await bus.publish(topic, message, priority=get_interactive_priority())
```

### 16. **ALWAYS Document Public APIs**

```python
async def my_method(self, param: str) -> str:
    """Brief description.

    Args:
        param: Parameter description

    Returns:
        Return value description
    """
```

---

## Additional Resources

### Documentation

- **Architecture**: `docs/ARCHITECTURE.md`
- **Messaging**: `docs/MESSAGING_ARCHITECTURE.md`
- **Peer Pairing & Mesh**: `docs/PEER_PAIRING_FLOW.md`
- **Gateway API**: `docs/GATEWAY.md`
- **Process Mode**: `README.process-mode.md`
- **Tilt (Compose dev)**: `docs/TILT.md`
- **Testing**: `docs/TESTING_PROCESS_MODE.md`
- **UI Integration**: `docs/UI_INTEGRATION.md`
- **MCP Integration**: `docs/MCP_INTEGRATION.md`
- **Tech Stack**: `docs/TECHSTACK.md`
- **Installation**: `docs/INSTALL.md`

### Key Files

- **Main Entry**: `main.py`
- **Supervisor**: `app/services/supervisor.py`
- **Base Service**: `app/shared/services/base_service.py`
- **Contract Registry**: `app/shared/contracts/registry.py`
- **LocalBus**: `app/messaging/local_bus.py`
- **BullMQBus**: `app/messaging/bullmq_bus.py`
- **MeshBus**: `app/messaging/mesh_bus.py`
- **Config API**: `app/shared/config/interface.py`

### Development Commands

```bash
./setup.sh                       # Guided setup
pip install -e .[dev-local-cpu]  # Manual install (CPU)
pip install -e .[dev-local-gpu]  # Manual install (GPU)
make format                      # Auto-format
make lint                        # Lint
make check                       # All checks
make test                        # All tests
make unit                        # Unit tests
make integration                 # Integration tests
make coverage                    # Coverage report
make clean                       # Remove temp files
```

---

**Last Updated**: February 2026
**Version**: 1.0.0
**Maintainers**: Aurora Team

<!-- gitnexus:start -->
# GitNexus MCP

This project is indexed by GitNexus as **aurora** (3585 symbols, 11757 relationships, 293 execution flows).

GitNexus provides a knowledge graph over this codebase — call chains, blast radius, execution flows, and semantic search.

## Always Start Here

For any task involving code understanding, debugging, impact analysis, or refactoring, you must:

1. **Read `gitnexus://repo/{name}/context`** — codebase overview + check index freshness
2. **Match your task to a skill below** and **read that skill file**
3. **Follow the skill's workflow and checklist**

> If step 1 warns the index is stale, run `npx gitnexus analyze` in the terminal first.

## Skills

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/refactoring/SKILL.md` |

## Tools Reference

| Tool | What it gives you |
|------|-------------------|
| `query` | Process-grouped code intelligence — execution flows related to a concept |
| `context` | 360-degree symbol view — categorized refs, processes it participates in |
| `impact` | Symbol blast radius — what breaks at depth 1/2/3 with confidence |
| `detect_changes` | Git-diff impact — what do your current changes affect |
| `rename` | Multi-file coordinated rename with confidence-tagged edits |
| `cypher` | Raw graph queries (read `gitnexus://repo/{name}/schema` first) |
| `list_repos` | Discover indexed repos |

## Resources Reference

Lightweight reads (~100-500 tokens) for navigation:

| Resource | Content |
|----------|---------|
| `gitnexus://repo/{name}/context` | Stats, staleness check |
| `gitnexus://repo/{name}/clusters` | All functional areas with cohesion scores |
| `gitnexus://repo/{name}/cluster/{clusterName}` | Area members |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{processName}` | Step-by-step trace |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher |

## Graph Schema

**Nodes:** File, Function, Class, Interface, Method, Community, Process
**Edges (via CodeRelation.type):** CALLS, IMPORTS, EXTENDS, IMPLEMENTS, DEFINES, MEMBER_OF, STEP_IN_PROCESS

```cypher
MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(f:Function {name: "myFunc"})
RETURN caller.name, caller.filePath
```

<!-- gitnexus:end -->
