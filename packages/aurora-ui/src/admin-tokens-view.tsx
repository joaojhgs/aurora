'use client'

import { useEffect, useMemo, useState } from 'react'
import { Activity, Clock, Copy, KeyRound, Lock, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import {
  AUTH_METHODS,
  AuroraError,
  summarizeCapabilities,
  type AuroraClient,
  type AvailabilityState,
  type CapabilitySummary,
  type JsonObject,
  type TokenResponse
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type AdminTokensLoadState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'degraded'
  | 'denied'
  | 'service-unavailable'
  | 'error'

export type AdminTokenStatus = 'active' | 'expiring' | 'expired'

export interface AdminTokenAction {
  title: string
  description: string
  methodId: typeof AUTH_METHODS.revokeToken
  payload: JsonObject
  affectedResources: string[]
  severity: 'critical'
  reason: string
  requiresAdminAction: true
}

export interface AdminTokenRow {
  id: string
  prefix: string
  userId: string | null
  deviceId: string | null
  scopes: string[]
  createdAt: string | null
  expiresAt: string | null
  status: AdminTokenStatus
  listState: AvailabilityState
  listReason: string
  revokeState: AvailabilityState
  revokeReason: string
  revokeAction: AdminTokenAction | null
}

export interface AdminTokensSnapshot {
  loadState: AdminTokensLoadState
  tokens: AdminTokenRow[]
  listState: AvailabilityState
  listReason: string
  revokeState: AvailabilityState
  revokeReason: string
  createState: AvailabilityState
  createReason: string
  secretsRedacted: boolean
  warnings: string[]
  error: string | null
  evidenceSource: string
}

export interface AdminTokensResourceProps {
  client: AuroraClient
  onPreviewAdminAction?: ((action: AdminTokenAction) => void) | undefined
}

export interface AdminTokensViewProps {
  snapshot: AdminTokensSnapshot
  onPreviewAdminAction?: ((action: AdminTokenAction) => void) | undefined
}

const loadingSnapshot: AdminTokensSnapshot = {
  loadState: 'loading',
  tokens: [],
  listState: 'pending',
  listReason: 'Loading Auth.ListTokens and token capability evidence through AuroraClient.',
  revokeState: 'pending',
  revokeReason: 'Loading Auth.RevokeToken capability evidence through AuroraClient.',
  createState: 'unsupported',
  createReason: 'Auth.CreateToken is not exposed by the SDK/contracts in this checkout; creation remains a disabled preview.',
  secretsRedacted: true,
  warnings: [],
  error: null,
  evidenceSource: 'pending AuroraClient SDK calls'
}

export function AdminTokensResource({ client, onPreviewAdminAction }: AdminTokensResourceProps) {
  const [snapshot, setSnapshot] = useState<AdminTokensSnapshot>(loadingSnapshot)

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildAdminTokensSnapshot(client).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client])

  return <AdminTokensView snapshot={snapshot} onPreviewAdminAction={onPreviewAdminAction} />
}

export async function buildAdminTokensSnapshot(client: AuroraClient): Promise<AdminTokensSnapshot> {
  const [tokensResult, catalogResult] = await Promise.allSettled([
    client.authApi.listTokens(),
    client.capabilities.listCatalog({ include_unavailable: true, include_internal: true, include_schemas: true })
  ])

  const tokensResponse = responseDataOrNull(tokensResult)
  const catalog = valueOrNull(catalogResult)
  const summaries = catalog ? summarizeCapabilities(catalog) : []
  const failures = [
    failureMessage('tokens', tokensResult),
    failureMessage('capability catalog', catalogResult)
  ].filter((message): message is string => Boolean(message))
  const denied = [tokensResult, catalogResult].some(isDeniedFailure)

  if (!tokensResponse && !catalog) {
    const unavailableMessage = 'Auth token SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      listState: denied ? 'denied' : 'unsupported',
      revokeState: 'unsupported',
      error: failures.length > 0 ? `${unavailableMessage} ${failures.join(' ')}` : unavailableMessage,
      warnings: failures,
      evidenceSource: 'AuroraClient SDK error'
    }
  }

  const listCapability = capabilityFor(AUTH_METHODS.listTokens, summaries)
  const revokeCapability = capabilityFor(AUTH_METHODS.revokeToken, summaries)
  const listState = listCapability?.availability ?? (tokensResponse ? 'available-local' : denied ? 'denied' : 'unsupported')
  const revokeState = revokeCapability?.availability ?? 'unsupported'
  const tokens = (tokensResponse?.tokens ?? []).map((token) => tokenRow(token, listCapability, revokeCapability))
  const loadState: AdminTokensLoadState = denied
    ? 'denied'
    : failures.length > 0
      ? 'degraded'
      : tokens.length === 0
        ? 'empty'
        : 'ready'

  return {
    loadState,
    tokens,
    listState,
    listReason: listCapability ? capabilityReason(listCapability) : (tokensResponse ? 'Auth.ListTokens returned token metadata through the SDK.' : 'Auth.ListTokens is not advertised by the capability catalog.'),
    revokeState,
    revokeReason: revokeCapability ? capabilityReason(revokeCapability) : 'Auth.RevokeToken is not advertised by the capability catalog.',
    createState: 'unsupported',
    createReason: 'Auth.CreateToken is not exposed by the SDK/contracts in this checkout; creation remains a disabled preview.',
    secretsRedacted: catalog?.secrets_redacted ?? true,
    warnings: failures,
    error: failures[0] ?? null,
    evidenceSource: client.transport.kind === 'mock' ? 'SDK mock transport fixture' : 'AuroraClient backend response'
  }
}

export function AdminTokensView({ snapshot, onPreviewAdminAction }: AdminTokensViewProps) {
  const totals = useMemo(() => tokenTotals(snapshot.tokens), [snapshot.tokens])

  return (
    <section className="aui-admin-tokens" aria-labelledby="admin-tokens-title">
      <header className="aui-admin-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="admin-tokens-title">Tokens</h1>
          <p>
            Scoped API tokens are RBAC credentials shown as redacted prefixes only. Creation is disabled until a real
            Auth.CreateToken contract exists; revocation is previewed through the AdminAction boundary.
          </p>
        </div>
        <div className="aui-admin-badges" aria-label="Token backend evidence">
          {isAvailabilityState(snapshot.loadState) ? <StatusBadge state={snapshot.loadState} /> : <span className={`aui-badge aui-badge-${snapshot.loadState}`}>{snapshot.loadState}</span>}
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
          <PrivacyBadge privacy="credential" />
        </div>
      </header>

      <TokensStatusPanel snapshot={snapshot} />

      <div className="aui-admin-metrics" aria-label="Token stats">
        <Metric label="Tokens" value={String(snapshot.tokens.length)} detail={`${totals.active} active`} />
        <Metric label="Expiring" value={String(totals.expiring)} detail="expires within 30 days" />
        <Metric label="Expired" value={String(totals.expired)} detail="not presented as usable" />
        <Metric label="Scopes" value={String(totals.scopes)} detail="unique redacted grants" />
      </div>

      <CreateTokenPreview snapshot={snapshot} />
      <TokensTable tokens={snapshot.tokens} onPreviewAdminAction={onPreviewAdminAction} />
    </section>
  )
}

function TokensStatusPanel({ snapshot }: { snapshot: AdminTokensSnapshot }) {
  if (snapshot.loadState === 'loading') {
    return (
      <div className="aui-admin-notice" aria-live="polite">
        <Activity size={18} aria-hidden />
        <span>Loading token metadata and capability evidence through AuroraClient.</span>
      </div>
    )
  }
  if (snapshot.loadState === 'ready') return null
  if (snapshot.loadState === 'empty') {
    return (
      <div className="aui-admin-notice" role="status">
        <KeyRound size={18} aria-hidden />
        <span>No scoped tokens were returned by Auth.ListTokens.</span>
      </div>
    )
  }
  return (
    <div className="aui-admin-notice aui-admin-notice-warning" role="alert">
      <Lock size={18} aria-hidden />
      <span>{snapshot.error ?? 'Token evidence is degraded. Secret values remain hidden and unsafe actions stay disabled.'}</span>
    </div>
  )
}

function CreateTokenPreview({ snapshot }: { snapshot: AdminTokensSnapshot }) {
  return (
    <section className="aui-admin-panel" aria-labelledby="token-create-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Create</p>
          <h2 id="token-create-title">Create-token preview</h2>
        </div>
        <StatusBadge state={snapshot.createState} />
      </div>
      <div className="aui-token-create-preview">
        <div>
          <strong>One-time reveal only</strong>
          <p>When Auth.CreateToken is implemented, the token secret must be shown once, never logged, and never re-rendered after navigation.</p>
        </div>
        <div>
          <strong>Suggested scopes</strong>
          <div className="aui-chip-list">
            <code className="aui-chip">Scheduler.manage</code>
            <code className="aui-chip">Tooling.use</code>
            <code className="aui-chip">Gateway.use</code>
          </div>
        </div>
        <button className="aui-action-chip" type="button" disabled title={snapshot.createReason}>
          <Plus size={15} aria-hidden />
          Create token unavailable
        </button>
      </div>
      <p className="aui-muted">{snapshot.createReason}</p>
    </section>
  )
}

function TokensTable({
  tokens,
  onPreviewAdminAction
}: {
  tokens: AdminTokenRow[]
  onPreviewAdminAction?: ((action: AdminTokenAction) => void) | undefined
}) {
  return (
    <section className="aui-admin-panel" aria-labelledby="tokens-table-title">
      <div className="aui-panel-heading">
        <div>
          <p className="aui-kicker">Credentials</p>
          <h2 id="tokens-table-title">Scoped token inventory</h2>
        </div>
      </div>
      {tokens.length === 0 ? (
        <p className="aui-muted">No tokens were returned by Auth.ListTokens.</p>
      ) : (
        <div className="aui-table-scroll">
          <table className="aui-table">
            <caption className="aui-sr-only">Scoped token table with redacted prefixes, scopes, expiry, and revoke AdminAction previews</caption>
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Principal</th>
                <th>Device</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <code>{token.prefix}••••</code>
                    <small>prefix only; secret redacted</small>
                  </td>
                  <td><code>{token.userId ?? 'not bound'}</code></td>
                  <td><code>{token.deviceId ?? 'not bound'}</code></td>
                  <td><PermissionChips scopes={token.scopes} /></td>
                  <td><span className={`aui-token-status aui-token-${token.status}`}>{token.status}</span></td>
                  <td>{token.expiresAt ?? 'no expiry reported'}</td>
                  <td>
                    <div className="aui-icon-actions">
                      <button type="button" aria-label={`Copy redacted prefix for ${token.prefix}`} title="Copies only the redacted token prefix, never the secret." disabled>
                        <Copy size={16} aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={`Revoke token ${token.prefix}`}
                        title={token.revokeReason}
                        disabled={!token.revokeAction}
                        onClick={() => {
                          if (token.revokeAction) onPreviewAdminAction?.(token.revokeAction)
                        }}
                      >
                        {token.revokeAction ? <Trash2 size={16} aria-hidden /> : <Lock size={16} aria-hidden />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export function buildTokenRevokeAdminAction(token: Pick<AdminTokenRow, 'id' | 'prefix' | 'userId' | 'deviceId'>, reason = 'Revoke scoped API token'): AdminTokenAction {
  return {
    title: `Revoke token ${token.prefix}`,
    description: 'Aurora will revoke this token only after AdminAction draft, confirmation, reauth, and audit receipt.',
    methodId: AUTH_METHODS.revokeToken,
    payload: { token_id: token.id } as JsonObject,
    affectedResources: [`token:${token.id}`, token.userId ? `principal:${token.userId}` : 'principal:not-bound', token.deviceId ? `device:${token.deviceId}` : 'device:not-bound'],
    severity: 'critical',
    reason,
    requiresAdminAction: true
  }
}

function tokenRow(
  token: TokenResponse,
  listCapability: CapabilitySummary | undefined,
  revokeCapability: CapabilitySummary | undefined
): AdminTokenRow {
  const revokeAvailable = Boolean(revokeCapability && ['available-local', 'available-remote', 'degraded'].includes(revokeCapability.availability))
  return {
    id: token.id,
    prefix: token.prefix,
    userId: token.user_id ?? null,
    deviceId: token.device_id ?? null,
    scopes: token.scopes,
    createdAt: token.created_at ?? null,
    expiresAt: token.expires_at ?? null,
    status: tokenStatus(token.expires_at ?? null),
    listState: listCapability?.availability ?? 'available-local',
    listReason: listCapability ? capabilityReason(listCapability) : 'Auth.ListTokens returned this redacted token through the SDK.',
    revokeState: revokeCapability?.availability ?? 'unsupported',
    revokeReason: revokeCapability ? capabilityReason(revokeCapability) : 'Auth.RevokeToken is not advertised by the capability catalog.',
    revokeAction: revokeAvailable ? buildTokenRevokeAdminAction({ id: token.id, prefix: token.prefix, userId: token.user_id ?? null, deviceId: token.device_id ?? null }) : null
  }
}

function tokenStatus(expiresAt: string | null): AdminTokenStatus {
  if (!expiresAt) return 'active'
  const expires = Date.parse(expiresAt)
  if (Number.isNaN(expires)) return 'active'
  const now = Date.now()
  if (expires <= now) return 'expired'
  const days = (expires - now) / (1000 * 60 * 60 * 24)
  return days <= 30 ? 'expiring' : 'active'
}

function tokenTotals(tokens: AdminTokenRow[]) {
  return {
    active: tokens.filter((token) => token.status !== 'expired').length,
    expiring: tokens.filter((token) => token.status === 'expiring').length,
    expired: tokens.filter((token) => token.status === 'expired').length,
    scopes: new Set(tokens.flatMap((token) => token.scopes)).size
  }
}

function PermissionChips({ scopes }: { scopes: string[] }) {
  return (
    <div className="aui-chip-list">
      {scopes.map((scope) => <code className="aui-chip" key={scope}>{scope}</code>)}
      {scopes.length === 0 ? <span className="aui-muted">no scopes</span> : null}
    </div>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="aui-admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function capabilityFor(methodId: string, summaries: CapabilitySummary[]): CapabilitySummary | undefined {
  return summaries.find((summary) => summary.busTopic === methodId)
}

function capabilityReason(capability: CapabilitySummary): string {
  if (capability.routeBlockers.length > 0) return capability.routeBlockers.join(', ')
  if (capability.raw.policy.approval_required) return `${capability.busTopic} requires AdminAction approval.`
  return `${capability.busTopic} is ${capability.availability}.`
}

function responseDataOrNull<T>(settled: PromiseSettledResult<{ ok: true; data: T } | { ok: false }>): T | null {
  return settled.status === 'fulfilled' && settled.value.ok ? settled.value.data : null
}

function valueOrNull<T>(settled: PromiseSettledResult<T>): T | null {
  return settled.status === 'fulfilled' ? settled.value : null
}

function failureMessage(label: string, settled: PromiseSettledResult<unknown>): string | null {
  if (settled.status === 'rejected') return `${label}: ${errorMessage(settled.reason)}`
  const value = settled.value as { ok?: boolean; error?: unknown }
  if (value && value.ok === false) return `${label}: ${errorMessage(value.error)}`
  return null
}

function isDeniedFailure(settled: PromiseSettledResult<unknown>): boolean {
  if (settled.status === 'rejected') {
    const reason = settled.reason as Partial<AuroraError>
    return reason.code === 'auth' || reason.code === 'permission'
  }
  const value = settled.value as { ok?: boolean; error?: Partial<AuroraError> }
  return value?.ok === false && (value.error?.code === 'auth' || value.error?.code === 'permission')
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  return maybe.message ?? (error instanceof Error ? error.message : 'Unknown SDK error')
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
