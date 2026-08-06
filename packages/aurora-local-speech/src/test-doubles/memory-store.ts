import {
  applyLifecycleEvent,
  createLifecycleSnapshot,
  type LocalSpeechLifecycleSnapshot
} from '../models/lifecycle.js'
import type { LocalSpeechPackManifest } from '../models/manifest.js'
import type {
  LocalSpeechActivationPort,
  LocalSpeechConcurrencyPort,
  LocalSpeechDownloadTask,
  LocalSpeechModelStorePort,
  LocalSpeechStoreStatus,
  LocalSpeechStoredAsset
} from '../storage/ports.js'

export class InMemoryLocalSpeechStore
  implements LocalSpeechModelStorePort, LocalSpeechActivationPort, LocalSpeechConcurrencyPort
{
  private readonly assets = new Map<string, LocalSpeechStoredAsset>()
  private readonly lifecycles = new Map<string, LocalSpeechLifecycleSnapshot>()
  private readonly reservations = new Map<string, { readonly packId: string; readonly expectedSha256: string; readonly expectedBytes: number }>()
  private readonly locks = new Set<string>()
  private activePack: string | null = null

  constructor(private readonly options: { readonly now?: () => number; readonly bytesAvailable?: number | null } = {}) {}

  async getStatus(): Promise<LocalSpeechStoreStatus> {
    const bytesUsed = Array.from(this.assets.values()).reduce((sum, asset) => sum + asset.byteSize, 0)
    return {
      bytesUsed,
      bytesAvailable: this.options.bytesAvailable ?? null,
      persistent: true
    }
  }

  async getLifecycle(packId: string): Promise<LocalSpeechLifecycleSnapshot | null> {
    return this.lifecycles.get(packId) ?? null
  }

  async setLifecycle(snapshot: LocalSpeechLifecycleSnapshot): Promise<void> {
    this.lifecycles.set(snapshot.packId, snapshot)
  }

  async reserveAsset(asset: {
    readonly assetId: string
    readonly url: string
    readonly sha256: string
    readonly byteSize: number
  }, packId: string): Promise<LocalSpeechDownloadTask> {
    this.reservations.set(asset.assetId, {
      packId,
      expectedSha256: asset.sha256,
      expectedBytes: asset.byteSize
    })
    return {
      packId,
      assetId: asset.assetId,
      url: asset.url,
      expectedSha256: asset.sha256,
      expectedBytes: asset.byteSize
    }
  }

  async promoteAsset(assetId: string, sha256: string, byteSize: number): Promise<LocalSpeechStoredAsset> {
    const reservation = this.reservations.get(assetId)
    if (!reservation) throw new Error(`asset ${assetId} was not reserved`)
    if (reservation.expectedSha256 !== sha256) throw new Error(`asset ${assetId} hash mismatch`)
    if (reservation.expectedBytes !== byteSize) throw new Error(`asset ${assetId} byte size mismatch`)

    const stored: LocalSpeechStoredAsset = {
      assetId,
      packId: reservation.packId,
      sha256,
      byteSize,
      state: 'ready',
      storedAt: this.now()
    }
    this.assets.set(assetId, stored)
    this.reservations.delete(assetId)
    return stored
  }

  async getAsset(assetId: string): Promise<LocalSpeechStoredAsset | null> {
    return this.assets.get(assetId) ?? null
  }

  async removePack(packId: string): Promise<void> {
    for (const [assetId, asset] of this.assets) {
      if (asset.packId === packId) this.assets.delete(assetId)
    }
    for (const [assetId, reservation] of this.reservations) {
      if (reservation.packId === packId) this.reservations.delete(assetId)
    }
    this.lifecycles.delete(packId)
    if (this.activePack === packId) this.activePack = null
  }

  async listAssets(packId?: string): Promise<readonly LocalSpeechStoredAsset[]> {
    const assets = Array.from(this.assets.values())
    return packId ? assets.filter((asset) => asset.packId === packId) : assets
  }

  async activatePack(manifest: LocalSpeechPackManifest): Promise<LocalSpeechLifecycleSnapshot> {
    const missingAsset = manifest.assets.find((asset) => asset.revocation?.revoked !== true && !this.assets.has(asset.assetId))
    if (missingAsset) throw new Error(`cannot activate ${manifest.packId}; missing asset ${missingAsset.assetId}`)

    const current =
      this.lifecycles.get(manifest.packId) ??
      applyLifecycleEvent(createLifecycleSnapshot(manifest.packId, this.now()), 'enqueue', { now: this.now() })
    const ready = current.state === 'ready' ? current : { ...current, state: 'ready' as const }
    const active = applyLifecycleEvent(ready, 'activate', { now: this.now() })
    this.lifecycles.set(manifest.packId, active)
    this.activePack = manifest.packId
    return active
  }

  async deactivatePack(packId: string): Promise<LocalSpeechLifecycleSnapshot> {
    if (this.activePack === packId) this.activePack = null
    const current = this.lifecycles.get(packId)
    if (!current) return createLifecycleSnapshot(packId, this.now())
    const next = { ...current, state: 'ready' as const, revision: current.revision + 1, updatedAt: this.now() }
    this.lifecycles.set(packId, next)
    return next
  }

  async getActivePack(): Promise<string | null> {
    return this.activePack
  }

  async withModelLock<T>(packId: string, task: () => Promise<T>): Promise<T> {
    if (this.locks.has(packId)) throw new Error(`local speech pack ${packId} is already locked`)
    this.locks.add(packId)
    try {
      return await task()
    } finally {
      this.locks.delete(packId)
    }
  }

  private now(): number {
    return this.options.now?.() ?? 0
  }
}
