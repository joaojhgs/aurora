import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AuroraVoiceWebRuntimeError,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceTtsAudio,
  type AuroraVoiceTtsRequest,
  type AuroraVoiceInferenceOutput,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebModelBindings,
  type AuroraVoiceWebModelDescriptor,
  type AuroraVoiceWebModelFileBinding,
  type AuroraVoiceWebModelFileReference,
  type AuroraVoiceWebModelFileRole,
  type AuroraVoiceWebModelTask
} from './types.js'
import type { AuroraVoiceWorkerSherpaAssets } from './worker-assets.js'

const SAMPLE_RATE_HZ = 16_000
const MAX_MODEL_FILES = 4096
const MAX_MODEL_FILE_BYTES = 1024 * 1024 * 1024
const MAX_VIRTUAL_PATH_BYTES = 256
const MAX_TTS_TEXT_CHARS = 1_000
const MAX_TTS_SECONDS = 60
const MAX_TTS_SAMPLES = 48_000 * MAX_TTS_SECONDS

export interface AuroraSherpaVoiceEngine {
  initialize(bindings: AuroraVoiceWebModelBindings | undefined): Promise<AuroraVoiceWebCapabilities>
  startSession(): Promise<void>
  pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<AuroraVoiceInferenceOutput | undefined>
  stopSession(): Promise<void>
  synthesizeSpeech(request: AuroraVoiceTtsRequest): Promise<AuroraVoiceTtsAudio>
  cancelTtsGeneration?(generation: number): void
  dispose(): void
}

interface SherpaRuntimeHandles {
  readonly vad: SherpaVad | null
  readonly recognizer: SherpaOfflineRecognizer | null
  readonly recognizerStream: SherpaOfflineStream | null
  readonly kws: SherpaKws | null
  readonly kwsStream: SherpaKwsStream | null
  readonly tts: SherpaOfflineTts | null
  readonly ttsGenerationConfig: Record<string, unknown>
}

interface ValidatedModelBindings {
  readonly files: readonly AuroraVoiceWebModelFileBinding[]
  readonly models: readonly AuroraVoiceWebModelDescriptor[]
}

export interface SherpaModule {
  FS_createDataFile(parent: string, name: string, data: Uint8Array, canRead: boolean, canWrite: boolean, canOwn: boolean): void
  FS_createPath?(parent: string, path: string, canRead: boolean, canWrite: boolean): void
  FS_unlink?(path: string): void
}

type SherpaEmscriptenFactory = (config: Record<string, unknown>) => Promise<SherpaModule> | SherpaModule

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
  inputFinished?(): void
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

interface SherpaOfflineTts {
  readonly sampleRate?: number
  readonly numSpeakers?: number
  generate?(config: unknown): unknown
  generateWithConfig?(text: string, config: unknown): unknown
  free(): void
}

interface SherpaHelpers {
  readonly createVad?: (module: SherpaModule, config: unknown) => SherpaVad
  readonly createOfflineRecognizer?: (module: SherpaModule, config: unknown) => SherpaOfflineRecognizer
  readonly createKws?: (module: SherpaModule, config: unknown) => SherpaKws
  readonly createOfflineTts?: (module: SherpaModule, config: unknown) => SherpaOfflineTts
}

type MutableSherpaHelpers = {
  createVad?: (module: SherpaModule, config: unknown) => SherpaVad
  createOfflineRecognizer?: (module: SherpaModule, config: unknown) => SherpaOfflineRecognizer
  createKws?: (module: SherpaModule, config: unknown) => SherpaKws
  createOfflineTts?: (module: SherpaModule, config: unknown) => SherpaOfflineTts
}

type OfflineRecognizerConstructor = new(config: unknown, module: SherpaModule) => SherpaOfflineRecognizer

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
    const validated = await validateModelBindings(bindings)
    const files = validated.files
    const models = validated.models
    const tasks = new Set(models.map((model) => model.task))
    const assets = this.engineAssets
    const needsVadAsr = tasks.has('vad') || tasks.has('stt')
    const needsKws = tasks.has('kws')
    const needsTts = tasks.has('tts')
    const vadAsrModuleUrl = assets?.vadAsrModuleUrl
    const kwsModuleUrl = assets?.kwsModuleUrl
    const ttsModuleUrl = assets?.ttsModuleUrl
    if (needsVadAsr && !vadAsrModuleUrl) throw unavailable('missing_vad_asr_engine')
    if (needsKws && !kwsModuleUrl) throw unavailable('missing_kws_engine')
    if (needsTts && !ttsModuleUrl) throw unavailable('missing_tts_engine')

    const helperUrls = [
      ...(needsVadAsr ? [assets?.vadHelperUrl, assets?.asrHelperUrl] : []),
      ...(needsKws ? [assets?.kwsHelperUrl] : []),
      ...(needsTts ? [assets?.ttsHelperUrl] : [])
    ].filter((url): url is string => typeof url === 'string')
    const helpers = await this.loadHelpers(helperUrls)
    let vadAsrModule: SherpaModule | null = null
    let kwsModule: SherpaModule | null = null
    let vad: SherpaVad | null = null
    let recognizer: SherpaOfflineRecognizer | null = null
    let recognizerStream: SherpaOfflineStream | null = null
    let kws: SherpaKws | null = null
    let kwsStream: SherpaKwsStream | null = null
    let tts: SherpaOfflineTts | null = null

    try {
      if (needsVadAsr) {
        if (!helpers.createVad && tasks.has('vad')) throw unavailable('missing_vad_helper')
        if (!helpers.createOfflineRecognizer && tasks.has('stt')) throw unavailable('missing_asr_helper')
        vadAsrModule = await this.loadModule(vadAsrModuleUrl!, files.filter((file) => file.task === 'vad' || file.task === 'stt'))
        mountSelectedModelFiles(vadAsrModule, files.filter((file) => file.task === 'vad' || file.task === 'stt'))
        if (tasks.has('vad')) vad = helpers.createVad?.(vadAsrModule, vadConfig(models)) ?? null
        if (tasks.has('stt')) {
          recognizer = helpers.createOfflineRecognizer?.(vadAsrModule, asrConfig(models)) ?? null
          if (recognizer === null || !validOfflineRecognizer(recognizer)) throw unavailable('missing_asr_helper')
          recognizerStream = recognizer.createStream()
          if (!validOfflineStream(recognizerStream)) throw unavailable('missing_asr_helper')
        }
      }
      if (needsKws) {
        if (!helpers.createKws) throw unavailable('missing_kws_helper')
        kwsModule = await this.loadModule(kwsModuleUrl!, files.filter((file) => file.task === 'kws'))
        mountSelectedModelFiles(kwsModule, files.filter((file) => file.task === 'kws'))
        kws = helpers.createKws(kwsModule, kwsConfig(models))
        if (!validKws(kws)) throw unavailable('missing_kws_helper')
        kwsStream = kws.createStream()
        if (!validKwsStream(kwsStream)) throw unavailable('missing_kws_helper')
      }
      if (needsTts) {
        if (!helpers.createOfflineTts) throw unavailable('missing_tts_helper')
        const ttsModule = await this.loadModule(ttsModuleUrl!, files.filter((file) => file.task === 'tts'))
        mountSelectedModelFiles(ttsModule, files.filter((file) => file.task === 'tts'))
        tts = helpers.createOfflineTts(ttsModule, ttsConfig(models))
        if (!validTts(tts)) throw unavailable('missing_tts_helper')
      }
      this.handles = { vad, recognizer, recognizerStream, kws, kwsStream, tts, ttsGenerationConfig: ttsGenerationConfig(models, files) }
      this.capabilities = Object.freeze({
        vad: vad !== null,
        kws: kws !== null,
        stt: recognizer !== null && recognizerStream !== null,
        tts: tts !== null
      })
      return this.capabilities
    } catch (error) {
      freeHandles({ vad, recognizer, recognizerStream, kws, kwsStream, tts, ttsGenerationConfig: {} })
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
    handles?.recognizerStream?.inputFinished?.()
    handles?.kwsStream?.inputFinished()
  }

  async synthesizeSpeech(request: AuroraVoiceTtsRequest): Promise<AuroraVoiceTtsAudio> {
    const handles = this.handles
    const tts = handles?.tts ?? null
    if (handles === null || tts === null || !this.capabilities.tts) throw unavailable('tts_unavailable')
    const text = validateTtsText(request.text)
    const generation = boundedGeneration(request.generation)
    const speed = boundedFloat(request.speed ?? 1.0, 0.25, 4.0, 'invalid_tts_request')
    const speakerId = boundedSpeakerId(request.speakerId)
    const audio = typeof tts.generateWithConfig === 'function'
      ? tts.generateWithConfig(text, { sid: speakerId, speed, ...handles.ttsGenerationConfig })
      : tts.generate?.({ text, sid: speakerId, speed, ...handles.ttsGenerationConfig })
    return Object.freeze(validateTtsAudio(audio, generation))
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
      files,
      models: bindings.models.map((model) => ({
        ...model,
        files: model.files.map((file) => ({ ...file })),
        ...(model.config === undefined ? {} : { config: { ...model.config } })
      }))
    },
    transfer: files.map((file) => file.bytes.buffer).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
  }
}

async function validateModelBindings(bindings: AuroraVoiceWebModelBindings): Promise<ValidatedModelBindings> {
  if (!Array.isArray(bindings.files) || bindings.files.length === 0 || bindings.files.length > MAX_MODEL_FILES) throw unavailable('invalid_bindings')
  if (!Array.isArray(bindings.models) || bindings.models.length === 0 || bindings.models.length > MAX_MODEL_FILES) throw unavailable('invalid_model_metadata')
  const seenVirtualPaths = new Set<string>()
  const seenFileIds = new Set<string>()
  const files = bindings.files.map((file) => {
    if (!isTask(file.task) || !safeId(file.fileId) || !safeVirtualPath(file.virtualPath) || !isSha256(file.sha256)) throw unavailable('invalid_binding')
    if (!(file.bytes instanceof Uint8Array) || file.byteLength !== file.bytes.byteLength || file.byteLength <= 0 || file.byteLength > MAX_MODEL_FILE_BYTES) {
      throw unavailable('invalid_binding')
    }
    if (seenVirtualPaths.has(file.virtualPath) || seenFileIds.has(file.fileId)) throw unavailable('duplicate_binding')
    seenVirtualPaths.add(file.virtualPath)
    seenFileIds.add(file.fileId)
    return file
  })
  for (const file of files) {
    if (await sha256Hex(file.bytes) !== file.sha256) throw unavailable('model_hash_mismatch')
  }
  const fileIds = new Map(files.map((file) => [file.fileId, file]))
  const models = bindings.models.map((model) => validateModelDescriptor(model, fileIds, files))
  return { files, models }
}

function vadConfig(models: readonly AuroraVoiceWebModelDescriptor[]): unknown {
  const model = requireModel(models, 'vad')
  return {
    sileroVad: {
      model: requireRole(model, 'model'),
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

function asrConfig(models: readonly AuroraVoiceWebModelDescriptor[]): unknown {
  const model = requireModel(models, 'stt')
  const language = model.config?.language ?? ''
  return {
    featConfig: { sampleRate: SAMPLE_RATE_HZ, featureDim: 80 },
    modelConfig: {
      moonshine: {
        preprocessor: '',
        encoder: model.family === 'moonshine' ? requireRole(model, 'encoder') : '',
        uncachedDecoder: '',
        cachedDecoder: '',
        mergedDecoder: model.family === 'moonshine' ? requireRole(model, 'mergedDecoder') : ''
      },
      whisper: {
        encoder: model.family === 'whisper' ? requireRole(model, 'encoder') : '',
        decoder: model.family === 'whisper' ? requireRole(model, 'decoder') : '',
        language,
        task: model.config?.task ?? 'transcribe',
        tailPaddings: -1
      },
      senseVoice: {
        model: model.family === 'sense-voice' ? requireRole(model, 'model') : '',
        language,
        useInverseTextNormalization: 1
      },
      tokens: requireRole(model, 'tokens'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: sttModelType(model),
      modelingUnit: model.family === 'moonshine' ? '' : 'bpe',
      bpeVocab: ''
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: 1
  }
}

function kwsConfig(models: readonly AuroraVoiceWebModelDescriptor[]): unknown {
  const model = requireModel(models, 'kws')
  return {
    featConfig: { samplingRate: SAMPLE_RATE_HZ, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: requireRole(model, 'encoder'),
        decoder: requireRole(model, 'decoder'),
        joiner: requireRole(model, 'joiner')
      },
      tokens: requireRole(model, 'tokens'),
      provider: 'cpu',
      modelType: '',
      numThreads: 1,
      debug: 0,
      modelingUnit: 'bpe',
      bpeVocab: optionalRole(model, 'bpeVocab')
    },
    maxActivePaths: 4,
    numTrailingBlanks: 1,
    keywordsScore: model.config?.keywordsScore ?? 1.0,
    keywordsThreshold: model.config?.keywordsThreshold ?? 0.25,
    keywords: model.config?.keywords ?? ''
  }
}

function ttsConfig(models: readonly AuroraVoiceWebModelDescriptor[]): unknown {
  const model = requireModel(models, 'tts')
  const vits = {
    model: model.family === 'piper' ? requireRole(model, 'model') : '',
    lexicon: model.family === 'piper' ? optionalRole(model, 'lexicon') : '',
    tokens: model.family === 'piper' ? requireRole(model, 'tokens') : '',
    dataDir: model.family === 'piper' ? optionalRole(model, 'dataDir') : '',
    noiseScale: model.config?.noiseScale ?? 0.667,
    noiseScaleW: model.config?.noiseScaleW ?? 0.8,
    lengthScale: model.config?.lengthScale ?? 1.0
  }
  const pocket = {
    lmFlow: model.family === 'pockettts' ? requireRole(model, 'lmFlow') : '',
    lmMain: model.family === 'pockettts' ? requireRole(model, 'lmMain') : '',
    encoder: model.family === 'pockettts' ? requireRole(model, 'encoder') : '',
    decoder: model.family === 'pockettts' ? requireRole(model, 'decoder') : '',
    textConditioner: model.family === 'pockettts' ? requireRole(model, 'textConditioner') : '',
    vocabJson: model.family === 'pockettts' ? requireRole(model, 'vocabJson') : '',
    tokenScoresJson: model.family === 'pockettts' ? requireRole(model, 'tokenScoresJson') : '',
    voiceEmbeddingCacheCapacity: 50
  }
  return {
    offlineTtsModelConfig: {
      offlineTtsVitsModelConfig: vits,
      offlineTtsMatchaModelConfig: {
        acousticModel: '',
        vocoder: '',
        lexicon: '',
        tokens: '',
        dataDir: '',
        noiseScale: 0.667,
        lengthScale: 1.0
      },
      offlineTtsKokoroModelConfig: { model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1.0, lexicon: '', lang: '' },
      offlineTtsKittenModelConfig: { model: '', voices: '', tokens: '', dataDir: '', lengthScale: 1.0 },
      offlineTtsZipVoiceModelConfig: {
        tokens: '',
        encoder: '',
        decoder: '',
        vocoder: '',
        dataDir: '',
        lexicon: '',
        featScale: 0.1,
        tShift: 0.5,
        targetRMS: 0.1,
        guidanceScale: 1.0
      },
      offlineTtsPocketModelConfig: pocket,
      numThreads: 1,
      debug: 0,
      provider: 'cpu'
    },
    ruleFsts: '',
    ruleFars: '',
    maxNumSentences: 1
  }
}

function ttsGenerationConfig(
  models: readonly AuroraVoiceWebModelDescriptor[],
  files: readonly AuroraVoiceWebModelFileBinding[]
): Record<string, unknown> {
  const matches = models.filter((model) => model.task === 'tts')
  if (matches.length === 0) return {}
  const model = requireModel(models, 'tts')
  if (model.family !== 'pockettts') return {}
  const configuredRate = model.config?.referenceSampleRateHz
  if (configuredRate === undefined) throw unavailable('missing_model_role')
  const referencePath = requireRole(model, 'referenceAudio')
  const referenceFile = files.find((file) => file.task === 'tts' && file.virtualPath === referencePath)
  if (referenceFile === undefined) throw unavailable('missing_model_role')
  const decoded = decodePocketReferenceWav(referenceFile.bytes)
  const referenceText = model.config?.referenceText?.trim()
  return {
    referenceAudio: decoded.samples,
    referenceSampleRate: decoded.sampleRateHz || configuredRate,
    extra: { max_frames: model.config?.maxFrames ?? 55 },
    ...(referenceText ? { referenceText } : {}),
  }
}

function decodePocketReferenceWav(bytes: Uint8Array): { readonly samples: Float32Array; readonly sampleRateHz: number } {
  if (bytes.byteLength < 44) throw unavailable('invalid_model_metadata')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw unavailable('invalid_model_metadata')
  let offset = 12
  let audioFormat = 0
  let channelCount = 0
  let sampleRateHz = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(offset, 4)
    const chunkLength = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8
    if (chunkLength > bytes.byteLength - chunkDataOffset) throw unavailable('invalid_model_metadata')
    if (chunkId === 'fmt ') {
      if (chunkLength < 16) throw unavailable('invalid_model_metadata')
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
  if (
    audioFormat !== 1 ||
    channelCount !== 1 ||
    bitsPerSample !== 16 ||
    dataOffset < 0 ||
    dataLength < 2 ||
    dataLength % 2 !== 0 ||
    !Number.isSafeInteger(sampleRateHz) ||
    sampleRateHz < 8_000 ||
    sampleRateHz > 48_000
  ) {
    throw unavailable('invalid_model_metadata')
  }
  const pcm = bytes.subarray(dataOffset, dataOffset + dataLength)
  const pcmView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = new Float32Array(pcm.byteLength / 2)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = pcmView.getInt16(index * 2, true)
    samples[index] = sample < 0 ? sample / 32768 : sample / 32767
  }
  return { samples, sampleRateHz }
}

async function loadControlledSherpaHelpers(urls: readonly string[], fetchImpl: typeof fetch): Promise<SherpaHelpers> {
  const helpers: MutableSherpaHelpers = {}
  for (const url of urls) await fetchNeutralEngineSource(url, fetchImpl)
  for (const url of urls) {
    const module = await import(/* webpackIgnore: true */ /* @vite-ignore */ url) as Partial<SherpaHelpers> & { readonly OfflineRecognizer?: unknown }
    if (typeof module.createVad === 'function') helpers.createVad = module.createVad
    if (typeof module.createOfflineRecognizer === 'function') helpers.createOfflineRecognizer = module.createOfflineRecognizer
    if (helpers.createOfflineRecognizer === undefined && typeof module.OfflineRecognizer === 'function') {
      const OfflineRecognizer = module.OfflineRecognizer as OfflineRecognizerConstructor
      helpers.createOfflineRecognizer = (sherpaModule, config) => new OfflineRecognizer(config, sherpaModule)
    }
    if (typeof module.createKws === 'function') helpers.createKws = module.createKws
    if (typeof module.createOfflineTts === 'function') helpers.createOfflineTts = module.createOfflineTts
  }
  return helpers
}

async function loadControlledSherpaModule(url: string, _files: readonly AuroraVoiceWebModelFileBinding[], fetchImpl: typeof fetch): Promise<SherpaModule> {
  await fetchNeutralEngineSource(url, fetchImpl)
  const imported = await import(/* webpackIgnore: true */ /* @vite-ignore */ url) as { readonly default?: unknown }
  if (typeof imported.default !== 'function') throw unavailable('safe_sherpa_loader_missing')
  const wasmUrl = wasmUrlForEngineModule(url)
  await assertFetchableNeutralWasm(wasmUrl, fetchImpl)
  return imported.default({
    noInitialRun: true,
    print: () => undefined,
    printErr: () => undefined,
    locateFile: (path: string) => {
      if (path.endsWith('.data')) throw unavailable('bundled_data_rejected')
      if (path.endsWith('.wasm')) return wasmUrl
      return new URL(path, url).href
    }
  }) as Promise<SherpaModule>
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

function wasmUrlForEngineModule(url: string): string {
  const parsed = new URL(url)
  if (!parsed.pathname.endsWith('.js')) throw unavailable('asset_unavailable')
  parsed.pathname = `${parsed.pathname.slice(0, -3)}.wasm`
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

async function assertFetchableNeutralWasm(url: string, fetchImpl: typeof fetch): Promise<void> {
  const parsed = new URL(url)
  if (!parsed.pathname.endsWith('.wasm') || parsed.pathname.endsWith('.data')) throw unavailable('asset_unavailable')
  const response = await fetchImpl(url, { credentials: 'same-origin' })
  if (!response.ok) throw unavailable('asset_unavailable')
}

const BUNDLED_DATA_PATTERNS = [
  /\.data(?:["'`)\s?&]|$)/i,
  /remote_package_size/i,
  /getPreloadedPackage/i,
  /expectedDataFileDownloads/i,
  /PACKAGE_NAME/i
]

function mountSelectedModelFiles(module: SherpaModule, files: readonly AuroraVoiceWebModelFileBinding[]): void {
  const createdDirs = new Set<string>(['/'])
  for (const file of files) {
    const name = file.virtualPath.slice(1)
    const parent = name.split('/').slice(0, -1).join('/')
    if (parent !== '') createParentDirectories(module, parent, createdDirs)
    module.FS_createDataFile('/', name, new Uint8Array(file.bytes), true, false, true)
  }
}

function createParentDirectories(module: SherpaModule, path: string, createdDirs: Set<string>): void {
  const parts = path.split('/').filter(Boolean)
  let current = ''
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`
    if (createdDirs.has(current)) continue
    module.FS_createPath?.('/', current, true, true)
    createdDirs.add(current)
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw unavailable('crypto_unavailable')
  const digest = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function validateModelDescriptor(
  model: AuroraVoiceWebModelDescriptor,
  fileIds: ReadonlyMap<string, AuroraVoiceWebModelFileBinding>,
  files: readonly AuroraVoiceWebModelFileBinding[]
): AuroraVoiceWebModelDescriptor {
  if (!isTask(model.task) || !isFamily(model.family) || !isKind(model.kind) || !Array.isArray(model.files) || model.files.length === 0) {
    throw unavailable('invalid_model_metadata')
  }
  if (
    (model.task === 'vad' && (model.kind !== 'vad' || model.family !== 'silero-vad')) ||
    (model.task === 'kws' && (model.kind !== 'keyword-spotter' || model.family !== 'sherpa-kws-transducer')) ||
    (model.task === 'stt' && model.kind !== 'offline-asr') ||
    (model.task === 'tts' && (model.kind !== 'offline-tts' || !(model.family === 'piper' || model.family === 'pockettts')))
  ) throw unavailable('invalid_model_metadata')
  const refs = model.files.map((ref) => validateModelFileReference(ref, model.task, fileIds, files))
  requireRoles(model, refs)
  return Object.freeze({
    task: model.task,
    family: model.family,
    kind: model.kind,
    files: refs,
    ...(model.config === undefined ? {} : { config: validateModelConfig(model.config) })
  })
}

function validateModelFileReference(
  ref: AuroraVoiceWebModelFileReference,
  task: AuroraVoiceWebModelTask,
  fileIds: ReadonlyMap<string, AuroraVoiceWebModelFileBinding>,
  files: readonly AuroraVoiceWebModelFileBinding[]
): AuroraVoiceWebModelFileReference {
  if (!isRole(ref.role) || !safeId(ref.fileId) || !safeVirtualPath(ref.virtualPath)) throw unavailable('invalid_model_metadata')
  if (ref.role === 'dataDir') {
    if (!files.some((file) => file.task === task && file.virtualPath.startsWith(`${ref.virtualPath}/`))) throw unavailable('invalid_model_metadata')
    return Object.freeze({ role: ref.role, fileId: ref.fileId, virtualPath: ref.virtualPath })
  }
  const file = fileIds.get(ref.fileId)
  if (file === undefined || file.task !== task || file.virtualPath !== ref.virtualPath) throw unavailable('invalid_model_metadata')
  return Object.freeze({ role: ref.role, fileId: ref.fileId, virtualPath: ref.virtualPath })
}

function validateModelConfig(config: NonNullable<AuroraVoiceWebModelDescriptor['config']>): NonNullable<AuroraVoiceWebModelDescriptor['config']> {
  if (config.language !== undefined && !/^[A-Za-z0-9_-]{0,32}$/.test(config.language)) throw unavailable('invalid_model_metadata')
  if (config.task !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(config.task)) throw unavailable('invalid_model_metadata')
  if (config.keywords !== undefined && config.keywords.length > 4096) throw unavailable('invalid_model_metadata')
  if (config.keywordsScore !== undefined && (!Number.isFinite(config.keywordsScore) || config.keywordsScore < 0)) throw unavailable('invalid_model_metadata')
  if (config.keywordsThreshold !== undefined && (!Number.isFinite(config.keywordsThreshold) || config.keywordsThreshold < 0)) throw unavailable('invalid_model_metadata')
  if (config.voiceId !== undefined && !/^[A-Za-z0-9_.:-]{1,96}$/.test(config.voiceId)) throw unavailable('invalid_model_metadata')
  if (config.speakerId !== undefined && (!Number.isSafeInteger(config.speakerId) || config.speakerId < 0 || config.speakerId > 10_000)) {
    throw unavailable('invalid_model_metadata')
  }
  if (config.speed !== undefined) boundedFloat(config.speed, 0.25, 4.0, 'invalid_model_metadata')
  if (config.noiseScale !== undefined) boundedFloat(config.noiseScale, 0, 10, 'invalid_model_metadata')
  if (config.noiseScaleW !== undefined) boundedFloat(config.noiseScaleW, 0, 10, 'invalid_model_metadata')
  if (config.lengthScale !== undefined) boundedFloat(config.lengthScale, 0.1, 10, 'invalid_model_metadata')
  if (config.referenceText !== undefined && (typeof config.referenceText !== 'string' || config.referenceText.length > 1_000)) {
    throw unavailable('invalid_model_metadata')
  }
  if (config.referenceSampleRateHz !== undefined && (!Number.isSafeInteger(config.referenceSampleRateHz) || config.referenceSampleRateHz < 8_000 || config.referenceSampleRateHz > 48_000)) {
    throw unavailable('invalid_model_metadata')
  }
  if (config.maxFrames !== undefined && (!Number.isSafeInteger(config.maxFrames) || config.maxFrames < 1 || config.maxFrames > 500)) {
    throw unavailable('invalid_model_metadata')
  }
  return Object.freeze({ ...config })
}

function requireRoles(model: AuroraVoiceWebModelDescriptor, refs: readonly AuroraVoiceWebModelFileReference[]): void {
  const roles = new Set(refs.map((ref) => ref.role))
  const requireEvery = (required: readonly AuroraVoiceWebModelFileRole[]) => {
    if (!required.every((role) => roles.has(role))) throw unavailable('missing_model_role')
  }
  if (model.family === 'silero-vad') requireEvery(['model'])
  if (model.family === 'moonshine') requireEvery(['encoder', 'mergedDecoder', 'tokens'])
  if (model.family === 'whisper') requireEvery(['encoder', 'decoder', 'tokens'])
  if (model.family === 'sense-voice') requireEvery(['model', 'tokens'])
  if (model.family === 'sherpa-kws-transducer') requireEvery(['encoder', 'decoder', 'joiner', 'tokens'])
  if (model.family === 'piper') requireEvery(['model', 'tokens', 'dataDir'])
  if (model.family === 'pockettts') requireEvery(['lmFlow', 'lmMain', 'encoder', 'decoder', 'textConditioner', 'vocabJson', 'tokenScoresJson', 'referenceAudio'])
}

function requireModel(models: readonly AuroraVoiceWebModelDescriptor[], task: AuroraVoiceWebModelTask): AuroraVoiceWebModelDescriptor {
  const matches = models.filter((model) => model.task === task)
  if (matches.length !== 1 || matches[0] === undefined) throw unavailable('invalid_model_metadata')
  return matches[0]
}

function requireRole(model: AuroraVoiceWebModelDescriptor, role: AuroraVoiceWebModelFileRole): string {
  const ref = model.files.find((file) => file.role === role)
  if (ref === undefined) throw unavailable('missing_model_role')
  return ref.virtualPath
}

function optionalRole(model: AuroraVoiceWebModelDescriptor, role: AuroraVoiceWebModelFileRole): string {
  return model.files.find((file) => file.role === role)?.virtualPath ?? ''
}

function validOfflineRecognizer(recognizer: SherpaOfflineRecognizer): boolean {
  return typeof recognizer.createStream === 'function' &&
    typeof recognizer.decode === 'function' &&
    typeof recognizer.getResult === 'function' &&
    typeof recognizer.free === 'function'
}

function validOfflineStream(stream: SherpaOfflineStream): boolean {
  return typeof stream.acceptWaveform === 'function' && typeof stream.free === 'function'
}

function validKws(kws: SherpaKws): boolean {
  return typeof kws.createStream === 'function' &&
    typeof kws.isReady === 'function' &&
    typeof kws.decode === 'function' &&
    typeof kws.getResult === 'function' &&
    typeof kws.reset === 'function' &&
    typeof kws.free === 'function'
}

function validKwsStream(stream: SherpaKwsStream): boolean {
  return typeof stream.acceptWaveform === 'function' && typeof stream.inputFinished === 'function' && typeof stream.free === 'function'
}

function validTts(tts: SherpaOfflineTts): boolean {
  return (typeof tts.generate === 'function' || typeof tts.generateWithConfig === 'function') &&
    typeof tts.free === 'function'
}

function sttModelType(model: AuroraVoiceWebModelDescriptor): string {
  if (model.family === 'sense-voice') return 'sense-voice'
  if (model.family === 'whisper') return 'whisper'
  if (model.family === 'moonshine') return 'moonshine'
  throw unavailable('invalid_model_metadata')
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
  try { handles.tts?.free() } catch {}
}

function hasAnyCapability(capabilities: AuroraVoiceWebCapabilities): boolean {
  return capabilities.vad || capabilities.kws || capabilities.stt || capabilities.tts
}

function pcmI16ToF32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let index = 0; index < pcm.length; index += 1) out[index] = Math.max(-1, Math.min(1, pcm[index]! / 32768))
  return out
}

function validateTtsText(text: string): string {
  if (typeof text !== 'string') throw unavailable('invalid_tts_request')
  const normalized = text.trim()
  if (normalized.length === 0 || normalized.length > MAX_TTS_TEXT_CHARS) throw unavailable('invalid_tts_request')
  return normalized
}

function boundedGeneration(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isSafeInteger(value) || value < 1) throw unavailable('invalid_tts_request')
  return value
}

function boundedSpeakerId(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) throw unavailable('invalid_tts_request')
  return value
}

function boundedFloat(value: number, min: number, max: number, code: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw unavailable(code)
  return value
}

function validateTtsAudio(value: unknown, generation: number): AuroraVoiceTtsAudio {
  if (typeof value !== 'object' || value === null) throw unavailable('tts_generation_failed')
  const sampleRate = (value as { sampleRate?: unknown }).sampleRate
  const samples = (value as { samples?: unknown }).samples
  if (!Number.isSafeInteger(sampleRate) || typeof sampleRate !== 'number' || sampleRate < 8_000 || sampleRate > 48_000) {
    throw unavailable('tts_generation_failed')
  }
  if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > MAX_TTS_SAMPLES) {
    throw unavailable('tts_generation_failed')
  }
  const pcm = new Int16Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!
    if (!Number.isFinite(sample)) throw unavailable('tts_generation_failed')
    const clamped = Math.max(-1, Math.min(1, sample))
    pcm[index] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
  }
  return {
    generation,
    sampleRateHz: sampleRate,
    channels: 1,
    sampleCount: pcm.length,
    durationMs: Math.ceil((pcm.length / sampleRate) * 1_000),
    pcm,
    redacted: true
  }
}

function isTask(value: unknown): value is AuroraVoiceWebModelTask {
  return value === 'vad' || value === 'kws' || value === 'stt' || value === 'tts'
}

function isFamily(value: unknown): value is AuroraVoiceWebModelDescriptor['family'] {
  return value === 'silero-vad' ||
    value === 'moonshine' ||
    value === 'whisper' ||
    value === 'sense-voice' ||
    value === 'sherpa-kws-transducer' ||
    value === 'piper' ||
    value === 'pockettts'
}

function isKind(value: unknown): value is AuroraVoiceWebModelDescriptor['kind'] {
  return value === 'vad' || value === 'offline-asr' || value === 'keyword-spotter' || value === 'offline-tts'
}

function isRole(value: unknown): value is AuroraVoiceWebModelFileRole {
  return value === 'model' ||
    value === 'encoder' ||
    value === 'decoder' ||
    value === 'mergedDecoder' ||
    value === 'tokens' ||
    value === 'joiner' ||
    value === 'keywords' ||
    value === 'bpeVocab' ||
    value === 'lexicon' ||
    value === 'dataDir' ||
    value === 'lmFlow' ||
    value === 'lmMain' ||
    value === 'textConditioner' ||
    value === 'vocabJson' ||
    value === 'tokenScoresJson' ||
    value === 'referenceAudio'
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
