import { describe, expect, it } from 'vitest'
import {
  LocalDataError,
  parseEncryptedDataEnvelopeV1,
  type EncryptedDataEnvelopeV1
} from '@aurora/client/local-data'

import {
  BrowserEnvelopeCryptoPort
} from './browser-envelope-crypto'
import {
  deleteMemoryDatabase,
  deriveTestBrowserEnvelopeCryptoDatabaseName,
  MemoryIndexedDbFactory
} from './__tests__/browser-envelope-crypto-test-helpers'

const cryptoImpl = globalThis.crypto
const encoder = new TextEncoder()

describe('BrowserEnvelopeCryptoPort', () => {
  it('roundtrips with real WebCrypto and emits canonical nondeterministic envelopes', async () => {
    const port = createPort()
    const plaintext = bytes('secret structured local data')
    const aad = bytes('table:memory|record:1|field:payload')

    const first = await port.encrypt('local-structured-data', plaintext, aad)
    const second = await port.encrypt('local-structured-data', plaintext, aad)

    expect(first).toMatchObject({ version: 1, algorithm: 'AES-GCM-256', keyId: second.keyId })
    expect(first.nonceB64Url).not.toBe(second.nonceB64Url)
    expect(first.ciphertextAndTagB64Url).not.toBe(second.ciphertextAndTagB64Url)
    expect(first.nonceB64Url).not.toContain('=')
    expect(first.ciphertextAndTagB64Url).not.toContain('=')
    expect(base64UrlDecode(first.nonceB64Url)).toHaveLength(12)
    expect(base64UrlDecode(first.ciphertextAndTagB64Url).byteLength).toBeGreaterThanOrEqual(16)
    expect(await port.decrypt(first, aad)).toEqual(plaintext)
    expect(parseEncryptedDataEnvelopeV1(first)).toEqual(first)
  })

  it('persists non-extractable CryptoKey handles across structured-cloned reload stores', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const firstPort = createPort({ indexedDB })
    const aad = bytes('aad')
    const envelope = await firstPort.encrypt('local-structured-data', bytes('persisted secret'), aad)
    const selectedKey = readMemoryKey(indexedDB, envelope.keyId)

    expect(selectedKey).toBeDefined()
    expect(selectedKey?.extractable).toBe(false)
    await expect(cryptoImpl.subtle.exportKey('raw', selectedKey!)).rejects.toThrow()

    await firstPort.close()
    const reloadedPort = createPort({ indexedDB })
    await expect(reloadedPort.decrypt(envelope, aad)).resolves.toEqual(bytes('persisted secret'))
  })

  it('fails closed for wrong AAD, tamper, tag changes, and wrong scoped keyId without leaking plaintext', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const port = createPort({ indexedDB })
    const aad = bytes('correct aad')
    const envelope = await port.encrypt('local-structured-data', bytes('plain-secret-token'), aad)

    await expectLocalDataFailure(port.decrypt(envelope, bytes('wrong aad')), 'decryption_failed')
    await expectLocalDataFailure(port.decrypt({
      ...envelope,
      ciphertextAndTagB64Url: flipLastByte(envelope.ciphertextAndTagB64Url)
    }, aad), 'decryption_failed')
    await expectLocalDataFailure(port.decrypt({
      ...envelope,
      nonceB64Url: flipLastByte(envelope.nonceB64Url)
    }, aad), 'decryption_failed')

    const otherProfile = createPort({ indexedDB, profileId: 'profile-2' })
    const otherEnvelope = await otherProfile.encrypt('local-structured-data', bytes('other secret'), aad)
    await expectLocalDataFailure(port.decrypt({
      ...envelope,
      keyId: otherEnvelope.keyId
    }, aad), 'missing_key')

    for (const candidate of [envelope, { ...envelope, ciphertextAndTagB64Url: flipLastByte(envelope.ciphertextAndTagB64Url) }]) {
      await port.decrypt(candidate, bytes('wrong aad')).catch((error: unknown) => {
        expect(String(error)).not.toContain('plain-secret-token')
      })
    }
  })

  it('serializes concurrent first use so one active key version is selected', async () => {
    const port = createPort()
    const aad = bytes('aad')
    const envelopes = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      port.encrypt('local-structured-data', bytes(`secret-${index}`), aad)
    ))

    expect(new Set(envelopes.map((envelope) => envelope.keyId)).size).toBe(1)
    await expect(port.decrypt(envelopes[17]!, aad)).resolves.toEqual(bytes('secret-17'))
  })

  it('rotates to a new active key while keeping old envelopes readable', async () => {
    const port = createPort()
    const aad = bytes('aad')
    const oldEnvelope = await port.encrypt('local-structured-data', bytes('old secret'), aad)
    const rotation = await port.rotateKey('local-structured-data')
    const newEnvelope = await port.encrypt('local-structured-data', bytes('new secret'), aad)

    expect(rotation.previousKeyId).toBe(oldEnvelope.keyId)
    expect(rotation.newKeyId).toBe(newEnvelope.keyId)
    expect(rotation.newKeyId).not.toBe(rotation.previousKeyId)
    await expect(port.decrypt(oldEnvelope, aad)).resolves.toEqual(bytes('old secret'))
    await expect(port.decrypt(newEnvelope, aad)).resolves.toEqual(bytes('new secret'))
  })

  it('serializes concurrent rotations and selects one final active key', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const observer = createPort({ indexedDB })
    const firstRotationGate = createDeferred()
    const first = createPort({ indexedDB, crypto: createGenerateKeyGateCrypto(firstRotationGate.promise) })
    const second = createPort({ indexedDB })
    const aad = bytes('aad')
    const original = await observer.encrypt('local-structured-data', bytes('original secret'), aad)

    const firstRotation = first.rotateKey('local-structured-data')
    await Promise.resolve()
    const secondRotation = await second.rotateKey('local-structured-data')
    firstRotationGate.resolve()
    const rotations = await Promise.all([firstRotation, Promise.resolve(secondRotation)])
    const afterRotation = await observer.encrypt('local-structured-data', bytes('active secret'), aad)

    expect(rotations[0]?.newKeyId).not.toBe(rotations[1]?.newKeyId)
    expect(rotations[1]?.previousKeyId).toBe(original.keyId)
    expect(rotations[0]?.previousKeyId).toBe(rotations[1]?.newKeyId)
    expect(keyVersion(rotations[0]!.newKeyId)).toBeGreaterThan(keyVersion(rotations[1]!.newKeyId))
    expect(afterRotation.keyId).toBe(rotations[0]?.newKeyId)
    await expect(observer.decrypt(original, aad)).resolves.toEqual(bytes('original secret'))
    await expect(observer.decrypt(afterRotation, aad)).resolves.toEqual(bytes('active secret'))
  })

  it('isolates keys by origin, profile, and local node', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const first = createPort({ indexedDB, origin: 'https://aurora.example.test/a', profileId: 'profile-1', localNodeId: 'node-1' })
    const sameOriginPath = createPort({ indexedDB, origin: 'https://aurora.example.test/b', profileId: 'profile-1', localNodeId: 'node-1' })
    const otherProfile = createPort({ indexedDB, origin: 'https://aurora.example.test', profileId: 'profile-2', localNodeId: 'node-1' })
    const otherNode = createPort({ indexedDB, origin: 'https://aurora.example.test', profileId: 'profile-1', localNodeId: 'node-2' })
    const aad = bytes('aad')
    const envelope = await first.encrypt('local-structured-data', bytes('isolated secret'), aad)

    await expect(sameOriginPath.decrypt(envelope, aad)).resolves.toEqual(bytes('isolated secret'))
    await expectLocalDataFailure(otherProfile.decrypt(envelope, aad), 'missing_key')
    await expectLocalDataFailure(otherNode.decrypt(envelope, aad), 'missing_key')
  })

  it('proves missing-key unreadability after the isolated key vault disappears', async () => {
    const indexedDB = new MemoryIndexedDbFactory()
    const port = createPort({ indexedDB })
    const aad = bytes('aad')
    const envelope = await port.encrypt('local-structured-data', bytes('delete secret'), aad)

    await port.close()
    await deleteMemoryDatabase(indexedDB, deriveTestBrowserEnvelopeCryptoDatabaseName('https://aurora.example.test', 'node-1'))
    const reopened = createPort({ indexedDB })
    await expectLocalDataFailure(reopened.decrypt(envelope, aad), 'missing_key')
  })

  it('validates canonical envelopes before decrypting', async () => {
    const port = createPort()
    const invalidEnvelope = {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'key-1',
      nonceB64Url: 'AAAAAAAAAAAAAAAA=',
      ciphertextAndTagB64Url: 'AAAA',
      createdAtMs: 1
    } as unknown as EncryptedDataEnvelopeV1

    await expect(port.decrypt(invalidEnvelope, bytes('aad'))).rejects.toMatchObject({
      code: 'invalid_record',
      metadata: {
        boundaryId: 'envelope.v1',
        validation: 'redacted'
      }
    })
  })
})

function createPort(
  overrides: Partial<{ origin: string; profileId: string; localNodeId: string; indexedDB: MemoryIndexedDbFactory; crypto: Crypto }> = {},
): BrowserEnvelopeCryptoPort {
  const indexedDB = overrides.indexedDB ?? new MemoryIndexedDbFactory()
  return new BrowserEnvelopeCryptoPort({
    origin: overrides.origin ?? 'https://aurora.example.test',
    profileId: overrides.profileId ?? 'profile-1',
    localNodeId: overrides.localNodeId ?? 'node-1',
    indexedDB: indexedDB as unknown as IDBFactory,
    crypto: overrides.crypto ?? cryptoImpl,
    nowMs: () => 1_000
  })
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createGenerateKeyGateCrypto(gate: Promise<void>): Crypto {
  return {
    getRandomValues: cryptoImpl.getRandomValues.bind(cryptoImpl),
    subtle: {
      generateKey: async (
        algorithm: AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams | HmacKeyGenParams | AesKeyGenParams,
        extractable: boolean,
        keyUsages: readonly KeyUsage[],
      ) => {
        await gate
        return await cryptoImpl.subtle.generateKey(algorithm, extractable, keyUsages)
      },
      encrypt: cryptoImpl.subtle.encrypt.bind(cryptoImpl.subtle),
      decrypt: cryptoImpl.subtle.decrypt.bind(cryptoImpl.subtle)
    } as unknown as SubtleCrypto
  } as Crypto
}

function keyVersion(keyId: string): number {
  const match = /\.v([1-9][0-9]*)$/u.exec(keyId)
  if (match === null) throw new Error(`Missing key version: ${keyId}`)
  return Number(match[1])
}

function readMemoryKey(indexedDB: MemoryIndexedDbFactory, keyId: string): CryptoKey | undefined {
  const databaseName = deriveTestBrowserEnvelopeCryptoDatabaseName('https://aurora.example.test', 'node-1')
  return indexedDB.databases.get(databaseName)?.stores.get('keys')?.get(keyId) as CryptoKey | undefined
}

function bytes(value: string): Uint8Array {
  return encoder.encode(value)
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = `${value.replace(/-/gu, '+').replace(/_/gu, '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

function flipLastByte(value: string): string {
  const bytesValue = base64UrlDecode(value)
  bytesValue[bytesValue.length - 1] = (bytesValue[bytesValue.length - 1] ?? 0) ^ 0xff
  return base64UrlEncode(bytesValue)
}

async function expectLocalDataFailure(operation: Promise<unknown>, reason: string): Promise<void> {
  await operation.then(
    () => {
      throw new Error('expected local data failure')
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(LocalDataError)
      expect(error).toMatchObject({
        code: 'invalid_record',
        metadata: { reason }
      })
    },
  )
}
