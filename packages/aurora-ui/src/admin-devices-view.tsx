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
import { Alert, AlertDescription } from '#components/ui/alert'
import { Badge } from '#components/ui/badge'
import { Label } from '#components/ui/label'
import { Textarea } from '#components/ui/textarea'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'
import { PageHeader } from './state-surface'
import { Button, Card, DataTable, StatStrip, type DataColumn } from './primitives'
import { adminCapabilityReason, adminErrorTitle, adminModuleLabel, adminReasonText, productAdminErrorCopy, productAdminReasonCopy, sanitizeAdminText } from './admin-product-copy'

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
  listReason: 'Loading devices, sessions, and platform features through Aurora.',
  tokenState: 'pending',
  tokenReason: 'Loading token/session status through Aurora.',
  pairingState: 'pending',
  pairingReason: 'Loading pending pairing requests through Aurora.',
  deleteState: 'pending',
  deleteReason: 'Loading device removal status before enabling changes.',
  meshPeerState: 'pending',
  meshPeerReason: 'Loading connected device links.',
  meshPeerActionState: 'pending',
  meshPeerActionReason: 'Loading trust actions before enabling device approval.',
  nativePlatform: null,
  nativeCapabilities: [],
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls'
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
        setMutationError(productAdminErrorCopy(error, 'Device update failed. Try again.'))
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
    failureMessage('platform features', nativeResult, true)
  ].filter((message): message is string => Boolean(message))
  const denied = [devicesResult, tokensResult, pairingsResult, catalogResult].some(isDeniedFailure)

  if (!devicesResponse && !tokensResponse && !pairingsResponse && !capabilityCatalog) {
    const message = 'Aurora device and session resources are unavailable.'
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
      evidenceSource: 'Aurora request error'
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
    : failures.filter((message) => !message.includes('platform features')).length > 0
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
    listReason: listCapability ? capabilityReason(listCapability) : 'Device listing is not ready yet.',
    tokenState: tokenCapability?.availability ?? (tokensResponse ? 'available-local' : denied ? 'denied' : 'unsupported'),
    tokenReason: tokenCapability ? capabilityReason(tokenCapability) : 'Token and session status is not ready yet.',
    pairingState: pairingCapability?.availability ?? (pairingsResponse ? 'available-local' : denied ? 'denied' : 'unsupported'),
    pairingReason: pairingCapability ? capabilityReason(pairingCapability) : 'Pending pairing status is not ready yet.',
    deleteState: deleteCapability?.availability ?? (denied ? 'denied' : 'unsupported'),
    deleteReason: deleteCapability ? capabilityReason(deleteCapability) : 'Device removal is not ready yet.',
    meshPeerState: meshPeersResponse ? (meshListCapability?.availability ?? 'available-local') : denied ? 'denied' : 'unsupported',
    meshPeerReason: meshListCapability ? capabilityReason(meshListCapability) : 'Connected device links are not ready yet.',
    meshPeerActionState,
    meshPeerActionReason: meshPeerActionCapability ? capabilityReason(meshPeerActionCapability) : 'Device trust actions are not ready yet.',
    nativePlatform: nativeManifest?.platform ?? null,
    nativeCapabilities: Object.entries(nativeManifest?.capabilities ?? {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([capability]) => capability)
      .sort(),
    warnings: failures,
    error: failures.find((message) => !message.includes('platform features')) ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'Local preview' : 'Aurora service response'
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
    <div className="flex flex-col gap-6">
      <PageHeader
        id="admin-devices-title"
        eyebrow="Admin"
        title="Devices and sessions"
        description="Registered devices, token-backed active sessions, trust state, and platform capabilities are loaded through Aurora."
        badges={
          <>
            {isAvailabilityState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <Badge variant="outline">{snapshot.loadState}</Badge>}
            <EvidenceBadge label={snapshot.evidenceSource} />
            <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets protected' : 'redaction pending'} />
            <PrivacyBadge privacy="credential" />
          </>
        }
        actions={
          <Button variant="ghost" icon={<RefreshCw size={16} aria-hidden />} disabled={snapshot.loadState === 'loading'} onClick={onRefresh}>
            Refresh
          </Button>
        }
      />

      <DeviceStatusPanel snapshot={snapshot} mutationError={mutationError} optimisticDeviceId={optimisticDeviceId} />

      <StatStrip
        ariaLabel="Device/session summary"
        items={[
          { label: 'Devices', value: String(snapshot.devices.length), caption: `${totals.trusted} trusted` },
          { label: 'Pending', value: String(totals.pending + snapshot.pendingPairings.length), caption: `${snapshot.pendingPairings.length} pairing requests` },
          { label: 'Sessions', value: String(totals.activeSessions), caption: 'token-backed status' },
          { label: 'Tokens', value: String(totals.tokens), caption: `${totals.expiredTokens} expired` }
        ]}
      />

      <DevicePlatformSecurityPanel snapshot={snapshot} reauthConfirmed={reauthConfirmed} onRunAdminAction={onRunAdminAction} />

      <Card title="Protected device changes" description="Device, pairing, and trust changes require admin confirmation and audit logging.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="admin-devices-reason">Reason</Label>
            <Textarea
              id="admin-devices-reason"
              value={adminReason}
              disabled={snapshot.deleteState === 'pending' || snapshot.deleteState === 'unsupported' || snapshot.deleteState === 'denied'}
              rows={2}
              onChange={(event) => onAdminReasonChange?.(event.currentTarget.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={reauthConfirmed} onChange={(event) => onReauthConfirmedChange?.(event.currentTarget.checked)} disabled={snapshot.deleteState === 'pending' || snapshot.deleteState === 'unsupported' || snapshot.deleteState === 'denied'} />
            <span>I confirm my recent admin unlock for device, pairing, and trust changes.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <CapabilityFact label="List devices" state={snapshot.listState} reason={snapshot.listReason} />
            <CapabilityFact label="List tokens" state={snapshot.tokenState} reason={snapshot.tokenReason} />
            <CapabilityFact label="Pending pairings" state={snapshot.pairingState} reason={snapshot.pairingReason} />
            <CapabilityFact label="Delete device" state={snapshot.deleteState} reason={snapshot.deleteReason} />
            <CapabilityFact label="Connected device link" state={snapshot.meshPeerState ?? 'unsupported'} reason={snapshot.meshPeerReason ?? 'Connected device details are not ready yet.'} />
            <CapabilityFact label="Trust actions" state={snapshot.meshPeerActionState ?? 'unsupported'} reason={snapshot.meshPeerActionReason ?? 'Device trust actions are not ready yet.'} />
          </div>
        </div>
      </Card>

      <Card title="Registered devices" flush>
        <DevicesDataTable
          devices={visibleDevices}
          loadState={snapshot.loadState}
          pendingDeviceId={pendingDeviceId}
          reauthConfirmed={reauthConfirmed}
          onDeleteDevice={onDeleteDevice}
          onRunAdminAction={onRunAdminAction}
        />
      </Card>
    </div>
  )
}

function DevicesDataTable({
  devices,
  loadState,
  pendingDeviceId,
  reauthConfirmed,
  onDeleteDevice,
  onRunAdminAction
}: {
  devices: AdminDeviceRow[]
  loadState: AdminDevicesLoadState
  pendingDeviceId: string | null
  reauthConfirmed: boolean
  onDeleteDevice?: ((device: AdminDeviceRow) => void) | undefined
  onRunAdminAction?: ((action: AdminDeviceAction, optimisticId: string) => void) | undefined
}) {
  const columns: DataColumn<AdminDeviceRow>[] = [
    {
      key: 'device',
      header: 'Device',
      render: (device) => (
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted"><Laptop size={16} aria-hidden /></span>
          <div className="flex flex-col">
            <strong className="text-sm font-medium">{device.name}</strong>
            <span className="text-xs text-muted-foreground">{device.id}</span>
          </div>
        </div>
      )
    },
    {
      key: 'trust',
      header: 'Trust',
      render: (device) => (
        <div>
          <StatusBadge state={device.trustState} />
          <p className="mt-1 text-xs text-muted-foreground">{device.trustLabel}</p>
        </div>
      )
    },
    {
      key: 'sessions',
      header: 'Sessions',
      render: (device) => (
        <div>
          <strong className="text-sm font-medium">{device.activeSessionCount}</strong>
          <p className="text-xs text-muted-foreground">{device.tokenCount} token records</p>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Token state</summary>
            {device.activeTokens.length === 0 ? (
              <p className="mt-1 text-muted-foreground">No active token state was returned for this device.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {device.activeTokens.map((token) => (
                  <li key={token.id} className="flex items-center gap-1.5">
                    <StatusBadge state={token.state} />
                    <span>{token.prefix || token.id}</span>
                    <small className="text-muted-foreground">{token.scopes.map(permissionLabel).join(', ') || 'no scopes'}</small>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>
      )
    },
    {
      key: 'platform',
      header: 'Platform',
      hideAt: 'lg',
      render: (device) => (
        <div>
          <strong className="text-sm font-medium">{device.platformLabel}</strong>
          <p className="text-xs text-muted-foreground">{device.platformEvidence}</p>
        </div>
      )
    },
    {
      key: 'mesh',
      header: 'Mesh peer',
      hideAt: 'md',
      render: (device) => (
        <div>
          <div className="flex items-center gap-1.5">
            <Link2 size={14} aria-hidden className="text-muted-foreground" />
            <StatusBadge state={device.meshPeerState} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{device.linkedMeshPeerLabel}</p>
          <small className="text-muted-foreground">{device.meshPeerEvidence}</small>
        </div>
      )
    },
    {
      key: 'state',
      header: 'State',
      hideAt: 'xl',
      render: (device) => (
        <dl className="flex flex-col gap-0.5 text-xs">
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Principal</dt><dd>{device.principalId ?? 'not reported'}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Created</dt><dd>{formatDate(device.createdAt)}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Last seen</dt><dd>{formatDate(device.lastSeen)}</dd></div>
        </dl>
      )
    },
    {
      key: 'action',
      header: 'Action',
      align: 'end',
      render: (device) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            variant="danger"
            icon={<Trash2 size={16} aria-hidden />}
            disabled={!reauthConfirmed || !device.deleteAction || Boolean(pendingDeviceId)}
            disabledReason={device.deleteReason}
            onClick={() => onDeleteDevice?.(device)}
          >
            {pendingDeviceId === device.id ? 'Submitting' : 'Revoke'}
          </Button>
          {device.trustAction ? (
            <Button
              variant="outline"
              icon={<CheckCircle2 size={16} aria-hidden />}
              disabled={!reauthConfirmed || Boolean(pendingDeviceId)}
              onClick={() => (device.trustAction ? onRunAdminAction?.(device.trustAction, device.id) : undefined)}
            >
              Trust device
            </Button>
          ) : null}
        </div>
      )
    }
  ]

  return (
    <DataTable
      columns={columns}
      rows={devices}
      getRowKey={(device) => device.id}
      empty={loadState === 'loading' ? null : <p className="p-6 text-sm text-muted-foreground">No registered devices were returned by Aurora.</p>}
    />
  )
}

function DevicePlatformSecurityPanel({ snapshot, reauthConfirmed, onRunAdminAction }: { snapshot: AdminDevicesSnapshot; reauthConfirmed: boolean; onRunAdminAction?: ((action: AdminDeviceAction, optimisticId: string) => void) | undefined }) {
  return (
    <section aria-labelledby="device-platform-title" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Trust posture</p>
          <h2 id="device-platform-title" className="text-base font-semibold">
            Pending pairings and platform security
          </h2>
        </div>
        <a href="/admin/pairing" className="rounded-lg border px-3 py-1.5 text-sm hover:bg-muted">
          Open pairing queue
        </a>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">Pending pairing requests</h3>
            {snapshot.pendingPairings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending pairings were returned by Aurora.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {snapshot.pendingPairings.map((pairing) => (
                  <li key={pairing.requestId} className="flex items-start gap-2.5 rounded-lg border bg-background/50 p-3">
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <StatusBadge state={pairing.status === 'pending' ? 'pending' : 'unsupported'} />
                      <Link2 size={14} aria-hidden className="text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <strong className="text-sm font-medium">{pairing.deviceName}</strong>
                      <div className="text-xs text-muted-foreground">
                        {pairing.remoteNodeName || pairing.remotePeerId} from {pairing.clientIp}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {pairing.permissionCount} permissions requested; admin={String(pairing.adminRequested)}; mesh={pairing.linkedMeshPeerLabel}; expires {formatDate(pairing.expiresAt)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Approval is protected; pairing secret is redacted.
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button variant="outline" icon={<CheckCircle2 size={16} aria-hidden />} disabled={!reauthConfirmed || !pairing.approveAction} onClick={() => (pairing.approveAction ? onRunAdminAction?.(pairing.approveAction, pairing.requestId) : undefined)}>
                          Approve and trust
                        </Button>
                        <Button variant="danger" icon={<XCircle size={16} aria-hidden />} disabled={!reauthConfirmed || !pairing.denyAction} onClick={() => (pairing.denyAction ? onRunAdminAction?.(pairing.denyAction, pairing.requestId) : undefined)}>
                          Deny request
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Platform security status</h3>
            <dl className="flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Platform</dt>
                <dd>{platformNameLabel(snapshot.nativePlatform)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Capabilities</dt>
                <dd className="text-right">{snapshot.nativeCapabilities.length > 0 ? `${snapshot.nativeCapabilities.length} platform feature(s) available` : 'no platform features reported'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Boundary</dt>
                <dd className="text-right">Device trust and platform claims are read from Aurora before actions are shown.</dd>
              </div>
            </dl>
          </div>
        </Card>
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
  const deleteReason = deleteCapability ? capabilityReason(deleteCapability) : 'Device removal is not ready yet.'
  const linkedMeshPeer = findLinkedMeshPeer(device.name, meshPeers)
  const actionableMeshPeer = findExactMeshPeerForDevice(device, meshPeers)
  const pendingPairing = findExactPairingForDevice(device, pendingPairings)
  const linkedState = linkedMeshPeer
    ? meshPeerAvailability(linkedMeshPeer)
    : pendingPairing
      ? 'pending'
      : 'unsupported'
  const trustAction = buildTrustActionForDevice(device, actionableMeshPeer, pendingPairing, meshPeerActionState)
  return {
    id: device.id,
    name: device.name,
    principalId: device.user_id ?? null,
    trustState: device.is_trusted ? 'available-local' : 'pending',
    trustLabel: device.is_trusted ? 'Trusted by Aurora' : 'Not trusted yet',
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
      ? linkedMeshPeerSummary(linkedMeshPeer)
      : pendingPairing
        ? `${pendingPairing.remote_node_name || pendingPairing.remote_peer_id} pending pairing`
        : 'no linked mesh peer reported',
    meshPeerState: linkedState,
    meshPeerEvidence: linkedMeshPeer
      ? `Connected device ${linkedMeshPeer.node_name}; ${adminReasonText(linkedMeshPeer.connection_status, 'Status needs attention')}`
      : pendingPairing
        ? `Waiting for approval on ${pendingPairing.remote_node_name || pendingPairing.remote_peer_id}`
        : 'No connected device or pending pairing matched this device label.'
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
      ? linkedMeshPeerSummary(linkedPeer)
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

function findExactMeshPeerForDevice(device: DeviceResponse, meshPeers: MeshPeerInfo[]): MeshPeerInfo | undefined {
  const deviceIds = exactDeviceLinkIds(device)
  return meshPeers.find((peer) => deviceIds.has(peer.peer_id) || deviceIds.has(peer.id))
}

function findExactPairingForDevice(device: DeviceResponse, pairings: PendingPairingEntry[]): PendingPairingEntry | undefined {
  const deviceIds = exactDeviceLinkIds(device)
  return pairings.find((entry) => deviceIds.has(entry.remote_peer_id))
}

function exactDeviceLinkIds(device: DeviceResponse): Set<string> {
  return new Set([device.id, device.user_id].filter((value): value is string => typeof value === 'string' && value.length > 0))
}

function linkedMeshPeerSummary(peer: MeshPeerInfo): string {
  return `${peer.node_name} (${meshPeerStateLabel(meshPeerAvailability(peer))})`
}

function meshPeerStateLabel(state: AvailabilityState): string {
  if (state === 'available-local' || state === 'available-remote') return 'approved'
  if (state === 'offline' || state === 'stale') return 'offline'
  if (state === 'denied' || state === 'privacy-blocked') return 'not allowed'
  if (state === 'pending') return 'pending'
  return 'needs attention'
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
      <Alert aria-live="polite">
        <ShieldCheck />
        <AlertDescription>Device change submitted for {optimisticDeviceId}; refreshing before removing the row.</AlertDescription>
      </Alert>
    )
  }
  if (mutationError) {
    return (
      <Alert variant="destructive" role="alert">
        <Lock />
        <AlertDescription>Your existing device access was not changed. Try again. {mutationError}</AlertDescription>
      </Alert>
    )
  }
  if (snapshot.loadState === 'loading') {
    return (
      <Alert aria-live="polite">
        <Activity />
        <AlertDescription>Loading devices, active sessions, and platform features through Aurora.</AlertDescription>
      </Alert>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <Alert role="status">
        <Laptop />
        <AlertDescription>No registered devices were returned by Aurora.</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" role="alert">
      <Lock />
      <AlertDescription>{productAdminReasonCopy(snapshot.error, 'Device/session status is degraded. Not ready or denied controls remain disabled.')}</AlertDescription>
    </Alert>
  )
}

function CapabilityFact({ label, state, reason }: { label: string; state: AvailabilityState; reason: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-background/50 p-3">
      <StatusBadge state={state} />
      <div className="min-w-0">
        <strong className="block text-sm font-medium">{label}</strong>
        <span className="text-xs text-muted-foreground">{reason}</span>
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
  return adminCapabilityReason(capability)
}

function permissionLabel(permission: string): string {
  if (permission === '*') return 'All access'
  const [module, action] = permission.split('.')
  if (!module || !action) return sanitizeAdminText(permission)
  if (action === 'manage') return `${adminModuleLabel(module)} management`
  if (action === 'use') return `${adminModuleLabel(module)} use`
  return `${adminModuleLabel(module)} ${sanitizeAdminText(action)}`
}

function responseDataOrNull<T>(result: PromiseSettledResult<{ ok: boolean; data?: T }>): T | null {
  return result.status === 'fulfilled' && result.value.ok && result.value.data !== undefined ? result.value.data : null
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function failureMessage(label: string, result: PromiseSettledResult<unknown>, optional = false): string | null {
  if (result.status === 'fulfilled') {
    if (isAuroraResponseFailure(result.value)) return `${label}: ${adminErrorTitle(result.value.error)}`
    return null
  }
  if (optional && result.reason instanceof AuroraError && result.reason.code === 'unsupported_feature') return `${label}: This Aurora version cannot use that feature yet`
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
  return adminErrorTitle(error, 'Aurora could not update this device')
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
  if (lower.includes('android')) return 'Android'
  if (lower.includes('iphone') || lower.includes('ios')) return 'iOS'
  if (lower.includes('tablet')) return 'Tablet'
  if (lower.includes('mac') || lower.includes('desktop')) return platformNameLabel(nativeManifest?.platform ?? 'desktop')
  return platformNameLabel(nativeManifest?.platform)
}

function platformEvidence(name: string, nativeManifest: NativeCapabilityManifest | null): string {
  if (!nativeManifest) return 'platform features unavailable'
  const capabilityCount = Object.values(nativeManifest.capabilities).filter(Boolean).length
  return `${capabilityCount} platform feature(s) available; inferred from device label "${name}"`
}

function platformNameLabel(platform: string | null | undefined): string {
  if (!platform) return 'platform features unavailable'
  if (/android/iu.test(platform)) return 'Android'
  if (/ios|iphone|ipad/iu.test(platform)) return 'iOS'
  if (/tauri|desktop|darwin|mac|windows|linux/iu.test(platform)) return 'Desktop'
  return sanitizeAdminText(platform)
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
