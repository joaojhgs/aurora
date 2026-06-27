# Aurora iOS Native Plugin

This Swift package is the IOS-004 iOS native capability scaffold for the official Tauri mobile plugin model.

It exposes:

- `nativeCapabilityManifest`
- `iosInvocationStatus`
- `iosEntrypointPayload`

The plugin reports App Intents, Shortcuts, share extension, deep-link, widget, and file-association capability evidence. It does not run Aurora orchestration in Swift. Native entrypoints must pass redacted payload metadata back to the SDK/backend, where attachment/context ingestion, policy, audit, and storage decisions remain authoritative.

The Xcode-managed App Intent, share extension, widget extension, associated domains, and generated iOS project wiring must be validated on macOS/Xcode with `tauri ios build` and simulator/device invocation. Linux tests only validate the SDK/Rust manifest contract.
