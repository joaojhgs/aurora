import type {
  LocalPeerGrantV1,
  PeerHostAuthorizationDecision,
  PeerHostAuthorizationStore,
  PeerHostAuthorizeRequest
} from './types.js'

export class DenyAllPeerHostAuthorizationStore implements PeerHostAuthorizationStore {
  async authorize(): Promise<PeerHostAuthorizationDecision> {
    return { allowed: false, reasonCode: 'authorization_store_unavailable' }
  }
}

export class SessionPeerHostAuthorizationStore implements PeerHostAuthorizationStore {
  private readonly grants = new Map<string, LocalPeerGrantV1>()

  constructor(grants: readonly LocalPeerGrantV1[] = []) {
    for (const grant of grants) this.upsertGrant(grant)
  }

  upsertGrant(grant: LocalPeerGrantV1): void {
    validateGrant(grant)
    this.grants.set(grant.grantId, grant)
  }

  revokeGrant(grantId: string, revokedAtMs = Date.now()): void {
    const grant = this.grants.get(grantId)
    if (!grant) return
    this.grants.set(grantId, { ...grant, revokedAtMs })
  }

  clear(): void {
    this.grants.clear()
  }

  async authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision> {
    let bestRevision = 0
    for (const grant of this.grants.values()) {
      if (grant.claimantPeerId !== request.remotePeerId) continue
      if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= request.nowMs) {
        return { allowed: false, reasonCode: 'grant_revoked', grantRevision: grant.grantRevision }
      }
      if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) {
        return { allowed: false, reasonCode: 'grant_expired', grantRevision: grant.grantRevision }
      }
      if (!grant.allowedMethodIds.includes(request.methodId)) continue
      bestRevision = Math.max(bestRevision, grant.grantRevision)
      const observed = new Set(request.identity.effectivePermissions)
      const hasPermissions = request.requiredPermissions.every((permission) => observed.has(permission))
      if (!hasPermissions) return { allowed: false, reasonCode: 'missing_required_permission', grantRevision: grant.grantRevision }
      return { allowed: true, grantRevision: grant.grantRevision }
    }
    return bestRevision > 0
      ? { allowed: false, reasonCode: 'grant_not_found', grantRevision: bestRevision }
      : { allowed: false, reasonCode: 'grant_not_found' }
  }
}

function validateGrant(grant: LocalPeerGrantV1): void {
  if (grant.version !== 1) throw new Error('unsupported grant version')
  if (!grant.grantId || !grant.tokenId || !grant.claimantPeerId) throw new Error('grant identity is required')
  if (!Array.isArray(grant.allowedMethodIds)) throw new Error('grant allowed methods are required')
  if (!Number.isSafeInteger(grant.createdAtMs) || grant.createdAtMs < 0) throw new Error('grant createdAtMs is invalid')
  if (!Number.isSafeInteger(grant.grantRevision) || grant.grantRevision < 0) throw new Error('grant revision is invalid')
}
