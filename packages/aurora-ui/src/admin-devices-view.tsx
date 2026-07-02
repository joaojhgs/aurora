'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, Laptop, Link2, Lock, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import {
  AUTH_METHODS,
  AuroraError,
  routePath,
  summarizeCapabilities,
  type AuroraClient,
  type AvailabilityState,
  type CapabilityCatalogResponse,
  type CapabilitySummary,
  type DeviceResponse,
  type JsonObject,
  type ListPendingPairingsResponse,
  type MeshPeerInfo,
  type NativeCapabilityManifest,
  type PendingPairingEntry,
  type TokenResponse
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type AdminDevicesLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'degraded'
  | 'denied'
  | 'service-unavailable'
  | 'error'

export interface AdminDeviceAction {
  methodId:
    | typeof AUTH_METHODS.deleteDevice
    | typeof AUTH_METHODS.pairingApprove
    | typeof AUTH_METHODS.pairingDeny
    | typeof AUTH_METHODS.meshApprovePeer
    | typeof AUTH_METHODS.meshRemovePeer
  payload: JsonObject
  reason: string
  reauthConfirmed: boolean
  affectedResources: string[]
  path: string
}

export interface AdminDeviceTokenRow {
  id: string
  prefix: string
  scopes: string[]
  createdAt: string | null
  expiresAt: string | null
  state: AvailabilityState
}

export interface AdminDeviceRow {
  id: string
  name: string
  principalId: string | null
  trustState: AvailabilityState
  trustLabel: string
  createdAt: string | null
  lastSeen: string | null
  platformLabel: string
  platformEvidence: string
  activeTokens: AdminDeviceTokenRow[]
  tokenCount: number
  activeSessionCount: number
  deleteState: AvailabilityState
  deleteReason: string
  deleteAction: AdminDeviceAction | null
  trustAction: AdminDeviceAction | null
  linkedMeshPeerId: string | null
  linkedMeshPeerLabel: string
  meshPeerState: AvailabilityState
  meshPeerEvidence: string
}

export interface AdminPendingPairingRow {
  requestId: string
  deviceName: string
  remotePeerId: string
  remoteNodeName: string
  clientIp: string
  status: string
  expiresAt: string
  permissionCount: number
  adminRequested: boolean
  linkedMeshPeerId: string | null
  linkedMeshPeerLabel: string
  linkedMeshPeerState: AvailabilityState
  approveAction: AdminDeviceAction | null
  denyAction: AdminDeviceAction | null
}

export interface AdminDevicesSnapshot {
  loadState: AdminDevicesLoadState
  generatedAt: string | null
  secretsRedacted: boolean
  devices: AdminDeviceRow[]
  pendingPairings: AdminPendingPairingRow[]
  listState: AvailabilityState
  listReason: string
  tokenState: AvailabilityState
  tokenReason: string
  pairingState: AvailabilityState
  pairingReason: string
  deleteState: AvailabilityState
  deleteReason: string
  meshPeerState?: AvailabilityState
  meshPeerReason?: string
  meshPeerActionState?: AvailabilityState
  meshPeerActionReason?: string
  nativePlatform: string | null
  nativeCapabilities: string[]
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface AdminDevicesResourceProps {
  client: AuroraClient
}

export interface AdminDevicesViewProps {
  snapshot: AdminDevicesSnapshot
  adminReason?: string
  pendingDeviceId?: string | null
  mutationError?: string | null
  optimisticDeviceId?: string | null
  reauthConfirmed?: boolean
  onAdminReasonChange?: (value: string) => void
  onReauthConfirmedChange?: (value: boolean) => void
  onRefresh?: () => void
  onDeleteDevice?: (device: AdminDeviceRow) => void
  onRunAdminAction?: (action: AdminDeviceAction, optimisticId: string) => void
}

const loadingSnapshot: AdminDevicesSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  devices: [],
  pendingPairings: [],
  listState: 'pending',
  listReason: 'Loading Auth.ListDevices, Auth.ListTokens, capability catalog, and native manifest through AuroraClient.',
  tokenState: 'pending',
  tokenReason: 'Loading token/session evidence through AuroraClient.',
  pairingState: 'pending',
  pairingReason: 'Loading Auth.ListPendingPairings through AuroraClient.',
  deleteState: 'pending',
  deleteReason: 'Loading Auth.DeleteDevice capability before enabling mutations.',
  meshPeerState: 'pending',
  meshPeerReason: 'Loading Auth.MeshListPeers for device-to-peer linkage.',
  meshPeerActionState: 'pending',
  meshPeerActionReason: 'Loading Auth.MeshApprovePeer/Auth.MeshRemovePeer AdminAction capabilities before enabling trust actions.',
  nativePlatform: null,
  nativeCapabilities: [],
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls'
}

export function AdminDevicesResource({ client }: AdminDevicesResourceProps) {
  const [snapshot, setSnapshot] = useState<AdminDevicesSnapshot>(loadingSnapshot)
  const [adminReason, setAdminReason] = useState('Remove device and revoke its local session access')
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [optimisticDeviceId, setOptimisticDeviceId] = useState<string | null>(null)

  const loadDevices = useCallback(async () => {
    setSnapshot(loadingSnapshot)
    const next = await buildAdminDevicesSnapshot(client)
    setSnapshot(next)
  }, [client])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildAdminDevicesSnapshot(client).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  const runAdminAction = useCallback(
    async (action: AdminDeviceAction, optimisticId: string) => {
      setPendingDeviceId(optimisticId)
      setOptimisticDeviceId(optimisticId)
      setMutationError(null)
      const reason = adminReason.trim() || action.reason
      try {
        await client.admin.execute({ ...action, reason, reauthConfirmed })
        await loadDevices()
      } catch (error) {
        setMutationError(deviceMutationErrorMessage(error))
      } finally {
        setPendingDeviceId(null)
        setOptimisticDeviceId(null)
      }
    },
    [adminReason, client.admin, loadDevices, reauthConfirmed]
  )

  const deleteDevice = useCallback(
    async (device: AdminDeviceRow) => {
      if (!device.deleteAction) return
      await runAdminAction(device.deleteAction, device.id)
    },
    [runAdminAction]
  )

  return (
    <AdminDevicesView
      snapshot={snapshot}
      adminReason={adminReason}
      reauthConfirmed={reauthConfirmed}
      onAdminReasonChange={setAdminReason}
      onReauthConfirmedChange={setReauthConfirmed}
      pendingDeviceId={pendingDeviceId}
      mutationError={mutationError}
      optimisticDeviceId={optimisticDeviceId}
      onRefresh={loadDevices}
      onDeleteDevice={deleteDevice}
      onRunAdminAction={runAdminAction}
    />
  )
}

export async function buildAdminDevicesSnapshot(client: AuroraClient): Promise<AdminDevicesSnapshot> {
  const [devicesResult, tokensResult, pairingsResult, meshPeersResult, catalogResult, nativeResult] = await Promise.allSettled([
    client.authApi.listDevices(),
    client.authApi.listTokens(),
    client.authApi.listPendingPairings(),
    client.mesh.listPeers({ include_disconnected: true }),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true, include_schemas: true }),
    client.native.getManifest()
  ])

  const devicesResponse = responseDataOrNull(devicesResult)
  const tokensResponse = responseDataOrNull(tokensResult)
  const pairingsResponse = responseDataOrNull(pairingsResult)
  const meshPeersResponse = responseDataOrNull(meshPeersResult)
  const capabilityCatalog = valueOrNull(catalogResult)
  const nativeManifest = valueOrNull(nativeResult)
  const summaries = capabilityCatalog ? summarizeCapabilities(capabilityCatalog) : []
  const listCapability = capabilityFor(AUTH_METHODS.listDevices, summaries)
  const tokenCapability = capabilityFor(AUTH_METHODS.listTokens, summaries)
  const pairingCapability = capabilityFor(AUTH_METHODS.listPendingPairings, summaries)
  const deleteCapability = capabilityFor(AUTH_METHODS.deleteDevice, summaries)
  const meshListCapability = capabilityFor(AUTH_METHODS.meshListPeers, summaries)
  const meshApproveCapability = capabilityFor(AUTH_METHODS.meshApprovePeer, summaries)
  const meshRemoveCapability = capabilityFor(AUTH_METHODS.meshRemovePeer, summaries)
  const failures = [
    failureMessage('devices', devicesResult),
    failureMessage('tokens', tokensResult),
    failureMessage('pending pairings', pairingsResult),
    failureMessage('mesh peers', meshPeersResult),
    failureMessage('capability catalog', catalogResult),
    failureMessage('native manifest', nativeResult, true)
  ].filter((message): message is string => Boolean(message))
  const denied = [devicesResult, tokensResult, pairingsResult, catalogResult].some(isDeniedFailure)

  if (!devicesResponse && !tokensResponse && !pairingsResponse && !capabilityCatalog) {
    const message = 'Auth device/session SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      listState: denied ? 'denied' : 'unsupported',
      tokenState: denied ? 'denied' : 'unsupported',
      pairingState: denied ? 'denied' : 'unsupported',
      deleteState: denied ? 'denied' : 'unsupported',
      meshPeerState: denied ? 'denied' : 'unsupported',
      meshPeerActionState: denied ? 'denied' : 'unsupported',
      listReason: message,
      tokenReason: message,
      pairingReason: message,
      deleteReason: message,
      meshPeerReason: message,
      meshPeerActionReason: message,
      error: message,
      warnings: failures,
      evidenceSource: 'AuroraClient SDK error'
    }
  }

  const tokenRows = tokensResponse?.tokens ?? []
  const meshPeers = meshPeersResponse?.peers ?? []
  const pairingActionAvailable = Boolean(pairingsResponse)
  const meshPeerActionCapability = meshApproveCapability ?? meshRemoveCapability
  const meshPeerActionState = meshPeerActionCapability?.availability ?? (meshPeersResponse ? 'available-local' : denied ? 'denied' : 'unsupported')
  const pendingPairings = buildPendingPairingRows(pairingsResponse, meshPeers, pairingActionAvailable)
  const devices = (devicesResponse?.devices ?? []).map((device) =>
    buildDeviceRow(device, tokenRows, deleteCapability, nativeManifest, meshPeers, pairingsResponse?.pairings ?? [], meshPeerActionState)
  )
  const loadState: AdminDevicesLoadState = denied
    ? 'denied'
    : failures.filter((message) => !message.includes('native manifest')).length > 0
      ? 'degraded'
      : devices.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    generatedAt: capabilityCatalog?.generated_at ?? null,
    secretsRedacted: Boolean((capabilityCatalog?.secrets_redacted ?? true) && (pairingsResponse?.secrets_redacted ?? true)),
    devices,
    pendingPairings,
    listState: listCapability?.availability ?? (denied ? 'denied' : 'unsupported'),
    listReason: listCapability ? capabilityReason(listCapability) : 'Auth.ListDevices is not advertised by the capability catalog.',
    tokenState: tokenCapability?.availability ?? (tokensResponse ? 'available-local' : denied ? 'denied' : 'unsupported'),
    tokenReason: tokenCapability ? capabilityReason(tokenCapability) : 'Auth.ListTokens token/session evidence is not advertised by the capability catalog.',
    pairingState: pairingCapability?.availability ?? (pairingsResponse ? 'available-local' : denied ? 'denied' : 'unsupported'),
    pairingReason: pairingCapability ? capabilityReason(pairingCapability) : 'Auth.ListPendingPairings is not advertised by the capability catalog.',
    deleteState: deleteCapability?.availability ?? (denied ? 'denied' : 'unsupported'),
    deleteReason: deleteCapability ? capabilityReason(deleteCapability) : 'Auth.DeleteDevice is not advertised by the capability catalog.',
    meshPeerState: meshPeersResponse ? (meshListCapability?.availability ?? 'available-local') : denied ? 'denied' : 'unsupported',
    meshPeerReason: meshListCapability ? capabilityReason(meshListCapability) : 'Auth.MeshListPeers is not advertised by the capability catalog; device mesh linkage may be incomplete.',
    meshPeerActionState,
    meshPeerActionReason: meshPeerActionCapability ? capabilityReason(meshPeerActionCapability) : 'Auth.MeshApprovePeer/Auth.MeshRemovePeer AdminAction capabilities are not advertised by the capability catalog.',
    nativePlatform: nativeManifest?.platform ?? null,
    nativeCapabilities: Object.entries(nativeManifest?.capabilities ?? {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([capability]) => capability)
      .sort(),
    warnings: failures,
    error: failures.find((message) => !message.includes('native manifest')) ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response'
  }
}

export function AdminDevicesView({
  snapshot,
  adminReason = '',
  pendingDeviceId = null,
  reauthConfirmed = false,
  mutationError = null,
  optimisticDeviceId = null,
  onAdminReasonChange,
  onReauthConfirmedChange,
  onRefresh,
  onDeleteDevice,
  onRunAdminAction
}: AdminDevicesViewProps) {
  const totals = useMemo(() => deviceTotals(snapshot.devices), [snapshot.devices])
  const visibleDevices = snapshot.devices.filter((device) => device.id !== optimisticDeviceId)

  return (
    <section className="aui-admin-devices" aria-labelledby="admin-devices-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-devices-title">Devices and sessions</h1>
          <p>
            Registered devices, token-backed active sessions, trust state, and platform capabilities are loaded through AuroraClient.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="Device backend evidence">
          {isAvailabilityState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <span className={`aui-badge aui-badge-${snapshot.loadState}`}>{snapshot.loadState}</span>}
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <PrivacyBadge privacy="credential" />
        </div>
      </header>

      <DeviceStatusPanel snapshot={snapshot} mutationError={mutationError} optimisticDeviceId={optimisticDeviceId} />

      <div className="aui-admin-metrics" aria-label="Device/session summary">
        <Metric label="Devices" value={String(snapshot.devices.length)} detail={`${totals.trusted} trusted`} />
        <Metric label="Pending" value={String(totals.pending + snapshot.pendingPairings.length)} detail={`${snapshot.pendingPairings.length} pairing requests`} />
        <Metric label="Sessions" value={String(totals.activeSessions)} detail="token-backed evidence" />
        <Metric label="Tokens" value={String(totals.tokens)} detail={`${totals.expiredTokens} expired`} />
      </div>

      <DevicePlatformSecurityPanel snapshot={snapshot} reauthConfirmed={reauthConfirmed} onRunAdminAction={onRunAdminAction} />

      <section className="aui-admin-panel" aria-labelledby="device-controls-title">
        <div className="aui-panel-heading">
          <div>
            <p className="aui-kicker">Controls</p>
            <h2 id="device-controls-title">AdminAction boundary</h2>
          </div>
          <button className="aui-button" type="button" disabled={snapshot.loadState === 'loading'} onClick={onRefresh}>
            <RefreshCw size={16} aria-hidden />
            Refresh
          </button>
        </div>
        <div className="aui-device-controls">
          <label>
            <span>AdminAction reason</span>
            <textarea
              value={adminReason}
              disabled={snapshot.deleteState === 'pending' || snapshot.deleteState === 'unsupported' || snapshot.deleteState === 'denied'}
              rows={2}
              onChange={(event) => onAdminReasonChange?.(event.currentTarget.value)}
            />
          </label>
          <label className="aui-confirmation-check">
            <input type="checkbox" checked={reauthConfirmed} onChange={(event) => onReauthConfirmedChange?.(event.currentTarget.checked)} disabled={snapshot.deleteState === 'pending' || snapshot.deleteState === 'unsupported' || snapshot.deleteState === 'denied'} />
            <span>I confirm recent AdminAction reauthentication for device, pairing, and mesh trust mutations.</span>
          </label>
          <div className="aui-device-capability-grid">
            <CapabilityFact label="List devices" state={snapshot.listState} reason={snapshot.listReason} />
            <CapabilityFact label="List tokens" state={snapshot.tokenState} reason={snapshot.tokenReason} />
            <CapabilityFact label="Pending pairings" state={snapshot.pairingState} reason={snapshot.pairingReason} />
            <CapabilityFact label="Delete device" state={snapshot.deleteState} reason={snapshot.deleteReason} />
            <CapabilityFact label="Mesh peer linkage" state={snapshot.meshPeerState ?? 'unsupported'} reason={snapshot.meshPeerReason ?? 'Auth.MeshListPeers is not advertised by the capability catalog; device mesh linkage may be incomplete.'} />
            <CapabilityFact label="Trust actions" state={snapshot.meshPeerActionState ?? 'unsupported'} reason={snapshot.meshPeerActionReason ?? 'Auth.MeshApprovePeer/Auth.MeshRemovePeer AdminAction capabilities are not advertised by the capability catalog.'} />
          </div>
        </div>
      </section>

      <section className="aui-admin-panel" aria-labelledby="device-list-title">
        <div className="aui-panel-heading">
          <div>
            <p className="aui-kicker">Inventory</p>
            <h2 id="device-list-title">Registered devices</h2>
          </div>
        </div>
        {visibleDevices.length === 0 && snapshot.loadState !== 'loading' ? (
          <p className="aui-muted">No registered devices were returned by Auth.ListDevices.</p>
        ) : (
          <div className="aui-table-scroll">
            <table className="aui-table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Trust</th>
                  <th>Sessions</th>
                  <th>Platform</th>
                  <th>Mesh peer</th>
                  <th>Evidence</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleDevices.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <div className="aui-device-identity">
                        <span className="aui-device-icon"><Laptop size={18} aria-hidden /></span>
                        <div>
                          <strong>{device.name}</strong>
                          <span>{device.id}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge state={device.trustState} />
                      <p className="aui-muted">{device.trustLabel}</p>
                    </td>
                    <td>
                      <strong>{device.activeSessionCount}</strong>
                      <p className="aui-muted">{device.tokenCount} token records</p>
                      <details className="aui-service-details">
                        <summary>Token evidence</summary>
                        {device.activeTokens.length === 0 ? (
                          <p>No active token evidence was returned for this device.</p>
                        ) : (
                          <ul className="aui-device-token-list">
                            {device.activeTokens.map((token) => (
                              <li key={token.id}>
                                <StatusBadge state={token.state} />
                                <span>{token.prefix || token.id}</span>
                                <small>{token.scopes.join(', ') || 'no scopes'}</small>
                              </li>
                            ))}
                          </ul>
                        )}
                      </details>
                    </td>
                    <td>
                      <strong>{device.platformLabel}</strong>
                      <p className="aui-muted">{device.platformEvidence}</p>
                    </td>
                    <td>
                      <Link2 size={16} aria-hidden />
                      <StatusBadge state={device.meshPeerState} />
                      <p className="aui-muted">{device.linkedMeshPeerLabel}</p>
                      <small>{device.meshPeerEvidence}</small>
                    </td>
                    <td>
                      <dl className="aui-device-facts">
                        <div><dt>Principal</dt><dd>{device.principalId ?? 'not reported'}</dd></div>
                        <div><dt>Created</dt><dd>{formatDate(device.createdAt)}</dd></div>
                        <div><dt>Last seen</dt><dd>{formatDate(device.lastSeen)}</dd></div>
                      </dl>
                    </td>
                    <td>
                      <button
                        className="aui-button aui-danger-button"
                        type="button"
                        disabled={!reauthConfirmed || !device.deleteAction || Boolean(pendingDeviceId)}
                        onClick={() => onDeleteDevice?.(device)}
                      >
                        <Trash2 size={16} aria-hidden />
                        {pendingDeviceId === device.id ? 'Submitting AdminAction' : 'Revoke'}
                      </button>
                      {device.trustAction ? (
                        <button
                          className="aui-button"
                          type="button"
                          disabled={!reauthConfirmed || Boolean(pendingDeviceId)}
                          onClick={() => device.trustAction ? onRunAdminAction?.(device.trustAction, device.id) : undefined}
                        >
                          <CheckCircle2 size={16} aria-hidden />
                          Trust via AdminAction
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  )
}

function DevicePlatformSecurityPanel({ snapshot, reauthConfirmed, onRunAdminAction }: { snapshot: AdminDevicesSnapshot; reauthConfirmed: boolean; onRunAdminAction?: ((action: AdminDeviceAction, optimisticId: string) => void) | undefined }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="device-platform-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Trust posture</p>
          <h2 id="device-platform-title">Pending pairings and platform security</h2>
        </div>
        <a className="aui-action-chip" href="/admin/pairing">Open pairing queue</a>
      </div>
      <div className="aui-device-posture-grid">
        <article>
          <h3>Pending pairing requests</h3>
          {snapshot.pendingPairings.length === 0 ? (
            <p className="aui-muted">No pending pairings were returned by Auth.ListPendingPairings.</p>
          ) : (
            <ul className="aui-device-pairing-list">
              {snapshot.pendingPairings.map((pairing) => (
                <li key={pairing.requestId}>
                  <StatusBadge state={pairing.status === 'pending' ? 'pending' : 'unsupported'} />
                  <Link2 size={16} aria-hidden />
                  <div>
                    <strong>{pairing.deviceName}</strong>
                    <span>{pairing.remoteNodeName || pairing.remotePeerId} from {pairing.clientIp}</span>
                    <small>{pairing.permissionCount} permissions requested; admin={String(pairing.adminRequested)}; mesh={pairing.linkedMeshPeerLabel}; expires {formatDate(pairing.expiresAt)}</small>
                    <small>AdminAction approve={pairing.approveAction?.methodId ?? 'unsupported'} deny={pairing.denyAction?.methodId ?? 'unsupported'}; pairing secret redacted</small>
                    <div className="aui-admin-actions">
                      <button className="aui-button" type="button" disabled={!reauthConfirmed || !pairing.approveAction} onClick={() => pairing.approveAction ? onRunAdminAction?.(pairing.approveAction, pairing.requestId) : undefined}>
                        <CheckCircle2 size={16} aria-hidden />
                        Approve/trust via AdminAction
                      </button>
                      <button className="aui-button aui-danger-button" type="button" disabled={!reauthConfirmed || !pairing.denyAction} onClick={() => pairing.denyAction ? onRunAdminAction?.(pairing.denyAction, pairing.requestId) : undefined}>
                        <XCircle size={16} aria-hidden />
                        Deny via AdminAction
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>
        <article>
          <h3>Platform security status</h3>
          <dl className="aui-device-facts">
            <div><dt>Platform</dt><dd>{snapshot.nativePlatform ?? 'native manifest unavailable'}</dd></div>
            <div><dt>Capabilities</dt><dd>{snapshot.nativeCapabilities.length > 0 ? snapshot.nativeCapabilities.join(', ') : 'no native capabilities advertised'}</dd></div>
            <div><dt>Boundary</dt><dd>Device trust uses Auth records; native capability claims use the SDK native manifest only.</dd></div>
          </dl>
        </article>
      </div>
    </section>
  )
}

export function buildDeviceDeleteAdminAction(device: Pick<AdminDeviceRow, 'id' | 'name' | 'principalId'>, reason: string, reauthConfirmed = false): AdminDeviceAction {
  return {
    methodId: AUTH_METHODS.deleteDevice,
    payload: { device_id: device.id },
    reason,
    reauthConfirmed,
    affectedResources: [
      `device:${device.id}`,
      ...(device.principalId ? [`principal:${device.principalId}`] : []),
      'device_tokens',
      'active_sessions'
    ],
    path: routePath('Auth', 'DeleteDevice')
  }
}

export function buildPendingPairingAdminAction(
  entry: PendingPairingEntry,
  action: 'approve' | 'deny',
  reason: string,
  reauthConfirmed = false
): AdminDeviceAction {
  const affectedResources = [
    `pairing:${entry.request_id}`,
    ...(entry.remote_peer_id ? [`peer:${entry.remote_peer_id}`] : []),
    `device:${entry.device_name}`
  ]
  if (action === 'approve') {
    return {
      methodId: AUTH_METHODS.pairingApprove,
      payload: {
        code: entry.code,
        permissions: entry.granted_permissions,
        is_admin: entry.granted_is_admin
      },
      reason,
      reauthConfirmed,
      affectedResources,
      path: routePath('Auth', 'PairingApprove')
    }
  }
  return {
    methodId: AUTH_METHODS.pairingDeny,
    payload: {
      code: entry.code,
      reason
    },
    reason,
    reauthConfirmed,
    affectedResources,
    path: routePath('Auth', 'PairingDeny')
  }
}

export function buildDeviceMeshPeerAdminAction(
  peer: Pick<MeshPeerInfo, 'peer_id' | 'node_name' | 'outbound_permissions'>,
  action: 'trust' | 'revoke',
  reason: string,
  reauthConfirmed = false
): AdminDeviceAction {
  if (action === 'trust') {
    return {
      methodId: AUTH_METHODS.meshApprovePeer,
      payload: { peer_id: peer.peer_id, permissions: peer.outbound_permissions },
      reason,
      reauthConfirmed,
      affectedResources: [`mesh-peer:${peer.peer_id}`, `peer:${peer.node_name}`],
      path: routePath('Auth', 'MeshApprovePeer')
    }
  }
  return {
    methodId: AUTH_METHODS.meshRemovePeer,
    payload: { peer_id: peer.peer_id, revoke_token: true },
    reason,
    reauthConfirmed,
    affectedResources: [`mesh-peer:${peer.peer_id}`, `peer:${peer.node_name}`],
    path: routePath('Auth', 'MeshRemovePeer')
  }
}

function buildDeviceRow(
  device: DeviceResponse,
  tokens: TokenResponse[],
  deleteCapability: CapabilitySummary | undefined,
  nativeManifest: NativeCapabilityManifest | null,
  meshPeers: MeshPeerInfo[],
  pendingPairings: PendingPairingEntry[],
  meshPeerActionState: AvailabilityState
): AdminDeviceRow {
  const deviceTokens = tokens.filter((token) => token.device_id === device.id)
  const activeTokens = deviceTokens.map(tokenRow)
  const activeSessionCount = activeTokens.filter((token) => token.state !== 'stale' && token.state !== 'denied').length
  const deleteState = deleteCapability?.availability ?? 'unsupported'
  const deleteReason = deleteCapability ? capabilityReason(deleteCapability) : 'Auth.DeleteDevice is not advertised by the capability catalog.'
  const linkedMeshPeer = findLinkedMeshPeer(device.name, meshPeers)
  const pendingPairing = findLinkedPairing(device.name, pendingPairings)
  const linkedState = linkedMeshPeer
    ? meshPeerAvailability(linkedMeshPeer)
    : pendingPairing
      ? 'pending'
      : 'unsupported'
  const trustAction = buildTrustActionForDevice(device, linkedMeshPeer, pendingPairing, meshPeerActionState)
  return {
    id: device.id,
    name: device.name,
    principalId: device.user_id ?? null,
    trustState: device.is_trusted ? 'available-local' : 'pending',
    trustLabel: device.is_trusted ? 'trusted by Auth device record' : 'not trusted by Auth device record',
    createdAt: device.created_at ?? null,
    lastSeen: device.last_seen ?? null,
    platformLabel: inferPlatformLabel(device.name, nativeManifest),
    platformEvidence: platformEvidence(device.name, nativeManifest),
    activeTokens,
    tokenCount: deviceTokens.length,
    activeSessionCount,
    deleteState,
    deleteReason,
    deleteAction: deleteState === 'available-local' || deleteState === 'available-remote' || deleteState === 'degraded'
      ? buildDeviceDeleteAdminAction({ id: device.id, name: device.name, principalId: device.user_id ?? null }, 'Remove device and revoke its local session access')
      : null,
    trustAction,
    linkedMeshPeerId: linkedMeshPeer?.peer_id ?? pendingPairing?.remote_peer_id ?? null,
    linkedMeshPeerLabel: linkedMeshPeer
      ? `${linkedMeshPeer.node_name} (${linkedMeshPeer.outbound_status}/${linkedMeshPeer.connection_status})`
      : pendingPairing
        ? `${pendingPairing.remote_node_name || pendingPairing.remote_peer_id} pending pairing`
        : 'no linked mesh peer reported',
    meshPeerState: linkedState,
    meshPeerEvidence: linkedMeshPeer
      ? `Auth.MeshListPeers peer ${linkedMeshPeer.peer_id}; inbound=${linkedMeshPeer.inbound_status}; outbound=${linkedMeshPeer.outbound_status}`
      : pendingPairing
        ? `Auth.ListPendingPairings links ${pendingPairing.remote_peer_id}; approval still requires AdminAction`
        : 'No Auth.MeshListPeers or pending pairing record matched this device label.'
  }
}

function buildPendingPairingRows(
  response: ListPendingPairingsResponse | null,
  meshPeers: MeshPeerInfo[],
  actionsAvailable: boolean
): AdminPendingPairingRow[] {
  return (response?.pairings ?? [])
    .filter((entry) => entry.status === 'pending')
    .map((entry) => pendingPairingRow(entry, meshPeers, actionsAvailable))
}

function pendingPairingRow(entry: PendingPairingEntry, meshPeers: MeshPeerInfo[], actionsAvailable: boolean): AdminPendingPairingRow {
  const linkedPeer = meshPeers.find((peer) => peer.peer_id === entry.remote_peer_id)
  return {
    requestId: entry.request_id,
    deviceName: entry.device_name,
    remotePeerId: entry.remote_peer_id,
    remoteNodeName: entry.remote_node_name,
    clientIp: entry.client_ip,
    status: entry.status,
    expiresAt: entry.expires_at,
    permissionCount: entry.granted_permissions.length,
    adminRequested: entry.granted_is_admin,
    linkedMeshPeerId: linkedPeer?.peer_id ?? entry.remote_peer_id ?? null,
    linkedMeshPeerLabel: linkedPeer
      ? `${linkedPeer.node_name} (${linkedPeer.outbound_status}/${linkedPeer.connection_status})`
      : entry.remote_peer_id
        ? `${entry.remote_node_name || entry.remote_peer_id} pending peer`
        : 'no mesh peer id reported',
    linkedMeshPeerState: linkedPeer ? meshPeerAvailability(linkedPeer) : 'pending',
    approveAction: actionsAvailable ? buildPendingPairingAdminAction(entry, 'approve', 'Approve pending device pairing from /admin/devices') : null,
    denyAction: actionsAvailable ? buildPendingPairingAdminAction(entry, 'deny', 'Deny pending device pairing from /admin/devices') : null
  }
}

function buildTrustActionForDevice(
  device: DeviceResponse,
  linkedMeshPeer: MeshPeerInfo | undefined,
  pendingPairing: PendingPairingEntry | undefined,
  meshPeerActionState: AvailabilityState
): AdminDeviceAction | null {
  if (pendingPairing) {
    return buildPendingPairingAdminAction(pendingPairing, 'approve', `Trust pending device ${device.name}`)
  }
  if (!linkedMeshPeer || device.is_trusted || meshPeerActionState === 'unsupported' || meshPeerActionState === 'denied' || meshPeerActionState === 'pending') {
    return null
  }
  return buildDeviceMeshPeerAdminAction(linkedMeshPeer, 'trust', `Trust mesh peer for device ${device.name}`)
}

function findLinkedMeshPeer(deviceName: string, meshPeers: MeshPeerInfo[]): MeshPeerInfo | undefined {
  const normalizedDevice = normalizeLinkLabel(deviceName)
  return meshPeers.find((peer) => {
    const peerLabels = [peer.node_name, peer.peer_id, peer.id].map(normalizeLinkLabel)
    return peerLabels.some((label) => label.length > 0 && (label.includes(normalizedDevice) || normalizedDevice.includes(label)))
  })
}

function findLinkedPairing(deviceName: string, pairings: PendingPairingEntry[]): PendingPairingEntry | undefined {
  const normalizedDevice = normalizeLinkLabel(deviceName)
  return pairings.find((entry) => {
    const labels = [entry.device_name, entry.remote_node_name, entry.remote_peer_id].map(normalizeLinkLabel)
    return labels.some((label) => label.length > 0 && (label.includes(normalizedDevice) || normalizedDevice.includes(label)))
  })
}

function normalizeLinkLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function meshPeerAvailability(peer: MeshPeerInfo): AvailabilityState {
  if (peer.outbound_status === 'approved' || peer.inbound_status === 'approved') return 'available-local'
  if (peer.outbound_status === 'pending' || peer.inbound_status === 'pending') return 'pending'
  if (peer.outbound_status === 'denied' || peer.inbound_status === 'denied') return 'denied'
  if (peer.connection_status === 'disconnected') return 'offline'
  return 'degraded'
}

function tokenRow(token: TokenResponse): AdminDeviceTokenRow {
  return {
    id: token.id,
    prefix: token.prefix,
    scopes: token.scopes,
    createdAt: token.created_at ?? null,
    expiresAt: token.expires_at ?? null,
    state: tokenExpired(token.expires_at ?? null) ? 'stale' : 'available-local'
  }
}

function DeviceStatusPanel({
  snapshot,
  mutationError,
  optimisticDeviceId
}: {
  snapshot: AdminDevicesSnapshot
  mutationError: string | null
  optimisticDeviceId: string | null
}) {
  if (optimisticDeviceId) {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <ShieldCheck size={18} aria-hidden />
        <span>AdminAction submitted for {optimisticDeviceId}; refreshing device evidence before committing the row removal.</span>
      </div>
    )
  }
  if (mutationError) {
    return (
      <div className="aui-admin-notice aui-admin-notice-warning" role="alert">
        <Lock size={18} aria-hidden />
        <span>Rollback required after AdminAction device deletion failed: {mutationError}</span>
      </div>
    )
  }
  if (snapshot.loadState === 'loading') {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading devices, token-backed sessions, capabilities, and native manifest through AuroraClient.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="aui-admin-notice" role="status">
        <Laptop size={18} aria-hidden />
        <span>No registered devices were returned by Auth.ListDevices.</span>
      </div>
    )
  }
  return (
    <div className="aui-admin-notice aui-admin-notice-warning" role="alert">
      <Lock size={18} aria-hidden />
      <span>{snapshot.error ?? 'Device/session evidence is degraded. Unsupported or denied controls remain disabled.'}</span>
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="aui-admin-metric">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  )
}

function CapabilityFact({ label, state, reason }: { label: string; state: AvailabilityState; reason: string }) {
  return (
    <div className="aui-device-capability">
      <StatusBadge state={state} />
      <div>
        <strong>{label}</strong>
        <span>{reason}</span>
      </div>
    </div>
  )
}

function deviceTotals(devices: AdminDeviceRow[]) {
  return devices.reduce(
    (totals, device) => ({
      trusted: totals.trusted + (device.trustState === 'available-local' ? 1 : 0),
      pending: totals.pending + (device.trustState === 'pending' ? 1 : 0),
      activeSessions: totals.activeSessions + device.activeSessionCount,
      tokens: totals.tokens + device.tokenCount,
      expiredTokens: totals.expiredTokens + device.activeTokens.filter((token) => token.state === 'stale').length
    }),
    { trusted: 0, pending: 0, activeSessions: 0, tokens: 0, expiredTokens: 0 }
  )
}

function capabilityFor(methodId: string, summaries: CapabilitySummary[]): CapabilitySummary | undefined {
  return summaries.find((summary) => summary.busTopic === methodId || `${summary.module}.${summary.method}` === methodId)
}

function capabilityReason(capability: CapabilitySummary): string {
  const blockers = capability.routeBlockers.length > 0 ? ` blockers: ${capability.routeBlockers.join(', ')}` : ''
  const location = capability.peerId && capability.peerId !== 'local-peer' ? `remote:${capability.peerId}` : capability.providerId
  const approval = capability.raw.policy.approval_required ? ' requires AdminAction approval' : ''
  return `${location} / ${capability.serviceInstanceId}; ${capability.busTopic ?? `${capability.module}.${capability.method}`} is ${capability.availability}${approval}.${blockers}`
}

function responseDataOrNull<T>(result: PromiseSettledResult<{ ok: boolean; data?: T }>): T | null {
  return result.status === 'fulfilled' && result.value.ok && result.value.data !== undefined ? result.value.data : null
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function failureMessage(label: string, result: PromiseSettledResult<unknown>, optional = false): string | null {
  if (result.status === 'fulfilled') {
    if (isAuroraResponseFailure(result.value)) return `${label}: ${result.value.error.message}`
    return null
  }
  if (optional && result.reason instanceof AuroraError && result.reason.code === 'unsupported_feature') return `${label}: unsupported by this SDK transport`
  return `${label}: ${deviceMutationErrorMessage(result.reason)}`
}

function isDeniedFailure(result: PromiseSettledResult<unknown>): boolean {
  if (result.status === 'rejected') return errorState(result.reason) === 'denied'
  if (isAuroraResponseFailure(result.value)) return errorState(result.value.error) === 'denied'
  return false
}

function isAuroraResponseFailure(value: unknown): value is { ok: false; error: AuroraError } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false && (value as { error?: unknown }).error instanceof AuroraError
}

function errorState(error: unknown): AvailabilityState {
  const normalized = error instanceof AuroraError ? error : null
  if (normalized?.code === 'permission' || normalized?.status === 403) return 'denied'
  if (normalized?.code === 'auth' || normalized?.status === 401) return 'denied'
  if (normalized?.code === 'privacy_blocked') return 'privacy-blocked'
  if (normalized?.code === 'unsupported_feature') return 'unsupported'
  return 'unsupported'
}

function deviceMutationErrorMessage(error: unknown): string {
  if (error instanceof AuroraError) return error.message
  if (error instanceof Error) return error.message
  return 'Unknown AuroraClient error'
}

function isAvailabilityState(value: string): value is AvailabilityState {
  return [
    'available-local',
    'available-remote',
    'pending',
    'offline',
    'denied',
    'degraded',
    'stale',
    'privacy-blocked',
    'unsupported'
  ].includes(value)
}

function tokenExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const parsed = Date.parse(expiresAt)
  return Number.isFinite(parsed) && parsed <= Date.now()
}

function inferPlatformLabel(name: string, nativeManifest: NativeCapabilityManifest | null): string {
  const lower = name.toLowerCase()
  if (lower.includes('android')) return 'android'
  if (lower.includes('iphone') || lower.includes('ios')) return 'ios'
  if (lower.includes('tablet')) return 'tablet'
  if (lower.includes('mac') || lower.includes('desktop')) return nativeManifest?.platform ?? 'desktop'
  return nativeManifest?.platform ?? 'not advertised'
}

function platformEvidence(name: string, nativeManifest: NativeCapabilityManifest | null): string {
  if (!nativeManifest) return 'native/platform manifest unavailable'
  const capabilityCount = Object.values(nativeManifest.capabilities).filter(Boolean).length
  return `${nativeManifest.platform}; ${capabilityCount} enabled native capabilities; inferred from device label "${name}"`
}

function formatDate(value: string | null): string {
  if (!value) return 'not reported'
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(new Date(parsed))
}
