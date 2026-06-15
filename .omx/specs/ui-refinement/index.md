# Aurora UI Refinement Artifact Index and Final Decision Record

Date: 2026-06-10  
Scope: integrated non-code artifact index for the all-in-one Aurora UI planning refinement.  
Status: planning baseline ready for later phase-by-phase task decomposition after quality gate.

## 1. Artifact set

| Artifact | Path | Purpose | Ultragoal story |
|---|---|---|---|
| Runtime decision | `.omx/research/ui-refinement/tauri-runtime-decision.md` | Decides official Tauri 2/Rust shell vs Python-backed Tauri; defines desktop/mobile runtime posture and experiments. | G001 |
| SDK base contract | `.omx/specs/ui-refinement/aurora-ui-sdk-contract.md` | Defines AuroraClient facade, transports, envelopes, events, admin action wrapper, capability graph, security defaults, conformance tests. | G002 |
| UI/UX flows | `.omx/specs/ui-refinement/aurora-ui-ux-flows.md` | Documents all assistant/admin/onboarding/mobile/model/failure flows and visual PoC screen inventory. | G003 |
| Feature graph | `.omx/specs/ui-refinement/feature-service-availability-graph.md` | Maps UI features to services/contracts/permissions/deployment modes/platform/native gaps. | G004 |
| Refinement backlog | `.omx/research/ui-refinement/refinement-backlog.md` | Lists remaining definitions, spikes, backend gaps, UX refinements, and release gates. | G005 |
| Integrated index | `.omx/specs/ui-refinement/index.md` | Ties artifacts together, summarizes decisions and readiness. | G006 |
| Final cleanup/review reports | `.omx/reports/ui-refinement/ai-slop-cleanup-report.md`, `.omx/reports/ui-refinement/final-independent-review.md` | Records docs-only cleanup/no-op status and independent architect/code-reviewer quality gate evidence. | G006 |
| Executed experiment report | `.omx/experiments/ui-refinement/EXPERIMENT_RESULTS.md` | Records local/headless spike outputs for Tauri, sidecar, Python-backed Tauri, SDK/OpenAPI, admin safety, LocalBus, mobile gates, mesh routing, privacy policy, inference surface, and mobile simulator completion. | Post-G006/G007 experiment pass |
| Mobile simulator report | `.omx/experiments/ui-refinement/MOBILE_SIMULATOR_EXPERIMENT_RESULTS.md` | Records Android SDK provisioning, Tauri Android APK build, emulator boot/install, assistant-role command probe, and iOS Linux-host feasibility result. | G007 |
| Visual reference mock | `modules/ui-mock-reference/` | Completed extracted v0 Next/shadcn/Tailwind UI-only mock covering assistant, onboarding, mesh, models/runtime, diagnostics, settings/permissions, and admin/operator dashboard surfaces. | G008 |
| Spec/code/mock audit report | `.omx/reports/ui-refinement/spec-code-mock-audit-report.md` | Code-grounded audit of original spec and mock; records permission, route, admin safety, mesh, mobile and backend-contract gaps. | Post-G008 audit/refinement pass |
| Spec-vs-code coverage matrix | `.omx/specs/ui-refinement/spec-vs-code-coverage-matrix.md` | Row-by-row production task-generation matrix mapping UI promises to backend status, mock status and required backend/UI work. | Post-G008 audit/refinement pass |

Supplemental artifacts from team lanes were reconciled after the OMX team reached terminal status
(`aurora-ui-refined-pla-2b6663ce`: 7/7 completed, 0 failed, then shut down):

- `.omx/research/ui-refinement/team-lanes/mobile-native-feasibility.md` — mobile platform feasibility, Android assistant-role gates, iOS non-replacement integration path, mobile inference candidates, Tauri native plugin implications.
- `.omx/research/ui-refinement/team-lanes/feature-availability-graph.md` — independent feature/service/contract/permission/deployment-mode graph and missing gap review.

## 2. Final accepted decisions

### Decision 1 — Shell/runtime

**Accepted:** Official Tauri 2 with normal Rust core is the production native shell for desktop and mobile.

**Why:** Aurora requires one UI across Linux, Windows, macOS, Android, iOS, server web, local desktop, and P2P mesh. Official Tauri 2 has the official cross-platform/mobile/native plugin path; Python-backed variants are not mature enough as the all-platform shell foundation.

**Fallback:** Use Python sidecar/loopback on desktop local; keep PyTauri/tauri-plugin-python as desktop prototype experiments only.

### Decision 2 — UI boundary

**Accepted:** The UI talks through a transport-independent TypeScript SDK (`AuroraClient`) backed by registry/capability graph and transport adapters.

**Why:** Gateway already exposes service contracts and dynamic HTTP routes; MeshBus abstracts local/remote bus routing; Tauri/native transports can map to the same envelopes. Direct Python service coupling would fragment server/local/mesh/mobile modes.

### Decision 3 — Admin dashboard parity

**Accepted:** Admin/operator dashboard is first-class and shares the same UI/component system as the assistant client.

**Why:** Server deployments require RBAC, peer, services, config, plugin, audit, and diagnostics management. Local and mesh modes need many of the same surfaces, gated by service availability and permissions.

### Decision 4 — Capability-driven UX

**Accepted:** Every feature renders according to capability state (`available`, `degraded`, `needs_permission`, `missing_service`, `unsupported_platform`, etc.) with explanation and repair actions.

**Why:** A distributed assistant cannot assume services, permissions, peers, native roles, or local runtimes are present. Feature gating prevents fragmented mode-specific UI forks.

### Decision 5 — Mobile posture

**Accepted:** Mobile launches as thin client first, then native local-light mode. Full Aurora Python service graph on mobile is not a default product assumption.

**Why:** Existing Python dependency profile is desktop/server-heavy. Android/iOS need native plugin and mobile inference work. The orchestrator semantics can remain stable behind capabilities while runtimes differ.

### Decision 6 — Android assistant integration

**Accepted:** Android can pursue assistant-role integration using official Tauri 2, Kotlin native plugins, and Android manifest/service declarations where the OS exposes `ROLE_ASSISTANT`, the package qualifies, and the user/OEM grants it. Fallback remains app/shortcut/notification/widget/tile/share/deep-link/server/mesh invocation.

**Why:** Tauri can host Kotlin plugin code and native Android package declarations; Android RoleManager/VoiceInteractionService support exists, but role grant remains package-qualification, user-consent, OS/device, and OEM-policy dependent.

**Implementation boundary:** The plugin coordinates capability checks and role requests; Android manifest/service resources qualify the package; Aurora assistant logic still runs through the SDK/capability graph and normal route/privacy policy.

### Decision 7 — iOS assistant integration

**Accepted:** iOS uses App Intents, Shortcuts, widgets, share sheet, deep links, and in-app voice. It must not claim Siri replacement.

**Why:** iOS third-party apps integrate with Siri/Shortcuts/App Intents rather than replacing Siri as system assistant.

### Decision 8 — Admin action safety

**Accepted:** All backend `method_type="manage"` operations go through an admin action draft/confirmation/audit wrapper.

**Why:** RBAC, tokens, devices, peers, config, plugins, and services include high-impact operations. The UI should not expose raw manage calls as plain buttons.

**Backend requirement:** high/critical manage routes must reject direct raw calls unless a backend-verifiable confirmation/audit envelope is present; generated/debug clients cannot bypass the same policy.

### Decision 8b — Canonical privacy taxonomy

**Accepted:** SDK, UI, diagnostics, route policy, feature graph, and future backend metadata use one `PrivacyClass` enum: `public`, `personal`, `sensitive`, `secret`, `raw-audio`, `credential`, and `admin-critical`.

**Why:** Route policy, diagnostics redaction, peer fallback, voice capture, credential handling, and admin confirmation cannot be safely implemented from divergent privacy labels.

### Decision 9 — Visual PoC requirements

**Accepted:** Lovable/AI-generated visual PoC must include assistant and admin dashboard surfaces, feature state fixtures, route/privacy badges, mobile permission flows, and admin confirmation/diff states.

**Why:** A chat-only PoC would miss the hard product problem: unified operational management across modes.


## 2.1 Experiment-driven refinements added after initial planning baseline

**Android Tauri/Kotlin/manifest decision (2026-06-11):** official Tauri 2 is compatible with Android Kotlin plugins and custom Android manifest/service declarations needed for assistant-role qualification. The previous `Package does not qualify` result is reclassified as expected evidence that a plain shell lacks role-qualifying Android components, not evidence against Tauri.

On 2026-06-10, the described spikes were no longer left as purely theoretical gates. The feasible local/headless subset was run and captured under `.omx/experiments/ui-refinement/`. The final task decomposition must incorporate these refinements:

1. SDK method identity is `bus_topic`/`name`; current `MethodInfo` has no `id`.
2. Official Tauri 2 desktop shell passed Linux scaffold/cargo-check; Rust-supervised Python loopback sidecar passed a minimal token/origin hardening probe.
3. PyTauri/tauri-plugin-python remain prototype-only because direct PyTauri import failed without its entrypoint, despite package/crate availability.
4. Gateway RouteGenerator can emit OpenAPI paths/security scopes from current metadata.
5. Backend admin confirmation/preview/audit-envelope enforcement is missing and must precede high/critical mutation UI.
6. LocalBus embedded request/reply works but has a response-shape caveat around top-level `ok`.
7. Android thin-client build/install is runnable on this Linux host after `/tmp` Android SDK/JDK provisioning; Android Kotlin native plugin bridge is proven; Tauri can package custom Android manifest/service declarations for assistant qualification; remaining Android tasks are role-qualified service prototype, visual launch, release/AAB/signing, real-device matrix, and CI storage/KVM. iOS still requires macOS/Xcode/device gates.
8. Privacy/route policy and mesh routing can be made executable test fixtures.
9. Mobile local-light inference needs a new runtime abstraction because current repo has no ExecuTorch/MLC/CoreML/mobile provider layer.

## 3. Practical implementation implications

1. Build SDK/capability graph before screens.
2. Build auth/session and registry ingestion before assistant/admin flows.
3. Build admin read-only dashboard before admin mutations.
4. Build AdminAction wrapper before config/RBAC/token/mesh mutation screens.
5. Build assistant text before voice/wake/streaming complexity.
6. Build desktop local sidecar after HTTP/server SDK path works.
7. Build mobile thin clients before local-light inference.
8. Build native mobile plugins as capability providers, not separate UI forks.
9. Build mesh route preview before allowing sensitive peer fallback.
10. Build diagnostics/redaction before external support/export workflows.

## 4. Source evidence summary

### Aurora repository evidence

- Gateway app dynamically exposes internal bus services through HTTP and OpenAPI: `app/services/gateway/fastapi_app.py:31-46`, `77-99`, `198-299`.
- Route generator creates `/api/{module}/{method}` paths and forwards to bus: `app/services/gateway/route_generator.py:321-341`, `361-388`, `424-432`.
- `MethodInfo` includes exposure, permissions, method type, and schemas: `app/shared/contracts/models/gateway.py:52-65`.
- Auth covers login, pairing, RBAC, tokens, devices, audit, and mesh peers: `app/shared/contracts/models/auth.py:34-95`; implementations in `app/services/auth/service.py:309-390`, `394-538`, `560-735`, `878-985`.
- Config service includes get/set/plugin/validate/reload/update events: `app/shared/contracts/models/config.py:16-28`.
- Supervisor service includes status and service control: `app/shared/contracts/models/supervisor.py:18-56`.
- Gateway starts HTTP/WebRTC/mesh; MeshBus wraps LocalBus/BullMQBus for remote routing: `app/services/gateway/service.py:62-67`, `494-515`, `686-703`; `app/messaging/mesh_bus.py:1-28`, `283-340`.
- Python version/dependency profile is desktop/server-heavy and currently has no Tauri scaffold: `pyproject.toml:38`, `63-127`, `231-270`, `293-319`, `305-319`, `402-408`; root scan found no `package.json`, `tauri.conf.json`, `Cargo.toml`, or Vite config.

### External research evidence

- Tauri 2 targets desktop and mobile with web frontend and Rust core; mobile plugins use Swift/Kotlin integration: https://v2.tauri.app/blog/tauri-20/ and https://v2.tauri.app/develop/plugins/develop-mobile/
- Tauri Android docs expose AndroidManifest editing, and Android Gradle merges app/library manifests into one APK/AAB manifest: https://v2.tauri.app/learn/mobile-multiwindow/ and https://developer.android.com/build/manage-manifests
- Tauri sidecars can embed external binaries for desktop packaging: https://v2.tauri.app/develop/sidecar/
- Tauri plugin/platform catalog includes security/native features and platform support differences: https://v2.tauri.app/plugin/
- PyTauri is independent/community and not official Tauri; tauri-plugin-python documents CPython/PyO3 complexity, especially mobile-target complexity: https://github.com/pytauri/pytauri and https://github.com/marcomq/tauri-plugin-python
- Android assistant role and VoiceInteractionService need OS support/user consent/manifest requirements: https://developer.android.com/reference/android/app/role/RoleManager and https://developer.android.com/reference/android/service/voice/VoiceInteractionService
- Apple App Intents/SiriKit/Shortcuts integration is the appropriate iOS path: https://developer.apple.com/videos/play/wwdc2024/10133/ and https://developer.apple.com/videos/play/wwdc2025/244/
- Mobile inference candidates have credible platform paths but need experiments: ExecuTorch Android/iOS docs, MLC LLM Android/iOS docs, ONNX Runtime mobile docs, llama.cpp repository.

## 5. Known unresolved questions intentionally deferred to spikes

1. Exact frontend framework/design system choice.
2. Exact OpenAPI generator choice.
3. First event streaming implementation.
4. Exact desktop Python sidecar packaging method.
5. Native mobile inference default runtime.
6. Android assistant role qualification on target devices.
7. iOS App Intent set and App Store policy risk.
8. Model catalog/licensing/download strategy.
9. Diagnostics/log export API.
10. Backup/restore API.
11. Permission template schema.
12. Config diff/rollback backend support.
13. Tool risk taxonomy.
14. Mesh TURN/STUN/signaling UX and operational requirements.

These are not blockers for the next planning phase; they are named spikes with acceptance criteria in the backlog.

## 6. Readiness for later phase/task decomposition

The next session can turn these artifacts into detailed multica/task-board work packages. The task decomposition should use this order:

1. Contract and SDK foundation.
2. Capability graph fixtures.
3. Auth/pairing/session UX.
4. Admin read-only dashboard.
5. Assistant text flow.
6. Admin action framework.
7. RBAC/token/device/config/mesh admin mutations.
8. Event streaming and voice.
9. Desktop Tauri sidecar/local node.
10. Desktop packaging/signing/updater.
11. Mobile thin client.
12. Android native plugin + assistant manifest/service qualification lane.
12. Native mobile integrations.
13. Mobile local-light inference.
14. Diagnostics/backup/hardening.
15. Visual QA/accessibility/performance/security gates.

## 7. Completion criteria for this artifact set

- Required artifacts exist and are cross-linked.
- Runtime decision is no longer an open spike; it has an accepted default and fallback posture.
- SDK contract has enough detail to drive implementation tasks.
- UI/UX flows cover assistant and admin/operator surfaces across deployment modes.
- Feature graph exposes service/module/mode availability and backend gaps.
- Backlog names unresolved work as spikes with acceptance criteria.
- Team supplemental evidence is monitored and integrated where available.
- Final quality gate records verification and independent review status.


### Mobile simulator completion (G007, 2026-06-10)

Additional evidence after the initial refinement plan:

- `.omx/experiments/ui-refinement/MOBILE_SIMULATOR_EXPERIMENT_RESULTS.md` is the canonical mobile spike result.
- Android Tauri thin-client and Kotlin plugin path is now smoke-proven: SDK/JDK provisioned, Android init passed, x86_64 split debug APK built, Android 15 ATD booted without KVM, APK installed, package/process observed, and `NativeCapabilityPlugin.getNativeCapabilityStatus` ran through Tauri `PluginHandle.run_mobile_plugin_async`.
- Android assistant role remains gated: the basic Tauri app cannot become `ROLE_ASSISTANT` without native manifest/service qualification.
- iOS remains macOS/Xcode-gated; Linux cannot run iOS simulator or Tauri iOS commands.

This should be reflected in the later Multica/task-board decomposition: Android shell/build tasks can start earlier than Android assistant/VIS/native inference tasks, while iOS starts with macOS CI/toolchain setup.


### Android native plugin completion (2026-06-11)

Additional emulator-backed evidence after G007:

- `.omx/experiments/ui-refinement/logs/142-rust-startup-plugin-compact-evidence.txt` is the compact proof log.
- Official Tauri 2 Rust registered a Kotlin `@TauriPlugin` and invoked `getNativeCapabilityStatus` through `PluginHandle.run_mobile_plugin_async`.
- The Kotlin payload proved native plugin load, Android device metadata, permission state, and assistant-role query state.
- `ROLE_ASSISTANT` was available but not held; `cmd role add-role-holder` failed with package-not-qualified evidence.
- The no-KVM ATD WebView renderer crashed after native proof, so future frontend visual smoke must run on KVM-enabled emulator and physical devices.

Final decision adjustment: Android native plugin capability provider work can move from feasibility spike to implementation planning. Android assistant-role qualification, stable WebView visual smoke, release signing/AAB, iOS Swift plugin proof, and mobile inference remain gated tasks.

- Verification addendum: `.omx/experiments/ui-refinement/logs/148-fresh-tauri-android-manifest-doc-verification.txt` confirms official Tauri Kotlin plugin docs, Tauri AndroidManifest editing docs, and Android Gradle manifest merge docs were reachable on 2026-06-11.

### Visual reference mock completion (G008, 2026-06-14)

The v0-provided mock zip at `modules/ui-para-assistente-ai.zip` was extracted and completed into `modules/ui-mock-reference/` as a UI-only reference app. Added coverage includes onboarding, mesh peers, models/runtime, diagnostics, settings/permissions, admin tokens, admin devices, contracts, plugins, pairing, backups, and a stronger assistant route/privacy guard.

Verification evidence:

- `pnpm exec tsc --noEmit` passed in `modules/ui-para-assistente-ai`.
- `pnpm build` passed and prerendered 21 app routes including all admin/operator and assistant support routes.
- `pnpm lint` remains unavailable because the inherited v0 package declares `eslint .` without adding an eslint dependency/config.

Implementation boundary remains unchanged: this mock is a visual/reference artifact, not the production Tauri/Gateway/SDK integration.



## 7. Production-readiness refinements from 2026-06-14 code audit

The UI plan is now constrained by the actual backend contract model instead of the visual mock alone. Future implementation tasks must preserve these refinements:

1. **Backend-canonical permissions:** UI fixtures, RBAC screens, token scopes and SDK calls use backend permission IDs such as `Auth.manage`, `Tooling.use`, `Config.manage`, `Supervisor.manage`, `Orchestrator.use` and wildcard `*`. Friendly labels are display-only.
2. **Method-call gateway model:** generated Gateway routes are POST method calls derived from `MethodInfo`; the SDK exposes `client.call(methodId, payload)` semantics rather than REST CRUD assumptions.
3. **MethodInfo-first contract model:** SDK/mock metadata uses `bus_topic`, `name`, `exposure`, `method_type`, `required_perms`, `input_schema` and `output_schema` first, then derives UI categories.
4. **Gateway built-ins:** `/api/registry`, `/api/services`, `/api/routes`, health endpoints and `/api/admin/peers` are gateway-native endpoints and must be modeled separately from generated contract routes.
5. **Session/error normalization:** Auth/session and contract-level `ErrorResponse` handling must be centralized in the SDK before protected UI wiring.
6. **AdminAction is backend work:** confirmation dialogs are not enough. Production mutation tasks require backend draft/preview/confirm/audit enforcement with nonce, payload digest, reason and audit receipt.
7. **Internal-only and missing-contract visibility:** Tauri local/internal bus capabilities, HTTP-generated routes, mesh route support, native-mobile capabilities and missing backend contracts must be rendered distinctly in the capability graph.
8. **Peer state separation:** persisted Auth mesh peers, live Gateway/WebRTC connected peers, route candidates, peer manifests and diagnostics are separate models.
9. **Mock role:** `modules/ui-mock-reference` is a visual/reference fixture app, now updated with backend coverage states and canonical permission/method fixtures; it is not production wiring.
10. **Task-generation rule:** every future card must link to `.omx/specs/ui-refinement/spec-vs-code-coverage-matrix.md` and declare backend route/contract work, SDK work, UI work, permissions, privacy class and verification.
