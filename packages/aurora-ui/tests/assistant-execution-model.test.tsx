import { describe, expect, it } from 'vitest'
import type { ModelRuntimeCatalogResponse, ModelRuntimeProviderInfo } from '@aurora/client'

import {
  assistantExecutionOptions,
  assistantInferencePolicy,
  assistantModelChoices,
  defaultAssistantModelChoiceId,
  mergeAssistantModelCatalogs
} from '../src/use-assistant-execution'
import type { AssistantExecutionOption } from '../src/assistant-view'
import type { RouteAvailability } from '../src/shell-data'

describe('assistant execution model extraction', () => {
  it('dedupes connected execution choices by peer identity and keeps the connected host fallback', () => {
    const route = routeAvailability([
      routeCandidate({
        id: 'local-provider',
        label: 'This device',
        providerKind: 'local',
        providerId: 'local-provider',
        state: 'available-local'
      }),
      routeCandidate({
        id: 'remote-a',
        label: 'Kitchen / Orchestrator',
        providerKind: 'mesh',
        providerId: 'mesh:peer-a:orchestrator',
        peerId: 'peer-a',
        serviceInstanceId: 'mesh:peer-a:orchestrator',
        state: 'available-remote'
      }),
      routeCandidate({
        id: 'remote-a-duplicate',
        label: 'Kitchen duplicate',
        providerKind: 'mesh',
        providerId: 'mesh:peer-a:other',
        peerId: 'peer-a',
        serviceInstanceId: 'mesh:peer-a:other',
        state: 'available-remote'
      })
    ])

    const options = assistantExecutionOptions(route, {
      executionHost: 'connected-device',
      localExecutionAvailable: true
    })

    expect(options.map((option) => option.id)).toEqual(['local', 'dispatch:connected:local-provider', 'dispatch:peer-a'])
    expect(options[0]).toEqual(expect.objectContaining({
      mode: 'local',
      transportHost: false,
      executionPeerId: null
    }))
    expect(options[1]).toEqual(expect.objectContaining({
      mode: 'dispatch',
      transportHost: true,
      executionPeerId: null,
      label: 'This device'
    }))
    expect(options[2]).toEqual(expect.objectContaining({
      mode: 'dispatch',
      transportHost: false,
      executionPeerId: 'peer-a',
      label: 'Kitchen'
    }))
  })

  it('merges only remote catalog providers that match the selected execution peer', () => {
    const route = routeAvailability([])
    const execution = firstExecutionOption(route)
    const selectedRemote: AssistantExecutionOption = {
      ...execution,
      id: 'dispatch:peer-a',
      mode: 'dispatch' as const,
      executionPeerId: 'peer-a',
      routePolicy: {
        ...execution.routePolicy,
        peerId: 'peer-a',
        serviceInstanceId: 'mesh:peer-a:orchestrator'
      },
      modelCatalogHost: 'connected-device' as const
    }

    const merged = mergeAssistantModelCatalogs(
      catalog([provider('local-provider', 'local-model')]),
      [{
        execution: selectedRemote,
        catalog: catalog([
          provider('mesh:peer-a:orchestrator:llm', 'remote-a', { provider_peer_id: 'peer-a', provider_service_instance_id: 'mesh:peer-a:orchestrator', provider_kind: 'mesh' }),
          provider('mesh:peer-b:orchestrator:llm', 'remote-b', { provider_peer_id: 'peer-b', provider_service_instance_id: 'mesh:peer-b:orchestrator', provider_kind: 'mesh' })
        ], {
          unavailable: ['mesh:peer-a:orchestrator:llm', 'mesh:peer-b:orchestrator:llm'],
          internal_only: ['mesh:peer-a:orchestrator:llm', 'mesh:peer-b:orchestrator:llm']
        })
      }]
    )

    expect(merged.providers.map((entry) => entry.provider_id)).toEqual(['local-provider', 'mesh:peer-a:orchestrator:llm'])
    expect(merged.unavailable).toEqual(['mesh:peer-a:orchestrator:llm'])
    expect(merged.internal_only).toEqual(['mesh:peer-a:orchestrator:llm'])
  })

  it('selects the configured model and builds remote inference policy without leaking transport state', () => {
    const route = routeAvailability([])
    const baseExecution = firstExecutionOption(route)
    const execution: AssistantExecutionOption = {
      ...baseExecution,
      id: 'dispatch:peer-a',
      mode: 'dispatch' as const,
      routePolicy: {
        ...baseExecution.routePolicy,
        peerId: 'peer-a',
        serviceInstanceId: 'mesh:peer-a:orchestrator'
      },
      modelCatalogHost: 'connected-device' as const
    }
    const runtimeCatalog = catalog([
      provider('mesh:peer-a:orchestrator:llm', 'remote-default', {
        provider_peer_id: 'peer-a',
        provider_service_instance_id: 'mesh:peer-a:orchestrator',
        provider_kind: 'mesh',
        default_model_id: 'remote-default'
      })
    ], { selected_provider_id: 'mesh:peer-a:orchestrator:llm' })
    const choices = assistantModelChoices(runtimeCatalog, execution)
    const defaultId = defaultAssistantModelChoiceId(choices, runtimeCatalog, execution)
    const selected = choices.find((choice) => choice.id === defaultId)
    if (!selected) throw new Error('Expected configured remote model choice to be available.')

    expect(selected.runtimeModel?.model_id).toBe('remote-default')
    expect(assistantInferencePolicy(selected, route)).toEqual(expect.objectContaining({
      providerId: 'mesh:peer-a:orchestrator:llm',
      peerId: 'peer-a',
      serviceInstanceId: 'mesh:peer-a:orchestrator',
      runtimeProviderId: null,
      modelId: 'remote-default',
      dataLeavesDevice: true
    }))
  })
})

function catalog(
  providers: ModelRuntimeCatalogResponse['providers'],
  overrides: Partial<ModelRuntimeCatalogResponse> = {}
): ModelRuntimeCatalogResponse {
  return {
    providers,
    provider_index: Object.fromEntries(providers.map((entry) => [entry.provider_id, entry.models?.map((model) => model.model_id) ?? []])),
    selected_provider_id: providers[0]?.provider_id ?? null,
    unavailable: [],
    internal_only: [],
    secrets_redacted: true,
    generated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  } satisfies ModelRuntimeCatalogResponse
}

function provider(
  providerId: string,
  modelId: string,
  overrides: Partial<ModelRuntimeProviderInfo> = {}
): ModelRuntimeProviderInfo {
  return {
    provider_id: providerId,
    display_name: providerId,
    provider_type: 'local',
    provider_kind: 'local',
    backend_kind: 'local',
    enabled: true,
    selected: false,
    health: 'ready',
    health_reason: null,
    model_id: modelId,
    source: null,
    license: null,
    context_window: null,
    generation_limit: null,
    hardware: {},
    model_files: [],
    capabilities: [],
    benchmark: { status: 'unavailable', tokens_per_second: null, latency_ms: null, measured_at: null, reason: null },
    import_progress: { operation_id: null, operation_type: 'import', status: 'idle', progress_percent: 0, message: '', updated_at: null },
    download_progress: { operation_id: null, operation_type: 'download', status: 'idle', progress_percent: 0, message: '', updated_at: null },
    default_model_id: modelId,
    provider_peer_id: null,
    provider_service_instance_id: null,
    models: [{
      model_id: modelId,
      display_name: modelId,
      provider_id: providerId,
      available: true,
      default: true,
      secrets_redacted: true
    }],
    secrets_redacted: true,
    ...overrides
  } satisfies ModelRuntimeCatalogResponse['providers'][number]
}


function firstExecutionOption(route: RouteAvailability): AssistantExecutionOption {
  const execution = assistantExecutionOptions(route)[0]
  if (!execution) throw new Error('Expected assistant execution option fixture to produce a local option.')
  return execution
}

function routeCandidate(
  candidate: Omit<RouteAvailability['candidateProviders'][number], 'selectable' | 'reason' | 'requiredAction'>
    & Partial<Pick<RouteAvailability['candidateProviders'][number], 'selectable' | 'reason' | 'requiredAction'>>
): RouteAvailability['candidateProviders'][number] {
  return {
    selectable: true,
    reason: 'Ready',
    requiredAction: null,
    ...candidate
  }
}

function routeAvailability(
  candidateProviders: RouteAvailability['candidateProviders']
): RouteAvailability {
  return {
    item: {
      id: 'assistant-run',
      label: 'Assistant',
      href: '/',
      capabilityModule: 'Assistant',
      capabilityMethod: 'Run',
      capabilityFeatureId: 'assistant-run',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'available-local',
      adminGated: false,
      expectedTask: 'assistant'
    },
    state: 'available-local',
    explanation: 'Assistant is ready.',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders,
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false
  }
}
