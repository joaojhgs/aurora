'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Cloud, Cpu, Download, Gauge, Network, Route, Terminal } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AuroraClient,
  AvailabilityState,
  CapabilityGraph,
  CapabilityProviderCandidate,
  ConfigFieldMetadata,
  ModelRuntimeCatalogResponse,
  ModelRuntimeProviderInfo,
  NativeCapabilityManifest,
  PrivacyClass
} from '@aurora/client'
import { cn } from '#lib/utils'
import { Badge } from '#components/ui/badge'
import { PageHeader, RouteStateNotice } from './state-surface'
import { PageTabs } from './shared-components'
import { AdminConfirmDialog, Button, Card, Checkbox, DataTable, type DataColumn } from './primitives'
import { ToneBadge, type BadgeTone } from './status-badges'
import { useAuroraQueryFallbackInterval, useAuroraQueryKeys } from './query-hooks'
import { AuroraQueryProvider, AURORA_QUERY_STALE_TIMES, useAuroraQueryScope, useAuroraQueryScopeKey } from './query'
import { modelErrorCopy, modelProductCopy, modelStatusCopy } from './models-product-copy'
import { ConfigureProviderDialog, configureFieldInitialValue, parseConfigureFieldValue, providerConfigSection, type ConfigureLoadState } from './models-configure-provider-dialog'

export interface ModelsViewProps {
  client: AuroraClient
  initialCatalog?: ModelRuntimeCatalogResponse | null
  initialGraph?: CapabilityGraph | null
  initialNativeManifest?: NativeCapabilityManifest | null
  initialError?: string | null
  /** Seeds the active tab; used by tests to render the "Usage & Benchmarks" panel without a click. */
  initialTab?: 'providers' | 'benchmarks'
}

export interface ModelProviderViewModel {
  id: string
  name: string
  selected: boolean
  availability: AvailabilityState
  privacyClass: PrivacyClass
  providerType: string
  backendKind: string
  routeLabel: string
  routeQuality: string
  health: string
  healthReason: string
  latencyContext: string
  hardware: string
  benchmark: string
  files: string
  modelIdentity: string
  capabilities: string[]
  blockers: string[]
  operationStatus: string
  canSelect: boolean
  selectReason: string
  selectConfigValue: string | null
  canImport: boolean
  importReason: string
  canDownload: boolean
  downloadReason: string
  canBenchmark: boolean
  benchmarkReason: string
  canRemove: boolean
  removeReason: string
}

export interface ModelBenchmarkSnapshotRow {
  label: string
  value: string
  detail: string
  state: AvailabilityState
}

export interface ModelRuntimeCategoryRow {
  id: string
  label: string
  value: string
  detail: string
  state: AvailabilityState
}

export interface ModelProviderGroup {
  id: 'local' | 'cloud' | 'mesh' | 'coding-agent'
  label: string
  detail: string
  providers: ModelProviderViewModel[]
}

export interface ModelsViewModel {
  loadState: 'loading' | 'ready' | 'empty' | 'error'
  generatedAt: string | null
  selectedProviderId: string | null
  activeProviderLabel: string
  preferredMeshPeerLabel: string
  providerCount: number
  availableCount: number
  remoteCount: number
  mobileLocalLightState: AvailabilityState
  mobileLocalLightReason: string
  secretsRedacted: boolean
  error: string | null
  providers: ModelProviderViewModel[]
  providerGroups: ModelProviderGroup[]
  categoryRows: ModelRuntimeCategoryRow[]
  benchmarkRows: ModelBenchmarkSnapshotRow[]
  warnings: string[]
}

const modelsCatalogRequest = { include_unavailable: true, include_operations: true } as const
const modelCapabilityGraphRequest = { include_unavailable: true, include_internal: true } as const

const emptyModel: ModelsViewModel = {
  loadState: 'loading',
  generatedAt: null,
  selectedProviderId: null,
  activeProviderLabel: 'Not set',
  preferredMeshPeerLabel: 'None selected',
  providerCount: 0,
  availableCount: 0,
  remoteCount: 0,
  mobileLocalLightState: 'unsupported',
  mobileLocalLightReason: 'Native manifest status is not loaded.',
  secretsRedacted: true,
  error: null,
  providers: [],
  providerGroups: [],
  categoryRows: [],
  benchmarkRows: [],
  warnings: []
}

export function ModelsView(props: ModelsViewProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <ModelsViewWithQuery {...props} />
  return (
    <AuroraQueryProvider client={props.client}>
      <ModelsViewWithQuery {...props} />
    </AuroraQueryProvider>
  )
}

function ModelsViewWithQuery({
  client,
  initialCatalog = null,
  initialGraph = null,
  initialNativeManifest = null,
  initialError = null,
  initialTab = 'providers'
}: ModelsViewProps) {
  const scopeKey = useAuroraQueryScopeKey()
  const scopeId = scopeKey[1]
  const initialScopeIdRef = useRef(scopeId)
  const activeScopeIdRef = useRef(scopeId)
  const mountedRef = useRef(false)
  const lifecycleGenerationRef = useRef(0)
  const configureAbortRef = useRef<AbortController | null>(null)
  activeScopeIdRef.current = scopeId
  const [localScopeId, setLocalScopeId] = useState(scopeId)
  const queryClient = useQueryClient()
  const queryKeys = useAuroraQueryKeys()
  const fallbackInterval = useAuroraQueryFallbackInterval()
  const modelsQueryKey = queryKeys.admin('models', modelsCatalogRequest)
  const graphQueryKey = queryKeys.capabilityGraph(modelCapabilityGraphRequest)
  const nativeManifestQueryKey = queryKeys.admin('models-native-manifest')
  const canUseInitialData = initialScopeIdRef.current === scopeId
  const effectiveInitialError = canUseInitialData ? initialError : null
  const catalogQuery = useQuery({
    queryKey: modelsQueryKey,
    queryFn: ({ signal }) => abortAwareModelsPromise(
      () => client.models.listCatalog(modelsCatalogRequest),
      signal
    ),
    initialData: canUseInitialData ? initialCatalog ?? undefined : undefined,
    enabled: effectiveInitialError === null,
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval
  })
  const graphQuery = useQuery({
    queryKey: graphQueryKey,
    queryFn: ({ signal }) => client.capabilities.getGraph(modelCapabilityGraphRequest, { ...(signal ? { signal } : {}) }).catch((error) => {
      if (isModelsAbortError(error)) throw error
      return null
    }),
    initialData: canUseInitialData ? initialGraph ?? undefined : undefined,
    enabled: effectiveInitialError === null,
    staleTime: AURORA_QUERY_STALE_TIMES.capabilities,
    refetchInterval: fallbackInterval
  })
  const nativeManifestQuery = useQuery({
    queryKey: nativeManifestQueryKey,
    queryFn: ({ signal }) => abortAwareModelsPromise(
      () => client.native.getManifest().catch(() => null),
      signal
    ),
    initialData: canUseInitialData ? initialNativeManifest ?? undefined : undefined,
    enabled: effectiveInitialError === null,
    staleTime: AURORA_QUERY_STALE_TIMES.lists,
    refetchInterval: fallbackInterval
  })
  const catalog = catalogQuery.data ?? null
  const graph = graphQuery.data ?? null
  const nativeManifest = nativeManifestQuery.data ?? null
  const loadState: ModelsViewModel['loadState'] = effectiveInitialError
    ? 'error'
    : catalogQuery.isError
      ? 'error'
      : catalog
        ? catalog.providers.length > 0 ? 'ready' : 'empty'
        : 'loading'
  const error = effectiveInitialError ?? (catalogQuery.error ? modelErrorMessage(catalogQuery.error) : null)
  const [selectingProviderId, setSelectingProviderId] = useState<string | null>(null)
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null)
  const [pendingProvider, setPendingProvider] = useState<ModelProviderViewModel | null>(null)
  const [reason, setReason] = useState('')
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [activeTab, setActiveTab] = useState<'providers' | 'benchmarks'>(initialTab)
  const [preferredMeshPeerId, setPreferredMeshPeerId] = useState<string | null>(null)
  const [configureProvider, setConfigureProvider] = useState<ModelProviderViewModel | null>(null)
  const [configureFields, setConfigureFields] = useState<ConfigFieldMetadata[]>([])
  const [configureValues, setConfigureValues] = useState<Record<string, string>>({})
  const [configureLoadState, setConfigureLoadState] = useState<ConfigureLoadState>('idle')
  const [configureError, setConfigureError] = useState<string | null>(null)
  const [configureSaving, setConfigureSaving] = useState(false)
  const localStateCurrent = localScopeId === scopeId
  const effectiveSelectingProviderId = localStateCurrent ? selectingProviderId : null
  const effectiveSelectionMessage = localStateCurrent ? selectionMessage : null
  const effectivePendingProvider = localStateCurrent ? pendingProvider : null
  const effectiveReason = localStateCurrent ? reason : ''
  const effectiveReauthConfirmed = localStateCurrent ? reauthConfirmed : false
  const effectivePreferredMeshPeerId = localStateCurrent ? preferredMeshPeerId : null
  const effectiveConfigureProvider = localStateCurrent ? configureProvider : null
  const effectiveConfigureFields = localStateCurrent ? configureFields : []
  const effectiveConfigureValues = localStateCurrent ? configureValues : {}
  const effectiveConfigureLoadState = localStateCurrent ? configureLoadState : 'idle'
  const effectiveConfigureError = localStateCurrent ? configureError : null
  const effectiveConfigureSaving = localStateCurrent ? configureSaving : false

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleGenerationRef.current += 1
      configureAbortRef.current?.abort()
      configureAbortRef.current = null
    }
  }, [])

  useEffect(() => {
    lifecycleGenerationRef.current += 1
    configureAbortRef.current?.abort()
    configureAbortRef.current = null
    setLocalScopeId(scopeId)
    setSelectingProviderId(null)
    setSelectionMessage(null)
    setPendingProvider(null)
    setReason('')
    setReauthConfirmed(false)
    setPreferredMeshPeerId(null)
    setConfigureProvider(null)
    setConfigureFields([])
    setConfigureValues({})
    setConfigureLoadState('idle')
    setConfigureError(null)
    setConfigureSaving(false)
  }, [scopeId])

  const model = useMemo(
    () => buildModelsViewModel({ catalog, graph, nativeManifest, loadState, error }),
    [catalog, graph, nativeManifest, loadState, error]
  )

  const preferredMeshPeer = effectivePreferredMeshPeerId
    ? (model.providers.find((provider) => provider.id === effectivePreferredMeshPeerId) ?? null)
    : (model.providers.find((provider) => provider.selected && provider.providerType === 'mesh') ?? null)
  const preferredMeshPeerLabel = preferredMeshPeer ? preferredMeshPeer.name : 'None selected'

  async function invalidateModelsConfigQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: modelsQueryKey }),
      queryClient.invalidateQueries({ queryKey: graphQueryKey }),
      queryClient.invalidateQueries({ queryKey: nativeManifestQueryKey }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin('config-editor') }),
      queryClient.invalidateQueries({ queryKey: queryKeys.capabilities({ include_unavailable: true, include_internal: true }) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.services() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.toolCatalog({ include_unavailable: true }) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin('plugins') }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin('service-routing') })
    ])
  }

  function isCurrentLifecycle(targetScopeId: string, generation: number): boolean {
    return mountedRef.current && activeScopeIdRef.current === targetScopeId && lifecycleGenerationRef.current === generation
  }

  async function confirmProviderSelection() {
    const provider = effectivePendingProvider
    if (!provider?.canSelect || !provider.selectConfigValue || effectiveSelectingProviderId) return
    const mutationScopeId = scopeId
    const mutationGeneration = lifecycleGenerationRef.current
    setSelectingProviderId(provider.id)
    setSelectionMessage(null)
    try {
      const result = await client.config.applyChange({
        change: {
          key_path: 'services.orchestrator.llm.provider',
          value: provider.selectConfigValue
        },
        reason: effectiveReason.trim() || `Select model source ${provider.name}`,
        reauthConfirmed: effectiveReauthConfirmed
      })
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      if (!result.data.success) throw new Error(result.data.error ?? 'Aurora did not accept the model source selection')
      await invalidateModelsConfigQueries()
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      setSelectionMessage('Model source selection applied.')
      setPendingProvider(null)
      setReason('')
      setReauthConfirmed(false)
    } catch (nextError) {
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      setSelectionMessage(`Model source selection failed: ${modelErrorMessage(nextError)}`)
    } finally {
      if (isCurrentLifecycle(mutationScopeId, mutationGeneration)) setSelectingProviderId(null)
    }
  }

  function requestProviderSelection(provider: ModelProviderViewModel) {
    if (!provider.canSelect || provider.selected || effectiveSelectingProviderId) return
    setReason(`Select model source ${provider.name}`)
    setReauthConfirmed(false)
    setPendingProvider(provider)
  }

  function setPreferredMeshPeer(provider: ModelProviderViewModel) {
    setPreferredMeshPeerId(provider.id)
  }

  async function openConfigureProvider(provider: ModelProviderViewModel) {
    const configValue = provider.selectConfigValue
    if (!configValue) return
    const mutationScopeId = scopeId
    const mutationGeneration = lifecycleGenerationRef.current
    configureAbortRef.current?.abort()
    const controller = new AbortController()
    configureAbortRef.current = controller
    setConfigureProvider(provider)
    setConfigureFields([])
    setConfigureValues({})
    setConfigureError(null)
    setConfigureLoadState('loading')
    try {
      const result = await client.config.getSchemaMetadata({
        section: providerConfigSection(configValue),
        include_values: true
      }, { signal: controller.signal })
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      if (!result.ok) throw new Error(result.error.message)
      setConfigureFields(result.data.fields)
      setConfigureValues(
        Object.fromEntries(result.data.fields.map((field) => [field.key_path, configureFieldInitialValue(field)]))
      )
      setConfigureLoadState('ready')
    } catch (nextError) {
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      if (isModelsAbortError(nextError)) return
      setConfigureError(modelErrorMessage(nextError))
      setConfigureLoadState('error')
    }
  }

  function closeConfigureProvider() {
    configureAbortRef.current?.abort()
    configureAbortRef.current = null
    setConfigureProvider(null)
    setConfigureFields([])
    setConfigureValues({})
    setConfigureLoadState('idle')
    setConfigureError(null)
  }

  function onConfigureFieldChange(keyPath: string, value: string) {
    setConfigureValues((current) => ({ ...current, [keyPath]: value }))
  }

  async function saveConfigureProvider() {
    const provider = effectiveConfigureProvider
    if (!provider || effectiveConfigureSaving) return
    const mutationScopeId = scopeId
    const mutationGeneration = lifecycleGenerationRef.current
    setConfigureSaving(true)
    setConfigureError(null)
    try {
      const receipts: string[] = []
      for (const field of effectiveConfigureFields) {
        if (field.type === 'dict' || field.type === 'list') continue
        const raw = effectiveConfigureValues[field.key_path] ?? ''
        if (field.secret) {
          if (raw.trim().length === 0) continue
        } else if (raw === configureFieldInitialValue(field)) {
          continue
        }
        const result = await client.config.applyChange({
          change: { key_path: field.key_path, value: parseConfigureFieldValue(raw, field.type) },
          reason: `Configure model source ${provider.name}`,
          reauthConfirmed: true
        })
        if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
        if (!result.data.success) throw new Error(result.data.error ?? `Aurora did not accept ${field.key_path}`)
        receipts.push(result.confirmation.audit_receipt)
      }
      await invalidateModelsConfigQueries()
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      setSelectionMessage(
        receipts.length > 0
          ? 'Model source settings applied.'
          : 'No configuration changes were made.'
      )
      closeConfigureProvider()
    } catch (nextError) {
      if (!isCurrentLifecycle(mutationScopeId, mutationGeneration)) return
      setConfigureError(modelErrorMessage(nextError))
    } finally {
      if (isCurrentLifecycle(mutationScopeId, mutationGeneration)) setConfigureSaving(false)
    }
  }

  return (
    <div data-state={model.loadState} className="flex flex-col gap-4">
      <PageHeader
        id="models-title"
        eyebrow="Models"
        title="Models & Sources"
        description="Local, cloud, and connected model sources, and which one handles requests by default."
      />

      {model.loadState === 'loading' ? <RouteStateNotice state="loading" title="Loading model sources" message="Loading model sources from Aurora." /> : null}
      {model.loadState === 'error' ? (
        <RouteStateNotice state="error" title="Model sources need attention" message={model.error ?? 'Model sources could not be loaded.'} />
      ) : null}
      {model.loadState === 'empty' ? (
        <RouteStateNotice state="empty" title="No model sources" message="No model sources were returned by Aurora." />
      ) : null}
      {effectiveSelectionMessage ? (
        <p
          className={cn(
            'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
            effectiveSelectionMessage.startsWith('Model source selection failed')
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : 'border-border bg-muted/30 text-muted-foreground'
          )}
          role={effectiveSelectionMessage.startsWith('Model source selection failed') ? 'alert' : 'status'}
        >
          <Route size={16} aria-hidden="true" />
          <span>{effectiveSelectionMessage}</span>
        </p>
      ) : null}
      {model.providers.length > 0 ? (
        <PageTabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value === 'benchmarks' ? 'benchmarks' : 'providers')}
          items={[
            {
              value: 'providers',
              label: 'Sources',
              content: (
                <div className="flex flex-col gap-6 py-4">
                  <ModelActiveProviderStrip activeProviderLabel={model.activeProviderLabel} preferredMeshPeerLabel={preferredMeshPeerLabel} />
                  <ModelProviderGroups
                    groups={model.providerGroups}
                    selectingProviderId={effectiveSelectingProviderId}
                    preferredMeshPeerId={preferredMeshPeer?.id ?? null}
                    onSelect={requestProviderSelection}
                    onSetPreferredPeer={setPreferredMeshPeer}
                    onConfigure={(provider) => {
                      void openConfigureProvider(provider)
                    }}
                  />
                  <div>
                    <p className="mb-2.5 text-[12.5px] font-semibold">Compare at a glance</p>
                    <ModelProviderCompareTable providers={model.providers} preferredMeshPeerId={preferredMeshPeer?.id ?? null} />
                  </div>
                </div>
              )
            },
            {
              value: 'benchmarks',
              label: 'Usage & Benchmarks',
              content: (
                <div className="flex flex-col gap-3 py-4">
                  <p className="text-sm text-muted-foreground">Accumulated usage across all model sources used so far in this deployment.</p>
                  <ModelUsageBenchmarkTable providers={model.providers} />
                </div>
              )
            }
          ]}
        />
      ) : null}

      <ConfigureProviderDialog
        provider={effectiveConfigureProvider}
        fields={effectiveConfigureFields}
        values={effectiveConfigureValues}
        loadState={effectiveConfigureLoadState}
        productModelErrorCopy={effectiveConfigureError}
        saving={effectiveConfigureSaving}
        onChange={onConfigureFieldChange}
        onCancel={closeConfigureProvider}
        onSave={() => {
          void saveConfigureProvider()
        }}
      />

      {effectivePendingProvider ? (
        <AdminConfirmDialog
          open
          title={`Select ${effectivePendingProvider.name}`}
          description="Apply this source as the selected model source."
          methodId="Config.Set"
          actionLabel="Select model source"
          severity="standard"
          affected={[effectivePendingProvider.name || 'Selected model source']}
          requireReason
          reasonValue={effectiveReason}
          onReasonChange={setReason}
          confirmLabel={`Select ${effectivePendingProvider.name}`}
          onConfirm={() => { void confirmProviderSelection() }}
          onCancel={() => {
            setPendingProvider(null)
            setReason('')
            setReauthConfirmed(false)
          }}
          busy={effectiveSelectingProviderId === effectivePendingProvider.id}
          extraValid={effectiveReauthConfirmed}
          extraInvalidReason="Confirm recent admin unlock before selecting a model source."
        >
          <Checkbox
            checked={effectiveReauthConfirmed}
            onChange={setReauthConfirmed}
            label="I confirm recent admin unlock for model source changes."
          />
        </AdminConfirmDialog>
      ) : null}
    </div>
  )
}


function abortAwareModelsPromise<T>(read: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return read()
  if (signal.aborted) return Promise.reject(modelsRequestAbortError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const settle = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = () => settle(() => reject(modelsRequestAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    let promise: Promise<T>
    try {
      promise = read()
    } catch (error) {
      settle(() => reject(error))
      return
    }
    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    )
    if (signal.aborted) onAbort()
  })
}

function modelsRequestAbortError(): DOMException {
  return new DOMException('Models request was cancelled', 'AbortError')
}

function isModelsAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function buildModelsViewModel(input: {
  catalog: ModelRuntimeCatalogResponse | null
  graph: CapabilityGraph | null
  nativeManifest: NativeCapabilityManifest | null
  loadState?: ModelsViewModel['loadState']
  error?: string | null
}): ModelsViewModel {
  if (input.error) return { ...emptyModel, loadState: 'error', error: input.error }
  if (!input.catalog) return { ...emptyModel, loadState: input.loadState ?? 'loading' }
  const candidates = providerCandidates(input.graph)
  const mobile = mobileLocalLight(input.nativeManifest, input.catalog)
  const providers = input.catalog.providers.map((provider) =>
    providerModel(provider, candidates.get(provider.provider_id), input.catalog!.selected_provider_id, input.nativeManifest)
  )
  const selected = providers.find((provider) => provider.selected)
  const loadState = input.loadState ?? (providers.length > 0 ? 'ready' : 'empty')
  return {
    loadState,
    generatedAt: input.catalog.generated_at,
    selectedProviderId: input.catalog.selected_provider_id,
    activeProviderLabel: selected ? selected.name : 'Not set',
    preferredMeshPeerLabel: preferredMeshPeerLabel(providers),
    providerCount: providers.length,
    availableCount: providers.filter(providerRouteable).length,
    remoteCount: providers.filter(isMeshOrRemoteProvider).length,
    mobileLocalLightState: mobile.state,
    mobileLocalLightReason: mobile.reason,
    secretsRedacted: input.catalog.secrets_redacted,
    error: null,
    providers,
    providerGroups: modelProviderGroups(providers),
    categoryRows: modelCategoryRows(providers, mobile),
    benchmarkRows: benchmarkSnapshotRows(providers),
    warnings: modelWarnings(providers, mobile)
  }
}

function providerRouteable(provider: ModelProviderViewModel): boolean {
  return ['available-local', 'available-remote', 'degraded'].includes(provider.availability)
}

function isMeshOrRemoteProvider(provider: ModelProviderViewModel): boolean {
  return provider.providerType === 'mesh' || provider.providerType === 'cloud' || provider.providerType === 'remote'
}

function ModelActiveProviderStrip({
  activeProviderLabel,
  preferredMeshPeerLabel
}: {
  activeProviderLabel: string
  preferredMeshPeerLabel: string
}) {
  return (
    <div
      className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-card px-4 py-3.5 sm:grid-cols-2 sm:gap-4"
      aria-label="Selected source and preferred connected device"
    >
      <div className="min-w-0">
        <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Chat source</p>
        <p className="mt-0.5 break-words text-sm font-semibold">{activeProviderLabel}</p>
      </div>
      <div className="min-w-0 border-t border-border pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-4">
        <p className="text-[10.5px] font-semibold tracking-wide text-muted-foreground uppercase">Preferred device (optional)</p>
        <p className="mt-0.5 break-words text-sm font-semibold">{preferredMeshPeerLabel}</p>
      </div>
    </div>
  )
}

function ModelProviderGroups({
  groups,
  selectingProviderId,
  preferredMeshPeerId,
  onSelect,
  onSetPreferredPeer,
  onConfigure
}: {
  groups: ModelProviderGroup[]
  selectingProviderId: string | null
  preferredMeshPeerId: string | null
  onSelect: (provider: ModelProviderViewModel) => void
  onSetPreferredPeer: (provider: ModelProviderViewModel) => void
  onConfigure: (provider: ModelProviderViewModel) => void
}) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.id} aria-labelledby={`model-provider-group-${group.id}`}>
          <div className="mb-2.5 flex items-center gap-1.5">
            <span className="text-muted-foreground" aria-hidden="true">
              {groupIcon(group.id)}
            </span>
            <h2 id={`model-provider-group-${group.id}`} className="text-[12.5px] font-semibold">
              {group.label}
            </h2>
          </div>
          {group.providers.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3.5">
              {group.providers.map((provider) => (
                <ModelProviderCard
                  key={provider.id}
                  provider={provider}
                  selecting={selectingProviderId === provider.id}
                  preferred={provider.id === preferredMeshPeerId}
                  onSelect={onSelect}
                  onSetPreferredPeer={onSetPreferredPeer}
                  onConfigure={onConfigure}
                />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  )
}

function ModelProviderCard({
  provider,
  selecting = false,
  preferred = false,
  onSelect,
  onSetPreferredPeer,
  onConfigure
}: {
  provider: ModelProviderViewModel
  selecting?: boolean
  preferred?: boolean
  onSelect?: (provider: ModelProviderViewModel) => void
  onSetPreferredPeer?: (provider: ModelProviderViewModel) => void
  onConfigure?: (provider: ModelProviderViewModel) => void
}) {
  const isMesh = provider.providerType === 'mesh'
  const configValue = provider.selectConfigValue
  const isActiveOrPreferred = isMesh ? preferred : provider.selected

  return (
    <Card className="border-[1.5px]">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <p className="text-[13.5px] font-semibold">{provider.name}</p>
            {isActiveOrPreferred ? <Badge className="px-2 py-0 text-[9.5px]">{isMesh ? 'Preferred' : 'Active'}</Badge> : null}
          </div>
          <ToneBadge tone={healthTone(provider.availability)} className="text-[10px] whitespace-nowrap">
            {modelHealthLabel(provider.availability)}
          </ToneBadge>
        </div>

        <dl className="flex flex-col gap-1 text-[11.5px]">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="font-mono">{modelName(provider)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Context</dt>
            <dd>{contextWindowLabel(provider)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Data leaves device</dt>
            <dd>{dataLeavesDeviceLabel(provider)}</dd>
          </div>
          {isMesh ? (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Latency</dt>
              <dd>{latencyOnlyLabel(provider)}</dd>
            </div>
          ) : null}
        </dl>

        <div className="flex flex-wrap gap-2">
          {configValue && !isMesh ? (
            <Button variant="outline" onClick={onConfigure ? () => onConfigure(provider) : undefined}>
              Configure
            </Button>
          ) : null}
          {isMesh ? (
            <Button
              variant={preferred ? 'outline' : 'primary'}
              className="flex-1"
              disabled={preferred}
              onClick={onSetPreferredPeer ? () => onSetPreferredPeer(provider) : undefined}
            >
              {preferred ? 'Preferred peer' : 'Set as preferred peer'}
            </Button>
          ) : (
            <Button
              variant={provider.selected ? 'outline' : 'primary'}
              className="flex-1"
              disabled={provider.selected || !provider.canSelect || selecting}
              disabledReason={provider.selected ? undefined : provider.selectReason}
              busy={selecting}
              onClick={provider.canSelect && onSelect ? () => onSelect(provider) : undefined}
            >
              {provider.selected ? 'Active' : selecting ? 'Setting active' : 'Set as active'}
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <ModelAction
            icon="download"
            label="Import"
            enabled={provider.canImport}
            reason={provider.importReason}
          />
          <ModelAction
            icon="download"
            label="Download"
            enabled={provider.canDownload}
            reason={provider.downloadReason}
          />
          <ModelAction
            icon="download"
            label="Remove"
            enabled={provider.canRemove}
            reason={provider.removeReason}
          />
          <ModelAction
            icon="benchmark"
            label="Benchmark"
            enabled={provider.canBenchmark}
            reason={provider.benchmarkReason}
          />
        </div>
      </div>
    </Card>
  )
}

function ModelProviderCompareTable({
  providers,
  preferredMeshPeerId
}: {
  providers: ModelProviderViewModel[]
  preferredMeshPeerId: string | null
}) {
  const columns: Array<DataColumn<ModelProviderViewModel>> = [
    {
      key: 'provider',
      header: 'Source',
      render: (provider) => (
        <span className="font-medium">
          {provider.name}
          {isActiveOrPreferredProvider(provider, preferredMeshPeerId) ? (
            <span className="font-semibold text-primary" aria-label="selected source">
              {' '}
              &#9733;
            </span>
          ) : null}
        </span>
      )
    },
    { key: 'type', header: 'Type', render: (provider) => <span className="text-muted-foreground">{modelProviderTypeLabel(provider)}</span> },
    { key: 'model', header: 'Model', mono: true, render: (provider) => <code>{modelName(provider)}</code> },
    { key: 'context', header: 'Context', render: (provider) => <span className="text-muted-foreground">{contextWindowLabel(provider)}</span> },
    {
      key: 'data-leaves-device',
      header: 'Data leaves device',
      render: (provider) => <span className="text-muted-foreground">{dataLeavesDeviceLabel(provider)}</span>
    },
    {
      key: 'health',
      header: 'Health',
      render: (provider) => <ToneBadge tone={healthTone(provider.availability)}>{modelHealthLabel(provider.availability)}</ToneBadge>
    }
  ]
  return <DataTable columns={columns} rows={providers} getRowKey={(provider) => provider.id} />
}

function ModelUsageBenchmarkTable({ providers }: { providers: ModelProviderViewModel[] }) {
  const columns: Array<DataColumn<ModelProviderViewModel>> = [
    { key: 'provider', header: 'Source', render: (provider) => <span className="font-medium">{provider.name}</span> },
    {
      key: 'requests',
      header: 'Requests',
      align: 'end',
      render: (provider) => <span className="text-muted-foreground">{usageRequestsLabel(provider)}</span>
    },
    {
      key: 'avg-latency',
      header: 'Avg latency',
      align: 'end',
      render: (provider) => <span className="text-muted-foreground">{latencyOnlyLabel(provider)}</span>
    },
    {
      key: 'tokens-per-sec',
      header: 'Tokens/sec',
      align: 'end',
      render: (provider) => <span className="text-muted-foreground">{tokensPerSecondLabel(provider)}</span>
    },
    {
      key: 'error-rate',
      header: 'Error rate',
      align: 'end',
      render: (provider) => <span className="text-muted-foreground">{errorRateLabel(provider)}</span>
    },
    {
      key: 'cost-accrued',
      header: 'Cost accrued',
      align: 'end',
      render: (provider) => <span className="text-muted-foreground">{costAccruedLabel(provider)}</span>
    }
  ]
  return <DataTable columns={columns} rows={providers} getRowKey={(provider) => provider.id} />
}

function ModelAction({
  icon,
  label,
  enabled,
  reason
}: {
  icon: 'route' | 'download' | 'benchmark'
  label: string
  enabled: boolean
  reason: string
}) {
  const Icon = icon === 'benchmark' ? Gauge : Download
  return (
    <button
      type="button"
      disabled={!enabled}
      aria-label={label}
      title={reason}
      data-action-reason={reason ? 'managed-by-aurora' : undefined}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon size={13} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}


function providerCandidates(graph: CapabilityGraph | null): Map<string, CapabilityProviderCandidate> {
  const result = new Map<string, CapabilityProviderCandidate>()
  const nodes = [
    graph?.byFeatureId['method:Orchestrator.GetModelCatalog'],
    graph?.byFeatureId['method:Orchestrator.ImportModel'],
    graph?.byFeatureId['method:Orchestrator.DownloadModel'],
    graph?.byFeatureId['method:Orchestrator.BenchmarkModel']
  ].filter(Boolean)
  for (const node of nodes) {
    for (const provider of node!.providers) {
      if (!result.has(provider.providerId)) result.set(provider.providerId, provider)
    }
  }
  return result
}

function preferredMeshPeerLabel(providers: ModelProviderViewModel[]): string {
  const selectedMesh = providers.find((provider) => provider.selected && provider.providerType === 'mesh')
  if (selectedMesh) return selectedMesh.name
  return 'None selected'
}

function isActiveOrPreferredProvider(provider: ModelProviderViewModel, preferredMeshPeerId: string | null): boolean {
  if (provider.providerType === 'mesh') return provider.id === preferredMeshPeerId
  return provider.selected
}

function healthTone(state: AvailabilityState): BadgeTone {
  if (state === 'available-local' || state === 'available-remote') return 'success'
  if (state === 'degraded' || state === 'pending' || state === 'stale') return 'warning'
  if (state === 'denied' || state === 'privacy-blocked' || state === 'offline') return 'danger'
  return 'neutral'
}

function modelProviderGroups(providers: ModelProviderViewModel[]): ModelProviderGroup[] {
  const groups: ModelProviderGroup[] = [
    {
      id: 'local',
      label: 'Local sources',
      detail: 'Local desktop and native-device model sources reported by Aurora.',
      providers: providers.filter((provider) => providerGroupId(provider) === 'local')
    },
    {
      id: 'cloud',
      label: 'Cloud sources',
      detail: 'External sources remain policy-gated by Aurora.',
      providers: providers.filter((provider) => providerGroupId(provider) === 'cloud')
    },
    {
      id: 'mesh',
      label: 'Connected sources',
      detail: 'Peer-backed sources are separate from the active chat source and require review.',
      providers: providers.filter((provider) => providerGroupId(provider) === 'mesh')
    },
    {
      id: 'coding-agent',
      label: 'Coding agent sources',
      detail: 'Shown only when Aurora advertises coding-agent source data.',
      providers: providers.filter((provider) => providerGroupId(provider) === 'coding-agent')
    }
  ]
  return groups.filter((group) => group.providers.length > 0 || group.id === 'coding-agent')
}

function providerGroupId(provider: ModelProviderViewModel): ModelProviderGroup['id'] {
  const providerType = provider.providerType.toLowerCase()
  const backendKind = provider.backendKind.toLowerCase()
  const capabilities = provider.capabilities.join(' ').toLowerCase()
  if (providerType.includes('coding') || backendKind.includes('coding') || capabilities.includes('coding-agent')) return 'coding-agent'
  if (providerType === 'mesh' || backendKind.includes('mesh')) return 'mesh'
  if (providerType === 'cloud' || providerType === 'remote' || backendKind.includes('cloud')) return 'cloud'
  return 'local'
}

function groupIcon(id: ModelProviderGroup['id']) {
  if (id === 'cloud') return <Cloud size={14} aria-hidden="true" />
  if (id === 'mesh') return <Network size={14} aria-hidden="true" />
  if (id === 'coding-agent') return <Terminal size={14} aria-hidden="true" />
  return <Cpu size={14} aria-hidden="true" />
}

function modelProviderTypeLabel(provider: ModelProviderViewModel): string {
  if (providerGroupId(provider) === 'coding-agent') return 'Coding agent'
  if (provider.providerType === 'mesh') return 'Mesh peer'
  if (provider.providerType === 'cloud' || provider.providerType === 'remote') return 'Cloud'
  if (provider.providerType.includes('mobile')) return 'Local light'
  return 'Local'
}

function modelName(provider: ModelProviderViewModel): string {
  return provider.modelIdentity.split(';')[0]?.trim() || 'Model pending'
}

function contextWindowLabel(provider: ModelProviderViewModel): string {
  const match = provider.latencyContext.match(/(\d+) token context/)
  return match?.[1] ? `${Number(match[1]).toLocaleString('en-US')} tokens` : 'Pending'
}

function dataLeavesDeviceLabel(provider: ModelProviderViewModel): string {
  if (provider.providerType === 'cloud' || provider.providerType === 'remote') return 'Yes'
  if (provider.providerType === 'mesh') return 'Peer only'
  return 'No'
}

function latencyOnlyLabel(provider: ModelProviderViewModel): string {
  const match = provider.latencyContext.match(/(\d+) ms latency/)
  return match?.[1] ? `${Number(match[1]).toLocaleString('en-US')}ms` : 'Pending'
}

function tokensPerSecondLabel(provider: ModelProviderViewModel): string {
  const match = provider.benchmark.match(/([\d.]+) tok\/s/)
  return match?.[1] ?? 'Pending'
}

function usageRequestsLabel(provider: ModelProviderViewModel): string {
  return provider.operationStatus === 'no operation active' ? '0' : 'Active'
}

function errorRateLabel(provider: ModelProviderViewModel): string {
  return provider.availability === 'denied' || provider.availability === 'privacy-blocked' ? 'Policy held' : '0%'
}

function costAccruedLabel(provider: ModelProviderViewModel): string {
  return provider.providerType === 'cloud' || provider.providerType === 'remote' ? '$0.00' : 'Local'
}

function modelHealthLabel(state: AvailabilityState): string {
  if (state === 'available-local' || state === 'available-remote') return 'Healthy'
  if (state === 'degraded') return 'Needs review'
  if (state === 'pending' || state === 'stale') return 'Pending'
  if (state === 'privacy-blocked' || state === 'denied') return 'Policy held'
  if (state === 'offline') return 'Offline'
  return 'Planned'
}

function providerModel(
  provider: ModelRuntimeProviderInfo,
  candidate: CapabilityProviderCandidate | undefined,
  selectedProviderId: string | null,
  nativeManifest: NativeCapabilityManifest | null
): ModelProviderViewModel {
  const nativeLocalLight = nativeLocalLightForProvider(provider, nativeManifest)
  const availability = nativeLocalLight?.state ?? availabilityForProvider(provider, candidate)
  const privacyClass = candidate?.privacyClass ?? privacyForProvider(provider)
  const blockers = sortedUnique([
    ...(candidate?.disabledReasons ?? []).map((reason) => modelStatusCopy(reason, 'This model source needs review before it can be used.')),
    nativeLocalLight?.reason,
    ...(!provider.enabled ? [modelStatusCopy(provider.health_reason, 'This model source is currently unavailable.')] : []),
    ...(!provider.secrets_redacted ? ['Sensitive details are hidden until Aurora can verify this source.'] : [])
  ])
  const importActive = isActiveModelOperationProgress(provider.import_progress)
  const downloadActive = isActiveModelOperationProgress(provider.download_progress)
  return {
    id: provider.provider_id,
    name: modelSourceDisplayName(provider.display_name),
    selected: provider.selected || provider.provider_id === selectedProviderId,
    availability,
    privacyClass,
    providerType: provider.provider_type,
    backendKind: provider.backend_kind,
    routeLabel: nativeLocalLight?.routeLabel ?? routeLabel(provider, candidate),
    routeQuality: routeQualityLabel(provider, availability, candidate),
    health: provider.health,
    healthReason: modelStatusCopy(provider.health_reason, 'Aurora did not provide a health reason.'),
    latencyContext: latencyContextLabel(provider),
    hardware: hardwareLabel(provider.hardware),
    benchmark: benchmarkLabel(provider),
    files: filesLabel(provider),
    modelIdentity: modelIdentityLabel(provider),
    capabilities: provider.capabilities.length > 0 ? provider.capabilities : ['catalog-only'],
    blockers,
    operationStatus: modelOperationStatus(provider),
    canSelect: canSelectProvider(provider, candidate, availability, provider.provider_id === selectedProviderId || provider.selected, blockers),
    selectReason: selectReason(provider.provider_id === selectedProviderId || provider.selected, provider, candidate, availability),
    selectConfigValue: modelProviderConfigValue(provider),
    canImport: false,
    importReason: importActive ? modelStatusCopy(provider.import_progress.message, 'Model import is in progress.') : 'Model import needs administrator approval before it can start.',
    canDownload: false,
    downloadReason: downloadActive ? modelStatusCopy(provider.download_progress.message, 'Model download is in progress.') : 'Model download needs administrator approval before it can start.',
    canBenchmark: false,
    benchmarkReason: provider.benchmark.status === 'running'
      ? modelStatusCopy(provider.benchmark.reason, 'Benchmark is running through Aurora.')
      : 'Benchmark needs administrator approval before it can start.',
    canRemove: false,
    removeReason: 'Removing model files is not available from Aurora yet.'
  }
}

function canSelectProvider(
  provider: ModelRuntimeProviderInfo,
  candidate: CapabilityProviderCandidate | undefined,
  availability: AvailabilityState,
  selected: boolean,
  blockers: string[]
): boolean {
  if (selected) return false
  if (provider.provider_type !== 'local') return false
  if (!modelProviderConfigValue(provider)) return false
  if (!provider.enabled) return false
  if (blockers.length > 0) return false
  if (!['available-local', 'degraded'].includes(availability)) return false
  if (candidate && (!candidate.selectable || candidate.providerKind !== 'local')) return false
  return true
}

function modelProviderConfigValue(provider: Pick<ModelRuntimeProviderInfo, 'provider_id' | 'backend_kind'>): string | null {
  const id = provider.provider_id
  const backend = provider.backend_kind
  if (id === 'llama_cpp' || id === 'huggingface_pipeline' || id === 'huggingface_endpoint' || id === 'openai') return id
  if (id.includes('llama-cpp') || backend === 'llama_cpp' || backend === 'desktop-local') return 'llama_cpp'
  if (id.includes('huggingface-pipeline') || backend === 'transformers_pipeline') return 'huggingface_pipeline'
  if (id.includes('huggingface-endpoint') || backend === 'huggingface_endpoint') return 'huggingface_endpoint'
  if (id.includes('openai') || backend === 'openai_chat') return 'openai'
  return null
}

function modelSourceDisplayName(name: string): string {
  return modelProductCopy(name, 'Model source')
}

function modelOperationStatus(provider: ModelRuntimeProviderInfo): string {
  const active = [provider.import_progress, provider.download_progress].filter(isActiveModelOperationProgress)
  if (active.length === 0) return 'no operation active'
  return active
    .map((progress) => {
      const label = progress.operation_type === 'download' ? 'Download' : 'Import'
      return `${label} ${progress.progress_percent}% complete (${modelStatusCopy(progress.message, 'Model task is updating.')})`
    })
    .join(', ')
}

function isActiveModelOperationProgress(
  progress: ModelRuntimeProviderInfo['import_progress'] | ModelRuntimeProviderInfo['download_progress']
): boolean {
  return progress.status !== 'idle' && progress.status !== 'not_started'
}

function connectedSourceRouteLabel(providerType: string): string {
  if (providerType === 'mesh') return 'Connected device'
  if (providerType === 'cloud' || providerType === 'remote') return 'Cloud source'
  if (providerType.includes('mobile')) return 'This device'
  return 'Connected source'
}

function availabilityForProvider(provider: ModelRuntimeProviderInfo, candidate: CapabilityProviderCandidate | undefined): AvailabilityState {
  if (candidate?.availability) return candidate.availability
  if (provider.health === 'stale') return 'stale'
  if (provider.health === 'denied') return 'denied'
  if (provider.health === 'degraded') return 'degraded'
  if (provider.health === 'privacy-blocked') return 'privacy-blocked'
  if (provider.health === 'pending') return 'pending'
  if (!provider.enabled || provider.health === 'unsupported' || provider.health === 'unavailable') return 'unsupported'
  return provider.provider_type === 'local' ? 'available-local' : 'available-remote'
}

function privacyForProvider(provider: ModelRuntimeProviderInfo): PrivacyClass {
  if (provider.provider_type === 'cloud') return 'sensitive'
  if (provider.provider_type.includes('mobile')) return 'credential'
  if (provider.provider_type === 'mesh') return 'personal'
  return 'personal'
}

function routeLabel(provider: ModelRuntimeProviderInfo, candidate: CapabilityProviderCandidate | undefined): string {
  if (candidate) return connectedSourceRouteLabel(provider.provider_type)
  if (provider.provider_type === 'local') return 'Available on this device'
  return connectedSourceRouteLabel(provider.provider_type)
}

function routeQualityLabel(
  provider: ModelRuntimeProviderInfo,
  availability: AvailabilityState,
  candidate: CapabilityProviderCandidate | undefined
): string {
  const routeKind = provider.provider_type === 'local'
    ? 'local'
    : provider.provider_type === 'mesh'
      ? 'mesh remote'
      : provider.provider_type === 'cloud'
        ? 'cloud egress'
        : provider.provider_type.includes('mobile')
          ? 'mobile native'
          : provider.provider_type
  const policy = candidate?.disabledReasons?.length
    ? 'needs review'
    : provider.enabled
      ? 'routeable from catalog status'
      : 'disabled by Aurora'
  return `${routeKind}; ${availability}; ${policy}`
}

function hardwareLabel(hardware: ModelRuntimeProviderInfo['hardware']): string {
  const entries = Object.entries(hardware)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
  return entries.length > 0 ? entries.join(', ') : 'not reported'
}

function benchmarkLabel(provider: ModelRuntimeProviderInfo): string {
  const { benchmark } = provider
  if (benchmark.status === 'complete') {
    const tokens = benchmark.tokens_per_second === null ? 'tokens pending' : `${benchmark.tokens_per_second} tok/s`
    const latency = benchmark.latency_ms === null ? 'latency pending' : `${benchmark.latency_ms} ms`
    return `${tokens}, ${latency}`
  }
  return benchmark.reason ? `${benchmark.status}: ${modelStatusCopy(benchmark.reason, 'Benchmark status needs review.')}` : benchmark.status
}

function latencyContextLabel(provider: ModelRuntimeProviderInfo): string {
  const latency = productModelLatencyCopy(provider.benchmark.latency_ms)
  const context = productModelContextCopy(provider.context_window)
  const limit = productModelGenerationLimitCopy(provider.generation_limit)
  return `${latency}; ${context}; ${limit}`
}

function productModelLatencyCopy(latencyMs: number | null): string {
  return latencyMs === null ? 'latency not measured' : `${latencyMs} ms latency`
}

function productModelContextCopy(contextWindow: number | null): string {
  return contextWindow === null ? 'context unknown' : `${contextWindow} token context`
}

function productModelGenerationLimitCopy(generationLimit: number | null): string {
  return generationLimit === null ? 'generation limit unknown' : `${generationLimit} token generation limit`
}

function filesLabel(provider: ModelRuntimeProviderInfo): string {
  if (provider.model_files.length === 0) return 'no local files reported'
  return provider.model_files
    .map((file) => `${file.display_name}${file.exists === false ? ' missing' : ''}${file.path_redacted ? ' redacted' : ''}`)
    .join(', ')
}

function modelIdentityLabel(provider: ModelRuntimeProviderInfo): string {
  const model = provider.model_id ?? 'model id not reported'
  const source = provider.source ?? 'source not reported'
  const license = provider.license ?? 'license not reported'
  return `${model}; ${source}; ${license}`
}

function benchmarkSnapshotRows(providers: ModelProviderViewModel[]): ModelBenchmarkSnapshotRow[] {
  const completed = providers.filter((provider) => !provider.benchmark.includes(':') && !provider.benchmark.includes('pending') && provider.benchmark !== 'idle')
  const running = providers.filter((provider) => provider.benchmark.includes('running'))
  const unavailable = providers.filter((provider) => provider.benchmark.includes('unsupported') || provider.benchmark.includes('unavailable') || provider.benchmark.includes('idle'))
  return [
    {
      label: 'Measured sources',
      value: `${completed.length}/${providers.length}`,
      detail: completed.length > 0 ? completed.map((provider) => provider.name).join(', ') : 'No completed benchmark status was returned by Aurora.',
      state: completed.length > 0 ? 'available-local' : 'pending'
    },
    {
      label: 'Running operations',
      value: `${running.length}`,
      detail: running.length > 0 ? running.map((provider) => provider.name).join(', ') : 'No benchmark operation is currently active.',
      state: running.length > 0 ? 'degraded' : 'available-local'
    },
    {
      label: 'Missing measurements',
      value: `${unavailable.length}`,
      detail: unavailable.length > 0 ? unavailable.map((provider) => provider.name).join(', ') : 'All sources have benchmark status.',
      state: unavailable.length > 0 ? 'degraded' : 'available-local'
    }
  ]
}

function modelCategoryRows(
  providers: ModelProviderViewModel[],
  mobile: { state: AvailabilityState; reason: string }
): ModelRuntimeCategoryRow[] {
  const selected = providers.find((provider) => provider.selected)
  const configured = providers
  const installedLocal = providers.filter((provider) =>
    provider.providerType === 'local' && provider.files !== 'no local files reported'
  )
  const activeImportDownload = providers.filter((provider) => provider.operationStatus !== 'no operation active')
  const benchmarkable = providers.filter(hasBenchmarkEvidence)
  const meshRemote = providers.filter(isMeshOrRemoteProvider)

  return [
    {
      id: 'selected-provider',
      label: 'Currently selected source',
      value: selected ? selected.name : 'not selected',
      detail: selected
        ? selected.selectReason
        : 'Aurora did not report a selected model source.',
      state: selected?.availability ?? 'pending'
    },
    {
      id: 'configured-providers',
      label: 'Configured sources',
      value: `${configured.length} configured`,
      detail: configured.length > 0
        ? configured.map((provider) => `${provider.name} (${provider.providerType})`).join(', ')
        : 'No model sources were returned by Aurora.',
      state: configured.length > 0 ? 'available-local' : 'unsupported'
    },
    {
      id: 'installed-local-models',
      label: 'Installed local models',
      value: `${installedLocal.length} installed`,
      detail: installedLocal.length > 0
        ? installedLocal.map((provider) => `${provider.name}: ${provider.files}`).join(', ')
        : 'No installed local model files were reported by Aurora.',
      state: installedLocal.length > 0 ? 'available-local' : 'unsupported'
    },
    {
      id: 'downloadable-importable-models',
      label: 'Downloadable/importable models',
      value: `${activeImportDownload.length} active operations`,
      detail: activeImportDownload.length > 0
        ? activeImportDownload.map((provider) => `${provider.name}: ${provider.operationStatus}`).join(', ')
        : 'No import or download is active.',
      state: activeImportDownload.length > 0 ? 'degraded' : 'pending'
    },
    {
      id: 'benchmarkable-providers',
      label: 'Benchmarkable sources',
      value: `${benchmarkable.length} with benchmark status`,
      detail: benchmarkable.length > 0
        ? benchmarkable.map((provider) => `${provider.name}: ${provider.benchmark}`).join(', ')
        : 'No benchmarkable sources or completed benchmark measurements were returned.',
      state: benchmarkable.length > 0 ? 'available-local' : 'pending'
    },
    {
      id: 'mesh-remote-providers',
      label: 'Connected or cloud sources',
      value: `${meshRemote.length} remote-capable`,
      detail: meshRemote.length > 0
        ? meshRemote.map((provider) => `${provider.name}: ${provider.routeLabel}`).join(', ')
        : 'No connected or cloud sources were reported.',
      state: meshRemote.some(providerRouteable) ? 'available-remote' : meshRemote.length > 0 ? 'privacy-blocked' : 'unsupported'
    },
    {
      id: 'mobile-local-light-availability',
      label: 'Mobile local-light availability',
      value: mobile.state,
      detail: mobile.reason,
      state: mobile.state
    }
  ]
}

function hasBenchmarkEvidence(provider: ModelProviderViewModel): boolean {
  if (provider.canBenchmark) return true
  return !provider.benchmark.includes('unsupported')
    && !provider.benchmark.includes('unavailable')
    && !provider.benchmark.includes('idle')
    && !provider.benchmark.includes('pending')
}

function modelWarnings(
  providers: ModelProviderViewModel[],
  mobile: { state: AvailabilityState; reason: string }
): string[] {
  return sortedUnique([
    ...providers.flatMap((provider) => provider.blockers.map((blocker) => `${provider.name}: ${blocker}`)),
    ...providers.filter((provider) => !provider.canSelect).map((provider) => `${provider.name}: ${provider.selectReason}`),
    mobile.state === 'available-local' ? null : `Mobile local-light remains capability-gated: ${mobile.reason}`
  ]).slice(0, 8)
}

function selectReason(
  selected: boolean,
  provider: ModelRuntimeProviderInfo,
  candidate: CapabilityProviderCandidate | undefined,
  availability: AvailabilityState
): string {
  if (selected) return 'Selected source is reported by Aurora.'
  if (provider.provider_type !== 'local') return 'Only local executable sources can be selected here; remote, cloud, and native sources require their own policy flow.'
  const configValue = modelProviderConfigValue(provider)
  if (!configValue) return 'This model source is not mapped for selection; repair is required.'
  if (!provider.enabled) return modelStatusCopy(provider.health_reason, 'Aurora reports this source disabled.')
  if (!['available-local', 'degraded'].includes(availability)) return `Local source is ${availability}; Aurora must report executable local status before selection.`
  if (candidate && !candidate.selectable) return 'Aurora marks this local source as not selectable.'
  if (candidate && candidate.providerKind !== 'local') return 'Aurora did not report this source as a local executable source.'
  return 'Selectable local source; choosing it updates the selected model source after admin approval.'
}

function mobileLocalLight(
  nativeManifest: NativeCapabilityManifest | null,
  catalog: ModelRuntimeCatalogResponse
): { state: AvailabilityState; reason: string } {
  const provider = catalog.providers.find((item) => item.provider_type.includes('mobile') || item.provider_id.includes('mobile'))
  const status = nativeManifest?.localLightInference
  if (status) {
    return {
      state: availabilityFromLocalLightStatus(status.state),
      reason: modelStatusCopy(status.reason, 'Native mobile model source needs attention.')
    }
  }
  const manifestEnabled = Boolean(nativeManifest?.capabilities['android.localLightInference.provider'])
  const permissionGranted = nativeManifest ? nativeManifest.permissions['aurora.android.localLightInference'] !== false : false
  if (manifestEnabled && permissionGranted) return { state: 'available-local', reason: 'Native mobile model source is available.' }
  if (provider?.health_reason) return { state: availabilityForProvider(provider, undefined), reason: modelStatusCopy(provider.health_reason, 'Native mobile model source needs attention.') }
  return { state: 'unsupported', reason: 'Native mobile model source status is unavailable.' }
}

function nativeLocalLightForProvider(
  provider: ModelRuntimeProviderInfo,
  nativeManifest: NativeCapabilityManifest | null
): { state: AvailabilityState; reason: string; routeLabel: string } | null {
  const status = nativeManifest?.localLightInference
  if (!status || provider.provider_id !== status.providerId) return null
  return {
    state: availabilityFromLocalLightStatus(status.state),
    reason: modelStatusCopy(status.reason, 'Native mobile model source needs attention.'),
    routeLabel: 'Available on this device'
  }
}

function availabilityFromLocalLightStatus(state: string): AvailabilityState {
  if (state === 'available') return 'available-local'
  if (state === 'needs_native_permission') return 'privacy-blocked'
  if (state === 'degraded' || state === 'fallback') return 'degraded'
  return 'unsupported'
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort()
}

function modelErrorMessage(error: unknown): string {
  return modelErrorCopy(error, 'Aurora model source request failed.')
}
