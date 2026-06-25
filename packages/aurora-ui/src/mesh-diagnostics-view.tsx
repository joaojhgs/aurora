import type { ReactNode } from 'react'
import { AlertTriangle, RadioTower, RefreshCw, Route, ShieldCheck } from 'lucide-react'
import type {
  AuroraClient,
  AvailabilityState,
  CapabilityActionInfo,
  CapabilityCatalogResponse,
  MeshPeerDiagnostic,
  MeshRouteDiagnostic,
  MeshStatusResponse,
  WebRTCDiagnosticError,
  WebRTCDiagnosticsResponse,
  WebRTCPeerDiagnostic
} from '@aurora/client'
import { EvidenceBadge, StatusBadge } from './status-badges'
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
  signalingEvidence: 'Loading Gateway.GetWebRTCDiagnostics through AuroraClient.',
  signalingRepair: 'Wait for Gateway diagnostics to resolve.',
  diagnosticsCapabilityState: 'pending',
  diagnosticsCapabilityReason: 'Loading capability catalog for Gateway.GetWebRTCDiagnostics.',
  connectedPeerCount: 0,
  authenticatedPeerCount: 0,
  pairingPeerCount: 0,
  pendingRpcCount: 0,
  transportRows: [],
  routeRows: [],
  recentErrors: [],
  warnings: [],
  errors: [],
  evidenceSource: 'pending AuroraClient SDK calls'
}

export async function buildMeshDiagnosticsSnapshot(
  client: AuroraClient,
  route: RouteAvailability
): Promise<MeshDiagnosticsSnapshot> {
  const [webrtc, mesh, catalog] = await Promise.all([
    captureDiagnostic(() => client.registry.getWebRTCDiagnostics()),
    captureDiagnostic(() => client.mesh.getStatus().then((response) => response.ok ? response.data : Promise.reject(response.error))),
    captureDiagnostic(() => client.capabilities.listCatalog({ include_unavailable: true, include_internal: true }))
  ])
  return meshDiagnosticsSnapshotFromResults({ route, webrtc, mesh, catalog })
}

export function meshDiagnosticsSnapshotFromResults(input: {
  route: RouteAvailability
  webrtc: SettledDiagnostic<WebRTCDiagnosticsResponse>
  mesh: SettledDiagnostic<MeshStatusResponse>
  catalog: SettledDiagnostic<CapabilityCatalogResponse>
}): MeshDiagnosticsSnapshot {
  const diagnosticsCapability = input.catalog.data?.actions.find((action) => action.topic === 'Gateway.GetWebRTCDiagnostics' || action.action_id.includes('Gateway.GetWebRTCDiagnostics')) ?? null
  const errors = [input.webrtc.error, input.mesh.error, input.catalog.error].filter((error): error is string => Boolean(error))
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
  ]
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
    signalingEvidence: signalingEvidence(webRtc, input.webrtc.error),
    signalingRepair: signalingRepair(webRtc, input.webrtc.error),
    diagnosticsCapabilityState: capabilityState(diagnosticsCapability, input.catalog.error),
    diagnosticsCapabilityReason: capabilityReason(diagnosticsCapability, input.catalog.error),
    connectedPeerCount: webRtc?.connected_peer_count ?? 0,
    authenticatedPeerCount: webRtc?.authenticated_peer_count ?? 0,
    pairingPeerCount: webRtc?.pairing_peer_count ?? 0,
    pendingRpcCount: webRtc?.pending_rpc_count ?? 0,
    transportRows,
    routeRows,
    recentErrors: webRtc?.recent_errors ?? [],
    warnings,
    errors,
    evidenceSource: errors.length ? 'partial AuroraClient diagnostics responses' : 'AuroraClient Gateway diagnostics, mesh status, and capability catalog'
  }
}

export function MeshDiagnosticsView({ snapshot, route, onRefresh }: MeshDiagnosticsViewProps) {
  return (
    <section className="aui-mesh-diagnostics" aria-labelledby="mesh-diagnostics-title">
      <header className="aui-mesh-diagnostics-header">
        <div>
          <p className="aui-kicker">MESH-004</p>
          <h1 id="mesh-diagnostics-title">WebRTC and ICE diagnostics</h1>
          <p>
            Signaling, ICE, auth, DataChannel, RTT, peer identity, compatibility, and route failures are rendered from AuroraClient diagnostics.
          </p>
        </div>
        <div className="aui-mesh-badges" aria-label="Mesh diagnostics state">
          <StatusBadge state={snapshot.loadState === 'ready' ? 'available-remote' : stateForLoad(snapshot.loadState)} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <EvidenceBadge label={snapshot.evidenceSource} />
          {onRefresh ? <button className="aui-action-chip" type="button" onClick={onRefresh}><RefreshCw size={14} aria-hidden />Refresh</button> : null}
        </div>
      </header>

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
            <Metric label="evidence" value={snapshot.signalingEvidence} />
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
          <PanelTitle icon={<AlertTriangle size={18} aria-hidden />} title="Repair evidence" description="Unsupported, stale, denied, or compatibility-blocked diagnostics remain visible." />
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
  const blockers = route.providers.filter((provider) => !provider.eligible).map((provider) => `${provider.node_name}: ${provider.reason_code} (${provider.reason})`)
  return {
    module: route.module,
    state: routeState(route),
    decisionTarget: route.decision_target,
    decisionPeerId: route.decision_peer_id ?? 'local',
    routeQuality: routeQuality(route.decision_latency_ms, route.decision_target),
    latency: formatMs(route.decision_latency_ms),
    fallback: route.fallback,
    providerSummary: `${route.providers.filter((provider) => provider.eligible).length}/${route.providers.length} eligible`,
    blockers,
    reason: route.reason
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
  return 'Signaling is connected with backend-reported privacy evidence.'
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
  return blockers.length > 0 ? blockers.join(', ') : `${action.provider_kind} provider ${action.provider_id}; bindability ${action.bindability}`
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
  if (peer.pending_pairing_task) return 'pending pairing task'
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
  return routes.length ? routes.map((route) => `${route.module}:${route.reason}`).join('; ') : 'no selected route'
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
