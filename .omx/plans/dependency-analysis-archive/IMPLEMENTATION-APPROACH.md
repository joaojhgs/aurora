# Dependency Restructuring Implementation Approach

**Date**: 2025-11-07  
**Status**: Updated based on feedback

## Revised Approach

After feedback, we're using **pyproject.toml as the primary dependency manager** instead of creating many requirement files.

## Strategy

### Primary: pyproject.toml Optional Dependencies

Use `pyproject.toml`'s `[project.optional-dependencies]` to organize dependencies:

1. **Core dependencies** → `[project.dependencies]` (shared by all)
2. **Service-specific** → `service-{name}` groups
3. **Mode-specific** → `mode-{name}` groups  
4. **Plugins** → `plugin-{name}` groups (already exist)
5. **Hardware** → `{hardware}` groups (already exist)

### Minimal Requirement Files

Only create requirement files if absolutely necessary for Docker builds where `pip install -e .` doesn't work well.

## pyproject.toml Structure

```toml
[project.dependencies]
# Core dependencies shared by ALL services
python-dotenv>=1.0.0
pydantic>=2.10.0
pydantic-settings>=2.7.0
jsonschema>=4.24.0
psutil>=5.0.0
tenacity>=9.0.0

[project.optional-dependencies]
# Service-specific dependencies
service-config = [
    # Only jsonschema (already in core)
]

service-db = [
    "aiosqlite>=0.19.0",
    "sqlite-vec",
    "SQLAlchemy==2.0.38",
    "langchain==0.3.25",
    "langchain-community==0.3.24",
    "langchain-huggingface==0.2.0",
    "langgraph==0.4.6",
]

service-tooling = [
    "aiohttp==3.11.12",
    "langchain-community==0.3.24",
    "langchain-core==0.3.62",
    "langchain-google-community==2.0.7",
    "langchain-mcp-adapters>=0.1.8",
    "langgraph==0.4.6",
]

service-scheduler = [
    "croniter==6.0.0",
]

service-stt-audio-input = [
    "PyAudio==0.2.14",
]

service-stt-wakeword = [
    "openwakeword==0.6.0",
    "pvporcupine==1.9.5",
    "numpy==1.26.4",
    "scipy==1.15.1",
    "onnxruntime==1.20.1",
]

service-stt-transcription = [
    "faster-whisper==1.1.1",
    "RealtimeSTT==0.3.94",
    "webrtcvad-wheels==2.0.14",
    "ctranslate2==4.5.0",
    "numpy==1.26.4",
]

service-stt-coordinator = [
    # Only pydantic (already in core)
]

service-tts = [
    "realtimetts==0.4.47",
    "piper-tts==1.2.0",
    "piper-phonemize==1.1.0",
    "PyAudio==0.2.14",
    "torch==2.6.0",
    "torchaudio==2.6.0",
    "torchvision==0.21.0",
    "onnxruntime==1.20.1",
]

service-orchestrator = [
    "langchain-core==0.3.62",
    "langchain-huggingface==0.2.0",
    "langchain-openai==0.3.18",
    "langgraph==0.4.6",
    "Jinja2==3.1.6",
    "typing-extensions>=4.10.0",
]

# Mode-specific dependencies
mode-threads = [
    # No additional dependencies - uses asyncio (stdlib)
]

mode-processes = [
    "bullmq>=1.7.0",
]

# Convenience groups
all-services = [
    "aurora[service-config,service-db,service-tooling,service-scheduler,service-stt-audio-input,service-stt-wakeword,service-stt-transcription,service-stt-coordinator,service-tts,service-orchestrator]",
]

# Keep existing groups for backward compatibility
runtime = [
    # All runtime dependencies (existing structure)
    # ...
]

# Keep existing plugin and hardware groups
# ...
```

## Installation Examples

### Service-specific (Docker)
```bash
pip install -e .[service-config,mode-processes]
```

### All services (threads mode)
```bash
pip install -e .[all-services,mode-threads]
```

### User setup (existing)
```bash
pip install -e .[runtime,torch-cpu,openai]
```

## Benefits

1. **Single source of truth**: pyproject.toml
2. **No file proliferation**: Minimal requirement files
3. **Easy to maintain**: All dependencies in one place
4. **Backward compatible**: Existing groups still work
5. **Flexible**: Can combine groups easily

## Next Steps

1. Reorganize pyproject.toml with service/mode groups
2. Remove unused dependencies (janus, halo)
3. Add missing dependencies (pvporcupine, typing-extensions)
4. Update Dockerfiles to use `pip install -e .[extras]`
5. Update setup scripts to use new groups










