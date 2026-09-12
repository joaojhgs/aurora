// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport, ORCHESTRATOR_METHODS, type AssistantRoutePolicy, type AssistantStreamUpdate } from '@aurora/client'
import { AssistantView, buildAssistantVoiceModel, routePolicyFromRoute } from '../src/assistant-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import {
  AURORA_RELEASE_FOCUSED_MEDIA_EVENT,
  getAuroraSurfaceProfile,
  type AuroraLocalSpeechPackState,
} from '../src/platform-surface'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus } from '../src/native-desktop-voice'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { AssistantVoiceRoutes, RouteAvailability } from '../src/shell-data'
import type { NativeMobileVoicePort, NativeMobileVoiceStatus } from '../src/native-mobile-voice'
import type { AuroraVoiceInferenceOutput, AuroraVoiceWebModelBindings } from '@aurora/voice-web'

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

  it('uses selected cached browser STT before remote transcription', async () => {
    const runtime = createRuntimeMock({
      capturedPcm: new Int16Array([0x1234, -2])
    })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('Local response ready.')
    })
    const modelBindings: AuroraVoiceWebModelBindings = {
      files: [{
        task: 'stt' as const,
        fileId: 'stt-model',
        virtualPath: '/stt/model.onnx',
        sha256: 'a'.repeat(64),
        byteLength: 4,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }],
      models: [{
        task: 'stt' as const,
        family: 'whisper',
        kind: 'offline-asr',
        files: [{ role: 'model', fileId: 'stt-model', virtualPath: '/stt/model.onnx' }],
        config: { language: 'en', task: 'transcribe' },
      }],
    }
    const container = renderAssistant(client, hostedSurface(), undefined, {
      browserSpeechPacks: {
        state: 'ready',
        packs: [],
        modelBindings,
        capabilities: { vad: false, kws: false, stt: true, tts: false },
        revision: 'stt:small.en:1',
      },
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    await act(async () => {
      runtime.emitEvent({
        kind: 'voice_inference',
        inference: {
          stt: [{ text: 'open the calendar', final: true, sequence: 1, redacted: true }],
          kwsHits: [],
          redacted: true,
        },
      })
      await Promise.resolve()
    })
    await clickButton(container, 'Stop listening')

    await vi.waitFor(() => expect(streamMessage).toHaveBeenCalledTimes(1))
    expect(transcribe).not.toHaveBeenCalled()
    expect(streamMessage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      text: 'open the calendar',
    }))
    expect(voiceRuntimeMock.create).toHaveBeenCalledWith(expect.objectContaining({
      modelBindings,
      sherpaAssets: expect.objectContaining({
        vadAsrModuleUrl: expect.any(URL),
      }),
    }))
    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
  })

  it('updates the hosted visualizer from redacted browser audio levels', async () => {
    const fillRect = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      fillRect,
    } as unknown as CanvasRenderingContext2D)
    const runtime = createRuntimeMock({
      capturedPcm: new Int16Array([1, 2, 3, 4])
    })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    const options = voiceRuntimeMock.create.mock.calls[0]?.[0] as {
      audio?: { onAudioLevel?: (level: number, peak: number) => void }
    } | undefined
    expect(options?.audio?.onAudioLevel).toEqual(expect.any(Function))

    fillRect.mockClear()
    await act(async () => {
      options?.audio?.onAudioLevel?.(0.42, 0.9)
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(fillRect).toHaveBeenCalled())
    const renderedBarHeights = fillRect.mock.calls.slice(1).map((call) => Number(call[3]))
    expect(Math.max(...renderedBarHeights)).toBeGreaterThan(3)
    expect(findForbiddenProductionCopyTerms(container.textContent ?? '').map((term) => term.id)).toEqual([])
  })

  it.each([
    ['Android WebView', getAuroraSurfaceProfile({
      runtimeMode: 'android-node',
      transportKind: 'mesh',
      nativePlatform: 'android',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    })],
    ['mobile WebView', getAuroraSurfaceProfile({
      runtimeMode: 'mobile',
      transportKind: 'http',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    })],
  ] as const)('routes %s focused push-to-talk through the browser runtime without direct UI microphone capture', async (_label, surfaceProfile) => {
    const runtime = createRuntimeMock({
      capturedPcm: new Int16Array([0x21, 0x22])
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
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('mobile speech'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const container = renderAssistant(client, surfaceProfile)

    expect(surfaceProfile.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))

    expect(voiceRuntimeMock.create).toHaveBeenCalledTimes(1)
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(audioContext).not.toHaveBeenCalled()
    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
  })

  it('shows on-device speech state while hosted capture still uses connected transcription', async () => {
    const runtime = createRuntimeMock({
      capturedPcm: new Int16Array([7, 8, 9])
    })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('hello aurora'))
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('done')
    })
    const surfaceProfile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'over-budget',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15'
    })
    const model = buildAssistantVoiceModel({
      client,
      route: assistantRoute(),
      surfaceProfile,
      captureStatus: 'idle',
      consentGranted: false,
    })
    const localSpeechChip = model.chips.find((chip) => chip.id === 'local-speech-pack')
    const container = renderAssistant(client, surfaceProfile)

    expect(localSpeechChip).toMatchObject({
      label: 'On-device speech',
      detail: expect.stringContaining('needs more available storage or memory'),
    })
    expect(model.chips.find((chip) => chip.id === 'wake')?.label).toBe('Wake while open')
    expect(container.querySelector('#assistant-route-panel')).toBeNull()
    expect(findButtonOrNull(container, 'Open route details')).toBeNull()
    expect(container.textContent).not.toContain('Route & privacy sheet')
    expect(container.textContent).not.toContain('Wake and background')
    expect(container.textContent).not.toContain('Session TTL')
    expect(container.textContent).not.toContain('transient unless backend retention policy says otherwise')
    expect(container.textContent).not.toContain('Audio route and consent')
    expect(findForbiddenProductionCopyTerms(`${localSpeechChip?.label ?? ''} ${localSpeechChip?.detail ?? ''}`)).toEqual([])

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(runtime.completeTurn).toHaveBeenCalledTimes(1))

    expect(transcribe.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      routePolicy: expect.any(Object)
    }))
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
  })

  it.each([
    ['disabled', []],
    ['unavailable', ['foreground-voice']],
    ['downloading', ['foreground-voice']],
    ['incompatible', ['foreground-voice']],
    ['over-budget', ['foreground-voice']],
  ] as const)('keeps authorized remote STT and TTS routes selected when local speech is %s', (
    localSpeechPackState,
    enabledCapabilityPacks,
  ) => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const routes = remoteVoiceRoutes('studio')
    const surfaceProfile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks,
      localSpeechPackState: localSpeechPackState as AuroraLocalSpeechPackState,
    })
    const model = buildAssistantVoiceModel({
      client,
      route: assistantRoute(),
      voiceRoutes: routes,
      surfaceProfile,
      captureStatus: 'idle',
      consentGranted: true,
    })

    expect(surfaceProfile.nodeMode).toBe('mesh-node')
    expect(surfaceProfile.localSpeechPack).toMatchObject({
      state: localSpeechPackState,
      canRunLocalVad: false,
      canRunLocalKws: false,
      canRunLocalStt: false,
      canRunLocalTts: false,
    })
    expect(model.transcriptionRoute).toBe(routes.transcription)
    expect(model.transcriptionRoute).toMatchObject({ state: 'available-remote', disabled: false })
    expect(model.speechRoute).toBe(routes.ttsSynthesize)
    expect(model.speechRoute).toMatchObject({ state: 'available-remote', disabled: false })
  })

  it('does not let a local download state bypass connected-voice consent', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'downloading',
    }), undefined, { voiceRoutes: remoteVoiceRoutes('studio') })

    await clickButton(container, 'Push to talk')
    await act(async () => { await Promise.resolve() })

    expect(runtime.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Review connected voice access before starting speech.')
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
    await clickButton(container, 'Push to talk')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(runtime.cancel).not.toHaveBeenCalled()

    completion.resolve(undefined)
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(2))

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
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
    await clickButton(container, 'Push to talk')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(runtime.cancel).not.toHaveBeenCalled()

    completion.resolve(undefined)
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(2))

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
  })

  it('does not start or cancel early when reset is followed by immediate PTT during pending hosted completion', async () => {
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
    await clickButton(container, 'New conversation')
    await clickButton(container, 'Push to talk')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(runtime.cancel).not.toHaveBeenCalled()

    completion.resolve(undefined)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(findButton(container, 'Push to talk')).toBeTruthy())
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(2))

    expect(runtime.completeTurn).toHaveBeenCalledTimes(1)
    expect(runtime.abandonTurn).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
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
    expect(runtime.unsubscribeEvent).toHaveBeenCalledTimes(1)
    const renderedAfterUnmount = container.textContent
    await act(async () => {
      runtime.emitEvent({ kind: 'error', reason: '/private/device/path after unmount' })
      await Promise.resolve()
    })
    expect(container.textContent).toBe(renderedAfterUnmount)
  })

  it('releases Android WebView browser capture on the native focused-media signal', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const getUserMedia = vi.fn()
    const mediaRecorder = vi.fn()
    const audioContext = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', mediaRecorder)
    vi.stubGlobal('AudioContext', audioContext)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const surfaceProfile = getAuroraSurfaceProfile({
      runtimeMode: 'android-node',
      transportKind: 'mesh',
      nativePlatform: 'android',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
    })
    expect(surfaceProfile.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, surfaceProfile)
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(runtime.cancel).toHaveBeenCalledWith('lifecycle_lost'))
    expect(findButton(container, 'Push to talk')).toBeTruthy()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(audioContext).not.toHaveBeenCalled()
  })

  it('applies redacted browser runtime events without rendering runtime details', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.onEvent).toHaveBeenCalledTimes(1))
    await act(async () => {
      runtime.emitEvent({ kind: 'frame_dropped', reason: 'queue_limit_internal' })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Microphone capture is continuing with reduced quality.')
    expect(container.textContent).not.toContain('queue_limit_internal')

    await act(async () => {
      runtime.emitEvent({ kind: 'error', reason: '/private/device/path runtime failure' })
      await Promise.resolve()
    })
    await vi.waitFor(() => {
      expect(container.querySelector('[data-voice-recovery="true"]')?.textContent)
        .toBe('Microphone capture failed. Try again.')
    })
    expect(container.textContent).not.toContain('/private/device/path')
    expect(container.textContent).not.toMatch(/\b(runtime|frame_dropped|queue_limit_internal)\b/i)
  })

  it('routes desktop-local focused voice only through the native desktop port', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const getUserMedia = vi.fn()
    const mediaRecorder = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', mediaRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const startVoiceListen = vi.spyOn(client.assistant, 'startVoiceListen')
    const stopVoiceListen = vi.spyOn(client.assistant, 'stopVoiceListen')
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const cancel = vi.spyOn(client.assistant, 'cancel')
    const nativeVoice = createNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }), nativeVoice)

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(nativeVoice.finish).toHaveBeenCalledTimes(1))

    expect(nativeVoice.start).toHaveBeenCalledWith({
      trigger: 'focused_push_to_talk',
      remoteAudioConsent: false
    })
    expect(nativeVoice.finish).toHaveBeenCalledWith({ generation: 1, reason: 'user_request' })
    expect(voiceRuntimeMock.create).not.toHaveBeenCalled()
    expect(runtime.start).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(stopVoiceListen).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps local focused voice local even when the user allowed connected voice earlier in the session', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }), nativeVoice)

    await clickButton(container, 'Allow connected voice')
    await vi.waitFor(() => expect(findButton(container, 'Stop connected voice access')).toBeTruthy())
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1))

    expect(nativeVoice.start).toHaveBeenCalledWith({
      trigger: 'focused_push_to_talk',
      remoteAudioConsent: false
    })
  })

  it('keeps local focused voice local when a connected transcription alternative is available', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createNativeDesktopVoicePort()
    const voiceRoutes = localVoiceRoutesWithRemoteAlternative('studio')
    expect(routePolicyFromRoute(voiceRoutes.transcription)).toEqual(expect.objectContaining({
      providerId: 'local:Transcription',
      peerId: null,
      serviceInstanceId: null
    }))
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }), nativeVoice, { voiceRoutes })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    expect(nativeVoice.start).toHaveBeenCalledWith({
      trigger: 'focused_push_to_talk',
      remoteAudioConsent: false
    })
  })

  it('blocks a privacy-limited connected transcription candidate before native start', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createNativeDesktopVoicePort()
    const routes = remoteVoiceRoutes('studio')
    routes.transcription = {
      ...routes.transcription,
      state: 'privacy-blocked',
      selectorRequired: false,
      disabled: true
    }
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    }), nativeVoice, { voiceRoutes: routes })

    await clickButton(container, 'Push to talk')
    await act(async () => { await Promise.resolve() })

    expect(nativeVoice.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Review connected voice access before starting speech.')
  })

  it('blocks connected speech capture before native start until the user explicitly allows it', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    }), nativeVoice, { voiceRoutes: remoteVoiceRoutes('studio') })

    await clickButton(container, 'Push to talk')
    await act(async () => { await Promise.resolve() })

    expect(nativeVoice.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Review connected voice access before starting speech.')

    await clickButton(container, 'Allow connected voice')
    await vi.waitFor(() => expect(findButton(container, 'Stop connected voice access')).toBeTruthy())
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1))

    expect(nativeVoice.start).toHaveBeenCalledWith({
      trigger: 'focused_push_to_talk',
      remoteAudioConsent: true
    })
  })

  it('blocks selector-required connected speech before desktop native start after consent', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const startVoiceListen = vi.spyOn(client.assistant, 'startVoiceListen')
    const transcribeVoiceAudio = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const nativeVoice = createNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    }), nativeVoice, { voiceRoutes: selectorRequiredRemoteVoiceRoutes('studio', 'booth') })

    await clickButton(container, 'Allow connected voice')
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(container.textContent).toContain('Choose a connected voice device before starting speech.'))

    expect(nativeVoice.start).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(transcribeVoiceAudio).not.toHaveBeenCalled()
    expect(voiceRuntimeMock.create).not.toHaveBeenCalled()
    expect(findButtonOrNull(container, 'Stop listening')).toBeNull()
  })

  it('stops active connected speech capture when connected voice access is revoked', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    }), nativeVoice, { voiceRoutes: remoteVoiceRoutes('studio') })

    await clickButton(container, 'Allow connected voice')
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop connected voice access')
    await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(1))

    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 1, reason: 'user_request' })
    expect(findButton(container, 'Allow connected voice')).toBeTruthy()
  })

  it('waits for browser connected speech capture cancellation before showing access as revoked', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, 2, 3, 4, 5]) })
    const cancel = deferred<undefined>()
    runtime.cancel.mockReturnValue(cancel.promise)
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface(), undefined, { voiceRoutes: remoteVoiceRoutes('studio') })

    await clickButton(container, 'Allow connected voice')
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop connected voice access')

    expect(runtime.cancel).toHaveBeenCalledWith('consent_revoked')
    expect(findButton(container, 'Stop connected voice access')).toBeTruthy()
    expect(findButtonOrNull(container, 'Allow connected voice')).toBeNull()

    cancel.resolve(undefined)
    await vi.waitFor(() => expect(findButton(container, 'Allow connected voice')).toBeTruthy())
  })

  it('applies connected voice access truth table to native mobile capture', async () => {
    const localClient = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const localMobileVoice = createNativeMobileVoicePort()
    const localContainer = renderAssistant(localClient, nativeMobileSurface(), undefined, {
      nativeMobileVoice: localMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(localContainer, 'Push to talk')
    await vi.waitFor(() => expect(localMobileVoice.start).toHaveBeenCalledTimes(1))
    expect(localMobileVoice.start).toHaveBeenCalledWith({ remoteAudioConsent: false })

    const blockedClient = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const blockedMobileVoice = createNativeMobileVoicePort()
    const blockedContainer = renderAssistant(blockedClient, nativeMobileSurface(), undefined, {
      nativeMobileVoice: blockedMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android',
      voiceRoutes: remoteVoiceRoutes('studio')
    })

    await clickButton(blockedContainer, 'Push to talk')
    await act(async () => { await Promise.resolve() })
    expect(blockedMobileVoice.start).not.toHaveBeenCalled()
    expect(blockedContainer.textContent).toContain('Review connected voice access before starting speech.')

    const grantedClient = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const grantedMobileVoice = createNativeMobileVoicePort()
    const grantedContainer = renderAssistant(grantedClient, nativeMobileSurface(), undefined, {
      nativeMobileVoice: grantedMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android',
      voiceRoutes: remoteVoiceRoutes('studio')
    })

    await clickButton(grantedContainer, 'Allow connected voice')
    await clickButton(grantedContainer, 'Push to talk')
    await vi.waitFor(() => expect(grantedMobileVoice.start).toHaveBeenCalledTimes(1))
    expect(grantedMobileVoice.start).toHaveBeenCalledWith({ remoteAudioConsent: true })
  })

  it('keeps native mobile hands-free startup out of the assistant route when wake assets become ready', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    let backgroundAvailable = false
    nativeMobileVoice.backgroundStatus.mockImplementation(async () => (
      backgroundAvailable
        ? nativeMobileStatus('idle')
        : nativeMobileStatus('unavailable')
    ))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const render = (surfaceProfile: ReturnType<typeof getAuroraSurfaceProfile>) => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          surfaceProfile={surfaceProfile}
          nativeMobileVoice={nativeMobileVoice}
          nativeAvailable
          nativePlatform="android"
        />
      )
    }

    await act(async () => {
      render(nativeMobileSurface())
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(nativeMobileVoice.backgroundStatus).toHaveBeenCalledTimes(1))
    expect(findButtonOrNull(container, 'Hands-free')).toBeNull()

    backgroundAvailable = true
    await act(async () => {
      render(nativeMobileBackgroundSurface())
      await Promise.resolve()
    })

    expect(nativeMobileVoice.startBackground).not.toHaveBeenCalled()
    expect(findButtonOrNull(container, 'Hands-free')).toBeNull()
  })

  it('observes native-owned mobile hands-free state and preserves it when hidden', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('listening', true))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    expect(findButtonOrNull(container, 'Open route details')).toBeNull()
    expect(container.querySelector('#assistant-route-panel')).toBeNull()
    await vi.waitFor(() => expect(nativeMobileVoice.backgroundStatus).toHaveBeenCalled())
    expect(nativeMobileVoice.start).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    expect(nativeMobileVoice.cancel).not.toHaveBeenCalled()
    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
  })

  it('temporarily hands native-owned mobile background capture to push-to-talk', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening', true))
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('listening', true))
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    const pushToTalk = await vi.waitFor(() => findButton(container, 'Push to talk'))
    expect(pushToTalk.hasAttribute('disabled')).toBe(false)
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    expect(nativeMobileVoice.startBackground).not.toHaveBeenCalled()
    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
    expect(findButtonOrNull(container, 'Hands-free')).toBeNull()
  })

  it('does not start mobile hands-free voice from the assistant UI', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('idle'))
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await vi.waitFor(() => expect(nativeMobileVoice.backgroundStatus).toHaveBeenCalled())
    expect(nativeMobileVoice.startBackground).not.toHaveBeenCalled()
    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
    expect(findButtonOrNull(container, 'Hands-free')).toBeNull()
  })

  it('keeps local native mobile hands-free independent from connected speech consent and selection', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    const surfaceProfile = nativeMobileBackgroundSurface()
    const voiceRoutes = selectorRequiredRemoteVoiceRoutes('studio', 'booth')
    const model = buildAssistantVoiceModel({
      client,
      route: assistantRoute(),
      surfaceProfile,
      voiceRoutes,
      captureStatus: 'idle',
      consentGranted: false,
      nativeMobileBackgroundWakeSupported: true,
    })

    expect(model.controls.find((control) => control.id === 'background-wake')).toMatchObject({
      enabled: true,
      state: 'available-local',
    })
    expect(model.routeSheetRoute.item.id).toBe('native-mobile-wake')
    expect(model.controls.find((control) => control.id === 'remote-consent')?.state).toBe('privacy-blocked')

    const container = renderAssistant(client, surfaceProfile, undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android',
      voiceRoutes,
    })

    expect(findButtonOrNull(container, 'Open route details')).toBeNull()
    expect(container.querySelector('#assistant-route-panel')).toBeNull()
    expect(nativeMobileVoice.start).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Choose a connected voice device before starting speech.')
  })

  it('leaves native mobile hands-free voice running when the assistant view unmounts', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('listening', true))
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    expect(findButtonOrNull(container, 'Open route details')).toBeNull()
    await vi.waitFor(() => expect(nativeMobileVoice.backgroundStatus).toHaveBeenCalled())

    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await Promise.resolve()
    })

    const root = roots.pop()
    expect(root).toBeDefined()
    await act(async () => {
      root?.unmount()
      await Promise.resolve()
    })

    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
    expect(nativeMobileVoice.cancel).not.toHaveBeenCalled()
  })

  it('does not create a native mobile hands-free start while the assistant route unmounts', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    expect(findButtonOrNull(container, 'Open route details')).toBeNull()
    expect(container.querySelector('#assistant-route-panel')).toBeNull()
    const root = roots.pop()
    expect(root).toBeDefined()
    await act(async () => {
      root?.unmount()
      await Promise.resolve()
    })

    expect(nativeMobileVoice.startBackground).not.toHaveBeenCalled()
    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
  })

  it('keeps native mobile push-to-talk available when hands-free prerequisites are missing', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('unavailable'))
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    expect(nativeMobileVoice.startBackground).not.toHaveBeenCalled()
  })

  it('submits the final native mobile transcript through the normal assistant path', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('Voice response ready.')
    })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.takeTranscript.mockResolvedValueOnce('hello from native speech')
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    await clickButton(container, 'Stop listening')

    await vi.waitFor(() => expect(nativeMobileVoice.finish).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(nativeMobileVoice.takeTranscript).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(container.textContent).toContain('hello from native speech'))
    expect(container.textContent).toContain('Voice response ready.')
  })

  it('reports an unsaved native mobile background wake turn instead of displaying an ephemeral transcript', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening', true))
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('listening', true))
    nativeMobileVoice.takeBackgroundResult.mockResolvedValueOnce({
      generation: 7,
      transcript: 'what is the meaning of life',
      assistantText: null,
      errorCode: 'assistant_unavailable',
      persisted: false,
      conversationId: null,
      persistenceErrorCode: 'native_voice_persistence_failed',
    })
    nativeMobileVoice.takeBackgroundResult.mockResolvedValue(null)
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await vi.waitFor(() => expect(nativeMobileVoice.takeBackgroundResult).toHaveBeenCalled())
    await vi.waitFor(() => expect(container.textContent).toContain('This voice request could not be saved. Try again.'))
    expect(container.textContent).not.toContain('what is the meaning of life')
    expect(streamMessage).not.toHaveBeenCalled()
  })

  it('does not display or redispatch an assistant response when its native background turn was not saved', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const streamMessage = vi.spyOn(client.assistant, 'streamMessage')
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening', true))
    nativeMobileVoice.backgroundStatus.mockResolvedValue(nativeMobileStatus('listening', true))
    nativeMobileVoice.takeBackgroundResult.mockResolvedValueOnce({
      generation: 8,
      transcript: 'turn on the lights',
      assistantText: 'The lights are on.',
      errorCode: null,
      persisted: false,
      conversationId: null,
      persistenceErrorCode: 'native_voice_persistence_failed',
    })
    nativeMobileVoice.takeBackgroundResult.mockResolvedValue(null)
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await vi.waitFor(() => expect(nativeMobileVoice.takeBackgroundResult).toHaveBeenCalled())
    await vi.waitFor(() => expect(container.textContent).toContain('This voice request could not be saved. Try again.'))
    expect(container.textContent).not.toContain('turn on the lights')
    expect(container.textContent).not.toContain('The lights are on.')
    expect(streamMessage).not.toHaveBeenCalled()
  })

  it('preserves a pending native mobile push-to-talk start across a visible WebView blur', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    const pendingStart = deferred<NativeMobileVoiceStatus>()
    nativeMobileVoice.start.mockImplementationOnce(() => pendingStart.promise)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      pendingStart.resolve(nativeMobileStatus('listening'))
      await pendingStart.promise
      await Promise.resolve()
    })

    expect(nativeMobileVoice.cancel).not.toHaveBeenCalled()
    expect(findButton(container, 'Stop listening')).toBeTruthy()
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(nativeMobileVoice.finish).toHaveBeenCalledTimes(1))
  })

  it('cancels native mobile push-to-talk immediately when native lifecycle requires release', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.backgroundStatus.mockImplementation(() => new Promise<NativeMobileVoiceStatus>(() => undefined))
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await Promise.resolve()
    })

    expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels native mobile push-to-talk when background status does not answer after hiding', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening'))
    nativeMobileVoice.backgroundStatus.mockImplementation(() => new Promise<NativeMobileVoiceStatus>(() => undefined))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1))
  })

  it('keeps native mobile focused push-to-talk foreground-only when hidden', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1))
    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
  })

  it('cancels native mobile processing when the app is hidden', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('processing'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1))
    expect(nativeMobileVoice.stopBackground).not.toHaveBeenCalled()
  })

  it('does not cancel native mobile voice on hide when Android reports no focused capture', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue({
      ...nativeMobileStatus('idle'),
      available: true,
      running: false,
      captureActive: false,
      backgroundActive: false,
    })
    nativeMobileVoice.backgroundStatus.mockImplementation(() => new Promise<NativeMobileVoiceStatus>(() => undefined))
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const container = renderAssistant(client, nativeMobileBackgroundSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android'
    })

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(nativeMobileVoice.status).toHaveBeenCalled())
    expect(nativeMobileVoice.cancel).not.toHaveBeenCalled()
    expect(nativeMobileVoice.backgroundStatus).toHaveBeenCalledTimes(1)
  })

  it('does not expose a native background voice action on pure web', () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    const model = buildAssistantVoiceModel({
      client,
      route: assistantRoute(),
      surfaceProfile: hostedSurface(),
      captureStatus: 'idle',
      consentGranted: false,
      nativeMobileBackgroundWakeSupported: true,
    })

    const background = model.controls.find((control) => control.id === 'background-wake')
    expect(background).toMatchObject({
      enabled: false,
      label: 'Hands-free',
    })
    expect(nativeMobileVoice.startBackground).not.toHaveBeenCalled()
  })

  it('blocks selector-required connected speech before native mobile start after consent', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const startVoiceListen = vi.spyOn(client.assistant, 'startVoiceListen')
    const transcribeVoiceAudio = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const nativeMobileVoice = createNativeMobileVoicePort()
    const container = renderAssistant(client, nativeMobileSurface(), undefined, {
      nativeMobileVoice,
      nativeAvailable: true,
      nativePlatform: 'android',
      voiceRoutes: selectorRequiredRemoteVoiceRoutes('studio', 'booth')
    })

    await clickButton(container, 'Allow connected voice')
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(container.textContent).toContain('Choose a connected voice device before starting speech.'))

    expect(nativeMobileVoice.start).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(transcribeVoiceAudio).not.toHaveBeenCalled()
    expect(voiceRuntimeMock.create).not.toHaveBeenCalled()
    expect(findButtonOrNull(container, 'Stop listening')).toBeNull()
  })

  it('invalidates connected voice access when the connected speech target changes', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createNativeDesktopVoicePort()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const surfaceProfile = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    })

    await act(async () => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          surfaceProfile={surfaceProfile}
          nativeVoice={nativeVoice}
          voiceRoutes={remoteVoiceRoutes('studio')}
        />
      )
      await Promise.resolve()
    })

    await clickButton(container, 'Allow connected voice')
    await vi.waitFor(() => expect(findButton(container, 'Stop connected voice access')).toBeTruthy())

    await act(async () => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          surfaceProfile={surfaceProfile}
          nativeVoice={nativeVoice}
          voiceRoutes={remoteVoiceRoutes('lab')}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(findButton(container, 'Allow connected voice')).toBeTruthy()
    await clickButton(container, 'Push to talk')
    expect(nativeVoice.start).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Review connected voice access before starting speech.')
  })

  it('keeps connected voice access copy product-facing', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface(), undefined, { voiceRoutes: remoteVoiceRoutes('studio') })

    await clickButton(container, 'Allow connected voice')
    await vi.waitFor(() => expect(findButton(container, 'Stop connected voice access')).toBeTruthy())

    const visible = (container.textContent ?? '').replace(/\s+/g, ' ')
    const attributes = Array.from(container.querySelectorAll('[aria-label], [title]'))
      .flatMap((node) => [node.getAttribute('aria-label'), node.getAttribute('title')])
      .filter((value): value is string => Boolean(value))
      .join(' ')
    expect(findForbiddenProductionCopyTerms(`${visible} ${attributes}`)).toEqual([])
  })

  it('preserves remote voice route selectors for hosted STT dispatch and read-aloud', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([11, 12, 13]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:remote-read-aloud') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const transcriptionPayloads: unknown[] = []
    const synthesisPayloads: unknown[] = []
    const transport = MockAuroraTransport.empty()
      .register('Transcription.Transcribe', (request) => {
        transcriptionPayloads.push(request.payload)
        return {
          text: 'hello aurora',
          confidence: null,
          language: null,
          duration_ms: 1_000,
          model_used: 'test',
        }
      })
      .register('TTS.Synthesize', (request) => {
        synthesisPayloads.push(request.payload)
        return {
          audio_data: 'UklGRg==',
          format: 'wav',
          sample_rate: 22_050,
          channels: 1,
          duration_ms: 120,
          text: 'Remote response ready.',
        }
      })
    const client = new AuroraClient({ transport })
    const transcribeVoiceAudio = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const synthesizeReadAloud = vi.spyOn(client.assistant, 'synthesizeReadAloud')
    vi.spyOn(client.assistant, 'streamMessage').mockImplementation(async function* () {
      yield completedUpdate('Remote response ready.')
    })
    const container = renderAssistant(client, hostedSurface(), undefined, { voiceRoutes: remoteVoiceRoutes('studio') })

    await clickButton(container, 'Allow connected voice')
    await clickButton(container, 'Push to talk')
    await clickButton(container, 'Stop listening')
    await vi.waitFor(() => expect(container.textContent).toContain('Remote response ready.'))
    const readAloud = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Read aloud')
    if (!readAloud) throw new Error('missing read-aloud action')
    await act(async () => {
      readAloud.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1))

    expect(transcriptionPayloads).toHaveLength(1)
    expectRemoteVoicePolicy(transcribeVoiceAudio.mock.calls[0]?.[0].routePolicy ?? undefined, 'Transcription')
    expectRemoteVoiceSelector((transcriptionPayloads[0] as { selector?: unknown }).selector, 'Transcription')
    expectRemoteVoiceSelector((transcriptionPayloads[0] as { mesh_selector?: unknown }).mesh_selector, 'Transcription')
    expect(synthesisPayloads).toHaveLength(1)
    expectRemoteVoicePolicy(synthesizeReadAloud.mock.calls[0]?.[0].routePolicy ?? undefined, 'TTS')
    expectRemoteVoiceSelector((synthesisPayloads[0] as { selector?: unknown }).selector, 'TTS')
    expectRemoteVoiceSelector((synthesisPayloads[0] as { mesh_selector?: unknown }).mesh_selector, 'TTS')
    expect(JSON.stringify({
      stt: transcriptionPayloads,
      tts: synthesisPayloads,
    })).not.toContain('Tooling.ExecuteTool')
  })

  it('fails closed when a connected voice route requires explicit device selection', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([11, 12, 13]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
    const routes = selectorRequiredRemoteVoiceRoutes('studio', 'booth')
    expect(routePolicyFromRoute(routes.transcription)).toEqual(expect.objectContaining({
      providerId: null,
      peerId: null,
      serviceInstanceId: null,
      selectorRequired: true,
    }))
    expect(routePolicyFromRoute(routes.ttsSynthesize)).toEqual(expect.objectContaining({
      providerId: null,
      peerId: null,
      serviceInstanceId: null,
      selectorRequired: true,
    }))
    expect(routePolicyFromRoute(routes.transcription, routes.transcription.candidateProviders[0])).toEqual(expect.objectContaining({
      providerId: 'remote:studio:Transcription',
      peerId: 'studio',
      serviceInstanceId: 'remote:studio:Transcription',
      selectorRequired: true,
    }))
    const transcriptionPayloads: unknown[] = []
    const transport = MockAuroraTransport.empty().register('Transcription.Transcribe', (request) => {
      transcriptionPayloads.push(request.payload)
      return {
        text: 'should not dispatch',
        confidence: null,
        language: null,
        duration_ms: 1_000,
        model_used: 'test',
      }
    })
    const client = new AuroraClient({ transport })
    const transcribeVoiceAudio = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const container = renderAssistant(client, hostedSurface(), undefined, { voiceRoutes: routes })

    await clickButton(container, 'Allow connected voice')
    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(container.textContent).toContain('Choose a connected voice device before starting speech.'))

    expect(runtime.start).not.toHaveBeenCalled()
    expect(transcribeVoiceAudio).not.toHaveBeenCalled()
    expect(transcriptionPayloads).toEqual([])
    expect(findButtonOrNull(container, 'Stop listening')).toBeNull()
  })

  it('blocks selector-required read-aloud without dispatching or sticking in speaking state', async () => {
    const routes = selectorRequiredRemoteVoiceRoutes('studio', 'booth')
    const synthesisPayloads: unknown[] = []
    const transport = MockAuroraTransport.empty().register('TTS.Synthesize', (request) => {
      synthesisPayloads.push(request.payload)
      return {
        audio_data: 'UklGRg==',
        format: 'wav',
        sample_rate: 22_050,
        channels: 1,
        duration_ms: 120,
        text: 'Selector required.',
      }
    })
    const client = new AuroraClient({ transport })
    const synthesizeReadAloud = vi.spyOn(client.assistant, 'synthesizeReadAloud')
    const container = renderAssistant(client, hostedSurface(), undefined, {
      voiceRoutes: routes,
      initialSession: {
        sessionId: 'selector-required-read-aloud',
        messages: [{
          id: 'assistant-selector-required',
          role: 'assistant',
          text: 'Connected speech needs an explicit device choice.',
          createdAt: '2026-08-11T00:00:00Z',
          status: 'sent',
        }]
      }
    })
    const readAloud = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Read aloud')
    if (!readAloud) throw new Error('missing read-aloud action')

    await act(async () => {
      readAloud.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Choose a connected voice device before starting speech.'))

    expect(synthesizeReadAloud).not.toHaveBeenCalled()
    expect(synthesisPayloads).toEqual([])
    expect(readAloud.getAttribute('data-speaking')).toBeNull()
    expect(readAloud.textContent?.trim()).toBe('Read aloud')
  })

  it('uses selected cached browser TTS for read-aloud before remote synthesis', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array([1, -1, 2, -2]) })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    const objectUrls: string[] = []
    const play = vi.fn(async () => undefined)
    class MockAudio {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly url: string) {}
      play = play
      pause = vi.fn()
      load = vi.fn()
      removeAttribute = vi.fn()
    }
    vi.stubGlobal('Audio', MockAudio)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:voice-${objectUrls.length + 1}`
      objectUrls.push(url)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const synthesizeReadAloud = vi.spyOn(client.assistant, 'synthesizeReadAloud')
    const modelBindings: AuroraVoiceWebModelBindings = {
      files: [{
        task: 'tts' as const,
        fileId: 'tts-model',
        virtualPath: '/tts/model.onnx',
        sha256: 'a'.repeat(64),
        byteLength: 4,
        bytes: new Uint8Array([1, 2, 3, 4]),
      }],
      models: [{
        task: 'tts' as const,
        family: 'piper',
        kind: 'offline-tts',
        files: [{ role: 'model', fileId: 'tts-model', virtualPath: '/tts/model.onnx' }],
        config: { voiceId: 'ava.en' },
      }],
    }
    const container = renderAssistant(client, hostedSurface(), undefined, {
      browserSpeechPacks: {
        state: 'ready',
        packs: [],
        modelBindings,
        capabilities: { vad: false, kws: false, stt: false, tts: true },
        ttsVoiceId: 'ava.en',
        revision: 'tts:piper.en:1',
      },
      initialSession: {
        sessionId: 'browser-tts-read-aloud',
        messages: [{
          id: 'assistant-browser-tts',
          role: 'assistant',
          text: 'Read locally.',
          createdAt: '2026-08-11T00:00:00Z',
          status: 'sent',
        }]
      }
    })
    const readAloud = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Read aloud')
    if (!readAloud) throw new Error('missing read-aloud action')

    await act(async () => {
      readAloud.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1))

    expect(synthesizeReadAloud).not.toHaveBeenCalled()
    expect(runtime.synthesizeSpeech).toHaveBeenCalledWith({
      text: 'Read locally.',
      voiceId: 'ava.en',
      generation: expect.any(Number),
    })
    expect(voiceRuntimeMock.create).toHaveBeenCalledWith(expect.objectContaining({
      modelBindings,
      sherpaAssets: expect.objectContaining({
        ttsModuleUrl: expect.any(URL),
      }),
    }))
    expect(String((voiceRuntimeMock.create.mock.calls[0]?.[0] as { sherpaAssets?: { ttsModuleUrl?: URL } }).sherpaAssets?.ttsModuleUrl)).toBe('http://localhost:3000/voice/sherpa/sherpa-onnx-wasm-main-tts.js')
  })

  it('shows microphone recovery guidance next to the composer controls', async () => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array() })
    runtime.start.mockRejectedValueOnce(new Error('/private/device/path'))
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => {
      expect(container.querySelector('[data-voice-recovery="true"]')?.textContent)
        .toBe('Microphone capture failed. Try again.')
    })
    expect(container.textContent).not.toContain('/private/device/path')
  })

  it.each([
    ['audio_source_permission_denied', 'Microphone permission was denied.', 'permission-denied'],
    ['audio_source_no_input_device', 'No microphone was found on this device.', 'no-device'],
    ['audio_source_unavailable', 'Microphone capture failed. Try again.', 'error'],
    ['audio_source_start_failed', 'Microphone capture failed. Try again.', 'error']
  ] as const)('maps hosted voice startup code %s to sanitized recovery state', async (code, copy, expectedStatus) => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array() })
    runtime.start.mockRejectedValueOnce(Object.assign(new Error('/private/device/path'), { code }))
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => {
      expect(container.querySelector('[data-voice-recovery="true"]')?.textContent).toBe(copy)
    })

    expect(container.textContent).not.toContain('/private/device/path')
    expect(buildAssistantVoiceModel({
      client,
      route: assistantRoute(),
      surfaceProfile: hostedSurface(),
      captureStatus: expectedStatus,
      consentGranted: false,
    }).captureStatus).toBe(expectedStatus)
  })

  it('maps name-shaped hosted voice startup errors when DOMException is unavailable', async () => {
    vi.stubGlobal('DOMException', undefined)
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array() })
    runtime.start.mockRejectedValueOnce({ name: 'NotAllowedError', message: '/private/device/path' })
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => {
      expect(container.querySelector('[data-voice-recovery="true"]')?.textContent)
        .toBe('Microphone permission was denied.')
    })

    expect(container.textContent).not.toContain('/private/device/path')
    expect(container.querySelector('[data-voice-recovery="true"]')).toBeTruthy()
  })

  it.each(['start_cancelled', 'audio_source_start_cancelled'] as const)('keeps hosted voice startup cancellation silent for code %s', async (code) => {
    const runtime = createRuntimeMock({ capturedPcm: new Int16Array() })
    runtime.start.mockRejectedValueOnce(Object.assign(new Error('/private/device/path'), { code }))
    voiceRuntimeMock.create.mockReturnValue(runtime)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = renderAssistant(client, hostedSurface())

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => {
      expect(container.querySelector('[data-voice-recovery="true"]')).toBeNull()
      expect(findButton(container, 'Push to talk')).toBeTruthy()
    })

    expect(container.textContent).not.toContain('/private/device/path')
    expect(container.textContent).not.toContain('Microphone capture failed')
    expect(container.textContent).not.toContain('No microphone was found')
  })

  it('routes desktop-thin focused voice only through the native desktop port', async () => {
    const getUserMedia = vi.fn()
    const mediaRecorder = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', mediaRecorder)
    vi.stubGlobal('AudioContext', FakeAudioContext)

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const startVoiceListen = vi.spyOn(client.assistant, 'startVoiceListen')
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const cancel = vi.spyOn(client.assistant, 'cancel')
    const nativeVoice = createNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    }), nativeVoice)

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1))

    expect(voiceRuntimeMock.create).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('fails desktop focused voice visibly when the native desktop port is missing', async () => {
    const getUserMedia = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const startVoiceListen = vi.spyOn(client.assistant, 'startVoiceListen')
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const cancel = vi.spyOn(client.assistant, 'cancel')
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }))

    await clickButton(container, 'Push to talk')

    expect(container.textContent).toContain('Voice is unavailable in this desktop app.')
    expect(voiceRuntimeMock.create).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels the returned native generation when release happens during pending desktop start', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createDeferredNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }), nativeVoice)

    await clickButton(container, 'Push to talk')
    expect(nativeVoice.cancel).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await Promise.resolve()
    })
    expect(nativeVoice.cancel).not.toHaveBeenCalled()

    nativeVoice.resolveStart(nativeStatus('listening', 42, true))
    await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(1))

    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 42, reason: 'window_hidden' })
    expect(findButton(container, 'Push to talk')).toBeTruthy()
    expect(findButtonOrNull(container, 'Stop listening')).toBeNull()
  })

  it('cancels the returned native generation when the window hides during pending desktop start', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createDeferredNativeDesktopVoicePort()
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux'
    }), nativeVoice)

    await clickButton(container, 'Push to talk')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })
    nativeVoice.resolveStart(nativeStatus('listening', 84, true))
    await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(1))

    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 84, reason: 'window_hidden' })
    expect(findButton(container, 'Push to talk')).toBeTruthy()
    expect(findButtonOrNull(container, 'Stop listening')).toBeNull()
  })

  it('cancels the returned native generation when unmounted during pending desktop start', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createDeferredNativeDesktopVoicePort()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          surfaceProfile={getAuroraSurfaceProfile({
            runtimeMode: 'desktop-local',
            transportKind: 'tauri-local',
            nativePlatform: 'linux'
          })}
          nativeVoice={nativeVoice}
        />
      )
      await Promise.resolve()
    })

    await clickButton(container, 'Push to talk')
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    roots.splice(roots.indexOf(root), 1)
    nativeVoice.resolveStart(nativeStatus('listening', 126, true))
    await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(1))

    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 126, reason: 'shutdown' })
  })

  it('retries detached shutdown cleanup when pending-start cancel rejects after unmount', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createDeferredNativeDesktopVoicePort()
    nativeVoice.cancel.mockRejectedValueOnce(new Error('native shutdown stop failed'))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <AssistantView
          client={client}
          route={assistantRoute()}
          surfaceProfile={getAuroraSurfaceProfile({
            runtimeMode: 'desktop-local',
            transportKind: 'tauri-local',
            nativePlatform: 'linux'
          })}
          nativeVoice={nativeVoice}
        />
      )
      await Promise.resolve()
    })

    await clickButton(container, 'Push to talk')
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    roots.splice(roots.indexOf(root), 1)
    nativeVoice.resolveStart(nativeStatus('listening', 2048, true))
    await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(2))

    expect(nativeVoice.cancel).toHaveBeenNthCalledWith(1, { generation: 2048, reason: 'shutdown' })
    expect(nativeVoice.cancel).toHaveBeenNthCalledWith(2, { generation: 2048, reason: 'shutdown' })
    expect(nativeVoice.start).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Voice could not stop cleanly. Try again.')
  })

  it('keeps a returned native generation retryable when pending-start cancel fails', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeVoice = createDeferredNativeDesktopVoicePort()
    nativeVoice.cancel.mockRejectedValueOnce(new Error('native stop failed'))
    const container = renderAssistant(client, getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nativePlatform: 'linux'
    }), nativeVoice)

    await clickButton(container, 'Push to talk')
    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await Promise.resolve()
    })
    nativeVoice.resolveStart(nativeStatus('listening', 512, true))
    await vi.waitFor(() => expect(container.textContent).toContain('Voice could not stop cleanly. Try again.'))

    expect(nativeVoice.cancel).toHaveBeenCalledTimes(1)
    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 512, reason: 'window_hidden' })
    expect(findButtonOrNull(container, 'Stop listening')).toBeNull()

    await clickButton(container, 'Push to talk')
    await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(2))

    expect(nativeVoice.cancel).toHaveBeenLastCalledWith({ generation: 512, reason: 'user_request' })
    expect(nativeVoice.start).toHaveBeenCalledTimes(1)
    expect(findButton(container, 'Push to talk')).toBeTruthy()
  })

  it('does not apply delayed native status or leak delayed subscribe cleanup after unmount', async () => {
    const statusDelayed = createDeferredStatusNativeDesktopVoicePort()
    const firstContainer = document.createElement('div')
    document.body.appendChild(firstContainer)
    const firstRoot = createRoot(firstContainer)
    roots.push(firstRoot)
    await act(async () => {
      firstRoot.render(
        <AssistantView
          client={new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })}
          route={assistantRoute()}
          surfaceProfile={getAuroraSurfaceProfile({
            runtimeMode: 'desktop-local',
            transportKind: 'tauri-local',
            nativePlatform: 'linux'
          })}
          nativeVoice={statusDelayed}
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      firstRoot.unmount()
      await Promise.resolve()
    })
    roots.splice(roots.indexOf(firstRoot), 1)
    statusDelayed.resolveStatus(nativeStatus('listening', 64, true))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(statusDelayed.subscribe).not.toHaveBeenCalled()
    expect(firstContainer.textContent).not.toContain('Aurora is listening.')

    const subscribeDelayed = createDeferredSubscribeNativeDesktopVoicePort()
    const secondContainer = document.createElement('div')
    document.body.appendChild(secondContainer)
    const secondRoot = createRoot(secondContainer)
    roots.push(secondRoot)
    await act(async () => {
      secondRoot.render(
        <AssistantView
          client={new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })}
          route={assistantRoute()}
          surfaceProfile={getAuroraSurfaceProfile({
            runtimeMode: 'desktop-thin',
            transportKind: 'tauri-thin',
            nativePlatform: 'linux'
          })}
          nativeVoice={subscribeDelayed}
        />
      )
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(subscribeDelayed.subscribe).toHaveBeenCalledTimes(1))
    await act(async () => {
      secondRoot.unmount()
      await Promise.resolve()
    })
    roots.splice(roots.indexOf(secondRoot), 1)
    subscribeDelayed.resolveSubscribe()
    await vi.waitFor(() => expect(subscribeDelayed.unsubscribe).toHaveBeenCalledTimes(1))
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
  const listeners = new Set<(event: BrowserVoiceRuntimeEvent) => void>()
  const unsubscribeEvent = vi.fn()
  const emitEvent = (overrides: Partial<BrowserVoiceRuntimeEvent> = {}) => {
    const event: BrowserVoiceRuntimeEvent = {
      kind: 'session_started',
      ownerId: session.ownerId,
      sessionId: session.sessionId,
      generation: session.generation,
      sequence: null,
      sampleCount: 0,
      byteLength: 0,
      queuedBytes: 0,
      reason: null,
      redacted: true,
      occurredAtMs: 1_700_000_000_000,
      ...overrides,
    }
    for (const listener of listeners) listener(event)
  }
  return {
    start: vi.fn(async () => {
      emitEvent({ kind: 'session_started' })
      return session
    }),
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
    synthesizeSpeech: vi.fn(async (request: { generation: number }) => ({
      generation: request.generation,
      sampleRateHz: 16_000,
      channels: 1 as const,
      sampleCount: 4,
      durationMs: 1,
      pcm: new Int16Array([1, -1, 2, -2]),
      redacted: true as const,
    })),
    cancel: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: BrowserVoiceRuntimeEvent) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        unsubscribeEvent()
      }
    }),
    unsubscribeEvent,
    emitEvent,
  }
}

interface BrowserVoiceRuntimeEvent {
  kind: string
  ownerId: string
  sessionId: string | null
  generation: number
  sequence: number | null
  sampleCount: number
  byteLength: number
  queuedBytes: number
  reason: string | null
  inference?: AuroraVoiceInferenceOutput
  redacted: true
  occurredAtMs: number
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

function renderAssistant(
  client: AuroraClient,
  surfaceProfile: ReturnType<typeof getAuroraSurfaceProfile>,
  nativeVoice?: NativeDesktopVoicePort,
  props: Partial<Parameters<typeof AssistantView>[0]> = {}
): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<AssistantView client={client} route={assistantRoute()} surfaceProfile={surfaceProfile} nativeVoice={nativeVoice} {...props} />)
  })
  return container
}

function remoteVoiceRoutes(peerId: string): AssistantVoiceRoutes {
  const remote = remoteAudioRoute(peerId)
  return {
    transcription: remote,
    wakeProcess: remote,
    wakeControl: remote,
    ttsSynthesize: remoteAudioRoute(peerId, 'voice-tts-synthesize', 'Spoken replies', 'personal'),
    ttsStop: remoteAudioRoute(peerId, 'voice-tts-stop', 'Stop spoken replies', 'personal')
  }
}

function expectRemoteVoicePolicy(
  routePolicy: AssistantRoutePolicy | undefined,
  service: 'Transcription' | 'TTS'
) {
  expect(routePolicy).toEqual({
    providerId: `remote:studio:${service}`,
    peerId: 'studio',
    serviceInstanceId: `remote:studio:${service}`,
    routeState: 'available-remote',
    fallbackBehavior: null,
    privacyClass: service === 'Transcription' ? 'raw-audio' : 'personal',
    selectorRequired: false,
    approvalRequired: false,
  })
}

function expectRemoteVoiceSelector(selector: unknown, service: 'Transcription' | 'TTS') {
  expect(selector).toEqual({
    provider_id: `remote:studio:${service}`,
    service_instance_id: `remote:studio:${service}`,
    peer_id: 'studio',
  })
}

function localVoiceRoutesWithRemoteAlternative(peerId: string): AssistantVoiceRoutes {
  const routes = remoteVoiceRoutes(peerId)
  const remoteCandidate = routes.transcription.candidateProviders[0]!
  return {
    ...routes,
    transcription: {
      ...routes.transcription,
      state: 'available-local',
      providerLabel: 'This device',
      candidateProviders: [
        {
          ...remoteCandidate,
          id: 'local:Transcription',
          providerId: 'local:Transcription',
          providerKind: 'local',
          peerId: null,
          nodeName: 'This device',
          serviceInstanceId: 'transcription-local',
          label: 'This device',
          state: 'available-local',
          reason: 'available'
        },
        remoteCandidate
      ],
      selectorRequired: false,
      disabled: false
    }
  }
}

function selectorRequiredRemoteVoiceRoutes(primaryPeerId: string, alternatePeerId: string): AssistantVoiceRoutes {
  const routes = remoteVoiceRoutes(primaryPeerId)
  return {
    ...routes,
    transcription: selectorRequiredRemoteRoute(routes.transcription, alternatePeerId),
    ttsSynthesize: selectorRequiredRemoteRoute(routes.ttsSynthesize, alternatePeerId)
  }
}

function selectorRequiredRemoteRoute(route: RouteAvailability, alternatePeerId: string): RouteAvailability {
  const primary = route.candidateProviders[0]!
  const service = route.item.capabilityModule
  return {
    ...route,
    selectorRequired: true,
    candidateProviders: [
      primary,
      {
        ...primary,
        id: `remote:${alternatePeerId}:${service}`,
        providerId: `remote:${alternatePeerId}:${service}`,
        peerId: alternatePeerId,
        nodeName: alternatePeerId,
        serviceInstanceId: `remote:${alternatePeerId}:${service}`,
        label: `Connected device ${alternatePeerId}`,
        selectable: true
      }
    ]
  }
}

function remoteAudioRoute(
  peerId: string,
  id = 'voice-transcription',
  label = 'Remote transcription',
  privacyClass: RouteAvailability['item']['privacyClass'] = 'raw-audio'
): RouteAvailability {
  const base = assistantRoute()
  const service = id.includes('tts') ? 'TTS' : 'Transcription'
  return {
    ...base,
    item: {
      ...base.item,
      id,
      label,
      capabilityModule: service,
      capabilityMethod: service === 'TTS' ? 'Synthesize' : 'Transcribe',
      privacyClass
    },
    state: 'available-remote',
    explanation: 'Connected Aurora device can help with speech.',
    providerLabel: `Connected device ${peerId}`,
    candidateProviders: [
      {
        id: `remote:${peerId}:${service}`,
        providerId: `remote:${peerId}:${service}`,
        providerKind: 'remote',
        peerId,
        nodeName: peerId,
        serviceInstanceId: `remote:${peerId}:${service}`,
        label: `Connected device ${peerId}`,
        state: 'available-remote',
        selectable: true,
        reason: 'available',
        requiredAction: null
      }
    ],
    evidenceSources: [service === 'TTS' ? 'TTS.Synthesize' : 'Transcription.Transcribe'],
    selectorRequired: false,
    disabled: false
  }
}

function createNativeDesktopVoicePort(): NativeDesktopVoicePort & {
  start: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  let listener: ((event: { sequence: number; status: NativeDesktopVoiceStatus }) => void) | null = null
  let sequence = 0
  const idle = nativeStatus('idle', null, true)
  const port = {
    status: vi.fn(async () => idle),
    start: vi.fn(async () => {
      const status = nativeStatus('listening', 1, true)
      listener?.({ sequence: ++sequence, status })
      return status
    }),
    finish: vi.fn(async () => {
      const status = nativeStatus('processing', 1, true)
      listener?.({ sequence: ++sequence, status })
      return status
    }),
    cancel: vi.fn(async () => {
      const status = nativeStatus('idle', null, true)
      listener?.({ sequence: ++sequence, status })
      return status
    }),
    subscribe: vi.fn(async (next: (event: { sequence: number; status: NativeDesktopVoiceStatus }) => void) => {
      listener = next
      return () => {
        listener = null
      }
    })
  }
  return port
}

function createDeferredNativeDesktopVoicePort(): NativeDesktopVoicePort & {
  start: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  resolveStart: (status: NativeDesktopVoiceStatus) => void
} {
  const start = deferred<NativeDesktopVoiceStatus>()
  const port = {
    status: vi.fn(async () => nativeStatus('idle', null, true)),
    start: vi.fn(() => start.promise),
    finish: vi.fn(async () => nativeStatus('processing', 1, true)),
    cancel: vi.fn(async () => nativeStatus('idle', null, true)),
    subscribe: vi.fn(async () => () => undefined),
    resolveStart: start.resolve
  }
  return port
}

function createDeferredStatusNativeDesktopVoicePort(): NativeDesktopVoicePort & {
  subscribe: ReturnType<typeof vi.fn>
  resolveStatus: (status: NativeDesktopVoiceStatus) => void
} {
  const status = deferred<NativeDesktopVoiceStatus>()
  const port = {
    status: vi.fn(() => status.promise),
    start: vi.fn(async () => nativeStatus('listening', 1, true)),
    finish: vi.fn(async () => nativeStatus('processing', 1, true)),
    cancel: vi.fn(async () => nativeStatus('idle', null, true)),
    subscribe: vi.fn(async () => () => undefined),
    resolveStatus: status.resolve
  }
  return port
}

function createDeferredSubscribeNativeDesktopVoicePort(): NativeDesktopVoicePort & {
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  resolveSubscribe: () => void
} {
  const subscription = deferred<() => void>()
  const unsubscribe = vi.fn()
  const port = {
    status: vi.fn(async () => nativeStatus('idle', null, true)),
    start: vi.fn(async () => nativeStatus('listening', 1, true)),
    finish: vi.fn(async () => nativeStatus('processing', 1, true)),
    cancel: vi.fn(async () => nativeStatus('idle', null, true)),
    subscribe: vi.fn(() => subscription.promise),
    unsubscribe,
    resolveSubscribe: () => subscription.resolve(unsubscribe)
  }
  return port
}

function createNativeMobileVoicePort(): NativeMobileVoicePort & {
  status: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  takeTranscript: ReturnType<typeof vi.fn>
  takeBackgroundResult: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  backgroundStatus: ReturnType<typeof vi.fn>
  startBackground: ReturnType<typeof vi.fn>
  stopBackground: ReturnType<typeof vi.fn>
} {
  return {
    status: vi.fn(async () => nativeMobileStatus('idle')),
    start: vi.fn(async () => nativeMobileStatus('listening')),
    finish: vi.fn(async () => nativeMobileStatus('processing')),
    takeTranscript: vi.fn(async () => 'native speech request'),
    takeBackgroundResult: vi.fn(async () => null),
    cancel: vi.fn(async () => nativeMobileStatus('idle')),
    backgroundStatus: vi.fn(async () => nativeMobileStatus('idle')),
    startBackground: vi.fn(async () => nativeMobileStatus('listening', true)),
    stopBackground: vi.fn(async () => nativeMobileStatus('idle'))
  }
}

function nativeMobileStatus(
  phase: NativeMobileVoiceStatus['phase'],
  backgroundActive = false
): NativeMobileVoiceStatus {
  return {
    available: phase !== 'unavailable',
    phase,
    running: phase === 'listening' || phase === 'processing',
    captureActive: phase === 'listening',
    backgroundActive,
    reasonCode: null,
    redacted: true
  }
}

function nativeStatus(
  phase: NativeDesktopVoiceStatus['phase'],
  generation: number | null,
  available: boolean
): NativeDesktopVoiceStatus {
  return {
    available,
    phase,
    generation,
    backgroundEligible: true,
    connection: available ? 'this_device' : 'unavailable',
    reasonCode: null,
    redacted: true
  }
}

async function clickButton(container: HTMLElement, label: string) {
  await act(async () => {
    findButton(container, label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function clickButtonByText(container: HTMLElement, label: string) {
  await act(async () => {
    findButtonByText(container, label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
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

function nativeMobileSurface() {
  return getAuroraSurfaceProfile({
    runtimeMode: 'mobile',
    transportKind: 'native-mobile',
    nativePlatform: 'android',
    nativeVoiceAvailable: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
  })
}

function nativeMobileBackgroundSurface() {
  return getAuroraSurfaceProfile({
    runtimeMode: 'mobile',
    transportKind: 'native-mobile',
    nativePlatform: 'android',
    nativeVoiceAvailable: true,
    nativeWakewordAvailable: true,
    localSpeechPackState: 'ready',
    localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Mobile Safari/537.36'
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

function findButtonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`button ${label} not found`)
  return button
}

function findButtonOrNull(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find((candidate) => candidate.getAttribute('aria-label') === label) ?? null
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
