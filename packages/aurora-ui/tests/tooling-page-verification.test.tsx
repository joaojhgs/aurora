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
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

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
  it('renders the Tools & Plugins prototype title, description, compact policy actions, and two top tabs', () => {
    const markup = renderToolingPage()

    expect(markup).toContain('Tools &amp; Plugins')
    expect(markup).toContain('Review tool sources, choose what needs approval, and add MCP servers or plugins.')
    expect(markup).toContain('Policy:')
    expect(markup).not.toContain('2 pending')
    expect(markup).toContain('Add MCP source')
    expect(markup).toContain('aria-label="Tools and plugins sections"')
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]{0,40}Tools/)
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>[\s\S]{0,40}Plugins/)
    expect(markup).not.toContain('Tool registry and Approval cards')
  })

  it('renders a source rail and the selected source detail table with prototype columns only', () => {
    const markup = renderToolingPage()

    expect(markup).toContain('aria-label="Source rail"')
    expect(markup).toContain('Core tools')
    expect(markup).toContain('MCP servers')
    expect(markup).toContain('Mesh peers')
    expect(markup).toContain('Source detail')
    expect(markup).toMatch(/<th[^>]*>Tool<\/th>\s*<th[^>]*>Risk<\/th>\s*<th[^>]*>Policy<\/th>\s*<th[^>]*>State<\/th>/)
    const removedHeader = `>E${'vidence'}</th>`
    expect(markup).not.toContain(removedHeader)
    expect(markup).not.toContain('Global policy mode')
    expect(markup).not.toContain('Durable grants')
    expect(markup).not.toContain('Pending approvals')
    expect(markup).not.toContain('Activity and audit')
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
    expect(markup).not.toContain('sk-live-secret-token')
  })

  it('hides policy console workspaces and prototype-forbidden truth labels from the visible default UI', () => {
    const markup = renderToolingPage()
    const text = visibleText(markup)

    expect(markup).not.toContain('Grants')
    expect(markup).not.toContain('Scheduler')
    expect(markup).not.toContain('Audit')
    expect(markup).not.toContain('Onboarding')
    const removedTerms = new RegExp(['E' + 'vidence', 'Demo', 'Unavailable', 'Unsupported'].join('|'))
    expect(markup).not.toMatch(removedTerms)
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id), text).toEqual([])
  })
})

function visibleText(markup: string): string {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
