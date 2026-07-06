import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  normalizeSchedulerJob,
  normalizeToolCatalog,
  schedulerJobsFixture,
  toolCatalogFixture,
  type ToolCatalogResponse,
} from '@aurora/client'
import {
  ToolApprovalPanel,
  auroraNavSections,
  navItemSnapshot,
  type RouteAvailability,
  type ToolApprovalPanelManagementState,
} from '../src'

function toolsRoute(): RouteAvailability {
  const toolsItem = auroraNavSections
    .flatMap((section) => section.items)
    .find((item) => item.id === 'tools')
  if (!toolsItem) throw new Error('missing tools nav item')
  return {
    item: navItemSnapshot(toolsItem),
    state: 'available-local',
    explanation: 'Local Tooling routes are routeable.',
    providerLabel: 'local / Tooling.GetToolCatalog',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Tooling.GetPolicySummary', 'Tooling.ListToolSources', 'Scheduler.ListJobs'],
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

function renderToolingPage(catalog: ToolCatalogResponse = toolCatalogFixture) {
  const client = new Aurora({ transport: new MockAuroraTransport() })
  return renderToStaticMarkup(
    <ToolApprovalPanel
      client={client}
      route={toolsRoute()}
      initialTools={normalizeToolCatalog(catalog, { transportKind: client.transport.kind })}
      initialSchedulerJobs={schedulerJobsFixture.jobs.map(normalizeSchedulerJob)}
      initialManagementState={managementState()}
    />,
  )
}

describe('Tooling page production verification', () => {
  it('renders source-first control center instead of the old flat approval-card registry', () => {
    const markup = renderToolingPage()

    expect(markup).toContain('Tooling policy')
    expect(markup).toContain('Source catalog')
    expect(markup).toContain('Source detail')
    expect(markup).toContain('Core tools')
    expect(markup).toContain('MCP servers')
    expect(markup).toContain('Plugins')
    expect(markup).toContain('Mesh peers')
    expect(markup).toContain('Unknown / quarantined')
    expect(markup).toContain('Blocked')
    expect(markup).not.toContain('Tool registry and Approval cards')
  })

  it('exposes policy, durable grants, pending approvals, and audit surfaces backed by Tooling contracts', () => {
    const markup = renderToolingPage()

    expect(markup).toContain('Global policy mode')
    expect(markup).toContain('enforce')
    expect(markup).toContain('dry_run_only')
    expect(markup).toContain('deny_all')
    expect(markup).toContain('unrestricted_except_blocked')
    expect(markup).toContain('Durable grants')
    expect(markup).toContain('Pending approvals')
    expect(markup).toContain('Approve in Assistant')
    expect(markup).toContain('Activity and audit')
    expect(markup).toContain('correlation ID')
  })

  it('never renders raw secret-like catalog payloads even when a backend fixture includes one', () => {
    const catalogWithSecret: ToolCatalogResponse = {
      ...toolCatalogFixture,
      tools: [
        ...toolCatalogFixture.tools,
        {
          global_tool_id: 'tool:local:secret-preview',
          display_name: 'Secret preview tool',
          description: 'Exercises SDK/UI redaction for visible local tools.',
          provider_kind: 'local',
          provider_label: 'Core tools',
          trust_tier: 'untrusted',
          risk_class: 'external',
          approval_required: true,
          args_schema: { type: 'object', properties: { token: { type: 'string' } } },
          args_preview: { token: 'sk-live-secret-token', channel: '#ops' },
          secrets_redacted: false,
        },
      ],
      secrets_redacted: false,
    }

    const markup = renderToolingPage(catalogWithSecret)

    expect(markup).toContain('Secret preview tool')
    expect(markup).toMatch(/redacted/i)
    expect(markup).not.toContain('sk-live-secret-token')
  })

  it('shows mesh catalog staleness and scheduler grant dependency warnings without live peer fanout copy', () => {
    const markup = renderToolingPage()

    expect(markup).toContain('Negotiated catalog cache')
    expect(markup).toContain('epoch')
    expect(markup).toContain('hash')
    expect(markup).toContain('stale')
    expect(markup).toContain('removed / unshared')
    expect(markup).toContain('Grant dependency')
    expect(markup).toContain('stale grant')
    expect(markup).toContain('missing grant')
    expect(markup).toContain('/admin/scheduler')
    expect(markup).not.toContain('fetch tools from peer on page load')
  })

  it('includes mobile source drawer and surface-truthful onboarding affordances', () => {
    const markup = renderToolingPage()

    expect(markup).toContain('Open source drawer')
    expect(markup).toContain('Tool source drawer')
    expect(markup).toContain('Desktop local')
    expect(markup).toContain('Web thin')
    expect(markup).toContain('Android')
    expect(markup).toContain('iOS')
    expect(markup).toContain('Demo data is labeled')
    expect(markup).not.toContain('local Python sidecar available on mobile')
  })
})
