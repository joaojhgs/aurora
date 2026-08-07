import { describe, expect, it } from 'vitest'

import { createAuroraBrowserVoiceRuntime } from '../src/browser-runtime.js'
import { AURORA_VOICE_WORKER_PROTOCOL_VERSION, type AuroraAudioWorkletPcmSink, type AuroraAudioWorkletPcmSource, type AuroraVoiceWebSession, type AuroraVoiceWorkerRequestEnvelope, type AuroraVoiceWorkerResponseEnvelope } from '../src/types.js'
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
})

class LoopbackWorker implements AuroraBrowserWorkerPort {
  readonly commands: AuroraVoiceWorkerRequestEnvelope['command'][] = []
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null

  postMessage(message: AuroraVoiceWorkerRequestEnvelope): void {
    this.commands.push(message.command)
    const response = responseFor(message)
    queueMicrotask(() => this.messageListener?.({ data: response } as MessageEvent<unknown>))
  }

  addEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListener = listener as (event: MessageEvent<unknown>) => void
  }

  removeEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)): void {
    if (type === 'message' && this.messageListener === listener) this.messageListener = null
  }
}

function responseFor(message: AuroraVoiceWorkerRequestEnvelope): AuroraVoiceWorkerResponseEnvelope {
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
        capabilities: { vad: false, kws: false, stt: false, tts: false },
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
