import { describe, expect, it } from 'vitest'

import {
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  type AuroraCapturedAudio,
  type AuroraPcmFrameEnvelope,
  type AuroraVoiceWebSession,
  type AuroraVoiceWorkerCommand,
  type AuroraVoiceWorkerRequestEnvelope,
  type AuroraVoiceWorkerResponseEnvelope
} from '../src/types.js'
import { AuroraVoiceWorkerDispatcher, type AuroraVoiceWasmBridge } from '../src/worker-dispatcher.js'

describe('AuroraVoiceWorkerDispatcher', () => {
  it('acks init start frame stop and finish through an injected bridge without promoting capabilities', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()
    const frame = frameEnvelope(session, 0, 4)
    const pcm = new Int16Array([1, 2, 3, 4])

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'audio_frame', frame, pcm }))
    await dispatcher.handleMessage(request(4, { type: 'stop', sessionId: session.sessionId, generation: session.generation }))
    await dispatcher.handleMessage(request(5, { type: 'finish_turn', sessionId: session.sessionId, generation: session.generation, outcome: 'completed' }))

    expect(port.messages.map((message) => [message.requestId, message.response.type])).toEqual([
      [1, 'ready'],
      [2, 'ack'],
      [3, 'ack'],
      [4, 'stop_result'],
      [5, 'ack']
    ])
    expect(port.messages[0]?.response).toMatchObject({ capabilities: { vad: false, kws: false, stt: false, tts: false } })
    expect(bridge.frames[0]?.pcm).toEqual(pcm)
    expect(bridge.finishCalls).toEqual([{ sessionId: session.sessionId, generation: session.generation, outcome: 'completed' }])
    expect(port.transfers[3]).toHaveLength(1)
  })

  it('advertises VAD KWS and STT only after bridge initialization accepts selected bindings', async () => {
    const bridge = new FakeBridge({ capabilities: { vad: true, kws: true, stt: true, tts: false } })
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)

    await dispatcher.handleMessage(request(1, {
      type: 'init',
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      maxFrameSamples: 4_800,
      maxQueuedBytes: 320_000,
      modelBindings: {
        files: [{
          task: 'vad',
          fileId: 'silero',
          virtualPath: '/silero.onnx',
          sha256: 'c'.repeat(64),
          byteLength: 1,
          bytes: Uint8Array.from([1])
        }],
        models: [{
          task: 'vad',
          family: 'silero-vad',
          kind: 'vad',
          files: [{ role: 'model', fileId: 'silero', virtualPath: '/silero.onnx' }]
        }]
      }
    }))

    expect(port.messages[0]?.response).toMatchObject({
      type: 'ready',
      capabilities: { vad: true, kws: true, stt: true, tts: false }
    })
    expect(bridge.initializeCalls).toBe(1)
  })

  it('returns typed voice outputs on frame acknowledgements', async () => {
    const bridge = new FakeBridge({ inference: true })
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: true, kws: true, stt: true, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'audio_frame', frame: frameEnvelope(session, 0, 2), pcm: new Int16Array([1, 2]) }))

    expect(port.messages[2]?.response).toEqual({
      type: 'ack',
      sessionId: session.sessionId,
      generation: session.generation,
      sequence: 0,
      inference: {
        vad: { active: true, speechDetected: true, sequence: 0, redacted: true },
        kwsHits: [{ keyword: 'aurora', score: 0.5, sequence: 0, redacted: true }],
        stt: [{ text: 'hello', final: false, sequence: 0, redacted: true }],
        redacted: true
      }
    })
  })

  it('returns bounded TTS PCM through the worker protocol', async () => {
    const bridge = new FakeBridge({ capabilities: { vad: false, kws: false, stt: false, tts: true }, tts: true })
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'synthesize_tts', generation: 3, text: 'hello', voiceId: 'voice.en', speakerId: 1, speed: 1.1 }))

    expect(port.messages[0]?.response).toMatchObject({ type: 'ready', capabilities: { tts: true } })
    expect(port.messages[1]?.response).toEqual({
      type: 'tts_result',
      generation: 3,
      audio: {
        generation: 3,
        sampleRateHz: 16000,
        channels: 1,
        sampleCount: 3,
        durationMs: 1,
        pcm: new Int16Array([0, 1024, -1024]),
        redacted: true
      }
    })
    expect(port.transfers[1]).toHaveLength(1)
    expect(bridge.ttsCalls).toEqual([{ type: 'synthesize_tts', generation: 3, text: 'hello', voiceId: 'voice.en', speakerId: 1, speed: 1.1 }])
  })

  it('rejects malformed TTS commands without echoing text payloads', async () => {
    const bridge = new FakeBridge({ capabilities: { vad: false, kws: false, stt: false, tts: true }, tts: true })
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId: 2,
      command: { type: 'synthesize_tts', generation: 1, text: '', token: 'secret transcript path' }
    })

    expect(port.messages[1]?.response).toEqual({ type: 'reject', sessionId: null, generation: 1, sequence: null, reason: 'worker_rejected' })
    expect(JSON.stringify(port.messages)).not.toMatch(/secret|transcript|path|hello|pcm|pointer/i)
    expect(bridge.ttsCalls).toEqual([])
  })

  it('rejects model bindings that try to supply executable engine assets', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)

    await dispatcher.handleMessage({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId: 1,
      command: {
        type: 'init',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        maxFrameSamples: 4_800,
        maxQueuedBytes: 320_000,
        modelBindings: {
          files: [{
            task: 'vad',
            fileId: 'silero',
            virtualPath: '/silero.onnx',
            sha256: 'c'.repeat(64),
            byteLength: 1,
            bytes: Uint8Array.from([1])
          }],
          models: [{
            task: 'vad',
            family: 'silero-vad',
            kind: 'vad',
            files: [{ role: 'model', fileId: 'silero', virtualPath: '/silero.onnx' }]
          }],
          sherpaAssets: { vadAsrModuleUrl: 'https://voice.example/sherpa-onnx-wasm-main-vad-asr.js' }
        }
      }
    })

    expect(port.messages[0]?.response).toEqual({ type: 'reject', sessionId: null, generation: 0, sequence: null, reason: 'worker_rejected' })
    expect(bridge.initializeCalls).toBe(0)
  })

  it('rejects stale and duplicate frames without leaking payloads', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()
    const frame = frameEnvelope(session, 0, 1)

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'audio_frame', frame, pcm: new Int16Array([42]) }))
    await dispatcher.handleMessage(request(4, { type: 'audio_frame', frame, pcm: new Int16Array([99]) }))
    await dispatcher.handleMessage(request(5, { type: 'audio_frame', frame: { ...frame, sequence: 1, sessionId: 'forged' }, pcm: new Int16Array([7]) }))

    expect(port.messages[3]?.response).toMatchObject({ type: 'reject', sessionId: session.sessionId, sequence: 0 })
    expect(port.messages[4]?.response).toMatchObject({ type: 'reject', sessionId: 'forged', sequence: 1 })
    expect(JSON.stringify(port.messages)).not.toMatch(/42|99|transcript|secret|path|pcm|pointer/i)
  })

  it('rejects overlapping starts and keeps live sessions on foreign cancel without bridge calls', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'start', session: { ...session, sessionId: 'owner-b:1' }, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(4, { type: 'cancel', sessionId: 'foreign-session', generation: session.generation, reason: 'cancelled' }))
    await dispatcher.handleMessage(request(5, { type: 'audio_frame', frame: frameEnvelope(session, 0, 1), pcm: new Int16Array([1]) }))
    await dispatcher.handleMessage(request(6, { type: 'cancel', sessionId: session.sessionId, generation: session.generation, reason: 'cancelled' }))
    await dispatcher.handleMessage(request(7, { type: 'audio_frame', frame: frameEnvelope(session, 1, 1), pcm: new Int16Array([1]) }))

    expect(port.messages[2]?.response).toMatchObject({ type: 'reject' })
    expect(port.messages[3]?.response).toEqual({ type: 'reject', sessionId: 'foreign-session', generation: session.generation, sequence: null, reason: 'stale_cancel' })
    expect(port.messages[4]?.response).toEqual({ type: 'ack', sessionId: session.sessionId, generation: session.generation, sequence: 0 })
    expect(port.messages[5]?.response).toEqual({ type: 'ack', sessionId: session.sessionId, generation: session.generation, sequence: null })
    expect(port.messages[6]?.response).toMatchObject({ type: 'reject' })
    expect(bridge.cancelCalls).toEqual([{ sessionId: session.sessionId, generation: session.generation, reason: 'cancelled' }])
  })

  it('serializes concurrent starts duplicate frames stop-vs-frame and cancel-vs-stop', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()
    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))

    await Promise.all([
      dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } })),
      dispatcher.handleMessage(request(3, { type: 'start', session: { ...session, sessionId: 'owner-b:1' }, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    ])
    expect(port.messages[1]?.response).toMatchObject({ type: 'ack' })
    expect(port.messages[2]?.response).toMatchObject({ type: 'reject' })
    expect(bridge.startCalls).toBe(1)

    await Promise.all([
      dispatcher.handleMessage(request(4, { type: 'audio_frame', frame: frameEnvelope(session, 0, 1), pcm: new Int16Array([1]) })),
      dispatcher.handleMessage(request(5, { type: 'audio_frame', frame: frameEnvelope(session, 0, 1), pcm: new Int16Array([2]) }))
    ])
    expect(port.messages[3]?.response).toMatchObject({ type: 'ack', sequence: 0 })
    expect(port.messages[4]?.response).toMatchObject({ type: 'reject', sequence: 0 })
    expect(bridge.frames).toHaveLength(1)

    await Promise.all([
      dispatcher.handleMessage(request(6, { type: 'stop', sessionId: session.sessionId, generation: session.generation })),
      dispatcher.handleMessage(request(7, { type: 'audio_frame', frame: frameEnvelope(session, 1, 1), pcm: new Int16Array([3]) }))
    ])
    expect(port.messages[5]?.response).toMatchObject({ type: 'stop_result' })
    expect(port.messages[6]?.response).toMatchObject({ type: 'reject', sequence: 1 })

    const secondSession = { ...session, sessionId: 'owner-a:2', generation: 2 }
    await dispatcher.handleMessage(request(8, { type: 'start', session: secondSession, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    expect(port.messages[7]?.response).toMatchObject({ type: 'reject' })
    await dispatcher.handleMessage(request(11, { type: 'finish_turn', sessionId: session.sessionId, generation: session.generation, outcome: 'completed' }))
    await dispatcher.handleMessage(request(12, { type: 'start', session: secondSession, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await Promise.all([
      dispatcher.handleMessage(request(13, { type: 'cancel', sessionId: secondSession.sessionId, generation: secondSession.generation, reason: 'cancelled' })),
      dispatcher.handleMessage(request(14, { type: 'stop', sessionId: secondSession.sessionId, generation: secondSession.generation }))
    ])
    expect(port.messages[8]?.response).toMatchObject({ type: 'ack', sessionId: session.sessionId })
    expect(port.messages[9]?.response).toMatchObject({ type: 'ack', sessionId: secondSession.sessionId })
    expect(port.messages[10]?.response).toMatchObject({ type: 'ack', sessionId: secondSession.sessionId })
    expect(port.messages[11]?.response).toMatchObject({ type: 'reject', sessionId: secondSession.sessionId })
  })

  it('settles stopped turns explicitly and rejects stale settlement without bridge calls', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()
    const secondSession = { ...session, sessionId: 'owner-a:2', generation: 2 }

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'stop', sessionId: session.sessionId, generation: session.generation }))
    await dispatcher.handleMessage(request(4, { type: 'start', session: secondSession, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(5, { type: 'finish_turn', sessionId: 'foreign-session', generation: session.generation, outcome: 'completed' }))
    await dispatcher.handleMessage(request(6, { type: 'finish_turn', sessionId: session.sessionId, generation: session.generation + 1, outcome: 'abandoned' }))
    await dispatcher.handleMessage(request(7, { type: 'finish_turn', sessionId: session.sessionId, generation: session.generation, outcome: 'completed' }))
    await dispatcher.handleMessage(request(8, { type: 'start', session: secondSession, capabilities: { vad: false, kws: false, stt: false, tts: false } }))

    expect(port.messages[3]?.response).toMatchObject({ type: 'reject' })
    expect(port.messages[4]?.response).toEqual({ type: 'reject', sessionId: 'foreign-session', generation: session.generation, sequence: null, reason: 'stale_finish' })
    expect(port.messages[5]?.response).toEqual({ type: 'reject', sessionId: session.sessionId, generation: session.generation + 1, sequence: null, reason: 'stale_finish' })
    expect(port.messages[6]?.response).toEqual({ type: 'ack', sessionId: session.sessionId, generation: session.generation, sequence: null })
    expect(port.messages[7]?.response).toEqual({ type: 'ack', sessionId: secondSession.sessionId, generation: secondSession.generation, sequence: null })
    expect(bridge.finishCalls).toEqual([{ sessionId: session.sessionId, generation: session.generation, outcome: 'completed' }])
  })

  it('abandons pending stopped ownership via cancel and frees pending stopped ownership via shutdown', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()
    const secondSession = { ...session, sessionId: 'owner-a:2', generation: 2 }

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'stop', sessionId: session.sessionId, generation: session.generation }))
    await dispatcher.handleMessage(request(4, { type: 'cancel', sessionId: session.sessionId, generation: session.generation, reason: 'cancelled' }))
    await dispatcher.handleMessage(request(5, { type: 'start', session: secondSession, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(6, { type: 'stop', sessionId: secondSession.sessionId, generation: secondSession.generation }))
    await dispatcher.handleMessage(request(7, { type: 'shutdown', generation: secondSession.generation, reason: 'shutdown' }))

    expect(port.messages[3]?.response).toEqual({ type: 'ack', sessionId: session.sessionId, generation: session.generation, sequence: null })
    expect(port.messages[6]?.response).toEqual({ type: 'ack', sessionId: '', generation: secondSession.generation, sequence: null })
    expect(bridge.finishCalls).toEqual([
      { sessionId: session.sessionId, generation: session.generation, outcome: 'abandoned' }
    ])
    expect(bridge.cancelCalls).toEqual([
      { sessionId: secondSession.sessionId, generation: secondSession.generation, reason: 'shutdown' }
    ])
  })

  it('keeps active ownership when stale null shutdown is rejected by the bridge', async () => {
    const bridge = new FakeBridge({ rejectNullShutdown: true })
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)
    const session = voiceSession()

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage(request(2, { type: 'start', session, capabilities: { vad: false, kws: false, stt: false, tts: false } }))
    await dispatcher.handleMessage(request(3, { type: 'shutdown', generation: session.generation + 1, reason: 'shutdown' }))
    await dispatcher.handleMessage(request(4, { type: 'audio_frame', frame: frameEnvelope(session, 0, 1), pcm: new Int16Array([1]) }))

    expect(port.messages[2]?.response).toEqual({ type: 'reject', sessionId: null, generation: session.generation + 1, sequence: null, reason: 'worker_rejected' })
    expect(port.messages[3]?.response).toEqual({ type: 'ack', sessionId: session.sessionId, generation: session.generation, sequence: 0 })
    expect(bridge.cancelCalls).toEqual([{ sessionId: null, generation: session.generation + 1, reason: 'shutdown' }])
  })

  it('sanitizes malformed commands into rejects instead of timing out', async () => {
    const bridge = new FakeBridge()
    const port = new RecordingPort()
    const dispatcher = new AuroraVoiceWorkerDispatcher(bridge, port)

    await dispatcher.handleMessage(request(1, { type: 'init', protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, maxFrameSamples: 4_800, maxQueuedBytes: 320_000 }))
    await dispatcher.handleMessage({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId: 2,
      command: { type: 'audio_frame', frame: null, pcm: 'secret transcript path' }
    })
    await dispatcher.handleMessage({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId: 3,
      command: { type: 'unknown', token: 'secret-token' }
    })

    expect(port.messages[1]?.response).toEqual({ type: 'reject', sessionId: null, generation: 0, sequence: null, reason: 'worker_rejected' })
    expect(port.messages[2]?.response).toEqual({ type: 'reject', sessionId: null, generation: 0, sequence: null, reason: 'worker_rejected' })
    expect(JSON.stringify(port.messages)).not.toMatch(/secret|transcript|path|token|pcm|pointer/i)
  })
})

class RecordingPort {
  readonly messages: AuroraVoiceWorkerResponseEnvelope[] = []
  readonly transfers: Transferable[][] = []

  postMessage(message: AuroraVoiceWorkerResponseEnvelope, transfer: readonly Transferable[] = []): void {
    this.messages.push(message)
    this.transfers.push([...transfer])
  }
}

class FakeBridge implements AuroraVoiceWasmBridge {
  readonly frames: { readonly frame: AuroraPcmFrameEnvelope; readonly pcm: Int16Array }[] = []
  readonly cancelCalls: { readonly sessionId: string | null; readonly generation: number; readonly reason: string }[] = []
  readonly finishCalls: { readonly sessionId: string; readonly generation: number; readonly outcome: 'completed' | 'abandoned' }[] = []
  readonly ttsCalls: { readonly type: 'synthesize_tts'; readonly generation: number; readonly text: string; readonly voiceId?: string; readonly speakerId?: number; readonly speed?: number }[] = []
  private readonly rejectNullShutdown: boolean
  private readonly capabilities
  private readonly inference: boolean
  private readonly tts: boolean
  startCalls = 0
  initializeCalls = 0

  constructor(options: { readonly rejectNullShutdown?: boolean; readonly capabilities?: { readonly vad: boolean; readonly kws: boolean; readonly stt: boolean; readonly tts: boolean }; readonly inference?: boolean; readonly tts?: boolean } = {}) {
    this.rejectNullShutdown = options.rejectNullShutdown === true
    this.capabilities = options.capabilities ?? { vad: false, kws: false, stt: false, tts: false }
    this.inference = options.inference === true
    this.tts = options.tts === true
  }

  async initialize(): Promise<{ readonly capabilities?: { readonly vad: boolean; readonly kws: boolean; readonly stt: boolean; readonly tts: boolean } }> {
    this.initializeCalls += 1
    return { capabilities: this.capabilities }
  }

  async startSession(_session: AuroraVoiceWebSession): Promise<void> {
    this.startCalls += 1
  }

  async pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array) {
    this.frames.push({ frame, pcm: new Int16Array(pcm) })
    if (!this.inference) return undefined
    return {
      vad: { active: true, speechDetected: true, sequence: frame.sequence, redacted: true as const },
      kwsHits: [{ keyword: 'aurora', score: 0.5, sequence: frame.sequence, redacted: true as const }],
      stt: [{ text: 'hello', final: false, sequence: frame.sequence, redacted: true as const }],
      redacted: true as const
    }
  }

  async stopSession(sessionId: string, generation: number): Promise<AuroraCapturedAudio> {
    return {
      sessionId,
      generation,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: 2,
      durationMs: 1,
      pcm: new Int16Array([5, 6]),
      redacted: true
    }
  }

  async finishTurn(sessionId: string, generation: number, outcome: 'completed' | 'abandoned'): Promise<void> {
    this.finishCalls.push({ sessionId, generation, outcome })
  }

  async synthesizeSpeech(request: { readonly type: 'synthesize_tts'; readonly generation: number; readonly text: string; readonly voiceId?: string; readonly speakerId?: number; readonly speed?: number }) {
    if (!this.tts) throw new Error('tts')
    this.ttsCalls.push(request)
    return {
      generation: request.generation,
      sampleRateHz: 16000,
      channels: 1 as const,
      sampleCount: 3,
      durationMs: 1,
      pcm: new Int16Array([0, 1024, -1024]),
      redacted: true as const
    }
  }

  async cancelGeneration(sessionId: string | null, generation: number, reason: string): Promise<void> {
    this.cancelCalls.push({ sessionId, generation, reason })
    if (this.rejectNullShutdown && sessionId === null && reason === 'shutdown') {
      throw new Error('stale shutdown')
    }
  }

  async snapshot(): Promise<{ readonly capabilities?: { readonly vad: boolean; readonly kws: boolean; readonly stt: boolean; readonly tts: boolean } }> {
    return { capabilities: { vad: true, kws: true, stt: true, tts: true } }
  }
}

function voiceSession(): AuroraVoiceWebSession {
  return Object.freeze({
    ownerId: 'owner-a',
    sessionId: 'owner-a:1',
    generation: 1,
    startedAtMs: 10,
    foregroundOnly: true
  })
}

function frameEnvelope(session: AuroraVoiceWebSession, sequence: number, sampleCount: number): AuroraPcmFrameEnvelope {
  return Object.freeze({
    sessionId: session.sessionId,
    generation: session.generation,
    sequence,
    discontinuity: false,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount,
    byteLength: sampleCount * 2,
    queuedBytes: sampleCount * 2
  })
}

function request(requestId: number, command: AuroraVoiceWorkerCommand): AuroraVoiceWorkerRequestEnvelope {
  return Object.freeze({
    protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
    requestId,
    command
  })
}
