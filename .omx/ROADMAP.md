# Aurora Unified Roadmap

**Purpose:** durable implementation roadmap for the mesh stabilization work and the production UI implementation plan. This file is ordered for delivery: mesh first, then UI contract refresh, then UI production tasks.

**Generated/updated:** 2026-06-14

## Ordering decision

1. Complete the mesh roadmap first because it changes identity, token scoping, capability graph, routing, provider aggregation, remote tool provenance, data/RAG policy, audio boundaries, scheduler delegation, Auth/Config exposure, tracing, and failure-mode contracts.
2. After mesh completion, run a dedicated UI roadmap sync task to update SDK contracts, backend/UI task acceptance criteria, mock types/data/components, and Multica dependency metadata against the implemented mesh contracts.
3. Execute the UI roadmap after the sync, preserving the existing UI phase order and dependency graph.

## Source artifacts

- Mesh tasks: `.omx/multica/mesh-roadmap-tasks/`
- Mesh upload ledger: `.omx/multica/mesh-roadmap-tasks/created-issues.json` (`PER-126` through `PER-146`)
- UI tasks: `.omx/specs/ui-production-tasks/tasks/`
- UI manifest: `.omx/specs/ui-production-tasks/manifest.md`
- Mesh/UI integration review: `.omx/specs/mesh-ui-roadmap-integration-review.md`
- UI mock reference: `modules/ui-mock-reference/`

## Roadmap gates

- **Gate M1:** mesh P0-P2 completed and tested; UI SDK/capability/route contracts can be synced.
- **Gate M2:** mesh P3-P6 completed or explicitly deferred; distributed UI surfaces can be finalized.
- **Gate U0:** UI roadmap sync complete after mesh; UI tasks can be uploaded/executed with stable mesh dependencies.
- **Gate U1:** SDK/backend/API contracts complete; UI shell and app surfaces can wire against real contracts.
- **Gate U2:** all platform shells and native plugins have matrix coverage for desktop, web, Android, and iOS.
- **Gate U3:** QA/release gates pass across HTTP, Tauri local, thread mode, process mode, and mesh/P2P transports.

---

# Part 1 — Mesh roadmap

## Mesh epic

- [ ] **PER-126 — [MESH][EPIC] Mesh polishing roadmap: secure cross-peer service fabric**
  - Summary: Parent task for polishing Aurora mesh into a secure, observable, hybrid-addressed cross-peer service fabric.
  - Source: `.omx/multica/mesh-roadmap-tasks/00-meshepic-mesh-polishing-roadmap-secure-cross-peer-service-fabric.md`
  - Labels: mesh, mesh-roadmap, mesh-epic

## Mesh P0 — Baseline and observability

- [ ] **PER-127 — [MESH][P0-T01] Establish mesh regression truth map and baseline test matrix**
  - Summary: Convert the current passing mesh state into an explicit regression matrix and documented truth map.
  - Source: `.omx/multica/mesh-roadmap-tasks/01-meshp0-t01-establish-mesh-regression-truth-map-and-baseline-test-matrix.md`
  - Labels: mesh, mesh-roadmap, mesh-p0, test-coverage
- [ ] **PER-128 — [MESH][P0-T02] Add mesh status and route diagnostic surface**
  - Summary: Expose a concise mesh status/debug view for identity, peers, manifests, routing, failures, and active calls.
  - Source: `.omx/multica/mesh-roadmap-tasks/02-meshp0-t02-add-mesh-status-and-route-diagnostic-surface.md`
  - Labels: mesh, mesh-roadmap, mesh-p0, observability

## Mesh P1 — Identity, auth, config, E2EE foundations

- [ ] **PER-129 — [MESH][P1-T01] Align stable mesh identity across WebRTC, Auth, registry, and manifests**
  - Summary: Ensure the same stable peer identity is used consistently across signaling/auth/registry/manifest paths.
  - Source: `.omx/multica/mesh-roadmap-tasks/03-meshp1-t01-align-stable-mesh-identity-across-webrtc-auth-registry-and-manifests.md`
  - Labels: mesh, mesh-roadmap, mesh-p1, identity, webrtc
- [ ] **PER-130 — [MESH][P1-T02] Make saved WebRTC mesh tokens peer-scoped and multi-peer safe**
  - Summary: Replace global saved-token shortcuts with peer-specific token selection and re-auth behavior.
  - Source: `.omx/multica/mesh-roadmap-tasks/04-meshp1-t02-make-saved-webrtc-mesh-tokens-peer-scoped-and-multi-peer-safe.md`
  - Labels: mesh, mesh-roadmap, mesh-p1, auth, webrtc
- [ ] **PER-131 — [MESH][P1-T03] Make bilateral reverse pairing peer-specific**
  - Summary: Fix reverse pairing skip logic so one saved token does not suppress pairing for unrelated peers.
  - Source: `.omx/multica/mesh-roadmap-tasks/05-meshp1-t03-make-bilateral-reverse-pairing-peer-specific.md`
  - Labels: mesh, mesh-roadmap, mesh-p1, auth, pairing
- [ ] **PER-132 — [MESH][P1-T04] Bring mesh sharing config schema to parity with runtime policy fields**
  - Summary: Expose or intentionally remove advanced mesh policy fields so config schema/defaults match runtime behavior.
  - Source: `.omx/multica/mesh-roadmap-tasks/06-meshp1-t04-bring-mesh-sharing-config-schema-to-parity-with-runtime-policy-fields.md`
  - Labels: mesh, mesh-roadmap, mesh-p1, config, security
- [ ] **PER-133 — [MESH][P1-T05] Clarify and test DataChannel app-layer E2EE behavior**
  - Summary: Determine whether DataChannel RPC uses app-layer E2EE or WebRTC DTLS only, then align code/docs/tests.
  - Source: `.omx/multica/mesh-roadmap-tasks/07-meshp1-t05-clarify-and-test-datachannel-app-layer-e2ee-behavior.md`
  - Labels: mesh, mesh-roadmap, mesh-p1, security, webrtc

## Mesh P2 — Capability graph, addressing, provider aggregation

- [ ] **PER-134 — [MESH][P2-T01] Design and implement mesh capability graph core models**
  - Summary: Create first-class models for peers, services, methods, tools, resources, trust tiers, policies, and provider metadata.
  - Source: `.omx/multica/mesh-roadmap-tasks/08-meshp2-t01-design-and-implement-mesh-capability-graph-core-models.md`
  - Labels: mesh, mesh-roadmap, mesh-p2, capability-graph, contracts
- [ ] **PER-135 — [MESH][P2-T02] Add hybrid addressing primitives for peer, provider, resource, and namespace selectors**
  - Summary: Add typed selectors so sensitive operations can target explicit peer/resource identities while low-risk routing stays transparent.
  - Source: `.omx/multica/mesh-roadmap-tasks/09-meshp2-t02-add-hybrid-addressing-primitives-for-peer-provider-resource-and-namespace-selectors.md`
  - Labels: mesh, mesh-roadmap, mesh-p2, addressing, contracts
- [ ] **PER-136 — [MESH][P2-T03] Support provider aggregation instead of one-provider-per-module routing**
  - Summary: Allow discovery and planning across multiple providers of the same service rather than selecting only one module provider.
  - Source: `.omx/multica/mesh-roadmap-tasks/10-meshp2-t03-support-provider-aggregation-instead-of-one-provider-per-module-routing.md`
  - Labels: mesh, mesh-roadmap, mesh-p2, routing, capability-graph

## Mesh P3 — Remote tooling and orchestrator binding

- [ ] **PER-137 — [MESH][P3-T01] Extend Tooling discovery with peer/source metadata and stable remote tool IDs**
  - Summary: Make local and remote tools distinguishable, stable, policy-aware, and safe for Orchestrator binding.
  - Source: `.omx/multica/mesh-roadmap-tasks/11-meshp3-t01-extend-tooling-discovery-with-peersource-metadata-and-stable-remote-tool-ids.md`
  - Labels: mesh, mesh-roadmap, mesh-p3, tooling, orchestrator
- [ ] **PER-138 — [MESH][P3-T02] Implement explicit remote Tooling execution routing and audit provenance**
  - Summary: Execute selected remote tools by explicit provider/tool ID with full audit trail and policy checks.
  - Source: `.omx/multica/mesh-roadmap-tasks/12-meshp3-t02-implement-explicit-remote-tooling-execution-routing-and-audit-provenance.md`
  - Labels: mesh, mesh-roadmap, mesh-p3, tooling, audit, security
- [ ] **PER-139 — [MESH][P3-T03] Teach Orchestrator to bind local plus authorized remote tools safely**
  - Summary: Expose authorized remote tools to Orchestrator with provenance, collision handling, and safety prompts where required.
  - Source: `.omx/multica/mesh-roadmap-tasks/13-meshp3-t03-teach-orchestrator-to-bind-local-plus-authorized-remote-tools-safely.md`
  - Labels: mesh, mesh-roadmap, mesh-p3, orchestrator, tooling

## Mesh P4 — Data/RAG sharing and replication

- [ ] **PER-140 — [MESH][P4-T01] Define DB/data-sharing modes and per-domain ownership policy**
  - Summary: Classify chat, memory/RAG, scheduler, auth/audit, mesh credentials, and config data into safe sharing modes.
  - Source: `.omx/multica/mesh-roadmap-tasks/14-meshp4-t01-define-dbdata-sharing-modes-and-per-domain-ownership-policy.md`
  - Labels: mesh, mesh-roadmap, mesh-p4, db, data-policy
- [ ] **PER-141 — [MESH][P4-T02] Design selective RAG/memory replication with provenance and conflict handling**
  - Summary: Plan and then implement selective cross-peer memory/RAG sync with namespaces, tombstones, conflicts, and privacy controls.
  - Source: `.omx/multica/mesh-roadmap-tasks/15-meshp4-t02-design-selective-ragmemory-replication-with-provenance-and-conflict-handling.md`
  - Labels: mesh, mesh-roadmap, mesh-p4, db, rag, replication

## Mesh P5 — Remote audio, scheduler, Auth/Config boundaries

- [ ] **PER-142 — [MESH][P5-T01] Add explicit remote TTS/STT/audio capability boundaries**
  - Summary: Define and implement safe remote audio semantics for synthesize, playback, transcription, wakeword, and streaming boundaries.
  - Source: `.omx/multica/mesh-roadmap-tasks/16-meshp5-t01-add-explicit-remote-ttssttaudio-capability-boundaries.md`
  - Labels: mesh, mesh-roadmap, mesh-p5, tts, stt, privacy
- [ ] **PER-143 — [MESH][P5-T02] Add namespace-aware remote Scheduler and delegated action policy**
  - Summary: Make remote scheduling explicit about owner namespace, target peer, and delegated tool/action permissions.
  - Source: `.omx/multica/mesh-roadmap-tasks/17-meshp5-t02-add-namespace-aware-remote-scheduler-and-delegated-action-policy.md`
  - Labels: mesh, mesh-roadmap, mesh-p5, scheduler, policy
- [ ] **PER-144 — [MESH][P5-T03] Define Auth and Config mesh exposure boundaries**
  - Summary: Separate required pairing/peer-management RPC from broad Auth/Config service sharing and document safe exposure rules.
  - Source: `.omx/multica/mesh-roadmap-tasks/18-meshp5-t03-define-auth-and-config-mesh-exposure-boundaries.md`
  - Labels: mesh, mesh-roadmap, mesh-p5, auth, config, security

## Mesh P6 — Distributed tracing, audit, chaos/failure testing

- [ ] **PER-145 — [MESH][P6-T01] Add distributed tracing, correlation IDs, and mesh audit views**
  - Summary: Make cross-peer requests traceable from caller through routing, WebRTC RPC, remote service execution, and response.
  - Source: `.omx/multica/mesh-roadmap-tasks/19-meshp6-t01-add-distributed-tracing-correlation-ids-and-mesh-audit-views.md`
  - Labels: mesh, mesh-roadmap, mesh-p6, observability, audit
- [ ] **PER-146 — [MESH][P6-T02] Build mesh chaos and failure-mode test suite**
  - Summary: Add hostile tests for disconnects, stale manifests, service restart, capacity, latency, token expiry, denied permissions, and fallback routing.
  - Source: `.omx/multica/mesh-roadmap-tasks/20-meshp6-t02-build-mesh-chaos-and-failure-mode-test-suite.md`
  - Labels: mesh, mesh-roadmap, mesh-p6, testing, resilience

---

# Part 2 — Required bridge task after mesh

## UI-SYNC-001 — Rebase UI roadmap, SDK contracts, mocks, and Multica metadata after mesh completion

- [ ] **UI-SYNC-001 — Update UI roadmap after mesh roadmap gates**
  - Runs after mesh P0-P6, or after documented mesh deferrals are accepted.
  - Update `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md` with final mesh identity/session/credential models, capability graph nodes, hybrid addressing selectors, provider aggregation, route explain receipts, E2EE status, remote tool provenance, data/RAG policy, audio boundaries, delegated scheduler semantics, Auth/Config exposure boundaries, and distributed trace/audit IDs.
  - Update UI production tasks: `SDK-006`, `SDK-010`, `SDK-012`, `SDK-014`, `BE-013`, `BE-014`, `BE-017`, `BE-018`, `MESH-001` through `MESH-004`, `UI-005`, `UIA-003`, `UIA-004`, `UIA-006`, `ADM-006`, `ADM-008`, `ADM-009`, `ADM-011`, `ADM-012`, `ADM-013`, `QA-003`, `QA-005`, `QA-006`, `QA-008`.
  - Update `modules/ui-mock-reference` with mesh-expanded states and components before production UI implementation begins.
  - Generate or update `.omx/multica/ui-production-tasks/` metadata using the mesh push/resume pattern, but do not run Multica upload until the server is available and a dry-run/list preflight passes.
  - Acceptance criteria: every mesh-dependent UI task names its mesh prerequisite issue(s), updated contract surface, mock reference, and verification matrix row.

---

# Part 3 — UI production roadmap

## P0 — Readiness and planning

- [ ] **P0-001 — P0-001 — Freeze production UI scope, terms, and task-board contract**
  - Lane: `planning`
  - Depends on: None
  - Goal: Create the canonical implementation glossary, mode definitions, task fields, and acceptance-gate conventions that every subsequent card uses.
  - Outcome: A reader can distinguish Server Web, Desktop Thin, Desktop Local, Mesh Shell, Android Thin, Android Local-Light, iOS Thin, and iOS Local-Light without re-reading previous research.
  - Source: `.omx/specs/ui-production-tasks/tasks/P0-001-freeze-production-ui-scope-terms-and-task-board-contract.md`
- [ ] **P0-002 — P0-002 — Generate live backend contract, route, permission, and exposure inventory**
  - Lane: `backend/readiness`
  - Depends on: None
  - Goal: Build a repeatable inventory command/test that exports current MethodInfo, OpenAPI paths, permissions, exposure, method_type, and gateway built-ins.
  - Outcome: The SDK/UI work starts from machine-readable backend truth, not stale fixture data.
  - Source: `.omx/specs/ui-production-tasks/tasks/P0-002-generate-live-backend-contract-route-permission-and-exposure-inventory.md`
- [ ] **P0-003 — P0-003 — Establish frontend package lint/type/build/test baseline**
  - Lane: `frontend/readiness`
  - Depends on: None
  - Goal: Turn the UI reference/package baseline into a repeatable quality harness before production code is added.
  - Outcome: Every UI and SDK task has a known command set and no task inherits the current `eslint` missing-dependency ambiguity.
  - Source: `.omx/specs/ui-production-tasks/tasks/P0-003-establish-frontend-package-lint-type-build-test-baseline.md`
- [ ] **P0-004 — P0-004 — Create monorepo/package layout decision for SDK, UI, Tauri, and native plugins**
  - Lane: `architecture`
  - Depends on: P0-001
  - Goal: Define where production TypeScript SDK, shared UI, Tauri app, desktop sidecar, Android plugin, and iOS plugin/extensions live.
  - Outcome: Task owners can implement in isolation without arguing file layout.
  - Source: `.omx/specs/ui-production-tasks/tasks/P0-004-create-monorepo-package-layout-decision-for-sdk-ui-tauri-and-native-plugins.md`

## P1 — SDK foundation

- [ ] **SDK-001 — SDK-001 — Scaffold `@aurora/client` TypeScript SDK package and public API**
  - Lane: `sdk`
  - Depends on: P0-004
  - Goal: Create the SDK workspace package with strict TS, ESM/CJS/build outputs if needed, typed exports, and no UI framework dependency.
  - Outcome: `AuroraClient` can be imported by web UI, Tauri UI, tests, and mock adapters.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-001-scaffold-@aurora-client-typescript-sdk-package-and-public-api.md`
- [ ] **SDK-002 — SDK-002 — Implement generated backend type ingestion from registry/OpenAPI**
  - Lane: `sdk`
  - Depends on: SDK-001, P0-002
  - Goal: Generate or ingest MethodInfo/OpenAPI schemas into TS method descriptors and request/response types.
  - Outcome: SDK consumers see backend method names, schemas, permissions, and route paths from generated truth.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-002-implement-generated-backend-type-ingestion-from-registry-openapi.md`
- [ ] **SDK-003 — SDK-003 — Define normalized envelopes, results, errors, and audit metadata**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Create canonical `AuroraRequest`, `AuroraResult`, `AuroraError`, `AuroraEvent`, `AuditReceipt`, and redaction metadata.
  - Outcome: All transports return one result shape regardless of HTTP, Tauri IPC, bus, mesh, or mock.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-003-define-normalized-envelopes-results-errors-and-audit-metadata.md`
- [ ] **SDK-004 — SDK-004 — Implement AuthSession state machine**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Represent anonymous, pairing, user, admin, mesh peer, API-key/system, expired, revoked, 401, and 403 states.
  - Outcome: Every screen can reason about auth without duplicating token logic.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-004-implement-authsession-state-machine.md`
- [ ] **SDK-005 — SDK-005 — Implement canonical permission catalog and effective-permission helpers**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Map backend permission strings and method_type to user-facing labels/templates without changing backend IDs.
  - Outcome: RBAC and feature gating use `Auth.manage`, `Tooling.use`, `*`, etc. exactly.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-005-implement-canonical-permission-catalog-and-effective-permission-helpers.md`
- [ ] **SDK-006 — SDK-006 — Implement capability graph engine**
  - Lane: `sdk`
  - Depends on: SDK-001, SDK-002, SDK-004, SDK-005
  - Goal: Merge registry, identity, transport, native capability, peer manifests, privacy policy, and service health into feature states.
  - Outcome: Navigation and every surface render available/degraded/blocked states from one engine.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-006-implement-capability-graph-engine.md`
- [ ] **SDK-007 — SDK-007 — Implement HTTP Gateway transport adapter**
  - Lane: `sdk`
  - Depends on: SDK-001, P0-002
  - Goal: Call generated dynamic routes and gateway built-ins with bearer/API-key auth, request timeout, retry classification, and schema-safe payloads.
  - Outcome: Server web and desktop thin modes can use live gateway without UI fetch calls.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-007-implement-http-gateway-transport-adapter.md`
- [ ] **SDK-008 — SDK-008 — Implement mock transport and contract fixtures**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Provide deterministic fixtures based on `modules/ui-mock-reference/lib/aurora/data.ts` plus backend inventory snapshots.
  - Outcome: UI can be developed/tested offline while preserving backend truth labels.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-008-implement-mock-transport-and-contract-fixtures.md`
- [ ] **SDK-009 — SDK-009 — Implement Tauri local/native transport interface**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Define JS-side transport that calls Tauri commands for local bus, sidecar status, native capability, secure storage, and local files.
  - Outcome: Desktop/mobile Tauri use the same SDK API as HTTP mode.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-009-implement-tauri-local-native-transport-interface.md`
- [ ] **SDK-010 — SDK-010 — Implement mesh/P2P transport interface**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Represent peer RPC, peer manifests, route candidates, and transport errors without binding UI to WebRTC internals.
  - Outcome: Mesh shell can route requests through trusted peers with explainable fallback.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-010-implement-mesh-p2p-transport-interface.md`
- [ ] **SDK-011 — SDK-011 — Implement event stream abstraction**
  - Lane: `sdk`
  - Depends on: SDK-001, SDK-003
  - Goal: Provide `subscribe`, `streamAssistant`, `watchHealth`, `watchConfig`, and reconnect/backfill semantics over HTTP SSE/WebSocket, Tauri IPC, and mesh.
  - Outcome: Streaming assistant, service health, pairing, and audit UI share one event contract.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-011-implement-event-stream-abstraction.md`
- [ ] **SDK-012 — SDK-012 — Implement route/privacy policy engine**
  - Lane: `sdk`
  - Depends on: SDK-001
  - Goal: Classify payload privacy, compare route candidates, block unsafe peer/cloud fallback, and produce redacted preview.
  - Outcome: RouteSheet and tool approvals show why a route is allowed or blocked.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-012-implement-route-privacy-policy-engine.md`
- [ ] **SDK-013 — SDK-013 — Implement AdminAction client controller**
  - Lane: `sdk`
  - Depends on: SDK-001, SDK-003, BE-004
  - Goal: Draft, display, confirm, reauth, submit, audit receipt, and error flows for manage/admin-critical operations.
  - Outcome: All high-risk UI actions go through one backend-enforced controller.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-013-implement-adminaction-client-controller.md`
- [ ] **SDK-014 — SDK-014 — Implement SDK conformance test suite across transports**
  - Lane: `sdk`
  - Depends on: SDK-001, SDK-007, SDK-008, SDK-009, SDK-010, SDK-011, SDK-013
  - Goal: Run shared behavior tests against mock, HTTP test gateway, Tauri command mocks, and mesh mocks.
  - Outcome: New transports cannot diverge silently.
  - Source: `.omx/specs/ui-production-tasks/tasks/SDK-014-implement-sdk-conformance-test-suite-across-transports.md`

## P2 — Backend contract/API gaps

- [ ] **BE-001 — BE-001 — Normalize auth/gateway route casing and public bypass behavior**
  - Lane: `backend/gateway`
  - Depends on: P0-002
  - Goal: Close backend/API gap for `auth.session.state_machine` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-001-normalize-auth-gateway-route-casing-and-public-bypass-behavior.md`
- [ ] **BE-002 — BE-002 — Add capability manifest endpoint or formal SDK-computed manifest contract**
  - Lane: `backend/gateway`
  - Depends on: P0-002
  - Goal: Close backend/API gap for `admin.overview` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-002-add-capability-manifest-endpoint-or-formal-sdk-computed-manifest-contract.md`
- [ ] **BE-003 — BE-003 — Add unified event stream contract**
  - Lane: `backend/events`
  - Depends on: P0-002, SDK-003
  - Goal: Close backend/API gap for `assistant.chat.streaming` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-003-add-unified-event-stream-contract.md`
- [ ] **BE-004 — BE-004 — Implement AdminAction draft/confirm/audit enforcement**
  - Lane: `backend/security`
  - Depends on: SDK-003
  - Goal: Close backend/API gap for `admin.action.envelope` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-004-implement-adminaction-draft-confirm-audit-enforcement.md`
- [ ] **BE-005 — BE-005 — Add diagnostics bundle export contract with redaction**
  - Lane: `backend/diagnostics`
  - Depends on: BE-004
  - Goal: Close backend/API gap for `admin.diagnostics.export` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-005-add-diagnostics-bundle-export-contract-with-redaction.md`
- [ ] **BE-006 — BE-006 — Add backup/restore contracts for config, DB/RAG, and models**
  - Lane: `backend/admin`
  - Depends on: BE-004
  - Goal: Close backend/API gap for `admin.backups` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-006-add-backup-restore-contracts-for-config-db-rag-and-models.md`
- [ ] **BE-007 — BE-007 — Add model runtime/catalog/import/download/benchmark contracts**
  - Lane: `backend/models`
  - Depends on: P0-002
  - Goal: Close backend/API gap for `models.catalog.runtime` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-007-add-model-runtime-catalog-import-download-benchmark-contracts.md`
- [ ] **BE-008 — BE-008 — Add attachment/context ingestion contracts**
  - Lane: `backend/assistant`
  - Depends on: P0-002
  - Goal: Close backend/API gap for `assistant.attachments` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-008-add-attachment-context-ingestion-contracts.md`
- [ ] **BE-009 — BE-009 — Add Orchestrator cancellation/interrupt contract**
  - Lane: `backend/orchestrator`
  - Depends on: P0-002
  - Goal: Close backend/API gap for `assistant.interrupt` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-009-add-orchestrator-cancellation-interrupt-contract.md`
- [ ] **BE-010 — BE-010 — Add config schema metadata, diff, rollback, and reload-impact preview**
  - Lane: `backend/config`
  - Depends on: BE-004
  - Goal: Close backend/API gap for `admin.config.edit` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-010-add-config-schema-metadata-diff-rollback-and-reload-impact-preview.md`
- [ ] **BE-011 — BE-011 — Add tool risk taxonomy and approval hints**
  - Lane: `backend/tools`
  - Depends on: P0-002
  - Goal: Close backend/API gap for `assistant.tool.approval` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-011-add-tool-risk-taxonomy-and-approval-hints.md`
- [ ] **BE-012 — BE-012 — Add pending pairing queue/list/event contract**
  - Lane: `backend/auth-mesh`
  - Depends on: BE-003
  - Goal: Close backend/API gap for `admin.pairing.queue` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-012-add-pending-pairing-queue-list-event-contract.md`
- [ ] **BE-013 — BE-013 — Add peer capability manifest and mesh route explain contracts**
  - Lane: `backend/mesh`
  - Depends on: BE-002
  - Goal: Close backend/API gap for `mesh.route.policy` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-013-add-peer-capability-manifest-and-mesh-route-explain-contracts.md`
- [ ] **BE-014 — BE-014 — Add WebRTC/ICE/data-channel diagnostics endpoints/events**
  - Lane: `backend/mesh`
  - Depends on: BE-003
  - Goal: Close backend/API gap for `mesh.diagnostics` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-014-add-webrtc-ice-data-channel-diagnostics-endpoints-events.md`
- [ ] **BE-015 — BE-015 — Implement or explicitly gate Supervisor service controls**
  - Lane: `backend/supervisor`
  - Depends on: BE-004
  - Goal: Close backend/API gap for `admin.services.control` so production UI can be honest and enforceable.
  - Outcome: Backend has a typed contract, route/exposure decision, permission model, audit/privacy behavior, and tests.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-015-implement-or-explicitly-gate-supervisor-service-controls.md`
- [ ] **BE-016 — BE-016 — Add deployment topology, bus health, and process-mode contract**
  - Lane: `backend/operations`
  - Depends on: P0-002, BE-002
  - Goal: Expose a typed, non-mutating backend contract that tells the UI exactly which Aurora architecture mode is running, which bus backend is active, and whether required infrastructure such as Redis/BullMQ is healthy.
  - Outcome: Admin and onboarding surfaces can distinguish server process mode, thread mode, local sidecar mode, and degraded Redis/BullMQ states without guessing from transport errors.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-016-add-deployment-topology-bus-health-and-process-mode-contract.md`
- [ ] **BE-017 — BE-017 — Add memory/RAG provenance, export, and delete contracts**
  - Lane: `backend/db-rag`
  - Depends on: P0-002, BE-004
  - Goal: Expose safe, permissioned memory/RAG read/provenance/export/delete surfaces so the assistant memory UI does not rely on internal-only DB methods.
  - Outcome: Users can inspect memory/RAG provenance, understand what context was used, export permitted records, and request deletion through auditable flows.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-017-add-memory-rag-provenance-export-delete-contracts.md`
- [ ] **BE-018 — BE-018 — Add scheduler management exposure and AdminAction contract**
  - Lane: `backend/scheduler`
  - Depends on: P0-002, BE-004
  - Goal: Make scheduler job management exposure explicit so the admin UI can safely list, schedule, cancel, pause, and resume jobs or honestly disable unsupported actions.
  - Outcome: Operators can manage scheduled jobs only through typed, permissioned, audited backend contracts.
  - Source: `.omx/specs/ui-production-tasks/tasks/BE-018-add-scheduler-management-exposure-and-adminaction-contract.md`

## P3 — Tauri desktop/native bridge

- [ ] **TAURI-001 — TAURI-001 — Scaffold official Tauri 2 app shell around production UI**
  - Lane: `tauri-desktop`
  - Depends on: P0-004, P0-003
  - Goal: Create production Tauri app using official Rust core and web frontend bundle.
  - Outcome: Desktop and mobile shell can launch the same React UI without Python-backed Tauri forks.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-001-scaffold-official-tauri-2-app-shell-around-production-ui.md`
- [ ] **TAURI-002 — TAURI-002 — Implement Rust-supervised desktop Python sidecar/local node**
  - Lane: `tauri-desktop`
  - Depends on: TAURI-001, SDK-009
  - Goal: Start, monitor, authenticate, and stop Aurora Python thread-mode node as a sidecar/loopback backend.
  - Outcome: Desktop Local mode can run offline local services while UI still uses SDK transport.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-002-implement-rust-supervised-desktop-python-sidecar-local-node.md`
- [ ] **TAURI-003 — TAURI-003 — Implement secure storage for tokens, mesh credentials, and local secrets**
  - Lane: `tauri-desktop`
  - Depends on: TAURI-001, SDK-004
  - Goal: Use platform keychain/Stronghold-compatible storage and never localStorage for credentials.
  - Outcome: Auth/session, mesh credentials, and admin unlock survive app restarts safely.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-003-implement-secure-storage-for-tokens-mesh-credentials-and-local-secrets.md`
- [ ] **TAURI-004 — TAURI-004 — Implement Tauri command bridge for local bus and native capability manifest**
  - Lane: `tauri-desktop`
  - Depends on: TAURI-001, SDK-009, BE-002
  - Goal: Expose `aurora_command`, `aurora_subscribe`, `native_capabilities`, sidecar status, log tail, and secure file handles.
  - Outcome: SDK Tauri transport can call local bus/native capabilities without HTTP.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-004-implement-tauri-command-bridge-for-local-bus-and-native-capability-manifest.md`
- [ ] **TAURI-005 — TAURI-005 — Implement desktop native permissions, tray, notifications, dialogs, files, and audio bridge**
  - Lane: `tauri-desktop`
  - Depends on: TAURI-001, SDK-009
  - Goal: Add desktop OS integrations needed by voice, attachments, diagnostics and always-available UX.
  - Outcome: Desktop app feels native while respecting capability graph and permissions.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-005-implement-desktop-native-permissions-tray-notifications-dialogs-files-and-audio-bridge.md`
- [ ] **TAURI-006 — TAURI-006 — Implement desktop packaging, signing, updater, and sidecar bundling**
  - Lane: `tauri-desktop`
  - Depends on: TAURI-002, TAURI-003, TAURI-004
  - Goal: Create reproducible Linux/macOS/Windows builds with signed updates and bundled sidecar policy.
  - Outcome: Production desktop releases are installable and updatable.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-006-implement-desktop-packaging-signing-updater-and-sidecar-bundling.md`
- [ ] **TAURI-007 — TAURI-007 — Map legacy PyQt UIBridge to Tauri/SDK migration contract**
  - Lane: `tauri-desktop`
  - Depends on: TAURI-004, UIA-001, UIA-004
  - Goal: Ensure the current PyQt `UIBridge` behavior is either preserved through the new SDK/Tauri event model or intentionally deprecated with a tested compatibility note.
  - Outcome: The Tauri migration does not silently drop existing local desktop flows for orchestrator input, STT transcription events, TTS playback state, status updates, or conversation history fetches.
  - Source: `.omx/specs/ui-production-tasks/tasks/TAURI-007-map-legacy-pyqt-uibridge-to-tauri-sdk-migration-contract.md`

## P4 — Android native

- [ ] **AND-001 — AND-001 — Create Tauri Android build/emulator CI baseline**
  - Lane: `android-native`
  - Depends on: TAURI-001
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Android APK/AAB builds and installs on emulator before feature plugins are added.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-001-create-tauri-android-build-emulator-ci-baseline.md`
- [ ] **AND-002 — AND-002 — Create Aurora Android Kotlin native plugin skeleton**
  - Lane: `android-native`
  - Depends on: AND-001, TAURI-004
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Tauri JS/Rust can invoke Kotlin native capability methods.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-002-create-aurora-android-kotlin-native-plugin-skeleton.md`
- [ ] **AND-003 — AND-003 — Implement Android native capability manifest provider**
  - Lane: `android-native`
  - Depends on: AND-002, SDK-006
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: SDK receives mic/notification/biometric/local-network/assistant-role/foreground-service/file/share status.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-003-implement-android-native-capability-manifest-provider.md`
- [ ] **AND-004 — AND-004 — Implement Android assistant-role qualification prototype**
  - Lane: `android-native`
  - Depends on: AND-002, AND-003
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Package declares qualifying manifest/service/activity entries and can request/check assistant role where available.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-004-implement-android-assistant-role-qualification-prototype.md`
- [ ] **AND-005 — AND-005 — Implement Android voice capture, foreground service, notifications, and permission flows**
  - Lane: `android-native`
  - Depends on: AND-003, UI-004
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: PTT/background voice states map to OS permission and foreground constraints.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-005-implement-android-voice-capture-foreground-service-notifications-and-permission-flows.md`
- [ ] **AND-006 — AND-006 — Implement Android share sheet, deep links, widgets/shortcuts, and quick tile entrypoints**
  - Lane: `android-native`
  - Depends on: AND-003, UIA-005
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Aurora can be invoked from Android system surfaces even when assistant role is unavailable.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-006-implement-android-share-sheet-deep-links-widgets-shortcuts-and-quick-tile-entrypoints.md`
- [ ] **AND-007 — AND-007 — Implement Android secure storage and biometric admin unlock**
  - Lane: `android-native`
  - Depends on: AND-003, TAURI-003
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Tokens/admin confirmations can use Android Keystore/Biometrics through SDK/Tauri plugin.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-007-implement-android-secure-storage-and-biometric-admin-unlock.md`
- [ ] **AND-008 — AND-008 — Implement Android local-light inference provider spike-to-product adapter**
  - Lane: `android-native`
  - Depends on: BE-007, AND-003
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Mobile runtime appears as a capability-gated provider, not a separate orchestrator fork.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-008-implement-android-local-light-inference-provider-spike-to-product-adapter.md`
- [ ] **AND-009 — AND-009 — Implement Android release, signing, Play/App Bundle, and device matrix gate**
  - Lane: `android-native`
  - Depends on: AND-001, AND-004, AND-005
  - Goal: Implement Android-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Android release path covers thin, mesh, assistant-role-capable, and fallback devices.
  - Source: `.omx/specs/ui-production-tasks/tasks/AND-009-implement-android-release-signing-play-app-bundle-and-device-matrix-gate.md`

## P5 — iOS native

- [ ] **IOS-001 — IOS-001 — Create macOS/Xcode/Tauri iOS build baseline**
  - Lane: `ios-native`
  - Depends on: TAURI-001
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: iOS app builds/runs on simulator/device in macOS CI/dev environment.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-001-create-macos-xcode-tauri-ios-build-baseline.md`
- [ ] **IOS-002 — IOS-002 — Create Aurora iOS Swift native plugin skeleton**
  - Lane: `ios-native`
  - Depends on: IOS-001, TAURI-004
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Tauri JS/Rust can invoke Swift native capability methods.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-002-create-aurora-ios-swift-native-plugin-skeleton.md`
- [ ] **IOS-003 — IOS-003 — Implement iOS App Intents and Shortcuts invocation**
  - Lane: `ios-native`
  - Depends on: IOS-002, SDK-006
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Aurora exposes approved assistant actions to Siri/Shortcuts/App Intents without claiming Siri replacement.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-003-implement-ios-app-intents-and-shortcuts-invocation.md`
- [ ] **IOS-004 — IOS-004 — Implement iOS share extension, deep links, widgets, and file associations**
  - Lane: `ios-native`
  - Depends on: IOS-002, UIA-005
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Aurora can receive shared content and be launched from system surfaces.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-004-implement-ios-share-extension-deep-links-widgets-and-file-associations.md`
- [ ] **IOS-005 — IOS-005 — Implement iOS Keychain/biometric secure storage and admin unlock**
  - Lane: `ios-native`
  - Depends on: IOS-002, TAURI-003
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Tokens, mesh credentials and admin confirmation unlocks use Keychain/Face ID/Touch ID.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-005-implement-ios-keychain-biometric-secure-storage-and-admin-unlock.md`
- [ ] **IOS-006 — IOS-006 — Implement iOS microphone, notifications, background limits, and voice UX states**
  - Lane: `ios-native`
  - Depends on: IOS-002, UI-004
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Voice UI accurately reflects iOS permission and background limitations.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-006-implement-ios-microphone-notifications-background-limits-and-voice-ux-states.md`
- [ ] **IOS-007 — IOS-007 — Implement iOS local-light inference provider adapter**
  - Lane: `ios-native`
  - Depends on: BE-007, IOS-002
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: Core ML/MLC/ExecuTorch-style providers register as capability-gated model providers.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-007-implement-ios-local-light-inference-provider-adapter.md`
- [ ] **IOS-008 — IOS-008 — Implement iOS signing, TestFlight/App Store, and device matrix gate**
  - Lane: `ios-native`
  - Depends on: IOS-001, IOS-003, IOS-004
  - Goal: Implement iOS-specific native capability safely inside official Tauri mobile architecture.
  - Outcome: iOS release path is production-ready and policy-safe.
  - Source: `.omx/specs/ui-production-tasks/tasks/IOS-008-implement-ios-signing-testflight-app-store-and-device-matrix-gate.md`

## P6 — UI shell

- [ ] **UI-001 — UI-001 — Build production app shell, routes, navigation, and design tokens**
  - Lane: `ui-shell`
  - Depends on: P0-003, SDK-001
  - Goal: Create production UI shell from the visual reference system.
  - Outcome: User sees unified assistant/admin/runtime shell on web and Tauri with responsive desktop/mobile navigation.
  - Source: `.omx/specs/ui-production-tasks/tasks/UI-001-build-production-app-shell-routes-navigation-and-design-tokens.md`
- [ ] **UI-002 — UI-002 — Implement capability-driven navigation and feature drawer**
  - Lane: `ui-shell`
  - Depends on: UI-001, SDK-006
  - Goal: Drive nav badges, disabled states, and repair actions from the capability graph.
  - Outcome: Every unavailable feature explains missing service/permission/native capability and next action.
  - Source: `.omx/specs/ui-production-tasks/tasks/UI-002-implement-capability-driven-navigation-and-feature-drawer.md`
- [ ] **UI-003 — UI-003 — Implement onboarding, connection, pairing, and auth/session flows**
  - Lane: `ui-auth`
  - Depends on: UI-001, SDK-004, BE-001
  - Goal: Create first-run and reconnect flows for every deployment mode.
  - Outcome: User can connect to server, local desktop sidecar, mesh peer, Android/iOS thin mode, or offline local mode with correct auth/pairing UX.
  - Source: `.omx/specs/ui-production-tasks/tasks/UI-003-implement-onboarding-connection-pairing-and-auth-session-flows.md`
- [ ] **UI-004 — UI-004 — Implement settings, permissions, privacy defaults, and native permission UX**
  - Lane: `ui-settings`
  - Depends on: UI-001, SDK-006, TAURI-004
  - Goal: Give users/admins one place to understand privacy and native permission posture.
  - Outcome: Settings accurately explain route defaults, admin confirmation policy, Android/iOS/desktop permission states, and fallback behavior.
  - Source: `.omx/specs/ui-production-tasks/tasks/UI-004-implement-settings-permissions-privacy-defaults-and-native-permission-ux.md`
- [ ] **UI-005 — UI-005 — Implement RouteSheet/privacy guard shared component**
  - Lane: `ui-crosscut`
  - Depends on: UI-001, SDK-012
  - Goal: Make route/privacy preview reusable across assistant, tools, admin exports, mesh route policy, and attachments.
  - Outcome: All payload-routing decisions expose target, privacy class, redacted preview, policy reason, and audit placeholder.
  - Source: `.omx/specs/ui-production-tasks/tasks/UI-005-implement-routesheet-privacy-guard-shared-component.md`

## P7 — Assistant UI

- [ ] **UIA-001 — UIA-001 — Wire assistant text chat send/receive**
  - Lane: `assistant`
  - Depends on: UI-001, UI-005, SDK-007
  - Goal: Implement basic assistant prompt flow over SDK before streaming complexity.
  - Outcome: User can send prompt and receive final response in server web, desktop thin, desktop local, and mesh/native-capable modes.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-001-wire-assistant-text-chat-send-receive.md`
- [ ] **UIA-002 — UIA-002 — Wire assistant streaming, cancellation, retry, and transport-loss states**
  - Lane: `assistant`
  - Depends on: UIA-001, SDK-011, BE-003, BE-009
  - Goal: Upgrade assistant UX to live token/event stream with robust interruption.
  - Outcome: User can stop generation/tool/TTS where supported and retry or recover from stream disconnect.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-002-wire-assistant-streaming-cancellation-retry-and-transport-loss-states.md`
- [ ] **UIA-003 — UIA-003 — Wire tool approval cards and tool-result display**
  - Lane: `assistant-tools`
  - Depends on: UIA-001, SDK-013, BE-011
  - Goal: Make tool execution transparent and permission/privacy aware.
  - Outcome: User sees tool risk, inputs, data-egress, approval/deny reason, progress, result, and audit receipt.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-003-wire-tool-approval-cards-and-tool-result-display.md`
- [ ] **UIA-004 — UIA-004 — Wire voice PTT, wake, transcription, and TTS playback per mode**
  - Lane: `assistant-voice`
  - Depends on: UIA-001, UI-004, SDK-006
  - Goal: Implement voice without conflating local device audio and remote server audio.
  - Outcome: User can understand and use local capture, remote transcription, native playback, wake/background capabilities by mode/platform.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-004-wire-voice-ptt-wake-transcription-and-tts-playback-per-mode.md`
- [ ] **UIA-005 — UIA-005 — Wire attachments and mobile share-intake UI**
  - Lane: `assistant-context`
  - Depends on: UIA-001, BE-008, SDK-006
  - Goal: Implement context intake for files, URLs, images, screenshots, shared content, and privacy labels.
  - Outcome: User can attach/share context and see route/privacy restrictions before sending.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-005-wire-attachments-and-mobile-share-intake-ui.md`
- [ ] **UIA-006 — UIA-006 — Wire conversation history, memory, and RAG provenance UI**
  - Lane: `assistant-memory`
  - Depends on: UIA-001, SDK-007, BE-017
  - Goal: Expose history and memory without leaking sensitive data or overclaiming mobile local storage.
  - Outcome: User can browse/search conversations, inspect memory/RAG provenance, delete/export where backend supports it.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-006-wire-conversation-history-memory-and-rag-provenance-ui.md`
- [ ] **UIA-007 — UIA-007 — Wire models/runtime selection and provider capability UI**
  - Lane: `assistant-models`
  - Depends on: UIA-001, BE-007
  - Goal: Let users select/understand model providers across local, remote, mesh, desktop GPU, and mobile local-light.
  - Outcome: Model UI shows actual provider health, hardware, benchmark, route/privacy implications, and unsupported states.
  - Source: `.omx/specs/ui-production-tasks/tasks/UIA-007-wire-models-runtime-selection-and-provider-capability-ui.md`

## P8 — Admin/operator dashboard

- [ ] **ADM-001 — ADM-001 — Wire admin overview/service/capability dashboard**
  - Lane: `admin`
  - Depends on: UI-002, SDK-006
  - Goal: Production-wire admin surface for `admin.overview`.
  - Outcome: Show deployment posture, service health, capability gaps, activity rail, and repair links.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-001-wire-admin-overview-service-capability-dashboard.md`
- [ ] **ADM-002 — ADM-002 — Wire services and contract explorer**
  - Lane: `admin`
  - Depends on: ADM-001, SDK-002, BE-015
  - Goal: Production-wire admin surface for `admin.services.list`.
  - Outcome: List services/methods/exposure/routes/backend coverage and safely preview health/control actions.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-002-wire-services-and-contract-explorer.md`
- [ ] **ADM-003 — ADM-003 — Wire RBAC principals, roles, permissions and effective access**
  - Lane: `admin`
  - Depends on: SDK-005, SDK-013, BE-004
  - Goal: Production-wire admin surface for `admin.rbac.principals`.
  - Outcome: CRUD principals/roles, patch permissions, preview effective diffs/cascade, and audit changes.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-003-wire-rbac-principals-roles-permissions-and-effective-access.md`
- [ ] **ADM-004 — ADM-004 — Wire token lifecycle management**
  - Lane: `admin`
  - Depends on: SDK-005, SDK-013, BE-004
  - Goal: Production-wire admin surface for `admin.tokens`.
  - Outcome: Create/list/scope-update/revoke tokens with one-time reveal and credential privacy.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-004-wire-token-lifecycle-management.md`
- [ ] **ADM-005 — ADM-005 — Wire device/session management**
  - Lane: `admin`
  - Depends on: SDK-004, SDK-013, BE-004
  - Goal: Production-wire admin surface for `admin.devices`.
  - Outcome: List/delete/trust devices and expose active sessions/tokens/platform capabilities.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-005-wire-device-session-management.md`
- [ ] **ADM-006 — ADM-006 — Wire config editor, validation, diff, rollback, reload impact**
  - Lane: `admin`
  - Depends on: SDK-013, BE-010
  - Goal: Production-wire admin surface for `admin.config.edit`.
  - Outcome: Schema-driven config read/edit/validate/apply/rollback with restart/reload impact and admin confirmation.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-006-wire-config-editor-validation-diff-rollback-reload-impact.md`
- [ ] **ADM-007 — ADM-007 — Wire plugins, MCP, tools and reload/install states**
  - Lane: `admin`
  - Depends on: SDK-007, BE-011
  - Goal: Production-wire admin surface for `admin.plugins`.
  - Outcome: Show plugin/MCP status, safe config toggles, internal-only reload, tool inventory and risk metadata.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-007-wire-plugins-mcp-tools-and-reload-install-states.md`
- [ ] **ADM-008 — ADM-008 — Wire audit log details and export**
  - Lane: `admin`
  - Depends on: SDK-007, BE-004
  - Goal: Production-wire admin surface for `admin.audit`.
  - Outcome: Search/filter audit, inspect event details/reasons/receipts/redacted payload, and export under policy.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-008-wire-audit-log-details-and-export.md`
- [ ] **ADM-009 — ADM-009 — Wire diagnostics probes and redacted support bundle**
  - Lane: `admin`
  - Depends on: SDK-013, BE-005
  - Goal: Production-wire admin surface for `admin.diagnostics.export`.
  - Outcome: Show probes, native/sidecar/gateway/mesh logs, redaction preview, export bundle with audit receipt.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-009-wire-diagnostics-probes-and-redacted-support-bundle.md`
- [ ] **ADM-010 — ADM-010 — Wire backup/restore dashboard**
  - Lane: `admin`
  - Depends on: SDK-013, BE-006
  - Goal: Production-wire admin surface for `admin.backups`.
  - Outcome: Create/verify/download/restore backups with admin-critical confirmation and rollback visibility.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-010-wire-backup-restore-dashboard.md`
- [ ] **ADM-011 — ADM-011 — Wire pairing queue and pending device/peer review**
  - Lane: `admin`
  - Depends on: SDK-004, BE-012
  - Goal: Production-wire admin surface for `admin.pairing.queue`.
  - Outcome: List pending pairings, approve/deny, expire, bilateral mesh pairing and inbound credential state.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-011-wire-pairing-queue-and-pending-device-peer-review.md`
- [ ] **ADM-012 — ADM-012 — Wire scheduler jobs and automation management**
  - Lane: `admin`
  - Depends on: SDK-007, SDK-013, BE-018
  - Goal: Production-wire admin surface for `scheduler.jobs`.
  - Outcome: List/schedule/cancel/pause/resume jobs with permission and audit handling.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-012-wire-scheduler-jobs-and-automation-management.md`
- [ ] **ADM-013 — ADM-013 — Wire deployment topology and process-mode operations dashboard**
  - Lane: `admin`
  - Depends on: ADM-001, BE-016, SDK-006
  - Goal: Add the admin/operator UI surface that explains how Aurora is deployed and which runtime/transport infrastructure is healthy.
  - Outcome: Operators can see at a glance whether they are managing a server process-mode deployment, local thread-mode app, desktop sidecar, or mesh peer shell, and what infrastructure is degraded.
  - Source: `.omx/specs/ui-production-tasks/tasks/ADM-013-wire-deployment-topology-and-process-mode-operations-dashboard.md`

## P9 — Mesh/WebRTC UI

- [ ] **MESH-001 — MESH-001 — Wire mesh pairing and persisted peer lifecycle**
  - Lane: `mesh`
  - Depends on: ADM-011, BE-013
  - Goal: Production-wire mesh/P2P surface for `admin.mesh.peers`.
  - Outcome: Admins can review pending peers, fingerprints, scopes, approve/deny/remove, and see persisted trust.
  - Source: `.omx/specs/ui-production-tasks/tasks/MESH-001-wire-mesh-pairing-and-persisted-peer-lifecycle.md`
- [ ] **MESH-002 — MESH-002 — Wire live sessions vs persisted peers view**
  - Lane: `mesh`
  - Depends on: MESH-001, BE-014
  - Goal: Production-wire mesh/P2P surface for `admin.mesh.peers`.
  - Outcome: UI separates active WebRTC sessions from Auth mesh peer records and device records.
  - Source: `.omx/specs/ui-production-tasks/tasks/MESH-002-wire-live-sessions-vs-persisted-peers-view.md`
- [ ] **MESH-003 — MESH-003 — Wire route policy editor and route explain UI**
  - Lane: `mesh`
  - Depends on: MESH-001, BE-013, SDK-012
  - Goal: Production-wire mesh/P2P surface for `mesh.route.policy`.
  - Outcome: Users/admins can define/explain peer fallback policy with privacy/trust/latency rules.
  - Source: `.omx/specs/ui-production-tasks/tasks/MESH-003-wire-route-policy-editor-and-route-explain-ui.md`
- [ ] **MESH-004 — MESH-004 — Wire WebRTC/ICE diagnostics UI**
  - Lane: `mesh`
  - Depends on: MESH-002, BE-014
  - Goal: Production-wire mesh/P2P surface for `mesh.diagnostics`.
  - Outcome: Operators can diagnose signaling, ICE, auth, DataChannel, RTT, and mesh routing failures.
  - Source: `.omx/specs/ui-production-tasks/tasks/MESH-004-wire-webrtc-ice-diagnostics-ui.md`

## P10 — QA/release gates

- [ ] **QA-001 — QA-001 — Build SDK/backend contract conformance CI**
  - Lane: `qa-release`
  - Depends on: SDK-014, P0-002
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: Contract drift fails fast across registry, OpenAPI, SDK generated types, fixtures, and mock refs.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-001-build-sdk-backend-contract-conformance-ci.md`
- [ ] **QA-002 — QA-002 — Build multi-mode E2E matrix**
  - Lane: `qa-release`
  - Depends on: UIA-001, ADM-001, TAURI-004, AND-001, IOS-001
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: Server web, desktop thin, desktop local, mesh shell, Android thin, iOS thin smoke flows run in CI/device labs.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-002-build-multi-mode-e2e-matrix.md`
- [ ] **QA-003 — QA-003 — Build security/privacy regression suite**
  - Lane: `qa-release`
  - Depends on: BE-004, SDK-012, ADM-008
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: Permissions, auth, AdminAction, redaction, route privacy and credential storage are tested adversarially.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-003-build-security-privacy-regression-suite.md`
- [ ] **QA-004 — QA-004 — Build accessibility, responsive, visual regression suite**
  - Lane: `qa-release`
  - Depends on: UI-001, UIA-001, ADM-001
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: Assistant/admin/mobile surfaces meet accessibility and visual consistency gates.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-004-build-accessibility-responsive-visual-regression-suite.md`
- [ ] **QA-005 — QA-005 — Build performance/offline/resilience suite**
  - Lane: `qa-release`
  - Depends on: UIA-002, SDK-011, TAURI-002
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: Streaming, event reconnect, sidecar startup, offline mode, peer failover and large lists meet budgets.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-005-build-performance-offline-resilience-suite.md`
- [ ] **QA-006 — QA-006 — Build release packaging and operator runbooks**
  - Lane: `qa-release`
  - Depends on: TAURI-006, AND-009, IOS-008, ADM-009
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: Operators and users can install/update/debug/recover production releases across platforms.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-006-build-release-packaging-and-operator-runbooks.md`
- [ ] **QA-007 — QA-007 — Final production readiness audit and task-board closure**
  - Lane: `qa-release`
  - Depends on: QA-001, QA-002, QA-003, QA-004, QA-005, QA-006
  - Goal: Create production gate evidence for the whole UI/backend/native system.
  - Outcome: All tasks are verified, docs/runbooks updated, and no mock-only production paths remain.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-007-final-production-readiness-audit-and-task-board-closure.md`
- [ ] **QA-008 — QA-008 — Build thread/process/mesh transport parity gate**
  - Lane: `qa-release`
  - Depends on: QA-002, BE-016, SDK-014, MESH-004
  - Goal: Add an explicit release gate proving that the same UI/SDK flows behave consistently across LocalBus thread mode, BullMQ/Redis process mode, HTTP Gateway thin mode, Tauri local mode, and Mesh/WebRTC mode.
  - Outcome: Production readiness cannot pass by testing only one deployment topology.
  - Source: `.omx/specs/ui-production-tasks/tasks/QA-008-build-thread-process-mesh-transport-parity-gate.md`

---

# Commit/readiness notes

- Keep `.omx/state/`, `.omx/logs/`, `.omx/tmp/`, `.omx/cache/`, `.omx/notepad.md`, and `.omx/project-memory.json` local-only.
- Track durable `.omx/ROADMAP.md`, `.omx/specs/**`, and `.omx/multica/**` artifacts.
- Track `modules/ui-mock-reference` source, config, lockfile, and public assets; do not track `.next/` or `node_modules/`.
- Do not upload UI tasks to Multica as ready-to-run until `UI-SYNC-001` is complete.
