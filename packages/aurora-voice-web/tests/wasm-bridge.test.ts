import { describe, expect, it } from 'vitest'

import { createAuroraBrowserVoiceRuntime } from '../src/browser-runtime.js'
import { AuroraWasmVoiceBridge } from '../src/wasm-bridge.js'
import type { AuroraPcmFrameEnvelope, AuroraVoiceWebSession } from '../src/types.js'
import type * as AuroraVoiceWasmModule from '../src/wasm/aurora_voice_wasm.js'

const session: AuroraVoiceWebSession = Object.freeze({
  ownerId: 'owner',
  sessionId: 'owner:7',
  generation: 7,
  startedAtMs: 12,
  foregroundOnly: true
})

describe('AuroraWasmVoiceBridge', () => {
  it('maps external session generations to Rust ownership and returns redacted captured audio', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 1, pcm: [11, -12, 13] })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 1_700_000_000_000 })

    await bridge.startSession(session)
    await bridge.pushPcmI16(frame(0), new Int16Array([1, 2]))
    const audio = await bridge.stopSession(session.sessionId, session.generation)
    await expect(bridge.stopSession(session.sessionId, 8)).rejects.toMatchObject({ code: 'stale_generation' })
    await bridge.finishTurn(session.sessionId, session.generation, 'completed')

    expect(runtime.calls.map((call) => call.type)).toEqual(['start', 'push', 'stop', 'complete'])
    expect(runtime.calls[0]?.routeRevision).toBe(1)
    expect(runtime.calls.map((call) => call.generation)).toEqual([undefined, 1, 1, 1])
    expect(audio).toMatchObject({
      sessionId: session.sessionId,
      generation: 7,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: 3,
      durationMs: 1,
      redacted: true
    })
    expect([...audio.pcm]).toEqual([11, -12, 13])
  })

  it('keeps stopped ownership pending when completion fails, then allows repeat after successful completion', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 1, failCompleteOnce: true })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 10 })

    await bridge.startSession(session)
    await bridge.stopSession(session.sessionId, session.generation)

    await expect(bridge.finishTurn(session.sessionId, session.generation, 'completed')).rejects.toMatchObject({ code: 'wasm_rejected' })
    await expect(bridge.startSession({ ...session, generation: 8, sessionId: 'owner:8' })).rejects.toMatchObject({ code: 'session_active' })

    await bridge.finishTurn(session.sessionId, session.generation, 'completed')
    await bridge.startSession({ ...session, generation: 8, sessionId: 'owner:8' })

    expect(runtime.calls.map((call) => call.type)).toEqual(['start', 'stop', 'complete', 'complete', 'start'])
  })

  it('abandons stopped ownership and rejects stale settlement afterward', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 3 })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 10 })

    await bridge.startSession(session)
    await bridge.stopSession(session.sessionId, session.generation)
    await bridge.finishTurn(session.sessionId, session.generation, 'abandoned')

    await expect(bridge.finishTurn(session.sessionId, session.generation, 'completed')).rejects.toMatchObject({ code: 'stale_generation' })
    expect(runtime.calls.map((call) => call.type)).toEqual(['start', 'stop', 'abandon'])
    expect(runtime.calls.at(-1)).toMatchObject({ generation: 3 })
  })

  it('cancels active Rust ownership, frees on shutdown, and rejects stale frame ownership', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 4 })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 10 })

    await bridge.startSession(session)
    await expect(bridge.pushPcmI16(frame(0, { sessionId: 'other' }), new Int16Array([1]))).rejects.toMatchObject({ code: 'stale_generation' })
    await bridge.cancelGeneration(session.sessionId, session.generation, 'shutdown')

    expect(runtime.calls.map((call) => call.type)).toEqual(['start', 'cancel'])
    expect(runtime.calls.at(-1)).toMatchObject({ generation: 4 })
    expect(runtime.freed).toBe(true)
  })

  it('rejects stale null shutdown without clearing active Rust ownership', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 4 })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 10 })

    await bridge.startSession(session)
    await expect(bridge.cancelGeneration(null, 99, 'shutdown')).rejects.toMatchObject({ code: 'stale_generation' })
    await bridge.cancelGeneration(session.sessionId, session.generation, 'shutdown')

    expect(runtime.freed).toBe(true)
    expect(runtime.calls.map((call) => call.type)).toEqual(['start', 'cancel'])
  })

  it('rejects WASM capabilities that are not exactly unavailable', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 1, capabilities: { vad: true, kws: false, stt: false, tts: false } })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 10 })

    await expect(bridge.snapshot()).rejects.toMatchObject({ code: 'snapshot_failed' })
  })

  it('enforces per-frame bounds before crossing the WASM boundary', async () => {
    const runtime = new FakeWasmRuntime({ nextGeneration: 1 })
    const bridge = new AuroraWasmVoiceBridge({ bindings: bindingsFor(runtime), nowMs: () => 10 })

    await bridge.startSession(session)
    await expect(bridge.pushPcmI16(frame(0, { sampleCount: 4_801, byteLength: 9_602 }), new Int16Array(4_801))).rejects.toMatchObject({ code: 'frame_bounds' })

    expect(runtime.calls.map((call) => call.type)).toEqual(['start'])
  })

  it('keeps the default browser facade free of a static WASM binding import', () => {
    const browserRuntimeSource = String(createAuroraBrowserVoiceRuntime)

    expect(browserRuntimeSource).not.toContain('aurora_voice_wasm')
    expect(browserRuntimeSource).not.toContain('AuroraWasmVoiceBridge')
  })
})

function frame(sequence: number, overrides: Partial<AuroraPcmFrameEnvelope> = {}): AuroraPcmFrameEnvelope {
  return Object.freeze({
    sessionId: session.sessionId,
    generation: session.generation,
    sequence,
    discontinuity: false,
    sampleRateHz: 16_000 as const,
    channels: 1 as const,
    sampleCount: 2,
    byteLength: 4,
    queuedBytes: 4,
    ...overrides
  })
}

function bindingsFor(runtime: FakeWasmRuntime): () => Promise<typeof AuroraVoiceWasmModule> {
  return async () => ({
    default: async () => undefined,
    AuroraVoiceWasmRuntime: class {
      constructor(_config?: unknown) {
        return runtime
      }
    }
  }) as unknown as typeof AuroraVoiceWasmModule
}

class FakeWasmRuntime {
  readonly calls: Array<{ readonly type: string; readonly generation: number | undefined; readonly routeRevision: number | undefined }> = []
  readonly nextGeneration: number
  readonly pcm: readonly number[]
  readonly capabilityValue: unknown
  private failCompleteOnce: boolean
  freed = false

  constructor(options: { readonly nextGeneration: number; readonly pcm?: readonly number[]; readonly failCompleteOnce?: boolean; readonly capabilities?: unknown }) {
    this.nextGeneration = options.nextGeneration
    this.pcm = options.pcm ?? [1, 2]
    this.capabilityValue = options.capabilities ?? { vad: false, kws: false, stt: false, tts: false }
    this.failCompleteOnce = options.failCompleteOnce === true
  }

  start_session(request: unknown): unknown {
    this.calls.push({ type: 'start', generation: undefined, routeRevision: routeRevisionFrom(request) })
    return { generation: this.nextGeneration }
  }

  push_pcm_i16(frameRequest: unknown): void {
    this.calls.push({ type: 'push', generation: generationFrom(frameRequest), routeRevision: undefined })
  }

  stop_session(request: unknown): unknown {
    this.calls.push({ type: 'stop', generation: generationFrom(request), routeRevision: undefined })
    return { sample_count: this.pcm.length, pcm_i16: Int16Array.from(this.pcm) }
  }

  complete_turn(request: unknown): string {
    this.calls.push({ type: 'complete', generation: generationFrom(request), routeRevision: undefined })
    if (this.failCompleteOnce) {
      this.failCompleteOnce = false
      throw new Error('complete failed')
    }
    return 'Idle'
  }

  abandon_turn(request: unknown): string {
    this.calls.push({ type: 'abandon', generation: generationFrom(request), routeRevision: undefined })
    return 'Idle'
  }

  cancel_generation(request: unknown): void {
    this.calls.push({ type: 'cancel', generation: generationFrom(request), routeRevision: undefined })
  }

  snapshot(): unknown {
    return {}
  }

  capabilities(): unknown {
    return this.capabilityValue
  }

  free(): void {
    this.freed = true
  }
}

function routeRevisionFrom(value: unknown): number | undefined {
  return typeof value === 'object' && value !== null && typeof (value as { route_revision?: unknown }).route_revision === 'number'
    ? (value as { route_revision: number }).route_revision
    : undefined
}

function generationFrom(value: unknown): number | undefined {
  return typeof value === 'object' && value !== null && typeof (value as { generation?: unknown }).generation === 'number'
    ? (value as { generation: number }).generation
    : undefined
}
