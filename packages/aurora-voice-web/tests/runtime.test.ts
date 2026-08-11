import { describe, expect, it } from 'vitest'

import {
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
  AuroraVoiceWebRuntime,
  AuroraVoiceWebRuntimeError,
  hiddenLifecycle,
  visibleLifecycle,
  type AuroraPcmFrame,
  type AuroraVoiceWebEvent,
  type AuroraVoiceWebSession,
  type AuroraVoiceWorkerCommand,
  type AuroraVoiceWorkerHost,
  type AuroraVoiceWorkerRequestOptions,
  type AuroraVoiceWorkerResponse
} from '../src/index.js'
import { capturedAudio, RecordingVoiceWorkerHost } from '../src/test-doubles/worker-host.js'

describe('AuroraVoiceWebRuntime', () => {
  it('starts foreground-only sessions with unavailable capabilities until promoted by the host', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, nowMs: () => 10 })
    const session = await runtime.start()

    expect(session).toMatchObject({ ownerId: 'owner-a', generation: 1, foregroundOnly: true })
    expect(runtime.snapshot()).toMatchObject({
      state: 'active',
      generation: 1,
      capabilities: AURORA_VOICE_WEB_DEFAULT_CAPABILITIES,
      lifecycle: visibleLifecycle()
    })
    expect(worker.commandsOf('start')[0]?.capabilities).toEqual({
      vad: false,
      kws: false,
      stt: false,
      tts: false
    })

    await expect(runtime.stop()).resolves.toMatchObject({ sampleRateHz: 16_000, channels: 1, sampleCount: 0 })
    await runtime.completeTurn()
  })

  it('enforces one active owner', async () => {
    const first = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker: new RecordingVoiceWorkerHost() })
    const sameOwner = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker: new RecordingVoiceWorkerHost() })
    const second = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: new RecordingVoiceWorkerHost() })
    const third = new AuroraVoiceWebRuntime({ ownerId: 'owner-c', worker: new RecordingVoiceWorkerHost() })
    await first.start()
    await expect(sameOwner.start()).rejects.toMatchObject({ code: 'active_owner_exists' })
    await expect(second.start()).rejects.toMatchObject({ code: 'active_owner_exists' })
    await expect(sameOwner.cancel()).resolves.toBeUndefined()
    await expect(third.start()).rejects.toMatchObject({ code: 'active_owner_exists' })
    await first.cancel()
    await expect(second.start()).resolves.toMatchObject({ ownerId: 'owner-b' })
    await second.cancel()
  })

  it('validates safe owner, session, lifecycle, and bound inputs', async () => {
    expect(() => new AuroraVoiceWebRuntime({ ownerId: '/secret/path', worker: new RecordingVoiceWorkerHost() }))
      .toThrow(AuroraVoiceWebRuntimeError)
    expect(() => new AuroraVoiceWebRuntime({ ownerId: 'owner-K', worker: new RecordingVoiceWorkerHost() }))
      .toThrow(AuroraVoiceWebRuntimeError)
    expect(() => new AuroraVoiceWebRuntime({ ownerId: 'owner-ſ', worker: new RecordingVoiceWorkerHost() }))
      .toThrow(AuroraVoiceWebRuntimeError)
    expect(() => new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker: new RecordingVoiceWorkerHost(), maxFrameSamples: 4_801 }))
      .toThrow(AuroraVoiceWebRuntimeError)
    expect(() => new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker: new RecordingVoiceWorkerHost(), maxQueuedBytes: 320_001 }))
      .toThrow(AuroraVoiceWebRuntimeError)

    const badSession = new AuroraVoiceWebRuntime({
      ownerId: 'owner-a',
      worker: new RecordingVoiceWorkerHost(),
      sessionIdFactory: () => '/secret/session'
    })
    await expect(badSession.start()).rejects.toMatchObject({ code: 'invalid_option' })

    const unicodeSession = new AuroraVoiceWebRuntime({
      ownerId: 'owner-a',
      worker: new RecordingVoiceWorkerHost(),
      sessionIdFactory: () => 'session-K'
    })
    await expect(unicodeSession.start()).rejects.toMatchObject({ code: 'invalid_option' })

    const afterBadSession = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: new RecordingVoiceWorkerHost() })
    await expect(afterBadSession.start()).resolves.toMatchObject({ ownerId: 'owner-b' })
    await afterBadSession.cancel()

    const invalidLifecycle = new AuroraVoiceWebRuntime({
      ownerId: 'owner-c',
      worker: new RecordingVoiceWorkerHost(),
      lifecycle: () => ({ foregroundOnly: true, visible: false, frozen: false, eligible: true, reason: 'visible' }) as const
    })
    await expect(invalidLifecycle.start()).rejects.toMatchObject({ code: 'invalid_lifecycle' })
  })

  it('rejects hidden, frozen, and ineligible starts', async () => {
    for (const reason of ['hidden', 'frozen', 'ineligible'] as const) {
      const runtime = new AuroraVoiceWebRuntime({
        ownerId: `owner-${reason}`,
        worker: new RecordingVoiceWorkerHost(),
        lifecycle: () => hiddenLifecycle(reason)
      })
      await expect(runtime.start()).rejects.toBeInstanceOf(AuroraVoiceWebRuntimeError)
      await expect(runtime.start()).rejects.toMatchObject({ code: 'lifecycle_ineligible' })
    }
  })

  it('clears ownership when start fails after host setup begins', async () => {
    const failingWorker = new FailingWorkerHost(['start'])
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker: failingWorker })
    await expect(runtime.start()).rejects.toMatchObject({ code: 'start_failed' })
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })

    const failingSource = new FailingSource('start')
    const sourceRuntime = new AuroraVoiceWebRuntime({
      ownerId: 'owner-b',
      worker: new RecordingVoiceWorkerHost(),
      pcmSource: failingSource
    })
    await expect(sourceRuntime.start()).rejects.toMatchObject({ code: 'start_failed' })
    expect(failingSource.calls).toEqual(['start', 'cancel'])

    const next = new AuroraVoiceWebRuntime({ ownerId: 'owner-c', worker: new RecordingVoiceWorkerHost() })
    await expect(next.start()).resolves.toMatchObject({ ownerId: 'owner-c' })
    await next.cancel()
  })

  it('keeps cancellation authoritative while the browser audio source is still starting', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const source = new DeferredStartSource()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, pcmSource: source })

    const starting = runtime.start()
    await source.waitUntilStarting()
    await runtime.cancel('user_cancelled')
    source.finishStarting()

    await expect(starting).rejects.toMatchObject({ code: 'start_failed' })
    expect(source.calls.filter((call) => call === 'cancel')).not.toHaveLength(0)
    expect(worker.commandsOf('cancel').length).toBeGreaterThanOrEqual(1)
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })

    const next = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: new RecordingVoiceWorkerHost() })
    await expect(next.start()).resolves.toMatchObject({ ownerId: 'owner-b' })
    await next.cancel()
  })

  it('does not let a cancelled stale start clear a newer session', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const source = new DeferredFirstStartSource()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, pcmSource: source })

    const staleStart = runtime.start()
    await source.waitUntilStarting()
    await runtime.cancel('user_cancelled')

    await expect(runtime.start()).resolves.toMatchObject({ ownerId: 'owner-a', generation: 2 })
    source.finishStarting()

    await expect(staleStart).rejects.toMatchObject({ code: 'start_failed' })
    expect(runtime.snapshot()).toMatchObject({ state: 'active', generation: 2, sessionId: 'owner-a:2' })
    await runtime.cancel()
  })

  it('attempts both host cleanup paths and clears state when stop or cancel fails', async () => {
    const stopSource = new FailingSource('stop')
    const stopWorker = new FailingWorkerHost(['stop'])
    const stopRuntime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker: stopWorker, pcmSource: stopSource })
    await stopRuntime.start()
    await expect(stopRuntime.stop()).rejects.toMatchObject({ code: 'stop_failed' })
    expect(stopSource.calls).toContain('stop')
    expect(stopWorker.commandsOf('stop')).toHaveLength(1)
    expect(stopWorker.commandsOf('cancel')).toHaveLength(1)
    expect(stopRuntime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })

    const cancelSource = new FailingSource('cancel')
    const cancelWorker = new FailingWorkerHost(['cancel'])
    const cancelRuntime = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: cancelWorker, pcmSource: cancelSource })
    await cancelRuntime.start()
    await expect(cancelRuntime.cancel()).rejects.toMatchObject({ code: 'cancel_failed' })
    expect(cancelSource.calls).toContain('cancel')
    expect(cancelWorker.commandsOf('cancel')).toHaveLength(1)
    expect(cancelRuntime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })
  })

  it('rejects stale generations and requires monotonic sequences unless discontinuity is explicit', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const events: AuroraVoiceWebEvent[] = []
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, maxFrameSamples: 4 })
    runtime.onEvent((event) => events.push(event))
    const session = await runtime.start()

    await expect(runtime.pushFrame(frame(session.sessionId, session.generation - 1, 0, [1]))).resolves.toBe(false)
    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 1, [1]))).resolves.toBe(false)
    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 4, [1], true))).resolves.toBe(true)
    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 5, [2]))).resolves.toBe(true)

    expect(worker.commandsOf('audio_frame').map((command) => command.frame.sequence)).toEqual([4, 5])
    expect(events.filter((event) => event.kind === 'frame_dropped').map((event) => event.reason)).toEqual([
      'stale_generation',
      'sequence'
    ])
    await runtime.cancel()
  })

  it('serializes concurrent frame pushes so duplicate sequences cannot both pass', async () => {
    const worker = new DeferredAudioWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, nowMs: () => 10 })
    const session = await runtime.start()

    const first = runtime.pushFrame(frame(session.sessionId, session.generation, 0, [1]))
    const second = runtime.pushFrame(frame(session.sessionId, session.generation, 0, [2]))
    await worker.waitForAudioPost()
    worker.releaseAudioPosts()

    await expect(Promise.all([first, second])).resolves.toEqual([true, false])
    expect(worker.commandsOf('audio_frame')).toHaveLength(1)
    await runtime.cancel()
  })

  it('does not accept an audio frame after concurrent cancellation during worker delivery', async () => {
    const worker = new DeferredAudioWorkerHost()
    const events: AuroraVoiceWebEvent[] = []
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    runtime.onEvent((event) => events.push(event))
    const session = await runtime.start()

    const pushed = runtime.pushFrame(frame(session.sessionId, session.generation, 0, [1]))
    await worker.waitForAudioPost()
    await runtime.cancel()
    worker.releaseAudioPosts()

    await expect(pushed).resolves.toBe(false)
    expect(events.some((event) => event.kind === 'frame_accepted')).toBe(false)
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0, nextSequence: 0 })
  })

  it('releases queued bytes and fails closed when worker audio delivery fails', async () => {
    const worker = new FailingWorkerHost(['audio_frame'])
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()

    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 0, [1, 2]))).resolves.toBe(false)
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })
    expect(worker.commandsOf('cancel')).toHaveLength(1)
  })

  it('checks frame and queue bounds before copying to the worker', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, maxFrameSamples: 2, maxQueuedBytes: 4 })
    const session = await runtime.start()
    const original = new Int16Array([1, 2, 3])

    await expect(runtime.pushFrame({
      sessionId: session.sessionId,
      generation: session.generation,
      sequence: 0,
      sampleRateHz: 16_000,
      channels: 1,
      pcm: original
    })).resolves.toBe(false)
    expect(worker.commandsOf('audio_frame')).toHaveLength(0)

    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 0, [7, 8]))).resolves.toBe(true)
    const copied = worker.commandsOf('audio_frame')[0]?.pcm
    expect(copied).toEqual(new Int16Array([7, 8]))
    expect(copied).not.toBe(original)
    expect(worker.transfers.at(-1)).toHaveLength(1)
    await runtime.cancel()
  })

  it('returns bounded captured audio only from stop', async () => {
    const worker = new RecordingVoiceWorkerHost()
    worker.responseOverride = (command) => {
      if (command.type === 'stop') {
        return { type: 'stop_result', sessionId: command.sessionId, generation: command.generation, capturedAudio: capturedAudio(command.sessionId, command.generation, [1, 2, 3]) }
      }
      return defaultResponseFor(command)
    }
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()
    await runtime.pushFrame(frame(session.sessionId, session.generation, 0, [42]))
    await expect(runtime.stop()).resolves.toMatchObject({ sessionId: session.sessionId, generation: session.generation, sampleCount: 3 })
    await runtime.completeTurn()

    const cancelRuntime = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: new RecordingVoiceWorkerHost() })
    await cancelRuntime.start()
    await expect(cancelRuntime.cancel()).resolves.toBeUndefined()
  })

  it('keeps the worker reusable after a normal stop', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    await expect(runtime.start()).resolves.toMatchObject({ generation: 1 })
    await expect(runtime.stop()).resolves.toMatchObject({ generation: 1 })
    await expect(runtime.start()).rejects.toMatchObject({ code: 'turn_pending' })
    await runtime.completeTurn()
    await expect(runtime.start()).resolves.toMatchObject({ generation: 2 })
    await runtime.dispose()

    expect(worker.commandsOf('start')).toHaveLength(2)
    expect(worker.commandsOf('stop')).toHaveLength(1)
    expect(worker.commandsOf('finish_turn')).toHaveLength(1)
    expect(worker.commandsOf('cancel')).toHaveLength(1)
  })

  it('requires explicit stopped-turn settlement before the same runtime can capture again', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()
    await runtime.stop()

    expect(runtime.snapshot()).toMatchObject({ state: 'stopped', sessionId: session.sessionId, generation: session.generation, queuedBytes: 0 })
    await expect(runtime.start()).rejects.toMatchObject({ code: 'turn_pending' })
    await runtime.completeTurn()
    expect(runtime.snapshot()).toMatchObject({ state: 'idle', sessionId: null, generation: session.generation })
    await expect(runtime.start()).resolves.toMatchObject({ generation: session.generation + 1 })
    await runtime.cancel()
    expect(worker.commandsOf('finish_turn')[0]).toMatchObject({ outcome: 'completed', sessionId: session.sessionId, generation: session.generation })
  })

  it('abandons stopped turns and releases the global capture lock after stop', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const other = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: new RecordingVoiceWorkerHost() })
    const session = await runtime.start()
    await runtime.stop()

    await expect(other.start()).resolves.toMatchObject({ ownerId: 'owner-b' })
    await other.cancel()
    await runtime.abandonTurn()
    await expect(runtime.start()).resolves.toMatchObject({ generation: session.generation + 1 })
    await runtime.cancel()
    expect(worker.commandsOf('finish_turn')[0]).toMatchObject({ outcome: 'abandoned', sessionId: session.sessionId })
  })

  it('keeps pending stopped turns on forged settlement acknowledgements', async () => {
    const worker = new RecordingVoiceWorkerHost()
    worker.responseOverride = (command) => {
      if (command.type === 'finish_turn') {
        return { type: 'ack', sessionId: command.sessionId, generation: command.generation + 1, sequence: null }
      }
      return defaultResponseFor(command)
    }
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()
    await runtime.stop()

    await expect(runtime.completeTurn()).rejects.toMatchObject({ code: 'finish_failed' })
    expect(runtime.snapshot()).toMatchObject({ state: 'stopped', sessionId: session.sessionId })
    await expect(runtime.start()).rejects.toMatchObject({ code: 'turn_pending' })
  })

  it('keeps pending stopped turns when abandon through cancel fails', async () => {
    const worker = new FailingWorkerHost(['cancel'])
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()
    await runtime.stop()

    await expect(runtime.cancel()).rejects.toMatchObject({ code: 'cancel_failed' })
    expect(runtime.snapshot()).toMatchObject({ state: 'stopped', sessionId: session.sessionId })
    await expect(runtime.start()).rejects.toMatchObject({ code: 'turn_pending' })
  })

  it('abandons pending turns on lifecycle loss and dispose', async () => {
    let eligible = true
    const lifecycleWorker = new RecordingVoiceWorkerHost()
    const lifecycleRuntime = new AuroraVoiceWebRuntime({
      ownerId: 'owner-a',
      worker: lifecycleWorker,
      lifecycle: () => eligible ? visibleLifecycle() : hiddenLifecycle('hidden')
    })
    await lifecycleRuntime.start()
    await lifecycleRuntime.stop()
    eligible = false
    await lifecycleRuntime.refreshLifecycle()
    expect(lifecycleRuntime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null })
    expect(lifecycleWorker.commandsOf('cancel')).toHaveLength(1)

    const disposeWorker = new RecordingVoiceWorkerHost()
    const disposeRuntime = new AuroraVoiceWebRuntime({ ownerId: 'owner-b', worker: disposeWorker })
    await disposeRuntime.start()
    await disposeRuntime.stop()
    await disposeRuntime.dispose()
    expect(disposeRuntime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null })
    expect(disposeWorker.commandsOf('cancel')).toHaveLength(1)
  })

  it('terminates the worker even when pending-turn cancellation fails during dispose', async () => {
    const worker = new FailingCancelShutdownWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()
    await runtime.stop()

    await expect(runtime.dispose()).rejects.toMatchObject({ code: 'cancel_failed' })

    expect(worker.shutdownCalls).toBe(1)
    expect(runtime.snapshot()).toMatchObject({ state: 'stopped', sessionId: session.sessionId })
  })

  it('fails closed on forged worker acknowledgements', async () => {
    const worker = new RecordingVoiceWorkerHost()
    worker.responseOverride = (command) => {
      if (command.type === 'audio_frame') {
        return { type: 'ack', sessionId: 'forged-session', generation: command.frame.generation, sequence: command.frame.sequence }
      }
      return defaultResponseFor(command)
    }
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker })
    const session = await runtime.start()
    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 0, [1]))).resolves.toBe(false)
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })
  })

  it('clears queued audio on cancel and prevents post-cancel events', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const events: AuroraVoiceWebEvent[] = []
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, nowMs: () => 10 })
    runtime.onEvent((event) => events.push(event))
    const session = await runtime.start()
    await runtime.cancel('user_cancelled')

    const before = events.length
    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 0, [1]))).resolves.toBe(false)
    expect(events).toHaveLength(before)
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', queuedBytes: 0, sessionId: null })
  })

  it('cancels when foreground eligibility is lost', async () => {
    let eligible = true
    const worker = new RecordingVoiceWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({
      ownerId: 'owner-a',
      worker,
      lifecycle: () => eligible ? visibleLifecycle() : hiddenLifecycle('hidden')
    })
    await runtime.start()
    eligible = false
    await runtime.refreshLifecycle()

    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null })
    expect(worker.commandsOf('cancel')).toHaveLength(1)
  })

  it('serializes events and worker metadata without sensitive payload fields', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const events: AuroraVoiceWebEvent[] = []
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, nowMs: () => 10 })
    runtime.onEvent((event) => events.push(event))
    const session = await runtime.start()
    await runtime.pushFrame(frame(session.sessionId, session.generation, 0, [42]))
    await runtime.cancel('/secret/path and transcript text')

    const serializedEvents = JSON.stringify(events)
    expect(serializedEvents).not.toMatch(/42|secret|transcript|pcm|path|credential|pointer|native/i)
    expect(worker.serializedCommands()).not.toMatch(/secret|transcript|path|credential|pointer|native/i)
  })
})

class FailingWorkerHost extends RecordingVoiceWorkerHost {
  constructor(private readonly failTypes: readonly AuroraVoiceWorkerCommand['type'][]) {
    super()
  }

  override async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    this.commands.push(command)
    if (this.failTypes.includes(command.type)) throw new Error(command.type)
    return defaultResponseFor(command)
  }
}

class FailingCancelShutdownWorkerHost extends RecordingVoiceWorkerHost {
  shutdownCalls = 0

  override async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    if (command.type === 'cancel') throw new Error('cancel')
    return super.request(command, options)
  }

  shutdown(): void {
    this.shutdownCalls += 1
  }
}

class DeferredAudioWorkerHost extends RecordingVoiceWorkerHost {
  private audioSeen: (() => void) | null = null
  private release: (() => void) | null = null
  private readonly audioSeenPromise = new Promise<void>((resolve) => {
    this.audioSeen = resolve
  })
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.release = resolve
  })

  override async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    if (command.type === 'audio_frame') {
      this.audioSeen?.()
      await this.releasePromise
    }
    return super.request(command, options)
  }

  waitForAudioPost(): Promise<void> {
    return this.audioSeenPromise
  }

  releaseAudioPosts(): void {
    this.release?.()
  }
}

function defaultResponseFor(command: AuroraVoiceWorkerCommand): AuroraVoiceWorkerResponse {
  switch (command.type) {
    case 'init':
      return {
        type: 'ready',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        capabilities: { vad: false, kws: false, stt: false, tts: false },
        maxFrameSamples: command.maxFrameSamples,
        maxQueuedBytes: command.maxQueuedBytes
      }
    case 'start':
      return { type: 'ack', sessionId: command.session.sessionId, generation: command.session.generation, sequence: null }
    case 'audio_frame':
      return { type: 'ack', sessionId: command.frame.sessionId, generation: command.frame.generation, sequence: command.frame.sequence }
    case 'stop':
      return { type: 'stop_result', sessionId: command.sessionId, generation: command.generation, capturedAudio: capturedAudio(command.sessionId, command.generation, []) }
    case 'finish_turn':
      return { type: 'ack', sessionId: command.sessionId, generation: command.generation, sequence: null }
    case 'cancel':
      return { type: 'ack', sessionId: command.sessionId ?? '', generation: command.generation, sequence: null }
    case 'shutdown':
      return { type: 'ack', sessionId: '', generation: command.generation, sequence: null }
  }
}

class FailingSource {
  readonly calls: string[] = []

  constructor(private readonly failMethod: 'start' | 'stop' | 'cancel') {}

  async start(_session: AuroraVoiceWebSession): Promise<void> {
    this.calls.push('start')
    if (this.failMethod === 'start') throw new Error('start')
  }

  async stop(_sessionId: string): Promise<void> {
    this.calls.push('stop')
    if (this.failMethod === 'stop') throw new Error('stop')
  }

  async cancel(_sessionId: string): Promise<void> {
    this.calls.push('cancel')
    if (this.failMethod === 'cancel') throw new Error('cancel')
  }
}

class DeferredStartSource {
  readonly calls: string[] = []
  private started: (() => void) | null = null
  private release: (() => void) | null = null
  private readonly startedPromise = new Promise<void>((resolve) => {
    this.started = resolve
  })
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.release = resolve
  })

  async start(): Promise<void> {
    this.calls.push('start')
    this.started?.()
    await this.releasePromise
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
  }

  async cancel(): Promise<void> {
    this.calls.push('cancel')
  }

  waitUntilStarting(): Promise<void> {
    return this.startedPromise
  }

  finishStarting(): void {
    this.release?.()
  }
}

class DeferredFirstStartSource extends DeferredStartSource {
  private startCount = 0

  override async start(): Promise<void> {
    this.startCount += 1
    if (this.startCount === 1) await super.start()
  }
}

function frame(
  sessionId: string,
  generation: number,
  sequence: number,
  samples: readonly number[],
  discontinuity = false
): AuroraPcmFrame {
  return {
    sessionId,
    generation,
    sequence,
    discontinuity,
    sampleRateHz: 16_000,
    channels: 1,
    pcm: Int16Array.from(samples)
  }
}
