# IOS-008 — Implement iOS signing, TestFlight/App Store, and device matrix gate


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P5 — iOS native integration lane
- **Lane:** ios-native
- **Depends on:** IOS-001, IOS-003, IOS-004
- **Parallelizable with:** None
- **Coverage matrix rows:** native.ios.invocation, voice.audio.mode_matrix
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Implement iOS-specific native capability safely inside official Tauri mobile architecture.

## User-visible outcome

iOS release path is production-ready and policy-safe.

## Backend/API implementation details

- No backend contract changes are expected in this task. If implementation discovers a missing backend dependency, create/link the relevant `BE-*` task instead of widening this task silently.

## SDK integration details

- Expose iOS native states through same SDK native manifest as Android/Desktop.
- Capability graph must state iOS cannot replace Siri; it can integrate via App Intents/Shortcuts/widgets/share/deep links.

## Tauri/native integration details

- Use Tauri iOS mobile plugin model: Swift class extends Tauri `Plugin`; `@objc` functions with `Invoke` bridge to JS/Rust.
- Use Xcode-managed targets/extensions for App Intents/share/widget as required.

## UI/UX implementation details

- Settings/Permissions screen shows iOS-specific states and copy must not promise Siri replacement.

## Code references to inspect first

- Future Tauri iOS project/plugin files
- `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx` iosStates
- `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx`

## Mock/component references

- `modules/ui-mock-reference/components/aurora/settings/settings-permissions-view.tsx` iosStates
- `modules/ui-mock-reference/components/aurora/onboarding/onboarding-view.tsx`

## Data, permissions, and privacy contract

- Source: https://v2.tauri.app/develop/plugins/develop-mobile/
- Source: https://v2.tauri.app/distribute/app-store/
- Source: https://developer.apple.com/documentation/appintents
- Source: https://developer.apple.com/documentation/SiriKit/creating-an-intents-app-extension
- Source: https://developer.apple.com/documentation/sirikit/structuring-your-code-to-support-app-extensions
- Source: https://v2.tauri.app/learn/mobile-file-associations/

## Acceptance criteria

- Build/test requires macOS + Xcode; Linux cannot satisfy this task.
- App Intents and extensions are scoped to concrete Aurora actions and privacy labels.
- UI copy says “Siri/Shortcuts/App Intents integration”, not “replace Siri”.

## Verification commands / evidence

- `tauri ios build` / Xcode build on macOS CI.
- Simulator/device invocation of native plugin and at least one App Intent/share flow.
- App Store/TestFlight signing dry run for release tasks.

## Risks and guardrails

- Apple platform policy and entitlement limits may constrain background/audio/extension behavior.
- Do not duplicate orchestrator logic in Swift; bridge to SDK/backend.

## Handoff notes

- No additional handoff notes at planning time.
