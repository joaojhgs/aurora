# Aurora documentation index

**Status:** Current source of truth
**Audience:** contributors, operators, and agents working in this repository

This index separates current documentation from historical/provenance material. If a document is not listed here, treat it as implementation-local, package-local, or archived context rather than canonical guidance.

## Start here

| Need | Read |
| --- | --- |
| What Aurora is and how the repo is organized | [`../readme.md`](../readme.md), [`ARCHITECTURE.md`](ARCHITECTURE.md), [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) |
| Install or run locally | [`INSTALL.md`](INSTALL.md), [`UV_USAGE.md`](UV_USAGE.md) |
| Run services in process mode or Docker | [`../README.process-mode.md`](../README.process-mode.md), [`TILT.md`](TILT.md), [`docker/DB-SERVICE-EMBEDDINGS.md`](docker/DB-SERVICE-EMBEDDINGS.md), [`docker/ORCHESTRATOR-SERVICE-LLM-MODES.md`](docker/ORCHESTRATOR-SERVICE-LLM-MODES.md) |
| Understand CI and tests | [`CI_CD.md`](CI_CD.md), [`../tests/README.md`](../tests/README.md), [`TESTING_PROCESS_MODE.md`](TESTING_PROCESS_MODE.md) |
| Work on configuration | [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md) |
| Work on messaging/contracts/API | [`MESSAGING_ARCHITECTURE.md`](MESSAGING_ARCHITECTURE.md), [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md), [`SERVICE_METHODS_REFERENCE.md`](SERVICE_METHODS_REFERENCE.md) |
| Work on Gateway, auth, permissions, or mesh | [`GATEWAY.md`](GATEWAY.md), [`AUTH_AND_PERMISSIONS.md`](AUTH_AND_PERMISSIONS.md), [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md), [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md) |
| Work on frontend, SDK, web, Tauri, or PyQt fallback | [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md), [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md), [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md) |
| Work on backup/restore | [`BACKUP_SERVICE.md`](BACKUP_SERVICE.md) |
| Work on MCP/tools | [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) |
| Work on dependencies and optional install profiles | [`DEPENDENCIES.md`](DEPENDENCIES.md) |
| Maintain documentation | [`DOC_MAINTENANCE.md`](DOC_MAINTENANCE.md) |

## Current core docs

| Document | Status | Purpose |
| --- | --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Current | System architecture, services, modes, and frontend boundaries. |
| [`FEATURE_MATRIX.md`](FEATURE_MATRIX.md) | Current | Feature readiness and production-boundary matrix. |
| [`TECHSTACK.md`](TECHSTACK.md) | Current | Major languages, frameworks, and runtime dependencies. |
| [`INSTALL.md`](INSTALL.md) | Current | Local install and setup guidance. |
| [`UV_USAGE.md`](UV_USAGE.md) | Current | `uv` and optional dependency usage. |
| [`DEPENDENCIES.md`](DEPENDENCIES.md) | Current | Service extras, local model profiles, sidecar profiles, and generated dependency-artifact policy. |
| [`CI_CD.md`](CI_CD.md) | Current | GitHub Actions lanes and local equivalents. |
| [`CONTRIBUTE.md`](CONTRIBUTE.md) | Current | Contributor workflow and links to current checks. |

## Runtime and backend docs

| Document | Status | Purpose |
| --- | --- | --- |
| [`CONFIG_SERVICE_PATTERN.md`](CONFIG_SERVICE_PATTERN.md) | Current | Required config access pattern for services. |
| [`MESSAGING_ARCHITECTURE.md`](MESSAGING_ARCHITECTURE.md) | Current | LocalBus/BullMQBus behavior, priorities, and process mode. |
| [`API_AND_CONTRACTS.md`](API_AND_CONTRACTS.md) | Current | Contract registry, generated Gateway routes, SDK conformance, and service method docs. |
| [`GATEWAY.md`](GATEWAY.md) | Current | HTTP Gateway, dynamic routes, event stream, WebRTC, and mesh endpoints. |
| [`AUTH_AND_PERMISSIONS.md`](AUTH_AND_PERMISSIONS.md) | Current | Principals, tokens, topic permissions, pairing, audit, and admin boundaries. |
| [`PEER_PAIRING_FLOW.md`](PEER_PAIRING_FLOW.md) | Current | Pairing and mesh resource-access flow. |
| [`DATA_SHARING_POLICY.md`](DATA_SHARING_POLICY.md) | Current | Mesh data-sharing modes and ownership policy. |
| [`BACKUP_SERVICE.md`](BACKUP_SERVICE.md) | Current | Backup/restore contract, dry-run limits, and storage. |
| [`SERVICE_METHODS_REFERENCE.md`](SERVICE_METHODS_REFERENCE.md) | Current but manually maintained | Human-readable service method overview. Keep it aligned with `app/shared/contracts/models/` and `@method_contract` decorators. |

## Frontend and platform docs

| Document | Status | Purpose |
| --- | --- | --- |
| [`FRONTEND_AND_UI_ARCHITECTURE.md`](FRONTEND_AND_UI_ARCHITECTURE.md) | Current | SDK-first UI architecture across React, web, Tauri, and PyQt fallback. |
| [`TAURI_DESKTOP_BUILD.md`](TAURI_DESKTOP_BUILD.md) | Current | Desktop sidecar profiles and unsigned bundle build flow. |
| [`PRODUCTION_UI_CONTRACTS.md`](PRODUCTION_UI_CONTRACTS.md) | Current | UI source-boundary rules and regression gates. |
| [`UI_INTEGRATION.md`](UI_INTEGRATION.md) | Legacy/current bridge reference | PyQt UIBridge reference and migration notes. Prefer `FRONTEND_AND_UI_ARCHITECTURE.md` for new UI work. |
| [`ACCESSIBILITY_RESPONSIVE_VISUAL_TESTS.md`](ACCESSIBILITY_RESPONSIVE_VISUAL_TESTS.md) | Current | UI package accessibility/responsive/visual checks. |
| [`PERFORMANCE_OFFLINE_RESILIENCE_TESTS.md`](PERFORMANCE_OFFLINE_RESILIENCE_TESTS.md) | Current | SDK resilience/offline/performance checks. |

## Partial or bounded feature docs

| Document | Status | Boundary |
| --- | --- | --- |
| [`AMBIENT_TRANSCRIPTION.md`](AMBIENT_TRANSCRIPTION.md) | Partial | Config and coordinator behavior exist; durable ambient logging service is not implemented. |
| [`MESH_GAP_E2E_HARNESS.md`](MESH_GAP_E2E_HARNESS.md) | Current bounded harness | Transport E2E harness, not a full physical-device proof. |
| [`SDK_BACKEND_CONFORMANCE_CI.md`](SDK_BACKEND_CONFORMANCE_CI.md) | Current bounded check | Prevents SDK/backend fixture drift, not a live production certification. |

## Archive and provenance

Historical plans, handoffs, task reports, and generated investigation artifacts live outside the current docs surface:

- [`docs/archive/`](archive/) stores human-readable provenance that is not current guidance.
- [`.omx/plans/docs-plans/`](../.omx/plans/docs-plans/) stores moved plan documents from the former `docs/plans/` tree.
- [`.omx/plans/dependency-analysis-archive/`](../.omx/plans/dependency-analysis-archive/) stores generated dependency-analysis artifacts and phase journals.

Do not add new generated reports, one-off task checklists, or agent handoffs to `docs/`. See [`DOC_MAINTENANCE.md`](DOC_MAINTENANCE.md).
