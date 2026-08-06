import type { LocalSpeechInstallState, LocalSpeechLifecycleSnapshot } from '../models/lifecycle.js'
import type { LocalSpeechAssetManifest } from '../models/manifest.js'
import type { LocalSpeechVerifiedManifest } from '../models/trust.js'

export function localSpeechAssetStorageKey(packId: string, packVersion: string, assetId: string): string {
  return `${encodeURIComponent(packId)}@${encodeURIComponent(packVersion)}#${encodeURIComponent(assetId)}`
}

export interface LocalSpeechStoredAsset {
  readonly storageKey: string
  readonly assetId: string
  readonly packId: string
  readonly packVersion: string
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
  readonly storageKey: string
  readonly packId: string
  readonly packVersion: string
  readonly assetId: string
  readonly url: string
  readonly expectedSha256: string
  readonly expectedBytes: number
}

export interface LocalSpeechModelStorePort {
  getStatus(): Promise<LocalSpeechStoreStatus>
  getLifecycle(packId: string): Promise<LocalSpeechLifecycleSnapshot | null>
  setLifecycle(snapshot: LocalSpeechLifecycleSnapshot): Promise<void>
  reserveAsset(asset: LocalSpeechAssetManifest, packId: string, packVersion: string): Promise<LocalSpeechDownloadTask>
  promoteAsset(storageKey: string, sha256: string, byteSize: number): Promise<LocalSpeechStoredAsset>
  getAsset(packId: string, packVersion: string, assetId: string): Promise<LocalSpeechStoredAsset | null>
  removePack(packId: string): Promise<void>
  listAssets(packId?: string): Promise<readonly LocalSpeechStoredAsset[]>
}

export interface LocalSpeechActivationPort {
  activatePack(verifiedManifest: LocalSpeechVerifiedManifest): Promise<LocalSpeechLifecycleSnapshot>
  deactivatePack(packId: string): Promise<LocalSpeechLifecycleSnapshot>
  getActivePack(): Promise<string | null>
}

export interface LocalSpeechConcurrencyPort {
  withResidencyLock<T>(task: () => Promise<T>): Promise<T>
  withPackLock<T>(packId: string, task: () => Promise<T>): Promise<T>
}
