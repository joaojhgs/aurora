'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Copy, EyeOff, KeyRound, RefreshCw, Save, ShieldAlert, Trash2 } from 'lucide-react'
import type { AuroraClient, AuroraError, AuthTokenCreateResponse, AuthTokenRecord } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export interface TokensViewProps {
  client: AuroraClient
  route: RouteAvailability
  initialModel?: TokenViewModel | undefined
}

export type TokenLoadState = 'loading' | 'ready' | 'error'
export type TokenMutationState = 'idle' | 'optimistic' | 'rollback-error'

export interface TokenViewModel {
  loadState: TokenLoadState
  route: RouteAvailability
  tokens: AuthTokenRecord[]
  error: string | null
  deniedReason: string | null
  mutationState: TokenMutationState
  lastAuditReceipt: string | null
  oneTimeReveal: AuthTokenCreateResponse | null
}

export async function buildTokenViewModel(
  client: AuroraClient,
  route: RouteAvailability
): Promise<TokenViewModel> {
  if (route.disabled) {
    return {
      ...emptyTokenViewModel(route),
      loadState: 'ready',
      deniedReason: tokenRouteReason(route)
    }
  }
  const result = await client.tokens.list({})
  if (!result.ok) {
    return {
      ...emptyTokenViewModel(route),
      loadState: 'error',
      error: tokenErrorMessage(result.error),
      deniedReason: tokenDeniedReason(result.error)
    }
  }
  return {
    ...emptyTokenViewModel(route),
    loadState: 'ready',
    tokens: result.data.tokens
  }
}

export function emptyTokenViewModel(route: RouteAvailability): TokenViewModel {
  return {
    loadState: 'loading',
    route,
    tokens: [],
    error: null,
    deniedReason: null,
    mutationState: 'idle',
    lastAuditReceipt: null,
    oneTimeReveal: null
  }
}

export function TokensView({ client, route, initialModel }: TokensViewProps) {
  const [model, setModel] = useState<TokenViewModel>(() => initialModel ?? emptyTokenViewModel(route))
  const [principalId, setPrincipalId] = useState('ops-bot')
  const [deviceId, setDeviceId] = useState('')
  const [scopes, setScopes] = useState('Gateway.use, Scheduler.manage')
  const [expiresInDays, setExpiresInDays] = useState('90')
  const [reason, setReason] = useState('Rotate scoped operational credential')
  const [editingTokenId, setEditingTokenId] = useState<string | null>(null)
  const [editingScopes, setEditingScopes] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)

  useEffect(() => {
    if (initialModel) return
    void refresh()
  }, [initialModel])

  async function refresh() {
    setModel((current) => ({ ...current, loadState: 'loading', error: null }))
    setModel(await buildTokenViewModel(client, route))
  }

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canMutate || busyAction) return
    const parsedScopes = parseScopes(scopes)
    const expires = Number.parseInt(expiresInDays, 10)
    const payload = {
      principal_id: principalId.trim(),
      device_id: deviceId.trim() || null,
      scopes: parsedScopes.length > 0 ? parsedScopes : null,
      expires_in_days: Number.isFinite(expires) && expires > 0 ? expires : 365
    }
    setBusyAction('create')
    setModel((current) => ({ ...current, mutationState: 'optimistic', error: null }))
    try {
      const result = await client.tokens.create(payload, {
        reason: reason.trim() || 'Create scoped token',
        reauthConfirmed: false,
        affectedResources: [`principal:${payload.principal_id}`, 'credential:token', 'audit:Auth.AuditEvent']
      })
      const created: AuthTokenRecord = {
        id: result.data.id,
        prefix: result.data.prefix,
        device_id: payload.device_id,
        user_id: payload.principal_id,
        scopes: result.data.scopes,
        created_at: new Date().toISOString(),
        expires_at: result.data.expires_at
      }
      setModel((current) => ({
        ...current,
        loadState: 'ready',
        tokens: [created, ...current.tokens.filter((token) => token.id !== created.id)],
        oneTimeReveal: result.data,
        lastAuditReceipt: result.auditReceipt,
        mutationState: 'idle',
        error: null
      }))
    } catch (error) {
      setModel((current) => ({ ...current, mutationState: 'rollback-error', error: tokenErrorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  async function saveScopes(token: AuthTokenRecord) {
    if (!canMutate || busyAction) return
    const nextScopes = parseScopes(editingScopes)
    const previous = model.tokens
    setBusyAction(`scopes:${token.id}`)
    setModel((current) => ({
      ...current,
      mutationState: 'optimistic',
      error: null,
      tokens: current.tokens.map((candidate) => candidate.id === token.id ? { ...candidate, scopes: nextScopes } : candidate)
    }))
    try {
      const result = await client.tokens.updateScopes({ token_id: token.id, scopes: nextScopes }, {
        reason: reason.trim() || `Update token scopes for ${token.prefix}`,
        reauthConfirmed: false
      })
      if (!result.data.success) throw new Error('Backend rejected token scope update')
      setEditingTokenId(null)
      setEditingScopes('')
      setModel((current) => ({
        ...current,
        mutationState: 'idle',
        lastAuditReceipt: result.auditReceipt,
        error: null
      }))
    } catch (error) {
      setModel((current) => ({ ...current, tokens: previous, mutationState: 'rollback-error', error: tokenErrorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  async function revokeToken(token: AuthTokenRecord) {
    if (!canMutate || busyAction) return
    const previous = model.tokens
    setBusyAction(`revoke:${token.id}`)
    setModel((current) => ({
      ...current,
      mutationState: 'optimistic',
      error: null,
      tokens: current.tokens.filter((candidate) => candidate.id !== token.id)
    }))
    try {
      const result = await client.tokens.revoke({ token_id: token.id }, {
        reason: reason.trim() || `Revoke token ${token.prefix}`,
        reauthConfirmed: false,
        phrase: token.prefix
      })
      if (!result.data.success) throw new Error('Backend rejected token revocation')
      setModel((current) => ({
        ...current,
        mutationState: 'idle',
        lastAuditReceipt: result.auditReceipt,
        error: null
      }))
    } catch (error) {
      setModel((current) => ({ ...current, tokens: previous, mutationState: 'rollback-error', error: tokenErrorMessage(error) }))
    } finally {
      setBusyAction(null)
    }
  }

  const canMutate = !route.disabled && route.requiresAdminAction && model.loadState !== 'loading'
  const summary = useMemo(() => tokenSummary(model.tokens), [model.tokens])
  const stateCopy = tokenStateCopy(model, route)

  return (
    <section className="aui-tokens" aria-labelledby="tokens-title">
      <header className="aui-tokens-header">
        <div>
          <p className="aui-kicker">Admin</p>
          <h1 id="tokens-title">Token lifecycle</h1>
          <p>{stateCopy}</p>
        </div>
        <div className="aui-assistant-badges" aria-label="Token backend evidence">
          <StatusBadge state={route.state} />
          <PrivacyBadge privacy="credential" />
          <EvidenceBadge label={route.providerLabel} />
          <EvidenceBadge label={route.requiresAdminAction ? 'AdminAction required' : 'read-only'} />
          {model.lastAuditReceipt ? <EvidenceBadge label={`audit ${model.lastAuditReceipt}`} /> : null}
        </div>
      </header>

      {model.error ? <p className="aui-token-alert" role="alert">{model.error}</p> : null}
      {model.deniedReason ? <p className="aui-token-alert" role="alert">{model.deniedReason}</p> : null}

      {model.oneTimeReveal ? (
        <section className="aui-token-reveal" aria-labelledby="token-reveal-title">
          <ShieldAlert size={18} aria-hidden />
          <div>
            <h2 id="token-reveal-title">One-time token reveal</h2>
            <p>This credential is only shown from the create response. It is not stored in the table and should not appear in diagnostics.</p>
            <code aria-label="Created token value">{model.oneTimeReveal.token}</code>
            <div className="aui-token-actions">
              <button type="button" onClick={() => void copyText(model.oneTimeReveal?.token ?? '')}>
                <Copy size={15} aria-hidden />
                <span>Copy once</span>
              </button>
              <button type="button" onClick={() => setModel((current) => ({ ...current, oneTimeReveal: null }))}>
                <EyeOff size={15} aria-hidden />
                <span>Dismiss</span>
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <div className="aui-token-summary" aria-label="Token summary">
        <article>
          <KeyRound size={18} aria-hidden />
          <strong>{summary.active}</strong>
          <span>listed credentials</span>
        </article>
        <article>
          <ShieldAlert size={18} aria-hidden />
          <strong>{summary.expiringSoon}</strong>
          <span>expire within 30 days</span>
        </article>
        <article data-state={model.mutationState}>
          <RefreshCw size={18} aria-hidden />
          <strong>{model.mutationState}</strong>
          <span>mutation state</span>
        </article>
      </div>

      <form className="aui-token-create" onSubmit={createToken} aria-label="Create scoped token">
        <label>
          Principal
          <input value={principalId} onChange={(event) => setPrincipalId(event.currentTarget.value)} disabled={!canMutate || Boolean(busyAction)} />
        </label>
        <label>
          Device
          <input value={deviceId} onChange={(event) => setDeviceId(event.currentTarget.value)} disabled={!canMutate || Boolean(busyAction)} placeholder="optional" />
        </label>
        <label>
          Scopes
          <input value={scopes} onChange={(event) => setScopes(event.currentTarget.value)} disabled={!canMutate || Boolean(busyAction)} />
        </label>
        <label>
          Days
          <input inputMode="numeric" value={expiresInDays} onChange={(event) => setExpiresInDays(event.currentTarget.value)} disabled={!canMutate || Boolean(busyAction)} />
        </label>
        <label className="aui-token-reason">
          AdminAction reason
          <input value={reason} onChange={(event) => setReason(event.currentTarget.value)} disabled={!canMutate || Boolean(busyAction)} />
        </label>
        <button type="submit" disabled={!canMutate || !principalId.trim() || Boolean(busyAction)}>
          <KeyRound size={16} aria-hidden />
          <span>Create token</span>
        </button>
      </form>

      <section className="aui-token-panel" aria-labelledby="token-table-title">
        <div className="aui-token-panel-head">
          <h2 id="token-table-title">Credentials</h2>
          <button type="button" disabled={model.loadState === 'loading'} onClick={() => void refresh()}>
            <RefreshCw size={15} aria-hidden />
            <span>Refresh</span>
          </button>
        </div>
        {model.loadState === 'loading' ? <p className="aui-token-empty">Loading token evidence from AuroraClient.</p> : null}
        {model.loadState !== 'loading' && model.tokens.length === 0 ? <p className="aui-token-empty">No tokens reported by Auth.ListTokens.</p> : null}
        {model.tokens.length > 0 ? (
          <div className="aui-token-table-wrap">
            <table className="aui-token-table">
              <thead>
                <tr>
                  <th>Prefix</th>
                  <th>Principal</th>
                  <th>Scopes</th>
                  <th>Expires</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {model.tokens.map((token) => (
                  <tr key={token.id} data-busy={busyAction?.endsWith(token.id) ? 'true' : undefined}>
                    <td><code>{token.prefix}</code></td>
                    <td>{token.user_id ?? 'unbound principal'}{token.device_id ? <small>device {token.device_id}</small> : null}</td>
                    <td>
                      {editingTokenId === token.id ? (
                        <input
                          aria-label={`Scopes for ${token.prefix}`}
                          value={editingScopes}
                          onChange={(event) => setEditingScopes(event.currentTarget.value)}
                          disabled={Boolean(busyAction)}
                        />
                      ) : (
                        <div className="aui-token-scopes">
                          {token.scopes.map((scope) => <span key={scope}>{scope}</span>)}
                        </div>
                      )}
                    </td>
                    <td>{formatDate(token.expires_at)}</td>
                    <td>
                      <div className="aui-token-actions">
                        {editingTokenId === token.id ? (
                          <button type="button" disabled={Boolean(busyAction)} onClick={() => void saveScopes(token)}>
                            <Save size={15} aria-hidden />
                            <span>Save</span>
                          </button>
                        ) : (
                          <button type="button" disabled={!canMutate || Boolean(busyAction)} onClick={() => {
                            setEditingTokenId(token.id)
                            setEditingScopes(token.scopes.join(', '))
                          }}>
                            <Save size={15} aria-hidden />
                            <span>Scopes</span>
                          </button>
                        )}
                        <button type="button" disabled={!canMutate || Boolean(busyAction)} onClick={() => void revokeToken(token)}>
                          <Trash2 size={15} aria-hidden />
                          <span>Revoke</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </section>
  )
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))]
}

function tokenSummary(tokens: AuthTokenRecord[]) {
  const now = Date.now()
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  return {
    active: tokens.length,
    expiringSoon: tokens.filter((token) => {
      if (!token.expires_at) return false
      const expires = Date.parse(token.expires_at)
      return Number.isFinite(expires) && expires > now && expires - now <= thirtyDays
    }).length
  }
}

function tokenStateCopy(model: TokenViewModel, route: RouteAvailability): string {
  if (model.loadState === 'loading') return 'Loading token lifecycle state from AuroraClient.'
  if (model.mutationState === 'optimistic') return 'Token mutation is pending AdminAction confirmation and backend result.'
  if (model.mutationState === 'rollback-error') return 'The last token mutation was rolled back after an SDK or backend error.'
  if (route.disabled) return tokenRouteReason(route)
  if (route.state === 'degraded') return 'Token management is available with backend-reported degradation; review provider and blockers before mutation.'
  if (model.tokens.length === 0) return 'Auth.ListTokens returned no credential records for the current filter.'
  return 'Token records are loaded from Auth.ListTokens; secrets remain hidden except for one-time create reveal.'
}

function tokenRouteReason(route: RouteAvailability): string {
  if (route.blockers.length > 0) return `Token management is disabled by capability evidence: ${route.blockers.join(', ')}.`
  return route.explanation
}

function tokenDeniedReason(error: AuroraError): string | null {
  if (error.code === 'auth' || error.code === 'permission') return 'Current principal lacks Auth.manage permission for token lifecycle management.'
  if (error.code === 'unavailable_service') return 'Auth token service is unavailable through the configured Aurora transport.'
  if (error.code === 'unsupported_feature') return 'This Aurora backend does not advertise token lifecycle methods.'
  if (error.code === 'privacy_blocked') return 'Token management is privacy-blocked by backend policy.'
  return null
}

function tokenErrorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>
  if (maybe.code) return `${maybe.code}: ${maybe.message ?? 'AuroraClient token request failed'}`
  return error instanceof Error ? error.message : 'AuroraClient token request failed'
}

function formatDate(value: string | null): string {
  if (!value) return 'no expiry'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 10)
}

async function copyText(value: string): Promise<void> {
  if (!value) return
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(value)
  }
}
