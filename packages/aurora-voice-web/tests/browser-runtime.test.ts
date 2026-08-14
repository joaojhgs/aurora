import { describe, expect, it } from 'vitest'

import { createAuroraBrowserVoiceRuntime } from '../src/browser-runtime.js'
import { createAuroraBrowserPageLifecycle, type AuroraBrowserPageLifecycleDocument, type AuroraBrowserPageLifecycleListener, type AuroraBrowserPageLifecyclePort, type AuroraBrowserPageLifecycleWindow } from '../src/browser-lifecycle.js'
import { hiddenLifecycle, visibleLifecycle } from '../src/runtime.js'
import { AURORA_VOICE_WORKER_PROTOCOL_VERSION, type AuroraAudioWorkletPcmSink, type AuroraAudioWorkletPcmSource, type AuroraVoiceLifecycleEligibility, type AuroraVoiceWebEvent, type AuroraVoiceWebSession, type AuroraVoiceWorkerRequestEnvelope, type AuroraVoiceWorkerResponseEnvelope } from '../src/types.js'
import type { AuroraAudioContextLike, AuroraAudioWorkletNodeLike, AuroraAudioNodeLike, AuroraMediaStreamAudioSourceNodeLike } from '../src/audio-worklet-source.js'
import type { AuroraBrowserWorkerPort } from '../src/worker-rpc.js'

describe('createAuroraBrowserVoiceRuntime', () => {
  it('constructs a module Worker host and bounded browser runtime without importing WASM on the main facade', async () => {
    const worker = new LoopbackWorker()
    const factoryCalls: Array<{ readonly url: URL; readonly options: WorkerOptions }> = []
    const lifecycleCalls: string[] = []
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      workerFactory: (url, options) => {
        factoryCalls.push({ url, options })
        return worker
      },
      workerTimeoutMs: 500,
      pcmSource: new FakePcmSource(),
      lifecycle: () => ({
        foregroundOnly: true,
        visible: true,
        frozen: false,
        eligible: true,
        reason: 'visible'
      }),
      onAudioLifecycleLost: (reason) => lifecycleCalls.push(`outer:${reason}`),
      sessionIdFactory: (ownerId, generation) => `${ownerId}:${generation}`
    })

    const session = await runtime.start()
    const audio = await runtime.stop()
    await runtime.completeTurn()

    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.options).toEqual({ type: 'module', name: 'aurora-voice-worker' })
    expect(String(factoryCalls[0]?.url)).toContain('voice-worker.js')
    expect(factoryCalls[0]?.url.searchParams.get('wasm')).toBe(new URL('../src/wasm/aurora_voice_wasm_bg.wasm', import.meta.url).href)
    expect(session).toMatchObject({ ownerId: 'browser', sessionId: 'browser:1', generation: 1, foregroundOnly: true })
    expect(audio).toMatchObject({ sessionId: 'browser:1', generation: 1, sampleRateHz: 16_000, channels: 1, redacted: true })
    expect([...worker.commands.map((command) => command.type)]).toEqual(['init', 'start', 'stop', 'finish_turn'])
    expect(lifecycleCalls).toEqual([])
  })

  it('cancels the worker turn when the browser audio lifecycle is lost', async () => {
    const worker = new LoopbackWorker()
    const track = new FakeMediaStreamTrack()
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker,
      workerTimeoutMs: 500,
      audio: {
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) as unknown as MediaStream },
        audioContextFactory: () => new FakeAudioContext(),
        workletNodeFactory: () => new FakeWorkletNode(),
        processorUrl: 'voice-processor.js',
        resourceReleaseTimeoutMs: 1,
        onLifecycleLost: () => undefined
      },
      sessionIdFactory: (ownerId, generation) => `${ownerId}:${generation}`
    })

    await runtime.start()
    track.end()
    await waitFor(() => worker.commands.some((command) => command.type === 'cancel'))

    expect(worker.commands.map((command) => command.type)).toEqual(['init', 'start', 'cancel'])
    expect(runtime.snapshot().state).toBe('cancelled')
  })

  it('passes an explicit generated WASM URL through custom worker URLs without changing the Worker contract', () => {
    const worker = new LoopbackWorker()
    const factoryCalls: Array<{ readonly url: URL; readonly options: WorkerOptions }> = []
    const workerUrl = new URL('https://voice.example/assets/voice-worker.js?cache=1')
    const wasmUrl = new URL('https://voice.example/assets/aurora_voice_wasm_bg.wasm')

    createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      workerFactory: (url, options) => {
        factoryCalls.push({ url, options })
        return worker
      },
      workerUrl,
      wasmUrl,
      pcmSource: new FakePcmSource()
    })

    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.options).toEqual({ type: 'module', name: 'aurora-voice-worker' })
    expect(factoryCalls[0]?.url.href).toBe('https://voice.example/assets/voice-worker.js?cache=1&wasm=https%3A%2F%2Fvoice.example%2Fassets%2Faurora_voice_wasm_bg.wasm')
  })

  it('cancels active capture on pagehide and does not resurrect it on pageshow', async () => {
    const worker = new LoopbackWorker()
    const pageLifecycle = new ControllablePageLifecycle(visibleLifecycle())
    const events: AuroraVoiceWebEvent[] = []
    const lifecycleLosses: string[] = []
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker,
      pcmSource: new FakePcmSource(),
      pageLifecycle,
      onPageLifecycleLost: (reason) => lifecycleLosses.push(reason),
      sessionIdFactory: (ownerId, generation) => `${ownerId}:${generation}`
    })
    runtime.onEvent((event) => events.push(event))

    await runtime.start()
    pageLifecycle.set(hiddenLifecycle('pagehide'))
    pageLifecycle.set(visibleLifecycle())
    await waitFor(() => runtime.snapshot().state === 'cancelled')

    expect(worker.commands.map((command) => command.type)).toEqual(['init', 'start', 'cancel'])
    expect(events).toContainEqual(expect.objectContaining({ kind: 'lifecycle_lost', reason: 'pagehide', redacted: true }))
    expect(lifecycleLosses).toEqual(['pagehide'])
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', lifecycle: { eligible: true, reason: 'visible' } })

    await runtime.start()
    expect(worker.commands.map((command) => command.type)).toEqual(['init', 'start', 'cancel', 'init', 'start'])
    await runtime.dispose()
    expect(pageLifecycle.listenerCount()).toBe(0)
  })

  it('rejects a discarded startup until pageshow restores foreground eligibility', async () => {
    const worker = new LoopbackWorker()
    const pageDocument = new FakePageLifecycleDocument(true)
    const pageWindow = new FakePageLifecycleWindow()
    const pageLifecycle = createAuroraBrowserPageLifecycle({ document: pageDocument, window: pageWindow })
    if (pageLifecycle === null) throw new Error('expected browser page lifecycle')
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker,
      pcmSource: new FakePcmSource(),
      pageLifecycle
    })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'lifecycle_ineligible' })
    expect(worker.commands).toEqual([])

    pageWindow.dispatch('pageshow')
    await runtime.start()
    expect(worker.commands.map((command) => command.type)).toEqual(['init', 'start'])
    await runtime.dispose()
  })

  it('combines page lifecycle with stricter caller focus eligibility', async () => {
    const pageLifecycle = new ControllablePageLifecycle(visibleLifecycle())
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker: new LoopbackWorker(),
      pcmSource: new FakePcmSource(),
      pageLifecycle,
      lifecycle: () => hiddenLifecycle('ineligible')
    })

    await expect(runtime.start()).rejects.toMatchObject({ code: 'lifecycle_ineligible' })
    await runtime.dispose()
  })

  it('transfers cloned selected model bytes to the worker and keeps the runtime copy reusable', async () => {
    const worker = new LoopbackWorker({
      capabilities: { vad: true, kws: false, stt: true, tts: false }
    })
    const selectedBytes = Uint8Array.from([1, 2, 3])
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker,
      pcmSource: new FakePcmSource(),
      modelBindings: {
        files: [{
          task: 'stt',
          fileId: 'tokens',
          virtualPath: '/tokens.txt',
          sha256: 'b'.repeat(64),
          byteLength: selectedBytes.byteLength,
          bytes: selectedBytes
        }]
      },
      sessionIdFactory: (ownerId, generation) => `${ownerId}:${generation}`
    })

    await runtime.start()

    expect(runtime.snapshot().capabilities).toEqual({ vad: true, kws: false, stt: true, tts: false })
    expect(selectedBytes.byteLength).toBe(3)
    expect(worker.transfers[0]).toHaveLength(1)
    expect(worker.commands[0]).toMatchObject({
      type: 'init',
      modelBindings: {
        files: [expect.objectContaining({ fileId: 'tokens', byteLength: 3 })]
      }
    })

    await runtime.cancel()
  })

  it('does not let a lifecycle event with no owner cancel a later session', async () => {
    const worker = new LoopbackWorker()
    const pageLifecycle = new ControllablePageLifecycle(visibleLifecycle())
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker,
      pcmSource: new FakePcmSource(),
      pageLifecycle
    })

    pageLifecycle.set(hiddenLifecycle('pagehide'))
    pageLifecycle.set(visibleLifecycle())
    await runtime.start()
    await Promise.resolve()

    expect(runtime.snapshot().state).toBe('active')
    expect(worker.commands.map((command) => command.type)).toEqual(['init', 'start'])
    await runtime.dispose()
  })

  it('coalesces caller and page lifecycle cancellation for the same session', async () => {
    const worker = new LoopbackWorker()
    const pageLifecycle = new ControllablePageLifecycle(visibleLifecycle())
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser',
      worker,
      pcmSource: new FakePcmSource(),
      pageLifecycle
    })

    await runtime.start()
    const callerCancellation = runtime.cancel('window_hidden')
    pageLifecycle.set(hiddenLifecycle('hidden'))
    await callerCancellation
    await waitFor(() => runtime.snapshot().state === 'cancelled')

    expect(worker.commands.filter((command) => command.type === 'cancel')).toHaveLength(1)
    await runtime.dispose()
  })
})

class LoopbackWorker implements AuroraBrowserWorkerPort {
  readonly commands: AuroraVoiceWorkerRequestEnvelope['command'][] = []
  readonly transfers: Transferable[][] = []
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null

  constructor(private readonly options: { readonly capabilities?: { readonly vad: boolean; readonly kws: boolean; readonly stt: boolean; readonly tts: false } } = {}) {}

  postMessage(message: AuroraVoiceWorkerRequestEnvelope, transfer: readonly Transferable[] = []): void {
    this.transfers.push([...transfer])
    this.commands.push(message.command)
    const response = responseFor(message, this.options.capabilities)
    queueMicrotask(() => this.messageListener?.({ data: response } as MessageEvent<unknown>))
  }

  addEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListener = listener as (event: MessageEvent<unknown>) => void
  }

  removeEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)): void {
    if (type === 'message' && this.messageListener === listener) this.messageListener = null
  }
}

function responseFor(
  message: AuroraVoiceWorkerRequestEnvelope,
  capabilities: { readonly vad: boolean; readonly kws: boolean; readonly stt: boolean; readonly tts: false } = { vad: false, kws: false, stt: false, tts: false }
): AuroraVoiceWorkerResponseEnvelope {
  const command = message.command
  const envelopeBase: Pick<AuroraVoiceWorkerResponseEnvelope, 'protocolVersion' | 'requestId'> = {
    protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
    requestId: message.requestId
  }
  if (command.type === 'init') {
    return {
      ...envelopeBase,
      response: {
        type: 'ready',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        capabilities,
        maxFrameSamples: command.maxFrameSamples,
        maxQueuedBytes: command.maxQueuedBytes
      }
    }
  }
  if (command.type === 'start') {
    return { ...envelopeBase, response: ack(command.session.sessionId, command.session.generation) }
  }
  if (command.type === 'stop') {
    const pcm = new Int16Array([4, 5, 6])
    return {
      ...envelopeBase,
      response: {
        type: 'stop_result',
        sessionId: command.sessionId,
        generation: command.generation,
        capturedAudio: capturedAudio(command.sessionId, command.generation, pcm)
      }
    }
  }
  if (command.type === 'finish_turn') {
    return { ...envelopeBase, response: ack(command.sessionId, command.generation) }
  }
  if (command.type === 'cancel') {
    return { ...envelopeBase, response: ack(command.sessionId ?? '', command.generation) }
  }
  throw new Error(`unexpected command ${command.type}`)
}

class FakePcmSource implements AuroraAudioWorkletPcmSource {
  async start(_session: AuroraVoiceWebSession, _sink: AuroraAudioWorkletPcmSink): Promise<void> {}
  async stop(_sessionId: string): Promise<void> {}
  async cancel(_sessionId: string): Promise<void> {}
}

class ControllablePageLifecycle implements AuroraBrowserPageLifecyclePort {
  private readonly listeners = new Set<AuroraBrowserPageLifecycleListener>()

  constructor(private eligibility: AuroraVoiceLifecycleEligibility) {}

  current(): AuroraVoiceLifecycleEligibility {
    return this.eligibility
  }

  subscribe(listener: AuroraBrowserPageLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(eligibility: AuroraVoiceLifecycleEligibility): void {
    this.eligibility = eligibility
    for (const listener of this.listeners) listener(eligibility)
  }

  listenerCount(): number {
    return this.listeners.size
  }
}

class FakePageLifecycleTarget {
  private readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event)
  }
}

class FakePageLifecycleDocument extends FakePageLifecycleTarget implements AuroraBrowserPageLifecycleDocument {
  readonly visibilityState = 'visible' as const

  constructor(public readonly wasDiscarded: boolean) {
    super()
  }
}

class FakePageLifecycleWindow extends FakePageLifecycleTarget implements AuroraBrowserPageLifecycleWindow {}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

class FakeMediaStreamTrack {
  private ended: (() => void) | null = null
  addEventListener(type: 'ended', listener: () => void): void {
    if (type === 'ended') this.ended = listener
  }
  removeEventListener(type: 'ended', listener: () => void): void {
    if (type === 'ended' && this.ended === listener) this.ended = null
  }
  stop(): void {}
  end(): void {
    this.ended?.()
  }
}

class FakeAudioContext implements AuroraAudioContextLike {
  readonly sampleRate = 48_000
  readonly state = 'running' as const
  readonly audioWorklet = { addModule: async (_url: string) => undefined }
  readonly destination: AuroraAudioNodeLike = { disconnect: () => undefined }
  createMediaStreamSource(_stream: MediaStream): AuroraMediaStreamAudioSourceNodeLike {
    return {
      connect: (destination) => destination,
      disconnect: () => undefined
    }
  }
  async close(): Promise<void> {}
}

class FakeWorkletNode implements AuroraAudioWorkletNodeLike {
  readonly port = new FakeMessagePort() as unknown as MessagePort
  connect(): AuroraAudioNodeLike {
    return this
  }
  disconnect(): void {}
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  postMessage(_message: unknown): void {}
  close(): void {}
}

function ack(sessionId: string, generation: number) {
  return { type: 'ack' as const, sessionId, generation, sequence: null }
}

function capturedAudio(sessionId: string, generation: number, pcm: Int16Array) {
  return Object.freeze({
    sessionId,
    generation,
    sampleRateHz: 16_000 as const,
    channels: 1 as const,
    sampleCount: pcm.length,
    durationMs: 1,
    pcm,
    redacted: true as const
  })
}
