import {
  LocalDataError,
  type LocalDataKeyPurpose
} from '@aurora/client/local-data'

import {
  buildBrowserEnvelopeKeyScope,
  type BrowserEnvelopeCryptoKeyStore,
  type BrowserEnvelopeKeyScope,
  type BrowserEnvelopeSelectedKey
} from '../browser-envelope-crypto'

interface StoredMapEnvelopeMetadata {
  readonly scope: BrowserEnvelopeKeyScope
  readonly activeVersion: number
  readonly activeKeyId: string
}

export class MapBrowserEnvelopeCryptoKeyStore implements BrowserEnvelopeCryptoKeyStore {
  readonly keys = new Map<string, CryptoKey>()
  readonly metadata = new Map<string, StoredMapEnvelopeMetadata>()
  createAttempts = 0
  private operationQueue: Promise<unknown> = Promise.resolve()

  async getActiveKey(
    scope: BrowserEnvelopeKeyScope,
    createCandidate: () => Promise<CryptoKey>,
    _nowMs: number,
  ): Promise<BrowserEnvelopeSelectedKey> {
    return await this.enqueue(async () => {
      const metadata = this.metadata.get(scope.scopeKey)
      if (metadata !== undefined) {
        const key = this.keys.get(metadata.activeKeyId)
        if (key === undefined) throw new LocalDataError('invalid_record', 'Local data envelope key is unavailable', { reason: 'missing_key' })
        return { keyId: metadata.activeKeyId, key: structuredClone(key) }
      }
      this.createAttempts += 1
      const key = await createCandidate()
      const keyId = testKeyId(scope, 1)
      this.keys.set(keyId, structuredClone(key))
      this.metadata.set(scope.scopeKey, { scope, activeVersion: 1, activeKeyId: keyId })
      return { keyId, key: structuredClone(key) }
    })
  }

  async getKey(scope: BrowserEnvelopeKeyScope, keyId: string): Promise<CryptoKey | null> {
    return await this.enqueue(async () => {
      if (!keyId.startsWith(`aurora-local-data-envelope.${scope.keyPurpose}.${scope.scopeKey}.v`)) return null
      const key = this.keys.get(keyId)
      return key === undefined ? null : structuredClone(key)
    })
  }

  async rotateKey(
    scope: BrowserEnvelopeKeyScope,
    createCandidate: () => Promise<CryptoKey>,
    _nowMs: number,
  ): Promise<{ previousKeyId: string; newKeyId: string }> {
    return await this.enqueue(async () => {
      const current = this.metadata.get(scope.scopeKey)
      if (current === undefined) {
        this.createAttempts += 1
        const key = await createCandidate()
        const keyId = testKeyId(scope, 1)
        this.keys.set(keyId, structuredClone(key))
        this.metadata.set(scope.scopeKey, { scope, activeVersion: 1, activeKeyId: keyId })
        return { previousKeyId: keyId, newKeyId: keyId }
      }
      const key = await createCandidate()
      const nextVersion = current.activeVersion + 1
      const nextKeyId = testKeyId(scope, nextVersion)
      this.keys.set(nextKeyId, structuredClone(key))
      this.metadata.set(scope.scopeKey, { scope, activeVersion: nextVersion, activeKeyId: nextKeyId })
      return { previousKeyId: current.activeKeyId, newKeyId: nextKeyId }
    })
  }

  async deleteKey(scope: BrowserEnvelopeKeyScope, keyId: string): Promise<void> {
    await this.enqueue(async () => {
      if (keyId.startsWith(`aurora-local-data-envelope.${scope.keyPurpose}.${scope.scopeKey}.v`)) this.keys.delete(keyId)
    })
  }

  async close(): Promise<void> {}

  snapshot(): MapBrowserEnvelopeCryptoKeyStore {
    const next = new MapBrowserEnvelopeCryptoKeyStore()
    for (const [keyId, key] of this.keys) next.keys.set(keyId, structuredClone(key))
    for (const [scopeKey, metadata] of this.metadata) next.metadata.set(scopeKey, structuredClone(metadata))
    next.createAttempts = this.createAttempts
    return next
  }

  private async enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => await work()
    const result = this.operationQueue.then(run, run)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return await result
  }
}

export function testEnvelopeScope(input: {
  origin?: string
  profileId?: string
  localNodeId?: string
  keyPurpose?: LocalDataKeyPurpose
} = {}): BrowserEnvelopeKeyScope {
  return buildBrowserEnvelopeKeyScope({
    origin: input.origin ?? 'https://aurora.example.test',
    profileId: input.profileId ?? 'profile-1',
    localNodeId: input.localNodeId ?? 'node-1',
    keyPurpose: input.keyPurpose ?? 'local-structured-data'
  })
}

function testKeyId(scope: BrowserEnvelopeKeyScope, version: number): string {
  return `aurora-local-data-envelope.${scope.keyPurpose}.${scope.scopeKey}.v${version}`
}
