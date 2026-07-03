import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  type GetRegistryResponse,
  type ToolCatalogResponse
} from '@aurora/client'
import {
  AdminPluginsView,
  buildAdminPluginsSnapshot
} from '../src/admin-plugins-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

describe('AdminPluginsView', () => {
  it('renders plugin/MCP catalog health, provider status, errors, logs, and AdminAction-ready reload only with route status', async () => {
    const client = new Aurora({
      transport: pluginsTransport(liveRegistryFixture())
    })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const markup = renderToStaticMarkup(
      <AdminPluginsView
        client={client}
        route={pluginsRoute()}
        initialSnapshot={snapshot}
      />
    )

    expect(snapshot.loadState).toBe('ready')
    expect(
      snapshot.tools.map((tool) => [
        tool.id,
        tool.providerGroup,
        tool.enabledState,
        tool.healthState
      ])
    ).toEqual([
      ['plugin.local.weather', 'local-plugin', 'enabled', 'available-local'],
      [
        'mcp.remote.calendar',
        'remote-peer-plugin-mcp',
        'read-only-remote',
        'available-remote'
      ],
      ['plugin.stale.notes', 'unavailable-stale', 'disabled', 'stale']
    ])
    expect(snapshot.tools[2]?.providerErrors).toContain(
      'provider process exited'
    )
    expect(snapshot.tools[0]?.providerLogs).toContain(
      'correlation=corr-weather'
    )
    expect(snapshot.tools[1]?.providerLogs).toContain(
      'audit=audit-calendar-001'
    )

    const reload = snapshot.actions.find(
      (action) => action.id === 'reload-plugins'
    )
    expect(reload).toMatchObject({
      available: true,
      repairState: 'admin-action-ready',
      routePath: '/api/Tooling/ReloadPlugins'
    })
    expect(snapshot.actions.every((action) => action.available)).toBe(true)

    expect(markup).toContain('Plugins, MCP, and tools')
    expect(markup).toContain('Local plugin')
    expect(markup).toContain('Remote peer plugin/MCP')
    expect(markup).toContain('Unavailable or stale provider')
    expect(markup).toContain('Health')
    expect(markup).toContain('enabled')
    expect(markup).toContain('read-only-remote')
    expect(markup).toContain('disabled: provider process exited')
    expect(markup).toContain('Errors: provider process exited')
    expect(markup).toContain('Provider logs')
    expect(markup).toContain('correlation=corr-weather')
    expect(markup).toContain('audit-calendar-001')
    expect(markup).toContain(
      'Available through a real Gateway route after AdminAction draft/confirm/audit.'
    )
    expect(markup).toContain('/api/Tooling/ReloadPlugins')
  })

  it('keeps reload disabled in explicit missing-contract repair state when backend does not advertise a route', async () => {
    const registry = liveRegistryFixture().modules.map((module) => ({
      ...module,
      methods: module.methods.filter(
        (method) => method.bus_topic !== 'Tooling.ReloadPlugins'
      )
    }))
    const client = new Aurora({
      transport: pluginsTransport({
        ...liveRegistryFixture(),
        modules: registry
      })
    })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const markup = renderToStaticMarkup(
      <AdminPluginsView
        client={client}
        route={pluginsRoute()}
        initialSnapshot={snapshot}
      />
    )

    const reload = snapshot.actions.find(
      (action) => action.id === 'reload-plugins'
    )
    expect(reload).toMatchObject({
      available: false,
      repairState: 'missing-contract',
      routePath: null
    })
    expect(reload?.reason).toContain('repair the backend contract')
    expect(markup).toContain('Repair state: missing-contract')
    expect(markup).toContain(
      'Tooling.ReloadPlugins is not advertised by Gateway registry'
    )
    expect(markup).toContain('disabled=""')
  })

  it('keeps reload disabled when a contract exists without AdminAction gateway support', async () => {
    const registry = liveRegistryFixture().modules.map((module) => ({
      ...module,
      methods: module.methods.filter(
        (method) => !(method.bus_topic ?? '').startsWith('Gateway.AdminAction')
      )
    }))
    const client = new Aurora({
      transport: pluginsTransport({
        ...liveRegistryFixture(),
        modules: registry
      })
    })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())

    expect(
      snapshot.actions.find((action) => action.id === 'reload-plugins')
    ).toMatchObject({
      available: false,
      repairState: 'missing-admin-action'
    })
  })
})

function pluginsRoute(): RouteAvailability {
  const item = auroraNavSections
    .flatMap((section) => section.items)
    .find((candidate) => candidate.id === 'plugins')
  if (!item) throw new Error('plugins route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Tooling catalog route available from mock status.',
    providerLabel: 'mock Tooling.GetToolCatalog',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Tooling.GetToolCatalog', 'Gateway.GetRegistry'],
    selectorRequired: false,
    approvalRequired: true,
    routeable: true,
    disabled: false,
    requiresAdminAction: true
  }
}

function pluginsTransport(registry: GetRegistryResponse): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Tooling.GetToolCatalog', () => toolCatalogFixture())
    .register('Gateway.GetRegistry', () => registry)
}

function liveRegistryFixture(): GetRegistryResponse {
  return {
    digest: 'plugins-registry',
    service_count: 2,
    method_count: 6,
    modules: [
      {
        module: 'Tooling',
        version: '9.9.9',
        summary: 'Tooling service from test transport',
        capabilities: ['catalog', 'plugins'],
        methods: [
          method(
            'Tooling.GetToolCatalog',
            'GetToolCatalog',
            'use',
            '/api/Tooling/GetToolCatalog'
          ),
          method(
            'Tooling.ReloadPlugins',
            'ReloadPlugins',
            'manage',
            '/api/Tooling/ReloadPlugins'
          ),
          method(
            'Tooling.InstallPlugin',
            'InstallPlugin',
            'manage',
            '/api/Tooling/InstallPlugin'
          ),
          method(
            'Tooling.UpdateToolSharingPolicy',
            'UpdateToolSharingPolicy',
            'manage',
            '/api/Tooling/UpdateToolSharingPolicy'
          )
        ]
      },
      {
        module: 'Gateway',
        version: '9.9.9',
        summary: 'Gateway AdminAction controller',
        capabilities: ['admin-action'],
        methods: [
          method(
            'Gateway.AdminActionDraft',
            'AdminActionDraft',
            'manage',
            '/api/Gateway/AdminActionDraft'
          ),
          method(
            'Gateway.AdminActionConfirm',
            'AdminActionConfirm',
            'manage',
            '/api/Gateway/AdminActionConfirm'
          )
        ]
      }
    ]
  }
}

function method(
  busTopic: string,
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
    required_perms: [`${busTopic}.use`],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' }
  }
}

function toolCatalogFixture(): ToolCatalogResponse {
  return {
    generated_at: '2026-07-02T00:00:00Z',
    secrets_redacted: true,
    tools: [
      {
        global_tool_id: 'plugin.local.weather',
        display_name: 'Weather plugin',
        description: 'Local plugin provider.',
        provider_label: 'Local plugin host',
        provider_peer_id: 'local-peer',
        service_instance_id: 'tooling-local-1',
        provider_kind: 'plugin',
        transport: 'local',
        route_path: ['/api/Tooling/ExecuteTool'],
        risk_class: 'standard',
        approval_required: false,
        mutating: false,
        correlation_id: 'corr-weather',
        policy_decision_id: 'policy-weather',
        providers: [
          {
            id: 'local-plugin-host',
            label: 'Local plugin host',
            provider_peer_id: 'local-peer',
            service_instance_id: 'tooling-local-1',
            provider_kind: 'plugin',
            transport: 'local',
            selectable: true,
            reason: 'healthy plugin host heartbeat'
          }
        ]
      },
      {
        global_tool_id: 'mcp.remote.calendar',
        display_name: 'Calendar MCP',
        description: 'Remote MCP provider.',
        provider_label: 'Peer calendar MCP',
        provider_peer_id: 'peer-b',
        service_instance_id: 'mcp-calendar-1',
        provider_kind: 'mesh',
        transport: 'mcp',
        route_path: ['/mesh/peer-b/tools/calendar'],
        risk_class: 'sensitive',
        approval_required: true,
        requested_approval_scope: 'session',
        approval_status: 'approved',
        result: {
          status: 'success',
          ok: true,
          audit_receipt: 'audit-calendar-001',
          redaction_status: 'redacted',
          duration_ms: 42
        },
        providers: [
          {
            id: 'peer-calendar',
            label: 'Peer calendar MCP',
            provider_peer_id: 'peer-b',
            service_instance_id: 'mcp-calendar-1',
            provider_kind: 'mesh',
            transport: 'mcp',
            selectable: true,
            reason: 'remote peer is healthy'
          }
        ]
      },
      {
        global_tool_id: 'plugin.stale.notes',
        display_name: 'Notes plugin',
        description: 'Stale plugin provider.',
        provider_label: 'Stale notes plugin',
        provider_peer_id: 'local-peer',
        service_instance_id: 'notes-plugin-1',
        provider_kind: 'plugin',
        transport: 'local',
        risk_class: 'admin-critical',
        disabled_reason: 'provider process exited',
        providers: [
          {
            id: 'notes-plugin',
            label: 'Stale notes plugin',
            provider_peer_id: 'local-peer',
            service_instance_id: 'notes-plugin-1',
            provider_kind: 'plugin',
            transport: 'local',
            selectable: false,
            reason: 'provider process exited'
          }
        ]
      }
    ]
  }
}
