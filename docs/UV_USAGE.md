# Using UV with Aurora

This guide explains how to install dependencies and run Aurora using `uv` as the package manager.

UV provides two approaches:
1. **Native UV workflow** (`uv venv`, `uv sync`) - Uses UV's built-in venv management
2. **Pip-compatible workflow** (`uv pip`) - Compatible with traditional pip workflows

## Table of Contents
- [UV Native Venv Integration](#uv-native-venv-integration) ⭐ Recommended
- [Pip-Compatible Workflow](#pip-compatible-workflow)
- [Installing Dependencies](#installing-dependencies)
- [Running the Full Application](#running-the-full-application)
- [Running Individual Services](#running-individual-services)
- [Service-Specific Dependencies](#service-specific-dependencies)

## UV Native Venv Integration ⭐

UV's native workflow automatically manages virtual environments and syncs dependencies from `pyproject.toml`. This is the recommended approach for new setups.

### Quick Start with UV Native

```bash
# 1. Create virtual environment (if not exists)
uv venv

# 2. Sync all dependencies from pyproject.toml
uv sync

# 3. Run Aurora (automatically uses the venv)
uv run python main.py

# Or activate the venv manually
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate    # Windows
python main.py
```

### How UV Native Works

1. **`uv venv`** - Creates a `.venv` directory (similar to `python -m venv`)
2. **`uv sync`** - Reads `pyproject.toml`, installs dependencies, creates `uv.lock` file
3. **`uv run`** - Automatically activates venv and runs commands

### Installing Service-Specific Dependencies (Native)

UV's native `sync` command reads optional dependencies from `pyproject.toml`:

```bash
# Sync with specific optional dependencies
uv sync --extra runtime --extra torch-cpu

# Sync with all services
uv sync --extra all-services

# Sync with specific service
uv sync --extra service-db

# Sync with multiple extras
uv sync --extra service-db --extra service-scheduler --extra mode-threads

# Sync with development dependencies
uv sync --extra dev --extra test-all
```

### Running with UV Native

```bash
# UV automatically manages venv - no activation needed!
uv run python main.py

# Run individual services
uv run python -m app.services.db
uv run python -m app.services.tts

# Run tests
uv run pytest

# Run any command with automatic venv
uv run ruff check app tests
```

### Benefits of UV Native Approach

✅ **Automatic venv management** - No need to manually activate  
✅ **Lock file support** - `uv.lock` ensures reproducible installs  
✅ **Faster dependency resolution** - UV is much faster than pip  
✅ **Direct pyproject.toml integration** - Reads optional dependencies automatically  
✅ **Simpler workflow** - `uv run` handles everything  

## Pip-Compatible Workflow

The `uv pip` interface provides pip-compatibility for existing workflows or when you need pip-specific features.

## Installing Dependencies

### Install UV (if not already installed)

```bash
# Linux/macOS
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Or using pip
pip install uv
```

### Basic Installation (Native UV)

```bash
# Create venv and sync dependencies
uv venv
uv sync --extra runtime --extra torch-cpu

# Or in one command (venv created automatically)
uv sync --extra runtime --extra torch-cpu
```

### Basic Installation (Pip-Compatible)

```bash
# Create venv first
uv venv
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate   # Windows

# Install in editable mode with runtime dependencies
uv pip install -e .[runtime]

# Or install with torch (CPU)
uv pip install -e .[runtime,torch-cpu]
```

### Service-Specific Dependencies (Native UV)

```bash
# Sync with all service dependencies
uv sync --extra all-services

# Sync with specific service
uv sync --extra service-db

# Sync with multiple services
uv sync --extra service-db --extra service-scheduler --extra service-tooling
```

### Service-Specific Dependencies (Pip-Compatible)

```bash
# Install all service dependencies
uv pip install -e .[all-services]

# Install specific service dependencies
uv pip install -e .[service-config]
uv pip install -e .[service-db]
uv pip install -e .[service-scheduler]
uv pip install -e .[service-tooling]
uv pip install -e .[service-stt-wakeword]
uv pip install -e .[service-stt-transcription]
uv pip install -e .[service-stt-coordinator]
uv pip install -e .[service-tts]
uv pip install -e .[service-orchestrator]

# Install multiple services at once
uv pip install -e .[service-db,service-scheduler,service-tooling]
```

### Mode-Specific Dependencies (Native UV)

```bash
# Threads mode (default - uses asyncio)
uv sync --extra mode-threads

# Processes mode (requires Redis/BullMQ)
uv sync --extra mode-processes
```

### Mode-Specific Dependencies (Pip-Compatible)

```bash
# Threads mode (default - uses asyncio)
uv pip install -e .[mode-threads]

# Processes mode (requires Redis/BullMQ)
uv pip install -e .[mode-processes]
```

### Development Dependencies (Native UV)

```bash
# Sync development dependencies
uv sync --extra dev

# Sync test dependencies
uv sync --extra test-all

# Sync everything for development
uv sync --extra dev --extra test-all --extra all-services
```

### Development Dependencies (Pip-Compatible)

```bash
# Install development dependencies
uv pip install -e .[dev]

# Install test dependencies
uv pip install -e .[test]
uv pip install -e .[test-all]

# Install everything for development
uv pip install -e .[dev,test-all]
```

### Complete Installation Examples (Native UV) ⭐ Recommended

```bash
# Full installation with all services (threads mode)
uv sync --extra runtime --extra torch-cpu --extra all-services --extra mode-threads

# Full installation with all services (processes mode)
uv sync --extra runtime --extra torch-cpu --extra all-services --extra mode-processes

# Development setup
uv sync --extra runtime --extra torch-cpu --extra all-services --extra mode-threads --extra dev --extra test-all
```

### Complete Installation Examples (Pip-Compatible)

```bash
# Full installation with all services (threads mode)
uv pip install -e .[runtime,torch-cpu,all-services,mode-threads]

# Full installation with all services (processes mode)
uv pip install -e .[runtime,torch-cpu,all-services,mode-processes]

# Development setup
uv pip install -e .[runtime,torch-cpu,all-services,mode-threads,dev,test-all]
```

## Running the Full Application

### Using UV Native (Recommended)

```bash
# UV automatically manages venv - no activation needed!
uv run python main.py

# Or using the entry point script
uv run aurora

# Or activate venv manually after uv sync
source .venv/bin/activate  # Linux/macOS
python main.py
```

### Using Pip-Compatible Workflow

```bash
# Activate venv first
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate   # Windows

# Run the full application (all services)
python main.py

# Or using the entry point script
aurora
```

## Running Individual Services

Each service can be run independently as a standalone process. Services have `__main__.py` files that allow them to be executed directly.

### Available Services

- `ConfigService` - Configuration management
- `DBService` - Database operations
- `SchedulerService` - Task scheduling
- `ToolingService` - Tool integrations
- `TTSService` - Text-to-speech
- `OrchestratorService` - LLM orchestration
- `WakeWordService` - Wake word detection
- `TranscriptionService` - Speech transcription
- `STTCoordinatorService` - STT coordination

### Running Services Individually (Native UV) ⭐

```bash
# UV automatically manages venv - no activation needed!
uv run python -m app.services.config
uv run python -m app.services.db
uv run python -m app.services.scheduler
uv run python -m app.services.tooling
uv run python -m app.services.tts
uv run python -m app.services.orchestrator
uv run python -m app.services.stt_wakeword
uv run python -m app.services.stt_transcription
uv run python -m app.services.stt_coordinator
```

### Running Services Individually (Pip-Compatible)

```bash
# Activate venv first
source .venv/bin/activate  # Linux/macOS

# Run services
python -m app.services.config
python -m app.services.db
python -m app.services.scheduler
python -m app.services.tooling
python -m app.services.tts
python -m app.services.orchestrator
python -m app.services.stt_wakeword
python -m app.services.stt_transcription
python -m app.services.stt_coordinator
```

### Service-Specific Installation + Run (Native UV)

For a minimal setup, sync only what you need:

```bash
# Example: Run only DB service
uv sync --extra service-db --extra mode-processes
uv run python -m app.services.db

# Example: Run only TTS service
uv sync --extra service-tts --extra mode-processes
uv run python -m app.services.tts
```

### Service-Specific Installation + Run (Pip-Compatible)

```bash
# Example: Run only DB service
uv pip install -e .[service-db,mode-processes]
uv run python -m app.services.db

# Example: Run only TTS service
uv pip install -e .[service-tts,mode-processes]
uv run python -m app.services.tts
```

## Service-Specific Dependencies

### ConfigService (`service-config`)
- Minimal dependencies (uses jsonschema from core)

### DBService (`service-db`)
```bash
uv pip install -e .[service-db]
```
- `aiosqlite`, `sqlite-vec`, `SQLAlchemy`
- `langchain`, `langchain-community`, `langgraph`

**Optional**: Local embeddings (adds ~7GB)
```bash
uv pip install -e .[service-db,service-db-local-embeddings]
```

### SchedulerService (`service-scheduler`)
```bash
uv pip install -e .[service-scheduler]
```
- `croniter`

### ToolingService (`service-tooling`)
```bash
uv pip install -e .[service-tooling]
```
- `aiohttp`
- `langchain-community`, `langchain-core`
- `langchain-google-community`
- `langchain-mcp-adapters`
- `langgraph`

### TTSService (`service-tts`)
```bash
uv pip install -e .[service-tts]
```
- `realtimetts`, `piper-tts`, `piper-phonemize`
- `PyAudio`
- `torch`, `torchaudio`, `torchvision`
- `onnxruntime`

### OrchestratorService (`service-orchestrator`)
```bash
uv pip install -e .[service-orchestrator]
```
- `langchain-core`, `langchain-openai`
- `langgraph`
- `Jinja2`, `typing-extensions`

**Optional**: HuggingFace endpoint
```bash
uv pip install -e .[service-orchestrator,service-orchestrator-huggingface-endpoint]
```

**Optional**: HuggingFace local (heavy - ~7GB)
```bash
uv pip install -e .[service-orchestrator,service-orchestrator-huggingface-local]
```

**Optional**: Llama.cpp (installed separately via setup script)
```bash
uv pip install -e .[service-orchestrator,service-orchestrator-llama-cpp]
```

### STT Services

**WakeWordService** (`service-stt-wakeword`)
```bash
uv pip install -e .[service-stt-wakeword]
```
- `openwakeword`, `pvporcupine`
- `numpy`, `scipy`, `onnxruntime`

**TranscriptionService** (`service-stt-transcription`)
```bash
uv pip install -e .[service-stt-transcription]
```
- `faster-whisper`, `RealtimeSTT`
- `webrtcvad-wheels`
- `ctranslate2`, `numpy`

**STTCoordinatorService** (`service-stt-coordinator`)
```bash
uv pip install -e .[service-stt-coordinator]
```
- `PyAudio`

## Common Workflows

### Development Setup (Native UV) ⭐ Recommended

```bash
# 1. Create venv and sync all dependencies
uv sync --extra runtime --extra torch-cpu --extra all-services --extra mode-threads --extra dev --extra test-all

# 2. Run the full application (no activation needed!)
uv run python main.py

# 3. Or run individual services for testing
uv run python -m app.services.db

# 4. Run tests
uv run pytest
```

### Development Setup (Pip-Compatible)

```bash
# 1. Create venv
uv venv
source .venv/bin/activate

# 2. Install all dependencies
uv pip install -e .[runtime,torch-cpu,all-services,mode-threads,dev,test-all]

# 3. Run the full application
python main.py

# 4. Or run individual services for testing
python -m app.services.db
```

### Minimal Testing Setup (Native UV)

```bash
# Sync only what you need for testing
uv sync --extra dev --extra test

# Run tests
uv run pytest
```

### Minimal Testing Setup (Pip-Compatible)

```bash
# Install only what you need for testing
uv pip install -e .[dev,test]

# Run tests
uv run pytest
```

### Production Deployment (Processes Mode) - Native UV

```bash
# Sync with processes mode (requires Redis)
uv sync --extra runtime --extra torch-cpu --extra all-services --extra mode-processes

# Start Redis first, then run services
uv run python main.py
```

### Production Deployment (Processes Mode) - Pip-Compatible

```bash
# Install with processes mode (requires Redis)
uv pip install -e .[runtime,torch-cpu,all-services,mode-processes]

# Start Redis first, then run services
python main.py
```

### Running Specific Service for Development (Native UV)

```bash
# Example: Develop only the DB service
uv sync --extra service-db --extra mode-threads --extra dev

# Run just the DB service
uv run python -m app.services.db
```

### Running Specific Service for Development (Pip-Compatible)

```bash
# Example: Develop only the DB service
uv pip install -e .[service-db,mode-threads,dev]

# Run just the DB service
uv run python -m app.services.db
```

## UV Native vs Pip-Compatible: Which to Use?

### Use UV Native (`uv sync`, `uv run`) when:
- ✅ Starting a new project or fresh setup
- ✅ You want automatic venv management
- ✅ You want reproducible installs (lock file)
- ✅ You want the fastest dependency resolution
- ✅ You're comfortable with UV's workflow

### Use Pip-Compatible (`uv pip`) when:
- ✅ Migrating from existing pip workflows
- ✅ You need pip-specific features
- ✅ You prefer manual venv activation
- ✅ You're using tools that expect pip

## Understanding UV's Venv Integration

### How `uv venv` Works

```bash
# Creates .venv directory (similar to python -m venv)
uv venv

# Creates venv in custom location
uv venv myenv

# Creates venv with specific Python version
uv venv --python 3.11
```

### How `uv sync` Works

`uv sync` reads `pyproject.toml` and:
1. Creates/updates `uv.lock` file (lockfile for reproducible installs)
2. Installs all dependencies matching the current extras
3. Installs the project itself in editable mode

```bash
# Sync with default dependencies
uv sync

# Sync with optional dependencies (extras)
uv sync --extra dev --extra test-all

# Sync without installing the project itself
uv sync --no-install-project
```

### How `uv run` Works

`uv run` automatically:
1. Creates venv if it doesn't exist
2. Syncs dependencies if needed
3. Activates venv
4. Runs the command
5. Deactivates venv when done

```bash
# No venv activation needed!
uv run python main.py
uv run pytest
uv run ruff check app
```

### Lock File (`uv.lock`)

When using `uv sync`, UV creates a `uv.lock` file that:
- Locks exact versions of all dependencies
- Ensures reproducible installs across environments
- Should be committed to version control (like `package-lock.json`)

```bash
# Sync creates/updates uv.lock
uv sync

# Commit lock file for reproducibility
git add uv.lock
```

## Notes

1. **Mode Selection**: Choose `mode-threads` (default) or `mode-processes` (requires Redis/BullMQ)

2. **Hardware Acceleration**: For GPU support, install CUDA/ROCm packages separately using the setup scripts

3. **Llama.cpp**: Llama.cpp dependencies are installed separately via the wheel installer script, not through pip/uv

4. **Redis**: Required for `mode-processes`. Install Redis separately:
   ```bash
   # Ubuntu/Debian
   sudo apt install redis-server
   
   # macOS
   brew install redis
   ```

5. **Environment Variables**: Make sure to set up your `.env` file with required configuration before running services

6. **Service Communication**: In processes mode, services communicate via Redis/BullMQ. In threads mode, they use in-memory message bus.

7. **Venv Location**: UV creates `.venv` by default (not `venv`). You can customize this:
   ```bash
   uv venv --python 3.11 my-custom-venv
   ```

8. **Lock File**: When using `uv sync`, commit `uv.lock` to version control for reproducible installs.

## Troubleshooting

### Missing Dependencies

If a service fails to start due to missing dependencies:

```bash
# Check what's installed
uv pip list

# Install missing service dependencies
uv pip install -e .[service-<name>]
```

### Import Errors

If you get import errors, ensure the package is installed in editable mode:

```bash
uv pip install -e .
```

### Redis Connection Errors (Processes Mode)

Ensure Redis is running:

```bash
# Check Redis status
redis-cli ping

# Start Redis if needed
redis-server
```

