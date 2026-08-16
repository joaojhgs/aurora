# Tauri Desktop Build

Aurora's frontend has three supported runtime modes:

- **Web thin** runs in a browser and uses the shared HTTP/WebRTC runtime without native credential commands.
- **Desktop thin** loads a nonsecret connection profile asynchronously, supports HTTP-only, WebRTC-only, and WebRTC-preferred through the shared WebView runtime, and does not start or require a local Python sidecar.
- **Desktop local** launches a Rust-supervised Aurora Python sidecar for development or packaged local mode. The UI still talks through `AuroraClient` and the loopback Gateway.

The packaged sidecar is now **profiled**. The default profile is intentionally small and does not install or bundle every local AI dependency.

> **Runtime/package distinction:** `build:bundle:desktop-thin` and its compatibility alias `build:bundle:thin` are genuinely Python-free remote bundle lanes. They write `src-tauri/tauri.thin.conf.json`, never call `prepare-sidecar`, and verify the produced bundle for forbidden Python/sidecar content. The minimal local sidecar lane is named `desktop-local-minimal`.

## Development bootstrap

Use the package Tauri command for local desktop development. This command is the real local stack path; browser-only mock/demo fixtures are degraded development fallbacks and must not be used as proof that desktop-local sidecar behavior works:

```bash
pnpm --filter @aurora/tauri-ui tauri dev
```

The Tauri package wraps the CLI for `dev` only. It automatically selects `.venv/bin/python` when available; otherwise it falls back to `uv run --no-dev --extra sidecar-thin python main.py` from the repository root. It sets threads mode, points the UI at the loopback Gateway, and enables the managed local sidecar. The dev path is deliberately different from packaged builds:

- **Dev** runs Python directly for fast iteration and clear service logs.
- **Package/build** stages a profiled sidecar executable for Tauri bundling.

Do not run `prepare:sidecar` or set `AURORA_TAURI_SIDECAR_SOURCE` just to use `tauri dev`. Those are package/release inputs. During development, Vite, Rust/Tauri, and Python service logs should appear in the same terminal; log prefixes are `[vite]` for frontend bundler output when separated by the dev server, `[tauri]` for wrapper/Rust shell output, `[aurora][stdout]`/`[aurora][stderr]` for Python service output, and `[gateway]` for explicit Gateway readiness probes when a smoke harness separates them. Desktop-local is not shown as ready until the Tauri sidecar status command succeeds and the SDK can read `/api/health`, `/api/registry`, and a core read-only `/api/services` sample through the Gateway boundary.
Closing the Tauri window hides Aurora to the tray; explicit tray Quit or Ctrl-C stops the supervised Python sidecar.

## Sidecar profiles

| Profile | Purpose | Dependency shape | CI behavior |
| --- | --- | --- | --- |
| `desktop-local-minimal` | Default local desktop package and smoke build. Gateway/config/auth/db/tooling/orchestrator only. | Maps to the Python builder's internal `thin` dependency profile; no STT/TTS/local model deps. | Real Linux Tauri bundle. |
| `local-cpu` | Offline/local assistant with STT/TTS/audio and CPU ML wheels. | `aurora[build,sidecar-local-audio,torch-cpu]`; includes Piper and `pocket-tts[audio]==2.1.0` code, while base weights, standard voice packs, and cloned voice states remain external; wheel installer uses `--hardware cpu` before resolving PocketTTS. | Profile staging smoke; release runner may build the full artifact. |
| `local-cuda` | NVIDIA CUDA local assistant. | `aurora[build,sidecar-local-audio,cuda]`; wheel installer uses `--hardware cuda` before resolving PocketTTS. | Profile staging smoke; GPU runner/release runner builds actual artifact. |
| `local-rocm` | AMD ROCm local assistant. | `aurora[build,sidecar-local-audio,rocm]`; wheel installer uses `--hardware rocm` before resolving PocketTTS. | Profile staging smoke; GPU runner/release runner builds actual artifact. |
| `local-metal` | macOS Metal local assistant. | `aurora[build,sidecar-local-audio,metal]`; wheel installer uses `--hardware metal` before resolving PocketTTS. | Profile staging smoke; macOS release runner builds actual artifact. |
| `local-vulkan`, `local-sycl`, `local-rpc` | Explicit accelerator/distributed variants. | `sidecar-local-audio` plus the matching pyproject accelerator extra. | Profile staging smoke; dedicated release runners build actual artifacts. |
| `full` | Legacy diagnostic all-in-one bundle. | `aurora[build,runtime,torch-cpu]`; intentionally large. | Profile staging smoke only unless explicitly requested. |

The prior 3GB+ artifact came from the old default installing `runtime,torch-cpu`, copying all `modules/`, and allowing PyInstaller to collect optional ML/audio/CUDA-like native libraries. That is now an explicit profile decision, not the default.

PocketTTS package code and PocketTTS model data are separate release concerns.
The local audio profiles can package provider code, but they must not package
licensed base models, starter voice packs, cloned voice states, or attribution
material unless a separate approved model/voice manifest explicitly permits it.

## One-command local desktop bundle

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @aurora/client build
pnpm --filter @aurora/ui build
pnpm --filter @aurora/tauri-ui build:bundle
```

`build:bundle` is an alias for the lean desktop-local sidecar default and is non-signing for local/CI smoke builds:

```bash
pnpm --filter @aurora/tauri-ui build:bundle:desktop-local
pnpm --filter @aurora/tauri-ui build:bundle:desktop-local-minimal
```

For a remote/no-sidecar shell, use either Python-free thin command:

```bash
pnpm --filter @aurora/tauri-ui build:bundle:desktop-thin
pnpm --filter @aurora/tauri-ui verify:bundle:desktop-thin
```

The desktop-thin command (and its `build:bundle:thin` alias) uses Tauri's `--config src-tauri/tauri.thin.conf.json` flavor overlay. `prepare:bundle:desktop-thin` compiles no Gateway or signaling URL, generates a runtime-configurable `connect-src 'self' http: https: ws: wss:` policy, replaces the base capability list with `aurora-thin`, and omits `bundle.externalBin` plus `bundle.resources`. At runtime, invite-first onboarding supplies the local node name and signaling/pairing material; normal connection settings edit the selected HTTP Gateway and/or WebRTC signaling profile afterward.

## Thin-shell platform runtime prerequisites

| Platform | Package/runtime dependency | Aurora package contract |
| --- | --- | --- |
| Linux | Tauri uses system GTK/WebKitGTK. The generated Debian package declares the normal GTK, WebKitGTK, and tray dependencies. | `webrtc-rs`, base64, and bytes are Linux-target-only Cargo dependencies linked into the binary. When WebKitGTK lacks `RTCPeerConnection`, desktop thin injects this native ICE/DTLS/SCTP/DataChannel primitive. No GStreamer or system WebRTC package is required by the fallback. |
| macOS | WKWebView is part of macOS. | `tauri.macos.conf.json` enables hardened runtime, signs with the narrow audio-input entitlement, and merges `Info.macos.plist` microphone/local-network purpose strings for focused voice/WebRTC and runtime-configured LAN peers. |
| Windows | Tauri uses Microsoft Edge WebView2. Rust's MSVC runtime is statically linked by Tauri's default Windows build policy. | MSI/NSIS configuration embeds the small Evergreen WebView2 bootstrapper, so the installer can provision/update WebView2 when it is missing. The bootstrapper needs internet only when the OS does not already have WebView2; it does not pin a stale fixed runtime. |
| Android | Tauri uses Android System WebView. | The manifest declares WebView as required and the app packages AndroidX WebKit compatibility APIs. Manifest/plugin merging declares Internet, network-state, record/modify-audio, foreground microphone, notification, biometric, camera, and vibration permissions. Release and debug builds allow user-configured cleartext LAN HTTP/WS endpoints. The native WebChromeClient grants WebView audio capture only after runtime permission, trusted origin, focus, and foreground checks. |
| iOS | WKWebView is part of iOS. | `Info.ios.plist` declares camera, microphone, local-network, Face ID, and runtime HTTP/WebSocket transport usage. Camera is used for invite QR scanning; microphone remains focused/user-initiated. |

The platform WebView remains OS-serviced on macOS, Android, and iOS. Windows
uses the Evergreen WebView2 updater path rather than bundling a fixed browser.
Linux keeps WebKitGTK for the UI but does not depend on its optional WebRTC DOM
feature.

The existing desktop workflow builds Linux local/thin packages and now also
builds Python-free macOS DMG and Windows MSI/NSIS thin packages on their native
GitHub runners. The Python-free artifact policy mounts each DMG read-only with
macOS `hdiutil`, scans the mounted application tree for embedded models,
sidecars, runtimes, and secrets, then detaches it before accepting the package.
Android APK/AAB and iOS simulator/WKWebView packages remain in their existing
platform-specific workflows.

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

Build the internal minimal Python sidecar profile directly:

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

1. Uses `--profile <name>` or `AURORA_TAURI_SIDECAR_PROFILE`; default is `desktop-local-minimal` (mapped internally to the Python builder's `thin` profile).
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
AURORA_TAURI_SIDECAR_BUILD_OUTPUT=/cache/aurora-sidecar pnpm --filter @aurora/tauri-ui prepare:sidecar:desktop-local-minimal
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

For path 2, Rust creates the platform Tauri application-data directory before
launch and uses it as the sidecar working directory. It points
`AURORA_CONFIG_FILE`, `AURORA_ENV_FILE`, and `AURORA_DATA_DIR` at persistent
paths below that directory. The PyInstaller extraction directory and the
read-only installation/resource directory are never used for mutable state.

## CI coverage

Relevant workflows:

- `.github/workflows/tauri-desktop.yml` builds the frontend, tests the Tauri runtime wrapper, runs a desktop bundle matrix for `desktop-local` and Python-free `desktop-thin`, boots the actual packaged minimal sidecar and requires healthy services/routes plus persistent config/data evidence, runs `cargo check` for both lanes, verifies desktop-thin artifact contents, runs `pnpm --filter @aurora/tauri-ui dev:smoke` under Xvfb for the local lane so `tauri dev` fails on missing Gateway readiness, early process exit, or missing `[tauri]`/`[aurora][...]` logs, and runs a sidecar profile staging matrix across `desktop-local-minimal`, local CPU, accelerator, and legacy full profiles.
- `.github/workflows/tauri-android.yml` builds Android thin debug APK/AAB artifacts, verifies Python-free artifact contents, runs Android preflight/native plugin parity, proves UI/native-payload behavior on API 30 and API 35 emulators, and runs the packaged API 35 System WebView against an external Python WebRTC peer. Python is test infrastructure only and is not embedded in the thin package.
- `.github/workflows/tauri-ios.yml` builds the iOS simulator baseline on macOS and installs/launches the Python-free thin `.app` in a real simulator, capturing a screenshot, process log, and keep-alive report.
- `.github/workflows/frontend-sdk.yml` runs shared UI and SDK package checks.
- `.github/workflows/release.yml` runs manual semantic-release readiness checks and publication.

Default `build:bundle:*` scripts pass `--no-sign` so local and CI package-smoke builds do not require updater signing secrets. Signing/notarization/release publication still require the platform-specific secrets documented in the release documentation.

## Linux bundle targets

The platform Linux config builds AppImage and deb by default. RPM packaging is intentionally not part of the default local/CI bundle because it requires RPM tooling and can hang on generic Linux runners without that toolchain. Use this explicit command on an RPM-capable runner:

```bash
pnpm --filter @aurora/tauri-ui build:bundle:linux-rpm:desktop-local-minimal
pnpm --filter @aurora/tauri-ui build:bundle:linux-rpm:thin
```
