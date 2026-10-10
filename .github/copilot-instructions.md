# Aurora Copilot Instructions

The root [`AGENTS.md`](../AGENTS.md) is the canonical agent contract for this repository. Follow it before this file. This document is a compact Copilot entry point and intentionally does not duplicate the complete architecture or workflow guidance.

## Before working

1. Read [`AGENTS.md`](../AGENTS.md).
2. Use [`docs/DOCS_INDEX.md`](../docs/DOCS_INDEX.md) to find current documentation; archived docs and task plans are not current guidance.
3. Read the nearest subsystem `AGENTS.md` before changing services, messaging, shared code, contracts, Gateway/Auth, tests, or the Tauri shell.
4. For documentation changes, follow [`docs/DOC_MAINTENANCE.md`](../docs/DOC_MAINTENANCE.md).

## Supported toolchains

- Python 3.10-3.11 only; use `uv`, not Conda or unconstrained `pip` setup.
- Node.js 24 with the repository-pinned pnpm version for TypeScript packages.
- Rust 1.88 for the native/WebAssembly workspace and Tauri shell.

Common setup:

```bash
uv sync --extra dev-third-party
corepack enable
pnpm install --frozen-lockfile
```

Use [`docs/INSTALL.md`](../docs/INSTALL.md) and [`docs/DEPENDENCIES.md`](../docs/DEPENDENCIES.md) to select another Python runtime or hardware profile.

## Architecture invariants

- Services communicate through the message bus, never through direct service calls.
- Use typed topic constants, Pydantic IO models, and registered method contracts.
- Use Aurora's structured logging helpers and protect mutable state from concurrent delivery.
- Production UI screens consume `AuroraClient`; they do not call Python services, raw Gateway endpoints, Tauri commands, or WebRTC internals directly.
- Resolve UI platform behavior through `getAuroraSurfaceProfile`; runtime role remains independent of physical platform and transport.
- Do not expose internal implementation or validation vocabulary in production UI copy.
- Keep credentials in `.env` or approved platform credential stores; never commit secrets.

Canonical architecture details live in:

- [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- [`docs/API_AND_CONTRACTS.md`](../docs/API_AND_CONTRACTS.md)
- [`docs/FRONTEND_AND_UI_ARCHITECTURE.md`](../docs/FRONTEND_AND_UI_ARCHITECTURE.md)
- [`docs/FEATURE_MATRIX.md`](../docs/FEATURE_MATRIX.md)

## Verification and commits

Run the smallest targeted checks first, then the relevant aggregate checks:

```bash
make format
make lint
make check
make unit
make integration
make check-docs
pnpm typecheck
pnpm test
make check-rust-voice
```

Do not claim platform evidence that the current host cannot produce. Android emulator/Waydroid checks do not replace physical-device power testing, and Linux checks do not replace macOS/Xcode iOS validation.

Keep commits coherent and reviewable. Inspect `git status` and the staged diff before every commit, preserve unrelated work, and push only when explicitly requested.
