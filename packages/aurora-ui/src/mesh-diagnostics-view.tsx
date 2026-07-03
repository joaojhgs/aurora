import type { ReactNode } from 'react'
import { Activity, AlertTriangle, Bug, Download, FileArchive, Gauge, RadioTower, RefreshCw, Route, ShieldCheck } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  GatewaySupportBundleResponse,
  SupportBundleDiagnosticItem,
  MeshPeerDiagnostic,
  MeshRouteDiagnostic,
  MeshStatusResponse,
  WebRTCDiagnosticError,
  WebRTCDiagnosticsResponse,
  WebRTCPeerDiagnostic
} from '@aurora/client'
import { EvidenceBadge, StatusBadge, presentableSignal } from './status-badges'
import type { RouteAvailability } from './shell-data'

export type MeshDiagnosticsLoadState = 'loading' | 'ready' | 'empty' | 'degraded' | 'denied' | 'unavailable' | 'error'

export interface SettledDiagnostic<T> {
  data: T | null
  error: string | null
  denied?: boolean
}

export interface MeshTransportRow {
  id: string
  peerId: string
  signalingPeerId: string
  nodeName: string
  state: AvailabilityState
  connectionState: string
  iceConnectionState: string
  iceGatheringState: string
  signalingState: string
  dataChannelState: string
  dataChannelLabel: string
  hasSendChannel: boolean
  rttMs: number | null
  authState: string
  identitySource: string
  isAdmin: boolean
  effectivePermissionCount: number
  pairingState: string
  routeQuality: string
  routeProvider: string
  trustLabel: string
  fingerprint: string
  permissions: string
  compatibility: string
  lastSeen: string
}

export interface MeshRouteDiagnosticRow {
  module: string
  state: AvailabilityState
  decisionTarget: string
  decisionPeerId: string
  routeQuality: string
  latency: string
  fallback: string
  providerSummary: string
  blockers: string[]
  reason: string
}

export interface DiagnosticsProbeRow {
  name: string
  state: AvailabilityState
  latency: string
  detail: string
}

export interface RedactionPreviewRow {
  label: string
  value: number
  detail: string
}

export interface DiagnosticsTimelineRow {
  id: string
  kind: string
  title: string
  detail: string
  time: string
  state: AvailabilityState
}

export interface DiagnosticsDetailRow {
  id: string
  name: string
  state: AvailabilityState
  source: string
  detail: string
}

export interface SupportBundleExportState {
  status: 'idle' | 'pending' | 'success' | 'error'
  message: string | null
}

export interface MeshDiagnosticsSnapshot {
  loadState: MeshDiagnosticsLoadState
  generatedAt: string | null
  localNodeName: string
  localMeshPeerId: string | null
  localSignalingPeerId: string | null
  started: boolean
  enabled: boolean
  meshEnabled: boolean
  requireAuth: boolean
  appLayerE2eeEnabled: boolean
  secretsRedacted: boolean
  signalingState: AvailabilityState
  signalingEvidence: string
  signalingRepair: string
  diagnosticsCapabilityState: AvailabilityState
  diagnosticsCapabilityReason: string
  connectedPeerCount: number
  authenticatedPeerCount: number
  pairingPeerCount: number
  pendingRpcCount: number
  supportBundleState: AvailabilityState
  supportBundleReason: string
  supportBundleGeneratedAt: string | null
  supportBundleCorrelationId: string | null
  supportBundleAuditReceipt: string | null
  supportBundleServiceCount: number
  supportBundleRouteCount: number
  supportBundleRecentEventCount: number
  supportBundleNativeCapabilityCount: number
  liveProbes: DiagnosticsProbeRow[]
  redactionRows: RedactionPreviewRow[]
  timelineRows: DiagnosticsTimelineRow[]
  serviceProbeRows: DiagnosticsDetailRow[]
  nativeCapabilityRows: DiagnosticsDetailRow[]
  sidecarLogRows: DiagnosticsDetailRow[]
  frontendLogRows: DiagnosticsDetailRow[]
  transportRows: MeshTransportRow[]
  routeRows: MeshRouteDiagnosticRow[]
  recentErrors: WebRTCDiagnosticError[]
  warnings: string[]
  errors: string[]
  evidenceSource: string
}

export interface MeshDiagnosticsResourceProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface MeshDiagnosticsViewProps {
  snapshot: MeshDiagnosticsSnapshot
  route: RouteAvailability
  onRefresh?: () => void
  onExportSupportBundle?: () => void | Promise<void>
  supportBundleExportState?: SupportBundleExportState
  reauthConfirmed?: boolean
  onReauthConfirmedChange?: (value: boolean) => void
}

export function redactDiagnosticText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/"((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|audio_buffer)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(authorization)\b(\s*[:=]\s*)(?:bearer\s+)?[^\s,;<>\"']+/gi, '$1$2[redacted]')
    .replace(/\b((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|audio_buffer)\b(\s*[:=]\s*)(["']?)[^\s,;<>\"']+/gi, '$1$2$3[redacted]')
    .replace(/([?&](?:(?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|audio_buffer)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(raw[-_ ]?audio\s+payload)(\s*[:=]\s*)?(["']?)[^\s,;<>\"']*/gi, '$1$2$3[redacted]')
}

export const loadingMeshDiagnosticsSnapshot: MeshDiagnosticsSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  localNodeName: 'Loading mesh diagnostics',
  localMeshPeerId: null,
  localSignalingPeerId: null,
  started: false,
  enabled: false,
  meshEnabled: false,
  requireAuth: true,
  appLayerE2eeEnabled: false,
  secretsRedacted: true,
  signalingState: 'pending',
  signalingEvidence: 'Loading Gateway.GetWebRTCDiagnostics through Aurora.',
  signalingRepair: 'Wait for Gateway diagnostics to resolve.',
  diagnosticsCapabilityState: 'pending',
  diagnosticsCapabilityReason: 'Loading capability catalog for Gateway.GetWebRTCDiagnostics.',
  connectedPeerCount: 0,
  authenticatedPeerCount: 0,
  pairingPeerCount: 0,
  pendingRpcCount: 0,
  supportBundleState: 'pending',
  supportBundleReason: 'Loading Gateway.GetSupportBundle redaction preview through Aurora.',
  supportBundleGeneratedAt: null,
  supportBundleCorrelationId: null,
  supportBundleAuditReceipt: null,
  supportBundleServiceCount: 0,
  supportBundleRouteCount: 0,
  supportBundleRecentEventCount: 0,
  supportBundleNativeCapabilityCount: 0,
  liveProbes: [
    { name: 'Gateway route registry', state: 'pending', latency: 'loading', detail: 'Gateway.GetCapabilityCatalog pending.' },
    { name: 'WebRTC diagnostics', state: 'pending', latency: 'loading', detail: 'Gateway.GetWebRTCDiagnostics pending.' },
    { name: 'Support bundle contract', state: 'pending', latency: 'loading', detail: 'Gateway.GetSupportBundle pending.' }
  ],
  redactionRows: [
    { label: 'Credential values', value: 0, detail: 'Waiting for support bundle redaction metadata.' },
    { label: 'Audio capture data', value: 0, detail: 'Waiting for omitted media metadata.' },
    { label: 'Personal memory snippets', value: 0, detail: 'Waiting for RAG omission metadata.' }
  ],
  timelineRows: [],
  serviceProbeRows: [],
  nativeCapabilityRows: [],
  sidecarLogRows: [],
  frontendLogRows: [],
  transportRows: [],
  routeRows: [],
  recentErrors: [],
  warnings: [],
  errors: [],
  evidenceSource: 'pending Aurora service calls'
}

export async function buildMeshDiagnosticsSnapshot(
  client: AuroraClient,
  route: RouteAvailability
): Promise<MeshDiagnosticsSnapshot> {
  const [webrtc, mesh, catalog, supportBundle] = await Promise.all([
    captureDiagnostic(() => client.registry.getWebRTCDiagnostics()),
    captureDiagnostic(() => client.mesh.getStatus().then((response) => response.ok ? response.data : Promise.reject(response.error))),
    captureDiagnostic(() => client.capabilities.listCatalog({ include_unavailable: true, include_internal: true })),
    captureDiagnostic(() => client.diagnostics.getSupportBundle({ event_limit: 6, audit_limit: 6, include_capability_catalog: true }).then((response) => response.ok ? response.data : Promise.reject(response.error)))
  ])
  return meshDiagnosticsSnapshotFromResults({ route, webrtc, mesh, catalog, supportBundle })
}

export function meshDiagnosticsSnapshotFromResults(input: {
  route: RouteAvailability
  webrtc: SettledDiagnostic<WebRTCDiagnosticsResponse>
  mesh: SettledDiagnostic<MeshStatusResponse>
  catalog: SettledDiagnostic<CapabilityCatalogResponse>
  supportBundle?: SettledDiagnostic<GatewaySupportBundleResponse>
}): MeshDiagnosticsSnapshot {
  const diagnosticsCapability = input.catalog.data?.actions.find((action) => action.topic === 'Gateway.GetWebRTCDiagnostics' || action.action_id.includes('Gateway.GetWebRTCDiagnostics')) ?? null
  const supportBundle = input.supportBundle?.data ?? null
  const supportBundleError = input.supportBundle?.error ?? null
  const errors = [input.webrtc.error, input.mesh.error, input.catalog.error, supportBundleError]
    .filter((error): error is string => Boolean(error))
    .map(redactDiagnosticText)
  const denied = Boolean(input.webrtc.denied || input.mesh.denied || input.catalog.denied || input.route.state === 'denied')
  const webRtc = input.webrtc.data
  const mesh = input.mesh.data
  const transportRows = buildTransportRows(webRtc, mesh)
  const routeRows = (mesh?.routes ?? []).map(routeRow)
  const warnings = [
    ...capabilityWarnings(diagnosticsCapability),
    ...signalingWarnings(webRtc),
    ...(mesh?.compatibility_failures ?? []).map((failure) => `${failure.peer_id} ${failure.module} ${failure.direction}: ${failure.reason}`),
    ...(input.route.disabled ? [input.route.explanation] : [])
  ].map((message) => redactDiagnosticText(presentableSignal(message)))
  const loadState: MeshDiagnosticsLoadState = denied
    ? 'denied'
    : errors.length > 0
      ? webRtc || mesh ? 'degraded' : 'unavailable'
      : warnings.length > 0 || transportRows.some((row) => row.state !== 'available-remote' && row.state !== 'available-local') || routeRows.some((row) => row.state !== 'available-remote' && row.state !== 'available-local')
        ? 'degraded'
        : !webRtc && !mesh
      ? 'unavailable'
      : transportRows.length === 0 && routeRows.length === 0
        ? 'empty'
          : 'ready'

  return {
    loadState,
    generatedAt: input.catalog.data?.generated_at ?? null,
    localNodeName: webRtc?.local_node_name ?? mesh?.local.node_name ?? input.catalog.data?.local_node_name ?? 'Aurora node',
    localMeshPeerId: webRtc?.local_mesh_peer_id ?? mesh?.local.peer_id ?? input.catalog.data?.local_peer_id ?? null,
    localSignalingPeerId: webRtc?.local_signaling_peer_id ?? null,
    started: Boolean(webRtc?.started ?? mesh?.local.webrtc_started),
    enabled: Boolean(webRtc?.enabled ?? mesh?.local.webrtc_started),
    meshEnabled: Boolean(webRtc?.mesh_enabled ?? mesh?.local.mesh_enabled),
    requireAuth: webRtc?.require_auth ?? true,
    appLayerE2eeEnabled: Boolean(webRtc?.app_layer_e2ee_enabled),
    secretsRedacted: Boolean(webRtc?.secrets_redacted ?? mesh?.secrets_redacted ?? input.catalog.data?.secrets_redacted ?? true),
    signalingState: signalingState(webRtc, input.webrtc.error),
    signalingEvidence: redactDiagnosticText(signalingEvidence(webRtc, input.webrtc.error)),
    signalingRepair: redactDiagnosticText(signalingRepair(webRtc, input.webrtc.error)),
    diagnosticsCapabilityState: capabilityState(diagnosticsCapability, input.catalog.error),
    diagnosticsCapabilityReason: redactDiagnosticText(capabilityReason(diagnosticsCapability, input.catalog.error)),
    connectedPeerCount: webRtc?.connected_peer_count ?? 0,
    authenticatedPeerCount: webRtc?.authenticated_peer_count ?? 0,
    pairingPeerCount: webRtc?.pairing_peer_count ?? 0,
    pendingRpcCount: webRtc?.pending_rpc_count ?? 0,
    supportBundleState: supportBundleState(supportBundle, supportBundleError),
    supportBundleReason: supportBundleReason(supportBundle, supportBundleError),
    supportBundleGeneratedAt: supportBundle?.generated_at ?? null,
    supportBundleCorrelationId: redactDiagnosticText(supportBundle?.correlation_id ?? null) || null,
    supportBundleAuditReceipt: redactDiagnosticText(supportBundle?.audit_receipt ?? supportBundle?.audit_error ?? null) || null,
    supportBundleServiceCount: supportBundle?.services.length ?? 0,
    supportBundleRouteCount: supportBundle?.route_diagnostics.length ?? 0,
    supportBundleRecentEventCount: supportBundle?.recent_events.length ?? 0,
    supportBundleNativeCapabilityCount: supportBundle?.native_capabilities.length ?? 0,
    liveProbes: buildLiveProbes({ supportBundle, supportBundleError, webRtc, mesh, catalog: input.catalog.data, diagnosticsCapability }),
    redactionRows: buildRedactionRows(supportBundle, Boolean(webRtc?.secrets_redacted ?? mesh?.secrets_redacted ?? input.catalog.data?.secrets_redacted ?? true)),
    timelineRows: buildTimelineRows(supportBundle),
    serviceProbeRows: buildServiceProbeRows(supportBundle),
    nativeCapabilityRows: buildSupportBundleDiagnosticRows(supportBundle?.native_capabilities ?? [], 'native'),
    sidecarLogRows: buildSupportBundleDiagnosticRows(supportBundle?.sidecar_logs ?? [], 'sidecar'),
    frontendLogRows: buildFrontendLogRows(supportBundle, webRtc),
    transportRows,
    routeRows,
    recentErrors: (webRtc?.recent_errors ?? []).map((error) => ({
      ...error,
      message: redactDiagnosticText(error.message),
      peer_id: error.peer_id ? redactDiagnosticText(error.peer_id) : error.peer_id
    })),
    warnings,
    errors,
    evidenceSource: errors.length ? 'partial Aurora diagnostics responses' : 'Aurora Gateway diagnostics, mesh status, and capability catalog'
  }
}

export function MeshDiagnosticsView({ snapshot, route, onRefresh, onExportSupportBundle, supportBundleExportState = { status: 'idle', message: null }, reauthConfirmed = false, onReauthConfirmedChange }: MeshDiagnosticsViewProps) {
  return (
    <section className="aui-mesh-diagnostics" aria-labelledby="mesh-diagnostics-title">
      <header className="aui-mesh-diagnostics-header">
        <div>
          <p className="aui-kicker">service contract</p>
          <h1 id="mesh-diagnostics-title">Diagnostics</h1>
          <p>
            WebRTC and ICE diagnostics, live probes, redaction preview, support-bundle export, traces, and route failures are rendered from Aurora diagnostics.
          </p>
        </div>
        <div className="aui-mesh-badges" aria-label="Mesh diagnostics state">
          <StatusBadge state={snapshot.loadState === 'ready' ? 'available-remote' : stateForLoad(snapshot.loadState)} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
          <EvidenceBadge label={snapshot.supportBundleState === 'available-local' ? 'support bundle ready' : 'support bundle gated'} />
          <EvidenceBadge label={snapshot.evidenceSource} />
          {onRefresh ? <button className="aui-action-chip" type="button" onClick={onRefresh}><RefreshCw size={14} aria-hidden />Refresh</button> : null}
        </div>
      </header>

      <div className="aui-diagnostics-overview" aria-label="Diagnostics overview">
        <MetricCard icon={<Activity size={20} aria-hidden />} label="services observed" value={String(snapshot.supportBundleServiceCount || snapshot.connectedPeerCount)} detail="Gateway.GetSupportBundle service list" />
        <MetricCard icon={<FileArchive size={20} aria-hidden />} label="event stream" value={String(snapshot.supportBundleRecentEventCount)} detail="redacted EventStream metadata" />
        <MetricCard icon={<Gauge size={20} aria-hidden />} label="route diagnostics" value={String(snapshot.supportBundleRouteCount || snapshot.routeRows.length)} detail="mesh and Gateway route state" />
        <MetricCard icon={<RadioTower size={20} aria-hidden />} label="live probes" value={String(snapshot.liveProbes.length)} detail="registry, WebRTC, mesh, support bundle" />
        <MetricCard icon={<Bug size={20} aria-hidden />} label="reported errors" value={String(snapshot.recentErrors.length + snapshot.errors.length)} detail="redacted before render" />
      </div>

      <div className="aui-diagnostics-grid">
        <section className="aui-mesh-panel" aria-label="Live probes">
          <PanelTitle icon={<RefreshCw size={18} aria-hidden />} title="Live probes" description="Gateway, mesh, WebRTC, capability, and support-bundle probes stay tied to SDK methods." />
          <div className="aui-diagnostics-probes">
            {snapshot.liveProbes.map((probe) => (
              <div className="aui-diagnostics-probe" key={probe.name}>
                <div><strong>{probe.name}</strong><small>{probe.latency}</small></div>
                <StatusBadge state={probe.state} />
                <p>{probe.detail}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="aui-mesh-panel" aria-labelledby="diagnostics-redaction-title">
          <PanelTitle icon={<ShieldCheck size={18} aria-hidden />} title="Redaction preview" description="Secrets, credential material, audio capture data, and personal memory contents are omitted or redacted before export." />
          <div className="aui-diagnostics-redaction">
            {snapshot.redactionRows.map((row) => (
              <div key={row.label}>
                <div className="aui-diagnostics-redaction-label"><span>{row.label}</span><strong>{row.value}%</strong></div>
                <div className="aui-diagnostics-progress" aria-label={`${row.label} redaction ${row.value}%`}><span style={{ width: `${row.value}%` }} /></div>
                <small>{row.detail}</small>
              </div>
            ))}
          </div>
          <div className="aui-mesh-badges" aria-label="Redaction classes">
            <EvidenceBadge label="credentials excluded" />
            <EvidenceBadge label="audio capture excluded" />
            <EvidenceBadge label="AdminAction audit" />
          </div>
        </section>
      </div>

      <section className="aui-mesh-panel" aria-labelledby="diagnostics-export-title">
        <PanelTitle icon={<Download size={18} aria-hidden />} title="Support-bundle export" description="Export stays behind Gateway.GetSupportBundle and AdminAction confirmation; secrets and media payloads are excluded." />
        <dl className="aui-mesh-meta">
          <Metric label="method" value="Gateway.GetSupportBundle" />
          <Metric label="AdminAction" value="Gateway.AdminActionDraft / Gateway.AdminActionConfirm" />
          <Metric label="state" value={snapshot.supportBundleState} />
          <Metric label="updated" value={snapshot.supportBundleGeneratedAt ?? 'not exported yet'} />
          <Metric label="correlation" value={snapshot.supportBundleCorrelationId ?? 'pending'} />
          <Metric label="audit receipt" value={snapshot.supportBundleAuditReceipt ?? 'pending'} />
        </dl>
        <p className="aui-mesh-diagnostics-note">{snapshot.supportBundleReason}</p>
        <label className="aui-confirmation-check">
          {onReauthConfirmedChange ? (
            <input type="checkbox" checked={reauthConfirmed} onChange={(event) => onReauthConfirmedChange(event.currentTarget.checked)} disabled={!onExportSupportBundle || supportBundleExportState.status === 'pending'} />
          ) : (
            <input type="checkbox" checked={false} readOnly disabled={!onExportSupportBundle || supportBundleExportState.status === 'pending'} />
          )}
          <span>I confirm recent AdminAction reauthentication before exporting support data.</span>
        </label>
        <button
          className="aui-primary-action"
          type="button"
          disabled={!onExportSupportBundle || !reauthConfirmed || supportBundleExportState.status === 'pending'}
          {...(onExportSupportBundle ? { onClick: () => void onExportSupportBundle() } : {})}
        >
          <Download size={15} aria-hidden />
          {supportBundleExportState.status === 'pending' ? 'Exporting through AdminAction...' : 'Export redacted bundle'}
        </button>
        {supportBundleExportState.message ? <p className={`aui-diagnostics-export-message ${supportBundleExportState.status}`} role="status">{supportBundleExportState.message}</p> : null}
      </section>

      <section className="aui-mesh-panel" aria-labelledby="diagnostics-service-probes-title">
        <PanelTitle icon={<Activity size={18} aria-hidden />} title="Service probes" description="Service health checks, Gateway route registry, event-stream metadata, WebRTC, native capabilities, sidecar logs, and frontend log status are surfaced only here for troubleshooting." />
        {snapshot.serviceProbeRows.length > 0 ? (
          <DetailGrid rows={snapshot.serviceProbeRows} label="Service health probes" />
        ) : (
          <p className="aui-mesh-diagnostics-empty" role="status">Gateway.GetSupportBundle did not return service probe rows.</p>
        )}
      </section>

      <div className="aui-diagnostics-grid">
        <section className="aui-mesh-panel" aria-labelledby="diagnostics-native-title">
          <PanelTitle icon={<ShieldCheck size={18} aria-hidden />} title="Native manifest and permissions" description="Desktop, Android, and iOS native capabilities are shown as redacted support-bundle metadata." />
          <DetailGrid rows={snapshot.nativeCapabilityRows} label="Native capability diagnostics" empty="No native manifest or permission diagnostics were returned by Gateway.GetSupportBundle." />
        </section>
        <section className="aui-mesh-panel" aria-labelledby="diagnostics-logs-title">
          <PanelTitle icon={<Bug size={18} aria-hidden />} title="Sidecar and frontend logs" description="Only redacted log metadata is previewed; raw logs, tokens, and media payloads never enter the support bundle." />
          <DetailGrid rows={[...snapshot.sidecarLogRows, ...snapshot.frontendLogRows]} label="Sidecar process and frontend log diagnostics" empty="No sidecar or frontend log metadata was returned. Repair Gateway.GetSupportBundle redacted log collection before exporting logs." />
        </section>
      </div>

      <section className="aui-mesh-panel" aria-labelledby="diagnostics-timeline-title">
        <PanelTitle icon={<FileArchive size={18} aria-hidden />} title="Timeline" description="Recent event and audit metadata from the redacted support bundle." />
        {snapshot.timelineRows.length > 0 ? (
          <ul className="aui-diagnostics-timeline">
            {snapshot.timelineRows.map((row) => (
              <li key={row.id}>
                <StatusBadge state={row.state} />
                <div><strong>{row.title}</strong><span>{row.detail}</span></div>
                <time>{row.time}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="aui-mesh-diagnostics-empty" role="status">No support-bundle timeline entries were returned.</p>
        )}
      </section>

      <dl className="aui-mesh-diagnostics-summary">
        <Metric label="connected" value={String(snapshot.connectedPeerCount)} />
        <Metric label="authenticated" value={String(snapshot.authenticatedPeerCount)} />
        <Metric label="pairing" value={String(snapshot.pairingPeerCount)} />
        <Metric label="pending RPC" value={String(snapshot.pendingRpcCount)} />
        <Metric label="routes" value={String(snapshot.routeRows.length)} />
      </dl>

      <div className="aui-mesh-diagnostics-grid">
        <section className="aui-mesh-panel" aria-labelledby="mesh-signaling-title">
          <PanelTitle icon={<RadioTower size={18} aria-hidden />} title="Signaling" description="MQTT/WebRTC setup, presence encryption, broker, room, and app-layer E2EE state." />
          <StatusBadge state={snapshot.signalingState} />
          <dl className="aui-mesh-meta">
            <Metric label="node" value={snapshot.localNodeName} />
            <Metric label="mesh peer" value={snapshot.localMeshPeerId ?? 'not reported'} />
            <Metric label="signaling peer" value={snapshot.localSignalingPeerId ?? 'not reported'} />
            <Metric label="auth" value={snapshot.requireAuth ? 'required' : 'not required'} />
            <Metric label="app-layer E2EE" value={snapshot.appLayerE2eeEnabled ? 'enabled' : 'not enabled'} />
            <Metric label="state" value={snapshot.signalingEvidence} />
          </dl>
          <p className="aui-mesh-diagnostics-note">{snapshot.signalingRepair}</p>
        </section>

        <section className="aui-mesh-panel" aria-labelledby="mesh-capability-title">
          <PanelTitle icon={<ShieldCheck size={18} aria-hidden />} title="Capability gating" description="Feature visibility follows the capability graph and route availability." />
          <dl className="aui-mesh-meta">
            <Metric label="route state" value={route.state} />
            <Metric label="provider" value={route.providerLabel} />
            <Metric label="selector" value={route.selectorRequired ? 'required' : 'not required'} />
            <Metric label="AdminAction" value={route.requiresAdminAction ? 'mutation only' : 'not required'} />
            <Metric label="diagnostics method" value={snapshot.diagnosticsCapabilityState} />
            <Metric label="reason" value={snapshot.diagnosticsCapabilityReason} />
          </dl>
        </section>
      </div>

      {snapshot.errors.length > 0 ? (
        <div className="aui-mesh-diagnostics-alert" role="alert">
          <AlertTriangle size={18} aria-hidden />
          <div>
            <strong>Degraded diagnostics inputs</strong>
            <ul>{snapshot.errors.map((error) => <li key={error}>{error}</li>)}</ul>
          </div>
        </div>
      ) : null}

      {snapshot.warnings.length > 0 ? (
        <section className="aui-mesh-panel" aria-labelledby="mesh-warning-title">
          <PanelTitle icon={<AlertTriangle size={18} aria-hidden />} title="Repair state" description="Unsupported, stale, denied, or compatibility-blocked diagnostics remain visible." />
          <ul className="aui-mesh-warnings">{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </section>
      ) : null}

      <section className="aui-mesh-panel" aria-labelledby="mesh-transport-title">
        <PanelTitle icon={<RadioTower size={18} aria-hidden />} title="Peer transport matrix" description="Stable identity is shown beside signaling session identity and live transport state." />
        {snapshot.transportRows.length > 0 ? (
          <div className="aui-mesh-diagnostics-table" role="table" aria-label="WebRTC peer transport diagnostics">
            <div role="row" className="aui-mesh-diagnostics-table-head">
              <span role="columnheader">Peer</span>
              <span role="columnheader">Transport</span>
              <span role="columnheader">Trust and permissions</span>
              <span role="columnheader">Route and freshness</span>
            </div>
            {snapshot.transportRows.map((peer) => (
              <div role="row" className="aui-mesh-diagnostics-table-row" key={peer.id}>
                <span role="cell"><strong>{peer.nodeName}</strong><code>{peer.peerId}</code><small>signaling {peer.signalingPeerId}</small></span>
                <span role="cell"><StatusBadge state={peer.state} /><small>ICE {peer.iceConnectionState}; gather {peer.iceGatheringState}; channel {peer.dataChannelState}; RTT {formatMs(peer.rttMs)}</small></span>
                <span role="cell"><strong>{peer.trustLabel}</strong><small>{peer.authState}; {peer.permissions}; {peer.fingerprint}</small></span>
                <span role="cell"><strong>{peer.routeQuality}</strong><small>{peer.routeProvider}; {peer.compatibility}; {peer.lastSeen}</small></span>
              </div>
            ))}
          </div>
        ) : (
          <p className="aui-mesh-diagnostics-empty" role="status">No live WebRTC peer sessions were reported by the backend.</p>
        )}
      </section>

      <section className="aui-mesh-panel" aria-labelledby="mesh-routes-title">
        <PanelTitle icon={<Route size={18} aria-hidden />} title="Route quality" description="Route decisions keep fallback and provider eligibility visible." />
        {snapshot.routeRows.length > 0 ? (
          <div className="aui-mesh-row-list">
            {snapshot.routeRows.map((row) => (
              <article className={`aui-mesh-row aui-mesh-card-${row.state}`} key={row.module}>
                <header>
                  <div>
                    <p className="aui-kicker">{row.decisionTarget}</p>
                    <h3>{row.module}</h3>
                    <code>{row.decisionPeerId}</code>
                  </div>
                  <StatusBadge state={row.state} />
                </header>
                <dl className="aui-mesh-meta">
                  <Metric label="quality" value={row.routeQuality} />
                  <Metric label="latency" value={row.latency} />
                  <Metric label="fallback" value={row.fallback} />
                  <Metric label="providers" value={row.providerSummary} />
                </dl>
                <p className="aui-mesh-diagnostics-note">{row.reason}</p>
                {row.blockers.length > 0 ? <ul className="aui-mesh-warnings">{row.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="aui-mesh-diagnostics-empty" role="status">No mesh routes were reported by Gateway.GetMeshStatus.</p>
        )}
      </section>

      <section className="aui-mesh-panel" aria-labelledby="mesh-errors-title">
        <PanelTitle icon={<AlertTriangle size={18} aria-hidden />} title="Recent transport errors" description="Backend-reported signaling, ICE, DataChannel, and RPC failures." />
        {snapshot.recentErrors.length > 0 ? (
          <ul className="aui-mesh-error-list">
            {snapshot.recentErrors.map((error) => (
              <li key={`${error.timestamp}:${error.code}:${error.peer_id ?? 'local'}`}>
                <strong>{error.code}</strong>
                <span>{error.message}</span>
                <small>{error.peer_id ?? 'local'}; {error.timestamp}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="aui-mesh-diagnostics-empty" role="status">No recent transport errors were reported.</p>
        )}
      </section>
    </section>
  )
}


function supportBundleState(bundle: GatewaySupportBundleResponse | null, error: string | null): AvailabilityState {
  if (error) return errorState(error)
  if (!bundle) return 'pending'
  if (!bundle.secrets_redacted || !bundle.redaction.secrets_redacted) return 'degraded'
  return 'available-local'
}

function supportBundleReason(bundle: GatewaySupportBundleResponse | null, error: string | null): string {
  if (error) return redactDiagnosticText(`Gateway.GetSupportBundle unavailable: ${error}`)
  if (!bundle) return 'Waiting for Gateway.GetSupportBundle support-bundle preview.'
  const omitted = bundle.redaction.omitted_payloads.map(safeDiagnosticCategoryLabel).join(', ') || 'none reported'
  return redactDiagnosticText(`Redacted support bundle ${bundle.correlation_id ?? 'without correlation'} omits ${omitted}.`)
}

function safeDiagnosticCategoryLabel(value: string): string {
  const normalized = value.toLowerCase()
  if (/raw[-_ ]?audio|audio_buffer/.test(normalized)) return 'audio capture data'
  if (/tokens?|credentials?|secrets?|passwords?|api[_-]?keys?/.test(normalized)) return 'credential material'
  return redactDiagnosticText(value)
}

function buildLiveProbes(input: {
  supportBundle: GatewaySupportBundleResponse | null
  supportBundleError: string | null
  webRtc: WebRTCDiagnosticsResponse | null
  mesh: MeshStatusResponse | null
  catalog: CapabilityCatalogResponse | null
  diagnosticsCapability: CapabilityActionInfo | null
}): DiagnosticsProbeRow[] {
  const bundle = input.supportBundle
  const rows: DiagnosticsProbeRow[] = [
    {
      name: 'Gateway route registry',
      state: input.catalog ? 'available-local' : 'degraded',
      latency: input.catalog?.generated_at ? `updated ${input.catalog.generated_at}` : 'not reported',
      detail: input.catalog ? `${input.catalog.actions.length} actions / ${input.catalog.providers.length} providers advertised.` : 'Gateway.GetCapabilityCatalog did not return route metadata.'
    },
    {
      name: 'OpenAPI and contract surface',
      state: capabilityState(input.diagnosticsCapability, null),
      latency: bundle ? `${bundle.registry.modules.length} modules` : 'contract gap',
      detail: bundle ? 'Registry snapshot included in redacted support bundle.' : 'Support bundle registry snapshot unavailable.'
    },
    {
      name: 'Mesh peer metrics',
      state: input.webRtc?.connected_peer_count ? 'available-remote' : input.mesh?.local.mesh_enabled ? 'degraded' : 'unsupported',
      latency: input.webRtc ? `${input.webRtc.connected_peer_count} connected / ${input.webRtc.pending_rpc_count} pending RPC` : 'not reported',
      detail: input.webRtc ? 'Gateway.GetWebRTCDiagnostics returned peer and route telemetry.' : 'WebRTC diagnostics unavailable or disabled.'
    },
    {
      name: 'Diagnostics bundle contract',
      state: supportBundleState(bundle, input.supportBundleError),
      latency: bundle?.generated_at ?? 'not exported',
      detail: supportBundleReason(bundle, input.supportBundleError)
    }
  ]
  return rows.map((probe) => ({ ...probe, detail: redactDiagnosticText(probe.detail), latency: redactDiagnosticText(probe.latency) }))
}

function buildRedactionRows(bundle: GatewaySupportBundleResponse | null, fallbackRedacted: boolean): RedactionPreviewRow[] {
  const redactedFields = bundle?.redaction.redacted_fields.join(' ').toLowerCase() ?? ''
  const omittedPayloads = bundle?.redaction.omitted_payloads.join(' ').toLowerCase() ?? ''
  const credentials = Boolean(bundle?.redaction.secrets_redacted ?? fallbackRedacted)
  const rawAudio = omittedPayloads.includes('audio') || redactedFields.includes('audio')
  const memory = omittedPayloads.includes('rag') || omittedPayloads.includes('memory') || redactedFields.includes('rag')
  return [
    {
      label: 'Credential values',
      value: credentials ? 100 : 0,
      detail: credentials ? 'Credential, secret, password, key, and URL fields are redacted.' : 'Credential redaction was not confirmed by backend metadata.'
    },
    {
      label: 'Audio capture data',
      value: rawAudio ? 100 : 0,
      detail: rawAudio ? 'Audio capture payloads are omitted from support bundles.' : 'Audio capture omission was not listed by the backend.'
    },
    {
      label: 'Personal memory snippets',
      value: memory ? 100 : 76,
      detail: memory ? 'RAG and personal memory contents are omitted; only metadata/correlation remains.' : 'Backend reported generic redaction, but no RAG-specific omission entry.'
    }
  ]
}

function buildServiceProbeRows(bundle: GatewaySupportBundleResponse | null): DiagnosticsDetailRow[] {
  if (!bundle) return []
  const healthRows = bundle.service_health.map((health, index) => ({
    id: `service-health-${health.module}-${index}`,
    name: `${health.module} service probe`,
    state: serviceHealthState(health.status),
    source: `Gateway.GetSupportBundle service_health @ ${redactDiagnosticText(health.timestamp)}`,
    detail: redactDiagnosticText(`${health.status}; checks ${safeDiagnosticDetails(health.checks)}`)
  }))
  const serviceRows = bundle.services
    .filter((service) => !bundle.service_health.some((health) => health.module === service.module))
    .map((service) => ({
      id: `service-${service.module}-${service.instance_id ?? 'default'}`,
      name: `${service.module} service probe`,
      state: serviceHealthState(service.status),
      source: 'Gateway.GetSupportBundle services',
      detail: redactDiagnosticText(`${service.status}; ${service.method_count} methods; ${service.capabilities.join(', ') || 'no capabilities reported'}`)
    }))
  return [...healthRows, ...serviceRows]
}

function buildSupportBundleDiagnosticRows(items: SupportBundleDiagnosticItem[], prefix: string): DiagnosticsDetailRow[] {
  return items.map((item, index) => ({
    id: `${prefix}-${item.name}-${index}`,
    name: redactDiagnosticText(item.name),
    state: diagnosticItemState(item),
    source: redactDiagnosticText(item.source),
    detail: redactDiagnosticText(`${item.status}; ${safeDiagnosticDetails(item.details)}; ${item.redacted ? 'redacted metadata only' : 'redaction not confirmed'}`)
  }))
}

function buildFrontendLogRows(bundle: GatewaySupportBundleResponse | null, webRtc: WebRTCDiagnosticsResponse | null): DiagnosticsDetailRow[] {
  if (!bundle) return []
  const frontendEvents = bundle.recent_events.filter((event) => /front[-_ ]?end|ui|browser|vite/i.test(`${event.kind} ${event.topic ?? ''} ${event.bus_topic ?? ''}`))
  if (frontendEvents.length > 0) {
    return frontendEvents.map((event, index) => ({
      id: `frontend-event-${event.id || index}`,
      name: 'Frontend errors/logs',
      state: event.status === 'failed' || event.status === 'error' ? 'degraded' : 'available-local',
      source: redactDiagnosticText(event.topic ?? event.kind ?? 'Gateway event stream'),
      detail: redactDiagnosticText(`${event.status ?? 'status unknown'}; ${safeDiagnosticDetails(event.payload_summary)}; ${event.secrets_redacted ? 'secrets protected' : 'redaction not confirmed'}`)
    }))
  }
  return [{
    id: 'frontend-logs-unavailable',
    name: 'Frontend errors/logs',
    state: webRtc?.recent_errors.length ? 'degraded' : 'unsupported',
    source: 'Gateway.GetSupportBundle recent_events',
    detail: 'No redacted frontend log stream is exposed yet; use this repair state instead of embedding raw frontend dumps on product pages.'
  }]
}

function serviceHealthState(status: string): AvailabilityState {
  const value = status.toLowerCase()
  if (value.includes('healthy') || value === 'ok' || value === 'running') return 'available-local'
  if (value.includes('degraded') || value.includes('warning') || value.includes('partial')) return 'degraded'
  if (value.includes('denied') || value.includes('forbidden')) return 'denied'
  if (value.includes('stale')) return 'stale'
  if (value.includes('down') || value.includes('error') || value.includes('failed')) return 'unsupported'
  return 'pending'
}

function diagnosticItemState(item: SupportBundleDiagnosticItem): AvailabilityState {
  const status = item.status.toLowerCase()
  if (!item.redacted) return 'degraded'
  if (status.includes('available') || status.includes('ready') || status.includes('ok') || status.includes('metadata')) return 'available-local'
  if (status.includes('degraded') || status.includes('partial')) return 'degraded'
  if (status.includes('denied') || status.includes('forbidden')) return 'denied'
  if (status.includes('unavailable') || status.includes('unsupported')) return 'unsupported'
  return 'pending'
}

function safeDiagnosticDetails(value: unknown): string {
  try {
    return redactDiagnosticText(JSON.stringify(value).replace(/raw[-_ ]?audio/gi, 'audio capture data'))
  } catch {
    return '[redacted metadata]'
  }
}

function buildTimelineRows(bundle: GatewaySupportBundleResponse | null): DiagnosticsTimelineRow[] {
  if (!bundle) return []
  const eventRows = bundle.recent_events.map((event, index) => ({
    id: event.id || `event-${index}`,
    kind: redactDiagnosticText(event.kind || event.topic || 'event'),
    title: redactDiagnosticText(event.topic || event.kind || 'Gateway event'),
    detail: redactDiagnosticText(`${event.status ?? 'status unknown'}; correlation ${event.correlation_id ?? bundle.correlation_id ?? 'none'}; peer ${event.peer_id ?? 'local'}`),
    time: redactDiagnosticText(event.timestamp),
    state: event.status === 'denied' || event.status === 'failed' ? 'denied' as AvailabilityState : 'available-local' as AvailabilityState
  }))
  const auditRows = bundle.recent_audit_events.map((event, index) => {
    const eventObject = event as Record<string, unknown>
    return {
      id: `audit-${String(eventObject.audit_receipt ?? eventObject.correlation_id ?? index)}`,
      kind: 'audit',
      title: redactDiagnosticText(String(eventObject.event ?? 'audit event')),
      detail: redactDiagnosticText(`receipt ${String(eventObject.audit_receipt ?? bundle.audit_receipt ?? 'pending')}; correlation ${String(eventObject.correlation_id ?? bundle.correlation_id ?? 'none')}`),
      time: redactDiagnosticText(String(eventObject.timestamp ?? bundle.generated_at)),
      state: 'available-local' as AvailabilityState
    }
  })
  return [...eventRows, ...auditRows].slice(0, 8)
}

function DetailGrid({ rows, label, empty }: { rows: DiagnosticsDetailRow[]; label: string; empty?: string }) {
  if (rows.length === 0) return <p className="aui-mesh-diagnostics-empty" role="status">{empty ?? 'No diagnostics metadata was returned.'}</p>
  return (
    <div className="aui-diagnostics-probes" aria-label={label}>
      {rows.map((row) => (
        <div className="aui-diagnostics-probe" key={row.id}>
          <div><strong>{row.name}</strong><small>{row.source}</small></div>
          <StatusBadge state={row.state} />
          <p>{row.detail}</p>
        </div>
      ))}
    </div>
  )
}

function MetricCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="aui-diagnostics-metric-card">
      <span>{icon}</span>
      <strong>{value}</strong>
      <p>{label}</p>
      <small>{detail}</small>
    </div>
  )
}

function buildTransportRows(
  webrtc: WebRTCDiagnosticsResponse | null,
  mesh: MeshStatusResponse | null
): MeshTransportRow[] {
  return (webrtc?.peers ?? []).map((peer) => {
    const meshPeer = findMeshPeer(mesh, peer)
    return {
      id: `${peer.stable_peer_id}:${peer.signaling_peer_id}`,
      peerId: peer.stable_peer_id || 'unresolved peer',
      signalingPeerId: peer.signaling_peer_id,
      nodeName: peer.node_name || meshPeer?.node_name || 'Unnamed peer',
      state: peerState(peer, meshPeer),
      connectionState: peer.connection_state,
      iceConnectionState: peer.ice_connection_state,
      iceGatheringState: peer.ice_gathering_state,
      signalingState: peer.signaling_state,
      dataChannelState: peer.data_channel_state,
      dataChannelLabel: peer.data_channel_label || 'not reported',
      hasSendChannel: peer.has_send_channel,
      rttMs: peer.rtt_ms,
      authState: peer.auth_state,
      identitySource: peer.identity_source,
      isAdmin: peer.is_admin,
      effectivePermissionCount: peer.effective_permission_count,
      pairingState: pairingState(peer),
      routeQuality: routeQuality(meshPeer?.latency_ms ?? peer.rtt_ms, meshPeer?.status ?? peer.connection_state),
      routeProvider: routeProvider(mesh, peer.stable_peer_id),
      trustLabel: trustLabel(peer, meshPeer),
      fingerprint: peer.identity_source ? `fingerprint/source: ${peer.identity_source}` : 'fingerprint not reported',
      permissions: `${peer.effective_permission_count} effective permission${peer.effective_permission_count === 1 ? '' : 's'}`,
      compatibility: compatibilityLabel(meshPeer),
      lastSeen: meshPeer ? `ping ${age(meshPeer.last_ping_age_s)}; manifest ${age(meshPeer.last_manifest_age_s)}` : 'manifest not reported'
    }
  })
}

function findMeshPeer(mesh: MeshStatusResponse | null, peer: WebRTCPeerDiagnostic): MeshPeerDiagnostic | null {
  return mesh?.peers.find((candidate) => candidate.peer_id === peer.stable_peer_id || candidate.node_name === peer.node_name) ?? null
}

function peerState(peer: WebRTCPeerDiagnostic, meshPeer: MeshPeerDiagnostic | null): AvailabilityState {
  if (peer.auth_timeout_pending || peer.pending_pairing_task || peer.pairing_active) return 'pending'
  if (peer.auth_state.includes('denied') || peer.auth_state.includes('failed')) return 'denied'
  if (meshPeer?.status === 'stale') return 'stale'
  if (peer.connection_state === 'connected' && peer.ice_connection_state === 'completed' && peer.data_channel_state === 'open' && peer.auth_state === 'authenticated') return 'available-remote'
  if (peer.connection_state === 'connected' || peer.data_channel_state === 'open') return 'degraded'
  return 'unsupported'
}

function routeRow(route: MeshRouteDiagnostic): MeshRouteDiagnosticRow {
  const blockers = route.providers
    .filter((provider) => !provider.eligible)
    .map((provider) => redactDiagnosticText(`${provider.node_name}: ${provider.reason_code} (${provider.reason})`))
  return {
    module: redactDiagnosticText(route.module),
    state: routeState(route),
    decisionTarget: redactDiagnosticText(route.decision_target),
    decisionPeerId: redactDiagnosticText(route.decision_peer_id ?? 'local'),
    routeQuality: routeQuality(route.decision_latency_ms, route.decision_target),
    latency: formatMs(route.decision_latency_ms),
    fallback: redactDiagnosticText(route.fallback),
    providerSummary: `${route.providers.filter((provider) => provider.eligible).length}/${route.providers.length} eligible`,
    blockers,
    reason: redactDiagnosticText(route.reason)
  }
}

function routeState(route: MeshRouteDiagnostic): AvailabilityState {
  if (!route.configured) return 'unsupported'
  if (route.decision_target === 'error' || route.decision_target === 'none') return 'unsupported'
  if (route.decision_target === 'local' && route.providers.some((provider) => !provider.eligible)) return 'degraded'
  if (route.providers.some((provider) => provider.reason_code.includes('denied') || provider.reason_code.includes('unauthorized'))) return 'denied'
  if (route.providers.some((provider) => provider.reason_code.includes('stale'))) return 'degraded'
  return route.decision_target === 'remote' ? 'available-remote' : 'available-local'
}

function signalingState(webrtc: WebRTCDiagnosticsResponse | null, error: string | null): AvailabilityState {
  if (error) return errorState(error)
  if (!webrtc?.enabled) return 'unsupported'
  if (!webrtc.started || !webrtc.signaling.connected) return 'degraded'
  if (!webrtc.signaling.app_id_configured || !webrtc.signaling.room_configured) return 'privacy-blocked'
  if (webrtc.signaling.public_broker_warning) return 'degraded'
  return 'available-remote'
}

function signalingEvidence(webrtc: WebRTCDiagnosticsResponse | null, error: string | null): string {
  if (error) return `Gateway.GetWebRTCDiagnostics unavailable: ${error}`
  if (!webrtc) return 'No WebRTC diagnostics returned.'
  return `${webrtc.signaling.strategy}; connected=${webrtc.signaling.connected}; brokers=${webrtc.signaling.broker_count}; encrypted_presence=${webrtc.signaling.encrypted_presence}`
}

function signalingRepair(webrtc: WebRTCDiagnosticsResponse | null, error: string | null): string {
  if (error) return 'Repair Gateway.GetWebRTCDiagnostics or permissions before trusting transport state.'
  if (!webrtc?.enabled) return 'WebRTC diagnostics are unsupported or disabled in this backend.'
  if (!webrtc.started) return 'Start the WebRTC mesh runtime before diagnosing peers.'
  if (!webrtc.signaling.connected) return 'Check signaling broker reachability and room configuration.'
  if (!webrtc.signaling.encrypted_presence || webrtc.signaling.public_broker_warning) return 'Review signaling privacy settings before exposing peer presence.'
  return 'Signaling is connected with backend-reported privacy status.'
}

function capabilityState(action: CapabilityActionInfo | null, error: string | null): AvailabilityState {
  if (error) return errorState(error)
  if (!action) return 'unsupported'
  if (action.policy.denial_reasons.length > 0 || action.route_blockers.length > 0) return action.policy.approval_required ? 'privacy-blocked' : 'denied'
  if (action.freshness.stale) return 'stale'
  return action.provider_kind === 'local' ? 'available-local' : 'available-remote'
}

function capabilityReason(action: CapabilityActionInfo | null, error: string | null): string {
  if (error) return `Capability catalog unavailable: ${error}`
  if (!action) return 'Gateway.GetWebRTCDiagnostics is not advertised by the capability catalog.'
  const blockers = [...action.route_blockers, ...action.policy.denial_reasons]
  return blockers.length > 0 ? presentableSignal(blockers.join(', ')) : `${action.provider_kind} provider ${action.provider_id}; bindability ${action.bindability}`
}

function capabilityWarnings(action: CapabilityActionInfo | null): string[] {
  if (!action) return ['Gateway.GetWebRTCDiagnostics capability is not advertised.']
  return [...action.route_blockers, ...action.policy.denial_reasons]
}

function signalingWarnings(webrtc: WebRTCDiagnosticsResponse | null): string[] {
  if (!webrtc) return []
  return [
    ...(!webrtc.started ? ['WebRTC runtime is not started.'] : []),
    ...(!webrtc.signaling.connected ? ['Signaling is disconnected.'] : []),
    ...(!webrtc.signaling.app_id_configured ? ['Signaling app ID is not configured.'] : []),
    ...(!webrtc.signaling.room_configured ? ['Signaling room is not configured.'] : []),
    ...(webrtc.signaling.public_broker_warning ? ['Public broker is in use; verify privacy expectations.'] : []),
    ...(!webrtc.app_layer_e2ee_enabled ? ['App-layer DataChannel E2EE is not enabled.'] : [])
  ]
}

async function captureDiagnostic<T>(operation: () => Promise<T>): Promise<SettledDiagnostic<T>> {
  try {
    return { data: await operation(), error: null, denied: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SDK request failed'
    return { data: null, error: message, denied: /permission|forbidden|denied|auth/i.test(message) }
  }
}

function errorState(error: string): AvailabilityState {
  const text = error.toLowerCase()
  if (text.includes('permission') || text.includes('forbidden') || text.includes('denied') || text.includes('auth')) return 'denied'
  if (text.includes('privacy')) return 'privacy-blocked'
  if (text.includes('timeout') || text.includes('unavailable')) return 'degraded'
  return 'unsupported'
}

function stateForLoad(loadState: MeshDiagnosticsLoadState): AvailabilityState {
  if (loadState === 'loading') return 'pending'
  if (loadState === 'denied') return 'denied'
  if (loadState === 'degraded') return 'degraded'
  if (loadState === 'empty' || loadState === 'unavailable' || loadState === 'error') return 'unsupported'
  return 'available-remote'
}

function pairingState(peer: WebRTCPeerDiagnostic): string {
  if (peer.pending_pairing_task) return 'pending pairing work'
  if (peer.pairing_active) return 'pairing active'
  if (peer.auth_timeout_pending) return 'auth timeout pending'
  return 'not pairing'
}

function trustLabel(peer: WebRTCPeerDiagnostic, meshPeer: MeshPeerDiagnostic | null): string {
  if (peer.auth_state === 'authenticated') return peer.is_admin ? 'authenticated admin peer' : 'authenticated peer'
  if (peer.pairing_active || peer.pending_pairing_task) return 'pairing pending'
  if (meshPeer?.status) return meshPeer.status
  return peer.auth_state || 'trust unknown'
}

function routeProvider(mesh: MeshStatusResponse | null, peerId: string): string {
  const routes = (mesh?.routes ?? []).filter((route) => route.decision_peer_id === peerId)
  return routes.length ? redactDiagnosticText(routes.map((route) => `${route.module}:${route.reason}`).join('; ')) : 'no selected route'
}

function compatibilityLabel(peer: MeshPeerDiagnostic | null): string {
  if (!peer) return 'compatibility not reported'
  const incompatible = [...peer.compatibility.local_incompatible, ...peer.compatibility.remote_incompatible]
  if (incompatible.length > 0) return `incompatible: ${incompatible.join(', ')}`
  const compatible = [...peer.compatibility.local_compatible, ...peer.compatibility.remote_compatible]
  return compatible.length ? `compatible: ${compatible.join(', ')}` : 'no compatibility overlap reported'
}

function routeQuality(latencyMs: number | null | undefined, status: string): string {
  if (status === 'stale') return 'stale'
  if (latencyMs === null || latencyMs === undefined) return 'latency unknown'
  if (latencyMs <= 50) return 'healthy'
  if (latencyMs <= 150) return 'degraded'
  return 'poor'
}

function age(seconds: number | null): string {
  if (seconds === null) return 'unknown'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

function formatMs(value: number | null): string {
  return value === null ? 'not reported' : `${Math.round(value)}ms`
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>
}

function PanelTitle({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="aui-mesh-panel-title">
      <span>{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  )
}
