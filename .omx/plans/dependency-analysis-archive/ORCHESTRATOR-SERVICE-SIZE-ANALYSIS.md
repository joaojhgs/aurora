# Orchestrator Service Docker Image Size Analysis

**Date**: 2025-11-07  
**Issue**: Orchestrator service includes all LLM provider dependencies, making it unnecessarily large

## Root Cause

The orchestrator service includes dependencies for all LLM providers:
- `langchain-openai` - Lightweight (~50MB) - API client only
- `langchain-huggingface` - Variable size:
  - For `huggingface_endpoint`: Lightweight (~50MB) - API client only
  - For `huggingface_pipeline`: Heavy (~7GB) - Requires torch, transformers, sentence-transformers
- `llama-cpp` / `llama-cpp-cuda` - Heavy (~500MB-1GB) - Local model inference

**Current**: All dependencies included regardless of which provider is used.

## When Are These Dependencies Used?

Looking at `app/services/orchestrator/agents/chatbot.py`:

```python
provider = config_api.get("general.llm.provider", "openai")

if provider == "openai":
    from langchain_openai import ChatOpenAI  # Lightweight API client

elif provider == "huggingface_endpoint":
    from langchain_huggingface import ChatHuggingFace, HuggingFaceEndpoint  # Lightweight API client

elif provider == "huggingface_pipeline":
    from langchain_huggingface import ChatHuggingFace, HuggingFacePipeline  # Heavy - requires torch

elif provider == "llama_cpp":
    from app.services.orchestrator.chat_llama_cpp import ChatLlamaCpp  # Heavy - requires llama-cpp-python
```

**Key Findings**:
- `langchain-openai`: Always lightweight (API client)
- `langchain-huggingface`: 
  - Lightweight for endpoint mode (API client)
  - Heavy for pipeline mode (requires torch/transformers ~7GB)
- `llama-cpp`: Heavy (~500MB-1GB) - only needed for local llama.cpp models

## Size Breakdown

| Provider | Dependencies | Estimated Size |
|----------|-------------|----------------|
| **openai** (default) | langchain-openai | ~50MB |
| **huggingface_endpoint** | langchain-huggingface (endpoint only) | ~50MB |
| **huggingface_pipeline** | langchain-huggingface + torch + transformers | ~7GB |
| **llama_cpp** (CPU) | llama-cpp-python | ~500MB-1GB |
| **llama_cpp** (CUDA) | llama-cpp-python[cuda] | ~500MB-1GB |

## Solution

Split dependencies into optional groups:

1. **Base orchestrator** (always included):
   - `langchain-core`
   - `langchain-openai` (lightweight, default provider)
   - `langgraph`
   - `Jinja2`
   - `typing-extensions`

2. **Optional groups**:
   - `service-orchestrator-huggingface-endpoint` - For HuggingFace endpoint (lightweight)
   - `service-orchestrator-huggingface-local` - For HuggingFace pipeline (heavy, includes torch)
   - `service-orchestrator-llama-cpp` - For llama.cpp CPU
   - `service-orchestrator-llama-cpp-cuda` - For llama.cpp CUDA

## Size Comparison

| Configuration | Size | Dependencies |
|--------------|------|--------------|
| **Orchestrator (OpenAI)** | ~200MB | langchain-core, langchain-openai, langgraph, Jinja2 |
| **Orchestrator (HuggingFace Endpoint)** | ~250MB | Above + langchain-huggingface (endpoint) |
| **Orchestrator (HuggingFace Pipeline)** | ~7GB | Above + langchain-huggingface (pipeline) + torch + transformers |
| **Orchestrator (llama.cpp CPU)** | ~700MB | Above + llama-cpp-python |
| **Orchestrator (llama.cpp CUDA)** | ~700MB | Above + llama-cpp-python[cuda] |

## Benefits

1. **Smaller default images**: Orchestrator is ~200MB instead of ~7GB when using OpenAI
2. **User choice**: Users can opt-in to local models when needed
3. **Better resource utilization**: Only install heavy dependencies when actually used
4. **Faster builds**: Smaller images build faster










