const AURORA_BROWSER_SQLITE_DATABASE_NAME = '/aurora-lightweight.db'
const AURORA_BROWSER_SQLITE_DIRECTORY_PREFIX = '/aurora/nodes/'
const PYTHON_SERVICE_DB_RE = /(?:^|[/\\])(?:aurora|test_db|scheduler|auth|db|rag|messages?)[-_]?(?:service|python)?\.sqlite(?:3|$)?/iu

export type BrowserSqliteProbeFailureReason =
  | 'worker_unavailable'
  | 'wasm_unavailable'
  | 'opfs_unavailable'
  | 'ownership_unavailable'
  | 'invalid_identity'
  | 'python_database_rejected'
  | 'storage_persistence_denied'

export interface BrowserSqliteStorageIdentity {
  readonly browserStorageIdentity: string
  readonly sahPoolDirectory: string
  readonly databaseName: typeof AURORA_BROWSER_SQLITE_DATABASE_NAME
  readonly ownershipKey: string
}

export interface BrowserSqliteOwnership {
  readonly key: string
  readonly ownerId: string
  release(): Promise<void>
}

export interface BrowserSqliteOwnershipLock {
  acquire(key: string, signal?: AbortSignal): Promise<BrowserSqliteOwnership>
}

export interface BrowserSqliteFeatureProbeOptions {
  readonly lock?: BrowserSqliteOwnershipLock
  readonly workerFactory?: BrowserSqliteWorkerFactory
  readonly wasmAssetUrl?: string
  readonly signal?: AbortSignal
  readonly requirePersistentStorage?: boolean
}

export interface BrowserSqliteFeatureProbeSuccess {
  readonly ok: true
  readonly identity: BrowserSqliteStorageIdentity
  readonly ownership: BrowserSqliteOwnership
  readonly persistentStorageGranted: boolean | null
}

export interface BrowserSqliteFeatureProbeFailure {
  readonly ok: false
  readonly reason: BrowserSqliteProbeFailureReason
}

export type BrowserSqliteFeatureProbeResult = BrowserSqliteFeatureProbeSuccess | BrowserSqliteFeatureProbeFailure
export type BrowserSqliteWorkerFactory = () => Pick<Worker, 'terminate'>

export function deriveBrowserSqliteStorageIdentity(localNodeId: string): BrowserSqliteStorageIdentity {
  if (!isSafeLocalNodeIdentity(localNodeId)) {
    throw new Error('invalid_identity')
  }
  if (rejectsPythonServiceDatabaseName(localNodeId)) {
    throw new Error('python_database_rejected')
  }
  const browserStorageIdentity = Array.from(sha256Bytes(new TextEncoder().encode(localNodeId.toLowerCase())), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  const sahPoolDirectory = `${AURORA_BROWSER_SQLITE_DIRECTORY_PREFIX}${browserStorageIdentity}/`
  const ownershipKey = `aurora:local-data:sqlite:${globalThis.location?.origin ?? 'unknown-origin'}:${sahPoolDirectory}:${AURORA_BROWSER_SQLITE_DATABASE_NAME}`
  return {
    browserStorageIdentity,
    sahPoolDirectory,
    databaseName: AURORA_BROWSER_SQLITE_DATABASE_NAME,
    ownershipKey
  }
}

export async function probeBrowserSqliteOpfs(
  localNodeId: string,
  options: BrowserSqliteFeatureProbeOptions = {}
): Promise<BrowserSqliteFeatureProbeResult> {
  let identity: BrowserSqliteStorageIdentity
  try {
    identity = deriveBrowserSqliteStorageIdentity(localNodeId)
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.message === 'python_database_rejected' ? 'python_database_rejected' : 'invalid_identity' }
  }

  if (typeof Worker === 'undefined' && options.workerFactory === undefined) {
    return { ok: false, reason: 'worker_unavailable' }
  }
  if (typeof WebAssembly === 'undefined') {
    return { ok: false, reason: 'wasm_unavailable' }
  }
  if (!hasOpfsSyncAccessHandle()) {
    return { ok: false, reason: 'opfs_unavailable' }
  }
  if (options.wasmAssetUrl !== undefined && !isSameOriginAsset(options.wasmAssetUrl)) {
    return { ok: false, reason: 'wasm_unavailable' }
  }

  const persistentStorageGranted = await requestPersistentStorage()
  if (options.requirePersistentStorage === true && persistentStorageGranted === false) {
    return { ok: false, reason: 'storage_persistence_denied' }
  }

  const lock = options.lock ?? new WebLocksBrowserSqliteOwnershipLock()
  try {
    const ownership = await lock.acquire(identity.ownershipKey, options.signal)
    return { ok: true, identity, ownership, persistentStorageGranted }
  } catch {
    return { ok: false, reason: 'ownership_unavailable' }
  }
}

export class WebLocksBrowserSqliteOwnershipLock implements BrowserSqliteOwnershipLock {
  async acquire(key: string, signal?: AbortSignal): Promise<BrowserSqliteOwnership> {
    const ownerId = crypto.randomUUID()
    const locks = (navigator as Navigator & { locks?: LockManager }).locks
    if (locks === undefined) {
      throw new Error('ownership_unavailable')
    }
    let releaseLock!: () => void
    let acquiredLock!: () => void
    const releasePromise = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const acquiredSignal = new Promise<void>((resolve) => {
      acquiredLock = resolve
    })
    const options: LockOptions = signal === undefined
      ? { mode: 'exclusive', ifAvailable: true }
      : { mode: 'exclusive', ifAvailable: true, signal }
    const acquired = locks.request(key, options, async (lock) => {
      if (lock === null) return false
      acquiredLock()
      await releasePromise
      return true
    })
    const held = await Promise.race([acquired.then((value) => value === true), acquiredSignal.then(() => true)])
    if (held === false) throw new Error('ownership_unavailable')
    return {
      key,
      ownerId,
      release: async () => {
        releaseLock()
        await acquired.catch(() => undefined)
      }
    }
  }
}

export function isSameOriginAsset(url: string): boolean {
  try {
    const parsed = new URL(url, globalThis.location?.href)
    return parsed.origin === globalThis.location?.origin
  } catch {
    return false
  }
}

export function rejectsPythonServiceDatabaseName(value: string): boolean {
  return value.includes('..') || PYTHON_SERVICE_DB_RE.test(value)
}

function isSafeLocalNodeIdentity(localNodeId: string): boolean {
  return /^[A-Za-z0-9_.:@/-]{1,256}$/u.test(localNodeId) && !localNodeId.includes('..') && !localNodeId.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(localNodeId)
}

function hasOpfsSyncAccessHandle(): boolean {
  const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<unknown> } | undefined
  return typeof storage?.getDirectory === 'function'
}

async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    if (typeof navigator.storage?.persist !== 'function') return null
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

function sha256Bytes(input: Uint8Array): Uint8Array {
  const words = new Uint32Array(64)
  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ])
  const bitLength = input.length * 8
  const paddedLength = (((input.length + 9 + 63) >> 6) << 6)
  const data = new Uint8Array(paddedLength)
  data.set(input)
  data[input.length] = 0x80
  const view = new DataView(data.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      words[index] = (smallSigma1(words[index - 2] ?? 0) + (words[index - 7] ?? 0) + smallSigma0(words[index - 15] ?? 0) + (words[index - 16] ?? 0)) >>> 0
    }
    let a = hash[0] ?? 0
    let b = hash[1] ?? 0
    let c = hash[2] ?? 0
    let d = hash[3] ?? 0
    let e = hash[4] ?? 0
    let f = hash[5] ?? 0
    let g = hash[6] ?? 0
    let h = hash[7] ?? 0
    for (let index = 0; index < 64; index += 1) {
      const t1 = (h + bigSigma1(e) + choice(e, f, g) + K[index]! + words[index]!) >>> 0
      const t2 = (bigSigma0(a) + majority(a, b, c)) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0
    hash[1] = ((hash[1] ?? 0) + b) >>> 0
    hash[2] = ((hash[2] ?? 0) + c) >>> 0
    hash[3] = ((hash[3] ?? 0) + d) >>> 0
    hash[4] = ((hash[4] ?? 0) + e) >>> 0
    hash[5] = ((hash[5] ?? 0) + f) >>> 0
    hash[6] = ((hash[6] ?? 0) + g) >>> 0
    hash[7] = ((hash[7] ?? 0) + h) >>> 0
  }
  const output = new Uint8Array(32)
  const outputView = new DataView(output.buffer)
  for (let index = 0; index < 8; index += 1) {
    outputView.setUint32(index * 4, hash[index] ?? 0, false)
  }
  return output
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift))
}

function choice(x: number, y: number, z: number): number {
  return (x & y) ^ (~x & z)
}

function majority(x: number, y: number, z: number): number {
  return (x & y) ^ (x & z) ^ (y & z)
}

function bigSigma0(value: number): number {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22)
}

function bigSigma1(value: number): number {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25)
}

function smallSigma0(value: number): number {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)
}

function smallSigma1(value: number): number {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])
