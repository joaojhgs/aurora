# Dependency Restructuring Implementation Progress

**Date**: 2025-11-07  
**Status**: Phase 5 In Progress - pyproject.toml Reorganization

## Summary

Using **pyproject.toml as the primary dependency manager** instead of many requirement files. This is cleaner, easier to maintain, and follows Python best practices.

## Completed

### Phase 5: pyproject.toml Reorganization

✅ **Service-specific optional groups created**:
- `service-config` - Config service (only jsonschema, already in core)
- `service-db` - Database service (aiosqlite, sqlite-vec, SQLAlchemy, langchain, langchain-community, langchain-huggingface, langgraph)
- `service-scheduler` - Scheduler service (croniter)
- `service-tooling` - Tooling service (aiohttp, langchain-community, langchain-core, langchain-google-community, langchain-mcp-adapters, langgraph)
- `service-stt-audio-input` - Audio input service (PyAudio)
- `service-stt-wakeword` - Wake word service (openwakeword, pvporcupine, numpy, scipy, onnxruntime)
- `service-stt-transcription` - Transcription service (faster-whisper, RealtimeSTT, webrtcvad-wheels, ctranslate2, numpy)
- `service-stt-coordinator` - STT coordinator service (only pydantic, already in core)
- `service-tts` - TTS service (realtimetts, piper-tts, piper-phonemize, PyAudio, torch, torchaudio, torchvision, onnxruntime)
- `service-orchestrator` - Orchestrator service (langchain-core, langchain-huggingface, langchain-openai, langgraph, Jinja2, typing-extensions)

✅ **Mode-specific optional groups created**:
- `mode-threads` - Threads mode (no additional dependencies - uses asyncio stdlib)
- `mode-processes` - Process mode (bullmq)

✅ **Convenience groups created**:
- `all-services` - Combines all service groups for threads mode

✅ **Dependencies updated**:
- Removed `halo` from runtime (not used)
- Moved `bullmq` to `mode-processes` group
- Added `pvporcupine` to `service-stt-wakeword`
- Added `typing-extensions` to `service-orchestrator`
- Added `langchain-google-community` to `service-tooling`
- Added `langchain-openai` to `service-orchestrator`

## In Progress

🔄 **Cleaning up runtime group**:
- Remove `janus` (not used)
- Mark transitive dependencies with notes
- Keep for version pinning but document they're transitive

🔄 **Updating Dockerfiles**:
- Change from `requirements-runtime.txt` to `pip install -e .[service-{name},mode-processes]`
- Test Docker builds

🔄 **Updating setup scripts**:
- Update `setup.sh` to use new groups
- Update `setup.bat` to use new groups
- Update `setup.py` to use new groups

## Next Steps

1. ✅ Complete pyproject.toml reorganization
2. ⏭️ Remove `janus` from requirements-runtime.txt
3. ⏭️ Update Dockerfiles to use new groups
4. ⏭️ Update setup scripts (setup.sh, setup.bat, setup.py)
5. ⏭️ Test installation with new groups
6. ⏭️ Update documentation

## Installation Examples

### Service-specific (Docker process mode)
```bash
pip install -e .[service-config,mode-processes]
pip install -e .[service-db,mode-processes]
# etc.
```

### All services (threads mode)
```bash
pip install -e .[all-services,mode-threads]
# or
pip install -e .[runtime,torch-cpu]  # existing method still works
```

### User setup (existing - backward compatible)
```bash
pip install -e .[runtime,torch-cpu,openai]
```

## Benefits

1. **Single source of truth**: pyproject.toml
2. **No file proliferation**: Minimal requirement files
3. **Easy to maintain**: All dependencies in one place
4. **Backward compatible**: Existing groups still work
5. **Flexible**: Can combine groups easily
6. **Standard Python practice**: Using pyproject.toml optional dependencies










