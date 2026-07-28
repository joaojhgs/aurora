import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport, type ToolCatalogResponse } from '@aurora/client'
import { AdminPluginsView, buildAdminPluginsSnapshot, type AdminPluginsSnapshot } from '../src/admin-plugins-view'
import { auroraEmbeddedNavItems, auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

describe('AdminPluginsView', () => {
  it('wires Tooling sources, policy, and fallback tools from Aurora for the Tools & Plugins screen', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.policy.mode).toBe('enforce')
    expect(snapshot.policy.pendingApprovalCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.sourceSummaries.length).toBeGreaterThan(0)
    expect(snapshot.fallbackTools.length).toBeGreaterThan(0)

    const markup = renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} />)

    expect(markup).toContain('Tools &amp; Plugins')
    expect(markup).toContain('Policy:')
    expect(markup).toContain('enforce')
    expect(markup).toContain('pending')
    expect(markup).toContain('Add MCP source')
    expect(markup).toContain('Tools')
    expect(markup).toContain('Plugins')
    expect(markup).toContain('Core tools')
    expect(markup).toContain('MCP servers')
    expect(markup).toContain('Mesh peers')
    expect(markup).toContain('diagnostics.serviceHealth')
  })

  it('renders unconfigured plugin templates as Configure cards in the Plugins tab', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const markup = renderToStaticMarkup(
      <AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} initialTab="plugins" />
    )

    // Default fixtures report no `plugin`-kind sources, so both onboarding
    // templates should render as unconfigured "Configure" cards.
    expect(markup).toContain('notion-plugin')
    expect(markup).toContain('home-assistant-plugin')
    expect(markup).toContain('Configure')
  })

  it('shows permission-blocked peer tools as stable, disabled management rows without adding them to bindable fallback tools', async () => {
    const stablePeerId = 'aurora-da2c3842004492c887b3ce878c8eb0cb'
    const stableToolId = `${stablePeerId}:remote_${stablePeerId}_Tooling:tool:list_scheduled_tasks_tool`
    const stableSourceId = `mesh:${stablePeerId}:remote_${stablePeerId}_Tooling`
    const catalog: ToolCatalogResponse = {
      tools: [],
      blocked_tools: [{
        reason_code: 'permission_denied',
        reason: 'caller principal lacks required tool permissions',
        missing_permissions: ['Scheduler.use'],
        tool: {
          global_tool_id: stableToolId,
          local_name: 'list_scheduled_tasks_tool',
          display_name: 'aurora-2.list_scheduled_tasks_tool',
          description: 'List scheduled tasks on aurora-2.',
          provider_label: 'aurora-2',
          provider_peer_id: stablePeerId,
          provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
          provider_kind: 'mesh_peer',
          source: 'mesh_peer',
          source_type: 'mesh_peer',
          source_id: stableSourceId,
          required_permissions: ['Scheduler.use']
        }
      }],
      providers: [{
        provider_peer_id: stablePeerId,
        provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
        provider_label: 'aurora-2',
        provider_kind: 'mesh_peer',
        eligible: true
      }],
      secrets_redacted: true
    }
    const transport = MockAuroraTransport.empty().register('Tooling.GetToolCatalog', () => catalog)
    const client = new Aurora({ transport })

    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const markup = renderToStaticMarkup(
      <AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} />
    )

    expect(snapshot.fallbackTools).toEqual([])
    expect(snapshot.sourceDetails[stableSourceId]?.blockedTools[0]).toMatchObject({
      id: stableToolId,
      providerPeerId: stablePeerId,
      state: 'unavailable',
      blockReasonCode: 'permission_denied'
    })
    expect(markup).toContain('aurora-2')
    expect(markup).toContain('aurora-2.list_scheduled_tasks_tool')
    expect(markup).toContain('Missing required permission: Scheduler.use.')
    expect(markup).toContain('Not callable from this peer.')
    expect(markup).toContain('missing permission')
    expect(markup).not.toContain(stablePeerId)
  })

  it('renders loading, empty, denied, service-unavailable, and route-disabled states', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={loadingSnapshot()} />)
    ).toContain('Loading Tooling catalog')

    const emptyTransport = MockAuroraTransport.empty()
      .register('Tooling.GetToolCatalog', () => ({ tools: [], secrets_redacted: true }))
      .register('Tooling.ListToolSources', () => ({ sources: [], count: 0, secrets_redacted: true }))
      .register('Tooling.GetSharingPolicy', () => ({ policy: { default_share: true, default_approval_mode: 'approve_all_local_safe', policy_mode: 'enforce', default_token_ttl_seconds: 300, rules: [] } }))
      .register('Tooling.ListApprovalGrants', () => ({ count: 0, grants: [] }))
      .register('Orchestrator.ListPendingToolApprovals', () => ({ count: 0, approvals: [] }))
      .register('Auth.AuditLog', () => ({ events: [], total: 0 }))
      .register('Tooling.GetMCPStatus', () => ({ started: false, servers: [], total_servers: 0, active_servers: 0 }))
    const emptySnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: emptyTransport }), pluginsRoute())
    expect(emptySnapshot.loadState).toBe('empty')
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={emptySnapshot} />)
    ).toContain('No tools are available from Aurora yet')

    const deniedTransport = MockAuroraTransport.empty().fail('Tooling.GetToolCatalog', 'permission', 'tool catalog denied')
    const deniedSnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: deniedTransport }), pluginsRoute())
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={deniedSnapshot} />)
    ).toContain('Permission is needed to use this feature')

    const unavailableTransport = MockAuroraTransport.empty().lose('Tooling.GetToolCatalog')
    const unavailableSnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: unavailableTransport }), pluginsRoute())
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')

    const disabledRoute: RouteAvailability = { ...pluginsRoute(), disabled: true, state: 'denied', blockers: ['missing:Tooling.manage'] }
    const disabledSnapshot = await buildAdminPluginsSnapshot(client, disabledRoute)
    expect(disabledSnapshot.loadState).toBe('denied')
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={disabledRoute} initialSnapshot={disabledSnapshot} />)
    ).toContain('Permission is needed to use this feature')
  })
})

function loadingSnapshot(): AdminPluginsSnapshot {
  return {
    loadState: 'loading' as const,
    policy: {
      mode: 'enforce',
      defaultBehavior: 'Loading Tooling policy through Aurora.',
      activeGrantCount: 0,
      pendingApprovalCount: 0,
      blockedCount: 0,
      sourceCount: 0,
      bypassEnabled: false,
      dryRunOnly: false,
      denyAll: false,
      lastChanged: 'not reported',
      actor: 'not reported',
      evidence: 'pending Aurora service calls'
    },
    sourceSummaries: [],
    sourceDetails: {},
    fallbackTools: [],
    warnings: [],
    error: null,
    evidenceSource: 'pending Aurora service calls'
  }
}

function pluginsRoute(): RouteAvailability {
  const item = [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems].find((candidate) => candidate.id === 'plugins')
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
