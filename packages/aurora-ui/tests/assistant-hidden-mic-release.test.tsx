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

  it('does not fall back to WebView microphone capture on Android when the native route is unavailable', async () => {
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
            runtimeMode: 'mobile-native',
            transportKind: 'native-mobile',
            nativePlatform: 'android',
            nativeVoicePresent: true,
            nativeVoiceAvailable: false,
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
    const audioContext = vi.fn()
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia }
    })
    vi.stubGlobal('MediaRecorder', mediaRecorder)
    vi.stubGlobal('AudioContext', audioContext)
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
    expect(audioContext).not.toHaveBeenCalled()
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

  it('does not cancel Android assistant-owned voice when the page hides before ASSIST starts', async () => {
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

    nativeMobileVoice.status.mockClear()
    nativeMobileVoice.cancel.mockClear()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening', true))
    setDocumentVisibility('hidden')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(nativeMobileVoice.status).not.toHaveBeenCalled()
    expect(nativeMobileVoice.cancel).not.toHaveBeenCalled()
  })

  it('does not claim Android assistant-owned voice after observing active native capture', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const nativeMobileVoice = createNativeMobileVoicePort()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening', true))
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
    await vi.waitFor(() => expect(nativeMobileVoice.status).toHaveBeenCalledTimes(1))

    nativeMobileVoice.cancel.mockClear()
    setDocumentVisibility('hidden')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(nativeMobileVoice.cancel).not.toHaveBeenCalled()
  })

  it('cancels Android UI-owned focused voice when the page hides', async () => {
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

    nativeMobileVoice.status.mockClear()
    nativeMobileVoice.cancel.mockClear()
    nativeMobileVoice.status.mockResolvedValue(nativeMobileStatus('listening', true))
    setDocumentVisibility('hidden')

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => expect(nativeMobileVoice.cancel).toHaveBeenCalledTimes(1))
    })
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

  it.each([
    ['unknown', getAuroraSurfaceProfile({ runtimeMode: 'unknown', transportKind: 'unknown' })],
    ['mock', getAuroraSurfaceProfile({ runtimeMode: 'mock', transportKind: 'mock' })],
  ] as const)('fails closed for %s focused push-to-talk without direct WebView microphone capture', async (_label, surfaceProfile) => {
    const getUserMedia = vi.fn()
    const mediaRecorder = vi.fn()
    const audioContext = vi.fn()
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } })
    vi.stubGlobal('MediaRecorder', mediaRecorder)
    vi.stubGlobal('AudioContext', audioContext)

    const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
    const startVoiceListen = vi.spyOn(client.assistant, 'startVoiceListen')
    const transcribe = vi.spyOn(client.assistant, 'transcribeVoiceAudio')
    const cancel = vi.spyOn(client.assistant, 'cancel')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AssistantView client={client} route={assistantRoute()} surfaceProfile={surfaceProfile} />)
      await Promise.resolve()
    })

    await act(async () => {
      findButton(container, 'Push to talk').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const rendered = renderedElementCopy(container)
    expect(rendered).toContain('Voice is unavailable on this device right now.')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(mediaRecorder).not.toHaveBeenCalled()
    expect(audioContext).not.toHaveBeenCalled()
    expect(startVoiceListen).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(findForbiddenProductionCopyTerms(rendered).map((term) => term.id), rendered).toEqual([])
  })
})

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

function setDocumentVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  })
}
