# DB Service Embeddings Configuration

The DB service supports two embedding modes with different Docker image sizes:

## Embedding Modes

### 1. OpenAI Embeddings (Default)
- **Image Size**: ~500MB
- **Dependencies**: Minimal (aiosqlite, sqlite-vec, SQLAlchemy, langchain, langchain-community, langgraph)
- **Configuration**: Set `general.embeddings.use_local=false` in `config.json`
- **Use Case**: When you have OpenAI API access and want a smaller, faster image

### 2. Local Embeddings
- **Image Size**: ~8GB
- **Dependencies**: Above + langchain-huggingface + torch + transformers + sentence-transformers
- **Configuration**: Set `general.embeddings.use_local=true` in `config.json`
- **Use Case**: When you want to run embeddings locally without API calls

## Docker Usage

### Using Build Args (Recommended)

#### OpenAI Embeddings (Default)
```bash
# Build with OpenAI embeddings (default)
docker-compose -f docker-compose.process.yml build db-service

# Or explicitly set the mode
DB_EMBEDDINGS_MODE=openai docker-compose -f docker-compose.process.yml build db-service
```

#### Local Embeddings
```bash
# Build with local embeddings using environment variable
DB_EMBEDDINGS_MODE=local docker-compose -f docker-compose.process.yml build db-service

# Or set it in your shell environment
export DB_EMBEDDINGS_MODE=local
docker-compose -f docker-compose.process.yml build db-service
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
  "general": {
    "embeddings": {
      "use_local": false  // false = OpenAI, true = local
    }
  }
}
```

**Important**: The Docker image must match your configuration:
- If `use_local=false`: Use `DB_EMBEDDINGS_MODE=openai` (or default)
- If `use_local=true`: Use `DB_EMBEDDINGS_MODE=local`

## Size Comparison

| Mode | Image Size | Dependencies | Build Time |
|------|-----------|--------------|------------|
| OpenAI | ~500MB | Minimal | Fast (~2-3 min) |
| Local | ~8GB | torch, transformers, sentence-transformers | Slow (~10-15 min) |

## Switching Between Modes

### From OpenAI to Local
1. Update `config.json`: Set `general.embeddings.use_local=true`
2. Rebuild DB service: `DB_EMBEDDINGS_MODE=local docker-compose -f docker-compose.process.yml build db-service`
3. Restart: `docker-compose -f docker-compose.process.yml up -d db-service`

### From Local to OpenAI
1. Update `config.json`: Set `general.embeddings.use_local=false`
2. Rebuild DB service: `DB_EMBEDDINGS_MODE=openai docker-compose -f docker-compose.process.yml build db-service`
3. Restart: `docker-compose -f docker-compose.process.yml up -d db-service`

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

## Environment Variables

You can set `DB_EMBEDDINGS_MODE` as an environment variable:

```bash
# In .env file or export
export DB_EMBEDDINGS_MODE=local

# Then use normally
docker-compose -f docker-compose.process.yml up -d
```

