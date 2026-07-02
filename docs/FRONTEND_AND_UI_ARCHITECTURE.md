# Frontend and UI architecture

**Status:** Current source of truth

Aurora's production UI architecture is SDK-first. Screens consume normalized `AuroraClient` state and call SDK methods; they do not call Python services, raw Gateway `fetch`, Tauri `invoke`, WebRTC internals, or PyQt bridge objects directly.

## Surfaces

| Surface | Path | Role |
| --- | --- | --- |
| TypeScript SDK | `packages/aurora-sdk` | Transport-independent client, fixtures, events, permissions, policy, tools, scheduler, backup, mesh, HTTP, Tauri, and mock transports. |
| Shared React UI | `packages/aurora-ui` | Production components and screens that depend on SDK state/contracts. |
| Web shell | `apps/aurora-web` | Browser/Next shell that hosts shared UI and uses Gateway-compatible SDK transport. |
| Tauri shell | `apps/aurora-tauri` | Desktop/mobile native shell, Rust command bridge, secure storage posture, sidecar supervision, and platform plugin skeletons. |
| PyQt fallback | `app/ui/bridge_service.py` | Legacy local fallback/reference for current bus behavior; not the preferred surface for new production screens. |

## Boundary rule

```text
React screen
  -> @aurora/client method/event API
  -> selected SDK transport
  -> Gateway HTTP/SSE, Tauri command bridge, mock transport, or mesh bridge
  -> Aurora bus/service contract
```

Production UI files must stay on the SDK side of this boundary. Tests in `packages/aurora-ui` and `packages/aurora-sdk` enforce that screens do not directly call backend transports.

See [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md).

## SDK transports

| Transport | Purpose |
| --- | --- |
| HTTP/Gateway | Web and remote clients use Gateway routes and event streams. |
| Tauri local/native | Desktop local mode can call narrow Rust commands that supervise the Python sidecar or proxy Gateway-compatible requests. |
| Mock/test | Package tests and visual/resilience suites. |
| Mesh bridge | Interface over peer RPC/capability routing; bridge owns WebRTC/native details. |

The SDK preserves method IDs, bus topics, selector/audit metadata, redaction information, and backend evidence. Tauri IPC and mock transports are not independent sources of truth for service state.

## Tauri desktop modes

| Mode | Behavior |
| --- | --- |
| Desktop local | Rust supervises a Python thread-mode sidecar and exposes a narrow command/session bridge to the SDK. |
| Desktop thin | Tauri shell talks to a remote Gateway; no local sidecar required. |
| Profiled local bundles | Sidecar profile selects thin/local CPU/GPU/full dependency sets. |

Default bundles are unsigned and thin unless an explicit profile/signing configuration is provided. See [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md) and `apps/aurora-tauri/README.md`.

## Platform capability truth matrix

UI copy and controls must report capabilities from SDK/native evidence, not from the presence of a route or shell alone.

| Platform mode | Supported evidence path | Native/local claims allowed | Required limit copy |
| --- | --- | --- | --- |
| Web thin | HTTP/Gateway SDK transport selected with `VITE_AURORA_GATEWAY_URL`. | Gateway-backed assistant/admin/runtime state, browser-supported permissions only. | No Tauri sidecar, keychain, Android role, or iOS App Intent claims. |
| Desktop local | `pnpm --filter @aurora/tauri-ui tauri dev` or packaged local build starts/probes the Rust-supervised Python sidecar and loopback Gateway. | Local sidecar status, secure storage, Gateway health, and native desktop command evidence. | Dev uses direct Python sidecar defaults; packaged builds stage profiled sidecar executables separately. |
| Desktop thin | Tauri shell uses Gateway HTTP transport against an operator-managed endpoint. | Tauri shell capability evidence plus remote Gateway data. | No local Python sidecar readiness claim unless local mode is explicitly enabled. |
| Linux CI | Vitest/Playwright route gates, `tauri:smoke:linux`, `cargo check`, `dev:smoke` under Xvfb. | Linux desktop smoke and policy baseline evidence. | Linux cannot satisfy iOS build/preflight evidence and does not replace Android emulator/device evidence. |
| Android | Tauri generated Android project, Android native plugin payloads, emulator/device smoke, Android preflight reports. | Assistant role, fallback entrypoints, Android Keystore, biometric/admin-unlock states only from native manifest payloads. | PR preflight can be unsigned; release readiness requires signing inputs and signed AAB/Play evidence. |
| iOS | iOS manifest policy on any platform; Tauri iOS init/build, simulator/device, and `ios:preflight` on macOS/Xcode. | Siri/Shortcuts/App Intents, share/deep-link/widget/file-association evidence after native targets exist. | Aurora must not claim default iOS system-assistant ownership. Full build/preflight requires macOS/Xcode. |

## Tauri security posture

The Tauri shell grants only Aurora-owned command/capability surfaces needed by the SDK. Broad shell, filesystem, process-spawn, notification, dialog, clipboard, and updater capabilities remain denied unless explicitly documented and tested.

See `apps/aurora-tauri/SECURITY.md`.

## PyQt fallback status

PyQt remains useful for local/reference behavior and older workflows. New production UI work should not extend PyQt as the primary UX architecture. When PyQt behavior is still the only implementation of a workflow, document it as a fallback/partial state in [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) and add SDK/Tauri tests before claiming parity.

`docs/UI_INTEGRATION.md` is retained as the PyQt UIBridge reference. Historical migration notes were moved to `docs/archive/UIBRIDGE_TAURI_MIGRATION.md`.

## Required docs updates for UI changes

When changing frontend behavior, update the narrowest relevant set:

- SDK contract/transport changes: `packages/aurora-sdk/README.md`, [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md), and SDK tests.
- Shared UI behavior: `packages/aurora-ui/README.md`, [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md), and UI tests.
- Tauri command/security/sidecar behavior: `apps/aurora-tauri/README.md`, `apps/aurora-tauri/SECURITY.md`, [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md), and Tauri tests.
- User-facing architecture changes: this document and [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md).

## Validation commands

```bash
pnpm --filter @aurora/client test
pnpm --filter @aurora/client test:resilience
pnpm --filter @aurora/ui test
pnpm --filter @aurora/ui test:accessibility
pnpm --filter @aurora/tauri-ui test
pnpm --filter @aurora/tauri-ui typecheck
pnpm --filter @aurora/tauri-ui tauri:smoke:linux
pnpm --filter @aurora/tauri-ui ios:policy
```

Run `pnpm --filter @aurora/tauri-ui dev:smoke` in a GUI-capable environment when validating the desktop-local sidecar/WebView path. Run iOS build/preflight commands only on macOS with Xcode.
