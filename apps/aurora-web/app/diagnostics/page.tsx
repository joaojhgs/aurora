import type {
  AvailabilityState,
  CapabilityCatalogResponse,
  DeploymentTopologyResponse,
  GetServicesResponse,
  RouteExplainResponse,
  WebRTCDiagnosticsResponse
} from '@aurora/client'
import { MeshDiagnosticsView, meshDiagnosticsSnapshotFromResults } from '@aurora/ui'
import { createAuroraWebClient } from '../aurora-client'
import {
  countText,
  productAvailabilityText,
  productErrorState,
  productErrorText,
  productQueueStatusState,
  productQueueStatusText,
  yesNo
} from '../product-copy'
import { getShellSnapshot } from '../shell-state'
import { DiagnosticsExportIsland } from './diagnostics-export-island'

interface DiagnosticResult<T> {
  data: T | null
  error: string | null
  errorState: AvailabilityState
}

interface ProbeRow {
  name: string
  state: AvailabilityState
  summary: string
  details: string
}

const redactionPreview = [
  { label: 'Tokens and credentials', source: 'Removed from the bundle before sharing.' },
  { label: 'Device secrets and approval codes', source: 'Hidden before the bundle is prepared.' },
  { label: 'Addresses, file locations, and model locations', source: 'Shown only as safe summaries.' },
  { label: 'Tool inputs and memory content', source: 'Summarized without sensitive detail.' },
  { label: 'Audio and session details', source: 'Kept out of the shared bundle.' }
]

export default async function Page() {
  const client = createAuroraWebClient()
  const [shell, services, topology, webrtc, mesh, catalog, route] = await Promise.all([
    getShellSnapshot(),
    capture(() => client.registry.listServices()),
    capture(() => client.registry.getDeploymentTopology()),
    capture(() => client.registry.getWebRTCDiagnostics()),
    captureResult(() => client.mesh.getStatus()),
    capture(() => client.capabilities.listCatalog({ include_unavailable: true, include_internal: true })),
    capture(() => client.routes.explain({
      topic: 'Tooling.ExecuteTool',
      include_candidates: true
    }))
  ])

  const probes = buildProbes({ services, topology, webrtc, catalog, route })
  const correlationId = route.data?.blockers.find((blocker) => blocker.security_privacy)?.code ?? null
  const unavailable = probes.filter((probe) => probe.state !== 'available-local' && probe.state !== 'available-remote')
  const exportDisabled = services.error !== null || topology.error !== null || catalog.error !== null
  const diagnosticsRoute = shell.routes.find((candidate) => candidate.item.id === 'diagnostics') ?? shell.routes[0]!
  const meshDiagnostics = meshDiagnosticsSnapshotFromResults({ route: diagnosticsRoute, webrtc, mesh, catalog })

  return (
    <div className="aw-page-stack adx-page">
      <section className="aw-panel adx-hero" aria-labelledby="diagnostics-title">
        <div>
          <p className="adx-kicker">ADM-009</p>
          <h1 id="diagnostics-title">Diagnostics</h1>
          <p>
            Aurora checks service health, trusted devices, privacy protection, and support export readiness.
            Sensitive details stay hidden before anything is shared.
          </p>
        </div>
        <dl className="adx-metrics">
          <Metric label="services" value={services.data?.services.length ?? 0} />
          <Metric label="trusted devices" value={webrtc.data?.connected_peer_count ?? 0} />
          <Metric label="blocked actions" value={blockedActions(catalog.data)} />
          <Metric label="needs attention" value={unavailable.length} />
        </dl>
      </section>

      <div className="aw-page-grid">
        <section className="aw-panel" aria-labelledby="diagnostics-probes-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-probes-title">Health Checks</h2>
              <p>Each row shows what Aurora can read now and what may need attention.</p>
            </div>
          </div>
          <div className="adx-table" role="table" aria-label="Health checks">
            <div className="adx-table-head" role="row">
              <span role="columnheader">Check</span>
              <span role="columnheader">State</span>
              <span role="columnheader">Summary</span>
            </div>
            {probes.map((probe) => (
              <div className="adx-table-row" role="row" key={probe.name}>
                <span role="cell">
                  <strong>{probe.name}</strong>
                  <small>{probe.details}</small>
                </span>
                <span role="cell"><StateBadge state={probe.state} /></span>
                <span role="cell">{probe.summary}</span>
              </div>
            ))}
          </div>
          <ErrorList results={[services, topology, webrtc, catalog, route]} />
        </section>

        <section className="aw-panel" aria-labelledby="diagnostics-redaction-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-redaction-title">Redaction Preview</h2>
              <p>Preview lists sensitive details Aurora removes or summarizes before support sharing.</p>
            </div>
            <span className="adx-badge">secrets redacted</span>
          </div>
          <ul className="adx-redaction-list">
            {redactionPreview.map((item) => (
              <li key={item.label}>
                <strong>{item.label}</strong>
                <span>{item.source}</span>
              </li>
            ))}
          </ul>
          <dl className="aw-facts adx-redaction-facts">
            <div>
              <dt>Feature list</dt>
              <dd>{catalog.data?.secrets_redacted ? 'Sensitive details removed' : redactionGap(catalog.error)}</dd>
            </div>
            <div>
              <dt>Trusted devices</dt>
              <dd>{webrtc.data?.secrets_redacted ? 'Sensitive details removed' : redactionGap(webrtc.error)}</dd>
            </div>
            <div>
              <dt>Service layout</dt>
              <dd>{topology.data?.secrets_redacted ? 'Sensitive details removed' : redactionGap(topology.error)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="aw-page-grid">
        <section className="aw-panel" aria-labelledby="diagnostics-availability-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-availability-title">Availability Summary</h2>
              <p>Unavailable features stay visible with clear next steps.</p>
            </div>
          </div>
          <dl className="aw-facts">
            <div>
              <dt>Bus</dt>
              <dd>{topology.data ? productQueueStatusText(topology.data.bullmq_queue_health.status) : unavailableText(topology.error)}</dd>
            </div>
            <div>
              <dt>Service Layout</dt>
              <dd>{topology.data ? 'Readable' : 'Unknown'}</dd>
            </div>
            <div>
              <dt>Available Features</dt>
              <dd>{catalog.data ? `${countText(catalog.data.providers.length, 'source')}, ${countText(catalog.data.actions.length, 'action')}` : unavailableText(catalog.error)}</dd>
            </div>
            <div>
              <dt>Needs Attention</dt>
              <dd>{topology.data?.mode_capability_degradations.length ? countText(topology.data.mode_capability_degradations.length, 'item') : 'No issues reported'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <MeshDiagnosticsView snapshot={meshDiagnostics} route={diagnosticsRoute} />

      <DiagnosticsExportIsland
        correlationId={correlationId}
        disabled={exportDisabled}
        disabledReason="Support export is unavailable until Aurora can read service health and feature availability."
      />
    </div>
  )
}

async function capture<T>(operation: () => Promise<T>): Promise<DiagnosticResult<T>> {
  try {
    return { data: await operation(), error: null, errorState: 'available-local' }
  } catch (error) {
    return { data: null, error: productErrorText(error), errorState: productErrorState(error) }
  }
}

async function captureResult<T>(operation: () => Promise<{ ok: true; data: T } | { ok: false; error: Error }>): Promise<DiagnosticResult<T>> {
  try {
    const result = await operation()
    if (result.ok) return { data: result.data, error: null, errorState: 'available-local' }
    return { data: null, error: productErrorText(result.error), errorState: productErrorState(result.error) }
  } catch (error) {
    return { data: null, error: productErrorText(error), errorState: productErrorState(error) }
  }
}

function buildProbes(input: {
  services: DiagnosticResult<GetServicesResponse>
  topology: DiagnosticResult<DeploymentTopologyResponse>
  webrtc: DiagnosticResult<WebRTCDiagnosticsResponse>
  catalog: DiagnosticResult<CapabilityCatalogResponse>
  route: DiagnosticResult<RouteExplainResponse>
}): ProbeRow[] {
  const availableFeatures = input.catalog

  return [
    {
      name: 'Service List',
      state: input.services.data?.services.length ? 'available-local' : stateFromResult(input.services),
      summary: input.services.data ? countText(input.services.data.services.length, 'service') : unavailableText(input.services.error),
      details: 'Aurora service health'
    },
    {
      name: 'Service Health',
      state: input.topology.data ? productQueueStatusState(input.topology.data.bullmq_queue_health.status) : stateFromResult(input.topology, 'degraded'),
      summary: input.topology.data ? productQueueStatusText(input.topology.data.bullmq_queue_health.status) : unavailableText(input.topology.error),
      details: 'App services and shared work queue'
    },
    {
      name: 'Available Features',
      state: availableFeatures.data?.actions.length ? 'available-local' : stateFromResult(availableFeatures),
      summary: availableFeatures.data ? `${countText(availableFeatures.data.actions.length, 'action')}; sensitive details removed: ${yesNo(availableFeatures.data.secrets_redacted)}` : unavailableText(availableFeatures.error),
      details: 'Feature and action readiness'
    },
    {
      name: 'Device Routing',
      state: input.route.data?.blockers.length ? 'privacy-blocked' : stateFromResult(input.route, 'available-remote'),
      summary: input.route.data ? input.route.data.blockers.length ? `${countText(input.route.data.blockers.length, 'item')} needs attention` : 'Ready' : unavailableText(input.route.error),
      details: 'Device selection and safety checks'
    },
    {
      name: 'Device Connection',
      state: input.webrtc.data?.started ? 'available-remote' : stateFromResult(input.webrtc, 'unsupported'),
      summary: input.webrtc.data
        ? trustedDeviceSummary(input.webrtc.data.connected_peer_count, input.webrtc.data.app_layer_e2ee_enabled)
        : unavailableText(input.webrtc.error),
      details: 'Trusted device connection health'
    }
  ]
}

function trustedDeviceSummary(connectedCount: number, privateConnection: boolean): string {
  return `${countText(connectedCount, 'trusted device')}; private connection: ${yesNo(privateConnection)}`
}

function blockedActions(catalog: CapabilityCatalogResponse | null): number {
  return catalog?.actions.filter((action) => action.bindability !== 'available').length ?? 0
}

function stateFromResult<T>(result: DiagnosticResult<T>, fallback: AvailabilityState = 'unsupported'): AvailabilityState {
  return result.error ? result.errorState : fallback
}

function unavailableText(error: string | null): string {
  return error ? productErrorText(error) : 'Unavailable'
}

function redactionGap(error: string | null): string {
  return error ? productErrorText(error, 'Sensitive-detail status is unavailable. Try again.') : 'Sensitive-detail status unavailable'
}

function StateBadge({ state }: { state: AvailabilityState }) {
  return <span className={`adx-badge adx-state-${state}`}>{productAvailabilityText(state)}</span>
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function ErrorList({ results }: { results: Array<DiagnosticResult<unknown>> }) {
  const errors = results.flatMap((result) => result.error ? [result.error] : [])
  if (!errors.length) return null
  return (
    <div className="adx-error-list" role="status">
      <strong>Degraded inputs</strong>
      <ul>
        {errors.map((error) => <li key={error}>{error}</li>)}
      </ul>
    </div>
  )
}
