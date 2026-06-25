'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Laptop, Lock, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
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
  type NativeCapabilityManifest,
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
  methodId: typeof AUTH_METHODS.deleteDevice
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
}

export interface AdminDevicesSnapshot {
  loadState: AdminDevicesLoadState
  generatedAt: string | null
  secretsRedacted: boolean
  devices: AdminDeviceRow[]
  listState: AvailabilityState
  listReason: string
  tokenState: AvailabilityState
  tokenReason: string
  deleteState: AvailabilityState
  deleteReason: string
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
  onAdminReasonChange?: (value: string) => void
  onRefresh?: () => void
  onDeleteDevice?: (device: AdminDeviceRow) => void
}

const loadingSnapshot: AdminDevicesSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  secretsRedacted: true,
  devices: [],
  listState: 'pending',
  listReason: 'Loading Auth.ListDevices, Auth.ListTokens, capability catalog, and native manifest through AuroraClient.',
  tokenState: 'pending',
  tokenReason: 'Loading token/session evidence through AuroraClient.',
  deleteState: 'pending',
  deleteReason: 'Loading Auth.DeleteDevice capability before enabling mutations.',
  nativePlatform: null,
  nativeCapabilities: [],
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls'
}

export function AdminDevicesResource({ client }: AdminDevicesResourceProps) {
  const [snapshot, setSnapshot] = useState<AdminDevicesSnapshot>(loadingSnapshot)
  const [adminReason, setAdminReason] = useState('Remove device and revoke its local session access')
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

  const deleteDevice = useCallback(
    async (device: AdminDeviceRow) => {
      if (!device.deleteAction) return
      setPendingDeviceId(device.id)
      setOptimisticDeviceId(device.id)
      setMutationError(null)
      const reason = adminReason.trim() || `Delete device ${device.id}`
      try {
        await client.admin.execute({ ...device.deleteAction, reason })
        await loadDevices()
      } catch (error) {
        setMutationError(deviceMutationErrorMessage(error))
      } finally {
        setPendingDeviceId(null)
        setOptimisticDeviceId(null)
      }
    },
    [adminReason, client.admin, loadDevices]
  )

  return (
    <AdminDevicesView
      snapshot={snapshot}
      adminReason={adminReason}
      onAdminReasonChange={setAdminReason}
      pendingDeviceId={pendingDeviceId}
      mutationError={mutationError}
      optimisticDeviceId={optimisticDeviceId}
      onRefresh={loadDevices}
      onDeleteDevice={deleteDevice}
    />
  )
}

export async function buildAdminDevicesSnapshot(client: AuroraClient): Promise<AdminDevicesSnapshot> {
  const [devicesResult, tokensResult, catalogResult, nativeResult] = await Promise.allSettled([
    client.authApi.listDevices(),
    client.authApi.listTokens(),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true, include_schemas: true }),
    client.native.getManifest()
  ])

  const devicesResponse = responseDataOrNull(devicesResult)
  const tokensResponse = responseDataOrNull(tokensResult)
  const capabilityCatalog = valueOrNull(catalogResult)
  const nativeManifest = valueOrNull(nativeResult)
  const summaries = capabilityCatalog ? summarizeCapabilities(capabilityCatalog) : []
  const listCapability = capabilityFor(AUTH_METHODS.listDevices, summaries)
  const tokenCapability = capabilityFor(AUTH_METHODS.listTokens, summaries)
  const deleteCapability = capabilityFor(AUTH_METHODS.deleteDevice, summaries)
  const failures = [
    failureMessage('devices', devicesResult),
    failureMessage('tokens', tokensResult),
    failureMessage('capability catalog', catalogResult),
    failureMessage('native manifest', nativeResult, true)
  ].filter((message): message is string => Boolean(message))
  const denied = [devicesResult, tokensResult, catalogResult].some(isDeniedFailure)

  if (!devicesResponse && !tokensResponse && !capabilityCatalog) {
    const message = 'Auth device/session SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      listState: denied ? 'denied' : 'unsupported',
      tokenState: denied ? 'denied' : 'unsupported',
      deleteState: denied ? 'denied' : 'unsupported',
      listReason: message,
      tokenReason: message,
      deleteReason: message,
      error: message,
      warnings: failures,
      evidenceSource: 'AuroraClient SDK error'
    }
  }

  const tokenRows = tokensResponse?.tokens ?? []
  const devices = (devicesResponse?.devices ?? []).map((device) =>
    buildDeviceRow(device, tokenRows, deleteCapability, nativeManifest)
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
    secretsRedacted: capabilityCatalog?.secrets_redacted ?? true,
    devices,
    listState: listCapability?.availability ?? (denied ? 'denied' : 'unsupported'),
    listReason: listCapability ? capabilityReason(listCapability) : 'Auth.ListDevices is not advertised by the capability catalog.',
    tokenState: tokenCapability?.availability ?? (tokensResponse ? 'available-local' : denied ? 'denied' : 'unsupported'),
    tokenReason: tokenCapability ? capabilityReason(tokenCapability) : 'Auth.ListTokens token/session evidence is not advertised by the capability catalog.',
    deleteState: deleteCapability?.availability ?? (denied ? 'denied' : 'unsupported'),
    deleteReason: deleteCapability ? capabilityReason(deleteCapability) : 'Auth.DeleteDevice is not advertised by the capability catalog.',
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
  mutationError = null,
  optimisticDeviceId = null,
  onAdminReasonChange,
  onRefresh,
  onDeleteDevice
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
        <Metric label="Sessions" value={String(totals.activeSessions)} detail="token-backed evidence" />
        <Metric label="Tokens" value={String(totals.tokens)} detail={`${totals.expiredTokens} expired`} />
        <Metric label="Native" value={snapshot.nativePlatform ?? 'none'} detail={`${snapshot.nativeCapabilities.length} SDK capabilities`} />
      </div>

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
          <div className="aui-device-capability-grid">
            <CapabilityFact label="List devices" state={snapshot.listState} reason={snapshot.listReason} />
            <CapabilityFact label="List tokens" state={snapshot.tokenState} reason={snapshot.tokenReason} />
            <CapabilityFact label="Delete device" state={snapshot.deleteState} reason={snapshot.deleteReason} />
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
                        disabled={!device.deleteAction || Boolean(pendingDeviceId)}
                        onClick={() => onDeleteDevice?.(device)}
                      >
                        <Trash2 size={16} aria-hidden />
                        {pendingDeviceId === device.id ? 'Submitting AdminAction' : 'Delete'}
                      </button>
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

export function buildDeviceDeleteAdminAction(device: Pick<AdminDeviceRow, 'id' | 'name' | 'principalId'>, reason: string): AdminDeviceAction {
  return {
    methodId: AUTH_METHODS.deleteDevice,
    payload: { device_id: device.id },
    reason,
    reauthConfirmed: true,
    affectedResources: [
      `device:${device.id}`,
      ...(device.principalId ? [`principal:${device.principalId}`] : []),
      'device_tokens',
      'active_sessions'
    ],
    path: routePath('Auth', 'DeleteDevice')
  }
}

function buildDeviceRow(
  device: DeviceResponse,
  tokens: TokenResponse[],
  deleteCapability: CapabilitySummary | undefined,
  nativeManifest: NativeCapabilityManifest | null
): AdminDeviceRow {
  const deviceTokens = tokens.filter((token) => token.device_id === device.id)
  const activeTokens = deviceTokens.map(tokenRow)
  const activeSessionCount = activeTokens.filter((token) => token.state !== 'stale' && token.state !== 'denied').length
  const deleteState = deleteCapability?.availability ?? 'unsupported'
  const deleteReason = deleteCapability ? capabilityReason(deleteCapability) : 'Auth.DeleteDevice is not advertised by the capability catalog.'
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
      : null
  }
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
      activeSessions: totals.activeSessions + device.activeSessionCount,
      tokens: totals.tokens + device.tokenCount,
      expiredTokens: totals.expiredTokens + device.activeTokens.filter((token) => token.state === 'stale').length
    }),
    { trusted: 0, activeSessions: 0, tokens: 0, expiredTokens: 0 }
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
