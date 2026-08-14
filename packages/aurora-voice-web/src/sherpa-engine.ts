import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AuroraVoiceWebRuntimeError,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebModelBindings,
  type AuroraVoiceWebModelFileBinding,
  type AuroraVoiceWebModelTask
} from './types.js'

const SAMPLE_RATE_HZ = 16_000
const MAX_MODEL_FILES = 64
const MAX_MODEL_FILE_BYTES = 256 * 1024 * 1024
const MAX_VIRTUAL_PATH_BYTES = 256

export interface AuroraSherpaVoiceEngine {
  initialize(bindings: AuroraVoiceWebModelBindings | undefined): Promise<AuroraVoiceWebCapabilities>
  startSession(): Promise<void>
  pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<void>
  stopSession(): Promise<void>
  dispose(): void
}

interface SherpaRuntimeHandles {
  readonly vad: SherpaVad | null
  readonly recognizer: SherpaOnlineRecognizer | null
  readonly recognizerStream: SherpaOnlineStream | null
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

interface SherpaOnlineRecognizer {
  createStream(): SherpaOnlineStream
  isReady(stream: SherpaOnlineStream): boolean
  decode(stream: SherpaOnlineStream): void
  getResult(stream: SherpaOnlineStream): unknown
  reset(stream: SherpaOnlineStream): void
  free(): void
}

interface SherpaOnlineStream {
  acceptWaveform(sampleRate: number, samples: Float32Array): void
  inputFinished(): void
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
  readonly createOnlineRecognizer?: (module: SherpaModule, config: unknown) => SherpaOnlineRecognizer
  readonly createKws?: (module: SherpaModule, config: unknown) => SherpaKws
}

export interface AuroraSherpaWasmVoiceEngineOptions {
  readonly loadModule?: (url: string, files: readonly AuroraVoiceWebModelFileBinding[]) => Promise<SherpaModule>
  readonly loadHelpers?: (urls: readonly string[]) => Promise<SherpaHelpers>
}

export class AuroraSherpaWasmVoiceEngine implements AuroraSherpaVoiceEngine {
  private readonly loadModule: (url: string, files: readonly AuroraVoiceWebModelFileBinding[]) => Promise<SherpaModule>
  private readonly loadHelpers: (urls: readonly string[]) => Promise<SherpaHelpers>
  private handles: SherpaRuntimeHandles | null = null
  private capabilities: AuroraVoiceWebCapabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES

  constructor(options: AuroraSherpaWasmVoiceEngineOptions = {}) {
    this.loadModule = options.loadModule ?? loadClassicEmscriptenModule
    this.loadHelpers = options.loadHelpers ?? loadClassicSherpaHelpers
  }

  async initialize(bindings: AuroraVoiceWebModelBindings | undefined): Promise<AuroraVoiceWebCapabilities> {
    this.dispose()
    if (bindings === undefined || bindings.files.length === 0) {
      this.capabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES
      return this.capabilities
    }
    const files = validateModelBindings(bindings)
    const tasks = new Set(files.map((file) => file.task))
    const assets = bindings.sherpaAssets
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
    let recognizer: SherpaOnlineRecognizer | null = null
    let recognizerStream: SherpaOnlineStream | null = null
    let kws: SherpaKws | null = null
    let kwsStream: SherpaKwsStream | null = null

    try {
      if (needsVadAsr) {
        if (!helpers.createVad && tasks.has('vad')) throw unavailable('missing_vad_helper')
        if (!helpers.createOnlineRecognizer && tasks.has('stt')) throw unavailable('missing_asr_helper')
        vadAsrModule = await this.loadModule(vadAsrModuleUrl!, files.filter((file) => file.task === 'vad' || file.task === 'stt'))
        if (tasks.has('vad')) vad = helpers.createVad?.(vadAsrModule, vadConfig(files)) ?? null
        if (tasks.has('stt')) {
          recognizer = helpers.createOnlineRecognizer?.(vadAsrModule, asrConfig(files)) ?? null
          if (recognizer === null) throw unavailable('missing_asr_helper')
          recognizerStream = recognizer.createStream()
        }
      }
      if (needsKws) {
        if (!helpers.createKws) throw unavailable('missing_kws_helper')
        kwsModule = await this.loadModule(kwsModuleUrl!, files.filter((file) => file.task === 'kws'))
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
    if (handles?.recognizer !== null && handles?.recognizerStream !== null && handles !== null) handles.recognizer.reset(handles.recognizerStream)
    if (handles?.kws !== null && handles?.kwsStream !== null && handles !== null) handles.kws.reset(handles.kwsStream)
  }

  async pushPcmI16(_frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<void> {
    const handles = this.handles
    if (handles === null || !hasAnyCapability(this.capabilities)) return
    const samples = pcmI16ToF32(pcm)
    handles.vad?.acceptWaveform(samples)
    while (handles.vad !== null && handles.vad.isDetected() && !handles.vad.isEmpty()) handles.vad.pop()
    if (handles.recognizer !== null && handles.recognizerStream !== null) {
      handles.recognizerStream.acceptWaveform(SAMPLE_RATE_HZ, samples)
      while (handles.recognizer.isReady(handles.recognizerStream)) handles.recognizer.decode(handles.recognizerStream)
      handles.recognizer.getResult(handles.recognizerStream)
    }
    if (handles.kws !== null && handles.kwsStream !== null) {
      handles.kwsStream.acceptWaveform(SAMPLE_RATE_HZ, samples)
      while (handles.kws.isReady(handles.kwsStream)) handles.kws.decode(handles.kwsStream)
      handles.kws.getResult(handles.kwsStream)
    }
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
      ...bindings,
      files
    },
    transfer: files.map((file) => file.bytes.buffer).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
  }
}

function validateModelBindings(bindings: AuroraVoiceWebModelBindings): readonly AuroraVoiceWebModelFileBinding[] {
  if (!Array.isArray(bindings.files) || bindings.files.length === 0 || bindings.files.length > MAX_MODEL_FILES) throw unavailable('invalid_bindings')
  const seen = new Set<string>()
  return bindings.files.map((file) => {
    if (!isTask(file.task) || !safeId(file.fileId) || !safeVirtualPath(file.virtualPath) || !isSha256(file.sha256)) throw unavailable('invalid_binding')
    if (!(file.bytes instanceof Uint8Array) || file.byteLength !== file.bytes.byteLength || file.byteLength <= 0 || file.byteLength > MAX_MODEL_FILE_BYTES) {
      throw unavailable('invalid_binding')
    }
    if (seen.has(file.virtualPath)) throw unavailable('duplicate_binding')
    seen.add(file.virtualPath)
    return file
  })
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
  return {
    featConfig: { sampleRate: SAMPLE_RATE_HZ, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: '',
        encoder: findPath(files, 'stt', ['encoder']),
        uncachedDecoder: '',
        cachedDecoder: '',
        tokens: ''
      },
      tokens: findPath(files, 'stt', ['tokens']),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: 'moonshine',
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

async function loadClassicSherpaHelpers(urls: readonly string[]): Promise<SherpaHelpers> {
  const helpers: SherpaHelpers = {}
  for (const url of urls) {
    const source = await fetchText(url)
    const loaded = Function(`${source}\nreturn { createVad: typeof createVad === 'function' ? createVad : undefined, createOnlineRecognizer: typeof createOnlineRecognizer === 'function' ? createOnlineRecognizer : undefined, createKws: typeof createKws === 'function' ? createKws : undefined };`)() as SherpaHelpers
    Object.assign(helpers, loaded)
  }
  return helpers
}

async function loadClassicEmscriptenModule(url: string, files: readonly AuroraVoiceWebModelFileBinding[]): Promise<SherpaModule> {
  const source = await fetchText(url)
  const moduleConfig: Record<string, unknown> = {
    noInitialRun: true,
    print: () => undefined,
    printErr: () => undefined,
    locateFile: (path: string) => new URL(path, url).href,
    preRun: [(module: SherpaModule) => {
      for (const file of files) {
        module.FS_createDataFile('/', file.virtualPath.slice(1), new Uint8Array(file.bytes), true, false, true)
      }
    }]
  }
  const module = Function('Module', `${source}\nreturn Module;`)(moduleConfig) as SherpaModule & { calledRun?: boolean; onRuntimeInitialized?: () => void }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(unavailable('engine_timeout')), 30_000)
    module.onRuntimeInitialized = () => {
      clearTimeout(timer)
      resolve()
    }
    if (module.calledRun === true) {
      clearTimeout(timer)
      resolve()
    }
  })
  return module
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw unavailable('asset_unavailable')
  return response.text()
}

function findPath(files: readonly AuroraVoiceWebModelFileBinding[], task: AuroraVoiceWebModelTask, needles: readonly string[]): string {
  return files.find((file) => file.task === task && needles.every((needle) => file.virtualPath.toLowerCase().includes(needle)))?.virtualPath ?? ''
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
