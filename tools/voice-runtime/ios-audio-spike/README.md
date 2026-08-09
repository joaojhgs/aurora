# Aurora iOS Audio Spike

This Phase 4 spike proves the planned iOS audio boundary without claiming a
Linux-host iOS runtime. It models foreground `AVAudioSession` plus
`AVAudioEngine` capture, sends Float32 PCM frames through a narrow C ABI, and
stores audio only in a Rust-owned bounded queue.

The Rust state rejects null pointers, empty chunks, non-finite samples, zero
sample rates, and oversized chunks. It reports backpressure instead of growing
unbounded, counts discontinuities, clears queued PCM on shutdown, and never logs
raw PCM.

The Swift fragment is intentionally foreground-only. Durable wake/background
behavior still requires a platform-native production adapter and is not proven
by this spike.

Linux verification is limited to Rust checks and Python structural tests. The
build script fails closed outside macOS or without Xcode. A macOS runner with
Xcode can run `scripts/build-rust-ios.sh` after installing the listed Rust iOS
targets, then link the produced static libraries into the Swift package or a
Tauri iOS target. Simulator execution, device capture, signing, interruption,
route-change, and background-session behavior remain unproven here.
