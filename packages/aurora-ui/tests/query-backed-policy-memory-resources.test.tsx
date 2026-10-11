// @vitest-environment jsdom
import { type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routeExplainFixture, type AuroraClient, type RoutePolicyEvaluation } from '@aurora/client'
import { DataPolicyResource } from '../src/data-policy-view'
import { MemoryView, emptyMemoryViewModel, type MemoryViewModel, type MemoryNamespaceView } from '../src/memory-view'
import { RoutePolicyResource } from '../src/route-policy-view'
import type { RouteAvailability } from '../src/shell-data'

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  fallbackInterval: vi.fn((_options?: unknown) => 15000),
  scopeKey: ['aurora', 'scope:test'] as readonly string[],
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mocks.useQuery(options),
}))

vi.mock('../src/query', () => ({
  AURORA_QUERY_STALE_TIMES: { lists: 30000 },
  useAuroraQueryScope: () => true,
  useAuroraQueryScopeKey: () => mocks.scopeKey,
}))

vi.mock('../src/query-hooks', () => ({
  useAuroraQueryFallbackInterval: (options: unknown) => mocks.fallbackInterval(options),
  useAuroraQueryKeys: () => ({
    admin: (resource: string, request: unknown) => [...mocks.scopeKey, 'admin', resource, request] as const,
  }),
}))

const roots: Root[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.scopeKey = ['aurora', 'scope:test']
  mocks.useQuery.mockImplementation((options) => ({
    data: (options as { placeholderData?: unknown }).placeholderData,
    refetch: vi.fn(),
  }))
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('Query-backed policy and memory resources', () => {
  it('keys route policy by route and scenario and forwards cancellation to Aurora reads', async () => {
    const signal = new AbortController().signal
    const listCatalog = vi.fn(async () => capabilityCatalog())
    const evaluatePolicy = vi.fn(async () => routePolicyEvaluation())
    const client = {
      capabilities: { listCatalog },
      routes: { evaluatePolicy, explain: vi.fn() },
      transport: { kind: 'mock' },
    } as unknown as AuroraClient

    const { container } = render(<RoutePolicyResource client={client} route={route('memory')} />)
    const queryOptions = useQueryOptions()

    expect(queryOptions.queryKey).toEqual([
      'aurora',
      'scope:test',
      'admin',
      'route-policy',
      { routeKey: 'memory|available-local|enabled|user|Ready', scenarioId: 'assistant_prompt' },
    ])
    expect(queryOptions.refetchInterval).toBe(15000)

    const toolTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Tool action'))
    act(() => toolTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(lastUseQueryOptions().queryKey).toEqual([
      'aurora',
      'scope:test',
      'admin',
      'route-policy',
      { routeKey: 'memory|available-local|enabled|user|Ready', scenarioId: 'tool_call' },
    ])

    await queryOptions.queryFn({ signal })

    expect(listCatalog).toHaveBeenCalledWith(
      { include_unavailable: true, include_internal: true },
      { signal },
    )
    expect(evaluatePolicy).toHaveBeenCalledWith(expect.objectContaining({ routeRequest: expect.any(Object) }), { signal })
  })

  it('keys data policy by route state and lets Query own refresh and cancellation', async () => {
    const signal = new AbortController().signal
    const refetch = vi.fn()
    const listNamespaces = vi.fn(async () => ({ ok: true, data: { namespaces: [] } }))
    const listMessages = vi.fn(async () => ({ ok: true, data: { messages: [] } }))
    const listCatalog = vi.fn(async () => capabilityCatalog())
    const evaluatePolicy = vi.fn(async () => routePolicyEvaluation())
    mocks.scopeKey = ['aurora', 'scope:test']
    mocks.useQuery.mockImplementation((options) => ({
      data: (options as { placeholderData?: unknown }).placeholderData,
      refetch,
    }))
    const client = {
      memory: { listNamespaces, listMessages },
      capabilities: { listCatalog },
      routes: { evaluatePolicy },
      transport: { kind: 'mock' },
    } as unknown as AuroraClient

    const { container, root } = render(<DataPolicyResource client={client} route={route('data')} />)
    const queryOptions = useQueryOptions()

    expect(queryOptions.queryKey).toEqual([
      'aurora',
      'scope:test',
      'admin',
      'data-policy',
      { routeKey: 'data|available-local|enabled|user' },
    ])
    expect(queryOptions.enabled).toBe(true)

    const loaded = await queryOptions.queryFn({ signal })
    expect(listNamespaces).toHaveBeenCalledWith({ include_remote: true, include_unavailable: true }, { signal })
    expect(listMessages).toHaveBeenCalledWith({ limit: 6 }, { signal })
    expect(listCatalog).toHaveBeenCalledWith({ include_unavailable: true, include_internal: true }, { signal })
    expect(evaluatePolicy).toHaveBeenCalledWith(expect.objectContaining({ auditReceiptTarget: 'Auth.StoreAuditEvent' }), { signal })

    mocks.useQuery.mockImplementation(() => ({ data: loaded, refetch }))
    act(() => root.render(<DataPolicyResource client={client} route={route('data')} />))
    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Refresh'))
    expect(refresh?.disabled).toBe(false)
    act(() => refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('keeps denied data-policy and route-policy resources from starting server reads', () => {
    const refetches = [vi.fn(), vi.fn()]
    let refetchIndex = 0
    mocks.useQuery.mockImplementation((options) => ({
      data: (options as { placeholderData?: unknown }).placeholderData,
      refetch: refetches[refetchIndex++] ?? vi.fn(),
    }))
    const client = {
      memory: { listNamespaces: vi.fn(), listMessages: vi.fn() },
      capabilities: { listCatalog: vi.fn() },
      routes: { evaluatePolicy: vi.fn(), explain: vi.fn() },
      transport: { kind: 'mock' },
    } as unknown as AuroraClient

    const data = render(<DataPolicyResource client={client} route={route('data', { disabled: true, state: 'denied' })} />)
    const policy = render(<RoutePolicyResource client={client} route={route('memory', { disabled: true, state: 'denied' })} />)

    expect(useQueryOptions(0).enabled).toBe(false)
    expect(useQueryOptions(1).enabled).toBe(false)
    for (const button of [...data.container.querySelectorAll('button'), ...policy.container.querySelectorAll('button')]) {
      if (button.textContent?.includes('Refresh')) {
        act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      }
    }
    expect(refetches[0]).not.toHaveBeenCalled()
    expect(refetches[1]).not.toHaveBeenCalled()
    expect(client.memory.listNamespaces).not.toHaveBeenCalled()
    expect(client.capabilities.listCatalog).not.toHaveBeenCalled()
    expect(client.routes.evaluatePolicy).not.toHaveBeenCalled()
  })

  it('keeps memory form text local and commits namespace plus submitted search to the scoped query key', async () => {
    const memoryRoute = route('memory')
    const model = memoryModel(memoryRoute, 'main.memory', '')
    const signal = new AbortController().signal
    const listMessages = vi.fn(async () => ({ ok: true, data: { messages: [] } }))
    const listNamespaces = vi.fn(async () => ({ ok: true, data: { namespaces: [model.selectedNamespace!.info] } }))
    const search = vi.fn(async () => ({
      ok: true,
      data: {
        decision: 'allow',
        items: [],
        denial_reason: null,
        policy_decision_id: 'policy-1',
        correlation_id: 'correlation-1',
      },
    }))
    const client = { memory: { listMessages, listNamespaces, search } } as unknown as AuroraClient
    mocks.scopeKey = ['aurora', 'scope:test']
    mocks.useQuery.mockImplementation((options) => ({
      data: model,
      refetch: vi.fn(),
      queryKey: (options as { queryKey: unknown }).queryKey,
    }))

    const { container, root } = render(<MemoryView client={client} route={memoryRoute} />)
    const input = container.querySelector<HTMLInputElement>('#memory-query')
    if (!input) throw new Error('Missing memory search input')

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'pairing notes')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    const submittedOptions = lastUseQueryOptions()
    expect(submittedOptions.queryKey).toEqual([
      'aurora',
      'scope:test',
      'admin',
      'memory',
      { routeKey: 'memory|available-local|enabled|user', namespace: 'main.memory', query: 'pairing notes' },
    ])

    await submittedOptions.queryFn({ signal })
    expect(listMessages).toHaveBeenCalledWith({ limit: 8 }, { signal })
    expect(listNamespaces).toHaveBeenCalledWith({ include_remote: true, include_unavailable: true }, { signal })
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'main.memory', query: 'pairing notes' }), { signal })

    mocks.scopeKey = ['aurora', 'scope:next']
    act(() => root.render(<MemoryView client={client} route={memoryRoute} />))
    expect(lastUseQueryOptions().queryKey).toEqual([
      'aurora',
      'scope:next',
      'admin',
      'memory',
      { routeKey: 'memory|available-local|enabled|user', namespace: null, query: '' },
    ])

    act(() => root.render(<MemoryView client={client} route={route('memory', { disabled: true, state: 'denied' })} />))
    const deniedOptions = lastUseQueryOptions()
    expect(deniedOptions.enabled).toBe(false)
    expect(deniedOptions.queryKey).toEqual([
      'aurora',
      'scope:next',
      'admin',
      'memory',
      { routeKey: 'memory|denied|disabled|user', namespace: null, query: '' },
    ])
  })
})

interface CapturedQueryOptions {
  queryKey: unknown
  queryFn: (input: { signal: AbortSignal }) => Promise<unknown>
  placeholderData?: unknown
  staleTime?: unknown
  refetchInterval?: unknown
  enabled?: boolean
}

function useQueryOptions(index = 0): CapturedQueryOptions {
  const call = mocks.useQuery.mock.calls[index]
  if (!call) throw new Error(`Expected useQuery call ${index}`)
  const options = call[0]
  if (!options || typeof options !== 'object' || typeof (options as { queryFn?: unknown }).queryFn !== 'function') {
    throw new Error('Expected query options with a query function')
  }
  return options as CapturedQueryOptions
}

function lastUseQueryOptions(): CapturedQueryOptions {
  const index = mocks.useQuery.mock.calls.length - 1
  if (index < 0) throw new Error('Expected at least one useQuery call')
  return useQueryOptions(index)
}

function render(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return { container, root }
}

function route(id: string, overrides: Partial<RouteAvailability> = {}): RouteAvailability {
  return {
    item: {
      id,
      label: id,
      href: `/${id}`,
      capabilityFeatureId: `route:${id}`,
      capabilityModule: 'DB',
      capabilityMethod: 'GetMessages',
      methodType: 'query',
      privacyClass: 'personal',
      fallbackState: 'available-local',
      expectedTask: 'Review saved data',
    },
    state: 'available-local',
    explanation: 'Ready',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
    ...overrides,
  }
}

function capabilityCatalog() {
  return {
    generated_at: '2026-01-01T00:00:00Z',
    secrets_redacted: true,
    actions: [
      capabilityAction('Gateway.ExplainRoute'),
      capabilityAction('Config.Set'),
    ],
  }
}

function capabilityAction(topic: string) {
  return {
    topic,
    freshness: { stale: false },
    policy: {
      denial_reasons: [],
      approval_required: topic === 'Config.Set',
      explicit_selector_required: false,
      selector_required: false,
    },
    route_blockers: [],
    bindability: 'available',
    provider_kind: 'local',
  }
}

function routePolicyEvaluation(): RoutePolicyEvaluation {
  return {
    decision: 'allowed',
    allowed: true,
    availability: 'available-local',
    privacyClass: 'personal',
    dataClasses: ['personal'],
    reasonCode: 'allowed',
    repairPath: null,
    explicitSelectorRequired: false,
    approval: { status: 'not-required', required: false, scopes: [] },
    selectedCandidate: null,
    blockers: [],
    preview: {
      topic: 'Gateway.ExplainRoute',
      module: 'Gateway',
      method: 'ExplainRoute',
      providerId: 'local',
      peerId: null,
      serviceInstanceId: null,
      providerKind: 'local',
      trustTier: 'local',
      transport: 'mock',
      fallbackBehavior: 'local',
      egressDestination: 'local',
      expectedPersistence: 'none',
      auditReceiptTarget: 'Auth.StoreAuditEvent',
      dataClasses: ['personal'],
      privacyClass: 'personal',
      selector: null,
      payloadPreview: null,
      secretsRedacted: true,
      blockers: [],
    },
    route: {
      ...routeExplainFixture,
      selected_target: 'local',
      candidates: [],
    },
  }
}

function memoryModel(routeAvailability: RouteAvailability, namespace: string, query: string): MemoryViewModel {
  const model = emptyMemoryViewModel(routeAvailability, query)
  const namespaceView: MemoryNamespaceView = {
    info: {
      namespace,
      owner_peer_id: 'local-peer',
      source_peer_id: 'local-peer',
      provider_peer_id: 'local-peer',
      record_count: 1,
      availability: 'available',
      freshness: 'fresh',
      embedding_model: 'text-embedding',
      schema_version: '1',
      policy: {
        privacy_class: 'personal',
        sharing_mode: 'never',
        allowed_operations: ['search'],
        denial_reason: null,
        explicit_selector_required: false,
        export_supported: false,
        import_supported: false,
        delete_supported: false,
        requires_admin_approval: false,
      },
    },
    kind: 'local-memory' as const,
    label: namespace,
    selectable: true,
    stateCopy: 'available',
    repairCopy: null,
  }
  return {
    ...model,
    loadState: 'ready',
    namespaces: [namespaceView],
    selectedNamespace: namespaceView,
    actions: {
      ...model.actions,
      search: {
        supported: true,
        disabled: false,
        label: 'Search',
        reason: 'Search uses Aurora.',
        requiresAdminAction: false,
      },
    },
  }
}
