# Aurora Tauri Security Review

TAURI-002, TAURI-004, and TAURI-006 expose only the minimum command and capability surface needed for the shared React UI to talk through `AuroraClient`, inspect native shell capability evidence, supervise the local Python thread-mode sidecar, and receive signed updates through the official Tauri 2 shell.

## Exposed Commands

| Command | Purpose | Permission | Notes |
| --- | --- | --- | --- |
| `aurora_command` | Proxies typed `AuroraClient` requests to the configured Aurora Gateway. | `aurora-command` | Allows loopback HTTP(S) by default. Remote Gateway origins require `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1`. Only `content-type`, `x-correlation-id`, and `x-request-id` frontend headers are forwarded. Gateway bearer tokens are read from process environment, not web storage. |
| `aurora_request` | Compatibility alias for the prior SDK request bridge. | `aurora-request` | Delegates to `aurora_command`; retained for migration only. |
| `aurora_subscribe` | Declares the SDK event subscription bridge. | `aurora-subscribe` | Returns `unsupported_feature` until BE-003 defines the unified backend event stream contract. |
| `aurora_native_capability_manifest`, `native_capabilities` | Returns Tauri shell capability evidence to the SDK. | `aurora-native-capability-manifest` | Reports allowed and denied native capabilities without secrets, including iOS App Intents/Shortcuts/share/deep-link baseline metadata and the unsupported Siri replacement limitation. |
| `aurora_sidecar_session` | Returns an in-memory command token to the SDK adapter. | `aurora-sidecar-session` | Token is not written to web storage or rendered by UI. It is used only by the Tauri transport adapter. |
| `aurora_sidecar_start` | Starts the Rust-supervised Python sidecar in thread mode. | `aurora-sidecar-start` | Disabled in desktop-thin mode. Requires loopback Gateway origin and sidecar session token. |
| `aurora_sidecar_stop` | Stops the Rust-supervised Python sidecar. | `aurora-sidecar-stop` | Requires sidecar session token. Used by shutdown and explicit stop paths. |
| `aurora_sidecar_status` | Reports local sidecar process and Gateway health. | `aurora-sidecar-status` | Includes pid/running/mode/loopback/health evidence and redacted token-storage facts; does not include the token value. |
| `aurora_log_tail` | Reports whether a local sidecar log tail is available. | `aurora-log-tail` | Does not read arbitrary files; returns unavailable until a supervised log source is exposed. |
| `aurora_secure_storage_get`, `aurora_secure_storage_set`, `aurora_secure_storage_delete` | SDK secure-storage helper surface. | `aurora-secure-storage` | Persists only validated Aurora credential keys in the platform keychain. Does not grant filesystem, shell, process, or web-storage access. |
| `aurora_native_permission_status` | Reports the shell native permission/capability matrix, denied defaults, and privacy classes. | `aurora-native-permissions` | Evidence only; grants no OS permission by itself. |
| `aurora_tray_status` | Reports system tray availability. | `aurora-tray` | Tray is created in Rust with Show Aurora and Quit actions; no shell/process access is exposed to the webview. |
| `aurora_notification_status`, `aurora_notification_send` | Reports notification availability and returns structured denied responses for sends. | `aurora-notifications` | Notification delivery is denied by default until a permission-request UX exists. |
| `aurora_dialog_status` | Reports dialog availability. | `aurora-dialogs` | Native open/save dialogs are denied by default until scoped picker UX exists. |
| `aurora_local_file_read`, `aurora_local_file_write`, `aurora_local_file_pick` | SDK local-file helper surface. | `aurora-local-file` | Returns `native_permission_missing`; no filesystem plugin or file scope is granted. |
| `aurora_secure_file_handle_open` | Future secure file-handle surface. | `aurora-secure-file-handle` | Returns `native_permission_missing`; scoped handle design is deferred. |
| `aurora_audio_bridge_status` | Reports raw-audio bridge readiness and required consent/backend evidence. | `aurora-audio-bridge` | Microphone capture, live audio streaming, and playback control are denied by default. |
| `aurora_shutdown` | Stops managed sidecar if present, then exits the shell cleanly. | `aurora-shutdown` | Does not terminate non-managed external Aurora processes. |

The Tauri updater plugin is also granted on desktop through `updater:default`. It validates signed updater artifacts against the configured public key and does not expose filesystem, shell, process-spawn, or arbitrary network powers to Aurora screens. The IOS-001 baseline uses `aurora-ios-baseline` and does not grant updater permissions because the updater plugin is desktop-only in this shell.

## Capability File

`src-tauri/capabilities/aurora-main.json` is the enabled desktop capability in `tauri.conf.json`. It grants:

- `core:app:default`
- `core:event:default`
- `core:window:default`
- Aurora native permission, tray, notification, dialog, and audio status commands
- `updater:default`
- the Aurora app-command permissions listed above

`src-tauri/tauri.ios.conf.json` switches iOS builds to `src-tauri/capabilities/aurora-ios-baseline.json`, which grants the same Aurora bridge/status command permissions but omits desktop-only `updater:default`.

## Denied By Default

The shell does not grant broad Tauri or plugin permissions for:

- filesystem read/write
- shell command execution
- process spawning
- clipboard
- notifications
- dialogs
- raw audio/microphone
- WebRTC/native networking outside the SDK/Gateway bridge

Secure credential storage is enabled only through the narrow Aurora keychain command surface. The native manifest reports broad filesystem, secure file handles, shell/process spawning, audio, clipboard, notifications, dialogs, and updater surfaces as unavailable where they are part of planned future Aurora surfaces. Follow-up tasks must add explicit permissions, UX, and tests before enabling them.

TAURI-005 adds the core Tauri tray feature and an Aurora-owned native status bridge. It intentionally does not grant notification delivery, native dialogs, arbitrary file reads/writes, microphone capture, live audio streaming, or playback control. Those surfaces report denied defaults through `Native.GetCapabilityManifest`, `aurora_native_permission_status`, and the per-feature status commands until downstream UI/backend tasks provide scoped consent, target selection, retention/audit language, and tests.

IOS-001 adds evidence-only iOS invocation metadata to the same native manifest. It does not grant iOS App Intent, widget, share extension, deep-link, SiriKit, microphone, or background execution powers by itself. Future iOS targets must stay Xcode-managed, scoped to concrete Aurora actions and privacy labels, and must use "Siri/Shortcuts/App Intents integration" wording rather than claiming Aurora can replace Siri.

## Token And Origin Handling

Tokens are not stored in frontend web storage. The Rust bridge reads `AURORA_TAURI_GATEWAY_TOKEN` or `AURORA_GATEWAY_TOKEN` from the process environment and injects the Authorization header server-side. Runtime credentials that must survive app restarts use `aurora_secure_storage_*` with platform keychain persistence, limited to `aurora.session*`, `aurora.auth*`, `aurora.gateway*`, `aurora.mesh*`, and `aurora.admin*` keys. Loopback Gateway access is the default; remote Gateway access is opt-in through environment configuration.

Local sidecar commands use a separate random in-memory command token generated by Rust at shell startup. `AuroraClient` gets that token through `TauriLocalTransport`; screen components do not call the commands directly. Desktop-thin mode never starts a sidecar and must set `AURORA_TAURI_REMOTE_GATEWAY_URL` plus `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1` for non-loopback Gateway origins.

The managed sidecar receives an isolated `AURORA_CONFIG_FILE` generated from Aurora defaults with Gateway enabled and bound to the selected loopback host/port. This keeps Desktop Local mode from relying on a user `config.json` that may leave Gateway disabled or bind it broadly. Packaging may provide an explicit `AURORA_TAURI_SIDECAR_CONFIG_FILE` when it needs a prebuilt config.

## Packaging, Signing, And Bundled Sidecar Policy

Tauri bundling is active for Linux, macOS, and Windows desktop targets. `createUpdaterArtifacts=true` makes Tauri produce signed updater artifacts during release builds when `TAURI_SIGNING_PRIVATE_KEY` is present in the process environment. The private signing key and password must be supplied by a secure local secret store or CI secret; they are never committed and `.env` files are not relied on for signing.

The committed updater endpoint and public key are release placeholders. Publishing requires replacing the public key with the generated public key content and using an HTTPS release metadata endpoint. Insecure update transport is not enabled.

Release builds use an ignored `src-tauri/tauri.release.conf.json` overlay whose `bundle.externalBin` references `binaries/aurora-sidecar`. The bundle build runs `pnpm prepare:sidecar`, which requires `AURORA_TAURI_SIDECAR_SOURCE` to point at an explicit prebuilt Aurora sidecar executable and copies it to Tauri's required target-triple suffixed filename before writing the overlay. Generated sidecar binaries and the release overlay are ignored by git. The default checked-in `tauri.conf.json` omits `externalBin` so `cargo check` and smoke CI do not require release-only sidecar artifacts.

The webview is not granted Tauri shell plugin execute/spawn permissions for the sidecar. The Rust supervisor owns process start/stop, injects only loopback Gateway and in-memory sidecar-token environment, and stops the managed child on window close, explicit shutdown, or app exit.
