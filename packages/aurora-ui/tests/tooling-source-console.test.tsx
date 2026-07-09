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
      { id: 'local:core', kind: 'core', label: 'Core tools', providerPeerId: 'local', providerServiceInstanceId: 'local:Tooling', providerKind: 'local', transport: 'local-bus', trustTier: 'trusted', status: 'active', toolCount: 2, blockedToolCount: 0, approvalRequiredCount: 0, newOrReviewCount: 0, activeGrantCount: 1, staleGrantCount: 0, includeFutureTools: false, cacheStatus: 'local catalog', catalogEpoch: null, catalogHash: null, generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { id: 'local:mcp:mail', kind: 'mcp', label: 'MCP servers', providerPeerId: 'local', providerServiceInstanceId: 'mcp-mail', providerKind: 'local', transport: 'mcp', trustTier: 'untrusted', status: 'stale', toolCount: 1, blockedToolCount: 1, approvalRequiredCount: 1, newOrReviewCount: 1, activeGrantCount: 0, staleGrantCount: 1, includeFutureTools: false, cacheStatus: 'stale grant / missing grant', catalogEpoch: 3, catalogHash: 'hash-mcp-mail', generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { id: 'local:plugin:weather', kind: 'plugin', label: 'Plugins', providerPeerId: 'local', providerServiceInstanceId: 'plugins', providerKind: 'plugin', transport: 'local-bus', trustTier: 'untrusted', status: 'needs-review', toolCount: 0, blockedToolCount: 0, approvalRequiredCount: 0, newOrReviewCount: 0, activeGrantCount: 0, staleGrantCount: 0, includeFutureTools: false, cacheStatus: 'plugin onboarding', catalogEpoch: null, catalogHash: null, generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { id: 'mesh:peer-garage:tooling-garage', kind: 'mesh_peer', label: 'Mesh peers', providerPeerId: 'peer-garage', providerServiceInstanceId: 'tooling-garage', providerKind: 'mesh_peer', transport: 'webrtc', trustTier: 'untrusted', status: 'needs-review', toolCount: 1, blockedToolCount: 0, approvalRequiredCount: 1, newOrReviewCount: 1, activeGrantCount: 1, staleGrantCount: 1, includeFutureTools: false, cacheStatus: 'negotiated catalog cache hit', catalogEpoch: 7, catalogHash: 'hash-peer-garage', generatedAt, lastAnnouncementAt: generatedAt, secretsRedacted: true },
      { id: 'unknown:quarantine', kind: 'unknown', label: 'Unknown sources', providerPeerId: null, providerServiceInstanceId: null, providerKind: 'unknown', transport: null, trustTier: 'unknown', status: 'unknown', toolCount: 0, blockedToolCount: 0, approvalRequiredCount: 0, newOrReviewCount: 0, activeGrantCount: 0, staleGrantCount: 0, includeFutureTools: false, cacheStatus: 'quarantine', catalogEpoch: null, catalogHash: null, generatedAt, lastAnnouncementAt: null, secretsRedacted: true },
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
  it('derives source rail groups and policy from SDK catalog state', () => {
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: 'mock' })
    const sources = buildToolingSources(tools)
    const policy = buildToolingPolicySummary(tools, sources)

    expect(sources.map((source) => source.type)).toEqual(expect.arrayContaining(['core', 'mcp', 'mesh']))
    expect(sources.find((source) => source.type === 'mesh')?.catalogEvidence).toContain('Negotiated cache evidence')
    expect(policy.mode).toBe('dry_run_only')
    expect(policy.pendingApprovalCount).toBeGreaterThan(0)
  })

  it('renders the Visual Ralph P0 Tools & Plugins prototype shell without policy-console copy', () => {
    const markup = renderToolsPanel('android')

    expect(markup).toContain('Tools &amp; Plugins')
    expect(markup).toContain('Core tools, MCP servers, plugins and mesh peer tools, grouped by source with policy and approvals.')
    expect(markup).toContain('Policy:')
    expect(markup).toContain('2 pending')
    expect(markup).toContain('Add MCP source')
    expect(markup).toContain('Tools')
    expect(markup).toContain('Plugins')
    expect(markup).toContain('Core tools')
    expect(markup).toContain('MCP servers')
    expect(markup).toContain('Mesh peers')
    expect(markup).toMatch(/<th[^>]*>Tool<\/th>\s*<th[^>]*>Risk<\/th>\s*<th[^>]*>Calls<\/th>\s*<th[^>]*>State<\/th>/)
    expect(markup).not.toContain('Global policy console')
    expect(markup).not.toContain('Grants')
    expect(markup).not.toContain('Approvals')
    expect(markup).not.toContain('Scheduler')
    expect(markup).not.toContain('Audit')
    expect(markup).not.toContain('Onboarding')
    expect(markup).not.toMatch(/Evidence|Demo|Unavailable|Unsupported/)
  })

})
