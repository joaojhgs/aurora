# Aurora UI SDK Base Contract Specification

Date: 2026-06-10  
Scope: non-code contract definition for the UI/client SDK used by browser, Tauri desktop, Tauri mobile, local/offline node, and P2P mesh shell modes.  
Status: accepted planning baseline.

## 1. Contract decision

Aurora UI should be built on a **transport-independent TypeScript SDK** named here as `AuroraClient`. The UI must never call Python service objects or hard-coded endpoint lists directly. It should use this hierarchy:

```text
UI screens/components
  -> AuroraClient facade
    -> CapabilityGraph + AuthSession + EventStream + AdminActionController
      -> Transport adapter: HttpGateway | TauriLocal | MeshWebRTC | NativeMobile | Mock
        -> Aurora contract registry / bus / native plugin bridge
```

The SDK is the stable boundary between product UX and Aurora's changing service topology.

## 2. Source-of-truth inputs

The SDK must compose these sources at runtime:

1. **Gateway registry**: `/api/registry`, `/api/services`, `/api/routes`, and OpenAPI.
2. **Contract metadata**: `MethodInfo` fields: `name`, `bus_topic`, `exposure`, `required_perms`, `method_type`, `input_schema`, `output_schema`. The SDK-derived canonical method id is `bus_topic` when present, otherwise `${module}.${name}`; do not require a backend `id` field unless a future registry migration adds it.
3. **Auth identity**: `Auth.WhoAmI`, token validation, effective permissions, device id, source.
4. **Native capability manifest**: Tauri/Swift/Kotlin/mobile plugins report device-specific availability.
5. **Mesh capability manifests**: peers report remote service availability, permissions, route quality, and trust status.
6. **Local runtime manifest**: desktop local sidecar reports Python node lifecycle, architecture mode, data/model paths, and health.

Aurora-local evidence:

- Gateway OpenAPI is available at `/api/openapi.json` (`app/services/gateway/fastapi_app.py:77-99`).
- Gateway has registry/services/routes endpoints (`app/services/gateway/fastapi_app.py:198-299`).
- Dynamic HTTP routes are generated from registry external methods (`app/services/gateway/route_generator.py:321-341`).
- Dynamic route paths are `/api/{module}/{method}` and forward to bus topics (`app/services/gateway/route_generator.py:361-388`, `424-432`).
- `MethodInfo` carries exposure, permissions, method type, and JSON schemas (`app/shared/contracts/models/gateway.py:52-65`).
- Auth exposes login/session, pairing, principals, tokens, devices, audit, and mesh peer methods (`app/shared/contracts/models/auth.py:34-95`).
- MeshBus is intended as a transparent bus wrapper (`app/messaging/mesh_bus.py:1-28`, `283-340`).


## 2.1 Executed SDK/transport probes (2026-06-10)

Evidence lives in `.omx/experiments/ui-refinement/EXPERIMENT_RESULTS.md`. The probes refined the SDK baseline as follows:

1. **No `MethodInfo.id` exists today.** `20-sdk-contract-probe.txt` intentionally failed when it required `id`. The current backend shape uses `name` + `bus_topic`.
2. **Canonical SDK method id:** `methodId = method.bus_topic ?? module + "." + method.name`. `21-sdk-contract-current-shape-probe.txt` passed using current `MethodInfo` fields.
3. **OpenAPI discovery works with current RouteGenerator.** `23-gateway-openapi-route-probe.txt` generated `/api/Auth/WhoAmI` and `/api/Auth/SetPermissions`, including method type descriptions and security scopes.
4. **LocalBus embedded transport works, with envelope discipline.** `24-local-bus-embedded-roundtrip-probe.txt` failed because a response model with top-level `ok` was interpreted as a `QueryResult`; `25-local-bus-embedded-roundtrip-fixed-probe.txt` passed after removing the ambiguous top-level `ok`.
5. **Admin metadata exists but admin confirmation does not.** `22-admin-safety-static-probe.txt` found many `method_type="manage"` declarations and gateway ACL propagation, but no backend `AdminAction`/confirmation/preview/dry-run/audit-envelope enforcement.

SDK consequence: generated/raw calls can be derived from current registry/OpenAPI, but the hand-written facade must normalize reply envelopes, surface method type/permissions, and refuse high/critical admin mutations until a backend-enforced `AdminAction` path exists.

## 3. SDK package boundary

### 3.1 Proposed package split

```text
packages/aurora-sdk/               # future TypeScript package; no code in this session
  core/                            # envelopes, errors, capability graph, transport interface
  transports/http-gateway/          # fetch/SSE/WebSocket/OpenAPI-derived calls
  transports/tauri-local/           # Tauri invoke/event/localhost-sidecar adapter
  transports/mesh-webrtc/           # WebRTC data-channel adapter, peer registry
  transports/native-mobile/         # Kotlin/Swift plugin command/event facade
  testing/                          # mock transport + contract fixtures
packages/aurora-ui/                # future product UI app
```

If monorepo package creation is deferred, keep this split conceptually in docs and code folders.

### 3.2 Type generation decision

Use **OpenAPI + registry metadata** for generated types, but keep a hand-written facade for UX semantics.

- Generated types cover raw route request/response schemas.
- Hand-written SDK facade covers capabilities, auth, events, routing, retries, admin confirmation, and UI-friendly domain operations.
- Use `openapi-typescript` or equivalent for zero-runtime TypeScript types. Its docs state it converts OpenAPI 3.0/3.1 schemas to TypeScript types and type-safe fetching: https://openapi-ts.dev/
- Evaluate `hey-api/openapi-ts` only if generated SDK operations are desired; still keep Aurora facade as the stable UI contract.

Do not manually duplicate every contract in frontend files; generate or ingest registry.

## 4. Core concepts

### 4.1 Transport modes

| Transport ID | Used by | Underlying mechanism | Required capability |
|---|---|---|---|
| `http-gateway` | server web, desktop thin, mobile thin | HTTPS fetch + WebSocket/SSE if available | Gateway HTTP enabled |
| `tauri-local` | desktop local/offline | Tauri Rust starts sidecar; UI calls loopback gateway or Tauri IPC wrapper | local Aurora node healthy |
| `mesh-webrtc` | mesh shell and hybrid routing | WebRTC data channel JSON-RPC aligned with MeshBus/PeerBridge topic calls | trusted peer + mesh credentials |
| `native-mobile` | Android/iOS local-light | Tauri plugin commands/events exposing native services and inference runtime | plugin manifest + permissions |
| `mock` | Lovable/PoC/storybook/tests | in-memory registry/events | fixture graph |

### 4.2 Availability states

Every feature and operation must evaluate to one of these states:

- `available`: all required service/permission/platform conditions are satisfied.
- `degraded`: feature works with reduced quality or partial backend support.
- `read_only`: data can be viewed but not changed.
- `remote_only`: available only through HTTP/mesh peer, not local runtime.
- `local_only`: available only on the local device/node.
- `needs_auth`: user must authenticate.
- `needs_pairing`: device/peer must pair first.
- `needs_permission`: authenticated identity lacks required permissions.
- `needs_native_permission`: OS permission missing (mic, notification, assistant role, files, biometrics, location, etc.).
- `missing_service`: service/contract absent.
- `unsupported_platform`: platform cannot support feature.
- `unknown`: registry/capability graph not loaded.
- `error`: last capability probe failed.

UI should display these states directly rather than hiding unavailable features silently.

## 5. Envelope definitions

These are logical schemas, not code.

### 5.1 `AuroraClientOptions`

```yaml
AuroraClientOptions:
  clientId: string
  appVersion: string
  modeHint: server-web | desktop-thin | desktop-local | desktop-mesh | android-thin | android-local-light | ios-thin | ios-local-light | auto
  transport: TransportConfig | TransportConfig[]
  storage: secure | memory | browser | tauri-stronghold | native-keychain
  privacyDefaults:
    preferLocal: boolean
    allowRemoteFallback: boolean
    allowMeshFallback: boolean
    redactDiagnostics: boolean
  timeouts:
    invokeMs: number
    streamReconnectMs: number
    sidecarBootMs: number
  telemetry:
    enabled: boolean
    destination: local-only | admin-server | none
```

### 5.2 `TransportConfig`

```yaml
TransportConfig:
  id: string
  kind: http-gateway | tauri-local | mesh-webrtc | native-mobile | mock
  priority: number
  endpoint?: string
  peerId?: string
  tauriCommandPrefix?: string
  nativePluginId?: string
  authMode: bearer | api-key | pairing | mesh-credential | native-session | anonymous
  trust:
    tlsRequired: boolean
    pinServer?: boolean
    expectedPeerFingerprint?: string
    loopbackOnly?: boolean
```

### 5.3 `AuroraIdentity`

```yaml
AuroraIdentity:
  principalId: string
  principalName: string
  deviceId?: string
  isAdmin: boolean
  permissions: string[]
  effectivePermissions: string[]
  source: bus | http | mesh | native | unknown
  authState: anonymous | pairing | authenticated | expired | revoked
```

Maps to existing `Auth.WhoAmI` fields (`principal_id`, `principal_name`, `device_id`, `is_admin`, `permissions`, `effective_perms`, `source`) in `app/shared/contracts/models/auth.py:155-168`.

### 5.4 Canonical `PrivacyClass`

The UI, SDK, diagnostics, route policy, admin confirmations, and future backend metadata must use one canonical privacy enum:

```yaml
PrivacyClass:
  public: safe for remote/server/mesh routing by default
  personal: user history, preferences, schedules, contacts, and non-secret local context
  sensitive: private content that may route remotely only with explicit policy/user visibility
  secret: prompts, files, memories, or payloads marked local-only unless an explicit override allows otherwise
  raw-audio: microphone/wake/audio buffers or transcripts before redaction; local-first and diagnostics-redacted by default
  credential: API keys, tokens, pairing secrets, mesh credentials, device keys, and auth material; never routed to peers or exported in diagnostics
  admin-critical: RBAC, config, plugin, service-control, token, device, peer-trust, audit, and deployment mutations; requires admin action enforcement
```

Canonical rules:

- `public` may use remote/server/mesh routes subject to normal auth.
- `personal` defaults to local-first with visible remote/mesh route badges.
- `sensitive` requires explicit `RoutePolicy` before remote or peer fallback.
- `secret`, `raw-audio`, `credential`, and `admin-critical` default to local-only unless a purpose-specific policy explicitly allows a safer transformed form.
- `credential` values must never be displayed after creation, sent through debug/generic invoke, included in support bundles, or routed to mesh peers.
- `raw-audio` diagnostics export is opt-in and must default to transcript/metadata redaction.
- `admin-critical` always combines route policy, permission check, backend confirmation envelope, and audit decision.

### 5.5 `AuroraInvokeRequest`

```yaml
AuroraInvokeRequest:
  topic: string              # e.g. Orchestrator.ExternalUserInput or Auth.ListPrincipals
  module: string
  method: string
  payload: object
  routePolicy:
    prefer: local | remote | mesh | auto
    allowFallback: boolean
    requiredPeerId?: string
    privacyClass: PrivacyClass
  priority: interactive | system | external | background | numeric
  timeoutMs: number
  idempotencyKey?: string
  correlationId: string
  trace?: boolean
  principalId?: string
```

### 5.6 `AuroraInvokeResponse<T>`

```yaml
AuroraInvokeResponse:
  ok: boolean
  data?: T
  error?: AuroraError
  meta:
    correlationId: string
    transportId: string
    route: local | remote | mesh | native
    peerId?: string
    durationMs: number
    serviceVersion?: string
    registryDigest?: string
    permissionDecision?: allowed | denied | unknown
```

### 5.7 `AuroraEvent<T>`

```yaml
AuroraEvent:
  topic: string
  module: string
  type: service | assistant | audio | admin | config | mesh | lifecycle | diagnostic
  payload: T
  meta:
    eventId: string
    correlationId?: string
    origin: local | external | mesh_forwarded | native
    peerId?: string
    timestamp: string
    sequence?: number
    privacyClass: PrivacyClass
```

Event streaming is transport-normalized:

- HTTP gateway may use WebSocket/SSE or polling fallback.
- Tauri local uses Tauri events or loopback WebSocket.
- Mesh uses data-channel event forwarding.
- Native mobile uses plugin event emitters.
- Mock uses in-memory event bus.

### 5.8 `AuroraError`

```yaml
AuroraError:
  code: string
  category: auth | permission | validation | timeout | transport | service_unavailable | conflict | rate_limit | native_permission | unsupported | internal
  message: string
  retryable: boolean
  userAction?: login | pair | request_permission | check_service | retry | choose_peer | open_settings | contact_admin
  details?: object
  cause?: object
```

All transports must normalize errors into this shape.

## 6. `AuroraClient` facade

### 6.1 Lifecycle

```text
createAuroraClient(options)
client.connect()
client.refreshRegistry()
client.refreshCapabilities()
client.dispose()
```

Requirements:

- `connect()` does not imply login; it initializes transport, registry, and capability graph.
- `refreshRegistry()` pulls Gateway/peer/native manifests and computes digest.
- `dispose()` closes streams, WebRTC channels, sidecar handles, and listeners.
- In local desktop mode, sidecar lifecycle is explicit: `startLocalNode()`, `stopLocalNode()`, `restartLocalNode()`, `getLocalNodeStatus()`.

### 6.2 Auth/session API

```text
client.auth.login(username, password)
client.auth.logout()
client.auth.whoAmI()
client.auth.refreshToken()
client.auth.startPairing(deviceName, peerHint?)
client.auth.connectPairing(code)
client.auth.approvePairing(code, permissions, isAdmin)
client.auth.exchangePairing(code)
client.auth.getSessionState()
```

Auth calls map to `AuthMethods` in `app/shared/contracts/models/auth.py:34-95`.

### 6.3 Registry/capability API

```text
client.registry.getModules()
client.registry.getMethods(module?)
client.registry.getServices()
client.registry.getServiceHealth(module)
client.capabilities.getGraph()
client.capabilities.getFeature(featureId)
client.capabilities.explain(featureId)
client.capabilities.watch(listener)
```

`explain(featureId)` is mandatory. It returns why a feature is disabled/degraded:

```yaml
CapabilityExplanation:
  featureId: string
  state: AvailabilityState
  satisfied:
    services: string[]
    methods: string[]
    permissions: string[]
    nativePermissions: string[]
  missing:
    services: string[]
    methods: string[]
    permissions: string[]
    nativePermissions: string[]
    platformSupport: string[]
  routes:
    preferredTransport: string
    fallbackTransports: string[]
    peers: PeerRoute[]
  userActions:
    - login
    - pair_device
    - request_microphone
    - enable_gateway
```

### 6.4 Generic invoke API

```text
client.invoke<T>(topicOrMethodId, payload, options?)
client.invokeMethod<T>({module, method}, payload, options?)
client.publish(topic, payload, options?)
```

Rules:

- UI feature code may use generic invoke only through domain-specific hooks/services unless building an admin/debug console.
- `method_type="manage"` triggers admin action flow unless caller explicitly passes an approved confirmation token.
- `privacyClass` defaults by feature and payload type; sensitive/secret/raw-audio/credential/admin-critical operations require explicit route policy if any non-local route is allowed.
- Generic invoke/debug explorer must not bypass `AdminActionController` or backend confirmation enforcement for `method_type="manage"` or `privacyClass="admin-critical"` calls.

### 6.5 Assistant domain API

```text
client.assistant.sendText({text, sessionId?, attachments?, routePolicy?})
client.assistant.startVoiceSession({mode, wakeWord?, routePolicy?})
client.assistant.stopVoiceSession()
client.assistant.interrupt()
client.assistant.subscribeResponses(sessionId?)
client.assistant.getConversationHistory(filters)
```

Backed by:

- `Orchestrator.ExternalUserInput` / `Orchestrator.UserInput` (`app/shared/contracts/models/orchestrator.py:18-41`).
- STT contracts (`app/shared/contracts/models/stt.py`).
- TTS contracts (`app/shared/contracts/models/tts.py`).
- DB message history/RAG contracts (`app/shared/contracts/models/db.py`).

### 6.6 Admin domain API

```text
client.admin.services.list()
client.admin.services.health(module)
client.admin.services.control(action, module, confirmation)
client.admin.rbac.listPrincipals()
client.admin.rbac.createPrincipal(input, confirmation)
client.admin.rbac.patchPermissions(input, confirmation)
client.admin.tokens.list(filters)
client.admin.tokens.create(input, confirmation)
client.admin.devices.list(filters)
client.admin.devices.delete(deviceId, confirmation)
client.admin.mesh.listPeers()
client.admin.mesh.approvePeer(input, confirmation)
client.admin.mesh.updatePeerPermissions(input, confirmation)
client.admin.mesh.removePeer(input, confirmation)
client.admin.config.get(path)
client.admin.config.set(path, value, confirmation)
client.admin.config.validate(candidate)
client.admin.plugins.get(id)
client.admin.plugins.set(id, config, confirmation)
client.admin.audit.search(filters)
```

Admin calls must go through `AdminActionController`.

High/critical admin calls must also be enforceable by the backend. The UI wrapper is required for usability and safety, but it is not the security boundary.

## 7. Admin action wrapper

### 7.1 Why it exists

Aurora exposes many `method_type="manage"` operations. The UI must not let any admin surface accidentally perform destructive or privilege-changing actions through a raw button click.

Examples from repo:

- Pairing approval is `method_type="manage"` (`app/services/auth/service.py:350-357`).
- Principal CRUD and permissions are `manage` (`app/services/auth/service.py:394-538`).
- Token/device/audit management are `manage` (`app/services/auth/service.py:560-735`).
- Mesh peer approve/deny/update/remove are `manage` (`app/services/auth/service.py:878-985`).
- Config writes and plugin writes exist (`app/shared/contracts/models/config.py:16-28`).
- Supervisor service control exists (`app/shared/contracts/models/supervisor.py:18-56`).

### 7.2 `AdminActionDraft`

```yaml
AdminActionDraft:
  actionId: string
  methodId: string
  title: string
  description: string
  severity: low | medium | high | critical
  payload: object
  before?: object
  after?: object
  diff?: object
  requiredPermissions: string[]
  affectedResources:
    - type: principal | token | device | peer | config | service | plugin | model | system
      id: string
      label: string
  confirmation:
    required: boolean
    mode: none | click | type_resource_name | biometric | reauth | two_admin
  audit:
    reasonRequired: boolean
    reason?: string
    ticket?: string
```

### 7.3 `AdminActionConfirmation`

```yaml
AdminActionConfirmation:
  actionId: string
  confirmedAt: string
  confirmedBy: AuroraIdentity
  confirmationMode: click | type_resource_name | biometric | reauth | two_admin
  phrase?: string
  reason?: string
  localOnly: boolean
```

### 7.4 Rules

- Low-risk read operations do not require draft confirmation.
- Any `manage` method requires at least click confirmation.
- Permission/token/principal deletion requires typed phrase or re-auth.
- Mesh peer trust changes require visible permissions diff.
- Config writes require validate-before-apply when `Config.Validate` is available.
- Service stop/restart requires health impact preview.
- High/critical `manage` calls must include a backend-verifiable confirmation envelope: `actionId`, `methodId`, payload digest, principal/device identity, confirmation mode, timestamp, reason/ticket when required, and nonce/expiry.
- Backend routes for high/critical `manage` calls must reject direct raw calls that omit or fail this envelope, including debug/generic invoke and generated SDK methods.
- Backend must persist or request an audit event for every accepted high/critical admin action. If the audit backend is unavailable, the route must either reject the action or return an explicit `audit_unavailable` risk state according to the method policy.
- UI must show missing audit backend as a risk state and cannot silently downgrade high/critical actions to unaudited direct calls.

## 8. Transport adapter contracts

### 8.1 `AuroraTransport`

```yaml
AuroraTransport:
  id: string
  kind: TransportKind
  connect(): TransportStatus
  disconnect(): void
  getStatus(): TransportStatus
  getRegistry(): RegistrySnapshot
  invoke(request: AuroraInvokeRequest): AuroraInvokeResponse
  subscribe(filter: EventFilter, listener): Subscription
  getNativeCapabilities?(): NativeCapabilityManifest
  getPeerCapabilities?(): PeerCapabilityManifest[]
```

### 8.2 HTTP gateway adapter

Responsibilities:

- fetch OpenAPI and `/api/registry`;
- include bearer/API key auth;
- call generated `/api/{module}/{method}` endpoints;
- normalize 401/403/404/503/timeout;
- subscribe events using the best available backend stream; fallback to polling registry/service health if no stream endpoint exists;
- respect CORS and same-origin constraints.

### 8.3 Tauri local adapter

Responsibilities:

- start/stop/restart desktop sidecar;
- discover loopback port/IPC handle;
- lock loopback endpoint to local origin where possible;
- stream sidecar health/logs;
- forward SDK calls to local gateway/IPC;
- expose native storage/keychain, notifications, file/dialog/deep link hooks through separate native capability manifest;
- never expose unrestricted shell or filesystem operations to the web UI.

### 8.4 Mesh WebRTC adapter

Responsibilities:

- manage peer credentials/pairing state;
- discover peer capability manifests;
- route `invoke` by topic/method and privacy policy;
- expose route preview before sensitive operations;
- normalize peer offline, permission denied, timeout, and fallback states;
- avoid forwarding high-frequency audio events by default, matching MeshBus local-first/high-frequency caution (`app/messaging/mesh_bus.py:12-21`).

### 8.5 Native mobile adapter

Responsibilities:

- expose Swift/Kotlin plugin command/event bridge;
- report OS permission states;
- expose native assistant integration availability;
- expose mobile inference runtime status;
- implement local-light services as native capability-backed methods where needed;
- never imply full Python node is available unless a specific future mobile Python experiment proves it.

Android assistant packaging decision:

- Official Tauri 2 can host Kotlin native plugins and Android manifest/service declarations in the final Android app package.
- Android assistant-role capability is represented as native state, not as an unconditional UI feature.
- The SDK must distinguish:
  - `assistantRoleAvailable`: Android exposes `ROLE_ASSISTANT` on this device/profile;
  - `assistantRoleHeld`: Aurora currently holds it;
  - `assistantPackageQualified`: the installed package appears to satisfy Android qualification checks where observable;
  - `assistantRoleRequestable`: the UI may show the role request action;
  - `assistantRoleDeniedOrBlocked`: user/OEM/policy denied or blocked it.
- A Tauri/Kotlin plugin may query and request role state, but Android only grants the role when the native package qualifies through manifest/service entries and the user/OEM policy allows it.

Minimum native mobile manifest shape for SDK fixtures:

```yaml
NativeCapabilityManifest:
  platform: android | ios | desktop
  shell: tauri-official-rust
  pluginBridge:
    android: kotlin-tauri-plugin
    ios: swift-tauri-plugin
  permissions:
    microphone: granted | denied | promptable | unsupported | unknown
    notifications: granted | denied | promptable | unsupported | unknown
    localNetwork: granted | denied | promptable | unsupported | unknown
    filesPhotos: granted | denied | promptable | unsupported | unknown
    biometrics: granted | denied | promptable | unsupported | unknown
  androidAssistant:
    roleAvailable: boolean
    roleHeld: boolean
    roleRequestable: boolean
    packageQualified: boolean | unknown
    voiceInteractionServiceDeclared: boolean | unknown
    bindVoiceInteractionPermissionDeclared: boolean | unknown
    fallbackEntrypoints: [app, notification, widget, shortcut, quick_tile, share_sheet, deep_link, server, mesh]
  iosInvocation:
    appIntentsAvailable: boolean
    shortcutsAvailable: boolean
    shareExtensionAvailable: boolean
    widgetsAvailable: boolean
    siriReplacement: false
  localInference:
    providers: []
    selectedProvider: string | null
    thermalState: nominal | fair | serious | critical | unknown
```

## 9. Capability graph contract

### 9.1 Feature node

```yaml
FeatureNode:
  id: string
  label: string
  category: assistant | voice | memory | tools | admin | mesh | config | diagnostics | native | model
  userValue: string
  required:
    services: string[]
    methods: string[]
    permissions: string[]
    nativeCapabilities: string[]
    nativePermissions: string[]
    platformRoles: string[]
  optional:
    services: string[]
    methods: string[]
    permissions: string[]
    nativeCapabilities: string[]
  privacyClass: PrivacyClass
  routePolicyDefault: local-first | remote-first | mesh-first | explicit
  statesByMode: map
  fallbacks: FeatureFallback[]
```

### 9.2 Feature edge types

- `requires_service`
- `requires_method`
- `requires_permission`
- `requires_native_permission`
- `requires_platform_role`
- `can_route_to_peer`
- `degrades_to`
- `audits_to`
- `configures`
- `emits_event`
- `consumes_event`

### 9.3 Evaluation algorithm

1. Load registry and native/peer manifests.
2. Load identity/effective permissions.
3. For each feature, check required services/methods.
4. Check required permissions.
5. Check platform/native roles/permissions.
6. Check route policy and privacy constraints.
7. Produce state + explanation + user actions.
8. Subscribe to registry/config/auth/mesh/native events and recompute.

## 10. SDK conformance tests for later implementation

Not code now; these are test obligations.

1. **Transport parity:** same assistant text call succeeds through HTTP and Tauri-local loopback fixture.
2. **Registry ingestion:** new backend method appears in capability graph without frontend hard-code.
3. **Permission denial:** missing `manage` permission disables admin mutation and returns `needs_permission` with explanation.
4. **Admin confirmation:** `Auth.DeleteDevice` cannot execute without confirmation token.
5. **Admin backend enforcement:** direct raw invocation of a high/critical `method_type="manage"` route is rejected without the backend-verifiable confirmation/audit envelope, even when called through debug/generic invoke.
6. **Config validation:** config set flow calls validate before set when available.
7. **Mesh privacy:** sensitive feature refuses remote route unless policy allows.
8. **Credential privacy:** credential payloads are redacted from diagnostics/support bundles and cannot route to peers.
9. **Raw audio privacy:** raw-audio payloads default local-only and require explicit opt-in for diagnostic capture/export.
10. **Peer fallback:** remote peer timeout degrades to configured fallback and surfaces route badge.
11. **Event normalization:** Orchestrator/TTS/STT/config events have common `AuroraEvent` shape across transports.
12. **Offline mode:** desktop local launches with no network and still computes local capabilities.
13. **Mobile unsupported:** iOS reports no Siri replacement, but App Intent-capable actions appear as native integration features.
14. **Android assistant role:** role unavailable/denied states are distinct from missing microphone permission.
15. **Mock mode:** Lovable/Storybook fixtures can render all states without backend.

## 11. Versioning and compatibility

- SDK major version follows UI contract stability, not backend service version.
- Registry digest changes trigger capability recompute.
- Feature definitions are versioned separately from generated OpenAPI types.
- Each transport declares `contractVersion` and `minRegistrySchemaVersion`.
- Unknown backend methods are visible in admin/debug explorer but not automatically productized.
- Deprecated backend methods remain callable only through compatibility layer until feature graph migrates.

## 12. Security and privacy defaults

- Default route policy is local-first for personal/sensitive/secret/raw-audio/credential/admin-critical data.
- Remote fallback must be user-visible for sensitive data.
- Tokens stored in OS/browser-appropriate secure storage; never localStorage for native app secrets.
- Tauri shell permissions must be least-privilege by window/scope.
- Loopback sidecar endpoints must bind to localhost/private IPC only, use random ports or IPC handles, require per-session token plus origin binding, deny arbitrary-origin CORS, and include port-conflict/hijack tests.
- Mesh calls require trusted peer identity, permission manifest, route preview for sensitive actions, and audit trace.
- Admin actions require confirmation and audit envelope.
- Diagnostics export must redact tokens, passwords, API keys, model prompts marked secret, and raw audio unless user opts in.

## 13. Visual PoC implications

For Lovable or another visual generator, the SDK spec should become fixtures:

- authenticated admin with full local stack;
- authenticated non-admin assistant-only user;
- unauthenticated pairing flow;
- desktop local sidecar booting;
- mobile thin client with missing native permissions;
- mesh route with remote peer available;
- config write requires validation/confirmation;
- feature disabled with clear explanation.

The PoC should design around feature state badges and route/privacy badges from day one.


## 16. Production-readiness corrections from 2026-06-14 code audit

These corrections supersede any UI/mock wording that used generic frontend-only permissions or REST-style assumptions.

### 16.1 Canonical method identity

The SDK method id is derived from current backend metadata:

```ts
type AuroraMethodId = MethodInfo["bus_topic"] | `${module}.${MethodInfo["name"]}`
```

Use `bus_topic` when present. Do not require a backend `id` field unless a future registry migration adds one.

### 16.2 Generated route semantics

Dynamic Gateway routes are method-call POST routes generated from contract metadata. The SDK must expose method invocation rather than REST CRUD assumptions:

```ts
await client.call('Auth.ListTokens', payload)
await client.call('Config.Set', payload)
await client.call('Tooling.ExecuteTool', payload)
```

The HTTP adapter maps calls to generated `/api/{Module}/{Method}` paths discovered from registry/OpenAPI. Tauri-local, mesh and native-mobile adapters may use IPC/bus/RPC equivalents while preserving the same logical envelope.

### 16.3 Gateway-native APIs

The SDK must model gateway-native APIs separately from generated contract calls:

```ts
client.gateway.getHealth()
client.gateway.getRegistry()
client.gateway.getServices()
client.gateway.getRoutes()
client.gateway.listConnectedPeers()
client.gateway.disconnectPeer(peerId)
client.gateway.refreshPeerPermissions(peerId)
```

These are not generic bus method calls and should not be displayed as ordinary contract methods without a `gateway_builtin` marker.

### 16.4 Permission catalog

The SDK permission catalog uses backend-canonical IDs: `*`, `<Service>.*`, `<Service>.use`, `<Service>.manage`, and exact method/topic permissions where exposed. Friendly labels and grouping are derived UI metadata only. The UI must not persist lower-case aliases such as `assistant.use` or `tools.execute` as authoritative scopes.

### 16.5 Normalized errors

The SDK must normalize both transport errors and successful HTTP responses containing contract-level error payloads:

```ts
type AuroraResult<T> =
  | { ok: true; data: T; meta: CallMeta }
  | { ok: false; error: AuroraError; meta: CallMeta }
```

Screens consume `AuroraResult<T>` and `AuthSession` state, not raw backend unions.

### 16.6 AdminAction backend enforcement

High/critical `method_type="manage"` operations require backend-enforced draft/preview/confirm/audit semantics before production UI enables them. Required fields include action id, actor identity, method id, payload digest, nonce, expiry, risk, diff/affected resources, confirmation mode, reason, and audit receipt. Visual dialogs are mock/reference only until the backend rejects direct unsafe calls.

### 16.7 Capability graph source precedence

Capability evaluation precedence for a feature is:

1. transport mode;
2. service availability;
3. method availability;
4. exposure compatibility (`internal`, `external`, `both`, `gateway_builtin`, `planned`);
5. auth/session state;
6. effective permissions;
7. native capability/platform role;
8. mesh peer trust/capability/route quality;
9. privacy policy;
10. backend coverage state (`implemented`, `partial`, `internal_only`, `missing_contract`, `planned`, `mock_only`).

This order prevents UI screens from presenting planned or internal-only operations as production-ready HTTP actions.
