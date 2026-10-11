// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuroraClient, ModelRuntimeCatalogRequest, ModelRuntimeCatalogResponse, ModelRuntimeProviderInfo } from '@aurora/client'
import { AuroraQueryProvider, createAuroraQueryClient } from './query'
import type { RouteAvailability } from './shell-data'
import {
  assistantExecutionOptions,
  assistantInferencePolicy,
  assistantModelChoices,
  useAssistantExecution,
} from './use-assistant-execution'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('assistant execution seam', () => {
  it('keeps local lightweight execution first while adding selectable connected devices', () => {
    const route = routeAvailability()
    const options = assistantExecutionOptions(route, {
      executionHost: 'this-device',
      localExecutionAvailable: true,
    })

    expect(options.map((option) => option.id)).toEqual([
      'local',
      'dispatch:peer-a'
    ])
    expect(options[0]).toMatchObject({
      runner: 'lightweight-local',
      routePolicy: {
        providerId: null,
        peerId: null,
        serviceInstanceId: null,
      }
    })
    expect(options[1]).toMatchObject({
      mode: 'dispatch',
      executionPeerId: 'peer-a',
      routePolicy: {
        providerId: 'mesh:peer-a:orchestrator',
        peerId: 'peer-a',
        serviceInstanceId: 'mesh:peer-a:orchestrator',
        privacyClass: 'personal',
      }
    })
  })

  it('builds a remote inference policy from selected connected-device model choice', () => {
    const route = routeAvailability()
    const execution = assistantExecutionOptions(route, { executionHost: 'this-device' })[1]!
    const provider = {
      provider_id: 'mesh:peer-a:orchestrator',
      display_name: 'Peer model source',
      provider_type: 'local',
      provider_kind: 'mesh',
      backend_kind: 'native',
      enabled: true,
      health: 'ready',
      model_id: 'llama-local',
      default_model_id: 'llama-local',
      models: [{
        model_id: 'llama-local',
        display_name: 'Peer Llama',
        provider_id: 'mesh:peer-a:orchestrator',
        available: true,
        secrets_redacted: true,
      }],
      provider_peer_id: 'peer-a',
      provider_service_instance_id: 'mesh:peer-a:orchestrator',
      secrets_redacted: true,
    } as unknown as ModelRuntimeProviderInfo
    const choices = assistantModelChoices({
      providers: [provider],
      selected_provider_id: provider.provider_id,
      provider_index: { [provider.provider_id]: ['llama-local'] },
      unavailable: [],
      internal_only: [],
      generated_at: '2026-09-16T00:00:00.000Z',
      secrets_redacted: true,
    }, execution)
    const selected = choices.find((choice) => !choice.automatic)!

    expect(assistantInferencePolicy(selected, route)).toEqual({
      providerId: provider.provider_id,
      peerId: 'peer-a',
      serviceInstanceId: 'mesh:peer-a:orchestrator',
      runtimeProviderId: null,
      modelId: 'llama-local',
      privacyClass: 'personal',
      selectorRequired: false,
      approvalRequired: false,
      dataLeavesDevice: true,
    })
  })

  it('refreshes model catalogs by query scope and ignores stale results after scope changes', async () => {
    const firstCatalog = deferred<ModelRuntimeCatalogResponse>()
    const firstListCatalog = vi.fn((_request: ModelRuntimeCatalogRequest) => firstCatalog.promise)
    const secondListCatalog = vi.fn(async (_request: ModelRuntimeCatalogRequest) => modelCatalog('provider-b', 'Second profile model'))
    const firstClient = assistantExecutionClient('user-a', firstListCatalog)
    const secondClient = assistantExecutionClient('user-b', secondListCatalog)
    const queryClient = createAuroraQueryClient()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const result: { current: ReturnType<typeof useAssistantExecution> | null } = { current: null }

    await act(async () => {
      root.render(createElement(
        AuroraQueryProvider,
        {
          client: firstClient,
          queryClient,
          queryScope: { backend: 'home', profileId: 'profile-a' },
          children: createElement(AssistantExecutionProbe, {
            client: firstClient,
            route: localRouteAvailability(),
            onResult: (next) => { result.current = next }
          })
        }
      ))
    })

    await vi.waitFor(() => expect(firstListCatalog).toHaveBeenCalledTimes(1))
    expect(result.current?.modelCatalogLoading).toBe(true)

    await act(async () => {
      root.render(createElement(
        AuroraQueryProvider,
        {
          client: secondClient,
          queryClient,
          queryScope: { backend: 'home', profileId: 'profile-b' },
          children: createElement(AssistantExecutionProbe, {
            client: secondClient,
            route: localRouteAvailability(),
            onResult: (next) => { result.current = next }
          })
        }
      ))
      await flushPromises()
    })

    await vi.waitFor(() => expect(secondListCatalog).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(result.current?.modelChoices.some((choice) => choice.model.name === 'Second profile model')).toBe(true)
    })

    await act(async () => {
      firstCatalog.resolve(modelCatalog('provider-a', 'Stale profile model'))
      await flushPromises()
    })

    expect(result.current?.modelChoices.some((choice) => choice.model.name === 'Second profile model')).toBe(true)
    expect(result.current?.modelChoices.some((choice) => choice.model.name === 'Stale profile model')).toBe(false)
    const assistantCatalogQueries = queryClient.getQueryCache().findAll({ queryKey: ['aurora'] })
      .filter((query) => query.queryKey[2] === 'admin' && query.queryKey[3] === 'assistant-model-catalog')
    expect(assistantCatalogQueries).toHaveLength(1)
    expect(assistantCatalogQueries[0]?.state.data).toEqual(modelCatalog('provider-b', 'Second profile model'))

    queryClient.clear()
  })
})

function AssistantExecutionProbe({
  client,
  route,
  onResult,
}: {
  client: AuroraClient
  route: RouteAvailability
  onResult: (result: ReturnType<typeof useAssistantExecution>) => void
}) {
  const result = useAssistantExecution({
    client,
    route,
    runtimeHealth: undefined,
    executionHost: 'this-device',
    localExecutionAvailable: true,
    modelLabel: null,
    setModelLabel: vi.fn(),
    setRuntimeProviderLabel: vi.fn(),
    productAssistantErrorCopy: (error) => error.message,
  })
  onResult(result)
  return null
}

function assistantExecutionClient(
  principalId: string,
  listCatalog: (request: ModelRuntimeCatalogRequest) => Promise<ModelRuntimeCatalogResponse>
): AuroraClient {
  return {
    transport: { kind: 'http' },
    auth: {
      snapshot: () => ({
        state: 'authenticated',
        principalId,
        deviceId: `${principalId}-device`,
        peerId: `${principalId}-peer`,
        credentialKind: 'session',
        source: 'test',
        tokenExpiresAt: null,
        status: 200,
        isAdmin: true,
        effectivePermissions: ['assistant.chat']
      }),
      subscribe: () => () => {}
    },
    models: { listCatalog }
  } as unknown as AuroraClient
}

function modelCatalog(providerId: string, modelName: string): ModelRuntimeCatalogResponse {
  return {
    providers: [{
      provider_id: providerId,
      display_name: modelName,
      provider_type: 'local',
      provider_kind: 'local',
      backend_kind: 'native',
      enabled: true,
      health: 'ready',
      model_id: `${providerId}-model`,
      default_model_id: `${providerId}-model`,
      models: [{
        model_id: `${providerId}-model`,
        display_name: modelName,
        provider_id: providerId,
        available: true,
        secrets_redacted: true,
      }],
      secrets_redacted: true,
    } as unknown as ModelRuntimeProviderInfo],
    selected_provider_id: providerId,
    provider_index: { [providerId]: [`${providerId}-model`] },
    unavailable: [],
    internal_only: [],
    generated_at: '2026-09-16T00:00:00.000Z',
    secrets_redacted: true,
  }
}

function routeAvailability(): RouteAvailability {
  return {
    item: {
      id: 'assistant.chat',
      capabilityMethod: 'assistant.chat',
      privacyClass: 'personal',
    },
    state: 'available-local',
    disabled: false,
    providerLabel: 'Local',
    explanation: 'Ready',
    selectorRequired: false,
    approvalRequired: false,
    candidateProviders: [
      {
        id: 'local',
        label: 'Local',
        state: 'available-local',
        reason: null,
        selectable: true,
        providerId: 'local',
        providerKind: 'local',
        peerId: null,
        nodeName: 'Local',
        serviceInstanceId: null,
      },
      {
        id: 'mesh:peer-a:orchestrator',
        label: 'Peer A / Orchestrator',
        state: 'available-remote',
        reason: null,
        selectable: true,
        providerId: 'mesh:peer-a:orchestrator',
        providerKind: 'mesh',
        peerId: 'peer-a',
        nodeName: 'Peer A',
        serviceInstanceId: 'mesh:peer-a:orchestrator',
      }
    ],
  } as unknown as RouteAvailability
}

function localRouteAvailability(): RouteAvailability {
  const route = routeAvailability()
  return {
    ...route,
    candidateProviders: [route.candidateProviders[0]!]
  } as RouteAvailability
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
