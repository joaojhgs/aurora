export interface AuroraWebPersistenceReport {
  readonly available: boolean
  readonly persistent: boolean
  readonly quotaBytes: number | null
  readonly usedBytes: number
}

export interface AuroraWebFetchedChunk {
  readonly bytes: Uint8Array
  readonly offset: number
  readonly complete: boolean
}

export interface AuroraWebFileStat {
  readonly byteLength: number
  readonly sha256: string | null
}

export interface AuroraWebModelStoreHost {
  persistenceReport(): Promise<AuroraWebPersistenceReport>
  readJson(key: string): Promise<string | null>
  writeJson(key: string, value: string): Promise<void>
  deleteJson(key: string): Promise<void>
  listJsonKeys(prefix: string): Promise<readonly string[]>
  stagingLen(storageKey: string): Promise<number>
  readStagingChunk(storageKey: string, offset: number, maxBytes: number): Promise<AuroraWebFetchedChunk>
  appendStaging(storageKey: string, offset: number, bytes: Uint8Array): Promise<void>
  clearStaging(storageKey: string): Promise<void>
  promotedStat(storageKey: string): Promise<AuroraWebFileStat | null>
  readPromotedChunk(storageKey: string, offset: number, maxBytes: number): Promise<AuroraWebFetchedChunk>
  promoteStagingAtomic(storageKey: string): Promise<void>
  deletePromoted(storageKey: string): Promise<void>
  listPromotedKeys(): Promise<readonly string[]>
  removePackData(packId: string): Promise<void>
}
