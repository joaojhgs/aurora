import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  capabilityCatalogFixture,
  cloneFixture,
  type CapabilityCatalogResponse,
  type GetRegistryResponse,
  type GetServicesResponse
} from '@aurora/client'
import { AdminServicesView, buildAdminServicesSnapshot } from '../src/admin-services-view'

describe('AdminServicesView', () => {
  it('renders prototype-density service cards with restart control', async () => {
    const snapshot = await buildAdminServicesSnapshot(new Aurora({ transport: servicesTransport() }))
    const config = snapshot.services.find((service) => service.module === 'Config')

    expect(snapshot.loadState).toBe('ready')
    expect(config?.controls.map((control) => [control.verb, control.methodId, control.available])).toEqual([
      ['restart', 'Supervisor.RestartService', false],
      ['reload', 'Config.ReloadService', true],
      ['stop', 'Supervisor.StopService', false]
    ])
    expect(config?.controls.find((control) => control.verb === 'reload')?.action).toMatchObject({
      title: 'Reload Config',
      methodId: 'Config.ReloadService',
      requiresReason: true
    })

    const markup = renderToStaticMarkup(<AdminServicesView snapshot={snapshot} />)
    expect(markup).toContain('Services')
    expect(markup).toContain('Backend service health and restart control. Admins only.')
    expect(markup).toContain('Config')
    expect(markup).toContain('Config service with reload control')
    expect(markup).toContain('1 methods')
    expect(markup).toContain('Restart')
    expect(markup).not.toContain('Details')
    expect(markup).not.toContain('Reload')
    expect(markup).not.toContain('Stop')
    expect(markup).not.toContain('Evidence')
    expect(markup).not.toContain('Demo')
  })
})

function servicesTransport(): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Gateway.GetServices', () => servicesFixture())
    .register('Gateway.GetRegistry', () => registryFixture())
    .register('Gateway.GetCapabilityCatalog', () => catalogFixture())
}

function servicesFixture(): GetServicesResponse {
  return {
    mode: 'processes',
    services: [
      {
        module: 'Config',
        version: '9.9.9',
        summary: 'Config service with reload control',
        capabilities: ['schema', 'reload'],
        method_count: 1,
        last_seen: '2026-07-02T00:00:00Z',
        status: 'healthy',
        instance_id: 'config-local-1'
      }
    ]
  }
}

function registryFixture(): GetRegistryResponse {
  return {
    digest: 'services-registry',
    service_count: 1,
    method_count: 1,
    modules: [
      {
        module: 'Config',
        version: '9.9.9',
        summary: 'Config service with reload control',
        capabilities: ['schema', 'reload'],
        methods: [method('Config.ReloadService', 'Config', 'ReloadService', 'manage', '/api/Config/ReloadService')]
      }
    ]
  }
}

function catalogFixture(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const provider = {
    ...catalog.providers[0]!,
    provider_id: 'local:Config',
    module: 'Config',
    service_instance_id: 'config-local-1',
    reason: 'Config reload is available through AdminAction.',
    policy: {
      ...catalog.providers[0]!.policy,
      required_permissions: ['Config.manage'],
      approval_required: true,
      operation_class: 'admin',
      safety_class: 'admin'
    },
    freshness: { ...catalog.providers[0]!.freshness, stale: false, registry_digest: 'services-registry' }
  }
  const action = {
    ...catalog.actions[0]!,
    action_id: 'config-reload',
    module: 'Config',
    method: 'ReloadService',
    topic: 'Config.ReloadService',
    provider_id: 'local:Config',
    service_instance_id: 'config-local-1',
    bindability: 'available',
    route_hints: ['/api/Config/ReloadService'],
    route_blockers: [],
    summary: 'Reload a service after configuration changes.',
    policy: provider.policy,
    freshness: provider.freshness
  }
  return {
    ...catalog,
    generated_at: '2026-07-02T00:00:00Z',
    providers: [provider],
    actions: [action],
    resources: [],
    provider_index: { Config: ['local:Config'] },
    action_index: { 'Config.ReloadService': ['config-reload'] },
    secrets_redacted: true
  }
}

function method(
  busTopic: string,
  module: string,
  name: string,
  methodType: 'use' | 'manage',
  routePath: string
) {
  return {
    name,
    summary: `${busTopic} test method`,
    bus_topic: busTopic,
    route_path: routePath,
    exposure: 'external' as const,
    method_type: methodType,
    input_model: `${name}Request`,
    output_model: `${name}Response`,
    required_perms: [`${module}.manage`],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' }
  }
}
