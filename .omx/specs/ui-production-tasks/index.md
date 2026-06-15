# Aurora UI Production Implementation Task Index

Date: 2026-06-14
Status: implementation-planning baseline; no production implementation included.

## Purpose

This directory decomposes the full Aurora UI/product plan into individually implementable production tasks. It covers backend/API gaps, transport-independent SDK, Tauri desktop, Android/iOS native plugins, assistant UI, admin/operator dashboard, mesh/WebRTC, security/privacy, QA and release.

## Non-negotiable implementation rules

- Production screens must call `AuroraClient`; never direct `fetch`, Tauri `invoke`, Python service objects, or raw WebRTC APIs from screen components.
- Backend service-to-service communication remains bus-only with typed topic constants and Pydantic/IOModel payloads.
- `method_type="manage"` and admin-critical operations must go through AdminAction draft/confirm/audit once BE-004 exists.
- Capability graph owns feature availability; UI must explain disabled/degraded states instead of hiding ambiguity.
- Official Tauri 2/Rust shell is the production native runtime. Python-backed Tauri forks remain prototype-only.
- Android assistant role is conditional: Tauri/Kotlin can support plugins/manifest/service declarations, but OS role grant requires package qualification plus user/OEM/profile support.
- iOS integrates through App Intents, Shortcuts, widgets, share extensions, file/deep links, and in-app voice; it must not claim Siri replacement.

## Official platform evidence used

- Tauri mobile plugins: https://v2.tauri.app/develop/plugins/develop-mobile/
- Tauri permissions/capabilities: https://v2.tauri.app/security/permissions/
- Tauri configuration: https://v2.tauri.app/develop/configuration-files/
- Tauri App Store/iOS: https://v2.tauri.app/distribute/app-store/
- Tauri mobile file associations: https://v2.tauri.app/learn/mobile-file-associations/
- Android RoleManager: https://developer.android.com/reference/android/app/role/RoleManager
- Android RoleManagerCompat ROLE_ASSISTANT: https://developer.android.com/reference/androidx/core/role/RoleManagerCompat
- Android VoiceInteractionService: https://developer.android.com/reference/android/service/voice/VoiceInteractionService
- Android notifications: https://developer.android.com/develop/ui/views/notifications
- Apple App Intents: https://developer.apple.com/documentation/appintents
- Apple Intents extension: https://developer.apple.com/documentation/SiriKit/creating-an-intents-app-extension
- Apple extensions structure: https://developer.apple.com/documentation/sirikit/structuring-your-code-to-support-app-extensions


## Crosswalk artifacts

- [Flow-to-task coverage](flow-to-task-coverage.md) maps every assistant/admin/mobile/mesh/runtime flow to mock component references, missing visual states, and production task IDs.
- [Backend/API gap crosswalk](backend-gap-crosswalk.md) maps code-grounded backend gaps to backend tasks and downstream UI/SDK tasks.
- [Task manifest](manifest.md) provides a compact import-friendly ID/phase/dependency/path table.

## Implementation phase order and parallelism

The critical path is: P0 baseline → SDK core/contract inventory → backend gaps that unblock honest UI → UI shell/read-only surfaces → AdminAction/mutations → Tauri/native/mobile integration → QA/release. Many lanes can run in parallel after their explicit dependencies are met.

### P0 — Production planning baseline and repository readiness

- [ ] [P0-001 — Freeze production UI scope, terms, and task-board contract](tasks/P0-001-freeze-production-ui-scope-terms-and-task-board-contract.md) _(lane: planning; deps: None)_
- [ ] [P0-002 — Generate live backend contract, route, permission, and exposure inventory](tasks/P0-002-generate-live-backend-contract-route-permission-and-exposure-inventory.md) _(lane: backend/readiness; deps: None)_
- [ ] [P0-003 — Establish frontend package lint/type/build/test baseline](tasks/P0-003-establish-frontend-package-lint-type-build-test-baseline.md) _(lane: frontend/readiness; deps: None)_
- [ ] [P0-004 — Create monorepo/package layout decision for SDK, UI, Tauri, and native plugins](tasks/P0-004-create-monorepo-package-layout-decision-for-sdk-ui-tauri-and-native-plugins.md) _(lane: architecture; deps: P0-001)_

### P1 — Transport-independent SDK and capability graph foundation

- [ ] [SDK-001 — Scaffold `@aurora/client` TypeScript SDK package and public API](tasks/SDK-001-scaffold-@aurora-client-typescript-sdk-package-and-public-api.md) _(lane: sdk; deps: P0-004)_
- [ ] [SDK-002 — Implement generated backend type ingestion from registry/OpenAPI](tasks/SDK-002-implement-generated-backend-type-ingestion-from-registry-openapi.md) _(lane: sdk; deps: SDK-001, P0-002)_
- [ ] [SDK-003 — Define normalized envelopes, results, errors, and audit metadata](tasks/SDK-003-define-normalized-envelopes-results-errors-and-audit-metadata.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-004 — Implement AuthSession state machine](tasks/SDK-004-implement-authsession-state-machine.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-005 — Implement canonical permission catalog and effective-permission helpers](tasks/SDK-005-implement-canonical-permission-catalog-and-effective-permission-helpers.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-006 — Implement capability graph engine](tasks/SDK-006-implement-capability-graph-engine.md) _(lane: sdk; deps: SDK-001, SDK-002, SDK-004, SDK-005)_
- [ ] [SDK-007 — Implement HTTP Gateway transport adapter](tasks/SDK-007-implement-http-gateway-transport-adapter.md) _(lane: sdk; deps: SDK-001, P0-002)_
- [ ] [SDK-008 — Implement mock transport and contract fixtures](tasks/SDK-008-implement-mock-transport-and-contract-fixtures.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-009 — Implement Tauri local/native transport interface](tasks/SDK-009-implement-tauri-local-native-transport-interface.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-010 — Implement mesh/P2P transport interface](tasks/SDK-010-implement-mesh-p2p-transport-interface.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-011 — Implement event stream abstraction](tasks/SDK-011-implement-event-stream-abstraction.md) _(lane: sdk; deps: SDK-001, SDK-003)_
- [ ] [SDK-012 — Implement route/privacy policy engine](tasks/SDK-012-implement-route-privacy-policy-engine.md) _(lane: sdk; deps: SDK-001)_
- [ ] [SDK-013 — Implement AdminAction client controller](tasks/SDK-013-implement-adminaction-client-controller.md) _(lane: sdk; deps: SDK-001, SDK-003, BE-004)_
- [ ] [SDK-014 — Implement SDK conformance test suite across transports](tasks/SDK-014-implement-sdk-conformance-test-suite-across-transports.md) _(lane: sdk; deps: SDK-001, SDK-007, SDK-008, SDK-009, SDK-010, SDK-011, SDK-013)_

### P2 — Backend contract and gateway/API gaps

- [ ] [BE-001 — Normalize auth/gateway route casing and public bypass behavior](tasks/BE-001-normalize-auth-gateway-route-casing-and-public-bypass-behavior.md) _(lane: backend/gateway; deps: P0-002)_
- [ ] [BE-002 — Add capability manifest endpoint or formal SDK-computed manifest contract](tasks/BE-002-add-capability-manifest-endpoint-or-formal-sdk-computed-manifest-contract.md) _(lane: backend/gateway; deps: P0-002)_
- [ ] [BE-003 — Add unified event stream contract](tasks/BE-003-add-unified-event-stream-contract.md) _(lane: backend/events; deps: P0-002, SDK-003)_
- [ ] [BE-004 — Implement AdminAction draft/confirm/audit enforcement](tasks/BE-004-implement-adminaction-draft-confirm-audit-enforcement.md) _(lane: backend/security; deps: SDK-003)_
- [ ] [BE-005 — Add diagnostics bundle export contract with redaction](tasks/BE-005-add-diagnostics-bundle-export-contract-with-redaction.md) _(lane: backend/diagnostics; deps: BE-004)_
- [ ] [BE-006 — Add backup/restore contracts for config, DB/RAG, and models](tasks/BE-006-add-backup-restore-contracts-for-config-db-rag-and-models.md) _(lane: backend/admin; deps: BE-004)_
- [ ] [BE-007 — Add model runtime/catalog/import/download/benchmark contracts](tasks/BE-007-add-model-runtime-catalog-import-download-benchmark-contracts.md) _(lane: backend/models; deps: P0-002)_
- [ ] [BE-008 — Add attachment/context ingestion contracts](tasks/BE-008-add-attachment-context-ingestion-contracts.md) _(lane: backend/assistant; deps: P0-002)_
- [ ] [BE-009 — Add Orchestrator cancellation/interrupt contract](tasks/BE-009-add-orchestrator-cancellation-interrupt-contract.md) _(lane: backend/orchestrator; deps: P0-002)_
- [ ] [BE-010 — Add config schema metadata, diff, rollback, and reload-impact preview](tasks/BE-010-add-config-schema-metadata-diff-rollback-and-reload-impact-preview.md) _(lane: backend/config; deps: BE-004)_
- [ ] [BE-011 — Add tool risk taxonomy and approval hints](tasks/BE-011-add-tool-risk-taxonomy-and-approval-hints.md) _(lane: backend/tools; deps: P0-002)_
- [ ] [BE-012 — Add pending pairing queue/list/event contract](tasks/BE-012-add-pending-pairing-queue-list-event-contract.md) _(lane: backend/auth-mesh; deps: BE-003)_
- [ ] [BE-013 — Add peer capability manifest and mesh route explain contracts](tasks/BE-013-add-peer-capability-manifest-and-mesh-route-explain-contracts.md) _(lane: backend/mesh; deps: BE-002)_
- [ ] [BE-014 — Add WebRTC/ICE/data-channel diagnostics endpoints/events](tasks/BE-014-add-webrtc-ice-data-channel-diagnostics-endpoints-events.md) _(lane: backend/mesh; deps: BE-003)_
- [ ] [BE-015 — Implement or explicitly gate Supervisor service controls](tasks/BE-015-implement-or-explicitly-gate-supervisor-service-controls.md) _(lane: backend/supervisor; deps: BE-004)_
- [ ] [BE-016 — Add deployment topology, bus health, and process-mode contract](tasks/BE-016-add-deployment-topology-bus-health-and-process-mode-contract.md) _(lane: backend/operations; deps: P0-002, BE-002)_
- [ ] [BE-017 — Add memory/RAG provenance, export, and delete contracts](tasks/BE-017-add-memory-rag-provenance-export-delete-contracts.md) _(lane: backend/db-rag; deps: P0-002, BE-004)_
- [ ] [BE-018 — Add scheduler management exposure and AdminAction contract](tasks/BE-018-add-scheduler-management-exposure-and-adminaction-contract.md) _(lane: backend/scheduler; deps: P0-002, BE-004)_

### P3 — Tauri desktop/native shell foundation

- [ ] [TAURI-001 — Scaffold official Tauri 2 app shell around production UI](tasks/TAURI-001-scaffold-official-tauri-2-app-shell-around-production-ui.md) _(lane: tauri-desktop; deps: P0-004, P0-003)_
- [ ] [TAURI-002 — Implement Rust-supervised desktop Python sidecar/local node](tasks/TAURI-002-implement-rust-supervised-desktop-python-sidecar-local-node.md) _(lane: tauri-desktop; deps: TAURI-001, SDK-009)_
- [ ] [TAURI-003 — Implement secure storage for tokens, mesh credentials, and local secrets](tasks/TAURI-003-implement-secure-storage-for-tokens-mesh-credentials-and-local-secrets.md) _(lane: tauri-desktop; deps: TAURI-001, SDK-004)_
- [ ] [TAURI-004 — Implement Tauri command bridge for local bus and native capability manifest](tasks/TAURI-004-implement-tauri-command-bridge-for-local-bus-and-native-capability-manifest.md) _(lane: tauri-desktop; deps: TAURI-001, SDK-009, BE-002)_
- [ ] [TAURI-005 — Implement desktop native permissions, tray, notifications, dialogs, files, and audio bridge](tasks/TAURI-005-implement-desktop-native-permissions-tray-notifications-dialogs-files-and-audio-bridge.md) _(lane: tauri-desktop; deps: TAURI-001, SDK-009)_
- [ ] [TAURI-006 — Implement desktop packaging, signing, updater, and sidecar bundling](tasks/TAURI-006-implement-desktop-packaging-signing-updater-and-sidecar-bundling.md) _(lane: tauri-desktop; deps: TAURI-002, TAURI-003, TAURI-004)_
- [ ] [TAURI-007 — Map legacy PyQt UIBridge to Tauri/SDK migration contract](tasks/TAURI-007-map-legacy-pyqt-uibridge-to-tauri-sdk-migration-contract.md) _(lane: tauri-desktop; deps: TAURI-004, UIA-001, UIA-004)_

### P4 — Android native integration lane

- [ ] [AND-001 — Create Tauri Android build/emulator CI baseline](tasks/AND-001-create-tauri-android-build-emulator-ci-baseline.md) _(lane: android-native; deps: TAURI-001)_
- [ ] [AND-002 — Create Aurora Android Kotlin native plugin skeleton](tasks/AND-002-create-aurora-android-kotlin-native-plugin-skeleton.md) _(lane: android-native; deps: AND-001, TAURI-004)_
- [ ] [AND-003 — Implement Android native capability manifest provider](tasks/AND-003-implement-android-native-capability-manifest-provider.md) _(lane: android-native; deps: AND-002, SDK-006)_
- [ ] [AND-004 — Implement Android assistant-role qualification prototype](tasks/AND-004-implement-android-assistant-role-qualification-prototype.md) _(lane: android-native; deps: AND-002, AND-003)_
- [ ] [AND-005 — Implement Android voice capture, foreground service, notifications, and permission flows](tasks/AND-005-implement-android-voice-capture-foreground-service-notifications-and-permission-flows.md) _(lane: android-native; deps: AND-003, UI-004)_
- [ ] [AND-006 — Implement Android share sheet, deep links, widgets/shortcuts, and quick tile entrypoints](tasks/AND-006-implement-android-share-sheet-deep-links-widgets-shortcuts-and-quick-tile-entrypoints.md) _(lane: android-native; deps: AND-003, UIA-005)_
- [ ] [AND-007 — Implement Android secure storage and biometric admin unlock](tasks/AND-007-implement-android-secure-storage-and-biometric-admin-unlock.md) _(lane: android-native; deps: AND-003, TAURI-003)_
- [ ] [AND-008 — Implement Android local-light inference provider spike-to-product adapter](tasks/AND-008-implement-android-local-light-inference-provider-spike-to-product-adapter.md) _(lane: android-native; deps: BE-007, AND-003)_
- [ ] [AND-009 — Implement Android release, signing, Play/App Bundle, and device matrix gate](tasks/AND-009-implement-android-release-signing-play-app-bundle-and-device-matrix-gate.md) _(lane: android-native; deps: AND-001, AND-004, AND-005)_

### P5 — iOS native integration lane

- [ ] [IOS-001 — Create macOS/Xcode/Tauri iOS build baseline](tasks/IOS-001-create-macos-xcode-tauri-ios-build-baseline.md) _(lane: ios-native; deps: TAURI-001)_
- [ ] [IOS-002 — Create Aurora iOS Swift native plugin skeleton](tasks/IOS-002-create-aurora-ios-swift-native-plugin-skeleton.md) _(lane: ios-native; deps: IOS-001, TAURI-004)_
- [ ] [IOS-003 — Implement iOS App Intents and Shortcuts invocation](tasks/IOS-003-implement-ios-app-intents-and-shortcuts-invocation.md) _(lane: ios-native; deps: IOS-002, SDK-006)_
- [ ] [IOS-004 — Implement iOS share extension, deep links, widgets, and file associations](tasks/IOS-004-implement-ios-share-extension-deep-links-widgets-and-file-associations.md) _(lane: ios-native; deps: IOS-002, UIA-005)_
- [ ] [IOS-005 — Implement iOS Keychain/biometric secure storage and admin unlock](tasks/IOS-005-implement-ios-keychain-biometric-secure-storage-and-admin-unlock.md) _(lane: ios-native; deps: IOS-002, TAURI-003)_
- [ ] [IOS-006 — Implement iOS microphone, notifications, background limits, and voice UX states](tasks/IOS-006-implement-ios-microphone-notifications-background-limits-and-voice-ux-states.md) _(lane: ios-native; deps: IOS-002, UI-004)_
- [ ] [IOS-007 — Implement iOS local-light inference provider adapter](tasks/IOS-007-implement-ios-local-light-inference-provider-adapter.md) _(lane: ios-native; deps: BE-007, IOS-002)_
- [ ] [IOS-008 — Implement iOS signing, TestFlight/App Store, and device matrix gate](tasks/IOS-008-implement-ios-signing-testflight-app-store-and-device-matrix-gate.md) _(lane: ios-native; deps: IOS-001, IOS-003, IOS-004)_

### P6 — Product UI shell and cross-cutting UX

- [ ] [UI-001 — Build production app shell, routes, navigation, and design tokens](tasks/UI-001-build-production-app-shell-routes-navigation-and-design-tokens.md) _(lane: ui-shell; deps: P0-003, SDK-001)_
- [ ] [UI-002 — Implement capability-driven navigation and feature drawer](tasks/UI-002-implement-capability-driven-navigation-and-feature-drawer.md) _(lane: ui-shell; deps: UI-001, SDK-006)_
- [ ] [UI-003 — Implement onboarding, connection, pairing, and auth/session flows](tasks/UI-003-implement-onboarding-connection-pairing-and-auth-session-flows.md) _(lane: ui-auth; deps: UI-001, SDK-004, BE-001)_
- [ ] [UI-004 — Implement settings, permissions, privacy defaults, and native permission UX](tasks/UI-004-implement-settings-permissions-privacy-defaults-and-native-permission-ux.md) _(lane: ui-settings; deps: UI-001, SDK-006, TAURI-004)_
- [ ] [UI-005 — Implement RouteSheet/privacy guard shared component](tasks/UI-005-implement-routesheet-privacy-guard-shared-component.md) _(lane: ui-crosscut; deps: UI-001, SDK-012)_

### P7 — Assistant UI production wiring

- [ ] [UIA-001 — Wire assistant text chat send/receive](tasks/UIA-001-wire-assistant-text-chat-send-receive.md) _(lane: assistant; deps: UI-001, UI-005, SDK-007)_
- [ ] [UIA-002 — Wire assistant streaming, cancellation, retry, and transport-loss states](tasks/UIA-002-wire-assistant-streaming-cancellation-retry-and-transport-loss-states.md) _(lane: assistant; deps: UIA-001, SDK-011, BE-003, BE-009)_
- [ ] [UIA-003 — Wire tool approval cards and tool-result display](tasks/UIA-003-wire-tool-approval-cards-and-tool-result-display.md) _(lane: assistant-tools; deps: UIA-001, SDK-013, BE-011)_
- [ ] [UIA-004 — Wire voice PTT, wake, transcription, and TTS playback per mode](tasks/UIA-004-wire-voice-ptt-wake-transcription-and-tts-playback-per-mode.md) _(lane: assistant-voice; deps: UIA-001, UI-004, SDK-006)_
- [ ] [UIA-005 — Wire attachments and mobile share-intake UI](tasks/UIA-005-wire-attachments-and-mobile-share-intake-ui.md) _(lane: assistant-context; deps: UIA-001, BE-008, SDK-006)_
- [ ] [UIA-006 — Wire conversation history, memory, and RAG provenance UI](tasks/UIA-006-wire-conversation-history-memory-and-rag-provenance-ui.md) _(lane: assistant-memory; deps: UIA-001, SDK-007, BE-017)_
- [ ] [UIA-007 — Wire models/runtime selection and provider capability UI](tasks/UIA-007-wire-models-runtime-selection-and-provider-capability-ui.md) _(lane: assistant-models; deps: UIA-001, BE-007)_

### P8 — Admin/operator dashboard production wiring

- [ ] [ADM-001 — Wire admin overview/service/capability dashboard](tasks/ADM-001-wire-admin-overview-service-capability-dashboard.md) _(lane: admin; deps: UI-002, SDK-006)_
- [ ] [ADM-002 — Wire services and contract explorer](tasks/ADM-002-wire-services-and-contract-explorer.md) _(lane: admin; deps: ADM-001, SDK-002, BE-015)_
- [ ] [ADM-003 — Wire RBAC principals, roles, permissions and effective access](tasks/ADM-003-wire-rbac-principals-roles-permissions-and-effective-access.md) _(lane: admin; deps: SDK-005, SDK-013, BE-004)_
- [ ] [ADM-004 — Wire token lifecycle management](tasks/ADM-004-wire-token-lifecycle-management.md) _(lane: admin; deps: SDK-005, SDK-013, BE-004)_
- [ ] [ADM-005 — Wire device/session management](tasks/ADM-005-wire-device-session-management.md) _(lane: admin; deps: SDK-004, SDK-013, BE-004)_
- [ ] [ADM-006 — Wire config editor, validation, diff, rollback, reload impact](tasks/ADM-006-wire-config-editor-validation-diff-rollback-reload-impact.md) _(lane: admin; deps: SDK-013, BE-010)_
- [ ] [ADM-007 — Wire plugins, MCP, tools and reload/install states](tasks/ADM-007-wire-plugins-mcp-tools-and-reload-install-states.md) _(lane: admin; deps: SDK-007, BE-011)_
- [ ] [ADM-008 — Wire audit log details and export](tasks/ADM-008-wire-audit-log-details-and-export.md) _(lane: admin; deps: SDK-007, BE-004)_
- [ ] [ADM-009 — Wire diagnostics probes and redacted support bundle](tasks/ADM-009-wire-diagnostics-probes-and-redacted-support-bundle.md) _(lane: admin; deps: SDK-013, BE-005)_
- [ ] [ADM-010 — Wire backup/restore dashboard](tasks/ADM-010-wire-backup-restore-dashboard.md) _(lane: admin; deps: SDK-013, BE-006)_
- [ ] [ADM-011 — Wire pairing queue and pending device/peer review](tasks/ADM-011-wire-pairing-queue-and-pending-device-peer-review.md) _(lane: admin; deps: SDK-004, BE-012)_
- [ ] [ADM-012 — Wire scheduler jobs and automation management](tasks/ADM-012-wire-scheduler-jobs-and-automation-management.md) _(lane: admin; deps: SDK-007, SDK-013, BE-018)_
- [ ] [ADM-013 — Wire deployment topology and process-mode operations dashboard](tasks/ADM-013-wire-deployment-topology-and-process-mode-operations-dashboard.md) _(lane: admin; deps: ADM-001, BE-016, SDK-006)_

### P9 — Mesh/WebRTC UI and route policy

- [ ] [MESH-001 — Wire mesh pairing and persisted peer lifecycle](tasks/MESH-001-wire-mesh-pairing-and-persisted-peer-lifecycle.md) _(lane: mesh; deps: ADM-011, BE-013)_
- [ ] [MESH-002 — Wire live sessions vs persisted peers view](tasks/MESH-002-wire-live-sessions-vs-persisted-peers-view.md) _(lane: mesh; deps: MESH-001, BE-014)_
- [ ] [MESH-003 — Wire route policy editor and route explain UI](tasks/MESH-003-wire-route-policy-editor-and-route-explain-ui.md) _(lane: mesh; deps: MESH-001, BE-013, SDK-012)_
- [ ] [MESH-004 — Wire WebRTC/ICE diagnostics UI](tasks/MESH-004-wire-webrtc-ice-diagnostics-ui.md) _(lane: mesh; deps: MESH-002, BE-014)_

### P10 — Quality, security, release, and operations

- [ ] [QA-001 — Build SDK/backend contract conformance CI](tasks/QA-001-build-sdk-backend-contract-conformance-ci.md) _(lane: qa-release; deps: SDK-014, P0-002)_
- [ ] [QA-002 — Build multi-mode E2E matrix](tasks/QA-002-build-multi-mode-e2e-matrix.md) _(lane: qa-release; deps: UIA-001, ADM-001, TAURI-004, AND-001, IOS-001)_
- [ ] [QA-003 — Build security/privacy regression suite](tasks/QA-003-build-security-privacy-regression-suite.md) _(lane: qa-release; deps: BE-004, SDK-012, ADM-008)_
- [ ] [QA-004 — Build accessibility, responsive, visual regression suite](tasks/QA-004-build-accessibility-responsive-visual-regression-suite.md) _(lane: qa-release; deps: UI-001, UIA-001, ADM-001)_
- [ ] [QA-005 — Build performance/offline/resilience suite](tasks/QA-005-build-performance-offline-resilience-suite.md) _(lane: qa-release; deps: UIA-002, SDK-011, TAURI-002)_
- [ ] [QA-006 — Build release packaging and operator runbooks](tasks/QA-006-build-release-packaging-and-operator-runbooks.md) _(lane: qa-release; deps: TAURI-006, AND-009, IOS-008, ADM-009)_
- [ ] [QA-007 — Final production readiness audit and task-board closure](tasks/QA-007-final-production-readiness-audit-and-task-board-closure.md) _(lane: qa-release; deps: QA-001, QA-002, QA-003, QA-004, QA-005, QA-006)_
- [ ] [QA-008 — Build thread/process/mesh transport parity gate](tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md) _(lane: qa-release; deps: QA-002, BE-016, SDK-014, MESH-004)_

## Dependency notes for maximizing parallelism

- After P0-001/P0-004/P0-003, SDK-001 and TAURI-001 can begin while backend inventory P0-002 continues.
- Backend read-only contracts (BE-002, BE-003, BE-007, BE-008, BE-009, BE-011, BE-013, BE-014, BE-016) can run in parallel after P0-002, but AdminAction-dependent mutations wait for BE-004. BE-017 and BE-018 close memory/RAG and scheduler exposure gaps before their UI mutation surfaces ship.
- UI shell (UI-001) can start after SDK package scaffold and frontend baseline; UI-002 waits for SDK-006 capability graph.
- Assistant text UI (UIA-001) can ship before streaming, tools, voice and attachments; those are intentionally separate tasks. Voice and attachment UI can start against capability fixtures before mobile native plugins land, with platform entrypoints gated by AND/IOS tasks.
- Admin read-only overview/services/contracts can run before mutation surfaces; RBAC/tokens/devices/config/mesh mutations wait for AdminAction.
- Android and iOS native skeletons can proceed after Tauri scaffold; assistant-role/App Intents/local inference are separate specialized tasks.
- QA tasks start as soon as their upstream feature cluster exists; do not postpone all QA to the end. QA-008 is the explicit parity gate for thread mode, process mode/BullMQ/Redis, HTTP thin mode, Tauri local mode, and Mesh/WebRTC mode.

## Task file contract

Every task file contains: metadata, goal, user-visible outcome, backend/API details, SDK integration, Tauri/native details, UI details, code references, mock references, data/permissions/privacy contract, acceptance criteria, verification, risks, and handoff notes.

## Coverage summary

- Total tasks: 97
- Backend/API tasks: 18
- SDK tasks: 14
- Native/Tauri tasks: 24
- UI tasks: 29
- QA/release tasks: 8


## Coverage review addendum

A second full-scope audit made process-mode deployment topology and legacy PyQt UIBridge migration explicit rather than relying on broad QA wording. Added `BE-016`, `BE-017`, `BE-018`, `TAURI-007`, `ADM-013`, and `QA-008` to cover LocalBus/BullMQBus/MeshBus parity, Redis/BullMQ health, process/thread topology, and PyQt-to-Tauri/SDK behavior mapping, memory/RAG governance, and scheduler management exposure.
