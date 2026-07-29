import { describe, expect, it } from 'vitest'

import {
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  MemoryLocalDataBackend
} from '../src/local-data/index.js'
import {
  EncryptedPeerGrantRepository,
  LocalDataPeerAuditSink,
  SecureInboundCredentialVerifierStore,
  inboundVerifierSecretKey,
  type InboundVerifierSecretStoragePort,
  type LocalPeerAuditRecord,
  type ProviderLocalPeerCredentialVerifierV1,
  type ProviderLocalPeerGrantV1,
  type PeerRelationshipSelector
} from '../src/peer-host/index.js'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-claimant',
  verifierPeerId: 'peer-verifier',
  roomName: 'room-a'
}

const otherSelector: PeerRelationshipSelector = {
  ...selector,
  roomName: 'room-b'
}

const profileId = 'profile-1'
const localNodeId = 'node-1'

function verifier(patch: Partial<ProviderLocalPeerCredentialVerifierV1> = {}): ProviderLocalPeerCredentialVerifierV1 {
  return {
    version: 1,
    ...selector,
    tokenHashHex: 'a'.repeat(64),
    createdAtMs: 100,
    credentialRevision: 1,
    ...patch
  }
}

function grant(patch: Partial<ProviderLocalPeerGrantV1> = {}): ProviderLocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-1',
    ...selector,
    allowedMethodIds: ['Tooling.GetTools'],
    allowedToolContractIds: ['aurora.local.native.share_text.v1'],
    capabilityPackIds: ['native.share'],
    resourceScopes: ['document:allowed'],
    createdAtMs: 200,
    grantRevision: 1,
    ...patch
  }
}

describe('local-data peer authority adapters', () => {
  it('stores inbound verifiers behind selector-bound secure keys and increments revision on revoke', async () => {
    const storage = new RecordingSecretStorage()
    const store = new SecureInboundCredentialVerifierStore({ storage })

    await store.upsertVerifier(verifier())

    const key = inboundVerifierSecretKey(selector)
    expect(storage.keys()).toEqual([key])
    expect(storage.values().join('\n')).toContain('"tokenHashHex"')
    expect(storage.values().join('\n')).not.toMatch(/bearer|rawBearer|proofHex/u)
    await expect(store.getVerifier(selector, 101)).resolves.toEqual(verifier())
    await expect(store.getVerifier(otherSelector, 101)).resolves.toBeUndefined()

    await expect(store.revokeVerifier(selector, 150)).resolves.toMatchObject({
      revokedAtMs: 150,
      credentialRevision: 2
    })
    await expect(store.getVerifier(selector, 151)).resolves.toBeUndefined()

    await store.deleteVerifier(selector)
    expect(storage.keys()).toEqual([])
  })

  it('fails closed for malformed secure-store verifier values', async () => {
    const storage = new RecordingSecretStorage()
    const store = new SecureInboundCredentialVerifierStore({ storage })
    await storage.setOpaqueSecret(inboundVerifierSecretKey(selector), '{"version":1}')

    await expect(store.getVerifier(selector, 1)).resolves.toBeUndefined()
    await expect(store.revokeVerifier(selector, 2)).resolves.toBeUndefined()

    await storage.setOpaqueSecret(inboundVerifierSecretKey(selector), 'not-json')
    await expect(store.getVerifier(selector, 1)).resolves.toBeUndefined()
  })

  it('stores full peer grants only inside encrypted envelopes and resolves by decrypted selector', async () => {
    const { session, repository, crypto } = await grantRepositoryFixture()

    await repository.upsertGrant(grant())

    const metadata = (await session.peerGrants.listPeerGrants())[0]
    expect(metadata).toMatchObject({
      grantId: 'grant-1',
      profileId,
      localNodeId,
      claimantPeerId: selector.claimantPeerId,
      tokenId: selector.tokenId,
      revision: 1
    })
    expect(JSON.stringify(metadata)).not.toMatch(/Tooling\.GetTools|document:allowed|peer-verifier|room-a|tokenHashHex|bearer/u)
    expect(crypto.encrypted[0]?.keyPurpose).toBe('local-structured-data')
    expect(new TextDecoder().decode(crypto.encrypted[0]?.aad)).toContain('"recordId":"grant-1"')

    await expect(repository.resolveGrant({
      selector,
      methodId: 'Tooling.GetTools',
      toolContractId: 'aurora.local.native.share_text.v1',
      capabilityPackId: 'native.share',
      resourceScope: 'document:allowed',
      nowMs: 201
    })).resolves.toMatchObject({ allowed: true, grant: { grantId: 'grant-1' } })

    await expect(repository.resolveGrant({
      selector: otherSelector,
      methodId: 'Tooling.GetTools',
      nowMs: 201
    })).resolves.toEqual({ allowed: false, reasonCode: 'grant_not_found' })
  })

  it('honors expiry and revoke through decrypted grant records', async () => {
    const { repository } = await grantRepositoryFixture()
    await repository.upsertGrant(grant({ grantId: 'expired', expiresAtMs: 250, grantRevision: 1 }))
    await repository.upsertGrant(grant({ grantId: 'active', createdAtMs: 210, grantRevision: 2 }))

    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 251 })).resolves.toMatchObject({
      allowed: true,
      grant: { grantId: 'active' }
    })

    await expect(repository.revokeGrants(selector, 260)).resolves.toEqual([
      expect.objectContaining({ grantId: 'active', grantRevision: 3, revokedAtMs: 260 }),
      expect.objectContaining({ grantId: 'expired', grantRevision: 2, revokedAtMs: 260 })
    ])
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 261 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'grant_revoked'
    })
    await expect(repository.listRecipientGrants(selector, 261)).resolves.toEqual([])
  })

  it('fails closed when grant envelope AAD or ciphertext is wrong', async () => {
    const { session, repository, crypto } = await grantRepositoryFixture()
    await repository.upsertGrant(grant())

    const wrongIdentityRepository = new EncryptedPeerGrantRepository({
      metadataRepository: session.peerGrants,
      crypto,
      profileId,
      localNodeId: 'node-2'
    })
    await expect(wrongIdentityRepository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 201 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'grant_not_found'
    })

    const [record] = await session.peerGrants.listPeerGrants()
    await session.peerGrants.upsertPeerGrant({
      ...record!,
      scopeEnvelope: {
        ...record!.scopeEnvelope,
        ciphertextAndTagB64Url: 'tamperedtamperedtampered'
      }
    })
    await expect(repository.resolveGrant({ selector, methodId: 'Tooling.GetTools', nowMs: 201 })).resolves.toEqual({
      allowed: false,
      reasonCode: 'grant_not_found'
    })
  })

  it('writes bounded redacted local audit records without verifier or bearer fields', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open(profileId, localNodeId)
    const sink = new LocalDataPeerAuditSink({
      auditRepository: session.localAudit,
      profileId,
      localNodeId,
      randomId: () => 'audit-1'
    })
    const audit: LocalPeerAuditRecord = {
      action: 'credential.verify',
      selector,
      decision: 'rejected',
      reasonCode: 'proof_mismatch',
      methodId: 'Tooling.GetTools',
      toolContractId: 'aurora.local.native.share_text.v1',
      capabilityPackId: 'native.share',
      resourceScope: 'document:allowed',
      correlationId: 'corr-1',
      createdAtMs: 300,
      redacted: true,
      redactedFields: ['tokenHashHex', 'proofHex', 'bearerToken']
    }

    await sink.record(audit)

    await expect(session.localAudit.listAudit()).resolves.toEqual([
      expect.objectContaining({
        id: 'audit-1',
        profileId,
        localNodeId,
        peerId: selector.claimantPeerId,
        action: 'credential.verify',
        decision: 'rejected',
        resultStatus: 'rejected',
        methodId: 'Tooling.GetTools',
        toolContractId: 'aurora.local.native.share_text.v1',
        correlationId: 'corr-1',
        redactedDetailJson: expect.objectContaining({
          redacted: true,
          secretsRedacted: true,
          reasonCode: 'proof_mismatch',
          capabilityPackId: 'native.share',
          resourceScope: 'document:allowed'
        })
      })
    ])
    const auditText = JSON.stringify(await session.localAudit.listAudit())
    expect(auditText).not.toMatch(/peer-verifier|room-a|tokenHashHex|proofHex|bearer|[a-f0-9]{64}/u)
  })
})

async function grantRepositoryFixture() {
  const backend = new MemoryLocalDataBackend()
  const session = await backend.open(profileId, localNodeId)
  const crypto = new RecordingEnvelopeCryptoPort()
  const repository = new EncryptedPeerGrantRepository({
    metadataRepository: session.peerGrants,
    crypto,
    profileId,
    localNodeId
  })
  return { backend, session, crypto, repository }
}

class RecordingSecretStorage implements InboundVerifierSecretStoragePort {
  private readonly store = new Map<string, string>()

  async getOpaqueSecret(key: string): Promise<string | undefined> {
    return this.store.get(key)
  }

  async setOpaqueSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async deleteOpaqueSecret(key: string): Promise<void> {
    this.store.delete(key)
  }

  keys(): string[] {
    return [...this.store.keys()].sort()
  }

  values(): string[] {
    return [...this.store.values()]
  }
}

class RecordingEnvelopeCryptoPort implements EnvelopeCryptoPort {
  readonly encrypted: Array<{ keyPurpose: LocalDataKeyPurpose; plaintext: Uint8Array; aad: Uint8Array }> = []
  private readonly retained = new Map<string, { plaintext: Uint8Array; aad: string }>()
  private counter = 0

  async encrypt(keyPurpose: LocalDataKeyPurpose, plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedDataEnvelopeV1> {
    this.counter += 1
    const ciphertextAndTagB64Url = encodeBase64Url(new Uint8Array([this.counter, ...new Uint8Array(16).fill(7)]))
    this.encrypted.push({ keyPurpose, plaintext: new Uint8Array(plaintext), aad: new Uint8Array(aad) })
    this.retained.set(ciphertextAndTagB64Url, {
      plaintext: new Uint8Array(plaintext),
      aad: new TextDecoder().decode(aad)
    })
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: `test-key-${this.counter}`,
      nonceB64Url: encodeBase64Url(new Uint8Array(12).fill(this.counter)),
      ciphertextAndTagB64Url,
      createdAtMs: 1_000 + this.counter
    }
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    const retained = this.retained.get(envelope.ciphertextAndTagB64Url)
    if (retained === undefined) throw new Error('ciphertext not found')
    if (retained.aad !== new TextDecoder().decode(aad)) throw new Error('aad mismatch')
    return new Uint8Array(retained.plaintext)
  }

  async rotateKey(_keyPurpose: LocalDataKeyPurpose): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'test-key-old', newKeyId: 'test-key-new' }
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}
