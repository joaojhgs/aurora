import { Cpu, Laptop, Network } from 'lucide-react'
import type { AssistantInferencePolicy, ModelRuntimeCatalogResponse, ModelRuntimeModelInfo, ModelRuntimeProviderInfo } from '@aurora/client'

import type { RouteAvailability } from './shell-data'
import type { AssistantExecutionOption, AssistantModelChoice, AssistantModelChoiceGroup, AssistantModelSourceGroup } from './assistant-view'
import { isInternalAssistantLabel, selectedRuntimeProvider } from './assistant-message'
import { isRemoteRouteCandidate, peerIdFromProviderIdentity, serviceInstanceFromProviderIdentity } from './assistant-execution-routing'

export function mergeAssistantModelCatalogs(
  localCatalog: ModelRuntimeCatalogResponse,
  remoteCatalogs: Array<{
    catalog: ModelRuntimeCatalogResponse
    execution: AssistantExecutionOption
  }>
): ModelRuntimeCatalogResponse {
  const providers = new Map(
    localCatalog.providers.map((provider) => [provider.provider_id, provider])
  )
  const unavailable = new Set(localCatalog.unavailable)
  const internalOnly = new Set(localCatalog.internal_only)

  for (const { catalog, execution } of remoteCatalogs) {
    for (const provider of catalog.providers) {
      if (!providerIsRemote(provider) || !providerMatchesExecution(provider, execution)) continue
      providers.set(provider.provider_id, provider)
    }
    for (const providerId of catalog.unavailable) {
      if (providers.has(providerId)) unavailable.add(providerId)
    }
    for (const providerId of catalog.internal_only) {
      if (providers.has(providerId)) internalOnly.add(providerId)
    }
  }

  const mergedProviders = [...providers.values()]
  return {
    ...localCatalog,
    providers: mergedProviders,
    provider_index: Object.fromEntries(
      mergedProviders.map((provider) => [
        provider.provider_id,
        provider.models?.map((model) => model.model_id) ?? []
      ])
    ),
    unavailable: [...unavailable],
    internal_only: [...internalOnly]
  }
}

export function assistantModelChoices(
  catalog: ModelRuntimeCatalogResponse | null,
  execution: AssistantExecutionOption
): AssistantModelChoice[] {
  const configuredProvider = catalog
    ? selectedRuntimeProvider(
        catalog.providers.find((provider) => provider.provider_id === catalog.selected_provider_id) ?? null,
        catalog.providers
      )
    : null
  const automatic: AssistantModelChoice = {
    id: 'automatic',
    model: {
      id: 'automatic',
      name: execution.mode === 'local'
        ? 'Configured default'
        : 'Automatic',
      description: execution.mode === 'local'
        ? configuredProvider
          ? 'Aurora uses the configured model for this device.'
          : 'Let Aurora choose from the configured, available model routes.'
        : 'The selected connected device chooses from the models it shares and permits.',
      icon: execution.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
    },
    provider: null,
    runtimeModel: null,
    automatic: true
  }
  if (!catalog) return [automatic]

  const usableProviders = catalog.providers
    .filter((provider) => providerUsableForAssistant(provider))
    .filter((provider) => execution.mode === 'local' || execution.transportHost || providerMatchesExecution(provider, execution))
  const choices = usableProviders
    .flatMap((provider, providerIndex) => {
      const models = provider.models?.filter((model) => model.available !== false) ?? []
      const availableModels = models.length > 0
        ? models
        : provider.model_id
          ? [{
              model_id: provider.model_id,
              display_name: provider.model_id,
              provider_id: provider.provider_id,
              secrets_redacted: true
            } satisfies ModelRuntimeModelInfo]
          : []
      return availableModels.map((runtimeModel, modelIndex): AssistantModelChoice => {
        const providerClass = execution.modelCatalogHost === 'connected-device'
          ? 'connected'
          : assistantModelProviderClass(provider)
        const providerLabel = safeAssistantCatalogLabel(
          provider.display_name,
          assistantModelProviderLabel(providerClass, providerIndex + 1)
        )
        const modelLabel = safeAssistantCatalogLabel(
          runtimeModel.display_name || runtimeModel.model_id,
          assistantModelLabel(providerClass, providerIndex + 1, modelIndex + 1)
        )
        const id = assistantModelChoiceId(provider.provider_id, runtimeModel.model_id)
        return {
          id,
          model: {
            id,
            name: modelLabel,
            description: assistantModelDescription(providerClass, providerLabel),
            icon: execution.modelCatalogHost === 'connected-device' || providerIsRemote(provider)
              ? <Network aria-hidden />
              : <Cpu aria-hidden />,
            keywords: assistantModelKeywords(providerClass, providerIndex + 1, modelIndex + 1, providerLabel, modelLabel)
          },
          provider,
          runtimeModel,
          automatic: false
        }
      })
    })
  return [automatic, ...choices]
}

export function assistantModelChoiceGroups(
  choices: AssistantModelChoice[],
  execution: AssistantExecutionOption
): AssistantModelChoiceGroup[] {
  const automatic = choices.filter((choice) => choice.automatic)
  const localProviders = new Map<string, AssistantModelChoiceGroup>()
  const peerProviders = new Map<string, AssistantModelChoiceGroup>()

  for (const choice of choices) {
    if (choice.automatic || !choice.provider) continue
    const provider = choice.provider
    const remote = execution.modelCatalogHost === 'connected-device' || providerIsRemote(provider)
    const id = remote
      ? `peer:${provider.provider_peer_id ?? 'remote'}:${provider.provider_id}`
      : `local:${provider.provider_id}`
    const target = remote ? peerProviders : localProviders
    const existing = target.get(id)
    if (existing) {
      existing.choices.push(choice)
      continue
    }
    const providerClass = remote ? 'connected' : assistantModelProviderClass(provider)
    const providerOrdinal = target.size + 1
    const providerLabel = safeAssistantCatalogLabel(
      provider.display_name,
      assistantModelProviderLabel(providerClass, providerOrdinal)
    )
    target.set(id, {
      id,
      heading: `${providerLabel} · ${modelCountLabel(1)}`,
      choices: [choice],
      scope: remote ? 'connected device' : 'this device'
    })
  }

  const groups: AssistantModelChoiceGroup[] = automatic.length > 0
    ? [{
        id: 'configured-default',
        heading: execution.mode === 'local' ? 'Configured default' : 'Automatic',
        choices: automatic,
        scope: 'default'
      }]
    : []
  groups.push(...localProviders.values(), ...peerProviders.values())
  for (const group of groups) {
    if (group.scope === 'default') continue
    group.heading = group.heading.replace(/1 model$/, modelCountLabel(group.choices.length))
  }
  return groups
}

export function assistantModelSourceGroups(
  providerGroups: AssistantModelChoiceGroup[],
  execution: AssistantExecutionOption,
  executionOptions: AssistantExecutionOption[] = [execution]
): AssistantModelSourceGroup[] {
  const sources = new Map<string, AssistantModelSourceGroup>()
  const connectedHostExecution = executionOptions.find((option) => option.transportHost)
  for (const group of providerGroups) {
    if (group.scope === 'default' || group.choices.length === 0) continue
    const provider = group.choices[0]?.provider
    if (!provider) continue
    const remote = execution.modelCatalogHost === 'connected-device' || providerIsRemote(provider)
    const peerId = remote
      ? execution.modelCatalogHost === 'connected-device'
        ? connectedHostExecution?.executionPeerId ?? 'connected-host'
        : provider.provider_peer_id ?? peerIdFromProviderIdentity(provider.provider_id) ?? 'remote'
      : null
    const sourceId = remote ? `source:peer:${peerId}` : 'source:local'
    const existing = sources.get(sourceId)
    if (existing) {
      existing.providerGroups.push(group)
      existing.modelCount += group.choices.length
      continue
    }
    const sourceOrdinal = [...sources.values()].filter((source) => source.scope === 'peer').length + 1
    sources.set(sourceId, {
      id: sourceId,
      heading: remote
        ? execution.modelCatalogHost === 'connected-device'
          ? execution.mode === 'dispatch'
            ? execution.label
            : connectedHostExecution?.label ?? 'Connected Aurora device'
          : execution.mode === 'dispatch' ? 'Selected connected device' : `Connected device ${sourceOrdinal}`
        : 'This device',
      description: remote
        ? execution.mode === 'dispatch'
          ? 'Models allowed for assistant work on the selected connected device.'
          : 'Models shared by a connected Aurora device.'
        : 'Models configured on this Aurora device, grouped by source.',
      providerGroups: [group],
      modelCount: group.choices.length,
      scope: remote ? 'peer' : 'local'
    })
  }
  return [...sources.values()]
}

export function assistantModelChoiceMatches(choice: AssistantModelChoice, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [
    choice.model.id,
    choice.model.name,
    choice.model.description ?? '',
    ...(choice.model.keywords ?? [])
  ].some((value) => value.toLowerCase().includes(normalized))
}

export function defaultAssistantModelChoiceId(
  choices: AssistantModelChoice[],
  catalog: ModelRuntimeCatalogResponse | null,
  execution: AssistantExecutionOption
): string {
  if (!catalog) return 'automatic'
  const selectedProvider = selectedRuntimeProvider(
    catalog.providers.find((provider) => provider.provider_id === catalog.selected_provider_id) ?? null,
    catalog.providers
  )
  if (!selectedProvider) return 'automatic'
  const selectedModelId = selectedProvider.default_model_id
    ?? selectedProvider.models?.find((model) => model.default)?.model_id
    ?? selectedProvider.model_id
  if (!selectedModelId) return 'automatic'
  return choices.find((choice) =>
    !choice.automatic &&
    choice.provider?.provider_id === selectedProvider.provider_id &&
    choice.runtimeModel?.model_id === selectedModelId
  )?.id ?? 'automatic'
}

export function assistantInferencePolicy(
  choice: AssistantModelChoice,
  route: RouteAvailability
): AssistantInferencePolicy | null {
  if (choice.automatic || !choice.provider || !choice.runtimeModel) return null
  const provider = choice.provider
  const remote = providerIsRemote(provider)
  return {
    providerId: provider.provider_id,
    peerId: remote ? provider.provider_peer_id ?? peerIdFromProviderIdentity(provider.provider_id) : null,
    serviceInstanceId: remote
      ? provider.provider_service_instance_id ?? serviceInstanceFromProviderIdentity(provider.provider_id)
      : null,
    runtimeProviderId: remote ? null : provider.provider_id,
    modelId: choice.runtimeModel.model_id,
    privacyClass: route.item.privacyClass,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired,
    dataLeavesDevice: remote || provider.provider_type === 'cloud'
  }
}

function assistantModelChoiceId(providerId: string, modelId: string): string {
  return `model-choice-${stableAssistantChoiceToken(`${providerId}\u001f${modelId}`)}`
}

function stableAssistantChoiceToken(value: string): string {
  let forward = 0x811c9dc5
  let reverse = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    forward = Math.imul(forward ^ value.charCodeAt(index), 0x01000193)
    reverse = Math.imul(reverse ^ value.charCodeAt(value.length - index - 1), 0x01000193)
  }
  return `${(forward >>> 0).toString(36)}-${(reverse >>> 0).toString(36)}`
}

function providerUsableForAssistant(provider: ModelRuntimeProviderInfo): boolean {
  if (!provider.enabled) return false
  return !/unavailable|misconfigured|offline|error|disabled/i.test(provider.health)
}

export function providerIsRemote(provider: ModelRuntimeProviderInfo): boolean {
  return /mesh|remote|peer/i.test(`${provider.provider_kind ?? ''}`)
    || /^(?:mesh|remote):/i.test(provider.provider_id)
}

export function providerMatchesExecution(
  provider: ModelRuntimeProviderInfo,
  execution: AssistantExecutionOption
): boolean {
  const peerId = execution.routePolicy.peerId
  const serviceInstanceId = execution.routePolicy.serviceInstanceId
  if (!providerIsRemote(provider)) return false
  if (peerId && provider.provider_peer_id === peerId) return true
  if (serviceInstanceId && provider.provider_service_instance_id === serviceInstanceId) return true
  const evidence = `${provider.provider_id} ${provider.provider_peer_id ?? ''} ${provider.provider_service_instance_id ?? ''}`
  return Boolean(peerId && evidence.includes(peerId))
}

type AssistantModelProviderClass = 'connected' | 'cloud' | 'local'

function assistantModelProviderClass(provider: ModelRuntimeProviderInfo): AssistantModelProviderClass {
  if (providerIsRemote(provider)) return 'connected'
  const trustedClass = `${provider.provider_type ?? ''} ${provider.provider_kind ?? ''} ${provider.backend_kind ?? ''}`.toLowerCase()
  if (/\bcloud\b/.test(trustedClass) || /\b(?:openai|anthropic|google)\b/.test(trustedClass)) return 'cloud'
  return 'local'
}

function assistantModelProviderLabel(providerClass: AssistantModelProviderClass, ordinal: number): string {
  if (providerClass === 'connected') return `Connected device ${ordinal}`
  if (providerClass === 'cloud') return `Cloud service ${ordinal}`
  return `This device ${ordinal}`
}

function assistantModelLabel(
  providerClass: AssistantModelProviderClass,
  providerOrdinal: number,
  modelOrdinal: number
): string {
  if (providerClass === 'connected') return `Connected device model ${providerOrdinal}.${modelOrdinal}`
  if (providerClass === 'cloud') return `Cloud model ${providerOrdinal}.${modelOrdinal}`
  return `Local model ${providerOrdinal}.${modelOrdinal}`
}

function assistantModelDescription(
  providerClass: AssistantModelProviderClass,
  providerLabel: string
): string {
  if (providerClass === 'connected') return `${providerLabel} shares this model for approved assistant work.`
  if (providerClass === 'cloud') return `${providerLabel} can help when your privacy choices allow it.`
  return `${providerLabel} runs on this device.`
}

function assistantModelKeywords(
  providerClass: AssistantModelProviderClass,
  providerOrdinal: number,
  modelOrdinal: number,
  providerLabel: string,
  modelLabel: string
): string[] {
  return [
    providerClass === 'connected' ? 'connected device' : providerClass === 'cloud' ? 'cloud service' : 'local device',
    `choice group ${providerOrdinal}`,
    `model ${modelOrdinal}`,
    providerLabel,
    modelLabel
  ]
}

function safeAssistantCatalogLabel(value: string | null | undefined, fallback: string): string {
  const label = value?.trim()
  if (!label || label.length > 96 || isInternalAssistantLabel(label)) return fallback
  return label
}

export function modelCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}



export { assistantExecutionOptions, executionPeerLabel, isRemoteRouteCandidate, peerIdFromProviderIdentity, routePolicyFromRoute } from './assistant-execution-routing'
export type { AssistantExecutionContext } from './assistant-execution-routing'
