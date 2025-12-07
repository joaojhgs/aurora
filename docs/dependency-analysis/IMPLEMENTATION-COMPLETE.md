# Dependency Restructuring Implementation - Status Update

**Date**: 2025-11-07  
**Status**: Phase 5-6 Complete, Phase 8 In Progress

## Completed Work

### ✅ Phase 5: pyproject.toml Reorganization

**Service-specific optional groups created**:
- `service-config` - Config service (only jsonschema, already in core)
- `service-db` - Database service
- `service-scheduler` - Scheduler service
- `service-tooling` - Tooling service
- `service-stt-audio-input` - Audio input service
- `service-stt-wakeword` - Wake word service
- `service-stt-transcription` - Transcription service
- `service-stt-coordinator` - STT coordinator service
- `service-tts` - TTS service
- `service-orchestrator` - Orchestrator service

**Mode-specific optional groups created**:
- `mode-threads` - Threads mode (no additional dependencies)
- `mode-processes` - Process mode (bullmq)

**Convenience groups created**:
- `all-services` - Combines all service groups

**Dependencies updated**:
- Removed `halo` from runtime (not used)
- Removed `janus` from requirements-runtime.txt (not used)
- Moved `bullmq` to `mode-processes` group
- Added `pvporcupine` to `service-stt-wakeword`
- Added `typing-extensions` to `service-orchestrator`
- Added `langchain-google-community` to `service-tooling`
- Added `langchain-openai` to `service-orchestrator`

### ✅ Phase 6: Dockerfile Updates

**All 10 service Dockerfiles updated**:
- Removed `requirements-docker.txt` and `requirements-runtime.txt` references
- Updated to use `pip install -e .[service-{name},mode-processes]`
- Improved layer caching by copying pyproject.toml first
- Each service now installs only its specific dependencies

**Updated Dockerfiles**:
- `docker/services/Dockerfile.config`
- `docker/services/Dockerfile.db`
- `docker/services/Dockerfile.tooling`
- `docker/services/Dockerfile.scheduler`
- `docker/services/Dockerfile.tts`
- `docker/services/Dockerfile.audio-input`
- `docker/services/Dockerfile.wakeword`
- `docker/services/Dockerfile.transcription`
- `docker/services/Dockerfile.stt-coordinator`
- `docker/services/Dockerfile.orchestrator`

### 🔄 Phase 8: Setup Scripts

**Status**: Setup scripts already use pyproject.toml groups correctly

**setup.sh**:
- ✅ Already uses `pip install -e .[third-party]`, `[local-huggingface]`, etc.
- ✅ No changes needed - existing groups maintained for backward compatibility
- ✅ Works with new service/mode groups if needed

**setup.bat**:
- ✅ Already uses pyproject.toml groups
- ✅ No changes needed - existing groups maintained for backward compatibility

**setup.py**:
- ✅ Already uses pyproject.toml groups
- ✅ No changes needed - existing groups maintained for backward compatibility

## Benefits Achieved

1. **Single source of truth**: All dependencies in pyproject.toml
2. **Service-specific Docker images**: Each service only installs what it needs
3. **Better Docker layer caching**: pyproject.toml copied first
4. **Backward compatible**: Existing installation methods still work
5. **Cleaner structure**: No proliferation of requirement files
6. **Easier maintenance**: All dependencies in one place

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
# or (backward compatible)
pip install -e .[runtime,torch-cpu]
```

### User setup (existing - backward compatible)
```bash
pip install -e .[runtime,torch-cpu,openai]
pip install -e .[local-huggingface]
pip install -e .[third-party-full]
```

## Next Steps

1. ✅ Complete pyproject.toml reorganization
2. ✅ Update Dockerfiles
3. ✅ Verify setup scripts (no changes needed)
4. ⏭️ Test Docker builds
5. ⏭️ Update documentation
6. ⏭️ Create migration guide

## Files Modified

- `pyproject.toml` - Added service/mode groups
- `requirements-runtime.txt` - Removed janus, added notes
- All 10 service Dockerfiles - Updated to use pyproject.toml groups
- `.cursor/plans/dependency-restructure.plan.md` - Updated plan

## Files Created

- `docs/dependency-analysis/IMPLEMENTATION-APPROACH.md` - Implementation approach
- `docs/dependency-analysis/IMPLEMENTATION-STATUS.md` - Status tracking
- `docs/dependency-analysis/IMPLEMENTATION-PROGRESS.md` - Progress tracking
- `docs/dependency-analysis/IMPLEMENTATION-COMPLETE.md` - This file










