import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  type AuroraCapturedAudio,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceTurnFinishOutcome,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebSession,
  type AuroraVoiceWorkerCommand,
  type AuroraVoiceWorkerRequestEnvelope,
  type AuroraVoiceWorkerResponse,
  type AuroraVoiceWorkerResponseEnvelope
} from './types.js'

const MAX_CAPTURED_AUDIO_SAMPLES = 16_000 * 60

export interface AuroraVoiceWasmBridge {
  startSession(session: AuroraVoiceWebSession): Promise<void>
  pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<void>
  stopSession(sessionId: string, generation: number): Promise<AuroraCapturedAudio>
  finishTurn(sessionId: string, generation: number, outcome: AuroraVoiceTurnFinishOutcome): Promise<void>
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
      this.reply(request.requestId, response, response.type === 'stop_result' ? [response.capturedAudio.pcm.buffer] : [])
    } catch {
      this.reply(request.requestId, {
        type: 'reject',
        sessionId: safeSessionIdFor(request.command),
        generation: safeGenerationFor(request.command),
        sequence: safeSequenceFor(request.command),
        reason: 'worker_rejected'
      })
    }
  }

  private async dispatch(command: AuroraVoiceWorkerCommand): Promise<AuroraVoiceWorkerResponse> {
    assertValidCommand(command)
    switch (command.type) {
      case 'init':
        if (command.protocolVersion !== AURORA_VOICE_WORKER_PROTOCOL_VERSION) throw new Error('version')
        await this.bridge.snapshot()
        this.initialized = true
        return {
          type: 'ready',
          protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
          capabilities: AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
          maxFrameSamples: command.maxFrameSamples,
          maxQueuedBytes: command.maxQueuedBytes
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
        await this.bridge.pushPcmI16(command.frame, command.pcm)
        this.nextSequence = command.frame.sequence + 1
        return { type: 'ack', sessionId: command.frame.sessionId, generation: command.frame.generation, sequence: command.frame.sequence }
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
      case 'cancel':
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
        !safePositiveInteger(init.maxQueuedBytes)
      ) throw new Error('command')
      return
    }
    case 'start': {
      const start = command as Partial<Extract<AuroraVoiceWorkerCommand, { type: 'start' }>>
      if (!validSession(start.session) || !capabilitiesUnavailable(start.capabilities)) throw new Error('command')
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

function capabilitiesUnavailable(capabilities: unknown): capabilities is AuroraVoiceWebCapabilities {
  if (typeof capabilities !== 'object' || capabilities === null) return false
  const candidate = capabilities as Partial<AuroraVoiceWebCapabilities>
  return candidate.vad === false && candidate.kws === false && candidate.stt === false && candidate.tts === false
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
  if (type === 'stop' || type === 'finish_turn' || type === 'cancel' || type === 'shutdown') {
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

function safePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}
