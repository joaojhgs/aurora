// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantRoutePolicy, AssistantStreamUpdate } from '@aurora/client'
import type { AuroraVoiceTtsAudio } from '@aurora/voice-web'
import type { AssistantStreamState, AssistantUiMessage } from './assistant-view'
import {
  base64ToUint8Array,
  useAssistantTts,
  wavBytesFromPcm16,
  type UseAssistantTtsOptions,
  type UseAssistantTtsResult,
} from './use-assistant-tts'

const roots: Root[] = []
let fakeAudioInstances: FakeAudio[] = []
let nextObjectUrl = 1
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  fakeAudioInstances = []
  nextObjectUrl = 1
  createObjectURL = vi.fn(() => `blob:assistant-tts-${nextObjectUrl++}`)
  revokeObjectURL = vi.fn()
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  vi.stubGlobal('Audio', FakeAudio)
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('assistant TTS audio helpers', () => {
  it('decodes streamed base64 audio bytes without changing order', () => {
    vi.stubGlobal('atob', (value: string) => value === 'AAEC/f7/' ? '\x00\x01\x02\xfd\xfe\xff' : '')
    try {
      expect([...base64ToUint8Array('AAEC/f7/')]).toEqual([0, 1, 2, 253, 254, 255])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns an empty byte array when base64 decoding is unavailable', () => {
    vi.stubGlobal('atob', undefined)
    try {
      expect(base64ToUint8Array('AAEC')).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('wraps browser TTS PCM as a mono 16-bit wav with the original samples', () => {
    const wav = wavBytesFromPcm16(new Int16Array([0, 32767, -32768]), 16_000)
    const view = new DataView(wav.buffer)
    const ascii = (start: number, length: number) => String.fromCharCode(...wav.slice(start, start + length))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(ascii(36, 4)).toBe('data')
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32767)
    expect(view.getInt16(48, true)).toBe(-32768)
  })
})

describe('useAssistantTts lifecycle', () => {
  it('plays queued streamed audio chunks in order and releases each completed URL once', async () => {
    const harness = await renderTtsHarness()

    await act(async () => {
      harness.result.enqueueStreamedTtsAudio(ttsAudioUpdate('first'))
      harness.result.enqueueStreamedTtsAudio(ttsAudioUpdate('second'))
      await flushPromises()
    })

    expect(fakeAudioInstances.map((audio) => audio.src)).toEqual(['blob:assistant-tts-1'])
    expect(fakeAudioInstances[0]?.play).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await act(async () => {
      fakeAudioInstances[0]?.finish()
      await flushPromises()
    })

    expect(fakeAudioInstances.map((audio) => audio.src)).toEqual(['blob:assistant-tts-1', 'blob:assistant-tts-2'])
    expect(fakeAudioInstances[1]?.play).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assistant-tts-1')

    await act(async () => {
      fakeAudioInstances[1]?.finish()
      await flushPromises()
    })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assistant-tts-2')
    expect(harness.result.speakingMessageIdRef.current).toBeNull()
  })

  it('stops active and queued streamed playback and revokes their URLs', async () => {
    const harness = await renderTtsHarness()

    await act(async () => {
      harness.result.enqueueStreamedTtsAudio(ttsAudioUpdate('active'))
      harness.result.enqueueStreamedTtsAudio(ttsAudioUpdate('queued'))
      harness.result.setSpeakingMessageId('assistant-message')
      await flushPromises()
    })

    await act(async () => {
      harness.result.stopStreamedTtsPlayback()
      await flushPromises()
    })

    expect(fakeAudioInstances).toHaveLength(1)
    expect(fakeAudioInstances[0]?.pause).toHaveBeenCalledTimes(1)
    expect(fakeAudioInstances[0]?.removeAttribute).toHaveBeenCalledWith('src')
    expect(fakeAudioInstances[0]?.load).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assistant-tts-1')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:assistant-tts-2')
    expect(harness.result.speakingMessageIdRef.current).toBeNull()
  })

  it('discards late browser synthesis after read-aloud invalidation', async () => {
    const synthesis = deferred<AuroraVoiceTtsAudio>()
    const runtime = { synthesizeSpeech: vi.fn(() => synthesis.promise) }
    const harness = await renderTtsHarness({
      browserLocalTtsVoiceId: 'local-voice',
      browserVoiceRuntime: vi.fn(async () => runtime),
    })

    let played!: Promise<boolean>
    await act(async () => {
      played = harness.result.synthesizeBrowserReadAloud('delayed speech', 'assistant-delayed')
      await flushPromises()
    })
    expect(harness.result.speakingMessageIdRef.current).toBe('assistant-delayed')

    await act(async () => {
      harness.result.invalidateReadAloudFallback()
      synthesis.resolve(ttsAudio())
      await flushPromises()
    })

    await expect(played).resolves.toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(fakeAudioInstances).toHaveLength(0)
  })

  it('does not replay streamed remote TTS when local sidecar owns playback', async () => {
    const harness = await renderTtsHarness({ usesLocalSidecar: true })

    await act(async () => {
      harness.result.enqueueStreamedTtsAudio(ttsAudioUpdate('remote-owned'))
      await flushPromises()
    })

    expect(harness.result.browserVoiceRemoteTtsAudioSeenRef.current).toBe(false)
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(fakeAudioInstances).toHaveLength(0)
  })

  it('uses the TTS playback cancellation scope when the user stops the same read-aloud message', async () => {
    const speechCancel = vi.fn()
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { cancel: speechCancel, speak: vi.fn() } })
    const client = assistantClient()
    const cancelBrowserVoiceRuntime = vi.fn(async () => undefined)
    const harness = await renderTtsHarness({ client, cancelBrowserVoiceRuntime })
    await act(async () => {
      harness.result.setSpeakingMessageId('assistant-read')
      await flushPromises()
    })

    await act(async () => {
      await harness.result.readAssistantMessageAloud(assistantMessage('assistant-read', 'Read this aloud.'))
      await flushPromises()
    })

    expect(cancelBrowserVoiceRuntime).toHaveBeenCalledWith('user_interrupt')
    expect(speechCancel).toHaveBeenCalledTimes(1)
    expect(client.assistant.cancel).toHaveBeenCalledWith({
      sessionId: 'conversation-1',
      scopes: ['tts_playback'],
      reason: 'user_interrupt'
    })
    expect(client.assistant.requestReadAloud).not.toHaveBeenCalled()
    expect(client.assistant.synthesizeReadAloud).not.toHaveBeenCalled()
  })
})

function HookHarness({ options, onResult }: { options: UseAssistantTtsOptions; onResult: (result: UseAssistantTtsResult) => void }) {
  const result = useAssistantTts(options)
  onResult(result)
  return null
}

async function renderTtsHarness(overrides: Partial<UseAssistantTtsOptions> = {}) {
  let latest: UseAssistantTtsResult | null = null
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const options = defaultTtsOptions(overrides)
  await act(async () => {
    root.render(createElement(HookHarness, { options, onResult: (result: UseAssistantTtsResult) => { latest = result } }))
    await flushPromises()
  })
  if (!latest) throw new Error('useAssistantTts did not render')
  return {
    get result() {
      if (!latest) throw new Error('useAssistantTts did not render')
      return latest
    },
    options,
    root,
    container,
  }
}

function defaultTtsOptions(overrides: Partial<UseAssistantTtsOptions>): UseAssistantTtsOptions {
  return {
    client: assistantClient(),
    sessionId: 'conversation-1',
    usesLocalSidecar: false,
    browserLocalTtsVoiceId: undefined,
    resolveReadAloudRoutePolicy: () => routePolicy(),
    browserVoiceRuntime: vi.fn(async () => ({ synthesizeSpeech: vi.fn(async () => ttsAudio()) })),
    cancelBrowserVoiceRuntime: vi.fn(async () => undefined),
    setStreamState: vi.fn((next) => typeof next === 'function' ? next({ status: 'idle', lastEventId: null, message: null }) : next),
    setLastError: vi.fn(),
    productAssistantErrorCopy: (error) => error.message,
    ...overrides,
  }
}

function assistantClient(): UseAssistantTtsOptions['client'] {
  return {
    assistant: {
      requestReadAloud: vi.fn(async () => ({ ok: true, data: { accepted: true } })),
      synthesizeReadAloud: vi.fn(async () => ({ ok: true, data: { audio_data: 'audio', format: 'wav' } })),
      cancel: vi.fn(async () => ({ ok: true, data: { status: 'cancelled' } })),
    }
  } as unknown as UseAssistantTtsOptions['client']
}

function ttsAudioUpdate(label: string, final = false): AssistantStreamUpdate {
  return {
    kind: 'tts_audio_chunk',
    eventId: `event-${label}`,
    messageId: 'assistant-message',
    sessionId: 'conversation-1',
    text: '',
    textDelta: '',
    modelLabel: null,
    requestId: null,
    error: null,
    audit: null,
    metadata: {},
    tool: null,
    ttsAudio: {
      chunkId: label,
      sequence: null,
      audioData: final ? null : btoa(label),
      encoding: 'wav',
      mimeType: 'audio/wav',
      sampleRate: null,
      channels: null,
      durationMs: null,
      final,
    },
  } as unknown as AssistantStreamUpdate
}

function ttsAudio(): AuroraVoiceTtsAudio {
  return {
    pcm: new Int16Array([1, 2, 3]),
    sampleRateHz: 16_000,
    sampleCount: 3,
  } as AuroraVoiceTtsAudio
}

function assistantMessage(id: string, text: string): AssistantUiMessage {
  return {
    id,
    role: 'assistant',
    text,
    createdAt: '2026-09-16T00:00:00.000Z',
    status: 'sent',
  }
}

function routePolicy(): AssistantRoutePolicy {
  return {
    providerId: null,
    peerId: null,
    serviceInstanceId: null,
    routeState: 'available-local',
    privacyClass: 'personal',
    selectorRequired: false,
    approvalRequired: false,
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

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

class FakeAudio {
  readonly play = vi.fn(async () => undefined)
  readonly pause = vi.fn()
  readonly load = vi.fn()
  readonly removeAttribute = vi.fn()
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly src: string) {
    fakeAudioInstances.push(this)
  }

  finish() {
    this.onended?.()
  }
}
