import type {
  LocalPeerGrantV1,
  PeerHostAuthorizationDecision,
  PeerHostAuthorizationStore,
  PeerHostAuthorizeRequest,
  PeerHostManifestAuthoritySnapshot
} from './types.js'
import type { AuthenticatedPeerContext, PeerAuthorityResolver } from './authority.js'

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
      if (request.authenticatedPeerContext !== undefined && grant.tokenId !== request.authenticatedPeerContext.selector.tokenId) continue
      if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= request.nowMs) {
        return { allowed: false, reasonCode: 'grant_revoked', grantRevision: grant.grantRevision }
      }
      if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) {
        return { allowed: false, reasonCode: 'grant_expired', grantRevision: grant.grantRevision }
      }
      if (!grant.allowedMethodIds.includes(request.methodId)) continue
      bestRevision = Math.max(bestRevision, grant.grantRevision)
      return { allowed: true, grantRevision: grant.grantRevision, grantedMethodIds: sortedUnique(grant.allowedMethodIds) }
    }
    return bestRevision > 0
      ? { allowed: false, reasonCode: 'grant_not_found', grantRevision: bestRevision }
      : { allowed: false, reasonCode: 'grant_not_found' }
  }

  snapshotManifestAuthority(request: { readonly remotePeerId?: string; readonly authenticatedPeerContext?: PeerHostAuthorizeRequest['authenticatedPeerContext']; readonly nowMs: number; readonly correlationId?: string }): PeerHostManifestAuthoritySnapshot {
    const grants = [...this.grants.values()]
      .filter((grant) => {
        if (request.remotePeerId !== undefined && grant.claimantPeerId !== request.remotePeerId) return false
        if (request.authenticatedPeerContext !== undefined && grant.tokenId !== request.authenticatedPeerContext.selector.tokenId) return false
        if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= request.nowMs) return false
        if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) return false
        return true
      })
      .sort((left, right) => right.grantRevision - left.grantRevision || right.createdAtMs - left.createdAtMs || left.grantId.localeCompare(right.grantId))
    const grantedMethodIds = sortedUnique(grants.flatMap((grant) => grant.allowedMethodIds))
    const recipientPeerId = request.remotePeerId ?? grants[0]?.claimantPeerId
    return {
      ...(recipientPeerId !== undefined ? { recipientPeerId } : {}),
      grantedMethodIds,
      authGrantRevision: grants.reduce((revision, grant) => Math.max(revision, grant.grantRevision), 0),
      authGrantState: grantedMethodIds.length > 0 ? 'active' : 'unknown'
    }
  }
}

export class PeerAuthorityHostAuthorizationStore implements PeerHostAuthorizationStore {
  constructor(
    private readonly resolver: PeerAuthorityResolver,
    private readonly options: {
      readonly grantedPermissionsForGrant?: (grant: LocalPeerGrantV1) => readonly string[]
    } = {}
  ) {}

  async authorize(request: PeerHostAuthorizeRequest): Promise<PeerHostAuthorizationDecision> {
    const context = request.authenticatedPeerContext
    if (context === undefined) return { allowed: false, reasonCode: 'peer_not_authenticated' }
    if (context.selector.claimantPeerId !== request.remotePeerId) return { allowed: false, reasonCode: 'selector_mismatch' }
    const decision = await this.resolver.resolveGrant(context, {
      methodId: request.methodId,
      nowMs: request.nowMs
    })
    return {
      allowed: decision.allowed,
      ...(decision.reasonCode !== undefined ? { reasonCode: decision.reasonCode } : {}),
      ...(decision.grant?.grantRevision !== undefined ? { grantRevision: decision.grant.grantRevision } : {}),
      ...(decision.grant?.allowedMethodIds !== undefined ? { grantedMethodIds: sortedUnique(decision.grant.allowedMethodIds) } : {}),
      ...(decision.grant !== undefined && this.options.grantedPermissionsForGrant !== undefined
        ? { grantedPermissions: sortedUnique(this.options.grantedPermissionsForGrant(decision.grant)) }
        : {})
    }
  }

  async snapshotManifestAuthority(request: { readonly remotePeerId?: string; readonly authenticatedPeerContext?: AuthenticatedPeerContext; readonly nowMs: number; readonly correlationId?: string }): Promise<PeerHostManifestAuthoritySnapshot> {
    const context = request.authenticatedPeerContext
    if (context === undefined) {
      return { ...(request.remotePeerId !== undefined ? { recipientPeerId: request.remotePeerId } : {}), grantedMethodIds: [], authGrantRevision: 0, authGrantState: 'unknown' }
    }
    if (request.remotePeerId !== undefined && context.selector.claimantPeerId !== request.remotePeerId) {
      return { recipientPeerId: request.remotePeerId, grantedMethodIds: [], authGrantRevision: 0, authGrantState: 'unknown' }
    }
    const grants = await this.resolver.snapshotRecipientGrants(context, request.nowMs, request.correlationId)
    const active = grants
      .filter((grant) => {
        if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= request.nowMs) return false
        if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= request.nowMs) return false
        return true
      })
      .sort((left, right) => right.grantRevision - left.grantRevision || right.createdAtMs - left.createdAtMs || left.grantId.localeCompare(right.grantId))
    const grantedMethodIds = sortedUnique(active.flatMap((grant) => grant.allowedMethodIds))
    const permissionsForGrant = this.options.grantedPermissionsForGrant
    const grantedPermissions = permissionsForGrant === undefined
      ? []
      : sortedUnique(active.flatMap((grant) => permissionsForGrant(grant)))
    return {
      recipientPeerId: context.selector.claimantPeerId,
      grantedMethodIds,
      grantedPermissions,
      authGrantRevision: active.reduce((revision, grant) => Math.max(revision, grant.grantRevision), 0),
      authGrantState: grantedMethodIds.length > 0 ? 'active' : 'unknown'
    }
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function validateGrant(grant: LocalPeerGrantV1): void {
  if (grant.version !== 1) throw new Error('unsupported grant version')
  if (!grant.grantId || !grant.tokenId || !grant.claimantPeerId) throw new Error('grant identity is required')
  if (!Array.isArray(grant.allowedMethodIds)) throw new Error('grant allowed methods are required')
  if (!Number.isSafeInteger(grant.createdAtMs) || grant.createdAtMs < 0) throw new Error('grant createdAtMs is invalid')
  if (!Number.isSafeInteger(grant.grantRevision) || grant.grantRevision < 0) throw new Error('grant revision is invalid')
}
