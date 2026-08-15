import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  cloneFixture,
  routeExplainFixture
} from '@aurora/client'
import { GatewayExplainRouteInputRouteExplainRequestSchema } from '@aurora/client/generated'
import {
  buildDataPolicySnapshot,
  buildMemoryViewModel,
  buildShellSnapshot,
  DataPolicyView,
  MemoryView,
  emptyMemoryViewModel,
  type RouteAvailability,
  auroraEmbeddedNavItems,
  navItemSnapshot,
  routePolicyScenarios
} from '../src/index'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

describe('Memory and data policy production stories', () => {
  it('keeps every built-in route preview within the generated Gateway selector contract', async () => {
    for (const scenario of routePolicyScenarios()) {
      const parsed = GatewayExplainRouteInputRouteExplainRequestSchema.safeParse(scenario.request)
      expect(parsed.success, `route scenario ${scenario.id}`).toBe(true)
    }

    const invalidDataRequests: Array<{ payload: unknown; issues: unknown }> = []
    let dataRequestCount = 0
    const transport = new MockAuroraTransport().register('Gateway.ExplainRoute', (request) => {
      dataRequestCount += 1
      const parsed = GatewayExplainRouteInputRouteExplainRequestSchema.safeParse(request.payload)
      if (!parsed.success) {
        invalidDataRequests.push({ payload: request.payload, issues: parsed.error.issues })
      }
      return cloneFixture(routeExplainFixture)
    })
    const client = new Aurora({ transport })
    const dataRoute = await enabledRoute(client, 'data')

    await buildDataPolicySnapshot(client, dataRoute)

    expect(dataRequestCount).toBe(5)
    expect(invalidDataRequests).toEqual([])
  })

  it('renders prototype-density Memory & Knowledge collections and search list', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const memoryRoute = await enabledRoute(client, 'memory')
    const model = await buildMemoryViewModel(client, memoryRoute, {
      namespace: 'peer-studio-gpu.memories',
      query: 'mesh pairing'
    })

    const markup = renderToStaticMarkup(<MemoryView client={client} route={memoryRoute} initialModel={model} />)

    expect(markup).toContain('Memory &amp; Knowledge')
    expect(markup).toContain('Collections')
    expect(markup).toContain('Search conversations')
    expect(markup).toContain('Shared by another device')
    expect(markup).toContain('Search hit for &quot;mesh pairing&quot;')
    expect(markup).not.toContain('Memory &amp; RAG collections')
    expect(markup).not.toContain('Export snapshot unsupported')
    expect(markup).not.toContain('Delete record unsupported')
    expect(markup).not.toContain('Evidence')
    expect(findForbiddenProductionCopyTerms(visibleText(markup)).map((term) => term.id)).toEqual([])
  })

  it('explains the no-memory state without duplicating a generic browse or capability report', async () => {
    const transport = new MockAuroraTransport()
      .register('DB.GetMessages', () => ({ messages: [], total: 0, has_more: false }))
      .register('DB.RAGListNamespaces', () => ({ namespaces: [] }))
    const client = new Aurora({ transport })
    const memoryRoute = await enabledRoute(client, 'memory')
    const model = await buildMemoryViewModel(client, memoryRoute)

    const markup = renderToStaticMarkup(<MemoryView client={client} route={memoryRoute} initialModel={model} />)

    expect(markup).toContain('No collections yet')
    expect(markup).toContain('Collections appear after conversations, approved context, or imported knowledge are saved.')
    expect(markup).toContain('No conversations yet')
    expect(markup).not.toContain('Runtime snapshot')
    expect(markup).not.toContain('Backend capability report')
  })

  it('renders data-policy privacy controls, namespace visibility, approval gates, and activity link separately from /memory search', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const dataRoute = await enabledRoute(client, 'data')
    const snapshot = await buildDataPolicySnapshot(client, dataRoute)

    const markup = renderToStaticMarkup(<DataPolicyView snapshot={snapshot} />)

    expect(markup).toContain('Review retention defaults')
    expect(markup).toContain('Retention defaults')
    expect(markup).toContain('Collection visibility')
    expect(markup).toContain('Audio storage')
    expect(markup).toContain('Transcript storage')
    expect(markup).toContain('Shared-device help')
    expect(markup).toContain('Export, delete, and import data flows')
    expect(markup).toContain('Review and approval')
    expect(markup).toContain('Activity history')
    expect(markup).toContain('Policy edits require administrator review and account history')
    expect(markup).toContain('href="/admin/audit"')
    expect(markup).not.toContain('Audit trail')
    expect(markup).not.toContain('AdminAction')
    expect(markup).not.toContain('Open audit log')
    expect(markup).not.toContain('id="memory-query"')
    expect(findForbiddenProductionCopyTerms(visibleText(markup)).map((term) => term.id)).toEqual([])
  })

  it('maps hostile memory errors to stable product copy', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const memoryRoute = await enabledRoute(client, 'memory')
    const hostile = 'thin client HTTP Gateway WebRTC transport failed'
    const model = { ...emptyMemoryViewModel(memoryRoute), loadState: 'error' as const, error: hostile }

    const text = visibleText(renderToStaticMarkup(<MemoryView client={client} route={memoryRoute} initialModel={model} />))

    expect(text).toContain('Memory is unavailable. Try again.')
    expect(text).not.toContain(hostile)
    expect(findForbiddenProductionCopyTerms(text).map((term) => term.id)).toEqual([])
  })
})

function visibleText(markup: string): string {
  return markup
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function enabledRoute(client: Aurora, id: string): Promise<RouteAvailability> {
  const snapshot = await buildShellSnapshot(client)
  const route = snapshot.routes.find((candidate) => candidate.item.id === id)
    ?? embeddedTestRoute(id)
  if (!route) throw new Error(`missing route ${id}`)
  return {
    ...route,
    state: 'available-local',
    disabled: false,
    providerLabel: 'local / DB',
    blockers: [],
    routeable: true
  }
}

function embeddedTestRoute(id: string): RouteAvailability | null {
  const item = auroraEmbeddedNavItems.find((candidate) => candidate.id === id)
  if (!item) return null
  return {
    item: navItemSnapshot(item),
    state: item.fallbackState,
    explanation: 'Embedded in a primary route for this nav revision.',
    providerLabel: 'embedded SDK route',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['embedded primary route'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}
