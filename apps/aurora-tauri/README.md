# Aurora Tauri Shell

This package is the official Tauri 2 desktop shell for Aurora. It hosts the production React UI and keeps Aurora service state behind `AuroraClient`.

## Modes

- Desktop local: uses the Tauri IPC bridge and reports local sidecar health. TAURI-001 does not launch Python sidecars; TAURI-002 owns supervision.
- Desktop thin: set `AURORA_TAURI_REMOTE_GATEWAY_URL` and `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1` for the Rust bridge to proxy SDK requests to a remote Gateway without a sidecar.
- Browser development fallback: `VITE_AURORA_GATEWAY_URL` selects HTTP transport; no Gateway URL uses SDK mock fixtures.

## Commands

```bash
pnpm --filter @aurora/tauri-ui build
pnpm --filter @aurora/tauri-ui tauri dev
cd apps/aurora-tauri/src-tauri && cargo check
```

## Scope Boundary

The frontend must use `AuroraClient`; screens must not call Tauri `invoke` except through the SDK transport adapter or this package's runtime bootstrap. Storage, file access, native audio, and sidecar process launch are intentionally disabled until their dedicated follow-up tasks.
