# @aurora/client

Transport-independent TypeScript SDK for Aurora UI, Tauri, native mobile, tests, and mocks.

The SDK is an adapter over backend truth. It preserves backend method IDs, permission casing, provider identity, selectors, policy flags, correlation IDs, and redaction assertions. It does not infer peer trust, route success, tool execution, audio state, or native permissions without backend or native-manifest evidence.

## HTTP Gateway

```ts
import { AuroraClient, HttpGatewayTransport } from '@aurora/client'

const client = new AuroraClient({
  transport: new HttpGatewayTransport({
    baseUrl: 'http://127.0.0.1:8000',
    bearerToken: sessionToken,
    defaultTimeoutMs: 15_000
  })
})

const methods = await client.registry.listMethods()
const catalog = await client.capabilities.listCatalog({ include_schemas: true })
const graph = await client.capabilities.getGraph()
const tts = graph.explain('method:TTS.Synthesize')
const permissions = await client.permissions.listCatalog()
const result = await client.result(() => client.registry.getRegistry())

client.auth.updateFromLogin({
  user_id: login.user_id,
  username: login.username,
  permissions: login.permissions,
  is_admin: login.is_admin,
  expires_at: login.expires_at
})

if (client.auth.snapshot().state === 'admin') {
  // Enable admin surfaces only from backend-proven permissions.
}

client.permissions.check(['Auth.DeletePrincipal'], 'manage').allowed
permissions.find((permission) => permission.id === 'Auth.manage')?.label
tts.providerCandidates.map((candidate) => candidate.providerIdentity)
```

`HttpGatewayTransport` maps Gateway built-ins to their live HTTP routes:

- `Gateway.GetRegistry` -> `GET /api/registry`
- `Gateway.GetServices` -> `GET /api/services`
- `Gateway.Health` / `Gateway.HealthCheck` -> `GET /api/health`
- `Gateway.OpenAPI` -> `GET /api/openapi.json`

Generated external service methods default to `POST /api/{Module}/{Method}` with a JSON payload, matching Gateway's dynamic route generator. Callers can still pass an explicit `path` and `httpMethod` through `client.request()` when a descriptor or gateway built-in requires it.

API-key and bearer auth are transport options; token values are only placed in request headers:

```ts
const transport = new HttpGatewayTransport({
  baseUrl: 'https://aurora.example',
  apiKey: operatorApiKey,
  bearerToken: sessionToken
})

const result = await new AuroraClient({ transport }).requestResult('TTS.Synthesize', {
  text: 'Hello'
})

if (!result.ok && result.error.code === 'permission') {
  result.audit.correlationId
}
```

## Generated Backend Inventory

`scripts/generate_backend_inventory.py` emits the backend contract, route, permission, exposure, and gateway built-in inventory used by UI planning. The SDK can ingest that generated shape directly:

```ts
import { describeBackendInventory } from '@aurora/client'

const inventory = await fetch('/backend-inventory.json').then((response) => response.json())
const { methods, gatewayBuiltins, methodTypes } = describeBackendInventory(inventory)

methodTypes['Gateway.GetRegistry'].responseSchema
methods.find((method) => method.busTopic === 'Gateway.GetRegistry')?.routePath
gatewayBuiltins.find((route) => route.routePath === '/api/registry')
```

Generated methods keep backend `bus_topic`, permission casing, `method_type`, schemas, and route paths. Internal-only methods are marked unavailable over HTTP unless a local/native transport explicitly supports bus access.

Permission catalogs can be derived from the same inventory without inventing frontend permission IDs:

```ts
import { buildPermissionCatalogFromBackendInventory, resolveEffectivePermissions } from '@aurora/client'

const permissions = buildPermissionCatalogFromBackendInventory(inventory)
permissions.find((permission) => permission.id === 'Tooling.use')?.label // "Use Tooling"

const effective = resolveEffectivePermissions({
  userPermissions: ['Auth.manage', 'Gateway.use'],
  tokenScopes: ['Gateway.*'],
  userIsAdmin: false
})
```

## Tauri Local

```ts
import { AuroraClient, TauriLocalTransport, buildCapabilityGraph } from '@aurora/client'

const transport = new TauriLocalTransport({
  // Optional in tests; production Tauri shells can rely on window.__TAURI__.core.invoke.
  invoke: window.__TAURI__.core.invoke,
  commands: {
    request: 'aurora_request',
    sidecarStatus: 'aurora_sidecar_status',
    nativeCapabilityManifest: 'aurora_native_capability_manifest'
  }
})

const client = new AuroraClient({ transport })
const sidecar = await transport.getSidecarStatus()
const manifest = await client.native.getManifest()
const catalog = await client.capabilities.listCatalog({ include_unavailable: true })
const graph = buildCapabilityGraph({
  catalog,
  nativeManifest: manifest,
  transportKind: client.transport.kind
})
const result = await client.result(() => client.native.getManifest())
const canManageAuth = client.permissions.has('Auth.DeletePrincipal', 'manage')

client.auth.updateFromWhoAmI({
  principal_id: 'local-owner',
  principal_name: 'Local owner',
  permissions: ['*'],
  effective_perms: ['*'],
  is_admin: true,
  source: 'http_bearer'
})
```

Tauri commands must return backend/service evidence. Tauri IPC is not a second source of truth for Aurora service, mesh, auth, tool, DB, scheduler, or audio state.

Local/native helpers stay outside React and Tauri imports so desktop and mobile shells can provide their own command bridge:

```ts
await transport.secureStorageSet('aurora.session', sessionHandle)
const stored = await transport.secureStorageGet('aurora.session')
const picked = await transport.pickLocalFile({ filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }] })
const file = picked.cancelled ? null : await transport.readLocalFile(picked.paths[0]!, { encoding: 'base64' })
```

Internal bus access is explicit to the Tauri command implementation. The SDK preserves `method`, `busTopic`, payload, timeout, audit hints, permission casing, and returned correlation/redaction metadata when it invokes `aurora_request`.

## Mesh

```ts
import { AuroraClient, MeshP2PTransport } from '@aurora/client'

const transport = new MeshP2PTransport({
  defaultPeerId: 'peer-123',
  fallbackPeerIds: ['peer-456'],
  routeResolver: async (request) => {
    const selector = request.payload && typeof request.payload === 'object'
      ? (request.payload as { selector?: { peer_id?: string } }).selector
      : undefined
    return {
      peerId: selector?.peer_id ?? 'peer-123',
      selector,
      candidates: [
        { peerId: 'peer-123', providerId: 'remote:TTS:peer-123', module: 'TTS', eligible: true },
        { peerId: 'peer-456', providerId: 'remote:TTS:peer-456', module: 'TTS', eligible: true, fallback: true }
      ],
      fallbackAllowed: true
    }
  },
  bridge: {
    async call(request) {
      // A WebRTC DataChannel, Tauri command, native mobile bridge, or test harness
      // supplies this implementation. It must return backend/peer evidence.
      return meshRpc.call(request.peerId, {
        method: request.busTopic,
        params: request.payload,
        correlation_id: request.correlationId
      })
    }
  }
})

const client = new AuroraClient({ transport })

const synth = await client.requestResult('TTS.Synthesize', {
  text: 'Hello',
  selector: { peer_id: 'peer-123', module: 'TTS' }
})

if (synth.ok) {
  synth.audit.targetPeerId
  synth.audit.correlationId
}

const route = await client.routes.explain({
  topic: 'TTS.Synthesize',
  selector: { peer_id: 'peer-123', module: 'TTS' }
})
const sessionId = 'assistant-session-123'

const policy = await client.routes.evaluatePolicy({
  route,
  topic: 'TTS.Synthesize',
  selector: { peer_id: 'peer-123', module: 'TTS' },
  payload: { text: 'Hello' },
  sessionId,
  consentGranted: true,
  privacyIndicatorShown: true,
  approvalScopes: [{
    scope: 'session',
    decision: 'approve',
    sessionId,
    peerId: 'peer-123',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
  }]
})

const capability = await client.capabilities.explain('method:TTS.Synthesize')

if (!policy.allowed) {
  // Show the backend reason and keep execution disabled.
  policy.reasonCode
  policy.repairPath
  policy.preview.blockers
}

if (capability.selectorRequired && !capability.selectedProvider) {
  // Ask the user to choose an eligible peer/provider before execution.
}

const result = await client.result(() => client.routes.explain({
  topic: 'TTS.Synthesize',
  selector: { peer_id: 'peer-123', module: 'TTS' }
}))

client.auth.updateFromPairingExchange({
  user_id: 'peer-principal',
  device_id: 'mesh-device',
  peer_id: 'peer-123',
  node_name: 'Kitchen node',
  permissions: ['TTS.use']
})

client.permissions.check(['TTS.Synthesize'], 'use').allowed
```

`MeshP2PTransport` is an interface over peer RPC rather than a WebRTC implementation. The bridge owns DataChannel/native details; the SDK preserves `method`, `busTopic`, selector, route candidates, fallback hints, timeout, peer IDs, correlation ID, and redaction metadata. Route resolution can come from `Gateway.ExplainRoute`, `Gateway.GetCapabilityCatalog`, a Tauri local command, or a deterministic test resolver, but UI code should still use the same `AuroraClient` calls.

Mesh errors are classified into the shared SDK codes: `auth`, `permission`, `validation`, `timeout`, `unavailable_service`, `unsupported_feature`, `privacy_blocked`, `native_permission_missing`, and `transport_loss`. Mesh UI should show selected provider peer, service instance, fallback behavior, blockers, and correlation/audit metadata when available.

## Route And Privacy Policy

`client.routes.evaluatePolicy()` combines backend `Gateway.ExplainRoute` output with `Gateway.GetCapabilityCatalog` policy facts. It does not guess the backend route; it preserves the selected candidate, denial code, explicit selector requirement, approval state, privacy class, redacted payload preview, fallback behavior, and audit target for RouteSheet/tool approval UI.

HTTP/server-web example:

```ts
const evaluation = await client.routes.evaluatePolicy({
  routeRequest: { topic: 'Tooling.ExecuteTool' },
  toolId: 'tool:diagnostics.serviceHealth',
  payload: { args: { service: 'Gateway' } }
})

if (evaluation.availability === 'privacy-blocked') showPrivacyGuard(evaluation.preview)
```

Tauri local example:

```ts
const manifest = await client.native.getManifest()
client.native.requirePermission('secureStorage', manifest)

const payload = { key: 'ui.dark_mode', value: true }
const argsHash = 'sha256:config-set-ui-dark-mode-true'
const route = await client.routes.explain({ topic: 'Config.Set' })
const evaluation = await client.routes.evaluatePolicy({
  route,
  topic: 'Config.Set',
  payload,
  argsHash,
  approvalScopes: [{
    scope: 'single',
    decision: 'approve',
    approvalId: 'approval-config-set-1',
    argsHash,
    providerId: route.selected_provider_id ?? 'local:Config',
    expiresAt: expiresAtIso
  }]
})
```

Mesh example:

```ts
const evaluation = await client.routes.evaluatePolicy({
  routeRequest: {
    topic: 'TTS.Synthesize',
    selector: { peer_id: 'peer-studio-gpu', module: 'TTS' }
  },
  selector: { peer_id: 'peer-studio-gpu', module: 'TTS' },
  payload: { text: userText },
  consentGranted: true,
  privacyIndicatorShown: true
})
```

Native mobile example:

```ts
const mobile = new AuroraClient({ transport: nativeMobileTransport })
const evaluation = await mobile.routes.evaluatePolicy({
  routeRequest: { topic: 'STT.Transcribe' },
  payload: { media_ref: 'native://recording/latest' },
  privacyClass: 'raw-audio',
  consentGranted: microphoneConsent,
  privacyIndicatorShown: recordingIndicatorVisible
})
```

Mock/test example:

```ts
import { MockAuroraTransport, defaultMockAuroraFixtures } from '@aurora/client'

const mockClient = new AuroraClient({ transport: new MockAuroraTransport(defaultMockAuroraFixtures) })
const evaluation = await mockClient.routes.evaluatePolicy({
  route: defaultMockAuroraFixtures.routeExplain,
  catalog: defaultMockAuroraFixtures.capabilityCatalog,
  payload: { api_key: 'hidden in preview' }
})

evaluation.preview.payloadPreview // { api_key: '[redacted]' }
```

## Event Streams

`client.events` provides one transport-independent event contract for assistant streaming, service health, config updates, pairing/admin/audit-style streams, and future BE-003 unified events. It returns an async iterable `AuroraEvent` subscription, preserving backend IDs, topics, correlation, peer/target peer, method/bus topic, status, and redaction metadata.

```ts
const subscription = client.events.streamAssistant({ prompt: 'Summarize status' }, {
  reconnect: { maxAttempts: 3, initialDelayMs: 250 },
  backfill: true
})

for await (const event of subscription) {
  if (event.kind === 'assistant.delta') renderDelta(event.payload)
  if (event.kind === 'tool.requested') showToolApproval(event.audit.toolId, event.audit.correlationId)
}
```

HTTP transports support SSE by default and WebSocket when requested. The live backend path is intentionally configurable until the unified backend event contract lands:

```ts
const client = new AuroraClient({
  transport: new HttpGatewayTransport({
    baseUrl: 'https://aurora.example',
    bearerToken: sessionToken,
    eventStreamPath: '/api/events'
  })
})

const health = client.events.watchHealth({
  protocol: 'sse',
  reconnect: true,
  backfill: true
})

const assistant = client.events.streamAssistant({ prompt: 'Hello' }, {
  protocol: 'websocket',
  path: '/api/events'
})
```

Tauri local shells expose the same API through an IPC command that returns backend/service event evidence:

```ts
const transport = new TauriLocalTransport({
  invoke: window.__TAURI__.core.invoke,
  commands: { eventSubscribe: 'aurora_event_subscribe' }
})
const client = new AuroraClient({ transport })

for await (const event of client.events.watchConfig({ backfill: true })) {
  event.audit.transport // "tauri-local"
  event.audit.correlationId
}
```

Mesh subscriptions are bridge-owned. The bridge may use WebRTC DataChannels, a local Gateway, or a native command, but it must return backend/peer event evidence:

```ts
const transport = new MeshP2PTransport({
  defaultPeerId: 'peer-123',
  bridge: {
    async call(request) {
      return meshRpc.call(request.peerId, request)
    },
    subscribe(request) {
      return meshEvents.subscribe(request.peerId, {
        stream: request.stream,
        topics: request.topics,
        lastEventId: request.lastEventId
      })
    }
  }
})

const client = new AuroraClient({ transport })
const events = client.events.watchHealth({ reconnect: true })
```

Native mobile shells use the same transport contract through their bridge layer. Android/iOS code should expose event support through a native/Tauri-style command only after the native manifest and backend route/policy evidence support the claimed feature:

```ts
const mobileClient = new AuroraClient({ transport: nativeMobileTransport })
const configEvents = mobileClient.events.watchConfig({ kinds: ['config.updated'] })
```

Mocks can script success, failure, permission, and transport-loss paths deterministically:

```ts
const transport = new MockAuroraTransport()
  .stream('assistant', [
    { id: '1', kind: 'assistant.delta', payload: { text: 'hel' }, correlation_id: 'corr-1' },
    { id: '2', kind: 'assistant.delta', payload: { text: 'lo' }, correlation_id: 'corr-1' }
  ])
  .failStream('config', 'permission', 'Forbidden stream')

const client = new AuroraClient({ transport })
const stream = client.events.streamAssistant(undefined, { reconnect: true, backfill: true })
```

Reconnects carry the last delivered event ID back into the next transport subscription as `lastEventId`; `backfill` and `replayFrom` are request hints for transports/backends that support replay. The SDK does not invent event delivery, pairing success, health, config, tool execution, or audit state; it only normalizes events supplied by the selected transport.

## Native Mobile

```ts
const manifest = await client.native.getManifest()
client.native.requirePermission('microphone', manifest)
const nativeGraph = buildCapabilityGraph({
  catalog: await client.capabilities.listCatalog({ include_unavailable: true }),
  nativeManifest: manifest,
  transportKind: client.transport.kind
})
const result = await client.result(() => client.native.getManifest())

client.auth.updateFromTokenValidation({
  valid: true,
  principal_id: 'mobile-user',
  principal_name: 'Mobile user',
  permissions: ['Gateway.use'],
  effective_perms: ['Gateway.use'],
  is_admin: false,
  source: 'http_bearer'
})

const effective = client.permissions.resolveEffective({
  userPermissions: ['Gateway.use', 'TTS.use'],
  tokenScopes: ['TTS.*']
})
```

Android/iOS features are enabled only when the native capability manifest and backend route/policy evidence both support them.

## Mock Tests

```ts
import {
  AuroraClient,
  MockAuroraTransport,
  compareRegistryFixtureToBackendInventory,
  gatewayRegistryFixture,
  backendInventoryFixture
} from '@aurora/client'

const transport = new MockAuroraTransport()

const client = new AuroraClient({ transport })
const result = await client.result(() => client.registry.getRegistry())
const catalog = await client.capabilities.listCatalog({ include_unavailable: true })
const route = await client.routes.explain({ topic: 'TTS.Synthesize' })
const native = await client.native.getManifest()
const explanation = await client.capabilities.explain('tool:tool:notes')
const permissionCatalog = await client.permissions.listCatalog()

client.auth.setApiKeySystem()
client.auth.snapshot().state // "api_key_system"
explanation.providerCandidates.length // local and remote providers remain separate.
compareRegistryFixtureToBackendInventory(gatewayRegistryFixture, backendInventoryFixture).ok // true
```

`MockAuroraTransport` preloads deterministic backend-shaped fixtures for registry, services, capability catalog, route explain, native manifest, and tool catalog. The fixtures are based on `modules/ui-mock-reference/lib/aurora/data.ts` labels plus backend inventory shapes; they preserve backend method identity as `bus_topic` + method name and keep internal-only methods unavailable over HTTP.

Use `MockAuroraTransport.empty()` when a test needs no handlers, or override/script individual methods:

```ts
const transport = new MockAuroraTransport()
  .register('Gateway.GetRegistry', gatewayRegistryFixture)
  .fail('Gateway.ExplainRoute', 'privacy_blocked', 'Explicit selector required')
  .timeout('Tooling.GetToolCatalog')
  .lose('Gateway.GetCapabilityCatalog')
```

The mock fixtures are test/development data only. Production UI code should call `AuroraClient` namespaces and treat Gateway/native responses as the truth source.

## Capability Graph

`client.capabilities.getGraph()` merges backend capability catalog actions, registry-only method exposure, native manifests, provider freshness, routeability, policy flags, and privacy/permission requirements into deterministic feature nodes. It preserves provider identity instead of collapsing local and remote providers:

```ts
const graph = await client.capabilities.getGraph()
const notes = graph.explain('tool:tool:notes')

notes.providerCandidates.map((candidate) => ({
  provider: candidate.providerIdentity,
  selectable: candidate.selectable,
  reason: candidate.disabledReasons[0] ?? null
}))
```

`graph.explain(featureId)` returns the selected provider, alternate providers, disabled reason, next repair action, selector/approval requirements, permission requirements, privacy class, and redaction evidence. Explicit selector and privacy requirements remain blocked until backend or native evidence satisfies them; the SDK does not silently fallback for safety-sensitive features.

## Auth Session State

`client.auth` is a transport-independent state machine for UI gates. It keeps token values out of snapshots and preserves backend permission casing.

States:

- `anonymous`
- `pairing`
- `user`
- `admin`
- `mesh_peer`
- `api_key_system`
- `expired`
- `revoked`
- `unauthorized`
- `forbidden`

```ts
client.auth.setPairing({ reason: 'Waiting for approval' })
client.auth.updateFromLogin(loginResponse)
client.auth.updateFromPairingExchange(pairingExchangeResponse)
client.auth.updateFromWhoAmI(whoAmIResponse)

const session = client.auth.snapshot()

if (session.needsAuthentication) {
  // Show login, pairing recovery, or token refresh.
}

if (session.state === 'forbidden') {
  // Show permission-specific repair copy without clearing identity details.
}
```

`request()` and `requestResult()` apply normalized `401` and `403` failures to `client.auth`. A `401` becomes `unauthorized`, `expired`, or `revoked` when backend detail text identifies the specific condition. A `403` becomes `forbidden`. Transport loss, timeouts, validation errors, unavailable services, unsupported features, privacy blocks, and native permission errors do not change auth state.

## Permission Catalog And Effective Access

Permission helpers mirror the backend matcher in `app/shared/auth/permissions.py`:

- `*` grants all permissions.
- `Service.*` grants every permission under that service prefix.
- `Service.use` and `Service.manage` grant methods with the matching backend `method_type`.
- Exact method permissions such as `Gateway.GetRegistry` grant that backend method only.
- Matching is case-sensitive; display helpers preserve raw backend IDs like `Auth.manage`, `Tooling.use`, and `*`.

```ts
import { checkAccess, hasPermission, permissionLabel } from '@aurora/client'

hasPermission('Auth.DeletePrincipal', ['Auth.manage'], 'manage') // true
hasPermission('Auth.DeletePrincipal', ['auth.manage'], 'manage') // false

const decision = checkAccess(['Gateway.use'], ['Gateway.GetRegistry'], 'use')
decision.grants['Gateway.GetRegistry'] // "Gateway.use"

permissionLabel('Auth.manage') // "Manage Auth"
```

## Normalized Envelopes

All transports use the same public SDK envelope types:

- `AuroraRequest<TPayload>` carries `method`, optional `busTopic`, optional transport `path`, payload, headers, timeout, abort signal, and audit hints.
- `AuroraResult<TData>` is a discriminated union: `{ ok: true, data, audit }` or `{ ok: false, error, audit }`.
- `AuroraError` carries the canonical error code, message, HTTP status when present, method, bus topic, correlation ID, and backend detail.
- `AuroraEvent<TPayload>` wraps event payloads with topic, method, bus topic, audit receipt, redaction metadata, and receive timestamp.
- `AuditReceipt` preserves backend evidence such as correlation ID, peer/principal/target peer, method, bus topic, tool/resource IDs, status, transport kind, and redaction metadata.
- `RedactionMetadata` preserves `secretsRedacted`, backend-provided redacted field names, source, and warnings.

```ts
const result = await client.result(() => client.tools.execute({
  tool_id: 'tool:remote:file-search',
  selector: { peer_id: 'peer-123' }
}))

if (result.ok) {
  console.log(result.audit.correlationId)
} else if (result.error.code === 'privacy_blocked') {
  // Show the backend reason and keep execution disabled.
}
```

The SDK extracts audit/redaction fields from backend-style payloads (`correlation_id`, `bus_topic`, `peer_id`, `target_peer_id`, `tool_id`, `resource_id`, `status`, `secrets_redacted`) and HTTP correlation headers. Missing metadata remains `null`; the SDK does not invent peer trust, route success, or redaction claims.

## Error Classes

`AuroraError.code` is one of:

- `auth`
- `permission`
- `validation`
- `timeout`
- `unavailable_service`
- `unsupported_feature`
- `privacy_blocked`
- `native_permission_missing`
- `transport_loss`
- `unknown`

Use `client.result(() => operation())` when UI code wants a typed success/failure union instead of exceptions.
