# Dependency Restructuring Implementation Status

**Date**: 2025-11-07  
**Status**: Phase 5 In Progress

## Updated Approach

Based on feedback, we're using **pyproject.toml as the primary dependency manager** instead of creating many requirement files.

## Changes Made

### Phase 5: pyproject.toml Reorganization

✅ **Completed**:
- Added service-specific optional groups: `service-config`, `service-db`, `service-scheduler`, `service-tooling`, `service-stt-audio-input`, `service-stt-wakeword`, `service-stt-transcription`, `service-stt-coordinator`, `service-tts`, `service-orchestrator`
- Added mode-specific optional groups: `mode-threads`, `mode-processes`
- Added convenience group: `all-services` (combines all service groups)
- Removed `janus` from runtime (not used)
- Removed `halo` from runtime (not used)
- Added missing dependencies: `pvporcupine`, `typing-extensions` to appropriate service groups
- Moved `bullmq` to `mode-processes` group

🔄 **In Progress**:
- Clean up `runtime` group (remove unused, mark transitive)
- Update Dockerfiles to use `pip install -e .[service-{name},mode-processes]`
- Update setup scripts

## Current pyproject.toml Structure

### Core Dependencies (`[project.dependencies]`)
- `python-dotenv`, `pydantic`, `pydantic-settings`, `jsonschema`, `psutil`, `tenacity`
- `coloredlogs`, `click`, `colorama` (may be used in scripts)

### Service-Specific Groups
- `service-config`: Only jsonschema (in core)
- `service-db`: aiosqlite, sqlite-vec, SQLAlchemy, langchain, langchain-community, langchain-huggingface, langgraph
- `service-scheduler`: croniter
- `service-tooling`: aiohttp, langchain-community, langchain-core, langchain-google-community, langchain-mcp-adapters, langgraph
- `service-stt-audio-input`: PyAudio
- `service-stt-wakeword`: openwakeword, pvporcupine, numpy, scipy, onnxruntime
- `service-stt-transcription`: faster-whisper, RealtimeSTT, webrtcvad-wheels, ctranslate2, numpy
- `service-stt-coordinator`: Only pydantic (in core)
- `service-tts`: realtimetts, piper-tts, piper-phonemize, PyAudio, torch, torchaudio, torchvision, onnxruntime
- `service-orchestrator`: langchain-core, langchain-huggingface, langchain-openai, langgraph, Jinja2, typing-extensions

### Mode-Specific Groups
- `mode-threads`: No additional dependencies (uses asyncio stdlib)
- `mode-processes`: bullmq

### Convenience Groups
- `all-services`: Combines all service groups

## Next Steps

1. ✅ Complete pyproject.toml reorganization
2. ⏭️ Update Dockerfiles to use new groups
3. ⏭️ Update setup scripts (setup.sh, setup.bat, setup.py)
4. ⏭️ Test installation with new groups
5. ⏭️ Update documentation










