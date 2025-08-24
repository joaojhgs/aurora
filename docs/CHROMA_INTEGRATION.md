# Chroma Vector Database Integration

Aurora now supports Chroma as an alternative backend for the memory store system, providing enhanced vector search capabilities and flexible deployment options.

## Overview

The Chroma integration replaces the existing SQLiteVec-based memory store with [Chroma vector database](https://www.trychroma.com/) while maintaining complete API compatibility. This allows for:

- **Local file-based storage** for development and single-user scenarios
- **Server-based deployment** for production and multi-user environments  
- **Seamless switching** between backends via configuration
- **Future-ready architecture** for distributed memory systems

## Configuration

### Backend Selection

Choose your memory store backend in `config.json`:

```json
{
  "general": {
    "memory_store": {
      "backend": "sqlite",  // or "chroma"
      "chroma": {
        "type": "local",    // or "server"
        "local": {
          "persist_directory": "./data/chroma"
        },
        "server": {
          "host": "localhost",
          "port": 8000
        }
      }
    }
  }
}
```

### Local File-Based Chroma (Development)

For local development and testing:

```json
{
  "general": {
    "memory_store": {
      "backend": "chroma",
      "chroma": {
        "type": "local",
        "local": {
          "persist_directory": "./data/chroma"
        }
      }
    }
  }
}
```

This creates a local Chroma database that persists to disk.

### Server-Based Chroma (Production)

For production deployments with a dedicated Chroma server:

```json
{
  "general": {
    "memory_store": {
      "backend": "chroma",
      "chroma": {
        "type": "server",
        "server": {
          "host": "chroma.example.com",
          "port": 8000
        }
      }
    }
  }
}
```

## Installation

### Basic Chroma Support

```bash
pip install langchain-chroma chromadb
```

### For Local Development

```bash
# Install Chroma with local dependencies
pip install chromadb[local]
```

### For Server Deployment

```bash
# Install Chroma server
pip install chromadb[server]

# Run Chroma server
chroma run --host 0.0.0.0 --port 8000
```

## Migration from SQLiteVec

Switching from SQLiteVec to Chroma is seamless:

1. **Update configuration** to use Chroma backend
2. **Restart Aurora** - existing data remains in SQLiteVec format
3. **Re-populate memories** as needed (Chroma starts with empty collections)

### Migration Script

If you need to migrate existing data, you can use this approach:

```python
# Example migration script (not included in Aurora)
from app.langgraph.memory_store import SQLiteVecStore, ChromaMemoryStore

# Export from SQLite
sqlite_store = SQLiteVecStore("./data/memories.db", "memories", embeddings)
items = sqlite_store.list_items_in_namespace(("main", "memories"), limit=1000)

# Import to Chroma  
chroma_store = ChromaMemoryStore("memories", embeddings, chroma_config)
for item in items:
    chroma_store.put(item.namespace, item.key, item.value)
```

## Architecture

### Class Hierarchy

```
BaseStore (LangGraph interface)
├── SQLiteVecStore (existing)
├── ChromaMemoryStore (new)
├── CombinedSQLiteVecStore (existing)
└── CombinedChromaStore (new)
```

### Key Components

1. **ChromaMemoryStore**: Core Chroma implementation mirroring SQLiteVecStore
2. **CombinedChromaStore**: Routes operations between memories/tools collections
3. **MemoryStoreManager**: Factory that creates appropriate backend based on config
4. **Configuration Schema**: Validates memory store settings

### Namespace Routing

Both SQLite and Chroma backends use the same namespace routing:

- `("main", "memories")` → memories collection/database
- `("tools",)` → tools collection/database  
- Other namespaces → default to memories (backward compatibility)

## API Compatibility

The Chroma integration maintains **100% API compatibility** with the existing memory store:

```python
# All existing code continues to work unchanged
from app.langgraph.memory_store import get_combined_store

store = get_combined_store()

# Same API regardless of backend
await store.aput(("main", "memories"), "key", {"text": "content"})
item = await store.aget(("main", "memories"), "key")
results = await store.asearch(("main", "memories"), query="search term")
```

## Performance Considerations

### Local Chroma vs SQLiteVec

- **Chroma Local**: Better vector search, modern architecture, more dependencies
- **SQLiteVec**: Lighter weight, fewer dependencies, simpler deployment

### Server Chroma vs Local

- **Server**: Better for multiple Aurora instances, centralized memory management
- **Local**: Better for single-user scenarios, no network dependencies

## Troubleshooting

### Common Issues

1. **Import Error**: Ensure Chroma packages are installed
   ```bash
   pip install langchain-chroma chromadb
   ```

2. **Server Connection**: Verify Chroma server is running and accessible
   ```bash
   curl http://localhost:8000/api/v1/heartbeat
   ```

3. **Persistence Issues**: Check directory permissions for local Chroma
   ```bash
   ls -la ./data/chroma/
   ```

### Fallback Behavior

- If Chroma backend is configured but unavailable, Aurora falls back to SQLiteVec
- Configuration validation ensures invalid settings are caught early
- Detailed logging helps diagnose connection and setup issues

## Future Enhancements

The Chroma integration provides foundation for:

1. **Multi-tenant Memory**: Different users/sessions with isolated collections
2. **Distributed Architecture**: Memory server separate from Aurora instances  
3. **Advanced Search**: Leveraging Chroma's full-text and metadata filtering
4. **Memory Scaling**: Handling large-scale memory requirements
5. **Memory Analytics**: Usage patterns and memory effectiveness metrics

## Development

### Running Tests

```bash
# Test Chroma integration
pytest tests/unit/app/langgraph/test_chroma_memory_store.py

# Test backward compatibility
pytest tests/unit/app/langgraph/test_memory_store_simple.py

# Run all memory store tests
pytest tests/unit/app/langgraph/ -k memory
```

### Local Development Setup

```bash
# Install development dependencies
pip install -e .[dev,runtime,chroma]

# Start local Chroma server for testing
chroma run --host localhost --port 8000 --path ./data/chroma_server
```

### Configuration Schema

The memory store configuration follows this schema:

```json
{
  "backend": "sqlite|chroma",
  "chroma": {
    "type": "local|server", 
    "local": {
      "persist_directory": "string"
    },
    "server": {
      "host": "string",
      "port": "integer"
    }
  }
}
```

This schema is validated on startup to catch configuration errors early.