# Orchestrator Service LLM Provider Modes

The orchestrator service supports multiple LLM provider modes with different Docker image sizes:

## LLM Provider Modes

### 1. OpenAI (Default)
- **Image Size**: ~200MB
- **Dependencies**: langchain-core, langchain-openai, langgraph, Jinja2
- **Configuration**: Set `general.llm.provider=openai` in `config.json`
- **Use Case**: When you have OpenAI API access and want a smaller, faster image

### 2. HuggingFace Endpoint
- **Image Size**: ~250MB
- **Dependencies**: Above + langchain-huggingface (endpoint only)
- **Configuration**: Set `general.llm.provider=huggingface_endpoint` in `config.json`
- **Use Case**: When you have HuggingFace endpoint API access

### 3. HuggingFace Local Pipeline
- **Image Size**: ~7GB
- **Dependencies**: Above + langchain-huggingface (pipeline) + torch + transformers + sentence-transformers
- **Configuration**: Set `general.llm.provider=huggingface_pipeline` in `config.json`
- **Use Case**: When you want to run HuggingFace models locally without API calls

### 4. Llama.cpp CPU
- **Image Size**: ~700MB
- **Dependencies**: Above + llama-cpp-python (CPU)
- **Configuration**: Set `general.llm.provider=llama_cpp` in `config.json`
- **Use Case**: When you want to run llama.cpp models locally on CPU

### 5. Llama.cpp CUDA
- **Image Size**: ~700MB
- **Dependencies**: Above + llama-cpp-python[cuda]
- **Configuration**: Set `general.llm.provider=llama_cpp` in `config.json` with CUDA support
- **Use Case**: When you want to run llama.cpp models locally with GPU acceleration

## Docker Usage

### Using Build Args (Recommended)

#### OpenAI (Default)
```bash
# Build with OpenAI (default)
docker-compose -f docker-compose.process.yml build orchestrator-service

# Or explicitly set the mode
ORCHESTRATOR_LLM_MODE=openai docker-compose -f docker-compose.process.yml build orchestrator-service
```

#### HuggingFace Endpoint
```bash
# Build with HuggingFace endpoint
ORCHESTRATOR_LLM_MODE=huggingface-endpoint docker-compose -f docker-compose.process.yml build orchestrator-service
```

#### HuggingFace Local Pipeline
```bash
# Build with local HuggingFace pipeline
ORCHESTRATOR_LLM_MODE=huggingface-local docker-compose -f docker-compose.process.yml build orchestrator-service

# Or set it in your shell environment
export ORCHESTRATOR_LLM_MODE=huggingface-local
docker-compose -f docker-compose.process.yml build orchestrator-service
```

#### Llama.cpp CPU
```bash
# Build with llama.cpp CPU
ORCHESTRATOR_LLM_MODE=llama-cpp docker-compose -f docker-compose.process.yml build orchestrator-service
```

#### Llama.cpp CUDA
```bash
# Build with llama.cpp CUDA
ORCHESTRATOR_LLM_MODE=llama-cpp-cuda docker-compose -f docker-compose.process.yml build orchestrator-service
```

### Using Makefile

```bash
# OpenAI (default)
make docker-orchestrator-build-openai

# HuggingFace endpoint
make docker-orchestrator-build-hf-endpoint

# HuggingFace local
make docker-orchestrator-build-hf-local

# Llama.cpp CPU
make docker-orchestrator-build-llama-cpp

# Llama.cpp CUDA
make docker-orchestrator-build-llama-cpp-cuda
```

### Using Direct Docker Build

```bash
# OpenAI
docker build --build-arg ORCHESTRATOR_LLM_MODE=openai -f docker/services/Dockerfile.orchestrator -t aurora-orchestrator:openai .

# HuggingFace local
docker build --build-arg ORCHESTRATOR_LLM_MODE=huggingface-local -f docker/services/Dockerfile.orchestrator -t aurora-orchestrator:hf-local .
```

## Configuration

The LLM provider mode is controlled by `config.json`:

```json
{
  "general": {
    "llm": {
      "provider": "openai"  // Options: "openai", "huggingface_endpoint", "huggingface_pipeline", "llama_cpp"
    }
  }
}
```

**Important**: The Docker image must match your configuration:
- If `provider=openai`: Use `ORCHESTRATOR_LLM_MODE=openai` (or default)
- If `provider=huggingface_endpoint`: Use `ORCHESTRATOR_LLM_MODE=huggingface-endpoint`
- If `provider=huggingface_pipeline`: Use `ORCHESTRATOR_LLM_MODE=huggingface-local`
- If `provider=llama_cpp`: Use `ORCHESTRATOR_LLM_MODE=llama-cpp` or `llama-cpp-cuda`

## Size Comparison

| Mode | Image Size | Dependencies | Build Time |
|------|-----------|--------------|------------|
| OpenAI | ~200MB | Minimal | Fast (~2-3 min) |
| HuggingFace Endpoint | ~250MB | Minimal + endpoint client | Fast (~2-3 min) |
| HuggingFace Local | ~7GB | torch, transformers, sentence-transformers | Slow (~10-15 min) |
| Llama.cpp CPU | ~700MB | llama-cpp-python | Medium (~5-7 min) |
| Llama.cpp CUDA | ~700MB | llama-cpp-python[cuda] | Medium (~5-7 min) |

## Switching Between Modes

### From OpenAI to HuggingFace Local
1. Update `config.json`: Set `general.llm.provider=huggingface_pipeline`
2. Rebuild orchestrator: `ORCHESTRATOR_LLM_MODE=huggingface-local docker-compose -f docker-compose.process.yml build orchestrator-service`
3. Restart: `docker-compose -f docker-compose.process.yml up -d orchestrator-service`

### From HuggingFace Local to OpenAI
1. Update `config.json`: Set `general.llm.provider=openai`
2. Rebuild orchestrator: `ORCHESTRATOR_LLM_MODE=openai docker-compose -f docker-compose.process.yml build orchestrator-service`
3. Restart: `docker-compose -f docker-compose.process.yml up -d orchestrator-service`

## Troubleshooting

### Error: "langchain-huggingface is required for HuggingFace endpoint but not installed"
- **Cause**: Using HuggingFace endpoint mode but Docker image was built with OpenAI mode
- **Solution**: Rebuild with `ORCHESTRATOR_LLM_MODE=huggingface-endpoint`

### Error: "Missing dependencies for HuggingFace Pipeline"
- **Cause**: Using HuggingFace pipeline mode but Docker image was built without local dependencies
- **Solution**: Rebuild with `ORCHESTRATOR_LLM_MODE=huggingface-local`

### Error: "Missing dependencies for Llama.cpp"
- **Cause**: Using llama.cpp mode but llama-cpp-python is not installed
- **Solution**: Rebuild with `ORCHESTRATOR_LLM_MODE=llama-cpp` or `llama-cpp-cuda`

### Error: "OpenAI API key not found"
- **Cause**: Using OpenAI mode but no API key configured
- **Solution**: Set `OPENAI_API_KEY` environment variable or configure in `config.json`

## Recommendations

1. **Default to OpenAI** for smaller images and faster builds
2. **Use HuggingFace endpoint** when you have endpoint API access (still lightweight)
3. **Use HuggingFace local** only when:
   - You don't have API access
   - You need offline operation
   - You have sufficient disk space and build time
4. **Use llama.cpp** when you want local models with smaller footprint than HuggingFace

## Environment Variables

You can set `ORCHESTRATOR_LLM_MODE` as an environment variable:

```bash
# In .env file or export
export ORCHESTRATOR_LLM_MODE=huggingface-local

# Then use normally
docker-compose -f docker-compose.process.yml up -d
```

