// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  normalizeSchedulerJob,
  normalizeToolCatalog,
  schedulerJobsFixture,
  toolCatalogFixture,
} from '@aurora/client'
import {
  ToolApprovalPanel,
  auroraNavSections,
  buildToolingPolicySummary,
  buildToolingSources,
  navItemSnapshot,
  type RouteAvailability,
  type ToolApprovalPanelManagementState,
} from '../src'

const sourceLifecycleDefaults = {
  retainedToolCount: 0,
  inactiveToolCount: 0,
  availabilityCounts: {},
  removedAt: null,
  sharedByPolicy: false,
  reasonCode: null,
  reason: null,
}

function toolsRoute(): RouteAvailability {
  const toolsItem = auroraNavSections.flatMap((section) => section.items).find((item) => item.id === 'tools')
  if (!toolsItem) throw new Error('missing tools nav item')
  return {
    item: navItemSnapshot(toolsItem),
    state: 'available-local',
    explanation: 'Local Tooling.GetToolCatalog and Scheduler.ListJobs are routeable.',
    providerLabel: 'local / Tooling.GetToolCatalog',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Tooling.GetToolCatalog', 'Scheduler.ListJobs'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}


function managementState(): ToolApprovalPanelManagementState {
  const generatedAt = '2026-07-06T00:00:00.000Z'
  return {
    policySummary: {
      mode: 'enforce',
      defaultApprovalMode: 'ask_each_time',
      defaultShare: false,
      defaultTokenTtlSeconds: 300,
      dryRunOnly: false,
      denyAll: false,
      unrestrictedExceptBlocked: false,
      ruleCount: 4,
      activeGrantCount: 2,
      pendingApprovalCount: 4,
      sourceCount: 5,
      blockedSourceCount: 1,
      blockedToolCount: 1,
      toolCount: toolCatalogFixture.tools.length,
      mcpServerCount: 1,
      activeMcpServerCount: 1,
      lastPolicyChangeActor: 'admin',
      lastPolicyChangeAt: generatedAt,
      lastPolicyCorrelationId: 'corr-policy',
      secretsRedacted: true,
    },
    sourceSummaries: [
      { ...sourceLifecycleDefaults, id: 'local:core', kind: 'core', label: 'Core tools', providerPeerId: 'local', providerServiceInstanceId: 'local:Tooling', providerKind: 'local', transport: 'local-bus', trustTier: 'trusted', status: 'active', toolCount: 2, blockedToolCount: 0, approvalRequiredCount: 0, newOrReviewCount: 0, activeGrantCount: 1, staleGrantCount: 0, includeFutureTools: false, cacheStatus: 'local catalog', catalogEpoch: null, catalogHash: null, generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { ...sourceLifecycleDefaults, id: 'local:mcp:mail', kind: 'mcp', label: 'MCP servers', providerPeerId: 'local', providerServiceInstanceId: 'mcp-mail', providerKind: 'local', transport: 'mcp', trustTier: 'untrusted', status: 'stale', toolCount: 1, blockedToolCount: 1, approvalRequiredCount: 1, newOrReviewCount: 1, activeGrantCount: 0, staleGrantCount: 1, includeFutureTools: false, cacheStatus: 'stale grant / missing grant', catalogEpoch: 3, catalogHash: 'hash-mcp-mail', generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { ...sourceLifecycleDefaults, id: 'local:plugin:weather', kind: 'plugin', label: 'Plugins', providerPeerId: 'local', providerServiceInstanceId: 'plugins', providerKind: 'plugin', transport: 'local-bus', trustTier: 'untrusted', status: 'needs-review', toolCount: 0, blockedToolCount: 0, approvalRequiredCount: 0, newOrReviewCount: 0, activeGrantCount: 0, staleGrantCount: 0, includeFutureTools: false, cacheStatus: 'plugin onboarding', catalogEpoch: null, catalogHash: null, generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { ...sourceLifecycleDefaults, id: 'mesh:peer-garage:tooling-garage', kind: 'mesh_peer', label: 'Mesh peers', providerPeerId: 'peer-garage', providerServiceInstanceId: 'tooling-garage', providerKind: 'mesh_peer', transport: 'webrtc', trustTier: 'untrusted', status: 'needs-review', toolCount: 1, blockedToolCount: 0, approvalRequiredCount: 1, newOrReviewCount: 1, activeGrantCount: 1, staleGrantCount: 1, includeFutureTools: false, cacheStatus: 'negotiated catalog cache hit', catalogEpoch: 7, catalogHash: 'hash-peer-garage', generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { ...sourceLifecycleDefaults, id: 'unknown:quarantine', kind: 'unknown', label: 'Unknown sources', providerPeerId: null, providerServiceInstanceId: null, providerKind: 'unknown', transport: null, trustTier: 'unknown', status: 'unknown', toolCount: 0, blockedToolCount: 0, approvalRequiredCount: 0, newOrReviewCount: 0, activeGrantCount: 0, staleGrantCount: 0, includeFutureTools: false, cacheStatus: 'quarantine', catalogEpoch: null, catalogHash: null, generatedAt, lastAnnouncementAt: null, secretsRedacted: true },
    ],
    sourceDetails: {},
    grants: [],
    pendingApprovals: [],
    auditEvents: [{ id: 'audit-1', event: 'tooling.policy.set', principalId: 'admin', toolId: null, providerId: null, route: 'Tooling.SetPolicyMode', createdAt: generatedAt, action: 'recorded', correlationId: 'corr-policy', policyDecisionId: 'policy-1', peerId: null, secretsRedacted: true, details: {}, raw: {} }],
    managementLoading: false,
    managementError: null,
  }
}

function renderToolsPanel(nativePlatform?: string) {
  const client = new Aurora({ transport: new MockAuroraTransport() })
  const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
  const schedulerJobs = schedulerJobsFixture.jobs.map(normalizeSchedulerJob)
  return renderToStaticMarkup(
    <ToolApprovalPanel
      client={client}
      route={toolsRoute()}
      initialTools={tools}
      initialSchedulerJobs={schedulerJobs}
      nativePlatform={nativePlatform}
      initialManagementState={managementState()}
    />,
  )
}

describe('source-first Tooling console', () => {
  it('shows authoritative loading states without transient catalog-derived source groups', () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
    const markup = renderToStaticMarkup(
      <ToolApprovalPanel
        client={client}
        route={toolsRoute()}
        initialTools={tools}
        initialSchedulerJobs={[]}
        initialManagementState={{
          sourceSummaries: [],
          sourceDetails: {},
          managementLoading: true,
          sharingLoading: true,
        }}
      />,
    )
    const host = document.createElement('div')
    host.innerHTML = markup

    expect(markup).toContain('Policy loading')
    expect(markup).toContain('Sources loading')
    expect(markup).toContain('Loading tool sources')
    expect(host.querySelectorAll('[aria-label="Tool sources"] button')).toHaveLength(0)
    expect(host.textContent).not.toContain('No sources match this search.')
  })

  it('derives source rail groups and policy from SDK catalog state', () => {
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: 'mock' })
    const sources = buildToolingSources(tools)
    const policy = buildToolingPolicySummary(tools, sources)

    expect(sources.map((source) => source.type)).toEqual(expect.arrayContaining(['core', 'mcp', 'mesh']))
    expect(sources.find((source) => source.type === 'mesh')?.catalogEvidence).toBe('audit.mesh.hardware')
    expect(policy.mode).toBe('dry_run_only')
    expect(policy.pendingApprovalCount).toBeGreaterThan(0)
  })

  it('defaults source approval controls to inherit when no explicit source policy exists', () => {
    const host = document.createElement('div')
    host.innerHTML = renderToolsPanel()
    const control = host.querySelector('[aria-label="Trust policy for Core tools"]')
    expect(control).not.toBeNull()
    const inherit = [...(control?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Inherit',
    )
    expect(inherit?.getAttribute('aria-pressed')).toBe('true')
  })

  it('groups local tools by backend share group IDs and keeps equal MCP names in distinct stable groups', () => {
    const tools = normalizeToolCatalog({
      tools: [
        {
          global_tool_id: 'aurora-tool:v1:peer-local:Tooling:mcp.mail-a.search',
          display_name: 'Search', source: 'mcp', provider_kind: 'mcp', provider_peer_id: 'local-peer',
          service_instance_id: 'session-that-may-change', source_id: 'mutable-source-a',
          share_group_id: 'mcp:server-a', share_group_label: 'Mail server', exportable: true
        },
        {
          global_tool_id: 'aurora-tool:v1:peer-local:Tooling:mcp.mail-a.send',
          display_name: 'Send', source: 'mcp', provider_kind: 'mcp', provider_peer_id: 'local-peer',
          service_instance_id: 'different-session', source_id: 'mutable-source-b',
          share_group_id: 'mcp:server-a', share_group_label: 'Mail server renamed', exportable: true
        },
        {
          global_tool_id: 'aurora-tool:v1:peer-local:Tooling:mcp.mail-b.search',
          display_name: 'Search', source: 'mcp', provider_kind: 'mcp', provider_peer_id: 'local-peer',
          service_instance_id: 'same-visible-name', source_id: 'mutable-source-a',
          share_group_id: 'mcp:server-b', share_group_label: 'Mail server', exportable: true
        },
        {
          global_tool_id: 'aurora-tool:v1:peer-remote:Tooling:mcp.mail-a.search',
          display_name: 'Search', source: 'mesh_peer', provider_kind: 'mesh_peer', provider_peer_id: 'peer-remote',
          service_instance_id: 'boot-session', share_group_id: 'mcp:server-a', share_group_label: 'Mail server', exportable: true
        }
      ],
      secrets_redacted: true
    })
    const sources = buildToolingSources(tools)

    expect(sources.find((source) => source.id === 'mcp:server-a')?.tools).toHaveLength(2)
    expect(sources.find((source) => source.id === 'mcp:server-a')?.name).toBe('Mail server')
    expect(sources.find((source) => source.id === 'mcp:server-b')?.tools).toHaveLength(1)
    expect(sources.find((source) => source.id === 'mesh:peer-remote:mcp:server-a')?.exportable).toBe(false)
    expect(tools.find((tool) => tool.providerPeerId === 'peer-remote')?.exportable).toBe(false)
  })

  it('renders the Visual Ralph P0 Tools & Plugins prototype shell without policy-console copy', () => {
    const markup = renderToolsPanel('android')

    expect(markup).toContain('Tools &amp; Plugins')
    expect(markup).toContain('Review tool sources, choose what needs approval, and add MCP servers or plugins.')
    expect(markup).toContain('Policy:')
    expect(markup).not.toContain('2 pending')
    expect(markup).toContain('Add MCP source')
    expect(markup).toContain('Tools')
    expect(markup).toContain('Plugins')
    expect(markup).toContain('Core tools')
    expect(markup).toContain('MCP servers')
    expect(markup).toContain('Mesh peers')
    expect(markup).toMatch(/<th[^>]*>Tool<\/th>\s*<th[^>]*>Risk<\/th>\s*<th[^>]*>Policy<\/th>\s*<th[^>]*>State<\/th>/)
    expect(markup).not.toContain('Global policy console')
    expect(markup).not.toContain('Grants')
    expect(markup).not.toContain('Approvals')
    expect(markup).not.toContain('Scheduler')
    expect(markup).not.toContain('Audit')
    expect(markup).not.toContain('Onboarding')
    expect(markup).not.toMatch(/Evidence|Demo|Unavailable|Unsupported/)
  })

})
