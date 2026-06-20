# @aurora/client

Transport-independent TypeScript SDK for Aurora UI, Tauri, native mobile, tests, and mocks.

The SDK is an adapter over backend truth. It preserves backend method IDs, permission casing, provider identity, selectors, policy flags, correlation IDs, and redaction assertions. It does not infer peer trust, route success, tool execution, audio state, or native permissions without backend or native-manifest evidence.

## HTTP Gateway

```ts
import { AuroraClient, HttpGatewayTransport } from '@aurora/client'

const client = new AuroraClient({
  transport: new HttpGatewayTransport({
    baseUrl: 'http://127.0.0.1:8000',
    bearerToken: sessionToken
  })
})

const methods = await client.registry.listMethods()
const catalog = await client.capabilities.listCatalog({ include_schemas: true })
const result = await client.result(() => client.registry.getRegistry())
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

## Tauri Local

```ts
import type { AuroraTransport } from '@aurora/client'
import { AuroraClient } from '@aurora/client'

const tauriTransport: AuroraTransport = {
  kind: 'tauri-local',
  async request(request) {
    return {
      data: await window.__TAURI__.core.invoke('aurora_request', request)
    }
  }
}

const client = new AuroraClient({ transport: tauriTransport })
const manifest = await client.native.getManifest()
const result = await client.result(() => client.native.getManifest())
```

Tauri commands must return backend/service evidence. Tauri IPC is not a second source of truth for Aurora service, mesh, auth, tool, DB, scheduler, or audio state.

## Mesh

```ts
const route = await client.routes.explain({
  topic: 'TTS.Synthesize',
  selector: { peer_id: 'peer-123', module: 'TTS' }
})

if (route.security_privacy_blockers.length > 0) {
  // Show the backend reason and keep execution disabled.
}

const result = await client.result(() => client.routes.explain({
  topic: 'TTS.Synthesize',
  selector: { peer_id: 'peer-123', module: 'TTS' }
}))
```

Mesh UI should show selected provider peer, service instance, fallback behavior, blockers, and correlation/audit metadata when available.

## Native Mobile

```ts
const manifest = await client.native.getManifest()
client.native.requirePermission('microphone', manifest)
const result = await client.result(() => client.native.getManifest())
```

Android/iOS features are enabled only when the native capability manifest and backend route/policy evidence both support them.

## Mock Tests

```ts
import { AuroraClient, MockAuroraTransport, gatewayRegistryFixture } from '@aurora/client'

const transport = new MockAuroraTransport()
  .register('Gateway.GetRegistry', gatewayRegistryFixture)

const client = new AuroraClient({ transport })
const result = await client.result(() => client.registry.getRegistry())
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
