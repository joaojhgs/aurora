# Aurora technology stack

**Status:** Current source of truth

Aurora combines Python services, a typed message bus, a TypeScript SDK/UI layer, and optional local AI/audio runtimes. Optional dependency groups keep heavy local-model and platform-specific dependencies out of thin profiles.

## Languages and runtimes

| Area | Stack |
| --- | --- |
| Backend services | Python 3.10-3.11, asyncio, Pydantic |
| Message bus | In-process `LocalBus`; Redis-backed `BullMQBus` for process mode |
| Gateway | FastAPI, Pydantic schemas, generated routes from contracts |
| Frontend packages | TypeScript, React, Vite/Vitest |
| Web shell | Next.js app under `apps/aurora-web` |
| Desktop/mobile shell | Tauri 2, Rust command bridge, platform-native plugin skeletons |
| Packaging | `uv`, PyInstaller sidecar builds, Tauri bundler, Docker Compose/Tilt |

## AI, speech, and audio

| Capability | Libraries / providers |
| --- | --- |
| LLM orchestration | LangGraph, LangChain, OpenAI, HuggingFace endpoint/local pipeline, llama.cpp profiles |
| STT | faster-whisper / RealtimeSTT paths, service-specific STT packages |
| Wakeword | OpenWakeWord |
| TTS | Piper / RealtimeTTS paths |
| Embeddings/RAG | SQLite, sqlite-vec, OpenAI embeddings, optional local embeddings |

Heavy local model stacks are optional. See [`DEPENDENCIES.md`](DEPENDENCIES.md) for install profiles and sidecar bundle profiles.

## UI and client stack

| Surface | Path | Notes |
| --- | --- | --- |
| SDK | `packages/aurora-sdk` | Transport-independent `AuroraClient`, fixtures, HTTP/Tauri/mock/mesh abstractions. |
| Shared React UI | `packages/aurora-ui` | Production UI primitives that consume SDK state only. |
| Web app | `apps/aurora-web` | Web shell around shared UI and SDK transport. |
| Tauri shell | `apps/aurora-tauri` | Desktop/mobile shell, native commands, sidecar supervision, secure storage posture. |
| PyQt fallback | `app/ui` | Legacy/local fallback and behavior reference. New production UI work should use SDK-first React/Tauri/web surfaces. |

See [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md).

## Integration and automation stack

| Capability | Stack |
| --- | --- |
| MCP | Model Context Protocol stdio / streamable HTTP / SSE integrations through ToolingService. |
| Scheduler | Cron-style and one-shot job service. |
| Mesh | Gateway WebRTC/DataChannel, signaling, peer registry, capability graph, routing table. |
| Auth/RBAC | AuthService, Gateway ACL, typed permission strings, audit events. |
| Backup | BackupService manifests and dry-run restore/rollback contracts. |

## Development and CI tools

| Tool | Purpose |
| --- | --- |
| `uv` | Python dependency resolution and command runner. |
| Ruff | Python lint/format. |
| Pytest | Python unit/integration/e2e/performance tests. |
| pnpm | TypeScript workspace management. |
| Vitest | SDK/UI/Tauri package tests. |
| Docker Compose | Process-mode service topology. |
| Tilt | Process-mode development UX. |
| GitHub Actions | Quality, Python tests, E2E, frontend/SDK, performance, Docker, release, Tauri, SDK conformance. |
