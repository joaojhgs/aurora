# Aurora All-in-One UI/UX Flow Specification

Date: 2026-06-10  
Scope: detailed non-code UX specification for the future Aurora web/Tauri/mobile UI and visual PoC.  
Status: accepted planning baseline; visuals and implementation are future work.

## 1. Product frame

Aurora UI is one product with two equal top-level jobs:

1. **Private AI assistant client** across local, server, and P2P transports.
2. **Admin/operator dashboard** for deployment management, RBAC, services, peers, configuration, plugins, audit, and diagnostics.

The same UI surfaces exist across modes, but individual actions are gated by capability, role, platform, and transport. The product should feel like a cockpit for a distributed private assistant, not a chat app bolted to a sysadmin panel.

## 2. Universal navigation model

### 2.1 Top-level app areas

1. **Assistant** — chat, voice, session timeline, route/privacy controls, attachments/context, quick actions.
2. **Memory & Knowledge** — conversation history, RAG collections, local/private memory, import/export, retention policy.
3. **Tools & Automations** — tool registry, MCP status, scheduler/cron jobs, automation recipes, tool execution logs.
4. **Mesh & Peers** — pairing, peer trust, route policies, peer health, permissions, mesh diagnostics.
5. **Admin** — services, config, RBAC, tokens, devices, plugins, audit, backups, deployment mode.
6. **Models & Runtime** — local/remote model providers, mobile runtime, downloads, hardware acceleration, benchmark results.
7. **Diagnostics** — logs, health, event stream, route traces, crash/sidecar reports, redacted export.
8. **Settings** — user preferences, privacy defaults, theme, voice, notifications, native permissions.

On small/mobile layouts, these collapse into:

- bottom tabs: Assistant, Activity, Mesh, Admin, Settings;
- assistant quick access floating button;
- admin sections behind role/capability gate.

### 2.2 Persistent global elements

- **Mode badge:** Server, Desktop Local, Desktop Thin, Mesh, Android, iOS, Offline, Hybrid.
- **Route badge:** Local, Remote, Mesh Peer, Native Mobile, Fallback, Unknown.
- **Privacy badge:** Local-only, Remote allowed, Mesh allowed, Sensitive blocked, Secret local-only.
- **Identity badge:** Anonymous, Pairing, User, Admin, Mesh peer, Expired.
- **Health badge:** Healthy, Degraded, Offline, Starting, Needs attention.
- **Capability explanation drawer:** every disabled/degraded action exposes why and how to fix.
- **Event/activity rail:** recent assistant responses, service updates, peer joins, config changes, warnings.

## 3. Visual design principles for future PoC

1. **Confidence through observability:** users always know where work is running and why.
2. **Local-first clarity:** local/private path is visually primary; remote/mesh fallback is explicit.
3. **Admin safety:** dangerous actions require preview, diff, confirmation, and audit reason.
4. **Progressive complexity:** assistant use is simple; power/admin detail is one panel away.
5. **Capability-aware surfaces:** unavailable features remain visible with explanation, not hidden.
6. **Multi-device continuity:** mobile and desktop share mental model but respect platform limits.
7. **Operator-grade density:** admin dashboard can show dense tables/graphs without compromising assistant simplicity.
8. **Accessibility:** keyboard, screen reader, high contrast, reduced motion, and voice fallback from the start.

## 4. Personas and primary intents

| Persona | Primary intents | Critical UX needs |
|---|---|---|
| Personal local user | private voice/chat assistant, offline models, local automations | simple setup, privacy confidence, model/device guidance |
| Server admin | deploy/manage services, RBAC, tokens, config, audit | dense status, safe mutations, rollback, logs |
| Mesh participant | pair devices, route tasks, trust peers | clear peer trust, route preview, revoke/permissions |
| Mobile user | invoke assistant anywhere, use share/intents, light local inference | OS permission clarity, no false Siri promises, low battery/thermal impact |
| Developer/operator | debug gateway/contracts, inspect events/routes | raw registry explorer, traces, diagnostics export |
| Family/team admin | create accounts/devices, limited permissions | understandable RBAC, pairing approval, audit trail |

## 5. Onboarding flows

### Flow O1 — First launch mode selection

Entry: app opened with no saved profile.

Steps:

1. Show welcome: “Run Aurora where?”
2. Choices:
   - Connect to a server.
   - Run locally on this desktop.
   - Join a P2P mesh.
   - Try demo/mock mode.
3. Explain privacy/performance tradeoffs for each.
4. Run environment probe:
   - browser can only server/mesh/demo;
   - desktop Tauri can server/local/mesh/demo;
   - Android/iOS can server/mesh/local-light/demo.
5. User picks mode.
6. UI creates profile with mode badge and next-step checklist.

Success states:

- profile created;
- transport initialized;
- registry/capability graph loads or gives repair steps.

Error states:

- server unreachable;
- unsupported local runtime on platform;
- mesh unavailable;
- permissions denied.

### Flow O2 — Connect to server deployment

1. Enter server URL or scan QR/deep link.
2. Fetch `/api/health` and `/api/registry` where available.
3. Show server identity/fingerprint/TLS state.
4. Choose auth:
   - username/password login;
   - API token;
   - pairing code.
5. Fetch `WhoAmI` and effective permissions.
6. Build capability graph.
7. Land on Assistant with admin banner if admin permissions exist.

Admin-specific additions:

- If user is admin, prompt to review service health and security posture.
- If auth is disabled or permissive CORS/default keys are detected, show hard warning.

### Flow O3 — Desktop local/offline setup

1. Check bundled Aurora node/sidecar installed.
2. Choose data directory.
3. Choose privacy default:
   - local-only strict;
   - local-first with remote fallback;
   - hybrid mesh allowed.
4. Start local Python node in thread mode.
5. Show boot timeline:
   - Python environment check;
   - config load;
   - bus start;
   - services register;
   - gateway/loopback health;
   - model/runtime availability.
6. If no model exists, show model setup wizard.
7. If audio desired, request microphone/speaker permissions.
8. Build capability graph from local registry.
9. Land on Assistant.

Failure branches:

- sidecar missing/corrupt -> repair/reinstall path;
- port conflict -> choose new port or IPC;
- config invalid -> config repair wizard;
- model missing -> text-only/local-disabled mode;
- service failed -> diagnostics + retry service.

### Flow O4 — P2P mesh-only shell setup

1. Choose Join Mesh.
2. Generate or load local mesh identity.
3. Discover or enter peer invitation.
4. Show peer name/fingerprint/capability preview if available.
5. Start pairing request.
6. Wait for peer admin approval.
7. Show granted permissions and available remote services.
8. Select route defaults:
   - use peer only when explicitly selected;
   - prefer peer for model tasks;
   - prefer peer for all assistant tasks;
   - never send sensitive data without prompt.
9. Land on Assistant with Mesh route badge.

Failure branches:

- no WebRTC support/network blocked;
- pairing code expired;
- peer denied;
- peer permissions insufficient;
- route test failed.

### Flow O5 — Android first launch

1. Mode selection: Server, Mesh, Local-light, Demo.
2. Explain Android local-light means native mobile capabilities/inference, not full desktop Python stack.
3. Request permissions only when needed:
   - microphone for voice;
   - notifications for background/status;
   - assistant role if user opts into “Use Aurora as Android assistant” and role is available;
   - battery optimization exemption only after explaining impact.
4. If assistant role selected:
   - query the Tauri Kotlin native capability plugin for plugin-loaded state, manifest/service qualification signals, `RoleManager.isRoleAvailable(ROLE_ASSISTANT)`, and current held state;
   - if the package is not qualified, show a developer/beta message and hide the user role request action in release builds;
   - if qualified and requestable, request role via Android system consent;
   - if denied, blocked by OEM/policy, or unavailable, continue with app/shortcut/notification/widget/tile/share invocation.
5. Configure server/mesh/local-light transport.
6. Land on mobile Assistant.

### Flow O6 — iOS first launch

1. Mode selection: Server, Mesh, Local-light, Demo.
2. Explicitly state: iOS cannot replace Siri; Aurora integrates through app, Shortcuts, Share Sheet, widgets, deep links, and App Intents where supported.
3. Request permissions just-in-time:
   - microphone;
   - speech recognition if required by native path;
   - notifications;
   - local network/Bonjour if used;
   - files/photos only when importing context.
4. Offer setup actions:
   - Add Aurora Shortcut;
   - Enable widgets/live activities if supported;
   - Configure Share Sheet action;
   - Enable App Intents actions.
5. Configure transport.
6. Land on mobile Assistant.

## 6. Assistant flows

### Flow A1 — Text assistant query

1. User enters prompt.
2. Composer shows route/privacy default.
3. User may click route badge to choose local/server/peer/native.
4. Capability graph validates `assistant.chat.text`.
5. Send through `client.assistant.sendText`.
6. UI shows:
   - queued/routing;
   - model/provider selected;
   - tool calls pending;
   - streaming response if available;
   - final response with citations/tool results.
7. User can follow up, copy, save to memory, run tool, or inspect trace.

Failure states:

- orchestrator unavailable -> choose peer/server or text-only offline note;
- missing permission -> login/pair/request permission;
- remote blocked by privacy -> prompt route override;
- timeout -> retry/local fallback.

### Flow A2 — Voice push-to-talk

1. User taps microphone.
2. UI checks microphone/native audio capability.
3. If not granted, permission explainer appears.
4. Start STT listening.
5. Show waveform, partial transcript, route badge.
6. User releases/taps stop.
7. Final transcript sent to orchestrator.
8. TTS response starts if available; text shown regardless.
9. User can interrupt TTS.

Degraded states:

- STT missing -> record/send audio to remote only if allowed; otherwise use text;
- TTS missing -> text-only response;
- wakeword missing -> push-to-talk only.

### Flow A3 — Always-available/wake mode desktop

1. User enables wake mode from settings.
2. UI shows privacy warning and local/remote handling policy.
3. Wakeword service availability checked.
4. Request OS mic/autostart permissions where needed.
5. Background indicator appears in tray/menu/status.
6. On wake detection, overlay opens compact assistant.
7. User can respond or cancel.
8. Activity logged locally; raw audio retention follows privacy setting.

### Flow A4 — Android assistant invocation

1. User invokes Aurora through app icon, notification, tile, shortcut, widget, share sheet, deep link, or assistant role if granted.
2. If launched through assistant role, Android enters Aurora through the native manifest-declared assistant component; the Tauri Kotlin plugin/session bridge opens or resumes the capture UI.
3. Lightweight `VoiceInteractionService`/session code must only collect the OS invocation context and hand off to Aurora UI/SDK; heavy inference/service routing stays behind normal Aurora transports/capability policy.
4. UI shows what context is available and asks before sending screen/share context.
5. Query routes per policy.
6. Result appears as assistant session; can continue in full app.

Fallback if role unavailable, denied, blocked, or package not qualified: app shortcut, notification action, widget, tile, share sheet, deep link, server route, or mesh route.

### Flow A5 — iOS system invocation

1. User invokes Aurora via app, widget, Shortcut, Share Sheet, URL/deep link, or App Intent.
2. If invoked through Siri/Shortcuts, the intent receives structured input and opens/resumes Aurora if needed.
3. UI shows “Invoked by Shortcut/Siri” but does not claim default assistant status.
4. Query routes per policy.
5. Result can return to Shortcuts if intent supports it, or open app session.

### Flow A6 — Route preview and override

Entry: any assistant action with non-local route or sensitive data.

1. User opens route badge.
2. Sheet shows candidate routes:
   - Local node/model;
   - Server gateway;
   - Peer(s) with trust/perms/latency;
   - Native mobile model.
3. Each route shows privacy class, expected capability, model/provider, cost, latency, audit implications.
4. User selects route or policy.
5. UI records preference with scope: one request, session, feature, global.
6. Sensitive/secret route changes require confirmation.

### Flow A7 — Tool call approval

1. Assistant proposes a tool/action.
2. If tool is harmless/read-only and permission allows, execute automatically per setting.
3. If tool is mutating/external/admin, show action preview:
   - tool name;
   - inputs;
   - target service;
   - data leaving device;
   - expected effects.
4. User approves/denies/edits.
5. Result flows back to assistant.
6. Audit if supported.

### Flow A8 — Conversation history and memory

1. User opens History/Memory.
2. UI lists sessions with route/model badges and privacy class.
3. User can search, pin, delete, summarize, export, or add to knowledge.
4. Retention controls show where memory lives: local DB/server/peer.
5. Delete action previews affected DB/RAG records.

## 7. Admin/operator dashboard flows

### Flow D1 — Dashboard overview

1. Admin opens Admin.
2. Overview shows:
   - deployment mode;
   - service count/health;
   - gateway status;
   - auth status;
   - mesh peers;
   - model runtime status;
   - config drift/updates;
   - recent audit events;
   - critical warnings.
3. Clicking any card opens detail.
4. Non-admin sees read-only/permission explanation or pairing request path.

### Flow D2 — Service registry and health

1. Open Admin → Services.
2. Table columns:
   - module;
   - status;
   - instance id;
   - capabilities;
   - method count;
   - last heartbeat;
   - route availability;
   - health checks.
3. Detail drawer shows methods with exposure, required permissions, schemas, OpenAPI path, last errors.
4. Admin can request health check.
5. If Supervisor controls are available, admin can start/stop/restart with confirmation.
6. Service action shows impact preview: dependent features affected.

### Flow D3 — Contract/method explorer

1. Open Admin → Contracts.
2. Search/filter by module, exposure, method type, permission.
3. Method detail shows input/output schema and examples.
4. Authorized users can run a safe test invocation in a sandbox console.
5. Manage methods require admin confirmation; destructive payloads require typed phrase.
6. Results are redacted if sensitive.

### Flow D4 — RBAC principal management

1. Open Admin → Access → Principals.
2. List users/devices/principals with admin flag, permissions, created/last active.
3. Create principal flow:
   - username/device name;
   - password/token policy;
   - permission template;
   - review;
   - confirm.
4. Edit principal flow:
   - show current permissions;
   - permission builder groups by service/feature;
   - diff preview;
   - confirm;
   - audit reason.
5. Delete principal flow:
   - show cascade: devices/tokens/mesh peers;
   - typed confirmation;
   - audit reason.

### Flow D5 — Token management

1. Open Admin → Access → Tokens.
2. List tokens with prefix only, principal/device, scopes, created, expiration.
3. Create token:
   - choose principal/device;
   - select scopes from permission templates;
   - expiration;
   - one-time token reveal;
   - copy/download securely.
4. Update token scopes:
   - diff permissions;
   - confirmation.
5. Revoke token:
   - show active sessions/peers affected;
   - confirmation;
   - audit.

### Flow D6 — Device management

1. Open Admin → Access → Devices.
2. List paired devices, trust status, user, last seen, source.
3. Device detail shows tokens, permissions, audit activity.
4. Delete/revoke device:
   - show tokens and peer links affected;
   - confirmation;
   - audit.

### Flow D7 — Pairing approval

1. User/device starts pairing and shows code.
2. Admin receives pending pairing notification.
3. Admin opens Pairing queue.
4. Pairing detail shows device name, IP/peer id, requested capabilities, expiration.
5. Admin chooses permission template and admin flag.
6. Confirm approval.
7. Pairing device receives token.
8. Audit event logged.

Failure states:

- code expired;
- device duplicates existing name;
- permission template invalid;
- audit service unavailable.

### Flow D8 — Mesh peer management

1. Open Mesh & Peers.
2. Graph view shows local node, approved peers, pending peers, denied peers, route quality.
3. Peer detail shows identity, fingerprint, permissions, capabilities, last seen, token link, route policies.
4. Approve peer:
   - verify fingerprint;
   - choose permissions;
   - route defaults;
   - confirm.
5. Update peer permissions:
   - permission diff;
   - impacted UI features;
   - confirm.
6. Remove peer:
   - optional revoke token;
   - route impact;
   - confirm.
7. Diagnostics tab shows connection tests, ICE/WebRTC status, latency, last errors.

### Flow D9 — Configuration management

1. Open Admin → Configuration.
2. Config tree generated from schema/keys where possible.
3. Sections: services, gateway, auth, mesh, models, audio, UI, plugins.
4. Click setting -> detail with description, current value, source (config.json/env/default), effective value.
5. Edit value in typed control.
6. Run validation.
7. Show diff and affected services.
8. Confirm apply.
9. Config.Updated event appears; affected services reload or show restart required.
10. Offer rollback from previous value.

Guardrails:

- secrets are masked;
- env-overridden values are read-only with explanation;
- invalid config cannot be applied unless explicitly supported as draft only.

### Flow D10 — Plugin management

1. Open Admin → Plugins.
2. List plugins with enabled state, config, capabilities, errors.
3. Plugin detail shows service/tool methods added, required secrets/permissions, health.
4. Enable/disable/edit config:
   - validate;
   - diff;
   - confirm;
   - reload affected service.
5. Plugin install/update is future high-risk flow and should require explicit trust model and signing decision.

### Flow D11 — Audit log

1. Open Admin → Audit.
2. Filter by principal, device, event, date, resource, severity.
3. Event detail shows action, actor, affected resources, route/peer, redacted payload, result.
4. Export requires admin confirmation and redaction choices.
5. If audit backend missing, dashboard shows high-priority security gap.

### Flow D12 — Diagnostics export

1. Open Diagnostics.
2. Select export bundle contents:
   - service health;
   - registry;
   - recent logs;
   - route traces;
   - config redacted;
   - client environment;
   - sidecar logs;
   - crash reports.
3. Redaction preview shows excluded secrets/audio/raw prompts.
4. User confirms export.
5. Bundle saved locally or sent to admin server if configured.

## 8. Models and runtime flows

### Flow M1 — Desktop local model setup

1. UI detects no model runtime ready.
2. Wizard asks goals: privacy, speed, quality, hardware.
3. Hardware probe: CPU, RAM, GPU, CUDA/ROCm/Metal support if available.
4. Recommended models list with size/license/performance.
5. Download/import model.
6. Verify hash/license.
7. Configure provider: llama.cpp, llama-server, vLLM, OpenAI-compatible, etc.
8. Run smoke prompt.
9. Add to capability graph.

### Flow M2 — Mobile local-light model setup

1. UI explains mobile local-light constraints: smaller models, battery/thermal, storage.
2. Detect runtime candidates: ExecuTorch, MLC LLM, ONNX Runtime, native OS models if supported later.
3. Recommend small model profile.
4. Download/bundle/import.
5. Run benchmark.
6. Set fallback route to server/mesh for heavy tasks.

### Flow M3 — Model route policy

1. Open Models & Runtime → Routing.
2. Define policies by feature/privacy:
   - chat local first;
   - summarization local unless long context;
   - coding remote allowed;
   - secrets local only;
   - image/vision remote allowed only with prompt.
3. Save policy.
4. Assistant route badge reflects policy.

## 9. Mobile-native flows

### Flow N1 — Native permissions center

1. Open Settings → Device Permissions.
2. List permission cards:
   - microphone;
   - speech recognition;
   - notifications;
   - local network;
   - files/photos;
   - location if tools need it;
   - biometrics;
   - Android assistant role;
   - Android assistant package qualification/manifest-service status for beta/dev builds;
   - battery optimization.
3. Each card shows state, why Aurora needs it, feature impact, request/open settings button.
4. Android assistant role card separates “Tauri native plugin loaded”, “package qualified”, “role available”, “role held”, “requestable”, and “fallback only” states.
5. Permission result recomputes capability graph.

### Flow N2 — Share Sheet / intent ingestion

1. User shares text/file/url/image to Aurora.
2. UI opens compact intake sheet.
3. Choose action: ask, summarize, store to memory, send to tool, schedule reminder.
4. Show privacy/route selection.
5. Execute and return result.

### Flow N3 — Widgets/quick actions

1. User adds widget/quick action.
2. Configure action: voice note, ask Aurora, summarize clipboard, route to peer, start automation.
3. Widget invokes predefined flow with minimal UI.
4. If auth expired or route unavailable, opens app with repair action.

## 10. Failure and recovery flows

### Flow F1 — Capability missing

1. User taps disabled feature.
2. Explanation drawer opens.
3. Shows missing service/permission/platform/transport.
4. Offers repair actions in order:
   - login;
   - pair device;
   - request OS permission;
   - start local service;
   - choose peer/server;
   - install/enable plugin;
   - open docs/diagnostics.

### Flow F2 — Service unhealthy

1. Health badge turns degraded.
2. Activity rail logs service issue.
3. User opens service detail.
4. If restart available, show impact preview and confirmation.
5. If not, show logs and suggested diagnostics export.

### Flow F3 — Transport lost mid-request

1. Request card shows lost route.
2. If fallback allowed, show “retry via X?” with privacy warning.
3. If local fallback exists, retry local.
4. If no route, preserve prompt/draft and notify user.

### Flow F4 — Auth expired

1. Identity badge changes to expired.
2. Mutations disabled; reads may remain cached/read-only.
3. Login/refresh prompt opens.
4. After success, replay safe pending reads; ask before replaying mutations.

### Flow F5 — Admin mutation conflict

1. Backend returns conflict/version mismatch.
2. UI fetches latest resource.
3. Shows side-by-side diff.
4. Admin can reapply, merge, or cancel.

### Flow F6 — Privacy policy blocks route

1. User tries action requiring remote/mesh route with sensitive data.
2. UI blocks with privacy explainer.
3. Options:
   - use local degraded mode;
   - redact/summarize before send;
   - one-time remote override;
   - change policy.
4. Overrides require confirmation and audit if admin-managed.

## 11. Screen inventory for visual PoC

### Assistant screens

- Assistant home, empty state.
- Text conversation with streaming response.
- Voice capture active.
- Tool approval modal.
- Route/privacy selection sheet.
- Conversation history and memory detail.
- Offline/degraded assistant state.

### Admin screens

- Admin overview dashboard.
- Services table and method drawer.
- Contract explorer.
- RBAC principals list/detail/edit permissions.
- Tokens list/create/revoke.
- Devices list/detail/delete.
- Pairing approval queue.
- Mesh graph and peer detail.
- Configuration tree/editor/diff/validation.
- Plugins list/detail/config.
- Audit log filters/detail/export.
- Diagnostics export wizard.

### Runtime/mobile screens

- First launch mode selection.
- Desktop local sidecar boot timeline.
- Model setup wizard.
- Mobile permissions center.
- Android assistant role flow.
- iOS Shortcuts/App Intents setup.
- Share sheet intake.
- Peer pairing QR/code flow.

### Global components

- Mode badge.
- Route/privacy badge.
- Capability state badge.
- Health badge.
- Identity badge.
- Capability explanation drawer.
- Admin action confirmation modal.
- Diff viewer.
- Event/activity rail.
- Service/peer/model status cards.
- Redaction preview component.

## 12. Feature gating UX rules

1. Never hide admin navigation solely because a user lacks permission; show locked/read-only if they can learn/repair.
2. Hide truly unsupported native platform features only in compact navigation, but expose them in capability explorer.
3. Assistant primary action must always offer the best available path: text-only if voice is unavailable, local degraded if remote blocked.
4. Every remote/mesh route for personal/sensitive/secret data must be visible before execution.
5. Every manage/admin mutation requires review+confirm.
6. Every feature state transition should create a small activity event for observability.

## 13. UX readiness checklist for later implementation tasks

- Capability graph fixtures exist for every mode.
- All major states have visual designs: empty, loading, available, degraded, locked, error.
- Admin mutations have confirmation variants by severity.
- Mobile permission denial flows are designed before native work starts.
- Route/privacy badges are visible in assistant and admin flows.
- Lovable/visual PoC includes both assistant and admin dashboard surfaces.
- PoC includes at least one narrow-screen/mobile layout for every top-level area.
- Accessibility pass includes keyboard navigation, labels, focus order, contrast, reduced motion.
