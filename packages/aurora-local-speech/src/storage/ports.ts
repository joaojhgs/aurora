import type { LocalSpeechInstallState, LocalSpeechLifecycleSnapshot } from '../models/lifecycle.js'
import type { LocalSpeechAssetManifest, LocalSpeechPackManifest } from '../models/manifest.js'

export interface LocalSpeechStoredAsset {
  readonly assetId: string
  readonly packId: string
  readonly sha256: string
  readonly byteSize: number
  readonly state: Extract<LocalSpeechInstallState, 'downloading' | 'verifying' | 'ready' | 'active'>
  readonly storedAt: number
}

export interface LocalSpeechStoreStatus {
  readonly bytesUsed: number
  readonly bytesAvailable: number | null
  readonly persistent: boolean
}

export interface LocalSpeechDownloadTask {
  readonly packId: string
  readonly assetId: string
  readonly url: string
  readonly expectedSha256: string
  readonly expectedBytes: number
}

export interface LocalSpeechModelStorePort {
  getStatus(): Promise<LocalSpeechStoreStatus>
  getLifecycle(packId: string): Promise<LocalSpeechLifecycleSnapshot | null>
  setLifecycle(snapshot: LocalSpeechLifecycleSnapshot): Promise<void>
  reserveAsset(asset: LocalSpeechAssetManifest, packId: string): Promise<LocalSpeechDownloadTask>
  promoteAsset(assetId: string, sha256: string, byteSize: number): Promise<LocalSpeechStoredAsset>
  getAsset(assetId: string): Promise<LocalSpeechStoredAsset | null>
  removePack(packId: string): Promise<void>
  listAssets(packId?: string): Promise<readonly LocalSpeechStoredAsset[]>
}

export interface LocalSpeechActivationPort {
  activatePack(manifest: LocalSpeechPackManifest): Promise<LocalSpeechLifecycleSnapshot>
  deactivatePack(packId: string): Promise<LocalSpeechLifecycleSnapshot>
  getActivePack(): Promise<string | null>
}

export interface LocalSpeechConcurrencyPort {
  withModelLock<T>(packId: string, task: () => Promise<T>): Promise<T>
}
