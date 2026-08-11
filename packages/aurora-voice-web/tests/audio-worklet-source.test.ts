import { describe, expect, it, vi } from 'vitest'

import {
  AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ,
  AuroraAudioWorkletFrameAssembler,
  AuroraStreamingPcm16Resampler,
  BrowserAudioWorkletPcmSource,
  type AuroraAudioNodeLike,
  type AuroraAudioContextLike,
  type AuroraAudioWorkletNodeLike,
  type AuroraBrowserAudioWorkletSourceOptions,
  type AuroraMediaStreamAudioSourceNodeLike
} from '../src/audio-worklet-source.js'
import { AuroraAudioWorkletProcessorCore, type AuroraAudioWorkletProcessorPort } from '../src/audio-worklet-processor.js'
import type { AuroraPcmFrame, AuroraVoiceWebSession } from '../src/types.js'

describe('AuroraStreamingPcm16Resampler', () => {
  it('resamples 48 kHz and 44.1 kHz input into deterministic 16 kHz PCM', () => {
    const from48 = new AuroraStreamingPcm16Resampler(48_000)
    const from441 = new AuroraStreamingPcm16Resampler(44_100)

    expect(from48.push(ramp(4_800))).toHaveLength(1_600)
    expect(from441.push(ramp(4_410))).toHaveLength(1_600)
    expect(from48.push(ramp(2_400))).toHaveLength(800)
    expect(from441.push(ramp(2_205))).toHaveLength(800)
  })

  it('keeps continuous resampling phase across chunk boundaries', () => {
    const chunked = new AuroraStreamingPcm16Resampler(44_100)
    const oneShot = new AuroraStreamingPcm16Resampler(44_100)
    const first = ramp(1_001)
    const second = ramp(2_357)
    const joined = new Float32Array(first.length + second.length)
    joined.set(first)
    joined.set(second, first.length)

    const chunkedOut = concatI16(chunked.push(first), chunked.push(second))
    const oneShotOut = oneShot.push(joined)

    expect(Array.from(chunkedOut)).toEqual(Array.from(oneShotOut))
  })
})

describe('AuroraAudioWorkletFrameAssembler', () => {
  it('emits exact 20 ms frame sequences and marks discontinuity after pressure drops', async () => {
    const sink = new DeferredSink()
    const assembler = new AuroraAudioWorkletFrameAssembler(session(), sink, { frameMs: 20, maxPendingFrames: 1 })

    await assembler.pushFloat32('session-a', 48_000, constant(9_600, 0.25))
    expect(sink.frames.map((frame) => frame.sequence)).toEqual([0])
    expect(assembler.snapshot()).toMatchObject({ pendingFrames: 1, droppedFrames: 9 })
    sink.resolveAll()
    await nextTurn()
    await assembler.pushFloat32('session-a', 48_000, constant(960, 0.25))
    expect(sink.frames[1]?.discontinuity).toBe(true)
    sink.resolveAll()
    await assembler.flush()

    expect(sink.frames[0]?.pcm).toHaveLength(320)
  })

  it('rejects stale session chunks without leaking frames', async () => {
    const sink = new RecordingSink()
    const assembler = new AuroraAudioWorkletFrameAssembler(session(), sink)
    await assembler.pushFloat32('old-session', 48_000, constant(960, 0.5))
    await assembler.flush()
    expect(sink.frames).toHaveLength(0)
  })

  it('flushes bounded tail on stop and erases it on cancel', async () => {
    const stopSink = new RecordingSink()
    const stopAssembler = new AuroraAudioWorkletFrameAssembler(session(), stopSink, { frameMs: 20 })
    await stopAssembler.pushFloat32('session-a', 48_000, constant(480, 0.5))
    await stopAssembler.flush()
    expect(stopSink.frames).toHaveLength(1)
    expect(stopSink.frames[0]?.pcm).toHaveLength(320)

    const cancelSink = new RecordingSink()
    const cancelAssembler = new AuroraAudioWorkletFrameAssembler(session(), cancelSink, { frameMs: 20 })
    await cancelAssembler.pushFloat32('session-a', 48_000, constant(480, 0.5))
    cancelAssembler.cancel()
    await cancelAssembler.flush()
    expect(cancelSink.frames).toHaveLength(0)
    expect(cancelAssembler.snapshot()).toMatchObject({ tailSamples: 0 })
  })
})

describe('AuroraAudioWorkletProcessorCore', () => {
  it('posts transferable mono blocks with variable render-block lengths', () => {
    const port = new FakeProcessorPort()
    const processor = new AuroraAudioWorkletProcessorCore(port, 'session-a', 48_000)

    expect(processor.process([[
      new Float32Array([0.5, 0.25, 0, -0.25, -0.5]),
      new Float32Array([0.5, 0.25, 0, -0.25, -0.5])
    ]])).toBe(true)
    expect(processor.process([[new Float32Array(257).fill(0.125)]])).toBe(true)

    expect(port.messages[0]).toMatchObject({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, sequence: 0 })
    expect((port.messages[0] as { samples: Float32Array }).samples).toHaveLength(5)
    expect(port.transfers[0]?.[0]).toBe((port.messages[0] as { samples: Float32Array }).samples.buffer)
    expect((port.messages[1] as { samples: Float32Array }).samples).toHaveLength(257)
  })

  it('acks stop, closes the port, and returns false after cleanup', () => {
    const port = new FakeProcessorPort()
    const processor = new AuroraAudioWorkletProcessorCore(port, 'session-a', 44_100)

    port.onmessage?.({ data: { type: 'stop', sessionId: 'stale', requestId: 'ignored' } } as MessageEvent<unknown>)
    expect(processor.process([[constant(128, 0.1)]])).toBe(true)
    port.onmessage?.({ data: { type: 'stop', sessionId: 'session-a', requestId: 'stop-1' } } as MessageEvent<unknown>)

    expect(port.closed).toBe(true)
    expect(port.messages.at(-1)).toEqual({ type: 'stopped', requestId: 'stop-1' })
    expect(processor.process([[constant(128, 0.1)]])).toBe(false)
  })
})

describe('BrowserAudioWorkletPcmSource', () => {
  it('starts transactionally, transfers worklet audio, flushes on stop, and cleans every browser resource', async () => {
    const ports = new FakeBrowserPorts()
    const sink = new RecordingSink()
    const source = new BrowserAudioWorkletPcmSource(ports.options({ frameMs: 20 }))

    await source.start(session(), sink)
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(960, 0.5) })
    await source.stop('session-a')

    expect(sink.frames).toHaveLength(1)
    expect(ports.trackStopped).toBe(true)
    expect(ports.sourceDisconnected).toBe(true)
    expect(ports.nodeDisconnected).toBe(true)
    expect(ports.contextClosed).toBe(true)
    expect(ports.portClosed).toBe(true)
  })

  it('resumes a suspended context during start and serializes concurrent worklet blocks', async () => {
    const ports = new FakeBrowserPorts({ initialContextState: 'suspended' })
    const sink = new RecordingSink()
    const source = new BrowserAudioWorkletPcmSource(ports.options({ frameMs: 20 }))

    await source.start(session(), sink)
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(960, 0.25) })
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(960, -0.25) })
    await source.stop('session-a')

    expect(ports.context.resumeCalls).toBe(1)
    expect(sink.frames.map((frame) => frame.sequence)).toEqual([0, 1])
    expect(sink.frames.every((frame) => frame.pcm.length === 320)).toBe(true)
  })

  it('cleans resources after permission/start failure without exposing device data', async () => {
    const ports = new FakeBrowserPorts({ failAddModule: true })
    const source = new BrowserAudioWorkletPcmSource(ports.options())

    await expect(source.start(session(), new RecordingSink())).rejects.toMatchObject({
      code: 'audio_source_start_failed',
      message: 'Voice capture could not start'
    })
    expect(ports.trackStopped).toBe(true)
    expect(ports.contextClosed).toBe(true)
  })

  it('classifies browser microphone startup errors without exposing device details', async () => {
    const cases = [
      ['NotAllowedError', 'audio_source_permission_denied', 'Microphone permission was denied'],
      ['SecurityError', 'audio_source_permission_denied', 'Microphone permission was denied'],
      ['NotFoundError', 'audio_source_no_input_device', 'No microphone was found'],
      ['DevicesNotFoundError', 'audio_source_no_input_device', 'No microphone was found'],
      ['NotReadableError', 'audio_source_unavailable', 'Voice capture is not available'],
      ['AbortError', 'audio_source_unavailable', 'Voice capture is not available']
    ] as const

    for (const [name, code, message] of cases) {
      const source = new BrowserAudioWorkletPcmSource({
        mediaDevices: {
          getUserMedia: async () => {
            throw new DOMException('/private/device/path', name)
          }
        },
        audioContextFactory: () => new FakeBrowserPorts().context,
        workletNodeFactory: () => new FakeBrowserPorts().workletNode,
        processorUrl: 'processor.js'
      })

      await expect(source.start(session(), new RecordingSink())).rejects.toMatchObject({ code, message })
      await expect(source.start(session(), new RecordingSink())).rejects.not.toThrow('/private/device/path')
    }
  })

  it('classifies name-shaped microphone startup errors when DOMException is unavailable', async () => {
    const originalDomException = globalThis.DOMException
    vi.stubGlobal('DOMException', undefined)
    try {
      const source = new BrowserAudioWorkletPcmSource({
        mediaDevices: {
          getUserMedia: async () => {
            throw { name: 'NotAllowedError', message: '/private/device/path' }
          }
        },
        audioContextFactory: () => new FakeBrowserPorts().context,
        workletNodeFactory: () => new FakeBrowserPorts().workletNode,
        processorUrl: 'processor.js'
      })

      await expect(source.start(session(), new RecordingSink())).rejects.toMatchObject({
        code: 'audio_source_permission_denied',
        message: 'Microphone permission was denied'
      })
      await expect(source.start(session(), new RecordingSink())).rejects.not.toThrow('/private/device/path')
    } finally {
      vi.stubGlobal('DOMException', originalDomException)
    }
  })

  it('stops a late getUserMedia stream after start timeout', async () => {
    const lateStream = new FakeMediaStream()
    let resolveStream!: (stream: MediaStream) => void
    const source = new BrowserAudioWorkletPcmSource({
      mediaDevices: {
        getUserMedia: async () => await new Promise<MediaStream>((resolve) => {
          resolveStream = resolve
        })
      },
      audioContextFactory: () => new FakeBrowserPorts().context,
      workletNodeFactory: () => new FakeBrowserPorts().workletNode,
      processorUrl: 'processor.js',
      startTimeoutMs: 100
    })

    await expect(source.start(session(), new RecordingSink())).rejects.toMatchObject({ code: 'audio_source_start_timeout' })
    resolveStream(lateStream as unknown as MediaStream)
    await nextTurn()

    expect(lateStream.track.stopped).toBe(true)
  })

  it('cancels a pending start before a late microphone stream can become active', async () => {
    const lateStream = new FakeMediaStream()
    let resolveStream!: (stream: MediaStream) => void
    let contextCreated = false
    const source = new BrowserAudioWorkletPcmSource({
      mediaDevices: {
        getUserMedia: async () => await new Promise<MediaStream>((resolve) => {
          resolveStream = resolve
        })
      },
      audioContextFactory: () => {
        contextCreated = true
        return new FakeBrowserPorts().context
      },
      workletNodeFactory: () => new FakeBrowserPorts().workletNode,
      processorUrl: 'processor.js',
      startTimeoutMs: 1_000
    })

    const starting = source.start(session(), new RecordingSink())
    await nextTurn()
    await source.cancel('session-a')
    resolveStream(lateStream as unknown as MediaStream)

    await expect(starting).rejects.toMatchObject({ code: 'audio_source_start_cancelled' })
    expect(lateStream.track.stopped).toBe(true)
    expect(contextCreated).toBe(false)
  })

  it('cancels idempotently and erases queued tail without flushing', async () => {
    const ports = new FakeBrowserPorts()
    const sink = new RecordingSink()
    const source = new BrowserAudioWorkletPcmSource(ports.options({ frameMs: 20 }))

    await source.start(session(), sink)
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(480, 0.5) })
    await source.cancel('session-a')
    await source.cancel('session-a')
    await source.stop('session-a')

    expect(sink.frames).toHaveLength(0)
    expect(ports.trackStopped).toBe(true)
    expect(ports.portClosed).toBe(true)
  })

  it('releases capture immediately on cancel even when the processor never acks', async () => {
    const ports = new FakeBrowserPorts({ autoAckControl: false })
    const sink = new RecordingSink()
    const source = new BrowserAudioWorkletPcmSource(ports.options({ frameMs: 20, stopTimeoutMs: 1_000 }))

    await source.start(session(), sink)
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(480, 0.5) })
    await expect(Promise.race([
      source.cancel('session-a').then(() => 'cancelled'),
      delay(25).then(() => 'timeout')
    ])).resolves.toBe('cancelled')

    expect(sink.frames).toHaveLength(0)
    expect(ports.trackStopped).toBe(true)
    expect(ports.portClosed).toBe(true)
    expect(ports.contextClosed).toBe(true)
  })

  it('releases capture within the default stop gate even when the processor never acks', async () => {
    const ports = new FakeBrowserPorts({ autoAckControl: false })
    const sink = new RecordingSink()
    const source = new BrowserAudioWorkletPcmSource(ports.options({ frameMs: 20 }))

    await source.start(session(), sink)
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(480, 0.5) })
    await expect(Promise.race([
      source.stop('session-a').then(() => 'stopped'),
      delay(250).then(() => 'timeout')
    ])).resolves.toBe('stopped')

    expect(sink.frames).toHaveLength(1)
    expect(ports.trackStopped).toBe(true)
    expect(ports.portClosed).toBe(true)
    expect(ports.contextClosed).toBe(true)
    expect(() => new BrowserAudioWorkletPcmSource(ports.options({ resourceReleaseTimeoutMs: 251 }))).toThrow()
  })

  it('fails closed when the browser track ends and reports a redacted lifecycle reason', async () => {
    const ports = new FakeBrowserPorts()
    const reasons: string[] = []
    const sink = new RecordingSink()
    const source = new BrowserAudioWorkletPcmSource(ports.options({
      frameMs: 20,
      onLifecycleLost: (reason) => reasons.push(reason)
    }))

    await source.start(session(), sink)
    ports.postFromWorklet({ type: 'audio', sessionId: 'session-a', sampleRateHz: 48_000, samples: constant(480, 0.5) })
    ports.stream.track.end()
    await nextTurn()

    expect(reasons).toEqual(['track_ended'])
    expect(sink.frames).toHaveLength(0)
    expect(ports.trackStopped).toBe(true)
    expect(ports.contextClosed).toBe(true)
  })

  it('fails closed when the browser context is suspended after start', async () => {
    const ports = new FakeBrowserPorts()
    const reasons: string[] = []
    const source = new BrowserAudioWorkletPcmSource(ports.options({
      onLifecycleLost: (reason) => reasons.push(reason)
    }))

    await source.start(session(), new RecordingSink())
    ports.context.suspendFromBrowser()
    await nextTurn()

    expect(reasons).toEqual(['context_suspended'])
    expect(ports.trackStopped).toBe(true)
    expect(ports.portClosed).toBe(true)
  })

  it('cleans up when lifecycle notification throws', async () => {
    const ports = new FakeBrowserPorts()
    const source = new BrowserAudioWorkletPcmSource(ports.options({
      onLifecycleLost: () => {
        throw new Error('/device/path')
      }
    }))

    await source.start(session(), new RecordingSink())
    ports.stream.track.end()
    await nextTurn()

    expect(ports.trackStopped).toBe(true)
    expect(ports.contextClosed).toBe(true)
    expect(ports.portClosed).toBe(true)
  })
})

describe('AuroraAudioWorkletFrameAssembler sink outcomes', () => {
  it('marks the next accepted frame discontinuous after sink false or rejection', async () => {
    const falseSink = new OutcomeSink([false, true])
    const falseAssembler = new AuroraAudioWorkletFrameAssembler(session(), falseSink, { frameMs: 20 })
    await falseAssembler.pushFloat32('session-a', 48_000, constant(960, 0.25))
    await nextTurn()
    expect(falseAssembler.snapshot()).toMatchObject({ droppedFrames: 1 })
    await falseAssembler.pushFloat32('session-a', 48_000, constant(960, 0.25))
    expect(falseSink.frames[1]?.discontinuity).toBe(true)

    const rejectSink = new OutcomeSink(['reject', true])
    const rejectAssembler = new AuroraAudioWorkletFrameAssembler(session(), rejectSink, { frameMs: 20 })
    await rejectAssembler.pushFloat32('session-a', 48_000, constant(960, 0.25))
    await nextTurn()
    expect(rejectAssembler.snapshot()).toMatchObject({ droppedFrames: 1 })
    await rejectAssembler.pushFloat32('session-a', 48_000, constant(960, 0.25))
    expect(rejectSink.frames[1]?.discontinuity).toBe(true)
  })
})

function session(): AuroraVoiceWebSession {
  return Object.freeze({
    ownerId: 'owner-a',
    sessionId: 'session-a',
    generation: 1,
    startedAtMs: 10,
    foregroundOnly: true
  })
}

function ramp(length: number): Float32Array {
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) samples[index] = Math.sin(index / 31)
  return samples
}

function constant(length: number, value: number): Float32Array {
  return new Float32Array(length).fill(value)
}

function concatI16(first: Int16Array, second: Int16Array): Int16Array {
  const joined = new Int16Array(first.length + second.length)
  joined.set(first)
  joined.set(second, first.length)
  return joined
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

class RecordingSink {
  readonly frames: AuroraPcmFrame[] = []

  async pushFrame(frame: AuroraPcmFrame): Promise<boolean> {
    this.frames.push({ ...frame, pcm: new Int16Array(frame.pcm) })
    return true
  }
}

class DeferredSink extends RecordingSink {
  private resolvers: (() => void)[] = []

  override async pushFrame(frame: AuroraPcmFrame): Promise<boolean> {
    this.frames.push({ ...frame, pcm: new Int16Array(frame.pcm) })
    await new Promise<void>((resolve) => this.resolvers.push(resolve))
    return true
  }

  resolveAll(): void {
    for (const resolve of this.resolvers.splice(0)) resolve()
  }
}

class OutcomeSink extends RecordingSink {
  constructor(private readonly outcomes: Array<boolean | 'reject'>) {
    super()
  }

  override async pushFrame(frame: AuroraPcmFrame): Promise<boolean> {
    this.frames.push({ ...frame, pcm: new Int16Array(frame.pcm) })
    const outcome = this.outcomes.shift() ?? true
    if (outcome === 'reject') throw new Error('/device/path')
    return outcome
  }
}

class FakeProcessorPort implements MessagePort, AuroraAudioWorkletProcessorPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  readonly messages: unknown[] = []
  readonly transfers: Transferable[][] = []
  closed = false

  postMessage(message: unknown, transfer: Transferable[]): void
  postMessage(message: unknown, options?: StructuredSerializeOptions): void
  postMessage(message: unknown, transferOrOptions: Transferable[] | StructuredSerializeOptions = []): void {
    this.messages.push(message)
    this.transfers.push(Array.isArray(transferOrOptions) ? transferOrOptions : [])
  }

  close(): void {
    this.closed = true
  }

  start(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true
  }
}

interface WorkletAudioMessage {
  readonly type: 'audio'
  readonly sessionId: string
  readonly sampleRateHz: number
  readonly samples: Float32Array
}

class FakeBrowserPorts {
  readonly stream: FakeMediaStream
  readonly context: FakeAudioContext
  readonly sourceNode: FakeSourceNode
  readonly workletNode: FakeWorkletNode
  readonly failAddModule: boolean
  readonly initialContextState: AudioContextState
  readonly autoAckControl: boolean

  constructor(options: { failAddModule?: boolean; initialContextState?: AudioContextState; autoAckControl?: boolean } = {}) {
    this.failAddModule = options.failAddModule === true
    this.initialContextState = options.initialContextState ?? 'running'
    this.autoAckControl = options.autoAckControl ?? true
    this.stream = new FakeMediaStream()
    this.context = new FakeAudioContext(this)
    this.sourceNode = new FakeSourceNode(this)
    this.workletNode = new FakeWorkletNode(this)
  }

  get trackStopped(): boolean {
    return this.stream.track.stopped
  }

  get sourceDisconnected(): boolean {
    return this.sourceNode.disconnected
  }

  get nodeDisconnected(): boolean {
    return this.workletNode.disconnected
  }

  get contextClosed(): boolean {
    return this.context.closed
  }

  get portClosed(): boolean {
    return this.workletNode.port.closed
  }

  options(overrides: AuroraBrowserAudioWorkletSourceOptions = {}): AuroraBrowserAudioWorkletSourceOptions {
    return {
      mediaDevices: {
        getUserMedia: async () => this.stream as unknown as MediaStream
      },
      audioContextFactory: () => this.context,
      workletNodeFactory: () => this.workletNode,
      processorUrl: 'processor.js',
      ...overrides
    }
  }

  postFromWorklet(message: WorkletAudioMessage): void {
    this.workletNode.port.onmessage?.({ data: message } as MessageEvent<unknown>)
  }
}

class FakeTrack {
  stopped = false
  private readonly endedListeners = new Set<EventListener>()

  stop(): void {
    this.stopped = true
  }

  addEventListener(type: 'ended', listener: EventListener): void {
    if (type === 'ended') this.endedListeners.add(listener)
  }

  removeEventListener(type: 'ended', listener: EventListener): void {
    if (type === 'ended') this.endedListeners.delete(listener)
  }

  end(): void {
    for (const listener of this.endedListeners) listener(new Event('ended'))
  }
}

class FakeMediaStream {
  readonly track = new FakeTrack()
  getTracks(): FakeTrack[] {
    return [this.track]
  }
}

class FakeAudioContext implements AuroraAudioContextLike {
  readonly sampleRate = AURORA_AUDIO_WORKLET_OUTPUT_SAMPLE_RATE_HZ
  state: AudioContextState
  closed = false
  resumeCalls = 0
  private readonly stateListeners = new Set<EventListener>()
  readonly audioWorklet = {
    addModule: async (_url: string): Promise<void> => {
      if (this.ports.failAddModule) throw new Error('/device/path')
    }
  }

  constructor(private readonly ports: FakeBrowserPorts) {
    this.state = ports.initialContextState
  }

  createMediaStreamSource(_stream: MediaStream): AuroraMediaStreamAudioSourceNodeLike {
    return this.ports.sourceNode
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.state = 'closed'
    this.closed = true
  }

  addEventListener(type: 'statechange', listener: EventListener): void {
    if (type === 'statechange') this.stateListeners.add(listener)
  }

  removeEventListener(type: 'statechange', listener: EventListener): void {
    if (type === 'statechange') this.stateListeners.delete(listener)
  }

  suspendFromBrowser(): void {
    this.state = 'suspended'
    for (const listener of this.stateListeners) listener(new Event('statechange'))
  }
}

class FakeSourceNode implements AuroraMediaStreamAudioSourceNodeLike {
  disconnected = false

  constructor(private readonly ports: FakeBrowserPorts) {}

  connect(_destination: AuroraAudioNodeLike): AuroraAudioNodeLike {
    return this.ports.workletNode
  }

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeWorkletNode extends EventTarget implements AuroraAudioWorkletNodeLike {
  readonly port = new FakeBrowserMessagePort()
  disconnected = false

  constructor(readonly ports: FakeBrowserPorts) {
    super()
    this.port.owner = ports
  }

  disconnect(): void {
    this.disconnected = true
  }

  connect(): AuroraAudioNodeLike {
    return this
  }
}

class FakeBrowserMessagePort extends FakeProcessorPort {
  owner: FakeBrowserPorts | null = null

  override postMessage(message: unknown, transfer: Transferable[]): void
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void
  override postMessage(message: unknown, transferOrOptions: Transferable[] | StructuredSerializeOptions = []): void {
    if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions)
    else super.postMessage(message, transferOrOptions)
    if (typeof message === 'object' && message !== null) {
      const typed = message as { type?: string; requestId?: string }
      if (this.owner?.autoAckControl === false) return
      if (typed.type === 'stop') this.onmessage?.({ data: { type: 'stopped', requestId: typed.requestId } } as MessageEvent<unknown>)
      if (typed.type === 'cancel') this.onmessage?.({ data: { type: 'cancelled', requestId: typed.requestId } } as MessageEvent<unknown>)
    }
  }
}
