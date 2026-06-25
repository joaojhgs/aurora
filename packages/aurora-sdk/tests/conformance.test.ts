import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  HttpGatewayTransport,
  MeshP2PTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  backendInventoryFixture,
  capabilityGraphCatalogFixture,
  cloneFixture,
  compareRegistryFixtureToBackendInventory,
  defaultMockAuroraFixtures,
  describeBackendInventory,
  describeRegistry,
  deploymentTopologyFixture,
  gatewayRegistryFixture,
  nativeCapabilityManifestFixture,
  routeExplainFixture,
  toolCatalogFixture,
  webrtcDiagnosticsFixture,
  type AuroraErrorCode,
  type AuroraTransportKind,
  type AuroraTransportRequest
} from '../src/index.js'

type ConformanceMethod =
  | 'Gateway.GetRegistry'
  | 'Gateway.GetServices'
  | 'Gateway.GetDeploymentTopology'
  | 'Gateway.GetWebRTCDiagnostics'
  | 'Gateway.GetCapabilityCatalog'
  | 'Gateway.ExplainRoute'
  | 'Tooling.GetToolCatalog'
  | 'Native.GetCapabilityManifest'

interface ConformanceCase {
  name: string
  kind: AuroraTransportKind
  createClient: () => AuroraClient
}

const conformanceCases: ConformanceCase[] = [
  {
    name: 'mock',
    kind: 'mock',
    createClient: () => new AuroraClient({ transport: new MockAuroraTransport() })
  },
  {
    name: 'HTTP Gateway',
    kind: 'http',
    createClient: () =>
      new AuroraClient({
        transport: new HttpGatewayTransport({
          baseUrl: 'http://aurora.local',
          fetchImpl: createConformanceFetch()
        })
      })
  },
  {
    name: 'Tauri command mock',
    kind: 'tauri-local',
    createClient: () =>
      new AuroraClient({
        transport: new TauriLocalTransport({
          invoke: async (command, args) => {
            if (command !== 'aurora_command') {
              throw new Error(`Unexpected Tauri command ${command}`)
            }
            const request = readTauriRequest(args)
            if (!hasConformanceResponse(request.method)) {
              throw { detail: { code: 'unsupported_feature', message: `Unsupported ${request.method}` }, status: 428 }
            }
            return {
              data: conformanceResponse(request.method),
              status: 200,
              audit: {
                correlationId: `corr-tauri-${request.method}`,
                method: request.method,
                busTopic: request.busTopic ?? request.method
              }
            }
          }
        })
      })
  },
  {
    name: 'mesh bridge mock',
    kind: 'mesh',
    createClient: () =>
      new AuroraClient({
        transport: new MeshP2PTransport({
          defaultPeerId: 'peer-conformance',
          routeResolver: () => ({
            peerId: 'peer-conformance',
            selector: { peer_id: 'peer-conformance', module: 'Gateway' },
            candidates: [{ peerId: 'peer-conformance', providerId: 'mesh:peer-conformance:Gateway', eligible: true }]
          }),
          bridge: {
            async call(request) {
              if (!hasConformanceResponse(request.method)) {
                return { error: { code: 'unsupported_feature', message: `Unsupported ${request.method}` } }
              }
              return {
                data: conformanceResponse(request.method),
                status: 'success',
                correlationId: `corr-mesh-${request.method}`,
                targetPeerId: request.peerId,
                secretsRedacted: true
              }
            }
          }
        })
      })
  }
]

describe('SDK transport conformance', () => {
  for (const transportCase of conformanceCases) {
    it(`${transportCase.name} preserves registry, capability, route, tool, and error behavior`, async () => {
      const client = transportCase.createClient()

      await expect(client.registry.getRegistry()).resolves.toEqual(gatewayRegistryFixture)
      await expect(client.registry.listServices()).resolves.toEqual(defaultMockAuroraFixtures.services)
      await expect(client.registry.getDeploymentTopology()).resolves.toEqual(deploymentTopologyFixture)
      await expect(client.registry.getWebRTCDiagnostics()).resolves.toEqual(webrtcDiagnosticsFixture)
      await expect(client.capabilities.listCatalog({ include_unavailable: true })).resolves.toEqual(
        capabilityGraphCatalogFixture
      )
      await expect(client.routes.explain({ topic: 'TTS.Synthesize' })).resolves.toEqual(routeExplainFixture)
      await expect(client.tools.listCatalog()).resolves.toEqual(toolCatalogFixture)

      const methods = await client.registry.listMethods()
      expect(methods).toEqual(describeRegistry(gatewayRegistryFixture))
      expect(methods).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            busTopic: 'Gateway.GetDeploymentTopology',
            routePath: '/api/Gateway/GetDeploymentTopology',
            requiredPermissions: ['Gateway.manage'],
            availableOverHttp: true
          }),
          expect.objectContaining({
            busTopic: 'Gateway.GetWebRTCDiagnostics',
            routePath: '/api/Gateway/GetWebRTCDiagnostics',
            requiredPermissions: ['Gateway.manage'],
            availableOverHttp: true
          }),
          expect.objectContaining({
            busTopic: 'Gateway.GetRegistry',
            routePath: '/api/Gateway/GetRegistry',
            requiredPermissions: ['Gateway.use'],
            availableOverHttp: true
          }),
          expect.objectContaining({
            busTopic: 'Gateway.InternalOnly',
            routePath: null,
            requiredPermissions: ['Gateway.manage'],
            availableOverHttp: false
          })
        ])
      )

      const result = await client.requestResult('Gateway.GetRegistry')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.audit).toEqual(
          expect.objectContaining({
            method: 'Gateway.GetRegistry',
            busTopic: 'Gateway.GetRegistry',
            transport: transportCase.kind,
            redaction: expect.objectContaining({ secretsRedacted: true })
          })
        )
      }

      const unsupported = await client.requestResult('Gateway.InternalOnly')
      expect(unsupported.ok).toBe(false)
      if (!unsupported.ok) {
        expect(unsupported.error.code).toBe('unsupported_feature')
        expect(unsupported.audit).toEqual(
          expect.objectContaining({
            method: 'Gateway.InternalOnly',
            busTopic: 'Gateway.InternalOnly',
            transport: transportCase.kind
          })
        )
      }
    })
  }

  it('keeps native manifest access limited to mock, Tauri, and native-capable transports', async () => {
    await expect(new AuroraClient({ transport: new MockAuroraTransport() }).native.getManifest()).resolves.toEqual(
      nativeCapabilityManifestFixture
    )
    await expect(
      new AuroraClient({
        transport: new TauriLocalTransport({
          invoke: async (command, args) => {
            if (command !== 'aurora_command') throw new Error(`Unexpected Tauri command ${command}`)
            return { data: conformanceResponse(readTauriRequest(args).method), status: 200 }
          }
        })
      }).native.getManifest()
    ).resolves.toEqual(nativeCapabilityManifestFixture)

    await expect(
      async () =>
        new AuroraClient({
          transport: new HttpGatewayTransport({
            baseUrl: 'http://aurora.local',
            fetchImpl: createConformanceFetch()
          })
        }).native.getManifest()
    ).rejects.toMatchObject({ code: 'unsupported_feature' })
  })

  it('classifies the required shared error taxonomy across all conformance transports', async () => {
    const errorCases: Array<{ code: AuroraErrorCode; expected: AuroraErrorCode }> = [
      { code: 'auth', expected: 'auth' },
      { code: 'permission', expected: 'permission' },
      { code: 'validation', expected: 'validation' },
      { code: 'timeout', expected: 'timeout' },
      { code: 'unavailable_service', expected: 'unavailable_service' },
      { code: 'unsupported_feature', expected: 'unsupported_feature' },
      { code: 'privacy_blocked', expected: 'privacy_blocked' },
      { code: 'native_permission_missing', expected: 'native_permission_missing' }
    ]

    for (const { code, expected } of errorCases) {
      for (const { name, createClient } of createErrorCases(code)) {
        const result = await createClient().requestResult('Gateway.GetRegistry')
        expect(result.ok, `${name} should fail`).toBe(false)
        if (!result.ok) expect(result.error.code).toBe(expected)
      }
    }

    for (const { name, createClient } of createTransportLossCases()) {
      const result = await createClient().requestResult('Gateway.GetRegistry')
      expect(result.ok, `${name} should fail`).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('transport_loss')
    }
  })

  it('compares SDK registry fixtures against the generated backend inventory snapshot', () => {
    const generated = describeBackendInventory(backendInventoryFixture)
    const comparison = compareRegistryFixtureToBackendInventory(gatewayRegistryFixture, backendInventoryFixture)

    expect(backendInventoryFixture.generated_by).toBe('scripts/generate_backend_inventory.py')
    expect(generated.methods.map((method) => method.busTopic)).toEqual([
      'Orchestrator.GetModelCatalog',
      'Orchestrator.GetModelRuntime',
      'Orchestrator.ImportModel',
      'Orchestrator.DownloadModel',
      'Orchestrator.BenchmarkModel',
      'Auth.ListTokens',
      'Auth.CreateToken',
      'Auth.UpdateTokenScopes',
      'Auth.RevokeToken',
      'Auth.ListPendingPairings',
      'Auth.ListPrincipals',
      'Auth.CreatePrincipal',
      'Auth.UpdatePrincipal',
      'Auth.DeletePrincipal',
      'Auth.SetPermissions',
      'Auth.PatchPermissions',
      'Auth.AuditLog',
      'Gateway.GetRegistry',
      'Gateway.GetDeploymentTopology',
      'Gateway.GetWebRTCDiagnostics',
      'Gateway.InternalOnly',
      'Orchestrator.IngestContext'
    ])
    expect(generated.gatewayBuiltins.map((route) => route.routePath)).toEqual(['/api/registry', '/api/admin/peers'])
    expect(comparison).toEqual({ ok: true, checked: 16, issues: [] })
  })
})

function createConformanceFetch(): typeof fetch {
  return async (input) => {
    const method = methodFromUrl(String(input))
    if (!method) {
      return new Response(
        JSON.stringify({ detail: { code: 'unsupported_feature', message: `Unsupported ${new URL(String(input)).pathname}` } }),
        { status: 428 }
      )
    }
    const data = conformanceResponse(method)
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'x-correlation-id': `corr-http-${method}` }
    })
  }
}

function createErrorCases(code: AuroraErrorCode): ConformanceCase[] {
  return [
    {
      name: `mock ${code}`,
      kind: 'mock',
      createClient: () =>
        new AuroraClient({ transport: MockAuroraTransport.empty().fail('Gateway.GetRegistry', code, code) })
    },
    {
      name: `HTTP ${code}`,
      kind: 'http',
      createClient: () =>
        new AuroraClient({
          transport: new HttpGatewayTransport({
            baseUrl: 'http://aurora.local',
            fetchImpl: async () =>
              new Response(JSON.stringify({ detail: httpErrorDetail(code) }), { status: httpStatusFor(code) })
          })
        })
    },
    {
      name: `Tauri ${code}`,
      kind: 'tauri-local',
      createClient: () =>
        new AuroraClient({
          transport: new TauriLocalTransport({
            invoke: async () => {
              throw { detail: { code, message: code }, status: httpStatusFor(code) }
            }
          })
        })
    },
    {
      name: `mesh ${code}`,
      kind: 'mesh',
      createClient: () =>
        new AuroraClient({
          transport: new MeshP2PTransport({
            defaultPeerId: 'peer-conformance',
            bridge: {
              async call() {
                return { error: { code, reason_code: code, message: code } }
              }
            }
          })
        })
    }
  ]
}

function createTransportLossCases(): ConformanceCase[] {
  return [
    {
      name: 'mock transport_loss',
      kind: 'mock',
      createClient: () => new AuroraClient({ transport: MockAuroraTransport.empty().lose('Gateway.GetRegistry') })
    },
    {
      name: 'HTTP transport_loss',
      kind: 'http',
      createClient: () =>
        new AuroraClient({
          transport: new HttpGatewayTransport({
            baseUrl: 'http://aurora.local',
            fetchImpl: async () => {
              throw new TypeError('fetch failed')
            }
          })
        })
    },
    {
      name: 'Tauri transport_loss',
      kind: 'tauri-local',
      createClient: () =>
        new AuroraClient({
          transport: new TauriLocalTransport({
            invoke: async () => {
              throw new TypeError('ipc closed')
            }
          })
        })
    },
    {
      name: 'mesh transport_loss',
      kind: 'mesh',
      createClient: () =>
        new AuroraClient({
          transport: new MeshP2PTransport({
            defaultPeerId: 'peer-conformance',
            bridge: {
              async call() {
                throw new TypeError('DataChannel closed')
              }
            }
          })
        })
    }
  ]
}

function conformanceResponse(method: string): unknown {
  switch (method as ConformanceMethod) {
    case 'Gateway.GetRegistry':
      return cloneFixture(gatewayRegistryFixture)
    case 'Gateway.GetServices':
      return cloneFixture(defaultMockAuroraFixtures.services)
    case 'Gateway.GetDeploymentTopology':
      return cloneFixture(deploymentTopologyFixture)
    case 'Gateway.GetWebRTCDiagnostics':
      return cloneFixture(webrtcDiagnosticsFixture)
    case 'Gateway.GetCapabilityCatalog':
      return cloneFixture(capabilityGraphCatalogFixture)
    case 'Gateway.ExplainRoute':
      return cloneFixture(routeExplainFixture)
    case 'Tooling.GetToolCatalog':
      return cloneFixture(toolCatalogFixture)
    case 'Native.GetCapabilityManifest':
      return cloneFixture(nativeCapabilityManifestFixture)
    default:
      throw new Error(`No conformance fixture for ${method}`)
  }
}

function hasConformanceResponse(method: string): method is ConformanceMethod {
  return [
    'Gateway.GetRegistry',
    'Gateway.GetServices',
    'Gateway.GetDeploymentTopology',
    'Gateway.GetWebRTCDiagnostics',
    'Gateway.GetCapabilityCatalog',
    'Gateway.ExplainRoute',
    'Tooling.GetToolCatalog',
    'Native.GetCapabilityManifest'
  ].includes(method)
}

function methodFromUrl(url: string): ConformanceMethod | null {
  const path = new URL(url).pathname
  switch (path) {
    case '/api/registry':
    case '/api/Gateway/GetRegistry':
      return 'Gateway.GetRegistry'
    case '/api/services':
    case '/api/Gateway/GetServices':
      return 'Gateway.GetServices'
    case '/api/Gateway/GetDeploymentTopology':
      return 'Gateway.GetDeploymentTopology'
    case '/api/Gateway/GetWebRTCDiagnostics':
      return 'Gateway.GetWebRTCDiagnostics'
    case '/api/Gateway/GetCapabilityCatalog':
      return 'Gateway.GetCapabilityCatalog'
    case '/api/Gateway/ExplainRoute':
      return 'Gateway.ExplainRoute'
    case '/api/Tooling/GetToolCatalog':
      return 'Tooling.GetToolCatalog'
    case '/api/Native/GetCapabilityManifest':
      return 'Native.GetCapabilityManifest'
    default:
      return null
  }
}

function readTauriRequest(args: Record<string, unknown> | undefined): AuroraTransportRequest {
  const request = args?.request
  if (typeof request !== 'object' || request === null || Array.isArray(request) || !('method' in request)) {
    throw new Error('Tauri conformance request missing method')
  }
  return request as AuroraTransportRequest
}

function httpStatusFor(code: AuroraErrorCode): number {
  switch (code) {
    case 'auth':
      return 401
    case 'permission':
      return 403
    case 'validation':
      return 422
    case 'timeout':
      return 504
    case 'unavailable_service':
      return 503
    case 'unsupported_feature':
    case 'privacy_blocked':
    case 'native_permission_missing':
      return 428
    default:
      return 500
  }
}

function httpErrorDetail(code: AuroraErrorCode): { code: AuroraErrorCode; message: string } {
  return { code, message: code.replaceAll('_', ' ') }
}
