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
  buildToolCategories,
  filterTools,
  navItemSnapshot,
  type RouteAvailability,
} from '../src'

function toolsRoute(): RouteAvailability {
  const toolsItem = auroraNavSections
    .flatMap((section) => section.items)
    .find((item) => item.id === 'tools')
  if (!toolsItem) throw new Error('missing tools nav item')
  return {
    item: navItemSnapshot(toolsItem),
    state: 'available-local',
    explanation: 'Local Tooling.GetToolCatalog and Scheduler.ListJobs are routeable.',
    providerLabel: 'local / Tooling.GetToolCatalog',
    blockers: [],
    repairActions: [],
    candidateProviders: [
      {
        id: 'local:Tooling',
        label: 'local / Tooling.GetToolCatalog',
        state: 'available-local',
        selectable: true,
        reason: 'Local Gateway advertises Tooling catalog and execution routes.',
        requiredAction: null,
      },
    ],
    evidenceSources: ['Tooling.GetToolCatalog', 'Scheduler.ListJobs'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function renderToolsPanel() {
  const client = new Aurora({ transport: new MockAuroraTransport() })
  const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
  const schedulerJobs = schedulerJobsFixture.jobs.map(normalizeSchedulerJob)
  return renderToStaticMarkup(
    <ToolApprovalPanel
      client={client}
      route={toolsRoute()}
      initialTools={tools}
      initialSchedulerJobs={schedulerJobs}
    />,
  )
}

describe('ToolApprovalPanel tools and automations stories', () => {
  it('matches the mock target with a registry, MCP status, and scheduler snapshot from backend fixtures', () => {
    const markup = renderToolsPanel()

    expect(markup).toContain('Tools &amp; Automations')
    expect(markup).toContain('Tool registry and Approval cards')
    expect(markup).toContain('Tooling.GetToolCatalog')
    expect(markup).toContain('MCP server status')
    expect(markup).toContain('Scheduled jobs')
    expect(markup).toContain('Scheduler.ListJobs')
    expect(markup).toContain('Open scheduler')
    expect(markup).toContain('<th>Job</th>')
    expect(markup).toContain('<th>Schedule</th>')
    expect(markup).toContain('<th>Status</th>')
    expect(markup).toContain('<th>Next</th>')
    expect(markup).toContain('<th>Target</th>')
    expect(markup).toContain('daily-digest')
    expect(markup).toContain('remote-knowledge-index')
    expect(markup).toContain('active automations')
  })

  it('covers search/category filters, tool details, schema form, dry-run, execution, approval, audit, and result status', () => {
    const markup = renderToolsPanel()
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: 'mock' })
    const categories = buildToolCategories(tools)

    expect(categories.map((category) => category.label)).toEqual(['All', 'Read-only', 'Mutating', 'External', 'Admin'])
    expect(filterTools(tools, 'external', 'email').map((tool) => tool.name)).toEqual(['Send email draft'])
    expect(filterTools(tools, 'admin', 'garage').map((tool) => tool.name)).toEqual(['Open garage door'])
    expect(filterTools(tools, 'read', 'diagnostics').map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['diagnostics.serviceHealth', 'Collect diagnostics bundle']),
    )

    expect(markup).toContain('Tool catalog filters')
    expect(markup).toContain('Tool search')
    expect(markup).toContain('Tool detail drawer')
    expect(markup).toContain('Tool parameters')
    expect(markup).toContain('Parameter validation is schema-derived from Tooling.GetToolCatalog')
    expect(markup).toContain('Dry-run preview')
    expect(markup).toContain('Execute safe local')
    expect(markup).toContain('Approve once')
    expect(markup).toContain('AdminAction confirmation required before approval or execution.')
    expect(markup).toContain('Audit receipt')
    expect(markup).toContain('audit-receipt-tool-result')
    expect(markup).toContain('corr-tool-result')
    expect(markup).toContain('local-peer -&gt; tooling-local')
  })

  it('does not expose fake execution for unavailable or sensitive tools', () => {
    const markup = renderToolsPanel()
    const adminCard = markup.slice(markup.indexOf('Write local config file'), markup.indexOf('Open garage door'))
    const sensitiveCard = markup.slice(markup.indexOf('Camera snapshot'), markup.indexOf('Collect diagnostics bundle'))
    const safeCard = markup.slice(markup.indexOf('diagnostics.serviceHealth'), markup.indexOf('Write local config file'))

    expect(safeCard).toContain('Execute safe local')
    expect(safeCard).toContain('No approval required by current backend policy.')
    expect(adminCard).toContain('AdminAction confirmation required before approval or execution.')
    expect(adminCard).not.toContain('Execute safe local')
    expect(sensitiveCard).toContain('Unavailable: service_unavailable')
    expect(sensitiveCard).not.toContain('Execute safe local')
  })
})
