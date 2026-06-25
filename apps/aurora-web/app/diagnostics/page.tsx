import type {
  AvailabilityState,
  CapabilityCatalogResponse,
  DeploymentTopologyResponse,
  GetServicesResponse,
  RouteExplainResponse,
  WebRTCDiagnosticsResponse
} from '@aurora/client'
import { createAuroraWebClient } from '../aurora-client'
import { DiagnosticsExportControl } from './diagnostics-export-control'

interface DiagnosticResult<T> {
  data: T | null
  error: string | null
}

interface ProbeRow {
  name: string
  state: AvailabilityState
  evidence: string
  details: string
}

const redactionPreview = [
  { label: 'Tokens and credentials', source: 'Gateway support bundle redaction.omitted_payloads' },
  { label: 'Peer secrets and approval tokens', source: 'Gateway support bundle redacted_fields' },
  { label: 'Redis URLs, host paths, and model paths', source: 'diagnostic redacted config shape' },
  { label: 'Tool args and RAG content', source: 'event and audit payload summaries only' },
  { label: 'Audio/session metadata', source: 'omitted raw-audio payloads' }
]

export default async function Page() {
  const client = createAuroraWebClient()
  const [services, topology, webrtc, catalog, route] = await Promise.all([
    capture(() => client.registry.listServices()),
    capture(() => client.registry.getDeploymentTopology()),
    capture(() => client.registry.getWebRTCDiagnostics()),
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

  return (
    <div className="aw-page-stack adx-page">
      <section className="aw-panel adx-hero" aria-labelledby="diagnostics-title">
        <div>
          <p className="adx-kicker">ADM-009</p>
          <h1 id="diagnostics-title">Diagnostics</h1>
          <p>
            Gateway, service, native, sidecar, mesh, route, redaction, and audit surfaces are shown only
            from SDK-backed backend evidence. Export uses the AdminAction controller.
          </p>
        </div>
        <dl className="adx-metrics">
          <Metric label="services" value={services.data?.services.length ?? 0} />
          <Metric label="mesh peers" value={webrtc.data?.connected_peer_count ?? 0} />
          <Metric label="blocked actions" value={blockedActions(catalog.data)} />
          <Metric label="degraded probes" value={unavailable.length} />
        </dl>
      </section>

      <div className="aw-page-grid">
        <section className="aw-panel" aria-labelledby="diagnostics-probes-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-probes-title">Diagnostics Probes</h2>
              <p>Each row is backed by Gateway, capability catalog, route, or WebRTC diagnostics.</p>
            </div>
          </div>
          <div className="adx-table" role="table" aria-label="Diagnostics probes">
            <div className="adx-table-head" role="row">
              <span role="columnheader">Probe</span>
              <span role="columnheader">State</span>
              <span role="columnheader">Evidence</span>
            </div>
            {probes.map((probe) => (
              <div className="adx-table-row" role="row" key={probe.name}>
                <span role="cell">
                  <strong>{probe.name}</strong>
                  <small>{probe.details}</small>
                </span>
                <span role="cell"><StateBadge state={probe.state} /></span>
                <span role="cell">{probe.evidence}</span>
              </div>
            ))}
          </div>
          <ErrorList results={[services, topology, webrtc, catalog, route]} />
        </section>

        <section className="aw-panel" aria-labelledby="diagnostics-redaction-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-redaction-title">Redaction Preview</h2>
              <p>Preview lists data classes the backend omits or summarizes before support export.</p>
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
              <dt>Capability catalog</dt>
              <dd>{catalog.data?.secrets_redacted ? 'backend redaction asserted' : redactionGap(catalog.error)}</dd>
            </div>
            <div>
              <dt>WebRTC diagnostics</dt>
              <dd>{webrtc.data?.secrets_redacted ? 'peer/session secrets redacted' : redactionGap(webrtc.error)}</dd>
            </div>
            <div>
              <dt>Deployment topology</dt>
              <dd>{topology.data?.secrets_redacted ? 'Redis URL redacted' : redactionGap(topology.error)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="aw-page-grid">
        <section className="aw-panel" aria-labelledby="diagnostics-mesh-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-mesh-title">Mesh And Route Snapshot</h2>
              <p>Route explain and WebRTC state stay visible with provider identity and blockers.</p>
            </div>
          </div>
          <dl className="aw-facts">
            <div>
              <dt>Route target</dt>
              <dd>{route.data ? `${route.data.selected_target} for ${route.data.topic}` : unavailableText(route.error)}</dd>
            </div>
            <div>
              <dt>Selected provider</dt>
              <dd>{route.data?.selected_provider_id ?? route.data?.selected_peer_id ?? 'none'}</dd>
            </div>
            <div>
              <dt>Fallback</dt>
              <dd>{route.data?.fallback_behavior ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>WebRTC/DataChannel</dt>
              <dd>{webrtc.data ? `${webrtc.data.connected_peer_count} connected, ${webrtc.data.pending_rpc_count} pending RPC` : unavailableText(webrtc.error)}</dd>
            </div>
            <div>
              <dt>Recent ICE/DataChannel errors</dt>
              <dd>{webrtc.data?.recent_errors.length ? webrtc.data.recent_errors.map((error) => error.code).join(', ') : 'none reported'}</dd>
            </div>
          </dl>
        </section>

        <section className="aw-panel" aria-labelledby="diagnostics-availability-title">
          <div className="adx-section-heading">
            <div>
              <h2 id="diagnostics-availability-title">Availability Summary</h2>
              <p>Unsupported or degraded features keep repair evidence instead of disappearing.</p>
            </div>
          </div>
          <dl className="aw-facts">
            <div>
              <dt>Bus</dt>
              <dd>{topology.data ? `${topology.data.bus_backend} (${topology.data.bullmq_queue_health.status})` : unavailableText(topology.error)}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{topology.data ? `${topology.data.architecture_mode} / ${topology.data.runtime_mode}` : 'unknown'}</dd>
            </div>
            <div>
              <dt>Capability providers</dt>
              <dd>{catalog.data ? `${catalog.data.providers.length} providers, ${catalog.data.actions.length} actions` : unavailableText(catalog.error)}</dd>
            </div>
            <div>
              <dt>Config parity</dt>
              <dd>{topology.data?.mode_capability_degradations.length ? topology.data.mode_capability_degradations.join(', ') : 'no mode degradations reported'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <DiagnosticsExportControl
        correlationId={correlationId}
        disabled={exportDisabled}
        disabledReason="Required support bundle inputs are unavailable; repair Gateway services, topology, and capability catalog first."
      />
    </div>
  )
}

async function capture<T>(operation: () => Promise<T>): Promise<DiagnosticResult<T>> {
  try {
    return { data: await operation(), error: null }
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : 'SDK request failed' }
  }
}

function buildProbes(input: {
  services: DiagnosticResult<GetServicesResponse>
  topology: DiagnosticResult<DeploymentTopologyResponse>
  webrtc: DiagnosticResult<WebRTCDiagnosticsResponse>
  catalog: DiagnosticResult<CapabilityCatalogResponse>
  route: DiagnosticResult<RouteExplainResponse>
}): ProbeRow[] {
  return [
    {
      name: 'Gateway service registry',
      state: input.services.data?.services.length ? 'available-local' : stateFromError(input.services.error),
      evidence: input.services.data ? `${input.services.data.services.length} services in ${input.services.data.mode}` : unavailableText(input.services.error),
      details: 'native/sidecar/gateway service inventory'
    },
    {
      name: 'Deployment and bus health',
      state: input.topology.data?.bullmq_queue_health.status === 'healthy' ? 'available-local' : stateFromError(input.topology.error, 'degraded'),
      evidence: input.topology.data ? `${input.topology.data.bus_backend}; redis=${input.topology.data.redis_reachable ?? 'n/a'}` : unavailableText(input.topology.error),
      details: 'process/thread topology and config parity'
    },
    {
      name: 'Capability catalog snapshot',
      state: input.catalog.data?.actions.length ? 'available-local' : stateFromError(input.catalog.error),
      evidence: input.catalog.data ? `${input.catalog.data.providers.length} providers; redacted=${input.catalog.data.secrets_redacted}` : unavailableText(input.catalog.error),
      details: 'provider/action/resource catalog'
    },
    {
      name: 'Mesh route explain',
      state: input.route.data?.blockers.length ? 'privacy-blocked' : stateFromError(input.route.error, 'available-remote'),
      evidence: input.route.data ? `${input.route.data.selected_target}; blockers=${input.route.data.blockers.map((blocker) => blocker.code).join(',') || 'none'}` : unavailableText(input.route.error),
      details: 'route, provider, fallback, policy blockers'
    },
    {
      name: 'WebRTC ICE/DataChannel',
      state: input.webrtc.data?.started ? 'available-remote' : stateFromError(input.webrtc.error, 'unsupported'),
      evidence: input.webrtc.data ? `${input.webrtc.data.connected_peer_count} connected; e2ee=${input.webrtc.data.app_layer_e2ee_enabled}` : unavailableText(input.webrtc.error),
      details: 'peer/session and DataChannel diagnostics'
    }
  ]
}

function blockedActions(catalog: CapabilityCatalogResponse | null): number {
  return catalog?.actions.filter((action) => action.bindability !== 'available').length ?? 0
}

function stateFromError(error: string | null, fallback: AvailabilityState = 'unsupported'): AvailabilityState {
  if (!error) return fallback
  const lower = error.toLowerCase()
  if (lower.includes('permission') || lower.includes('forbidden')) return 'denied'
  if (lower.includes('timeout') || lower.includes('unavailable')) return 'degraded'
  return 'unsupported'
}

function unavailableText(error: string | null): string {
  return error ? `unavailable: ${error}` : 'unavailable'
}

function redactionGap(error: string | null): string {
  return error ? `redaction evidence unavailable: ${error}` : 'redaction evidence unavailable'
}

function StateBadge({ state }: { state: AvailabilityState }) {
  return <span className={`adx-badge adx-state-${state}`}>{state}</span>
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
