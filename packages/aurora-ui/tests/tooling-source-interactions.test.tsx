// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  navItemSnapshot,
  type RouteAvailability,
  type ToolApprovalPanelManagementState,
} from '../src'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('Tooling source interactions', () => {
  it('uses an accessible mobile source drawer trigger instead of a placeholder button', async () => {
    const container = renderPanel(new Aurora({ transport: new MockAuroraTransport() }), { nativePlatform: 'android' })

    const trigger = findButtonByText(container, 'Sources')
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.aui-tool-source-rail-open')).toBeNull()

    expect(trigger!.getAttribute('aria-controls')).toBe('tool-source-drawer')
  })

  it('surfaces onboarding validation failures from typed Tooling source contracts', async () => {
    const transport = {
      kind: 'http',
      async request() {
        throw new Error('backend validation down')
      },
    }
    const container = renderPanel(new Aurora({ transport }))

    await act(async () => {
      findButtonByText(container, 'Add MCP source')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const endpointInput = findInputByPlaceholder(container, 'stdio command or https://server') ?? findInputByPlaceholder(container, 'https://server')
    expect(endpointInput).not.toBeNull()
    await act(async () => {
      setInputValue(endpointInput!, 'https://mcp.example.test')
      endpointInput!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      findButtonByText(container, '3. Discover')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      findButtonByText(container, 'Test connection')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Could not connect to this Aurora device. Try again.')
    expect(container.textContent).not.toContain('backend validation down')
  })

  it('does not present unsupported onboarding as successful validation', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const container = renderPanel(client)

    await act(async () => {
      findButtonByText(container, 'Add MCP source')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const endpointInput = findInputByPlaceholder(container, 'stdio command or https://server') ?? findInputByPlaceholder(container, 'https://server')
    expect(endpointInput).not.toBeNull()
    await act(async () => {
      setInputValue(endpointInput!, 'https://mcp.example.test')
      endpointInput!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => {
      findButtonByText(container, '3. Discover')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      findButtonByText(container, 'Test connection')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('MCP source is not available in this Aurora version yet.')
    expect(container.textContent).not.toContain('MCP source test valid')
  })
})

function renderPanel(client: Aurora, options: { nativePlatform?: string } = {}): HTMLElement {
  const tools = normalizeToolCatalog(toolCatalogFixture, { transportKind: client.transport.kind })
  const schedulerJobs = schedulerJobsFixture.jobs.map(normalizeSchedulerJob)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <ToolApprovalPanel
        client={client}
        route={toolsRoute()}
        initialTools={tools}
        initialSchedulerJobs={schedulerJobs}
        initialManagementState={managementState()}
        nativePlatform={options.nativePlatform}
      />,
    )
  })
  return container
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
      ruleCount: 1,
      activeGrantCount: 0,
      pendingApprovalCount: 0,
      sourceCount: 1,
      blockedSourceCount: 0,
      blockedToolCount: 0,
      toolCount: toolCatalogFixture.tools.length,
      mcpServerCount: 0,
      activeMcpServerCount: 0,
      lastPolicyChangeActor: 'admin',
      lastPolicyChangeAt: generatedAt,
      lastPolicyCorrelationId: 'corr-policy',
      secretsRedacted: true,
    },
    sourceSummaries: [],
    sourceDetails: {},
    grants: [],
    pendingApprovals: [],
    auditEvents: [],
    managementLoading: false,
    managementError: null,
  }
}

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text)) ?? null
}

function findInputByPlaceholder(container: ParentNode, placeholder: string): HTMLInputElement | null {
  return Array.from(container.querySelectorAll('input')).find((input) => input.placeholder === placeholder) ?? null
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}
