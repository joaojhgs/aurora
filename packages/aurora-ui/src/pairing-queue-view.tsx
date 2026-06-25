'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AUTH_METHODS,
  AuroraError,
  routePath,
  type AuroraClient,
  type AvailabilityState,
  type JsonObject,
  type ListPendingPairingsResponse,
  type PendingPairingEntry
} from '@aurora/client'
import { StateSurface } from './state-surface'
import { StatusBadge } from './status-badges'
import type { RouteAvailability } from './shell-data'

export type PairingQueueLoadState = 'loading' | 'ready' | 'error'

export interface PairingQueueModel {
  state: AvailabilityState | 'loading' | 'error'
  description: string
  evidence: string
  entries: PendingPairingEntry[]
  total: number
  expiredCount: number
  secretsRedacted: boolean
  disabledReason: string | null
  error: string | null
}

export interface PairingQueueModelInput {
  route: RouteAvailability
  response?: ListPendingPairingsResponse | null
  loadState?: PairingQueueLoadState
  error?: unknown
}

export interface PairingQueueViewProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface PairingAdminActionRequest {
  methodId: string
  payload: JsonObject
  reason: string
  reauthConfirmed: boolean
  affectedResources: string[]
  path: string
}

export function PairingQueueView({ client, route }: PairingQueueViewProps) {
  const [includeNonPending, setIncludeNonPending] = useState(false)
  const [response, setResponse] = useState<ListPendingPairingsResponse | null>(null)
  const [loadState, setLoadState] = useState<PairingQueueLoadState>(route.disabled ? 'ready' : 'loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [adminReason, setAdminReason] = useState('Review pending device or peer pairing request')
  const [permissions, setPermissions] = useState('')
  const [grantAdmin, setGrantAdmin] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)

  const loadQueue = useCallback(async () => {
    if (route.disabled) {
      setLoadState('ready')
      return
    }
    setLoadState('loading')
    setLoadError(null)
    const result = await client.authApi.listPendingPairings({ include_non_pending: includeNonPending })
    if (result.ok) {
      setResponse(result.data)
      setLoadState('ready')
      return
    }
    setLoadError(result.error)
    setLoadState('error')
  }, [client, includeNonPending, route.disabled])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  const model = useMemo(
    () => buildPairingQueueModel({ route, response, loadState, error: loadError }),
    [loadError, loadState, response, route]
  )

  const submitPairingAction = useCallback(
    async (entry: PendingPairingEntry, action: 'approve' | 'deny') => {
      setPendingAction(`${entry.request_id}:${action}`)
      setMutationError(null)
      const reason = adminReason.trim() || `${action} pairing request ${entry.request_id}`
      try {
        await client.admin.execute(buildPairingAdminActionRequest(entry, action, { reason, permissions, grantAdmin }))
        await loadQueue()
      } catch (error) {
        setMutationError(pairingErrorMessage(error))
      } finally {
        setPendingAction(null)
      }
    },
    [adminReason, client.admin, grantAdmin, loadQueue, permissions]
  )

  return (
    <PairingQueueSurface
      model={model}
      route={route}
      includeNonPending={includeNonPending}
      onIncludeNonPendingChange={setIncludeNonPending}
      adminReason={adminReason}
      onAdminReasonChange={setAdminReason}
      permissions={permissions}
      onPermissionsChange={setPermissions}
      grantAdmin={grantAdmin}
      onGrantAdminChange={setGrantAdmin}
      pendingAction={pendingAction}
      mutationError={mutationError}
      onRefresh={loadQueue}
      onApprove={(entry) => submitPairingAction(entry, 'approve')}
      onDeny={(entry) => submitPairingAction(entry, 'deny')}
    />
  )
}

export interface PairingQueueSurfaceProps {
  model: PairingQueueModel
  route: RouteAvailability
  includeNonPending?: boolean
  onIncludeNonPendingChange?: (value: boolean) => void
  adminReason?: string
  onAdminReasonChange?: (value: string) => void
  permissions?: string
  onPermissionsChange?: (value: string) => void
  grantAdmin?: boolean
  onGrantAdminChange?: (value: boolean) => void
  pendingAction?: string | null
  mutationError?: string | null
  onRefresh?: () => void
  onApprove?: (entry: PendingPairingEntry) => void
  onDeny?: (entry: PendingPairingEntry) => void
}

export function PairingQueueSurface({
  model,
  route,
  includeNonPending = false,
  onIncludeNonPendingChange,
  adminReason = '',
  onAdminReasonChange,
  permissions = '',
  onPermissionsChange,
  grantAdmin = false,
  onGrantAdminChange,
  pendingAction = null,
  mutationError = null,
  onRefresh,
  onApprove,
  onDeny
}: PairingQueueSurfaceProps) {
  const controlsDisabled = route.disabled || model.state === 'loading'
  const actionDisabled = controlsDisabled || Boolean(pendingAction)
  return (
    <div className="aui-pairing-queue">
      <StateSurface
        title="Pairing queue"
        state={model.state}
        description={model.description}
        evidence={model.evidence}
        actionLabel={route.requiresAdminAction ? 'AdminAction required for approve/deny' : null}
      />

      <section className="aui-pairing-controls" aria-label="Pairing queue controls">
        <label className="aui-inline-field">
          <input
            type="checkbox"
            checked={includeNonPending}
            disabled={controlsDisabled}
            onChange={(event) => onIncludeNonPendingChange?.(event.currentTarget.checked)}
          />
          <span>Include approved, denied, and expired requests</span>
        </label>
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
            placeholder="Auth.use, Gateway.use"
            onChange={(event) => onPermissionsChange?.(event.currentTarget.value)}
          />
        </label>
        <label className="aui-inline-field">
          <input
            type="checkbox"
            checked={grantAdmin}
            disabled={controlsDisabled}
            onChange={(event) => onGrantAdminChange?.(event.currentTarget.checked)}
          />
          <span>Grant admin role on approval</span>
        </label>
        <button className="aui-button" type="button" disabled={controlsDisabled} onClick={onRefresh}>Refresh</button>
      </section>

      {mutationError ? <p className="aui-message aui-message-danger" role="alert">{mutationError}</p> : null}
      {model.disabledReason ? <p className="aui-message">{model.disabledReason}</p> : null}
      {model.error ? <p className="aui-message aui-message-danger" role="alert">{model.error}</p> : null}
      {model.state === 'loading' ? <p className="aui-message" aria-live="polite">Loading pairing queue from AuroraClient.</p> : null}
      {model.state !== 'loading' && !model.disabledReason && !model.error && model.entries.length === 0 ? (
        <p className="aui-message">No pending device or peer pairing requests were reported by Auth.</p>
      ) : null}

      <section className="aui-pairing-list" aria-label="Pending device and peer pairing requests">
        {model.entries.map((entry) => (
          <article className="aui-pairing-card" key={entry.request_id}>
            <header className="aui-pairing-card-header">
              <div>
                <p className="aui-kicker">{entry.device_name || 'Unnamed device'}</p>
                <h2>{peerLabel(entry)}</h2>
              </div>
              <StatusBadge state={pairingState(entry)} />
            </header>
            <dl className="aui-pairing-facts">
              <div><dt>Request</dt><dd>{entry.request_id}</dd></div>
              <div><dt>Status</dt><dd>{entry.status}</dd></div>
              <div><dt>Client</dt><dd>{entry.client_ip || 'not reported'}</dd></div>
              <div><dt>Pairing code</dt><dd>{redactedCodeLabel(entry.code)}</dd></div>
              <div><dt>Expires</dt><dd>{formatDate(entry.expires_at)}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(entry.created_at)}</dd></div>
              <div><dt>Approved by</dt><dd>{entry.approved_by || 'not approved'}</dd></div>
              <div><dt>Denied by</dt><dd>{entry.denied_by || 'not denied'}</dd></div>
              <div><dt>Permissions</dt><dd>{entry.granted_permissions?.join(', ') || 'none granted'}</dd></div>
            </dl>
            <div className="aui-pairing-actions">
              <button
                className="aui-primary-action"
                type="button"
                disabled={actionDisabled || entry.status !== 'pending'}
                onClick={() => onApprove?.(entry)}
              >
                {pendingAction === `${entry.request_id}:approve` ? 'Submitting AdminAction' : 'AdminAction approve'}
              </button>
              <button
                className="aui-button"
                type="button"
                disabled={actionDisabled || entry.status !== 'pending'}
                onClick={() => onDeny?.(entry)}
              >
                {pendingAction === `${entry.request_id}:deny` ? 'Submitting AdminAction' : 'AdminAction deny'}
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}

export function buildPairingQueueModel({
  route,
  response = null,
  loadState = 'ready',
  error = null
}: PairingQueueModelInput): PairingQueueModel {
  if (route.disabled) {
    return {
      state: route.state,
      description: 'Pairing queue is disabled until the capability catalog reports Auth.ListPendingPairings as routeable.',
      evidence: routeEvidence(route),
      entries: [],
      total: 0,
      expiredCount: 0,
      secretsRedacted: true,
      disabledReason: `Capability unavailable: ${route.explanation}`,
      error: null
    }
  }
  if (loadState === 'loading') {
    return {
      state: 'loading',
      description: 'Loading device and peer pairing requests from Auth.ListPendingPairings.',
      evidence: routeEvidence(route),
      entries: [],
      total: 0,
      expiredCount: 0,
      secretsRedacted: true,
      disabledReason: null,
      error: null
    }
  }
  if (loadState === 'error') {
    const state = errorState(error)
    return {
      state,
      description: state === 'denied'
        ? 'Auth denied pairing queue access for the current principal.'
        : 'Pairing queue could not be loaded from AuroraClient; no local fallback state is shown.',
      evidence: `${routeEvidence(route)}; AuroraClient error`,
      entries: [],
      total: 0,
      expiredCount: 0,
      secretsRedacted: true,
      disabledReason: null,
      error: pairingErrorMessage(error)
    }
  }

  const entries = response?.pairings ?? []
  const expiredCount = response?.expired_count ?? entries.filter((entry) => pairingState(entry) === 'stale').length
  return {
    state: entries.length > 0 ? 'pending' : route.state,
    description: entries.length > 0
      ? 'Auth reports pending device or peer pairing requests that require explicit review.'
      : 'Auth reports no pending device or peer pairing requests.',
    evidence: `${routeEvidence(route)}; total=${response?.total ?? entries.length}; expired=${expiredCount}; secrets_redacted=${response?.secrets_redacted ?? true}`,
    entries,
    total: response?.total ?? entries.length,
    expiredCount,
    secretsRedacted: response?.secrets_redacted ?? true,
    disabledReason: null,
    error: null
  }
}

export function parsePermissionList(value: string): string[] | null {
  const permissions = value
    .split(/[\s,]+/)
    .map((permission) => permission.trim())
    .filter(Boolean)
  return permissions.length > 0 ? permissions : null
}

export function buildPairingAdminActionRequest(
  entry: PendingPairingEntry,
  action: 'approve' | 'deny',
  input: { reason: string; permissions?: string; grantAdmin?: boolean }
): PairingAdminActionRequest {
  const reason = input.reason.trim() || `${action} pairing request ${entry.request_id}`
  if (action === 'approve') {
    return {
      methodId: AUTH_METHODS.pairingApprove,
      payload: {
        code: entry.code,
        permissions: parsePermissionList(input.permissions ?? ''),
        is_admin: Boolean(input.grantAdmin)
      },
      reason,
      reauthConfirmed: true,
      affectedResources: affectedResourcesFor(entry),
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
    reauthConfirmed: true,
    affectedResources: affectedResourcesFor(entry),
    path: routePath('Auth', 'PairingDeny')
  }
}

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof AuroraError) {
    if (error.code === 'permission' || error.code === 'auth') return `Permission denied by Auth: ${error.message}`
    if (error.code === 'unavailable_service') return `Auth service unavailable: ${error.message}`
    if (error.code === 'unsupported_feature') return `Pairing queue unsupported by this backend: ${error.message}`
    if (error.code === 'timeout') return `AuroraClient request timed out: ${error.message}`
    return error.message
  }
  return error instanceof Error ? error.message : 'Unknown pairing queue error'
}

function routeEvidence(route: RouteAvailability): string {
  const blockers = route.blockers.length > 0 ? route.blockers.join(',') : 'none'
  return `${route.providerLabel}; state=${route.state}; blockers=${blockers}; sources=${route.evidenceSources.join(',') || 'none'}`
}

function errorState(error: unknown): AvailabilityState | 'error' {
  if (error instanceof AuroraError) {
    if (error.code === 'permission' || error.code === 'auth') return 'denied'
    if (error.code === 'unsupported_feature') return 'unsupported'
    return 'degraded'
  }
  return 'error'
}

function pairingState(entry: PendingPairingEntry): AvailabilityState {
  if (entry.status === 'approved') return 'available-local'
  if (entry.status === 'denied') return 'denied'
  if (isExpired(entry.expires_at)) return 'stale'
  return 'pending'
}

function isExpired(value: string): boolean {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp < Date.now()
}

function peerLabel(entry: PendingPairingEntry): string {
  if (entry.remote_node_name && entry.remote_peer_id) return `${entry.remote_node_name} / ${entry.remote_peer_id}`
  if (entry.remote_node_name) return entry.remote_node_name
  if (entry.remote_peer_id) return entry.remote_peer_id
  return 'Local device pairing'
}

function redactedCodeLabel(value: string): string {
  return value ? 'redacted by UI' : 'not reported'
}

function affectedResourcesFor(entry: PendingPairingEntry): string[] {
  return [
    `pairing:${entry.request_id}`,
    entry.remote_peer_id ? `peer:${entry.remote_peer_id}` : null,
    entry.device_name ? `device:${entry.device_name}` : null
  ].filter((value): value is string => Boolean(value))
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
