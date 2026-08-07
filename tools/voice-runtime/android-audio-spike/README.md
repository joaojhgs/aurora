# Aurora Android Audio Phase 4 Spike

This standalone spike proves the selected Android local-audio data plane:
Kotlin owns focused `AudioRecord` lifecycle and permission-facing Android APIs,
while Rust 1.88 owns bounded PCM ingestion, discontinuity tracking, shutdown,
and backpressure accounting.

It is intentionally outside the production app and outside the root Rust
workspace. It commits source and portable scripts only; generated APKs, Rust
targets, Gradle state, and emulator output stay ignored under this directory.

## Scope

- Rust: `1.88.0`, no third-party crates.
- Android: Kotlin `AudioRecord` plus `AudioManager`.
- Bridge: Kotlin -> JNI C shim -> narrow Rust C ABI.
- ABIs: `arm64-v8a` and `x86_64`.
- Minimum Android API: 26.

## Data-Plane Contract

- Kotlin never logs PCM contents.
- Capture is started and stopped explicitly.
- Each read copies only the valid sample count before crossing JNI.
- Rust accepts a maximum per-chunk sample count and bounded queue capacity.
- Rust returns backpressure instead of growing unbounded state.
- Rust records discontinuities when sequence numbers skip.
- Shutdown cancels future ingestion and clears buffered PCM.

## Validation

```bash
cd tools/voice-runtime/android-audio-spike
cargo +1.88.0 fmt --check --manifest-path native/Cargo.toml
cargo +1.88.0 test --manifest-path native/Cargo.toml
cargo +1.88.0 clippy --all-targets --manifest-path native/Cargo.toml -- -D warnings
ANDROID_HOME=/path/to/sdk ./scripts/build-rust-android.sh
ANDROID_HOME=/path/to/sdk ./scripts/build-android.sh
ANDROID_HOME=/path/to/sdk ./scripts/run-emulator-smoke.sh
```

`build-rust-android.sh` resolves `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`, or the
pinned NDK under `ANDROID_HOME` / `ANDROID_SDK_ROOT`. `build-android.sh`
requires either `GRADLE_BIN` or `gradle` on `PATH` and fails closed otherwise.
Both scripts avoid committed machine-specific paths.

The emulator smoke installs the debug APK, grants microphone permission when a
device is available, launches a bounded no-permission synthetic ingestion path,
and verifies Rust stats through logcat summary counters. It does not claim
physical microphone proof; emulator audio input availability varies by host.
