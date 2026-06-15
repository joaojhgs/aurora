# Task Manifest

| ID | Phase | Lane | Dependencies | Path |
|---|---|---|---|---|
| P0-001 | P0 | planning | None | `tasks/P0-001-freeze-production-ui-scope-terms-and-task-board-contract.md` |
| P0-002 | P0 | backend/readiness | None | `tasks/P0-002-generate-live-backend-contract-route-permission-and-exposure-inventory.md` |
| P0-003 | P0 | frontend/readiness | None | `tasks/P0-003-establish-frontend-package-lint-type-build-test-baseline.md` |
| P0-004 | P0 | architecture | P0-001 | `tasks/P0-004-create-monorepo-package-layout-decision-for-sdk-ui-tauri-and-native-plugins.md` |
| SDK-001 | P1 | sdk | P0-004 | `tasks/SDK-001-scaffold-@aurora-client-typescript-sdk-package-and-public-api.md` |
| SDK-002 | P1 | sdk | SDK-001, P0-002 | `tasks/SDK-002-implement-generated-backend-type-ingestion-from-registry-openapi.md` |
| SDK-003 | P1 | sdk | SDK-001 | `tasks/SDK-003-define-normalized-envelopes-results-errors-and-audit-metadata.md` |
| SDK-004 | P1 | sdk | SDK-001 | `tasks/SDK-004-implement-authsession-state-machine.md` |
| SDK-005 | P1 | sdk | SDK-001 | `tasks/SDK-005-implement-canonical-permission-catalog-and-effective-permission-helpers.md` |
| SDK-006 | P1 | sdk | SDK-001, SDK-002, SDK-004, SDK-005 | `tasks/SDK-006-implement-capability-graph-engine.md` |
| SDK-007 | P1 | sdk | SDK-001, P0-002 | `tasks/SDK-007-implement-http-gateway-transport-adapter.md` |
| SDK-008 | P1 | sdk | SDK-001 | `tasks/SDK-008-implement-mock-transport-and-contract-fixtures.md` |
| SDK-009 | P1 | sdk | SDK-001 | `tasks/SDK-009-implement-tauri-local-native-transport-interface.md` |
| SDK-010 | P1 | sdk | SDK-001 | `tasks/SDK-010-implement-mesh-p2p-transport-interface.md` |
| SDK-011 | P1 | sdk | SDK-001, SDK-003 | `tasks/SDK-011-implement-event-stream-abstraction.md` |
| SDK-012 | P1 | sdk | SDK-001 | `tasks/SDK-012-implement-route-privacy-policy-engine.md` |
| SDK-013 | P1 | sdk | SDK-001, SDK-003, BE-004 | `tasks/SDK-013-implement-adminaction-client-controller.md` |
| SDK-014 | P1 | sdk | SDK-001, SDK-007, SDK-008, SDK-009, SDK-010, SDK-011, SDK-013 | `tasks/SDK-014-implement-sdk-conformance-test-suite-across-transports.md` |
| BE-001 | P2 | backend/gateway | P0-002 | `tasks/BE-001-normalize-auth-gateway-route-casing-and-public-bypass-behavior.md` |
| BE-002 | P2 | backend/gateway | P0-002 | `tasks/BE-002-add-capability-manifest-endpoint-or-formal-sdk-computed-manifest-contract.md` |
| BE-003 | P2 | backend/events | P0-002, SDK-003 | `tasks/BE-003-add-unified-event-stream-contract.md` |
| BE-004 | P2 | backend/security | SDK-003 | `tasks/BE-004-implement-adminaction-draft-confirm-audit-enforcement.md` |
| BE-005 | P2 | backend/diagnostics | BE-004 | `tasks/BE-005-add-diagnostics-bundle-export-contract-with-redaction.md` |
| BE-006 | P2 | backend/admin | BE-004 | `tasks/BE-006-add-backup-restore-contracts-for-config-db-rag-and-models.md` |
| BE-007 | P2 | backend/models | P0-002 | `tasks/BE-007-add-model-runtime-catalog-import-download-benchmark-contracts.md` |
| BE-008 | P2 | backend/assistant | P0-002 | `tasks/BE-008-add-attachment-context-ingestion-contracts.md` |
| BE-009 | P2 | backend/orchestrator | P0-002 | `tasks/BE-009-add-orchestrator-cancellation-interrupt-contract.md` |
| BE-010 | P2 | backend/config | BE-004 | `tasks/BE-010-add-config-schema-metadata-diff-rollback-and-reload-impact-preview.md` |
| BE-011 | P2 | backend/tools | P0-002 | `tasks/BE-011-add-tool-risk-taxonomy-and-approval-hints.md` |
| BE-012 | P2 | backend/auth-mesh | BE-003 | `tasks/BE-012-add-pending-pairing-queue-list-event-contract.md` |
| BE-013 | P2 | backend/mesh | BE-002 | `tasks/BE-013-add-peer-capability-manifest-and-mesh-route-explain-contracts.md` |
| BE-014 | P2 | backend/mesh | BE-003 | `tasks/BE-014-add-webrtc-ice-data-channel-diagnostics-endpoints-events.md` |
| BE-015 | P2 | backend/supervisor | BE-004 | `tasks/BE-015-implement-or-explicitly-gate-supervisor-service-controls.md` |
| BE-016 | P2 | backend/operations | P0-002, BE-002 | `tasks/BE-016-add-deployment-topology-bus-health-and-process-mode-contract.md` |
| BE-017 | P2 | backend/db-rag | P0-002, BE-004 | `tasks/BE-017-add-memory-rag-provenance-export-delete-contracts.md` |
| BE-018 | P2 | backend/scheduler | P0-002, BE-004 | `tasks/BE-018-add-scheduler-management-exposure-and-adminaction-contract.md` |
| TAURI-001 | P3 | tauri-desktop | P0-004, P0-003 | `tasks/TAURI-001-scaffold-official-tauri-2-app-shell-around-production-ui.md` |
| TAURI-002 | P3 | tauri-desktop | TAURI-001, SDK-009 | `tasks/TAURI-002-implement-rust-supervised-desktop-python-sidecar-local-node.md` |
| TAURI-003 | P3 | tauri-desktop | TAURI-001, SDK-004 | `tasks/TAURI-003-implement-secure-storage-for-tokens-mesh-credentials-and-local-secrets.md` |
| TAURI-004 | P3 | tauri-desktop | TAURI-001, SDK-009, BE-002 | `tasks/TAURI-004-implement-tauri-command-bridge-for-local-bus-and-native-capability-manifest.md` |
| TAURI-005 | P3 | tauri-desktop | TAURI-001, SDK-009 | `tasks/TAURI-005-implement-desktop-native-permissions-tray-notifications-dialogs-files-and-audio-bridge.md` |
| TAURI-006 | P3 | tauri-desktop | TAURI-002, TAURI-003, TAURI-004 | `tasks/TAURI-006-implement-desktop-packaging-signing-updater-and-sidecar-bundling.md` |
| TAURI-007 | P3 | tauri-desktop | TAURI-004, UIA-001, UIA-004 | `tasks/TAURI-007-map-legacy-pyqt-uibridge-to-tauri-sdk-migration-contract.md` |
| AND-001 | P4 | android-native | TAURI-001 | `tasks/AND-001-create-tauri-android-build-emulator-ci-baseline.md` |
| AND-002 | P4 | android-native | AND-001, TAURI-004 | `tasks/AND-002-create-aurora-android-kotlin-native-plugin-skeleton.md` |
| AND-003 | P4 | android-native | AND-002, SDK-006 | `tasks/AND-003-implement-android-native-capability-manifest-provider.md` |
| AND-004 | P4 | android-native | AND-002, AND-003 | `tasks/AND-004-implement-android-assistant-role-qualification-prototype.md` |
| AND-005 | P4 | android-native | AND-003, UI-004 | `tasks/AND-005-implement-android-voice-capture-foreground-service-notifications-and-permission-flows.md` |
| AND-006 | P4 | android-native | AND-003, UIA-005 | `tasks/AND-006-implement-android-share-sheet-deep-links-widgets-shortcuts-and-quick-tile-entrypoints.md` |
| AND-007 | P4 | android-native | AND-003, TAURI-003 | `tasks/AND-007-implement-android-secure-storage-and-biometric-admin-unlock.md` |
| AND-008 | P4 | android-native | BE-007, AND-003 | `tasks/AND-008-implement-android-local-light-inference-provider-spike-to-product-adapter.md` |
| AND-009 | P4 | android-native | AND-001, AND-004, AND-005 | `tasks/AND-009-implement-android-release-signing-play-app-bundle-and-device-matrix-gate.md` |
| IOS-001 | P5 | ios-native | TAURI-001 | `tasks/IOS-001-create-macos-xcode-tauri-ios-build-baseline.md` |
| IOS-002 | P5 | ios-native | IOS-001, TAURI-004 | `tasks/IOS-002-create-aurora-ios-swift-native-plugin-skeleton.md` |
| IOS-003 | P5 | ios-native | IOS-002, SDK-006 | `tasks/IOS-003-implement-ios-app-intents-and-shortcuts-invocation.md` |
| IOS-004 | P5 | ios-native | IOS-002, UIA-005 | `tasks/IOS-004-implement-ios-share-extension-deep-links-widgets-and-file-associations.md` |
| IOS-005 | P5 | ios-native | IOS-002, TAURI-003 | `tasks/IOS-005-implement-ios-keychain-biometric-secure-storage-and-admin-unlock.md` |
| IOS-006 | P5 | ios-native | IOS-002, UI-004 | `tasks/IOS-006-implement-ios-microphone-notifications-background-limits-and-voice-ux-states.md` |
| IOS-007 | P5 | ios-native | BE-007, IOS-002 | `tasks/IOS-007-implement-ios-local-light-inference-provider-adapter.md` |
| IOS-008 | P5 | ios-native | IOS-001, IOS-003, IOS-004 | `tasks/IOS-008-implement-ios-signing-testflight-app-store-and-device-matrix-gate.md` |
| UI-001 | P6 | ui-shell | P0-003, SDK-001 | `tasks/UI-001-build-production-app-shell-routes-navigation-and-design-tokens.md` |
| UI-002 | P6 | ui-shell | UI-001, SDK-006 | `tasks/UI-002-implement-capability-driven-navigation-and-feature-drawer.md` |
| UI-003 | P6 | ui-auth | UI-001, SDK-004, BE-001 | `tasks/UI-003-implement-onboarding-connection-pairing-and-auth-session-flows.md` |
| UI-004 | P6 | ui-settings | UI-001, SDK-006, TAURI-004 | `tasks/UI-004-implement-settings-permissions-privacy-defaults-and-native-permission-ux.md` |
| UI-005 | P6 | ui-crosscut | UI-001, SDK-012 | `tasks/UI-005-implement-routesheet-privacy-guard-shared-component.md` |
| UIA-001 | P7 | assistant | UI-001, UI-005, SDK-007 | `tasks/UIA-001-wire-assistant-text-chat-send-receive.md` |
| UIA-002 | P7 | assistant | UIA-001, SDK-011, BE-003, BE-009 | `tasks/UIA-002-wire-assistant-streaming-cancellation-retry-and-transport-loss-states.md` |
| UIA-003 | P7 | assistant-tools | UIA-001, SDK-013, BE-011 | `tasks/UIA-003-wire-tool-approval-cards-and-tool-result-display.md` |
| UIA-004 | P7 | assistant-voice | UIA-001, UI-004, SDK-006 | `tasks/UIA-004-wire-voice-ptt-wake-transcription-and-tts-playback-per-mode.md` |
| UIA-005 | P7 | assistant-context | UIA-001, BE-008, SDK-006 | `tasks/UIA-005-wire-attachments-and-mobile-share-intake-ui.md` |
| UIA-006 | P7 | assistant-memory | UIA-001, SDK-007, BE-017 | `tasks/UIA-006-wire-conversation-history-memory-and-rag-provenance-ui.md` |
| UIA-007 | P7 | assistant-models | UIA-001, BE-007 | `tasks/UIA-007-wire-models-runtime-selection-and-provider-capability-ui.md` |
| ADM-001 | P8 | admin | UI-002, SDK-006 | `tasks/ADM-001-wire-admin-overview-service-capability-dashboard.md` |
| ADM-002 | P8 | admin | ADM-001, SDK-002, BE-015 | `tasks/ADM-002-wire-services-and-contract-explorer.md` |
| ADM-003 | P8 | admin | SDK-005, SDK-013, BE-004 | `tasks/ADM-003-wire-rbac-principals-roles-permissions-and-effective-access.md` |
| ADM-004 | P8 | admin | SDK-005, SDK-013, BE-004 | `tasks/ADM-004-wire-token-lifecycle-management.md` |
| ADM-005 | P8 | admin | SDK-004, SDK-013, BE-004 | `tasks/ADM-005-wire-device-session-management.md` |
| ADM-006 | P8 | admin | SDK-013, BE-010 | `tasks/ADM-006-wire-config-editor-validation-diff-rollback-reload-impact.md` |
| ADM-007 | P8 | admin | SDK-007, BE-011 | `tasks/ADM-007-wire-plugins-mcp-tools-and-reload-install-states.md` |
| ADM-008 | P8 | admin | SDK-007, BE-004 | `tasks/ADM-008-wire-audit-log-details-and-export.md` |
| ADM-009 | P8 | admin | SDK-013, BE-005 | `tasks/ADM-009-wire-diagnostics-probes-and-redacted-support-bundle.md` |
| ADM-010 | P8 | admin | SDK-013, BE-006 | `tasks/ADM-010-wire-backup-restore-dashboard.md` |
| ADM-011 | P8 | admin | SDK-004, BE-012 | `tasks/ADM-011-wire-pairing-queue-and-pending-device-peer-review.md` |
| ADM-012 | P8 | admin | SDK-007, SDK-013, BE-018 | `tasks/ADM-012-wire-scheduler-jobs-and-automation-management.md` |
| ADM-013 | P8 | admin | ADM-001, BE-016, SDK-006 | `tasks/ADM-013-wire-deployment-topology-and-process-mode-operations-dashboard.md` |
| MESH-001 | P9 | mesh | ADM-011, BE-013 | `tasks/MESH-001-wire-mesh-pairing-and-persisted-peer-lifecycle.md` |
| MESH-002 | P9 | mesh | MESH-001, BE-014 | `tasks/MESH-002-wire-live-sessions-vs-persisted-peers-view.md` |
| MESH-003 | P9 | mesh | MESH-001, BE-013, SDK-012 | `tasks/MESH-003-wire-route-policy-editor-and-route-explain-ui.md` |
| MESH-004 | P9 | mesh | MESH-002, BE-014 | `tasks/MESH-004-wire-webrtc-ice-diagnostics-ui.md` |
| QA-001 | P10 | qa-release | SDK-014, P0-002 | `tasks/QA-001-build-sdk-backend-contract-conformance-ci.md` |
| QA-002 | P10 | qa-release | UIA-001, ADM-001, TAURI-004, AND-001, IOS-001 | `tasks/QA-002-build-multi-mode-e2e-matrix.md` |
| QA-003 | P10 | qa-release | BE-004, SDK-012, ADM-008 | `tasks/QA-003-build-security-privacy-regression-suite.md` |
| QA-004 | P10 | qa-release | UI-001, UIA-001, ADM-001 | `tasks/QA-004-build-accessibility-responsive-visual-regression-suite.md` |
| QA-005 | P10 | qa-release | UIA-002, SDK-011, TAURI-002 | `tasks/QA-005-build-performance-offline-resilience-suite.md` |
| QA-006 | P10 | qa-release | TAURI-006, AND-009, IOS-008, ADM-009 | `tasks/QA-006-build-release-packaging-and-operator-runbooks.md` |
| QA-007 | P10 | qa-release | QA-001, QA-002, QA-003, QA-004, QA-005, QA-006 | `tasks/QA-007-final-production-readiness-audit-and-task-board-closure.md` |
| QA-008 | P10 | qa-release | QA-002, BE-016, SDK-014, MESH-004 | `tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md` |