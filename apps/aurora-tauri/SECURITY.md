# Aurora Tauri Security Review

TAURI-001 exposes only the minimum command and capability surface needed to launch the shared React UI through the official Tauri 2 shell.

## Exposed Commands

| Command | Purpose | Permission | Notes |
| --- | --- | --- | --- |
| `aurora_request` | Proxies typed `AuroraClient` requests to the configured Aurora Gateway. | `aurora-request` | Allows loopback HTTP(S) by default. Remote Gateway origins require `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1`. Only `content-type`, `x-correlation-id`, and `x-request-id` frontend headers are forwarded. Gateway bearer tokens are read from process environment, not web storage. |
| `aurora_native_capability_manifest` | Returns Tauri shell capability evidence to the SDK. | `aurora-native-capability-manifest` | Reports allowed and denied native capabilities without secrets. |
| `aurora_sidecar_status` | Reports local sidecar health. | `aurora-sidecar-status` | TAURI-001 does not launch or manage Python sidecars. It reports sidecar supervision as pending TAURI-002. |
| `aurora_shutdown` | Exits the shell cleanly. | `aurora-shutdown` | Does not terminate external Aurora processes in TAURI-001. |

## Capability File

`src-tauri/capabilities/aurora-main.json` is the only enabled capability in `tauri.conf.json`. It grants:

- `core:app:default`
- `core:event:default`
- `core:window:default`
- the four Aurora app-command permissions listed above

## Denied By Default

The shell does not grant broad Tauri or plugin permissions for:

- filesystem read/write
- shell command execution
- process spawning
- secure credential storage
- clipboard
- notifications
- dialogs
- updater
- raw audio/microphone
- WebRTC/native networking outside the SDK/Gateway bridge

The native manifest also reports these as unavailable where they are part of planned future Aurora surfaces. Follow-up tasks must add explicit permissions, UX, and tests before enabling them.

## Token And Origin Handling

Tokens are not stored in frontend web storage. The Rust bridge reads `AURORA_TAURI_GATEWAY_TOKEN` or `AURORA_GATEWAY_TOKEN` from the process environment and injects the Authorization header server-side. Loopback Gateway access is the default; remote Gateway access is opt-in through environment configuration.
