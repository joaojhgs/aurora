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
import {
  resolvePocketReferenceAudioMode,
  type AuroraVoiceWebModelBindings,
  type AuroraVoiceWebModelDescriptor,
  type AuroraVoiceWebModelTask,
  type AuroraWebModelStoreHost,
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
  readonly profilePackId?: string | undefined
  readonly profilePackRevision?: string | undefined
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

export interface AuroraBrowserPocketReferenceProfileSummary {
  readonly id: string
  readonly label: string
  readonly transcript: string
  readonly sampleRateHz: number
  readonly durationMs: number
  readonly byteLength: number
  readonly sha256: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface AuroraBrowserPocketReferenceProfileInput {
  readonly audioBytes: Uint8Array
  readonly transcript?: string | undefined
  readonly filename?: string | undefined
  readonly mimeType?: string | undefined
  readonly label?: string | undefined
}

export interface AuroraBrowserPocketReferenceProfileData extends AuroraBrowserPocketReferenceProfileSummary {
  readonly audioBytes: Uint8Array
}

export interface AuroraPocketReferenceWavDecodeResult {
  readonly normalizedBytes: Uint8Array
  readonly samples: Float32Array
  readonly sampleRateHz: number
  readonly durationMs: number
}

export interface AuroraBrowserPocketReferenceProfileStoreOptions {
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly createHost?: () => Promise<AuroraWebModelStoreHost>
}

export interface AuroraLocalSpeechCatalogPort {
  readonly available: boolean
  listCatalog(): Promise<AuroraBrowserSpeechPackCatalogResult>
  select(request: AuroraBrowserSpeechPackInstallRequest): Promise<AuroraBrowserSpeechPackInstallReceipt>
  listReferenceProfiles?(): Promise<readonly AuroraBrowserPocketReferenceProfileSummary[]>
  saveReferenceProfile?(input: AuroraBrowserPocketReferenceProfileInput): Promise<AuroraBrowserPocketReferenceProfileSummary>
  deleteReferenceProfile?(profileId: string): Promise<void>
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
  readonly loadReferenceProfile?: ((profileId: string) => Promise<AuroraBrowserPocketReferenceProfileData | null>) | undefined
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly createHost?: () => Promise<AuroraWebModelStoreHost | null>
}

export const AURORA_BROWSER_SPEECH_PACK_TASKS: readonly AuroraBrowserSpeechPackTask[] = Object.freeze(['vad', 'kws', 'stt', 'tts'])

export interface AuroraBrowserVoiceCatalogPortOptions {
  readonly available?: boolean | undefined
  readonly globalObject?: Parameters<typeof AuroraBrowserModelStoreHost.create>[0]
  readonly trustedAssetOrigins?: readonly string[] | undefined
  readonly afterSelect?: ((receipt: AuroraBrowserSpeechPackInstallReceipt, request: AuroraBrowserSpeechPackInstallRequest) => Promise<void> | void) | undefined
  readonly afterReferenceProfileDeleted?: ((profileId: string) => Promise<void> | void) | undefined
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
    listReferenceProfiles: () => listAuroraBrowserPocketReferenceProfiles(options),
    saveReferenceProfile: (input: AuroraBrowserPocketReferenceProfileInput) => saveAuroraBrowserPocketReferenceProfile(input, options),
    async deleteReferenceProfile(profileId: string): Promise<void> {
      await deleteAuroraBrowserPocketReferenceProfile(profileId, options)
      await options.afterReferenceProfileDeleted?.(profileId)
    },
  })
}

export async function listAuroraBrowserPocketReferenceProfiles(
  options: AuroraBrowserPocketReferenceProfileStoreOptions = {},
): Promise<readonly AuroraBrowserPocketReferenceProfileSummary[]> {
  const host = await pocketReferenceProfileHost(options)
  const index = await readPocketReferenceProfileIndex(host)
  const recovered: string[] = []
  const profiles: AuroraBrowserPocketReferenceProfileSummary[] = []
  for (const id of index) {
    const profile = await readPocketReferenceProfileSummary(host, id)
    if (!profile) continue
    const stat = await host.promotedStat(pocketReferenceAudioKey(id))
    if (!stat || stat.byteLength !== profile.byteLength) {
      await deletePocketReferenceProfile(host, id)
      continue
    }
    recovered.push(id)
    profiles.push(profile)
  }
  if (recovered.length !== index.length) await writePocketReferenceProfileIndex(host, recovered)
  return Object.freeze(profiles.sort((left, right) => right.updatedAtMs - left.updatedAtMs).map((profile) => Object.freeze(profile)))
}

export async function saveAuroraBrowserPocketReferenceProfile(
  input: AuroraBrowserPocketReferenceProfileInput,
  options: AuroraBrowserPocketReferenceProfileStoreOptions = {},
): Promise<AuroraBrowserPocketReferenceProfileSummary> {
  const decoded = decodeAuroraPocketReferenceWav(input.audioBytes)
  const transcript = normalizePocketReferenceTranscript(input.transcript ?? '')
  const host = await pocketReferenceProfileHost(options)
  const id = createPocketReferenceProfileId(options.globalObject)
  const now = Date.now()
  const audioKey = pocketReferenceAudioKey(id)
  const audioBytes = decoded.normalizedBytes
  const sha256 = await sha256Hex(audioBytes)
  await host.clearStaging(audioKey)
  await host.appendStaging(audioKey, 0, audioBytes)
  await host.promoteStagingAtomic(audioKey)
  const summary: AuroraBrowserPocketReferenceProfileSummary = Object.freeze({
    id,
    label: pocketReferenceProfileLabel(input.label, input.filename, now),
    transcript,
    sampleRateHz: decoded.sampleRateHz,
    durationMs: decoded.durationMs,
    byteLength: audioBytes.byteLength,
    sha256,
    createdAtMs: now,
    updatedAtMs: now,
  })
  await host.writeJson(pocketReferenceProfileKey(id), JSON.stringify(summary))
  const index = await readPocketReferenceProfileIndex(host)
  await writePocketReferenceProfileIndex(host, [id, ...index.filter((candidate) => candidate !== id)])
  return summary
}

export async function readAuroraBrowserPocketReferenceProfile(
  profileId: string,
  options: AuroraBrowserPocketReferenceProfileStoreOptions = {},
): Promise<AuroraBrowserPocketReferenceProfileData | null> {
  if (!isPocketReferenceProfileId(profileId)) return null
  const host = await pocketReferenceProfileHost(options)
  const summary = await readPocketReferenceProfileSummary(host, profileId)
  if (!summary) return null
  const bytes = await readPromotedBytes(host, pocketReferenceAudioKey(profileId), summary.byteLength)
  if (!bytes || bytes.byteLength !== summary.byteLength) {
    await deletePocketReferenceProfile(host, profileId)
    await writePocketReferenceProfileIndex(host, (await readPocketReferenceProfileIndex(host)).filter((id) => id !== profileId))
    return null
  }
  return Object.freeze({
    ...summary,
    audioBytes: bytes,
  })
}

export async function deleteAuroraBrowserPocketReferenceProfile(
  profileId: string,
  options: AuroraBrowserPocketReferenceProfileStoreOptions = {},
): Promise<void> {
  if (!isPocketReferenceProfileId(profileId)) return
  const host = await pocketReferenceProfileHost(options)
  await deletePocketReferenceProfile(host, profileId)
  await writePocketReferenceProfileIndex(host, (await readPocketReferenceProfileIndex(host)).filter((id) => id !== profileId))
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
      let taskModels = pack.models.filter((model) => model.task === task)
      if (taskModels.length === 0) return rejectedBrowserSpeechPacksStatus('rejected', 'unavailable')
      let referenceFile: AuroraVoiceWebModelBindings['files'][number] | null = null
      if (task === 'tts' && taskModels.some(isPocketTtsProfileModel)) {
        const referenceProfileId = trusted.referenceProfileId
        if (!referenceProfileId) continue
        const referenceProfile = options.loadReferenceProfile
          ? await options.loadReferenceProfile(referenceProfileId)
          : await readAuroraBrowserPocketReferenceProfile(referenceProfileId, { createHost: async () => host })
        if (!referenceProfile) continue
        const referenceFileId = `reference-audio:${referenceProfile.id}`
        const referenceVirtualPath = `/aurora/reference/${referenceProfile.id}.wav`
        referenceFile = Object.freeze({
          task,
          fileId: referenceFileId,
          virtualPath: referenceVirtualPath,
          sha256: referenceProfile.sha256,
          byteLength: referenceProfile.byteLength,
          bytes: referenceProfile.audioBytes,
        })
        taskModels = taskModels.map((model) => {
          if (!isPocketTtsProfileModel(model)) return model
          return Object.freeze({
            ...model,
            files: Object.freeze([
              ...model.files.filter((file) => file.role !== 'referenceAudio'),
              Object.freeze({
                role: 'referenceAudio' as const,
                fileId: referenceFileId,
                virtualPath: referenceVirtualPath,
              }),
            ]),
            config: Object.freeze({
              ...(model.config ?? {}),
              referenceSampleRateHz: referenceProfile.sampleRateHz,
            }),
          })
        })
      }
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
      if (referenceFile) files.push(referenceFile)
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
    revision: browserSpeechPacksRevision(packs, modelBindings),
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

function browserSpeechPacksRevision(
  packs: readonly AuroraBrowserActiveModelPack[],
  modelBindings: AuroraVoiceWebModelBindings,
): string {
  const packRevision = packs
    .map((pack) => `${pack.identity.scope.task}:${pack.identity.packId}:${pack.identity.packVersion}:${pack.identity.variantId}`)
    .sort()
    .join('|')
  const bindingRevision = modelBindings.files
    .filter((file) => file.fileId.startsWith('reference-audio:'))
    .map((file) => `${file.fileId}:${file.sha256}`)
    .sort()
    .join('|')
  return bindingRevision ? `${packRevision}|${bindingRevision}` : packRevision
}

function isPocketTtsModel(model: AuroraVoiceWebModelDescriptor): boolean {
  return model.task === 'tts' && model.family === 'pockettts'
}

function isPocketTtsProfileModel(model: AuroraVoiceWebModelDescriptor): boolean {
  return isPocketTtsModel(model) && resolvePocketReferenceAudioMode(model.config) === 'profile'
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
    (variant.model_bindings ?? []).some((model) =>
      model.task === 'tts'
      && model.family === 'pockettts'
      && resolvePocketReferenceAudioMode(model.config) === 'profile'
    )
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

type PocketReferenceProfileRecord = AuroraBrowserPocketReferenceProfileSummary

const POCKET_REFERENCE_PROFILE_INDEX_KEY = 'aurora.voice.reference.v1:index'
const POCKET_REFERENCE_PROFILE_PREFIX = 'aurora.voice.reference.v1:profile:'
const POCKET_REFERENCE_AUDIO_PREFIX = 'aurora.voice.reference.v1:audio:'
const POCKET_REFERENCE_MAX_BYTES = 10 * 1024 * 1024
const POCKET_REFERENCE_MIN_DURATION_MS = 500
const POCKET_REFERENCE_MAX_DURATION_MS = 30_000
const POCKET_REFERENCE_MAX_TRANSCRIPT_CHARS = 1_000

async function pocketReferenceProfileHost(
  options: AuroraBrowserPocketReferenceProfileStoreOptions,
): Promise<AuroraWebModelStoreHost> {
  return options.createHost
    ? await options.createHost()
    : await AuroraBrowserModelStoreHost.create(options.globalObject)
}

async function readPocketReferenceProfileIndex(host: AuroraWebModelStoreHost): Promise<readonly string[]> {
  try {
    const raw = await host.readJson(POCKET_REFERENCE_PROFILE_INDEX_KEY)
    if (!raw) return Object.freeze([])
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return Object.freeze([])
    return Object.freeze(parsed.filter((id): id is string => typeof id === 'string' && isPocketReferenceProfileId(id)))
  } catch {
    return Object.freeze([])
  }
}

async function writePocketReferenceProfileIndex(
  host: AuroraWebModelStoreHost,
  ids: readonly string[],
): Promise<void> {
  await host.writeJson(POCKET_REFERENCE_PROFILE_INDEX_KEY, JSON.stringify([...new Set(ids)].filter(isPocketReferenceProfileId)))
}

async function readPocketReferenceProfileSummary(
  host: AuroraWebModelStoreHost,
  profileId: string,
): Promise<AuroraBrowserPocketReferenceProfileSummary | null> {
  try {
    const raw = await host.readJson(pocketReferenceProfileKey(profileId))
    if (!raw) return null
    return parsePocketReferenceProfileRecord(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

async function deletePocketReferenceProfile(host: AuroraWebModelStoreHost, profileId: string): Promise<void> {
  await Promise.all([
    host.deleteJson(pocketReferenceProfileKey(profileId)).catch(() => undefined),
    host.deletePromoted(pocketReferenceAudioKey(profileId)).catch(() => undefined),
    host.clearStaging(pocketReferenceAudioKey(profileId)).catch(() => undefined),
  ])
}

async function readPromotedBytes(
  host: AuroraWebModelStoreHost,
  storageKey: string,
  byteLength: number,
): Promise<Uint8Array | null> {
  const stat = await host.promotedStat(storageKey)
  if (!stat || stat.byteLength !== byteLength) return null
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  while (offset < byteLength) {
    const chunk = await host.readPromotedChunk(storageKey, offset, Math.min(1024 * 1024, byteLength - offset))
    if (chunk.bytes.byteLength === 0) return null
    bytes.set(chunk.bytes, offset)
    offset += chunk.bytes.byteLength
  }
  return bytes
}

function parsePocketReferenceProfileRecord(value: unknown): AuroraBrowserPocketReferenceProfileSummary | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Partial<PocketReferenceProfileRecord>
  let transcript: string
  try {
    const rawTranscript = typeof record.transcript === 'string' ? record.transcript : ''
    transcript = normalizePocketReferenceTranscript(rawTranscript)
  } catch {
    return null
  }
  if (
    typeof record.id !== 'string'
    || !isPocketReferenceProfileId(record.id)
    || typeof record.label !== 'string'
    || record.label.trim() === ''
    || (typeof record.transcript === 'string' && transcript !== record.transcript)
    || typeof record.sampleRateHz !== 'number'
    || !Number.isSafeInteger(record.sampleRateHz)
    || record.sampleRateHz < 8_000
    || record.sampleRateHz > 48_000
    || typeof record.durationMs !== 'number'
    || !Number.isFinite(record.durationMs)
    || record.durationMs < POCKET_REFERENCE_MIN_DURATION_MS
    || record.durationMs > POCKET_REFERENCE_MAX_DURATION_MS
    || typeof record.byteLength !== 'number'
    || !Number.isSafeInteger(record.byteLength)
    || record.byteLength <= 0
    || record.byteLength > POCKET_REFERENCE_MAX_BYTES
    || typeof record.sha256 !== 'string'
    || !isSha256(record.sha256)
    || typeof record.createdAtMs !== 'number'
    || !Number.isSafeInteger(record.createdAtMs)
    || typeof record.updatedAtMs !== 'number'
    || !Number.isSafeInteger(record.updatedAtMs)
  ) {
    return null
  }
  return Object.freeze({
    id: record.id,
    label: record.label,
    transcript,
    sampleRateHz: record.sampleRateHz,
    durationMs: record.durationMs,
    byteLength: record.byteLength,
    sha256: record.sha256,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  })
}

export function decodeAuroraPocketReferenceWav(bytes: Uint8Array): AuroraPocketReferenceWavDecodeResult {
  if (bytes.byteLength < 44 || bytes.byteLength > POCKET_REFERENCE_MAX_BYTES) throw new Error('voice_sample_file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') throw new Error('voice_sample_file')
  let offset = 12
  let audioFormat = 0
  let channelCount = 0
  let sampleRateHz = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(bytes, offset, 4)
    const chunkLength = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8
    if (chunkLength > bytes.byteLength - chunkDataOffset) throw new Error('voice_sample_file')
    if (chunkId === 'fmt ') {
      if (chunkLength < 16) throw new Error('voice_sample_file')
      audioFormat = view.getUint16(chunkDataOffset, true)
      channelCount = view.getUint16(chunkDataOffset + 2, true)
      sampleRateHz = view.getUint32(chunkDataOffset + 4, true)
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset
      dataLength = chunkLength
    }
    offset = chunkDataOffset + chunkLength + (chunkLength % 2)
  }
  if (audioFormat !== 1 || channelCount !== 1 || bitsPerSample !== 16 || dataOffset < 0 || dataLength <= 0 || dataLength % 2 !== 0) {
    throw new Error('voice_sample_format')
  }
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 48_000) throw new Error('voice_sample_rate')
  const durationMs = Math.round((dataLength / 2 / sampleRateHz) * 1000)
  if (durationMs < POCKET_REFERENCE_MIN_DURATION_MS) throw new Error('voice_sample_short')
  if (durationMs > POCKET_REFERENCE_MAX_DURATION_MS) throw new Error('voice_sample_long')
  const pcm = bytes.slice(dataOffset, dataOffset + dataLength)
  return Object.freeze({
    normalizedBytes: writePcm16MonoWav(sampleRateHz, pcm),
    samples: pcm16BytesToFloat32(pcm),
    sampleRateHz,
    durationMs,
  })
}

function pcm16BytesToFloat32(pcmBytes: Uint8Array): Float32Array {
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength)
  const samples = new Float32Array(pcmBytes.byteLength / 2)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = view.getInt16(index * 2, true)
    samples[index] = sample < 0 ? sample / 32768 : sample / 32767
  }
  return samples
}

function writePcm16MonoWav(sampleRateHz: number, pcmBytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(44 + pcmBytes.byteLength)
  const view = new DataView(output.buffer)
  writeAscii(output, 0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes.byteLength, true)
  writeAscii(output, 8, 'WAVE')
  writeAscii(output, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRateHz, true)
  view.setUint32(28, sampleRateHz * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(output, 36, 'data')
  view.setUint32(40, pcmBytes.byteLength, true)
  output.set(pcmBytes, 44)
  return output
}

function normalizePocketReferenceTranscript(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length > POCKET_REFERENCE_MAX_TRANSCRIPT_CHARS) throw new Error('voice_sample_words')
  return normalized
}

function pocketReferenceProfileLabel(label: string | undefined, filename: string | undefined, now: number): string {
  const preferred = (label ?? filename ?? '').replace(/\s+/gu, ' ').trim()
  const safe = preferred.length > 0 ? preferred : `Voice sample ${new Date(now).toLocaleDateString('en-US')}`
  return safe.slice(0, 96)
}

function createPocketReferenceProfileId(globalObject: Parameters<typeof AuroraBrowserModelStoreHost.create>[0] | undefined): string {
  const cryptoObject = globalObject?.crypto ?? globalThis.crypto
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID()
  const random = new Uint8Array(16)
  cryptoObject?.getRandomValues?.(random)
  if (random.some((byte) => byte !== 0)) {
    return Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

function pocketReferenceProfileKey(profileId: string): string {
  return `${POCKET_REFERENCE_PROFILE_PREFIX}${profileId}`
}

function pocketReferenceAudioKey(profileId: string): string {
  return `${POCKET_REFERENCE_AUDIO_PREFIX}${profileId}`
}

function isPocketReferenceProfileId(value: string): boolean {
  return SAFE_PROFILE_ID_RE.test(value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) value += String.fromCharCode(bytes[offset + index] ?? 0)
  return value
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('voice_sample_storage')
  const digest = await subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u
const SAFE_PROFILE_ID_RE = /^[A-Za-z0-9._:@+-]{1,128}$/u
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
