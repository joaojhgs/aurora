# API 35 software-QEMU validation attempt

Result: **blocked; no Android smoke pass is claimed**.

The repository-owned `aurora_api35_google` AVD was launched on `emulator-5560`
with API 35, x86_64, Google APIs, software TCG (`-accel off`), no window, no
audio, no boot animation, SwiftShader, and snapshots disabled. The exact APK
selected for the attempt was built from `8fff7af6` with SHA-256
`83256515b81e87f3fd28e9a5122c0d6a5dd20d7b7507591daff475bc6de0f24c`.
It predates later presentation fixes through `b3b76826` and is not an exact
artifact of the current source checkpoint.

ADB reached `device` at 164 seconds and the Android package manager became
ready at 486 seconds. Android never set `sys.boot_completed=1` through the
final 711-second poll, so the maintained `android:smoke` runner was correctly
not started. This attempt does not replace CI-equivalent KVM validation and
does not prove install, launch, rendered UI, lifecycle, voice, or performance.

The emulator reported that the current user could not access `/dev/kvm`,
warned that x86_64 emulation may not work without hardware acceleration, and
emitted repeated X11 authorization plus TCG AVX/F16C warnings. Cleanup
succeeded with `adb -s emulator-5560 emu kill`; the post-run ADB inventory was
empty.

Files:

- `result.json` — redacted structured verdict and artifact identity.
- `boot.log` — bounded readiness polling and cleanup trace.

The original session-local emulator log was 125,310 bytes with SHA-256
`b00c7e88e4320c3408a36b5b22c8f76f967316882d4c3f0a47718c7ac61b13b3`;
it is summarized rather than committed because it is dominated by repeated
emulator/X11 warnings.
