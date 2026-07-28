// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuroraClient, ToolApprovalCardModel, ToolExportPolicyModel, ToolExportScopeModel } from '@aurora/client'
import { ToolApprovalPanel, auroraNavSections, navItemSnapshot, type RouteAvailability } from '../src'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import { ToolSharingRowControl } from '../src/tooling/tool-sharing-controls'

let container: HTMLDivElement
let root: Root

describe('tooling product copy', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView = () => undefined
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('maps tool page errors and empty states away from internal wording', () => {
    const markup = renderToStaticMarkup(
      <ToolApprovalPanel
        client={client()}
        route={{
          ...toolsRoute(),
          disabled: true,
          blockers: ['provider route failed with WebRTC transport status 500'],
        }}
        initialTools={[]}
        initialSchedulerJobs={[]}
        initialManagementState={{
          sourceSummaries: [],
          sourceDetails: {},
          managementLoading: false,
          managementError: 'Tooling.GetToolSourceDetail provider stack trace: route failed',
          sharingLoading: false,
        }}
      />,
    )

    const text = visibleText(markup)
    expect(text).toContain('Tools are unavailable. Review access and try again.')
    expect(text).toContain('No core, MCP, plugin, mesh, unknown, or blocked sources are available right now.')
    expectForbiddenFree(text)
  })

  it('keeps the MCP setup dialog product-facing while preserving endpoint fields', async () => {
    await act(async () => {
      root.render(
        <ToolApprovalPanel
          client={client()}
          route={toolsRoute()}
          initialTools={[]}
          initialSchedulerJobs={[]}
          initialManagementState={{
            sourceSummaries: [],
            sourceDetails: {},
            managementLoading: false,
            sharingLoading: false,
          }}
        />,
      )
    })

    const add = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Add MCP source'))
    expect(add).toBeTruthy()
    await act(async () => add!.click())

    const text = visibleText(container.innerHTML)
    expect(text).toContain('Server URL or command profile')
    expect(text).toContain('Aurora checks the connection before saving.')
    expectForbiddenFree(text)
  })

  it('renders MCP setup success and failure states without remapping success to failure copy', async () => {
    await renderPanel(client({
      testMcpSource: async () => ({ ok: true, status: 'ok', supported: true, errors: [] }),
    }))
    await openMcpDiscoverStep()
    await act(async () => findButton('Test connection')!.click())

    let text = visibleText(container.innerHTML)
    expect(text).toContain('MCP source connection looks ready.')
    expect(text).not.toContain('Could not connect')
    expectForbiddenFree(text)

    act(() => root.unmount())
    root = createRoot(container)
    await renderPanel(client({
      testMcpSource: async () => {
        throw new Error('provider route failed with transport stack trace')
      },
    }))
    await openMcpDiscoverStep()
    await act(async () => findButton('Test connection')!.click())

    text = visibleText(container.innerHTML)
    expect(text).toContain('Could not connect to this Aurora device. Try again.')
    expect(text).not.toContain('provider route failed')
    expectForbiddenFree(text)
  })

  it('keeps expanded tool details and raw result errors product-safe', async () => {
    await renderPanel(client(), [tool({
      state: 'unavailable',
      disabledReason: 'provider transport route stack trace',
      result: {
        ok: false,
        status: 'failed',
        providerPeerId: 'peer-kitchen',
        correlationId: 'corr-safe',
        auditReceipt: null,
        routePath: ['Tooling.ExecuteTool'],
        durationMs: null,
        redactionStatus: 'redacted',
        retryEligible: true,
        fallbackEligible: true,
        outputPreview: null,
        error: 'provider route failed at WebRTC transport',
      },
    })])

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle details for Calendar lookup"]')
    expect(toggle).toBeTruthy()
    await act(async () => toggle!.click())
    const text = visibleText(container.innerHTML)
    expect(text).toContain('This tool needs attention before Aurora can use it.')
    expect(text).toContain('Needs attention')
    expect(text).toContain('Connection lost. Reconnecting...')
    expect(text).not.toContain('Tooling.ExecuteTool')
    expect(text).not.toContain('provider route failed')
    expectForbiddenFree(text)
  })

  it('keeps policy, scheduler, grant, approval, and activity workspaces hidden from the compact page', async () => {
    await renderPanel(client(), [tool()])

    const text = visibleText(container.innerHTML)
    expect(text).toContain('Tools & Plugins')
    expect(text).not.toContain('Global policy mode')
    expect(text).not.toContain('Scheduled tool actions')
    expect(text).not.toContain('Durable grants')
    expect(text).not.toContain('Pending approvals')
    expect(text).not.toContain('Activity and audit')
    expectForbiddenFree(text)
  })

  it('maps sharing control errors and remote-tool copy to user state', () => {
    const remoteMarkup = renderToStaticMarkup(
      <ToolSharingRowControl
        tool={{ ...tool(), exportable: false, sourceType: 'mesh_peer', providerKind: 'mesh_peer', providerLabel: 'Kitchen Aurora' }}
        policy={sharingPolicy()}
        peers={peers()}
        decision={null}
      />,
    )
    const errorMarkup = renderToStaticMarkup(
      <ToolSharingRowControl
        tool={tool()}
        policy={sharingPolicy()}
        peers={peers()}
        decision={null}
        error="provider route failed with transport fallback stack trace"
      />,
    )

    const text = `${visibleText(remoteMarkup)} ${visibleText(errorMarkup)}`
    expect(text).toContain('Shared from another device')
    expect(text).toContain('Change sharing on Kitchen Aurora')
    expect(text).toContain('Could not connect to this Aurora device. Try again.')
    expectForbiddenFree(text)
  })
})

async function renderPanel(testClient: AuroraClient, tools: ToolApprovalCardModel[] = []): Promise<void> {
  await act(async () => {
    root.render(
      <ToolApprovalPanel
        client={testClient}
        route={toolsRoute()}
        initialTools={tools}
        initialSchedulerJobs={[]}
        initialManagementState={{
          sourceSummaries: [],
          sourceDetails: {},
          managementLoading: false,
          sharingLoading: false,
        }}
      />,
    )
  })
}

async function openMcpDiscoverStep(): Promise<void> {
  const add = findButton('Add MCP source')
  expect(add).toBeTruthy()
  await act(async () => add!.click())
  const discover = findButton('3. Discover')
  expect(discover).toBeTruthy()
  await act(async () => discover!.click())
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
}

function expectForbiddenFree(text: string): void {
  const matches = findForbiddenProductionCopyTerms(text).map((term) => term.id)
  expect(matches, text).toEqual([])
}

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

function client(overrides: { testMcpSource?: () => Promise<unknown> } = {}): AuroraClient {
  return {
    transport: { kind: 'http' },
    auth: {
      snapshot: () => ({ principalId: 'admin' }),
      subscribe: () => () => undefined,
    },
    tools: {
      testMcpSource: overrides.testMcpSource,
    },
  } as unknown as AuroraClient
}

function toolsRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'tools')!
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Ready',
    providerLabel: 'Aurora',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function tool(overrides: Partial<ToolApprovalCardModel> = {}): ToolApprovalCardModel {
  return {
    id: 'tool:calendar:list',
    name: 'Calendar lookup',
    description: 'Reads calendar events.',
    providerLabel: 'Aurora',
    providerPeerId: null,
    serviceInstanceId: 'calendar',
    providerKind: 'local',
    sourceType: 'core',
    trustTier: 'trusted',
    configuredTrustTier: null,
    transport: 'local',
    routePath: [],
    riskClass: 'read',
    approvalRequired: false,
    requiresAdminAction: false,
    selectorRequired: false,
    providerSelectorRequired: false,
    dataEgress: false,
    mutating: false,
    requiredPermissions: [],
    argsSchema: null,
    argsPreview: null,
    argsHash: null,
    meshSelector: null,
    resourceSelector: null,
    approvalScopes: [],
    requestedApprovalScope: null,
    tokenTtlSeconds: null,
    state: 'ready',
    disabledReason: null,
    denialReason: null,
    dryRunSupported: false,
    dryRunRequired: false,
    dryRunPreview: null,
    auditDestination: null,
    correlationId: null,
    policyDecisionId: null,
    approvalRequestId: null,
    expiresAt: null,
    providers: [],
    result: null,
    secretsRedacted: true,
    exportable: true,
    ...overrides,
  } as ToolApprovalCardModel
}

function peers(): ToolExportScopeModel[] {
  return [{ peerId: 'peer-kitchen', label: 'Kitchen Aurora', stale: false }]
}

function sharingPolicy(): ToolExportPolicyModel {
  return {
    scope: { peerId: null, label: 'All peers', stale: false },
    defaultState: 'unshared',
    revision: 1,
    initialized: true,
    scopes: peers(),
    migratedFromLegacy: false,
    updatedAt: 1,
    rules: [],
    staleToolIds: [],
    staleGroupIds: [],
    protocolTier: 'projection_v1',
    providerEnabled: true,
    consumerEnabled: true,
    enforcementActive: true,
    switchRevision: 1,
    secretsRedacted: true,
  }
}
