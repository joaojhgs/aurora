# Aurora Tauri Security Review

TAURI-004 exposes only the minimum command and capability surface needed for the shared React UI to talk through `AuroraClient` and inspect native shell capability evidence through the official Tauri 2 shell.

## Exposed Commands

| Command | Purpose | Permission | Notes |
| --- | --- | --- | --- |
| `aurora_command` | Proxies typed `AuroraClient` requests to the configured Aurora Gateway. | `aurora-command` | Allows loopback HTTP(S) by default. Remote Gateway origins require `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1`. Only `content-type`, `x-correlation-id`, and `x-request-id` frontend headers are forwarded. Gateway bearer tokens are read from process environment, not web storage. |
| `aurora_request` | Compatibility alias for the prior SDK request bridge. | `aurora-request` | Delegates to `aurora_command`; retained for migration only. |
| `aurora_subscribe` | Declares the SDK event subscription bridge. | `aurora-subscribe` | Returns `unsupported_feature` until BE-003 defines the unified backend event stream contract. |
| `aurora_native_capability_manifest`, `native_capabilities` | Returns Tauri shell capability evidence to the SDK. | `aurora-native-capability-manifest` | Reports allowed and denied native capabilities without secrets. |
| `aurora_sidecar_status` | Reports local sidecar health. | `aurora-sidecar-status` | TAURI-001 does not launch or manage Python sidecars. It reports sidecar supervision as pending TAURI-002. |
| `aurora_log_tail` | Reports whether a local sidecar log tail is available. | `aurora-log-tail` | Does not read arbitrary files; returns unavailable until TAURI-002 provides a supervised log source. |
| `aurora_secure_storage_get`, `aurora_secure_storage_set`, `aurora_secure_storage_delete` | SDK secure-storage helper surface. | `aurora-secure-storage` | Returns `native_permission_missing`; no secure storage plugin is enabled in this task. |
| `aurora_local_file_read`, `aurora_local_file_write`, `aurora_local_file_pick` | SDK local-file helper surface. | `aurora-local-file` | Returns `native_permission_missing`; no filesystem plugin or file scope is granted. |
| `aurora_secure_file_handle_open` | Future secure file-handle surface. | `aurora-secure-file-handle` | Returns `native_permission_missing`; scoped handle design is deferred. |
| `aurora_shutdown` | Exits the shell cleanly. | `aurora-shutdown` | Does not terminate external Aurora processes in TAURI-001. |

## Capability File

`src-tauri/capabilities/aurora-main.json` is the only enabled capability in `tauri.conf.json`. It grants:

- `core:app:default`
- `core:event:default`
- `core:window:default`
- the Aurora app-command permissions listed above

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
