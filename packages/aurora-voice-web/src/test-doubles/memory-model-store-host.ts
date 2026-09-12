import type {
  AuroraWebFetchedChunk,
  AuroraWebFileStat,
  AuroraWebModelStoreHost,
  AuroraWebPersistenceReport
} from '../model-store-host.js'

export class MemoryWebModelStoreHost implements AuroraWebModelStoreHost {
  private readonly json = new Map<string, string>()
  private readonly staging = new Map<string, Uint8Array>()
  private readonly promoted = new Map<string, Uint8Array>()

  constructor(private readonly quotaBytes: number | null = null) {
    if (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0)) {
      throw new Error('quota')
    }
  }

  async persistenceReport(): Promise<AuroraWebPersistenceReport> {
    return {
      available: true,
      persistent: true,
      quotaBytes: this.quotaBytes,
      usedBytes: this.usedBytes()
    }
  }

  async readJson(key: string): Promise<string | null> {
    return this.json.get(key) ?? null
  }

  async writeJson(key: string, value: string): Promise<void> {
    this.json.set(key, value)
  }

  async deleteJson(key: string): Promise<void> {
    this.json.delete(key)
  }

  async listJsonKeys(prefix: string): Promise<readonly string[]> {
    return [...this.json.keys()].filter((key) => key.startsWith(prefix)).sort()
  }

  async stagingLen(storageKey: string): Promise<number> {
    return this.staging.get(storageKey)?.byteLength ?? 0
  }

  async readStagingChunk(storageKey: string, offset: number, maxBytes: number): Promise<AuroraWebFetchedChunk> {
    return chunk(this.staging.get(storageKey) ?? new Uint8Array(), offset, maxBytes)
  }

  async appendStaging(storageKey: string, offset: number, bytes: Uint8Array): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset')
    if (!(bytes instanceof Uint8Array)) throw new Error('bytes')
    const current = this.staging.get(storageKey) ?? new Uint8Array()
    if (offset !== current.byteLength) throw new Error('append_offset')
    this.ensureQuota(bytes.byteLength)
    const next = new Uint8Array(current.byteLength + bytes.byteLength)
    next.set(current, 0)
    next.set(bytes, current.byteLength)
    this.staging.set(storageKey, next)
  }

  async clearStaging(storageKey: string): Promise<void> {
    this.staging.delete(storageKey)
  }

  async promotedStat(storageKey: string): Promise<AuroraWebFileStat | null> {
    const file = this.promoted.get(storageKey)
    if (!file) return null
    return { byteLength: file.byteLength, sha256: null }
  }

  async readPromotedChunk(storageKey: string, offset: number, maxBytes: number): Promise<AuroraWebFetchedChunk> {
    return chunk(this.promoted.get(storageKey) ?? new Uint8Array(), offset, maxBytes)
  }

  async promoteStagingAtomic(storageKey: string): Promise<void> {
    const file = this.staging.get(storageKey)
    if (!file) throw new Error('missing_staging')
    this.promoted.set(storageKey, new Uint8Array(file))
    this.staging.delete(storageKey)
  }

  async deletePromoted(storageKey: string): Promise<void> {
    this.promoted.delete(storageKey)
  }

  async listPromotedKeys(): Promise<readonly string[]> {
    return [...this.promoted.keys()].sort()
  }

  async removePackData(packId: string): Promise<void> {
    for (const key of [...this.staging.keys()]) {
      if (key.startsWith(`${packId}@`)) this.staging.delete(key)
    }
    for (const key of [...this.promoted.keys()]) {
      if (key.startsWith(`${packId}@`)) this.promoted.delete(key)
    }
  }

  private usedBytes(): number {
    return [...this.staging.values(), ...this.promoted.values()]
      .reduce((total, file) => total + file.byteLength, 0)
  }

  private ensureQuota(extraBytes: number): void {
    if (this.quotaBytes !== null && this.usedBytes() + extraBytes > this.quotaBytes) {
      throw new Error('quota')
    }
  }
}

function chunk(bytes: Uint8Array, offset: number, maxBytes: number): AuroraWebFetchedChunk {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset')
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('max_bytes')
  const end = Math.min(bytes.byteLength, offset + maxBytes)
  return {
    bytes: bytes.slice(offset, end),
    offset,
    complete: end >= bytes.byteLength
  }
}
