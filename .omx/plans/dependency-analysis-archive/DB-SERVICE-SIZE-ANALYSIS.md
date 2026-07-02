# DB Service Docker Image Size Analysis

**Date**: 2025-11-07  
**Issue**: DB service Docker image is ~8GB (largest of all services)

## Root Cause

The DB service includes `langchain-huggingface` which pulls in heavy ML dependencies:

1. **langchain-huggingface** → requires:
   - `sentence-transformers` (~500MB)
   - `transformers` (~200MB)
   - `tokenizers` (~50MB)
   - `huggingface-hub` (~20MB)

2. **sentence-transformers** → requires:
   - `torch` (PyTorch) - **~5-7GB** (the main culprit!)
   - `torchaudio` - **~500MB**
   - `torchvision` - **~200MB**
   - `numpy`, `scipy`, `scikit-learn`, etc.

**Total**: ~7-8GB just for local embeddings support

## When Are These Dependencies Used?

Looking at `app/services/db/rag_service.py`:

```python
def get_embeddings():
    use_local = config_api.get("general.embeddings.use_local", False)
    
    if use_local:
        from langchain_huggingface import HuggingFaceEmbeddings  # Only here!
        embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
    else:
        from langchain.embeddings import init_embeddings
        embeddings = init_embeddings("openai:text-embedding-3-small")
```

**Key Finding**: `langchain-huggingface` is only used when `general.embeddings.use_local=true`. When it's `false`, the service uses OpenAI embeddings which don't need these heavy dependencies.

## Current Default

From `config_defaults.json`:
```json
"embeddings": {
    "use_local": true
}
```

So by default, local embeddings are enabled, but this is configurable.

## Solution

### Option 1: Make Local Embeddings Optional (Recommended)

Move `langchain-huggingface` to an optional group:

```toml
service-db = [
    "aiosqlite>=0.19.0",
    "sqlite-vec",
    "SQLAlchemy==2.0.38",
    "langchain==0.3.25",
    "langchain-community==0.3.24",
    "langgraph==0.4.6",
    # langchain-huggingface moved to service-db-local-embeddings
]

service-db-local-embeddings = [
    "langchain-huggingface==0.2.0",
    # Pulls in: torch, transformers, sentence-transformers (~7GB)
]
```

**Dockerfile update**:
```dockerfile
# For DB service with local embeddings
RUN pip install --no-cache-dir -e .[service-db,service-db-local-embeddings,mode-processes]

# For DB service with OpenAI embeddings (default, much smaller)
RUN pip install --no-cache-dir -e .[service-db,mode-processes]
```

**Benefits**:
- DB service without local embeddings: ~500MB (vs 8GB)
- DB service with local embeddings: ~8GB (only when needed)
- User can choose based on their needs

### Option 2: Lazy Import with Better Error Message

Keep dependencies but make import lazy and provide clear error:

```python
def get_embeddings():
    use_local = config_api.get("general.embeddings.use_local", False)
    
    if use_local:
        try:
            from langchain_huggingface import HuggingFaceEmbeddings
        except ImportError:
            raise ImportError(
                "langchain-huggingface is required for local embeddings. "
                "Install with: pip install -e .[service-db-local-embeddings]"
            )
        embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
    else:
        from langchain.embeddings import init_embeddings
        embeddings = init_embeddings("openai:text-embedding-3-small")
```

### Option 3: Use Lighter Embedding Model

Use a lighter embedding solution that doesn't require PyTorch, but this would require code changes.

## Recommendation

**Use Option 1**: Make local embeddings optional. This allows:
- Smaller Docker images by default (when using OpenAI embeddings)
- Users can opt-in to local embeddings when needed
- Better resource utilization

## Implementation

1. Update `pyproject.toml` to move `langchain-huggingface` to optional group
2. Update DB service Dockerfile to conditionally install local embeddings
3. Update documentation to explain the choice
4. Update setup scripts to handle the optional dependency

## Size Comparison

| Configuration | Dependencies | Estimated Size |
|--------------|--------------|----------------|
| DB service (OpenAI embeddings) | aiosqlite, sqlite-vec, SQLAlchemy, langchain, langchain-community, langgraph | ~500MB |
| DB service (local embeddings) | Above + langchain-huggingface + torch + transformers + sentence-transformers | ~8GB |
| **Savings** | | **~7.5GB** |










