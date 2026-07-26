# Production UI Contract Hardening

## Scope

This document audits production UI surfaces that render service, mesh, admin, privacy, native, onboarding, model, memory, and backup state. The enforceable source is `packages/aurora-ui/src/production-surface-contracts.ts`; this document summarizes the same contract for review.

## Source Rules

- Runtime screens must use `AuroraClient`, SDK-derived capability graph/catalog data, native capability manifests, or an explicit unsupported/degraded state.
- Mock fixtures are allowed for tests and mock transport development fallback only. They are not production truth.
- Admin-critical or `manage` mutations must be represented as AdminAction draft/confirm/audit gated before the UI claims execution.
- Diagnostic graph/resource data may explain topology and blockers, but executable controls still require SDK/capability/native evidence.

## Surface Matrix

| Surface | Source of truth | AdminAction / degraded behavior | Test coverage |
| --- | --- | --- | --- |
| Assistant and RouteSheet | `Orchestrator.ExternalUserInput`, `Orchestrator.Interrupt`, event stream, `Gateway.GetCapabilityCatalog`, `Gateway.ExplainRoute` | Route confirmation blocks on privacy denial, unavailable SDK state, and unconfirmed AdminAction. | `packages/aurora-ui/tests/shell.test.tsx` |
| Admin overview/services/contracts | `Gateway.GetCapabilityCatalog`, `Gateway.GetRegistry`, `Gateway.GetServices`, deployment topology | Service controls render disabled or AdminAction-preview only when lifecycle descriptors are missing/internal. | `packages/aurora-ui/tests/shell.test.tsx` |
| RBAC/tokens/devices | Auth principal/token/device SDK methods plus audit records | Permission, token, and device mutations build AdminAction requests and show rollback/pending evidence. | `packages/aurora-ui/tests/shell.test.tsx` |
| Audit/plugins/tools/scheduler | `Auth.AuditLog`, `Tooling.GetToolCatalog`, `Scheduler.ListJobs`, capability graph | Tool/plugin/scheduler mutations require approval/AdminAction or render unsupported with reason text. | `packages/aurora-ui/tests/shell.test.tsx`, `packages/aurora-sdk/tests/scheduler.test.ts` |
| Config editor/settings/privacy | Config schema/diff/history/reload-impact SDK methods and capability graph route policy | Config and route policy saves require AdminAction; secret values stay redacted. | `packages/aurora-ui/tests/shell.test.tsx` |
| Memory/RAG/data policy | RAG namespace/search/provenance SDK methods plus explicit unsupported policy for raw SQL/replication | Export/import/delete stay disabled behind AdminAction or data-sharing policy. | `packages/aurora-ui/tests/shell.test.tsx` |
| Backup/restore | Backup list/create/verify/restore/rollback SDK surfaces | Create, verify, restore, and rollback are AdminAction-gated. | `packages/aurora-ui/tests/shell.test.tsx` |
| Models/runtime | Orchestrator model catalog/runtime/operation SDK methods, capability graph, native evidence | Import/download/benchmark/selection remain disabled until descriptors allow them. | `packages/aurora-ui/tests/shell.test.tsx` |
| Mesh peers/diagnostics/route policy/resources | `Gateway.GetMeshStatus`, WebRTC diagnostics, route explain, capability catalog, Auth peer/pairing methods | Presence is not pairing success; stale/denied/explicit-selector failures remain visible and disabled. | `packages/aurora-ui/tests/shell.test.tsx` |
| Native capability/settings/onboarding | `Native.GetCapabilityManifest`, Auth session/pairing SDK methods | Unsupported platform features render as platform limits; mock transport is labeled degraded development fallback. | `packages/aurora-ui/tests/shell.test.tsx`, app runtime tests |

## Regression Gates

- `packages/aurora-ui/tests/shell.test.tsx` verifies the production surface matrix, nav bindings, evidence sources, AdminAction declarations, and test-only fixture policy.
- The same test scans production UI files under `packages/aurora-ui/src`, `apps/aurora-web/app`, and `apps/aurora-tauri/src` so screen code cannot directly call `fetch`, Tauri `invoke`, SDK fixtures, mock-reference data, raw service objects, or raw bus implementations outside adapter internals.
- SDK conformance remains covered by `packages/aurora-sdk/tests/conformance.test.ts` and `scripts/check_sdk_backend_conformance.py`.

## Operator verification contract

The production UI contract is not complete until the operator evidence below exists for the current tree.

| Evidence class | Required command or artifact | Acceptance boundary |
| --- | --- | --- |
| Route production contract | `pnpm --filter @aurora/tauri-ui test:e2e:routes` | All 22 primary routes are registered, route-specific, and free of placeholder/debug-dashboard fallback copy. |
| Route outcome contract | `pnpm --filter @aurora/tauri-ui test:e2e:outcomes` and `apps/aurora-tauri/reports/e2e-outcomes/` | Navigation, SDK-backed state, visible errors, and invoked backend method names are recorded as static review artifacts. |
| Desktop local dev contract | `pnpm --filter @aurora/tauri-ui tauri dev`; CI wrapper `pnpm --filter @aurora/tauri-ui dev:smoke` | Vite, Rust/Tauri, and Python Aurora services run in one local stack with Gateway readiness and `[tauri]`/`[aurora][...]` log evidence. |
| Linux-safe aggregate smoke | `pnpm --filter @aurora/tauri-ui tauri:smoke:linux` | Delegates to `test:ci-regression-gates`; route, assistant, admin, runtime, outcome, dev-bootstrap, native-evidence, and service-boundary gates pass without requiring a desktop WebView. |
| Packaged desktop sidecar contract | `pnpm --filter @aurora/tauri-ui prepare:sidecar:<profile>` and `pnpm --filter @aurora/tauri-ui build:bundle:<profile>` | Dev sidecar behavior remains separate from packaged sidecar staging; default local packaging is unsigned `desktop-local-minimal`. Every `*:thin` bundle command is Python-free desktop-thin. |
| Android capability/artifact contract | `pnpm --filter @aurora/tauri-ui android:preflight:ci` for PRs; `android:verify:thin:apk` and `android:verify:thin:aab` for artifact proof; `android:preflight:strict` for release readiness | PR CI can validate generated Android project/native payload shape and Python-free APK/AAB contents without keystore secrets; strict release readiness requires signing inputs. Local emulator/physical runtime smoke remains separate evidence. |
| iOS capability contract | `pnpm --filter @aurora/tauri-ui ios:policy` on Linux; `tauri ios init`/`tauri ios build`/`ios:preflight` on macOS/Xcode | Linux can only enforce policy copy and manifest baseline. Full iOS build/preflight evidence requires macOS/Xcode. |

The final quality gate must link to the actual logs/screenshots/reports and separate `passed`, `failed`, `blocked`, and `pending external platform` states. Do not mark code-reviewer approval, architect clearance, or ai-slop-cleaner result as complete unless those checks have actually run on the current diff.
