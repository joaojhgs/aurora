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
```

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
```

Mesh UI should show selected provider peer, service instance, fallback behavior, blockers, and correlation/audit metadata when available.

## Native Mobile

```ts
const manifest = await client.native.getManifest()
client.native.requirePermission('microphone', manifest)
```

Android/iOS features are enabled only when the native capability manifest and backend route/policy evidence both support them.

## Mock Tests

```ts
import { AuroraClient, MockAuroraTransport, gatewayRegistryFixture } from '@aurora/client'

const transport = new MockAuroraTransport()
  .register('Gateway.GetRegistry', gatewayRegistryFixture)

const client = new AuroraClient({ transport })
```

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
