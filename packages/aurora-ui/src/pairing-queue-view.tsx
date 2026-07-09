'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Alert, AlertDescription } from '#components/ui/alert'
import { Input } from '#components/ui/input'
import { Label } from '#components/ui/label'
import { Textarea } from '#components/ui/textarea'
import { PageHeader } from './state-surface'
import { StatusBadge, presentableSignal } from './status-badges'
import type { RouteAvailability } from './shell-data'
import {
  Button,
  Card,
  DataTable,
  MetaGrid,
  StatStrip,
  Switch,
  type DataColumn
} from './primitives'
import { KeyRound, Plus, RefreshCcw, RotateCcw } from 'lucide-react'

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
  const reauthReason = reauthConfirmed ? undefined : 'Confirm the in-session admin unlock to submit AdminAction requests.'

  const queueColumns: Array<DataColumn<PendingPairingEntry>> = [
    {
      key: 'device',
      header: 'Device / peer',
      render: (entry) => (
        <span className="flex flex-col gap-0.5">
          <strong>{entry.device_name || 'Unnamed device'}</strong>
          <small className="text-xs text-muted-foreground">{peerLabel(entry)}</small>
        </span>
      )
    },
    { key: 'status', header: 'Status', render: (entry) => <StatusBadge state={pairingState(entry)} /> },
    { key: 'client', header: 'Client', hideAt: 'md', render: (entry) => entry.client_ip || 'not reported' },
    { key: 'expiry', header: 'Expiry state', render: (entry) => (isExpired(entry.expires_at) ? 'expired' : 'active') },
    { key: 'expires', header: 'Expires', hideAt: 'lg', render: (entry) => formatDate(entry.expires_at) },
    {
      key: 'code',
      header: 'Pairing code',
      hideAt: 'lg',
      render: (entry) => <span className="font-mono text-xs">{redactedCodeLabel(entry.code)}</span>
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      render: (entry) => (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            variant="ghost"
            disabled={actionDisabled || entry.status !== 'pending' || !entry.code || (!onCopyValue && !onCopyCode)}
            onClick={() => (onCopyCode ? onCopyCode(entry) : onCopyValue?.(entry.code, entry.request_id))}
          >
            Copy code
          </Button>
          <Button
            variant="primary"
            disabled={actionDisabled || entry.status !== 'pending'}
            disabledReason={reauthReason}
            onClick={() => onApprove?.(entry)}
          >
            {pendingAction === `${entry.request_id}:approve` ? 'Submitting AdminAction' : 'AdminAction approve'}
          </Button>
          <Button
            variant="danger"
            disabled={actionDisabled || entry.status !== 'pending'}
            disabledReason={reauthReason}
            onClick={() => onDeny?.(entry)}
          >
            {pendingAction === `${entry.request_id}:deny` ? 'Submitting AdminAction' : 'AdminAction deny'}
          </Button>
        </div>
      )
    }
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Admin"
        title="Pairing queue"
        description="Review pending device and peer pairing requests, and mint or exchange pairing codes through audited AdminAction."
        badges={<StatusBadge state={route.state} />}
        badgesLabel="Pairing route status"
        actions={
          <Button
            variant="outline"
            icon={<RefreshCcw size={16} aria-hidden />}
            disabled={controlsDisabled}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        }
      />

      <StatStrip
        items={[
          { label: 'Pending', value: String(model.total) },
          { label: 'Expired', value: String(model.expiredCount) },
          { label: 'Secrets', value: 'Protected', tone: 'success' },
          { label: 'Queue', value: String(model.state) }
        ]}
      />

      <Card title="AdminAction options" ariaLabel="Pairing AdminAction options">
        <p className="text-sm text-muted-foreground">Approve, deny, create, and exchange all route through Aurora AdminAction; provide a reason and confirm the in-session unlock before submitting.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pairing-reason">AdminAction reason</Label>
            <Textarea
              id="pairing-reason"
              value={adminReason}
              rows={2}
              disabled={controlsDisabled}
              onChange={(event) => onAdminReasonChange?.(event.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pairing-permissions">Approve permissions</Label>
            <Input
              id="pairing-permissions"
              value={permissions}
              disabled={controlsDisabled}
              placeholder="Auth.use, Gateway.use"
              onChange={(event) => onPermissionsChange?.(event.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground">Space or comma separated permissions granted on approval.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Switch
            checked={includeNonPending}
            disabled={controlsDisabled}
            onChange={(value) => onIncludeNonPendingChange?.(value)}
            label="Include approved, denied, and expired requests"
          />
          <Switch
            checked={grantAdmin}
            disabled={controlsDisabled}
            onChange={(value) => onGrantAdminChange?.(value)}
            label="Grant admin role on approval"
          />
          <Switch
            checked={reauthConfirmed}
            disabled={controlsDisabled}
            onChange={(value) => onReauthConfirmedChange?.(value)}
            label="In-session admin unlock confirmed for AdminAction submit"
          />
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Create pairing code" icon={<KeyRound size={18} aria-hidden />} ariaLabel="Create pairing code">
          <p className="text-sm text-muted-foreground">
            Uses <code className="font-mono text-xs">{AUTH_METHODS.pairingStart}</code>. QR image is unavailable until a renderer or backend QR contract exists; the deep-link payload is provided for native handoff.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pairing-device">Device name</Label>
            <Input id="pairing-device" value={createDeviceName} disabled={controlsDisabled} onChange={(event) => onCreateDeviceNameChange?.(event.currentTarget.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pairing-peer">Remote peer id</Label>
            <Input id="pairing-peer" value={createRemotePeerId} disabled={controlsDisabled} placeholder="optional mesh peer id" onChange={(event) => onCreateRemotePeerIdChange?.(event.currentTarget.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pairing-node">Remote node name</Label>
            <Input id="pairing-node" value={createRemoteNodeName} disabled={controlsDisabled} placeholder="optional node name" onChange={(event) => onCreateRemoteNodeNameChange?.(event.currentTarget.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<Plus size={16} aria-hidden />}
              disabled={!canCreate}
              disabledReason={!reauthConfirmed ? reauthReason : 'Enter a device name to create a pairing code.'}
              busy={pendingAction === 'create'}
              onClick={onCreate}
            >
              {pendingAction === 'create' ? 'Creating through AdminAction' : 'Create pairing code via AdminAction'}
            </Button>
          </div>
          {createdCredential ? (
            <section className="rounded-lg border border-success/35 bg-success/5 p-3" aria-label="Created pairing credential">
              <MetaGrid
                columns={1}
                items={[
                  { label: 'One-time pairing code', value: <code className="font-mono text-xs">{createdCredential.code}</code> },
                  { label: 'Expires', value: createdCredential.expiresAt ? formatDate(createdCredential.expiresAt) : `${createdCredential.expiresInSeconds ?? 'unknown'} seconds` },
                  { label: 'Deep link', value: <code className="font-mono text-xs">{createdCredential.deepLink}</code> },
                  { label: 'QR', value: createdCredential.qrUnavailableReason },
                  { label: 'Audit', value: createdCredential.auditReceipt ?? 'audit receipt pending' }
                ]}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => onCopyValue?.(createdCredential.code, 'created-code')}>Copy one-time code</Button>
                <Button variant="outline" onClick={() => onCopyValue?.(createdCredential.deepLink, 'created-link')}>Copy deep link</Button>
              </div>
            </section>
          ) : null}
        </Card>

        <Card title="Exchange and revoke" icon={<RotateCcw size={18} aria-hidden />} ariaLabel="Pairing exchange and revoke">
          <p className="text-sm text-muted-foreground">
            Exchange uses <code className="font-mono text-xs">{AUTH_METHODS.pairingExchange}</code>. Exchanged tokens revoke through <code className="font-mono text-xs">{AUTH_METHODS.revokeToken}</code> when the backend returns a token id.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pairing-exchange-code">Pairing code to exchange</Label>
            <Input id="pairing-exchange-code" value={exchangeCode} disabled={controlsDisabled} placeholder="paste code from device" onChange={(event) => onExchangeCodeChange?.(event.currentTarget.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!canExchange}
              disabledReason={!reauthConfirmed ? reauthReason : 'Enter a pairing code to exchange.'}
              busy={pendingAction === 'exchange'}
              onClick={onExchange}
            >
              {pendingAction === 'exchange' ? 'Exchanging through AdminAction' : 'Exchange via AdminAction'}
            </Button>
            <Button
              variant="outline"
              disabled={!canRevokeToken}
              disabledReason="Revoke needs a token id returned from a completed exchange."
              busy={pendingAction === 'revoke-token'}
              onClick={onRevokeExchangedToken}
            >
              {pendingAction === 'revoke-token' ? 'Revoking through AdminAction' : 'Revoke exchanged token via AdminAction'}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground" role="note">Pending pairing revoke unavailable: missing backend contract Auth.PairingRevoke.</p>
          {exchangeResult ? (
            <section className="rounded-lg border border-success/35 bg-success/5 p-3" aria-label="Pairing exchange result">
              <MetaGrid
                columns={1}
                items={[
                  { label: 'Session state', value: exchangeResult.state },
                  { label: 'Token id', value: exchangeResult.tokenId ?? 'not returned' },
                  { label: 'Token secret', value: 'redacted after exchange' },
                  { label: 'Audit', value: exchangeResult.auditReceipt ?? 'audit receipt pending' }
                ]}
              />
            </section>
          ) : null}
        </Card>
      </div>

      {operation.message ? (
        <Alert variant={operation.status === 'error' ? 'destructive' : 'default'} role={operation.status === 'error' ? 'alert' : 'status'}>
          <AlertDescription>{operation.message}</AlertDescription>
        </Alert>
      ) : null}
      {operation.auditReceipt ? <p className="text-sm text-muted-foreground">AdminAction audit receipt: {operation.auditReceipt}</p> : null}
      {mutationError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{mutationError}</AlertDescription>
        </Alert>
      ) : null}
      {copyError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{copyError}</AlertDescription>
        </Alert>
      ) : null}
      {copiedRequestId ? (
        <p className="text-sm text-muted-foreground" role="status">
          Pairing code copied from controlled Admin pairing surface; secrets stay scoped to clipboard and are not logged.
        </p>
      ) : null}
      {model.disabledReason ? (
        <Alert role="note">
          <AlertDescription>{model.disabledReason}</AlertDescription>
        </Alert>
      ) : null}
      {model.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{model.error}</AlertDescription>
        </Alert>
      ) : null}

      <Card title="Pending requests" ariaLabel="Pending device and peer pairing requests" flush>
        <DataTable
          columns={queueColumns}
          rows={model.entries}
          getRowKey={(entry) => entry.request_id}
          empty={
            <div className="p-6 text-sm text-muted-foreground">
              {model.state === 'loading'
                ? <p aria-live="polite">Loading pairing queue from Aurora.</p>
                : model.disabledReason
                  ? <p>{model.disabledReason}</p>
                  : model.error
                    ? <p>{model.error}</p>
                    : <p>No pending device or peer pairing requests were reported by Auth.</p>}
            </div>
          }
        />
      </Card>
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
