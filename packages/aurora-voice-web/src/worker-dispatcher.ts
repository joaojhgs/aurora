import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  AuroraVoiceWebRuntimeError,
  type AuroraCapturedAudio,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceTtsAudio,
  type AuroraVoiceInferenceOutput,
  type AuroraVoiceTurnFinishOutcome,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebModelBindings,
  type AuroraVoiceWebSession,
  type AuroraVoiceWorkerCommand,
  type AuroraVoiceWorkerRequestEnvelope,
  type AuroraVoiceWorkerResponse,
  type AuroraVoiceWorkerResponseEnvelope
} from './types.js'

const MAX_CAPTURED_AUDIO_SAMPLES = 16_000 * 60
const MAX_TTS_AUDIO_SAMPLES = 48_000 * 60
const MAX_TTS_TEXT_CHARS = 1_000

export interface AuroraVoiceWasmBridge {
  initialize?(modelBindings: AuroraVoiceWebModelBindings | undefined): Promise<{ readonly capabilities?: AuroraVoiceWebCapabilities }>
  startSession(session: AuroraVoiceWebSession): Promise<void>
  pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<AuroraVoiceInferenceOutput | undefined>
  stopSession(sessionId: string, generation: number): Promise<AuroraCapturedAudio>
  finishTurn(sessionId: string, generation: number, outcome: AuroraVoiceTurnFinishOutcome): Promise<void>
  synthesizeSpeech?(request: { readonly text: string; readonly generation: number; readonly voiceId?: string; readonly speakerId?: number; readonly speed?: number }): Promise<AuroraVoiceTtsAudio>
  cancelGeneration(sessionId: string | null, generation: number, reason: string): Promise<void>
  snapshot(): Promise<{ readonly capabilities?: AuroraVoiceWebCapabilities }>
}

export interface AuroraVoiceWorkerDispatcherPort {
  postMessage(message: AuroraVoiceWorkerResponseEnvelope, transfer?: readonly Transferable[]): void
}

export class AuroraVoiceWorkerDispatcher {
  private initialized = false
  private activeSession: AuroraVoiceWebSession | null = null
  private pendingStoppedSession: AuroraVoiceWebSession | null = null
  private nextSequence = 0
  private commandChain: Promise<void> = Promise.resolve()

  constructor(private readonly bridge: AuroraVoiceWasmBridge, private readonly port: AuroraVoiceWorkerDispatcherPort) {}

  async handleMessage(data: unknown): Promise<void> {
    const request = validateRequestEnvelope(data)
    if (request === null) return
    const run = this.commandChain.then(
      () => this.handleValidRequest(request),
      () => this.handleValidRequest(request)
    )
    this.commandChain = run.then(
      () => undefined,
      () => undefined
    )
    await run
  }

  private async handleValidRequest(request: AuroraVoiceWorkerRequestEnvelope): Promise<void> {
    try {
      const response = await this.dispatch(request.command)
      this.reply(request.requestId, response, transferForResponse(response))
    } catch (error) {
      this.reply(request.requestId, {
        type: 'reject',
        sessionId: safeSessionIdFor(request.command),
        generation: safeGenerationFor(request.command),
        sequence: safeSequenceFor(request.command),
        reason: safeWorkerRejectReason(error)
      })
    }
  }

  private async dispatch(command: AuroraVoiceWorkerCommand): Promise<AuroraVoiceWorkerResponse> {
    assertValidCommand(command)
    switch (command.type) {
      case 'init':
        if (command.protocolVersion !== AURORA_VOICE_WORKER_PROTOCOL_VERSION) throw new Error('version')
        {
          const snapshot = this.bridge.initialize === undefined
            ? await this.bridge.snapshot()
            : await this.bridge.initialize(command.modelBindings)
          const capabilities = snapshot.capabilities ?? AURORA_VOICE_WEB_DEFAULT_CAPABILITIES
          assertCapabilities(capabilities)
          this.initialized = true
          return {
            type: 'ready',
            protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
            capabilities,
            maxFrameSamples: command.maxFrameSamples,
            maxQueuedBytes: command.maxQueuedBytes
          }
        }
      case 'start':
        this.requireInitialized()
        if (this.activeSession !== null || this.pendingStoppedSession !== null) throw new Error('overlap')
        await this.bridge.startSession(command.session)
        this.activeSession = command.session
        this.nextSequence = 0
        return { type: 'ack', sessionId: command.session.sessionId, generation: command.session.generation, sequence: null }
      case 'audio_frame':
        this.requireActive(command.frame.sessionId, command.frame.generation)
        if (!(command.pcm instanceof Int16Array)) throw new Error('pcm')
        if (command.frame.byteLength !== command.pcm.byteLength || command.frame.sampleCount !== command.pcm.length) throw new Error('shape')
        if (command.frame.sampleRateHz !== 16_000 || command.frame.channels !== 1) throw new Error('audio')
        if (command.frame.discontinuity) {
          this.nextSequence = command.frame.sequence
        } else if (command.frame.sequence !== this.nextSequence) {
          throw new Error('sequence')
        }
        const inference = await this.bridge.pushPcmI16(command.frame, command.pcm)
        if (inference !== undefined && !validInferenceOutput(inference, command.frame.sequence)) throw new Error('inference')
        this.nextSequence = command.frame.sequence + 1
        return {
          type: 'ack',
          sessionId: command.frame.sessionId,
          generation: command.frame.generation,
          sequence: command.frame.sequence,
          ...(inference !== undefined ? { inference } : {})
        }
      case 'stop': {
        this.requireActive(command.sessionId, command.generation)
        const audio = boundedCapturedAudio(await this.bridge.stopSession(command.sessionId, command.generation), command.sessionId, command.generation)
        this.pendingStoppedSession = this.activeSession
        this.activeSession = null
        this.nextSequence = 0
        return { type: 'stop_result', sessionId: command.sessionId, generation: command.generation, capturedAudio: audio }
      }
      case 'finish_turn': {
        const pending = this.pendingStoppedSession
        if (
          pending === null ||
          command.sessionId !== pending.sessionId ||
          command.generation !== pending.generation
        ) {
          return { type: 'reject', sessionId: command.sessionId, generation: command.generation, sequence: null, reason: 'stale_finish' }
        }
        await this.bridge.finishTurn(command.sessionId, command.generation, command.outcome)
        this.pendingStoppedSession = null
        return { type: 'ack', sessionId: command.sessionId, generation: command.generation, sequence: null }
      }
      case 'synthesize_tts': {
        this.requireInitialized()
        if (this.bridge.synthesizeSpeech === undefined) throw new Error('tts_unavailable')
        const audio = boundedTtsAudio(await this.bridge.synthesizeSpeech(command), command.generation)
        return { type: 'tts_result', generation: command.generation, audio }
      }
      case 'cancel':
        if (command.sessionId === null) {
          await this.bridge.cancelGeneration(null, command.generation, 'cancelled')
          return { type: 'ack', sessionId: '', generation: command.generation, sequence: null }
        }
        if (this.activeSession !== null && command.sessionId === this.activeSession.sessionId && command.generation === this.activeSession.generation) {
          await this.bridge.cancelGeneration(command.sessionId, command.generation, 'cancelled')
          this.activeSession = null
          this.nextSequence = 0
          return { type: 'ack', sessionId: command.sessionId ?? '', generation: command.generation, sequence: null }
        }
        if (this.pendingStoppedSession !== null && command.sessionId === this.pendingStoppedSession.sessionId && command.generation === this.pendingStoppedSession.generation) {
          await this.bridge.finishTurn(command.sessionId, command.generation, 'abandoned')
          this.pendingStoppedSession = null
          this.nextSequence = 0
          return { type: 'ack', sessionId: command.sessionId ?? '', generation: command.generation, sequence: null }
        }
        {
          return { type: 'reject', sessionId: command.sessionId, generation: command.generation, sequence: null, reason: 'stale_cancel' }
        }
      case 'shutdown':
        if (this.activeSession !== null && this.activeSession.generation === command.generation) {
          await this.bridge.cancelGeneration(this.activeSession.sessionId, command.generation, 'shutdown')
        } else if (this.pendingStoppedSession !== null && this.pendingStoppedSession.generation === command.generation) {
          await this.bridge.cancelGeneration(this.pendingStoppedSession.sessionId, command.generation, 'shutdown')
        } else {
          await this.bridge.cancelGeneration(null, command.generation, 'shutdown')
        }
        this.activeSession = null
        this.pendingStoppedSession = null
        this.nextSequence = 0
        return { type: 'ack', sessionId: '', generation: command.generation, sequence: null }
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('not_ready')
  }

  private requireActive(sessionId: string, generation: number): void {
    this.requireInitialized()
    if (this.activeSession?.sessionId !== sessionId || this.activeSession.generation !== generation) {
      throw new Error('stale')
    }
  }

  private reply(requestId: number, response: AuroraVoiceWorkerResponse, transfer: readonly Transferable[] = []): void {
    this.port.postMessage(Object.freeze({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId,
      response
    }), transfer)
  }
}

function safeWorkerRejectReason(error: unknown): string {
  if (
    error instanceof AuroraVoiceWebRuntimeError &&
    /^[a-z_]{1,48}$/.test(error.code)
  ) {
    return error.code
  }
  return 'worker_rejected'
}

function validateRequestEnvelope(data: unknown): AuroraVoiceWorkerRequestEnvelope | null {
  if (typeof data !== 'object' || data === null) return null
  const envelope = data as Partial<AuroraVoiceWorkerRequestEnvelope>
  const requestId = envelope.requestId
  if (
    envelope.protocolVersion !== AURORA_VOICE_WORKER_PROTOCOL_VERSION ||
    !Number.isSafeInteger(requestId) ||
    requestId === undefined ||
    requestId < 1 ||
    typeof envelope.command !== 'object' ||
    envelope.command === null
  ) {
    return null
  }
  return envelope as AuroraVoiceWorkerRequestEnvelope
}

function boundedCapturedAudio(audio: AuroraCapturedAudio, sessionId: string, generation: number): AuroraCapturedAudio {
  if (
    audio.sessionId !== sessionId ||
    audio.generation !== generation ||
    audio.sampleRateHz !== 16_000 ||
    audio.channels !== 1 ||
    audio.sampleCount !== audio.pcm.length ||
    audio.sampleCount > MAX_CAPTURED_AUDIO_SAMPLES ||
    audio.durationMs > 60_000 ||
    audio.redacted !== true
  ) {
    throw new Error('audio')
  }
  return Object.freeze({ ...audio, pcm: new Int16Array(audio.pcm) })
}

function boundedTtsAudio(audio: AuroraVoiceTtsAudio, generation: number): AuroraVoiceTtsAudio {
  if (
    audio.generation !== generation ||
    !Number.isSafeInteger(audio.sampleRateHz) ||
    audio.sampleRateHz < 8_000 ||
    audio.sampleRateHz > 48_000 ||
    audio.channels !== 1 ||
    audio.sampleCount !== audio.pcm.length ||
    audio.sampleCount <= 0 ||
    audio.sampleCount > MAX_TTS_AUDIO_SAMPLES ||
    audio.durationMs <= 0 ||
    audio.durationMs > 60_000 ||
    audio.redacted !== true
  ) {
    throw new Error('tts_audio')
  }
  return Object.freeze({ ...audio, pcm: new Int16Array(audio.pcm) })
}

function transferForResponse(response: AuroraVoiceWorkerResponse): readonly Transferable[] {
  if (response.type === 'stop_result') return [response.capturedAudio.pcm.buffer]
  if (response.type === 'tts_result') return [response.audio.pcm.buffer]
  return []
}

function assertValidCommand(command: unknown): asserts command is AuroraVoiceWorkerCommand {
  if (typeof command !== 'object' || command === null) throw new Error('command')
  const type = (command as { type?: unknown }).type
  if (typeof type !== 'string') throw new Error('command')
  switch (type) {
    case 'init': {
      const init = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'init' }>>
      if (
        init.protocolVersion !== AURORA_VOICE_WORKER_PROTOCOL_VERSION ||
        !safePositiveInteger(init.maxFrameSamples) ||
        !safePositiveInteger(init.maxQueuedBytes) ||
        !validModelBindings(init.modelBindings)
      ) throw new Error('command')
      return
    }
    case 'start': {
      const start = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'start' }>>
      if (!validSession(start.session) || !validCapabilities(start.capabilities)) throw new Error('command')
      return
    }
    case 'audio_frame': {
      const audio = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'audio_frame' }>>
      if (!validFrame(audio.frame) || !(audio.pcm instanceof Int16Array)) throw new Error('command')
      return
    }
    case 'stop': {
      const stop = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'stop' }>>
      if (!safeString(stop.sessionId) || !safePositiveInteger(stop.generation)) throw new Error('command')
      return
    }
    case 'finish_turn': {
      const finish = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'finish_turn' }>>
      if (!safeString(finish.sessionId) || !safePositiveInteger(finish.generation) || !validFinishOutcome(finish.outcome)) {
        throw new Error('command')
      }
      return
    }
    case 'synthesize_tts': {
      const synthesize = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'synthesize_tts' }>>
      if (
        !safePositiveInteger(synthesize.generation) ||
        !validTtsText(synthesize.text) ||
        !(synthesize.voiceId === undefined || safeString(synthesize.voiceId)) ||
        !(synthesize.speakerId === undefined || safeNonNegativeInteger(synthesize.speakerId)) ||
        !(synthesize.speed === undefined || validTtsSpeed(synthesize.speed))
      ) throw new Error('command')
      return
    }
    case 'cancel': {
      const cancel = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'cancel' }>>
      if (!(cancel.sessionId === null || safeString(cancel.sessionId)) || !safePositiveInteger(cancel.generation) || !safeString(cancel.reason)) {
        throw new Error('command')
      }
      return
    }
    case 'shutdown': {
      const shutdown = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'shutdown' }>>
      if (!safePositiveInteger(shutdown.generation) || !safeString(shutdown.reason)) throw new Error('command')
      return
    }
    default:
      throw new Error('command')
  }
}

function validSession(session: unknown): session is AuroraVoiceWebSession {
  if (typeof session !== 'object' || session === null) return false
  const candidate = session as Partial<AuroraVoiceWebSession>
  return safeString(candidate.ownerId) &&
    safeString(candidate.sessionId) &&
    safePositiveInteger(candidate.generation) &&
    Number.isFinite(candidate.startedAtMs) &&
    candidate.foregroundOnly === true
}

function validFrame(frame: unknown): frame is AuroraPcmFrameEnvelope {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as Partial<AuroraPcmFrameEnvelope>
  return safeString(candidate.sessionId) &&
    safePositiveInteger(candidate.generation) &&
    safeNonNegativeInteger(candidate.sequence) &&
    typeof candidate.discontinuity === 'boolean' &&
    candidate.sampleRateHz === 16_000 &&
    candidate.channels === 1 &&
    safePositiveInteger(candidate.sampleCount) &&
    safePositiveInteger(candidate.byteLength) &&
    safePositiveInteger(candidate.queuedBytes)
}

function assertCapabilities(capabilities: unknown): asserts capabilities is AuroraVoiceWebCapabilities {
  if (!validCapabilities(capabilities)) throw new Error('capabilities')
}

function validCapabilities(capabilities: unknown): capabilities is AuroraVoiceWebCapabilities {
  if (typeof capabilities !== 'object' || capabilities === null) return false
  const candidate = capabilities as Partial<AuroraVoiceWebCapabilities>
  return typeof candidate.vad === 'boolean' &&
    typeof candidate.kws === 'boolean' &&
    typeof candidate.stt === 'boolean' &&
    typeof candidate.tts === 'boolean'
}

function validModelBindings(bindings: unknown): bindings is AuroraVoiceWebModelBindings | undefined {
  if (bindings === undefined) return true
  if (typeof bindings !== 'object' || bindings === null) return false
  if ('sherpaAssets' in bindings) return false
  const files = (bindings as Partial<AuroraVoiceWebModelBindings>).files
  const models = (bindings as Partial<AuroraVoiceWebModelBindings>).models
  if (!Array.isArray(files) || files.length === 0 || files.length > 4096) return false
  if (!Array.isArray(models) || models.length === 0 || models.length > 64) return false
  return files.every((file) => {
    if (typeof file !== 'object' || file === null) return false
    const candidate = file as Record<string, unknown>
    return (candidate.task === 'vad' || candidate.task === 'kws' || candidate.task === 'stt' || candidate.task === 'tts') &&
      safeString(candidate.fileId) &&
      safeVirtualPath(candidate.virtualPath) &&
      typeof candidate.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(candidate.sha256) &&
      candidate.bytes instanceof Uint8Array &&
      safePositiveInteger(candidate.byteLength) &&
      candidate.byteLength === candidate.bytes.byteLength
  }) && models.every(validModelDescriptor)
}

function validModelDescriptor(model: unknown): boolean {
  if (typeof model !== 'object' || model === null) return false
  const candidate = model as Record<string, unknown>
  if (
    !(candidate.task === 'vad' || candidate.task === 'kws' || candidate.task === 'stt' || candidate.task === 'tts') ||
    !(candidate.family === 'silero-vad' || candidate.family === 'moonshine' || candidate.family === 'whisper' || candidate.family === 'sense-voice' || candidate.family === 'sherpa-kws-transducer' || candidate.family === 'piper' || candidate.family === 'pockettts') ||
    !(candidate.kind === 'vad' || candidate.kind === 'offline-asr' || candidate.kind === 'keyword-spotter' || candidate.kind === 'offline-tts') ||
    !Array.isArray(candidate.files) ||
    candidate.files.length === 0
  ) return false
  return candidate.files.every((file) => (
    typeof file === 'object' &&
    file !== null &&
    (file as { role?: unknown }).role !== undefined &&
    ['model', 'encoder', 'decoder', 'mergedDecoder', 'tokens', 'joiner', 'keywords', 'bpeVocab', 'lexicon', 'dataDir', 'lmFlow', 'lmMain', 'textConditioner', 'vocabJson', 'tokenScoresJson', 'pocketProtocol', 'bosBeforeVoice', 'fixedVoiceState', 'referenceAudio'].includes(String((file as { role?: unknown }).role)) &&
    safeString((file as { fileId?: unknown }).fileId) &&
    safeVirtualPath((file as { virtualPath?: unknown }).virtualPath)
  ))
}

function validInferenceOutput(inference: unknown, sequence: number): inference is AuroraVoiceInferenceOutput {
  if (typeof inference !== 'object' || inference === null) return false
  const candidate = inference as Partial<AuroraVoiceInferenceOutput>
  if (candidate.redacted !== true || !Array.isArray(candidate.kwsHits) || !Array.isArray(candidate.stt)) return false
  if (candidate.vad !== undefined && (
    candidate.vad.redacted !== true ||
    typeof candidate.vad.active !== 'boolean' ||
    typeof candidate.vad.speechDetected !== 'boolean' ||
    candidate.vad.sequence !== sequence
  )) return false
  return candidate.kwsHits.every((hit) => (
    typeof hit === 'object' &&
    hit !== null &&
    typeof hit.keyword === 'string' &&
    hit.keyword.length > 0 &&
    (hit.score === null || typeof hit.score === 'number') &&
    hit.sequence === sequence &&
    hit.redacted === true
  )) && candidate.stt.every((result) => (
    typeof result === 'object' &&
    result !== null &&
    typeof result.text === 'string' &&
    result.text.length > 0 &&
    typeof result.final === 'boolean' &&
    result.sequence === sequence &&
    result.redacted === true
  ))
}

function safeVirtualPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 256 &&
    !value.includes('..') &&
    !value.includes('//') &&
    /^[A-Za-z0-9_./:-]+$/.test(value)
}

function safeSessionIdFor(command: unknown): string | null {
  if (typeof command !== 'object' || command === null) return null
  const type = (command as { type?: unknown }).type
  if (type === 'start') {
    const session = (command as { session?: Partial<AuroraVoiceWebSession> }).session
    return safeString(session?.sessionId) ? session.sessionId : null
  }
  if (type === 'audio_frame') {
    const frame = (command as { frame?: Partial<AuroraPcmFrameEnvelope> }).frame
    return safeString(frame?.sessionId) ? frame.sessionId : null
  }
  if (type === 'stop' || type === 'finish_turn' || type === 'cancel') {
    const sessionId = (command as { sessionId?: unknown }).sessionId
    return safeString(sessionId) ? sessionId : null
  }
  return null
}

function safeGenerationFor(command: unknown): number {
  if (typeof command !== 'object' || command === null) return 0
  const type = (command as { type?: unknown }).type
  if (type === 'start') {
    const generation = (command as { session?: Partial<AuroraVoiceWebSession> }).session?.generation
    return safePositiveInteger(generation) ? generation : 0
  }
  if (type === 'audio_frame') {
    const generation = (command as { frame?: Partial<AuroraPcmFrameEnvelope> }).frame?.generation
    return safePositiveInteger(generation) ? generation : 0
  }
  if (type === 'stop' || type === 'finish_turn' || type === 'synthesize_tts' || type === 'cancel' || type === 'shutdown') {
    const generation = (command as { generation?: unknown }).generation
    return safePositiveInteger(generation) ? generation : 0
  }
  return 0
}

function safeSequenceFor(command: unknown): number | null {
  if (typeof command !== 'object' || command === null || (command as { type?: unknown }).type !== 'audio_frame') return null
  const sequence = (command as { frame?: Partial<AuroraPcmFrameEnvelope> }).frame?.sequence
  return safeNonNegativeInteger(sequence) ? sequence : null
}

function safeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function validFinishOutcome(value: unknown): value is AuroraVoiceTurnFinishOutcome {
  return value === 'completed' || value === 'abandoned'
}

function validTtsText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_TTS_TEXT_CHARS
}

function validTtsSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4.0
}

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}
