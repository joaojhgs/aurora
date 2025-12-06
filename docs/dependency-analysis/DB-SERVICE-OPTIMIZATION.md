# DB Service Docker Image Size Optimization

**Date**: 2025-11-07  
**Issue**: DB service Docker image is ~8GB (largest of all services)

## Problem

The DB service includes `langchain-huggingface` which pulls in:
- **torch** (PyTorch): ~5-7GB
- **torchaudio**: ~500MB
- **torchvision**: ~200MB
- **transformers**: ~200MB
- **sentence-transformers**: ~500MB
- **Other ML dependencies**: ~500MB

**Total**: ~7-8GB

## Root Cause

`langchain-huggingface` is only used when `general.embeddings.use_local=true`. When `false`, the service uses OpenAI embeddings which don't need these dependencies.

## Solution Implemented

Moved `langchain-huggingface` to an optional group: `service-db-local-embeddings`

### Before
```toml
service-db = [
    "langchain-huggingface==0.2.0",  # Always included (~7GB)
    # ...
]
```

### After
```toml
service-db = [
    # langchain-huggingface moved to optional group
    # ...
]

service-db-local-embeddings = [
    "langchain-huggingface==0.2.0",  # Only when needed
]
```

## Size Comparison

| Configuration | Size | Dependencies |
|--------------|------|--------------|
| **DB service (OpenAI embeddings)** | ~500MB | aiosqlite, sqlite-vec, SQLAlchemy, langchain, langchain-community, langgraph |
| **DB service (local embeddings)** | ~8GB | Above + langchain-huggingface + torch + transformers + sentence-transformers |
| **Savings** | **~7.5GB** | When using OpenAI embeddings |

## Usage

### Docker (OpenAI embeddings - default, smaller)
```dockerfile
RUN pip install --no-cache-dir -e .[service-db,mode-processes]
```

### Docker (Local embeddings - when needed)
```dockerfile
RUN pip install --no-cache-dir -e .[service-db,service-db-local-embeddings,mode-processes]
```

### Python (OpenAI embeddings - default)
```bash
pip install -e .[service-db,mode-processes]
```

### Python (Local embeddings - when needed)
```bash
pip install -e .[service-db,service-db-local-embeddings,mode-processes]
```

## Configuration

The DB service checks `general.embeddings.use_local`:
- `true`: Uses local HuggingFace embeddings (requires `service-db-local-embeddings`)
- `false`: Uses OpenAI embeddings (doesn't need `service-db-local-embeddings`)

## Benefits

1. **Smaller default images**: DB service is ~500MB instead of ~8GB when using OpenAI embeddings
2. **User choice**: Users can opt-in to local embeddings when needed
3. **Better resource utilization**: Only install heavy dependencies when actually used
4. **Faster builds**: Smaller images build faster

## Migration

For existing deployments:
- If using OpenAI embeddings: No change needed (already smaller)
- If using local embeddings: Add `service-db-local-embeddings` to installation

## Next Steps

1. ✅ Moved `langchain-huggingface` to optional group
2. ⏭️ Update Dockerfile to conditionally install (or document the choice)
3. ⏭️ Update setup scripts to handle optional dependency
4. ⏭️ Update documentation










