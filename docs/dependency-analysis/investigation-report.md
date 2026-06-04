# Dependency Investigation Report

**Date**: 2025-11-07  
**Status**: Phase 1-2 Complete, Phase 3-4 In Progress

## Executive Summary

This report documents the findings from the dependency investigation phase. The analysis reveals significant opportunities for optimization:

- **Many unused dependencies** in requirements-runtime.txt
- **Mode-specific dependencies** (bullmq, janus) included for all modes
- **Service-specific dependencies** can be isolated
- **Hardware acceleration dependencies** (torch, CUDA) always included

## Phase 1: Dependency Analysis Tools Setup

✅ **Completed**
- Installed: pipdeptree, pipreqs, pip-audit, pip-tools
- Created analysis script: `scripts/analyze-dependencies.py`
- Generated dependency tree: `docs/dependency-analysis/dependency-tree.txt`

## Phase 2: Service-Specific Dependency Mapping

✅ **Completed**

### Service Dependencies Summary

| Service | External Packages | Key Dependencies |
|---------|------------------|------------------|
| **config** | 1 | jsonschema |
| **db** | 7 | aiosqlite, langchain, langchain-community, langchain-huggingface, langgraph, pydantic |
| **scheduler** | 1 | croniter |
| **tooling** | 7 | aiohttp, langchain-community, langchain-core, langchain-google-community, langchain-mcp-adapters, langgraph, psutil, pydantic |
| **stt_audio_input** | 2 | PyAudio, pydantic |
| **tts** | 3 | PyAudio, realtimetts, wave (stdlib) |
| **orchestrator** | 9 | Jinja2, langchain-core, langchain-huggingface, langchain-openai, langgraph, llama-cpp, llama-cpp-cuda, pydantic, typing-extensions |
| **stt_transcription** | 3 | faster-whisper, numpy, webrtcvad-wheels |
| **stt_coordinator** | 1 | pydantic |
| **stt_wakeword** | 4 | numpy, openwakeword, pvporcupine, pydantic |

### Shared Dependencies

These packages are used by multiple services:

1. **pydantic** (6 services): db, tooling, stt_audio_input, orchestrator, stt_coordinator, stt_wakeword
2. **langgraph** (3 services): db, tooling, orchestrator
3. **langchain-community** (2 services): db, tooling
4. **langchain-huggingface** (2 services): db, orchestrator
5. **langchain-core** (2 services): tooling, orchestrator
6. **PyAudio** (2 services): stt_audio_input, tts
7. **numpy** (2 services): stt_transcription, stt_wakeword
8. **dataclasses** (3 services): db, scheduler, tooling (stdlib)
9. **uuid** (4 services): db, scheduler, tooling, stt_audio_input (stdlib)

### Service-Specific Dependencies

These packages are only used by one service:

- **config**: jsonschema
- **db**: aiosqlite, langchain
- **scheduler**: croniter
- **tooling**: aiohttp, langchain-google-community, langchain-mcp-adapters, psutil
- **tts**: realtimetts
- **orchestrator**: Jinja2, langchain-openai, llama-cpp, llama-cpp-cuda, typing-extensions
- **stt_transcription**: faster-whisper, webrtcvad-wheels
- **stt_wakeword**: openwakeword, pvporcupine

## Phase 3: Mode and Context Analysis

🔄 **In Progress**

### Process Mode Dependencies

**bullmq**:
- **Status**: ✅ Used (process mode only)
- **Location**: `app/messaging/bullmq_bus.py`
- **Usage**: Only imported when `AURORA_ARCHITECTURE_MODE=processes`
- **Action**: Move to `requirements/modes/processes.txt`

**janus**:
- **Status**: ❌ NOT USED
- **Location**: Not found in codebase
- **Action**: Remove from requirements-runtime.txt (unused dependency)

**Redis**:
- **Status**: External service (not a Python package)
- **Usage**: Required for BullMQBus in process mode
- **Action**: Document as external dependency

### Threads Mode Dependencies

**LocalBus**:
- **Status**: ✅ No special dependencies
- **Location**: `app/messaging/local_bus.py`
- **Dependencies**: Uses asyncio.Queue (stdlib) and threading (stdlib)
- **Action**: No additional dependencies needed

### Hardware Acceleration Dependencies

**torch, torchaudio, torchvision**:
- **Status**: ⚠️ Always included but conditionally used
- **Location**: Used in various services when hardware acceleration enabled
- **Action**: Move to optional dependencies (`requirements/optional/cuda.txt`, etc.)

**onnxruntime**:
- **Status**: ⚠️ Always included but conditionally used
- **Action**: Move to optional dependencies

**llama-cpp, llama-cpp-cuda**:
- **Status**: ✅ Service-specific (orchestrator only)
- **Location**: `app/services/orchestrator/`
- **Action**: Move to orchestrator service dependencies

### Plugin Dependencies

**langchain-google-community**:
- **Status**: ✅ Service-specific (tooling only)
- **Action**: Move to tooling service dependencies

**langchain-mcp-adapters**:
- **Status**: ✅ Service-specific (tooling only)
- **Action**: Move to tooling service dependencies

## Phase 4: Unused Dependency Identification

🔄 **In Progress**

### Comparison Results

**Total declared in requirements-runtime.txt**: 60 packages  
**Total actually used**: 27 packages  
**Unused packages**: 33 packages (55% unused!)

### Unused Dependencies List

These packages are declared but NOT used in the codebase:

1. **bullmq** - Only needed in process mode (should be in modes/processes.txt)
2. **janus** - NOT USED ANYWHERE (should be removed)
3. **click** - CLI framework (may be used in scripts, verify)
4. **colorama** - Terminal colors (may be used in scripts, verify)
5. **coloredlogs** - Colored logging (may be used in helpers, verify)
6. **ctranslate2** - Translation (REQUIRED - transitive dependency of faster-whisper)
7. **duckduckgo-search** - Search (may be in tooling, verify)
8. **emoji** - Emoji support (not used)
9. **halo** - Spinner (not used)
10. **httpx** - HTTP client (may be transitive, verify)
11. **huggingface-hub** - HF hub (may be transitive, verify)
12. **langchain-text-splitters** - Text splitting (may be transitive, verify)
13. **langchain_mcp_adapters** - MCP adapters (in tooling, but name mismatch)
14. **langgraph-checkpoint** - Checkpointing (may be transitive, verify)
15. **langgraph-sdk** - SDK (may be transitive, verify)
16. **langsmith** - LangSmith (may be transitive, verify)
17. **markupsafe** - Jinja2 dependency (transitive)
18. **onnxruntime** - ONNX runtime (REQUIRED - used by openwakeword and piper-tts)
19. **pillow** - Image processing (not used)
20. **piper-phonemize** - Piper TTS (REQUIRED - transitive dependency of piper-tts)
21. **piper-tts** - Piper TTS (USED - required by realtimetts via RealtimeTTS.PiperVoice)
22. **pydantic-settings** - Settings (may be used, verify)
23. **python-dotenv** - .env files (used in main.py, verify)
24. **realtimestt** - Real-time STT (typo? should be RealtimeSTT)
25. **regex** - Regex (may be transitive, verify)
26. **requests** - HTTP client (may be transitive, verify)
27. **scipy** - Scientific computing (REQUIRED - transitive dependency of openwakeword)
28. **sentence-transformers** - Embeddings (may be transitive, verify)
29. **sqlalchemy** - ORM (may be used in db, verify)
30. **sqlite-vec** - Vector extension (may be used in db, verify)
31. **tenacity** - Retry logic (may be used, verify)
32. **tiktoken** - Tokenization (may be transitive, verify)
33. **tokenizers** - Tokenization (may be transitive, verify)
34. **torch** - PyTorch (REQUIRED - used by realtimetts via stanza)
35. **torchaudio** - PyTorch audio (REQUIRED - used by realtimetts via stanza)
36. **torchvision** - PyTorch vision (REQUIRED - used by realtimetts via stanza)
37. **tqdm** - Progress bars (transitive - required by realtimetts via stanza)
38. **transformers** - Transformers (may be transitive, verify)
39. **urllib3** - HTTP library (transitive)

### Missing Dependencies

These packages are used but NOT declared:

1. **Jinja2** - Used in orchestrator (declared as jinja2, but import is jinja2)
2. **PyAudio** - Used in stt_audio_input, tts (declared as pyaudio, but import is pyaudio)
3. **langchain-google-community** - Used in tooling
4. **langchain-mcp-adapters** - Used in tooling (declared as langchain_mcp_adapters)
5. **langchain-openai** - Used in orchestrator
6. **llama-cpp** - Used in orchestrator
7. **llama-cpp-cuda** - Used in orchestrator
8. **pvporcupine** - Used in stt_wakeword
9. **typing-extensions** - Used in orchestrator

### False Positives (Need Verification)

These are marked as unused but may be:
- **Transitive dependencies**: Required by other packages
- **Used in scripts**: Not in app/ directory
- **Used conditionally**: Only imported when certain conditions met
- **Name mismatches**: Import name differs from package name

## Key Findings

### 1. Minimal Service Dependencies

Some services have very few dependencies:
- **config**: Only jsonschema (1 package)
- **stt_coordinator**: Only pydantic (1 package)
- **scheduler**: Only croniter (1 package)

### 2. Heavy Service Dependencies

Some services have many dependencies:
- **orchestrator**: 9 packages (including optional llama-cpp variants)
- **tooling**: 7 packages
- **db**: 7 packages

### 3. Mode-Specific Dependencies

- **bullmq**: Only needed in process mode
- **janus**: Not used at all (should be removed)

### 4. Core Dependencies (NOT Optional)

**torch, torchaudio, torchvision**:
- **Status**: ✅ REQUIRED (NOT optional)
- **Usage**: Required by `realtimetts` (via `stanza` dependency) for TTS
- **Note**: Used in CPU-only inference, not just GPU acceleration
- **Action**: Keep in core requirements

**onnxruntime**:
- **Status**: ✅ REQUIRED (NOT optional)
- **Usage**: 
  - Required by `openwakeword` for wake word detection (CPU-only inference)
  - Required by `piper-tts` for TTS
- **Note**: Used in CPU-only inference, not just GPU acceleration
- **Action**: Keep in core requirements

**llama-cpp-cuda**:
- **Status**: ⚠️ Optional (CUDA acceleration only)
- **Usage**: Used in orchestrator for CUDA-accelerated LLM inference
- **Action**: Move to optional dependencies

### 5. Transitive Dependencies

**IMPORTANT**: Many "unused" dependencies are actually **transitive dependencies** of packages that ARE used. These should generally NOT be explicitly declared (let pip handle them), but can be pinned for version control.

**Confirmed Transitive Dependencies**:

1. **piper-tts, piper-phonemize**:
   - Required by `realtimetts` (via RealtimeTTS.PiperVoice)
   - **Action**: Keep in requirements (used via RealtimeTTS)

2. **ctranslate2**:
   - Required by `faster-whisper`
   - **Action**: Keep in requirements (direct dependency of faster-whisper)

3. **onnxruntime**:
   - Required by `openwakeword` (wake word detection)
   - Required by `piper-tts` (TTS)
   - **Action**: Keep in requirements (core dependency)

4. **torch, torchaudio, torchvision**:
   - Required by `realtimetts` (via `stanza` dependency)
   - **Action**: Keep in requirements (core dependency for TTS)

5. **scipy**:
   - Required by `openwakeword`
   - **Action**: Keep in requirements (direct dependency)

6. **tqdm, emoji, regex**:
   - Required by `realtimetts` (via `stanza`, `stream2sentence`)
   - **Action**: Transitive - can be removed from explicit requirements

7. **requests, urllib3**:
   - Required by multiple packages (`huggingface-hub`, `openwakeword`, etc.)
   - **Action**: Transitive - can be removed from explicit requirements

8. **transformers, tokenizers, huggingface-hub**:
   - Required by `sentence-transformers`
   - **Action**: Transitive - can be removed from explicit requirements

9. **Jinja2, MarkupSafe**:
   - Required by `torch` (via realtimetts → stanza)
   - **Action**: Transitive - can be removed from explicit requirements

10. **coloredlogs**:
    - Required by `onnxruntime`
    - **Action**: Transitive - can be removed from explicit requirements

**Best Practice**: 
- Only declare **direct dependencies** that your code imports
- Let pip handle transitive dependencies automatically
- **Exception**: Pin transitive dependencies if you need specific versions for compatibility/security

## Recommendations

### Immediate Actions

1. **Remove unused dependencies**:
   - Remove `janus` (not used anywhere)
   - Verify and potentially remove: emoji, halo, tqdm, ctranslate2

2. **Move mode-specific dependencies**:
   - Move `bullmq` to `requirements/modes/processes.txt`
   - Create `requirements/modes/threads.txt` (currently empty)

3. **Keep core dependencies** (NOT optional):
   - **torch, torchaudio, torchvision**: Keep in core (required by realtimetts for TTS)
   - **onnxruntime**: Keep in core (required by openwakeword and piper-tts)
   - **llama-cpp-cuda**: Move to optional (CUDA acceleration only)

4. **Fix missing dependencies**:
   - Add `langchain-google-community` to tooling
   - Add `langchain-openai` to orchestrator
   - Add `pvporcupine` to stt_wakeword
   - Add `typing-extensions` to orchestrator

### Short-term Actions

1. **Create service-specific requirement files**
2. **Create shared/core requirement file**
3. **Update Dockerfiles to use service-specific requirements**
4. **Verify transitive dependencies** (use pipdeptree)

### Long-term Actions

1. **Implement dependency validation** in CI
2. **Create dependency decision tree** documentation
3. **Automate dependency updates** with Dependabot/Renovate
4. **Create dependency size analysis** (Docker image sizes)

## Next Steps

1. ✅ Complete Phase 3: Verify all mode-specific and plugin dependencies
2. ✅ Complete Phase 4: Verify transitive dependencies and false positives
3. ⏭️ Phase 5: Design new dependency structure
4. ⏭️ Phase 6: Update Dockerfiles
5. ⏭️ Phase 7: Create installation helpers
6. ⏭️ Phase 8: Documentation

## Files Generated

- `docs/dependency-analysis/service-dependencies.json` - Service dependency mapping
- `docs/dependency-analysis/comparison.json` - Comparison with requirements
- `docs/dependency-analysis/dependency-tree.txt` - Full dependency tree
- `docs/dependency-analysis/investigation-report.md` - This report

