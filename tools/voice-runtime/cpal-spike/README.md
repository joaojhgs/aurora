# Aurora CPAL Phase 4 Spike

This is a standalone feasibility spike for `cpal` 0.17.3. It is intentionally
outside the root Rust workspace and does not add a production dependency.

## Scope

- Rust: 1.88.0.
- Dependency: `cpal = 0.17.3`.
- Commands:
  - `cargo +1.88.0 run -- list`
  - `cargo +1.88.0 run -- capture --seconds 1`
  - `cargo +1.88.0 run -- playback --seconds 1`
- Capture and playback are bounded to 5 seconds and only run when explicitly
  requested.

## Platform Decision

- Desktop: CPAL 0.17.3 is the primary Rust feasibility candidate for device
  enumeration and bounded stream open checks.
- Android: Kotlin `AudioRecord`/`AudioManager` should be the primary data plane
  into Rust-owned bounded PCM buffers. CPAL Android remains a comparison spike,
  not the production owner.
- iOS: Swift `AVAudioEngine`/`AVAudioSession` should be the primary data plane
  into Rust-owned bounded PCM buffers. CPAL iOS remains a comparison spike, not
  the production owner.
- Web: `AudioWorklet` is the primary capture/playback surface. CPAL's web path
  needs nightly/browser-specific support and is not selected for production.

## Validation Commands

```bash
cargo +1.88.0 fmt --check
cargo +1.88.0 test
cargo +1.88.0 clippy --all-targets -- -D warnings
cargo +1.88.0 run -- list
ANDROID_HOME=/path/to/android-sdk ./scripts/android-check.sh
```

The Android helper resolves `ANDROID_NDK_HOME`, `ANDROID_NDK_ROOT`,
`ANDROID_HOME/ndk/27.0.12077973`, or `ANDROID_SDK_ROOT/ndk/27.0.12077973`, then
exports the two `CARGO_TARGET_*_LINKER` variables before compiling
`aarch64-linux-android` and `x86_64-linux-android`. It does not claim a device
stream has opened on Android.

The standalone `Cargo.lock` is deliberate. This spike is outside the root Rust
workspace, and the lockfile keeps the exact `cpal` 0.17.3 transitive dependency
set reproducible for Phase 4 evidence.
