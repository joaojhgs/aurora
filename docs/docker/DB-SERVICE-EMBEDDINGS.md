# DB Service Embeddings Configuration

The DB service supports two embedding modes with different Docker image sizes:

## Embedding Modes

### 1. OpenAI Embeddings (Default)
- **Image Size**: ~500MB
- **Dependencies**: Minimal (aiosqlite, sqlite-vec, SQLAlchemy, langchain, langchain-community, langgraph)
- **Configuration**: Set `services.db.embeddings.use_local=false` in `config.json`
- **Use Case**: When you have OpenAI API access and want a smaller, faster image

### 2. Local Embeddings
- **Image Size**: ~8GB
- **Dependencies**: Above + langchain-huggingface + torch + transformers + sentence-transformers
- **Configuration**: Set `services.db.embeddings.use_local=true` in `config.json`
- **Use Case**: When you want to run embeddings locally without API calls

## Docker Usage

### Using Config-Driven Make Targets (Recommended)

#### OpenAI Embeddings (Default)
```bash
# Build from services.db.embeddings.use_local in config.json
make docker-db-build

# Or explicitly build the OpenAI variant
make docker-db-build-openai
```

#### Local Embeddings
```bash
# Build from services.db.embeddings.use_local in config.json
make docker-db-build

# Or explicitly build the local variant
make docker-db-build-local
```

### Using Direct Docker Build

#### OpenAI Embeddings
```bash
docker build --build-arg DB_EMBEDDINGS_MODE=openai -f docker/services/Dockerfile.db -t aurora-db:openai .
```

#### Local Embeddings
```bash
docker build --build-arg DB_EMBEDDINGS_MODE=local -f docker/services/Dockerfile.db -t aurora-db:local .
```

## Configuration

The embedding mode is controlled by `config.json`:

```json
{
  "services": {
    "db": {
      "embeddings": {
        "use_local": false
      }
    }
  }
}
```

**Important**: The Docker image must match your configuration:
- If `use_local=false`: `make docker-db-build` emits `DB_EMBEDDINGS_MODE=openai`
- If `use_local=true`: `make docker-db-build` emits `DB_EMBEDDINGS_MODE=local`

## Size Comparison

| Mode | Image Size | Dependencies | Build Time |
|------|-----------|--------------|------------|
| OpenAI | ~500MB | Minimal | Fast (~2-3 min) |
| Local | ~8GB | torch, transformers, sentence-transformers | Slow (~10-15 min) |

## Switching Between Modes

### From OpenAI to Local
1. Update `config.json`: Set `services.db.embeddings.use_local=true`
2. Rebuild DB service: `make docker-db-build`
3. Restart: `make docker-process-up`

### From Local to OpenAI
1. Update `config.json`: Set `services.db.embeddings.use_local=false`
2. Rebuild DB service: `make docker-db-build`
3. Restart: `make docker-process-up`

## Troubleshooting

### Error: "langchain-huggingface is required for local embeddings but not installed"
- **Cause**: Using local embeddings mode but Docker image was built with OpenAI embeddings
- **Solution**: Rebuild with `DB_EMBEDDINGS_MODE=local`

### Error: "OpenAI API key not found"
- **Cause**: Using OpenAI embeddings mode but no API key configured
- **Solution**: Set `OPENAI_API_KEY` environment variable or configure in `config.json`

## Recommendations

1. **Default to OpenAI embeddings** for smaller images and faster builds
2. **Use local embeddings** only when:
   - You don't have OpenAI API access
   - You need offline operation
   - You have sufficient disk space and build time

## Inspect Generated Build Args

The supported Make/scripts workflows derive `DB_EMBEDDINGS_MODE` from config:

```bash
python scripts/config_to_docker_env.py --format env
```
