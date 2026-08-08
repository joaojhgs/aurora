// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport, ORCHESTRATOR_METHODS } from '@aurora/client'
import { AssistantView } from '../src/assistant-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import { AURORA_RELEASE_FOCUSED_MEDIA_EVENT, getAuroraSurfaceProfile } from '../src/platform-surface'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { NativeDesktopVoicePort, NativeDesktopVoiceStatus } from '../src/native-desktop-voice'
import type { NativeMobileVoicePort, NativeMobileVoiceStatus } from '../src/native-mobile-voice'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Assistant focused WebView microphone policy', () => {
  it('does not open coordinator-wide voice subscriptions on Android focused capture', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const voiceEvents = vi.spyOn(client.assistant, 'streamVoiceEvents').mockImplementation(async function* () {})
    const voiceResponses = vi.spyOn(client.assistant, 'streamVoiceAssistantResponses').mockImplementation(async function* () {})
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
            runtimeMode: 'android-node',
            transportKind: 'mesh',
            nativePlatform: 'android'
          })}
        />
      )
      await Promise.resolve()
    })

    expect(voiceEvents).not.toHaveBeenCalled()
    expect(voiceResponses).not.toHaveBeenCalled()
  })

  it('does not fall back to WebView microphone capture on iOS before native voice is ready', async () => {
    const getUserMedia = vi.fn()
    const mediaRecorder = vi.fn()
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia }
    })
    vi.stubGlobal('MediaRecorder', mediaRecorder)

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
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
            runtimeMode: 'ios-thin',
            transportKind: 'native-mobile',
            nativePlatform: 'ios'
          })}
        />
      )
      await Promise.resolve()
    })

    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(renderedElementCopy(container)).toContain('Voice is unavailable on this device right now.')
  })

  it('keeps desktop native voice off coordinator-wide subscriptions', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const voiceEvents = vi.spyOn(client.assistant, 'streamVoiceEvents').mockImplementation(async function* () {})
    const voiceResponses = vi.spyOn(client.assistant, 'streamVoiceAssistantResponses').mockImplementation(async function* () {})
    const nativeVoice = createNativeDesktopVoicePort()
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

    expect(nativeVoice.status).toHaveBeenCalledTimes(1)
    expect(nativeVoice.subscribe).toHaveBeenCalledTimes(1)
    expect(voiceEvents).not.toHaveBeenCalled()
    expect(voiceResponses).not.toHaveBeenCalled()
  })

  it('cancels desktop native focused voice on release without WebView or coordinator fallback', async () => {
    const getUserMedia = vi.fn()
    const mediaRecorder = vi.fn()
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia }
    })
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
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await vi.waitFor(() => expect(nativeVoice.start).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(findButton(container, 'Stop listening')).toBeTruthy())
    })
    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await vi.waitFor(() => expect(nativeVoice.cancel).toHaveBeenCalledTimes(1))
    })

    expect(nativeVoice.cancel).toHaveBeenCalledWith({ generation: 1, reason: 'window_hidden' })
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(stopVoiceListen).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(renderedElementCopy(container)).not.toContain('No microphone audio was captured')
  })

  it('cancels active Android native voice when the assistant view unmounts', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
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
            runtimeMode: 'mobile-native',
            transportKind: 'native-mobile',
            nativePlatform: 'android',
            nativeVoicePresent: true,
            nativeVoiceAvailable: true,
          })}
          nativeMobileVoice={nativeMobileVoice}
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
      await Promise.resolve()
    })

    await act(async () => {
      root.unmount()
      await vi.waitFor(() => expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1))
    })

    expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending Android native start that resolves after unmount', async () => {
    let resolveStart: ((status: NativeMobileVoiceStatus) => void) | undefined
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.start.mockImplementationOnce(() => new Promise<NativeMobileVoiceStatus>((resolve) => {
      resolveStart = resolve
    }))
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
            runtimeMode: 'mobile-native',
            transportKind: 'native-mobile',
            nativePlatform: 'android',
            nativeVoicePresent: true,
            nativeVoiceAvailable: true,
          })}
          nativeMobileVoice={nativeMobileVoice}
        />
      )
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await vi.waitFor(() => expect(nativeMobileVoice.start).toHaveBeenCalledTimes(1))
    })

    await act(async () => {
      root.unmount()
      await vi.waitFor(() => expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1))
      resolveStart?.(nativeMobileStatus('listening', true))
      await Promise.resolve()
    })

    expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(2)
  })

  it('stops focused push-to-talk media tracks when the thin shell is hidden', async () => {
    const stopped = vi.fn()
    const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })

    const mic = findButton(container, 'Push to talk')
    await act(async () => {
      mic.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stopped).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
    })

    expect(stopped).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Microphone listening stopped because Aurora was no longer the active window.')
  })

  it('stops focused media on a native lifecycle release without requiring the WebRTC peer to disconnect', async () => {
    const stopped = vi.fn()
    const stream = { getTracks: () => [{ stop: stopped }] } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })

    const mic = findButton(container, 'Push to talk')
    await act(async () => {
      mic.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(stopped).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event(AURORA_RELEASE_FOCUSED_MEDIA_EVENT))
      await Promise.resolve()
    })

    expect(stopped).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Microphone listening stopped because Aurora was no longer the active window.')
  })

  it('maps hostile microphone errors to product copy', async () => {
    const hostile = 'NotReadableError: WebRTC transport runtime fallback failed'
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException(hostile, 'NotReadableError') }) }
    })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })

    const mic = findButton(container, 'Push to talk')
    await act(async () => {
      mic.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const rendered = renderedElementCopy(container)
    expect(rendered).toContain('Microphone capture failed. Try again.')
    expect(rendered).not.toContain(hostile)
    expect(rendered).not.toMatch(/\b(WebRTC|transport|fallback|runtime)\b/i)
    expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id), rendered).toEqual([])
  })

  it('reports when push-to-talk stops before Web Audio produces microphone samples', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })

    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Stop listening').click()
      await Promise.resolve()
    })

    expect(renderedElementCopy(container)).toContain(
      'No microphone audio was captured. Check microphone permission and try push-to-talk again.'
    )
  })

  it('resumes Web Audio from the tap before waiting for Android microphone access', async () => {
    const events: string[] = []
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    class SuspendedAudioContext extends FakeAudioContext {
      state = 'suspended'
      resume = vi.fn(async () => {
        events.push('resume')
        this.state = 'running'
        return undefined
      })
    }
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          events.push('getUserMedia')
          return stream
        })
      }
    })
    vi.stubGlobal('AudioContext', SuspendedAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(events.slice(0, 2)).toEqual(['resume', 'getUserMedia'])
  })

  it('transcribes MediaRecorder chunks when Web Audio produces no processor samples', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('AudioContext', DecodingAudioContext)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription(''))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Stop listening').click()
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    })

    const request = transcribe.mock.calls[0]?.[0]
    expect(request).toEqual(expect.objectContaining({
      format: 'raw',
      sample_rate: 16_000,
      channels: 1,
      model: 'accurate'
    }))
    expect(request?.audio_data.length).toBeGreaterThan(0)
  })

  it('updates the existing composer with MediaRecorder transcription while still listening', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('AudioContext', DecodingAudioContext)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription('live words'))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 950))
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    })

    expect(transcribe.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ model: 'realtime' }))
    expect(container.querySelector('textarea')?.value).toBe('live words')
    expect(findButton(container, 'Stop listening')).toBeTruthy()
  })

  it('keeps the Web Audio PCM transcription path when MediaRecorder is unavailable', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) }
    })
    vi.stubGlobal('AudioContext', PcmAudioContext)
    vi.stubGlobal('MediaRecorder', RejectingMediaRecorder)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio').mockResolvedValue(successfulTranscription(''))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} />)
      await Promise.resolve()
    })
    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    PcmAudioContext.processor?.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => Float32Array.from({ length: 8_000 }, (_, index) => Math.sin(index / 8) * 0.2)
      }
    })
    await act(async () => {
      findButton(container, 'Stop listening').click()
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalled())
    })

    expect(transcribe.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      format: 'raw',
      sample_rate: 16_000,
      model: 'accurate'
    }))
  })
})

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

class DecodingAudioContext extends FakeAudioContext {
  sampleRate = 48_000
  decodeAudioData = vi.fn(async () => ({
    sampleRate: 48_000,
    length: 48_000,
    numberOfChannels: 1,
    getChannelData: () => Float32Array.from({ length: 48_000 }, (_, index) => Math.sin(index / 12) * 0.2)
  }))
}

class PcmAudioContext extends FakeAudioContext {
  static processor: {
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null
  } | null = null

  createScriptProcessor = vi.fn(() => {
    const processor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null as ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null
    }
    PcmAudioContext.processor = processor
    return processor
  })
}

class RejectingMediaRecorder {
  static isTypeSupported = vi.fn(() => true)

  constructor() {
    throw new Error('unsupported')
  }
}

class FakeMediaRecorder {
  static isTypeSupported = vi.fn((mimeType: string) => mimeType.startsWith('audio/webm'))

  readonly mimeType: string
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? 'audio/webm'
  }

  start(_timeslice?: number) {
    this.state = 'recording'
    queueMicrotask(() => this.emitChunk([1, 2, 3, 4]))
  }

  stop() {
    this.emitChunk([5, 6, 7, 8])
    this.state = 'inactive'
    queueMicrotask(() => this.onstop?.())
  }

  private emitChunk(bytes: number[]) {
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(bytes)], { type: this.mimeType })
    } as BlobEvent)
  }
}

function successfulTranscription(text: string) {
  return {
    ok: true as const,
    audit: {
      correlationId: 'voice-capture-test',
      eventKind: null,
      peerId: null,
      principalId: null,
      targetPeerId: null,
      method: 'Transcription.Transcribe',
      busTopic: 'Transcription.Transcribe',
      toolId: null,
      resourceId: null,
      status: 'ok',
      transport: 'mock',
      redaction: {
        secretsRedacted: true,
        redactedFields: [],
        source: 'transport' as const,
        warnings: []
      }
    },
    data: {
      text,
      confidence: null,
      language: null,
      duration_ms: 1_000,
      model_used: 'test'
    }
  }
}

function createNativeDesktopVoicePort(): NativeDesktopVoicePort & {
  status: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
} {
  let listener: ((event: { sequence: number; status: NativeDesktopVoiceStatus }) => void) | null = null
  let sequence = 0
  const port = {
    status: vi.fn(async () => nativeStatus('idle', null, true)),
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

function createNativeMobileVoicePort(): NativeMobileVoicePort & {
  status: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
} {
  const port = {
    status: vi.fn(async () => nativeMobileStatus('idle', true)),
    start: vi.fn(async () => nativeMobileStatus('listening', true)),
    finish: vi.fn(async () => nativeMobileStatus('processing', true)),
    cancel: vi.fn(async () => nativeMobileStatus('idle', true)),
  }
  return port
}

function nativeMobileStatus(
  phase: NativeMobileVoiceStatus['phase'],
  available: boolean,
): NativeMobileVoiceStatus {
  return {
    available,
    phase,
    running: phase === 'listening' || phase === 'processing',
    captureActive: phase === 'listening',
    reasonCode: null,
    redacted: true,
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

function renderedElementCopy(root: HTMLElement): string {
  const attributes = Array.from(root.querySelectorAll('*')).flatMap((element) => (
    ['aria-label', 'title', 'placeholder', 'disabledreason']
      .map((name) => element.getAttribute(name))
      .filter((value): value is string => Boolean(value))
  ))
  return [root.textContent ?? '', ...attributes].join(' ').replace(/\s+/g, ' ').trim()
}
