# Aurora Tauri Security Review

TAURI-002, TAURI-004, and TAURI-006 expose only the minimum command and capability surface needed for the shared React UI to talk through `AuroraClient`, inspect native shell capability evidence, supervise the local Python thread-mode sidecar, and receive signed updates through the official Tauri 2 shell.

## Exposed Commands

| Command | Purpose | Permission | Notes |
| --- | --- | --- | --- |
| `aurora_command` | Proxies typed `AuroraClient` requests to the configured Aurora Gateway. | `aurora-command` | Allows loopback HTTP(S) by default. Remote Gateway origins require `AURORA_TAURI_ALLOW_REMOTE_GATEWAY=1`. Only `content-type`, `x-correlation-id`, and `x-request-id` frontend headers are forwarded. Bearer authentication is SDK/session-driven or an opaque scoped native proof; the Rust bridge does not read Gateway bearer tokens from process environment. |
| `aurora_request` | Compatibility alias for the prior SDK request bridge. | `aurora-request` | Delegates to `aurora_command`; retained for migration only. |
| `aurora_subscribe`, `aurora_activate_subscription`, `aurora_unsubscribe` | Opens, activates, and closes SDK event subscriptions by proxying the configured Gateway SSE route `/api/events/stream` into scoped Tauri webview events. | `aurora-subscribe` | Uses the same loopback/remote Gateway origin policy as request/response commands. Desktop Local mode requires the in-memory sidecar session token; Desktop Thin mode is an explicit Gateway/SDK session path, not local bus access or environment-token injection. |
| `aurora_native_capability_manifest`, `native_capabilities` | Returns Tauri shell capability evidence to the SDK. | `aurora-native-capability-manifest` | Reports allowed and denied native capabilities without secrets, including Android secure-storage/admin-unlock states, iOS App Intents/Shortcuts/share/deep-link baseline metadata, and the unsupported system assistant role limitation. |
| `aurora_sidecar_session` | Returns an in-memory command token to the SDK adapter. | `aurora-sidecar-session` | Token is not written to web storage or rendered by UI. It is used only by the Tauri transport adapter. |
| `aurora_sidecar_start` | Starts the Rust-supervised Python sidecar in thread mode. | `aurora-sidecar-start` | Disabled in desktop-thin mode. Requires loopback Gateway origin and sidecar session token. |
| `aurora_sidecar_stop` | Stops the Rust-supervised Python sidecar. | `aurora-sidecar-stop` | Requires sidecar session token. Used by shutdown and explicit stop paths. |
| `aurora_sidecar_status` | Reports local sidecar process and Gateway health. | `aurora-sidecar-status` | Includes pid/running/mode/loopback/health evidence and redacted token-storage facts; does not include the token value. |
| `aurora_log_tail` | Reports whether a local sidecar log tail is available. | `aurora-log-tail` | Does not read arbitrary files; returns unavailable until a supervised log source is exposed. |
| `aurora_secure_storage_get`, `aurora_secure_storage_set`, `aurora_secure_storage_delete` | SDK secure-storage helper surface for local/mobile credential flows. | `aurora-secure-storage` | Persists only validated Aurora credential keys in the platform keychain or Android Keystore. This broad credential helper is not granted by the Python-free desktop-thin capability. |
| `aurora_thin_profile_get`, `aurora_thin_profile_set` | Desktop-thin nonsecret connection profile load/save. | `aurora-thin-profile` | Persists only the fixed desktop-thin profile document (mode, exact endpoints, label/node name, stable peer ID). It cannot generic-get/set auth, admin, Gateway, mesh, or session secret keys. |
| `aurora_biometric_admin_unlock_status`, `aurora_biometric_admin_unlock` | Reports and requests Android biometric/device-credential admin confirmation. | `aurora-android-admin-unlock` | Android-only. Returns redacted `admin-critical` status and starts the platform credential confirmation intent only when native keyguard evidence says it is requestable. |
| `aurora_native_permission_status` | Reports the shell native permission/capability matrix, denied defaults, and privacy classes. | `aurora-native-permissions` | Evidence only; grants no OS permission by itself. |
| `aurora_tray_status` | Reports system tray availability. | `aurora-tray` | Tray is created in Rust with Show Aurora and Quit actions; no shell/process access is exposed to the webview. |
| `aurora_notification_status`, `aurora_notification_send` | Reports notification availability and returns structured denied responses for sends. | `aurora-notifications` | Notification delivery is denied by default until a permission-request UX exists. |
| `aurora_dialog_status` | Reports dialog availability. | `aurora-dialogs` | Native open/save dialogs are denied by default until scoped picker UX exists. |
| `aurora_local_file_read`, `aurora_local_file_write`, `aurora_local_file_pick` | SDK local-file helper surface. | `aurora-local-file` | Returns `native_permission_missing`; no filesystem plugin or file scope is granted. |
| `aurora_secure_file_handle_open` | Future secure file-handle surface. | `aurora-secure-file-handle` | Returns `native_permission_missing`; scoped handle design is deferred. |
| `aurora_audio_bridge_status` | Reports raw-audio bridge readiness and required consent/backend evidence. | `aurora-audio-bridge` | Microphone capture, live audio streaming, and playback control are denied by default. |
| `aurora_shutdown` | Stops managed sidecar if present, then exits the shell cleanly. | `aurora-shutdown` | Does not terminate non-managed external Aurora processes. |

The Tauri updater plugin is granted only on desktop through the separate `aurora-desktop-updater` capability with `updater:default`. It validates signed updater artifacts against the configured public key and does not expose filesystem, shell, process-spawn, or arbitrary network powers to Aurora screens. Android and iOS baseline builds do not grant updater permissions because the updater plugin is installed only for desktop targets in this shell.

## Capability File

`src-tauri/capabilities/aurora-main.json` is the shared shell capability in `tauri.conf.json`. It grants:

- `core:app:default`
- `core:event:default`
- `core:window:default`
- Aurora native permission, tray, notification, dialog, and audio status commands
- `aurora-secure-storage` for trusted desktop-local/mobile credential flows only
- the Aurora app-command permissions listed above

`src-tauri/tauri.linux.conf.json`, `src-tauri/tauri.macos.conf.json`, and `src-tauri/tauri.windows.conf.json` add `src-tauri/capabilities/aurora-desktop-updater.json` for desktop updater access. `src-tauri/tauri.ios.conf.json` switches iOS builds to `src-tauri/capabilities/aurora-ios-baseline.json`, which grants the same Aurora bridge/status command permissions but omits desktop-only `updater:default`.

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

Secure credential storage is enabled only through explicit Aurora keychain/Keystore command surfaces. Desktop-thin grants `aurora-thin-profile` and `aurora-thin-peer-credentials`, not generic `aurora-secure-storage`. The native manifest reports broad filesystem, secure file handles, shell/process spawning, audio, clipboard, notifications, dialogs, and updater surfaces as unavailable where they are part of planned future Aurora surfaces. Follow-up tasks must add explicit permissions, UX, and tests before enabling them.

TAURI-005 adds the core Tauri tray feature and an Aurora-owned native status bridge. It intentionally does not grant notification delivery, native dialogs, arbitrary file reads/writes, microphone capture, live audio streaming, or playback control. Those surfaces report denied defaults through `Native.GetCapabilityManifest`, `aurora_native_permission_status`, and the per-feature status commands until downstream UI/backend tasks provide scoped consent, target selection, retention/audit language, and tests.

IOS-001 adds evidence-only iOS invocation metadata to the same native manifest. It does not grant iOS App Intent, widget, share extension, deep-link, SiriKit, microphone, or background execution powers by itself. Future iOS targets must stay Xcode-managed, scoped to concrete Aurora actions and privacy labels, and must use "Siri/Shortcuts/App Intents integration" wording rather than claiming default iOS assistant ownership.

## Event Subscription Bridge

The Tauri event bridge does not expose Python bus objects or create a second privileged event bus. `aurora_subscribe` builds a bounded `/api/events/stream` URL from the SDK stream/topic/kind/correlation fields and allocates a subscription-scoped Tauri event name. The SDK calls `aurora_activate_subscription` only after both event listeners are registered, then Rust starts the task that consumes the Gateway SSE response and emits each normalized backend event. The SDK closes the native task through `aurora_unsubscribe` when a view closes, an assistant turn is cancelled, or the subscription iterator is returned.

The bridge forwards only Gateway-authorized, redacted `Aurora.EventStream` events. Rust-side transport errors emit a redacted close event with `secretsRedacted=true`; token values, Gateway bearer strings, sidecar session tokens, filesystem paths, Redis URLs, peer secrets, and raw secret-like diagnostics are not included in the close payload. Window close and `aurora_shutdown` abort active subscription tasks before stopping the managed sidecar.

CI runs `pnpm --filter @aurora/tauri-ui eventstream:smoke` under the Linux Tauri desktop job. The smoke starts a loopback Gateway-compatible SSE source, launches the real Tauri shell, receives one `health.updated` event through `TauriLocalTransport.subscribe()`, closes the SDK subscription, and records whether the Gateway request closed after unsubscribe in `apps/aurora-tauri/reports/eventstream-smoke.json`.

## Token And Origin Handling

Tokens are not stored in frontend web storage. The Rust bridge does not read `AURORA_TAURI_GATEWAY_TOKEN` or `AURORA_GATEWAY_TOKEN`, and it does not inject an Authorization header from process environment. Live Gateway authentication remains SDK/session-driven, or uses opaque scoped native proof commands such as desktop-thin peer reconnect proofs that never return raw bearer tokens to the WebView. Runtime credentials that must survive app restarts use explicit platform keychain/Keystore commands; desktop-thin grants only the fixed nonsecret profile document and peer reconnect credential/proof commands, while generic `aurora_secure_storage_*` remains outside the thin capability. Loopback Gateway access is the default; remote Gateway access is opt-in through environment configuration.

Local sidecar commands use a separate random in-memory command token generated by Rust at shell startup. `AuroraClient` gets that token through `TauriLocalTransport`; screen components do not call the commands directly. Desktop-thin mode never starts a sidecar. Its persisted connection profile contains only mode, runtime HTTP/HTTPS Gateway and/or WS/WSS signaling endpoints, and stable peer metadata; room secrets are stored through the scoped native room-secret backend instead of the nonsecret profile document. A WebRTC-only package/profile does not require a Gateway endpoint. Live SDK session/pairing state owns authentication.

Tauri command `details` and readiness `diagnosticCause` payloads are internal support diagnostics only. They may carry redacted implementation context for logs and support exports, but rendered UI must use the mapped product message and safe reference fields instead of showing raw diagnostic keys, values, transport names, local paths, or endpoint details.

The packaged managed sidecar receives isolated `AURORA_CONFIG_FILE`, `AURORA_ENV_FILE`, and `AURORA_DATA_DIR` paths below Tauri's platform application-data directory. The config is created from embedded Aurora defaults on first run, while managed-sidecar policy forces the Gateway active on the selected loopback host/port. This keeps Desktop Local mode from relying on a working-directory `config.json`, writing secrets into a PyInstaller extraction directory, or binding the Gateway broadly. Packaging may provide an explicit `AURORA_TAURI_SIDECAR_CONFIG_FILE` when it needs a prebuilt config.

## Packaging, Signing, And Bundled Sidecar Policy

Tauri bundling is active for Linux, macOS, and Windows desktop targets. `createUpdaterArtifacts=true` makes Tauri produce signed updater artifacts during release builds when `TAURI_SIGNING_PRIVATE_KEY` is present in the process environment. The private signing key and password must be supplied by a secure local secret store or CI secret; they are never committed and `.env` files are not relied on for signing.

The committed updater endpoint and public key are release placeholders. Publishing requires replacing the public key with the generated public key content and using an HTTPS release metadata endpoint. Insecure update transport is not enabled.

Release builds use an ignored `src-tauri/tauri.release.conf.json` overlay whose `bundle.externalBin` references `binaries/aurora-sidecar`. The default local bundle runs `pnpm prepare:sidecar:desktop-local-minimal`; the staging adapter maps that user-facing name to the Python builder's internal `thin` dependency profile. Python-free `build:bundle:thin` and `build:bundle:desktop-thin` never call the sidecar preparer. Heavier local assistant variants (`local-cpu`, `local-cuda`, `local-rocm`, `local-metal`, `local-vulkan`, `local-sycl`, `local-rpc`, and legacy `full`) are explicit release profiles. Profile outputs are isolated under `dist/sidecars/<profile>/aurora-sidecar` and size-guarded before staging so a stale all-in-one artifact cannot silently become the default package. The script copies the result to Tauri's required target-triple suffixed filename before writing the overlay and includes the config-defaults resource needed by the Rust supervisor. Generated sidecar binaries and the release overlay are ignored by git. The default checked-in `tauri.conf.json` omits `externalBin` so `cargo check` and smoke CI do not require release-only sidecar artifacts.

The webview is not granted Tauri shell plugin execute/spawn permissions for the sidecar. The Rust supervisor owns process start/stop, injects only loopback Gateway and in-memory sidecar-token environment, and stops the managed child on window close, explicit shutdown, or app exit.
