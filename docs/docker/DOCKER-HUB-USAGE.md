# Docker Hub Usage Guide

This guide explains how to use pre-built Aurora Docker images from Docker Hub.

## Overview

Aurora provides pre-built Docker images for all services with multiple variants to support different hardware configurations and dependency requirements. These images are automatically built and published to Docker Hub on each release.

## Image Registry

**Default Registry**: `docker.io/aurora-ai/`

All images are published under the `aurora-ai` namespace on Docker Hub. You can configure a different namespace using the `DOCKER_NAMESPACE` secret in GitHub Actions.

## Image Naming Convention

### Tag Structure

```
{registry}/{namespace}/{service}:{variant}-{hardware}-{version}
```

### Examples

- `docker.io/aurora-ai/aurora-db:openai-v1.0.0`
- `docker.io/aurora-ai/aurora-db:local-v1.0.0`
- `docker.io/aurora-ai/aurora-orchestrator:llama-cpp-cuda-v1.0.0`
- `docker.io/aurora-ai/aurora-orchestrator:llama-cpp-rocm-v1.0.0`
- `docker.io/aurora-ai/aurora-tts:cuda-v1.0.0`
- `docker.io/aurora-ai/aurora-tts:metal-v1.0.0`

### Latest Tags

- `{service}:{variant}-{hardware}-latest` - Latest release
- `{service}:{variant}-{hardware}` - Latest (shorthand, same as above)

## Available Services and Variants

### Config Service

- **Image**: `aurora-ai/aurora-config:latest`
- **Variants**: None (single image)
- **Size**: ~200MB

### DB Service

- **Variants**:
  - `openai` - Uses OpenAI embeddings API (~500MB)
  - `local` - Uses local embeddings models (~8GB)
- **Build Arg**: `DB_EMBEDDINGS_MODE`

**Examples**:
```bash
docker pull aurora-ai/aurora-db:openai-latest
docker pull aurora-ai/aurora-db:local-latest
```

### Orchestrator Service

- **Variants**:
  - `openai` - OpenAI API (~200MB)
  - `huggingface-endpoint` - HuggingFace endpoint API (~250MB)
  - `huggingface-local` - Local HuggingFace pipeline (~7GB)
  - `llama-cpp-cpu` - Llama.cpp CPU inference (~700MB)
  - `llama-cpp-cuda` - Llama.cpp CUDA inference (~700MB)
  - `llama-cpp-rocm` - Llama.cpp ROCm inference (~700MB)
  - `llama-cpp-metal` - Llama.cpp Metal inference (~700MB, macOS)

**Examples**:
```bash
docker pull aurora-ai/aurora-orchestrator:openai-latest
docker pull aurora-ai/aurora-orchestrator:llama-cpp-cuda-latest
docker pull aurora-ai/aurora-orchestrator:llama-cpp-metal-latest
```

### TTS Service

- **Variants**:
  - `cpu` - CPU-only PyTorch (~2GB)
  - `cuda` - CUDA PyTorch (~3GB)
  - `rocm` - ROCm PyTorch (~3GB)
  - `metal` - Metal PyTorch (~2GB, macOS)

**Examples**:
```bash
docker pull aurora-ai/aurora-tts:cpu-latest
docker pull aurora-ai/aurora-tts:cuda-latest
docker pull aurora-ai/aurora-tts:metal-latest
```

### STT Transcription Service

- **Variants**:
  - `cpu` - CPU-only faster-whisper (~1GB)
  - `cuda` - CUDA faster-whisper (~2GB)

**Examples**:
```bash
docker pull aurora-ai/aurora-stt-transcription:cpu-latest
docker pull aurora-ai/aurora-stt-transcription:cuda-latest
```

### STT Wakeword Service

- **Variants**:
  - `cpu` - CPU-only onnxruntime (~500MB)
  - `cuda` - CUDA onnxruntime (~1GB)

**Examples**:
```bash
docker pull aurora-ai/aurora-stt-wakeword:cpu-latest
docker pull aurora-ai/aurora-stt-wakeword:cuda-latest
```

### Other Services

These services have no variants (single image each):

- `aurora-ai/aurora-scheduler:latest`
- `aurora-ai/aurora-tooling:latest`
- `aurora-ai/aurora-stt-audio-input:latest`
- `aurora-ai/aurora-stt-coordinator:latest`

## Pulling Images

### Pull Specific Image

```bash
docker pull aurora-ai/aurora-db:openai-latest
docker pull aurora-ai/aurora-orchestrator:llama-cpp-cuda-latest
docker pull aurora-ai/aurora-tts:cuda-latest
```

### Pull All Images for a Service

```bash
# Pull all DB service variants
docker pull aurora-ai/aurora-db:openai-latest
docker pull aurora-ai/aurora-db:local-latest

# Pull all TTS service variants
docker pull aurora-ai/aurora-tts:cpu-latest
docker pull aurora-ai/aurora-tts:cuda-latest
docker pull aurora-ai/aurora-tts:rocm-latest
docker pull aurora-ai/aurora-tts:metal-latest
```

## Model File Configuration

Aurora services support model file configuration via environment variables. This allows you to specify model paths without modifying the container image.

### Environment Variables

- `AURORA_TTS_MODEL_FILE_PATH` - TTS model file path
- `AURORA_TTS_MODEL_CONFIG_FILE_PATH` - TTS model config file path
- `AURORA_WAKE_WORD_MODEL_PATH` - Wake word model path(s), comma-separated
- `AURORA_LLAMA_CPP_MODEL_PATH` - Llama.cpp model file path
- `AURORA_HUGGINGFACE_MODEL_ID` - HuggingFace model ID
- `AURORA_MODELS_DIR` - Base directory for model files (default: `/app/models`)

### Volume Mount Strategy

Mount your local models directory to `/app/models` in the container:

```bash
docker run -v ./models:/app/models \
  -e AURORA_TTS_MODEL_FILE_PATH=/app/models/voice/en_US-lessac-medium.onnx \
  aurora-ai/aurora-tts:cpu-latest
```

### Example: Using Pre-built Images with Models

1. **Create models directory**:
   ```bash
   mkdir -p models/voice models/wakeword models/llama
   ```

2. **Download model files**:
   ```bash
   # Download TTS models
   wget -O models/voice/en_US-lessac-medium.onnx <model-url>
   wget -O models/voice/en_US-lessac-medium.onnx.txt <config-url>
   
   # Download wake word models
   wget -O models/wakeword/jarvis.onnx <wakeword-url>
   
   # Download Llama.cpp models
   wget -O models/llama/model.gguf <llama-model-url>
   ```

3. **Run services with models**:
   ```bash
   docker run -d \
     --name aurora-tts \
     -v $(pwd)/models:/app/models \
     -e AURORA_TTS_MODEL_FILE_PATH=/app/models/voice/en_US-lessac-medium.onnx \
     -e AURORA_TTS_MODEL_CONFIG_FILE_PATH=/app/models/voice/en_US-lessac-medium.onnx.txt \
     aurora-ai/aurora-tts:cpu-latest
   ```

## Docker Compose with Pre-built Images

You can use pre-built images in `docker-compose.yml` instead of building locally:

```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    # ... redis configuration

  db-service:
    image: aurora-ai/aurora-db:openai-latest
    environment:
      - AURORA_ENV=production
      - AURORA_ARCHITECTURE_MODE=processes
      - REDIS_URL=redis://redis:6379
    volumes:
      - ./data:/app/data
      - ./config:/app/config
      - ./models:/app/models
    depends_on:
      - redis

  orchestrator-service:
    image: aurora-ai/aurora-orchestrator:llama-cpp-cuda-latest
    environment:
      - AURORA_ENV=production
      - AURORA_ARCHITECTURE_MODE=processes
      - REDIS_URL=redis://redis:6379
      - AURORA_LLAMA_CPP_MODEL_PATH=/app/models/llama/model.gguf
    volumes:
      - ./data:/app/data
      - ./config:/app/config
      - ./models:/app/models
    depends_on:
      - db-service

  tts-service:
    image: aurora-ai/aurora-tts:cuda-latest
    environment:
      - AURORA_ENV=production
      - AURORA_ARCHITECTURE_MODE=processes
      - REDIS_URL=redis://redis:6379
      - AURORA_TTS_MODEL_FILE_PATH=/app/models/voice/en_US-lessac-medium.onnx
      - AURORA_TTS_MODEL_CONFIG_FILE_PATH=/app/models/voice/en_US-lessac-medium.onnx.txt
    volumes:
      - ./data:/app/data
      - ./config:/app/config
      - ./models:/app/models
    depends_on:
      - redis
```

## Variant Selection Guide

### Choosing the Right Variant

1. **DB Service**:
   - Use `openai` if you have OpenAI API access and want a smaller image
   - Use `local` if you want to run embeddings locally without API calls

2. **Orchestrator Service**:
   - Use `openai` for cloud-based LLM (smallest, requires API key)
   - Use `huggingface-endpoint` for HuggingFace cloud API
   - Use `huggingface-local` for local HuggingFace models (largest)
   - Use `llama-cpp-*` variants for local inference:
     - `llama-cpp-cpu` - CPU inference
     - `llama-cpp-cuda` - NVIDIA GPU
     - `llama-cpp-rocm` - AMD GPU
     - `llama-cpp-metal` - Apple Silicon (macOS)

3. **TTS Service**:
   - Use `cpu` for CPU-only systems
   - Use `cuda` for NVIDIA GPUs
   - Use `rocm` for AMD GPUs
   - Use `metal` for Apple Silicon (macOS)

4. **STT Services**:
   - Use `cpu` for CPU-only systems
   - Use `cuda` for NVIDIA GPUs (faster transcription)

## Troubleshooting

### Image Not Found

If you get an "image not found" error:

1. **Check the image name**: Ensure you're using the correct namespace (`aurora-ai`)
2. **Check the tag**: Verify the variant and version exist
3. **Check Docker Hub**: Visit https://hub.docker.com/r/aurora-ai/ to see available images

### Model Files Not Found

If services can't find model files:

1. **Check volume mounts**: Ensure `./models:/app/models` is mounted
2. **Check environment variables**: Verify model paths are set correctly
3. **Check file permissions**: Ensure model files are readable
4. **Use absolute paths**: Try using absolute paths in environment variables

### Hardware Acceleration Not Working

If GPU acceleration isn't working:

1. **Check variant**: Ensure you're using the correct hardware variant (e.g., `cuda`, `rocm`, `metal`)
2. **Check Docker runtime**: For CUDA, use `nvidia-docker` or Docker with GPU support
3. **Check device access**: Ensure GPU devices are accessible to containers
4. **Check logs**: Review container logs for hardware-related errors

### Performance Issues

If services are slow:

1. **Use GPU variants**: Switch to CUDA/ROCm/Metal variants if available
2. **Check resource limits**: Ensure containers have sufficient CPU/memory
3. **Check model size**: Larger models require more resources
4. **Check network**: For cloud APIs, ensure good network connectivity

## Updating Images

### Pull Latest Versions

```bash
# Pull latest version of a specific image
docker pull aurora-ai/aurora-db:openai-latest

# Pull specific version
docker pull aurora-ai/aurora-db:openai-v1.0.0
```

### Update All Images

```bash
# Update all images used in docker-compose
docker-compose pull

# Or manually update each service
docker pull aurora-ai/aurora-config:latest
docker pull aurora-ai/aurora-db:openai-latest
docker pull aurora-ai/aurora-orchestrator:openai-latest
# ... etc
```

## Related Documentation

- [Installation Guide](../INSTALL.md) - Full installation instructions
- [Docker Process Mode](../../README.process-mode.md) - Running Aurora in process mode
- [DB Service Embeddings](DB-SERVICE-EMBEDDINGS.md) - DB service configuration
- [Orchestrator LLM Modes](ORCHESTRATOR-SERVICE-LLM-MODES.md) - Orchestrator configuration








