# Aurora AI Agent Development Guide

**ALWAYS FOLLOW THESE INSTRUCTIONS FIRST**. This is the top-level guide for AI coding agents. Detailed subsystem guidance lives in focused sub-files -- see the routing table below.

---

## Sub-Agent Guides

Detailed guidance lives next to the code it describes. **Always read the relevant sub-guide before working on a subsystem.**

## Repository Exploration Docs

Use the documentation index when orienting yourself before implementation, investigation, or review:

- Start with [`docs/DOCS_INDEX.md`](docs/DOCS_INDEX.md) to find the canonical current docs and to distinguish current guidance from archived/provenance material.
- For high-level repo orientation, read [`readme.md`](readme.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and [`docs/FEATURE_MATRIX.md`](docs/FEATURE_MATRIX.md).
- For domain-specific work, follow the index to the relevant docs, especially [`docs/API_AND_CONTRACTS.md`](docs/API_AND_CONTRACTS.md), [`docs/AUTH_AND_PERMISSIONS.md`](docs/AUTH_AND_PERMISSIONS.md), [`docs/FRONTEND_AND_UI_ARCHITECTURE.md`](docs/FRONTEND_AND_UI_ARCHITECTURE.md), [`docs/BACKUP_SERVICE.md`](docs/BACKUP_SERVICE.md), and [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md).
- For documentation changes, follow [`docs/DOC_MAINTENANCE.md`](docs/DOC_MAINTENANCE.md) and run `make check-docs`. Do not treat `docs/archive/` or `.omx/plans/` as current implementation guidance unless you are explicitly doing provenance or plan-history work.

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
| Sherpa PocketTTS (patch queue, language packs, native/WASM proof) | [`tools/voice-runtime/AGENTS.md`](tools/voice-runtime/AGENTS.md) |

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

- **Audio**: PyAudio, faster-whisper, OpenWakeWord
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

### Commit Discipline

- During substantial multi-step work, commit each coherent, verified slice as soon as it is complete; do not leave an entire session as one unrelated dirty tree.
- When multiple agents work in parallel, every agent owns its declared files/modules, coordinates before touching shared files, and commits its own coherent verified slice before handing off.
- Inspect `git status` and the staged diff before every commit. Never absorb, rewrite, or discard unrelated work from another agent or an earlier session.
- Keep commits purpose-based and reviewable (for example: Python protocol/backend, SDK, UI, packaging, tests/docs) and include the verification evidence in the commit message.
- Defer pushing until the user requests it and all intended local commits are complete and verified. When a push is requested, push once from a clean tree.

### Parallel Agent Commit Discipline

- Concurrent write agents must use isolated branches/worktrees so they never share a Git index or race a commit. Assign each agent an explicit write scope before it starts.
- Reserve shared integration files—workspace/package lockfiles, root manifests, generated inventories, central registries, cross-platform Tauri bootstrap files, and CI workflows—for one named integration owner unless the leader explicitly transfers ownership.
- Every sub-agent must commit each coherent, verified slice before handoff using the Lore Commit Protocol. Do not hand back a large uncommitted working tree unless a genuine blocker prevents a safe commit.
- Before committing, sub-agents must inspect `git status`, stage only their owned paths, review the staged diff, and run the smallest verification that proves the slice. Never use broad staging that can absorb another lane's edits.
- Every handoff must report the commit SHA, owned files, verification run, failures or untested gaps, and any follow-up dependency. The integration owner alone rebases/cherry-picks concurrent lane commits and resolves shared-file conflicts.
- Sub-agents must not push. The leader/integration owner pushes once only when the user requests it and the integrated branch is clean and verified.

### Testing

```bash
make test              # All tests except performance
make unit              # Unit tests only
make integration       # Integration tests
make coverage          # Coverage report
```

Mesh pairing, reconnect, revocation, route access, and mobile background claims
must graduate from unit/integration checks to live service boundaries before
acceptance. Use `pnpm test:hosted-peer:live` for the hosted browser full
`main.py` Python stack; do not substitute a mock server for acceptance evidence.
Use Waydroid for the final local Android packaged WebView/native Rust gate only
after cheaper suites pass, and rerun it on an integration branch only when that
branch has a substantial source delta affecting Android native, Rust mesh
session, SDK transport, pairing, reconnect, revocation, foreground-service, or
lifecycle behavior. iOS runtime/WebRTC evidence requires macOS/Xcode CI or a
macOS runner; Linux checks are policy/source guards only.

### Android Device Selection

- Use Waydroid as the default Android target for local development, quick iteration, APK install/launch, logcat, screenshots, and interactive or scripted test runs. It is the fast, GPU-accelerated device on this host.
- Discover Waydroid from `adb devices -l` instead of assuming its IP. Prefer the device whose description contains `WayDroid`; pass its serial explicitly with `adb -s "$WAYDROID_SERIAL" ...` when more than one device is connected.
- Use the QEMU Android Emulator only when a task requires a specific API level, Google/Play system image, virtual hardware or sensor behavior, snapshot isolation, clean-device reproducibility, ABI coverage, or parity with emulator-based CI/CD.
- Do not start QEMU merely because an Android device is needed, and do not leave a QEMU emulator running after a compatibility test. Shut it down when the test finishes so it does not reserve CPU and memory needed by other development runtimes.
- Before reporting an Android failure, state which device class was tested. Reproduce compatibility-sensitive failures on the CI-equivalent QEMU image before treating a Waydroid-only difference as a release blocker.

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

This project is indexed by GitNexus as **aurora-mesh-parity-implementation** (29830 symbols, 105580 relationships, 300 execution flows).

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

## Aurora UI Platform and Voice Contract Memory

- All Aurora UI fixes must preserve the multi-surface contract unless the change is explicitly platform-specific: desktop Tauri local, desktop Tauri thin, web thin, Android, and iOS must route through centralized surface detection rather than ad hoc transport checks.
- Use `packages/aurora-ui/src/platform-surface.ts` (`getAuroraSurfaceProfile`) as the single source for desktop-local vs desktop-thin vs web vs Android/iOS/mobile behavior. Add new platform capability flags there first, then consume them from pages/components.
- Runtime role is never selected by an environment variable or compiled into an APK/desktop bundle; the old `VITE_AURORA_RUNTIME_MODE` build-time role assignments must not be reintroduced. A single Android/iOS/desktop client may dynamically act as a thin client managing a remote server, or as a node itself; persist and resolve those `roles` from runtime onboarding/profile state and keep them independent from the physical platform surface and transport mode.
- Local UI polish uses **one** Next debug server: `pnpm dev:ui:debug` (same as `pnpm dev:web` in this worktree). That launcher sets `NEXT_PUBLIC_AURORA_DEBUG_UI=1` so the Development preview badge, overlay, and device emulator are injected; production builds and plain `next dev` must not load that module. Switch surface/role/tier/admin/viewport at runtime with query params, the in-app Development preview badge, or the `aurora-debug-ui` cookie/sessionStorage. Do not spawn 11 Next processes for chrome comparison. Named `pnpm dev:ui:<preset>` commands remain valid isolated wrappers (random port) that apply the same query string; they must not bake a unique `NEXT_PUBLIC_*` role/surface into the compile. Production clients ignore the override. Query contract for agents: `aurora-surface=web|desktop-local|desktop-thin|android|ios`, `aurora-role=remote-console|mesh-node`, `aurora-tier=none|lightweight-ts|python-full`, `aurora-admin=0|1`, `aurora-viewport=phone|tablet|full`. Compatibility: `aurora-role=python-full` still means mesh-node + python-full. Example: `http://127.0.0.1:3000/?aurora-surface=android&aurora-role=mesh-node&aurora-admin=0&aurora-viewport=phone`. Active override JSON: `GET /__aurora/debug-preset`.
- Production UI is for end users only. Never show implementation/process wording such as proof, evidence, fixture, assertion, implementation, tested, debug, fallback, provider/consumer/hybrid, route counts, manifest, contract, protocol, transport, runtime, schema, migration, SQLite, IndexedDB, OPFS, sidecar, thin, or similar engineering terms in user-facing labels, empty states, toasts, dialogs, menus, setup text, or errors. Show useful user state, impact, action, remedy, and optional non-sensitive error IDs instead; keep implementation terms in logs, tests, developer docs, and non-rendered redacted support exports only.
- Voice ownership is split intentionally: desktop-local daemon wakeword/background capture remains owned by `STTCoordinator`; focused push-to-talk and visual waveform capture use WebView/browser microphone capture when available. Thin web wakeword may use focused WebView/Gateway streaming only while the page is focused. Mobile push-to-talk may use focused WebView capture, while durable wake/background behavior requires platform-native adapters.
- Any new bus method or event must follow the typed contract process: add constants and IO models under `app/shared/contracts/models/`, implement with `@method_contract` and correct `exposure`/`method_type`/permissions, route only via bus/SDK/Gateway boundaries, update SDK descriptors/types, and add tests proving redaction plus route/event behavior. Never introduce literal bus topics.

## Aurora Production UI Copy Contract

- Aurora's production UI is an end-user product surface, not an implementation report, developer console, test harness, or agent handoff.
- User-facing copy must never use internal verification/process language such as **proof**, **evidence**, **fixture**, **assertion**, **implementation**, **tested**, **debug**, or “what this test proves.”
- User-facing copy must not expose implementation vocabulary such as **manifest**, **contract**, **schema**, **migration**, **fallback**, **provider/consumer/hybrid role**, **runtime tier**, **sidecar**, **thin shell**, storage-engine names, route counts, internal transport state machines, source-code component names, or WebRTC/HTTP/WSS terminology outside the exact advanced connection fields a user must configure.
- Present only information useful to the user's current task: what happened, what is affected, whether their data/action is safe, and the next action they can take. A non-sensitive error/reference ID is allowed when it helps support.
- Translate internal states into product language. Examples: “peer lease expired” becomes “Device offline”; “SQLite/IndexedDB fallback” becomes “Saved on this device” or “Temporary session”; “migration failed” becomes “Local data needs attention”; “provider unavailable” becomes “This device is unavailable.”
- Advanced settings may show a standardized connection method or endpoint URL only when the user must configure it; even there, avoid implementation diagnostics and explain the practical effect in plain language.
- Keep technical details in structured logs, non-rendered redacted support exports, developer documentation, and tests—not in the production UI. Do not add a developer-console or implementation-diagnostics screen to the production navigation.
- Add rendered-copy tests or a production-string lint for new UI work. Tests must fail when forbidden implementation/proof wording reaches onboarding, navigation, status cards, errors, empty states, settings, or dialogs.
