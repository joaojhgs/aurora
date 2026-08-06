import { describe, expect, it } from 'vitest'

import {
  applyLifecycleEvent,
  canActivate,
  createLifecycleSnapshot,
  type LocalSpeechPackManifest
} from '../src/index.js'
import { InMemoryLocalSpeechStore } from '../src/test-doubles/index.js'

const hash = 'b'.repeat(64)

const pack: LocalSpeechPackManifest = {
  schemaVersion: 1,
  packId: 'starter-en',
  packVersion: '1',
  minAuroraVersion: '0.1.0',
  minRuntimeVersion: '0.1.0',
  minEngineVersion: '0.1.0',
  starter: true,
  optional: false,
  createdAt: '2026-08-06T00:00:00Z',
  assets: [
    {
      assetId: 'asset-1',
      feature: 'tts',
      runtimeTarget: 'android',
      language: 'en',
      byteSize: 16,
      url: 'https://models.example.invalid/asset-1.bin',
      sha256: hash,
      compression: 'none',
      license: 'test-license',
      attribution: 'Aurora test fixture',
      upstreamSource: 'aurora-test',
      upstreamRevision: 'fixture-1',
      redistribution: 'internal-only'
    }
  ]
}

describe('local speech lifecycle and store ports', () => {
  it('moves through the expected install lifecycle', () => {
    const queued = applyLifecycleEvent(createLifecycleSnapshot('starter-en', 10), 'enqueue', { now: 11 })
    const downloading = applyLifecycleEvent(queued, 'start-download', { now: 12 })
    const verifying = applyLifecycleEvent(downloading, 'download-complete', { now: 13 })
    const ready = applyLifecycleEvent(verifying, 'verify-ok', { now: 14 })
    const active = applyLifecycleEvent(ready, 'activate', { now: 15 })

    expect(canActivate(ready)).toBe(true)
    expect(active).toMatchObject({ state: 'active', revision: 5, updatedAt: 15 })
  })

  it('prevents activation before every non-revoked asset is stored', async () => {
    const store = new InMemoryLocalSpeechStore()

    await expect(store.activatePack(pack)).rejects.toThrow(/missing asset/)
  })

  it('promotes reserved assets only when hash and size match', async () => {
    const store = new InMemoryLocalSpeechStore({ now: () => 42 })
    await store.reserveAsset(pack.assets[0]!, pack.packId)

    await expect(store.promoteAsset('asset-1', 'c'.repeat(64), 16)).rejects.toThrow(/hash mismatch/)

    const stored = await store.promoteAsset('asset-1', hash, 16)
    const active = await store.activatePack(pack)

    expect(stored).toMatchObject({ assetId: 'asset-1', state: 'ready', storedAt: 42 })
    expect(active.state).toBe('active')
    expect(await store.getActivePack()).toBe(pack.packId)
  })

  it('serializes model work per pack', async () => {
    const store = new InMemoryLocalSpeechStore()
    await expect(
      store.withModelLock('starter-en', async () =>
        store.withModelLock('starter-en', async () => 'unreachable')
      )
    ).rejects.toThrow(/already locked/)

    await expect(store.withModelLock('starter-en', async () => 'ok')).resolves.toBe('ok')
  })
})
