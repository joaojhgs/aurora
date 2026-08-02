import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient, MockAuroraTransport, type ModelRuntimeCatalogResponse, type ModelRuntimeProviderInfo } from '@aurora/client'
import {
  AssistantView,
  assistantExecutionOptions,
  assistantInferencePolicy,
  assistantMessageRuntimeLabel,
  assistantModelChoiceGroups,
  assistantModelChoices,
  assistantModelSourceGroups,
  assistantSessionFromPersisted,
  mergeAssistantModelCatalogs
} from '../src/assistant-view'
import type { RouteAvailability } from '../src/shell-data'
import type { LightweightAssistantDependencies } from '../src/local-assistant/lightweight-assistant'

const hostileCatalogPattern = /\b(?:SDK|WebView|daemon|Orchestrator|native-manifest|WebRTC|transport|fallback|runtime|Gateway\.ExplainRoute|Tooling\.DeleteSecret|api_key|secret-token|sk-secret)\b|provider:\/\/|peer-WebRTC-runtime/i

describe('assistant execution and model pickers', () => {
  it('keeps one Assistant UI and renders the bottom execution control for a connected host', () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const candidateRoute = route()
    const connectedRoute = {
      ...candidateRoute,
      candidateProviders: [{
        ...candidateRoute.candidateProviders[0]!,
        peerId: 'peer-home',
        nodeName: 'Home Aurora'
      }]
    }
    const execution = assistantExecutionOptions(connectedRoute, {
      executionHost: 'connected-device',
      localExecutionAvailable: true
    })

    const markup = renderToStaticMarkup(
      <AssistantView
        client={client}
        route={connectedRoute}
        executionHost="connected-device"
        localAssistant={readyLocalAssistant()}
      />
    )

    expect(execution.map((option) => [option.mode, option.label, option.runner])).toEqual([
      ['local', 'Local', 'lightweight-local'],
      ['dispatch', 'Home Aurora', 'aurora-route']
    ])
    expect(markup).not.toContain('Choose how Aurora answers')
    expect(markup.match(/aria-label="Prompt composer"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Executing locally"')
    expect(markup).toContain('aui-execution-selector-trigger')
    expect(markup).not.toContain('aui-execution-segment')
  })

  it('offers local execution and preserves the selected peer dispatch identity', () => {
    const options = assistantExecutionOptions(route())

    expect(options.map((option) => [option.mode, option.label])).toEqual([
      ['local', 'Local'],
      ['dispatch', 'studio']
    ])
    expect(options[1]?.routePolicy).toEqual(expect.objectContaining({
      providerId: 'remote:peer-studio:Orchestrator',
      peerId: 'peer-studio',
      serviceInstanceId: 'remote:peer-studio:Orchestrator'
    }))
  })

  it('shows local and peer-shared models for local execution but scopes dispatch to its peer', () => {
    const execution = assistantExecutionOptions(route())
    const localChoices = assistantModelChoices(catalog(), execution[0]!)
    const dispatchChoices = assistantModelChoices(catalog(), execution[1]!)

    expect(localChoices.map((choice) => choice.model.name)).toEqual([
      'Configured default',
      'GPT 5',
      'DialoGPT Medium',
      'Qwen 32B'
    ])
    expect(dispatchChoices.map((choice) => choice.model.name)).toEqual([
      'Connected device default',
      'Qwen 32B'
    ])

    const localGroups = assistantModelChoiceGroups(localChoices, execution[0]!)
    const dispatchGroups = assistantModelChoiceGroups(dispatchChoices, execution[1]!)
    expect(localGroups.map((group) => ({
      heading: group.heading,
      models: group.choices.map((choice) => choice.model.name)
    }))).toEqual([
      { heading: 'Configured default', models: ['Configured default'] },
      { heading: 'OpenAI · 1 model', models: ['GPT 5'] },
      { heading: 'HuggingFace Pipeline · 1 model', models: ['DialoGPT Medium'] },
      { heading: 'Studio OpenAI · 1 model', models: ['Qwen 32B'] }
    ])
    expect(dispatchGroups.map((group) => group.heading)).toEqual([
      'Connected device default',
      'Studio OpenAI · 1 model'
    ])
    expect(assistantModelSourceGroups(localGroups, execution[0]!, execution).map((source) => ({
      heading: source.heading,
      providers: source.providerGroups.map((group) => group.heading),
      modelCount: source.modelCount
    }))).toEqual([
      {
        heading: 'This device',
        providers: ['OpenAI · 1 model', 'HuggingFace Pipeline · 1 model'],
        modelCount: 2
      },
      {
        heading: 'Connected device 1',
        providers: ['Studio OpenAI · 1 model'],
        modelCount: 1
      }
    ])
  })

  it('aggregates peer-scoped catalogs into local execution without adding unrelated providers', () => {
    const execution = assistantExecutionOptions(route())
    const completeCatalog = catalog()
    const localCatalog = {
      ...completeCatalog,
      providers: completeCatalog.providers.filter((provider) => !provider.provider_peer_id)
    }
    const peerCatalog = {
      ...completeCatalog,
      providers: completeCatalog.providers.filter((provider) =>
        !provider.provider_peer_id || provider.provider_peer_id === 'peer-studio'
      )
    }

    const merged = mergeAssistantModelCatalogs(localCatalog, [{
      catalog: peerCatalog,
      execution: execution[1]!
    }])

    expect(assistantModelChoices(merged, execution[0]!).map((choice) => choice.model.name)).toEqual([
      'Configured default',
      'GPT 5',
      'DialoGPT Medium',
      'Qwen 32B'
    ])
    expect(merged.providers.filter((provider) => provider.provider_peer_id).map((provider) =>
      provider.provider_peer_id
    )).toEqual(['peer-studio'])
  })

  it('classifies a connected host catalog as peer-owned while preserving real model names', () => {
    const connectedRoute = {
      ...route(),
      candidateProviders: [{
        ...route().candidateProviders[0]!,
        peerId: 'peer-home',
        nodeName: 'Home Aurora'
      }]
    }
    const execution = assistantExecutionOptions(connectedRoute, {
      executionHost: 'connected-device',
      localExecutionAvailable: true
    })
    const choices = assistantModelChoices(catalog(), execution[0]!)
    const groups = assistantModelChoiceGroups(choices, execution[0]!)
    const sources = assistantModelSourceGroups(groups, execution[0]!, execution)

    expect(choices.map((choice) => choice.model.name)).toEqual([
      'Configured default',
      'GPT 5',
      'DialoGPT Medium',
      'Qwen 32B'
    ])
    expect(groups.filter((group) => group.scope !== 'default').every((group) => group.scope === 'connected device')).toBe(true)
    expect(sources).toEqual([
      expect.objectContaining({
        heading: 'Home Aurora',
        scope: 'peer',
        modelCount: 3
      })
    ])
  })

  it('keeps dispatch and explicit inference selectors independent', () => {
    const execution = assistantExecutionOptions(route())[0]!
    const remoteChoice = assistantModelChoices(catalog(), execution)
      .find((choice) => choice.runtimeModel?.model_id === 'qwen-32b')!

    expect(assistantInferencePolicy(remoteChoice, route())).toEqual(expect.objectContaining({
      providerId: 'remote:peer-studio:Orchestrator:openai',
      peerId: 'peer-studio',
      serviceInstanceId: 'remote:peer-studio:Orchestrator',
      runtimeProviderId: null,
      modelId: 'qwen-32b',
      dataLeavesDevice: true
    }))
  })

  it('keeps hostile catalog fields out of model selector presentation while preserving request keys', () => {
    const hostileProviderId = 'remote:peer-WebRTC-runtime:Gateway.ExplainRoute:native-manifest'
    const hostileModelId = 'SDK-Orchestrator-secret-model'
    const hostileCatalog: ModelRuntimeCatalogResponse = {
      generated_at: '2026-07-28T00:00:00Z',
      selected_provider_id: hostileProviderId,
      providers: [
        provider({
          provider_id: hostileProviderId,
          display_name: 'native-manifest WebRTC transport fallback secret Gateway.ExplainRoute',
          provider_kind: 'mesh_peer',
          provider_type: 'remote',
          provider_peer_id: 'peer-WebRTC-runtime',
          provider_service_instance_id: 'remote:peer-WebRTC-runtime:Orchestrator',
          model_id: hostileModelId,
          models: [model(hostileProviderId, hostileModelId, 'SDK Orchestrator secret model')]
        })
      ],
      provider_index: {},
      unavailable: [],
      internal_only: [],
      secrets_redacted: true
    }
    const execution = assistantExecutionOptions(route())[0]!
    const choices = assistantModelChoices(hostileCatalog, execution)
    const explicit = choices.find((choice) => !choice.automatic)!
    const groups = assistantModelChoiceGroups(choices, execution)
    const sources = assistantModelSourceGroups(groups, execution, [execution])
    const renderedSelectorFields = JSON.stringify({
      ids: choices.map((choice) => choice.model.id),
      names: choices.map((choice) => choice.model.name),
      descriptions: choices.map((choice) => choice.model.description),
      keywords: choices.map((choice) => choice.model.keywords),
      groups: groups.map((group) => group.heading),
      sources: sources.map((source) => [source.heading, source.description])
    })

    expect(renderedSelectorFields).not.toMatch(hostileCatalogPattern)
    expect(explicit.model.id).toMatch(/^model-choice-[a-z0-9]+-[a-z0-9]+$/)
    expect(explicit.provider?.provider_id).toBe(hostileProviderId)
    expect(explicit.runtimeModel?.model_id).toBe(hostileModelId)
    expect(assistantInferencePolicy(explicit, route())).toEqual(expect.objectContaining({
      providerId: hostileProviderId,
      modelId: hostileModelId,
      peerId: 'peer-WebRTC-runtime'
    }))
  })

  it('labels each assistant turn by execution device and model, including persisted dispatches', () => {
    expect(assistantMessageRuntimeLabel({
      id: 'local-answer',
      role: 'assistant',
      text: 'Local answer',
      createdAt: '2026-07-23T00:00:00Z',
      status: 'sent',
      routeLabel: 'Local',
      providerLabel: 'OpenAI',
      modelLabel: 'gpt-4o'
    })).toBe('Local · gpt-4o')

    const persisted = assistantSessionFromPersisted({
      session: {
        id: 'dispatch-session',
        principal_id: 'system',
        type: 'chat',
        title: 'Dispatch',
        created_at: '2026-07-23T00:00:00Z',
        updated_at: '2026-07-23T00:00:01Z',
        last_active_at: '2026-07-23T00:00:01Z',
        message_count: 1
      },
      messages: [{
        id: 'remote-answer',
        role: 'assistant',
        content: 'Remote answer',
        timestamp: '2026-07-23T00:00:01Z',
        metadata: {
          execution: 'remote_dispatch',
          execution_peer_id: 'peer-studio',
          execution_peer_name: 'studio',
          provider_label: 'OpenAI',
          model: 'gpt-4o'
        }
      }]
    })

    expect(assistantMessageRuntimeLabel(
      persisted.messages[0]!,
      new Map([['peer-studio', 'studio']])
    )).toBe('studio · gpt-4o')
  })

  it('keeps a model selection stable when a refreshed catalog changes provider order', () => {
    const execution = assistantExecutionOptions(route())[0]!
    const original = assistantModelChoices(catalog(), execution)
    const reorderedCatalog = catalog()
    reorderedCatalog.providers = [...reorderedCatalog.providers].reverse()
    const reordered = assistantModelChoices(reorderedCatalog, execution)
    const selected = original.find((choice) => choice.runtimeModel?.model_id === 'qwen-32b')!

    expect(reordered.find((choice) => choice.runtimeModel?.model_id === 'qwen-32b')?.id).toBe(selected.id)
  })
})

function route(): RouteAvailability {
  return {
    item: { privacyClass: 'personal' },
    state: 'available-local',
    explanation: 'available',
    providerLabel: 'local / Orchestrator.ExternalUserInput',
    blockers: [],
    repairActions: [],
    candidateProviders: [
      {
        id: 'local:Orchestrator',
        providerId: 'local:Orchestrator',
        providerKind: 'local',
        peerId: null,
        serviceInstanceId: 'local:Orchestrator',
        label: 'local / Orchestrator.ExternalUserInput',
        state: 'available-local',
        selectable: true,
        reason: 'available',
        requiredAction: null
      },
      {
        id: 'remote:peer-studio:Orchestrator',
        providerId: 'remote:peer-studio:Orchestrator',
        providerKind: 'remote',
        peerId: 'peer-studio',
        serviceInstanceId: 'remote:peer-studio:Orchestrator',
        label: 'remote:studio / Orchestrator.ExternalUserInput',
        state: 'available-remote',
        selectable: true,
        reason: 'available',
        requiredAction: null
      }
    ],
    evidenceSources: ['test'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false
  } as unknown as RouteAvailability
}

function catalog(): ModelRuntimeCatalogResponse {
  return {
    generated_at: '2026-07-23T00:00:00Z',
    selected_provider_id: 'openai',
    providers: [
      provider({
        provider_id: 'openai',
        display_name: 'OpenAI',
        provider_kind: 'cloud',
        provider_type: 'cloud',
        model_id: 'gpt-5',
        models: [model('openai', 'gpt-5', 'GPT 5')]
      }),
      provider({
        provider_id: 'huggingface_pipeline',
        display_name: 'HuggingFace Pipeline',
        provider_kind: 'local',
        provider_type: 'local',
        model_id: 'microsoft/DialoGPT-medium',
        models: [model('huggingface_pipeline', 'microsoft/DialoGPT-medium', 'DialoGPT Medium')]
      }),
      provider({
        provider_id: 'remote:peer-studio:Orchestrator:openai',
        display_name: 'Studio OpenAI',
        provider_kind: 'mesh_peer',
        provider_type: 'remote',
        provider_peer_id: 'peer-studio',
        provider_service_instance_id: 'remote:peer-studio:Orchestrator',
        model_id: 'qwen-32b',
        models: [model('remote:peer-studio:Orchestrator:openai', 'qwen-32b', 'Qwen 32B')]
      }),
      provider({
        provider_id: 'llama-cpp',
        display_name: 'Broken llama.cpp',
        health: 'misconfigured',
        model_id: 'missing'
      })
    ],
    provider_index: {},
    unavailable: [],
    internal_only: [],
    secrets_redacted: true
  }
}

function provider(overrides: Partial<ModelRuntimeProviderInfo>): ModelRuntimeProviderInfo {
  return {
    provider_id: 'provider',
    display_name: 'Provider',
    backend_kind: 'test',
    provider_type: 'local',
    enabled: true,
    selected: false,
    health: 'available',
    health_reason: null,
    model_id: null,
    source: null,
    license: null,
    context_window: null,
    generation_limit: null,
    hardware: {},
    model_files: [],
    capabilities: [],
    benchmark: { status: 'unknown', tokens_per_second: null, latency_ms: null, measured_at: null, reason: null },
    import_progress: { operation_id: null, operation_type: 'import', status: 'idle', progress_percent: 0, message: '', updated_at: null },
    download_progress: { operation_id: null, operation_type: 'download', status: 'idle', progress_percent: 0, message: '', updated_at: null },
    secrets_redacted: true,
    ...overrides
  }
}

function model(providerId: string, modelId: string, displayName: string) {
  return {
    model_id: modelId,
    display_name: displayName,
    provider_id: providerId,
    available: true,
    secrets_redacted: true
  }
}

function readyLocalAssistant(): LightweightAssistantDependencies {
  return {
    provider: { complete: async () => ({ type: 'message', content: 'local' }) },
    tools: {} as LightweightAssistantDependencies['tools'] & object,
    localData: {} as LightweightAssistantDependencies['localData'] & object,
    envelopeCrypto: {} as LightweightAssistantDependencies['envelopeCrypto'] & object,
    scope: { profileId: 'profile-1', localNodeId: 'node-1' },
    availableTools: []
  }
}
