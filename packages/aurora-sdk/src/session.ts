import { AuroraError } from './errors.js'

export type AuthSessionState =
  | 'anonymous'
  | 'pairing'
  | 'user'
  | 'admin'
  | 'mesh_peer'
  | 'api_key_system'
  | 'expired'
  | 'revoked'
  | 'unauthorized'
  | 'forbidden'

export type AuthCredentialKind = 'none' | 'bearer_token' | 'api_key' | 'mesh_peer_token' | 'system' | 'unknown'

export interface AuthSessionIdentity {
  principalId?: string | null | undefined
  principalName?: string | null | undefined
  deviceId?: string | null | undefined
  peerId?: string | null | undefined
  nodeName?: string | null | undefined
  permissions?: string[] | undefined
  effectivePermissions?: string[] | undefined
  source?: string | null | undefined
  credentialKind?: AuthCredentialKind | undefined
  tokenExpiresAt?: string | null | undefined
  reason?: string | null | undefined
  status?: number | null | undefined
}

export interface AuthSessionSnapshot {
  state: AuthSessionState
  principalId: string | null
  principalName: string | null
  deviceId: string | null
  peerId: string | null
  nodeName: string | null
  permissions: string[]
  effectivePermissions: string[]
  source: string | null
  credentialKind: AuthCredentialKind
  tokenExpiresAt: string | null
  reason: string | null
  status: number | null
  isAuthenticated: boolean
  isAdmin: boolean
  isSystem: boolean
  isMeshPeer: boolean
  needsAuthentication: boolean
  isDenied: boolean
  isTerminal: boolean
}

export interface LoginLikeResponse {
  user_id?: string | null
  username?: string | null
  permissions?: string[]
  effective_perms?: string[]
  is_admin?: boolean
  expires_at?: string | null
}

export interface ValidateTokenLikeResponse {
  valid: boolean
  principal_id?: string | null
  principal_name?: string | null
  device_id?: string | null
  permissions?: string[]
  effective_perms?: string[]
  is_admin?: boolean
  source?: string | null
}

export interface WhoAmILikeResponse {
  principal_id: string
  principal_name?: string | null
  device_id?: string | null
  permissions?: string[]
  effective_perms?: string[]
  is_admin?: boolean
  source?: string | null
}

export interface PairingExchangeLikeResponse {
  user_id?: string | null
  device_id?: string | null
  permissions?: string[]
  peer_id?: string | null
  node_name?: string | null
}

export type AuthSessionListener = (snapshot: AuthSessionSnapshot) => void

const EMPTY_SNAPSHOT: AuthSessionSnapshot = {
  state: 'anonymous',
  principalId: null,
  principalName: null,
  deviceId: null,
  peerId: null,
  nodeName: null,
  permissions: [],
  effectivePermissions: [],
  source: null,
  credentialKind: 'none',
  tokenExpiresAt: null,
  reason: null,
  status: null,
  isAuthenticated: false,
  isAdmin: false,
  isSystem: false,
  isMeshPeer: false,
  needsAuthentication: false,
  isDenied: false,
  isTerminal: false
}

const AUTHENTICATED_STATES = new Set<AuthSessionState>(['user', 'admin', 'mesh_peer', 'api_key_system'])
const DENIED_STATES = new Set<AuthSessionState>(['unauthorized', 'forbidden'])
const TERMINAL_STATES = new Set<AuthSessionState>(['expired', 'revoked', 'unauthorized', 'forbidden'])

export class AuthSession {
  private snapshotValue: AuthSessionSnapshot = EMPTY_SNAPSHOT
  private readonly listeners = new Set<AuthSessionListener>()

  snapshot(): AuthSessionSnapshot {
    return cloneSnapshot(this.snapshotValue)
  }

  subscribe(listener: AuthSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  setAnonymous(reason: string | null = null): void {
    this.commit('anonymous', { reason, credentialKind: 'none' })
  }

  setPairing(details: AuthSessionIdentity = {}): void {
    this.commit('pairing', {
      ...details,
      credentialKind: details.credentialKind ?? 'unknown'
    })
  }

  setAuthenticated(
    principalId: string,
    permissions: string[],
    tokenExpiresAt: string | null = null,
    options: Omit<AuthSessionIdentity, 'principalId' | 'permissions' | 'tokenExpiresAt'> & { isAdmin?: boolean } = {}
  ): void {
    this.commit(options.isAdmin ? 'admin' : 'user', {
      ...options,
      principalId,
      permissions,
      tokenExpiresAt,
      credentialKind: options.credentialKind ?? 'bearer_token'
    })
  }

  setUser(details: AuthSessionIdentity): void {
    this.commit('user', {
      ...details,
      credentialKind: details.credentialKind ?? 'bearer_token'
    })
  }

  setAdmin(details: AuthSessionIdentity): void {
    this.commit('admin', {
      ...details,
      credentialKind: details.credentialKind ?? 'bearer_token'
    })
  }

  setMeshPeer(details: AuthSessionIdentity): void {
    this.commit('mesh_peer', {
      ...details,
      credentialKind: details.credentialKind ?? 'mesh_peer_token'
    })
  }

  setApiKeySystem(details: AuthSessionIdentity = {}): void {
    this.commit('api_key_system', {
      ...details,
      principalId: details.principalId ?? 'system',
      principalName: details.principalName ?? 'SYSTEM',
      permissions: details.permissions ?? ['*'],
      effectivePermissions: details.effectivePermissions ?? details.permissions ?? ['*'],
      source: details.source ?? 'api_key',
      credentialKind: details.credentialKind ?? 'api_key'
    })
  }

  expire(reason = 'Authentication expired'): void {
    this.commit('expired', {
      ...this.snapshotValue,
      reason,
      status: 401
    })
  }

  revoke(reason = 'Authentication revoked'): void {
    this.commit('revoked', {
      ...this.snapshotValue,
      reason,
      status: 401
    })
  }

  markUnauthorized(reason = 'Authentication required', status = 401): void {
    this.commit('unauthorized', {
      ...this.snapshotValue,
      reason,
      status
    })
  }

  markForbidden(reason = 'Permission denied', status = 403): void {
    this.commit('forbidden', {
      ...this.snapshotValue,
      reason,
      status
    })
  }

  clear(): void {
    this.snapshotValue = EMPTY_SNAPSHOT
    this.emit()
  }

  refreshClock(now: Date = new Date()): AuthSessionSnapshot {
    const expiresAt = this.snapshotValue.tokenExpiresAt
    if (AUTHENTICATED_STATES.has(this.snapshotValue.state) && expiresAt && Date.parse(expiresAt) <= now.getTime()) {
      this.expire('Token expired')
    }
    return this.snapshot()
  }

  hasPermission(permission: string): boolean {
    return hasPermission(permission, this.snapshotValue.effectivePermissions)
  }

  updateFromLogin(response: LoginLikeResponse): void {
    const details = {
      principalId: response.user_id ?? null,
      principalName: response.username ?? null,
      permissions: response.permissions ?? [],
      effectivePermissions: response.effective_perms ?? response.permissions ?? [],
      tokenExpiresAt: response.expires_at ?? null,
      source: 'login',
      credentialKind: 'bearer_token' as const
    }
    if (response.is_admin) this.setAdmin(details)
    else this.setUser(details)
  }

  updateFromTokenValidation(response: ValidateTokenLikeResponse): void {
    if (!response.valid) {
      this.markUnauthorized('Token validation failed')
      return
    }
    const details = {
      principalId: response.principal_id ?? null,
      principalName: response.principal_name ?? null,
      deviceId: response.device_id ?? null,
      permissions: response.permissions ?? [],
      effectivePermissions: response.effective_perms ?? response.permissions ?? [],
      source: response.source ?? 'token_validation',
      credentialKind: credentialKindForSource(response.source)
    }
    if (isSystemSource(response.source)) this.setApiKeySystem(details)
    else if (isMeshPeerSource(response.source)) this.setMeshPeer(details)
    else if (response.is_admin) this.setAdmin(details)
    else this.setUser(details)
  }

  updateFromWhoAmI(response: WhoAmILikeResponse): void {
    const details = {
      principalId: response.principal_id,
      principalName: response.principal_name ?? null,
      deviceId: response.device_id ?? null,
      permissions: response.permissions ?? [],
      effectivePermissions: response.effective_perms ?? response.permissions ?? [],
      source: response.source ?? 'whoami',
      credentialKind: credentialKindForSource(response.source)
    }
    if (isSystemSource(response.source)) this.setApiKeySystem(details)
    else if (isMeshPeerSource(response.source)) this.setMeshPeer(details)
    else if (response.is_admin) this.setAdmin(details)
    else this.setUser(details)
  }

  updateFromPairingExchange(response: PairingExchangeLikeResponse): void {
    this.setMeshPeer({
      principalId: response.user_id ?? null,
      deviceId: response.device_id ?? null,
      peerId: response.peer_id ?? null,
      nodeName: response.node_name ?? null,
      permissions: response.permissions ?? [],
      effectivePermissions: response.permissions ?? [],
      source: 'pairing_exchange'
    })
  }

  applyError(error: AuroraError): void {
    if (error.code === 'auth' || error.status === 401) {
      const reason = error.message || 'Authentication required'
      const detail = detailText(error.detail)
      if (detail.includes('revoked')) this.revoke(reason)
      else if (detail.includes('expired')) this.expire(reason)
      else this.markUnauthorized(reason, error.status ?? 401)
      return
    }
    if (error.code === 'permission' || error.status === 403) {
      this.markForbidden(error.message || 'Permission denied', error.status ?? 403)
    }
  }

  private commit(state: AuthSessionState, details: AuthSessionIdentity): void {
    const permissions = [...(details.permissions ?? [])]
    const effectivePermissions = [...(details.effectivePermissions ?? permissions)]
    this.snapshotValue = {
      state,
      principalId: details.principalId ?? null,
      principalName: details.principalName ?? null,
      deviceId: details.deviceId ?? null,
      peerId: details.peerId ?? null,
      nodeName: details.nodeName ?? null,
      permissions,
      effectivePermissions,
      source: details.source ?? null,
      credentialKind: details.credentialKind ?? 'unknown',
      tokenExpiresAt: details.tokenExpiresAt ?? null,
      reason: details.reason ?? null,
      status: details.status ?? null,
      isAuthenticated: AUTHENTICATED_STATES.has(state),
      isAdmin: state === 'admin' || state === 'api_key_system' || effectivePermissions.includes('*'),
      isSystem: state === 'api_key_system',
      isMeshPeer: state === 'mesh_peer',
      needsAuthentication: state === 'anonymous' || state === 'expired' || state === 'revoked' || state === 'unauthorized',
      isDenied: DENIED_STATES.has(state),
      isTerminal: TERMINAL_STATES.has(state)
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function cloneSnapshot(snapshot: AuthSessionSnapshot): AuthSessionSnapshot {
  return {
    ...snapshot,
    permissions: [...snapshot.permissions],
    effectivePermissions: [...snapshot.effectivePermissions]
  }
}

function hasPermission(required: string, granted: string[]): boolean {
  if (granted.includes('*')) return true
  if (granted.includes(required)) return true
  const [prefix] = required.split('.', 1)
  if (prefix && granted.includes(`${prefix}.*`)) return true
  return false
}

function isSystemSource(source: string | null | undefined): boolean {
  return source === 'api_key' || source === 'system' || source === 'auth_disabled'
}

function isMeshPeerSource(source: string | null | undefined): boolean {
  return source === 'mesh_peer' || source === 'pairing_exchange' || source === 'mesh_peer_token'
}

function credentialKindForSource(source: string | null | undefined): AuthCredentialKind {
  if (source === 'api_key') return 'api_key'
  if (source === 'system' || source === 'auth_disabled') return 'system'
  if (isMeshPeerSource(source)) return 'mesh_peer_token'
  if (source === 'http_bearer' || source === 'login' || source === 'token_validation' || source === 'whoami') {
    return 'bearer_token'
  }
  return 'unknown'
}

function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail.toLowerCase()
  if (typeof detail !== 'object' || detail === null) return ''
  const values = Object.values(detail as Record<string, unknown>)
  return values.filter((value): value is string => typeof value === 'string').join(' ').toLowerCase()
}
