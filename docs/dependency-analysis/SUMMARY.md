# Dependency Investigation Summary

**Date**: 2025-11-07  
**Status**: Investigation Phase Complete

## Quick Findings

### Key Statistics
- **Total declared dependencies**: 60 packages
- **Actually used**: 27 packages
- **Unused**: 33 packages (55% unused!)
- **Missing**: 9 packages (used but not declared)

### Critical Findings

1. **janus is NOT USED** - Should be removed immediately
2. **bullmq is process-mode only** - Should be in mode-specific requirements
3. **Many services have minimal dependencies** - Can be optimized significantly
4. **Hardware acceleration deps always included** - Should be optional

## Service Dependency Breakdown

### Minimal Dependencies (1-2 packages)
- **config**: jsonschema (1 package)
- **stt_coordinator**: pydantic (1 package)
- **scheduler**: croniter (1 package)
- **stt_audio_input**: PyAudio, pydantic (2 packages)

### Medium Dependencies (3-4 packages)
- **stt_transcription**: faster-whisper, numpy, webrtcvad-wheels (3 packages)
- **stt_wakeword**: numpy, openwakeword, pvporcupine, pydantic (4 packages)
- **tts**: PyAudio, realtimetts (2 packages, + wave stdlib)

### Heavy Dependencies (7+ packages)
- **db**: aiosqlite, langchain, langchain-community, langchain-huggingface, langgraph, pydantic (6 packages)
- **tooling**: aiohttp, langchain-community, langchain-core, langchain-google-community, langchain-mcp-adapters, langgraph, psutil, pydantic (8 packages)
- **orchestrator**: Jinja2, langchain-core, langchain-huggingface, langchain-openai, langgraph, llama-cpp, llama-cpp-cuda, pydantic, typing-extensions (9 packages)

## Shared Dependencies

These are used by multiple services and should be in `requirements/base/core.txt`:

1. **pydantic** (6 services): db, tooling, stt_audio_input, orchestrator, stt_coordinator, stt_wakeword
2. **langgraph** (3 services): db, tooling, orchestrator
3. **langchain-community** (2 services): db, tooling
4. **langchain-huggingface** (2 services): db, orchestrator
5. **langchain-core** (2 services): tooling, orchestrator
6. **PyAudio** (2 services): stt_audio_input, tts
7. **numpy** (2 services): stt_transcription, stt_wakeword

## Mode-Specific Dependencies

### Process Mode Only
- **bullmq** - Used in `app/messaging/bullmq_bus.py`
- **Redis** - External service (not Python package)

### Threads Mode
- No special dependencies (uses asyncio.Queue from stdlib)

### Unused
- **janus** - NOT USED ANYWHERE - Remove immediately

## Optional Dependencies

### Core Dependencies (NOT Optional)

**torch, torchaudio, torchvision**:
- **Status**: ✅ REQUIRED (NOT optional)
- **Usage**: Required by `realtimetts` (via `stanza` dependency) for TTS
- **Note**: Used in CPU-only inference, not just GPU acceleration

**onnxruntime**:
- **Status**: ✅ REQUIRED (NOT optional)
- **Usage**: 
  - Required by `openwakeword` for wake word detection (CPU-only inference)
  - Required by `piper-tts` for TTS
- **Note**: Used in CPU-only inference, not just GPU acceleration

### Optional Dependencies

### Hardware Acceleration
- **llama-cpp-cuda** - Only needed with CUDA acceleration

### Plugins
- **langchain-google-community** - Tooling service only
- **langchain-mcp-adapters** - Tooling service only
- **langchain-openai** - Orchestrator service only

## Unused Dependencies (Confirmed)

These are declared but NOT used in the codebase:

1. **janus** - NOT USED (remove immediately)
2. **halo** - Not used (can be removed)

## Transitive Dependencies (Can Be Removed)

These are transitive dependencies that can be removed from explicit requirements (let pip handle them):

1. **tqdm** - Required by realtimetts (via stanza, stream2sentence)
2. **emoji** - Required by realtimetts (via stanza, stream2sentence)
3. **regex** - Required by realtimetts (via stanza, stream2sentence)
4. **requests** - Required by multiple packages (huggingface-hub, openwakeword, etc.)
5. **urllib3** - Required by requests
6. **transformers** - Required by sentence-transformers
7. **tokenizers** - Required by transformers and faster-whisper
8. **huggingface-hub** - Required by transformers, sentence-transformers, faster-whisper
9. **Jinja2** - Required by torch (via realtimetts → stanza)
10. **MarkupSafe** - Required by Jinja2
11. **coloredlogs** - Required by onnxruntime

**Note**: Only remove if you don't need version pinning. If you need specific versions for compatibility/security, keep them.

## Core Dependencies (Keep in Requirements)

These are direct dependencies that should be explicitly declared:

1. **piper-tts** - Used via RealtimeTTS.PiperVoice
2. **piper-phonemize** - Dependency of piper-tts
3. **ctranslate2** - Direct dependency of faster-whisper
4. **scipy** - Direct dependency of openwakeword
5. **torch, torchaudio, torchvision** - Required by realtimetts (via stanza)
6. **onnxruntime** - Required by openwakeword and piper-tts

## Missing Dependencies (Used but not declared)

1. **langchain-google-community** - Used in tooling
2. **langchain-openai** - Used in orchestrator
3. **pvporcupine** - Used in stt_wakeword
4. **typing-extensions** - Used in orchestrator
5. **llama-cpp** - Used in orchestrator
6. **llama-cpp-cuda** - Used in orchestrator

## Recommendations

### Immediate Actions

1. **Remove unused dependencies**:
   - Remove `janus` from requirements-runtime.txt
   - Remove `ctranslate2`, `emoji`, `halo`, `tqdm`, `piper-tts`, `pillow`

2. **Move mode-specific dependencies**:
   - Move `bullmq` to `requirements/modes/processes.txt`

3. **Add missing dependencies**:
   - Add `langchain-google-community` to tooling
   - Add `langchain-openai` to orchestrator
   - Add `pvporcupine` to stt_wakeword
   - Add `typing-extensions` to orchestrator
   - Add `llama-cpp` and `llama-cpp-cuda` to orchestrator

4. **Move optional dependencies**:
   - Move `torch`, `torchaudio`, `torchvision` to `requirements/optional/cuda.txt`
   - Move `onnxruntime` to `requirements/optional/onnx.txt`

### Next Steps

1. ✅ Complete Phase 3: Verify transitive dependencies
2. ✅ Complete Phase 4: Finalize unused dependencies list
3. ⏭️ Phase 5: Design new dependency structure
4. ⏭️ Phase 6: Update Dockerfiles
5. ⏭️ Phase 7: Create installation helpers
6. ⏭️ Phase 8: Documentation

## Files Generated

- `docs/dependency-analysis/service-dependencies.json` - Service dependency mapping
- `docs/dependency-analysis/comparison.json` - Comparison with requirements
- `docs/dependency-analysis/dependency-tree.txt` - Full dependency tree
- `docs/dependency-analysis/dependency-tree.json` - Dependency tree (JSON)
- `docs/dependency-analysis/investigation-report.md` - Detailed report
- `docs/dependency-analysis/SUMMARY.md` - This summary

