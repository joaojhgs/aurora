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
  private readonly rejectNullShutdown: boolean
  startCalls = 0

  constructor(options: { readonly rejectNullShutdown?: boolean } = {}) {
    this.rejectNullShutdown = options.rejectNullShutdown === true
  }

  async startSession(_session: AuroraVoiceWebSession): Promise<void> {
    this.startCalls += 1
  }

  async pushPcmI16(frame: AuroraPcmFrameEnvelope, pcm: Int16Array): Promise<void> {
    this.frames.push({ frame, pcm: new Int16Array(pcm) })
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
