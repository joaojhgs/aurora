import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import {
  buildDataPolicySnapshot,
  buildMemoryViewModel,
  buildShellSnapshot,
  DataPolicyView,
  MemoryView,
  type RouteAvailability,
  auroraEmbeddedNavItems,
  navItemSnapshot
} from '../src/index'

describe('Memory and data policy production stories', () => {
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
    expect(markup).toContain('Remote peer')
    expect(markup).toContain('Search hit for &quot;mesh pairing&quot;')
    expect(markup).not.toContain('Memory &amp; RAG collections')
    expect(markup).not.toContain('Export snapshot unsupported')
    expect(markup).not.toContain('Delete record unsupported')
    expect(markup).not.toContain('Evidence')
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

  it('renders data-policy privacy controls, namespace visibility, AdminAction gates, and audit link separately from /memory search', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const dataRoute = await enabledRoute(client, 'data')
    const snapshot = await buildDataPolicySnapshot(client, dataRoute)

    const markup = renderToStaticMarkup(<DataPolicyView snapshot={snapshot} />)

    expect(markup).toContain('settings-style privacy controls')
    expect(markup).toContain('Retention defaults')
    expect(markup).toContain('Namespace visibility')
    expect(markup).toContain('Raw audio storage')
    expect(markup).toContain('Transcript storage')
    expect(markup).toContain('Remote/mesh fallback')
    expect(markup).toContain('Export, delete, and import data flows')
    expect(markup).toContain('Policy edits require AdminAction draft/confirm/audit through Config.Set')
    expect(markup).toContain('href="/admin/audit"')
    expect(markup).not.toContain('id="memory-query"')
  })
})

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
