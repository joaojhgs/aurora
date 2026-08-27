// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RouteAvailability } from '@aurora/ui'
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
    const client = {
      transport: { kind: 'http' },
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
    expect(client.registry.getDeploymentTopology).toHaveBeenCalledTimes(1)
    expect(client.registry.getWebRTCDiagnostics).toHaveBeenCalledTimes(1)
    expect(client.mesh.getStatus).toHaveBeenCalledTimes(1)
    expect(client.capabilities.listCatalog).toHaveBeenCalledWith({
      include_unavailable: true,
      include_internal: true,
    })
    expect(client.routes.explain).toHaveBeenCalledWith({
      topic: 'Tooling.ExecuteTool',
      include_candidates: true,
    })
  })
})

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
