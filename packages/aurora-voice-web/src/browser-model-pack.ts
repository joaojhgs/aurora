import type { AuroraWebModelStoreHost } from './model-store-host.js'
import type { AuroraVoiceWebModelDescriptor } from './types.js'
import type * as AuroraVoiceWasmModule from './wasm/aurora_voice_wasm.js'

export const AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID = 'aurora-nonproduction-web-wasm-test'
export const AURORA_MODEL_PACK_SIGNATURE_ALGORITHM = 'ed25519'

const NON_PRODUCTION_WEB_WASM_PUBLIC_KEY_BASE64 = 'k1NEXA5D4H1jAs3GBxo9Cr42I6BUeYEA/HqYiTOUKhc='

const ACTIVE_PREFIX = 'aurora.voice.web-store.v1:active:'
const EXPECTED_SELECTION_PREFIX = 'aurora.voice.web-store.v1:expected-selection:'
const FILE_PREFIX = 'aurora.voice.web-store.v1:file:'
const LIFECYCLE_PREFIX = 'aurora.voice.web-store.v1:lifecycle:'
const LIFECYCLE_BACKING_PREFIX = 'aurora.voice.web-store.v1:lifecycle-backing:'
const HASH_CHUNK_BYTES = 64 * 1024

export interface AuroraBrowserModelPackSignature {
  readonly key_id: string
  readonly algorithm: string
  readonly value: string
}

export interface AuroraBrowserModelPackFile {
  readonly file_id: string
  readonly asset_id: string
  readonly task: string
  readonly url: string
  readonly sha256: string
  readonly byte_size: number
  readonly installed_size: number
  readonly compression: 'none' | 'tar_bzip2'
  readonly archive_root?: string
  readonly archive_entries?: readonly AuroraBrowserModelPackArchiveEntry[]
  readonly dependencies?: readonly string[]
}

export interface AuroraBrowserModelPackArchiveEntry {
  readonly file_id: string
  readonly task: string
  readonly path: string
  readonly kind?: 'file' | 'directory'
  readonly sha256?: string
  readonly byte_size?: number
}

export interface AuroraBrowserModelPackVariant {
  readonly variant_id: string
  readonly file_ids: readonly string[]
  readonly target: string
  readonly os: string
  readonly arch: string
  readonly model_bindings?: readonly AuroraVoiceWebModelDescriptor[]
}

export interface AuroraBrowserModelPackManifest {
  readonly schema_version: 1
  readonly pack_id: string
  readonly pack_version: string
  readonly display_name: string
  readonly tasks: readonly string[]
  readonly files: readonly AuroraBrowserModelPackFile[]
  readonly variants: readonly AuroraBrowserModelPackVariant[]
  readonly signature?: AuroraBrowserModelPackSignature | null
  readonly revocation?: { readonly revoked?: boolean } | null
  readonly [key: string]: unknown
}

export interface AuroraBrowserModelPackScope {
  readonly task: string
  readonly slotId?: string
}

export type AuroraBrowserModelPackVerificationMode = 'signature' | 'release-hash' | 'embedded-catalog'

export interface AuroraBrowserModelPackReleaseTrustKey {
  readonly keyId: string
  readonly publicKeyBase64: string
}

export interface AuroraBrowserModelPackTrustOptions {
  readonly allowNonProductionTestSignature?: boolean
  readonly allowEmbeddedBrowserVoiceCatalogTrust?: boolean
  readonly trustedReleaseKeys?: readonly AuroraBrowserModelPackReleaseTrustKey[]
  readonly expectedReleaseManifestSha256?: string
}

export interface AuroraBrowserModelPackSourceOptions {
  readonly allowNonProductionLoopbackHttpAssetUrls?: boolean
  readonly trustedAssetBaseUrl?: string
  readonly trustedAssetOrigins?: readonly string[]
}

export interface AuroraBrowserModelPackInstallOptions extends AuroraBrowserModelPackTrustOptions, AuroraBrowserModelPackSourceOptions {
  readonly host: AuroraWebModelStoreHost
  readonly manifest: AuroraBrowserModelPackManifest
  readonly scope?: AuroraBrowserModelPackScope
  /**
   * Trusted transport override for tests or a caller-owned downloader.
   *
   * The installer prevalidates and normalizes the asset URL before invoking this
   * callback. Custom implementations must fetch exactly that URL, preserve the
   * supplied abort signal, and fail closed instead of following redirects.
   */
  readonly fetchBytes?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>
  readonly extractTarBzip2Archive?: AuroraBrowserTarBzip2Extractor
  readonly archiveLimits?: AuroraBrowserArchiveInstallLimits
  /** Cancels verification, download, and staging before atomic promotion begins. */
  readonly signal?: AbortSignal
  readonly nowMs?: () => number
}

export interface AuroraBrowserArchiveInstallLimits {
  readonly maxEntries?: number
  readonly maxFileBytes?: number
  readonly maxTotalBytes?: number
}

export interface AuroraBrowserExtractedArchiveFile {
  readonly path: string
  readonly byteSize: number
  readonly sha256: string
  readonly bytes: Uint8Array
}

export type AuroraBrowserTarBzip2Extractor = (
  archiveBytes: Uint8Array,
  request: {
    readonly expectedRoot: string
    readonly expectedPaths: readonly string[]
    readonly expectedDirectories: readonly string[]
    readonly allowUnexpectedFiles: boolean
    readonly maxEntries: number
    readonly maxFileBytes: number
    readonly maxTotalBytes: number
  }
) => Promise<readonly AuroraBrowserExtractedArchiveFile[]>

export interface AuroraBrowserModelPackIdentity {
  readonly packId: string
  readonly packVersion: string
  readonly variantId: string
  readonly scope: Required<AuroraBrowserModelPackScope>
}

export interface AuroraBrowserModelPackFileReceipt {
  readonly fileId: string
  readonly storageKey: string
  readonly sha256: string
  readonly byteLength: number
}

export interface AuroraBrowserModelPackInstallReceipt {
  readonly identity: AuroraBrowserModelPackIdentity
  readonly files: readonly AuroraBrowserModelPackFileReceipt[]
  readonly manifestSha256: string
  readonly verificationMode: AuroraBrowserModelPackVerificationMode
  readonly verificationKeyId: string
}

export interface AuroraBrowserImmutableModelFile {
  readonly fileId: string
  readonly virtualPath: string
  readonly storageKey: string
  readonly sha256: string
  readonly byteLength: number
  readAll(): Promise<Uint8Array>
  readChunk(offset: number, maxBytes: number): Promise<Uint8Array>
}

export interface AuroraBrowserActiveModelPack {
  readonly identity: AuroraBrowserModelPackIdentity
  readonly files: readonly AuroraBrowserImmutableModelFile[]
  readonly models: readonly AuroraVoiceWebModelDescriptor[]
}

interface ActiveRecord {
  readonly identity: {
    readonly scope: { readonly task: string; readonly slot_id: string }
    readonly pack_id: string
    readonly pack_version: string
    readonly variant_id: string
  }
  readonly manifest_json: string
  readonly files: readonly StoredFileRecord[]
  readonly verification_receipt: AuroraBrowserManifestVerificationReceipt
}

interface StoredFileRecord {
  readonly storage_key: string
  readonly pack_id: string
  readonly pack_version: string
  readonly variant_id: string
  readonly file_id: string
  readonly virtual_path: string
  readonly sha256: string
  readonly byte_size: number
}

interface InstallRecordPlan {
  readonly fileId: string
  readonly virtualPath?: string
  readonly sha256: string
  readonly byteLength: number
  readonly bytes: Uint8Array
}

interface ExpectedInstalledRecord {
  readonly fileId: string
  readonly virtualPath?: string
  readonly sha256?: string
  readonly byteLength?: number
}

export interface AuroraBrowserManifestFileReceipt {
  readonly file_id: string
  readonly sha256: string
  readonly byte_size: number
}

export interface AuroraBrowserManifestVerificationReceipt {
  readonly pack_id: string
  readonly pack_version: string
  readonly manifest_sha256: string
  readonly verification_mode: AuroraBrowserModelPackVerificationMode
  readonly key_id: string
  readonly variant_id: string
  readonly target: string
  readonly os: string
  readonly arch: string
  readonly file_ids: readonly string[]
  readonly files: readonly AuroraBrowserManifestFileReceipt[]
}

export class AuroraBrowserModelPackError extends Error {
  constructor(
    readonly code: string,
    readonly cleanupFailed = false,
    cause?: unknown
  ) {
    super(
      `aurora_voice_web_model_pack:${code}`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'AuroraBrowserModelPackError'
  }
}

interface ResolvedManifestTrust {
  readonly publicKeyBase64: string
  readonly verificationMode: AuroraBrowserModelPackVerificationMode
  readonly expectedManifestSha256?: string
}

const DEFAULT_ARCHIVE_LIMITS: Required<AuroraBrowserArchiveInstallLimits> = Object.freeze({
  maxEntries: 2048,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
})
const EMBEDDED_BROWSER_CATALOG_KEY_ID = 'aurora-browser-voice-catalog'
const CANONICAL_REDIRECT_FINAL_ORIGINS = new Set(['https://release-assets.githubusercontent.com'])

export async function verifyBrowserModelPackManifest(
  manifest: AuroraBrowserModelPackManifest,
  options: AuroraBrowserModelPackTrustOptions = {}
): Promise<AuroraBrowserManifestVerificationReceipt> {
  validateManifestShape(manifest)
  if (manifest.revocation?.revoked === true) throw modelPackError('revoked_pack')
  const signature = manifest.signature
  const canonical = canonicalJson(stripSignature(manifest))
  const canonicalBytes = encodeUtf8(canonical)
  const manifestSha256 = await sha256Hex(canonicalBytes)
  if (!signature) {
    if (options.allowEmbeddedBrowserVoiceCatalogTrust === true) {
      await verifyEmbeddedBrowserCatalogManifest(manifest, manifestSha256)
      const variant = selectWebWasmVariant(manifest)
      return {
        pack_id: manifest.pack_id,
        pack_version: manifest.pack_version,
        manifest_sha256: manifestSha256,
        verification_mode: 'embedded-catalog',
        key_id: EMBEDDED_BROWSER_CATALOG_KEY_ID,
        variant_id: variant.variant_id,
        target: variant.target,
        os: variant.os,
        arch: variant.arch,
        file_ids: variant.file_ids,
        files: manifestReceiptFiles(manifest, variant)
      }
    }
    throw modelPackError('unsigned')
  }
  if (signature.algorithm !== AURORA_MODEL_PACK_SIGNATURE_ALGORITHM) throw modelPackError('algorithm')
  const trust = resolveManifestTrust(signature.key_id, options)
  if (trust === null) throw modelPackError('untrusted_key')
  if (trust.expectedManifestSha256 !== undefined && trust.expectedManifestSha256 !== manifestSha256) {
    throw modelPackError('release_hash')
  }
  const verified = await verifyEd25519(trust.publicKeyBase64, signature.value, canonicalBytes)
  if (!verified) throw modelPackError('signature')

  const variant = selectWebWasmVariant(manifest)
  return {
    pack_id: manifest.pack_id,
    pack_version: manifest.pack_version,
    manifest_sha256: manifestSha256,
    verification_mode: trust.verificationMode,
    key_id: signature.key_id,
    variant_id: variant.variant_id,
    target: variant.target,
    os: variant.os,
    arch: variant.arch,
    file_ids: variant.file_ids,
    files: manifestReceiptFiles(manifest, variant)
  }
}

function manifestReceiptFiles(
  manifest: AuroraBrowserModelPackManifest,
  variant: AuroraBrowserModelPackVariant
): readonly AuroraBrowserManifestFileReceipt[] {
  return variant.file_ids.map((fileId) => {
    const file = manifest.files.find((candidate) => candidate.file_id === fileId)
    if (!file) throw modelPackError('selection')
    return { file_id: file.file_id, sha256: file.sha256, byte_size: file.byte_size }
  })
}

async function verifyEmbeddedBrowserCatalogManifest(
  manifest: AuroraBrowserModelPackManifest,
  manifestSha256: string
): Promise<void> {
  const { findAuroraBrowserVoiceCatalogEntry } = await import('./browser-voice-catalog.js')
  const catalogEntry = findAuroraBrowserVoiceCatalogEntry(manifest.pack_id)
  if (catalogEntry === null || catalogEntry.installableByBrowserArchive !== true) throw modelPackError('unsigned')
  const expected = catalogEntry.toModelPackManifest()
  const expectedSha256 = await sha256Hex(encodeUtf8(canonicalJson(stripSignature(expected))))
  if (manifestSha256 !== expectedSha256) throw modelPackError('release_hash')
}

export async function installVerifiedBrowserModelPack({
  host,
  manifest,
  scope,
  fetchBytes,
  allowNonProductionTestSignature = false,
  allowEmbeddedBrowserVoiceCatalogTrust = false,
  allowNonProductionLoopbackHttpAssetUrls = false,
  trustedReleaseKeys,
  expectedReleaseManifestSha256,
  trustedAssetBaseUrl,
  trustedAssetOrigins,
  signal,
  nowMs = Date.now,
  extractTarBzip2Archive = defaultExtractTarBzip2Archive,
  archiveLimits
}: AuroraBrowserModelPackInstallOptions): Promise<AuroraBrowserModelPackInstallReceipt> {
  throwIfAborted(signal)
  const trustOptions: AuroraBrowserModelPackTrustOptions = { allowNonProductionTestSignature, allowEmbeddedBrowserVoiceCatalogTrust }
  if (trustedReleaseKeys !== undefined) {
    Object.assign(trustOptions, { trustedReleaseKeys })
  }
  if (expectedReleaseManifestSha256 !== undefined) {
    Object.assign(trustOptions, { expectedReleaseManifestSha256 })
  }
  const verificationReceipt = await verifyBrowserModelPackManifest(manifest, trustOptions)
  throwIfAborted(signal)
  const variant = selectReceiptVariant(manifest, verificationReceipt)
  const normalizedScope = normalizeScope(scope, manifest.tasks[0])
  validateVariantTaskScope(manifest, variant, normalizedScope.task)
  const assetSourceOptions: AuroraBrowserModelPackSourceOptions = { allowNonProductionLoopbackHttpAssetUrls }
  if (trustedAssetBaseUrl !== undefined) Object.assign(assetSourceOptions, { trustedAssetBaseUrl })
  if (trustedAssetOrigins !== undefined) Object.assign(assetSourceOptions, { trustedAssetOrigins })
  const assetPolicy = buildAssetSourcePolicy(assetSourceOptions)
  const downloadBytes = fetchBytes === undefined
    ? (url: string, abortSignal?: AbortSignal) => defaultFetchBytes(url, assetPolicy, abortSignal)
    : fetchBytes
  const records: StoredFileRecord[] = []
  const stagedKeys = new Set<string>()
  const preexistingPromotedKeys = new Set<string>()
  try {
    const recordPlans: InstallRecordPlan[] = []
    for (const fileId of verificationReceipt.file_ids) {
      throwIfAborted(signal)
      const file = manifest.files.find((candidate) => candidate.file_id === fileId)
      const verifiedFile = verificationReceipt.files.find((candidate) => candidate.file_id === fileId)
      if (!file || !verifiedFile || verifiedFile.sha256 !== file.sha256 || verifiedFile.byte_size !== file.byte_size) {
        throw modelPackError('receipt')
      }
      const assetUrl = resolveTrustedAssetUrl(file.url, assetPolicy)
      let bytes: Uint8Array
      try {
        bytes = await downloadBytes(assetUrl, signal)
      } catch (error) {
        if (signal?.aborted === true) throw modelPackError('aborted', error)
        throw error
      }
      throwIfAborted(signal)
      if (bytes.byteLength !== file.byte_size) throw modelPackError('size')
      const digest = await sha256Hex(bytes)
      throwIfAborted(signal)
      if (digest !== file.sha256) throw modelPackError('hash')
      recordPlans.push(...await createInstallRecordPlans(
        file,
        bytes,
        extractTarBzip2Archive,
        archiveLimits,
        verificationReceipt.verification_mode === 'embedded-catalog',
        signal
      ))
    }
    for (const [recordIndex, plan] of recordPlans.entries()) {
      throwIfAborted(signal)
      const storageKey = fileStorageKey(manifest.pack_id, verificationReceipt.manifest_sha256, recordIndex)
      stagedKeys.add(storageKey)
      if (await host.promotedStat(storageKey) !== null) preexistingPromotedKeys.add(storageKey)
      throwIfAborted(signal)
      await host.clearStaging(storageKey)
      throwIfAborted(signal)
      await host.appendStaging(storageKey, 0, plan.bytes)
      throwIfAborted(signal)
      records.push({
        storage_key: storageKey,
        pack_id: manifest.pack_id,
        pack_version: manifest.pack_version,
        variant_id: variant.variant_id,
        file_id: plan.fileId,
        virtual_path: plan.virtualPath ?? virtualPathFromVariant(variant, plan.fileId),
        sha256: plan.sha256,
        byte_size: plan.byteLength
      })
    }
    throwIfAborted(signal)
  } catch (error) {
    const cleanupErrors = await clearStagedFiles(host, stagedKeys)
    throwInstallFailure(error, signal, cleanupErrors)
  }

  const installedAt = Math.max(0, Math.trunc(nowMs()))
  const active: ActiveRecord = {
    identity: {
      scope: { task: normalizedScope.task, slot_id: normalizedScope.slotId },
      pack_id: manifest.pack_id,
      pack_version: manifest.pack_version,
      variant_id: variant.variant_id
    },
    manifest_json: JSON.stringify(manifest),
    files: records,
    verification_receipt: verificationReceipt
  }
  const jsonWrites = records.map((record) => ({
    key: fileKey(record.storage_key),
    value: JSON.stringify({
      ...record,
      state: 'ready',
      stored_at: installedAt
    })
  }))
  jsonWrites.push(
    {
      key: expectedSelectionKey(manifest.pack_id, manifest.pack_version, variant.variant_id),
      value: JSON.stringify({ files: records })
    },
    {
      key: lifecycleKey(manifest.pack_id, manifest.pack_version, variant.variant_id),
      value: JSON.stringify({
        pack_id: manifest.pack_id,
        pack_version: manifest.pack_version,
        variant_id: variant.variant_id,
        state: 'active',
        revision: 1,
        updated_at: installedAt,
        error_code: null
      })
    },
    {
      key: lifecycleBackingKey(manifest.pack_id, manifest.pack_version, variant.variant_id),
      value: JSON.stringify({ files: records })
    },
    { key: activeKey(normalizedScope), value: JSON.stringify(active) }
  )

  let jsonSnapshots: readonly JsonSnapshot[]
  try {
    jsonSnapshots = await snapshotJson(host, jsonWrites.map(({ key }) => key))
    throwIfAborted(signal)
  } catch (error) {
    const cleanupErrors = await clearStagedFiles(host, stagedKeys)
    throwInstallFailure(error, signal, cleanupErrors)
  }

  const newlyPromotedKeys = new Set<string>()
  try {
    for (const record of records) {
      if (!preexistingPromotedKeys.has(record.storage_key)) newlyPromotedKeys.add(record.storage_key)
      await host.promoteStagingAtomic(record.storage_key)
      stagedKeys.delete(record.storage_key)
    }
    for (const write of jsonWrites) await host.writeJson(write.key, write.value)
  } catch (error) {
    const restored = await restoreJson(host, jsonSnapshots)
    const cleanupErrors = [
      ...(await clearStagedFiles(host, stagedKeys)),
      ...restored.errors
    ]
    // Keep promoted blobs if the active-pointer rollback failed: it may still reference this generation.
    if (!restored.failedKeys.has(activeKey(normalizedScope))) {
      cleanupErrors.push(...await deletePromotedFiles(host, newlyPromotedKeys))
    }
    throwInstallFailure(error, signal, cleanupErrors)
  }
  return {
    identity: {
      packId: manifest.pack_id,
      packVersion: manifest.pack_version,
      variantId: variant.variant_id,
      scope: normalizedScope
    },
    files: records.map((record) => ({
      fileId: record.file_id,
      virtualPath: record.virtual_path,
      storageKey: record.storage_key,
      sha256: record.sha256,
      byteLength: record.byte_size
    })),
    manifestSha256: verificationReceipt.manifest_sha256,
    verificationMode: verificationReceipt.verification_mode,
    verificationKeyId: verificationReceipt.key_id
  }
}

export async function openActiveBrowserModelPack(
  host: AuroraWebModelStoreHost,
  scope: AuroraBrowserModelPackScope = { task: 'stt' },
  options: AuroraBrowserModelPackTrustOptions = {}
): Promise<AuroraBrowserActiveModelPack | null> {
  const normalizedScope = normalizeScope(scope, scope.task)
  const raw = await host.readJson(activeKey(normalizedScope))
  if (raw === null) return null
  const active = parseActiveRecord(raw)
  if (
    active.identity.scope.task !== normalizedScope.task ||
    active.identity.scope.slot_id !== normalizedScope.slotId
  ) {
    return null
  }
  const manifest = parseManifestJson(active.manifest_json)
  const freshReceipt = await verifyBrowserModelPackManifest(manifest, options)
  const variant = selectReceiptVariant(manifest, freshReceipt)
  validateVariantTaskScope(manifest, variant, normalizedScope.task)
  validateActiveReceipt(active, manifest, variant, freshReceipt)
  const files: AuroraBrowserImmutableModelFile[] = []
  for (const record of active.files) {
    const stat = await host.promotedStat(record.storage_key)
    if (!stat || stat.byteLength !== record.byte_size) throw modelPackError('missing_file')
    const digest = await hashPromotedFile(host, record.storage_key, record.byte_size)
    if (digest !== record.sha256) throw modelPackError('corrupt')
    files.push({
      fileId: record.file_id,
      virtualPath: record.virtual_path,
      storageKey: record.storage_key,
      sha256: record.sha256,
      byteLength: record.byte_size,
      readAll: async () => readPromotedExact(host, record.storage_key, 0, record.byte_size),
      readChunk: async (offset, maxBytes) => readPromotedExact(host, record.storage_key, offset, maxBytes)
    })
  }
  return {
    identity: {
      packId: active.identity.pack_id,
      packVersion: active.identity.pack_version,
      variantId: active.identity.variant_id,
      scope: normalizedScope
    },
    files,
    models: variant.model_bindings ?? []
  }
}

function resolveManifestTrust(keyId: string, options: AuroraBrowserModelPackTrustOptions): ResolvedManifestTrust | null {
  if (!safeId(keyId)) throw modelPackError('invalid_id')
  if (options.allowNonProductionTestSignature === true && keyId === AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID) {
    return {
      publicKeyBase64: NON_PRODUCTION_WEB_WASM_PUBLIC_KEY_BASE64,
      verificationMode: 'signature'
    }
  }

  const releaseKey = resolveReleaseTrustKey(keyId, options.trustedReleaseKeys ?? [])
  if (releaseKey === null) return null
  if (!isSha256(options.expectedReleaseManifestSha256)) throw modelPackError('release_hash')
  return {
    publicKeyBase64: releaseKey.publicKeyBase64,
    verificationMode: 'release-hash',
    expectedManifestSha256: options.expectedReleaseManifestSha256
  }
}

function resolveReleaseTrustKey(
  keyId: string,
  trustedReleaseKeys: readonly AuroraBrowserModelPackReleaseTrustKey[]
): AuroraBrowserModelPackReleaseTrustKey | null {
  let matched: AuroraBrowserModelPackReleaseTrustKey | null = null
  const seen = new Set<string>()
  for (const key of trustedReleaseKeys) {
    if (!safeId(key.keyId)) throw modelPackError('invalid_id')
    if (seen.has(key.keyId)) throw modelPackError('untrusted_key')
    seen.add(key.keyId)
    if (key.keyId === keyId) matched = key
  }
  return matched
}

function validateManifestShape(manifest: AuroraBrowserModelPackManifest): void {
  if (manifest.schema_version !== 1) throw modelPackError('schema')
  for (const value of [manifest.pack_id, manifest.pack_version]) {
    if (!safeId(value)) throw modelPackError('invalid_id')
  }
  if (typeof manifest.display_name !== 'string' || manifest.display_name.trim() === '') {
    throw modelPackError('invalid_id')
  }
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) throw modelPackError('empty')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw modelPackError('empty')
  if (!Array.isArray(manifest.variants) || manifest.variants.length === 0) throw modelPackError('empty')
  if (!hasUniqueStrings(manifest.tasks)) throw modelPackError('duplicate_id')
  for (const task of manifest.tasks) {
    if (!safeId(task)) throw modelPackError('invalid_id')
  }
  if (!hasUniqueStrings(manifest.files.map((file) => file.file_id))) throw modelPackError('duplicate_id')
  for (const file of manifest.files) {
    if (!safeId(file.file_id) || !safeId(file.asset_id) || !safeId(file.task)) throw modelPackError('invalid_id')
    validateAssetUrlText(file.url)
    if (!isSha256(file.sha256) || !Number.isSafeInteger(file.byte_size) || file.byte_size <= 0) {
      throw modelPackError('size')
    }
    if (!Number.isSafeInteger(file.installed_size) || file.installed_size <= 0) throw modelPackError('size')
    if (file.compression === 'none') {
      if (file.installed_size < file.byte_size || file.archive_root !== undefined || file.archive_entries !== undefined) {
        throw modelPackError('compression')
      }
    } else if (file.compression === 'tar_bzip2') {
      validateArchiveFileShape(file, manifest.tasks)
    } else {
      throw modelPackError('compression')
    }
    if (!manifest.tasks.includes(file.task)) throw modelPackError('variant_file')
  }
  if (!hasUniqueStrings(manifest.variants.map((variant) => variant.variant_id))) throw modelPackError('duplicate_id')
  for (const variant of manifest.variants) {
    if (!safeId(variant.variant_id) || !safeId(variant.target) || !safeId(variant.os) || !safeId(variant.arch)) {
      throw modelPackError('invalid_id')
    }
    if (!hasUniqueStrings(variant.file_ids)) throw modelPackError('duplicate_id')
    if (variant.model_bindings !== undefined && !validVariantModelBindings(variant.model_bindings, manifest.files, variant.file_ids)) {
      throw modelPackError('model_metadata')
    }
  }
}

function validateArchiveFileShape(file: AuroraBrowserModelPackFile, tasks: readonly string[]): void {
  if (!safeArchivePath(file.archive_root) || !Array.isArray(file.archive_entries) || file.archive_entries.length === 0) {
    throw modelPackError('compression')
  }
  if (!hasUniqueStrings(file.archive_entries.map((entry) => entry.file_id))) throw modelPackError('duplicate_id')
  if (!hasUniqueStrings(file.archive_entries.map((entry) => entry.path))) throw modelPackError('duplicate_id')
  if (!hasUniqueStrings(file.archive_entries.map((entry) => entry.path.toLocaleLowerCase('en-US')))) throw modelPackError('duplicate_id')
  let installedTotal = 0
  for (const entry of file.archive_entries) {
    if (!safeId(entry.file_id) || !safeId(entry.task) || !tasks.includes(entry.task)) throw modelPackError('invalid_id')
    if (!safeArchivePath(entry.path) || !archivePathStartsWith(entry.path, file.archive_root)) throw modelPackError('compression')
    if ((entry.kind ?? 'file') !== 'file' && entry.kind !== 'directory') throw modelPackError('compression')
    if (entry.kind === 'directory' && (entry.sha256 !== undefined || entry.byte_size !== undefined)) throw modelPackError('compression')
    if (entry.kind !== 'directory' && entry.sha256 !== undefined && !isSha256(entry.sha256)) throw modelPackError('hash')
    if (entry.kind !== 'directory' && entry.byte_size !== undefined && (!Number.isSafeInteger(entry.byte_size) || entry.byte_size <= 0)) {
      throw modelPackError('size')
    }
    if (entry.kind !== 'directory' && entry.byte_size !== undefined) installedTotal = checkedAdd(installedTotal, entry.byte_size)
  }
  if (installedTotal > file.installed_size) throw modelPackError('size')
}

function validVariantModelBindings(
  bindings: readonly AuroraVoiceWebModelDescriptor[],
  manifestFiles: readonly AuroraBrowserModelPackFile[],
  variantFileIds: readonly string[]
): boolean {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 64) return false
  const ids = new Set(expandedVariantFileIds(manifestFiles, variantFileIds))
  return bindings.every((model) => (
    (model.task === 'vad' || model.task === 'kws' || model.task === 'stt' || model.task === 'tts') &&
    (model.family === 'silero-vad' || model.family === 'moonshine' || model.family === 'whisper' || model.family === 'sense-voice' || model.family === 'sherpa-kws-transducer' || model.family === 'piper' || model.family === 'pockettts') &&
    (model.kind === 'vad' || model.kind === 'offline-asr' || model.kind === 'keyword-spotter' || model.kind === 'offline-tts') &&
    Array.isArray(model.files) &&
    model.files.length > 0 &&
    model.files.every((file: AuroraVoiceWebModelDescriptor['files'][number]) => (
      ['model', 'encoder', 'decoder', 'mergedDecoder', 'tokens', 'joiner', 'keywords', 'bpeVocab', 'lexicon', 'dataDir', 'lmFlow', 'lmMain', 'textConditioner', 'vocabJson', 'tokenScoresJson', 'referenceAudio'].includes(file.role) &&
      ids.has(file.fileId) &&
      safeId(file.fileId) &&
      typeof file.virtualPath === 'string' &&
      file.virtualPath.startsWith('/')
    ))
  ))
}

function expandedVariantFileIds(
  manifestFiles: readonly AuroraBrowserModelPackFile[],
  variantFileIds: readonly string[]
): readonly string[] {
  const ids: string[] = []
  for (const fileId of variantFileIds) {
    const file = manifestFiles.find((candidate) => candidate.file_id === fileId)
    if (!file) continue
    if (file.compression === 'tar_bzip2') {
      ids.push(...(file.archive_entries ?? []).map((entry) => entry.file_id))
    } else {
      ids.push(file.file_id)
    }
  }
  return ids
}

function virtualPathFromVariant(variant: AuroraBrowserModelPackVariant, fileId: string): string {
  const refs = (variant.model_bindings ?? []).flatMap((model) => model.files).filter((file) => file.fileId === fileId)
  if (refs.length === 0) return `/${fileId}`
  if (refs.length !== 1) throw modelPackError('model_metadata')
  return refs[0]!.virtualPath
}

function selectWebWasmVariant(manifest: AuroraBrowserModelPackManifest): AuroraBrowserModelPackVariant {
  const variant = manifest.variants.find((candidate) =>
    candidate.target === 'web' &&
    candidate.os === 'web' &&
    candidate.arch === 'wasm32'
  )
  if (!variant) throw modelPackError('no_variant')
  if (variant.file_ids.length === 0) throw modelPackError('variant_file')
  for (const fileId of variant.file_ids) {
    if (!manifest.files.some((file) => file.file_id === fileId)) throw modelPackError('variant_file')
  }
  return variant
}

function selectReceiptVariant(
  manifest: AuroraBrowserModelPackManifest,
  receipt: AuroraBrowserManifestVerificationReceipt
): AuroraBrowserModelPackVariant {
  const variant = manifest.variants.find((candidate) => candidate.variant_id === receipt.variant_id)
  if (!variant) throw modelPackError('no_variant')
  if (variant.target !== 'web' || variant.os !== 'web' || variant.arch !== 'wasm32') throw modelPackError('target')
  if (!sameStringMultiset(variant.file_ids, receipt.file_ids)) throw modelPackError('target')
  return variant
}

function validateVariantTaskScope(
  manifest: AuroraBrowserModelPackManifest,
  variant: AuroraBrowserModelPackVariant,
  task: string
): void {
  const hasTaskFile = variant.file_ids.some((fileId) => {
    const file = manifest.files.find((candidate) => candidate.file_id === fileId)
    return file?.task === task || file?.archive_entries?.some((entry) => entry.task === task) === true
  })
  if (!hasTaskFile) throw modelPackError('scope')
}

async function defaultFetchBytes(
  url: string,
  assetPolicy?: AssetSourcePolicyOptions,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetch(url, {
    cache: 'no-store',
    redirect: 'follow',
    ...(signal === undefined ? {} : { signal })
  })
  if (!response.ok) throw modelPackError('network')
  validateFinalResponseUrl(url, response.url, assetPolicy)
  return new Uint8Array(await response.arrayBuffer())
}

async function createInstallRecordPlans(
  file: AuroraBrowserModelPackFile,
  bytes: Uint8Array,
  extractTarBzip2Archive: AuroraBrowserTarBzip2Extractor,
  archiveLimits: AuroraBrowserArchiveInstallLimits | undefined,
  allowUnexpectedArchiveFiles: boolean,
  signal: AbortSignal | undefined
): Promise<readonly InstallRecordPlan[]> {
  if (file.compression === 'none') {
    return [{ fileId: file.file_id, sha256: file.sha256, byteLength: bytes.byteLength, bytes }]
  }
  if (file.compression !== 'tar_bzip2') throw modelPackError('compression')
  const entries = file.archive_entries ?? []
  const root = file.archive_root
  if (root === undefined || entries.length === 0) throw modelPackError('compression')
  const fileEntries = entries.filter((entry) => (entry.kind ?? 'file') === 'file')
  const directoryEntries = entries.filter((entry) => entry.kind === 'directory')
  const limits = normalizeArchiveLimits(archiveLimits)
  const extracted = await extractTarBzip2Archive(bytes, {
    expectedRoot: root,
    expectedPaths: fileEntries.map((entry) => entry.path),
    expectedDirectories: directoryEntries.map((entry) => entry.path),
    allowUnexpectedFiles: allowUnexpectedArchiveFiles,
    maxEntries: limits.maxEntries,
    maxFileBytes: limits.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes
  })
  throwIfAborted(signal)
  const byPath = new Map<string, AuroraBrowserExtractedArchiveFile>()
  const byCasePath = new Set<string>()
  for (const extractedFile of extracted) {
    const casePath = extractedFile.path.toLocaleLowerCase('en-US')
    if (!safeArchivePath(extractedFile.path) || byPath.has(extractedFile.path) || byCasePath.has(casePath)) throw modelPackError('archive_invalid')
    if (!fileEntries.some((entry) => entry.path === extractedFile.path) && !directoryEntries.some((entry) => archivePathStartsWith(extractedFile.path, entry.path) && extractedFile.path !== entry.path)) {
      throw modelPackError('archive_unexpected')
    }
    byPath.set(extractedFile.path, extractedFile)
    byCasePath.add(casePath)
  }
  let total = 0
  const plans: InstallRecordPlan[] = []
  for (const entry of fileEntries) {
    const extractedFile = byPath.get(entry.path)
    if (!extractedFile) throw modelPackError('archive_missing')
    if (entry.byte_size !== undefined && (extractedFile.byteSize !== entry.byte_size || extractedFile.bytes.byteLength !== entry.byte_size)) throw modelPackError('size')
    if (entry.sha256 !== undefined && extractedFile.sha256 !== entry.sha256) throw modelPackError('hash')
    total = checkedAdd(total, extractedFile.bytes.byteLength)
    if (total > file.installed_size || total > limits.maxTotalBytes) throw modelPackError('archive_bounds')
    plans.push({
      fileId: entry.file_id,
      virtualPath: `/${entry.path}`,
      sha256: extractedFile.sha256,
      byteLength: extractedFile.byteSize,
      bytes: extractedFile.bytes
    })
  }
  for (const entry of directoryEntries) {
    const children = extracted.filter((file) => archivePathStartsWith(file.path, entry.path) && file.path !== entry.path)
    if (children.length === 0) throw modelPackError('archive_missing')
    for (const child of children) {
      total = checkedAdd(total, child.bytes.byteLength)
      if (total > file.installed_size || total > limits.maxTotalBytes) throw modelPackError('archive_bounds')
      plans.push({
        fileId: directoryChildFileId(entry.file_id, child.path),
        virtualPath: `/${child.path}`,
        sha256: child.sha256,
        byteLength: child.byteSize,
        bytes: child.bytes
      })
    }
  }
  if (plans.length === 0 || !hasUniqueStrings(plans.map((plan) => plan.fileId)) || !hasUniqueStrings(plans.map((plan) => plan.virtualPath).filter((path): path is string => path !== undefined))) {
    throw modelPackError('archive_duplicate')
  }
  return plans
}

async function defaultExtractTarBzip2Archive(
  archiveBytes: Uint8Array,
  request: Parameters<AuroraBrowserTarBzip2Extractor>[1]
): Promise<readonly AuroraBrowserExtractedArchiveFile[]> {
  const bindings = await loadArchiveWasmBindings()
  let receipt: unknown
  try {
    receipt = bindings.aurora_extract_tar_bzip2_archive(archiveBytes, {
      expected_root: request.expectedRoot,
      expected_paths: request.expectedPaths,
      expected_directories: request.expectedDirectories,
      allow_unexpected_files: request.allowUnexpectedFiles,
      max_entries: request.maxEntries,
      max_file_bytes: request.maxFileBytes,
      max_total_bytes: request.maxTotalBytes
    })
  } catch (error) {
    throw modelPackError(safeArchiveErrorCode(error), error)
  }
  if (!isObjectRecord(receipt) || !Array.isArray(receipt.files)) throw modelPackError('archive_invalid')
  return receipt.files.map((file) => {
    if (!isObjectRecord(file)) throw modelPackError('archive_invalid')
    const path = file.path
    const byteSize = file.byte_size
    const sha256 = file.sha256
    if (typeof path !== 'string' || typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || typeof sha256 !== 'string') {
      throw modelPackError('archive_invalid')
    }
    const bytes = file.bytes instanceof Uint8Array
      ? file.bytes
      : Array.isArray(file.bytes)
        ? Uint8Array.from(file.bytes)
        : null
    if (bytes === null) throw modelPackError('archive_invalid')
    return {
      path,
      byteSize,
      sha256,
      bytes
    }
  })
}

function safeArchiveErrorCode(error: unknown): string {
  const code = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  return /^archive_[a-z_]{1,40}$/.test(code) ? code : 'archive_invalid'
}

function directoryChildFileId(directoryFileId: string, path: string): string {
  const basename = path.split('/').at(-1) ?? 'file'
  const safeBasename = basename.replaceAll(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 48)
  const fileId = `${directoryFileId}:${hashPath32(path)}:${safeBasename}`
  if (!safeId(fileId)) throw modelPackError('invalid_id')
  return fileId
}

function hashPath32(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

async function loadArchiveWasmBindings(): Promise<typeof AuroraVoiceWasmModule> {
  const bindings = await import('./wasm/aurora_voice_wasm.js')
  await bindings.default()
  return bindings
}

function normalizeArchiveLimits(limits: AuroraBrowserArchiveInstallLimits | undefined): Required<AuroraBrowserArchiveInstallLimits> {
  const normalized = { ...DEFAULT_ARCHIVE_LIMITS, ...(limits ?? {}) }
  for (const value of [normalized.maxEntries, normalized.maxFileBytes, normalized.maxTotalBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw modelPackError('archive_bounds')
  }
  return normalized
}

function resolveTrustedAssetUrl(
  assetUrl: string,
  options: AssetSourcePolicyOptions
): string {
  const { resolved, baseOrigin } = parseAssetUrl(assetUrl, options.trustedAssetBaseUrl)
  if (
    resolved.protocol === 'https:' &&
    isTrustedHttpsAssetOrigin(resolved, options.trustedAssetOrigins, baseOrigin)
  ) {
    return resolved.href
  }
  if (
    resolved.protocol === 'http:' &&
    options.allowNonProductionLoopbackHttpAssetUrls === true &&
    isLoopbackHostname(resolved.hostname)
  ) {
    return resolved.href
  }
  throw modelPackError('asset_url')
}

interface AssetSourcePolicyOptions extends Required<Pick<AuroraBrowserModelPackSourceOptions, 'allowNonProductionLoopbackHttpAssetUrls'>> {
  readonly trustedAssetBaseUrl?: string
  readonly trustedAssetOrigins?: readonly string[]
}

function buildAssetSourcePolicy(options: AuroraBrowserModelPackSourceOptions): AssetSourcePolicyOptions {
  const policy: AssetSourcePolicyOptions = {
    allowNonProductionLoopbackHttpAssetUrls: options.allowNonProductionLoopbackHttpAssetUrls === true
  }
  if (options.trustedAssetBaseUrl !== undefined) Object.assign(policy, { trustedAssetBaseUrl: options.trustedAssetBaseUrl })
  if (options.trustedAssetOrigins !== undefined) Object.assign(policy, { trustedAssetOrigins: options.trustedAssetOrigins })
  return policy
}

function parseAssetUrl(
  assetUrl: string,
  trustedAssetBaseUrl: string | undefined
): { readonly resolved: URL; readonly baseOrigin?: string } {
  validateAssetUrlText(assetUrl)
  if (assetUrl.startsWith('//')) throw modelPackError('asset_url')
  try {
    if (trustedAssetBaseUrl === undefined) return { resolved: new URL(assetUrl) }
    const baseUrl = new URL(trustedAssetBaseUrl)
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopbackHostname(baseUrl.hostname))) {
      throw modelPackError('asset_url')
    }
    return { resolved: new URL(assetUrl, baseUrl), baseOrigin: baseUrl.origin }
  } catch (error) {
    if (error instanceof AuroraBrowserModelPackError) throw error
    throw modelPackError('asset_url', error)
  }
}

function isTrustedHttpsAssetOrigin(
  assetUrl: URL,
  trustedAssetOrigins: readonly string[] | undefined,
  baseOrigin: string | undefined
): boolean {
  if (baseOrigin !== undefined && assetUrl.origin === baseOrigin) return true
  const currentLocation = globalThis.location
  if (currentLocation?.protocol === 'https:' && assetUrl.origin === currentLocation.origin) return true
  return normalizeTrustedAssetOrigins(trustedAssetOrigins).has(assetUrl.origin)
}

function normalizeTrustedAssetOrigins(trustedAssetOrigins: readonly string[] | undefined): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const origin of trustedAssetOrigins ?? []) {
    validateAssetUrlText(origin)
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
        throw modelPackError('asset_url')
      }
      origins.add(parsed.origin)
    } catch (error) {
      if (error instanceof AuroraBrowserModelPackError) throw error
      throw modelPackError('asset_url', error)
    }
  }
  return origins
}

function validateFinalResponseUrl(
  requestedUrl: string,
  responseUrl: string,
  assetPolicy: AssetSourcePolicyOptions | undefined
): void {
  if (responseUrl === '') return
  let requested: URL
  let final: URL
  try {
    requested = new URL(requestedUrl)
    final = new URL(responseUrl)
  } catch {
    throw modelPackError('asset_url')
  }
  if (final.protocol !== 'https:' && !(assetPolicy?.allowNonProductionLoopbackHttpAssetUrls === true && final.protocol === 'http:' && isLoopbackHostname(final.hostname))) {
    throw modelPackError('asset_url')
  }
  if (final.origin === requested.origin) return
  if (requested.origin === 'https://github.com' && CANONICAL_REDIRECT_FINAL_ORIGINS.has(final.origin)) return
  throw modelPackError('asset_url')
}

function validateAssetUrlText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value === '' || /\s/.test(value)) {
    throw modelPackError('asset_url')
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(normalized)) {
    return normalized.split('.').every((part) => Number(part) <= 255)
  }
  return false
}

interface JsonSnapshot {
  readonly key: string
  readonly value: string | null
}

async function snapshotJson(
  host: AuroraWebModelStoreHost,
  keys: readonly string[]
): Promise<readonly JsonSnapshot[]> {
  return Promise.all(keys.map(async (key) => ({ key, value: await host.readJson(key) })))
}

async function restoreJson(
  host: AuroraWebModelStoreHost,
  snapshots: readonly JsonSnapshot[]
): Promise<{ readonly errors: readonly unknown[]; readonly failedKeys: ReadonlySet<string> }> {
  const errors: unknown[] = []
  const failedKeys = new Set<string>()
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.value === null) {
        await host.deleteJson(snapshot.key)
      } else {
        await host.writeJson(snapshot.key, snapshot.value)
      }
    } catch (error) {
      errors.push(error)
      failedKeys.add(snapshot.key)
    }
  }
  return { errors, failedKeys }
}

async function clearStagedFiles(
  host: AuroraWebModelStoreHost,
  storageKeys: ReadonlySet<string>
): Promise<readonly unknown[]> {
  const errors: unknown[] = []
  for (const storageKey of storageKeys) {
    try {
      await host.clearStaging(storageKey)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

async function deletePromotedFiles(
  host: AuroraWebModelStoreHost,
  storageKeys: ReadonlySet<string>
): Promise<readonly unknown[]> {
  const errors: unknown[] = []
  for (const storageKey of storageKeys) {
    try {
      await host.deletePromoted(storageKey)
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw modelPackError('aborted')
}

function throwInstallFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  cleanupErrors: readonly unknown[]
): never {
  const primary = signal?.aborted === true && !(error instanceof AuroraBrowserModelPackError && error.code === 'aborted')
    ? modelPackError('aborted', error)
    : error
  if (cleanupErrors.length === 0) throw primary
  const cleanupFailure = new AggregateError(cleanupErrors, 'aurora_voice_web_model_pack:cleanup')
  if (primary instanceof AuroraBrowserModelPackError) {
    throw modelPackError(primary.code, new AggregateError([primary, cleanupFailure]), true)
  }
  throw new AggregateError([primary, cleanupFailure], 'aurora_voice_web_model_pack:install_and_cleanup')
}

async function hashPromotedFile(host: AuroraWebModelStoreHost, storageKey: string, byteLength: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let offset = 0
  while (offset < byteLength) {
    const chunk = await host.readPromotedChunk(storageKey, offset, Math.min(HASH_CHUNK_BYTES, byteLength - offset))
    if (chunk.offset !== offset || chunk.bytes.byteLength === 0) throw modelPackError('missing_file')
    chunks.push(chunk.bytes)
    offset += chunk.bytes.byteLength
  }
  return sha256Hex(concat(chunks, byteLength))
}

async function readPromotedExact(
  host: AuroraWebModelStoreHost,
  storageKey: string,
  offset: number,
  maxBytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw modelPackError('bounds')
  }
  const chunk = await host.readPromotedChunk(storageKey, offset, maxBytes)
  if (chunk.offset !== offset) throw modelPackError('missing_file')
  return chunk.bytes
}

function parseActiveRecord(raw: string): ActiveRecord {
  try {
    const value = JSON.parse(raw) as unknown
    if (!isObjectRecord(value)) throw new Error('shape')
    const identity = value.identity
    const scope = isObjectRecord(identity) ? identity.scope : null
    const files = value.files
    if (
      !isObjectRecord(identity) ||
      !isObjectRecord(scope) ||
      !safeId(scope.task) ||
      !safeId(scope.slot_id) ||
      !safeId(identity.pack_id) ||
      !safeId(identity.pack_version) ||
      !safeId(identity.variant_id) ||
      typeof value.manifest_json !== 'string' ||
      !Array.isArray(files) ||
      files.length === 0 ||
      !files.every(isStoredFileRecord) ||
      !isObjectRecord(value.verification_receipt)
    ) {
      throw new Error('shape')
    }
    return value as unknown as ActiveRecord
  } catch {
    throw modelPackError('active')
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStoredFileRecord(value: unknown): value is StoredFileRecord {
  return (
    isObjectRecord(value) &&
    typeof value.storage_key === 'string' &&
    value.storage_key.length > 0 &&
    safeId(value.pack_id) &&
    safeId(value.pack_version) &&
    safeId(value.variant_id) &&
    safeId(value.file_id) &&
    safeVirtualPath(value.virtual_path) &&
    isSha256(value.sha256) &&
    Number.isSafeInteger(value.byte_size) &&
    (value.byte_size as number) > 0
  )
}

function parseManifestJson(raw: string): AuroraBrowserModelPackManifest {
  try {
    return JSON.parse(raw) as AuroraBrowserModelPackManifest
  } catch {
    throw modelPackError('manifest')
  }
}

function validateActiveReceipt(
  active: ActiveRecord,
  manifest: AuroraBrowserModelPackManifest,
  variant: AuroraBrowserModelPackVariant,
  freshReceipt: AuroraBrowserManifestVerificationReceipt
): void {
  const receipt = active.verification_receipt
  if (!Array.isArray(receipt.file_ids) || !Array.isArray(receipt.files)) throw modelPackError('receipt')
  const receiptFileIds = receipt.files.map((file) => file.file_id)
  const activeFileIds = active.files.map((file) => file.file_id)
  const expectedInstalledFiles = expectedInstalledRecords(manifest.files, variant.file_ids)
  const exactExpectedInstalledFiles = expectedInstalledFiles.filter((file) => (
    file.virtualPath !== undefined || file.sha256 !== undefined || file.byteLength !== undefined
  ))
  const exactExpectedInstalledFileIds = exactExpectedInstalledFiles.map((file) => file.fileId)
  const directoryEntries = expectedDirectoryRecords(manifest.files, variant.file_ids)
  if (
    receipt.pack_id !== active.identity.pack_id ||
    receipt.pack_version !== active.identity.pack_version ||
    receipt.variant_id !== active.identity.variant_id ||
    receipt.verification_mode !== freshReceipt.verification_mode ||
    receipt.key_id !== freshReceipt.key_id ||
    receipt.manifest_sha256 !== freshReceipt.manifest_sha256 ||
    receipt.target !== 'web' ||
    receipt.os !== 'web' ||
    receipt.arch !== 'wasm32' ||
    !isSha256(receipt.manifest_sha256) ||
    !hasUniqueStrings(receipt.file_ids) ||
    !hasUniqueStrings(receiptFileIds) ||
    !hasUniqueStrings(activeFileIds) ||
    !hasUniqueStrings(active.files.map((file) => file.virtual_path)) ||
    !sameStringMultiset(receipt.file_ids, receiptFileIds) ||
    !sameStringMultiset(receipt.file_ids, freshReceipt.file_ids)
  ) {
    throw modelPackError('receipt')
  }
  for (const expected of exactExpectedInstalledFiles) {
    const file = active.files.find((candidate) => candidate.file_id === expected.fileId)
    if (!file || (expected.virtualPath !== undefined && file.virtual_path !== expected.virtualPath)) throw modelPackError('receipt')
    if (
      (expected.sha256 !== undefined && file.sha256 !== expected.sha256) ||
      (expected.byteLength !== undefined && file.byte_size !== expected.byteLength)
    ) throw modelPackError('receipt')
  }
  for (const file of active.files) {
    if (exactExpectedInstalledFileIds.includes(file.file_id)) continue
    const directory = directoryEntries.find((entry) => activeFileBelongsToDirectory(file, entry))
    if (!directory) throw modelPackError('receipt')
  }
  for (const directory of directoryEntries) {
    if (!active.files.some((file) => activeFileBelongsToDirectory(file, directory))) {
      throw modelPackError('receipt')
    }
  }
}

function expectedInstalledRecords(
  manifestFiles: readonly AuroraBrowserModelPackFile[],
  variantFileIds: readonly string[]
): readonly ExpectedInstalledRecord[] {
  const records: ExpectedInstalledRecord[] = []
  for (const fileId of variantFileIds) {
    const file = manifestFiles.find((candidate) => candidate.file_id === fileId)
    if (!file) throw modelPackError('receipt')
    if (file.compression === 'tar_bzip2') {
      const entries = file.archive_entries ?? []
      records.push(...entries.map((entry) => {
        const record: ExpectedInstalledRecord = {
          fileId: entry.file_id,
          ...(entry.kind === 'directory' ? {} : { virtualPath: `/${entry.path}` })
        }
        if (entry.sha256 !== undefined) Object.assign(record, { sha256: entry.sha256 })
        if (entry.byte_size !== undefined) Object.assign(record, { byteLength: entry.byte_size })
        return record
      }))
    } else {
      records.push({ fileId: file.file_id, sha256: file.sha256, byteLength: file.byte_size })
    }
  }
  return records
}

function expectedDirectoryRecords(
  manifestFiles: readonly AuroraBrowserModelPackFile[],
  variantFileIds: readonly string[]
): readonly Required<Pick<ExpectedInstalledRecord, 'fileId' | 'virtualPath'>>[] {
  const records: Array<Required<Pick<ExpectedInstalledRecord, 'fileId' | 'virtualPath'>>> = []
  for (const fileId of variantFileIds) {
    const file = manifestFiles.find((candidate) => candidate.file_id === fileId)
    if (!file || file.compression !== 'tar_bzip2') continue
    for (const entry of file.archive_entries ?? []) {
      if (entry.kind === 'directory') records.push({ fileId: entry.file_id, virtualPath: `/${entry.path}` })
    }
  }
  return records
}

function activeFileBelongsToDirectory(
  file: StoredFileRecord,
  directory: Required<Pick<ExpectedInstalledRecord, 'fileId' | 'virtualPath'>>
): boolean {
  return (
    file.file_id === directoryChildFileId(directory.fileId, file.virtual_path.slice(1)) &&
    file.virtual_path.startsWith(`${directory.virtualPath}/`)
  )
}

function normalizeScope(scope: AuroraBrowserModelPackScope | undefined, fallbackTask: string | undefined): Required<AuroraBrowserModelPackScope> {
  const task = scope?.task ?? fallbackTask ?? 'stt'
  const slotId = scope?.slotId ?? 'default'
  if (!safeId(task) || !safeId(slotId)) throw modelPackError('scope')
  return { task, slotId }
}

function activeKey(scope: Required<AuroraBrowserModelPackScope>): string {
  if (scope.task.includes(':') || scope.slotId.includes(':')) {
    return `${ACTIVE_PREFIX}${scope.task.length}:${scope.task}:${scope.slotId}`
  }
  return `${ACTIVE_PREFIX}${scope.task}:${scope.slotId}`
}

function expectedSelectionKey(packId: string, packVersion: string, variantId: string): string {
  return `${EXPECTED_SELECTION_PREFIX}${lifecycleStorageKey(packId, packVersion, variantId)}`
}

function lifecycleKey(packId: string, packVersion: string, variantId: string): string {
  return `${LIFECYCLE_PREFIX}${lifecycleStorageKey(packId, packVersion, variantId)}`
}

function lifecycleBackingKey(packId: string, packVersion: string, variantId: string): string {
  return `${LIFECYCLE_BACKING_PREFIX}${lifecycleStorageKey(packId, packVersion, variantId)}`
}

function lifecycleStorageKey(packId: string, packVersion: string, variantId: string): string {
  return `aurora.voice.model-pack.v1:${encodeKey(packId)}@${encodeKey(packVersion)}:${encodeKey(variantId)}`
}

function fileStorageKey(packId: string, manifestSha256: string, fileIndex: number): string {
  if (!safeId(packId) || !isSha256(manifestSha256) || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
    throw modelPackError('storage_key')
  }
  return `${packId}@avmf2:${manifestSha256}+${fileIndex}`
}

function fileKey(storageKey: string): string {
  return `${FILE_PREFIX}${storageKey}`
}

function encodeKey(value: string): string {
  return [...encodeUtf8(value)]
    .map((byte) =>
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    )
    .join('')
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw modelPackError('canonical')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object') throw modelPackError('canonical')
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function stripSignature(manifest: AuroraBrowserModelPackManifest): Record<string, unknown> {
  const { signature: _signature, ...unsigned } = manifest
  return unsigned
}

async function verifyEd25519(publicKeyBase64: string, signatureBase64: string, payload: Uint8Array): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw modelPackError('signature_unavailable')
  const publicKeyBytes = decodeBase64(publicKeyBase64)
  const signatureBytes = decodeBase64(signatureBase64)
  if (publicKeyBytes.byteLength !== 32 || signatureBytes.byteLength !== 64) throw modelPackError('signature_encoding')
  const key = await subtle.importKey('raw', publicKeyBytes, 'Ed25519', false, ['verify'])
  return subtle.verify('Ed25519', key, signatureBytes, payload)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function concat(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw modelPackError('base64')
  }
  if (typeof atob === 'function') {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
  }
  throw modelPackError('base64')
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function safeArchivePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !value.split('/').some((segment) => (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      !/^[A-Za-z0-9._-]+$/.test(segment)
    ))
  )
}

function safeVirtualPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && safeArchivePath(value.slice(1))
}

function archivePathStartsWith(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function checkedAdd(left: number, right: number): number {
  const value = left + right
  if (!Number.isSafeInteger(value) || value < left) throw modelPackError('size')
  return value
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

function sameStringMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const counts = new Map<string, number>()
  for (const value of left) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  for (const value of right) {
    const count = counts.get(value)
    if (count === undefined) return false
    if (count === 1) {
      counts.delete(value)
    } else {
      counts.set(value, count - 1)
    }
  }
  return counts.size === 0
}

function modelPackError(code: string, cause?: unknown, cleanupFailed = false): AuroraBrowserModelPackError {
  return new AuroraBrowserModelPackError(code, cleanupFailed, cause)
}
