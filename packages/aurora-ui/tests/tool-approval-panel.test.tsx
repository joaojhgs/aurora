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
  it('matches the source-first Tooling console with policy, catalog, scheduler, and onboarding entrypoints', () => {
    const markup = renderToolsPanel()

    expect(markup).toContain('Tools &amp; Automations')
    expect(markup).toContain('Tooling policy')
    expect(markup).toContain('Source catalog')
    expect(markup).toContain('Source detail')
    expect(markup).toContain('Tooling.GetToolCatalog')
    expect(markup).toContain('Scheduled tool actions')
    expect(markup).toContain('Scheduler')
    expect(markup).toContain('Add MCP server')
    expect(markup).toContain('Add plugin')
    expect(markup).toContain('Durable grants')
    expect(markup).toContain('Pending approvals')
  })

  it('covers source search helpers, selected tool details, schema form, dry-run, execution, approval, audit, and result status', () => {
    const markup = renderToolsPanel()
    const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: 'mock' })
    const categories = buildToolCategories(tools)

    expect(categories.map((category) => category.label)).toEqual(['All', 'Read-only', 'Mutating', 'External', 'Admin'])
    expect(filterTools(tools, 'external', 'email').map((tool) => tool.name)).toEqual(['Send email draft'])
    expect(filterTools(tools, 'admin', 'garage').map((tool) => tool.name)).toEqual(['Open garage door'])
    expect(filterTools(tools, 'read', 'diagnostics').map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['diagnostics.serviceHealth', 'Collect diagnostics bundle']),
    )

    expect(markup).toContain('Search sources and tools')
    expect(markup).toContain('Advanced details and redacted payloads')
    expect(markup).toContain('Arguments schema summary')
    expect(markup).toContain('Dry-run preview')
    expect(markup).toContain('Execute safe local')
    expect(markup).toContain('Deny')
    expect(markup).toContain('Correlation')
    expect(markup).toContain('LLM/scheduler binding')
  })

  it('does not expose fake execution for tools that are not currently selected or safe-local executable', () => {
    const markup = renderToolsPanel()
    const safeCard = markup.slice(markup.indexOf('diagnostics.serviceHealth'))

    expect(safeCard).toContain('Execute safe local')
    expect(safeCard).toContain('No approval required by current backend policy.')
    expect(markup).not.toContain('Pretend execution')
  })

})
