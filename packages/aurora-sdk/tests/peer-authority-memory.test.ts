import { describe, expect, it } from 'vitest'

import {
  MemoryInboundCredentialVerifierStore,
  MemoryPeerAuditSink,
  MemoryPeerGrantRepository,
  MemoryPeerRevocationBroadcaster,
  MemoryPeerRevocationController,
  MemoryReconnectChallengeStore,
  NoopReconnectChallengeStore,
  PeerAuthorityResolver,
  PeerPairingIssuer,
  createReconnectProofForBearer,
  type LocalPeerGrantV1,
  type PeerRelationshipIdentity,
  type PeerRelationshipSelector,
  type ReconnectTransportAttestation
} from '../src/peer-host/authority.js'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-claimant',
  verifierPeerId: 'peer-verifier',
  roomName: 'room-a'
}

const relationship: PeerRelationshipIdentity = {
  claimantPeerId: selector.claimantPeerId,
  verifierPeerId: selector.verifierPeerId,
  roomName: selector.roomName
}

const otherSelector: PeerRelationshipSelector = {
  ...selector,
  roomName: 'room-b'
}

const transport: ReconnectTransportAttestation = {
  channelBinding: 'a'.repeat(64),
  claimantSignalingPeerId: 'sig-claimant',
  verifierSignalingPeerId: 'sig-verifier'
}

const otherTransport: ReconnectTransportAttestation = {
  ...transport,
  verifierSignalingPeerId: 'sig-other'
}

function grant(patch: Partial<LocalPeerGrantV1> = {}): LocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-1',
    ...selector,
    allowedMethodIds: ['Tooling.GetTools'],
    allowedToolContractIds: ['tool:one'],
    capabilityPackIds: ['local-tools'],
    resourceScopes: ['scope:a'],
    createdAtMs: 1,
    grantRevision: 1,
    ...patch
  }
}

describe('memory provider authority', () => {
  it('issues a bearer once and persists only the SHA-256 verifier', async () => {
    const verifierStore = new MemoryInboundCredentialVerifierStore()
    const issuer = new PeerPairingIssuer({
      verifierStore,
      randomBytes: () => new Uint8Array(32).fill(7),
      now: () => 100
    })

    const issued = await issuer.issue(selector)
    const verifier = await verifierStore.getVerifier(selector, 100)

    expect(issued.bearerToken).toBe('07'.repeat(32))
    expect(verifier?.tokenHashHex).toBe(issued.verifier.tokenHashHex)
    expect(verifier?.tokenHashHex).not.toBe(issued.bearerToken)
    expect(JSON.stringify(verifier)).not.toContain(issued.bearerToken)
  })

  it('requires exact selector and transport for challenge consumption and allows replay only until original expiry', async () => {
    const store = new MemoryReconnectChallengeStore({
      randomBytes: () => new Uint8Array(32).fill(3)
    })
    const challenge = await store.issueChallenge(relationship, transport, 1_000)

    expect(challenge.challenge).toBe('03'.repeat(32))
    expect(challenge).toMatchObject({ identity: relationship })
    expect(challenge).not.toHaveProperty('selector')
    expect(challenge.expiresAtMs - challenge.issuedAtMs).toBe(20_000)
    await expect(store.consumeChallenge(challenge.challenge, otherSelector, transport, 1_001)).resolves.toMatchObject({ status: 'selector_mismatch' })
    await expect(store.consumeChallenge(challenge.challenge, selector, otherTransport, 1_001)).resolves.toMatchObject({ status: 'transport_mismatch' })
    await expect(store.consumeChallenge(challenge.challenge, selector, transport, 1_001)).resolves.toMatchObject({ status: 'accepted' })
    await expect(store.consumeChallenge(challenge.challenge, selector, transport, 1_002)).resolves.toMatchObject({ status: 'replay' })
    await expect(store.consumeChallenge(challenge.challenge, selector, transport, 21_000)).resolves.toMatchObject({ status: 'expired' })
  })

  it('retries challenge collisions no more than eight times', async () => {
    let calls = 0
    const store = new MemoryReconnectChallengeStore({
      randomBytes: () => {
        calls += 1
        return new Uint8Array(32).fill(calls === 1 ? 4 : 5)
      }
    })
    await store.issueChallenge(relationship, transport, 1)
    const second = await store.issueChallenge(relationship, transport, 2)
    expect(second.challenge).toBe('05'.repeat(32))
    expect(calls).toBe(2)

    const exhausted = new MemoryReconnectChallengeStore({
      randomBytes: () => new Uint8Array(32).fill(9)
    })
    await exhausted.issueChallenge(relationship, transport, 1)
    await expect(exhausted.issueChallenge(relationship, transport, 2)).rejects.toThrow(/collision retry/u)
  })

  it('fails unavailable instead of issuing a placeholder Noop reconnect challenge', async () => {
    const store = new NoopReconnectChallengeStore()
    await expect(store.issueChallenge(relationship, transport, 1)).rejects.toThrow(/unavailable/u)
  })

  it('resolves grants by exact selector, active coverage, and deterministic order', async () => {
    const repository = new MemoryPeerGrantRepository()
    await repository.upsertGrant(grant({ grantId: 'revoked-newest', grantRevision: 9, createdAtMs: 9, revokedAtMs: 10 }))
    await repository.upsertGrant(grant({ grantId: 'active-newer', grantRevision: 8, createdAtMs: 20 }))
    await repository.upsertGrant(grant({ grantId: 'active-older', grantRevision: 1, createdAtMs: 1 }))
    await repository.upsertGrant(grant({ grantId: 'wrong-room', ...otherSelector, grantRevision: 99, createdAtMs: 99 }))

    await expect(repository.resolveGrant({
      selector,
      methodId: 'Tooling.GetTools',
      toolContractId: 'tool:one',
      capabilityPackId: 'local-tools',
      resourceScope: 'scope:a',
      nowMs: 11
    })).resolves.toMatchObject({ allowed: true, grant: { grantId: 'active-newer' } })

    await expect(repository.resolveGrant({
      selector,
      methodId: 'Tooling.GetExportCatalog',
      nowMs: 11
    })).resolves.toEqual({ allowed: false, reasonCode: 'method_not_granted' })
  })

  it('does not let requiredPermissions metadata independently grant authority', async () => {
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository: new MemoryPeerGrantRepository()
    })

    await expect(resolver.resolveGrant({
      selector,
      transport,
      credentialRevision: 1,
      authenticatedAtMs: 1
    }, {
      methodId: 'Tooling.GetTools',
      nowMs: 1
    })).resolves.toEqual({ allowed: false, reasonCode: 'grant_not_found' })
  })

  it('projects recipient manifests asynchronously from active grants only', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant({ grantId: 'expired-grant', expiresAtMs: 3, grantRevision: 2 }))
    await grantRepository.upsertGrant(grant({ grantId: 'active-grant', grantRevision: 3 }))
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository,
      manifestProvider: async (context, grants) => ({
        recipient: context.selector.claimantPeerId,
        grantIds: grants.map((item) => item.grantId)
      })
    })

    await expect(resolver.getRecipientManifest({
      selector,
      transport,
      credentialRevision: 1,
      authenticatedAtMs: 4
    }, 4)).resolves.toEqual({
      recipient: 'peer-claimant',
      grantIds: ['active-grant']
    })
  })

  it('verifies reconnect proof with the canonical transcript and rejects replay/cross-relationship proofs', async () => {
    const verifierStore = new MemoryInboundCredentialVerifierStore()
    let challengeByte = 6
    const challengeStore = new MemoryReconnectChallengeStore({
      randomBytes: () => new Uint8Array(32).fill(challengeByte++)
    })
    const issuer = new PeerPairingIssuer({
      verifierStore,
      randomBytes: () => new Uint8Array(32).fill(8),
      now: () => 1
    })
    const issued = await issuer.issue(selector)
    const challenge = await challengeStore.issueChallenge(relationship, transport, 2)
    const proofHex = await createReconnectProofForBearer(issued.bearerToken, selector, transport, challenge.challenge)
    const resolver = new PeerAuthorityResolver({
      verifierStore,
      grantRepository: new MemoryPeerGrantRepository(),
      challengeStore
    })

    await expect(resolver.verifyReconnectProof({
      proofHex,
      selector,
      transport,
      challenge: challenge.challenge,
      nowMs: 3
    })).resolves.toMatchObject({ ok: true, context: { selector } })

    await expect(resolver.verifyReconnectProof({
      proofHex,
      selector,
      transport,
      challenge: challenge.challenge,
      nowMs: 4
    })).resolves.toMatchObject({ ok: false, reasonCode: 'replay' })

    const crossChallenge = await challengeStore.issueChallenge(otherSelector, transport, 5)
    await expect(resolver.verifyReconnectProof({
      proofHex,
      selector: otherSelector,
      transport,
      challenge: crossChallenge.challenge,
      nowMs: 6
    })).resolves.toMatchObject({ ok: false, reasonCode: 'credential_not_found' })
  })

  it('revokes verifier and grants, rejects challenges, emits a redacted event, and audits', async () => {
    const verifierStore = new MemoryInboundCredentialVerifierStore()
    const grantRepository = new MemoryPeerGrantRepository()
    const challengeStore = new MemoryReconnectChallengeStore({
      randomBytes: () => new Uint8Array(32).fill(10)
    })
    const auditSink = new MemoryPeerAuditSink()
    const broadcaster = new MemoryPeerRevocationBroadcaster()
    const events: unknown[] = []
    broadcaster.subscribe((event) => events.push(event))

    await new PeerPairingIssuer({ verifierStore, now: () => 1, randomBytes: () => new Uint8Array(32).fill(11) }).issue(selector)
    await grantRepository.upsertGrant(grant())
    const challenge = await challengeStore.issueChallenge(relationship, transport, 2)
    const controller = new MemoryPeerRevocationController({
      verifierStore,
      grantRepository,
      challengeStore,
      auditSink,
      broadcaster,
      now: () => 3
    })

    await expect(controller.revoke(selector, 'operator_revoked')).resolves.toMatchObject({
      redacted: true,
      revokedGrantIds: ['grant-1'],
      reasonCode: 'operator_revoked'
    })
    await expect(verifierStore.getVerifier(selector, 4)).resolves.toBeUndefined()
    await expect(grantRepository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 4 })).resolves.toEqual({ allowed: false, reasonCode: 'grant_revoked' })
    await expect(challengeStore.consumeChallenge(challenge.challenge, selector, transport, 4)).resolves.toMatchObject({ status: 'rejected' })
    expect(events).toHaveLength(1)
    expect(JSON.stringify(events[0])).not.toMatch(/tokenHashHex|bearer|proofHex/u)
    expect(auditSink.records).toEqual([expect.objectContaining({ action: 'grant.revoke', decision: 'revoked', redacted: true })])
  })

  it('audits tokenless resolver challenge issuance and rejects failed durable pairing persistence', async () => {
    const auditSink = new MemoryPeerAuditSink()
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository: new MemoryPeerGrantRepository(),
      challengeStore: new MemoryReconnectChallengeStore({ randomBytes: () => new Uint8Array(32).fill(12) }),
      auditSink
    })

    await expect(resolver.issueReconnectChallenge({ identity: relationship, transport, nowMs: 5 })).resolves.toMatchObject({
      challenge: '0c'.repeat(32),
      identity: relationship
    })
    expect(auditSink.records).toEqual([
      expect.objectContaining({
        action: 'challenge.issue',
        decision: 'issued',
        selector: relationship,
        redacted: true
      })
    ])
    expect(JSON.stringify(auditSink.records[0]?.selector)).not.toMatch(/tokenId|bearer|proof|tokenHashHex/u)

    const failingIssuer = new PeerPairingIssuer({
      verifierStore: {
        getVerifier: async () => undefined,
        upsertVerifier: async () => { throw new Error('durable persistence failed') },
        revokeVerifier: async () => undefined,
        deleteVerifier: async () => undefined
      },
      auditSink,
      randomBytes: () => new Uint8Array(32).fill(13),
      now: () => 10
    })
    await expect(failingIssuer.issue(selector)).rejects.toThrow(/persistence failed/u)
    expect(auditSink.records.filter((record) => record.action === 'credential.issue')).toHaveLength(0)
  })
})
