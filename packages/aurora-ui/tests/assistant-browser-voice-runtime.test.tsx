// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport, ORCHESTRATOR_METHODS, type AssistantStreamUpdate } from '@aurora/client'
import { AssistantView } from '../src/assistant-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import { getAuroraSurfaceProfile } from '../src/platform-surface'
import type { RouteAvailability } from '../src/shell-data'

const voiceRuntimeMock = vi.hoisted(() => ({
  create: vi.fn()
}))

vi.mock('@aurora/voice-web/browser', () => ({
  createAuroraBrowserVoiceRuntime: voiceRuntimeMock.create
}))

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  voiceRuntimeMock.create.mockReset()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Assistant hosted browser voice runtime', () => {
  it('uses the hosted runtime without direct UI microphone capture and sends Int16 little-endian PCM for transcription', async () => {
    const runtime = createRuntimeMock({
      capturedPcm: new Int16Array([0x1234, -2])
    })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const getUserMedia = vi.fn(async () => { throw new Error('unexpected direct microphone access') })
    const mediaRecorder = vi.fn()
    const audioContext = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', mediaRecorder)
    vi.stubGlobal('AudioContext', audioContext)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.completeTurn).toHaveBeenCalledTimes(1))

    expect(voiceRuntimeMock.create).toHaveBeenCalledTimes(1)
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(audioContext).not.toHaveBeenCalled()
    expect(transcribe.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      audio_data: btoa(String.fromCharCode(0x34, 0x12, 0xfe, 0xff)),
      format: 'raw',
      sample_rate: 16_000,
      channels: 1,
      model: 'accurate',
      routePolicy: expect.any(Object)
    }))
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
  })

  it('abandons the hosted turn when transcription fails', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue({
      ok: false,
      error: new Error('transcription unavailable')
    } as Awaited<ReturnType<typeof client.assistant.transcribeVoiceAudio>>)
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.abandonTurn).toHaveBeenCalledTimes(1))

    expect(runtime.completeTurn).not.toHaveBeenCalled()
    expect(streamMessage).not.toHaveBeenCalled()
  })

  it('abandons the hosted turn when transcription throws', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockRejectedValue(new Error('transcription unavailable'))
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.abandonTurn).toHaveBeenCalledTimes(1))

    expect(runtime.completeTurn).not.toHaveBeenCalled()
    expect(streamMessage).not.toHaveBeenCalled()
  })

  it('abandons the hosted turn when the assistant response fails', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield failedUpdate()
    })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.abandonTurn).toHaveBeenCalledTimes(1))

    expect(runtime.completeTurn).not.toHaveBeenCalled()
  })

  it('does not send a late transcription after the user stops hosted processing', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcription = deferred<Awaited<ReturnType<typeof client.assistant.transcribeVoiceAudio>>>()
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockReturnValue(transcription.promise)
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(findButton(container, 'Stop assistant generation')).toBeTruthy())
    await clickButton(container, 'Stop assistant generation')
    transcription.resolve(successfulTranscription('late words'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtime.abandonTurn).toHaveBeenCalledTimes(1)
    expect(runtime.cancel).not.toHaveBeenCalled()
    expect(streamMessage).not.toHaveBeenCalled()
    expect(runtime.completeTurn).not.toHaveBeenCalled()
  })

  it('does not send a late transcription after hosted processing loses focus', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcription = deferred<Awaited<ReturnType<typeof client.assistant.transcribeVoiceAudio>>>()
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockReturnValue(transcription.promise)
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    transcription.resolve(successfulTranscription('late words'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtime.cancel).toHaveBeenCalledWith('lifecycle_lost')
    expect(runtime.cancel).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(streamMessage).not.toHaveBeenCalled()
    expect(runtime.completeTurn).not.toHaveBeenCalled()
  })

  it('does not send a late transcription after the hosted audio lifecycle is lost while processing', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcription = deferred<Awaited<ReturnType<typeof client.assistant.transcribeVoiceAudio>>>()
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockReturnValue(transcription.promise)
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalledTimes(1))
    await act(async () => {
      voiceRuntimeMock.create.mock.calls[0]?.[0].onAudioLifecycleLost?.('track-ended')
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(findButton(container, 'Push to talk')).toBeTruthy())
    transcription.resolve(successfulTranscription('late words'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtime.cancel).toHaveBeenCalledWith('lifecycle_lost')
    expect(runtime.cancel).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(streamMessage).not.toHaveBeenCalled()
    expect(runtime.completeTurn).not.toHaveBeenCalled()
  })

  it('does not abandon or cancel when the user stops during pending hosted completion', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    const completion = deferred<undefined>()
    runtime.completeTurn.mockReturnValueOnce(completion.promise)
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.completeTurn).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(findComposerAction(container, 'stop')).toBeTruthy())
    await clickComposerAction(container, 'stop')
    completion.resolve(undefined)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
    expect(findButton(container, 'Push to talk')).toBeTruthy()
  })

  it('does not abandon or cancel when lifecycle is lost during pending hosted completion', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    const completion = deferred<undefined>()
    runtime.completeTurn.mockReturnValueOnce(completion.promise)
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.completeTurn).toHaveBeenCalledTimes(1))
    await act(async () => {
      voiceRuntimeMock.create.mock.calls[0]?.[0].onAudioLifecycleLost?.('track-ended')
      await Promise.resolve()
    })
    completion.resolve(undefined)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
    expect(findButton(container, 'Push to talk')).toBeTruthy()
  })

  it('disposes after unmount waits for pending hosted completion settlement', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    const completion = deferred<undefined>()
    runtime.completeTurn.mockReturnValueOnce(completion.promise)
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} surfaceProfile={hostedSurface()} />)
      await Promise.resolve()
    })

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.completeTurn).toHaveBeenCalledTimes(1))
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    roots.splice(roots.indexOf(root), 1)
    expect(runtime.dispose).not.toHaveBeenCalled()

    completion.resolve(undefined)
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledTimes(1))

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
  })

  it('cleans up failed hosted completion so the next capture can start', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    runtime.completeTurn.mockRejectedValueOnce(new Error('ack failed'))
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(runtime.completeTurn).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('Voice request finished, but Aurora could not close listening cleanly.'))

    expect(runtime.cancel).toHaveBeenCalledWith('turn_completed_failed')
    expect(runtime.cancel).toHaveBeenCalledTimes(1)
    expect(runtime.completeTurn.mock.invocationCallOrder[0]).toBeLessThan(runtime.cancel.mock.invocationCallOrder[0]!)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(2))
  })

  it('recreates the hosted runtime when failed completion cleanup cancel also fails', async () => {
    const failedRuntime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    failedRuntime.completeTurn.mockRejectedValueOnce(new Error('ack failed'))
    failedRuntime.cancel.mockRejectedValueOnce(new Error('cleanup failed'))
    const replacementRuntime = createRuntimeMock({ capturedPcm: new Int16Array([6, 7, 8, 9, 10]) })
    voiceRuntimeMock.create
      .mockReturnValueOnce(failedRuntime)
      .mockReturnValueOnce(replacementRuntime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(failedRuntime.completeTurn).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(failedRuntime.dispose).toHaveBeenCalledTimes(1))

    expect(failedRuntime.cancel).toHaveBeenCalledWith('turn_completed_failed')
    expect(failedRuntime.cancel).toHaveBeenCalledTimes(1)
    expect(failedRuntime.abandonTurn).not.toHaveBeenCalled()

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(voiceRuntimeMock.create).toHaveBeenCalledTimes(2))
    expect(replacementRuntime.start).toHaveBeenCalledTimes(1)
  })

  it('cancels hosted capture on lifecycle release and disposes on unmount without a MediaStream', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} surfaceProfile={hostedSurface()} />)
      await Promise.resolve()
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    expect(runtime.cancel).toHaveBeenCalledWith('lifecycle_lost')
    expect(getUserMedia).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    roots.splice(roots.indexOf(root), 1)

    expect(runtime.dispose).toHaveBeenCalledTimes(1)
  })

  it('leaves the Tauri local focused capture path on the existing media capture implementation', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    const getUserMedia = vi.fn(async () => stream)
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }))

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1))

    expect(voiceRuntimeMock.create).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
  })
})

function createRuntimeMock({ capturedPcm }: { capturedPcm: Int16Array }) {
  const session = {
    ownerId: 'aurora-assistant-view',
    sessionId: 'browser-voice-session',
    generation: 1,
    startedAtMs: 1,
    foregroundOnly: true as const
  }
  return {
    start: vi.fn(async () => session),
    stop: vi.fn(async () => ({
      sessionId: session.sessionId,
      generation: session.generation,
      sampleRateHz: 16_000,
      channels: 1,
      sampleCount: capturedPcm.length,
      durationMs: 500,
      pcm: capturedPcm,
      redacted: true as const
    })),
    completeTurn: vi.fn(async () => undefined),
    abandonTurn: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderAssistant(client: AuroraClient, surfaceProfile: ReturnType<typeof getAuroraSurfaceProfile>): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<AssistantView client={client} route={assistantRoute()} surfaceProfile={surfaceProfile} />)
  })
  return container
}

async function clickButton(container: HTMLElement, label: string) {
  await act(async () => {
    findButton(container, label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function hostedSurface() {
  return getAuroraSurfaceProfile({
    runtimeMode: 'web',
    transportKind: 'http',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15'
  })
}

function successfulTranscription(text: string) {
  return {
    ok: true as const,
    audit: audit('Transcription.Transcribe', 'Transcription.Transcribe'),
    data: {
      text,
      confidence: null,
      language: null,
      duration_ms: 1_000,
      model_used: 'test'
    }
  }
}

function completedUpdate(text: string): AssistantStreamUpdate {
  return {
    ...streamUpdate(text),
    kind: 'completed',
    text,
    textDelta: ''
  }
}

function failedUpdate(): AssistantStreamUpdate {
  return {
    ...streamUpdate(''),
    kind: 'failed',
    text: 'Assistant response failed.',
    textDelta: '',
    error: new Error('Assistant response failed.') as unknown as AssistantStreamUpdate['error']
  }
}

function streamUpdate(textDelta: string): AssistantStreamUpdate {
  return {
    kind: 'delta',
    eventId: 'event-1',
    messageId: 'message-1',
    sessionId: 'session-1',
    text: textDelta,
    textDelta,
    modelLabel: null,
    error: null,
    audit: audit(ORCHESTRATOR_METHODS.externalUserInput, ORCHESTRATOR_METHODS.externalUserInput),
    metadata: {},
    tool: null,
    ttsAudio: null
  }
}

function audit(method: string, busTopic: string) {
  return {
    correlationId: 'browser-voice-test',
    eventKind: null,
    peerId: null,
    principalId: null,
    targetPeerId: null,
    method,
    busTopic,
    toolId: null,
    resourceId: null,
    status: null,
    transport: 'mock',
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'sdk' as const,
      warnings: []
    }
  }
}

function assistantRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'assistant')
  if (!item) throw new Error('assistant route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Assistant route available from mock status.',
    providerLabel: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`,
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [ORCHESTRATOR_METHODS.externalUserInput],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === label)
  if (!button) throw new Error(`button ${label} not found`)
  return button
}

function findComposerAction(container: HTMLElement, action: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[data-composer-action="${action}"]`)
  if (!button) {
    const actions = Array.from(container.querySelectorAll('button[data-composer-action]'))
      .map((candidate) => `${candidate.getAttribute('data-composer-action')}:${candidate.getAttribute('aria-label')}`)
      .join(', ')
    throw new Error(`composer action ${action} not found; actions: ${actions}; text: ${container.textContent?.replace(/\s+/g, ' ').trim()}`)
  }
  return button
}

async function clickComposerAction(container: HTMLElement, action: string) {
  await act(async () => {
    findComposerAction(container, action).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

class FakeAudioContext {
  state = 'running'
  sampleRate = 16_000
  destination = {}
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }))
  createAnalyser = vi.fn(() => ({ fftSize: 1024, smoothingTimeConstant: 0.35, getByteTimeDomainData: vi.fn() }))
  createScriptProcessor = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null as unknown }))
}
