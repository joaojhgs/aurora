import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  AuroraVoiceWebRuntimeError,
  type AuroraCapturedAudio,
  type AuroraPcmFrame,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceLifecycleEligibility,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebEvent,
  type AuroraVoiceWebEventKind,
  type AuroraVoiceWebEventListener,
  type AuroraVoiceWebRuntimeOptions,
  type AuroraVoiceWebRuntimeSnapshot,
  type AuroraVoiceWebSession,
  type AuroraVoiceWebState
} from './types.js'

const DEFAULT_MAX_FRAME_SAMPLES = 4_800
const DEFAULT_MAX_QUEUED_BYTES = 16_000 * 2 * 10
const DEFAULT_WORKER_TIMEOUT_MS = 5_000
const MAX_CAPTURED_AUDIO_SAMPLES = 16_000 * 60

interface ActiveVoiceLock {
  readonly ownerId: string
  readonly token: symbol
}

let activeVoiceLock: ActiveVoiceLock | null = null

export class AuroraVoiceWebRuntime {
  readonly ownerId: string
  private readonly lockToken = Symbol('AuroraVoiceWebRuntime')
  private readonly worker
  private readonly pcmSource
  private readonly lifecycle
  private readonly maxFrameSamples: number
  private readonly maxQueuedBytes: number
  private readonly workerTimeoutMs: number
  private readonly nowMs: () => number
  private readonly sessionIdFactory: (ownerId: string, generation: number) => string
  private readonly listeners = new Set<AuroraVoiceWebEventListener>()
  private readonly capabilities: AuroraVoiceWebCapabilities
  private state: AuroraVoiceWebState = 'idle'
  private session: AuroraVoiceWebSession | null = null
  private pendingStoppedSession: AuroraVoiceWebSession | null = null
  private generation = 0
  private nextSequence = 0
  private queuedBytes = 0
  private frameChain: Promise<void> = Promise.resolve()

  constructor(options: AuroraVoiceWebRuntimeOptions) {
    this.ownerId = requireNonEmpty(options.ownerId, 'ownerId')
    this.worker = options.worker
    this.pcmSource = options.pcmSource
    this.lifecycle = options.lifecycle ?? visibleLifecycle
    this.maxFrameSamples = boundedIntegerInRange(options.maxFrameSamples ?? DEFAULT_MAX_FRAME_SAMPLES, 'maxFrameSamples', 1, DEFAULT_MAX_FRAME_SAMPLES)
    this.maxQueuedBytes = boundedIntegerInRange(options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES, 'maxQueuedBytes', 2, DEFAULT_MAX_QUEUED_BYTES)
    this.workerTimeoutMs = boundedIntegerInRange(options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS, 'workerTimeoutMs', 1, 60_000)
    this.nowMs = options.nowMs ?? Date.now
    this.sessionIdFactory = options.sessionIdFactory ?? defaultSessionId
    this.capabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES
  }

  onEvent(listener: AuroraVoiceWebEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot(): AuroraVoiceWebRuntimeSnapshot {
    return {
      ownerId: this.ownerId,
      state: this.state,
      sessionId: this.session?.sessionId ?? this.pendingStoppedSession?.sessionId ?? null,
      generation: this.generation,
      nextSequence: this.nextSequence,
      queuedBytes: this.queuedBytes,
      capabilities: this.capabilities,
      lifecycle: this.currentLifecycle()
    }
  }

  async start(): Promise<AuroraVoiceWebSession> {
    const eligibility = this.currentLifecycle()
    if (!eligibility.eligible || !eligibility.visible || eligibility.frozen) {
      throw new AuroraVoiceWebRuntimeError('lifecycle_ineligible', 'Foreground voice capture is not available')
    }
    if (this.session !== null) {
      throw new AuroraVoiceWebRuntimeError('session_active', 'This voice session is already active')
    }
    if (this.pendingStoppedSession !== null) {
      throw new AuroraVoiceWebRuntimeError('turn_pending', 'The previous voice turn is still pending')
    }
    if (activeVoiceLock !== null) {
      throw new AuroraVoiceWebRuntimeError('active_owner_exists', 'A voice session is already active')
    }

    const nextGeneration = this.generation + 1
    const nextSession = Object.freeze({
      ownerId: this.ownerId,
      sessionId: safeIdentifier(this.sessionIdFactory(this.ownerId, nextGeneration), 'sessionId'),
      generation: nextGeneration,
      startedAtMs: this.nowMs(),
      foregroundOnly: true
    })

    activeVoiceLock = { ownerId: this.ownerId, token: this.lockToken }
    this.state = 'active'
    this.generation = nextGeneration
    this.nextSequence = 0
    this.queuedBytes = 0
    this.session = nextSession
    let workerStarted = false
    try {
      const ready = await this.worker.request({
        type: 'init',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        maxFrameSamples: this.maxFrameSamples,
        maxQueuedBytes: this.maxQueuedBytes
      }, { timeoutMs: this.workerTimeoutMs })
      if (
        ready.type !== 'ready' ||
        ready.protocolVersion !== AURORA_VOICE_WORKER_PROTOCOL_VERSION ||
        !capabilitiesAreUnavailable(ready.capabilities) ||
        ready.maxFrameSamples > this.maxFrameSamples ||
        ready.maxQueuedBytes > this.maxQueuedBytes
      ) {
        throw new AuroraVoiceWebRuntimeError('worker_rejected', 'Voice worker is not available')
      }
      const started = await this.worker.request({ type: 'start', session: this.session, capabilities: this.capabilities }, { timeoutMs: this.workerTimeoutMs })
      validateAck(started, this.session.sessionId, this.session.generation, null)
      workerStarted = true
      await this.pcmSource?.start(this.session, { pushFrame: (frame) => this.pushFrame(frame) })
      this.emit('session_started', null, null, 0, 0, 0, null)
      return this.session
    } catch {
      const failedSession = this.session
      await this.bestEffortCancelHosts(failedSession, workerStarted, 'start_failed')
      this.emit('error', null, this.generation, 0, 0, 0, 'start_failed')
      this.clearSession('cancelled')
      throw new AuroraVoiceWebRuntimeError('start_failed', 'Voice session could not start')
    }
  }

  async stop(): Promise<AuroraCapturedAudio | null> {
    const session = this.session
    if (session === null) return null
    let failed = false
    let capturedAudio: AuroraCapturedAudio | null = null
    try {
      try {
        await this.pcmSource?.stop(session.sessionId)
      } catch {
        failed = true
      }
      try {
        const stopped = await this.worker.request({ type: 'stop', sessionId: session.sessionId, generation: session.generation }, { timeoutMs: this.workerTimeoutMs })
        capturedAudio = validateStopResult(stopped, session.sessionId, session.generation)
      } catch {
        failed = true
      }
      this.emit(failed ? 'error' : 'session_stopped', null, null, 0, 0, 0, failed ? 'stop_failed' : 'stopped')
    } finally {
      if (failed || capturedAudio === null) {
        await this.bestEffortCancelHosts(session, true, 'stop_failed')
        this.clearSession('cancelled')
      } else {
        this.clearActiveSession('stopped')
        this.pendingStoppedSession = session
      }
    }
    if (failed) throw new AuroraVoiceWebRuntimeError('stop_failed', 'Voice session could not stop cleanly')
    return capturedAudio
  }

  async completeTurn(): Promise<void> {
    await this.finishTurn('completed')
  }

  async abandonTurn(): Promise<void> {
    await this.finishTurn('abandoned')
  }

  async cancel(reason = 'cancelled'): Promise<void> {
    const session = this.session
    const pending = this.pendingStoppedSession
    if (session === null && pending === null) return
    const generation = this.generation
    let failed = false
    try {
      try {
        if (session !== null) await this.pcmSource?.cancel(session.sessionId)
      } catch {
        failed = true
      }
      try {
        const cancelled = await this.worker.request({
          type: 'cancel',
          sessionId: session?.sessionId ?? pending?.sessionId ?? null,
          generation: session?.generation ?? pending?.generation ?? generation,
          reason: 'cancelled'
        }, { timeoutMs: this.workerTimeoutMs })
        const owner = session ?? pending
        if (owner !== null) validateAck(cancelled, owner.sessionId, owner.generation, null)
      } catch {
        failed = true
      }
      this.emit(failed ? 'error' : 'session_cancelled', null, null, 0, 0, 0, failed ? 'cancel_failed' : normalizeReason(reason))
    } finally {
      if (failed && session === null && pending !== null) {
        this.clearActiveSession('stopped')
        this.pendingStoppedSession = pending
      } else {
        this.clearSession('cancelled')
      }
    }
    if (failed) throw new AuroraVoiceWebRuntimeError('cancel_failed', 'Voice session could not cancel cleanly')
  }

  async refreshLifecycle(): Promise<void> {
    const eligibility = this.currentLifecycle()
    if ((this.session === null && this.pendingStoppedSession === null) || eligibility.eligible && eligibility.visible && !eligibility.frozen) return
    await this.cancel('lifecycle_lost')
    this.emit('lifecycle_lost', null, null, 0, 0, 0, eligibility.reason)
  }

  async dispose(): Promise<void> {
    await this.cancel('disposed')
    this.worker.shutdown?.()
  }

  async pushFrame(frame: AuroraPcmFrame): Promise<boolean> {
    const run = this.frameChain.then(
      () => this.deliverFrame(frame),
      () => this.deliverFrame(frame)
    )
    this.frameChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async deliverFrame(frame: AuroraPcmFrame): Promise<boolean> {
    const session = this.session
    if (session === null || this.state !== 'active') return false
    const rejected = this.rejectionReason(frame, session)
    if (rejected !== null) {
      this.emit('frame_dropped', frame.sequence, frame.generation, 0, 0, this.queuedBytes, rejected)
      return false
    }

    const byteLength = frame.pcm.byteLength
    const sampleCount = frame.pcm.length
    const nextQueuedBytes = this.queuedBytes + byteLength
    if (nextQueuedBytes > this.maxQueuedBytes) {
      await this.failClosed('queue_limit')
      this.emit('frame_dropped', frame.sequence, frame.generation, sampleCount, byteLength, this.queuedBytes, 'queue_limit')
      return false
    }

    if (frame.discontinuity === true) this.nextSequence = frame.sequence
    const copiedPcm = new Int16Array(frame.pcm)
    const transferBuffer = copiedPcm.buffer
    this.queuedBytes = nextQueuedBytes
    const envelope: AuroraPcmFrameEnvelope = Object.freeze({
      sessionId: session.sessionId,
      generation: session.generation,
      sequence: frame.sequence,
      discontinuity: frame.discontinuity === true,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount,
      byteLength,
      queuedBytes: this.queuedBytes
    })
    try {
      const posted = await this.worker.request({ type: 'audio_frame', frame: envelope, pcm: copiedPcm }, {
        timeoutMs: this.workerTimeoutMs,
        transfer: [transferBuffer]
      })
      validateAck(posted, session.sessionId, session.generation, frame.sequence)
      if (
        this.session !== session ||
        this.state !== 'active' ||
        this.session.sessionId !== session.sessionId ||
        this.session.generation !== session.generation
      ) {
        return false
      }
      this.nextSequence = frame.sequence + 1
      this.emit('frame_accepted', frame.sequence, frame.generation, sampleCount, byteLength, this.queuedBytes - byteLength, null)
      return true
    } catch {
      await this.failClosed('frame_failed')
      return false
    } finally {
      this.queuedBytes = Math.max(0, this.queuedBytes - byteLength)
    }
  }

  private rejectionReason(frame: AuroraPcmFrame, session: AuroraVoiceWebSession): string | null {
    if (!(frame.pcm instanceof Int16Array)) return 'frame_type'
    if (frame.sessionId !== session.sessionId) return 'stale_session'
    if (frame.generation !== session.generation) return 'stale_generation'
    if (frame.sampleRateHz !== 16_000) return 'sample_rate'
    if (frame.channels !== 1) return 'channel_count'
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) return 'sequence'
    if (frame.discontinuity !== true && frame.sequence !== this.nextSequence) return 'sequence'
    if (frame.pcm.length === 0 || frame.pcm.length > this.maxFrameSamples) return 'frame_limit'
    return null
  }

  private currentLifecycle(): AuroraVoiceLifecycleEligibility {
    return validateLifecycle(this.lifecycle())
  }

  private async failClosed(reason: string): Promise<void> {
    const session = this.session
    await this.bestEffortCancelHosts(session, true, reason)
    this.emit('error', null, this.generation, 0, 0, this.queuedBytes, reason)
    this.clearSession('cancelled')
  }

  private async finishTurn(outcome: 'completed' | 'abandoned'): Promise<void> {
    const pending = this.pendingStoppedSession
    if (pending === null) return
    try {
      const finished = await this.worker.request({
        type: 'finish_turn',
        sessionId: pending.sessionId,
        generation: pending.generation,
        outcome
      }, { timeoutMs: this.workerTimeoutMs })
      validateAck(finished, pending.sessionId, pending.generation, null)
      this.pendingStoppedSession = null
      this.state = outcome === 'completed' ? 'idle' : 'cancelled'
      this.generation = pending.generation
      this.nextSequence = 0
      this.queuedBytes = 0
    } catch {
      this.emit('error', null, pending.generation, 0, 0, this.queuedBytes, 'finish_failed')
      throw new AuroraVoiceWebRuntimeError('finish_failed', 'Voice turn could not be finished cleanly')
    }
  }

  private async bestEffortCancelHosts(session: AuroraVoiceWebSession | null, notifyWorker: boolean, reason: string): Promise<void> {
    try {
      await this.pcmSource?.cancel(session?.sessionId ?? '')
    } catch {
      // Best-effort cleanup; callers report the sanitized outer failure.
    }
    if (!notifyWorker) return
    try {
      const cancelled = await this.worker.request({
        type: 'cancel',
        sessionId: session?.sessionId ?? null,
        generation: session?.generation ?? this.generation,
        reason
      }, { timeoutMs: this.workerTimeoutMs })
      if (session !== null) validateAck(cancelled, session.sessionId, session.generation, null)
    } catch {
      // Best-effort cleanup; callers report the sanitized outer failure.
    }
  }

  private clearSession(nextState: Exclude<AuroraVoiceWebState, 'active'>): void {
    this.clearActiveSession(nextState)
    this.pendingStoppedSession = null
  }

  private clearActiveSession(nextState: Exclude<AuroraVoiceWebState, 'active'>): void {
    if (activeVoiceLock?.token === this.lockToken) activeVoiceLock = null
    this.state = nextState
    this.session = null
    this.nextSequence = 0
    this.queuedBytes = 0
  }

  private emit(
    kind: AuroraVoiceWebEventKind,
    sequence: number | null,
    generation: number | null,
    sampleCount: number,
    byteLength: number,
    queuedBytes: number,
    reason: string | null
  ): void {
    const event: AuroraVoiceWebEvent = Object.freeze({
      kind,
      ownerId: this.ownerId,
      sessionId: this.session?.sessionId ?? this.pendingStoppedSession?.sessionId ?? null,
      generation: generation ?? this.generation,
      sequence,
      sampleCount,
      byteLength,
      queuedBytes,
      reason,
      redacted: true,
      occurredAtMs: this.nowMs()
    })
    for (const listener of this.listeners) listener(event)
  }
}

export function visibleLifecycle(): AuroraVoiceLifecycleEligibility {
  return Object.freeze({
    foregroundOnly: true,
    visible: true,
    frozen: false,
    eligible: true,
    reason: 'visible'
  })
}

export function hiddenLifecycle(reason: Exclude<AuroraVoiceLifecycleEligibility['reason'], 'visible'> = 'hidden'): AuroraVoiceLifecycleEligibility {
  return Object.freeze({
    foregroundOnly: true,
    visible: false,
    frozen: reason === 'frozen',
    eligible: false,
    reason
  })
}

function boundedIntegerInRange(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuroraVoiceWebRuntimeError('invalid_option', `${label} is out of range`)
  }
  return value
}

function requireNonEmpty(value: string, label: string): string {
  return safeIdentifier(value, label)
}

function safeIdentifier(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AuroraVoiceWebRuntimeError('invalid_option', `${label} is required`)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value)) {
    throw new AuroraVoiceWebRuntimeError('invalid_option', `${label} must be a safe identifier`)
  }
  return value
}

function defaultSessionId(ownerId: string, generation: number): string {
  return `${ownerId}:${generation}`
}

function normalizeReason(reason: string): string {
  if (/^[A-Za-z0-9_.-]{1,48}$/.test(reason)) return reason
  return 'cancelled'
}

function capabilitiesAreUnavailable(capabilities: AuroraVoiceWebCapabilities): boolean {
  return capabilities.vad === false && capabilities.kws === false && capabilities.stt === false && capabilities.tts === false
}

function validateAck(response: unknown, sessionId: string, generation: number, sequence: number | null): void {
  if (
    typeof response !== 'object' ||
    response === null ||
    (response as { type?: unknown }).type !== 'ack' ||
    (response as { sessionId?: unknown }).sessionId !== sessionId ||
    (response as { generation?: unknown }).generation !== generation ||
    (response as { sequence?: unknown }).sequence !== sequence
  ) {
    throw new AuroraVoiceWebRuntimeError('worker_rejected', 'Voice worker rejected the request')
  }
}

function validateStopResult(response: unknown, sessionId: string, generation: number): AuroraCapturedAudio {
  if (
    typeof response !== 'object' ||
    response === null ||
    (response as { type?: unknown }).type !== 'stop_result' ||
    (response as { sessionId?: unknown }).sessionId !== sessionId ||
    (response as { generation?: unknown }).generation !== generation
  ) {
    throw new AuroraVoiceWebRuntimeError('worker_rejected', 'Voice worker rejected the request')
  }
  const audio = (response as { capturedAudio?: unknown }).capturedAudio
  if (
    typeof audio !== 'object' ||
    audio === null ||
    (audio as { sessionId?: unknown }).sessionId !== sessionId ||
    (audio as { generation?: unknown }).generation !== generation ||
    (audio as { sampleRateHz?: unknown }).sampleRateHz !== 16_000 ||
    (audio as { channels?: unknown }).channels !== 1 ||
    (audio as { redacted?: unknown }).redacted !== true ||
    !((audio as { pcm?: unknown }).pcm instanceof Int16Array)
  ) {
    throw new AuroraVoiceWebRuntimeError('worker_rejected', 'Voice worker returned invalid audio')
  }
  const pcm = (audio as AuroraCapturedAudio).pcm
  const sampleCount = (audio as { sampleCount?: unknown }).sampleCount
  const durationMs = (audio as { durationMs?: unknown }).durationMs
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount !== pcm.length ||
    sampleCount < 0 ||
    sampleCount > MAX_CAPTURED_AUDIO_SAMPLES ||
    typeof durationMs !== 'number' ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 0 ||
    durationMs > 60_000
  ) {
    throw new AuroraVoiceWebRuntimeError('worker_rejected', 'Voice worker returned invalid audio')
  }
  return Object.freeze({
    sessionId,
    generation,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: sampleCount as number,
    durationMs: durationMs as number,
    pcm: new Int16Array(pcm),
    redacted: true
  })
}

function validateLifecycle(value: AuroraVoiceLifecycleEligibility): AuroraVoiceLifecycleEligibility {
  if (
    value?.foregroundOnly !== true ||
    typeof value.visible !== 'boolean' ||
    typeof value.frozen !== 'boolean' ||
    typeof value.eligible !== 'boolean'
  ) {
    throw new AuroraVoiceWebRuntimeError('invalid_lifecycle', 'Lifecycle state is invalid')
  }
  if (value.eligible && (!value.visible || value.frozen || value.reason !== 'visible')) {
    throw new AuroraVoiceWebRuntimeError('invalid_lifecycle', 'Lifecycle state is inconsistent')
  }
  if (!value.eligible && value.reason === 'visible') {
    throw new AuroraVoiceWebRuntimeError('invalid_lifecycle', 'Lifecycle state is inconsistent')
  }
  return Object.freeze({ ...value })
}
