# Native profile isolation: source-backed admission

## Finding

On Linux, per-run XDG roots plus a private D-Bus session provide a grounded way to isolate Aurora's filesystem paths and the single-instance bus name while keeping the same OS user and the normal dynamically selected runtime role. They do **not** isolate Linux keyutils. The existing debug-only `desktop-native-voice-e2e` credential builder is the only source-supported way found here to avoid sharing the host's default keyring: it is process-only memory storage and changes keyring persistence semantics. Therefore this is a viable disposable native profile for one in-process run, not proof of production keyring behavior or safe reuse across launches.

## Source basis

- `apps/aurora-tauri/src-tauri/tauri.conf.json:5` sets bundle identifier `dev.aurora.desktop`.
- Locked Tauri `2.11.3` `src/path/desktop.rs:238-269` resolves app config/data/cache dirs by calling `dirs::{config_dir,data_dir,cache_dir}` and appending that identifier. Locked `dirs 6.0.0` `src/lin.rs:8-16` reads absolute `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, and `XDG_STATE_HOME`; relative values are ignored in favor of home-directory defaults. `app_config_dir` is also the parent of the local SQLite DB: `apps/aurora-tauri/src-tauri/src/local_data_native.rs:3107-3124`. App data also supplies node-config and speech-pack roots (`src/lib.rs:9704-9714`, `src/native_speech_host.rs:1374-1378,1510-1517,1711-1715,1832-1837`). Tauri's runtime directory uses `XDG_RUNTIME_DIR` directly (`tauri-2.11.3/src/path/desktop.rs:183-187`).
- Cargo.lock resolves `keyring 3.6.3`; the app enables its `linux-native` feature without Secret Service features (`src-tauri/Cargo.toml:60`). That selects keyutils as the default backend (`keyring-3.6.3/src/lib.rs:207-216`), which is associated with the current OS user, not these XDG roots or the session bus.
- The already-supported test builder is installed only for debug desktop builds with feature `desktop-native-voice-e2e` and environment `AURORA_DESKTOP_NATIVE_VOICE_E2E=1` (`src-tauri/Cargo.toml:21-23`, `src/lib.rs:9632-9639`). Its key tuple is target/service/user, its store is an in-process `Arc<Mutex<HashMap<...>>>`, and persistence reports `ProcessOnly` (`src/desktop_native_voice_e2e_keyring.rs:10-45`). It replaces the app-wide keyring builder, not just one voice key namespace. It also holds local-data envelope keys (`src/lib.rs:7608-7665`) and desktop thin-profile data (`src/lib.rs:6777-6779`); those values disappear when the process exits. A resulting private SQLite DB must be treated as disposable and not reopened by a later process.
- The locked `tauri-plugin-single-instance 2.4.2` Linux implementation claims `<app identifier>.SingleInstance` on the session bus (`tauri-plugin-single-instance-2.4.2/src/platform_impl/linux.rs:36-64`). Aurora registers that plugin first (`src/lib.rs:9671-9680`). A private `dbus-run-session` therefore isolates the stable application bus name from the normal desktop session without changing the application identifier.

## Future invocation shape

Root should first finish the currently running condition and then use a fresh, mode-0700 scratch directory under the current user's absolute `XDG_RUNTIME_DIR`. Keep `HOME`, UID, binary identity, normal profile/onboarding flow, and application runtime role resolution unchanged. Do not set runtime-role variables, modify profile/config defaults, copy host keyring entries, or reuse this scratch root after the process exits.

```sh
test -n "${XDG_RUNTIME_DIR:-}" && test "${XDG_RUNTIME_DIR#/}" != "$XDG_RUNTIME_DIR"
profile_root="$(mktemp -d "$XDG_RUNTIME_DIR/aurora-native-profile.XXXXXXXX")"
chmod 700 "$profile_root"
install -d -m 700 "$profile_root/data" "$profile_root/config" \
  "$profile_root/state" "$profile_root/cache" "$profile_root/runtime"
dbus-run-session -- env \
  XDG_DATA_HOME="$profile_root/data" \
  XDG_CONFIG_HOME="$profile_root/config" \
  XDG_STATE_HOME="$profile_root/state" \
  XDG_CACHE_HOME="$profile_root/cache" \
  XDG_RUNTIME_DIR="$profile_root/runtime" \
  AURORA_DESKTOP_NATIVE_VOICE_E2E=1 \
  /absolute/path/to/already-built/debug/aurora-tauri
```

The executable must already be a debug build with `desktop-native-voice-e2e`; this note does not authorize a build or a launch. The application should be initialized through ordinary onboarding/profile selection inside this scratch data/config/keyring scope. Before accepting any result, verify from the actual run that the effective app-config DB path, node-config root, speech-pack root, cache path, runtime path, and D-Bus address resolve inside this run's private roots/session; retain only bounded path-containment booleans and hashes in the report. Confirm the process was the sole instance, exited cleanly, and its children/resources retired. Remove only this exact mode-0700 scratch root after shutdown.

## Limits and unresolved boundary

The source establishes how the path and DBus inputs are read; it is not runtime evidence that every transitive library honors them or that the target package was built with the E2E feature. Process-only keyring deliberately cannot validate OS-keyring persistence, and local-data encryption keys are lost on exit, so a second-process reopen is unsupported with this backend. Any required acceptance that needs host-keyring persistence, cross-process encrypted local data, an existing user's saved desktop-thin profile, or other persisted OS-account credentials remains unresolved by this isolation method; stop rather than silently fall back to the host keyring or change the user's role/account.
