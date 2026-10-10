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
  ToolingConsole,
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
    expect(trigger!.closest('#tool-source-drawer')).toBeNull()
    expect(container.querySelector('.aui-tool-source-rail-open')).toBeNull()

    expect(trigger!.getAttribute('aria-controls')).toBe('tool-source-drawer')
    await act(async () => trigger!.click())
    expect(container.querySelector('#tool-source-drawer')?.className).toContain('flex')
    expect(findButtonByText(container, 'Close')).not.toBeNull()
  })

  it('surfaces onboarding validation failures from typed Tooling source contracts', async () => {
    let rejectRequest: ((error: Error) => void) | null = null
    const transport = {
      kind: 'http',
      async request() {
        return new Promise<never>((_, reject) => {
          rejectRequest = reject
        })
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

    expect(findButtonByText(container, 'Test connection')?.disabled).toBe(true)
    expect(findButtonByText(container, '1. Details')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Close Add MCP source"]')?.disabled).toBe(true)

    await act(async () => {
      rejectRequest?.(new Error('backend validation down'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Could not connect to this Aurora device. Try again.')
    expect(container.textContent).not.toContain('backend validation down')
    expect(findButtonByText(container, 'Test connection')?.disabled).toBe(false)
    expect(findButtonByText(container, '1. Details')?.disabled).toBe(false)
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

  it('disables plugin activation while saving', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    let finishToggle: (() => void) | null = null
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <ToolingConsole
          client={client}
          route={toolsRoute()}
          tools={[]}
          loading={false}
          error={null}
          schedulerJobs={[]}
          schedulerLoading={false}
          schedulerError={null}
          selectedProviders={{}}
          decisionMessages={{}}
          builtinPlugins={[{
            id: 'calendar',
            label: 'Calendar',
            active: false,
            configured: true,
            activateKeyPath: 'services.tooling.plugins.calendar.enabled',
            fields: [],
            evidence: 'ready',
          }]}
          managementLoading={false}
          sourceSummaries={[]}
          sourceDetails={{}}
          grants={[]}
          pendingApprovals={[]}
          auditEvents={[]}
          sharingPolicy={null}
          sharingPeers={[]}
          sharingDecisions={{}}
          sharingLoading={false}
          sharingError={null}
          sharingMessage={null}
          sharingPendingKey={null}
          sourceConfiguredTrustTiers={{}}
          onTogglePlugin={() => new Promise<void>((resolve) => {
            finishToggle = resolve
          })}
          onSelectProvider={() => undefined}
          onApprove={() => undefined}
          onDeny={() => undefined}
          onExecuteSafe={() => undefined}
        />
      )
    })

    await act(async () => {
      findButtonByText(container, 'Plugins')!.click()
    })
    await act(async () => {
      await Promise.resolve()
    })
    const activationSwitch = container.querySelector<HTMLElement>('[role="switch"][aria-label="Inactive"]')
    expect(activationSwitch).toBeTruthy()

    await act(async () => {
      activationSwitch?.click()
      await Promise.resolve()
    })

    expect(activationSwitch?.getAttribute('data-disabled')).toBe('')

    await act(async () => {
      finishToggle?.()
      await Promise.resolve()
    })

    expect(activationSwitch?.getAttribute('data-disabled')).toBeNull()
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
