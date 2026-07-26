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
      initialManagementState={{
        sourceSummaries: [],
        sourceDetails: {},
        managementLoading: false,
        sharingLoading: false,
      }}
    />,
  )
}

describe('ToolApprovalPanel tools and automations stories', () => {
  it('matches the source-first Tools & Plugins console with policy summary, source rail, and detail panel', () => {
    const markup = renderToolsPanel()

    // Consolidated per the Aurora Cockpit redesign: this is now a read-only source/tool
    // catalog browser (Tools tab + Plugins tab). Execution/approval happens through the
    // Assistant's tool-call approval flow, not here; scheduler jobs have their own screen.
    expect(markup).toContain('Tools &amp; Plugins')
    expect(markup).toContain('Tools policy summary')
    expect(markup).toContain('Tool sources')
    expect(markup).toContain('Source detail')
    expect(markup).toContain('Aurora core Tooling')
    expect(markup).toContain('Add MCP source')
    expect(markup).not.toContain('2 pending')
    expect(markup).toContain('dry_run_only')
  })

  it('covers source search helpers, selected tool details, and the risk/state catalog table', () => {
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
    expect(markup).toContain('Aurora core Tooling')
    // Stable backend share groups keep Diagnostics separate from the default
    // core group even when both sources are local/core.
    expect(markup).toContain('Diagnostics')
    expect(markup).toContain('provider-selector-required')
    expect(markup).toContain('Selected source tool inventory')
  })

  it('does not expose any inline execution or approval controls in the read-only catalog view', () => {
    const markup = renderToolsPanel()

    // The catalog browser is intentionally read-only -- no per-tool execute/approve/deny
    // controls (navigation buttons like source rows and tabs are expected and fine).
    expect(markup).not.toContain('Pretend execution')
    expect(markup).not.toContain('Execute safe local')
    expect(markup).not.toContain('>Deny<')
    expect(markup).not.toContain('>Approve<')
    expect(markup.match(/role="tab"/g)?.length).toBe(2)
  })

})
