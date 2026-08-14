import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AuroraVoiceWebRuntimeError,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceInferenceOutput,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebModelBindings,
  type AuroraVoiceWebModelFileBinding,
  type AuroraVoiceWebModelTask
} from './types.js'
import type { AuroraVoiceWorkerSherpaAssets } from './worker-assets.js'

const SAMPLE_RATE_HZ = 16_000
const MAX_MODEL_FILES = 64
const MAX_MODEL_FILE_BYTES = 256 * 1024 * 1024
const MAX_VIRTUAL_PATH_BYTES = 256

export interface AuroraSherpaVoiceEngine {
  initialize(bindings: AuroraVoiceWebModelBindings | undefined): Promise<AuroraVoiceWebCapabilities>
  startSession(): Promise<void>
  pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<AuroraVoiceInferenceOutput | undefined>
  stopSession(): Promise<void>
  dispose(): void
}

interface SherpaRuntimeHandles {
  readonly vad: SherpaVad | null
  readonly recognizer: SherpaOfflineRecognizer | null
  readonly recognizerStream: SherpaOfflineStream | null
  readonly kws: SherpaKws | null
  readonly kwsStream: SherpaKwsStream | null
}

export interface SherpaModule {
  FS_createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn: boolean): void
  FS_unlink?(path: string): void
}

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void
  isDetected(): boolean
  isEmpty(): boolean
  pop(): void
  reset(): void
  clear?(): void
  flush?(): void
  free(): void
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream
  decode(stream: SherpaOfflineStream): void
  getResult(stream: SherpaOfflineStream): unknown
  free(): void
}

interface SherpaOfflineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  inputFinished(): void
  reset?(): void
  free(): void
}

interface SherpaKws {
  createStream(): SherpaKwsStream
  isReady(stream: SherpaKwsStream): boolean
  decode(stream: SherpaKwsStream): void
  getResult(stream: SherpaKwsStream): unknown
  reset(stream: SherpaKwsStream): void
  free(): void
}

interface SherpaKwsStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  inputFinished(): void
  free(): void
}

interface SherpaHelpers {
  readonly createVad?: (module: SherpaModule, config: unknown) => SherpaVad
  readonly createOfflineRecognizer?: (module: SherpaModule, config: unknown) => SherpaOfflineRecognizer
  readonly createKws?: (module: SherpaModule, config: unknown) => SherpaKws
}

export interface AuroraSherpaWasmVoiceEngineOptions {
  readonly engineAssets?: AuroraVoiceWorkerSherpaAssets
  readonly loadModule?: (url: string, files: readonly AuroraVoiceWebModelFileBinding[]) => Promise<SherpaModule>
  readonly loadHelpers?: (urls: readonly string[]) => Promise<SherpaHelpers>
  readonly fetch?: typeof fetch
}

export class AuroraSherpaWasmVoiceEngine implements AuroraSherpaVoiceEngine {
  private readonly engineAssets: AuroraVoiceWorkerSherpaAssets | undefined
  private readonly loadModule: (url: string, files: readonly AuroraVoiceWebModelFileBinding[]) => Promise<SherpaModule>
  private readonly loadHelpers: (urls: readonly string[]) => Promise<SherpaHelpers>
  private readonly fetchAsset: typeof fetch
  private handles: SherpaRuntimeHandles | null = null
  private capabilities: AuroraVoiceWebCapabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES

  constructor(options: AuroraSherpaWasmVoiceEngineOptions = {}) {
    this.engineAssets = options.engineAssets
    this.fetchAsset = options.fetch ?? globalThis.fetch
    this.loadModule = options.loadModule ?? ((url, files) => loadControlledSherpaModule(url, files, this.fetchAsset))
    this.loadHelpers = options.loadHelpers ?? ((urls) => loadControlledSherpaHelpers(urls, this.fetchAsset))
  }

  async initialize(bindings: AuroraVoiceWebModelBindings | undefined): Promise<AuroraVoiceWebCapabilities> {
    this.dispose()
    if (bindings === undefined || bindings.files.length === 0) {
      this.capabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES
      return this.capabilities
    }
    const files = await validateModelBindings(bindings)
    const tasks = new Set(files.map((file) => file.task))
    const assets = this.engineAssets
    const needsVadAsr = tasks.has('vad') || tasks.has('stt')
    const needsKws = tasks.has('kws')
    const vadAsrModuleUrl = assets?.vadAsrModuleUrl
    const kwsModuleUrl = assets?.kwsModuleUrl
    if (needsVadAsr && !vadAsrModuleUrl) throw unavailable('missing_vad_asr_engine')
    if (needsKws && !kwsModuleUrl) throw unavailable('missing_kws_engine')

    const helperUrls = [
      ...(needsVadAsr ? [assets?.vadHelperUrl, assets?.asrHelperUrl] : []),
      ...(needsKws ? [assets?.kwsHelperUrl] : [])
    ].filter((url): url is string => typeof url === 'string')
    const helpers = await this.loadHelpers(helperUrls)
    let vadAsrModule: SherpaModule | null = null
    let kwsModule: SherpaModule | null = null
    let vad: SherpaVad | null = null
    let recognizer: SherpaOfflineRecognizer | null = null
    let recognizerStream: SherpaOfflineStream | null = null
    let kws: SherpaKws | null = null
    let kwsStream: SherpaKwsStream | null = null

    try {
      if (needsVadAsr) {
        if (!helpers.createVad && tasks.has('vad')) throw unavailable('missing_vad_helper')
        if (!helpers.createOfflineRecognizer && tasks.has('stt')) throw unavailable('missing_asr_helper')
        vadAsrModule = await this.loadModule(vadAsrModuleUrl!, files.filter((file) => file.task === 'vad' || file.task === 'stt'))
        mountSelectedModelFiles(vadAsrModule, files.filter((file) => file.task === 'vad' || file.task === 'stt'))
        if (tasks.has('vad')) vad = helpers.createVad?.(vadAsrModule, vadConfig(files)) ?? null
        if (tasks.has('stt')) {
          requireOfflineAsrFiles(files)
          recognizer = helpers.createOfflineRecognizer?.(vadAsrModule, asrConfig(files)) ?? null
          if (recognizer === null) throw unavailable('missing_asr_helper')
          recognizerStream = recognizer.createStream()
        }
      }
      if (needsKws) {
        if (!helpers.createKws) throw unavailable('missing_kws_helper')
        kwsModule = await this.loadModule(kwsModuleUrl!, files.filter((file) => file.task === 'kws'))
        mountSelectedModelFiles(kwsModule, files.filter((file) => file.task === 'kws'))
        kws = helpers.createKws(kwsModule, kwsConfig(files))
        kwsStream = kws.createStream()
      }
      this.handles = { vad, recognizer, recognizerStream, kws, kwsStream }
      this.capabilities = Object.freeze({
        vad: vad !== null,
        kws: kws !== null,
        stt: recognizer !== null && recognizerStream !== null,
        tts: false
      })
      return this.capabilities
    } catch (error) {
      freeHandles({ vad, recognizer, recognizerStream, kws, kwsStream })
      throw error
    }
  }

  async startSession(): Promise<void> {
    this.handles?.vad?.reset()
    const handles = this.handles
    if (handles?.recognizerStream !== null && handles !== null) handles.recognizerStream.reset?.()
    if (handles?.kws !== null && handles?.kwsStream !== null && handles !== null) handles.kws.reset(handles.kwsStream)
  }

  async pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<AuroraVoiceInferenceOutput | undefined> {
    const handles = this.handles
    if (handles === null || !hasAnyCapability(this.capabilities)) return undefined
    const samples = pcmI16ToF32(pcm)
    let speechDetected = false
    handles.vad?.acceptWaveform(samples)
    while (handles.vad !== null && handles.vad.isDetected() && !handles.vad.isEmpty()) {
      speechDetected = true
      handles.vad.pop()
    }
    const stt: Array<AuroraVoiceInferenceOutput['stt'][number]> = []
    if (handles.recognizer !== null && handles.recognizerStream !== null) {
      handles.recognizerStream.acceptWaveform(SAMPLE_RATE_HZ, samples)
      handles.recognizer.decode(handles.recognizerStream)
      const text = textFromResult(handles.recognizer.getResult(handles.recognizerStream))
      if (text !== '') stt.push({ text, final: false, sequence: frame.sequence, redacted: true })
    }
    const kwsHits: Array<AuroraVoiceInferenceOutput['kwsHits'][number]> = []
    if (handles.kws !== null && handles.kwsStream !== null) {
      handles.kwsStream.acceptWaveform(SAMPLE_RATE_HZ, samples)
      while (handles.kws.isReady(handles.kwsStream)) handles.kws.decode(handles.kwsStream)
      const hit = kwsHitFromResult(handles.kws.getResult(handles.kwsStream), frame.sequence)
      if (hit !== null) kwsHits.push(hit)
    }
    return Object.freeze({
      ...(handles.vad !== null ? { vad: { active: speechDetected, speechDetected, sequence: frame.sequence, redacted: true as const } } : {}),
      kwsHits,
      stt,
      redacted: true as const
    })
  }

  async stopSession(): Promise<void> {
    const handles = this.handles
    handles?.vad?.flush?.()
    handles?.recognizerStream?.inputFinished()
    handles?.kwsStream?.inputFinished()
  }

  dispose(): void {
    if (this.handles !== null) {
      freeHandles(this.handles)
      this.handles = null
    }
    this.capabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES
  }
}

export function cloneModelBindingsForWorker(bindings: AuroraVoiceWebModelBindings | undefined): {
  readonly bindings?: AuroraVoiceWebModelBindings
  readonly transfer: readonly Transferable[]
} {
  if (bindings === undefined) return { transfer: [] }
  const files = bindings.files.map((file) => ({
    ...file,
    bytes: new Uint8Array(file.bytes)
  }))
  return {
    bindings: {
      files
    },
    transfer: files.map((file) => file.bytes.buffer).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
  }
}

async function validateModelBindings(bindings: AuroraVoiceWebModelBindings): Promise<readonly AuroraVoiceWebModelFileBinding[]> {
  if (!Array.isArray(bindings.files) || bindings.files.length === 0 || bindings.files.length > MAX_MODEL_FILES) throw unavailable('invalid_bindings')
  const seen = new Set<string>()
  const files = bindings.files.map((file) => {
    if (!isTask(file.task) || !safeId(file.fileId) || !safeVirtualPath(file.virtualPath) || !isSha256(file.sha256)) throw unavailable('invalid_binding')
    if (!(file.bytes instanceof Uint8Array) || file.byteLength !== file.bytes.byteLength || file.byteLength <= 0 || file.byteLength > MAX_MODEL_FILE_BYTES) {
      throw unavailable('invalid_binding')
    }
    if (seen.has(file.virtualPath)) throw unavailable('duplicate_binding')
    seen.add(file.virtualPath)
    return file
  })
  for (const file of files) {
    if (await sha256Hex(file.bytes) !== file.sha256) throw unavailable('model_hash_mismatch')
  }
  return files
}

function vadConfig(files: readonly AuroraVoiceWebModelFileBinding[]): unknown {
  return {
    sileroVad: {
      model: findPath(files, 'vad', ['silero', '.onnx']),
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      windowSize: 512,
      maxSpeechDuration: 20
    },
    tenVad: { model: '', threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, windowSize: 256, maxSpeechDuration: 20 },
    sampleRate: SAMPLE_RATE_HZ,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 30
  }
}

function asrConfig(files: readonly AuroraVoiceWebModelFileBinding[]): unknown {
  const moonshineDecoder = findPath(files, 'stt', ['merged', 'decoder']) || findPath(files, 'stt', ['decoder'])
  return {
    featConfig: { sampleRate: SAMPLE_RATE_HZ, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: '',
        encoder: findPath(files, 'stt', ['encoder']),
        uncachedDecoder: moonshineDecoder,
        cachedDecoder: moonshineDecoder
      },
      whisper: {
        encoder: findPath(files, 'stt', ['whisper', 'encoder']) || findPath(files, 'stt', ['encoder']),
        decoder: findPath(files, 'stt', ['whisper', 'decoder']) || findPath(files, 'stt', ['decoder']),
        language: '',
        task: 'transcribe',
        tailPaddings: -1
      },
      senseVoice: {
        model: findPath(files, 'stt', ['sense', 'model']) || findPath(files, 'stt', ['sensevoice']),
        language: '',
        useInverseTextNormalization: 1
      },
      tokens: findPath(files, 'stt', ['tokens']),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: sttModelType(files),
      modelingUnit: 'bpe',
      bpeVocab: ''
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 1
  }
}

function kwsConfig(files: readonly AuroraVoiceWebModelFileBinding[]): unknown {
  return {
    featConfig: { samplingRate: SAMPLE_RATE_HZ, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: findPath(files, 'kws', ['encoder']),
        decoder: findPath(files, 'kws', ['decoder']),
        joiner: findPath(files, 'kws', ['joiner'])
      },
      tokens: findPath(files, 'kws', ['tokens']),
      provider: 'cpu',
      modelType: '',
      numThreads: 1,
      debug: 0,
      modelingUnit: 'bpe',
      bpeVocab: ''
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: 1.0,
    keywordsThreshold: 0.25,
    keywords: ''
  }
}

async function loadControlledSherpaHelpers(urls: readonly string[], fetchImpl: typeof fetch): Promise<SherpaHelpers> {
  for (const url of urls) await fetchNeutralEngineSource(url, fetchImpl)
  throw unavailable('safe_sherpa_loader_missing')
}

async function loadControlledSherpaModule(url: string, _files: readonly AuroraVoiceWebModelFileBinding[], fetchImpl: typeof fetch): Promise<SherpaModule> {
  await fetchNeutralEngineSource(url, fetchImpl)
  throw unavailable('safe_sherpa_loader_missing')
}

export async function fetchNeutralEngineSource(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
  if (typeof fetchImpl !== 'function') throw unavailable('asset_unavailable')
  const response = await fetchImpl(url, { credentials: 'same-origin' })
  if (!response.ok) throw unavailable('asset_unavailable')
  const source = await response.text()
  assertNoBundledDataPreload(source)
  return source
}

export function assertNoBundledDataPreload(source: string): void {
  if (BUNDLED_DATA_PATTERNS.some((pattern) => pattern.test(source))) throw unavailable('bundled_data_rejected')
}

const BUNDLED_DATA_PATTERNS = [
  /\.data(?:["'`)\s?&]|$)/i,
  /remote_package_size/i,
  /getPreloadedPackage/i,
  /expectedDataFileDownloads/i,
  /FS_createPreloadedFile/i,
  /loadPackage/i,
  /PACKAGE_NAME/i
]

function mountSelectedModelFiles(module: SherpaModule, files: readonly AuroraVoiceWebModelFileBinding[]): void {
  for (const file of files) module.FS_createDataFile('/', file.virtualPath.slice(1), new Uint8Array(file.bytes), true, false, true)
}

function findPath(files: readonly AuroraVoiceWebModelFileBinding[], task: AuroraVoiceWebModelTask, needles: readonly string[]): string {
  return files.find((file) => file.task === task && needles.every((needle) => file.virtualPath.toLowerCase().includes(needle)))?.virtualPath ?? ''
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw unavailable('crypto_unavailable')
  const digest = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function requireOfflineAsrFiles(files: readonly AuroraVoiceWebModelFileBinding[]): void {
  const hasMoonshine = files.some((file) => file.task === 'stt' && file.virtualPath.toLowerCase().includes('moonshine'))
  const hasWhisper = files.some((file) => file.task === 'stt' && file.virtualPath.toLowerCase().includes('whisper'))
  const hasSenseVoice = files.some((file) => file.task === 'stt' && file.virtualPath.toLowerCase().includes('sense'))
  if (hasMoonshine) {
    if (
      findPath(files, 'stt', ['encoder']) === '' ||
      (findPath(files, 'stt', ['merged', 'decoder']) === '' && findPath(files, 'stt', ['decoder']) === '') ||
      findPath(files, 'stt', ['tokens']) === ''
    ) throw unavailable('missing_asr_binding')
    return
  }
  if (hasWhisper || hasSenseVoice) {
    if (hasWhisper && (
      (findPath(files, 'stt', ['whisper', 'encoder']) === '' && findPath(files, 'stt', ['encoder']) === '') ||
      (findPath(files, 'stt', ['whisper', 'decoder']) === '' && findPath(files, 'stt', ['decoder']) === '') ||
      findPath(files, 'stt', ['tokens']) === ''
    )) throw unavailable('missing_asr_binding')
    if (hasSenseVoice && (
      (findPath(files, 'stt', ['sense', 'model']) === '' && findPath(files, 'stt', ['sensevoice']) === '') ||
      findPath(files, 'stt', ['tokens']) === ''
    )) throw unavailable('missing_asr_binding')
    return
  }
  if (findPath(files, 'stt', ['tokens']) === '') throw unavailable('missing_asr_binding')
}

function sttModelType(files: readonly AuroraVoiceWebModelFileBinding[]): string {
  if (files.some((file) => file.task === 'stt' && file.virtualPath.toLowerCase().includes('sense'))) return 'sense-voice'
  if (files.some((file) => file.task === 'stt' && file.virtualPath.toLowerCase().includes('whisper'))) return 'whisper'
  return 'moonshine'
}

function textFromResult(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value !== 'object' || value === null) return ''
  const text = (value as { text?: unknown }).text
  return typeof text === 'string' ? text.trim() : ''
}

function kwsHitFromResult(value: unknown, sequence: number): AuroraVoiceInferenceOutput['kwsHits'][number] | null {
  if (typeof value !== 'object' || value === null) return null
  const keyword = (value as { keyword?: unknown }).keyword
  if (typeof keyword !== 'string' || keyword.trim() === '') return null
  const score = (value as { score?: unknown }).score
  return {
    keyword: keyword.trim(),
    score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    sequence,
    redacted: true
  }
}

function freeHandles(handles: SherpaRuntimeHandles): void {
  try { handles.recognizerStream?.free() } catch {}
  try { handles.kwsStream?.free() } catch {}
  try { handles.vad?.free() } catch {}
  try { handles.recognizer?.free() } catch {}
  try { handles.kws?.free() } catch {}
}

function hasAnyCapability(capabilities: AuroraVoiceWebCapabilities): boolean {
  return capabilities.vad || capabilities.kws || capabilities.stt || capabilities.tts
}

function pcmI16ToF32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let index = 0; index < pcm.length; index += 1) out[index] = Math.max(-1, Math.min(1, pcm[index]! / 32768))
  return out
}

function isTask(value: unknown): value is AuroraVoiceWebModelTask {
  return value === 'vad' || value === 'kws' || value === 'stt'
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
}

function safeVirtualPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= MAX_VIRTUAL_PATH_BYTES &&
    !value.includes('..') &&
    !value.includes('//') &&
    /^[A-Za-z0-9_./:-]+$/.test(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function unavailable(code: string): AuroraVoiceWebRuntimeError {
  return new AuroraVoiceWebRuntimeError(/^[a-z_]{1,48}$/.test(code) ? code : 'worker_rejected', 'Voice worker is not available')
}
