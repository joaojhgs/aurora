'use client'

import { useEffect, useMemo, useState } from 'react'
import { Cpu, Download, Gauge, HardDrive, RefreshCcw, Route, Smartphone } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  CapabilityGraph,
  CapabilityProviderCandidate,
  ModelRuntimeCatalogResponse,
  ModelRuntimeProviderInfo,
  NativeCapabilityManifest,
  PrivacyClass
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface ModelsViewProps {
  client: AuroraClient
  initialCatalog?: ModelRuntimeCatalogResponse | null
  initialGraph?: CapabilityGraph | null
  initialNativeManifest?: NativeCapabilityManifest | null
  initialError?: string | null
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
  health: string
  healthReason: string
  hardware: string
  benchmark: string
  files: string
  capabilities: string[]
  blockers: string[]
  operationStatus: string
  canSelect: boolean
  selectReason: string
  canImport: boolean
  importReason: string
  canDownload: boolean
  downloadReason: string
  canBenchmark: boolean
  benchmarkReason: string
}

export interface ModelsViewModel {
  loadState: 'loading' | 'ready' | 'empty' | 'error'
  generatedAt: string | null
  selectedProviderId: string | null
  providerCount: number
  availableCount: number
  remoteCount: number
  mobileLocalLightState: AvailabilityState
  mobileLocalLightReason: string
  secretsRedacted: boolean
  error: string | null
  providers: ModelProviderViewModel[]
}

const emptyModel: ModelsViewModel = {
  loadState: 'loading',
  generatedAt: null,
  selectedProviderId: null,
  providerCount: 0,
  availableCount: 0,
  remoteCount: 0,
  mobileLocalLightState: 'unsupported',
  mobileLocalLightReason: 'Native manifest evidence is not loaded.',
  secretsRedacted: true,
  error: null,
  providers: []
}

export function ModelsView({
  client,
  initialCatalog = null,
  initialGraph = null,
  initialNativeManifest = null,
  initialError = null
}: ModelsViewProps) {
  const [catalog, setCatalog] = useState<ModelRuntimeCatalogResponse | null>(initialCatalog)
  const [graph, setGraph] = useState<CapabilityGraph | null>(initialGraph)
  const [nativeManifest, setNativeManifest] = useState<NativeCapabilityManifest | null>(initialNativeManifest)
  const [loadState, setLoadState] = useState<ModelsViewModel['loadState']>(
    initialError ? 'error' : initialCatalog ? 'ready' : 'loading'
  )
  const [error, setError] = useState<string | null>(initialError)

  useEffect(() => {
    if (initialCatalog || initialError) return
    let cancelled = false
    setLoadState('loading')
    setError(null)
    Promise.all([
      client.models.listCatalog({ include_unavailable: true, include_operations: true }),
      client.capabilities.getGraph({ include_unavailable: true, include_internal: true }).catch(() => null),
      client.native.getManifest().catch(() => null)
    ]).then(
      ([nextCatalog, nextGraph, nextNativeManifest]) => {
        if (cancelled) return
        setCatalog(nextCatalog)
        setGraph(nextGraph)
        setNativeManifest(nextNativeManifest)
        setLoadState(nextCatalog.providers.length > 0 ? 'ready' : 'empty')
      },
      (nextError) => {
        if (cancelled) return
        setError(modelErrorMessage(nextError))
        setLoadState('error')
      }
    )
    return () => {
      cancelled = true
    }
  }, [client, initialCatalog, initialError])

  const model = useMemo(
    () => buildModelsViewModel({ catalog, graph, nativeManifest, loadState, error }),
    [catalog, graph, nativeManifest, loadState, error]
  )

  return (
    <section className="aui-models" aria-labelledby="aui-models-title" data-state={model.loadState}>
      <header className="aui-models-header">
        <div>
          <p className="aui-kicker">Models</p>
          <h1 id="aui-models-title">Models and runtime</h1>
          <p>
            Provider health, route, privacy, hardware, and benchmark states are loaded through AuroraClient.
          </p>
        </div>
        <div className="aui-model-badges" aria-label="Model catalog summary">
          <EvidenceBadge label={`${model.providerCount} providers`} />
          <EvidenceBadge label={`${model.availableCount} selectable`} />
          <EvidenceBadge label={`${model.remoteCount} remote`} />
          <EvidenceBadge label={model.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
        </div>
      </header>

      {model.loadState === 'loading' ? (
        <ModelNotice icon="loading" message="Loading model runtime catalog from AuroraClient." />
      ) : null}
      {model.loadState === 'error' ? (
        <ModelNotice icon="error" message={model.error ?? 'Model runtime catalog could not be loaded.'} role="alert" />
      ) : null}
      {model.loadState === 'empty' ? (
        <ModelNotice icon="empty" message="No model runtime providers were returned by the backend catalog." />
      ) : null}

      {model.providers.length > 0 ? (
        <>
          <div className="aui-model-grid">
            {model.providers.map((provider) => (
              <ModelProviderCard key={provider.id} provider={provider} />
            ))}
          </div>
          <div className="aui-model-layout">
            <ModelProviderTable providers={model.providers} />
            <aside className="aui-model-summary" aria-label="Runtime summary">
              <h2>Runtime evidence</h2>
              <dl>
                <div><dt>Generated</dt><dd>{model.generatedAt ?? 'pending'}</dd></div>
                <div><dt>Selected provider</dt><dd>{model.selectedProviderId ?? 'not selected'}</dd></div>
                <div><dt>Mobile local-light</dt><dd><StatusBadge state={model.mobileLocalLightState} /></dd></div>
                <div><dt>Native evidence</dt><dd>{model.mobileLocalLightReason}</dd></div>
              </dl>
            </aside>
          </div>
        </>
      ) : null}
    </section>
  )
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
    providerModel(provider, candidates.get(provider.provider_id), input.catalog!.selected_provider_id)
  )
  const loadState = input.loadState ?? (providers.length > 0 ? 'ready' : 'empty')
  return {
    loadState,
    generatedAt: input.catalog.generated_at,
    selectedProviderId: input.catalog.selected_provider_id,
    providerCount: providers.length,
    availableCount: providers.filter((provider) => provider.canSelect).length,
    remoteCount: providers.filter((provider) => provider.providerType !== 'local').length,
    mobileLocalLightState: mobile.state,
    mobileLocalLightReason: mobile.reason,
    secretsRedacted: input.catalog.secrets_redacted,
    error: null,
    providers
  }
}

function ModelProviderCard({ provider }: { provider: ModelProviderViewModel }) {
  const Icon = provider.providerType.includes('mobile') ? Smartphone : Cpu
  return (
    <article className={`aui-model-card aui-model-card-${provider.availability}`}>
      <header>
        <span className="aui-model-icon"><Icon size={18} aria-hidden="true" /></span>
        <div>
          <h2>{provider.name}</h2>
          <code>{provider.id}</code>
        </div>
        <StatusBadge state={provider.availability} />
      </header>
      <dl className="aui-model-meta">
        <div><dt>Route</dt><dd>{provider.routeLabel}</dd></div>
        <div><dt>Health</dt><dd>{provider.health} · {provider.healthReason}</dd></div>
        <div><dt>Hardware</dt><dd>{provider.hardware}</dd></div>
        <div><dt>Benchmark</dt><dd>{provider.benchmark}</dd></div>
        <div><dt>Files</dt><dd>{provider.files}</dd></div>
        <div><dt>Privacy</dt><dd><PrivacyBadge privacy={provider.privacyClass} /></dd></div>
      </dl>
      <div className="aui-model-capabilities" aria-label={`${provider.name} capabilities`}>
        {provider.capabilities.map((capability) => <EvidenceBadge key={capability} label={capability} />)}
      </div>
      <div className="aui-model-actions">
        <ModelAction icon="route" label={provider.selected ? 'Selected' : 'Select'} enabled={provider.canSelect && !provider.selected} reason={provider.selectReason} />
        <ModelAction icon="download" label="Import" enabled={provider.canImport} reason={provider.importReason} />
        <ModelAction icon="download" label="Download" enabled={provider.canDownload} reason={provider.downloadReason} />
        <ModelAction icon="benchmark" label="Benchmark" enabled={provider.canBenchmark} reason={provider.benchmarkReason} />
      </div>
      {provider.blockers.length > 0 ? (
        <ul className="aui-model-blockers">
          {provider.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
        </ul>
      ) : null}
    </article>
  )
}

function ModelProviderTable({ providers }: { providers: ModelProviderViewModel[] }) {
  return (
    <div className="aui-model-table-wrap">
      <table className="aui-model-table">
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">State</th>
            <th scope="col">Route/privacy</th>
            <th scope="col">Hardware</th>
            <th scope="col">Benchmark</th>
            <th scope="col">Operation</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => (
            <tr key={provider.id}>
              <th scope="row"><span>{provider.name}</span><code>{provider.id}</code></th>
              <td><StatusBadge state={provider.availability} /></td>
              <td>{provider.routeLabel}<br /><PrivacyBadge privacy={provider.privacyClass} /></td>
              <td>{provider.hardware}</td>
              <td>{provider.benchmark}</td>
              <td>{provider.operationStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ModelAction({ icon, label, enabled, reason }: { icon: 'route' | 'download' | 'benchmark'; label: string; enabled: boolean; reason: string }) {
  const Icon = icon === 'route' ? Route : icon === 'benchmark' ? Gauge : Download
  return (
    <button type="button" disabled={!enabled} title={reason} aria-label={`${label}: ${reason}`}>
      <Icon size={15} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

function ModelNotice({ icon, message, role = 'status' }: { icon: 'loading' | 'error' | 'empty'; message: string; role?: 'status' | 'alert' }) {
  const Icon = icon === 'loading' ? RefreshCcw : icon === 'empty' ? HardDrive : Route
  return (
    <p className={`aui-model-notice ${icon}`} role={role}>
      <Icon size={16} aria-hidden="true" />
      <span>{message}</span>
    </p>
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

function providerModel(
  provider: ModelRuntimeProviderInfo,
  candidate: CapabilityProviderCandidate | undefined,
  selectedProviderId: string | null
): ModelProviderViewModel {
  const availability = availabilityForProvider(provider, candidate)
  const privacyClass = candidate?.privacyClass ?? privacyForProvider(provider)
  const blockers = sortedUnique([
    ...(candidate?.disabledReasons ?? []),
    ...(!provider.enabled ? [provider.health_reason ?? 'provider disabled by backend catalog'] : []),
    ...(!provider.secrets_redacted ? ['secrets_redacted_false'] : [])
  ])
  const importActive = provider.import_progress.status !== 'idle'
  const downloadActive = provider.download_progress.status !== 'idle'
  return {
    id: provider.provider_id,
    name: provider.display_name,
    selected: provider.selected || provider.provider_id === selectedProviderId,
    availability,
    privacyClass,
    providerType: provider.provider_type,
    backendKind: provider.backend_kind,
    routeLabel: routeLabel(provider, candidate),
    health: provider.health,
    healthReason: provider.health_reason ?? 'backend catalog did not provide a health reason',
    hardware: hardwareLabel(provider.hardware),
    benchmark: benchmarkLabel(provider),
    files: filesLabel(provider),
    capabilities: provider.capabilities.length > 0 ? provider.capabilities : ['catalog-only'],
    blockers,
    operationStatus: [provider.import_progress, provider.download_progress]
      .filter((progress) => progress.status !== 'idle')
      .map((progress) => `${progress.operation_type}:${progress.status} ${progress.progress_percent}%`)
      .join(', ') || 'no operation active',
    canSelect: ['available-local', 'available-remote', 'degraded'].includes(availability),
    selectReason: selectReason(availability, candidate),
    canImport: importActive,
    importReason: importActive ? provider.import_progress.message : 'AdminAction model import contract is not active.',
    canDownload: downloadActive,
    downloadReason: downloadActive ? provider.download_progress.message : 'AdminAction model download contract is not active.',
    canBenchmark: provider.benchmark.status === 'running',
    benchmarkReason: provider.benchmark.status === 'running'
      ? provider.benchmark.reason ?? 'Benchmark is running through backend operation state.'
      : 'Benchmark action stays disabled until backend operation evidence exists.'
  }
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
  if (candidate) return `${candidate.providerIdentity} / ${candidate.module}.${candidate.method}`
  if (provider.provider_type === 'local') return 'local / backend catalog'
  return `${provider.provider_type} / backend catalog`
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
  return benchmark.reason ? `${benchmark.status}: ${benchmark.reason}` : benchmark.status
}

function filesLabel(provider: ModelRuntimeProviderInfo): string {
  if (provider.model_files.length === 0) return 'no local files reported'
  return provider.model_files
    .map((file) => `${file.display_name}${file.exists === false ? ' missing' : ''}${file.path_redacted ? ' redacted' : ''}`)
    .join(', ')
}

function selectReason(availability: AvailabilityState, candidate: CapabilityProviderCandidate | undefined): string {
  if (availability === 'available-local') return 'Local provider is selectable from backend catalog evidence.'
  if (availability === 'available-remote') return 'Remote provider needs visible route/privacy context before selection.'
  if (availability === 'degraded') return 'Provider is partially usable with backend-reported limitations.'
  return candidate?.requiredAction ?? 'Provider is not selectable in the current backend state.'
}

function mobileLocalLight(
  nativeManifest: NativeCapabilityManifest | null,
  catalog: ModelRuntimeCatalogResponse
): { state: AvailabilityState; reason: string } {
  const provider = catalog.providers.find((item) => item.provider_type.includes('mobile') || item.provider_id.includes('mobile'))
  const manifestEnabled = Boolean(nativeManifest?.capabilities.mobileLocalLightRuntime)
  const permissionGranted = nativeManifest ? nativeManifest.permissions.mobileLocalLightRuntime !== false : false
  if (manifestEnabled && permissionGranted) return { state: 'available-local', reason: `native:${nativeManifest?.platform}` }
  if (provider?.health_reason) return { state: availabilityForProvider(provider, undefined), reason: provider.health_reason }
  return { state: 'unsupported', reason: 'Native mobile runtime provider proof is unavailable.' }
}

function sortedUnique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort()
}

function modelErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'AuroraClient model runtime request failed.'
}
