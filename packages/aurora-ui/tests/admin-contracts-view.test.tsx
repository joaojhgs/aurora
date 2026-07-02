import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  capabilityCatalogFixture,
  cloneFixture,
  type CapabilityCatalogResponse,
  type GetRegistryResponse,
  type GetServicesResponse
} from '@aurora/client'
import { AdminServicesView, buildAdminServicesSnapshot } from '../src/index'

describe('admin contracts view', () => {
  it('renders /admin/contracts browser evidence from live SDK registry and capability catalog data', async () => {
    const transport = MockAuroraTransport.empty()
      .register('Gateway.GetServices', liveServicesFixture())
      .register('Gateway.GetRegistry', liveRegistryFixture())
      .register('Gateway.GetCapabilityCatalog', liveCapabilityCatalogFixture())

    const snapshot = await buildAdminServicesSnapshot(new AuroraClient({ transport }))
    const markup = renderToStaticMarkup(<AdminServicesView snapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.services.map((service) => service.module)).toEqual(['Weather'])
    expect(snapshot.contracts.map((contract) => contract.busTopic)).toEqual(['Weather.Forecast'])
    expect(snapshot.contracts[0]).toMatchObject({
      busTopic: 'Weather.Forecast',
      generatedRoutePath: '/api/Weather/Forecast',
      liveRegistryStatus: 'live-registry',
      conformanceStatus: 'conformant',
      capabilityPermissions: ['Weather.use']
    })
    expect(snapshot.contracts[0]?.exportEvidence).toContain('Gateway.GetCapabilityCatalog action weather-forecast')

    expect(markup).toContain('Contract registry browser grouped by service module with method detail controls')
    expect(markup).toContain('Search contracts')
    expect(markup).toContain('Service/module')
    expect(markup).toContain('Method detail')
    expect(markup).toContain('Weather module / 1 contracts')
    expect(markup).toContain('Weather.Forecast')
    expect(markup).toContain('/api/Weather/Forecast')
    expect(markup).toContain('OpenAPI/export evidence')
    expect(markup).toContain('Generated Gateway/OpenAPI path /api/Weather/Forecast')
    expect(markup).toContain('Live-registry status')
    expect(markup).toContain('Contract conformance')
    expect(markup).toContain('WeatherForecastRequest')
    expect(markup).toContain('WeatherForecastResponse')
    expect(markup).toContain('&quot;city&quot;')
    expect(markup).not.toContain('Gateway.GetServices')
    expect(markup).not.toContain('Auth.AuditLog')
  })
})

function liveServicesFixture(): GetServicesResponse {
  return {
    mode: 'processes',
    services: [
      {
        module: 'Weather',
        version: '9.9.9',
        summary: 'Live weather service from test transport',
        capabilities: ['forecast'],
        method_count: 1,
        last_seen: '2026-07-02T00:00:00Z',
        status: 'healthy',
        instance_id: 'weather-live-1'
      }
    ]
  }
}

function liveRegistryFixture(): GetRegistryResponse {
  return {
    digest: 'weather-live-registry',
    service_count: 1,
    method_count: 1,
    modules: [
      {
        module: 'Weather',
        version: '9.9.9',
        summary: 'Live weather service from test transport',
        capabilities: ['forecast'],
        methods: [
          {
            name: 'Forecast',
            summary: 'Fetch live forecast by city',
            bus_topic: 'Weather.Forecast',
            exposure: 'external',
            method_type: 'use',
            input_model: 'WeatherForecastRequest',
            output_model: 'WeatherForecastResponse',
            required_perms: ['Weather.use'],
            input_schema: {
              type: 'object',
              required: ['city'],
              properties: {
                city: { type: 'string' }
              }
            },
            output_schema: {
              type: 'object',
              properties: {
                temperature_c: { type: 'number' }
              }
            }
          }
        ]
      }
    ]
  }
}

function liveCapabilityCatalogFixture(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const provider = {
    ...catalog.providers[0]!,
    provider_id: 'local:Weather',
    provider_kind: 'local',
    module: 'Weather',
    version: '9.9.9',
    service_instance_id: 'weather-live-1',
    reason: 'Weather forecast is routeable from the live capability catalog.',
    policy: {
      ...catalog.providers[0]!.policy,
      required_permissions: ['Weather.use'],
      denial_reasons: []
    },
    freshness: {
      ...catalog.providers[0]!.freshness,
      stale: false,
      registry_digest: 'weather-live-registry'
    }
  }
  const action = {
    ...catalog.actions[0]!,
    action_id: 'weather-forecast',
    module: 'Weather',
    method: 'Forecast',
    topic: 'Weather.Forecast',
    provider_id: 'local:Weather',
    provider_kind: 'local',
    service_instance_id: 'weather-live-1',
    bindability: 'available',
    route_hints: ['/api/Weather/Forecast'],
    route_blockers: [],
    summary: 'Fetch live forecast by city',
    input_schema: {
      type: 'object',
      required: ['city'],
      properties: {
        city: { type: 'string' }
      }
    },
    output_schema: {
      type: 'object',
      properties: {
        temperature_c: { type: 'number' }
      }
    },
    policy: {
      ...catalog.actions[0]!.policy,
      required_permissions: ['Weather.use'],
      denial_reasons: [],
      safety_class: 'standard',
      operation_class: 'read'
    },
    freshness: {
      ...catalog.actions[0]!.freshness,
      stale: false,
      registry_digest: 'weather-live-registry'
    }
  }
  return {
    ...catalog,
    generated_at: '2026-07-02T00:00:00Z',
    providers: [provider],
    actions: [action],
    resources: [],
    provider_index: { Weather: ['local:Weather'] },
    action_index: { 'Weather.Forecast': ['weather-forecast'] },
    secrets_redacted: true
  }
}
