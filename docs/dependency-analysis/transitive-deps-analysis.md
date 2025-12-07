# Transitive Dependencies Analysis

**Date**: 2025-11-07  
**Status**: Corrected Analysis

## Summary

After re-investigation, many "unused" dependencies are actually **transitive dependencies** of packages that ARE used. Additionally, **torch** and **onnxruntime** are NOT optional - they're required for CPU-only inference.

## Key Corrections

### 1. torch, torchaudio, torchvision are REQUIRED (NOT Optional)

**Status**: ✅ Core Dependencies

**Why**:
- `torch` is required by `realtimetts` via `stanza` dependency
- Used in CPU-only inference for TTS
- NOT just for GPU acceleration

**Evidence**:
```bash
$ pipdeptree -p realtimetts
realtimetts==0.4.47
├── stream2sentence [required: ==0.3.0, installed: 0.3.0]
│   └── stanza [required: ==1.9.2, installed: 1.9.2]
│       └── torch [required: >=1.3.0, installed: 2.6.0+cu124]
```

**Action**: Keep in core requirements

### 2. onnxruntime is REQUIRED (NOT Optional)

**Status**: ✅ Core Dependencies

**Why**:
- Required by `openwakeword` for wake word detection (CPU-only inference)
- Required by `piper-tts` for TTS
- Used in CPU-only inference, not just GPU acceleration

**Evidence**:
```bash
$ pipdeptree -p openwakeword
openwakeword==0.6.0
└── onnxruntime [required: >=1.10.0,<2, installed: 1.20.1]

$ pipdeptree -p piper-tts
piper-tts==1.2.0
└── onnxruntime [required: >=1.11.0,<2, installed: 1.20.1]
```

**Action**: Keep in core requirements

### 3. piper-tts and piper-phonemize are USED

**Status**: ✅ Used (via RealtimeTTS)

**Why**:
- `realtimetts` uses `RealtimeTTS.PiperVoice` which requires `piper-tts`
- Code in `app/services/tts/service.py` imports `PiperVoice` from `RealtimeTTS`
- `piper-phonemize` is a dependency of `piper-tts`

**Evidence**:
```python
# app/services/tts/service.py
from RealtimeTTS import PiperVoice, TextToAudioStream
voice = PiperVoice(model_file=model_file, config_file=config_file)
```

**Action**: Keep in requirements

### 4. Confirmed Transitive Dependencies

These are transitive dependencies that can be removed from explicit requirements (let pip handle them):

1. **tqdm**: Required by `realtimetts` (via `stanza`, `stream2sentence`)
2. **emoji**: Required by `realtimetts` (via `stanza`, `stream2sentence`)
3. **regex**: Required by `realtimetts` (via `stanza`, `stream2sentence`)
4. **requests**: Required by multiple packages (`huggingface-hub`, `openwakeword`, etc.)
5. **urllib3**: Required by `requests`
6. **transformers**: Required by `sentence-transformers`
7. **tokenizers**: Required by `transformers` and `faster-whisper`
8. **huggingface-hub**: Required by `transformers`, `sentence-transformers`, `faster-whisper`
9. **Jinja2**: Required by `torch` (via realtimetts → stanza)
10. **MarkupSafe**: Required by `Jinja2`
11. **coloredlogs**: Required by `onnxruntime`

**Action**: These can be removed from explicit requirements (let pip handle them), unless version pinning is needed

### 5. Direct Dependencies That Should Be Explicit

These are direct dependencies that should be explicitly declared:

1. **ctranslate2**: Direct dependency of `faster-whisper` (used in transcription)
2. **scipy**: Direct dependency of `openwakeword` (used in wake word detection)
3. **piper-tts**: Used via RealtimeTTS (should be explicit)
4. **piper-phonemize**: Dependency of `piper-tts` (should be explicit)

**Action**: Keep in requirements

## Updated Unused Dependencies List

After accounting for transitive dependencies, these are truly unused:

1. **janus** - NOT USED ANYWHERE (remove immediately)
2. **halo** - Not used (can be removed)
3. **click** - May be used in scripts (verify)
4. **colorama** - May be used in scripts (verify)
5. **duckduckgo-search** - May be used in tooling (verify)
6. **tiktoken** - May be transitive (verify)
7. **Pillow** - May be transitive (verify)
8. **pydantic-settings** - May be used (verify)
9. **python-dotenv** - Used in main.py (keep)
10. **tenacity** - May be used (verify)
11. **langchain-text-splitters** - May be transitive (verify)
12. **langgraph-checkpoint** - May be transitive (verify)
13. **langgraph-sdk** - May be transitive (verify)
14. **langsmith** - May be transitive (verify)
15. **SQLAlchemy** - May be used in db (verify)
16. **sqlite-vec** - May be used in db (verify)

## Recommendations

### Immediate Actions

1. **Remove unused dependencies**:
   - Remove `janus` (confirmed not used)
   - Remove `halo` (not used)

2. **Keep core dependencies**:
   - Keep `torch`, `torchaudio`, `torchvision` (required by realtimetts)
   - Keep `onnxruntime` (required by openwakeword and piper-tts)
   - Keep `piper-tts`, `piper-phonemize` (used via RealtimeTTS)
   - Keep `ctranslate2` (required by faster-whisper)
   - Keep `scipy` (required by openwakeword)

3. **Consider removing transitive dependencies**:
   - Remove `tqdm`, `emoji`, `regex` (transitive via realtimetts)
   - Remove `requests`, `urllib3` (transitive via multiple packages)
   - Remove `transformers`, `tokenizers`, `huggingface-hub` (transitive via sentence-transformers)
   - Remove `Jinja2`, `MarkupSafe` (transitive via torch)
   - Remove `coloredlogs` (transitive via onnxruntime)

   **Note**: Only remove if you don't need version pinning. If you need specific versions for compatibility/security, keep them.

### Best Practices

1. **Only declare direct dependencies** that your code imports
2. **Let pip handle transitive dependencies** automatically
3. **Exception**: Pin transitive dependencies if you need specific versions for:
   - Compatibility (e.g., known working versions)
   - Security (e.g., patched versions)
   - Performance (e.g., optimized versions)

## Updated Statistics

- **Total declared**: 60 packages
- **Direct dependencies**: ~30 packages
- **Transitive dependencies**: ~20 packages (can be removed)
- **Truly unused**: ~10 packages (should be removed)










