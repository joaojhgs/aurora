# Tauri Desktop Build

Aurora desktop has two runtime modes:

- **Desktop thin** connects to an already-running/operator-managed Gateway and does not need a local Python sidecar.
- **Desktop local** bundles and launches a Rust-supervised Aurora Python sidecar. The UI still talks through `AuroraClient` and the loopback Gateway.

The packaged sidecar is now **profiled**. The default profile is intentionally small and does not install or bundle every local AI dependency.

## Sidecar profiles

| Profile | Purpose | Dependency shape | CI behavior |
| --- | --- | --- | --- |
| `thin` | Default desktop package and smoke build. Gateway/config/auth/db/tooling/orchestrator only. | `aurora[build,sidecar-thin]`; no STT/TTS/local model deps; PyInstaller excludes local AI modules. | Real Linux Tauri bundle. |
| `local-cpu` | Offline/local assistant with STT/TTS/audio and CPU ML wheels. | `aurora[build,sidecar-local-audio,torch-cpu]`; wheel installer uses `--hardware cpu`. | Profile staging smoke; release runner may build the full artifact. |
| `local-cuda` | NVIDIA CUDA local assistant. | `aurora[build,sidecar-local-audio,cuda]`; wheel installer uses `--hardware cuda`. | Profile staging smoke; GPU runner/release runner builds actual artifact. |
| `local-rocm` | AMD ROCm local assistant. | `aurora[build,sidecar-local-audio,rocm]`; wheel installer uses `--hardware rocm`. | Profile staging smoke; GPU runner/release runner builds actual artifact. |
| `local-metal` | macOS Metal local assistant. | `aurora[build,sidecar-local-audio,metal]`; wheel installer uses `--hardware metal`. | Profile staging smoke; macOS release runner builds actual artifact. |
| `local-vulkan`, `local-sycl`, `local-rpc` | Explicit accelerator/distributed variants. | `sidecar-local-audio` plus the matching pyproject accelerator extra. | Profile staging smoke; dedicated release runners build actual artifacts. |
| `full` | Legacy diagnostic all-in-one bundle. | `aurora[build,runtime,torch-cpu]`; intentionally large. | Profile staging smoke only unless explicitly requested. |

The prior 3GB+ artifact came from the old default installing `runtime,torch-cpu`, copying all `modules/`, and allowing PyInstaller to collect optional ML/audio/CUDA-like native libraries. That is now an explicit profile decision, not the default.

## One-command local desktop bundle

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @aurora/client build
pnpm --filter @aurora/ui build
pnpm --filter @aurora/tauri-ui build:bundle
```

`build:bundle` is an alias for the lean default and is non-signing for local/CI smoke builds:

```bash
pnpm --filter @aurora/tauri-ui build:bundle:thin
```

Local assistant variants are explicit:

```bash
pnpm --filter @aurora/tauri-ui build:bundle:local-cpu
pnpm --filter @aurora/tauri-ui build:bundle:local-cuda
pnpm --filter @aurora/tauri-ui build:bundle:local-metal
```

## Sidecar-only builds

The package scripts use an isolated `uv --no-dev` environment for automatic sidecar builds so a developer venv that already contains `runtime`, CUDA, Playwright, pytest, or other extras cannot contaminate PyInstaller analysis.

List supported profiles:

```bash
uv run python scripts/build.py --list-sidecar-profiles
```

Build only the default thin sidecar in the same isolated mode used by `prepare:sidecar`:

```bash
uv run --isolated --no-dev python scripts/build.py --target exe --clean --sidecar --sidecar-profile thin
```

For quick development checks you can still run `uv run python scripts/build.py ...`, but that uses the current project venv and may collect already-installed optional packages.

Build a local CPU sidecar:

```bash
uv run --isolated --no-dev python scripts/build.py --target exe --clean --sidecar --sidecar-profile local-cpu
```

Profile outputs are isolated so stale giant artifacts are not accidentally reused:

```text
dist/sidecars/thin/aurora-sidecar
dist/sidecars/local-cpu/aurora-sidecar
dist/sidecars/local-cuda/aurora-sidecar
```

## What `prepare:sidecar` does

`prepare:sidecar` stages a profile-specific sidecar for Tauri:

1. Uses `--profile <name>` or `AURORA_TAURI_SIDECAR_PROFILE`; default is `thin`.
2. Uses `AURORA_TAURI_SIDECAR_SOURCE` only when explicitly provided as a trusted prebuilt override.
3. Otherwise looks for the matching profile output under `dist/sidecars/<profile>/aurora-sidecar`.
4. If missing, builds it with an isolated environment:

   ```bash
   uv run --isolated --no-dev python scripts/build.py --target exe --clean --sidecar --sidecar-profile <profile>
   ```

5. Enforces the profile size guard before staging.
6. Copies the executable to Tauri's target-triple name:

   ```text
   apps/aurora-tauri/src-tauri/binaries/aurora-sidecar-$TARGET_TRIPLE[.exe]
   ```

7. Writes ignored release metadata:

   ```text
   apps/aurora-tauri/src-tauri/tauri.release.conf.json
   apps/aurora-tauri/reports/sidecar-prepare.json
   ```

Useful overrides:

```bash
AURORA_TAURI_SIDECAR_BUILD_OUTPUT=/cache/aurora-sidecar pnpm --filter @aurora/tauri-ui prepare:sidecar:thin
AURORA_TAURI_SIDECAR_SOURCE=/secure/artifacts/aurora-sidecar pnpm --filter @aurora/tauri-ui build:bundle:local-cpu
AURORA_TAURI_SIDECAR_MAX_MB=2200 pnpm --filter @aurora/tauri-ui prepare:sidecar:local-cpu
```

Do not use a generic `dist/aurora-sidecar` as the normal path. Legacy output reuse is disabled unless `AURORA_TAURI_SIDECAR_ALLOW_LEGACY_OUTPUT=1` is set intentionally.

## Runtime behavior

The Rust shell starts the sidecar in this order:

1. `AURORA_TAURI_SIDECAR_PROGRAM` / `AURORA_TAURI_SIDECAR_ARGS` when explicitly set for development or diagnostics.
2. The bundled `aurora-sidecar-$TARGET_TRIPLE[.exe]` from Tauri resources.
3. Development fallback: `python main.py` from the repository root.

Packaged desktop-local builds should use path 2. Desktop thin mode never starts a sidecar.

## CI coverage

Relevant workflows:

- `.github/workflows/tauri-desktop.yml` builds the frontend, tests the Tauri runtime wrapper, builds the lean Linux AppImage+deb Tauri bundle with `thin`, and runs a sidecar profile staging matrix across `thin`, local CPU, accelerator, and legacy full profiles.
- `.github/workflows/tauri-android.yml` builds Android APK/native plugin evidence.
- `.github/workflows/tauri-ios.yml` builds the iOS simulator baseline on macOS.
- `.github/workflows/frontend-sdk.yml` runs shared UI and SDK package checks.
- `.github/workflows/release.yml` runs manual semantic-release readiness checks and publication.

Default `build:bundle:*` scripts pass `--no-sign` so local and CI package-smoke builds do not require updater signing secrets. Signing/notarization/release publication still require the platform-specific secrets documented in the release documentation.

## Linux bundle targets

The platform Linux config builds AppImage and deb by default. RPM packaging is intentionally not part of the default local/CI bundle because it requires RPM tooling and can hang on generic Linux runners without that toolchain. Use this explicit command on an RPM-capable runner:

```bash
pnpm --filter @aurora/tauri-ui build:bundle:linux-rpm:thin
```
