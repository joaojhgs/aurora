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
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'
import { PageHeader } from './state-surface'
import {
  AdminConfirmDialog,
  Card,
  Checkbox,
  DataTable,
  MetaGrid,
  StatStrip,
  type DataColumn
} from './primitives'

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
  selectConfigValue: string | null
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
  mobileLocalLightReason: 'Native manifest status is not loaded.',
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
  const [selectingProviderId, setSelectingProviderId] = useState<string | null>(null)
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null)
  const [pendingProvider, setPendingProvider] = useState<ModelProviderViewModel | null>(null)
  const [reason, setReason] = useState('')
  const [reauthConfirmed, setReauthConfirmed] = useState(false)

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

  async function confirmProviderSelection() {
    const provider = pendingProvider
    if (!provider?.canSelect || !provider.selectConfigValue || selectingProviderId) return
    setSelectingProviderId(provider.id)
    setSelectionMessage(null)
    try {
      const result = await client.config.applyChange({
        change: {
          key_path: 'services.orchestrator.llm.provider',
          value: provider.selectConfigValue
        },
        reason: reason.trim() || `Select model provider ${provider.name} from Aurora Models runtime`,
        reauthConfirmed
      })
      if (!result.data.success) throw new Error(result.data.error ?? 'Config.Set did not accept the provider selection')
      const nextCatalog = await client.models.listCatalog({ include_unavailable: true, include_operations: true })
      setCatalog(nextCatalog)
      setLoadState(nextCatalog.providers.length > 0 ? 'ready' : 'empty')
      setSelectionMessage(`Provider selection applied through Config.Set AdminAction. Audit receipt: ${result.confirmation.audit_receipt}`)
      setPendingProvider(null)
      setReason('')
      setReauthConfirmed(false)
    } catch (nextError) {
      setSelectionMessage(`Provider selection failed: ${modelErrorMessage(nextError)}`)
    } finally {
      setSelectingProviderId(null)
    }
  }

  function requestProviderSelection(provider: ModelProviderViewModel) {
    if (!provider.canSelect || provider.selected || selectingProviderId) return
    setReason(`Select model provider ${provider.name} from Aurora Models runtime`)
    setReauthConfirmed(false)
    setPendingProvider(provider)
  }

  return (
    <div className="aui-models" data-state={model.loadState}>
      <PageHeader
        id="aui-models-title"
        eyebrow="Models"
        title="Models and runtime"
        description="Provider health, route, privacy, hardware, and benchmark states are loaded through Aurora."
        badges={
          <>
            <EvidenceBadge label={`${model.providerCount} providers`} />
            <EvidenceBadge label={model.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
          </>
        }
      />

      <StatStrip
        ariaLabel="Model catalog summary"
        items={[
          { label: 'Providers', value: String(model.providerCount) },
          { label: 'Routeable', value: `${model.availableCount} routeable` },
          { label: 'Remote', value: `${model.remoteCount} remote` },
          { label: 'Updated', value: model.generatedAt ?? 'pending' }
        ]}
      />

      {model.loadState === 'loading' ? (
        <ModelNotice icon="loading" message="Loading model runtime catalog from Aurora." />
      ) : null}
      {model.loadState === 'error' ? (
        <ModelNotice icon="error" message={model.error ?? 'Model runtime catalog could not be loaded.'} role="alert" />
      ) : null}
      {model.loadState === 'empty' ? (
        <ModelNotice icon="empty" message="No model runtime providers were returned by the backend catalog." />
      ) : null}
      {selectionMessage ? (
        <p className="aui-model-notice" role={selectionMessage.startsWith('Provider selection failed') ? 'alert' : 'status'}>
          <Route size={16} aria-hidden="true" />
          <span>{selectionMessage}</span>
        </p>
      ) : null}

      {model.providers.length > 0 ? (
        <>
          <ModelRoutePolicyBanner providers={model.providers} selectedProviderId={model.selectedProviderId} />
          <Card title="Model runtime categories" icon={<HardDrive size={18} aria-hidden="true" />}>
            <ModelRuntimeCategories rows={model.categoryRows} />
          </Card>
          <div className="aui-model-grid">
            {model.providers.map((provider) => (
              <ModelProviderCard
                key={provider.id}
                provider={provider}
                selecting={selectingProviderId === provider.id}
                onSelect={requestProviderSelection}
              />
            ))}
          </div>
          <Card title="Provider route policy" icon={<Route size={18} aria-hidden="true" />}>
            <ModelRoutePolicyPanel providers={model.providers} />
          </Card>
          <div className="aui-model-layout">
            <Card title="Runtime providers" flush>
              <ModelProviderTable providers={model.providers} />
            </Card>
            <aside className="aui-model-summary" aria-label="Runtime summary">
              <Card title="Runtime state">
                <MetaGrid
                  items={[
                    { label: 'Updated', value: model.generatedAt ?? 'pending' },
                    { label: 'Selected provider', value: model.selectedProviderId ?? 'not selected' },
                    { label: 'Mobile local-light', value: <StatusBadge state={model.mobileLocalLightState} /> },
                    { label: 'Native state', value: model.mobileLocalLightReason }
                  ]}
                />
                <ModelBenchmarkSnapshot rows={model.benchmarkRows} />
                <ModelSetupActions providers={model.providers} />
                <ModelWarnings warnings={model.warnings} />
              </Card>
            </aside>
          </div>
        </>
      ) : null}

      {pendingProvider ? (
        <AdminConfirmDialog
          open
          title={`Select ${pendingProvider.name}`}
          description={`Apply ${pendingProvider.selectConfigValue ?? 'provider'} through Config.Set AdminAction.`}
          methodId="Config.Set"
          severity="standard"
          affected={[pendingProvider.id]}
          requireReason
          reasonValue={reason}
          onReasonChange={setReason}
          confirmLabel={`Select ${pendingProvider.name}`}
          onConfirm={() => { void confirmProviderSelection() }}
          onCancel={() => {
            setPendingProvider(null)
            setReason('')
            setReauthConfirmed(false)
          }}
          busy={selectingProviderId === pendingProvider.id}
          extraValid={reauthConfirmed}
          extraInvalidReason="Confirm AdminAction reauthentication before selecting a model provider."
        >
          <Checkbox
            checked={reauthConfirmed}
            onChange={setReauthConfirmed}
            label="I confirm recent AdminAction reauthentication for model provider changes."
          />
        </AdminConfirmDialog>
      ) : null}
    </div>
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

function ModelProviderCard({
  provider,
  selecting = false,
  onSelect
}: {
  provider: ModelProviderViewModel
  selecting?: boolean
  onSelect?: (provider: ModelProviderViewModel) => void
}) {
  const Icon = provider.providerType.includes('mobile') ? Smartphone : Cpu
  const selectLabel = provider.selected ? 'Selected' : selecting ? `Selecting ${provider.name}` : `Select ${provider.name}`
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
        <ModelAction
          icon="route"
          label={selectLabel}
          enabled={provider.canSelect && !provider.selected && !selecting}
          reason={provider.selectReason}
          onClick={provider.canSelect && onSelect ? () => { onSelect(provider) } : undefined}
        />
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
            ? `${selected.name} is the selected provider; local executable provider changes use Config.Set through AdminAction.`
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
    <dl className="aui-model-categories-list" aria-label="Model runtime categories">
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
  )
}

function ModelRoutePolicyPanel({ providers }: { providers: ModelProviderViewModel[] }) {
  return (
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
          <MetaGrid
            items={[
              { label: 'Route', value: provider.routeLabel },
              { label: 'Privacy', value: <PrivacyBadge privacy={provider.privacyClass} /> },
              { label: 'Selectable', value: provider.canSelect ? `yes; writes ${provider.selectConfigValue ?? 'unknown'} through Config.Set AdminAction` : provider.selectReason },
              { label: 'Blockers', value: presentableSignal(provider.blockers.length > 0 ? provider.blockers.join(', ') : 'none reported') }
            ]}
          />
        </article>
      ))}
    </div>
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
        Provider selection confirmation: {selected ? `${selected.name} is selected by backend catalog status.` : 'no provider selected by backend catalog status.'}
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
  const columns: DataColumn<ModelProviderViewModel>[] = [
    {
      key: 'provider',
      header: 'Provider',
      render: (provider) => (
        <div>
          <span>{provider.name}</span>
          <code>{provider.id}</code>
        </div>
      )
    },
    {
      key: 'state',
      header: 'State',
      render: (provider) => <StatusBadge state={provider.availability} />
    },
    {
      key: 'route',
      header: 'Route/privacy',
      render: (provider) => (
        <div>
          {provider.routeLabel}
          <PrivacyBadge privacy={provider.privacyClass} />
        </div>
      )
    },
    {
      key: 'hardware',
      header: 'Hardware',
      hideAt: 'lg',
      render: (provider) => provider.hardware
    },
    {
      key: 'benchmark',
      header: 'Benchmark',
      hideAt: 'lg',
      render: (provider) => provider.benchmark
    },
    {
      key: 'latency',
      header: 'Latency/context',
      hideAt: 'md',
      render: (provider) => provider.latencyContext
    },
    {
      key: 'operation',
      header: 'Operation',
      render: (provider) => provider.operationStatus
    }
  ]

  return (
    <DataTable
      columns={columns}
      rows={providers}
      getRowKey={(provider) => provider.id}
    />
  )
}

function ModelAction({
  icon,
  label,
  enabled,
  reason,
  onClick
}: {
  icon: 'route' | 'download' | 'benchmark'
  label: string
  enabled: boolean
  reason: string
  onClick?: (() => void) | undefined
}) {
  const Icon = icon === 'route' ? Route : icon === 'benchmark' ? Gauge : Download
  return (
    <button type="button" disabled={!enabled} title={reason} aria-label={`${label}: ${reason}`} onClick={onClick}>
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
    canSelect: canSelectProvider(provider, candidate, availability, provider.provider_id === selectedProviderId || provider.selected, blockers),
    selectReason: selectReason(provider.provider_id === selectedProviderId || provider.selected, provider, candidate, availability),
    selectConfigValue: modelProviderConfigValue(provider),
    canImport: importActive,
    importReason: importActive ? provider.import_progress.message : 'AdminAction model import contract is not active.',
    canDownload: downloadActive,
    downloadReason: downloadActive ? provider.download_progress.message : 'AdminAction model download contract is not active.',
    canBenchmark: provider.benchmark.status === 'running',
    benchmarkReason: provider.benchmark.status === 'running'
      ? provider.benchmark.reason ?? 'Benchmark is running through backend operation state.'
      : 'Benchmark action stays disabled until backend operation status exists.'
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
      ? 'routeable from catalog status'
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
      detail: completed.length > 0 ? completed.map((provider) => provider.name).join(', ') : 'No completed benchmark status was returned by the backend catalog.',
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
      detail: unavailable.length > 0 ? unavailable.map((provider) => provider.name).join(', ') : 'All providers have benchmark status.',
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
      value: `${benchmarkable.length} with benchmark status`,
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

function selectReason(
  selected: boolean,
  provider: ModelRuntimeProviderInfo,
  candidate: CapabilityProviderCandidate | undefined,
  availability: AvailabilityState
): string {
  if (selected) return 'Selected provider is reported by backend catalog status.'
  if (provider.provider_type !== 'local') return 'Only local executable providers can be selected from this cockpit; remote/cloud/native providers require their own policy flow.'
  const configValue = modelProviderConfigValue(provider)
  if (!configValue) return 'Backend provider is not mapped to services.orchestrator.llm.provider; selection stays disabled with repair required.'
  if (!provider.enabled) return provider.health_reason ?? 'Backend catalog reports this provider disabled.'
  if (!['available-local', 'degraded'].includes(availability)) return `Local provider is ${availability}; capability catalog must report executable local status before selection.`
  if (candidate && !candidate.selectable) return 'Capability catalog marks this local provider as not selectable.'
  if (candidate && candidate.providerKind !== 'local') return 'Capability catalog did not report this provider as a local executable provider.'
  return `Selectable local provider; choosing it writes ${configValue} to services.orchestrator.llm.provider through Config.Set AdminAction.`
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
  return 'Aurora model runtime request failed.'
}
