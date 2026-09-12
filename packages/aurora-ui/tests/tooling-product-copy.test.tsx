// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuroraClient, ToolApprovalCardModel, ToolExportPolicyModel, ToolExportScopeModel } from '@aurora/client'
import { ToolApprovalPanel, auroraNavSections, navItemSnapshot, type RouteAvailability, type ToolApprovalPanelManagementState } from '../src'
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

  it('renders plugin toggle and settings success states without internal config copy', async () => {
    await renderPanel(client(), [], { builtinPlugins: [builtinPlugin({ active: false, configured: true, fields: [] })] })
    await openPluginsTab()
    await act(async () => {
      findSwitch()!.click()
      await flushAsync()
    })

    let text = visibleText(container.innerHTML)
    expect(text).toContain('Brave Search is active. Review its tools before use.')
    expectNoHostileTerms(text)
    expectForbiddenFree(text)

    act(() => root.unmount())
    root = createRoot(container)
    await renderPanel(client(), [], {
      builtinPlugins: [builtinPlugin({
        active: false,
        configured: true,
        fields: [configField('services.tooling.plugins.brave_search.api_key', 'API key', 'Enter the API key.', '', true)],
      })],
    })
    await openPluginsTab()
    await act(async () => findButton('Configure')!.click())
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      setInputValue(input, 'secret-value')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton('Save')!.click()
      await flushAsync()
    })

    text = visibleText(container.innerHTML)
    expect(text).toContain('Brave Search settings saved.')
    expectNoHostileTerms(text)
    expectForbiddenFree(text)
  })

  it('keeps plugin config paths in request data and out of rendered decision copy', async () => {
    const reasons: string[] = []
    const appliedPaths: string[] = []
    await renderPanel(client({
      applyChange: async (request) => {
        reasons.push(request.reason)
        appliedPaths.push(request.change.key_path)
        throw new Error('services.tooling.plugins.brave_search.api_key provider route failed with transport stack trace')
      },
    }), [], {
      builtinPlugins: [builtinPlugin({
        active: false,
        configured: true,
        fields: [configField('services.tooling.plugins.brave_search.api_key', 'API key', 'Enter the API key.', '', true)],
      })],
    })
    await openPluginsTab()
    await act(async () => findButton('Configure')!.click())
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      setInputValue(input, 'secret-value')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton('Save')!.click()
      await flushAsync()
    })

    expect(appliedPaths).toEqual(['services.tooling.plugins.brave_search.api_key'])
    expect(reasons).toEqual(['Update plugin settings from Aurora UI'])
    const rendered = visibleAndAriaText()
    expect(rendered).toContain('Could not connect to this Aurora device. Try again.')
    expect(rendered).not.toContain('services.tooling.plugins.brave_search.api_key')
    expect(rendered).not.toContain('provider route failed')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))
  })

  it('keeps plugin config field keys and hostile metadata out of visible labels and attributes', async () => {
    const appliedPaths: string[] = []
    await renderPanel(client({
      applyChange: async (request) => {
        appliedPaths.push(request.change.key_path)
        return { ok: true, data: { applied: true, revision: 2, secrets_redacted: true } }
      },
    }), [], {
      builtinPlugins: [builtinPlugin({
        active: false,
        configured: false,
        fields: [configField(
          'services.tooling.plugins.brave_search.Tooling.ExecuteTool.api_token',
          `${dynamicHostileText()} API key token`,
          `${dynamicHostileText()} secret credential placeholder`,
          '',
          true,
        )],
      })],
    })
    await openPluginsTab()
    await act(async () => findButton('Configure')!.click())

    let rendered = visibleAriaAndAttributeText()
    expect(rendered).toContain('Built-in plugin; needs 1 setting.')
    expect(rendered).toContain('Setting 1 (protected) · not set')
    expect(rendered).toContain('Enter protected value')
    expect(rendered).not.toContain('services.tooling.plugins.brave_search.Tooling.ExecuteTool.api_token')
    expect(rendered).not.toContain('api token')
    expect(rendered).not.toContain('API key')
    expect(rendered).not.toContain('secret credential')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))

    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      setInputValue(input, 'secret-value')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      findButton('Save')!.click()
      await flushAsync()
    })

    expect(appliedPaths).toEqual(['services.tooling.plugins.brave_search.Tooling.ExecuteTool.api_token'])
    rendered = visibleAriaAndAttributeText()
    expect(rendered).not.toContain('services.tooling.plugins.brave_search.Tooling.ExecuteTool.api_token')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))
  })

  it('maps hostile catalog and top-level alert failures before rendering', async () => {
    await renderPanel(client({
      loadApprovalCards: async () => ({
        ok: false,
        error: {
          code: 'connection_lost',
          message: dynamicHostileText(),
        },
      }),
    }), null)
    await act(async () => { await flushAsync() })

    let rendered = visibleAndAriaText()
    expect(rendered).toContain('Connection lost. Reconnecting...')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))

    act(() => root.unmount())
    root = createRoot(container)
    await renderPanel(client(), [], {
      managementError: dynamicHostileText(),
    })

    rendered = visibleAndAriaText()
    expect(rendered).toContain('Connection lost. Reconnecting...')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))
  })

  it('keeps expanded tool details and raw result errors product-safe while preserving ordinary text', async () => {
    const safeDescription = 'Reads calendar events and shows upcoming meetings.'
    const safeProvider = 'Kitchen Aurora'
    await renderPanel(client(), [
      tool({ description: safeDescription, providerLabel: safeProvider }),
      tool({
        id: 'tool:calendar:hostile',
        name: 'Hostile calendar lookup',
        providerLabel: dynamicHostileText(),
        description: dynamicHostileText(),
        providers: [{
          id: 'hostile-source',
          label: dynamicHostileText(),
          selectable: true,
          providerKind: 'mcp',
          providerPeerId: null,
          serviceInstanceId: 'hostile-source',
          trustTier: 'untrusted',
          transport: 'mcp',
          reason: 'Available source',
        }],
      }),
    ])

    let text = visibleText(container.innerHTML)
    expect(text).toContain(safeDescription)
    expect(text).toContain('This tool can help after you review it.')
    expectNoHostileTerms(text)
    expectForbiddenFree(text)

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle details for Hostile calendar lookup"]')
    expect(toggle).toBeTruthy()
    await act(async () => toggle!.click())
    text = visibleText(container.innerHTML)
    expect(text).toContain('This tool can help after you review it.')
    expect(text).toContain('Aurora source')
    expectNoHostileTerms(text)
    expectForbiddenFree(text)
  })

  it('keeps backend and fallback source names product-safe while preserving ordinary names', async () => {
    const safeSourceName = 'Family calendar source'
    await renderPanel(client(), [], {
      sourceSummaries: [
        backendSourceSummary('backend-safe-source', safeSourceName),
        backendSourceSummary('backend-hostile-source', dynamicHostileText()),
      ],
      sourceDetails: {
        'backend-safe-source': sourceDetail([tool({ id: 'tool:calendar:safe-source', name: 'Safe source calendar', description: 'Reads family events.' })]),
        'backend-hostile-source': sourceDetail([tool({ id: 'tool:calendar:backend-hostile', name: 'Backend hostile calendar', description: 'Reads shared events.' })]),
      },
    })

    let rendered = visibleAndAriaText()
    expect(rendered).toContain(safeSourceName)
    expect(rendered).toContain('Aurora source')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))

    act(() => root.unmount())
    root = createRoot(container)
    await renderPanel(client(), [
      tool({
        id: 'tool:calendar:fallback-safe',
        name: 'Grouped safe calendar',
        sourceType: 'mcp',
        shareGroupId: 'safe-source-group',
        shareGroupLabel: safeSourceName,
        serviceInstanceId: safeSourceName,
        providerLabel: safeSourceName,
      }),
      tool({
        id: 'tool:calendar:fallback-hostile',
        name: 'Grouped hostile calendar',
        sourceType: 'mcp',
        shareGroupId: 'hostile-source-group',
        shareGroupLabel: dynamicHostileText(),
        serviceInstanceId: dynamicHostileText(),
        providerLabel: dynamicHostileText(),
      }),
    ])

    rendered = visibleAndAriaText()
    expect(rendered).toContain(safeSourceName)
    expect(rendered).toContain('Aurora source')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))
  })

  it('uses approved device names and trims Python tool internals from shared-tool copy', async () => {
    const peerId = 'aurora-7810d9a4f79a3ed0ccd5273d10b86c7a'
    const remoteTool = tool({
      id: 'remote:pomodoro:status',
      name: 'pomodoro_status_tool',
      description: 'Get the current status of the Pomodoro session. Args: bus: MessageBus instance for communication (injected by ToolingService) Returns: Current session information.',
      providerLabel: peerId,
      providerPeerId: peerId,
      providerKind: 'mesh_peer',
      sourceType: 'mesh_peer',
      serviceInstanceId: 'tooling-remote',
      shareGroupId: 'pomodoro',
      shareGroupLabel: 'Pomodoro',
    })
    await renderPanel(client(), [], {
      sourceSummaries: [{
        ...backendSourceSummary('mesh:pomodoro', `${peerId} · Pomodoro`),
        kind: 'mesh_peer',
        providerPeerId: peerId,
        providerServiceInstanceId: 'tooling-remote',
        providerKind: 'mesh_peer',
      }],
      sourceDetails: {
        'mesh:pomodoro': sourceDetail([remoteTool]),
      },
      sharingPeers: [{ peerId, label: 'Office Aurora', stale: false }],
    })

    const rendered = visibleAndAriaText()
    expect(rendered).toContain('Office Aurora · Pomodoro')
    expect(rendered).toContain('Pomodoro status')
    expect(rendered).toContain('Get the current status of the Pomodoro session.')
    expect(rendered).not.toContain(peerId)
    expect(rendered).not.toContain('MessageBus')
    expect(rendered).not.toContain('Args:')
    expect(rendered).not.toContain('Returns:')
    expectForbiddenFree(visibleText(container.innerHTML))
  })

  it('keeps selected sharing group labels product-safe in visible and ARIA copy', async () => {
    await renderPanel(client(), [
      tool({
        id: 'tool:calendar:selected-sharing-hostile',
        name: 'Selected sharing calendar',
        sourceType: 'mcp',
        shareGroupId: 'selected-sharing-hostile',
        shareGroupLabel: dynamicHostileText(),
        serviceInstanceId: dynamicHostileText(),
        providerLabel: dynamicHostileText(),
      }),
    ])

    const rendered = visibleAndAriaText()
    expect(rendered).toContain('Choose whether Aurora source tools are advertised to mesh peers.')
    expect(rendered).toContain('Mesh sharing for Aurora source group')
    expectNoHostileTerms(rendered)
    expectForbiddenFree(visibleText(container.innerHTML))
  })

  it('keeps expanded tool result errors product-safe', async () => {
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
    const hostileRemoteMarkup = renderToStaticMarkup(
      <ToolSharingRowControl
        tool={{ ...tool(), exportable: false, sourceType: 'mesh_peer', providerKind: 'mesh_peer', providerLabel: dynamicHostileText() }}
        policy={sharingPolicy()}
        peers={peers()}
        decision={null}
      />,
    )

    const text = `${visibleText(remoteMarkup)} ${visibleText(errorMarkup)} ${visibleText(hostileRemoteMarkup)}`
    expect(text).toContain('Shared from another device')
    expect(text).toContain('Change sharing on Kitchen Aurora')
    expect(text).toContain('Change sharing on Aurora source')
    expect(text).toContain('Could not connect to this Aurora device. Try again.')
    expectNoHostileTerms(text)
    expectForbiddenFree(text)
  })
})

async function renderPanel(testClient: AuroraClient, tools: ToolApprovalCardModel[] | null = [], managementState: ToolApprovalPanelManagementState = {}): Promise<void> {
  await act(async () => {
    root.render(
      <ToolApprovalPanel
        client={testClient}
        route={toolsRoute()}
        initialTools={tools ?? undefined}
        initialSchedulerJobs={[]}
        initialManagementState={{
          sourceSummaries: [],
          sourceDetails: {},
          managementLoading: false,
          sharingLoading: false,
          ...managementState,
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

async function openPluginsTab(): Promise<void> {
  const plugins = [...container.querySelectorAll<HTMLElement>('[role="tab"], button')]
    .find((element) => element.textContent?.trim() === 'Plugins')
  expect(plugins).toBeTruthy()
  await act(async () => plugins!.click())
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text))
}

function findSwitch(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="switch"], [data-slot="switch"]')
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function expectForbiddenFree(text: string): void {
  const matches = findForbiddenProductionCopyTerms(text).map((term) => term.id)
  expect(matches, text).toEqual([])
}

function expectNoHostileTerms(text: string): void {
  for (const term of hostileDynamicTerms()) {
    expect(text, term).not.toContain(term)
  }
}

function hostileDynamicTerms(): string[] {
  return [
    'S' + 'DK',
    'c' + 'ache',
    'T' + 'ooling',
    'T' + 'ooling.ExecuteTool',
    'provider',
    'route',
    'schema',
    'protocol',
    'transport',
    'runtime',
    'manifest',
  ]
}

function dynamicHostileText(): string {
  return hostileDynamicTerms().join(' ')
}

function visibleAndAriaText(): string {
  return [
    visibleText(container.innerHTML),
    ...[...container.querySelectorAll<HTMLElement>('[aria-label]')]
      .map((element) => element.getAttribute('aria-label') ?? ''),
  ].join(' ')
}

function visibleAriaAndAttributeText(): string {
  return [
    visibleAndAriaText(),
    ...[...container.querySelectorAll<HTMLElement>('[placeholder], [title]')]
      .flatMap((element) => [
        element.getAttribute('placeholder') ?? '',
        element.getAttribute('title') ?? '',
      ]),
  ].join(' ')
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

function client(overrides: {
  testMcpSource?: () => Promise<unknown>
  loadApprovalCards?: () => Promise<unknown>
  applyChange?: (request: { change: { key_path: string; value: unknown }; reason: string }) => Promise<unknown>
} = {}): AuroraClient {
  return {
    transport: { kind: 'http' },
    auth: {
      snapshot: () => ({ principalId: 'admin' }),
      subscribe: () => () => undefined,
    },
    tools: {
      testMcpSource: overrides.testMcpSource,
      loadApprovalCards: overrides.loadApprovalCards,
    },
    config: {
      previewDiff: async () => ({ ok: true, data: { valid: true, diffs: [], errors: [], secrets_redacted: true, base_revision: 1, preview_token: 'preview-1', changed_paths: [] } }),
      previewReloadImpact: async () => ({ ok: true, data: { affected_services: [], restart_required: false, reload_required: true, warnings: [] } }),
      applyChange: overrides.applyChange ?? (async () => ({ ok: true, data: { applied: true, revision: 2, secrets_redacted: true } })),
      getSchemaMetadata: async () => ({ ok: true, data: { fields: [configField('services.tooling.plugins.brave_search.activate', 'Activate', 'Enable Brave Search.', true, false)], secrets_redacted: true } }),
    },
  } as unknown as AuroraClient
}

function builtinPlugin(overrides: Partial<NonNullable<ToolApprovalPanelManagementState['builtinPlugins']>[number]> = {}): NonNullable<ToolApprovalPanelManagementState['builtinPlugins']>[number] {
  return {
    id: 'brave_search',
    label: 'Brave Search',
    active: false,
    configured: true,
    activateKeyPath: 'services.tooling.plugins.brave_search.activate',
    fields: [],
    evidence: 'settings',
    ...overrides,
  }
}

function configField(keyPath: string, title: string, description: string, currentValue: unknown, secret: boolean): NonNullable<ToolApprovalPanelManagementState['builtinPlugins']>[number]['fields'][number] {
  return {
    key_path: keyPath,
    title,
    description,
    type: typeof currentValue === 'boolean' ? 'boolean' : 'string',
    current_value: currentValue,
    source_layer: 'config',
    secret,
    reload_required: true,
    restart_required: false,
    affected_services: ['tooling'],
    constraints: {},
  } as NonNullable<ToolApprovalPanelManagementState['builtinPlugins']>[number]['fields'][number]
}

function backendSourceSummary(id: string, label: string): NonNullable<ToolApprovalPanelManagementState['sourceSummaries']>[number] {
  return {
    id,
    kind: 'mcp',
    label,
    providerPeerId: 'local',
    providerServiceInstanceId: id,
    providerKind: 'mcp',
    transport: 'mcp',
    trustTier: 'untrusted',
    status: 'active',
    toolCount: 1,
    blockedToolCount: 0,
    approvalRequiredCount: 0,
    newOrReviewCount: 0,
    activeGrantCount: 0,
    staleGrantCount: 0,
    includeFutureTools: false,
    cacheStatus: 'ready',
    catalogEpoch: null,
    catalogHash: null,
    generatedAt: '2026-07-28T00:00:00.000Z',
    lastAnnouncementAt: '2026-07-28T00:00:00.000Z',
    retainedToolCount: 0,
    removedToolCount: 0,
    unsharedToolCount: 0,
    secretsRedacted: true,
  } as unknown as NonNullable<ToolApprovalPanelManagementState['sourceSummaries']>[number]
}

function sourceDetail(tools: ToolApprovalCardModel[]): NonNullable<ToolApprovalPanelManagementState['sourceDetails']>[string] {
  return {
    tools,
    blockedTools: [],
    retainedTools: [],
  } as unknown as NonNullable<ToolApprovalPanelManagementState['sourceDetails']>[string]
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
