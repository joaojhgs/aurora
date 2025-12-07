# Aurora Voice Assistant Development Instructions

**ALWAYS FOLLOW THESE INSTRUCTIONS FIRST**. Only search for additional context or run extra commands if the information here is incomplete or found to be incorrect.

Aurora is a Python-based intelligent voice assistant for local automation and productivity. It uses real-time speech-to-text, LLMs, and various productivity tools in a modular, privacy-focused architecture.

## Bootstrap and Environment Setup

**CRITICAL**: Aurora requires Python 3.9-3.11. Python 3.12+ causes dependency conflicts. Check your Python version first:
```bash
python --version  # Must be 3.9.x, 3.10.x, or 3.11.x
# If Python 3.12+: Install Python 3.11 with pyenv or system package manager
```

**Python version validation (run this first):**
```bash
python -c "import sys; print(f'Version: {sys.version}'); print('Compatible' if sys.version_info[:2] in [(3,9), (3,10), (3,11)] else 'INCOMPATIBLE - Use Python 3.9-3.11')"
```

**Set up the development environment:**
```bash
# Install system dependencies (Linux) - takes 1-2 minutes
sudo apt update && sudo apt install -y portaudio19-dev python3-pip python3-venv python3-dev gcc

# Run guided setup (RECOMMENDED) - detects hardware and configures automatically
./setup.sh  # Choose option 3 for Development

# OR manually install development dependencies
pip install -r requirements-dev.txt  # Takes 2-3 minutes, set timeout to 300 seconds
```

**NEVER CANCEL: Setup takes 5-10 minutes on first run. Set timeout to 900+ seconds.**

## Build and Test Commands

**Build the project:**
```bash
# NEVER CANCEL: Full build takes 15-20 minutes. Set timeout to 1800+ seconds.
make setup  # Complete environment setup

# Format code (takes 30-60 seconds)
make format

# NEVER CANCEL: Linting takes 2-3 minutes. Set timeout to 300+ seconds.
make lint

# NOTE: If dependency installation fails due to Python 3.12+:
# Error messages like "piper-phonemize==1.1.0 not found" are expected
# Use Python 3.9-3.11 or run simplified validation commands below
```

**Run tests:**
```bash
# NEVER CANCEL: All tests take 10-15 minutes. Set timeout to 1200+ seconds.
make test

# Run specific test categories (each takes 3-8 minutes)
make unit        # Unit tests - 3-5 minutes
make integration # Integration tests - 5-8 minutes  
make coverage    # Coverage report - 8-12 minutes

# NEVER CANCEL: Full test suite can take 20+ minutes. Set timeout to 1800+ seconds.
pytest  # Run all tests except performance tests
```

**Performance tests (optional):**
```bash
# NEVER CANCEL: Performance tests take 15-30 minutes. Set timeout to 2400+ seconds.
pytest tests/performance
```

## Running Aurora

**Basic application run:**
```bash
# NEVER CANCEL: First run takes 5-10 minutes (downloads models). Set timeout to 900+ seconds.
python main.py

# Run without UI (headless mode)
python main.py  # UI activation controlled by config.json
```

**Configuration:**
- Copy `.env.file` to `.env` and add API keys
- Modify `config.json` for settings (defaults work for most users)
- Model files stored in `chat_models/` and `voice_models/` directories

## Manual Validation Scenarios

**ALWAYS test these scenarios after making changes:**

1. **Python Version Compatibility Check:**
   ```bash
   python -c "import sys; print('✅ Compatible' if sys.version_info[:2] in [(3,9), (3,10), (3,11)] else '❌ INCOMPATIBLE - Use Python 3.9-3.11')"
   # Verify: Shows "✅ Compatible"
   ```

2. **Basic Application Import Test:**
   ```bash
   python -c "from app.config.config_manager import config_manager; print('✅ Basic imports successful')"
   # Verify: No import errors
   # Verify: Configuration loads successfully
   # Expected: May create config.json if missing
   ```

3. **Application Startup Test:**
   ```bash
   python main.py
   # Verify: Application starts without crashes
   # Verify: Configuration loads successfully
   # Verify: No import errors in logs
   # NOTE: Will fail with missing dependencies unless full setup completed
   ```

4. **Development Tools Workflow:**
   ```bash
   make format && make lint
   # Verify: Code formatting applies cleanly
   # Verify: Linting passes or shows expected warnings only
   # NOTE: Some linting errors are expected if dependencies not fully installed
   ```

5. **Test Suite Basic Validation:**
   ```bash
   make unit
   # Verify: Unit tests execute (may skip tests requiring missing dependencies)
   # Verify: No critical import failures
   # Check logs for any failures related to your changes specifically
   ```

## Common Development Workflows

**Adding new features:**
1. Create branch: `git checkout -b feature/your-feature-name`
2. Run setup: `./setup.sh` (choose Development option)
3. Make changes in `app/` directory
4. **ALWAYS run validation:** `make format && make lint && make unit`
5. Test manually: `python main.py`
6. Commit with pre-commit hooks

**Working with dependencies:**
```bash
# Add runtime dependency to pyproject.toml [project.dependencies]
# Add dev dependency to pyproject.toml [project.optional-dependencies.dev]
# Update requirements-*.txt files accordingly
pip install -e .[dev-local-cpu]  # Install in development mode
```

**Before committing:**
```bash
# ALWAYS run these commands (total 5-8 minutes):
make format  # Auto-format code
make lint    # Check code style  
make check   # Run all quality checks
make unit    # Run unit tests
```

## Key Code Locations

**Core application structure:**
- `main.py` - Application entry point
- `app/` - Core Aurora application code
  - `app/config/` - Configuration management
  - `app/langgraph/` - LLM orchestration and tool integration  
  - `app/speech_to_text/` - Audio input processing
  - `app/text_to_speech/` - Audio output processing
- `modules/` - Optional feature modules (UI, integrations)
- `tests/` - Test suite (unit, integration, e2e, performance)

**Configuration files:**
- `config.json` - Main application configuration
- `.env` - API keys and sensitive settings
- `pyproject.toml` - Python package configuration
- `Makefile` - Development commands

**Build and setup:**
- `setup.sh` / `setup.bat` - Guided installation scripts
- `requirements-*.txt` - Python dependencies by category
- `.github/workflows/` - CI/CD pipeline definitions

**Testing:**
- `tests/unit/` - Component isolation tests
- `tests/integration/` - Component interaction tests  
- `tests/e2e/` - Complete workflow tests
- `tests/performance/` - Performance benchmarks

## Dependency Management

**Python package structure:**
- Uses `pyproject.toml` with optional dependencies for modular installation
- Multiple requirement files for different use cases
- Hardware-specific dependencies (CPU/GPU acceleration)

**Installing dependencies:**
```bash
# Development with all features
pip install -e .[dev-local-cpu]

# Production with specific features
pip install -e .[full-third-party]  # With API providers
pip install -e .[full-local-huggingface]  # With local models
```

## Build System Details

**Make targets (from Makefile):**
- `make help` - Show available commands
- `make setup` - Complete development environment setup
- `make format` - Auto-format code (black + isort)
- `make lint` - Run linting (flake8)  
- `make check` - Run all code quality checks
- `make test` - Run all tests except performance
- `make unit` - Unit tests only
- `make integration` - Integration tests only
- `make coverage` - Generate test coverage report
- `make clean` - Remove temporary files

**Pre-commit hooks:**
- Automatically installed with development setup
- Run on every commit to enforce code quality
- Manual execution: `pre-commit run --all-files`

## Troubleshooting

**Common issues:**

1. **Python version compatibility:**
   - Error: `Python 3.12 detected - Aurora requires Python 3.11 or earlier`
   - Error: Dependency conflicts or import failures
   - Solution: Install Python 3.11 using pyenv or system package manager
   - Commands:
     ```bash
     # Using pyenv (recommended):
     pyenv install 3.11.9
     pyenv local 3.11.9
     
     # Using apt (Ubuntu/Debian):
     sudo apt install python3.11 python3.11-venv python3.11-dev
     ```

2. **Dependency installation failures:**
   - Error: pip install timeouts or package not found
   - Error: `piper-phonemize==1.1.0` not found
   - Solution: Try `./setup.sh` guided setup instead of manual pip install
   - Alternative: Install categories separately (runtime, dev, test)
   - Note: Some dependencies may not be available for Python 3.12+

3. **Audio dependencies missing:**
   - Error: `portaudio not found` or `PyAudio installation failed`
   - Solution: `sudo apt install portaudio19-dev` (Linux)
   - Solution: `brew install portaudio` (macOS)

4. **Model files missing:**
   - Error: `Model path not found` or `FileNotFoundError`
   - Solution: Download models to `chat_models/` and `voice_models/`
   - Configuration: Update paths in `config.json`
   - Note: Application creates default config on first run

5. **Tests failing due to missing dependencies:**
   - Expected: Some tests may require external services or optional dependencies
   - Check: Run simplified tests with `-m simple` marker
   - Solution: `pytest -m "not external and not gpu"`
   - Verify: Your changes didn't break core imports

6. **Import errors in development:**
   - Error: `ModuleNotFoundError` for Aurora modules
   - Solution: Install in development mode: `pip install -e .`
   - Verify: You're in the correct directory with pyproject.toml

7. **Setup script fails:**
   - Error: Script exits early with Python version error
   - Solution: This is expected behavior - install compatible Python first
   - Don't override the version check - it prevents worse dependency issues

## Critical Timing Information

**NEVER CANCEL these operations - wait for completion:**

- **System setup:** 5-10 minutes (first time: 15-20 minutes)
- **Full dependency install:** 10-15 minutes
- **Complete build:** 15-20 minutes  
- **Unit tests:** 3-5 minutes
- **Integration tests:** 5-8 minutes
- **All tests:** 10-15 minutes
- **Performance tests:** 15-30 minutes
- **First application run:** 5-10 minutes (model downloads)

**Set these minimum timeouts:**
- pip install commands: 300-900 seconds
- make build/setup: 1200-1800 seconds  
- pytest commands: 600-1800 seconds
- First run: 900 seconds

## Architecture Notes

Aurora uses a modular plugin architecture:
- **LangGraph** for LLM orchestration and tool routing
- **Plugin system** for optional integrations (Jira, Slack, GitHub, etc.)
- **PyQt6** for optional GUI interface
- **SQLite** with vector extensions for memory/storage
- **MCP (Model Context Protocol)** for external tool integration

**Key design principles:**
- Privacy-first (local processing by default)
- Modular dependencies (only install what you need)
- Hardware acceleration support (CPU/GPU/Metal/ROCm)
- Extensible tool system via plugins and MCP servers