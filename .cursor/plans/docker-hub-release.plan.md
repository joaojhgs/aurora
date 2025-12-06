# Docker Hub Release Integration Plan

**Date**: 2025-11-07

**Status**: Planning Phase

## Overview

This plan outlines the integration of Docker Hub image building and publishing into the release workflow, including:

- Multi-variant service images (cloud vs local dependencies)
- Hardware acceleration variants (CPU, CUDA, ROCm, Metal, Vulkan, SYCL, RPC)
- Model file configuration via environment variables
- Docker Hub publishing automation
- Make commands for local builds
- Docker Compose support for variants

## Goals

1. **Automated Docker Hub Publishing**: Build and push service images to Docker Hub on release
2. **Multiple Image Variants**: Support cloud/local dependencies and hardware acceleration
3. **Model Configuration**: Allow users to specify model files via environment variables
4. **Easy User Setup**: Users can pull pre-built images with correct dependencies
5. **Hardware Flexibility**: Support different hardware backends for local inference

## Service Variants Analysis

### Services Requiring Variants

#### 1. **DB Service** (Already implemented)

- **Variants**: `openai`, `local`
- **Build Arg**: `DB_EMBEDDINGS_MODE`
- **Size**: ~500MB (openai) vs ~8GB (local)

#### 2. **Orchestrator Service** (Partially implemented)

- **Variants**: 
                                - `openai` (cloud API)
                                - `huggingface-endpoint` (cloud API)
                                - `huggingface-local` (local pipeline)
                                - `llama-cpp-cpu` (CPU inference)
                                - `llama-cpp-cuda` (CUDA inference)
                                - `llama-cpp-rocm` (ROCm inference)
                                - `llama-cpp-metal` (Metal inference - macOS)
                                - `llama-cpp-vulkan` (Vulkan inference)
                                - `llama-cpp-sycl` (SYCL inference - Intel)
                                - `llama-cpp-rpc` (RPC inference)
- **Build Arg**: `ORCHESTRATOR_LLM_MODE`
- **Hardware Build Args**: `ORCHESTRATOR_HARDWARE` (for llama-cpp variants)

#### 3. **TTS Service**

- **Variants**:
                                - `cpu` (CPU-only torch)
                                - `cuda` (CUDA torch)
                                - `rocm` (ROCm torch)
                                - `metal` (Metal torch - macOS)
- **Build Arg**: `TTS_HARDWARE`
- **Size**: ~2GB (CPU) vs ~3GB (GPU variants)

#### 4. **STT Transcription Service**

- **Variants**:
                                - `cpu` (CPU-only faster-whisper)
                                - `cuda` (CUDA faster-whisper)
- **Build Arg**: `STT_TRANSCRIPTION_HARDWARE`
- **Size**: ~1GB (CPU) vs ~2GB (CUDA)

#### 5. **STT Wakeword Service**

- **Variants**:
                                - `cpu` (CPU-only onnxruntime)
                                - `cuda` (CUDA onnxruntime)
- **Build Arg**: `STT_WAKEWORD_HARDWARE`
- **Size**: ~500MB (CPU) vs ~1GB (CUDA)

### Services Without Variants

- **Config Service**: No variants needed
- **Scheduler Service**: No variants needed
- **Tooling Service**: No variants needed
- **STT Audio Input Service**: No variants needed
- **STT Coordinator Service**: No variants needed

## Model File Configuration

### Current State

Model paths are currently read from `config.json` via ConfigAPI:

- **TTS**: `general.text_to_speech.model_file_path` and `model_config_file_path`
- **Wakeword**: `general.speech_to_text.wake_word.model_path`
- **Llama.cpp**: `general.llm.local.llama_cpp.options.model_path`
- **HuggingFace**: `general.llm.local.huggingface_pipeline.options.model`

### Proposed Solution

**Environment Variable Override Pattern**:

1. Services check environment variables first
2. Fall back to ConfigAPI if env vars not set
3. Support both absolute paths and paths relative to mounted volumes

**Environment Variables**:

- `AURORA_TTS_MODEL_FILE_PATH` - TTS model file path
- `AURORA_TTS_MODEL_CONFIG_FILE_PATH` - TTS model config file path
- `AURORA_WAKE_WORD_MODEL_PATH` - Wake word model path(s), comma-separated
- `AURORA_LLAMA_CPP_MODEL_PATH` - Llama.cpp model file path
- `AURORA_HUGGINGFACE_MODEL_ID` - HuggingFace model ID
- `AURORA_MODELS_DIR` - Base directory for model files (default: `/app/models`)

**Volume Mount Strategy**:

- Mount model directory: `./models:/app/models`
- Users can place model files in `./models/` directory
- Services look for models in `/app/models/` inside container

## Docker Hub Image Naming Convention

### Image Tag Structure

```
{registry}/{namespace}/{service}:{variant}-{hardware}-{version}
```

**Examples**:

- `docker.io/aurora-ai/aurora-db:openai-v1.0.0`
- `docker.io/aurora-ai/aurora-db:local-v1.0.0`
- `docker.io/aurora-ai/aurora-orchestrator:llama-cpp-cuda-v1.0.0`
- `docker.io/aurora-ai/aurora-orchestrator:llama-cpp-rocm-v1.0.0`
- `docker.io/aurora-ai/aurora-tts:cuda-v1.0.0`
- `docker.io/aurora-ai/aurora-tts:metal-v1.0.0`

**Latest Tags**:

- `{service}:{variant}-{hardware}-latest` - Latest release
- `{service}:{variant}-{hardware}` - Latest (shorthand)

### Registry Configuration

- **Docker Hub**: `docker.io/aurora-ai/` (or user-specified)
- **GitHub Container Registry**: `ghcr.io/{owner}/` (alternative)
- **Configurable**: Via workflow secrets

## Implementation Plan

### Phase 1: Model Configuration Support

#### 1.1 Update Services to Support Environment Variables

**Files to Update**:

- `app/services/tts/service.py` - Add env var support for model paths
- `app/services/stt_wakeword/service.py` - Add env var support for model path
- `app/services/orchestrator/agents/chatbot.py` - Add env var support for model paths
- `app/services/config/config_manager.py` - Add env var mapping for model paths

**Implementation**:

```python
# Example for TTS service
def _get_model_paths(self):
    """Get model paths from env vars or config."""
    model_file = os.getenv(
        "AURORA_TTS_MODEL_FILE_PATH",
        file_root + config_api.get("general.text_to_speech.model_file_path", "/models/voice/en_US-lessac-medium.onnx")
    )
    config_file = os.getenv(
        "AURORA_TTS_MODEL_CONFIG_FILE_PATH",
        file_root + config_api.get("general.text_to_speech.model_config_file_path", "/models/voice/en_US-lessac-medium.onnx.txt")
    )
    return model_file, config_file
```

#### 1.2 Update Config Manager

Add environment variable mappings:

```python
ENV_VAR_MAPPINGS = {
    # ... existing mappings ...
    "AURORA_TTS_MODEL_FILE_PATH": ("general.text_to_speech.model_file_path", str),
    "AURORA_TTS_MODEL_CONFIG_FILE_PATH": ("general.text_to_speech.model_config_file_path", str),
    "AURORA_WAKE_WORD_MODEL_PATH": ("general.speech_to_text.wake_word.model_path", str),
    "AURORA_LLAMA_CPP_MODEL_PATH": ("general.llm.local.llama_cpp.options.model_path", str),
    "AURORA_HUGGINGFACE_MODEL_ID": ("general.llm.local.huggingface_pipeline.options.model", str),
    "AURORA_MODELS_DIR": ("general.models_dir", str),
}
```

### Phase 2: Dockerfile Updates

#### 2.1 Update Orchestrator Dockerfile

**Add Hardware Acceleration Support**:

```dockerfile
ARG ORCHESTRATOR_LLM_MODE=openai
ARG ORCHESTRATOR_HARDWARE=cpu

# Install llama-cpp-python based on hardware
RUN if [[ "$ORCHESTRATOR_LLM_MODE" == llama-cpp-* ]]; then \
    case "$ORCHESTRATOR_HARDWARE" in \
        cuda) \
            pip install llama-cpp-python --extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cu124/ || \
            pip install llama-cpp-python[cuda]; \
            ;; \
        rocm) \
            pip install llama-cpp-python --extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/rocm/ || \
            CMAKE_ARGS="-DGGML_HIPBLAS=ON" pip install llama-cpp-python; \
            ;; \
        metal) \
            pip install llama-cpp-python --extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/metal/ || \
            CMAKE_ARGS="-DGGML_METAL=ON" pip install llama-cpp-python; \
            ;; \
        vulkan) \
            CMAKE_ARGS="-DGGML_VULKAN=ON" pip install llama-cpp-python; \
            ;; \
        sycl) \
            CMAKE_ARGS="-DGGML_SYCL=ON -DCMAKE_C_COMPILER=icx -DCMAKE_CXX_COMPILER=icpx" pip install llama-cpp-python; \
            ;; \
        rpc) \
            CMAKE_ARGS="-DGGML_RPC=ON" pip install llama-cpp-python; \
            ;; \
        *) \
            pip install llama-cpp-python --extra-index-url=https://abetlen.github.io/llama-cpp-python/whl/cpu/ || \
            CMAKE_ARGS="-DGGML_BLAS=ON -DGGML_BLAS_VENDOR=OpenBLAS" pip install llama-cpp-python; \
            ;; \
    esac; \
fi
```

#### 2.2 Create TTS Service Dockerfile Variants

**Add Hardware Build Arg**:

```dockerfile
ARG TTS_HARDWARE=cpu

# Install PyTorch based on hardware
RUN case "$TTS_HARDWARE" in \
    cuda) \
        pip install torch==2.6.0+cu124 torchaudio==2.6.0+cu124 torchvision==0.21.0+cu124 \
            --extra-index-url=https://download.pytorch.org/whl/cu124; \
        ;; \
    rocm) \
        pip install torch==2.6.0+rocm6.0 torchaudio==2.6.0+rocm6.0 \
            --extra-index-url=https://download.pytorch.org/whl/rocm6.0; \
        ;; \
    metal) \
        pip install torch==2.6.0 torchaudio==2.6.0 torchvision==0.21.0; \
        ;; \
    *) \
        pip install torch==2.6.0 torchaudio==2.6.0 torchvision==0.21.0; \
        ;; \
esac
```

#### 2.3 Create STT Transcription Service Dockerfile Variants

**Add Hardware Build Arg**:

```dockerfile
ARG STT_TRANSCRIPTION_HARDWARE=cpu

# faster-whisper uses ctranslate2 which supports CUDA
# CPU is default, CUDA requires ctranslate2 with CUDA support
RUN if [ "$STT_TRANSCRIPTION_HARDWARE" = "cuda" ]; then \
    pip install ctranslate2 --extra-index-url=https://pypi.org/simple/ || \
    pip install ctranslate2[cuda]; \
fi
```

#### 2.4 Create STT Wakeword Service Dockerfile Variants

**Add Hardware Build Arg**:

```dockerfile
ARG STT_WAKEWORD_HARDWARE=cpu

# onnxruntime supports GPU via providers
RUN if [ "$STT_WAKEWORD_HARDWARE" = "cuda" ]; then \
    pip install onnxruntime-gpu==1.20.1; \
else \
    pip install onnxruntime==1.20.1; \
fi
```

### Phase 3: Docker Compose Updates

#### 3.1 Add Build Args to docker-compose.process.yml

```yaml
services:
  db-service:
    build:
      context: .
      dockerfile: docker/services/Dockerfile.db
      args:
        DB_EMBEDDINGS_MODE: ${DB_EMBEDDINGS_MODE:-openai}
    
  orchestrator-service:
    build:
      context: .
      dockerfile: docker/services/Dockerfile.orchestrator
      args:
        ORCHESTRATOR_LLM_MODE: ${ORCHESTRATOR_LLM_MODE:-openai}
        ORCHESTRATOR_HARDWARE: ${ORCHESTRATOR_HARDWARE:-cpu}
    environment:
      - AURORA_LLAMA_CPP_MODEL_PATH=${AURORA_LLAMA_CPP_MODEL_PATH:-/app/models/llama/model.gguf}
      - AURORA_HUGGINGFACE_MODEL_ID=${AURORA_HUGGINGFACE_MODEL_ID:-}
    volumes:
      - ./models:/app/models  # Mount models directory
    
  tts-service:
    build:
      context: .
      dockerfile: docker/services/Dockerfile.tts
      args:
        TTS_HARDWARE: ${TTS_HARDWARE:-cpu}
    environment:
      - AURORA_TTS_MODEL_FILE_PATH=${AURORA_TTS_MODEL_FILE_PATH:-/app/models/voice/en_US-lessac-medium.onnx}
      - AURORA_TTS_MODEL_CONFIG_FILE_PATH=${AURORA_TTS_MODEL_CONFIG_FILE_PATH:-/app/models/voice/en_US-lessac-medium.onnx.txt}
    volumes:
      - ./models:/app/models
    
  stt-transcription-service:
    build:
      context: .
      dockerfile: docker/services/Dockerfile.transcription
      args:
        STT_TRANSCRIPTION_HARDWARE: ${STT_TRANSCRIPTION_HARDWARE:-cpu}
    
  stt-wakeword-service:
    build:
      context: .
      dockerfile: docker/services/Dockerfile.wakeword
      args:
        STT_WAKEWORD_HARDWARE: ${STT_WAKEWORD_HARDWARE:-cpu}
    environment:
      - AURORA_WAKE_WORD_MODEL_PATH=${AURORA_WAKE_WORD_MODEL_PATH:-/app/models/wakeword/jarvis.onnx}
    volumes:
      - ./models:/app/models
```

### Phase 4: Make Commands

#### 4.1 Add Make Targets for Docker Builds

```makefile
# Docker Hub configuration
DOCKER_REGISTRY ?= docker.io
DOCKER_NAMESPACE ?= aurora-ai
VERSION ?= $(shell python -c "import tomllib; f=open('pyproject.toml','rb'); print(tomllib.load(f)['project']['version'])")

# Build all service images
docker-build-all:
	@echo "Building all service images..."
	$(MAKE) docker-build-config
	$(MAKE) docker-build-db-openai
	$(MAKE) docker-build-db-local
	$(MAKE) docker-build-orchestrator-openai
	$(MAKE) docker-build-orchestrator-hf-endpoint
	$(MAKE) docker-build-orchestrator-hf-local
	$(MAKE) docker-build-orchestrator-llama-cpu
	$(MAKE) docker-build-orchestrator-llama-cuda
	$(MAKE) docker-build-tts-cpu
	$(MAKE) docker-build-tts-cuda
	$(MAKE) docker-build-stt-transcription-cpu
	$(MAKE) docker-build-stt-transcription-cuda
	$(MAKE) docker-build-stt-wakeword-cpu
	$(MAKE) docker-build-stt-wakeword-cuda
	# ... other services

# DB Service builds
docker-build-db-openai:
	docker build --build-arg DB_EMBEDDINGS_MODE=openai \
		-f docker/services/Dockerfile.db \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-latest \
		.

docker-build-db-local:
	docker build --build-arg DB_EMBEDDINGS_MODE=local \
		-f docker/services/Dockerfile.db \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:local-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:local-latest \
		.

# Orchestrator Service builds
docker-build-orchestrator-openai:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=openai \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:openai-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:openai-latest \
		.

docker-build-orchestrator-llama-cuda:
	docker build --build-arg ORCHESTRATOR_LLM_MODE=llama-cpp \
		--build-arg ORCHESTRATOR_HARDWARE=cuda \
		-f docker/services/Dockerfile.orchestrator \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cuda-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-orchestrator:llama-cpp-cuda-latest \
		.

# TTS Service builds
docker-build-tts-cpu:
	docker build --build-arg TTS_HARDWARE=cpu \
		-f docker/services/Dockerfile.tts \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cpu-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cpu-latest \
		.

docker-build-tts-cuda:
	docker build --build-arg TTS_HARDWARE=cuda \
		-f docker/services/Dockerfile.tts \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cuda-$(VERSION) \
		-t $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-tts:cuda-latest \
		.

# Push commands
docker-push-all:
	@echo "Pushing all service images to $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)..."
	$(MAKE) docker-push-config
	$(MAKE) docker-push-db-openai
	$(MAKE) docker-push-db-local
	# ... other services

docker-push-db-openai:
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-$(VERSION)
	docker push $(DOCKER_REGISTRY)/$(DOCKER_NAMESPACE)/aurora-db:openai-latest

# Login command
docker-login:
	@echo "Logging in to $(DOCKER_REGISTRY)..."
	@docker login $(DOCKER_REGISTRY) -u $(DOCKER_USERNAME) -p $(DOCKER_PASSWORD)
```

### Phase 5: GitHub Actions Workflow Integration

#### 5.1 Add Docker Build Job to release.yml

```yaml
  # Job 7: Build and push Docker images
  docker-build:
    name: 🐳 Build Docker Images
    needs: [validate]
    if: needs.validate.outputs.should_release == 'true' && github.event.inputs.dry_run != 'true'
    runs-on: ubuntu-latest
    strategy:
      matrix:
        service:
          - name: config
            variants: [default]
          - name: db
            variants: [openai, local]
          - name: orchestrator
            variants: [openai, huggingface-endpoint, huggingface-local, llama-cpp-cpu, llama-cpp-cuda, llama-cpp-rocm, llama-cpp-metal]
          - name: tts
            variants: [cpu, cuda, rocm, metal]
          - name: stt-transcription
            variants: [cpu, cuda]
          - name: stt-wakeword
            variants: [cpu, cuda]
          - name: scheduler
            variants: [default]
          - name: tooling
            variants: [default]
          - name: stt-audio-input
            variants: [default]
          - name: stt-coordinator
            variants: [default]
    steps:
      - name: 📥 Checkout repository
        uses: actions/checkout@v4

      - name: 🐳 Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: 🔐 Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: 🏗️ Build and push Docker image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/services/Dockerfile.${{ matrix.service.name }}
          push: true
          tags: |
            docker.io/aurora-ai/aurora-${{ matrix.service.name }}:${{ matrix.variant }}-${{ needs.validate.outputs.next_version }}
            docker.io/aurora-ai/aurora-${{ matrix.service.name }}:${{ matrix.variant }}-latest
          build-args: |
            ${{ matrix.service.build_args }}
          cache-from: type=registry,ref=docker.io/aurora-ai/aurora-${{ matrix.service.name }}:${{ matrix.variant }}-latest
          cache-to: type=inline
```

**Note**: This is a simplified version. The actual implementation needs to handle:

- Different build args per variant
- Conditional hardware acceleration builds
- Multi-platform builds (if needed)
- Build caching optimization

### Phase 6: Documentation

#### 6.1 Create Docker Hub Usage Guide

**File**: `docs/docker/DOCKER-HUB-USAGE.md`

**Content**:

- How to pull pre-built images
- Image naming conventions
- Variant selection guide
- Model file configuration
- Environment variable reference
- Example docker-compose.yml configurations

#### 6.2 Update Installation Documentation

**Files to Update**:

- `docs/INSTALL.md` - Add Docker Hub installation option
- `README.md` - Add quick start with Docker Hub images

## Implementation Checklist

### Phase 1: Model Configuration

- [ ] Update TTS service to support env vars
- [ ] Update Wakeword service to support env vars
- [ ] Update Orchestrator service to support env vars
- [ ] Update Config Manager with env var mappings
- [ ] Test model path resolution (env vars > config)

### Phase 2: Dockerfile Updates

- [ ] Update Orchestrator Dockerfile with hardware variants
- [ ] Update TTS Dockerfile with hardware variants
- [ ] Update STT Transcription Dockerfile with hardware variants
- [ ] Update STT Wakeword Dockerfile with hardware variants
- [ ] Test all Dockerfile builds locally

### Phase 3: Docker Compose

- [ ] Add build args to docker-compose.process.yml
- [ ] Add environment variables for model paths
- [ ] Add volume mounts for models directory
- [ ] Test docker-compose builds

### Phase 4: Make Commands

- [ ] Add docker-build-* targets for all services/variants
- [ ] Add docker-push-* targets
- [ ] Add docker-login target
- [ ] Add docker-build-all target
- [ ] Add docker-push-all target
- [ ] Test all make commands

### Phase 5: GitHub Actions

- [ ] Add docker-build job to release.yml
- [ ] Configure Docker Hub secrets
- [ ] Test workflow in dry-run mode
- [ ] Optimize build caching
- [ ] Add build status reporting

### Phase 6: Documentation

- [ ] Create Docker Hub usage guide
- [ ] Update installation documentation
- [ ] Add example configurations
- [ ] Create troubleshooting guide

## Testing Strategy

### Local Testing

1. Build all variants locally using Make commands
2. Test model file resolution with env vars
3. Test docker-compose with different variants
4. Verify image sizes are reasonable

### CI/CD Testing

1. Test Docker builds in PR workflow (dry-run)
2. Test full release workflow with Docker Hub push
3. Verify all variants are built and pushed
4. Test pulling images from Docker Hub

## Future Enhancements

1. **Multi-platform Builds**: Support ARM64, AMD64
2. **Image Scanning**: Security scanning before push
3. **Image Signing**: Sign images for verification
4. **Automated Testing**: Test images after build
5. **Image Size Optimization**: Further optimize image sizes
6. **Build Matrix Optimization**: Parallel builds where possible

## Related Documentation

- [Docker Service Optimization](./DB-SERVICE-OPTIMIZATION.md)
- [Orchestrator Service Optimization](./ORCHESTRATOR-SERVICE-SIZE-ANALYSIS.md)
- [Dependency Restructuring Plan](./dependency-restructure.plan.md)






