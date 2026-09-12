import type {
  AuthenticatedPeerContext,
  GrantDimensions,
  IssuedPeerBearerCredential,
  IssueReconnectChallengeRequest,
  LocalPeerGrantV1,
  PeerAuthorityDecision,
  PeerAuthorityResolverPort,
  PeerHostAuthorizationDecision,
  PeerHostAuthorizationStore,
  PeerHostAuthorizeRequest,
  PeerHostManifestAuthoritySnapshot,
  PeerPairingIssuerPort,
  PeerRelationshipSelector,
  ReconnectChallengeRecord,
  VerifyReconnectProofRequest,
  VerifyReconnectProofResult
} from '../../src/peer-host/index.js'

/**
 * Scripted stand-ins for the authority, for tests about something else.
 *
 * After R2 there is exactly one authority and it is Rust — see
 * `rust/crates/aurora-mesh-authority` and the shared corpus at
 * `tests/fixtures/mesh_authority_parity_vectors.json`, which the Rust tests and
 * `@aurora/mesh-authority-web` both run.
 *
 * Nothing here is a second authority. These doubles hold no grant logic and
 * evaluate no policy: a test states the decision it wants and these hand it
 * back, so a peer-host or session test can exercise *its* behaviour given a
 * decision without dragging WebAssembly into a unit test. If you find yourself
 * adding a rule to this file, the rule belongs in Rust and the test belongs in
 * the corpus.
 */

/** Answer every call with one scripted decision. */
export function scriptedAuthorizationStore(
  decide: (request: PeerHostAuthorizeRequest) => PeerHostAuthorizationDecision,
  snapshot?: (request: {
    readonly remotePeerId?: string
    readonly authenticatedPeerContext?: AuthenticatedPeerContext
    readonly nowMs: number
  }) => PeerHostManifestAuthoritySnapshot
): PeerHostAuthorizationStore {
  return {
    async authorize(request) {
      return decide(request)
    },
    async snapshotManifestAuthority(request) {
      return (
        snapshot?.(request) ?? {
          ...(request.remotePeerId !== undefined ? { recipientPeerId: request.remotePeerId } : {}),
          grantedMethodIds: [],
          authGrantRevision: 0,
          authGrantState: 'unknown' as const
        }
      )
    }
  }
}

/**
 * Allow a fixed set of methods for a fixed peer, deny everything else.
 *
 * A fixture, not a rule: the caller lists the method ids that should be allowed
 * and this compares against that list. It does not read a grant, check an
 * expiry, or consult a selector beyond the peer id the test names.
 */
export function allowMethods(options: {
  readonly claimantPeerId: string
  readonly methodIds: readonly string[]
  readonly grantRevision?: number
  readonly toolContractIds?: readonly string[]
  readonly deniedReasonCode?: string
}): PeerHostAuthorizationStore {
  const allowed = new Set(options.methodIds)
  const grantedMethodIds = [...allowed].sort()
  const grantRevision = options.grantRevision ?? 1
  return scriptedAuthorizationStore(
    (request) => {
      if (request.remotePeerId !== options.claimantPeerId || !allowed.has(request.methodId)) {
        return { allowed: false, reasonCode: options.deniedReasonCode ?? 'grant_not_found' }
      }
      return {
        allowed: true,
        grantRevision,
        grantedMethodIds,
        ...(options.toolContractIds !== undefined
          ? { grantedToolContractIds: [...options.toolContractIds].sort() }
          : {})
      }
    },
    (request) => ({
      ...(request.remotePeerId !== undefined ? { recipientPeerId: request.remotePeerId } : {}),
      grantedMethodIds,
      ...(options.toolContractIds !== undefined
        ? { grantedToolContractIds: [...options.toolContractIds].sort() }
        : {}),
      authGrantRevision: grantRevision,
      authGrantState: grantedMethodIds.length > 0 ? ('active' as const) : ('unknown' as const)
    })
  )
}

/**
 * An authority whose answer a test can change mid-run.
 *
 * Peer-host tests need to see what the host does when authority is withdrawn
 * while a request is in flight. They state the new answer directly; nothing
 * here evaluates a grant.
 */
export interface MutableAuthorizationStore extends PeerHostAuthorizationStore {
  /** Allow exactly these methods, for this peer. */
  allow(methodIds: readonly string[], options?: { readonly grantRevision?: number }): void
  /** Deny everything, with this reason. */
  deny(reasonCode: string): void
}

export function mutableAuthorizationStore(options: {
  readonly claimantPeerId: string
  readonly methodIds?: readonly string[]
  readonly grantRevision?: number
}): MutableAuthorizationStore {
  let current = allowMethods({
    claimantPeerId: options.claimantPeerId,
    methodIds: options.methodIds ?? [],
    ...(options.grantRevision !== undefined ? { grantRevision: options.grantRevision } : {})
  })
  return {
    allow(methodIds, allowOptions) {
      current = allowMethods({
        claimantPeerId: options.claimantPeerId,
        methodIds,
        ...(allowOptions?.grantRevision !== undefined
          ? { grantRevision: allowOptions.grantRevision }
          : options.grantRevision !== undefined
            ? { grantRevision: options.grantRevision }
            : {})
      })
    },
    deny(reasonCode) {
      current = denyAllAuthorizationStore(reasonCode)
    },
    async authorize(request) {
      return await current.authorize(request)
    },
    async snapshotManifestAuthority(request) {
      return (await current.snapshotManifestAuthority?.(request)) ?? {
        ...(request.remotePeerId !== undefined ? { recipientPeerId: request.remotePeerId } : {}),
        grantedMethodIds: [],
        authGrantRevision: 0,
        authGrantState: 'unknown' as const
      }
    }
  }
}

/** Deny every call, with the reason a missing authority reports. */
export function denyAllAuthorizationStore(
  reasonCode = 'authorization_store_unavailable'
): PeerHostAuthorizationStore {
  return scriptedAuthorizationStore(() => ({ allowed: false, reasonCode }))
}

/** A resolver whose answers the test supplies outright. */
export function scriptedResolver(script: {
  readonly issueReconnectChallenge?: (
    request: IssueReconnectChallengeRequest
  ) => Promise<ReconnectChallengeRecord> | ReconnectChallengeRecord
  readonly verifyReconnectProof?: (
    request: VerifyReconnectProofRequest
  ) => Promise<VerifyReconnectProofResult> | VerifyReconnectProofResult
  readonly resolveGrant?: (
    context: AuthenticatedPeerContext,
    dimensions: GrantDimensions & { readonly nowMs: number }
  ) => Promise<PeerAuthorityDecision> | PeerAuthorityDecision
}): PeerAuthorityResolverPort {
  return {
    async issueReconnectChallenge(request) {
      if (script.issueReconnectChallenge === undefined) {
        throw new Error('test resolver was not scripted to issue a challenge')
      }
      return await script.issueReconnectChallenge(request)
    },
    async verifyReconnectProof(request) {
      if (script.verifyReconnectProof === undefined) {
        throw new Error('test resolver was not scripted to verify a proof')
      }
      return await script.verifyReconnectProof(request)
    },
    async resolveGrant(context, dimensions) {
      if (script.resolveGrant === undefined) return { allowed: false, reasonCode: 'grant_not_found' }
      return await script.resolveGrant(context, dimensions)
    }
  }
}

/**
 * A resolver that answers `resolveGrant` from a literal grant list.
 *
 * Coverage here is a plain membership test on the four dimensions, matching what
 * a test means by "this grant covers that". The real ordering, expiry and
 * revocation rules live in Rust and are pinned by the corpus.
 */
export function grantListResolver(
  grants: readonly LocalPeerGrantV1[],
  extra: Parameters<typeof scriptedResolver>[0] = {}
): PeerAuthorityResolverPort {
  return scriptedResolver({
    ...extra,
    resolveGrant: (context, dimensions) => {
      const covering = grants.find((grant) => {
        if (grant.claimantPeerId !== context.selector.claimantPeerId) return false
        if (grant.verifierPeerId !== context.selector.verifierPeerId) return false
        if (grant.roomName !== context.selector.roomName) return false
        if (grant.revokedAtMs !== undefined && grant.revokedAtMs <= dimensions.nowMs) return false
        if (grant.expiresAtMs !== undefined && grant.expiresAtMs <= dimensions.nowMs) return false
        if (dimensions.methodId !== undefined && !grant.allowedMethodIds.includes(dimensions.methodId)) return false
        if (
          dimensions.toolContractId !== undefined
          && !grant.allowedToolContractIds.includes(dimensions.toolContractId)
        ) return false
        if (
          dimensions.capabilityPackId !== undefined
          && !grant.capabilityPackIds.includes(dimensions.capabilityPackId)
        ) return false
        if (
          dimensions.resourceScope !== undefined
          && !grant.resourceScopes.includes(dimensions.resourceScope)
        ) return false
        return true
      })
      return covering === undefined
        ? { allowed: false, reasonCode: 'grant_not_found' as const }
        : { allowed: true, grant: covering }
    }
  })
}

/**
 * Both seams a mesh-node provider composition needs, from one grant list.
 *
 * The composition asks the authority two different questions — "may this peer
 * call this method" through the authorization store, and "does a grant cover
 * this tool / capability / scope" through the resolver. In production both go
 * to the same Rust authority; in a test they come from the same literal list so
 * they cannot disagree with each other.
 */
export function authorityFromGrants(
  grants: readonly LocalPeerGrantV1[],
  claimantPeerId: string
): {
  readonly resolver: PeerAuthorityResolverPort
  readonly authorizationStore: PeerHostAuthorizationStore
} {
  const forPeer = grants.filter((grant) => grant.claimantPeerId === claimantPeerId)
  const methodIds = [...new Set(forPeer.flatMap((grant) => grant.allowedMethodIds))].sort()
  const toolContractIds = [
    ...new Set(forPeer.flatMap((grant) => grant.allowedToolContractIds))
  ].sort()
  return {
    resolver: grantListResolver(grants),
    authorizationStore: allowMethods({ claimantPeerId, methodIds, toolContractIds })
  }
}

/** A pairing issuer that hands back a fixed credential. */
export function scriptedPairingIssuer(options: {
  readonly bearerToken: string
  readonly tokenHashHex: string
  readonly now?: () => number
  readonly onRollback?: (selector: PeerRelationshipSelector) => void
}): PeerPairingIssuerPort {
  const now = options.now ?? (() => 1_000)
  return {
    async issue(selector): Promise<IssuedPeerBearerCredential> {
      return {
        tokenId: selector.tokenId,
        bearerToken: options.bearerToken,
        verifier: {
          version: 1,
          ...selector,
          tokenHashHex: options.tokenHashHex,
          createdAtMs: now(),
          credentialRevision: 1
        }
      }
    },
    async rollback(selector) {
      options.onRollback?.(selector)
    }
  }
}
