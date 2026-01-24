# Aurora AI Agent Development Guide

**ALWAYS FOLLOW THESE INSTRUCTIONS FIRST**. This document provides comprehensive guidance for AI coding agents working with the Aurora voice assistant codebase. It covers architecture, design patterns, development workflows, and critical implementation details.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Core Concepts](#core-concepts)
4. [Service Structure](#service-structure)
5. [Message Bus Architecture](#message-bus-architecture)
6. [Development Workflows](#development-workflows)
7. [Code Organization](#code-organization)
8. [Testing](#testing)
9. [Configuration Management](#configuration-management)
10. [Deployment Modes](#deployment-modes)
11. [Critical Rules](#critical-rules)

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

Aurora supports two distinct architecture modes:

#### 1. **Threads Mode** (Default)
- All services run in the same process
- Communication via `LocalBus` (in-memory asyncio queues)
- **Use case**: Development, testing, single-machine deployments
- **Benefits**: Low latency, simple setup, shared memory
- **Limitations**: No horizontal scaling, single point of failure

#### 2. **Processes Mode** (Production)
- Each service runs as a separate OS process
- Communication via `BullMQBus` (Redis-backed message queue)
- **Use case**: Production, distributed deployments, Docker
- **Benefits**: Horizontal scaling, process isolation, fault tolerance
- **Requirements**: Redis server

**Mode Selection**:
```bash
# Environment variable
export AURORA_ARCHITECTURE_MODE=processes  # or "threads"
export REDIS_URL=redis://localhost:6379

# Or in config.json
{
  "general": {
    "architecture": {
      "mode": "processes"
    }
  }
}
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
                            ▼
                   ┌──────────────┐
                   │  UI Bridge   │
                   │  (Optional)  │
                   │              │
                   │ - PyQt6 UI   │
                   │ - Qt signals │
                   └──────────────┘
```

---

## Core Concepts

### 1. Services

**All Aurora functionality is organized into services**. Each service:
- Inherits from `BaseService` (in `app/shared/services/base_service.py`)
- Implements lifecycle methods: `on_start()`, `on_stop()`, `reload()`
- Communicates exclusively via the message bus
- Registers method contracts for API exposure
- Runs independently (can be started/stopped individually)

### 2. Message Bus

**The message bus is the ONLY communication mechanism between services**. Direct service-to-service calls are prohibited.

**Key principles**:
- All inter-service communication goes through the bus
- Services publish messages to topics
- Services subscribe to topics they're interested in
- Messages are delivered concurrently to all subscribers
- No shared state between services (except via database)

### 3. Contract Registry

**Services expose their APIs through method contracts**. Contracts define:
- Method ID (e.g., `"TTS.Request"`)
- Input/output models (Pydantic)
- Exposure level (`"internal"`, `"external"`, `"both"`)
- Default priority and allowed origins

**Example**:
```python
@method_contract(
    method_id="TTS.Request",
    summary="Request TTS synthesis",
    input_model=TTSRequest,
    output_model=TTSResponse,
    exposure="both"
)
async def synthesize(self, request: TTSRequest) -> TTSResponse:
    # Implementation
    pass
```

### 4. Configuration

**Centralized configuration via ConfigService**:
- Primary source: `config.json` (structured settings)
- Secondary source: `.env` (sensitive credentials)
- Config changes trigger reload events
- Services subscribe to `Config.Changed` events
- Hot-reload supported for most settings

### 5. Plugin System

**Optional integrations loaded conditionally**:
- Plugins activated via `config.json` (`plugins.{name}.activate`)
- Dependencies installed only when needed
- Examples: Jira, Slack, GitHub, Gmail, OpenRecall
- MCP servers for external tool integration

---

## Service Structure

### Core Services

#### 1. **ConfigService** (`app/services/config/`)
- **Purpose**: Centralized configuration management
- **Responsibilities**:
  - Load and validate `config.json`
  - Provide config API to other services
  - Publish `Config.Changed` events on updates
  - Migrate settings from `.env` to `config.json`
- **Topics**: `Config.Get`, `Config.Set`, `Config.Changed`
- **Dependencies**: None (starts first)

#### 2. **DBService** (`app/services/db/`)
- **Purpose**: Database persistence and retrieval
- **Responsibilities**:
  - SQLite database management
  - Message history storage
  - RAG (vector) storage with sqlite-vec
  - Cron job persistence
  - Embeddings generation (local or API)
- **Topics**: `DB.StoreMessage`, `DB.GetRecentMessages`, `DB.StoreCronJob`, etc.
- **Dependencies**: ConfigService

#### 3. **ToolingService** (`app/services/tooling/`)
- **Purpose**: Tool management and execution
- **Responsibilities**:
  - Load core tools (search, browser, etc.)
  - Load plugin tools (Jira, Slack, etc.)
  - Load MCP tools from external servers
  - Provide tool registry to Orchestrator
  - Execute tool calls
- **Topics**: `Tool.Request`, `Tool.Result`, `Tool.List`
- **Dependencies**: ConfigService, DBService

#### 4. **SchedulerService** (`app/services/scheduler/`)
- **Purpose**: Scheduled task management
- **Responsibilities**:
  - Cron job scheduling with croniter
  - Job execution coordination
  - Job persistence via DBService
- **Topics**: `Sched.Schedule`, `Sched.Cancel`, `Sched.JobFired`
- **Dependencies**: ConfigService, DBService

#### 5. **TTSService** (`app/services/tts/`)
- **Purpose**: Text-to-speech synthesis
- **Responsibilities**:
  - Audio generation with Piper TTS
  - Playback management
  - Interrupt handling
  - Audio output via PyAudio
- **Topics**: `TTS.Request`, `TTS.Stop`, `TTS.Pause`, `TTS.Resume`, `TTS.Started`, `TTS.Stopped`
- **Dependencies**: ConfigService

#### 6. **STT Services** (`app/services/stt_*/`)

**STTCoordinatorService** (`stt_coordinator/`):
- Orchestrates STT workflow
- Manages audio capture (merged from AudioInputService)
- Coordinates wake word and transcription services
- Publishes `STT.SessionStarted`, `STT.UserSpeechCaptured`

**WakeWordService** (`stt_wakeword/`):
- Wake word detection with OpenWakeWord or Porcupine
- Publishes `WakeWord.Detected` events
- Continuous listening mode

**TranscriptionService** (`stt_transcription/`):
- Speech-to-text with faster-whisper
- Real-time and accurate transcription modes
- Ambient transcription support
- Publishes `Transcription.Result` events

**Dependencies**: ConfigService

#### 7. **OrchestratorService** (`app/services/orchestrator/`)
- **Purpose**: LLM coordination and conversation management
- **Responsibilities**:
  - LangGraph agent workflow
  - LLM provider integration (OpenAI, HuggingFace, llama.cpp)
  - Tool selection and execution
  - Conversation context management
  - Response generation
- **Topics**: `UI.UserInput`, `External.UserInput`, `LLM.ResponseReady`
- **Dependencies**: ConfigService, DBService, ToolingService

#### 8. **Supervisor** (`app/services/supervisor.py`)
- **Purpose**: Service lifecycle management
- **Responsibilities**:
  - Initialize message bus (LocalBus or BullMQBus)
  - Start services in dependency order
  - Handle graceful shutdown
  - Monitor service health (future)
- **Topics**: `Supervisor.GetStatus`, `Supervisor.RestartService`
- **Dependencies**: None (top-level orchestrator)

### Optional Services

#### **UIBridge** (`app/ui/bridge_service.py`)
- **Purpose**: Bridge between message bus and PyQt6 UI
- **Responsibilities**:
  - Subscribe to bus events (transcriptions, responses, TTS status)
  - Emit Qt signals for UI updates (thread-safe)
  - Publish user input from UI to bus
  - Load message history on startup
- **Threading**: Runs in background thread, UI in main thread
- **Topics**: Subscribes to all user-facing events

#### **Gateway Service** (Planned)
- **Purpose**: HTTP/WebSocket API for external clients
- **Responsibilities**:
  - REST API for service control
  - WebSocket for real-time events
  - Authentication and authorization
  - CORS handling
- **Configuration**: `config.json` → `gateway.*`

---

## Message Bus Architecture

### Message Types

#### 1. **Commands** (Point-to-Point)
- Guaranteed delivery with retry logic
- Exponential backoff (3 attempts by default)
- Dead-letter queue for failed messages
- Priority-based processing
- **Use for**: Service requests, control commands

**Example**:
```python
await bus.publish(
    "TTS.Request",
    TTSRequest(text="Hello", interrupt=True),
    event=False,  # Command
    priority=10,  # Interactive priority
    origin="internal"
)
```

#### 2. **Events** (Broadcast)
- Best-effort delivery
- Multiple subscribers supported
- No retry logic
- Wildcard topic matching (`"TTS.*"`)
- **Use for**: Notifications, state changes

**Example**:
```python
await bus.publish(
    "STT.TranscriptionDetected",
    TranscriptionResult(text="Hello world"),
    event=True,  # Event
    priority=10,
    origin="internal"
)
```

#### 3. **Queries** (Request/Response)
- Synchronous-style API over async messaging
- Timeout support (default 5s)
- Correlation IDs for tracking
- **Use for**: Data retrieval, status checks

**Example**:
```python
result = await bus.request(
    "DB.GetRecentMessages",
    GetMessagesQuery(limit=10),
    timeout=5.0
)
```

### Message Priority

**Lower numbers = higher priority**:

| Priority Class | Value | Use Cases |
|---------------|-------|-----------|
| **Interactive** | 10 | User interactions (STT, UI input) |
| **System** | 50 | Background tasks, scheduled jobs |
| **External** | 80 | External API requests, webhooks |

**Configuration** (`config.json`):
```json
{
  "messaging": {
    "priorities": {
      "interactive": 10,
      "system": 50,
      "external": 80
    }
  }
}
```

### Concurrent Message Delivery

**CRITICAL**: As of October 2025, LocalBus delivers messages **concurrently** to all subscribers using `asyncio.create_task()`.

**Implications**:
- Handlers run in parallel, not sequentially
- Order of completion is not guaranteed
- UI updates happen immediately, even during long LLM processing
- Services must handle concurrent state updates
- One handler's failure doesn't affect others

**Example Flow**:
```
User says "Jarvis, hello"
├─ 03:00:00 - STT publishes USER_SPEECH_CAPTURED
├─ 03:00:00 - UI Bridge receives (adds user message) ← Concurrent
├─ 03:00:00 - Orchestrator receives (starts LLM)    ← Concurrent
└─ 03:00:08 - Orchestrator publishes LLM_RESPONSE
    ├─ 03:00:08 - UI Bridge receives (adds assistant message)
    └─ 03:00:08 - TTS receives (starts speaking)
```

### Topic Naming Convention

**Format**: `{Service}.{Action}`

**Examples**:
- `TTS.Request`, `TTS.Stop`, `TTS.Started`, `TTS.Stopped`
- `STT.SessionStarted`, `STT.UserSpeechCaptured`
- `DB.StoreMessage`, `DB.GetRecentMessages`
- `Config.Get`, `Config.Set`, `Config.Changed`
- `LLM.ResponseReady`

**Wildcards**: `"TTS.*"` matches all TTS topics

### Message Envelope Structure

```python
@dataclass
class Envelope:
    topic: str              # Topic name
    payload: BaseModel      # Message data (Pydantic model)
    id: str                 # Unique message ID
    timestamp: float        # Unix timestamp
    priority: int           # Message priority
    origin: str             # "internal", "external", "system"
    attempts: int           # Retry attempts
    max_attempts: int       # Max retry attempts
    ttl_ms: int | None      # Time-to-live in milliseconds
    reply_to: str | None    # Reply topic for queries
```

---

## Development Workflows

### Environment Setup

**CRITICAL**: Always activate the conda environment before running any commands:

```bash
conda activate aurora
```

**Python Version**: 3.10-3.11 only (3.12+ causes dependency conflicts)

**Verify Python version**:
```bash
python -c "import sys; print(f'Version: {sys.version}'); print('Compatible' if sys.version_info[:2] in [(3,10), (3,11)] else 'INCOMPATIBLE')"
```

### Installation

**Option 1: Guided Setup (Recommended)**:
```bash
./setup.sh  # Choose option 3 for Development
```

**Option 2: Manual Installation**:
```bash
pip install -e .[dev-local-cpu]  # Development with CPU
pip install -e .[dev-local-gpu]  # Development with GPU
```

### Running Aurora

**CLI Mode** (no UI):
```bash
python main.py
```

**UI Mode** (PyQt6):
```bash
# Enable UI in config.json
{
  "ui": {
    "activate": true
  }
}

python main.py
```

**Process Mode** (Docker):
```bash
# Setup and start
make docker-process-mode

# Or manually
docker-compose -f docker-compose.process.yml up -d
```

### Code Quality

**Before committing, ALWAYS run**:
```bash
make format  # Auto-format code (ruff)
make lint    # Check code style
make check   # Run all quality checks
make unit    # Run unit tests
```

**Pre-commit hooks** (automatically installed):
```bash
pre-commit run --all-files
```

### Testing

**Run tests**:
```bash
make test              # All tests except performance
make unit              # Unit tests only (3-5 min)
make integration       # Integration tests (5-8 min)
make coverage          # Coverage report (8-12 min)
pytest tests/performance  # Performance tests (15-30 min)
```

**Test markers**:
```bash
pytest -m "not external and not gpu"  # Skip external/GPU tests
pytest -m process_mode                # Process mode tests only
```

### Adding a New Service

**1. Create service directory**:
```
app/services/my_service/
├── __init__.py
├── __main__.py
├── service.py
└── models.py
```

**2. Implement service** (`service.py`):
```python
from app.shared.services.base_service import BaseService
from app.shared.contracts.registry import method_contract

class MyService(BaseService):
    def __init__(self):
        super().__init__(
            module="MyService",
            summary="My service description",
            capabilities=["capability1", "capability2"]
        )
    
    async def on_start(self):
        # Service-specific startup
        pass
    
    async def on_stop(self):
        # Service-specific shutdown
        pass
    
    async def reload(self, config_section: str | None = None):
        # Handle config reload
        pass
    
    @method_contract(
        method_id="MyService.DoSomething",
        summary="Do something",
        input_model=MyRequest,
        output_model=MyResponse,
        exposure="internal"
    )
    async def do_something(self, envelope: Envelope) -> None:
        # Implementation
        pass
```

**3. Register in Supervisor** (`app/services/supervisor.py`):
```python
from app.services.my_service import MyService

# In _start_services_threads():
my_service = MyService()
await my_service.start()
self.services.append(my_service)
```

**4. Add to Docker** (if using process mode):
- Create `docker/services/Dockerfile.my-service`
- Add to `docker-compose.process.yml`
- Add entry point to `pyproject.toml`

### Adding a New Tool

**1. Create tool file** (`app/services/tooling/tools/my_tool.py`):
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
    # Implementation
    return f"Result: {param}"
```

**2. Register in ToolsManager** (`app/services/tooling/tools_manager.py`):
```python
from .tools.my_tool import my_tool

# In _load_core_tools():
self._tools.append(my_tool)
```

**3. Add to tool database** (automatic on service start)

### Adding a Plugin

**1. Create plugin directory**:
```
app/services/tooling/tools/plugins/my_plugin/
├── __init__.py
└── tools.py
```

**2. Implement tools** (`tools.py`):
```python
from langchain_core.tools import tool

@tool
def my_plugin_action(param: str) -> str:
    """Plugin action description."""
    # Implementation
    return result
```

**3. Add configuration** (`config.json`):
```json
{
  "plugins": {
    "my_plugin": {
      "activate": true,
      "api_key": ""
    }
  }
}
```

**4. Add dependencies** (`pyproject.toml`):
```toml
[project.optional-dependencies]
my-plugin = [
    "my-plugin-dependency>=1.0.0",
]
```

**5. Load conditionally** (in ToolsManager):
```python
if config_manager.get("plugins.my_plugin.activate"):
    from .tools.plugins.my_plugin.tools import my_plugin_action
    self._tools.append(my_plugin_action)
```

---

## Code Organization

### Directory Structure

```
aurora/
├── app/                          # Core application code
│   ├── __init__.py
│   ├── __main__.py              # Entry point for `python -m app`
│   ├── helpers/                 # Utility functions
│   │   └── aurora_logger.py     # Logging utilities
│   ├── messaging/               # Message bus implementation
│   │   ├── bus.py               # Abstract bus interface
│   │   ├── local_bus.py         # LocalBus (threads mode)
│   │   ├── bullmq_bus.py        # BullMQBus (processes mode)
│   │   └── bus_runtime.py       # Global bus singleton
│   ├── services/                # Service implementations
│   │   ├── config/              # ConfigService
│   │   ├── db/                  # DBService
│   │   ├── orchestrator/        # OrchestratorService
│   │   ├── scheduler/           # SchedulerService
│   │   ├── tooling/             # ToolingService
│   │   │   ├── tools/           # Core and plugin tools
│   │   │   └── mcp/             # MCP integration
│   │   ├── tts/                 # TTSService
│   │   ├── stt_coordinator/     # STTCoordinatorService
│   │   ├── stt_transcription/   # TranscriptionService
│   │   ├── stt_wakeword/        # WakeWordService
│   │   └── supervisor.py        # Supervisor
│   ├── shared/                  # Shared code for all services
│   │   ├── config/              # Config interface
│   │   ├── contracts/           # Contract registry and models
│   │   ├── messaging/           # Messaging utilities
│   │   └── services/            # BaseService abstraction
│   └── ui/                      # UI integration
│       └── bridge_service.py    # UIBridge
├── modules/                     # Optional modules
│   ├── ui/                      # PyQt6 UI
│   │   └── aurora_ui.py
│   └── openrecall/              # OpenRecall integration
├── tests/                       # Test suite
│   ├── unit/                    # Unit tests
│   ├── integration/             # Integration tests
│   ├── e2e/                     # End-to-end tests
│   └── performance/             # Performance tests
├── docker/                      # Docker configurations
│   └── services/                # Service Dockerfiles
├── scripts/                     # Build and setup scripts
├── docs/                        # Documentation
├── main.py                      # Main entry point
├── config.json                  # Configuration file
├── .env                         # Environment variables (sensitive)
├── pyproject.toml               # Python package configuration
├── Makefile                     # Development commands
└── README.md                    # Project README
```

### Import Conventions

**Absolute imports only**:
```python
# Good
from app.services.tts import TTSService
from app.shared.config.interface import ConfigAPI
from app.messaging.bus_runtime import get_bus

# Bad
from ..services.tts import TTSService
from .config import ConfigAPI
```

**Avoid circular imports**:
- Use `TYPE_CHECKING` for type hints
- Import at function level if needed
- Use string annotations for forward references

**Example**:
```python
from __future__ import annotations
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.db import DBService

def my_function(db: DBService) -> None:
    # Implementation
    pass
```

### Naming Conventions

**Files**: `snake_case.py`
**Classes**: `PascalCase`
**Functions/Methods**: `snake_case()`
**Constants**: `UPPER_SNAKE_CASE`
**Private**: `_leading_underscore`

**Services**: `{Name}Service` (e.g., `TTSService`, `DBService`)
**Models**: `{Name}Request`, `{Name}Response`, `{Name}Event`
**Topics**: `{Service}.{Action}` (e.g., `TTS.Request`)

---

## Testing

### Test Structure

```
tests/
├── unit/                    # Unit tests (isolated components)
│   ├── test_config.py
│   ├── test_messaging.py
│   └── test_services/
├── integration/             # Integration tests (component interaction)
│   ├── test_process_mode.py
│   ├── test_service_communication.py
│   └── test_database.py
├── e2e/                     # End-to-end tests (full workflows)
│   └── test_voice_workflow.py
└── performance/             # Performance benchmarks
    └── test_message_throughput.py
```

### Writing Tests

**Unit test example**:
```python
import pytest
from app.messaging.local_bus import LocalBus

@pytest.mark.asyncio
async def test_message_delivery():
    bus = LocalBus()
    await bus.start()
    
    received = []
    bus.subscribe("test.topic", lambda env: received.append(env))
    
    await bus.publish("test.topic", MyMessage(data="test"))
    await asyncio.sleep(0.1)
    
    assert len(received) == 1
    await bus.stop()
```

**Integration test example**:
```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_config_service_startup():
    # Test that ConfigService can start and respond
    supervisor = Supervisor()
    await supervisor.initialize()
    
    # Verify service is running
    assert supervisor._bus is not None
    
    await supervisor.shutdown()
```

### Test Markers

```python
@pytest.mark.unit          # Unit test
@pytest.mark.integration   # Integration test
@pytest.mark.e2e           # End-to-end test
@pytest.mark.performance   # Performance test
@pytest.mark.process_mode  # Process mode test
@pytest.mark.slow          # Slow test (>5s)
@pytest.mark.external      # Requires external services
@pytest.mark.gpu           # Requires GPU
```

### Running Tests

```bash
# All tests
pytest

# Specific marker
pytest -m unit
pytest -m "not external and not gpu"

# Specific file
pytest tests/unit/test_messaging.py

# Specific test
pytest tests/unit/test_messaging.py::test_message_delivery

# With coverage
pytest --cov=app --cov-report=html

# Parallel execution
pytest -n auto
```

---

## Configuration Management

### Configuration Files

**Primary**: `config.json` (structured settings)
**Secondary**: `.env` (sensitive credentials)

### Configuration Structure

```json
{
  "general": {
    "llm": {
      "provider": "openai",  // or "llama_cpp", "huggingface_pipeline", etc.
      "third_party": {
        "openai": {
          "options": {
            "model": "gpt-4o",
            "temperature": 0.7,
            "max_tokens": 512
          }
        }
      },
      "local": {
        "llama_cpp": {
          "options": {
            "model_path": "model.gguf",
            "n_gpu_layers": 0
          }
        }
      }
    },
    "embeddings": {
      "use_local": true  // false for OpenAI embeddings
    },
    "speech_to_text": {
      "language": "en",
      "ambient_transcription": {
        "enable": false
      },
      "wake_word": {
        "enabled": true,
        "backend": "oww",  // or "porcupine"
        "threshold": 0.5
      },
      "transcription": {
        "vad_enabled": true,
        "realtime_model": {
          "model_size": "tiny"
        },
        "accurate_model": {
          "model_size": "base"
        }
      }
    },
    "text_to_speech": {
      "model_file_path": "voice_models/en_US-lessac-medium.onnx"
    }
  },
  "ui": {
    "activate": false,
    "dark_mode": false
  },
  "plugins": {
    "jira": {
      "activate": false
    },
    "slack": {
      "activate": false
    }
  },
  "mcp": {
    "enabled": true,
    "servers": {}
  },
  "gateway": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8000
  }
}
```

### Accessing Configuration

**In services**:
```python
from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()

# Get value
provider = config_api.get("general.llm.provider")
ui_enabled = config_api.get("ui.activate", default=False)

# Set value
config_api.set("ui.dark_mode", True)

# Get entire config
config = config_api.get_config()
```

**Config reload**:
```python
# Services automatically receive Config.Changed events
async def reload(self, config_section: str | None = None):
    if config_section == "llm" or config_section is None:
        # Reload LLM configuration
        self._provider = config_api.get("general.llm.provider")
```

### Environment Variables

**Priority**: Environment variables override `config.json`

**Common variables**:
```bash
AURORA_ARCHITECTURE_MODE=processes  # or "threads"
REDIS_URL=redis://localhost:6379
AURORA_LOG_LEVEL=INFO
OPENAI_API_KEY=sk-...
HUGGINGFACE_API_TOKEN=hf_...
```

**Migration**: `.env` values are migrated to `config.json` on first run

---

## Deployment Modes

### Thread Mode (Development)

**Use case**: Development, testing, single-machine

**Setup**:
```bash
# config.json (or omit - threads is default)
{
  "general": {
    "architecture": {
      "mode": "threads"
    }
  }
}

# Run
python main.py
```

**Characteristics**:
- All services in one process
- LocalBus (asyncio queues)
- Low latency
- Simple debugging
- No external dependencies

### Process Mode (Production)

**Use case**: Production, distributed deployments, Docker

**Setup**:
```bash
# 1. Start Redis
docker run -d -p 6379:6379 redis:7-alpine

# 2. Configure
export AURORA_ARCHITECTURE_MODE=processes
export REDIS_URL=redis://localhost:6379

# 3. Run
python main.py
```

**Characteristics**:
- Each service in separate process
- BullMQBus (Redis queues)
- Horizontal scaling
- Process isolation
- Requires Redis

### Docker Deployment

**Quick start**:
```bash
# Using helper script
make docker-process-mode

# Or manually
docker-compose -f docker-compose.process.yml up -d
```

**Service images**:
- `aurora-config`: ConfigService
- `aurora-db`: DBService
- `aurora-orchestrator`: OrchestratorService
- `aurora-tts`: TTSService
- `aurora-stt-*`: STT services
- `aurora-scheduler`: SchedulerService
- `aurora-tooling`: ToolingService

**Monitoring**:
```bash
# View logs
docker-compose -f docker-compose.process.yml logs -f

# Check status
docker-compose -f docker-compose.process.yml ps

# Restart service
docker-compose -f docker-compose.process.yml restart orchestrator-service
```

### Scaling Services

**Horizontal scaling** (process mode only):
```bash
# Scale transcription service to 2 instances
docker-compose -f docker-compose.process.yml up -d --scale transcription-service=2
```

**Vertical scaling** (resource limits):
```yaml
# docker-compose.process.yml
services:
  orchestrator-service:
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
```

---

## Critical Rules

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
await bus.publish(
    "TTS.Request",
    TTSRequest(text="Hello", interrupt=True),
    event=False,
    priority=10
)
```

### 2. **ALWAYS Activate Conda Environment**

**BEFORE** running any commands:
```bash
conda activate aurora
```

### 3. **ALWAYS Use Python 3.10-3.11**

Python 3.12+ causes dependency conflicts. Verify version:
```bash
python --version  # Must be 3.10.x or 3.11.x
```

### 4. **NEVER Block the Event Loop**

All service methods must be `async`. Use `asyncio.to_thread()` for blocking operations.

```python
# ❌ BAD
def process_data(self):
    time.sleep(5)  # Blocks event loop!

# ✅ GOOD
async def process_data(self):
    await asyncio.sleep(5)  # Non-blocking

# ✅ GOOD (for CPU-bound work)
async def process_data(self):
    result = await asyncio.to_thread(cpu_intensive_function)
```

### 5. **ALWAYS Handle Concurrent Message Delivery**

Messages are delivered concurrently. Don't assume execution order.

```python
# ❌ BAD
self.state = "processing"
# Another handler might change state concurrently!

# ✅ GOOD
async with self._state_lock:
    self.state = "processing"
```

### 6. **ALWAYS Use Pydantic Models for Messages**

```python
# ❌ BAD
await bus.publish("TTS.Request", {"text": "Hello"})

# ✅ GOOD
await bus.publish("TTS.Request", TTSRequest(text="Hello"))
```

### 7. **ALWAYS Register Method Contracts**

```python
# ✅ GOOD
@method_contract(
    method_id="MyService.DoSomething",
    summary="Do something",
    input_model=MyRequest,
    output_model=MyResponse,
    exposure="internal"
)
async def do_something(self, envelope: Envelope) -> None:
    # Implementation
    pass
```

### 8. **ALWAYS Clean Up Resources**

```python
async def on_stop(self):
    # Close connections
    if self._db_connection:
        await self._db_connection.close()
    
    # Cancel tasks
    for task in self._background_tasks:
        task.cancel()
    
    # Release locks
    # etc.
```

### 9. **ALWAYS Use Absolute Imports**

```python
# ✅ GOOD
from app.services.tts import TTSService
from app.shared.config.interface import ConfigAPI

# ❌ BAD
from ..services.tts import TTSService
from .config import ConfigAPI
```

### 10. **ALWAYS Test Before Committing**

```bash
make format  # Auto-format
make lint    # Check style
make unit    # Run tests
```

### 11. **NEVER Commit Sensitive Data**

- API keys go in `.env` (gitignored)
- Use `config.json` for structure only
- Credentials are migrated from `.env` to `config.json` at runtime

### 12. **ALWAYS Use Structured Logging**

```python
from app.helpers.aurora_logger import log_info, log_error, log_debug

log_info("Service started")
log_error("Failed to connect", exc_info=True)
log_debug(f"Processing message: {message}")
```

### 13. **ALWAYS Handle Config Reload**

```python
async def reload(self, config_section: str | None = None):
    if config_section == "my_section" or config_section is None:
        # Reload configuration
        self._setting = config_api.get("my_section.setting")
```

### 14. **ALWAYS Use Priority Helpers**

```python
from app.messaging.priority_helpers import (
    get_interactive_priority,
    get_system_priority,
    get_external_priority
)

# User interaction
await bus.publish(topic, message, priority=get_interactive_priority())

# Background task
await bus.publish(topic, message, priority=get_system_priority())
```

### 15. **ALWAYS Document Public APIs**

```python
async def my_method(self, param: str) -> str:
    """Brief description.
    
    Detailed description if needed.
    
    Args:
        param: Parameter description
    
    Returns:
        Return value description
    
    Raises:
        ValueError: When param is invalid
    """
    pass
```

---

## Additional Resources

### Documentation

- **Architecture**: `docs/ARCHITECTURE.md`
- **Messaging**: `docs/MESSAGING_ARCHITECTURE.md`
- **Process Mode**: `README.process-mode.md`
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
- **Config API**: `app/shared/config/interface.py`

### Development Commands

```bash
# Setup
./setup.sh                    # Guided setup
pip install -e .[dev-local-cpu]  # Manual install

# Running
python main.py                # CLI mode
python main.py                # UI mode (if ui.activate=true)

# Code Quality
make format                   # Auto-format
make lint                     # Lint
make check                    # All checks

# Testing
make test                     # All tests
make unit                     # Unit tests
make integration              # Integration tests
make coverage                 # Coverage report

# Docker
make docker-process-mode      # Setup and start
make docker-process-up        # Start services
make docker-process-down      # Stop services
make docker-process-logs      # View logs

# Cleanup
make clean                    # Remove temp files
```

---

## Summary

Aurora is a **microservices-based voice assistant** with a **message bus architecture** that supports both **thread mode** (development) and **process mode** (production). All services communicate exclusively via the message bus, using **contracts** to define their APIs. The system is **modular**, **privacy-first**, and **extensible** through plugins and MCP servers.

**Key principles**:
1. **Message bus only** - No direct service calls
2. **Concurrent delivery** - Handlers run in parallel
3. **Contract-based APIs** - Explicit method contracts
4. **Configuration-driven** - Hot-reload support
5. **Plugin architecture** - Optional dependencies
6. **Process isolation** - Services can run independently
7. **Privacy-first** - Local processing by default

**When developing**:
- Always use the message bus
- Always activate conda environment
- Always use Python 3.10-3.11
- Always test before committing
- Always handle concurrent delivery
- Always clean up resources

**For questions or issues**, refer to the documentation in `docs/` or open an issue on GitHub.

---

**Last Updated**: January 2026
**Version**: 1.0.0
**Maintainers**: Aurora Team
