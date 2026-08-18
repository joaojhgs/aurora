# Aurora dependency guide

**Status:** Current source of truth
**Audience:** contributors, CI maintainers, and release builders

Aurora uses `uv` and `pyproject.toml` optional dependency groups to avoid installing every local-model, audio, GPU, and integration dependency for every runtime. The default development path should install only the profile needed for the task.

## Rules

- Use `uv`; do not introduce Conda or ad-hoc requirements files.
- Keep dependency groups in `pyproject.toml` as the source of truth.
- Add dependencies to the narrowest service, mode, hardware, or integration group that owns them.
- Do not commit generated dependency trees, audit snapshots, or temporary analysis JSON/TXT under `docs/`. Generate them locally or publish them as CI artifacts.
- For Tauri bundles, choose an explicit sidecar profile instead of shipping every local dependency in one package.
- For Python-free Tauri client bundles, keep platform runtime dependencies target-specific. Linux links the native peer primitive only on Linux; Windows provisions WebView2; macOS/iOS use WKWebView; Android uses System WebView. See [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md).

## Common local installs

```bash
# Lightweight third-party/API development
uv sync --extra dev-third-party

# CPU local assistant development
uv sync --extra dev-local-cpu

# GPU local assistant development
uv sync --extra dev-local-gpu

# Test tooling only
uv sync --extra test-all

# Process-mode services and Redis client deps
uv sync --extra mode-processes
```

For one-off commands, prefer:

```bash
uv run --extra dev python main.py
uv run --extra test-all pytest tests/unit
```

## Runtime layering

| Layer | Examples | Guidance |
| --- | --- | --- |
| Core/runtime | service framework, config, bus, contracts | Keep minimal and broadly usable. |
| Service extras | `service-db`, `service-tts`, `service-orchestrator`, `gateway` | Install only for services that need them, especially in containers. |
| Mode extras | `mode-threads`, `mode-processes` | Process mode owns Redis/BullMQ dependencies. |
| Hardware/local-model extras | `cuda`, `rocm`, `metal`, `vulkan`, `sycl`, `torch-cpu` | Keep explicit; do not include in Python-free client or API-only builds. |
| Integration extras | `google`, `jira`, `github`, `slack` | Optional plugin/tooling integrations. Submodules such as OpenRecall own and lock their dependencies independently. |
| Test/dev extras | `dev`, `test-unit`, `test-integration`, `test-e2e`, `test-performance`, `test-all` | CI and local validation profiles. |

## Service dependency groups

The service groups in `pyproject.toml` mirror Aurora process-mode boundaries:

| Group | Purpose |
| --- | --- |
| `service-config` | Config service runtime. |
| `service-auth` | Auth, token, pairing, and principal support. |
| `service-db` | SQLite/RAG persistence and default embedding paths. |
| `service-db-local-embeddings` | Local embedding model support for DB/RAG. |
| `service-scheduler` | Cron and scheduled-job runtime. |
| `service-tooling` | Built-in tools, plugin tooling, and MCP client support. |
| `service-stt-wakeword` | Wake-word service dependencies. |
| `service-stt-transcription` | Speech transcription service dependencies. |
| `service-stt-coordinator` | Coordinator-side STT orchestration dependencies. |
| `service-tts` | Piper and PocketTTS synthesis/audio dependencies. Piper remains the default provider. Model files, PocketTTS base weights, standard voice packs, and cloned voice states remain separately managed data. |
| `service-orchestrator` | LangGraph/LangChain orchestration and default LLM client support. |
| `gateway` | FastAPI Gateway, WebRTC, ACL, and mesh transport dependencies. |
| `all-services` | Convenience group for full local service runtime. |

## LLM and embedding choices

| Use case | Recommended extras | Notes |
| --- | --- | --- |
| OpenAI/API-first orchestration | `openai`, `service-orchestrator` | Smallest practical LLM path. |
| HuggingFace endpoint | `service-orchestrator-huggingface-endpoint` | API client only. |
| HuggingFace local pipeline | `service-orchestrator-huggingface-local` plus hardware extras | Heavy; pulls local model stack. |
| llama.cpp CPU/CUDA | `service-orchestrator-llama-cpp*` plus setup-script managed install | Some llama.cpp wheels are intentionally handled outside normal `uv sync`. |
| DB OpenAI embeddings | `service-db` | Default small DB image/profile. |
| DB local embeddings | `service-db-local-embeddings` or `embeddings-local` | Heavy local embedding profile. |

## Tauri sidecar and client package profiles

`sidecar-local-audio`, `service-tts`, and the aggregate `runtime` profile carry
both Piper and `pocket-tts[audio]==2.1.0` code. The `sidecar-thin` profile
carries neither TTS runtime. Model weights, standard voice packs, and user voice
state are not dependency-profile inputs and must remain outside packaged
application artifacts. Process-mode TTS keeps managed downloads and voice state
in the persistent `aurora_voice_models` volume mounted at `/app/voice_models`;
PocketTTS uses `voice_models/pockettts` for its model cache and
`voice_models/pockettts/voices` for voice-state artifacts by default.

Hardware-backed local speech installs establish the selected Torch triplet before
resolving PocketTTS. The Docker and sidecar builders enforce that order. For a
manual service environment, use the frozen-export sequence in `docs/UV_USAGE.md`;
do not start from an unconstrained editable extra install.

PocketTTS currently exposes these product-language selections through the TTS
config:

| Product language | Compact config | Quality config |
| --- | --- | --- |
| English | `english_2026-04` | `english_2026-04` |
| German | `german` | `german_24l` |
| Portuguese | `portuguese` | `portuguese_24l` |
| Italian | `italian` | `italian_24l` |
| Spanish | `spanish` | `spanish_24l` |
| French | unavailable | `french_24l` |

The legacy internal IDs `english` and `english_2026-01` are compatibility-only
aliases. A plain `french` PocketTTS config is unavailable; choose the `quality`
tier to resolve French to `french_24l`.

The exact internal config IDs recognized by the provider are `english`,
`english_2026-01`, `english_2026-04`, `german`, `german_24l`, `portuguese`,
`portuguese_24l`, `italian`, `italian_24l`, `spanish`, `spanish_24l`, and
`french_24l`.

The supported PocketTTS runtime is one resident base model with serialized
synthesis entry. Use `services.tts.provider = "piper"` for the default and
immediate rollback path. To opt into PocketTTS, set `services.tts.provider =
"pockettts"` and configure:

| Field | Default | Notes |
| --- | --- | --- |
| `services.tts.providers.pockettts.quality_tier` | `compact` | `compact` or `quality`; French is available only as `quality`. |
| `services.tts.providers.pockettts.cache_dir` | `voice_models/pockettts` | Persistent model/cache directory. Set this inside a persistent process-mode volume. |
| `services.tts.providers.pockettts.voice_state_dir` | `voice_models/pockettts/voices` | Sensitive local voice-state storage. Keep it private and backed up according to user consent. |
| `services.tts.providers.pockettts.device` | `cpu` | Current schema accepts CPU only. Hardware extras affect package contents, not this runtime field yet. |
| `services.tts.providers.pockettts.initialization_timeout_s` | `120.0` | Model initialization timeout. |
| `services.tts.providers.pockettts.request_timeout_s` | `120.0` | Per-request synthesis timeout. |
| `services.tts.providers.pockettts.max_concurrent_requests` | `1` | Schema and provider enforce serialized entry. |
| `services.tts.providers.pockettts.preload_model` | `false` | Keep the selected base unloaded until explicit use unless an operator opts into preload. |
| `services.tts.providers.pockettts.preload_voice_ids` | `[]` | Additional logical voices must exist in the registry and be supported by the provider. |
| `services.tts.providers.pockettts.temperature` | `null` | Optional provider sampling control. |
| `services.tts.providers.pockettts.lsd_decode_steps` | `1` | Optional provider decode control. |
| `services.tts.providers.pockettts.noise_clamp` | `null` | Optional provider noise control. |
| `services.tts.providers.pockettts.eos_threshold` | `-4.0` | Optional provider EOS control. |
| `services.tts.providers.pockettts.quantize` | `false` | Provider quantization flag. |

`services.tts.providers.pockettts.custom_config_path` exists in the schema but
is intentionally fail-closed in the service. Bare custom PocketTTS config files
are unavailable until Aurora can validate their manifest, model identity, and
license metadata.

Standard voice packs require separately approved manifests. Aurora does not
bundle or auto-download a licensed starter PocketTTS model or voice asset. Model
and voice-asset licenses, attribution, and redistribution terms are separate
from Aurora's MIT-licensed package code. Cloned voice states are sensitive local
data managed by the voice registry; do not copy them into images, sidecars, logs,
or support bundles.

PocketTTS standard voices are registry-installed artifacts, not provider
built-ins. The service accepts provider-neutral
`standard:<pack>:<voice>` IDs only when the local `VoiceRegistry` contains an
exact ready `pockettts-python` voice-state artifact whose language bundle and
compatibility group match the selected resident PocketTTS base. Default and
preload voice IDs fail closed when no compatible registry entry exists; Aurora
does not guess from upstream PocketTTS voice names and does not accept a bare
`standard:alba` ID.

Current upstream provenance is intentionally treated as input to a future
manifest, not as release approval. Kyutai publishes the
[`pocket-tts`](https://github.com/kyutai-labs/pocket-tts) package code under
MIT, the
[`kyutai/pocket-tts-without-voice-cloning`](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning)
model card lists `cc-by-4.0`, and Kyutai's
[`tts-voices`](https://huggingface.co/kyutai/tts-voices) card lists per-source
voice licenses including CC BY 4.0 and non-commercial sources. Kyutai also lists
prohibited uses for unlawful, deceptive, or non-consensual voice use. Do not
enable redistribution or automatic download for any PocketTTS model or voice
asset until an approved Aurora manifest records the exact upstream repo, path,
revision, SHA-256, size, license, attribution, and redistribution decision.

The Sherpa native/WASM PocketTTS path is separate from the Python PocketTTS
provider. It uses official sherpa-onnx `v1.13.5` plus
`tools/voice-runtime/sherpa-patches/`, converts English `english_2026-04` and
French `french_24l` packs on demand into `.artifacts/`, and must not commit
weights. See [`SHERPA_POCKETTTS.md`](SHERPA_POCKETTTS.md). The
`sherpa-pockettts-language-packs` workflow is a temporary bootstrap publisher.

Tauri desktop packages stage a Python sidecar using `apps/aurora-tauri/scripts/prepare-sidecar.mjs` and `scripts/build.py`. Profiles are explicit so the default bundle does not install every local dependency.

| Profile | Intent | Typical command |
| --- | --- | --- |
| `desktop-client` | Python-free remote-console/mesh-node desktop client. It does not call `prepare-sidecar`, compiles no operator endpoint, and stores HTTP/WebRTC role configuration at runtime. Linux package/live proof uses the native peer primitive only when WebKitGTK lacks `RTCPeerConnection`; macOS/Windows live proof remains platform-runner evidence. | `pnpm --filter @aurora/tauri-ui build:bundle:desktop-client`; `pnpm test:desktop-client:live` |
| `desktop-local-minimal` | Default local desktop Python sidecar package. Gateway/config/auth/db/tooling/orchestrator only. Internally this maps to the Python builder's legacy `thin` dependency profile, but the package still contains and supervises Python. | `pnpm --filter @aurora/tauri-ui build:bundle:desktop-local-minimal` |
| `local-cpu` | Local assistant bundle for CPU-only machines. | `pnpm --filter @aurora/tauri-ui build:bundle:local-cpu` |
| `local-cuda` | NVIDIA CUDA local assistant bundle. | `pnpm --filter @aurora/tauri-ui build:bundle:local-cuda` |
| `local-rocm` | AMD ROCm local assistant bundle. | `pnpm --filter @aurora/tauri-ui build:bundle:local-rocm` |
| `local-metal` | macOS Metal local assistant bundle. | `pnpm --filter @aurora/tauri-ui build:bundle:local-metal` |
| `local-vulkan` / `local-sycl` | Experimental hardware-specific local model profiles. | explicit package script |
| `local-rpc` | Local sidecar/RPC boundary profile. | explicit package script |
| `full` | Full local dependency profile; use intentionally because it can be large. | `pnpm --filter @aurora/tauri-ui build:bundle:full` |

Legacy `*:thin` package scripts remain compatibility aliases for the neutral `*:client` scripts. Do not use the Python builder's internal `thin` dependency profile as evidence that a package is Python-free; Python-free client artifacts are the `desktop-client`, Android client, and iOS client bundle lanes.

Android client artifact proof is package-content evidence, not device-runtime
evidence. Current-main x86_64 debug APK and universal four-ABI debug AAB scans
pass with no Python/sidecar/endpoint/secrets, and a packaged API 30 application
launch smoke passes on the workspace emulator. No API 35 packaged-WebView or
Chrome WebRTC report is claimed from that launch-only smoke; run the API 35
workflow or an authorized physical device for those lanes. iOS client source,
policy, frontend, and overlay gates are Linux-safe, but simulator, Swift
runtime, signing, and App Store proof require macOS/Xcode.

See [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md) for sidecar build mechanics and signing boundaries.

## Docker image variants

Process-mode Compose runs separate service containers. Keep container images service-specific and build hardware/model variants only where they are needed.

| Area | Current docs |
| --- | --- |
| DB embeddings variants | [`docker/DB-SERVICE-EMBEDDINGS.md`](docker/DB-SERVICE-EMBEDDINGS.md) |
| Orchestrator LLM variants | [`docker/ORCHESTRATOR-SERVICE-LLM-MODES.md`](docker/ORCHESTRATOR-SERVICE-LLM-MODES.md) |
| Process-mode operation | [`../README.process-mode.md`](../README.process-mode.md), [`TILT.md`](TILT.md) |
| CI container validation | [`CI_CD.md`](CI_CD.md) |

## Dependency analysis artifacts

Dependency investigation outputs are reproducible local or CI artifacts, not tracked documentation. To refresh dependency evidence:

```bash
make analyze-deps
make generate-dependency-tree
make audit-dependencies
```

Keep the generated outputs under local `.artifacts/` or local agent state unless a small, curated summary belongs in this file.
