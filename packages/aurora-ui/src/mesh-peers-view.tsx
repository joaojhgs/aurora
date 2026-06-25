'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import {
  AUTH_METHODS,
  AuroraError,
  GATEWAY_METHODS,
  routePath,
  summarizeCapabilities,
  type AuroraClient,
  type AvailabilityState,
  type CapabilitySummary,
  type DeviceResponse,
  type JsonObject,
  type MeshPeerDiagnostic,
  type MeshPeerInfo,
  type MeshRouteDiagnostic,
  type MeshStatusResponse,
  type PendingPairingEntry,
  type WebRTCDiagnosticsResponse
} from '@aurora/client'
import { EvidenceBadge, StatusBadge } from './status-badges'
import type { RouteAvailability } from './shell-data'

export type MeshPeersLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'degraded'
  | 'denied'
  | 'service-unavailable'
  | 'error'

export interface MeshPeerAdminAction {
  methodId:
    | typeof AUTH_METHODS.meshApprovePeer
    | typeof AUTH_METHODS.meshDenyPeer
    | typeof AUTH_METHODS.meshRemovePeer
  payload: JsonObject
  reason: string
  reauthConfirmed: boolean
  affectedResources: string[]
  path: string
}

export interface MeshPeerRow {
  peerId: string
  nodeName: string
  roomName: string
  lifecycleState: AvailabilityState
  lifecycleLabel: string
  trustState: AvailabilityState
  trustLabel: string
  outboundStatus: string
  inboundStatus: string
  connectionStatus: string
  fingerprint: string
  permissions: string[]
  inboundPermissions: string[]
  latencyMs: number | null
  routeQuality: string
  compatibility: string
  serviceCount: number
  services: string[]
  lastSeen: string | null
  lastEvidenceSource: string
  pendingPairing: PendingPairingEntry | null
  approveAction: MeshPeerAdminAction | null
  denyAction: MeshPeerAdminAction | null
  removeAction: MeshPeerAdminAction | null
}

export interface MeshLiveSessionRow {
  sessionId: string
  stablePeerId: string
  nodeName: string
  state: AvailabilityState
  connectionState: string
  iceState: string
  dataChannelState: string
  authState: string
  latencyMs: number | null
  identitySource: string
  permissions: string
  pairingState: string
  linkedPeerState: string
  evidenceSource: string
}

export interface MeshDeviceRow {
  deviceId: string
  name: string
  principalId: string | null
  state: AvailabilityState
  trustLabel: string
  linkedPeerId: string | null
  linkedPeerLabel: string
  lastSeen: string | null
  evidenceSource: string
}

export interface MeshPeersSnapshot {
  loadState: MeshPeersLoadState
  generatedAt: string | null
  localPeerId: string | null
  localNodeName: string
  meshEnabled: boolean
  meshStarted: boolean
  webrtcStarted: boolean
  secretsRedacted: boolean
  peers: MeshPeerRow[]
  liveSessions: MeshLiveSessionRow[]
  devices: MeshDeviceRow[]
  pendingCount: number
  approvedCount: number
  deniedCount: number
  removedCount: number
  runtimePeerCount: number
  liveSessionCount: number
  deviceCount: number
  routeCount: number
  compatibilityFailures: string[]
  listState: AvailabilityState
  listReason: string
  statusState: AvailabilityState
  statusReason: string
  mutationState: AvailabilityState
  mutationReason: string
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface MeshPeersResourceProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface MeshPeersViewProps {
  snapshot: MeshPeersSnapshot
  route: RouteAvailability
  adminReason?: string
  permissions?: string
  revokeToken?: boolean
  pendingPeerId?: string | null
  optimisticPeerId?: string | null
  mutationError?: string | null
  onAdminReasonChange?: (value: string) => void
  onPermissionsChange?: (value: string) => void
  onRevokeTokenChange?: (value: boolean) => void
  onRefresh?: () => void
  onApprovePeer?: (peer: MeshPeerRow) => void
  onDenyPeer?: (peer: MeshPeerRow) => void
  onRemovePeer?: (peer: MeshPeerRow) => void
}

const loadingSnapshot: MeshPeersSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  localPeerId: null,
  localNodeName: 'Loading Aurora mesh',
  meshEnabled: false,
  meshStarted: false,
  webrtcStarted: false,
  secretsRedacted: true,
  peers: [],
  liveSessions: [],
  devices: [],
  pendingCount: 0,
  approvedCount: 0,
  deniedCount: 0,
  removedCount: 0,
  runtimePeerCount: 0,
  liveSessionCount: 0,
  deviceCount: 0,
  routeCount: 0,
  compatibilityFailures: [],
  listState: 'pending',
  listReason: 'Loading Auth.MeshListPeers, Gateway.GetMeshStatus, WebRTC diagnostics, pairing queue, and capability catalog through AuroraClient.',
  statusState: 'pending',
  statusReason: 'Loading Gateway.GetMeshStatus through AuroraClient.',
  mutationState: 'pending',
  mutationReason: 'Loading Auth mesh peer manage capabilities before enabling AdminAction controls.',
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls'
}

export function MeshPeersResource({ client, route }: MeshPeersResourceProps) {
  const [snapshot, setSnapshot] = useState<MeshPeersSnapshot>(loadingSnapshot)
  const [adminReason, setAdminReason] = useState('Review mesh peer trust and persisted credentials')
  const [permissions, setPermissions] = useState('Gateway.use')
  const [revokeToken, setRevokeToken] = useState(true)
  const [pendingPeerId, setPendingPeerId] = useState<string | null>(null)
  const [optimisticPeerId, setOptimisticPeerId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const loadPeers = useCallback(async () => {
    setSnapshot(loadingSnapshot)
    const next = await buildMeshPeersSnapshot(client, route)
    setSnapshot(next)
  }, [client, route])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildMeshPeersSnapshot(client, route).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route])

  const runAction = useCallback(
    async (peer: MeshPeerRow, kind: 'approve' | 'deny' | 'remove') => {
      const action =
        kind === 'approve' ? buildMeshPeerAdminAction(peer, 'approve', { reason: adminReason, permissions }) :
        kind === 'deny' ? buildMeshPeerAdminAction(peer, 'deny', { reason: adminReason }) :
        buildMeshPeerAdminAction(peer, 'remove', { reason: adminReason, revokeToken })
      if (!action) return
      setPendingPeerId(peer.peerId)
      setOptimisticPeerId(peer.peerId)
      setMutationError(null)
      try {
        await client.admin.execute(action)
        await loadPeers()
      } catch (error) {
        setMutationError(meshPeerErrorMessage(error))
      } finally {
        setPendingPeerId(null)
        setOptimisticPeerId(null)
      }
    },
    [adminReason, client.admin, loadPeers, permissions, revokeToken]
  )

  return (
    <MeshPeersView
      snapshot={snapshot}
      route={route}
      adminReason={adminReason}
      permissions={permissions}
      revokeToken={revokeToken}
      pendingPeerId={pendingPeerId}
      optimisticPeerId={optimisticPeerId}
      mutationError={mutationError}
      onAdminReasonChange={setAdminReason}
      onPermissionsChange={setPermissions}
      onRevokeTokenChange={setRevokeToken}
      onRefresh={loadPeers}
      onApprovePeer={(peer) => runAction(peer, 'approve')}
      onDenyPeer={(peer) => runAction(peer, 'deny')}
      onRemovePeer={(peer) => runAction(peer, 'remove')}
    />
  )
}

export async function buildMeshPeersSnapshot(
  client: AuroraClient,
  route: RouteAvailability
): Promise<MeshPeersSnapshot> {
  const [statusResult, peersResult, pairingsResult, diagnosticsResult, devicesResult, catalogResult] = await Promise.allSettled([
    client.mesh.getStatus(),
    client.mesh.listPeers({ include_disconnected: true }),
    client.authApi.listPendingPairings({ include_non_pending: true }),
    client.registry.getWebRTCDiagnostics(),
    client.authApi.listDevices(),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true })
  ])

  const statusResponse = responseDataOrNull(statusResult)
  const peersResponse = responseDataOrNull(peersResult)
  const pairingsResponse = responseDataOrNull(pairingsResult)
  const diagnostics = valueOrNull(diagnosticsResult)
  const devicesResponse = responseDataOrNull(devicesResult)
  const catalog = valueOrNull(catalogResult)
  const summaries = catalog ? summarizeCapabilities(catalog) : []
  const listCapability = capabilityFor(AUTH_METHODS.meshListPeers, summaries)
  const statusCapability = capabilityFor(GATEWAY_METHODS.getMeshStatus, summaries)
  const mutationCapability = firstCapability([
    AUTH_METHODS.meshApprovePeer,
    AUTH_METHODS.meshDenyPeer,
    AUTH_METHODS.meshRemovePeer
  ], summaries)
  const failures = [
    failureMessage('mesh status', statusResult),
    failureMessage('mesh peers', peersResult),
    failureMessage('pairing queue', pairingsResult, true),
    failureMessage('WebRTC diagnostics', diagnosticsResult, true),
    failureMessage('Auth devices', devicesResult, true),
    failureMessage('capability catalog', catalogResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [statusResult, peersResult, catalogResult].some(isDeniedFailure)

  if (route.disabled || (!statusResponse && !peersResponse && !catalog)) {
    const message = route.disabled
      ? `Capability unavailable: ${route.explanation}`
      : 'Mesh peer lifecycle SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      listState: stateFromCapability(listCapability, denied ? 'denied' : 'unsupported'),
      statusState: stateFromCapability(statusCapability, denied ? 'denied' : 'unsupported'),
      mutationState: stateFromCapability(mutationCapability, denied ? 'denied' : 'unsupported'),
      listReason: message,
      statusReason: message,
      mutationReason: route.requiresAdminAction
        ? 'AdminAction is required, but the mesh manage capability is not routeable.'
        : message,
      warnings: failures,
      error: message,
      evidenceSource: route.disabled ? route.providerLabel : 'AuroraClient SDK error'
    }
  }

  const rows = buildMeshPeerRows({
    persistedPeers: peersResponse?.peers ?? [],
    pendingPairings: pairingsResponse?.pairings ?? [],
    status: statusResponse,
    diagnostics,
    mutationCapability
  })
  const liveSessions = buildMeshLiveSessionRows(diagnostics, statusResponse, peersResponse?.peers ?? [])
  const devices = buildMeshDeviceRows(devicesResponse?.devices ?? [], rows, liveSessions)
  const loadState: MeshPeersLoadState = denied
    ? 'denied'
    : rows.length === 0 && liveSessions.length === 0 && devices.length === 0
      ? 'empty'
      : failures.length > 0
        ? 'degraded'
        : 'ready'

  return {
    loadState,
    generatedAt: catalog?.generated_at ?? null,
    localPeerId: statusResponse?.local.peer_id ?? diagnostics?.local_mesh_peer_id ?? catalog?.local_peer_id ?? null,
    localNodeName: statusResponse?.local.node_name || diagnostics?.local_node_name || catalog?.local_node_name || 'Aurora node',
    meshEnabled: statusResponse?.local.mesh_enabled ?? diagnostics?.mesh_enabled ?? false,
    meshStarted: statusResponse?.local.mesh_started ?? false,
    webrtcStarted: statusResponse?.local.webrtc_started ?? diagnostics?.started ?? false,
    secretsRedacted: statusResponse?.secrets_redacted ?? catalog?.secrets_redacted ?? true,
    peers: rows,
    liveSessions,
    devices,
    pendingCount: rows.filter((peer) => peer.trustState === 'pending').length,
    approvedCount: rows.filter((peer) => peer.trustState === 'available-local' || peer.trustState === 'available-remote').length,
    deniedCount: rows.filter((peer) => peer.trustState === 'denied').length,
    removedCount: rows.filter((peer) => peer.outboundStatus === 'removed').length,
    runtimePeerCount: statusResponse?.peers.length ?? 0,
    liveSessionCount: liveSessions.length,
    deviceCount: devices.length,
    routeCount: statusResponse?.routes.length ?? 0,
    compatibilityFailures: statusResponse?.compatibility_failures.map((item) =>
      `${item.peer_id} ${item.module} ${item.direction}: ${item.reason}`
    ) ?? [],
    listState: stateFromCapability(listCapability, peersResponse ? 'available-local' : 'degraded'),
    listReason: capabilityReason(listCapability, 'Auth.MeshListPeers returned persisted trust records.'),
    statusState: stateFromCapability(statusCapability, statusResponse ? 'available-local' : 'degraded'),
    statusReason: capabilityReason(statusCapability, 'Gateway.GetMeshStatus returned mesh runtime diagnostics.'),
    mutationState: stateFromCapability(mutationCapability, mutationCapability ? mutationCapability.availability : 'unsupported'),
    mutationReason: capabilityReason(mutationCapability, 'Auth mesh peer mutations require AdminAction draft, confirm, and audit.'),
    warnings: failures,
    error: denied ? 'Mesh peer lifecycle access was denied by Auth or Gateway.' : null,
    evidenceSource: 'AuroraClient mesh/auth/gateway/device/capability responses'
  }
}

export function MeshPeersView({
  snapshot,
  route,
  adminReason = '',
  permissions = '',
  revokeToken = true,
  pendingPeerId = null,
  optimisticPeerId = null,
  mutationError = null,
  onAdminReasonChange,
  onPermissionsChange,
  onRevokeTokenChange,
  onRefresh,
  onApprovePeer,
  onDenyPeer,
  onRemovePeer
}: MeshPeersViewProps) {
  const controlsDisabled = route.disabled || snapshot.loadState === 'loading' || snapshot.loadState === 'denied'
  const mutationDisabled = controlsDisabled || Boolean(pendingPeerId) || !['available-local', 'available-remote', 'degraded'].includes(snapshot.mutationState)
  return (
    <section className="aui-mesh" aria-labelledby="mesh-peers-title">
      <header className="aui-mesh-header">
        <div>
          <p className="aui-kicker">Mesh trust</p>
          <h1 id="mesh-peers-title">Mesh peers</h1>
          <p>Active WebRTC sessions, persisted Auth peer records, and device records are rendered as separate backend-proven surfaces.</p>
        </div>
        <div className="aui-mesh-badges" aria-label="Mesh evidence">
          <StatusBadge state={snapshot.loadState === 'loading' ? 'pending' : snapshot.listState} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <EvidenceBadge label={snapshot.localPeerId ?? 'local peer pending'} />
        </div>
      </header>

      <dl className="aui-mesh-summary">
        <MeshFact label="Local node" value={`${snapshot.localNodeName} / ${snapshot.localPeerId ?? 'not reported'}`} />
        <MeshFact label="Runtime" value={`mesh=${snapshot.meshEnabled ? 'enabled' : 'disabled'} started=${snapshot.meshStarted ? 'yes' : 'no'} webrtc=${snapshot.webrtcStarted ? 'yes' : 'no'}`} />
        <MeshFact label="Trust states" value={`${snapshot.pendingCount} pending / ${snapshot.approvedCount} approved / ${snapshot.deniedCount} denied / ${snapshot.removedCount} removed`} />
        <MeshFact label="Diagnostics" value={`${snapshot.liveSessionCount} live sessions / ${snapshot.runtimePeerCount} runtime peers / ${snapshot.routeCount} routes`} />
        <MeshFact label="Devices" value={`${snapshot.deviceCount} Auth device records`} />
      </dl>

      <section className="aui-mesh-controls" aria-label="Mesh peer controls">
        <label>
          <span>AdminAction reason</span>
          <textarea
            value={adminReason}
            disabled={controlsDisabled}
            rows={2}
            onChange={(event) => onAdminReasonChange?.(event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Approve permissions</span>
          <input
            value={permissions}
            disabled={controlsDisabled}
            placeholder="Gateway.use, TTS.use"
            onChange={(event) => onPermissionsChange?.(event.currentTarget.value)}
          />
        </label>
        <label className="aui-inline-field">
          <input
            type="checkbox"
            checked={revokeToken}
            disabled={controlsDisabled}
            onChange={(event) => onRevokeTokenChange?.(event.currentTarget.checked)}
          />
          <span>Revoke issued token on remove</span>
        </label>
        <button className="aui-button" type="button" disabled={controlsDisabled} onClick={onRefresh}>
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </button>
      </section>

      <MeshStatusPanel snapshot={snapshot} route={route} />

      {mutationError ? <p className="aui-message aui-message-danger" role="alert">{mutationError}</p> : null}
      {snapshot.error ? <p className="aui-message aui-message-danger" role="alert">{snapshot.error}</p> : null}
      {snapshot.loadState === 'loading' ? <p className="aui-message" aria-live="polite">Loading mesh peers from AuroraClient.</p> : null}
      {snapshot.loadState === 'empty' ? <p className="aui-message">No active WebRTC sessions, persisted mesh peers, pending pairings, or device records were reported by the backend.</p> : null}

      <MeshLiveSessionsPanel sessions={snapshot.liveSessions} />
      <MeshDevicesPanel devices={snapshot.devices} />

      <section className="aui-mesh-list" aria-label="Persisted mesh peer lifecycle">
        {snapshot.peers.map((peer) => {
          const optimistic = optimisticPeerId === peer.peerId
          const pending = pendingPeerId === peer.peerId
          return (
            <article className={`aui-mesh-card aui-mesh-card-${peer.trustState}`} data-state={optimistic ? 'optimistic' : undefined} key={peer.peerId}>
              <header>
                <div>
                  <p className="aui-kicker">{peer.roomName || 'mesh room not reported'}</p>
                  <h2>{peer.nodeName}</h2>
                  <code>{peer.peerId}</code>
                </div>
                <div className="aui-mesh-card-badges">
                  <StatusBadge state={optimistic ? 'pending' : peer.trustState} />
                  <StatusBadge state={peer.lifecycleState} />
                </div>
              </header>
              <dl className="aui-mesh-meta">
                <MeshFact label="Fingerprint" value={peer.fingerprint} />
                <MeshFact label="Trust" value={peer.trustLabel} />
                <MeshFact label="Connection" value={`${peer.connectionStatus}; ${peer.lifecycleLabel}`} />
                <MeshFact label="Route quality" value={peer.routeQuality} />
                <MeshFact label="Latency" value={peer.latencyMs === null ? 'not reported' : `${peer.latencyMs} ms`} />
                <MeshFact label="Compatibility" value={peer.compatibility} />
                <MeshFact label="Last seen" value={formatDate(peer.lastSeen)} />
                <MeshFact label="Evidence" value={peer.lastEvidenceSource} />
              </dl>
              <div className="aui-mesh-scopes" aria-label={`${peer.nodeName} permission scopes`}>
                <div>
                  <strong>Outbound scopes</strong>
                  <span>{peer.permissions.join(', ') || 'none granted'}</span>
                </div>
                <div>
                  <strong>Inbound scopes</strong>
                  <span>{peer.inboundPermissions.join(', ') || 'none granted'}</span>
                </div>
                <div>
                  <strong>Services</strong>
                  <span>{peer.services.join(', ') || 'none advertised'}</span>
                </div>
              </div>
              <div className="aui-mesh-actions">
                <button
                  type="button"
                  disabled={mutationDisabled || !peer.approveAction || pending}
                  onClick={() => onApprovePeer?.(peer)}
                >
                  <CheckCircle2 size={16} aria-hidden="true" />
                  {pending ? 'Submitting AdminAction' : 'AdminAction approve'}
                </button>
                <button
                  type="button"
                  disabled={mutationDisabled || !peer.denyAction || pending}
                  onClick={() => onDenyPeer?.(peer)}
                >
                  <XCircle size={16} aria-hidden="true" />
                  {pending ? 'Submitting AdminAction' : 'AdminAction deny'}
                </button>
                <button
                  type="button"
                  disabled={mutationDisabled || !peer.removeAction || pending}
                  onClick={() => onRemovePeer?.(peer)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  {pending ? 'Submitting AdminAction' : 'AdminAction remove'}
                </button>
              </div>
            </article>
          )
        })}
      </section>
    </section>
  )
}

function MeshLiveSessionsPanel({ sessions }: { sessions: MeshLiveSessionRow[] }) {
  return (
    <section className="aui-mesh-panel" aria-labelledby="mesh-live-sessions-title">
      <div className="aui-mesh-panel-title">
        <span><ShieldCheck size={18} aria-hidden="true" /></span>
        <div>
          <h2 id="mesh-live-sessions-title">Active WebRTC sessions</h2>
          <p>Transport session IDs stay separate from stable Auth mesh peer identity.</p>
        </div>
      </div>
      {sessions.length === 0 ? <p className="aui-message">No active WebRTC session evidence was reported.</p> : (
        <div className="aui-mesh-row-list">
          {sessions.map((session) => (
            <article className="aui-mesh-row" key={session.sessionId}>
              <header>
                <div>
                  <p className="aui-kicker">{session.sessionId}</p>
                  <h3>{session.nodeName}</h3>
                  <code>{session.stablePeerId}</code>
                </div>
                <StatusBadge state={session.state} />
              </header>
              <dl className="aui-mesh-meta">
                <MeshFact label="Connection" value={`${session.connectionState}; ICE ${session.iceState}; channel ${session.dataChannelState}`} />
                <MeshFact label="Auth" value={session.authState} />
                <MeshFact label="Latency" value={session.latencyMs === null ? 'not reported' : `${session.latencyMs} ms`} />
                <MeshFact label="Pairing" value={session.pairingState} />
                <MeshFact label="Linked peer" value={session.linkedPeerState} />
                <MeshFact label="Permissions" value={session.permissions} />
                <MeshFact label="Identity source" value={session.identitySource} />
                <MeshFact label="Evidence" value={session.evidenceSource} />
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function MeshDevicesPanel({ devices }: { devices: MeshDeviceRow[] }) {
  return (
    <section className="aui-mesh-panel" aria-labelledby="mesh-devices-title">
      <div className="aui-mesh-panel-title">
        <span><ShieldCheck size={18} aria-hidden="true" /></span>
        <div>
          <h2 id="mesh-devices-title">Auth device records</h2>
          <p>Device trust is shown separately from mesh peer trust and live WebRTC transport state.</p>
        </div>
      </div>
      {devices.length === 0 ? <p className="aui-message">No Auth device records were reported for this mesh view.</p> : (
        <div className="aui-mesh-row-list">
          {devices.map((device) => (
            <article className="aui-mesh-row" key={device.deviceId}>
              <header>
                <div>
                  <p className="aui-kicker">{device.principalId ?? 'principal not reported'}</p>
                  <h3>{device.name}</h3>
                  <code>{device.deviceId}</code>
                </div>
                <StatusBadge state={device.state} />
              </header>
              <dl className="aui-mesh-meta">
                <MeshFact label="Device trust" value={device.trustLabel} />
                <MeshFact label="Linked peer" value={device.linkedPeerLabel} />
                <MeshFact label="Stable peer ID" value={device.linkedPeerId ?? 'not linked by backend evidence'} />
                <MeshFact label="Last seen" value={formatDate(device.lastSeen)} />
                <MeshFact label="Evidence" value={device.evidenceSource} />
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function MeshStatusPanel({ snapshot, route }: { snapshot: MeshPeersSnapshot; route: RouteAvailability }) {
  return (
    <section className="aui-mesh-panel" aria-labelledby="mesh-state-title">
      <div className="aui-mesh-panel-title">
        <span><ShieldCheck size={18} aria-hidden="true" /></span>
        <div>
          <h2 id="mesh-state-title">Backend evidence</h2>
          <p>{snapshot.evidenceSource}</p>
        </div>
      </div>
      <dl className="aui-mesh-meta">
        <MeshFact label="Peer list" value={`${snapshot.listState}: ${snapshot.listReason}`} />
        <MeshFact label="Mesh status" value={`${snapshot.statusState}: ${snapshot.statusReason}`} />
        <MeshFact label="Mutations" value={`${snapshot.mutationState}: ${snapshot.mutationReason}`} />
        <MeshFact label="Route feature" value={`${route.state}: ${route.explanation}`} />
      </dl>
      {snapshot.compatibilityFailures.length > 0 || snapshot.warnings.length > 0 ? (
        <ul className="aui-mesh-warnings" aria-label="Mesh peer warnings">
          {[...snapshot.compatibilityFailures, ...snapshot.warnings].map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function buildMeshLiveSessionRows(
  diagnostics: WebRTCDiagnosticsResponse | null,
  status: MeshStatusResponse | null,
  persistedPeers: MeshPeerInfo[]
): MeshLiveSessionRow[] {
  return (diagnostics?.peers ?? []).map((session) => {
    const runtime = status?.peers.find((peer) => peer.peer_id === session.stable_peer_id) ?? null
    const persisted = persistedPeers.find((peer) => peer.peer_id === session.stable_peer_id) ?? null
    return {
      sessionId: session.signaling_peer_id,
      stablePeerId: session.stable_peer_id,
      nodeName: session.node_name || runtime?.node_name || persisted?.node_name || 'Unnamed WebRTC session',
      state: liveSessionState(session, runtime, persisted),
      connectionState: session.connection_state,
      iceState: session.ice_connection_state,
      dataChannelState: session.data_channel_state,
      authState: session.auth_state,
      latencyMs: session.rtt_ms ?? runtime?.latency_ms ?? null,
      identitySource: session.identity_source,
      permissions: `${session.effective_permission_count} effective permissions${session.is_admin ? '; admin principal' : ''}`,
      pairingState: [
        session.pairing_active ? 'pairing active' : null,
        session.auth_timeout_pending ? 'auth timeout pending' : null,
        session.pending_pairing_task ? 'pending pairing task' : null
      ].filter(Boolean).join('; ') || 'no pairing task reported',
      linkedPeerState: persisted
        ? `Auth peer ${persisted.outbound_status}/${persisted.inbound_status}`
        : runtime
          ? `runtime peer ${runtime.status}`
          : 'no persisted peer record',
      evidenceSource: 'Gateway.GetWebRTCDiagnostics'
    }
  })
}

function buildMeshDeviceRows(
  devices: DeviceResponse[],
  peers: MeshPeerRow[],
  sessions: MeshLiveSessionRow[]
): MeshDeviceRow[] {
  return devices.map((device) => {
    const linkedPeer = matchDevicePeer(device, peers, sessions)
    return {
      deviceId: device.id,
      name: device.name,
      principalId: device.user_id ?? null,
      state: device.is_trusted ? 'available-local' : 'denied',
      trustLabel: device.is_trusted ? 'trusted Auth device' : 'untrusted Auth device',
      linkedPeerId: linkedPeer?.peerId ?? null,
      linkedPeerLabel: linkedPeer ? `${linkedPeer.nodeName} (${linkedPeer.source})` : 'not linked to a mesh peer by backend evidence',
      lastSeen: device.last_seen ?? null,
      evidenceSource: 'Auth.ListDevices'
    }
  })
}

function matchDevicePeer(
  device: DeviceResponse,
  peers: MeshPeerRow[],
  sessions: MeshLiveSessionRow[]
): { peerId: string; nodeName: string; source: string } | null {
  const fields = [device.id, device.name, device.user_id ?? ''].map(normalizedMatchText).filter(Boolean)
  for (const session of sessions) {
    const sessionTokens = [session.stablePeerId, session.nodeName, session.sessionId].map(normalizedMatchText)
    if (sessionTokens.some((token) => token && fields.some((field) => field.includes(token) || token.includes(field)))) {
      return { peerId: session.stablePeerId, nodeName: session.nodeName, source: 'live WebRTC session' }
    }
  }
  for (const peer of peers) {
    const peerTokens = [peer.peerId, peer.nodeName].map(normalizedMatchText)
    if (peerTokens.some((token) => token && fields.some((field) => field.includes(token) || token.includes(field)))) {
      return { peerId: peer.peerId, nodeName: peer.nodeName, source: 'persisted peer record' }
    }
  }
  return null
}

function buildMeshPeerRows(input: {
  persistedPeers: MeshPeerInfo[]
  pendingPairings: PendingPairingEntry[]
  status: MeshStatusResponse | null
  diagnostics: WebRTCDiagnosticsResponse | null
  mutationCapability: CapabilitySummary | null
}): MeshPeerRow[] {
  const runtimeByPeer = new Map(input.status?.peers.map((peer) => [peer.peer_id, peer]) ?? [])
  const pairingByPeer = new Map(input.pendingPairings.filter((entry) => entry.remote_peer_id).map((entry) => [entry.remote_peer_id, entry]))
  const peerIds = new Set<string>([
    ...input.persistedPeers.map((peer) => peer.peer_id),
    ...runtimeByPeer.keys(),
    ...pairingByPeer.keys()
  ])
  return [...peerIds].sort().map((peerId) => {
    const persisted = input.persistedPeers.find((peer) => peer.peer_id === peerId) ?? null
    const runtime = runtimeByPeer.get(peerId) ?? null
    const pairing = pairingByPeer.get(peerId) ?? null
    return buildMeshPeerRow(peerId, persisted, runtime, pairing, input.status?.routes ?? [], input.diagnostics, input.mutationCapability)
  })
}

function liveSessionState(
  session: WebRTCDiagnosticsResponse['peers'][number],
  runtime: MeshPeerDiagnostic | null,
  persisted: MeshPeerInfo | null
): AvailabilityState {
  if (session.auth_state === 'denied' || session.auth_state === 'failed') return 'denied'
  if (runtime?.status === 'stale') return 'stale'
  if (session.connection_state === 'connected' && session.data_channel_state === 'open' && session.auth_state === 'authenticated') {
    return persisted?.outbound_status === 'approved' || runtime?.status === 'authenticated' ? 'available-remote' : 'pending'
  }
  if (session.pairing_active || session.pending_pairing_task || session.auth_timeout_pending) return 'pending'
  if (session.connection_state === 'disconnected' || session.ice_connection_state === 'failed') return 'stale'
  return 'degraded'
}

function normalizedMatchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function buildMeshPeerRow(
  peerId: string,
  persisted: MeshPeerInfo | null,
  runtime: MeshPeerDiagnostic | null,
  pairing: PendingPairingEntry | null,
  routes: MeshRouteDiagnostic[],
  diagnostics: WebRTCDiagnosticsResponse | null,
  mutationCapability: CapabilitySummary | null
): MeshPeerRow {
  const outboundStatus = persisted?.outbound_status ?? pairing?.status ?? 'unknown'
  const inboundStatus = persisted?.inbound_status ?? 'unknown'
  const trustState = trustStateFor(outboundStatus, inboundStatus)
  const lifecycleState = lifecycleStateFor(runtime?.status, persisted?.connection_status)
  const services = runtime?.services.map((service) => `${service.module}@${service.version || 'unknown'}`) ?? []
  const routeQuality = routeQualityFor(peerId, routes)
  const compatibility = compatibilityFor(runtime)
  const canMutate = mutationCapability ? ['available-local', 'available-remote', 'degraded'].includes(mutationCapability.availability) : true
  const base: Omit<MeshPeerRow, 'approveAction' | 'denyAction' | 'removeAction'> = {
    peerId,
    nodeName: persisted?.node_name || runtime?.node_name || pairing?.remote_node_name || 'Unnamed mesh peer',
    roomName: persisted?.room_name ?? 'not reported',
    lifecycleState,
    lifecycleLabel: runtime?.status ?? persisted?.connection_status ?? 'no runtime evidence',
    trustState,
    trustLabel: `outbound=${outboundStatus}; inbound=${inboundStatus}`,
    outboundStatus,
    inboundStatus,
    connectionStatus: persisted?.connection_status ?? webrtcConnectionFor(peerId, diagnostics) ?? 'not reported',
    fingerprint: peerId,
    permissions: persisted?.outbound_permissions ?? pairing?.granted_permissions ?? [],
    inboundPermissions: persisted?.inbound_permissions ?? [],
    latencyMs: runtime?.latency_ms ?? webrtcLatencyFor(peerId, diagnostics),
    routeQuality,
    compatibility,
    serviceCount: runtime?.services.length ?? 0,
    services,
    lastSeen: persisted?.last_seen_at ?? null,
    lastEvidenceSource: evidenceFor(persisted, runtime, pairing, diagnostics),
    pendingPairing: pairing ?? null
  }
  return {
    ...base,
    approveAction: canMutate && outboundStatus !== 'approved' ? buildMeshPeerAdminAction(base, 'approve', { reason: 'Approve mesh peer', permissions: base.permissions.join(', ') }) : null,
    denyAction: canMutate && outboundStatus !== 'denied' ? buildMeshPeerAdminAction(base, 'deny', { reason: 'Deny mesh peer' }) : null,
    removeAction: canMutate && outboundStatus !== 'removed' ? buildMeshPeerAdminAction(base, 'remove', { reason: 'Remove mesh peer', revokeToken: true }) : null
  }
}

export function buildMeshPeerAdminAction(
  peer: Pick<MeshPeerRow, 'peerId' | 'nodeName'>,
  action: 'approve' | 'deny' | 'remove',
  input: { reason: string; permissions?: string; revokeToken?: boolean }
): MeshPeerAdminAction | null {
  const reason = input.reason.trim() || `${action} mesh peer ${peer.peerId}`
  if (action === 'approve') {
    return {
      methodId: AUTH_METHODS.meshApprovePeer,
      payload: { peer_id: peer.peerId, permissions: parseMeshPermissionList(input.permissions ?? '') ?? [] },
      reason,
      reauthConfirmed: true,
      affectedResources: [`mesh-peer:${peer.peerId}`, `peer:${peer.nodeName}`],
      path: routePath('Auth', 'MeshApprovePeer')
    }
  }
  if (action === 'deny') {
    return {
      methodId: AUTH_METHODS.meshDenyPeer,
      payload: { peer_id: peer.peerId },
      reason,
      reauthConfirmed: true,
      affectedResources: [`mesh-peer:${peer.peerId}`],
      path: routePath('Auth', 'MeshDenyPeer')
    }
  }
  return {
    methodId: AUTH_METHODS.meshRemovePeer,
    payload: { peer_id: peer.peerId, revoke_token: input.revokeToken ?? true },
    reason,
    reauthConfirmed: true,
    affectedResources: [`mesh-peer:${peer.peerId}`],
    path: routePath('Auth', 'MeshRemovePeer')
  }
}

export function parseMeshPermissionList(value: string): string[] | null {
  const permissions = value.split(/[\s,]+/).map((permission) => permission.trim()).filter(Boolean)
  return permissions.length > 0 ? permissions : null
}

export function meshPeerErrorMessage(error: unknown): string {
  if (error instanceof AuroraError) {
    if (error.code === 'permission' || error.code === 'auth') return `Permission denied by Auth: ${error.message}`
    if (error.code === 'unavailable_service') return `Mesh peer service unavailable: ${error.message}`
    if (error.code === 'unsupported_feature') return `Mesh peer lifecycle unsupported by this backend: ${error.message}`
    if (error.code === 'timeout') return `AuroraClient request timed out: ${error.message}`
    return error.message
  }
  return error instanceof Error ? error.message : 'Unknown mesh peer lifecycle error'
}

function MeshFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function responseDataOrNull<T>(result: PromiseSettledResult<{ ok: boolean; data?: T }>): T | null {
  return result.status === 'fulfilled' && result.value.ok ? result.value.data ?? null : null
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function failureMessage(label: string, result: PromiseSettledResult<unknown>, optional = false): string | null {
  if (result.status === 'fulfilled') {
    const value = result.value as { ok?: boolean; error?: unknown } | undefined
    if (value?.ok === false) return `${label}: ${meshPeerErrorMessage(value.error)}`
    return null
  }
  return optional ? `${label} unavailable: ${meshPeerErrorMessage(result.reason)}` : `${label}: ${meshPeerErrorMessage(result.reason)}`
}

function isDeniedFailure(result: PromiseSettledResult<unknown>): boolean {
  const error = result.status === 'fulfilled'
    ? (result.value as { ok?: boolean; error?: unknown }).error
    : result.reason
  return error instanceof AuroraError && (error.code === 'permission' || error.code === 'auth')
}

function capabilityFor(methodId: string, capabilities: CapabilitySummary[]): CapabilitySummary | null {
  return capabilities.find((capability) => capability.busTopic === methodId || capability.id === methodId) ?? null
}

function firstCapability(methodIds: string[], capabilities: CapabilitySummary[]): CapabilitySummary | null {
  for (const methodId of methodIds) {
    const capability = capabilityFor(methodId, capabilities)
    if (capability) return capability
  }
  return null
}

function stateFromCapability(capability: CapabilitySummary | null, fallback: AvailabilityState): AvailabilityState {
  return capability?.availability ?? fallback
}

function capabilityReason(capability: CapabilitySummary | null, fallback: string): string {
  if (!capability) return fallback
  const blockers = capability.routeBlockers.length > 0 ? ` blockers=${capability.routeBlockers.join(',')}` : ''
  return `${capability.busTopic ?? capability.id} is ${capability.availability}.${blockers}`
}

function trustStateFor(outbound: string, inbound: string): AvailabilityState {
  if (outbound === 'approved' && inbound === 'approved') return 'available-remote'
  if (outbound === 'approved') return 'available-local'
  if (outbound === 'denied' || inbound === 'denied') return 'denied'
  if (outbound === 'removed') return 'unsupported'
  if (outbound === 'pending' || inbound === 'pending') return 'pending'
  return 'degraded'
}

function lifecycleStateFor(runtimeStatus: string | undefined, connectionStatus: string | undefined): AvailabilityState {
  if (runtimeStatus === 'stale') return 'stale'
  if (runtimeStatus === 'negotiated' || runtimeStatus === 'authenticated') return 'available-remote'
  if (runtimeStatus === 'connected' || connectionStatus === 'connected') return 'pending'
  if (connectionStatus === 'disconnected') return 'stale'
  return 'degraded'
}

function routeQualityFor(peerId: string, routes: MeshRouteDiagnostic[]): string {
  const selected = routes.filter((route) => route.decision_peer_id === peerId)
  const candidates = routes.flatMap((route) => route.providers.filter((provider) => provider.peer_id === peerId))
  if (selected.length > 0) return selected.map((route) => `${route.module}: ${route.decision_target} ${route.reason}`).join('; ')
  if (candidates.length > 0) return candidates.map((candidate) => `${candidate.reason_code || 'candidate'} ${candidate.reason}`).join('; ')
  return 'no route evidence'
}

function compatibilityFor(peer: MeshPeerDiagnostic | null): string {
  if (!peer) return 'no manifest compatibility evidence'
  const c = peer.compatibility
  const failures = [...c.local_incompatible, ...c.remote_incompatible]
  if (failures.length > 0) return `incompatible: ${failures.join(', ')}`
  const compatible = [...c.local_compatible, ...c.remote_compatible]
  return compatible.length > 0 ? `compatible: ${compatible.join(', ')}` : 'no compatible services reported'
}

function webrtcConnectionFor(peerId: string, diagnostics: WebRTCDiagnosticsResponse | null): string | null {
  const peer = diagnostics?.peers.find((candidate) => candidate.stable_peer_id === peerId)
  return peer ? `${peer.connection_state}/${peer.data_channel_state}/${peer.auth_state}` : null
}

function webrtcLatencyFor(peerId: string, diagnostics: WebRTCDiagnosticsResponse | null): number | null {
  return diagnostics?.peers.find((candidate) => candidate.stable_peer_id === peerId)?.rtt_ms ?? null
}

function evidenceFor(
  persisted: MeshPeerInfo | null,
  runtime: MeshPeerDiagnostic | null,
  pairing: PendingPairingEntry | null,
  diagnostics: WebRTCDiagnosticsResponse | null
): string {
  const sources = [
    persisted ? 'Auth.MeshListPeers' : null,
    runtime ? 'Gateway.GetMeshStatus' : null,
    pairing ? 'Auth.ListPendingPairings' : null,
    diagnostics?.peers.some((peer) => peer.stable_peer_id === (persisted?.peer_id ?? runtime?.peer_id ?? pairing?.remote_peer_id)) ? 'Gateway.GetWebRTCDiagnostics' : null
  ].filter(Boolean)
  return sources.join(', ') || 'no backend evidence'
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'not reported'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp))
}
