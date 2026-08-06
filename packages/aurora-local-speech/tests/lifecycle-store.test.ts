import { describe, expect, it } from 'vitest'

import {
  applyLifecycleEvent,
  canActivate,
  canonicalizeManifest,
  createLifecycleSnapshot,
  verifyLocalSpeechManifest,
  type LocalSpeechLifecycleSnapshot,
  type LocalSpeechPackManifest,
  type LocalSpeechVerifiedManifest
} from '../src/index.js'
import { createDeterministicTrustedKey, InMemoryLocalSpeechStore } from '../src/test-doubles/index.js'

const hash = 'b'.repeat(64)

function sign(manifest: Omit<LocalSpeechPackManifest, 'signature'>): LocalSpeechPackManifest {
  const unsigned = manifest as LocalSpeechPackManifest
  return {
    ...manifest,
    signature: {
      keyId: 'test-key',
      algorithm: 'ed25519',
      value: `signed:${canonicalizeManifest(unsigned).length}`
    }
  }
}

async function verify(manifest: LocalSpeechPackManifest): Promise<LocalSpeechVerifiedManifest> {
  return verifyLocalSpeechManifest(manifest, {
    trustedKeys: [
      {
        ...createDeterministicTrustedKey(),
        verify(canonicalManifest, signature): boolean {
          return signature.value === `signed:${canonicalManifest.length}`
        }
      }
    ]
  })
}

function readySnapshot(packId: string): LocalSpeechLifecycleSnapshot {
  const queued = applyLifecycleEvent(createLifecycleSnapshot(packId, 10), 'enqueue', { now: 11 })
  const downloading = applyLifecycleEvent(queued, 'start-download', { now: 12 })
  const verifying = applyLifecycleEvent(downloading, 'download-complete', { now: 13 })
  return applyLifecycleEvent(verifying, 'verify-ok', { now: 14 })
}

const pack: LocalSpeechPackManifest = sign({
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
})

const secondPack: LocalSpeechPackManifest = sign({
  ...pack,
  packId: 'starter-es',
  packVersion: '1',
  assets: [
    {
      ...pack.assets[0]!,
      language: 'es',
      sha256: 'c'.repeat(64)
    }
  ]
})

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
    await store.setLifecycle(readySnapshot(pack.packId))

    await expect(store.activatePack(await verify(pack))).rejects.toThrow(/missing asset/)
  })

  it('does not accept raw manifests at the activation boundary', () => {
    const store = new InMemoryLocalSpeechStore()

    if (false) {
      // @ts-expect-error activation must receive LocalSpeechVerifiedManifest from trust verification
      void store.activatePack(pack)
    }
  })

  it('promotes reserved assets only when hash and size match', async () => {
    const store = new InMemoryLocalSpeechStore({ now: () => 42 })
    const task = await store.reserveAsset(pack.assets[0]!, pack.packId, pack.packVersion)

    await expect(store.promoteAsset(task.storageKey, 'c'.repeat(64), 16)).rejects.toThrow(/hash mismatch/)

    const stored = await store.promoteAsset(task.storageKey, hash, 16)
    await store.setLifecycle(readySnapshot(pack.packId))
    const active = await store.activatePack(await verify(pack))

    expect(stored).toMatchObject({
      storageKey: 'starter-en@1#asset-1',
      assetId: 'asset-1',
      packVersion: '1',
      state: 'ready',
      storedAt: 42
    })
    expect(active.state).toBe('active')
    expect(await store.getActivePack()).toBe(pack.packId)
  })

  it('keys stored assets by pack id, pack version, and asset id', async () => {
    const store = new InMemoryLocalSpeechStore()
    const task = await store.reserveAsset(pack.assets[0]!, pack.packId, pack.packVersion)
    await store.promoteAsset(task.storageKey, hash, 16)
    await store.setLifecycle(readySnapshot('starter-en-v2'))

    const versionTwo = sign({
      ...pack,
      packId: 'starter-en-v2',
      packVersion: '2',
      assets: [{ ...pack.assets[0]!, sha256: hash }]
    })

    await expect(store.activatePack(await verify(versionTwo))).rejects.toThrow(/missing asset/)
  })

  it('checks stored asset hash and size against the activating manifest version', async () => {
    const store = new InMemoryLocalSpeechStore()
    const task = await store.reserveAsset(pack.assets[0]!, pack.packId, pack.packVersion)
    await store.promoteAsset(task.storageKey, hash, 16)
    await store.setLifecycle(readySnapshot(pack.packId))
    const changedManifest = sign({
      ...pack,
      assets: [{ ...pack.assets[0]!, byteSize: 32 }]
    })

    await expect(store.activatePack(await verify(changedManifest))).rejects.toThrow(/does not match manifest/)
  })

  it('requires a ready lifecycle before activation', async () => {
    const store = new InMemoryLocalSpeechStore()
    const task = await store.reserveAsset(pack.assets[0]!, pack.packId, pack.packVersion)
    await store.promoteAsset(task.storageKey, hash, 16)

    await expect(store.activatePack(await verify(pack))).rejects.toThrow(/lifecycle is not ready/)
  })

  it('demotes the previous active pack through the lifecycle table', async () => {
    const store = new InMemoryLocalSpeechStore()
    const firstTask = await store.reserveAsset(pack.assets[0]!, pack.packId, pack.packVersion)
    const secondTask = await store.reserveAsset(secondPack.assets[0]!, secondPack.packId, secondPack.packVersion)
    await store.promoteAsset(firstTask.storageKey, hash, 16)
    await store.promoteAsset(secondTask.storageKey, 'c'.repeat(64), 16)
    await store.setLifecycle(readySnapshot(pack.packId))
    await store.setLifecycle(readySnapshot(secondPack.packId))

    await store.activatePack(await verify(pack))
    await store.activatePack(await verify(secondPack))

    await expect(store.getLifecycle(pack.packId)).resolves.toMatchObject({ state: 'ready' })
    await expect(store.getLifecycle(secondPack.packId)).resolves.toMatchObject({ state: 'active' })
    await expect(store.getActivePack()).resolves.toBe(secondPack.packId)
  })

  it('queues residency model work instead of failing nested acquisition', async () => {
    const store = new InMemoryLocalSpeechStore()
    const order: string[] = []
    let releaseFirst!: () => void

    const first = store.withResidencyLock(async () => {
      order.push('first-start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('first-end')
      return 'first'
    })
    const second = store.withResidencyLock(async () => {
      order.push('second')
      return 'second'
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('queues pack-scoped work independently from the residency lock', async () => {
    const store = new InMemoryLocalSpeechStore()

    await expect(
      Promise.all([
        store.withPackLock('starter-en', async () => 'first'),
        store.withPackLock('starter-en', async () => 'second')
      ])
    ).resolves.toEqual(['first', 'second'])
  })
})
