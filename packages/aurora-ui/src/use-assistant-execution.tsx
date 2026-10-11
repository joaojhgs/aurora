'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Cpu, Laptop, Network } from 'lucide-react'
import type { AuroraClient, ModelRuntimeCatalogRequest, ModelRuntimeCatalogResponse } from '@aurora/client'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible'
import { ModelSelector } from '#components/assistant-ui/model-selector'
import { cn } from '#lib/utils'
import type { RouteAvailability } from './shell-data'
import type { AssistantExecutionOption, AssistantModelChoice, AssistantModelChoiceGroup, AssistantModelSourceGroup, AssistantRuntimeHealth } from './assistant-view'
import { buildAssistantRuntimeStrip } from './assistant-status'
import { AURORA_QUERY_STALE_TIMES } from './query'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys } from './query-hooks'
import { safeAssistantRuntimeValue, selectedRuntimeProvider } from './assistant-message'
import {
  assistantExecutionOptions,
  assistantInferencePolicy,
  assistantModelChoiceGroups,
  assistantModelChoiceMatches,
  assistantModelChoices,
  assistantModelSourceGroups,
  defaultAssistantModelChoiceId,
  executionPeerLabel,
  isRemoteRouteCandidate,
  mergeAssistantModelCatalogs,
  modelCountLabel,
  peerIdFromProviderIdentity
} from './assistant-execution-model'

export {
  assistantExecutionOptions,
  assistantInferencePolicy,
  assistantModelChoiceGroups,
  assistantModelChoices,
  assistantModelSourceGroups,
  defaultAssistantModelChoiceId,
  isRemoteRouteCandidate,
  mergeAssistantModelCatalogs,
  routePolicyFromRoute
} from './assistant-execution-model'
export type { AssistantExecutionContext } from './assistant-execution-model'

export function AssistantModelSourceSection({
  source,
  query
}: {
  source: AssistantModelSourceGroup
  query: string
}) {
  const [open, setOpen] = useState(true)
  const searching = query.trim().length > 0
  const visibleProviders = source.providerGroups.filter((group) =>
    !searching || group.choices.some((choice) => assistantModelChoiceMatches(choice, query))
  )
  if (visibleProviders.length === 0) return null
  const visibleModelCount = visibleProviders.reduce((total, group) =>
    total + group.choices.filter((choice) => !searching || assistantModelChoiceMatches(choice, query)).length, 0
  )
  return (
    <div className="min-w-0" data-source-scope={source.scope}>
      <ModelSelector.Separator className="mx-0" />
      <Collapsible open={searching || open} onOpenChange={(next) => {
        if (!searching) setOpen(next)
      }}>
        <CollapsibleTrigger type="button" className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2.5 border-0 bg-transparent px-3 py-[0.68rem] text-left text-[var(--aui-ink)] hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_88%,transparent)] data-[panel-open]:bg-[color-mix(in_srgb,var(--aui-surface-2)_62%,transparent)] data-[panel-open]:text-[var(--aui-ink)]">
          {source.scope === 'peer' ? <Network aria-hidden /> : <Laptop aria-hidden />}
          <span className="grid min-w-0 gap-[0.08rem]">
            <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.78rem]">{source.heading}</strong>
            <small className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.68rem] font-medium text-[var(--aui-muted)]">{source.description}</small>
          </span>
          <span className="whitespace-nowrap text-[0.66rem] font-semibold text-[var(--aui-muted)]">{modelCountLabel(searching ? visibleModelCount : source.modelCount)}</span>
          <ChevronDown className={cn('text-[var(--aui-muted)] transition-transform duration-150', (searching || open) && 'rotate-180')} aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="overflow-hidden border-t border-[color-mix(in_srgb,var(--aui-border)_58%,transparent)] data-[closed]:animate-[aui-model-group-close_140ms_ease_both] data-[open]:animate-[aui-model-group-open_160ms_ease_both]">
          {visibleProviders.map((group) => (
            <AssistantModelProviderSection key={group.id} group={group} query={query} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function AssistantModelProviderSection({
  group,
  query
}: {
  group: AssistantModelChoiceGroup
  query: string
}) {
  const [open, setOpen] = useState(true)
  const searching = query.trim().length > 0
  const visibleChoices = group.choices.filter((choice) =>
    !searching || assistantModelChoiceMatches(choice, query)
  )
  if (visibleChoices.length === 0) return null
  const provider = visibleChoices[0]?.provider
  return (
    <Collapsible
      open={searching || open}
      onOpenChange={(next) => {
        if (!searching) setOpen(next)
      }}
      className="border-t border-[color-mix(in_srgb,var(--aui-border)_42%,transparent)] first:border-t-0"
    >
      <CollapsibleTrigger type="button" className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 border-0 bg-transparent py-[0.52rem] pl-[1.35rem] pr-3 !text-[0.76rem] text-left text-[var(--aui-muted)] hover:bg-[color-mix(in_srgb,var(--aui-surface-2)_88%,transparent)] hover:text-[var(--aui-ink)] data-[panel-open]:bg-[color-mix(in_srgb,var(--aui-surface-2)_62%,transparent)] data-[panel-open]:text-[var(--aui-ink)]">
        {group.scope === 'connected device' ? <Network aria-hidden /> : <Cpu aria-hidden />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{group.heading.replace(/\s+·\s+\d+\s+models?$/, '')}</span>
        <span className="whitespace-nowrap text-[0.66rem] font-semibold text-[var(--aui-muted)]">{modelCountLabel(visibleChoices.length)}</span>
        <ChevronDown className={cn('text-[var(--aui-muted)] transition-transform duration-150', (searching || open) && 'rotate-180')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="overflow-hidden data-[closed]:animate-[aui-model-group-close_140ms_ease_both] data-[open]:animate-[aui-model-group-open_160ms_ease_both] [&_[data-slot=model-selector-group]]:pl-[0.65rem]">
        <ModelSelector.Group>
          {visibleChoices.map((choice) => <ModelSelector.Item key={choice.id} model={choice.model} />)}
        </ModelSelector.Group>
      </CollapsibleContent>
    </Collapsible>
  )
}


export interface UseAssistantExecutionInput {
  client: AuroraClient
  route: RouteAvailability
  runtimeHealth: AssistantRuntimeHealth | undefined
  executionHost: 'this-device' | 'connected-device'
  localExecutionAvailable: boolean
  modelLabel: string | null
  setModelLabel: (value: string | null) => void
  setRuntimeProviderLabel: (value: string | null) => void
  productAssistantErrorCopy: (error: Error) => string
}

type AssistantModelCatalogSelector = NonNullable<ModelRuntimeCatalogRequest['meshSelector']>

type AssistantRemoteModelCatalogRequest = {
  execution: AssistantExecutionOption
  selector: AssistantModelCatalogSelector
}

const assistantBaseModelCatalogRequest = {
  include_unavailable: true,
  include_operations: false,
  includeRemote: true
} as const satisfies ModelRuntimeCatalogRequest

function assistantModelCatalogSelector(
  execution: AssistantExecutionOption,
  dataScope: string | null | undefined
): AssistantModelCatalogSelector {
  return {
    peerId: execution.routePolicy.peerId ?? null,
    providerId: execution.routePolicy.providerId ?? null,
    serviceInstanceId: execution.routePolicy.serviceInstanceId ?? null,
    dataScope: dataScope ?? null
  }
}

function assistantModelCatalogRequest(
  selector: AssistantModelCatalogSelector
): ModelRuntimeCatalogRequest {
  return {
    ...assistantBaseModelCatalogRequest,
    meshSelector: selector
  }
}

async function fetchAssistantMergedModelCatalog(
  client: AuroraClient,
  remotes: AssistantRemoteModelCatalogRequest[],
  signal: AbortSignal
): Promise<ModelRuntimeCatalogResponse> {
  const catalog = await fetchAssistantModelCatalog(client, assistantBaseModelCatalogRequest, signal)
  const remoteCatalogs = await Promise.all(
    remotes.map(async ({ execution, selector }) => {
      try {
        const remoteCatalog = await fetchAssistantModelCatalog(client, assistantModelCatalogRequest(selector), signal)
        return { catalog: remoteCatalog, execution }
      } catch (error) {
        if (signal.aborted || assistantModelCatalogWasAborted(error)) throw error
        return null
      }
    })
  )
  return mergeAssistantModelCatalogs(
    catalog,
    remoteCatalogs.filter((entry) => entry !== null)
  )
}

async function fetchAssistantModelCatalog(
  client: AuroraClient,
  request: ModelRuntimeCatalogRequest,
  signal: AbortSignal
): Promise<ModelRuntimeCatalogResponse> {
  if (signal.aborted) throw assistantModelCatalogAbortError()
  return client.models.listCatalog(request, { signal })
}

function assistantModelCatalogAbortError(): DOMException {
  return new DOMException('Assistant model catalog request was cancelled', 'AbortError')
}

function assistantModelCatalogWasAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function useAssistantExecution({
  client,
  route,
  runtimeHealth,
  executionHost,
  localExecutionAvailable,
  modelLabel,
  setModelLabel,
  setRuntimeProviderLabel,
  productAssistantErrorCopy,
}: UseAssistantExecutionInput) {
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval({ subscriptionAvailable: false })
  const [executionOptionId, setExecutionOptionIdState] = useState('local')
  const [selectedModelChoiceId, setSelectedModelChoiceIdState] = useState('automatic')
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const localExecutionMessageLabel = 'Local'

  const executionOptions = useMemo(
    () => assistantExecutionOptions(route, { executionHost, localExecutionAvailable }),
    [executionHost, localExecutionAvailable, route]
  )
  const executionPeerLabels = useMemo(
    () => {
      const labels = new Map<string, string>()
      for (const candidate of route.candidateProviders) {
        if (!isRemoteRouteCandidate(candidate)) continue
        const peerId = candidate.peerId ?? peerIdFromProviderIdentity(candidate.providerId ?? candidate.id)
        if (!peerId) continue
        labels.set(peerId, executionPeerLabel(candidate.nodeName ?? candidate.label, peerId))
      }
      for (const option of executionOptions) {
        if (option.mode === 'dispatch' && option.executionPeerId) {
          labels.set(option.executionPeerId, option.label)
        }
      }
      return labels
    },
    [executionOptions, route.candidateProviders]
  )
  const selectedExecution = executionOptions.find((option) => option.id === executionOptionId) ?? executionOptions[0]!
  const routePolicy = selectedExecution.routePolicy
  const remoteModelCatalogRequests = useMemo(
    () => executionOptions
      .filter((option) => option.mode === 'dispatch' && !option.transportHost)
      .map((execution) => ({
        execution,
        selector: assistantModelCatalogSelector(execution, route.item.privacyClass)
      })),
    [executionOptions, route.item.privacyClass]
  )
  const remoteModelCatalogKey = useMemo(
    () => remoteModelCatalogRequests.map(({ selector }) => selector),
    [remoteModelCatalogRequests]
  )
  const localModelCatalogQuery = useQuery({
    queryKey: queryKeys.admin('assistant-model-catalog', {
      includeRemote: true,
      remotes: remoteModelCatalogKey
    }),
    queryFn: ({ signal }) => fetchAssistantMergedModelCatalog(client, remoteModelCatalogRequests, signal),
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
  })
  const selectedDispatchModelCatalogRequest = useMemo(() => {
    if (selectedExecution.mode !== 'dispatch' || selectedExecution.transportHost) return null
    return assistantModelCatalogSelector(selectedExecution, route.item.privacyClass)
  }, [route.item.privacyClass, selectedExecution])
  const dispatchModelCatalogQuery = useQuery({
    queryKey: queryKeys.admin('assistant-dispatch-model-catalog', selectedDispatchModelCatalogRequest ?? { disabled: true }),
    queryFn: ({ signal }) => {
      if (selectedDispatchModelCatalogRequest === null) throw new Error('Connected device model source is not selected')
      return fetchAssistantModelCatalog(client, assistantModelCatalogRequest(selectedDispatchModelCatalogRequest), signal)
    },
    enabled: selectedDispatchModelCatalogRequest !== null,
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval,
  })
  const localModelCatalog = localModelCatalogQuery.data ?? null
  const dispatchModelCatalog = dispatchModelCatalogQuery.data ?? null
  const activeModelCatalog = selectedExecution.mode === 'local' || selectedExecution.transportHost
    ? localModelCatalog
    : dispatchModelCatalog
  const activeModelCatalogQuery = selectedExecution.mode === 'dispatch' && !selectedExecution.transportHost
    ? dispatchModelCatalogQuery
    : localModelCatalogQuery
  const modelCatalogLoading = activeModelCatalogQuery.isPending
  const modelCatalogError = activeModelCatalogQuery.error
    ? productAssistantErrorCopy(activeModelCatalogQuery.error instanceof Error
      ? activeModelCatalogQuery.error
      : new Error(String(activeModelCatalogQuery.error)))
    : null
  const modelChoices = useMemo(
    () => assistantModelChoices(activeModelCatalog, selectedExecution),
    [activeModelCatalog, selectedExecution]
  )
  const modelChoiceGroups = useMemo(
    () => assistantModelChoiceGroups(modelChoices, selectedExecution),
    [modelChoices, selectedExecution]
  )
  const modelSourceGroups = useMemo(
    () => assistantModelSourceGroups(modelChoiceGroups, selectedExecution, executionOptions),
    [executionOptions, modelChoiceGroups, selectedExecution]
  )
  const selectedModelChoice = modelChoices.find((choice) => choice.id === selectedModelChoiceId) ?? modelChoices[0]!
  const inferencePolicy = assistantInferencePolicy(selectedModelChoice, route)
  const runtimeStrip = useMemo(
    () => ({
      ...buildAssistantRuntimeStrip(runtimeHealth, modelLabel, route, client.transport.kind),
      selectedModel: safeAssistantRuntimeValue(selectedModelChoice.model.name, modelLabel),
      routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label
    }),
    [client.transport.kind, localExecutionMessageLabel, modelLabel, route, runtimeHealth, selectedExecution, selectedModelChoice.model.name]
  )

  useEffect(() => {
    const catalog = localModelCatalogQuery.data
    if (!catalog) return
    const provider = selectedRuntimeProvider(
      catalog.providers.find((candidate) => candidate.provider_id === catalog.selected_provider_id) ?? null,
      catalog.providers
    )
    if (provider?.model_id) setModelLabel('Configured default')
    if (provider) setRuntimeProviderLabel('Selected model source')
  }, [localModelCatalogQuery.data, setModelLabel, setRuntimeProviderLabel])

  useEffect(() => {
    if (modelChoices.some((choice) => choice.id === selectedModelChoiceId)) return
    setSelectedModelChoiceIdState(defaultAssistantModelChoiceId(modelChoices, activeModelCatalog, selectedExecution))
  }, [activeModelCatalog, modelChoices, selectedExecution, selectedModelChoiceId])

  function setExecutionOptionId(value: string) {
    setExecutionOptionIdState(value)
    setSelectedModelChoiceIdState('automatic')
    setModelSearchQuery('')
  }

  function setSelectedModelChoiceId(value: string) {
    setSelectedModelChoiceIdState(value)
    setModelSearchQuery('')
  }

  return {
    executionOptions,
    executionPeerLabels,
    selectedExecution,
    setExecutionOptionId,
    routePolicy,
    modelChoices,
    modelChoiceGroups,
    modelSourceGroups,
    selectedModelChoice,
    setSelectedModelChoiceId,
    modelSearchQuery,
    setModelSearchQuery,
    modelCatalogLoading,
    modelCatalogError,
    inferencePolicy,
    runtimeStrip,
    localExecutionMessageLabel,
  }
}
