'use client'

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AUTH_METHODS,
  AuroraError,
  routePath,
  type AuroraClient,
  type AuthPairingExchangeResponse,
  type AuthPairingStartResponse,
  type AvailabilityState,
  type JsonObject,
  type ListPendingPairingsResponse,
  type PendingPairingEntry,
  type TokenRevokeResponse
} from '@aurora/client'
import { StateSurface } from './state-surface'
import { StatusBadge, presentableSignal } from './status-badges'
import type { RouteAvailability } from './shell-data'

export type PairingQueueLoadState = 'loading' | 'ready' | 'error'
export type PairingOperationStatus = 'idle' | 'pending' | 'success' | 'error'
export type PairingAdminActionKind = 'create' | 'approve' | 'deny' | 'exchange' | 'revoke-token'

const PAIRING_ADMIN_ACTION_METHODS = new Set<string>([
  AUTH_METHODS.pairingStart,
  AUTH_METHODS.pairingApprove,
  AUTH_METHODS.pairingDeny,
  AUTH_METHODS.pairingExchange,
  AUTH_METHODS.revokeToken
])

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

export interface PairingCredentialModel {
  code: string
  expiresInSeconds: number | null
  expiresAt: string | null
  deepLink: string
  qrPayload: string
  qrUnavailableReason: string
  auditReceipt: string | null
}

export interface PairingExchangeModel {
  tokenId: string | null
  state: string
  auditReceipt: string | null
  tokenSecretRedacted: true
}

export interface PairingOperationModel {
  status: PairingOperationStatus
  message: string | null
  auditReceipt: string | null
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

export interface PairingCreateInput {
  deviceName: string
  clientIp?: string
  remotePeerId?: string
  remoteNodeName?: string
  reason: string
  reauthConfirmed?: boolean
}

export interface PairingExchangeInput {
  code: string
  reason: string
  reauthConfirmed?: boolean
}

export interface PairingRevokeInput {
  tokenId: string
  reason: string
  reauthConfirmed?: boolean
}

export function PairingQueueView({ client, route }: PairingQueueViewProps) {
  const [includeNonPending, setIncludeNonPending] = useState(false)
  const [response, setResponse] = useState<ListPendingPairingsResponse | null>(null)
  const [loadState, setLoadState] = useState<PairingQueueLoadState>(route.disabled ? 'ready' : 'loading')
  const [loadError, setLoadError] = useState<unknown>(null)
  const [adminReason, setAdminReason] = useState('Review pending device or peer pairing request')
  const [permissions, setPermissions] = useState('')
  const [grantAdmin, setGrantAdmin] = useState(false)
  const [reauthConfirmed, setReauthConfirmed] = useState(false)
  const [createDeviceName, setCreateDeviceName] = useState('New Aurora device')
  const [createRemotePeerId, setCreateRemotePeerId] = useState('')
  const [createRemoteNodeName, setCreateRemoteNodeName] = useState('')
  const [exchangeCode, setExchangeCode] = useState('')
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [operation, setOperation] = useState<PairingOperationModel>({ status: 'idle', message: null, auditReceipt: null })
  const [createdCredential, setCreatedCredential] = useState<PairingCredentialModel | null>(null)
  const [exchangeResult, setExchangeResult] = useState<PairingExchangeModel | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [copiedRequestId, setCopiedRequestId] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)

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
      setOperation({ status: 'pending', message: `${action} pairing pending AdminAction draft, confirmation, and audit.`, auditReceipt: null })
      setMutationError(null)
      setCopyError(null)
      const reason = adminReason.trim() || `${action} pairing request ${entry.request_id}`
      try {
        const result = await client.admin.execute(buildPairingAdminActionRequest(entry, action, { reason, permissions, grantAdmin, reauthConfirmed }))
        setOperation({
          status: 'success',
          message: `${action} pairing completed through AdminAction; queue refresh requested.`,
          auditReceipt: result.confirmation.audit_receipt
        })
        await loadQueue()
      } catch (error) {
        const message = pairingErrorMessage(error)
        setMutationError(message)
        setOperation({ status: 'error', message, auditReceipt: null })
      } finally {
        setPendingAction(null)
      }
    },
    [adminReason, client.admin, grantAdmin, loadQueue, permissions, reauthConfirmed]
  )

  const createPairingCredential = useCallback(async () => {
    const request = buildPairingCreateAdminActionRequest({
      deviceName: createDeviceName,
      remotePeerId: createRemotePeerId,
      remoteNodeName: createRemoteNodeName,
      reason: adminReason,
      reauthConfirmed
    })
    setPendingAction('create')
    setMutationError(null)
    setCreatedCredential(null)
    setOperation({ status: 'pending', message: 'Creating pairing code through AdminAction draft, confirmation, and audit.', auditReceipt: null })
    try {
      const result = await client.admin.execute<AuthPairingStartResponse>(request)
      setCreatedCredential(buildPairingCredentialModel(result.data, result.confirmation.audit_receipt))
      setOperation({
        status: 'success',
        message: 'Pairing code created; copy the code or deep link before it expires. QR rendering remains unavailable without a QR contract/renderer.',
        auditReceipt: result.confirmation.audit_receipt
      })
      await loadQueue()
    } catch (error) {
      const message = pairingErrorMessage(error)
      setMutationError(message)
      setOperation({ status: 'error', message, auditReceipt: null })
    } finally {
      setPendingAction(null)
    }
  }, [adminReason, client.admin, createDeviceName, createRemoteNodeName, createRemotePeerId, loadQueue, reauthConfirmed])

  const exchangePairingCode = useCallback(async () => {
    const request = buildPairingExchangeAdminActionRequest({ code: exchangeCode, reason: adminReason, reauthConfirmed })
    setPendingAction('exchange')
    setMutationError(null)
    setExchangeResult(null)
    setOperation({ status: 'pending', message: 'Exchanging pairing code through AdminAction; returned token secrets will be redacted.', auditReceipt: null })
    try {
      const result = await client.admin.execute<AuthPairingExchangeResponse>(request)
      setExchangeResult({
        tokenId: result.data.token_id ?? null,
        state: result.data.peer_id ? 'mesh_peer' : 'user',
        auditReceipt: result.confirmation.audit_receipt,
        tokenSecretRedacted: true
      })
      setOperation({
        status: 'success',
        message: result.data.token_id
          ? 'Pairing exchange completed and token id captured for optional revoke.'
          : 'Pairing exchange completed; backend did not return a token id for revoke.',
        auditReceipt: result.confirmation.audit_receipt
      })
    } catch (error) {
      const message = pairingErrorMessage(error)
      setMutationError(message)
      setOperation({ status: 'error', message, auditReceipt: null })
    } finally {
      setPendingAction(null)
    }
  }, [adminReason, client.admin, exchangeCode, reauthConfirmed])

  const revokeExchangedToken = useCallback(async () => {
    if (!exchangeResult?.tokenId) return
    const request = buildPairingTokenRevokeAdminActionRequest({ tokenId: exchangeResult.tokenId, reason: adminReason, reauthConfirmed })
    setPendingAction('revoke-token')
    setMutationError(null)
    setOperation({ status: 'pending', message: 'Revoking exchanged token through AdminAction.', auditReceipt: null })
    try {
      const result = await client.admin.execute<TokenRevokeResponse>(request)
      setOperation({
        status: 'success',
        message: result.data.success ? 'Exchanged token revoked through Auth.RevokeToken.' : 'Auth.RevokeToken completed without success confirmation.',
        auditReceipt: result.confirmation.audit_receipt
      })
    } catch (error) {
      const message = pairingErrorMessage(error)
      setMutationError(message)
      setOperation({ status: 'error', message, auditReceipt: null })
    } finally {
      setPendingAction(null)
    }
  }, [adminReason, client.admin, exchangeResult?.tokenId, reauthConfirmed])

  const copySecret = useCallback(async (value: string, requestId: string) => {
    setCopyError(null)
    setCopiedRequestId(null)
    if (!value) {
      setCopyError('No pairing value was reported for this request.')
      return
    }
    try {
      const clipboard = globalThis.navigator?.clipboard
      if (!clipboard?.writeText) {
        throw new Error('Clipboard API unavailable; open the controlled pairing details on a secure desktop session.')
      }
      await clipboard.writeText(value)
      setCopiedRequestId(requestId)
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : 'Unable to copy pairing value.')
    }
  }, [])

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
      reauthConfirmed={reauthConfirmed}
      onReauthConfirmedChange={setReauthConfirmed}
      createDeviceName={createDeviceName}
      onCreateDeviceNameChange={setCreateDeviceName}
      createRemotePeerId={createRemotePeerId}
      onCreateRemotePeerIdChange={setCreateRemotePeerId}
      createRemoteNodeName={createRemoteNodeName}
      onCreateRemoteNodeNameChange={setCreateRemoteNodeName}
      exchangeCode={exchangeCode}
      onExchangeCodeChange={setExchangeCode}
      pendingAction={pendingAction}
      operation={operation}
      createdCredential={createdCredential}
      exchangeResult={exchangeResult}
      mutationError={mutationError}
      copiedRequestId={copiedRequestId}
      copyError={copyError}
      onRefresh={loadQueue}
      onCopyValue={copySecret}
      onCreate={createPairingCredential}
      onExchange={exchangePairingCode}
      onRevokeExchangedToken={revokeExchangedToken}
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
  reauthConfirmed?: boolean
  onReauthConfirmedChange?: (value: boolean) => void
  createDeviceName?: string
  onCreateDeviceNameChange?: (value: string) => void
  createRemotePeerId?: string
  onCreateRemotePeerIdChange?: (value: string) => void
  createRemoteNodeName?: string
  onCreateRemoteNodeNameChange?: (value: string) => void
  exchangeCode?: string
  onExchangeCodeChange?: (value: string) => void
  pendingAction?: string | null
  operation?: PairingOperationModel
  createdCredential?: PairingCredentialModel | null
  exchangeResult?: PairingExchangeModel | null
  mutationError?: string | null
  copiedRequestId?: string | null
  copyError?: string | null
  onRefresh?: () => void
  onCopyValue?: (value: string, id: string) => void
  onCopyCode?: (entry: PendingPairingEntry) => void
  onCreate?: () => void
  onExchange?: () => void
  onRevokeExchangedToken?: () => void
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
  reauthConfirmed = false,
  onReauthConfirmedChange,
  createDeviceName = '',
  onCreateDeviceNameChange,
  createRemotePeerId = '',
  onCreateRemotePeerIdChange,
  createRemoteNodeName = '',
  onCreateRemoteNodeNameChange,
  exchangeCode = '',
  onExchangeCodeChange,
  pendingAction = null,
  operation = { status: 'idle', message: null, auditReceipt: null },
  createdCredential = null,
  exchangeResult = null,
  mutationError = null,
  copiedRequestId = null,
  copyError = null,
  onRefresh,
  onCopyValue,
  onCopyCode,
  onCreate,
  onExchange,
  onRevokeExchangedToken,
  onApprove,
  onDeny
}: PairingQueueSurfaceProps) {
  const controlsDisabled = route.disabled || model.state === 'loading'
  const adminActionReady = !controlsDisabled
  const actionDisabled = controlsDisabled || Boolean(pendingAction) || !reauthConfirmed
  const canCreate = adminActionReady && reauthConfirmed && Boolean(createDeviceName.trim()) && !pendingAction && Boolean(onCreate)
  const canExchange = adminActionReady && reauthConfirmed && Boolean(exchangeCode.trim()) && !pendingAction && Boolean(onExchange)
  const canRevokeToken = adminActionReady && reauthConfirmed && Boolean(exchangeResult?.tokenId) && !pendingAction && Boolean(onRevokeExchangedToken)
  return (
    <div className="aui-pairing-queue">
      <StateSurface
        title="Pairing queue"
        state={model.state}
        description={model.description}
        evidence={model.evidence}
        actionLabel="Admin action required"
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
        <label className="aui-inline-field">
          <input
            type="checkbox"
            checked={reauthConfirmed}
            disabled={controlsDisabled}
            onChange={(event) => onReauthConfirmedChange?.(event.currentTarget.checked)}
          />
          <span>In-session admin unlock confirmed for AdminAction submit</span>
        </label>
        <button className="aui-button" type="button" disabled={controlsDisabled} onClick={onRefresh}>Refresh</button>
      </section>

      <section className="aui-pairing-admin" aria-label="Admin pairing code creation and exchange">
        <h2>Pairing code, QR, and deep link</h2>
        <p>
          Pairing creation uses <code>{AUTH_METHODS.pairingStart}</code> through AdminAction. QR image output is honest-unavailable until a QR renderer or backend QR contract exists; the deep link payload is shown for native handoff.
        </p>
        <form className="aui-pairing-controls" onSubmit={(event: FormEvent) => { event.preventDefault(); onCreate?.() }}>
          <label>
            <span>Device name</span>
            <input value={createDeviceName} disabled={controlsDisabled} onChange={(event) => onCreateDeviceNameChange?.(event.currentTarget.value)} />
          </label>
          <label>
            <span>Remote peer id</span>
            <input value={createRemotePeerId} disabled={controlsDisabled} placeholder="optional mesh peer id" onChange={(event) => onCreateRemotePeerIdChange?.(event.currentTarget.value)} />
          </label>
          <label>
            <span>Remote node name</span>
            <input value={createRemoteNodeName} disabled={controlsDisabled} placeholder="optional node name" onChange={(event) => onCreateRemoteNodeNameChange?.(event.currentTarget.value)} />
          </label>
          <button className="aui-primary-action" type="submit" disabled={!canCreate}>
            {pendingAction === 'create' ? 'Creating through AdminAction' : 'Create pairing code via AdminAction'}
          </button>
        </form>
        {createdCredential ? (
          <div className="aui-card" aria-label="Created pairing credential">
            <dl className="aui-pairing-facts">
              <div><dt>One-time pairing code</dt><dd><code>{createdCredential.code}</code></dd></div>
              <div><dt>Expires</dt><dd>{createdCredential.expiresAt ? formatDate(createdCredential.expiresAt) : `${createdCredential.expiresInSeconds ?? 'unknown'} seconds`}</dd></div>
              <div><dt>Deep link</dt><dd><code>{createdCredential.deepLink}</code></dd></div>
              <div><dt>QR</dt><dd>{createdCredential.qrUnavailableReason}</dd></div>
              <div><dt>Audit</dt><dd>{createdCredential.auditReceipt ?? 'audit receipt pending'}</dd></div>
            </dl>
            <div className="aui-pairing-actions">
              <button type="button" className="aui-button" onClick={() => onCopyValue?.(createdCredential.code, 'created-code')}>Copy one-time code</button>
              <button type="button" className="aui-button" onClick={() => onCopyValue?.(createdCredential.deepLink, 'created-link')}>Copy deep link</button>
            </div>
            <p className="aui-message">QR payload: {createdCredential.qrPayload}</p>
          </div>
        ) : null}
      </section>

      <section className="aui-pairing-admin" aria-label="Pairing exchange and revoke">
        <h2>Exchange and revoke</h2>
        <p>
          Exchange uses <code>{AUTH_METHODS.pairingExchange}</code> through AdminAction. Pending-code revoke is unavailable because <code>Auth.PairingRevoke</code> is not exposed; exchanged tokens can be revoked through <code>{AUTH_METHODS.revokeToken}</code> when the backend returns a token id.
        </p>
        <form className="aui-pairing-controls" onSubmit={(event: FormEvent) => { event.preventDefault(); onExchange?.() }}>
          <label>
            <span>Pairing code to exchange</span>
            <input value={exchangeCode} disabled={controlsDisabled} placeholder="paste code from device" onChange={(event) => onExchangeCodeChange?.(event.currentTarget.value)} />
          </label>
          <button className="aui-primary-action" type="submit" disabled={!canExchange}>
            {pendingAction === 'exchange' ? 'Exchanging through AdminAction' : 'Exchange via AdminAction'}
          </button>
          <button className="aui-button" type="button" disabled={!canRevokeToken} onClick={onRevokeExchangedToken}>
            {pendingAction === 'revoke-token' ? 'Revoking through AdminAction' : 'Revoke exchanged token via AdminAction'}
          </button>
        </form>
        <p className="aui-message">Pending pairing revoke unavailable: missing backend contract Auth.PairingRevoke.</p>
        {exchangeResult ? (
          <div className="aui-card" aria-label="Pairing exchange result">
            <dl className="aui-pairing-facts">
              <div><dt>Session state</dt><dd>{exchangeResult.state}</dd></div>
              <div><dt>Token id</dt><dd>{exchangeResult.tokenId ?? 'not returned'}</dd></div>
              <div><dt>Token secret</dt><dd>redacted after exchange</dd></div>
              <div><dt>Audit</dt><dd>{exchangeResult.auditReceipt ?? 'audit receipt pending'}</dd></div>
            </dl>
          </div>
        ) : null}
      </section>

      {operation.message ? <p className={`aui-message${operation.status === 'error' ? ' aui-message-danger' : ''}`} role={operation.status === 'error' ? 'alert' : 'status'}>{operation.message}</p> : null}
      {operation.auditReceipt ? <p className="aui-message">AdminAction audit receipt: {operation.auditReceipt}</p> : null}
      {mutationError ? <p className="aui-message aui-message-danger" role="alert">{mutationError}</p> : null}
      {copyError ? <p className="aui-message aui-message-danger" role="alert">{copyError}</p> : null}
      {copiedRequestId ? <p className="aui-message" role="status">Pairing code copied from controlled Admin pairing surface; secrets stay scoped to clipboard and are not logged.</p> : null}
      {model.disabledReason ? <p className="aui-message">{model.disabledReason}</p> : null}
      {model.error ? <p className="aui-message aui-message-danger" role="alert">{model.error}</p> : null}
      {model.state === 'loading' ? <p className="aui-message" aria-live="polite">Loading pairing queue from Aurora.</p> : null}
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
              <div><dt>Expiry state</dt><dd>{isExpired(entry.expires_at) ? 'expired' : 'active'}</dd></div>
              <div><dt>Expires</dt><dd>{formatDate(entry.expires_at)}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(entry.created_at)}</dd></div>
              <div><dt>Approved by</dt><dd>{entry.approved_by || 'not approved'}</dd></div>
              <div><dt>Denied by</dt><dd>{entry.denied_by || 'not denied'}</dd></div>
              <div><dt>Deny reason</dt><dd>{entry.denied_reason || 'none'}</dd></div>
              <div><dt>Permissions</dt><dd>{entry.granted_permissions?.join(', ') || 'none granted'}</dd></div>
              <div><dt>Admin grant</dt><dd>{entry.granted_is_admin ? 'yes' : 'no'}</dd></div>
            </dl>
            <div className="aui-pairing-actions">
              <button
                className="aui-button"
                type="button"
                disabled={actionDisabled || entry.status !== 'pending' || !entry.code || (!onCopyValue && !onCopyCode)}
                onClick={() => onCopyCode ? onCopyCode(entry) : onCopyValue?.(entry.code, entry.request_id)}
              >
                Copy pairing code
              </button>
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
      description: 'Pairing queue is disabled until Aurora reports pending-pairing access as available.',
      evidence: routeEvidence(route),
      entries: [],
      total: 0,
      expiredCount: 0,
      secretsRedacted: true,
      disabledReason: `Capability unavailable: ${presentableSignal(route.explanation)}`,
      error: null
    }
  }
  if (loadState === 'loading') {
    return {
      state: 'loading',
      description: 'Loading device and peer pairing requests from Aurora.',
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
        : 'Pairing queue could not be loaded from Aurora; no local fallback state is shown.',
      evidence: `${routeEvidence(route)}; Aurora unavailable`,
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
  input: { reason: string; permissions?: string; grantAdmin?: boolean; reauthConfirmed?: boolean }
): PairingAdminActionRequest {
  const reason = input.reason.trim() || `${action} pairing request ${entry.request_id}`
  const code = requirePairingCode(entry.code, action)
  if (action === 'approve') {
    return assertPairingAdminAction({
      methodId: AUTH_METHODS.pairingApprove,
      payload: {
        code,
        permissions: parsePermissionList(input.permissions ?? ''),
        is_admin: Boolean(input.grantAdmin)
      },
      reason,
      reauthConfirmed: Boolean(input.reauthConfirmed),
      affectedResources: affectedResourcesFor(entry),
      path: routePath('Auth', 'PairingApprove')
    })
  }
  return assertPairingAdminAction({
    methodId: AUTH_METHODS.pairingDeny,
    payload: {
      code,
      reason
    },
    reason,
    reauthConfirmed: Boolean(input.reauthConfirmed),
    affectedResources: affectedResourcesFor(entry),
    path: routePath('Auth', 'PairingDeny')
  })
}

export function buildPairingCreateAdminActionRequest(input: PairingCreateInput): PairingAdminActionRequest {
  const deviceName = input.deviceName.trim()
  if (!deviceName) throw new Error('Device name is required before creating a pairing code.')
  const payload: JsonObject = { device_name: deviceName }
  if (input.clientIp?.trim()) payload.client_ip = input.clientIp.trim()
  if (input.remotePeerId?.trim()) payload.remote_peer_id = input.remotePeerId.trim()
  if (input.remoteNodeName?.trim()) payload.remote_node_name = input.remoteNodeName.trim()
  return assertPairingAdminAction({
    methodId: AUTH_METHODS.pairingStart,
    payload,
    reason: input.reason.trim() || `create pairing code for ${deviceName}`,
    reauthConfirmed: Boolean(input.reauthConfirmed),
    affectedResources: [`pairing:new:${deviceName}`, input.remotePeerId?.trim() ? `peer:${input.remotePeerId.trim()}` : null].filter((value): value is string => Boolean(value)),
    path: routePath('Auth', 'PairingStart')
  })
}

export function buildPairingExchangeAdminActionRequest(input: PairingExchangeInput): PairingAdminActionRequest {
  const code = input.code.trim()
  if (!code) throw new Error('Pairing code is required before exchange.')
  return assertPairingAdminAction({
    methodId: AUTH_METHODS.pairingExchange,
    payload: { code },
    reason: input.reason.trim() || 'exchange pairing code from admin pairing surface',
    reauthConfirmed: Boolean(input.reauthConfirmed),
    affectedResources: [`pairing-code:${redactedIdentifier(code)}`, 'auth-session'],
    path: routePath('Auth', 'PairingExchange')
  })
}

export function buildPairingTokenRevokeAdminActionRequest(input: PairingRevokeInput): PairingAdminActionRequest {
  const tokenId = input.tokenId.trim()
  if (!tokenId) throw new Error('Token id is required before revoke.')
  return assertPairingAdminAction({
    methodId: AUTH_METHODS.revokeToken,
    payload: { token_id: tokenId },
    reason: input.reason.trim() || `revoke exchanged pairing token ${tokenId}`,
    reauthConfirmed: Boolean(input.reauthConfirmed),
    affectedResources: [`token:${tokenId}`, 'auth-session'],
    path: routePath('Auth', 'RevokeToken')
  })
}

export function buildPairingCredentialModel(
  response: AuthPairingStartResponse,
  auditReceipt: string | null = null
): PairingCredentialModel {
  const deepLink = pairingDeepLink(response.code)
  return {
    code: response.code,
    expiresInSeconds: response.expires_in_seconds,
    expiresAt: expiryFromSeconds(response.expires_in_seconds),
    deepLink,
    qrPayload: deepLink,
    qrUnavailableReason: 'QR image unavailable: no @aurora/ui QR renderer or backend QR contract is exposed in this checkout.',
    auditReceipt
  }
}

export function pairingDeepLink(code: string): string {
  return `aurora://pairing/exchange?code=${encodeURIComponent(code)}`
}

export function assertPairingAdminAction(request: PairingAdminActionRequest): PairingAdminActionRequest {
  if (!PAIRING_ADMIN_ACTION_METHODS.has(request.methodId)) {
    throw new Error(`Pairing mutation ${request.methodId} is not allowlisted for this AdminAction surface.`)
  }
  if (!request.reauthConfirmed) throw new Error('Pairing mutations require reauthConfirmed AdminAction requests.')
  if (!request.reason.trim()) throw new Error('Pairing mutations require an AdminAction reason.')
  return request
}

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof AuroraError) {
    if (error.code === 'permission' || error.code === 'auth') return `Permission denied by Auth: ${error.message}`
    if (error.code === 'unavailable_service') return `Auth service unavailable: ${error.message}`
    if (error.code === 'unsupported_feature') return `Pairing backend unsupported by this deployment: ${error.message}`
    if (error.code === 'timeout') return `Aurora request timed out: ${error.message}`
    return error.message
  }
  return error instanceof Error ? error.message : 'Unknown pairing queue error'
}

function routeEvidence(route: RouteAvailability): string {
  const blockers = route.blockers.length > 0 ? route.blockers.join(',') : 'none'
  const action = route.requiresAdminAction ? 'route-admin-action' : 'pairing-mutations-force-admin-action'
  return `${route.providerLabel}; state=${route.state}; ${action}; blockers=${blockers}; sources=${route.evidenceSources.join(',') || 'none'}`
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

function requirePairingCode(value: string, action: 'approve' | 'deny'): string {
  if (!value) throw new Error(`Cannot ${action} pairing request without backend-reported pairing code.`)
  return value
}

function redactedIdentifier(value: string): string {
  if (value.length <= 4) return 'redacted'
  return `${value.slice(0, 2)}…${value.slice(-2)}`
}

function expiryFromSeconds(seconds: number | null | undefined): string | null {
  if (!Number.isFinite(seconds) || seconds === undefined || seconds === null) return null
  return new Date(Date.now() + seconds * 1000).toISOString()
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
