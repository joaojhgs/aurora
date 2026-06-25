# Aurora Tauri Shell

This package is the official Tauri 2 desktop shell for Aurora. It hosts the production React UI and keeps Aurora service state behind `AuroraClient`.

## Modes

- Desktop local: uses the Tauri IPC bridge to start, monitor, and stop a Rust-supervised Python thread-mode sidecar while UI data still flows through `AuroraClient`.
- Desktop thin: set `AURORA_TAURI_REMOTE_GATEWAY_URL` and `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1` for the Rust bridge to proxy SDK requests to a remote Gateway without a sidecar.
- Browser development fallback: `VITE_AURORA_GATEWAY_URL` selects HTTP transport; no Gateway URL uses SDK mock fixtures.

Desktop local sidecar defaults:

- program: `python`
- args: `main.py`
- cwd: repository root
- Gateway URL: `http://127.0.0.1:8000`
- config: generated from `app/services/config/config_defaults.json` with Gateway enabled and bound to the selected loopback host/port, passed to Python via `AURORA_CONFIG_FILE`

Override with `AURORA_TAURI_SIDECAR_PROGRAM`, `AURORA_TAURI_SIDECAR_ARGS`, `AURORA_TAURI_SIDECAR_CWD`, `AURORA_TAURI_SIDECAR_CONFIG_FILE`, or `AURORA_GATEWAY_URL` when packaging provides a bundled Python entrypoint.

## Secure storage

`aurora_secure_storage_get`, `aurora_secure_storage_set`, and `aurora_secure_storage_delete` persist only Aurora credential keys in the platform keychain through the Rust shell. Accepted keys are limited to `aurora.session*`, `aurora.auth*`, `aurora.gateway*`, `aurora.mesh*`, and `aurora.admin*` namespaces for session tokens, refresh material, mesh credentials, Gateway tokens, and admin unlock secrets.

The Tauri shell and SDK transport do not use `localStorage`, `sessionStorage`, or plaintext files for these values. The secure-storage commands return redacted metadata (`backend=platform-keychain`, `persisted=true`, `secretsRedacted=true`) and only return a secret value to the explicit `secureStorageGet` caller.

## Packaging And Updates

Tauri bundling is enabled for Linux AppImage/deb/rpm, macOS dmg, and Windows MSI/NSIS targets. Release builds create updater artifacts and signatures through Tauri's updater configuration.

Release inputs:

- `AURORA_TAURI_SIDECAR_SOURCE`: required path to a prebuilt Aurora sidecar executable before `tauri build`.
- `AURORA_TAURI_TARGET_TRIPLE`: optional override for cross-build sidecar naming; defaults to the host Rust target triple.
- `TAURI_SIGNING_PRIVATE_KEY`: required by Tauri when producing signed updater artifacts. Use a secure CI secret or a local secret path/content.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: optional signing key password.

The updater public key and endpoint in `src-tauri/tauri.conf.json` are release placeholders. A production release must replace `AURORA_RELEASE_PUBLIC_KEY_REPLACE_BEFORE_RELEASE` with the generated public key content and point the HTTPS endpoint at the signed release metadata service before publishing.

```bash
pnpm --filter @aurora/tauri-ui prepare:sidecar
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui build:bundle
```

`prepare:sidecar` copies the explicit sidecar artifact into `src-tauri/binaries/aurora-sidecar-$TARGET_TRIPLE` because Tauri expects target-triple suffixed external binaries at bundle time. The generated binaries are ignored by git.

## Commands

```bash
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui tauri dev
cd apps/aurora-tauri/src-tauri && cargo check
cd apps/aurora-tauri/src-tauri && cargo test
```

## Scope Boundary

The frontend must use `AuroraClient`; screens must not call Tauri `invoke` except through the SDK transport adapter or this package's runtime bootstrap. Secure credential storage is enabled through the narrow Aurora keychain command surface only. File access, native audio, event subscription streaming, and broad shell/fs permissions remain disabled or explicitly unsupported until their dedicated follow-up tasks.
