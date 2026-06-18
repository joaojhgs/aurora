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

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap task integration addendum

The mesh roadmap that was previously completed delivered important primitives, but the production UI/SDK task set must now treat `.omx/plans/mesh-production-e2e-integration-gap-plan.md` and `.omx/multica/mesh-production-gap-tasks/` as prerequisite context before final implementation.

New ordering rule:

1. Complete the mesh production gap sequence through `MESH-GAP-011` before implementing final production mesh/UI integration tasks.
2. Run `MESH-GAP-012` after backend naming stabilizes to re-sync this UI task set against the final contracts.
3. UI tasks may continue design/mock work earlier, but production wiring must depend on the typed capability catalog, route explain, aggregate tool catalog, and approval protocol.

Important cross-cutting change:

- Tool approval is not mesh-only. The approval harness must support internal/local tools and remote mesh tools, with configurable modes including deny-all, ask-each-time, allow-once, allow-until-expiry, approve-all-for-session, approve-all-for-peer, approve-all-local-safe, and dry-run-only.
- Capability graph must represent provider candidates instead of binary feature availability.
- Route/privacy policy must consume backend route explain and explicit-selector decisions.
- UI admin surfaces must configure per-tool/per-peer sharing policy, not just display risk hints.

<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

<!-- UI-MULTICA-CREATED-ISSUES -->
## UI Multica issue IDs

These UI tasks are intentionally `blocked` until the mesh production sequence is complete through `PER-163` / `MESH-GAP-011` and `PER-164` / `MESH-GAP-012` refreshes specs. Target branch after unblock: `feat/ui-multi-platform-integration`.

| Task | Issue | Status | Parent |
| --- | --- | --- | --- |
| UI-EPIC | PER-165 / `bc3a8538-a346-4802-a96c-ddc366ec75d8` | blocked | — |
| ADM-001 | PER-166 / `5952304f-dadf-4903-a138-37647144d03f` | blocked | PER-165 |
| ADM-002 | PER-167 / `db19667a-7d70-4066-99c3-2bbd72319d59` | blocked | PER-165 |
| ADM-003 | PER-168 / `4ae970c4-cdf4-4d5e-8551-4b702c2b8b52` | blocked | PER-165 |
| ADM-004 | PER-169 / `377acdda-9bb2-4201-87c4-31180066472e` | blocked | PER-165 |
| ADM-005 | PER-170 / `5d5b17dd-84cc-4abb-8ef2-f3596d2d0ece` | blocked | PER-165 |
| ADM-006 | PER-171 / `fe455575-d6d8-40ae-993c-56258d34e2a6` | blocked | PER-165 |
| ADM-007 | PER-172 / `4a8ed967-1e13-4ab3-83ca-23cf0710115c` | blocked | PER-165 |
| ADM-008 | PER-173 / `a91c1b05-a652-4a6e-a7f3-914a3d847f4a` | blocked | PER-165 |
| ADM-009 | PER-174 / `93b38f08-4000-4164-af92-a87747f13523` | blocked | PER-165 |
| ADM-010 | PER-175 / `78e95a65-6bef-4b70-9f4f-e3a5b70c6ad7` | blocked | PER-165 |
| ADM-011 | PER-176 / `5fa1b5e5-7619-4481-ac80-a3a93b665e36` | blocked | PER-165 |
| ADM-012 | PER-177 / `8ac120ed-1cc1-4fc0-8b6c-68c93524dce2` | blocked | PER-165 |
| ADM-013 | PER-178 / `e59d740d-d280-4568-85f6-560fda48f4a3` | blocked | PER-165 |
| AND-001 | PER-179 / `b322e41b-2260-4848-8ccf-2d0d335d4110` | blocked | PER-165 |
| AND-002 | PER-180 / `a7545435-0d45-45f7-a70c-2c2685130043` | blocked | PER-165 |
| AND-003 | PER-181 / `abb9e558-b570-4681-b743-abb29f6109c1` | blocked | PER-165 |
| AND-004 | PER-182 / `c42a00d7-3975-457f-8f87-2d7845dccfbe` | blocked | PER-165 |
| AND-005 | PER-183 / `ef0fcb60-e7f3-4fc4-acf7-cdb7b9c8bcbc` | blocked | PER-165 |
| AND-006 | PER-184 / `05ec0e65-a484-42ab-9074-835ebf72495a` | blocked | PER-165 |
| AND-007 | PER-185 / `2fff2220-4763-4b56-a888-07aa50331cdd` | blocked | PER-165 |
| AND-008 | PER-186 / `f44c1241-d7e8-4def-a9c6-0a07a9f1d8a2` | blocked | PER-165 |
| AND-009 | PER-187 / `dcb8276a-5ecb-45e5-9259-135864df202d` | blocked | PER-165 |
| BE-001 | PER-188 / `151de6b3-cd86-4783-91f2-4166ad3b5faf` | blocked | PER-165 |
| BE-002 | PER-189 / `fcaa1dd0-1d71-4484-a1cc-135cfb8fca33` | blocked | PER-165 |
| BE-003 | PER-190 / `f8bdc73f-5c32-4030-8f87-fbeabc5747b7` | blocked | PER-165 |
| BE-004 | PER-191 / `b1bcdb20-8daa-4c06-bd67-f1a60ad8108f` | blocked | PER-165 |
| BE-005 | PER-192 / `9e919952-1cb0-49ab-b4ed-4c486d870343` | blocked | PER-165 |
| BE-006 | PER-193 / `b969923a-9f03-4b97-9904-95427748e8f4` | blocked | PER-165 |
| BE-007 | PER-194 / `77aec4f2-fde0-4e14-98cd-769f3ae48e75` | blocked | PER-165 |
| BE-008 | PER-195 / `6b4bdf2a-0e0d-4a99-8fa6-3659939adeda` | blocked | PER-165 |
| BE-009 | PER-196 / `22bad1ce-2047-4fc8-93be-6682dfc4fe9a` | blocked | PER-165 |
| BE-010 | PER-197 / `18c4833d-50da-4ac9-b4e6-e344a0923052` | blocked | PER-165 |
| BE-011 | PER-198 / `9012a3bc-9b27-4404-961c-3d16a47e5554` | blocked | PER-165 |
| BE-012 | PER-199 / `7764eb86-963f-422b-9aeb-b254998e72c1` | blocked | PER-165 |
| BE-013 | PER-200 / `7e00a584-36a7-4ecd-bf39-7bff2d840f52` | blocked | PER-165 |
| BE-014 | PER-201 / `9a85fbcb-758f-43b7-8bb6-1f7e015d3b08` | blocked | PER-165 |
| BE-015 | PER-202 / `5c6186bc-0cc6-4a05-8d84-e01559706877` | blocked | PER-165 |
| BE-016 | PER-203 / `5f0eb73f-bf34-4d66-b44c-8d5e71e215d6` | blocked | PER-165 |
| BE-017 | PER-204 / `dd4b269f-f0a7-42f3-ab72-a52b46570990` | blocked | PER-165 |
| BE-018 | PER-205 / `10ffbe7b-232f-4f04-bc69-6834fc228812` | blocked | PER-165 |
| IOS-001 | PER-206 / `416901ed-1626-48b5-a4fb-eeace049f543` | blocked | PER-165 |
| IOS-002 | PER-207 / `a67d317a-4177-4b46-8c08-537428397b15` | blocked | PER-165 |
| IOS-003 | PER-208 / `a6431172-9e4b-4974-8002-eef5170e9c46` | blocked | PER-165 |
| IOS-004 | PER-209 / `8dcc8406-2c77-4113-a43a-27c59fee74d0` | blocked | PER-165 |
| IOS-005 | PER-210 / `e8afc7c5-8945-4465-91b9-a5eed41736d0` | blocked | PER-165 |
| IOS-006 | PER-211 / `740dd570-8f0c-40d6-a06a-1963e0421a1b` | blocked | PER-165 |
| IOS-007 | PER-212 / `2badd70a-10b5-4209-b15f-1404dd9f2950` | blocked | PER-165 |
| IOS-008 | PER-213 / `7cf558aa-e550-4686-bfde-d3850200c538` | blocked | PER-165 |
| MESH-001 | PER-214 / `f673d9e3-dbc8-4d02-8953-f802c21784d5` | blocked | PER-165 |
| MESH-002 | PER-215 / `4b385c32-fbd4-4c64-a933-f3d319b167d7` | blocked | PER-165 |
| MESH-003 | PER-216 / `70b7cbb1-786c-4e77-8225-dfc3715b8163` | blocked | PER-165 |
| MESH-004 | PER-217 / `d630686d-ba81-483e-b712-f3850996a66c` | blocked | PER-165 |
| P0-001 | PER-218 / `aea461b8-0ce5-4462-bce2-96a7970aa5ef` | blocked | PER-165 |
| P0-002 | PER-219 / `c9121b4b-454e-4b0f-a856-310ef6c9d165` | blocked | PER-165 |
| P0-003 | PER-220 / `67cceb1e-1375-4a69-8b56-7013d0a11c7a` | blocked | PER-165 |
| P0-004 | PER-221 / `84328a7f-5bef-4cea-9767-2b8cbcbfc03d` | blocked | PER-165 |
| QA-001 | PER-222 / `8bbdb835-48a3-47c6-bbaa-66e13442a5bb` | blocked | PER-165 |
| QA-002 | PER-223 / `2d7d10d7-d25b-4a29-b460-296ed4068c56` | blocked | PER-165 |
| QA-003 | PER-224 / `2637bb00-4b26-4941-8431-56e2177ff77a` | blocked | PER-165 |
| QA-004 | PER-225 / `45f3212f-df1f-4c96-a801-a19b6f54e9ba` | blocked | PER-165 |
| QA-005 | PER-226 / `e512593d-2fda-4e10-9c85-6ef076223bac` | blocked | PER-165 |
| QA-006 | PER-227 / `24a98f56-4fde-440f-8f05-c838a3bcc747` | blocked | PER-165 |
| QA-007 | PER-228 / `64dd08c9-9c77-40cb-960a-2d2b85204a4b` | blocked | PER-165 |
| QA-008 | PER-229 / `2e61be69-7d4e-4708-a1a3-54a92a9a25d4` | blocked | PER-165 |
| SDK-001 | PER-230 / `7f390b40-ec35-4a3a-b569-20dc26971192` | blocked | PER-165 |
| SDK-002 | PER-231 / `bf09b499-e695-4b2b-b731-aec45a25f7aa` | blocked | PER-165 |
| SDK-003 | PER-232 / `11854287-f757-40d5-b66c-79f6edf34ee8` | blocked | PER-165 |
| SDK-004 | PER-233 / `0045c727-c10f-4c40-8658-d18050016112` | blocked | PER-165 |
| SDK-005 | PER-234 / `cbc95be0-4035-4977-bc2a-9434fc68453e` | blocked | PER-165 |
| SDK-006 | PER-235 / `2c69813a-c52f-4536-a9be-4a7a70a7bc5e` | blocked | PER-165 |
| SDK-007 | PER-236 / `8af5150c-9a1d-433b-b695-14c76d0902c9` | blocked | PER-165 |
| SDK-008 | PER-237 / `eec9bf99-93f0-4ae1-a950-a8bf3f6417ab` | blocked | PER-165 |
| SDK-009 | PER-238 / `154b47f5-307c-40c6-9376-e677797721af` | blocked | PER-165 |
| SDK-010 | PER-239 / `b11681fc-40c7-4e50-8c11-bf5089597105` | blocked | PER-165 |
| SDK-011 | PER-240 / `3085a772-2d59-441f-a99c-71d0b380498f` | blocked | PER-165 |
| SDK-012 | PER-241 / `2924c7af-22a6-431a-b59d-a8441910e68e` | blocked | PER-165 |
| SDK-013 | PER-242 / `34fc9bc3-fbda-48d8-9b75-cc583205ea1c` | blocked | PER-165 |
| SDK-014 | PER-243 / `3bde6959-6c6f-4d28-a19e-3265d3380ac0` | blocked | PER-165 |
| TAURI-001 | PER-244 / `5aa4301c-0424-4bec-b55f-d9eed07447b5` | blocked | PER-165 |
| TAURI-002 | PER-245 / `81c4346e-39f8-44b7-89ec-0ead78cbbb8f` | blocked | PER-165 |
| TAURI-003 | PER-246 / `8a3a2d0c-2297-47cb-aca5-7a18d45556b3` | blocked | PER-165 |
| TAURI-004 | PER-247 / `6e0b08e0-4237-4280-851b-168cf40815d4` | blocked | PER-165 |
| TAURI-005 | PER-248 / `7f7ca0fc-12c1-42cb-867f-000605c52785` | blocked | PER-165 |
| TAURI-006 | PER-249 / `c7698684-9465-43f3-bf77-e85bcbacd9b2` | blocked | PER-165 |
| TAURI-007 | PER-250 / `5db55643-7e8a-4a38-8825-d16f71bcdcd8` | blocked | PER-165 |
| UI-001 | PER-251 / `ed96cd0e-9404-4532-acd2-be0224e0b823` | blocked | PER-165 |
| UI-002 | PER-252 / `e2ac7803-80be-4d7f-8ab9-9dfd91bfe3dc` | blocked | PER-165 |
| UI-003 | PER-253 / `7f220937-29b2-4cee-974c-9ec827b9c185` | blocked | PER-165 |
| UI-004 | PER-254 / `a3f60b49-c78f-4c72-bebe-6fd497d80457` | blocked | PER-165 |
| UI-005 | PER-255 / `710bfadc-821c-469d-888b-5a26459ad117` | blocked | PER-165 |
| UIA-001 | PER-256 / `e2029456-bdd5-4c22-994a-8b3111e51b64` | blocked | PER-165 |
| UIA-002 | PER-257 / `d0c81a9a-2a34-4b8c-92aa-9451e812e266` | blocked | PER-165 |
| UIA-003 | PER-258 / `217ff1f0-6be4-4819-89e9-521a631ab4bb` | blocked | PER-165 |
| UIA-004 | PER-259 / `4f847468-4c37-45bc-b90f-697f55cee24c` | blocked | PER-165 |
| UIA-005 | PER-260 / `c7cca682-6dc5-4a7c-b4e0-57ac6b16299a` | blocked | PER-165 |
| UIA-006 | PER-261 / `af5be28d-bf47-47bc-abf1-42d0b12480d8` | blocked | PER-165 |
| UIA-007 | PER-262 / `42259b56-71bf-4457-a634-f02211654c2f` | blocked | PER-165 |
