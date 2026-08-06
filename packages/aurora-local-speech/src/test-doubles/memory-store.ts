import {
  applyLifecycleEvent,
  localSpeechPackLifecycleKey,
  type LocalSpeechPackIdentity,
  type LocalSpeechLifecycleSnapshot
} from '../models/lifecycle.js'
import { assertLocalSpeechVerifiedManifest, type LocalSpeechVerifiedManifest } from '../models/trust.js'
import type {
  LocalSpeechActivationPort,
  LocalSpeechConcurrencyPort,
  LocalSpeechDownloadTask,
  LocalSpeechModelStorePort,
  LocalSpeechStoreStatus,
  LocalSpeechStoredAsset
} from '../storage/ports.js'
import { localSpeechAssetStorageKey } from '../storage/ports.js'

interface Reservation {
  readonly storageKey: string
  readonly packId: string
  readonly packVersion: string
  readonly assetId: string
  readonly expectedSha256: string
  readonly expectedBytes: number
}

export class InMemoryLocalSpeechStore
  implements LocalSpeechModelStorePort, LocalSpeechActivationPort, LocalSpeechConcurrencyPort
{
  private readonly assets = new Map<string, LocalSpeechStoredAsset>()
  private readonly lifecycles = new Map<string, LocalSpeechLifecycleSnapshot>()
  private readonly reservations = new Map<string, Reservation>()
  private readonly lockChains = new Map<string, Promise<void>>()
  private residencyLockChain: Promise<void> = Promise.resolve()
  private activePack: LocalSpeechPackIdentity | null = null

  constructor(
    private readonly options: {
      readonly now?: () => number
      readonly bytesAvailable?: number | null
      readonly persistent?: boolean
    } = {}
  ) {}

  async getStatus(): Promise<LocalSpeechStoreStatus> {
    const bytesUsed = Array.from(this.assets.values()).reduce((sum, asset) => sum + asset.byteSize, 0)
    return {
      bytesUsed,
      bytesAvailable: this.options.bytesAvailable ?? null,
      persistent: this.options.persistent ?? false
    }
  }

  async getLifecycle(packId: string, packVersion: string): Promise<LocalSpeechLifecycleSnapshot | null> {
    return this.lifecycles.get(localSpeechPackLifecycleKey(packId, packVersion)) ?? null
  }

  async setLifecycle(snapshot: LocalSpeechLifecycleSnapshot): Promise<void> {
    this.lifecycles.set(localSpeechPackLifecycleKey(snapshot.packId, snapshot.packVersion), snapshot)
  }

  async reserveAsset(asset: {
    readonly assetId: string
    readonly url: string
    readonly sha256: string
    readonly byteSize: number
  }, packId: string, packVersion: string): Promise<LocalSpeechDownloadTask> {
    const storageKey = localSpeechAssetStorageKey(packId, packVersion, asset.assetId)
    this.reservations.set(storageKey, {
      storageKey,
      packId,
      packVersion,
      assetId: asset.assetId,
      expectedSha256: asset.sha256,
      expectedBytes: asset.byteSize
    })
    return {
      storageKey,
      packId,
      packVersion,
      assetId: asset.assetId,
      url: asset.url,
      expectedSha256: asset.sha256,
      expectedBytes: asset.byteSize
    }
  }

  async promoteAsset(storageKey: string, sha256: string, byteSize: number): Promise<LocalSpeechStoredAsset> {
    const reservation = this.reservations.get(storageKey)
    if (!reservation) throw new Error(`asset ${storageKey} was not reserved`)
    if (reservation.expectedSha256 !== sha256) throw new Error(`asset ${storageKey} hash mismatch`)
    if (reservation.expectedBytes !== byteSize) throw new Error(`asset ${storageKey} byte size mismatch`)

    const stored: LocalSpeechStoredAsset = {
      storageKey,
      assetId: reservation.assetId,
      packId: reservation.packId,
      packVersion: reservation.packVersion,
      sha256,
      byteSize,
      state: 'ready',
      storedAt: this.now()
    }
    this.assets.set(storageKey, stored)
    this.reservations.delete(storageKey)
    return stored
  }

  async getAsset(packId: string, packVersion: string, assetId: string): Promise<LocalSpeechStoredAsset | null> {
    return this.assets.get(localSpeechAssetStorageKey(packId, packVersion, assetId)) ?? null
  }

  async removePack(packId: string): Promise<void> {
    for (const [storageKey, asset] of this.assets) {
      if (asset.packId === packId) this.assets.delete(storageKey)
    }
    for (const [storageKey, reservation] of this.reservations) {
      if (reservation.packId === packId) this.reservations.delete(storageKey)
    }
    for (const [lifecycleKey, snapshot] of this.lifecycles) {
      if (snapshot.packId === packId) this.lifecycles.delete(lifecycleKey)
    }
    if (this.activePack?.packId === packId) this.activePack = null
  }

  async listAssets(packId?: string): Promise<readonly LocalSpeechStoredAsset[]> {
    const assets = Array.from(this.assets.values())
    return packId ? assets.filter((asset) => asset.packId === packId) : assets
  }

  async activatePack(verifiedManifest: LocalSpeechVerifiedManifest): Promise<LocalSpeechLifecycleSnapshot> {
    return this.withResidencyLock(() => this.activatePackUnlocked(verifiedManifest))
  }

  private async activatePackUnlocked(verifiedManifest: LocalSpeechVerifiedManifest): Promise<LocalSpeechLifecycleSnapshot> {
    assertLocalSpeechVerifiedManifest(verifiedManifest)
    const manifest = verifiedManifest.manifest
    const current = this.lifecycles.get(localSpeechPackLifecycleKey(manifest.packId, manifest.packVersion))
    if (!current || current.state !== 'ready') {
      throw new Error(`cannot activate ${manifest.packId}; lifecycle is not ready`)
    }

    const activeAssets = manifest.assets.filter((asset) => asset.revocation?.revoked !== true)
    if (activeAssets.length === 0) {
      throw new Error(`cannot activate ${manifest.packId}; manifest has no active assets`)
    }

    const revokedAssetIds = new Set(
      manifest.assets.filter((asset) => asset.revocation?.revoked === true).map((asset) => asset.assetId)
    )
    for (const asset of activeAssets) {
      const revokedDependency = (asset.dependencies ?? []).find((dependency) => revokedAssetIds.has(dependency))
      if (revokedDependency) {
        throw new Error(`cannot activate ${manifest.packId}; asset ${asset.assetId} depends on revoked asset ${revokedDependency}`)
      }
    }

    for (const asset of activeAssets) {
      const stored = this.assets.get(localSpeechAssetStorageKey(manifest.packId, manifest.packVersion, asset.assetId))
      if (!stored) throw new Error(`cannot activate ${manifest.packId}; missing asset ${asset.assetId}`)
      if (stored.sha256 !== asset.sha256 || stored.byteSize !== asset.byteSize) {
        throw new Error(`cannot activate ${manifest.packId}; asset ${asset.assetId} does not match manifest`)
      }
    }

    if (
      this.activePack &&
      (this.activePack.packId !== manifest.packId || this.activePack.packVersion !== manifest.packVersion)
    ) {
      const previous = this.lifecycles.get(
        localSpeechPackLifecycleKey(this.activePack.packId, this.activePack.packVersion)
      )
      if (previous?.state === 'active') {
        this.lifecycles.set(
          localSpeechPackLifecycleKey(previous.packId, previous.packVersion),
          applyLifecycleEvent(previous, 'deactivate', { now: this.now() })
        )
      }
    }

    const active = applyLifecycleEvent(current, 'activate', { now: this.now() })
    this.lifecycles.set(localSpeechPackLifecycleKey(manifest.packId, manifest.packVersion), active)
    this.activePack = { packId: manifest.packId, packVersion: manifest.packVersion }
    return active
  }

  async deactivatePack(packId: string, packVersion: string): Promise<LocalSpeechLifecycleSnapshot> {
    return this.withResidencyLock(() => this.deactivatePackUnlocked(packId, packVersion))
  }

  private async deactivatePackUnlocked(packId: string, packVersion: string): Promise<LocalSpeechLifecycleSnapshot> {
    const current = this.lifecycles.get(localSpeechPackLifecycleKey(packId, packVersion))
    if (!current) throw new Error(`cannot deactivate ${packId}; lifecycle is missing`)
    const next = applyLifecycleEvent(current, 'deactivate', { now: this.now() })
    this.lifecycles.set(localSpeechPackLifecycleKey(packId, packVersion), next)
    if (this.activePack?.packId === packId && this.activePack.packVersion === packVersion) this.activePack = null
    return next
  }

  async getActivePack(): Promise<LocalSpeechPackIdentity | null> {
    return this.activePack
  }

  async withResidencyLock<T>(task: () => Promise<T>): Promise<T> {
    const result = this.enqueueAfter(this.residencyLockChain, task)
    this.residencyLockChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async withPackLock<T>(packId: string, task: () => Promise<T>): Promise<T> {
    const current = this.lockChains.get(packId) ?? Promise.resolve()
    const result = this.enqueueAfter(current, task)
    this.lockChains.set(
      packId,
      result.then(
        () => undefined,
        () => undefined
      )
    )
    return result
  }

  private now(): number {
    return this.options.now?.() ?? 0
  }

  private async enqueueAfter<T>(current: Promise<void>, task: () => Promise<T>): Promise<T> {
    await current
    return task()
  }
}
