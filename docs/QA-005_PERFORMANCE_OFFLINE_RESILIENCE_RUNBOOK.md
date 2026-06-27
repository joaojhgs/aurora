# QA-005 Performance, Offline, And Resilience Gate

## Scope

This gate covers SDK-backed production readiness evidence for streaming reconnect, offline handling, Tauri sidecar startup evidence, mesh peer failover, and large capability/tool lists. It does not mark native desktop/mobile packaging or physical-device assistant-role behavior production-ready without the artifact and device evidence listed below.

## Required Commands

| Layer | Command | Owner | Required artifact |
| --- | --- | --- | --- |
| SDK resilience/performance | `pnpm --filter @aurora/client test:qa005` | Frontend | CI log showing QA-005 tests green. |
| SDK type/build | `pnpm --filter @aurora/client typecheck` and `pnpm --filter @aurora/client build` | Frontend | CI log or local handoff output. |
| Workspace regression | `pnpm test` | Frontend/QA | CI log; failures require owner and accepted skip rationale. |
| Tauri sidecar smoke | `pnpm --filter @aurora/tauri-ui prepare:sidecar` plus Tauri shell smoke when platform dependencies exist | Frontend/QA | `apps/aurora-tauri/reports/qa-005-sidecar-smoke.log`. |
| Process mode | `uv run pytest tests/integration/test_process_mode.py` with Redis available | Backend/QA | pytest log and Redis/process-mode environment summary. |
| Mesh failover | live two-peer mesh suite from QA-002/QA-008 when available | Backend/QA | peer IDs, route/fallback audit correlation IDs, no mock transport. |

## Acceptance Evidence

- Streaming reconnect must preserve the last backend-proven event ID and must not replay duplicate event IDs after reconnect.
- Offline mode must surface `transport_loss`, `unavailable_service`, `unsupported_feature`, or `native_permission_missing` instead of optimistic success.
- Tauri sidecar checks must include startup/status/crash or unavailable evidence with a log path. Browser-only Playwright or SDK mocks cannot prove sidecar health.
- Mesh failover must include selected peer/provider, stale or denied primary reason, fallback evidence, `correlation_id`, and redaction metadata.
- Large capability/tool lists must keep policy, selector, provider, permission, and redaction fields intact while staying inside the budget asserted by the QA-005 SDK test.
- Security/privacy negative cases from QA-003 remain a release prerequisite; QA-005 only verifies that resilience paths preserve error/audit/redaction evidence.

## Deferred Or Manual Evidence

- Android assistant role is not production complete from emulator-only evidence. A physical device/OEM/profile matrix is required before release claims.
- iOS cannot claim Siri replacement. iOS evidence is limited to app-owned intents, shortcuts, widgets, share/deep-link surfaces, secure storage, and explicit user actions.
- Live process-mode and mesh checks may be skipped only when Redis, WebRTC signaling, or two-peer runtime infrastructure is unavailable. The skip must name the missing dependency, owner, follow-up issue, and the command that was attempted.

## Rollback And Diagnostics

- Disable the release candidate if QA-005 reports mock-only readiness, missing sidecar logs, duplicated stream events, lost audit correlation IDs, or unredacted secret-like fields.
- Collect Gateway diagnostics/support bundle only through the redacted diagnostics contract. Do not attach raw tokens, mesh credentials, API keys, or unredacted tool arguments.
- Roll back to the last release branch whose QA-001 through QA-006 artifacts are complete and whose native packaging artifacts match the target platform.

## Final Checklist Links

- QA-001 SDK/backend contract conformance.
- QA-002 multi-mode E2E matrix.
- QA-003 security/privacy regression suite.
- QA-004 accessibility/responsive/visual regression suite.
- QA-005 this performance/offline/resilience gate.
- QA-006 release packaging and operator runbooks.
- QA-007 final production readiness audit and task-board closure.
