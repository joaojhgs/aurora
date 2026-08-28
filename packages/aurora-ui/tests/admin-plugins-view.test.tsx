// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport, type ToolCatalogResponse } from '@aurora/client'
import { AdminPluginsView, buildAdminPluginsSnapshot, type AdminPluginsSnapshot } from '../src/admin-plugins-view'
import { auroraEmbeddedNavItems, auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
})

describe('AdminPluginsView', () => {
  it('wires Tooling sources, policy, and fallback tools from Aurora for the Tools & Plugins screen', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.policy.mode).toBe('enforce')
    expect(snapshot.policy.pendingApprovalCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.sourceSummaries.length).toBeGreaterThan(0)
    expect(snapshot.fallbackTools.length).toBeGreaterThan(0)

    const markup = renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} />)

    expect(markup).toContain('Tools &amp; Plugins')
    expect(markup).toContain('Review:')
    expect(markup).toContain('Review required')
    expect(markup).toContain('pending')
    expect(markup).toContain('Add tool source')
    expect(markup).toContain('Tools')
    expect(markup).toContain('Plugins')
    expect(markup).toContain('Core tools')
    expect(markup).toContain('Connected tool sources')
    expect(markup).toContain('Connected devices')
    expect(markup).toContain('diagnostics.serviceHealth')
  })

  it('renders unconfigured plugin templates as Configure cards in the Plugins tab', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const markup = renderToStaticMarkup(
      <AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} initialTab="plugins" />
    )

    // Default fixtures report no `plugin`-kind sources, so both onboarding
    // templates should render as unconfigured "Configure" cards.
    expect(markup).toContain('notion-plugin')
    expect(markup).toContain('home-assistant-plugin')
    expect(markup).toContain('Configure')
  })

  it('shows permission-blocked peer tools as stable, disabled management rows without adding them to bindable fallback tools', async () => {
    const stablePeerId = 'aurora-da2c3842004492c887b3ce878c8eb0cb'
    const stableToolId = `${stablePeerId}:remote_${stablePeerId}_Tooling:tool:list_scheduled_tasks_tool`
    const stableSourceId = `mesh:${stablePeerId}:remote_${stablePeerId}_Tooling`
    const catalog: ToolCatalogResponse = {
      tools: [],
      blocked_tools: [{
        reason_code: 'permission_denied',
        reason: 'caller principal lacks required tool permissions',
        missing_permissions: ['Scheduler.use'],
        tool: {
          global_tool_id: stableToolId,
          local_name: 'list_scheduled_tasks_tool',
          display_name: 'aurora-2.list_scheduled_tasks_tool',
          description: 'List scheduled tasks on aurora-2.',
          provider_label: 'aurora-2',
          provider_peer_id: stablePeerId,
          provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
          provider_kind: 'mesh_peer',
          source: 'mesh_peer',
          source_type: 'mesh_peer',
          source_id: stableSourceId,
          required_permissions: ['Scheduler.use']
        }
      }],
      providers: [{
        provider_peer_id: stablePeerId,
        provider_service_instance_id: `remote:${stablePeerId}:Tooling`,
        provider_label: 'aurora-2',
        provider_kind: 'mesh_peer',
        eligible: true
      }],
      secrets_redacted: true
    }
    const transport = MockAuroraTransport.empty().register('Tooling.GetToolCatalog', () => catalog)
    const client = new Aurora({ transport })

    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const markup = renderToStaticMarkup(
      <AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} />
    )

    expect(snapshot.fallbackTools).toEqual([])
    expect(snapshot.sourceDetails[stableSourceId]?.blockedTools[0]).toMatchObject({
      id: stableToolId,
      providerPeerId: stablePeerId,
      state: 'unavailable',
      blockReasonCode: 'permission_denied'
    })
    expect(markup).toContain('aurora-2')
    expect(markup).toContain('aurora-2.list_scheduled_tasks_tool')
    expect(markup).toContain('Missing required permission: Scheduler.use.')
    expect(markup).toContain('Not callable from this peer.')
    expect(markup).toContain('missing permission')
    expect(markup).not.toContain(stablePeerId)
  })

  it('renders loading, empty, denied, service-unavailable, and route-disabled states', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={loadingSnapshot()} />)
    ).toContain('Loading Tooling catalog')

    const emptyTransport = MockAuroraTransport.empty()
      .register('Tooling.GetToolCatalog', () => ({ tools: [], secrets_redacted: true }))
      .register('Tooling.ListToolSources', () => ({ sources: [], count: 0, secrets_redacted: true }))
      .register('Tooling.GetSharingPolicy', () => ({ policy: { default_share: true, default_approval_mode: 'approve_all_local_safe', policy_mode: 'enforce', default_token_ttl_seconds: 300, rules: [] } }))
      .register('Tooling.ListApprovalGrants', () => ({ count: 0, grants: [] }))
      .register('Orchestrator.ListPendingToolApprovals', () => ({ count: 0, approvals: [] }))
      .register('Auth.AuditLog', () => ({ events: [], total: 0 }))
      .register('Tooling.GetMCPStatus', () => ({ started: false, servers: [], total_servers: 0, active_servers: 0 }))
    const emptySnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: emptyTransport }), pluginsRoute())
    expect(emptySnapshot.loadState).toBe('empty')
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={emptySnapshot} />)
    ).toContain('No tools are available from Aurora yet')

    const deniedTransport = MockAuroraTransport.empty().fail('Tooling.GetToolCatalog', 'permission', 'tool catalog denied')
    const deniedSnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: deniedTransport }), pluginsRoute())
    expect(deniedSnapshot.loadState).toBe('denied')
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={deniedSnapshot} />)
    ).toContain('Permission is needed to use this feature')

    const unavailableTransport = MockAuroraTransport.empty().lose('Tooling.GetToolCatalog')
    const unavailableSnapshot = await buildAdminPluginsSnapshot(new Aurora({ transport: unavailableTransport }), pluginsRoute())
    expect(unavailableSnapshot.loadState).toBe('service-unavailable')

    const disabledRoute: RouteAvailability = { ...pluginsRoute(), disabled: true, state: 'denied', blockers: ['missing:Tooling.manage'] }
    const disabledSnapshot = await buildAdminPluginsSnapshot(client, disabledRoute)
    expect(disabledSnapshot.loadState).toBe('denied')
    expect(
      renderToStaticMarkup(<AdminPluginsView client={client} route={disabledRoute} initialSnapshot={disabledSnapshot} />)
    ).toContain('Permission is needed to use this feature')
  })

  it('maps hostile MCP wizard backend errors before rendering', async () => {
    const hostile = 'Tooling.TestMCPSource services.orchestrator.llm.provider sk-abc123 proof fallback protocol room_password /api/admin/schema'
    const client = new Aurora({ transport: wizardErrorTransport('Tooling.TestMCPSource', hostile) })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const container = mount(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} />)

    await clickButton(container, 'Add tool source')
    await setInputValue(document.body.querySelector('#mcp-source-name') as HTMLInputElement, 'local-mcp')
    await setInputValue(document.body.querySelector('#mcp-source-command') as HTMLInputElement, 'npx safe-mcp')
    await clickButton(document.body, 'Test & add source')

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Check the source details and try again.')
    expectUnsafeWizardCopyAbsent(alert?.outerHTML ?? '')
  })

  it('maps hostile plugin wizard backend errors before rendering', async () => {
    const hostile = 'Tooling.TestPluginSource services-orchestrator-llm-provider api_key=sk-abc123 schema fallback protocol room_password /api/admin/plugin'
    const client = new Aurora({ transport: wizardErrorTransport('Tooling.TestPluginSource', hostile) })
    const snapshot = await buildAdminPluginsSnapshot(client, pluginsRoute())
    const container = mount(<AdminPluginsView client={client} route={pluginsRoute()} initialSnapshot={snapshot} initialTab="plugins" />)

    await clickButton(container, 'Configure')
    await setInputValue(document.body.querySelector('#plugin-config-key') as HTMLInputElement, 'safe-local-test-key')
    await setInputValue(document.body.querySelector('#plugin-config-scope') as HTMLInputElement, 'default')
    await clickButton(document.body, 'Save & activate')

    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Check the source details and try again.')
    expectUnsafeWizardCopyAbsent(alert?.outerHTML ?? '')
  })
})

function mount(node: ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(node)
  })
  return container
}

async function clickButton(container: ParentNode, text: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(text))
  expect(button).not.toBeNull()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function setInputValue(input: HTMLInputElement | null, value: string): Promise<void> {
  expect(input).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

function wizardErrorTransport(method: 'Tooling.TestMCPSource' | 'Tooling.TestPluginSource', error: string): MockAuroraTransport {
  return new MockAuroraTransport().register(method, () => ({
    ok: false,
    source_id: 'local:test',
    error,
    secrets_redacted: true
  }))
}

function expectUnsafeWizardCopyAbsent(markup: string): void {
  expect(markup).not.toMatch(/Tooling\.Test|services[._/-]?orchestrator|sk-abc123|api[_ -]?key|proof|fallback|protocol|room[_ -]?password|schema|\/api\/admin/iu)
}

function loadingSnapshot(): AdminPluginsSnapshot {
  return {
    loadState: 'loading' as const,
    policy: {
      mode: 'enforce',
      defaultBehavior: 'Loading Tooling policy through Aurora.',
      activeGrantCount: 0,
      pendingApprovalCount: 0,
      blockedCount: 0,
      sourceCount: 0,
      bypassEnabled: false,
      dryRunOnly: false,
      denyAll: false,
      lastChanged: 'not reported',
      actor: 'not reported',
      evidence: 'pending Aurora service calls'
    },
    sourceSummaries: [],
    sourceDetails: {},
    fallbackTools: [],
    warnings: [],
    error: null,
    evidenceSource: 'pending Aurora service calls'
  }
}

function pluginsRoute(): RouteAvailability {
  const item = [...auroraNavSections.flatMap((section) => section.items), ...auroraEmbeddedNavItems].find((candidate) => candidate.id === 'plugins')
  if (!item) throw new Error('plugins route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Tooling catalog route available from mock status.',
    providerLabel: 'mock Tooling.GetToolCatalog',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Tooling.GetToolCatalog', 'Gateway.GetRegistry'],
    selectorRequired: false,
    approvalRequired: true,
    routeable: true,
    disabled: false,
    requiresAdminAction: true
  }
}
