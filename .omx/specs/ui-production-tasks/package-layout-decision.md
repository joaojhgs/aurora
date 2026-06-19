# Aurora UI Package Layout Decision

Date: 2026-06-19
Status: accepted planning baseline for P0-004; no production package scaffold in this task.
Branch target: `feat/ui-multi-platform-integration`

## Scope

This document fixes the future production workspace layout for Aurora's TypeScript SDK, shared UI, web app, official Tauri 2 app, desktop sidecar bridge, Android native plugin, and iOS native plugin/extensions.

The current repository remains Python-runtime-first. `pyproject.toml` stays the source of truth for Aurora services. `modules/ui-mock-reference/` remains reference-only and is not a production package boundary.

## Decision

Future production UI/native work will use a root JavaScript/Rust workspace with these directories:

| Path | Package or crate name | Owner lane | Purpose |
| --- | --- | --- | --- |
| `packages/aurora-sdk` | `@aurora/client` | SDK | Transport-independent TypeScript client, generated backend types, normalized envelopes, auth/session state, capability graph, route/privacy helpers, and test fixtures. |
| `packages/aurora-ui` | `@aurora/ui` | UI | Shared React components, design tokens, accessibility primitives, state renderers, route/privacy UI, and SDK-bound hooks. |
| `apps/aurora-web` | `@aurora/web` | UI | Browser/server-web application. It consumes `@aurora/client` and `@aurora/ui`; it must not call Gateway, Tauri IPC, Python services, or WebRTC directly. |
| `apps/aurora-tauri/src` | `@aurora/tauri-ui` | Tauri desktop | Frontend bundle for the official Tauri 2 desktop app. It consumes `@aurora/client` and `@aurora/ui`. |
| `apps/aurora-tauri/src-tauri` | `aurora-tauri` | Tauri desktop | Official Tauri 2 Rust shell, typed commands, sidecar supervision, secure IPC, updater, permissions/capabilities, and platform plugin glue. |
| `apps/aurora-tauri/sidecars` | not independently published | Tauri desktop/backend integration | Packaging manifests and entrypoint wrappers for supervising local Aurora Python service processes. Runtime code stays under the existing Python `app/` tree unless a future task explicitly extracts it. |
| `native/android` | `aurora-android-plugin` | Android native | Kotlin native plugin source, Android capability manifest provider, assistant-role proof, permissions, foreground-service declarations, emulator/build fixtures, and Android-specific CI. |
| `native/ios` | `aurora-ios-plugin` | iOS native | Swift native plugin source, App Intents, Shortcuts, widgets/share extensions, file/deep-link associations, Keychain/biometric storage, device fixtures, and iOS-specific CI. |

## Import Direction

Allowed import direction:

```text
apps/aurora-web -> packages/aurora-ui -> packages/aurora-sdk
apps/aurora-web -----------------------> packages/aurora-sdk
apps/aurora-tauri/src -> packages/aurora-ui -> packages/aurora-sdk
apps/aurora-tauri/src -----------------> packages/aurora-sdk
apps/aurora-tauri/src-tauri -> packaged Python sidecar process/Gateway contracts only
native/android -> Tauri mobile plugin bridge and generated native capability manifest
native/ios -> Tauri mobile plugin bridge and generated native capability manifest
packages/aurora-sdk -> generated backend contract artifacts only
```

The SDK is the only production TypeScript package that may know backend transport details. UI packages and apps consume SDK interfaces and view models.

## Forbidden Dependencies

- `packages/aurora-ui`, `apps/aurora-web`, and `apps/aurora-tauri/src` must not use direct `fetch`, raw WebSocket/SSE clients, Tauri `invoke`, Python service objects, or raw WebRTC APIs for Aurora service state. They must use `@aurora/client`.
- `packages/aurora-sdk` must not import React, Next.js, Tauri frontend APIs, native mobile APIs, or components from `@aurora/ui`.
- `packages/aurora-ui` must not import app routes, app stores, Tauri Rust command bindings, native plugin code, Python modules, or generated Python files directly.
- `apps/aurora-tauri/src-tauri` must not become a second source of truth for Aurora services, mesh, auth, tools, DB, scheduler, or audio. It returns backend evidence through typed commands and sidecar/Gateway contracts.
- `native/android` and `native/ios` must not import production React app code. Native capability state flows through Tauri/mobile plugin bridges and the SDK native capability manifest.
- Production packages must not import from `modules/ui-mock-reference/`. Components may be copied from the mock only with attribution, review, fixture removal, and migration into `packages/aurora-ui` or an app-owned directory.
- No package may claim backend, mesh, Tauri, native, audio, Auth/RBAC, process-mode, or transport parity behavior from frontend-only fixtures.

## Build And CI Ownership

| Surface | Build owner | Required future baseline |
| --- | --- | --- |
| Root JS workspace | P0-003/frontend readiness | Package manager workspace, lint/typecheck/test/build commands, dependency boundaries. |
| `@aurora/client` | SDK lane | Type generation, contract conformance tests, transport fixtures, HTTP/Tauri/mesh adapter parity. |
| `@aurora/ui` | UI lane | Component tests, accessibility checks, visual states for backend-proven/pending/denied/degraded/stale/privacy-blocked/deferred states. |
| `@aurora/web` | UI lane | Browser build, route tests, SDK transport integration fixtures. |
| `aurora-tauri` | Tauri lane | Rust checks/tests, Tauri 2 configuration, command permission/capability tests, desktop WebDriver E2E where platform support exists. |
| Desktop sidecars | Tauri lane with backend review | Sidecar packaging smoke, isolated profile/config/data dirs, process lifecycle evidence. |
| Android native | Android lane | Gradle/Tauri Android build, emulator smoke, RoleManager/assistant-role capability evidence, permission states. |
| iOS native | iOS lane | Xcode/Tauri iOS build on macOS, App Intents/extension compile checks, simulator/device smoke where available. |

## Runtime Boundaries

- Server Web and Desktop Thin use HTTP/WebSocket/SSE SDK transports only.
- Desktop Local uses the official Tauri 2 Rust shell to supervise or connect to a local Aurora node, but UI state still comes through `@aurora/client`.
- Mesh Shell surfaces require provider identity, route explain/selector evidence, policy result, provenance, and audit/correlation data before enabling remote actions.
- Android and iOS native capabilities are manifest-driven and permission-gated. iOS must not claim Siri replacement; Android assistant-role support must be proven by native package qualification and runtime role state.

## Static Workspace Graph

The machine-readable graph for this decision is `.omx/specs/ui-production-tasks/package-layout-workspace-graph.json`. It is a planning artifact until P0-003/SDK-001/TAURI-001/AND-001/IOS-001 create the actual workspace manifests.

Validation command:

```bash
python -m json.tool .omx/specs/ui-production-tasks/package-layout-workspace-graph.json >/tmp/package-layout-workspace-graph.pretty.json
```

Current repository check:

```bash
find . -maxdepth 3 \( -name package.json -o -name pnpm-workspace.yaml -o -name Cargo.toml -o -name turbo.json -o -name nx.json \) -print
```

Expected result before scaffolding: only `modules/ui-mock-reference/package.json` exists. Any future root/package manifests must match this decision or update this document in the same change.

## Downstream Task Mapping

- P0-003 creates the root package manager/workspace baseline and must encode these package paths.
- SDK-001 owns `packages/aurora-sdk`.
- UI-001 owns first production use of `packages/aurora-ui` and `apps/aurora-web`.
- TAURI-001 owns `apps/aurora-tauri/src` and `apps/aurora-tauri/src-tauri`.
- TAURI-002 owns sidecar supervision under `apps/aurora-tauri/sidecars` plus any Python entrypoint changes.
- AND-001/AND-002 own `native/android`.
- IOS-001/IOS-002 own `native/ios`.

## Review Gate

Before any production scaffold task proceeds, the implementing agent must check this document and the graph artifact, then keep package names, import direction, forbidden dependencies, and CI ownership consistent unless that task explicitly updates the decision.
