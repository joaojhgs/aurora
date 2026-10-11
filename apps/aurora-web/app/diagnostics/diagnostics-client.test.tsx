// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouteAvailability } from '@aurora/ui'
import { AuroraQueryProvider, createAuroraQueryClient } from '@aurora/ui/query'
import { BrowserShellRuntimeProvider } from '../browser-shell-runtime'
import { DiagnosticsClientPage } from './diagnostics-client'

vi.mock('@aurora/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aurora/ui')>()
  return {
    ...actual,
    MeshDiagnosticsView: () => <section aria-label="Trusted device details" />,
    meshDiagnosticsSnapshotFromResults: vi.fn(() => ({})),
  }
})

describe('DiagnosticsClientPage', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('loads privileged diagnostics from the hydrated browser runtime client', async () => {
    const client = createDiagnosticsClient()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider runtime={{ client } as never} snapshot={{ routes: [] } as never}>
          <DiagnosticsClientPage diagnosticsRoute={diagnosticsRoute()} />
        </BrowserShellRuntimeProvider>,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(client.registry.listServices).toHaveBeenCalledTimes(1)
    expect(client.registry.listServices).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(client.registry.getDeploymentTopology).toHaveBeenCalledTimes(1)
    expect(client.registry.getDeploymentTopology).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(1)
    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(client.mesh.getStatus).toHaveBeenCalledTimes(1)
    expect(client.mesh.getStatus).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
    expect(client.capabilities.listCatalog).toHaveBeenCalledWith({
      include_unavailable: true,
      include_internal: true,
    }, { signal: expect.any(AbortSignal) })
    expect(client.routes.explain).toHaveBeenCalledWith({
      topic: 'Tooling.ExecuteTool',
      include_candidates: true,
    }, { signal: expect.any(AbortSignal) })
    expect(container.textContent).toContain('Support')
    expect(container.textContent).not.toContain('ADM-009')
  })

  it('renders without a hydrated browser runtime and does not require a client', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(<DiagnosticsClientPage diagnosticsRoute={diagnosticsRoute()} />)
    })

    expect(container.textContent).toContain('Support')
    expect(container.textContent).toContain('Unavailable')
  })

  it('does not read diagnostics while the route is denied', async () => {
    const client = createDiagnosticsClient()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider runtime={{ client } as never} snapshot={{ routes: [] } as never}>
          <DiagnosticsClientPage diagnosticsRoute={{ ...diagnosticsRoute(), disabled: true, routeable: false, state: 'denied' }} />
        </BrowserShellRuntimeProvider>,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(client.registry.listServices).not.toHaveBeenCalled()
    expect(client.registry.getDeploymentTopology).not.toHaveBeenCalled()
    expect(client.registry.getWebRTCDiagnostics).not.toHaveBeenCalled()
    expect(client.mesh.getStatus).not.toHaveBeenCalled()
    expect(client.capabilities.listCatalog).not.toHaveBeenCalled()
    expect(client.routes.explain).not.toHaveBeenCalled()
  })

  it('reads diagnostics again when the signed-in principal changes', async () => {
    const client = createDiagnosticsClient({ principalId: 'principal-before' })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider runtime={{ client } as never} snapshot={{ routes: [] } as never}>
          <DiagnosticsClientPage diagnosticsRoute={diagnosticsRoute()} />
        </BrowserShellRuntimeProvider>,
      )
    })
    await act(async () => {
      await Promise.resolve()
    })
    const initialReads = client.registry.listServices.mock.calls.length

    await act(async () => {
      client.setPrincipal('principal-after')
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(initialReads).toBeGreaterThan(0)
    expect(client.registry.listServices.mock.calls.length).toBeGreaterThan(initialReads)
  })

  it('uses the surrounding Aurora query scope for diagnostics reads', async () => {
    const client = createDiagnosticsClient()
    const queryClient = createAuroraQueryClient()
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    const renderWithProfile = (profileId: string) => (
      <AuroraQueryProvider
        client={client as never}
        queryClient={queryClient}
        queryScope={{ backend: 'http', peerId: 'peer-1', profileId }}
      >
        <BrowserShellRuntimeProvider runtime={{ client } as never} snapshot={{ routes: [] } as never}>
          <DiagnosticsClientPage diagnosticsRoute={diagnosticsRoute()} />
        </BrowserShellRuntimeProvider>
      </AuroraQueryProvider>
    )

    await act(async () => {
      root.render(renderWithProfile('profile-before'))
    })
    await act(async () => {
      await Promise.resolve()
    })
    const initialReads = client.registry.listServices.mock.calls.length

    await act(async () => {
      root.render(renderWithProfile('profile-after'))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(initialReads).toBeGreaterThan(0)
    expect(client.registry.listServices.mock.calls.length).toBeGreaterThan(initialReads)
  })
})

function createDiagnosticsClient(options: { principalId?: string } = {}) {
  let principalId = options.principalId ?? 'principal-1'
  const listeners = new Set<() => void>()
  return {
    transport: { kind: 'http' },
    auth: {
      snapshot: vi.fn(() => ({
        state: 'authenticated',
        principalId,
        deviceId: 'device-1',
        peerId: 'peer-1',
        credentialKind: 'token',
        source: 'test',
        tokenExpiresAt: null,
        status: 200,
        isAdmin: true,
        effectivePermissions: ['admin.diagnostics'],
      })),
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }),
    },
    setPrincipal: (nextPrincipalId: string) => {
      principalId = nextPrincipalId
      listeners.forEach((listener) => listener())
    },
    registry: {
      listServices: vi.fn(async () => ({ services: [] })),
      getDeploymentTopology: vi.fn(async () => ({
        bullmq_queue_health: { status: 'disabled' },
        mode_capability_degradations: [],
        secrets_redacted: true,
      })),
      getWebRTCDiagnostics: vi.fn(async () => ({
        started: true,
        connected_peer_count: 1,
        app_layer_e2ee_enabled: true,
        secrets_redacted: true,
      })),
    },
    mesh: {
      getStatus: vi.fn(async () => ({ ok: true, data: { peers: [], sessions: [] } })),
    },
    capabilities: {
      listCatalog: vi.fn(async () => ({
        providers: [],
        actions: [],
        secrets_redacted: true,
      })),
    },
    routes: {
      explain: vi.fn(async () => ({ blockers: [] })),
    },
  }
}

function diagnosticsRoute(): RouteAvailability {
  return {
    item: {
      id: 'diagnostics',
      label: 'Diagnostics',
      href: '/diagnostics',
      capabilityModule: 'Gateway',
      capabilityMethod: 'GetSupportBundle',
      methodType: 'manage',
      privacyClass: 'admin-critical',
      fallbackState: 'unsupported',
      expectedTask: 'Review diagnostics',
    },
    state: 'available-local',
    explanation: 'Ready',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}
