import type { AuroraWebModelStoreHost } from './model-store-host.js'

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
  readonly compression: string
  readonly dependencies?: readonly string[]
}

export interface AuroraBrowserModelPackVariant {
  readonly variant_id: string
  readonly file_ids: readonly string[]
  readonly target: string
  readonly os: string
  readonly arch: string
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

export type AuroraBrowserModelPackVerificationMode = 'signature' | 'release-hash'

export interface AuroraBrowserModelPackReleaseTrustKey {
  readonly keyId: string
  readonly publicKeyBase64: string
}

export interface AuroraBrowserModelPackTrustOptions {
  readonly allowNonProductionTestSignature?: boolean
  readonly trustedReleaseKeys?: readonly AuroraBrowserModelPackReleaseTrustKey[]
  readonly expectedReleaseManifestSha256?: string
}

export interface AuroraBrowserModelPackInstallOptions extends AuroraBrowserModelPackTrustOptions {
  readonly host: AuroraWebModelStoreHost
  readonly manifest: AuroraBrowserModelPackManifest
  readonly scope?: AuroraBrowserModelPackScope
  readonly fetchBytes?: (url: string) => Promise<Uint8Array>
  readonly nowMs?: () => number
}

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
  readonly storageKey: string
  readonly sha256: string
  readonly byteLength: number
  readAll(): Promise<Uint8Array>
  readChunk(offset: number, maxBytes: number): Promise<Uint8Array>
}

export interface AuroraBrowserActiveModelPack {
  readonly identity: AuroraBrowserModelPackIdentity
  readonly files: readonly AuroraBrowserImmutableModelFile[]
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
  readonly sha256: string
  readonly byte_size: number
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
  constructor(readonly code: string) {
    super(`aurora_voice_web_model_pack:${code}`)
    this.name = 'AuroraBrowserModelPackError'
  }
}

interface ResolvedManifestTrust {
  readonly publicKeyBase64: string
  readonly verificationMode: AuroraBrowserModelPackVerificationMode
  readonly expectedManifestSha256?: string
}

export async function verifyBrowserModelPackManifest(
  manifest: AuroraBrowserModelPackManifest,
  options: AuroraBrowserModelPackTrustOptions = {}
): Promise<AuroraBrowserManifestVerificationReceipt> {
  validateManifestShape(manifest)
  if (manifest.revocation?.revoked === true) throw modelPackError('revoked_pack')
  const signature = manifest.signature
  if (!signature) throw modelPackError('unsigned')
  if (signature.algorithm !== AURORA_MODEL_PACK_SIGNATURE_ALGORITHM) throw modelPackError('algorithm')
  const trust = resolveManifestTrust(signature.key_id, options)
  if (trust === null) throw modelPackError('untrusted_key')

  const canonical = canonicalJson(stripSignature(manifest))
  const canonicalBytes = encodeUtf8(canonical)
  const manifestSha256 = await sha256Hex(canonicalBytes)
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
    files: variant.file_ids.map((fileId) => {
      const file = manifest.files.find((candidate) => candidate.file_id === fileId)
      if (!file) throw modelPackError('selection')
      return { file_id: file.file_id, sha256: file.sha256, byte_size: file.byte_size }
    })
  }
}

export async function installVerifiedBrowserModelPack({
  host,
  manifest,
  scope,
  fetchBytes = defaultFetchBytes,
  allowNonProductionTestSignature = false,
  trustedReleaseKeys,
  expectedReleaseManifestSha256,
  nowMs = Date.now
}: AuroraBrowserModelPackInstallOptions): Promise<AuroraBrowserModelPackInstallReceipt> {
  const trustOptions: AuroraBrowserModelPackTrustOptions = { allowNonProductionTestSignature }
  if (trustedReleaseKeys !== undefined) {
    Object.assign(trustOptions, { trustedReleaseKeys })
  }
  if (expectedReleaseManifestSha256 !== undefined) {
    Object.assign(trustOptions, { expectedReleaseManifestSha256 })
  }
  const verificationReceipt = await verifyBrowserModelPackManifest(manifest, trustOptions)
  const variant = selectReceiptVariant(manifest, verificationReceipt)
  const normalizedScope = normalizeScope(scope, manifest.tasks[0])
  const records: StoredFileRecord[] = []
  for (const fileId of verificationReceipt.file_ids) {
    const file = manifest.files.find((candidate) => candidate.file_id === fileId)
    const verifiedFile = verificationReceipt.files.find((candidate) => candidate.file_id === fileId)
    if (!file || !verifiedFile || verifiedFile.sha256 !== file.sha256 || verifiedFile.byte_size !== file.byte_size) {
      throw modelPackError('receipt')
    }
    const storageKey = fileStorageKey(manifest.pack_id, manifest.pack_version, variant.variant_id, file.file_id)
    const bytes = await fetchBytes(file.url)
    if (bytes.byteLength !== file.byte_size) throw modelPackError('size')
    const digest = await sha256Hex(bytes)
    if (digest !== file.sha256) throw modelPackError('hash')
    await host.clearStaging(storageKey)
    await host.appendStaging(storageKey, 0, bytes)
    await host.promoteStagingAtomic(storageKey)
    const record: StoredFileRecord = {
      storage_key: storageKey,
      pack_id: manifest.pack_id,
      pack_version: manifest.pack_version,
      variant_id: variant.variant_id,
      file_id: file.file_id,
      sha256: digest,
      byte_size: bytes.byteLength
    }
    await host.writeJson(fileKey(storageKey), JSON.stringify({
      ...record,
      state: 'ready',
      stored_at: Math.max(0, Math.trunc(nowMs()))
    }))
    records.push(record)
  }
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
  await host.writeJson(expectedSelectionKey(manifest.pack_id, manifest.pack_version, variant.variant_id), JSON.stringify({ files: records }))
  await host.writeJson(lifecycleKey(manifest.pack_id, manifest.pack_version, variant.variant_id), JSON.stringify({
    pack_id: manifest.pack_id,
    pack_version: manifest.pack_version,
    variant_id: variant.variant_id,
    state: 'active',
    revision: 1,
    updated_at: Math.max(0, Math.trunc(nowMs())),
    error_code: null
  }))
  await host.writeJson(lifecycleBackingKey(manifest.pack_id, manifest.pack_version, variant.variant_id), JSON.stringify({ files: records }))
  await host.writeJson(activeKey(normalizedScope), JSON.stringify(active))
  return {
    identity: {
      packId: manifest.pack_id,
      packVersion: manifest.pack_version,
      variantId: variant.variant_id,
      scope: normalizedScope
    },
    files: records.map((record) => ({
      fileId: record.file_id,
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
  validateActiveReceipt(active, freshReceipt)
  const files: AuroraBrowserImmutableModelFile[] = []
  for (const record of active.files) {
    const stat = await host.promotedStat(record.storage_key)
    if (!stat || stat.byteLength !== record.byte_size) throw modelPackError('missing_file')
    const digest = await hashPromotedFile(host, record.storage_key, record.byte_size)
    if (digest !== record.sha256) throw modelPackError('corrupt')
    files.push({
      fileId: record.file_id,
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
    files
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
  for (const task of manifest.tasks) {
    if (!safeId(task)) throw modelPackError('invalid_id')
  }
  for (const file of manifest.files) {
    if (!safeId(file.file_id) || !safeId(file.asset_id) || !safeId(file.task)) throw modelPackError('invalid_id')
    if (!isSha256(file.sha256) || !Number.isSafeInteger(file.byte_size) || file.byte_size <= 0) {
      throw modelPackError('size')
    }
    if (!Number.isSafeInteger(file.installed_size) || file.installed_size < file.byte_size) throw modelPackError('size')
    if (file.compression !== 'none') throw modelPackError('compression')
    if (!manifest.tasks.includes(file.task)) throw modelPackError('variant_file')
  }
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
  if (!sameStringSet(variant.file_ids, receipt.file_ids)) throw modelPackError('target')
  return variant
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw modelPackError('network')
  return new Uint8Array(await response.arrayBuffer())
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
    const value = JSON.parse(raw) as ActiveRecord
    if (
      !value.identity ||
      typeof value.manifest_json !== 'string' ||
      !Array.isArray(value.files) ||
      value.files.length === 0 ||
      !value.verification_receipt
    ) {
      throw new Error('shape')
    }
    return value
  } catch {
    throw modelPackError('active')
  }
}

function parseManifestJson(raw: string): AuroraBrowserModelPackManifest {
  try {
    return JSON.parse(raw) as AuroraBrowserModelPackManifest
  } catch {
    throw modelPackError('manifest')
  }
}

function validateActiveReceipt(active: ActiveRecord, freshReceipt: AuroraBrowserManifestVerificationReceipt): void {
  const receipt = active.verification_receipt
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
    !sameStringSet(receipt.file_ids, freshReceipt.file_ids)
  ) {
    throw modelPackError('receipt')
  }
  if (!sameStringSet(active.files.map((file) => file.file_id), receipt.file_ids)) throw modelPackError('receipt')
  for (const file of active.files) {
    const verified = receipt.files.find((candidate) => candidate.file_id === file.file_id)
    const fresh = freshReceipt.files.find((candidate) => candidate.file_id === file.file_id)
    if (
      !verified ||
      !fresh ||
      verified.sha256 !== fresh.sha256 ||
      verified.byte_size !== fresh.byte_size ||
      file.sha256 !== verified.sha256 ||
      file.byte_size !== verified.byte_size
    ) {
      throw modelPackError('receipt')
    }
  }
}

function normalizeScope(scope: AuroraBrowserModelPackScope | undefined, fallbackTask: string | undefined): Required<AuroraBrowserModelPackScope> {
  const task = scope?.task ?? fallbackTask ?? 'stt'
  const slotId = scope?.slotId ?? 'default'
  if (!safeId(task) || !safeId(slotId)) throw modelPackError('scope')
  return { task, slotId }
}

function activeKey(scope: Required<AuroraBrowserModelPackScope>): string {
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

function fileStorageKey(packId: string, packVersion: string, variantId: string, fileId: string): string {
  return `aurora.voice.model-file.v1:${encodeKey(packId)}@${encodeKey(packVersion)}:${encodeKey(variantId)}+${encodeKey(fileId)}`
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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function modelPackError(code: string): AuroraBrowserModelPackError {
  return new AuroraBrowserModelPackError(code)
}
