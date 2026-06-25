# PER-249 TAURI-006 Packaging And Sidecar Plan

## Requirements Summary

- Enable official Tauri 2 desktop bundling for Linux/macOS/Windows from `apps/aurora-tauri/src-tauri/tauri.conf.json`.
- Produce signed updater artifacts through Tauri updater configuration without committing private signing material.
- Keep sidecar supervision behind existing `AuroraClient`/Tauri transport commands; do not add screen-level `invoke` calls.
- Define a reproducible bundled-sidecar input policy that supports Desktop Local while preserving Desktop Thin remote HTTP mode.
- Update security evidence for every exposed capability, denied default, updater permission, sidecar token/origin handling, and release-time secret handling.

## Acceptance Criteria

- `cargo check` passes in `apps/aurora-tauri/src-tauri`.
- `pnpm --filter @aurora/tauri-ui build` passes.
- Tauri config has bundling enabled, updater artifacts enabled, HTTPS update endpoint placeholders, and constrained sidecar external binary path.
- Native manifest and sidecar status report updater/release sidecar evidence without exposing secrets.
- Docs list exposed commands/capabilities and denied defaults, including updater and sidecar bundling policy.

## Implementation Steps

1. Update `apps/aurora-tauri/src-tauri/tauri.conf.json` for bundling, updater artifacts, external sidecar binary path, package metadata, and updater endpoint/public-key placeholders.
2. Add updater plugin dependencies/init in `apps/aurora-tauri/src-tauri/Cargo.toml` and `src/lib.rs`; stop managed sidecar before installer/restart exit.
3. Add release sidecar preparation scripts under `apps/aurora-tauri/scripts/` that copy a prebuilt sidecar from `AURORA_TAURI_SIDECAR_SOURCE` and name it with the host target triple expected by Tauri.
4. Extend Rust status/manifest details with release sidecar and updater facts while keeping tokens redacted and local sidecar start loopback-only.
5. Update `apps/aurora-tauri/README.md` and `SECURITY.md` with build/signing/updater/sidecar policy.
6. Add focused tests for manifest/status configuration and sidecar binary naming.

## Risks And Mitigations

- Updater signing needs private key material: require environment variables at build time and document that `.env` files are not used for Tauri signing.
- Bundled sidecar can drift from Python source: release script requires an explicit prebuilt source artifact and fails if absent.
- Broad native process permissions would expand attack surface: keep Rust `Command` supervision and do not grant shell plugin permissions to the webview.
- Remote thin mode could accidentally start a local sidecar: preserve existing `AURORA_TAURI_REMOTE_GATEWAY_URL` thin-mode sidecar block.

## Verification Steps

- `pnpm --filter @aurora/tauri-ui build`
- `cd apps/aurora-tauri/src-tauri && cargo check`
- `cd apps/aurora-tauri/src-tauri && cargo test`
- Linux smoke launch if WebKit/Tauri runtime dependencies are available; otherwise document the exact environment blocker.
