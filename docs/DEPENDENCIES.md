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
| `service-tts` | Piper and PocketTTS synthesis/audio dependencies. Model and voice assets remain separately managed data. |
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

`sidecar-local-audio` carries both Piper and PocketTTS code. The `sidecar-thin`
profile carries neither TTS runtime. Model weights and user voice state are not
dependency-profile inputs and must remain outside packaged application artifacts.
Process-mode TTS keeps its managed downloads and voice state in the persistent
`aurora_voice_models` volume mounted at `/app/voice_models`.

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
pass with no Python/sidecar/endpoint/secrets; emulator/device WebRTC proof
still requires usable KVM access or an authorized physical device. iOS client
source, policy, frontend, and overlay gates are Linux-safe, but simulator,
Swift runtime, signing, and App Store proof require macOS/Xcode.

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

Historical dependency investigation files were moved to `.omx/plans/dependency-analysis-archive/`. They are useful provenance but not current guidance. To refresh dependency evidence:

```bash
make analyze-deps
make generate-dependency-tree
make audit-dependencies
```

Treat outputs as local or CI artifacts unless a small, curated summary belongs in this file.
