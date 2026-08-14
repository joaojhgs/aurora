import {
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AuroraVoiceWebRuntimeError,
  type AuroraCapturedAudio,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceTurnFinishOutcome,
  type AuroraVoiceWebCapabilities,
  type AuroraVoiceWebModelBindings,
  type AuroraVoiceWebSherpaAssets,
  type AuroraVoiceWebSession
} from './types.js'
import { AuroraSherpaWasmVoiceEngine, type AuroraSherpaVoiceEngine } from './sherpa-engine.js'
import type { AuroraVoiceWasmBridge } from './worker-dispatcher.js'
import type * as AuroraVoiceWasmModule from './wasm/aurora_voice_wasm.js'

const DEFAULT_WASM_MAX_FRAMES = 4_096
const DEFAULT_WASM_MAX_SAMPLES = 16_000 * 60
const MAX_CAPTURED_AUDIO_SAMPLES = 16_000 * 60
const MAX_FRAME_SAMPLES = 4_800
const MICROS_PER_MS = 1_000
const RUST_ROUTE_REVISION = 1

type AuroraVoiceWasmBindings = typeof AuroraVoiceWasmModule
type AuroraVoiceWasmRuntime = InstanceType<AuroraVoiceWasmBindings['AuroraVoiceWasmRuntime']>
type AuroraVoiceWasmUrl = string | URL
type AuroraVoiceWasmBindingsLoader = (wasmUrl?: AuroraVoiceWasmUrl) => Promise<AuroraVoiceWasmBindings>

interface AuroraWasmVoiceBridgeOptions {
  readonly bindings?: AuroraVoiceWasmBindingsLoader
  readonly wasmUrl?: AuroraVoiceWasmUrl
  readonly sherpaEngine?: AuroraSherpaVoiceEngine
  readonly sherpaAssets?: AuroraVoiceWebSherpaAssets
  readonly surface?: string
  readonly maxFrames?: number
  readonly maxSamples?: number
  readonly nowMs?: () => number
}

interface GenerationOwnership {
  readonly sessionId: string
  readonly externalGeneration: number
  readonly rustGeneration: number
  stopped: boolean
}

export class AuroraWasmVoiceBridge implements AuroraVoiceWasmBridge {
  private readonly bindingsLoader: AuroraVoiceWasmBindingsLoader
  private readonly surface: string
  private readonly maxFrames: number
  private readonly maxSamples: number
  private readonly nowMs: () => number
  private readonly wasmUrl: AuroraVoiceWasmUrl | undefined
  private readonly sherpaEngine: AuroraSherpaVoiceEngine
  private readonly defaultSherpaAssets: AuroraVoiceWebSherpaAssets | undefined
  private bindingsPromise: Promise<AuroraVoiceWasmBindings> | null = null
  private runtime: AuroraVoiceWasmRuntime | null = null
  private active: GenerationOwnership | null = null
  private pendingStopped: GenerationOwnership | null = null
  private capabilities: AuroraVoiceWebCapabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES

  constructor(options: AuroraWasmVoiceBridgeOptions = {}) {
    this.bindingsLoader = options.bindings ?? loadAuroraVoiceWasmBindings
    this.wasmUrl = options.wasmUrl
    this.surface = safeSurface(options.surface ?? 'hosted-web')
    this.maxFrames = boundedInteger(options.maxFrames ?? DEFAULT_WASM_MAX_FRAMES, 'maxFrames', 1, DEFAULT_WASM_MAX_FRAMES)
    this.maxSamples = boundedInteger(options.maxSamples ?? DEFAULT_WASM_MAX_SAMPLES, 'maxSamples', 1, DEFAULT_WASM_MAX_SAMPLES)
    this.nowMs = options.nowMs ?? Date.now
    this.sherpaEngine = options.sherpaEngine ?? new AuroraSherpaWasmVoiceEngine()
    this.defaultSherpaAssets = options.sherpaAssets
  }

  async initialize(modelBindings: AuroraVoiceWebModelBindings | undefined): Promise<{ readonly capabilities?: AuroraVoiceWebCapabilities }> {
    await this.ensureRuntime()
    this.capabilities = await this.sherpaEngine.initialize(mergeSherpaAssets(modelBindings, this.defaultSherpaAssets))
    return { capabilities: this.capabilities }
  }

  async startSession(session: AuroraVoiceWebSession): Promise<void> {
    if (this.active !== null || this.pendingStopped !== null) {
      throw sanitizedError('session_active')
    }
    const runtime = await this.ensureRuntime()
    const started = readStartedSession(() => runtime.start_session({
      session_id: safeSessionId(session.sessionId),
      route_revision: RUST_ROUTE_REVISION,
      at_micros: this.nowMicros()
    }))
    this.active = {
      sessionId: session.sessionId,
      externalGeneration: session.generation,
      rustGeneration: started.generation,
      stopped: false
    }
    await this.sherpaEngine.startSession()
  }

  async pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<void> {
    const ownership = this.requireActive(frame.sessionId, frame.generation)
    if (!(pcm instanceof Int16Array) || pcm.length !== frame.sampleCount || pcm.byteLength !== frame.byteLength) {
      throw sanitizedError('audio_shape')
    }
    if (pcm.length === 0 || pcm.length > MAX_FRAME_SAMPLES) {
      throw sanitizedError('frame_bounds')
    }
    await this.withRuntime((runtime) => {
      runtime.push_pcm_i16({
        session_id: ownership.sessionId,
        generation: ownership.rustGeneration,
        sequence: frame.sequence,
        timestamp_micros: this.nowMicros(),
        discontinuity: frame.discontinuity,
        sample_rate_hz: frame.sampleRateHz,
        channels: frame.channels,
        samples: Array.from(pcm)
      })
    })
    await this.sherpaEngine.pushPcmI16(frame, pcm)
  }

  async stopSession(sessionId: string, generation: number): Promise<AuroraCapturedAudio> {
    const ownership = this.requireActive(sessionId, generation)
    const stopped = await this.withRuntime((runtime) => readStoppedSession(() => runtime.stop_session({
      session_id: ownership.sessionId,
      generation: ownership.rustGeneration,
      at_micros: this.nowMicros()
    })))
    const pcm = toBoundedPcm(stopped.pcm_i16, stopped.sample_count)
    await this.sherpaEngine.stopSession()
    ownership.stopped = true
    this.active = null
    this.pendingStopped = ownership
    return Object.freeze({
      sessionId,
      generation,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: pcm.length,
      durationMs: Math.ceil((pcm.length / 16_000) * 1_000),
      pcm,
      redacted: true
    })
  }

  async finishTurn(sessionId: string, generation: number, outcome: AuroraVoiceTurnFinishOutcome): Promise<void> {
    const ownership = this.requirePending(sessionId, generation)
    await this.withRuntime((runtime) => {
      const request = { generation: ownership.rustGeneration, at_micros: this.nowMicros() }
      if (outcome === 'completed') {
        runtime.complete_turn(request)
      } else {
        runtime.abandon_turn(request)
      }
    })
    this.pendingStopped = null
  }

  async cancelGeneration(sessionId: string | null, generation: number, reason: string): Promise<void> {
    const normalizedReason = /^[A-Za-z0-9_.-]{1,48}$/.test(reason) ? reason : 'cancelled'
    if (this.active !== null && this.matches(this.active, sessionId, generation)) {
      const ownership = this.active
      await this.withRuntime((runtime) => {
        runtime.cancel_generation({ generation: ownership.rustGeneration, at_micros: this.nowMicros() })
      })
      this.active = null
      if (normalizedReason === 'shutdown') this.disposeRuntime()
      return
    }
    if (this.pendingStopped !== null && this.matches(this.pendingStopped, sessionId, generation)) {
      const ownership = this.pendingStopped
      await this.withRuntime((runtime) => {
        runtime.abandon_turn({ generation: ownership.rustGeneration, at_micros: this.nowMicros() })
      })
      this.pendingStopped = null
      if (normalizedReason === 'shutdown') this.disposeRuntime()
      return
    }
    if (sessionId === null && normalizedReason === 'shutdown') {
      if (this.active !== null || this.pendingStopped !== null) {
        throw sanitizedError('stale_generation')
      }
      this.disposeRuntime()
      return
    }
    throw sanitizedError('stale_generation')
  }

  async snapshot(): Promise<{ readonly capabilities?: AuroraVoiceWebCapabilities }> {
    const runtime = await this.ensureRuntime()
    try {
      runtime.snapshot()
      readCoreCapabilities(runtime.capabilities())
    } catch {
      throw sanitizedError('snapshot_failed')
    }
    return { capabilities: this.capabilities }
  }

  private async withRuntime<T>(operation: (runtime: AuroraVoiceWasmRuntime) => T): Promise<T> {
    const runtime = await this.ensureRuntime()
    try {
      return operation(runtime)
    } catch {
      throw sanitizedError('wasm_rejected')
    }
  }

  private async ensureRuntime(): Promise<AuroraVoiceWasmRuntime> {
    if (this.runtime !== null) return this.runtime
    if (this.bindingsPromise === null) this.bindingsPromise = this.bindingsLoader(this.wasmUrl)
    const bindings = await this.bindingsPromise
    this.runtime = new bindings.AuroraVoiceWasmRuntime({
      surface: this.surface,
      max_frames: this.maxFrames,
      max_samples: this.maxSamples
    })
    return this.runtime
  }

  private requireActive(sessionId: string, generation: number): GenerationOwnership {
    if (this.active === null || !this.matches(this.active, sessionId, generation)) {
      throw sanitizedError('stale_generation')
    }
    return this.active
  }

  private requirePending(sessionId: string, generation: number): GenerationOwnership {
    if (this.pendingStopped === null || !this.matches(this.pendingStopped, sessionId, generation) || !this.pendingStopped.stopped) {
      throw sanitizedError('stale_generation')
    }
    return this.pendingStopped
  }

  private matches(ownership: GenerationOwnership, sessionId: string | null, generation: number): boolean {
    return (sessionId === null || ownership.sessionId === sessionId) && ownership.externalGeneration === generation
  }

  private nowMicros(): number {
    const micros = Math.trunc(this.nowMs() * MICROS_PER_MS)
    if (!Number.isSafeInteger(micros) || micros < 0) throw sanitizedError('time_bounds')
    return micros
  }

  private disposeRuntime(): void {
    try {
      this.runtime?.free()
    } finally {
      this.runtime = null
      this.bindingsPromise = null
      this.active = null
      this.pendingStopped = null
      this.sherpaEngine.dispose()
      this.capabilities = AURORA_VOICE_WEB_DEFAULT_CAPABILITIES
    }
  }
}

function mergeSherpaAssets(
  bindings: AuroraVoiceWebModelBindings | undefined,
  assets: AuroraVoiceWebSherpaAssets | undefined
): AuroraVoiceWebModelBindings | undefined {
  if (bindings === undefined) return undefined
  if (assets === undefined && bindings.sherpaAssets === undefined) return bindings
  return {
    ...bindings,
    sherpaAssets: {
      ...assets,
      ...bindings.sherpaAssets
    }
  }
}

async function loadAuroraVoiceWasmBindings(wasmUrl?: AuroraVoiceWasmUrl): Promise<AuroraVoiceWasmBindings> {
  const bindings = await import('./wasm/aurora_voice_wasm.js')
  await bindings.default(wasmUrl)
  return bindings
}

function readStartedSession(operation: () => unknown): { readonly generation: number } {
  try {
    const value = operation()
    if (typeof value !== 'object' || value === null) throw sanitizedError('start_shape')
    const generation = (value as { generation?: unknown }).generation
    if (!Number.isSafeInteger(generation) || typeof generation !== 'number' || generation < 1) throw sanitizedError('generation_bounds')
    return { generation }
  } catch {
    throw sanitizedError('start_failed')
  }
}

function readStoppedSession(operation: () => unknown): { readonly sample_count: number; readonly pcm_i16: unknown } {
  try {
    const value = operation()
    if (typeof value !== 'object' || value === null) throw sanitizedError('stop_shape')
    const sampleCount = (value as { sample_count?: unknown }).sample_count
    const pcm = (value as { pcm_i16?: unknown }).pcm_i16
    if (!Number.isSafeInteger(sampleCount) || typeof sampleCount !== 'number' || sampleCount < 0) throw sanitizedError('stop_shape')
    return { sample_count: sampleCount, pcm_i16: pcm }
  } catch {
    throw sanitizedError('stop_failed')
  }
}

function readCoreCapabilities(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { vad?: unknown }).vad !== false ||
    (value as { kws?: unknown }).kws !== false ||
    (value as { stt?: unknown }).stt !== false ||
    (value as { tts?: unknown }).tts !== false
  ) {
    throw sanitizedError('capability_shape')
  }
}

function toBoundedPcm(value: unknown, sampleCount: number): Int16Array {
  const pcm = value instanceof Int16Array
    ? new Int16Array(value)
    : Array.isArray(value)
      ? Int16Array.from(value.map((sample) => {
        if (!Number.isInteger(sample) || sample < -32768 || sample > 32767) throw sanitizedError('audio_shape')
        return sample
      }))
      : null
  if (pcm === null || pcm.length !== sampleCount || pcm.length > MAX_CAPTURED_AUDIO_SAMPLES) throw sanitizedError('audio_shape')
  return pcm
}

function safeSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value)) throw sanitizedError('invalid_id')
  return value
}

function safeSurface(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value)) throw sanitizedError('invalid_option')
  return value
}

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuroraVoiceWebRuntimeError('invalid_option', `${label} is out of range`)
  }
  return value
}

function sanitizedError(code: string): AuroraVoiceWebRuntimeError {
  const safeCode = /^[a-z_]{1,48}$/.test(code) ? code : 'wasm_rejected'
  return new AuroraVoiceWebRuntimeError(safeCode, 'Voice worker is not available')
}
