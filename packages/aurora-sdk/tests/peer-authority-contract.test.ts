import { describe, expect, it, vi } from 'vitest'

import {
  DenyAllInboundCredentialVerifierStore,
  DenyAllPeerGrantRepository,
  NoopPeerRevocationBroadcaster,
  NoopReconnectChallengeStore,
  PeerAuthorityResolver,
  type PeerRelationshipSelector,
  type ReconnectTransportAttestation
} from '../src/peer-host/authority.js'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-claimant',
  verifierPeerId: 'peer-verifier',
  roomName: 'room-a'
}

const transport: ReconnectTransportAttestation = {
  channelBinding: 'a'.repeat(64),
  claimantSignalingPeerId: 'sig-claimant',
  verifierSignalingPeerId: 'sig-verifier'
}

describe('provider authority deny-all contract', () => {
  it('returns an empty recipient manifest without a grant', async () => {
    const resolver = new PeerAuthorityResolver({
      verifierStore: new DenyAllInboundCredentialVerifierStore(),
      grantRepository: new DenyAllPeerGrantRepository(),
      challengeStore: new NoopReconnectChallengeStore(),
      manifestProvider: async () => {
        throw new Error('manifest provider must not run without a grant')
      }
    })

    await expect(resolver.getRecipientManifest({
      selector,
      transport,
      credentialRevision: 1,
      authenticatedAtMs: 1
    }, 1)).resolves.toEqual({ shared_services: [], grants: [] })
  })

  it('rejects reconnect authentication when no verifier exists', async () => {
    const resolver = new PeerAuthorityResolver({
      verifierStore: new DenyAllInboundCredentialVerifierStore(),
      grantRepository: new DenyAllPeerGrantRepository(),
      challengeStore: new NoopReconnectChallengeStore()
    })

    await expect(resolver.verifyReconnectProof({
      proofHex: 'b'.repeat(64),
      selector,
      transport,
      challenge: 'c'.repeat(64),
      nowMs: 1
    })).resolves.toMatchObject({ ok: false, reasonCode: 'not_found' })
  })

  it('does not treat caller frame identity permissions as provider authority', async () => {
    const repository = new DenyAllPeerGrantRepository()

    await expect(repository.resolveGrant({
      selector,
      methodId: 'Tooling.GetTools',
      nowMs: 1
    })).resolves.toEqual({ allowed: false, reasonCode: 'grant_not_found' })
  })

  it('unsubscribes revocation listeners synchronously', async () => {
    const broadcaster = new NoopPeerRevocationBroadcaster()
    const listener = vi.fn()
    const unsubscribe = broadcaster.subscribe(listener)
    unsubscribe()

    await broadcaster.publish({
      type: 'peer_authority_revoked_v1',
      selector,
      revokedGrantIds: [],
      revokedAtMs: 1,
      reasonCode: 'test',
      redacted: true
    })

    expect(listener).not.toHaveBeenCalled()
  })
})
