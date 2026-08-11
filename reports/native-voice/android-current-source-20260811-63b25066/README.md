# Current-source Android build and API 35 smoke attempt

Result: **the current-source APK and static policy checks pass; runtime smoke is blocked before app launch**.

## Artifact and static verification

The universal debug client APK was built from feature-branch HEAD
`63b250660dd07011dac6c12a92e983f9c01e2553`, whose application-code baseline
is `b3b76826`. The artifact is 1,271,390,157 bytes with SHA-256
`c99008ea74dc6cd21996e0a0467a8c4d86ffafe819bf51e545514606700a946e`.
It contains all four Android ABIs, has no staged Python sidecar, has no compiled
Gateway or signaling origin, and uses runtime-configured endpoints. The build
does not select Aurora's runtime role; the one APK continues to resolve roles
from persisted onboarding/profile state.

The maintained build and artifact-policy commands passed. The archive scan
checked 1,010 entries and found no forbidden content. Fourteen client-bundle
tests and 53 focused Android policy/harness tests passed. Android preflight
reported 27 passing checks and one expected blocked check: release signing
inputs are not configured. The APK is debug-signed and is not release
evidence. Fresh raw Vitest output for the 14-test bundle run and the 53-test
focused run is retained in `static-test-output.txt` with SHA-256
`3df112c65f66e0df29b5f9b30dd2080028b6cc0f3060d0105d0881ad32412331`.

## Maintained API 35 smoke

The repository AVD `aurora_api35_google` ran on `emulator-5560` with API 35,
x86_64 Google APIs, software TCG (`-accel off`), no window/audio/boot
animation, SwiftShader, and snapshots disabled. This is neither KVM/CI-equivalent
nor physical-device evidence.

ADB and the package manager first appeared ready at 232 seconds. The maintained
`pnpm --filter @aurora/tauri-ui android:smoke` command then ran without source
or timeout-policy changes. The 1.27 GB APK push passed in 88.778 seconds.
Installation failed before Aurora launched:

```text
cmd: Failure calling service package: Broken pipe (32)
```

Logcat records Android's watchdog killing the system process after its main
thread was blocked for 60 seconds, followed by `DeadSystemException` failures.
Because the app process never launched, this attempt proves no rendered UI,
native payload, navigation, lifecycle, pairing, or voice behavior. It is an
environment-scoped software-TCG failure, not a passed or failed Aurora UI
assertion.

The single maintained attempt exited 1 after 186 seconds; total emulator time
was 425 seconds. Cleanup succeeded, leaving no ADB device or emulator process.
Session logs remain under
`/tmp/aurora-api35-current-source-smoke-20260811T023117Z`; their hashes are
recorded in `result.json`.

## Other open device gates

Waydroid at `192.168.240.112:5555` still returns `No route to host`. Its bridge
has no carrier and no ADB device is present. Prior tracked Waydroid evidence
records the host container as stopped and restart as requiring unavailable root
or polkit authority. Therefore the current APK was not installed or navigated
through MobileMCP on Waydroid.

RAC-33 and RAC-50 remain `partial`. Current-source build provenance and static
policy checks are recorded here, but current-source rendered UI,
make-device-available continuation, clean restart persistence, pairing, a
complete Gateway/UI voice turn, CI-equivalent KVM validation, release signing,
and physical-device proof remain open.
