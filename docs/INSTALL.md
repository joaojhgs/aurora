# Aurora Installation Guide

Complete installation documentation for Aurora Voice Assistant. For a quick start, see the [main README](../readme.md).

## 🚀 Quick Start

### Recommended Installation (Guided Setup)

```bash
# Clone the repository
git clone https://github.com/joaojhgs/aurora.git
cd aurora

# Run the interactive setup script
./setup.sh        # Linux/macOS
setup.bat         # Windows
```

The setup script will:
- ✅ Check Python version compatibility (requires Python 3.9-3.11, rejects Python 3.12+)
- ✅ Detect your hardware capabilities
- ✅ Install required system dependencies (PortAudio)
- ✅ Guide you through installation options
- ✅ Configure your environment automatically

---

## 📋 System Requirements

### Python Version Requirements
- **Python 3.9 - 3.11** (Python 3.12+ causes dependency conflicts with `tflite-runtime`, `openwakeword`, and audio/ML libraries)
- The setup scripts automatically verify your Python version and will reject Python 3.12+ with helpful installation guidance
- **Important**: Aurora enforces this requirement in `pyproject.toml` with `requires-python = ">=3.9,<3.12"`

### Platform Support
- **Linux** (Ubuntu 18.04+, CentOS 7+, etc.)
- **macOS** (10.15+, including Apple Silicon)
- **Windows** (Windows 10+)

### Hardware Requirements

#### Minimum (Third-party APIs)
- **RAM:** 2GB
- **Storage:** 1GB
- **Internet:** Required for API calls

#### Recommended (Local Models)
- **RAM:** 8GB+ (16GB+ for larger models)
- **Storage:** 5GB+ (depends on model sizes)
- **GPU:** Optional but recommended for performance

#### GPU Acceleration Support
- **NVIDIA:** CUDA 11.8+ or 12.x
- **AMD:** ROCm 6.0+
- **Apple Silicon:** Metal (automatic)
- **Intel:** SYCL (experimental)
- **Cross-platform:** Vulkan (experimental)

---

## 🛠️ Installation Methods

### Method 1: Guided Setup (Recommended)

**Best for:** Most users, handles everything automatically

**Linux/macOS:**
```bash
# Interactive installation with hardware detection
./setup.sh
```

**Windows:**
```batch
# Interactive installation with hardware detection
setup.bat
```

The guided setup provides 15+ installation options including:
- Third-party API providers (OpenAI, etc.)
- Local models with CPU/GPU acceleration
- Hardware-specific optimizations (CUDA, ROCm, Metal, Vulkan, SYCL)
- Development environments

### Method 2: Manual Installation

**Best for:** Advanced users who need specific control

#### Prerequisites

**Install PortAudio:**

**Linux:**
```bash
sudo apt install portaudio19-dev
```

**macOS:**
```bash
brew install portaudio
brew link portaudio
```

**Windows:** Usually handled automatically by pip

#### Package Installation Options

**Third-party API providers (easiest setup):**
```bash
# Using UV (recommended - faster dependency resolution)
uv sync --extra third-party

# Or using pip
pip install -e .[third-party]
```

**Local models with CPU:**
```bash
# Using UV (recommended)
uv sync --extra local-huggingface

# Or using pip
pip install -e .[local-huggingface]
```

**Local models with GPU:**
```bash
# Using UV (recommended)
uv sync --extra local-huggingface-gpu

# Or using pip
pip install -e .[local-huggingface-gpu]
```

**Development environment:**
```bash
# Using UV (recommended)
uv sync --extra dev-local-gpu

# Or using pip
pip install -e .[dev-local-gpu]
```

**See [UV Usage Guide](UV_USAGE.md) for complete UV documentation.**

### Method 3: Docker Hub (Pre-built Images)

**Best for:** Users who want to use pre-built Docker images without building locally

Aurora provides pre-built Docker images on Docker Hub with multiple variants for different hardware configurations. This is the fastest way to get started with Docker.

#### Prerequisites

- Docker 20.10+ installed
- Docker Compose 2.0+ (optional, for multi-service setup)

#### Quick Start with Docker Hub

1. **Pull the images you need**:
   ```bash
   # Example: Pull services for a basic setup
   docker pull aurora-ai/aurora-config:latest
   docker pull aurora-ai/aurora-db:openai-latest
   docker pull aurora-ai/aurora-orchestrator:openai-latest
   docker pull aurora-ai/aurora-tts:cpu-latest
   ```

2. **Use with docker-compose**:
   ```yaml
   # docker-compose.yml
   services:
     db-service:
       image: aurora-ai/aurora-db:openai-latest
       # ... configuration
   ```

3. **Or run directly**:
   ```bash
   docker run -d \
     --name aurora-db \
     -v $(pwd)/data:/app/data \
     -v $(pwd)/config:/app/config \
     aurora-ai/aurora-db:openai-latest
   ```

#### Available Variants

- **DB Service**: `openai` (smaller, ~500MB) or `local` (larger, ~8GB)
- **Orchestrator**: `openai`, `huggingface-endpoint`, `huggingface-local`, `llama-cpp-cpu`, `llama-cpp-cuda`, `llama-cpp-rocm`, `llama-cpp-metal`
- **TTS**: `cpu`, `cuda`, `rocm`, `metal`
- **STT Transcription**: `cpu`, `cuda`
- **STT Wakeword**: `cpu`, `cuda`

#### Model Configuration

Mount your models directory and configure via environment variables:

```bash
docker run -d \
  --name aurora-tts \
  -v $(pwd)/models:/app/models \
  -e AURORA_TTS_MODEL_FILE_PATH=/app/models/voice/en_US-lessac-medium.onnx \
  aurora-ai/aurora-tts:cpu-latest
```

**For detailed Docker Hub usage, see [Docker Hub Usage Guide](docker/DOCKER-HUB-USAGE.md)**

---

## ⚡ GPU Acceleration & Hardware Backends

Aurora uses intelligent wheel installation for optimal performance across different hardware configurations.

### Automatic Hardware Detection

The setup scripts automatically detect and install the best packages for your hardware:

```bash
# Automatic selection based on your system
python scripts/wheel_installer.py --package pytorch --hardware cuda
python scripts/wheel_installer.py --package llama-cpp-python --hardware cuda --advanced
```

### Supported Hardware Backends

#### Manual Wheel Installation

For advanced users who want specific wheel control:

```bash
# Install llama-cpp-python with optimal wheels
python scripts/wheel_installer.py --hardware cuda          # Standard CUDA wheels
python scripts/wheel_installer.py --hardware cuda --advanced  # Advanced wheels (Gemma3 support)
python scripts/wheel_installer.py --hardware cpu           # CPU wheels with OpenBLAS
python scripts/wheel_installer.py --hardware rocm          # AMD ROCm wheels
python scripts/wheel_installer.py --hardware metal         # Apple Metal (macOS only)
python scripts/wheel_installer.py --hardware vulkan        # Vulkan (cross-platform)
python scripts/wheel_installer.py --hardware sycl          # Intel SYCL (Intel GPU)
python scripts/wheel_installer.py --hardware rpc           # RPC distributed computing
```

### Hardware Backend Details

<details>
<summary><strong>CPU (OpenBLAS) - Default</strong></summary>

Aurora automatically tries these wheels in order:
1. **Pre-built CPU wheels**: `--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cpu/`
2. **Fallback**: Source compilation with OpenBLAS environment variables

Manual installation:
```bash
CMAKE_ARGS="-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS" pip install llama-cpp-python
```
</details>

<details>
<summary><strong>CUDA (NVIDIA GPU) - Recommended for GPU Users</strong></summary>

Aurora automatically tries these wheels in order:

**CUDA 12.4 (Primary - Supports Gemma2)**
```bash
python -m pip install llama-cpp-python --no-cache-dir --prefer-binary --extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cu124/
```
Model recommendation: [Gemma-2-2B-Q6](https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/blob/main/gemma-2-2b-it-Q6_K_L.gguf)

**Advanced Wheels (Supports Gemma3 non-multi-modal)**
```bash
python -m pip install https://github.com/oobabooga/llama-cpp-python-cuBLAS-wheels/releases/download/textgen-webui/llama_cpp_python_cuda-0.3.8+cu124-cp311-cp311-linux_x86_64.whl
```
Model recommendations: [Gemma-3-4B-IT-Q8](https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q8_K.gguf?download=true)

**CUDA 11.8 (Legacy Support)**
```bash
python -m pip install llama-cpp-python --prefer-binary --extra-index-url=https://jllllll.github.io/llama-cpp-python-cuBLAS-wheels/AVX2/cu118
```
Model recommendation: [LLAMA2-7B-Q4](https://huggingface.co/TheBloke/Llama-2-7B-Chat-GGUF/blob/main/llama-2-7b-chat.Q4_K_M.gguf)

**Fallback**: Source compilation with CUDA
</details>

<details>
<summary><strong>ROCm (AMD GPU)</strong></summary>

Aurora automatically tries these wheels in order:
1. **Pre-built ROCm wheels**: `--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/rocm/`
2. **Fallback**: Source compilation with ROCm environment variables

Manual installation:
```bash
CMAKE_ARGS="-DGGML_HIPBLAS=ON" pip install llama-cpp-python
```
</details>

<details>
<summary><strong>Metal (Apple Silicon/macOS) - Recommended for Mac Users</strong></summary>

Aurora automatically tries these wheels in order:
1. **Pre-built Metal wheels**: `--extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/metal/`
2. **Fallback**: Source compilation with Metal Performance Shaders

**Platform Requirements**: macOS only (automatically validated)
**Best Performance**: Apple M1/M2/M3 processors

Manual installation:
```bash
CMAKE_ARGS="-DGGML_METAL=ON" pip install llama-cpp-python
```
</details>

<details>
<summary><strong>Vulkan (Cross-Platform GPU)</strong></summary>

Cross-platform GPU acceleration using Vulkan API.

**Supported Platforms**: Windows, Linux, macOS
**Supported GPUs**: NVIDIA, AMD, Intel, mobile GPUs
**Requirements**: Vulkan-compatible drivers

Aurora automatically tries:
1. **Source compilation with Vulkan**: `CMAKE_ARGS="-DGGML_VULKAN=ON"`

Manual installation:
```bash
CMAKE_ARGS="-DGGML_VULKAN=ON" pip install llama-cpp-python
```
</details>

<details>
<summary><strong>SYCL (Intel GPU)</strong></summary>

Intel GPU acceleration using SYCL programming model.

**Supported Hardware**: Intel Arc GPUs, Intel integrated graphics
**Requirements**: Intel OneAPI toolkit
**Platforms**: Linux, Windows

Aurora automatically tries:
1. **Source compilation with SYCL**: Intel OneAPI detection + SYCL compilation

Manual installation:
```bash
# Install Intel OneAPI first
CMAKE_ARGS="-DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx" pip install llama-cpp-python
```
</details>

<details>
<summary><strong>RPC (Distributed Computing)</strong></summary>

Distributed inference across multiple machines or processes.

**Use Cases**: Large model distributed inference, remote GPU access
**Platforms**: Cross-platform
**Requirements**: Network setup between nodes

Aurora automatically tries:
1. **Source compilation with RPC**: `CMAKE_ARGS="-DGGML_RPC=ON"`

Manual installation:
```bash
CMAKE_ARGS="-DGGML_RPC=ON" pip install llama-cpp-python
```
</details>

### Installation Verification

After installation, verify your setup:
```bash
# Test llama-cpp-python installation
python -c "import llama_cpp; print('✅ llama-cpp-python installed successfully')"

# Test hardware acceleration (if using CUDA/ROCm)
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}')"
```

You can find more backend installations at the original [llama-cpp-python repository](https://github.com/abetlen/llama-cpp-python?tab=readme-ov-file#supported-backends).

---

## 📂 Model Management

Aurora stores model files in dedicated directories at the project root:

### Chat Models (`chat_models/`)
- Large language models in GGUF format (2-4GB each)
- Configure in `config.json`: `"llama_cpp_model_path": "chat_models/model-name.gguf"`
- Included: Gemma 2B/3B, Llama 2 7B models
- Download more from [Hugging Face GGUF models](https://huggingface.co/models?library=gguf)

### Voice Models (`voice_models/`)
- Text-to-speech (Piper) and wake word models
- Configure in `config.json`: `"model_file_path": "/voice_models/voice-name.onnx"`
- Included: English, Portuguese voices + Jarvis wake word
- Download more from [Piper Voices](https://github.com/rhasspy/piper/blob/master/VOICES.md)

### Model Directory Features
- ✅ **Excluded from builds**: Large files don't bloat packages
- ✅ **Git ignored**: Models managed separately from code
- ✅ **User controlled**: Choose models based on your hardware
- ✅ **Privacy focused**: All models run locally

*See [`DEPENDENCIES.md`](DEPENDENCIES.md) and [`../voice_models/README.md`](../voice_models/README.md) for model/dependency information.*

---

## ⚙️ Configuration

### Initial Configuration

Aurora uses a hybrid configuration system with both `config.json` and `.env` files:

#### Configuration Files Setup

**Main Configuration (`config.json`)**:
- Most settings are now managed through the `config.json` file
- Includes UI settings, LLM models, speech settings, CUDA options, and plugin configurations
- Validated with JSON schema to prevent configuration errors
- Falls back to safe defaults if validation fails

**Environment Variables (`.env`)**:
- Copy `.env.example` to `.env` in the root directory
- Contains development settings and configuration for third party software that works with envs such as:
  - `OPENAI_API_KEY` - Your OpenAI API key for embeddings and chat models (if you decide to use any)
  - Langsmith logging and tracing for development

#### Configuration Overview

* Most configurations come with defaults that work out of the box for English language
* CUDA is turned off by default, fine control is available in `config.json`
* Currently supports OpenAI and LLAMA-CPP for the main LLM
* Embeddings support both local (HuggingFace) and OpenAI options
* Set only one LLM model: either `openai_chat_model` or `llama_cpp_model_path` in `config.json`

**Key Configuration Sections in `config.json`:**
- `ui`: Interface settings (activation, dark mode, debug mode)
- `llm`: Language model configuration (local or OpenAI models)
- `embeddings`: Choose between local or OpenAI embeddings
- `speech_to_text`: STT language, detection settings, noise reduction
- `text_to_speech`: Voice model paths, sample rates, Piper configuration
- `cuda`: Fine-grained CUDA acceleration control for different components
- `plugins`: Enable/disable and configure various productivity integrations
- `google`: Google services credentials configuration

**Environment Variables (`.env`) contain:**
- `OPENAI_API_KEY`: Required for OpenAI models and embeddings
- Plugin API keys: `JIRA_API_TOKEN`, `BRAVE_API_KEY`, `SLACK_USER_TOKEN`, etc.
- GitHub app credentials: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
- Service account files: `GOOGLE_CREDENTIALS_FILE`

#### Configuration Validation

Aurora automatically validates your `config.json` file against a JSON schema when starting up:
- Invalid configurations automatically fall back to safe defaults
- Configuration errors are logged for easy debugging
- Runtime validation prevents invalid configuration changes
- You can validate your current config anytime using the config manager

---

## 🏃 Running Aurora

After installation and configuration:

```bash
python main.py
```

The assistant will start with your configured settings. The first run may take longer as it downloads and initializes models.

---

## 🔍 Troubleshooting

### Python Version Issues

Aurora requires Python 3.9-3.11. Python 3.12+ causes dependency conflicts with `tflite-runtime`, `openwakeword`, and audio/ML libraries.

**Our setup scripts automatically check and reject incompatible versions with helpful guidance.**

**Check your Python version:**
```bash
python --version  # or python3 --version
```

**If you have Python 3.12+, install a compatible version:**

**Linux (using pyenv):**
```bash
# Install pyenv if needed
curl https://pyenv.run | bash

# Install and use Python 3.11
pyenv install 3.11.10
pyenv local 3.11.10
```

**macOS:**
```bash
# Using Homebrew
brew install python@3.11

# Using pyenv
brew install pyenv
pyenv install 3.11.10
pyenv local 3.11.10
```

**Windows:**
- Download Python 3.11 from [python.org](https://www.python.org/downloads/)
- Or use Microsoft Store (search for "Python 3.11")

### Audio Dependencies

**Linux:**
```bash
sudo apt install portaudio19-dev python3-dev
# or for Red Hat/CentOS
sudo yum install portaudio-devel python3-devel
```

**macOS:**
```bash
brew install portaudio
brew link portaudio
```

**Windows:**
- PyAudio wheel should install automatically
- If issues persist: `pip install pipwin && pipwin install pyaudio`

### GPU and Hardware Acceleration Issues

#### CUDA Issues
```bash
# Check CUDA installation
nvidia-smi

# Verify PyTorch CUDA (after Aurora installation)
python -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}')"

# Check installed PyTorch version
python -c "import torch; print(f'PyTorch version: {torch.__version__}')"

# Reinstall PyTorch with specific CUDA version
python scripts/wheel_installer.py --package pytorch --hardware cuda
python scripts/wheel_installer.py --package pytorch --hardware cuda --legacy-torch  # For CUDA 11.8
```

#### ROCm Issues (AMD GPU)
```bash
# Check ROCm installation
rocm-smi

# Verify PyTorch ROCm
python -c "import torch; print(f'ROCm available: {torch.cuda.is_available()}')"

# Reinstall for ROCm
python scripts/wheel_installer.py --package pytorch --hardware rocm
```

#### Metal Issues (Apple Silicon)
```bash
# Check Metal support
python -c "import torch; print(f'MPS available: {torch.backends.mps.is_available()}')"

# Reinstall for Metal
python scripts/wheel_installer.py --package pytorch --hardware metal
```

### Installation Issues

#### Permission Errors
```bash
# Use pip user install (avoid sudo/administrator)
pip install --user -e .[third-party]

# Or use virtual environment
python -m venv aurora_env
source aurora_env/bin/activate  # Linux/macOS
# or
aurora_env\Scripts\activate  # Windows
pip install -e .[third-party]
```

#### Package Conflicts
```bash
# Clean install in new virtual environment
python -m venv fresh_aurora_env
source fresh_aurora_env/bin/activate  # Linux/macOS
# or
fresh_aurora_env\Scripts\activate  # Windows

# Install Aurora
pip install -e .[third-party]
```

#### Wheel Installation Issues
```bash
# Force reinstall with no cache
pip install --no-cache-dir --force-reinstall -e .[third-party]

# Use wheel installer for troubleshooting
python scripts/wheel_installer.py --hardware cpu --verbose

# Check wheel installer help
python scripts/wheel_installer.py --help
```

### Configuration Issues

#### Config Validation Errors
- Aurora automatically falls back to safe defaults if `config.json` is invalid
- Check console output for validation error details
- You can validate config manually: `python -c "from config_manager import ConfigManager; ConfigManager().validate()"`

#### Environment Variables
```bash
# Check if .env file exists
ls -la .env

# Copy example if needed
cp .env.example .env

# Edit with your API keys
nano .env  # or your preferred editor
```

### Performance Issues

#### High Memory Usage
- Use smaller models (e.g., Gemma 2B instead of Llama 7B)
- Enable GPU acceleration to offload processing
- Close other applications to free RAM

#### Slow Startup
- First run downloads models automatically
- Subsequent runs should be faster
- Consider using SSD storage for model files

#### Audio Issues
- Check microphone permissions in system settings
- Test audio with: `python -c "import pyaudio; print('✅ Audio working')"`
- Adjust microphone sensitivity in config.json

---

## 📚 Additional Resources

- **Main Documentation**: [README.md](../readme.md)
- **Python Version Compatibility**: Python 3.10-3.11 is required; see this install guide and [`DEPENDENCIES.md`](DEPENDENCIES.md).
- **Model Information**: 
  - [Dependency Guide](DEPENDENCIES.md)
  - [Voice Models README](../voice_models/README.md)
- **Issues & Support**: [GitHub Issues](https://github.com/joaojhgs/aurora/issues)

---

## 🎉 Quick Reference

| User Type | Recommended Method | Command |
|-----------|-------------------|---------|
| **First-time User** | Guided Setup | `./setup.sh` (Linux/macOS) or `setup.bat` (Windows) |
| **Developer** | Development Install | `pip install -e .[dev-local-gpu]` |
| **API User** | Third-party APIs | `pip install -e .[third-party]` |
| **Privacy-focused** | Local Models | `pip install -e .[local-huggingface-gpu]` |
| **Advanced User** | Manual Wheels | `python scripts/wheel_installer.py --hardware cuda` |

Choose the method that best fits your use case and technical expertise!
