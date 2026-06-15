# Aurora UI Spec-vs-Code Coverage Matrix

Date: 2026-06-14  
Purpose: production task-generation source for mapping UI promises to current backend support, mock coverage, and required backend/frontend work.  
Status: planning artifact; not implementation code.

## Legend

Backend status:

- `implemented`: current backend route/contract/service support exists for the core operation.
- `partial`: some backend support exists, but production semantics are incomplete.
- `internal_only`: backend operation exists but is not exposed through generated HTTP routes; usable only through local/Tauri/internal paths unless explicitly bridged.
- `missing_contract`: required backend/API contract does not exist yet.
- `planned`: product/spec requirement not yet backed by code.
- `mock_only`: only represented in UI fixtures.

Mock status:

- `covered`: meaningful visual/state reference exists.
- `partial`: some visual coverage exists but key states are missing.
- `missing`: no useful mock coverage yet.

## Matrix

| ID | Area | UI promise | Current backend status | Mock status | Required backend work | Required UI/SDK/mock work | Task-generation note |
|---|---|---|---|---|---|---|---|
| `sdk.transport.client` | SDK | One `AuroraClient` across HTTP, Tauri local, mesh, native mobile and mock | partial | partial | Keep Gateway registry/OpenAPI stable; add event stream; add capability manifest or SDK-computed equivalent | SDK core, normalized result envelope, transport adapters, generated type ingestion | First implementation cluster. Do not wire screens directly to fetch/IPC. |
| `gateway.method_exposure_matrix` | SDK/Admin | Contract explorer and feature gating know method exposure, method type and required perms | implemented | partial | Document gateway built-ins separately from dynamic routes; smoke-test generated route casing | Use `MethodInfo` fields directly; display `internal/external/both/gateway_builtin/planned` | Blocks accurate capability graph and contracts page. |
| `auth.session.state_machine` | Auth | UI recovers from anonymous, pairing, user, admin, expired, API-key/SYSTEM, 401 and 403 states | partial | partial | Smoke-test public auth bypass path casing; normalize payload errors vs HTTP errors | AuthSession state machine and visuals for expired/denied/revoked sessions | Must precede all protected surfaces. |
| `permissions.catalog` | RBAC | Friendly permission UI backed by canonical backend IDs | implemented | partial | Optionally expose grouped permission metadata from backend | Use backend IDs such as `Auth.manage`, `Tooling.use`, `Config.manage`, `*` | Required before RBAC/token task cards. |
| `admin.action.envelope` | Admin safety | High-risk manage calls require server draft/confirm/audit envelope | missing_contract | partial | Add AdminAction draft/preview/confirm APIs; enforce nonce/digest/reason/audit receipt; block raw high-risk bypass | Keep dialog fields; wire to server challenge; handle reauth/two-admin modes | Blocks production config/RBAC/token/peer/service mutations. |
| `assistant.chat.text` | Assistant | Text prompt through gateway/local/mesh/native transport | implemented | covered | Stabilize Orchestrator external input route and response shape | SDK `assistant.sendMessage`; loading/error/route states | First assistant screen wiring task. |
| `assistant.chat.streaming` | Assistant | Streaming tokens/events, reconnect and fallback | missing_contract | partial | Unified event stream over HTTP/Tauri/mesh; event envelope | Streaming, retry, transport-lost and full-message fallback states | Do after basic text invocation. |
| `assistant.interrupt` | Assistant | Stop generation/TTS/tool run | missing_contract | partial | Orchestrator cancellation contract; possibly TTS stop bridge for local playback | Interrupt/cancel button states and disabled explanations | Prevent fake stop button. |
| `assistant.route.preview` | Assistant/Privacy | Route/privacy sheet previews local/remote/mesh/native target and policy | partial | covered | Optional backend route explain endpoint; peer manifests; policy persistence | Redacted payload preview, target, reason, audit placeholder, one-request/session/global scope | SDK can compute v1; backend explain can follow. |
| `assistant.tool.approval` | Assistant/Tools | Tool calls show risk, inputs, route, privacy and approval policy | partial | partial | Tool risk taxonomy/approval hints; tool schema metadata; audit tool decisions | Tool schema viewer, validation, approve/deny reason, result display | Required before enabling tool execution in production UI. |
| `assistant.attachments` | Assistant | Attach files/context/URLs/photos/share data | missing_contract | partial | Attachment/context ingestion contract; upload limits; privacy classification; native share intake | Attachment picker states and route policy | Planned backend route cluster. |
| `assistant.history` | Memory | Conversation/history read, privacy display and delete/export states | partial | partial | Confirm DB method exposure/RBAC; delete/export contracts | History screen, delete preview, source provenance | Separate read support from mutation support. |
| `assistant.memory.rag` | Memory | RAG search/collections/provenance | partial | partial | Collection CRUD, retention, deletion, ingestion route contracts if needed | RAG collection/search/delete UX | Mobile local vector DB remains future. |
| `voice.audio.mode_matrix` | Voice/Native | PTT, wake, transcription and TTS work per mode/platform | partial | partial | Clarify exposed transcription/synthesis vs internal listen/playback; native audio bridge contracts | Split local capture, remote transcription, local playback, wake/background permissions | Prevent server-web/local-device confusion. |
| `admin.overview` | Admin | Deployment/service/capability posture dashboard | implemented | covered | Capability manifest endpoint optional | Use gateway services/routes plus SDK capability graph | Early admin read-only task. |
| `admin.services.list` | Admin | Service table with health, methods and exposure | implemented | covered | Normalize service health response shape | Show bus topic, route path, backend coverage, dependencies | Mock updated with backend coverage. |
| `admin.services.control` | Admin | Restart/start/stop service controls with impact preview | partial | partial | Implement/verify restart; add start/stop or mark unsupported; AdminAction enforcement | Disable missing controls; show local/internal/planned states | Do not expose stop/start as fully supported today. |
| `admin.contracts.explorer` | Admin/SDK | Explore registry/OpenAPI, schemas, safe test invoke | implemented | covered | Schema/example completeness; test-invoke guard for manage methods | Method search, schema panel, safe invoke preview | Build after SDK registry ingestion. |
| `admin.rbac.principals` | Admin/RBAC | Principal CRUD, effective permissions, cascade previews | implemented | partial | Confirm all Auth principal methods exposed as intended; AdminAction envelope | Create/edit/delete flows and effective permission diff | Requires canonical permission catalog. |
| `admin.tokens` | Admin/RBAC | Token create/list/scope update/revoke with one-time reveal | implemented | partial | AdminAction envelope; one-time reveal semantics verified | Staged create wizard, scope picker, revoke impact sessions | Must handle credential privacy class. |
| `admin.devices` | Admin/RBAC | Device list/delete/trust detail | implemented | partial | AdminAction envelope; session invalidation semantics | Device detail drawer: tokens, sessions, audit, platform caps | Distinguish device record from active session. |
| `admin.pairing.queue` | Admin/Mesh | Start/connect/approve/exchange pairing and pending review | partial | partial | Pending pairing list/event endpoint if not currently available | Pairing expired/denied/bilateral/inbound credential states | Pairing connect is code-based; queue UI needs backend support. |
| `admin.mesh.peers` | Admin/Mesh | Persisted mesh peer CRUD and live connected peer management | partial | partial | Peer capability manifest; WebRTC metrics; gateway connected peer bridge | Separate persisted peer vs live connection panels | High priority for mesh production clarity. |
| `mesh.route.policy` | Mesh | Configure/explain peer route policy | missing_contract | partial | Route policy read/write and explain contract | Policy editor, sensitive-data blocks, peer fallback explanation | SDK-computed v1 possible but persistence needed. |
| `mesh.diagnostics` | Mesh | WebRTC/ICE/latency/data-channel diagnostics | missing_contract | partial | Mesh diagnostics endpoint/events | Peer diagnostic cards and failure states | Required for production P2P support. |
| `admin.config.view` | Admin/Config | Read effective config and source layering | implemented | covered | Optional schema metadata endpoint | Schema-driven editor and env/default/config source explanation | Existing Config.Get supports read path. |
| `admin.config.edit` | Admin/Config | Validate, diff, apply config safely | partial | covered | Backend diff/rollback/versioning; reload impact preview; AdminAction envelope | Typed controls, validation errors, affected service list | Config.Set/Validate exist; rollback does not. |
| `admin.plugins` | Admin/Tools | Plugin/MCP config, status and reload | partial | partial | Plugin install/update/signing; expose/restrict Tooling.ReloadMCPTools intentionally | Plugin cards with internal-only reload state | Avoid pretending install marketplace exists. |
| `admin.audit` | Admin/Audit | Audit log with reason, action id, route, payload redaction and export | implemented | partial | Ensure every admin action emits audit receipt | Event detail drawer, export confirmation | Depends on AdminAction enforcement for future events. |
| `admin.diagnostics.export` | Admin/Diagnostics | Redacted support bundle export | missing_contract | covered | Diagnostics bundle contract, log/trace collection, redaction, audit | Keep mock but mark missing-contract | Important backend route cluster. |
| `admin.backups` | Admin/Backup | Backup/restore config, DB/RAG and model state | missing_contract | partial | Backup create/verify/restore/rollback contracts; encryption/storage targets | Mark preview-only until backend exists | Admin-critical; not a UI-only task. |
| `models.catalog.runtime` | Models | Model provider catalog, import/download/benchmark, mobile local-light | missing_contract | partial | Provider/catalog/import/download/benchmark contracts; mobile provider abstraction | Runtime cards, device matrix, import wizard | Do not bind UI to one provider. |
| `native.android.assistant_role` | Mobile/Native | Android assistant role when package qualifies and user/OEM grants | partial | covered | Tauri Kotlin plugin, manifest/service qualification, emulator/device role tests | Role available/qualified/held/requestable/fallback states | Tauri can support this; grant is conditional. |
| `native.ios.invocation` | Mobile/Native | iOS App Intents, Shortcuts, widgets, share sheet and deep links | planned | covered | Swift plugin/extensions, App Intent definitions | Do not claim Siri replacement | Explicit product/legal/platform boundary. |

## Backend route/task additions implied by the matrix

1. `Aurora.EventStream` or equivalent unified event stream.
2. `AdminAction.Draft` / `AdminAction.Confirm` / audit receipt contract or equivalent policy layer.
3. Capability manifest endpoint or SDK-computed manifest formalization.
4. Peer capability manifest and route policy/explain contracts.
5. Diagnostics bundle export contract.
6. Backup/restore contracts.
7. Model catalog/import/download/benchmark contracts.
8. Attachment/context ingestion and mobile share-intake contracts.
9. Orchestrator cancellation/interrupt contract.
10. Config rollback/version/reload-impact preview contract.
11. Tool risk/approval metadata contract.
12. Pending pairing queue/list/event contract if queue UI remains first-class.

## Task-generation usage

Every future implementation card should link to at least one row in this matrix and state:

- UI feature ID;
- backend status at task start;
- SDK surface to implement or consume;
- transport modes covered;
- permissions used;
- privacy class;
- mock/reference path;
- verification required;
- whether backend route/contract work is required before UI wiring.
