import {
  AuroraVoiceWebRuntimeError,
  type AuroraAudioWorkletPcmSink,
  type AuroraAudioWorkletPcmSource,
  type AuroraPcmFrame,
  type AuroraVoiceWebSession
} from './types.js'

export const AURORA_AUDIO_WORKLET_DEFAULT_FRAME_MS = 20
export const AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ = 16_000
export const AURORA_AUDIO_WORKLET_PROCESSOR_NAME = 'aurora-voice-pcm-source'

const MIN_FRAME_MS = 20
const MAX_FRAME_MS = 100
const DEFAULT_START_TIMEOUT_MS = 5_000
const DEFAULT_STOP_TIMEOUT_MS = 1_000
const DEFAULT_RESOURCE_RELEASE_TIMEOUT_MS = 200
const DEFAULT_MAX_PENDING_FRAMES = 4
const DEFAULT_MAX_TAIL_MS = 200

export interface AuroraBrowserAudioWorkletSourceOptions {
  readonly mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  readonly audioContextFactory?: (options: AudioContextOptions) => AuroraAudioContextLike
  readonly workletNodeFactory?: (
    context: AuroraAudioContextLike,
    name: string,
    options: AudioWorkletNodeOptions
  ) => AuroraAudioWorkletNodeLike
  readonly processorUrl?: string
  readonly startTimeoutMs?: number
  readonly stopTimeoutMs?: number
  readonly resourceReleaseTimeoutMs?: number
  readonly frameMs?: number
  readonly maxPendingFrames?: number
  readonly maxTailMs?: number
  readonly onLifecycleLost?: (reason: AuroraBrowserAudioLifecycleLostReason) => void
}

export interface AuroraAudioContextLike {
  readonly sampleRate: number
  readonly state?: AudioContextState
  readonly audioWorklet: Pick<AudioWorklet, 'addModule'>
  createMediaStreamSource(stream: MediaStream): AuroraMediaStreamAudioSourceNodeLike
  resume?(): Promise<void>
  close(): Promise<void>
  addEventListener?(type: 'statechange', listener: EventListener): void
  removeEventListener?(type: 'statechange', listener: EventListener): void
}

export interface AuroraMediaStreamAudioSourceNodeLike {
  connect(destination: AuroraAudioNodeLike): AuroraAudioNodeLike
  disconnect(): void
}

export interface AuroraAudioNodeLike {
  connect?(destination: AuroraAudioNodeLike): AuroraAudioNodeLike
  disconnect(): void
}

export interface AuroraAudioWorkletNodeLike extends AuroraAudioNodeLike {
  readonly port: MessagePort
}

interface ActiveBrowserAudioSession {
  readonly session: AuroraVoiceWebSession
  readonly sink: AuroraAudioWorkletPcmSink
  readonly mediaStream: MediaStream
  readonly context: AuroraAudioContextLike
  readonly sourceNode: AuroraMediaStreamAudioSourceNodeLike
  readonly workletNode: AuroraAudioWorkletNodeLike
  readonly assembler: AuroraAudioWorkletFrameAssembler
  readonly cleanupCallbacks: Array<() => void>
  messageChain: Promise<void>
  stopping: boolean
  closed: boolean
}

interface PendingBrowserAudioStart {
  readonly sessionId: string
  cancelled: boolean
}

export type AuroraBrowserAudioLifecycleLostReason = 'track_ended' | 'context_suspended'

export class BrowserAudioWorkletPcmSource implements AuroraAudioWorkletPcmSource {
  private readonly mediaDevices
  private readonly audioContextFactory
  private readonly workletNodeFactory
  private readonly processorUrl: string
  private readonly startTimeoutMs: number
  private readonly stopTimeoutMs: number
  private readonly resourceReleaseTimeoutMs: number
  private readonly frameMs: number
  private readonly maxPendingFrames: number
  private readonly maxTailMs: number
  private readonly onLifecycleLost: ((reason: AuroraBrowserAudioLifecycleLostReason) => void) | undefined
  private active: ActiveBrowserAudioSession | null = null
  private pendingStart: PendingBrowserAudioStart | null = null
  private pendingStopAck: PendingAck | null = null

  constructor(options: AuroraBrowserAudioWorkletSourceOptions = {}) {
    this.mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices
    this.audioContextFactory = options.audioContextFactory ?? defaultAudioContextFactory
    this.workletNodeFactory = options.workletNodeFactory ?? defaultWorkletNodeFactory
    this.processorUrl = options.processorUrl ?? new URL('./audio-worklet-processor.js', import.meta.url).toString()
    this.startTimeoutMs = boundedInteger(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, 'startTimeoutMs', 100, 30_000)
    this.stopTimeoutMs = boundedInteger(options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, 'stopTimeoutMs', 100, 10_000)
    this.resourceReleaseTimeoutMs = boundedInteger(
      options.resourceReleaseTimeoutMs ?? DEFAULT_RESOURCE_RELEASE_TIMEOUT_MS,
      'resourceReleaseTimeoutMs',
      1,
      250
    )
    this.frameMs = boundedInteger(options.frameMs ?? AURORA_AUDIO_WORKLET_DEFAULT_FRAME_MS, 'frameMs', MIN_FRAME_MS, MAX_FRAME_MS)
    this.maxPendingFrames = boundedInteger(options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES, 'maxPendingFrames', 1, 32)
    this.maxTailMs = boundedInteger(options.maxTailMs ?? DEFAULT_MAX_TAIL_MS, 'maxTailMs', this.frameMs, 1_000)
    this.onLifecycleLost = options.onLifecycleLost
  }

  async start(session: AuroraVoiceWebSession, sink: AuroraAudioWorkletPcmSink): Promise<void> {
    if (this.active !== null || this.pendingStart !== null) {
      throw new AuroraVoiceWebRuntimeError('audio_source_active', 'Voice capture is already active')
    }
    if (this.mediaDevices?.getUserMedia === undefined) {
      throw new AuroraVoiceWebRuntimeError('audio_source_unavailable', 'Voice capture is not available')
    }

    let mediaStream: MediaStream | null = null
    let context: AuroraAudioContextLike | null = null
    let sourceNode: AuroraMediaStreamAudioSourceNodeLike | null = null
    let workletNode: AuroraAudioWorkletNodeLike | null = null
    const pendingStart: PendingBrowserAudioStart = { sessionId: session.sessionId, cancelled: false }
    this.pendingStart = pendingStart

    try {
      mediaStream = await getUserMediaWithLateStop(
        this.mediaDevices.getUserMedia({ audio: foregroundVoiceConstraints(), video: false }),
        this.startTimeoutMs,
        'audio_source_start_timeout'
      )
      this.assertPendingStart(pendingStart)
      context = this.audioContextFactory({ latencyHint: 'interactive' })
      await withTimeout(context.audioWorklet.addModule(this.processorUrl), this.startTimeoutMs, 'audio_source_start_timeout')
      this.assertPendingStart(pendingStart)
      await this.resumeContextIfSuspended(context)
      this.assertPendingStart(pendingStart)
      sourceNode = context.createMediaStreamSource(mediaStream)
      workletNode = this.workletNodeFactory(context, AURORA_AUDIO_WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { sessionId: session.sessionId }
      })
      const assembler = new AuroraAudioWorkletFrameAssembler(session, sink, {
        frameMs: this.frameMs,
        maxPendingFrames: this.maxPendingFrames,
        maxTailMs: this.maxTailMs
      })
      const active: ActiveBrowserAudioSession = {
        session,
        sink,
        mediaStream,
        context,
        sourceNode,
        workletNode,
        assembler,
        cleanupCallbacks: [],
        messageChain: Promise.resolve(),
        stopping: false,
        closed: false
      }
      workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        active.messageChain = active.messageChain.then(
          () => this.handleWorkletMessage(active, event.data),
          () => this.handleWorkletMessage(active, event.data)
        )
      }
      this.bindLifecycleLoss(active)
      sourceNode.connect(workletNode)
      this.assertPendingStart(pendingStart)
      this.active = active
    } catch (error) {
      safeDisconnect(sourceNode)
      safeDisconnect(workletNode)
      safeClosePort(workletNode?.port)
      stopTracks(mediaStream)
      await safeCloseContext(context)
      throw classifyAudioSourceStartError(error)
    } finally {
      if (this.pendingStart === pendingStart) this.pendingStart = null
    }
  }

  async stop(sessionId: string): Promise<void> {
    this.cancelPendingStart(sessionId)
    const active = this.active
    if (active === null || active.session.sessionId !== sessionId) return
    if (active.closed) return
    try {
      await active.messageChain
      active.stopping = true
      await Promise.race([
        this.requestProcessorAck(active, 'stop').catch(() => undefined),
        delay(this.resourceReleaseTimeoutMs)
      ])
      await active.messageChain
      await this.cleanup(active)
      await active.assembler.flush()
    } finally {
      await this.cleanup(active)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelPendingStart(sessionId)
    const active = this.active
    if (active === null || active.session.sessionId !== sessionId) return
    if (active.closed) return
    active.stopping = true
    active.assembler.cancel()
    this.bestEffortPostProcessorCancel(active, 'cancel')
    await this.cleanup(active)
  }

  private cancelPendingStart(sessionId: string): void {
    if (this.pendingStart?.sessionId === sessionId) this.pendingStart.cancelled = true
  }

  private assertPendingStart(pendingStart: PendingBrowserAudioStart): void {
    if (this.pendingStart !== pendingStart || pendingStart.cancelled) {
      throw new AuroraVoiceWebRuntimeError('audio_source_start_cancelled', 'Voice capture start was cancelled')
    }
  }

  private async handleWorkletMessage(active: ActiveBrowserAudioSession, data: unknown): Promise<void> {
    if (this.active !== active || active.closed) return
    const message = parseWorkletMessage(data)
    if (message === null) return
    if (message.type === 'audio') {
      if (active.stopping || message.sessionId !== active.session.sessionId) return
      await active.assembler.pushFloat32(message.sessionId, message.sampleRateHz, message.samples)
      return
    }
    if (this.pendingStopAck?.requestId === message.requestId) {
      this.pendingStopAck.resolve()
      this.pendingStopAck = null
    }
  }

  private async resumeContextIfSuspended(context: AuroraAudioContextLike): Promise<void> {
    if (context.state !== 'suspended') return
    if (context.resume === undefined) {
      throw new AuroraVoiceWebRuntimeError('audio_source_suspended', 'Voice capture is not available')
    }
    await withTimeout(context.resume(), this.startTimeoutMs, 'audio_source_start_timeout')
    if (context.state === 'suspended') {
      throw new AuroraVoiceWebRuntimeError('audio_source_suspended', 'Voice capture is not available')
    }
  }

  private bindLifecycleLoss(active: ActiveBrowserAudioSession): void {
    for (const track of active.mediaStream.getTracks()) {
      const onEnded = (): void => {
        void this.failClosedFromBrowserSignal(active, 'track_ended')
      }
      track.addEventListener?.('ended', onEnded)
      active.cleanupCallbacks.push(() => track.removeEventListener?.('ended', onEnded))
    }
    const onStateChange = (): void => {
      if (active.context.state === 'suspended' || active.context.state === 'closed') {
        void this.failClosedFromBrowserSignal(active, 'context_suspended')
      }
    }
    active.context.addEventListener?.('statechange', onStateChange)
    active.cleanupCallbacks.push(() => active.context.removeEventListener?.('statechange', onStateChange))
  }

  private async failClosedFromBrowserSignal(
    active: ActiveBrowserAudioSession,
    reason: AuroraBrowserAudioLifecycleLostReason
  ): Promise<void> {
    if (this.active !== active || active.closed) return
    active.stopping = true
    active.assembler.cancel()
    try {
      this.onLifecycleLost?.(reason)
    } catch {
      // Product callbacks must not keep the microphone open.
    }
    this.bestEffortPostProcessorCancel(active, reason)
    await this.cleanup(active)
  }

  private async requestProcessorAck(active: ActiveBrowserAudioSession, type: 'stop' | 'cancel'): Promise<void> {
    const requestId = `${type}-${active.session.generation}`
    const ack = new Promise<void>((resolve) => {
      this.pendingStopAck = { requestId, resolve }
    })
    active.workletNode.port.postMessage({ type, sessionId: active.session.sessionId, requestId })
    await withTimeout(ack, this.stopTimeoutMs, 'audio_source_stop_timeout')
  }

  private bestEffortPostProcessorCancel(active: ActiveBrowserAudioSession, reason: string): void {
    try {
      active.workletNode.port.postMessage({
        type: 'cancel',
        sessionId: active.session.sessionId,
        requestId: `cancel-${active.session.generation}`,
        reason
      })
    } catch {
      // The browser source is being torn down; cancellation remains fail-closed.
    }
  }

  private async cleanup(active: ActiveBrowserAudioSession): Promise<void> {
    if (active.closed) return
    active.closed = true
    if (this.active === active) this.active = null
    this.pendingStopAck = null
    for (const cleanup of active.cleanupCallbacks.splice(0)) {
      try {
        cleanup()
      } catch {
        // Best-effort listener release.
      }
    }
    safeDisconnect(active.sourceNode)
    safeDisconnect(active.workletNode)
    safeClosePort(active.workletNode.port)
    stopTracks(active.mediaStream)
    await safeCloseContext(active.context)
  }
}

interface PendingAck {
  readonly requestId: string
  readonly resolve: () => void
}

export interface AuroraAudioWorkletFrameAssemblerOptions {
  readonly frameMs?: number
  readonly maxPendingFrames?: number
  readonly maxTailMs?: number
}

export interface AuroraAudioWorkletFrameAssemblerSnapshot {
  readonly sequence: number
  readonly pendingFrames: number
  readonly tailSamples: number
  readonly droppedFrames: number
}

export class AuroraAudioWorkletFrameAssembler {
  private readonly session: AuroraVoiceWebSession
  private readonly sink: AuroraAudioWorkletPcmSink
  private readonly frameSamples: number
  private readonly maxPendingFrames: number
  private readonly maxTailSamples: number
  private readonly resamplers = new Map<number, AuroraStreamingPcm16Resampler>()
  private tail = new Int16Array(0)
  private sequence = 0
  private pendingFrames = 0
  private droppedFrames = 0
  private discontinuityNext = false
  private cancelled = false

  constructor(session: AuroraVoiceWebSession, sink: AuroraAudioWorkletPcmSink, options: AuroraAudioWorkletFrameAssemblerOptions = {}) {
    this.session = session
    this.sink = sink
    const frameMs = boundedInteger(options.frameMs ?? AURORA_AUDIO_WORKLET_DEFAULT_FRAME_MS, 'frameMs', MIN_FRAME_MS, MAX_FRAME_MS)
    this.frameSamples = Math.round(AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ * frameMs / 1_000)
    this.maxPendingFrames = boundedInteger(options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES, 'maxPendingFrames', 1, 32)
    const maxTailMs = boundedInteger(options.maxTailMs ?? DEFAULT_MAX_TAIL_MS, 'maxTailMs', frameMs, 1_000)
    this.maxTailSamples = Math.round(AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ * maxTailMs / 1_000)
  }

  snapshot(): AuroraAudioWorkletFrameAssemblerSnapshot {
    return Object.freeze({
      sequence: this.sequence,
      pendingFrames: this.pendingFrames,
      tailSamples: this.tail.length,
      droppedFrames: this.droppedFrames
    })
  }

  async pushFloat32(sessionId: string, sampleRateHz: number, samples: Float32Array): Promise<void> {
    if (this.cancelled || sessionId !== this.session.sessionId) return
    if (!(samples instanceof Float32Array) || samples.length === 0) return
    const sampleRate = boundedInteger(sampleRateHz, 'sampleRateHz', 8_000, 192_000)
    const resampler = this.resamplerFor(sampleRate)
    this.appendTail(resampler.push(samples))
    await this.drainCompleteFrames()
  }

  async flush(): Promise<void> {
    if (this.cancelled) return
    if (this.tail.length > 0) {
      const padded = new Int16Array(this.frameSamples)
      padded.set(this.tail.subarray(0, Math.min(this.tail.length, this.frameSamples)))
      this.tail = new Int16Array(0)
      await this.pushFrame(padded, true)
    }
    await this.waitForPending()
  }

  cancel(): void {
    this.cancelled = true
    this.tail = new Int16Array(0)
    this.resamplers.clear()
  }

  private resamplerFor(sampleRateHz: number): AuroraStreamingPcm16Resampler {
    const existing = this.resamplers.get(sampleRateHz)
    if (existing !== undefined) return existing
    const next = new AuroraStreamingPcm16Resampler(sampleRateHz)
    this.resamplers.set(sampleRateHz, next)
    return next
  }

  private appendTail(samples: Int16Array): void {
    if (samples.length === 0) return
    const next = new Int16Array(this.tail.length + samples.length)
    next.set(this.tail)
    next.set(samples, this.tail.length)
    if (next.length > this.maxTailSamples) {
      this.tail = next.slice(next.length - this.maxTailSamples)
      this.discontinuityNext = true
      this.droppedFrames += 1
      return
    }
    this.tail = next
  }

  private async drainCompleteFrames(): Promise<void> {
    while (!this.cancelled && this.tail.length >= this.frameSamples) {
      const frame = this.tail.slice(0, this.frameSamples)
      this.tail = this.tail.slice(this.frameSamples)
      const discontinuity = this.discontinuityNext
      this.discontinuityNext = false
      if (!await this.pushFrame(frame, discontinuity)) {
        this.discontinuityNext = true
      }
    }
  }

  private async pushFrame(pcm: Int16Array, discontinuity: boolean): Promise<boolean> {
    if (this.pendingFrames >= this.maxPendingFrames) {
      this.droppedFrames += 1
      this.discontinuityNext = true
      return false
    }
    const frame: AuroraPcmFrame = Object.freeze({
      sessionId: this.session.sessionId,
      generation: this.session.generation,
      sequence: this.sequence,
      discontinuity,
      sampleRateHz: AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ,
      channels: 1,
      pcm
    })
    this.sequence += 1
    this.pendingFrames += 1
    void this.sink.pushFrame(frame).then(
      (accepted) => {
        if (!accepted) {
          this.droppedFrames += 1
          this.discontinuityNext = true
        }
      },
      () => {
        this.droppedFrames += 1
        this.discontinuityNext = true
      }
    ).finally(() => {
      this.pendingFrames = Math.max(0, this.pendingFrames - 1)
    })
    return true
  }

  private async waitForPending(): Promise<void> {
    while (this.pendingFrames > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
}

export class AuroraStreamingPcm16Resampler {
  private readonly step: number
  private position = 0
  private lastSample: number | null = null

  constructor(readonly inputSampleRateHz: number) {
    const rate = boundedInteger(inputSampleRateHz, 'inputSampleRateHz', 8_000, 192_000)
    this.step = rate / AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ
  }

  push(input: Float32Array): Int16Array {
    if (input.length === 0) return new Int16Array(0)
    const prepend = this.lastSample !== null
    const length = input.length + (prepend ? 1 : 0)
    const output: number[] = []
    const sampleAt = (index: number): number => {
      if (prepend && index === 0) return this.lastSample ?? 0
      return input[index - (prepend ? 1 : 0)] ?? 0
    }

    while (this.position < length - 1) {
      const leftIndex = Math.floor(this.position)
      const fraction = this.position - leftIndex
      const left = sampleAt(leftIndex)
      const right = sampleAt(leftIndex + 1)
      output.push(floatToPcm16(left + (right - left) * fraction))
      this.position += this.step
    }

    this.lastSample = input[input.length - 1] ?? 0
    this.position -= length - 1
    if (this.position < 0 || !Number.isFinite(this.position)) this.position = 0
    return Int16Array.from(output)
  }
}

function foregroundVoiceConstraints(): MediaTrackConstraints {
  return {
    channelCount: { ideal: 1 },
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
}

function defaultAudioContextFactory(options: AudioContextOptions): AuroraAudioContextLike {
  const AudioContextConstructor = globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (AudioContextConstructor === undefined) {
    throw new AuroraVoiceWebRuntimeError('audio_source_unavailable', 'Voice capture is not available')
  }
  return new AudioContextConstructor(options)
}

function defaultWorkletNodeFactory(
  context: AuroraAudioContextLike,
  name: string,
  options: AudioWorkletNodeOptions
): AuroraAudioWorkletNodeLike {
  return new AudioWorkletNode(context as unknown as BaseAudioContext, name, options) as AuroraAudioWorkletNodeLike
}

function parseWorkletMessage(data: unknown): WorkletMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const candidate = data as Partial<WorkletMessage>
  if (candidate.type === 'audio') {
    if (typeof candidate.sessionId !== 'string') return null
    if (!Number.isSafeInteger(candidate.sampleRateHz)) return null
    if (!(candidate.samples instanceof Float32Array)) return null
    return {
      type: 'audio',
      sessionId: candidate.sessionId,
      sampleRateHz: candidate.sampleRateHz as number,
      samples: candidate.samples
    }
  }
  if ((candidate.type === 'stopped' || candidate.type === 'cancelled') && typeof candidate.requestId === 'string') {
    return { type: candidate.type, requestId: candidate.requestId }
  }
  return null
}

type WorkletMessage =
  | {
      readonly type: 'audio'
      readonly sessionId: string
      readonly sampleRateHz: number
      readonly samples: Float32Array
    }
  | {
      readonly type: 'stopped' | 'cancelled'
      readonly requestId: string
    }

function boundedInteger(value: number, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuroraVoiceWebRuntimeError('invalid_option', `${field} is outside the supported range`)
  }
  return value
}

function floatToPcm16(value: number): number {
  const clipped = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0))
  return clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AuroraVoiceWebRuntimeError(code, 'Voice capture timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function getUserMediaWithLateStop(promise: Promise<MediaStream>, timeoutMs: number, code: string): Promise<MediaStream> {
  let timedOut = false
  promise.then(
    (stream) => {
      if (timedOut) stopTracks(stream)
    },
    () => {
      // The visible start path reports a stable sanitized error.
    }
  )
  try {
    return await withTimeout(promise, timeoutMs, code)
  } catch (error) {
    timedOut = true
    throw error
  }
}

function classifyAudioSourceStartError(error: unknown): AuroraVoiceWebRuntimeError {
  if (error instanceof AuroraVoiceWebRuntimeError) {
    if (
      error.code === 'audio_source_start_cancelled' ||
      error.code === 'audio_source_start_timeout' ||
      error.code === 'audio_source_suspended' ||
      error.code === 'audio_source_unavailable'
    ) {
      return error
    }
    return new AuroraVoiceWebRuntimeError('audio_source_start_failed', 'Voice capture could not start')
  }
  const name = browserErrorName(error)
  if (name) {
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new AuroraVoiceWebRuntimeError('audio_source_permission_denied', 'Microphone permission was denied')
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return new AuroraVoiceWebRuntimeError('audio_source_no_input_device', 'No microphone was found')
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return new AuroraVoiceWebRuntimeError('audio_source_unavailable', 'Voice capture is not available')
    }
  }
  return new AuroraVoiceWebRuntimeError('audio_source_start_failed', 'Voice capture could not start')
}

function browserErrorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop()
    } catch {
      // Best-effort release.
    }
  }
}

function safeDisconnect(node: { disconnect(): void } | null | undefined): void {
  try {
    node?.disconnect()
  } catch {
    // Best-effort release.
  }
}

function safeClosePort(port: MessagePort | null | undefined): void {
  try {
    port?.close()
  } catch {
    // Best-effort release.
  }
}

async function safeCloseContext(context: AuroraAudioContextLike | null): Promise<void> {
  try {
    await context?.close()
  } catch {
    // Best-effort release.
  }
}

declare global {
  interface Window {
    readonly webkitAudioContext?: typeof AudioContext
  }

  // Safari exposes this constructor on globalThis, but TypeScript does not.
  // eslint-disable-next-line no-var
  var webkitAudioContext: typeof AudioContext | undefined
}
