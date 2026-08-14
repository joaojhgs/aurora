import {
  AuroraBrowserModelStoreHost,
  findAuroraBrowserVoiceCatalogEntry,
  installVerifiedBrowserModelPack,
  listAuroraBrowserVoiceCatalogEntries,
  openActiveBrowserModelPack,
  type AuroraBrowserActiveModelPack,
  type AuroraBrowserModelPackInstallReceipt as VoiceWebBrowserModelPackInstallReceipt,
  type AuroraBrowserModelPackScope,
  type AuroraBrowserModelPackReleaseTrustKey,
  type AuroraBrowserVoiceCatalogEntry,
} from '@aurora/voice-web/browser'
import type {
  AuroraVoiceWebModelBindings,
  AuroraVoiceWebModelDescriptor,
  AuroraVoiceWebModelTask,
  AuroraWebModelStoreHost,
} from '@aurora/voice-web'

export interface AuroraHostedBrowserSpeechPackTrustInput {
  readonly releaseKeyId: string
  readonly releasePublicKeyBase64: string
  readonly expectedManifestSha256: string
}

export type AuroraHostedBrowserSpeechPackStatus =
  | {
      readonly state: 'not-configured'
      readonly pack: null
    }
  | {
      readonly state: 'absent'
      readonly pack: null
    }
  | {
      readonly state: 'verified'
      readonly pack: AuroraBrowserActiveModelPack
    }
  | {
      readonly state: 'rejected'
      readonly reason: string
      readonly pack: null
    }
  | {
      readonly state: 'storage-unavailable'
      readonly reason: string
      readonly pack: null
    }

export interface AuroraHostedBrowserSpeechPackOptions {
  readonly trust?: AuroraHostedBrowserSpeechPackTrustInput | null | undefined
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly createHost?: () => Promise<AuroraWebModelStoreHost>
}

export type AuroraBrowserSpeechPackTask = AuroraVoiceWebModelTask

export interface AuroraBrowserSpeechPackTrustSelection {
  readonly task: AuroraBrowserSpeechPackTask
  readonly packId: string
  readonly packVersion: string
  readonly verificationMode?: 'release-hash' | 'embedded-catalog' | 'signature' | undefined
  readonly releaseKeyId?: string | undefined
  readonly releasePublicKeyBase64?: string | undefined
  readonly expectedManifestSha256: string
  readonly slotId?: string | undefined
  readonly voiceId?: string | undefined
  readonly referenceProfileId?: string | undefined
}

export interface AuroraBrowserSpeechPackCatalogSelection {
  readonly task: AuroraBrowserSpeechPackTask
  readonly packId: string
  readonly packVersion: string
  readonly displayName: string
  readonly language?: string | undefined
  readonly voiceId?: string | undefined
  readonly voiceRevision?: string | undefined
  readonly requiresReferenceProfile?: boolean | undefined
  readonly referenceProfileId?: string | undefined
  readonly referenceProfileSelected?: boolean | undefined
  readonly cached?: boolean | undefined
  readonly active?: boolean | undefined
}

export interface AuroraBrowserSpeechPackCatalogResult {
  readonly state: 'ready' | 'unavailable'
  readonly items: readonly AuroraBrowserSpeechPackCatalogSelection[]
}

export interface AuroraBrowserSpeechPackInstallProgress {
  readonly state: 'queued' | 'downloading' | 'saving' | 'ready'
  readonly receivedBytes?: number | undefined
  readonly totalBytes?: number | undefined
}

export interface AuroraBrowserSpeechPackInstallRequest {
  readonly selection: AuroraBrowserSpeechPackCatalogSelection
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((progress: AuroraBrowserSpeechPackInstallProgress) => void) | undefined
}

export interface AuroraBrowserSpeechPackInstallReceipt {
  readonly task: AuroraBrowserSpeechPackTask
  readonly packId: string
  readonly packVersion: string
  readonly trust: AuroraBrowserSpeechPackTrustSelection
}

export interface AuroraLocalSpeechCatalogPort {
  readonly available: boolean
  listCatalog(): Promise<AuroraBrowserSpeechPackCatalogResult>
  select(request: AuroraBrowserSpeechPackInstallRequest): Promise<AuroraBrowserSpeechPackInstallReceipt>
}

export type AuroraBrowserSpeechPackInstallPort = AuroraLocalSpeechCatalogPort

export type AuroraBrowserSpeechPacksRuntimeStatus =
  | {
      readonly state: 'disabled' | 'not-configured' | 'absent'
      readonly packs: readonly AuroraBrowserActiveModelPack[]
      readonly modelBindings?: undefined
      readonly capabilities: Record<AuroraBrowserSpeechPackTask, boolean>
      readonly ttsVoiceId?: undefined
      readonly revision: string
    }
  | {
      readonly state: 'ready'
      readonly packs: readonly AuroraBrowserActiveModelPack[]
      readonly modelBindings: AuroraVoiceWebModelBindings
      readonly capabilities: Record<AuroraBrowserSpeechPackTask, boolean>
      readonly ttsVoiceId?: string | undefined
      readonly revision: string
    }
  | {
      readonly state: 'rejected' | 'storage-unavailable'
      readonly reason: string
      readonly packs: readonly AuroraBrowserActiveModelPack[]
      readonly modelBindings?: undefined
      readonly capabilities: Record<AuroraBrowserSpeechPackTask, boolean>
      readonly ttsVoiceId?: undefined
      readonly revision: string
    }

export interface AuroraBrowserSpeechPacksOptions {
  readonly enabled?: boolean | undefined
  readonly trustSelections?: readonly AuroraBrowserSpeechPackTrustSelection[] | null | undefined
  readonly tasks?: readonly AuroraBrowserSpeechPackTask[] | undefined
  readonly ttsVoiceId?: string | null | undefined
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly createHost?: () => Promise<AuroraWebModelStoreHost | null>
}

export const AURORA_BROWSER_SPEECH_PACK_TASKS: readonly AuroraBrowserSpeechPackTask[] = Object.freeze(['vad', 'kws', 'stt', 'tts'])

export interface AuroraBrowserVoiceCatalogPortOptions {
  readonly available?: boolean | undefined
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly trustedAssetOrigins?: readonly string[] | undefined
  readonly afterSelect?: ((receipt: AuroraBrowserSpeechPackInstallReceipt, request: AuroraBrowserSpeechPackInstallRequest) => Promise<void> | void) | undefined
}

export function createAuroraBrowserVoiceCatalogPort(
  options: AuroraBrowserVoiceCatalogPortOptions = {},
): AuroraLocalSpeechCatalogPort {
  return Object.freeze({
    available: options.available ?? true,
    async listCatalog(): Promise<AuroraBrowserSpeechPackCatalogResult> {
      if (options.available === false) return Object.freeze({ state: 'unavailable', items: Object.freeze([]) })
      const active = await activeBrowserVoiceCatalogPacks(options.globalObject)
      const items = listAuroraBrowserVoiceCatalogEntries()
        .filter((entry) => entry.installableByBrowserArchive)
        .map((entry) => browserVoiceCatalogSelection(entry, active.get(entry.task)))
      return Object.freeze({ state: 'ready', items: Object.freeze(items) })
    },
    async select(request: AuroraBrowserSpeechPackInstallRequest): Promise<AuroraBrowserSpeechPackInstallReceipt> {
      if (options.available === false) throw new Error('voice_download_unavailable')
      if (request.selection.requiresReferenceProfile === true && !request.selection.referenceProfileId) {
        throw new Error('voice_reference_required')
      }
      const entry = findAuroraBrowserVoiceCatalogEntry(request.selection.packId)
      if (!entry || entry.task !== request.selection.task || entry.installableByBrowserArchive !== true) {
        throw new Error('voice_download_unavailable')
      }
      request.onProgress?.({ state: 'queued' })
      const host = await AuroraBrowserModelStoreHost.create(options.globalObject)
      request.onProgress?.({ state: 'downloading' })
      const receipt = await installVerifiedBrowserModelPack({
        host,
        manifest: entry.toModelPackManifest(),
        scope: { task: entry.task },
        allowEmbeddedBrowserVoiceCatalogTrust: true,
        trustedAssetOrigins: options.trustedAssetOrigins ?? ['https://github.com'],
        ...(request.signal ? { signal: request.signal } : {}),
      })
      request.onProgress?.({ state: 'saving' })
      const mapped = browserVoiceInstallReceipt(entry, request, receipt)
      await options.afterSelect?.(mapped, request)
      request.onProgress?.({ state: 'ready' })
      return mapped
    },
  })
}

export async function openHostedBrowserSttSpeechPack(
  options: AuroraHostedBrowserSpeechPackOptions = {},
): Promise<AuroraHostedBrowserSpeechPackStatus> {
  const trust = normalizeTrustInput(options.trust ?? null)
  if (trust.state === 'not-configured') return Object.freeze({ state: 'not-configured', pack: null })
  if (trust.state === 'invalid') {
    return Object.freeze({
      state: 'rejected',
      reason: trust.reason,
      pack: null,
    })
  }

  let host: AuroraWebModelStoreHost | null
  try {
    host = options.createHost
      ? await options.createHost()
      : await AuroraBrowserModelStoreHost.openExisting(options.globalObject)
  } catch (error) {
    return Object.freeze({
      state: 'storage-unavailable',
      reason: safeReason(error, 'open'),
      pack: null,
    })
  }
  if (host === null) return Object.freeze({ state: 'absent', pack: null })

  try {
    const pack = await openActiveBrowserModelPack(host, { task: 'stt' }, trust.options)
    if (!pack) return Object.freeze({ state: 'absent', pack: null })
    return Object.freeze({ state: 'verified', pack: freezePack(pack) })
  } catch (error) {
    if (isBrowserModelPackError(error)) {
      return Object.freeze({
        state: 'rejected',
        reason: error.code,
        pack: null,
      })
    }
    return Object.freeze({
      state: 'storage-unavailable',
      reason: safeReason(error, 'read'),
      pack: null,
    })
  }
}

export async function openActiveBrowserSpeechPacks(
  options: AuroraBrowserSpeechPacksOptions = {},
): Promise<AuroraBrowserSpeechPacksRuntimeStatus> {
  if (options.enabled === false) return emptyBrowserSpeechPacksStatus('disabled')
  const tasks = options.tasks ?? AURORA_BROWSER_SPEECH_PACK_TASKS
  const trustSelections = new Map<string, AuroraBrowserSpeechPackTrustSelection>()
  for (const selection of options.trustSelections ?? []) {
    trustSelections.set(selection.task, selection)
  }
  if (trustSelections.size === 0) return emptyBrowserSpeechPacksStatus('not-configured')

  let host: AuroraWebModelStoreHost | null
  try {
    host = options.createHost
      ? await options.createHost()
      : await AuroraBrowserModelStoreHost.openExisting(options.globalObject)
  } catch (error) {
    return rejectedBrowserSpeechPacksStatus('storage-unavailable', safeReason(error, 'open'))
  }
  if (host === null) return emptyBrowserSpeechPacksStatus('absent')

  const packs: AuroraBrowserActiveModelPack[] = []
  const files: AuroraVoiceWebModelBindings['files'][number][] = []
  const models: AuroraVoiceWebModelDescriptor[] = []
  const capabilities = emptyCapabilities()
  try {
    for (const task of tasks) {
      const trusted = trustSelections.get(task)
      if (!trusted) continue
      const trust = normalizeTrustSelection(trusted)
      if (trust.state === 'not-configured') continue
      if (trust.state === 'invalid') return rejectedBrowserSpeechPacksStatus('rejected', trust.reason)
      const scope: AuroraBrowserModelPackScope = trusted.slotId ? { task, slotId: trusted.slotId } : { task }
      const pack = await openActiveBrowserModelPack(host, scope, trust.options)
      if (pack === null) continue
      const taskModels = pack.models.filter((model) => model.task === task)
      if (taskModels.length === 0) return rejectedBrowserSpeechPacksStatus('rejected', 'unavailable')
      packs.push(freezePack(pack))
      models.push(...taskModels)
      capabilities[task] = true
      for (const file of pack.files) {
        files.push({
          task,
          fileId: file.fileId,
          virtualPath: virtualPathFromModels(taskModels, file.fileId),
          sha256: file.sha256,
          byteLength: file.byteLength,
          bytes: await file.readAll(),
        })
      }
    }
  } catch (error) {
    if (isBrowserModelPackError(error)) {
      return rejectedBrowserSpeechPacksStatus('rejected', error.code)
    }
    return rejectedBrowserSpeechPacksStatus('storage-unavailable', safeReason(error, 'read'))
  }

  if (files.length === 0) return emptyBrowserSpeechPacksStatus('absent')
  const modelBindings: AuroraVoiceWebModelBindings = Object.freeze({
    files: Object.freeze(files),
    models: Object.freeze(models),
  })
  return Object.freeze({
    state: 'ready',
    packs: Object.freeze(packs),
    modelBindings,
    capabilities,
    ...(options.ttsVoiceId ? { ttsVoiceId: options.ttsVoiceId } : {}),
    revision: browserSpeechPacksRevision(packs),
  })
}

type NormalizedTrustInput =
  | {
      readonly state: 'not-configured'
    }
  | {
      readonly state: 'invalid'
      readonly reason: 'key-id' | 'public-key' | 'expected-digest'
    }
  | {
      readonly state: 'valid'
      readonly options: {
        readonly allowEmbeddedBrowserVoiceCatalogTrust?: true
        readonly trustedReleaseKeys?: readonly AuroraBrowserModelPackReleaseTrustKey[]
        readonly expectedReleaseManifestSha256?: string
      }
    }

function normalizeTrustInput(
  input: AuroraHostedBrowserSpeechPackTrustInput | null,
): NormalizedTrustInput {
  if (!input) return { state: 'not-configured' }
  const keyId = input.releaseKeyId.trim()
  const publicKeyBase64 = input.releasePublicKeyBase64.trim()
  const expectedManifestSha256 = input.expectedManifestSha256.trim().toLowerCase()
  if (!SAFE_ID_RE.test(keyId)) return { state: 'invalid', reason: 'key-id' }
  if (!isSha256(expectedManifestSha256)) return { state: 'invalid', reason: 'expected-digest' }
  if (!isBase64ByteLength(publicKeyBase64, 32)) return { state: 'invalid', reason: 'public-key' }
  return {
    state: 'valid',
    options: {
      trustedReleaseKeys: [{
        keyId,
        publicKeyBase64,
      }],
      expectedReleaseManifestSha256: expectedManifestSha256,
    },
  }
}

function normalizeTrustSelection(
  input: AuroraBrowserSpeechPackTrustSelection | null,
): NormalizedTrustInput {
  if (!input) return { state: 'not-configured' }
  const expectedManifestSha256 = input.expectedManifestSha256.trim().toLowerCase()
  if (!isSha256(expectedManifestSha256)) return { state: 'invalid', reason: 'expected-digest' }
  if (input.verificationMode === 'embedded-catalog' || (!input.releaseKeyId && !input.releasePublicKeyBase64)) {
    return {
      state: 'valid',
      options: {
        allowEmbeddedBrowserVoiceCatalogTrust: true,
        expectedReleaseManifestSha256: expectedManifestSha256,
      },
    }
  }
  const keyId = input.releaseKeyId?.trim() ?? ''
  const publicKeyBase64 = input.releasePublicKeyBase64?.trim() ?? ''
  if (!SAFE_ID_RE.test(keyId)) return { state: 'invalid', reason: 'key-id' }
  if (!isBase64ByteLength(publicKeyBase64, 32)) return { state: 'invalid', reason: 'public-key' }
  return {
    state: 'valid',
    options: {
      trustedReleaseKeys: [{
        keyId,
        publicKeyBase64,
      }],
      expectedReleaseManifestSha256: expectedManifestSha256,
    },
  }
}

function freezePack(pack: AuroraBrowserActiveModelPack): AuroraBrowserActiveModelPack {
  const files = Object.freeze(pack.files.map((file) => Object.freeze(file)))
  const models = Object.freeze(pack.models.map((model): AuroraVoiceWebModelDescriptor => {
    const frozenModel = {
      ...model,
      files: Object.freeze(model.files.map((file) => Object.freeze({ ...file }))),
    }
    if (!model.config) return Object.freeze(frozenModel)
    return Object.freeze({
      ...frozenModel,
      config: Object.freeze({ ...model.config }),
    })
  }))
  return Object.freeze({
    identity: Object.freeze({
      ...pack.identity,
      scope: Object.freeze({ ...pack.identity.scope }),
    }),
    files,
    models,
  })
}

function emptyBrowserSpeechPacksStatus(
  state: 'disabled' | 'not-configured' | 'absent',
): AuroraBrowserSpeechPacksRuntimeStatus {
  return Object.freeze({
    state,
    packs: Object.freeze([]),
    capabilities: emptyCapabilities(),
    revision: state,
  })
}

function rejectedBrowserSpeechPacksStatus(
  state: 'rejected' | 'storage-unavailable',
  reason: string,
): AuroraBrowserSpeechPacksRuntimeStatus {
  return Object.freeze({
    state,
    reason,
    packs: Object.freeze([]),
    capabilities: emptyCapabilities(),
    revision: `${state}:${reason}`,
  })
}

function emptyCapabilities(): Record<AuroraBrowserSpeechPackTask, boolean> {
  return { vad: false, kws: false, stt: false, tts: false }
}

function virtualPathFromModels(models: readonly AuroraVoiceWebModelDescriptor[], fileId: string): string {
  for (const model of models) {
    const file = model.files.find((candidate) => candidate.fileId === fileId)
    if (file) return file.virtualPath
  }
  return `/aurora/${fileId}`
}

function browserSpeechPacksRevision(packs: readonly AuroraBrowserActiveModelPack[]): string {
  return packs
    .map((pack) => `${pack.identity.scope.task}:${pack.identity.packId}:${pack.identity.packVersion}:${pack.identity.variantId}`)
    .sort()
    .join('|')
}

async function activeBrowserVoiceCatalogPacks(
  globalObject: Parameters<typeof AuroraBrowserModelStoreHost.create>[0] | undefined,
): Promise<Map<AuroraBrowserSpeechPackTask, { readonly packId: string; readonly packVersion: string }>> {
  const active = new Map<AuroraBrowserSpeechPackTask, { readonly packId: string; readonly packVersion: string }>()
  let host: AuroraWebModelStoreHost | null
  try {
    host = await AuroraBrowserModelStoreHost.openExisting(globalObject)
  } catch {
    return active
  }
  if (host === null) return active
  for (const task of AURORA_BROWSER_SPEECH_PACK_TASKS) {
    try {
      const pack = await openActiveBrowserModelPack(host, { task }, { allowEmbeddedBrowserVoiceCatalogTrust: true })
      if (pack) active.set(task, { packId: pack.identity.packId, packVersion: pack.identity.packVersion })
    } catch {
      // Keep the download list available even if an installed choice needs attention.
    }
  }
  return active
}

function browserVoiceCatalogSelection(
  entry: AuroraBrowserVoiceCatalogEntry,
  active: { readonly packId: string; readonly packVersion: string } | undefined,
): AuroraBrowserSpeechPackCatalogSelection {
  const manifest = entry.toModelPackManifest()
  const isActive = active?.packId === manifest.pack_id && active.packVersion === manifest.pack_version
  const requiresReferenceProfile = browserVoiceCatalogEntryNeedsReferenceProfile(entry)
  return Object.freeze({
    task: entry.task,
    packId: manifest.pack_id,
    packVersion: manifest.pack_version,
    displayName: entry.displayName,
    language: entry.languages[0],
    cached: isActive,
    active: isActive,
    ...(entry.task === 'tts' ? { voiceId: entry.id, voiceRevision: manifest.pack_version } : {}),
    ...(requiresReferenceProfile ? { requiresReferenceProfile: true, referenceProfileSelected: false } : {}),
  })
}

function browserVoiceInstallReceipt(
  entry: AuroraBrowserVoiceCatalogEntry,
  request: AuroraBrowserSpeechPackInstallRequest,
  receipt: VoiceWebBrowserModelPackInstallReceipt,
): AuroraBrowserSpeechPackInstallReceipt {
  return Object.freeze({
    task: entry.task,
    packId: receipt.identity.packId,
    packVersion: receipt.identity.packVersion,
    trust: Object.freeze({
      task: entry.task,
      packId: receipt.identity.packId,
      packVersion: receipt.identity.packVersion,
      slotId: receipt.identity.scope.slotId,
      verificationMode: receipt.verificationMode,
      releaseKeyId: receipt.verificationKeyId,
      expectedManifestSha256: receipt.manifestSha256,
      ...(entry.task === 'tts' ? { voiceId: entry.id } : {}),
      ...(request.selection.referenceProfileId ? { referenceProfileId: request.selection.referenceProfileId } : {}),
    }),
  })
}

function browserVoiceCatalogEntryNeedsReferenceProfile(entry: AuroraBrowserVoiceCatalogEntry): boolean {
  const manifest = entry.toModelPackManifest()
  return manifest.variants.some((variant) =>
    (variant.model_bindings ?? []).some((model) => model.task === 'tts' && model.family === 'pockettts')
  )
}

function isBrowserModelPackError(error: unknown): error is { readonly code: string } {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { readonly name?: unknown }).name === 'AuroraBrowserModelPackError'
    && typeof (error as { readonly code?: unknown }).code === 'string'
  )
}

function safeReason(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name) return error.name
  return fallback
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u
const SHA256_RE = /^[a-f0-9]{64}$/u

function isSha256(value: string): boolean {
  return SHA256_RE.test(value)
}

function isBase64ByteLength(value: string, expectedByteLength: number): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) return false
  try {
    return atob(value).length === expectedByteLength
  } catch {
    return false
  }
}
