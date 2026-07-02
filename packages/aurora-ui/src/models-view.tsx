'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Cpu, Download, Gauge, HardDrive, RefreshCcw, Route, Smartphone } from 'lucide-react'
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
  canImport: boolean
  importReason: string
  canDownload: boolean
  downloadReason: string
  canBenchmark: boolean
  benchmarkReason: string
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
  categoryRows: ModelRuntimeCategoryRow[]
  benchmarkRows: ModelBenchmarkSnapshotRow[]
  warnings: string[]
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
  providers: [],
  categoryRows: [],
  benchmarkRows: [],
  warnings: []
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
          <EvidenceBadge label={`${model.availableCount} routeable`} />
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
          <ModelRoutePolicyBanner providers={model.providers} selectedProviderId={model.selectedProviderId} />
          <ModelRuntimeCategories rows={model.categoryRows} />
          <div className="aui-model-grid">
            {model.providers.map((provider) => (
              <ModelProviderCard key={provider.id} provider={provider} />
            ))}
          </div>
          <ModelRoutePolicyPanel providers={model.providers} />
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
              <ModelBenchmarkSnapshot rows={model.benchmarkRows} />
              <ModelSetupActions providers={model.providers} />
              <ModelWarnings warnings={model.warnings} />
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
    providerModel(provider, candidates.get(provider.provider_id), input.catalog!.selected_provider_id, input.nativeManifest)
  )
  const loadState = input.loadState ?? (providers.length > 0 ? 'ready' : 'empty')
  return {
    loadState,
    generatedAt: input.catalog.generated_at,
    selectedProviderId: input.catalog.selected_provider_id,
    providerCount: providers.length,
    availableCount: providers.filter(providerRouteable).length,
    remoteCount: providers.filter(isMeshOrRemoteProvider).length,
    mobileLocalLightState: mobile.state,
    mobileLocalLightReason: mobile.reason,
    secretsRedacted: input.catalog.secrets_redacted,
    error: null,
    providers,
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
        <div><dt>Route quality</dt><dd>{provider.routeQuality}</dd></div>
        <div><dt>Health</dt><dd>{provider.health} · {provider.healthReason}</dd></div>
        <div><dt>Latency/context</dt><dd>{provider.latencyContext}</dd></div>
        <div><dt>Hardware</dt><dd>{provider.hardware}</dd></div>
        <div><dt>Benchmark</dt><dd>{provider.benchmark}</dd></div>
        <div><dt>Files</dt><dd>{provider.files}</dd></div>
        <div><dt>Model</dt><dd>{provider.modelIdentity}</dd></div>
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

function ModelRoutePolicyBanner({
  providers,
  selectedProviderId
}: {
  providers: ModelProviderViewModel[]
  selectedProviderId: string | null
}) {
  const selected = providers.find((provider) => provider.selected)
  const routeable = providers.filter(providerRouteable)
  return (
    <section className="aui-model-policy-banner" aria-labelledby="model-current-route-policy-title">
      <div>
        <p className="aui-kicker">Current route policy banner</p>
        <h2 id="model-current-route-policy-title">Current route policy</h2>
        <p>
          {selected
            ? `${selected.name} is the selected provider; selection changes remain disabled until a backend/AdminAction selection contract is available.`
            : selectedProviderId
              ? `Backend selected provider ${selectedProviderId}, but it was not returned in the current catalog.`
              : 'No provider is currently selected; Assistant will keep model repair guidance visible.'}
        </p>
      </div>
      <div className="aui-model-policy-banner-actions">
        <EvidenceBadge label={`${routeable.length} routeable providers`} />
        <EvidenceBadge label={`${providers.filter((provider) => provider.canBenchmark).length} benchmark operations`} />
        <a href="/" className="aui-model-repair-link">No model configured assistant repair link</a>
      </div>
    </section>
  )
}

function ModelRuntimeCategories({ rows }: { rows: ModelRuntimeCategoryRow[] }) {
  return (
    <section className="aui-model-categories" aria-labelledby="model-categories-title">
      <div className="aui-model-panel-title">
        <span><HardDrive size={18} aria-hidden="true" /></span>
        <div>
          <h2 id="model-categories-title">Model runtime categories</h2>
          <p>Provider inventory separates selection, configured backends, local files, operations, benchmarks, mesh routes, and mobile-native proof.</p>
        </div>
      </div>
      <dl>
        {rows.map((row) => (
          <div key={row.id}>
            <dt>{row.label}</dt>
            <dd>
              <StatusBadge state={row.state} />
              <strong>{row.value}</strong>
              <small>{row.detail}</small>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function ModelRoutePolicyPanel({ providers }: { providers: ModelProviderViewModel[] }) {
  return (
    <section className="aui-model-route-policy" aria-labelledby="model-route-policy-title">
      <div className="aui-model-panel-title">
        <span><Route size={18} aria-hidden="true" /></span>
        <div>
          <h2 id="model-route-policy-title">Provider route policy</h2>
          <p>Route, privacy, and blocker state is read from the capability graph and runtime catalog; selector-only policy is not treated as a hard blocker.</p>
        </div>
      </div>
      <div className="aui-model-route-grid">
        {providers.map((provider) => (
          <article className="aui-model-route-card" key={provider.id}>
            <header>
              <div>
                <p className="aui-kicker">{provider.providerType} provider</p>
                <h3>{provider.name}</h3>
              </div>
              <StatusBadge state={provider.availability} />
            </header>
            <dl className="aui-model-meta">
              <div><dt>Route</dt><dd>{provider.routeLabel}</dd></div>
              <div><dt>Privacy</dt><dd><PrivacyBadge privacy={provider.privacyClass} /></dd></div>
              <div><dt>Selectable</dt><dd>{provider.canSelect ? 'yes' : provider.selectReason}</dd></div>
              <div><dt>Blockers</dt><dd>{provider.blockers.length > 0 ? provider.blockers.join(', ') : 'none reported'}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  )
}

function ModelBenchmarkSnapshot({ rows }: { rows: ModelBenchmarkSnapshotRow[] }) {
  return (
    <section className="aui-model-benchmark" aria-labelledby="model-benchmark-title">
      <div className="aui-model-panel-title compact">
        <span><Gauge size={16} aria-hidden="true" /></span>
        <div>
          <h2 id="model-benchmark-title">Benchmark snapshot</h2>
          <p>Only backend-reported benchmark facts are shown; missing measurements stay explicit.</p>
        </div>
      </div>
      <table className="aui-model-benchmark-table">
        <caption>Benchmark snapshot table</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">State</th>
            <th scope="col">Value</th>
            <th scope="col">Backend detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td><StatusBadge state={row.state} /></td>
              <td>{row.value}</td>
              <td>{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function ModelSetupActions({ providers }: { providers: ModelProviderViewModel[] }) {
  const selected = providers.find((provider) => provider.selected)
  const importProvider = providers.find((provider) => provider.canImport) ?? selected ?? providers[0]
  const downloadProvider = providers.find((provider) => provider.canDownload) ?? selected ?? providers[0]
  return (
    <section className="aui-model-setup" aria-labelledby="model-setup-title">
      <div className="aui-model-panel-title compact">
        <span><Download size={16} aria-hidden="true" /></span>
        <div>
          <h2 id="model-setup-title">Model path/import/download setup CTA</h2>
          <p>Setup actions are visible, but mutating operations stay disabled without backend AdminAction contracts.</p>
        </div>
      </div>
      <div className="aui-model-setup-actions">
        <ModelAction icon="download" label="Set model path" enabled={false} reason={selected ? `Provider selection confirmation: ${selected.name} is selected; configure paths through backend AdminAction when exposed.` : 'No model configured; open Assistant repair link first.'} />
        <ModelAction icon="download" label="Import model" enabled={Boolean(importProvider?.canImport)} reason={importProvider?.importReason ?? 'No provider available for model import.'} />
        <ModelAction icon="download" label="Download model" enabled={Boolean(downloadProvider?.canDownload)} reason={downloadProvider?.downloadReason ?? 'No provider available for model download.'} />
      </div>
      <p className="aui-model-selection-confirmation">
        Provider selection confirmation: {selected ? `${selected.name} is selected by backend catalog evidence.` : 'no provider selected by backend catalog evidence.'}
      </p>
      <a href="/" className="aui-model-repair-link">Open Assistant model repair</a>
    </section>
  )
}

function ModelWarnings({ warnings }: { warnings: string[] }) {
  return warnings.length === 0 ? null : (
    <section className="aui-model-warnings" aria-labelledby="model-warning-title">
      <div className="aui-model-panel-title compact">
        <span><AlertTriangle size={16} aria-hidden="true" /></span>
        <div>
          <h2 id="model-warning-title">Runtime warnings</h2>
          <p>Capabilities are disabled or degraded until backend/native proof allows them.</p>
        </div>
      </div>
      <ul>
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </section>
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
            <th scope="col">Latency/context</th>
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
              <td>{provider.latencyContext}</td>
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
  selectedProviderId: string | null,
  nativeManifest: NativeCapabilityManifest | null
): ModelProviderViewModel {
  const nativeLocalLight = nativeLocalLightForProvider(provider, nativeManifest)
  const availability = nativeLocalLight?.state ?? availabilityForProvider(provider, candidate)
  const privacyClass = candidate?.privacyClass ?? privacyForProvider(provider)
  const blockers = sortedUnique([
    ...(candidate?.disabledReasons ?? []),
    nativeLocalLight?.reason,
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
    routeLabel: nativeLocalLight?.routeLabel ?? routeLabel(provider, candidate),
    routeQuality: routeQualityLabel(provider, availability, candidate),
    health: provider.health,
    healthReason: provider.health_reason ?? 'backend catalog did not provide a health reason',
    latencyContext: latencyContextLabel(provider),
    hardware: hardwareLabel(provider.hardware),
    benchmark: benchmarkLabel(provider),
    files: filesLabel(provider),
    modelIdentity: modelIdentityLabel(provider),
    capabilities: provider.capabilities.length > 0 ? provider.capabilities : ['catalog-only'],
    blockers,
    operationStatus: [provider.import_progress, provider.download_progress]
      .filter((progress) => progress.status !== 'idle')
      .map((progress) => `${progress.operation_type}:${progress.status} ${progress.progress_percent}%`)
      .join(', ') || 'no operation active',
    canSelect: false,
    selectReason: selectReason(provider.provider_id === selectedProviderId || provider.selected),
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
    ? `blocked by ${candidate.disabledReasons.join(', ')}`
    : provider.enabled
      ? 'routeable from catalog evidence'
      : 'disabled by backend catalog'
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
  return benchmark.reason ? `${benchmark.status}: ${benchmark.reason}` : benchmark.status
}

function latencyContextLabel(provider: ModelRuntimeProviderInfo): string {
  const latency = provider.benchmark.latency_ms === null ? 'latency not measured' : `${provider.benchmark.latency_ms} ms latency`
  const context = provider.context_window === null ? 'context unknown' : `${provider.context_window} token context`
  const limit = provider.generation_limit === null ? 'generation limit unknown' : `${provider.generation_limit} token generation limit`
  return `${latency}; ${context}; ${limit}`
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
      label: 'Measured providers',
      value: `${completed.length}/${providers.length}`,
      detail: completed.length > 0 ? completed.map((provider) => provider.name).join(', ') : 'No completed benchmark evidence was returned by the backend catalog.',
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
      detail: unavailable.length > 0 ? unavailable.map((provider) => provider.name).join(', ') : 'All providers have benchmark evidence.',
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
  const activeImportDownload = providers.filter((provider) => provider.canImport || provider.canDownload)
  const benchmarkable = providers.filter(hasBenchmarkEvidence)
  const meshRemote = providers.filter(isMeshOrRemoteProvider)

  return [
    {
      id: 'selected-provider',
      label: 'Currently selected provider',
      value: selected ? selected.name : 'not selected',
      detail: selected
        ? `${selected.id}; ${selected.selectReason}`
        : 'Backend catalog did not report a selected provider.',
      state: selected?.availability ?? 'pending'
    },
    {
      id: 'configured-providers',
      label: 'Configured providers',
      value: `${configured.length} configured`,
      detail: configured.length > 0
        ? configured.map((provider) => `${provider.name} (${provider.providerType})`).join(', ')
        : 'No providers were returned by the model runtime catalog.',
      state: configured.length > 0 ? 'available-local' : 'unsupported'
    },
    {
      id: 'installed-local-models',
      label: 'Installed local models',
      value: `${installedLocal.length} installed`,
      detail: installedLocal.length > 0
        ? installedLocal.map((provider) => `${provider.name}: ${provider.files}`).join(', ')
        : 'No installed local model files were reported by the backend catalog.',
      state: installedLocal.length > 0 ? 'available-local' : 'unsupported'
    },
    {
      id: 'downloadable-importable-models',
      label: 'Downloadable/importable models',
      value: `${activeImportDownload.length} active operations`,
      detail: activeImportDownload.length > 0
        ? activeImportDownload.map((provider) => `${provider.name}: ${provider.operationStatus}`).join(', ')
        : 'No import/download operation is active; AdminAction import and download contracts remain disabled.',
      state: activeImportDownload.length > 0 ? 'degraded' : 'pending'
    },
    {
      id: 'benchmarkable-providers',
      label: 'Benchmarkable providers',
      value: `${benchmarkable.length} with benchmark evidence`,
      detail: benchmarkable.length > 0
        ? benchmarkable.map((provider) => `${provider.name}: ${provider.benchmark}`).join(', ')
        : 'No benchmarkable providers or completed benchmark measurements were returned.',
      state: benchmarkable.length > 0 ? 'available-local' : 'pending'
    },
    {
      id: 'mesh-remote-providers',
      label: 'Mesh/remote providers',
      value: `${meshRemote.length} remote-capable`,
      detail: meshRemote.length > 0
        ? meshRemote.map((provider) => `${provider.name}: ${provider.routeLabel}`).join(', ')
        : 'No mesh, cloud, or remote provider routes were reported.',
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

function selectReason(selected: boolean): string {
  if (selected) return 'Selected provider is reported by backend catalog evidence.'
  return 'Backend model selection contract is not active; selection stays disabled until an SDK/AdminAction operation exists.'
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
      reason: `${status.evidenceSource}: ${status.reason}`
    }
  }
  const manifestEnabled = Boolean(nativeManifest?.capabilities['android.localLightInference.provider'])
  const permissionGranted = nativeManifest ? nativeManifest.permissions['aurora.android.localLightInference'] !== false : false
  if (manifestEnabled && permissionGranted) return { state: 'available-local', reason: `native:${nativeManifest?.platform}` }
  if (provider?.health_reason) return { state: availabilityForProvider(provider, undefined), reason: provider.health_reason }
  return { state: 'unsupported', reason: 'Native mobile runtime provider proof is unavailable.' }
}

function nativeLocalLightForProvider(
  provider: ModelRuntimeProviderInfo,
  nativeManifest: NativeCapabilityManifest | null
): { state: AvailabilityState; reason: string; routeLabel: string } | null {
  const status = nativeManifest?.localLightInference
  if (!status || provider.provider_id !== status.providerId) return null
  return {
    state: availabilityFromLocalLightStatus(status.state),
    reason: status.reason,
    routeLabel: `native:${status.platform} / ${status.providerId}`
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
  if (error instanceof Error && error.message) return error.message
  return 'AuroraClient model runtime request failed.'
}
