import { describe, expect, it } from 'vitest'
import { createAuroraBrowserVoiceRuntime } from '../src/browser-runtime.js'
import type { AuroraBrowserPageLifecyclePort, AuroraBrowserPageLifecycleListener } from '../src/browser-lifecycle.js'
import type { AuroraBrowserWorkerPort } from '../src/worker-rpc.js'

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
  type AuroraVoiceWorkerRequestEnvelope,
  type AuroraVoiceWorkerRequestOptions,
  type AuroraVoiceWorkerResponse,
  type AuroraVoiceWorkerResponseEnvelope
} from '../src/index.js'
import { capturedAudio, RecordingVoiceWorkerHost, synthesizedAudio } from '../src/test-doubles/worker-host.js'

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

  it('synthesizes bounded local TTS only after the worker advertises TTS capability', async () => {
    const worker = new RecordingVoiceWorkerHost()
    worker.responseOverride = (command) => {
      if (command.type === 'init') {
        return {
          type: 'ready',
          protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
          capabilities: { vad: false, kws: false, stt: false, tts: true },
          maxFrameSamples: command.maxFrameSamples,
          maxQueuedBytes: command.maxQueuedBytes
        }
      }
      if (command.type === 'synthesize_tts') return { type: 'tts_result', generation: command.generation, audio: synthesizedAudio(command.generation, [0, 1024, -1024]) }
      return defaultResponseFor(command)
    }
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-tts', worker })

    await expect(runtime.synthesizeSpeech({ text: ' Hello Aurora ', voiceId: 'voice.en', speakerId: 1, speed: 1.2 }))
      .resolves.toMatchObject({ generation: 1, sampleRateHz: 16_000, channels: 1, sampleCount: 3, redacted: true })

    expect(worker.commandsOf('synthesize_tts')).toEqual([{
      type: 'synthesize_tts',
      generation: 1,
      text: 'Hello Aurora',
      voiceId: 'voice.en',
      speakerId: 1,
      speed: 1.2
    }])
    expect(runtime.snapshot().capabilities.tts).toBe(true)
  })

  it('uses a separate bounded TTS timeout without changing capture command timeouts', async () => {
    const worker = new TimeoutRecordingWorkerHost()
    worker.responseOverride = (command) => {
      if (command.type === 'init') {
        return {
          type: 'ready',
          protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
          capabilities: { vad: false, kws: false, stt: false, tts: true },
          maxFrameSamples: command.maxFrameSamples,
          maxQueuedBytes: command.maxQueuedBytes
        }
      }
      return defaultResponseFor(command)
    }
    const runtime = new AuroraVoiceWebRuntime({
      ownerId: 'owner-tts-timeout',
      worker,
      workerTimeoutMs: 5_000,
      ttsTimeoutMs: 120_000
    })

    await runtime.synthesizeSpeech({ text: 'hello' })

    expect(worker.timeoutByType('init')).toEqual([120_000])
    expect(worker.timeoutByType('synthesize_tts')).toEqual([120_000])

    await runtime.start()
    expect(worker.timeoutByType('start')).toEqual([5_000])
    await runtime.cancel()

    const captureWorker = new TimeoutRecordingWorkerHost()
    const captureRuntime = new AuroraVoiceWebRuntime({ ownerId: 'owner-capture-timeout', worker: captureWorker, workerTimeoutMs: 5_000 })
    await captureRuntime.start()
    expect(captureWorker.timeoutByType('init')).toEqual([5_000])
    expect(captureWorker.timeoutByType('start')).toEqual([5_000])
    await captureRuntime.cancel()
  })

  it('keeps TTS unavailable when selected bindings do not initialize a TTS engine', async () => {
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-no-tts', worker: new RecordingVoiceWorkerHost() })

    await expect(runtime.synthesizeSpeech({ text: 'hello' })).rejects.toMatchObject({ code: 'tts_unavailable' })
  })

  it('transcribes bounded local PCM through the worker and fences output after cancellation', async () => {
    const worker = new DeferredSttWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-stt', worker })
    const pcm = new Int16Array([1, -2, 3])

    const transcription = runtime.transcribeSpeech({ pcm, language: 'en' })
    await worker.waitForSttPost()
    expect(worker.timeoutByType('transcribe_stt')).toEqual([60_000])
    expect(worker.commandsOf('transcribe_stt')[0]).toMatchObject({ type: 'transcribe_stt', generation: 1, pcm, language: 'en' })
    expect(worker.transfers.at(-1)).toHaveLength(1)

    await expect(runtime.start()).rejects.toMatchObject({ code: 'inference_busy' })
    await runtime.cancel()
    worker.releaseStt()

    await expect(transcription).rejects.toMatchObject({ code: 'stale_generation' })
    expect(worker.commandsOf('cancel')).toEqual([{ type: 'cancel', sessionId: null, generation: 1, reason: 'cancelled' }])
  })

  it('rejects finite STT capture while a capture session owns the voice runtime', async () => {
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-stt-capture', worker: new RecordingVoiceWorkerHost() })
    await runtime.start()

    await expect(runtime.transcribeSpeech({ pcm: new Int16Array([1]) })).rejects.toMatchObject({ code: 'session_active' })
    await runtime.cancel()
  })

  it('cancels finite STT and fences its response when foreground eligibility is lost', async () => {
    const worker = new DeferredSttWorkerHost()
    let eligible = true
    const runtime = new AuroraVoiceWebRuntime({
      ownerId: 'owner-stt-hidden',
      worker,
      lifecycle: () => eligible ? visibleLifecycle() : hiddenLifecycle('hidden'),
    })
    const transcription = runtime.transcribeSpeech({ pcm: new Int16Array([7, 8]) })
    await worker.waitForSttPost()

    eligible = false
    await runtime.refreshLifecycle()
    worker.releaseStt()

    await expect(transcription).rejects.toMatchObject({ code: 'stale_generation' })
    expect(worker.commandsOf('cancel')).toHaveLength(1)
  })

  it('fences hidden STT synchronously and lets resumed STT survive its delayed cancel acknowledgement', async () => {
    const worker = new DeferredLifecycleSttWorkerHost()
    const pageLifecycle = new ControllablePageLifecycle()
    const runtime = createAuroraBrowserVoiceRuntime({ ownerId: 'browser-lifecycle-stt', worker, pageLifecycle })
    let resolveCancelled: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
    runtime.onEvent((event) => {
      if (event.kind === 'session_cancelled') resolveCancelled?.()
    })

    const first = runtime.transcribeSpeech({ pcm: new Int16Array([11]) })
    await worker.waitForSttCount(1)
    pageLifecycle.set(hiddenLifecycle('hidden'))
    await worker.waitForCancelCount(1)

    pageLifecycle.set(visibleLifecycle())
    worker.releaseStt(0)
    await expect(first).rejects.toMatchObject({ code: 'stale_generation' })

    const resumed = runtime.transcribeSpeech({ pcm: new Int16Array([22]) })
    await worker.waitForSttCount(2)

    worker.releaseCancel(0)
    await cancelled
    worker.releaseStt(1)
    await expect(resumed).resolves.toMatchObject({ text: 'result-3', generation: 3 })
    await runtime.dispose()
  })

  it('cleans only the hidden capture when TTS completes before its cancel acknowledgement', async () => {
    const worker = new DeferredLifecycleSttWorkerHost()
    const pageLifecycle = new ControllablePageLifecycle()
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'browser-lifecycle-capture-tts',
      worker,
      pageLifecycle,
      pcmSource: { async start() {}, async stop() {}, async cancel() {} },
    })
    let resolveCancelled: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => { resolveCancelled = resolve })
    runtime.onEvent((event) => {
      if (event.kind === 'session_cancelled') resolveCancelled?.()
    })

    try {
      const capture = await runtime.start()
      pageLifecycle.set(hiddenLifecycle('hidden'))
      await worker.waitForCancelCount(1)
      pageLifecycle.set(visibleLifecycle())

      await expect(runtime.synthesizeSpeech({ text: 'resumed speech' })).resolves.toMatchObject({ sampleCount: 3 })
      worker.releaseCancel(0)
      await cancelled

      await expect(runtime.start()).resolves.toMatchObject({ generation: capture.generation + 1 })
    } finally {
      worker.acknowledgePendingCancels()
      worker.autoAcknowledgeCancels()
      await runtime.dispose().catch(() => undefined)
    }
  })

  it('discards stale TTS audio after cancellation', async () => {
    const worker = new DeferredTtsWorkerHost()
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-stale-tts', worker })

    const synthesis = runtime.synthesizeSpeech({ text: 'hello' })
    await worker.waitForTtsPost()
    await runtime.cancel('user_cancelled')
    worker.releaseTts()

    await expect(synthesis).rejects.toMatchObject({ code: 'stale_generation' })
    expect(worker.commandsOf('cancel')).toEqual([{ type: 'cancel', sessionId: null, generation: 1, reason: 'cancelled' }])
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

    await expect(starting).rejects.toMatchObject({ code: 'start_cancelled' })
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

    await expect(staleStart).rejects.toMatchObject({ code: 'start_cancelled' })
    expect(runtime.snapshot()).toMatchObject({ state: 'active', generation: 2, sessionId: 'owner-a:2' })
    await runtime.cancel()
  })

  it('preserves sanitized browser audio source startup classifications', async () => {
    const cases = [
      'audio_source_permission_denied',
      'audio_source_no_input_device',
      'audio_source_unavailable',
      'audio_source_start_timeout',
      'audio_source_suspended',
      'audio_source_start_failed'
    ] as const

    for (const code of cases) {
      const worker = new RecordingVoiceWorkerHost()
      const source = new CodedFailingSource(code)
      const runtime = new AuroraVoiceWebRuntime({ ownerId: `owner-${code}`, worker, pcmSource: source })
      const events: AuroraVoiceWebEvent[] = []
      runtime.onEvent((event) => events.push(event))

      await expect(runtime.start()).rejects.toMatchObject({ code })
      expect(events.find((event) => event.kind === 'error')).toMatchObject({ reason: code, redacted: true })
      expect(worker.commandsOf('cancel').at(-1)?.reason).toBe(code)
      expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', sessionId: null, queuedBytes: 0 })
    }
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

  it('delivers typed VAD KWS and STT outputs from frame acknowledgements to runtime callers', async () => {
    const worker = new RecordingVoiceWorkerHost()
    const events: AuroraVoiceWebEvent[] = []
    worker.responseOverride = (command) => {
      if (command.type === 'audio_frame') {
        return {
          type: 'ack',
          sessionId: command.frame.sessionId,
          generation: command.frame.generation,
          sequence: command.frame.sequence,
          inference: {
            vad: { active: true, speechDetected: true, sequence: command.frame.sequence, redacted: true },
            kwsHits: [{ keyword: 'aurora', score: 0.5, sequence: command.frame.sequence, redacted: true }],
            stt: [{ text: 'hello', final: false, sequence: command.frame.sequence, redacted: true }],
            redacted: true
          }
        }
      }
      return defaultResponseFor(command)
    }
    const runtime = new AuroraVoiceWebRuntime({ ownerId: 'owner-a', worker, nowMs: () => 10 })
    runtime.onEvent((event) => events.push(event))
    const session = await runtime.start()

    await expect(runtime.pushFrame(frame(session.sessionId, session.generation, 0, [1, 2]))).resolves.toBe(true)

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'voice_inference',
      sequence: 0,
      inference: {
        vad: { active: true, speechDetected: true, sequence: 0, redacted: true },
        kwsHits: [{ keyword: 'aurora', score: 0.5, sequence: 0, redacted: true }],
        stt: [{ text: 'hello', final: false, sequence: 0, redacted: true }],
        redacted: true
      },
      redacted: true
    }))
    await runtime.cancel()
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

class DeferredTtsWorkerHost extends RecordingVoiceWorkerHost {
  private ttsSeen: (() => void) | null = null
  private release: (() => void) | null = null
  private readonly ttsSeenPromise = new Promise<void>((resolve) => {
    this.ttsSeen = resolve
  })
  private readonly releasePromise = new Promise<void>((resolve) => {
    this.release = resolve
  })

  override async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    if (command.type === 'init') {
      this.transfers.push([...(options?.transfer ?? [])])
      this.commands.push(command)
      return {
        type: 'ready',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        capabilities: { vad: false, kws: false, stt: false, tts: true },
        maxFrameSamples: command.maxFrameSamples,
        maxQueuedBytes: command.maxQueuedBytes
      }
    }
    if (command.type === 'synthesize_tts') {
      this.transfers.push([...(options?.transfer ?? [])])
      this.commands.push(command)
      this.ttsSeen?.()
      await this.releasePromise
      return { type: 'tts_result', generation: command.generation, audio: synthesizedAudio(command.generation, [0, 1, -1]) }
    }
    return super.request(command, options)
  }

  waitForTtsPost(): Promise<void> {
    return this.ttsSeenPromise
  }

  releaseTts(): void {
    this.release?.()
  }
}

class TimeoutRecordingWorkerHost extends RecordingVoiceWorkerHost {
  readonly timeouts: { readonly type: AuroraVoiceWorkerCommand['type']; readonly timeoutMs?: number }[] = []

  override async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    this.timeouts.push({
      type: command.type,
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    })
    return super.request(command, options)
  }

  timeoutByType(type: AuroraVoiceWorkerCommand['type']): (number | undefined)[] {
    return this.timeouts.filter((entry) => entry.type === type).map((entry) => entry.timeoutMs)
  }
}

class DeferredSttWorkerHost extends TimeoutRecordingWorkerHost {
  private sttSeen: (() => void) | null = null
  private release: (() => void) | null = null
  private readonly sttSeenPromise = new Promise<void>((resolve) => { this.sttSeen = resolve })
  private readonly releasePromise = new Promise<void>((resolve) => { this.release = resolve })

  override async request(command: AuroraVoiceWorkerCommand, options?: AuroraVoiceWorkerRequestOptions): Promise<AuroraVoiceWorkerResponse> {
    if (command.type === 'init') {
      this.transfers.push([...(options?.transfer ?? [])])
      this.commands.push(command)
      return {
        type: 'ready',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        capabilities: { vad: false, kws: false, stt: true, tts: false },
        maxFrameSamples: command.maxFrameSamples,
        maxQueuedBytes: command.maxQueuedBytes
      }
    }
    if (command.type === 'transcribe_stt') {
      this.timeouts.push({
        type: command.type,
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
      })
      this.transfers.push([...(options?.transfer ?? [])])
      this.commands.push({ ...command, pcm: new Int16Array(command.pcm) })
      this.sttSeen?.()
      await this.releasePromise
      return { type: 'stt_result', generation: command.generation, text: 'late transcript' }
    }
    return super.request(command, options)
  }

  waitForSttPost(): Promise<void> { return this.sttSeenPromise }
  releaseStt(): void { this.release?.() }
}

class ControllablePageLifecycle implements AuroraBrowserPageLifecyclePort {
  private eligibility = visibleLifecycle()
  private readonly listeners = new Set<AuroraBrowserPageLifecycleListener>()

  current(): ReturnType<typeof visibleLifecycle> | ReturnType<typeof hiddenLifecycle> { return this.eligibility }

  subscribe(listener: AuroraBrowserPageLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(eligibility: ReturnType<typeof visibleLifecycle> | ReturnType<typeof hiddenLifecycle>): void {
    this.eligibility = eligibility
    for (const listener of this.listeners) listener(eligibility)
  }
}

class DeferredLifecycleSttWorkerHost implements AuroraBrowserWorkerPort {
  readonly commands: AuroraVoiceWorkerRequestEnvelope['command'][] = []
  readonly transfers: Transferable[][] = []
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null
  private readonly stt: Array<{
    readonly requestId: number
    readonly generation: number
  }> = []
  private readonly cancels: Array<{
    readonly requestId: number
    readonly command: Extract<AuroraVoiceWorkerCommand, { type: 'cancel' }>
  }> = []
  private readonly sttWaiters = new Map<number, () => void>()
  private readonly cancelWaiters = new Map<number, () => void>()
  private readonly releasedCancels = new Set<number>()
  private acknowledgeCancelsImmediately = false

  postMessage(message: AuroraVoiceWorkerRequestEnvelope, transfer: readonly Transferable[] = []): void {
    this.transfers.push([...transfer])
    const command = message.command
    this.commands.push(command.type === 'transcribe_stt' ? { ...command, pcm: new Int16Array(command.pcm) } : command)
    if (command.type === 'init') {
      this.respond(message.requestId, {
        type: 'ready',
        protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
        capabilities: { vad: false, kws: false, stt: true, tts: true },
        maxFrameSamples: command.maxFrameSamples,
        maxQueuedBytes: command.maxQueuedBytes
      })
    } else if (command.type === 'start' || command.type === 'synthesize_tts') {
      this.respond(message.requestId, defaultResponseFor(command))
    } else if (command.type === 'transcribe_stt') {
      this.stt.push({ requestId: message.requestId, generation: command.generation })
      this.notifyWaiters(this.stt.length, this.sttWaiters)
    } else if (command.type === 'cancel') {
      this.cancels.push({ requestId: message.requestId, command })
      this.notifyWaiters(this.cancels.length, this.cancelWaiters)
      if (this.acknowledgeCancelsImmediately) this.releaseCancel(this.cancels.length - 1)
    } else if (command.type === 'shutdown') {
      this.respond(message.requestId, { type: 'ack', sessionId: '', generation: command.generation, sequence: null })
    }
  }

  addEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)): void {
    if (type === 'message') this.messageListener = listener as (event: MessageEvent<unknown>) => void
  }

  removeEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | ((event: Event) => void)): void {
    if (type === 'message' && this.messageListener === listener) this.messageListener = null
  }

  terminate(): void {}

  waitForSttCount(count: number): Promise<void> {
    return this.waitForCount(count, this.stt.length, this.sttWaiters)
  }

  waitForCancelCount(count: number): Promise<void> {
    return this.waitForCount(count, this.cancels.length, this.cancelWaiters)
  }

  releaseStt(index: number): void {
    const request = this.stt[index]
    if (!request) throw new Error(`missing deferred STT request ${index}`)
    this.respond(request.requestId, { type: 'stt_result', generation: request.generation, text: `result-${request.generation}` })
  }

  releaseCancel(index: number): void {
    const request = this.cancels[index]
    if (!request) throw new Error(`missing deferred cancel request ${index}`)
    if (this.releasedCancels.has(index)) return
    this.releasedCancels.add(index)
    this.respond(request.requestId, {
      type: 'ack',
      sessionId: request.command.sessionId ?? '',
      generation: request.command.generation,
      sequence: null
    })
  }

  acknowledgePendingCancels(): void {
    for (let index = 0; index < this.cancels.length; index += 1) this.releaseCancel(index)
  }

  autoAcknowledgeCancels(): void {
    this.acknowledgeCancelsImmediately = true
  }

  private waitForCount(count: number, current: number, waiters: Map<number, () => void>): Promise<void> {
    if (current >= count) return Promise.resolve()
    return new Promise((resolve) => waiters.set(count, resolve))
  }

  private notifyWaiters(current: number, waiters: Map<number, () => void>): void {
    for (const [count, resolve] of waiters) {
      if (current < count) continue
      waiters.delete(count)
      resolve()
    }
  }

  private respond(requestId: number, response: AuroraVoiceWorkerResponse): void {
    const envelope: AuroraVoiceWorkerResponseEnvelope = {
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId,
      response
    }
    queueMicrotask(() => this.messageListener?.({ data: envelope } as MessageEvent<unknown>))
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
    case 'synthesize_tts':
      return {
        type: 'tts_result',
        generation: command.generation,
        audio: {
          generation: command.generation,
          sampleRateHz: 16_000,
          channels: 1,
          sampleCount: 3,
          durationMs: 1,
          pcm: new Int16Array([0, 1024, -1024]),
          redacted: true
        }
      }
    case 'transcribe_stt':
      return { type: 'stt_result', generation: command.generation, text: '' }
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

class CodedFailingSource {
  constructor(private readonly code: string) {}

  async start(): Promise<void> {
    throw new AuroraVoiceWebRuntimeError(this.code, 'sanitized startup failure')
  }

  async stop(): Promise<void> {}

  async cancel(): Promise<void> {}
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
