// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AUTH_METHODS,
  AuroraClient as Aurora,
  MockAuroraTransport,
  SCHEDULER_METHODS,
  capabilityCatalogFixture,
  cloneFixture,
  gatewayRegistryFixture,
  schedulerJobsFixture,
  toolCatalogFixture,
  type AuroraClient,
  type CapabilityCatalogResponse,
  type GetRegistryResponse,
  type GetServicesResponse,
  type SchedulerActionResponse,
  type TokenResponse
} from '@aurora/client'
import { AuroraQueryProvider, createAuroraQueryClient } from '../src/query'
import { AdminContractsResource, AdminServicesResource } from '../src/admin-services-view'
import { AdminSchedulerView, buildAdminSchedulerSnapshot } from '../src/admin-scheduler-view'
import { AdminTokensResource } from '../src/admin-tokens-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren()
})

describe('admin Query migration', () => {
  it('dedupes services and contracts loads through one scoped admin query key', async () => {
    const calls: string[] = []
    const client = new Aurora({ transport: servicesTransport(calls) })
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-one' }}>
          <AdminServicesResource client={client} />
          <AdminContractsResource client={client} />
        </AuroraQueryProvider>,
      )
    })
    await act(async () => { await settleQueries(queryClient) })

    expect(calls).toEqual(['Gateway.GetServices', 'Gateway.GetRegistry', 'Gateway.GetCapabilityCatalog'])
    expect(container.textContent).toContain('Settings')
    expect(container.textContent).toContain('Service actions')

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })

  it('keeps services and contracts admin query data separated by peer scope', async () => {
    const calls: string[] = []
    const client = new Aurora({ transport: servicesTransport(calls) })
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    function Harness({ peerId }: { peerId: string }) {
      return (
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId }}>
          <AdminServicesResource client={client} />
          <AdminContractsResource client={client} />
        </AuroraQueryProvider>
      )
    }

    await act(async () => {
      root.render(<Harness peerId="peer-one" />)
    })
    await act(async () => { await flushPromises() })
    await act(async () => {
      root.render(<Harness peerId="peer-two" />)
    })
    await act(async () => { await flushPromises() })

    expect(calls).toEqual([
      'Gateway.GetServices',
      'Gateway.GetRegistry',
      'Gateway.GetCapabilityCatalog',
      'Gateway.GetServices',
      'Gateway.GetRegistry',
      'Gateway.GetCapabilityCatalog'
    ])

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })

  it('does not read scheduler resources when the route is disabled before query execution', async () => {
    const calls: string[] = []
    const client = new Aurora({ transport: schedulerTransport(calls) })
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-one' }}>
          <AdminSchedulerView client={client} route={schedulerRoute({ disabled: true, state: 'denied' })} />
        </AuroraQueryProvider>,
      )
    })
    await act(async () => { await flushPromises() })

    expect(calls).toEqual([])
    expect(container.textContent).toContain('Scheduler')

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })

  it('invalidates the scoped scheduler query after an audited mutation', async () => {
    const calls: string[] = []
    const client = new Aurora({ transport: schedulerTransport(calls, schedulerRegistryFixture()) })
    const initialSnapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute())
    calls.splice(0)
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId: 'peer-one' }}>
          <AdminSchedulerView client={client} route={schedulerRoute()} initialSnapshot={initialSnapshot} />
        </AuroraQueryProvider>,
      )
    })
    await act(async () => { await settleQueries(queryClient) })
    calls.splice(0)

    const cancelButton = Array.from(container.querySelectorAll('button')).find((button) => /cancel/i.test(button.textContent ?? ''))
    const unlock = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(cancelButton).toBeDefined()
    expect(unlock).not.toBeNull()

    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => { await flushPromises() })

    expect(calls).toEqual([
      'Gateway.AdminActionDraft',
      'Gateway.AdminActionConfirm',
      SCHEDULER_METHODS.cancel,
      SCHEDULER_METHODS.listJobs,
      'Gateway.GetRegistry',
      'Gateway.GetCapabilityCatalog',
      'Tooling.GetToolCatalog'
    ])
    expect(container.textContent).toContain('scheduler.cancel.audit')

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })


  it('clears token one-time reveal and recent unlock immediately when the query scope changes', async () => {
    const controls = tokenClientControls()
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await renderTokens(root, container, controls.client, queryClient, 'peer-one')
    await createTokenFromForm(container)
    controls.create.resolve(tokenCreateResponse('secret-peer-one'))
    await act(async () => { await flushPromises() })

    expect(container.textContent).toContain('secret-peer-one')
    expect(adminUnlockCheckbox(container)?.checked).toBe(true)

    await renderTokens(root, container, controls.client, queryClient, 'peer-two')

    expect(container.textContent).not.toContain('secret-peer-one')
    expect(container.textContent).not.toContain('Copy this token now')
    expect(adminUnlockCheckbox(container)?.checked).toBe(false)

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })

  it('ignores a late token mint from the previous auth scope', async () => {
    const controls = tokenClientControls()
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await renderTokens(root, container, controls.client, queryClient, 'peer-one')
    await createTokenFromForm(container)
    expect(container.textContent).toContain('Applying token change')

    await renderTokens(root, container, controls.client, queryClient, 'peer-two')
    expect(container.textContent).not.toContain('Applying token change')

    controls.create.resolve(tokenCreateResponse('late-old-scope-secret'))
    await act(async () => { await flushPromises() })

    expect(container.textContent).not.toContain('late-old-scope-secret')
    expect(container.textContent).not.toContain('Copy this token now')
    expect(container.textContent).not.toContain('Token creation failed')

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })

  it('ignores late token update and revoke failures from the previous auth scope', async () => {
    const controls = tokenClientControls()
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await renderTokens(root, container, controls.client, queryClient, 'peer-one')
    await unlockTokenAdmin(container)
    await startTokenScopeUpdate(container, 'Assistant.use, TTS.use')
    expect(container.textContent).toContain('Applying token change')

    await renderTokens(root, container, controls.client, queryClient, 'peer-two')
    controls.update.reject(new Error('previous scope update failed'))
    await act(async () => { await flushPromises() })

    expect(container.textContent).not.toContain('Token scopes could not be updated')
    expect(container.textContent).not.toContain('previous scope update failed')

    controls.update = deferred<{ data: { success: boolean }; auditReceipt: string; actionId: string }>()
    await unlockTokenAdmin(container)
    await startTokenRevoke(container)
    expect(container.textContent).toContain('Applying token change')

    await renderTokens(root, container, controls.client, queryClient, 'peer-three')
    controls.revoke.reject(new Error('previous scope revoke failed'))
    await act(async () => { await flushPromises() })

    expect(container.textContent).not.toContain('Token could not be revoked')
    expect(container.textContent).not.toContain('previous scope revoke failed')

    root.unmount()
    roots.splice(roots.indexOf(root), 1)
    queryClient.clear()
    container.remove()
  })

  it('ignores a token mint that settles after unmount', async () => {
    const controls = tokenClientControls()
    const queryClient = createAuroraQueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await renderTokens(root, container, controls.client, queryClient, 'peer-one')
    await createTokenFromForm(container)
    expect(container.textContent).toContain('Applying token change')

    await act(async () => root.unmount())
    roots.splice(roots.indexOf(root), 1)
    controls.create.resolve(tokenCreateResponse('after-unmount-secret'))
    await act(async () => { await flushPromises() })

    expect(invalidateSpy).not.toHaveBeenCalled()
    queryClient.clear()
    container.remove()
  })
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

async function flushQueryRender(): Promise<void> {
  await flushPromises()
  await flushPromises()
}

async function settleQueries(queryClient: ReturnType<typeof createAuroraQueryClient>): Promise<void> {
  for (let cycle = 0; cycle < 8; cycle += 1) {
    await flushPromises()
    if (queryClient.isFetching() === 0) break
  }
  await flushPromises()
}

function authFacade(peerId = 'peer-one') {
  return {
    snapshot: () => ({
      state: 'authenticated',
      principalId: 'principal-admin',
      deviceId: 'device-admin',
      peerId,
      credentialKind: 'admin',
      source: 'test',
      tokenExpiresAt: null,
      status: 200,
      isAdmin: true,
      effectivePermissions: ['Auth.manage', 'Scheduler.manage', 'Config.manage'],
    }),
    subscribe: () => () => {},
  }
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

type TokenMutationResult<T> = { data: T; auditReceipt: string; actionId: string }

type TokenClientControls = {
  client: AuroraClient
  create: Deferred<TokenMutationResult<{ token: string; id: string; prefix: string; scopes: string[]; expires_at: string | null }>>
  update: Deferred<TokenMutationResult<{ success: boolean }>>
  revoke: Deferred<TokenMutationResult<{ success: boolean }>>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function renderTokens(
  root: Root,
  container: HTMLElement,
  client: AuroraClient,
  queryClient: ReturnType<typeof createAuroraQueryClient>,
  peerId: string,
): Promise<void> {
  await act(async () => {
    root.render(
      <AuroraQueryProvider client={client} queryClient={queryClient} queryScope={{ backend: 'unit', peerId }}>
        <AdminTokensResource client={client} />
      </AuroraQueryProvider>,
    )
    await flushPromises()
  })
  expect(container.textContent).toContain('Tokens')
}

async function unlockTokenAdmin(container: HTMLElement): Promise<void> {
  const checkbox = adminUnlockCheckbox(container)
  expect(checkbox).not.toBeNull()
  if (!checkbox?.checked) {
    await act(async () => {
      checkbox!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => { await flushPromises() })
  }
}

function adminUnlockCheckbox(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[type="checkbox"]')
}

async function createTokenFromForm(container: HTMLElement): Promise<void> {
  await unlockTokenAdmin(container)
  await updateInput(container.querySelector('input[placeholder="principal-id"]'), 'principal-new')
  await updateInput(container.querySelector('input[placeholder="Permission names, separated by commas"]'), 'Assistant.use')
  await clickButton(container, 'Create token')
}

async function startTokenScopeUpdate(container: HTMLElement, scopes: string): Promise<void> {
  await clickButton(container, 'Edit scopes')
  await updateInput(container.querySelector('#token-scopes-token-existing'), scopes)
  await clickButton(container, 'Save')
}

async function startTokenRevoke(container: HTMLElement): Promise<void> {
  const rowRevoke = buttonsByText(container, 'Revoke').find((button) => button.getAttribute('aria-label')?.startsWith('Revoke token'))
  expect(rowRevoke).toBeDefined()
  expect(rowRevoke!.disabled).toBe(false)
  await act(async () => {
    rowRevoke!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
  })
  const confirmRevoke = buttonsByText(document.body, 'Revoke').find((button) => !button.getAttribute('aria-label'))
  expect(confirmRevoke).toBeDefined()
  expect(confirmRevoke!.disabled).toBe(false)
  await act(async () => {
    confirmRevoke!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
  })
}

async function updateInput(input: Element | null, value: string): Promise<void> {
  expect(input).not.toBeNull()
  await act(async () => {
    const target = input as HTMLInputElement
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }))
    await flushPromises()
  })
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = buttonsByText(container, label)[0]
  expect(button).toBeDefined()
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushPromises()
  })
}

function buttonsByText(container: HTMLElement, label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((button) => button.textContent?.trim() === label)
}

function tokenClientControls(): TokenClientControls {
  const existingToken: TokenResponse = {
    id: 'token-existing',
    prefix: 'aur_tok',
    user_id: 'principal-existing',
    device_id: 'device-existing',
    scopes: ['Assistant.use'],
    created_at: '2026-07-02T00:00:00Z',
    expires_at: null
  }
  const controls: TokenClientControls = {
    client: null as unknown as AuroraClient,
    create: deferred<TokenMutationResult<{ token: string; id: string; prefix: string; scopes: string[]; expires_at: string | null }>>(),
    update: deferred<TokenMutationResult<{ success: boolean }>>(),
    revoke: deferred<TokenMutationResult<{ success: boolean }>>()
  }
  controls.client = {
    transport: { kind: 'mock' },
    auth: authFacade(),
    tokens: {
      list: vi.fn(async () => ({ ok: true, data: { tokens: [existingToken] } })),
      create: vi.fn(() => controls.create.promise),
      updateScopes: vi.fn(() => controls.update.promise),
      revoke: vi.fn(() => controls.revoke.promise)
    },
    capabilities: {
      listCatalog: vi.fn(async () => tokenCapabilityCatalog())
    }
  } as unknown as AuroraClient
  return controls
}

function tokenCreateResponse(secret: string): TokenMutationResult<{ token: string; id: string; prefix: string; scopes: string[]; expires_at: string | null }> {
  return {
    data: {
      token: secret,
      id: `token-${secret}`,
      prefix: 'aur_new',
      scopes: ['Assistant.use'],
      expires_at: null
    },
    auditReceipt: `audit-${secret}`,
    actionId: `action-${secret}`
  }
}

function tokenCapabilityCatalog(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const provider = {
    ...catalog.providers[0]!,
    provider_id: 'local:Auth',
    peer_id: null,
    provider_kind: 'local',
    module: 'Auth',
    service_instance_id: 'auth-local-1',
    eligible: true,
    reason_code: 'eligible',
    reason: 'Token administration is available after admin approval.',
    policy: {
      ...catalog.providers[0]!.policy,
      required_permissions: ['Auth.manage'],
      approval_required: true,
      operation_class: 'admin-critical',
      safety_class: 'credential',
      denial_reasons: []
    },
    freshness: { ...catalog.providers[0]!.freshness, stale: false, registry_digest: 'auth-registry' }
  }
  const actionBase = catalog.actions[0]!
  const actions = [
    AUTH_METHODS.listTokens,
    AUTH_METHODS.createToken,
    AUTH_METHODS.updateTokenScopes,
    AUTH_METHODS.revokeToken
  ].map((topic) => ({
    ...actionBase,
    action_id: `auth-${topic}`,
    module: 'Auth',
    method: topic.replace('Auth.', ''),
    topic,
    provider_id: provider.provider_id,
    peer_id: provider.peer_id,
    provider_kind: 'local',
    service_instance_id: provider.service_instance_id,
    selector: { peer_id: 'local-peer', module: 'Auth' },
    bindability: 'available' as const,
    route_blockers: [],
    summary: 'Token administration is available after admin approval.',
    policy: provider.policy,
    freshness: provider.freshness
  }))
  return {
    ...catalog,
    generated_at: '2026-07-02T00:00:00Z',
    providers: [provider],
    actions,
    resources: [],
    provider_index: { Auth: [provider.provider_id] },
    action_index: Object.fromEntries(actions.map((action) => [String(action.topic), [action.action_id]])),
    secrets_redacted: true
  }
}

function servicesTransport(calls: string[] = []): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Gateway.GetServices', () => {
      calls.push('Gateway.GetServices')
      return servicesFixture()
    })
    .register('Gateway.GetRegistry', () => {
      calls.push('Gateway.GetRegistry')
      return registryFixture()
    })
    .register('Gateway.GetCapabilityCatalog', () => {
      calls.push('Gateway.GetCapabilityCatalog')
      return catalogFixture()
    })
}

function servicesFixture(): GetServicesResponse {
  return {
    mode: 'processes',
    services: [
      {
        module: 'Config',
        version: '9.9.9',
        summary: 'Settings service with reload control',
        capabilities: ['schema', 'reload'],
        method_count: 1,
        last_seen: '2026-07-02T00:00:00Z',
        status: 'healthy',
        instance_id: 'config-local-1'
      }
    ]
  }
}

function registryFixture(): GetRegistryResponse {
  return {
    digest: 'services-registry',
    service_count: 1,
    method_count: 1,
    modules: [
      {
        module: 'Config',
        version: '9.9.9',
        summary: 'Settings service with reload control',
        capabilities: ['schema', 'reload'],
        methods: [method('Config.ReloadService', 'Config', 'ReloadService', 'manage', '/api/Config/ReloadService')]
      }
    ]
  }
}

function catalogFixture(): CapabilityCatalogResponse {
  const catalog = cloneFixture(capabilityCatalogFixture)
  const provider = {
    ...catalog.providers[0]!,
    provider_id: 'local:Config',
    module: 'Config',
    service_instance_id: 'config-local-1',
    reason: 'Settings reload is available after admin approval.',
    policy: {
      ...catalog.providers[0]!.policy,
      required_permissions: ['Config.manage'],
      approval_required: true,
      operation_class: 'admin',
      safety_class: 'admin'
    },
    freshness: { ...catalog.providers[0]!.freshness, stale: false, registry_digest: 'services-registry' }
  }
  const action = {
    ...catalog.actions[0]!,
    action_id: 'config-reload',
    module: 'Config',
    method: 'ReloadService',
    topic: 'Config.ReloadService',
    provider_id: 'local:Config',
    service_instance_id: 'config-local-1',
    bindability: 'available',
    route_hints: ['/api/Config/ReloadService'],
    route_blockers: [],
    summary: 'Reload settings after configuration changes.',
    policy: provider.policy,
    freshness: provider.freshness
  }
  return {
    ...catalog,
    generated_at: '2026-07-02T00:00:00Z',
    providers: [provider],
    actions: [action],
    resources: [],
    provider_index: { Config: ['local:Config'] },
    action_index: { 'Config.ReloadService': ['config-reload'] },
    secrets_redacted: true
  }
}

function method(busTopic: string, module: string, name: string, methodType: 'use' | 'manage', routePath: string) {
  return {
    name,
    summary: `${busTopic} test method`,
    bus_topic: busTopic,
    route_path: routePath,
    exposure: 'external' as const,
    method_type: methodType,
    input_model: `${name}Request`,
    output_model: `${name}Response`,
    required_perms: [`${module}.manage`],
    input_schema: { type: 'object' },
    output_schema: { type: 'object' }
  }
}

function schedulerRoute(overrides: Partial<RouteAvailability> = {}): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'scheduler')
  if (!item) throw new Error('scheduler route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Scheduler route available from live registry and capability catalog status.',
    providerLabel: 'mock Scheduler.ListJobs',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Scheduler.ListJobs', 'Gateway.GetRegistry', 'Gateway.GetCapabilityCatalog'],
    selectorRequired: false,
    approvalRequired: true,
    routeable: true,
    disabled: false,
    requiresAdminAction: true,
    ...overrides
  }
}

function schedulerRegistryFixture(): GetRegistryResponse {
  return {
    ...gatewayRegistryFixture,
    modules: [
      ...gatewayRegistryFixture.modules,
      {
        module: 'Scheduler',
        version: '9.9.9',
        summary: 'Scheduler admin methods',
        capabilities: ['jobs'],
        methods: [
          method(SCHEDULER_METHODS.listJobs, 'Scheduler', 'ListJobs', 'use', '/api/Scheduler/ListJobs'),
          method(SCHEDULER_METHODS.cancel, 'Scheduler', 'Cancel', 'manage', '/api/Scheduler/Cancel'),
          method(SCHEDULER_METHODS.pause, 'Scheduler', 'Pause', 'manage', '/api/Scheduler/Pause'),
          method(SCHEDULER_METHODS.resume, 'Scheduler', 'Resume', 'manage', '/api/Scheduler/Resume'),
          method(SCHEDULER_METHODS.scheduleAction, 'Scheduler', 'ScheduleAction', 'manage', '/api/Scheduler/ScheduleAction'),
        ]
      }
    ],
    service_count: gatewayRegistryFixture.service_count + 1,
    method_count: gatewayRegistryFixture.method_count + 5
  }
}

function schedulerTransport(calls: string[] = [], registry: GetRegistryResponse = gatewayRegistryFixture): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register(SCHEDULER_METHODS.listJobs, () => {
      calls.push(SCHEDULER_METHODS.listJobs)
      return schedulerJobsFixture
    })
    .register('Gateway.GetRegistry', () => {
      calls.push('Gateway.GetRegistry')
      return registry
    })
    .register('Gateway.GetCapabilityCatalog', () => {
      calls.push('Gateway.GetCapabilityCatalog')
      return capabilityCatalogFixture
    })
    .register('Tooling.GetToolCatalog', () => {
      calls.push('Tooling.GetToolCatalog')
      return toolCatalogFixture
    })
    .register('Gateway.AdminActionDraft', () => {
      calls.push('Gateway.AdminActionDraft')
      return {
        action_id: 'aa-scheduler',
        nonce: 'nonce',
        digest: 'digest',
        method_id: SCHEDULER_METHODS.cancel,
        affected_resources: ['scheduler.jobs'],
        required_phrase: 'CONFIRM',
        required_reason: true,
        required_reauth: true,
        expires_at: '2026-07-02T00:05:00Z',
        expires_in_seconds: 300,
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }
    })
    .register('Gateway.AdminActionConfirm', () => {
      calls.push('Gateway.AdminActionConfirm')
      return {
        action_id: 'aa-scheduler',
        confirmation_token: 'token',
        digest: 'digest',
        confirmed: true,
        expires_at: '2026-07-02T00:05:00Z',
        audit_receipt: 'audit-scheduler-001',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }
    })
    .register(SCHEDULER_METHODS.cancel, () => {
      calls.push(SCHEDULER_METHODS.cancel)
      return {
        ok: true,
        status: 'cancelled',
        job_id: 'job-local-daily-digest',
        action: 'cancel',
        reason: 'scheduler.cancel.audit',
        audit_event: 'scheduler.cancel.audit'
      } satisfies SchedulerActionResponse
    })
    .register(SCHEDULER_METHODS.scheduleAction, () => {
      calls.push(SCHEDULER_METHODS.scheduleAction)
      return {
        ok: true,
        job_id: 'job-typed-tooling',
        status: 'scheduled',
        reason: 'scheduled typed tooling action job-typed-tooling',
        policy_decision_id: 'policy-schedule-action-ui',
        correlation_id: 'corr-schedule-action-ui'
      }
    })
}
