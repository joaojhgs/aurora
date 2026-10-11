// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeMobileVoiceBackgroundResult, NativeMobileVoicePort, NativeMobileVoiceStatus } from './native-mobile-voice'
import { useAssistantNativeBackgroundResultPoll, type UseAssistantNativeBackgroundResultPollOptions } from './use-assistant-view-lifecycle'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useAssistantNativeBackgroundResultPoll', () => {
  it('discards an in-flight result when observation becomes connecting or healthy', async () => {
    const pendingResult = deferred<NativeMobileVoiceBackgroundResult | null>()
    const takeBackgroundResult = vi.fn(() => pendingResult.promise)
    const harness = await renderPollHarness({ nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult) })

    expect(takeBackgroundResult).toHaveBeenCalledTimes(1)
    await act(async () => {
      harness.rerender({ nativeAssistantEventConsumerStatus: 'connecting' })
      await flushPromises()
    })
    await act(async () => {
      pendingResult.resolve(backgroundResult({ generation: 51 }))
      await flushPromises()
    })

    expect(takeBackgroundResult).toHaveBeenCalledTimes(1)
    expect(harness.options.reconcileNativeAssistantPersistence).not.toHaveBeenCalled()
    expect(harness.options.showNativeMobileBackgroundTurn).not.toHaveBeenCalled()
    expect(harness.options.setVoiceCaptureStatus).not.toHaveBeenCalled()
    expect(harness.options.setLastError).not.toHaveBeenCalled()
  })

  it('discards a rejected in-flight result after observation becomes streaming', async () => {
    const pendingResult = deferred<NativeMobileVoiceBackgroundResult | null>()
    const takeBackgroundResult = vi.fn(() => pendingResult.promise)
    const harness = await renderPollHarness({ nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult) })

    await act(async () => {
      harness.rerender({ nativeAssistantEventConsumerStatus: 'streaming' })
      await flushPromises()
    })
    await act(async () => {
      pendingResult.reject(new Error('native transport detail'))
      await flushPromises()
    })

    expect(harness.options.reconcileNativeAssistantPersistence).not.toHaveBeenCalled()
    expect(harness.options.showNativeMobileBackgroundTurn).not.toHaveBeenCalled()
    expect(harness.options.setVoiceCaptureStatus).not.toHaveBeenCalled()
    expect(harness.options.setLastError).not.toHaveBeenCalled()
  })

  it('performs one bounded recovery drain of at most 32 reads', async () => {
    const takeBackgroundResult = vi.fn(async () => backgroundResult())
    await renderPollHarness({
      nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult),
      nativeAssistantEventConsumerStatus: 'closed',
    })

    await act(async () => {
      for (let index = 0; index < 80; index += 1) await Promise.resolve()
    })
    expect(takeBackgroundResult).toHaveBeenCalledTimes(32)
  })

  it('starts a fresh recovery after observation leaves and re-enters a terminal state', async () => {
    const takeBackgroundResult = vi.fn(async () => null)
    const harness = await renderPollHarness({ nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult) })
    expect(takeBackgroundResult).toHaveBeenCalledTimes(1)

    await act(async () => {
      harness.rerender({ nativeAssistantEventConsumerStatus: 'connecting' })
      await flushPromises()
    })
    await act(async () => {
      harness.rerender({ nativeAssistantEventConsumerStatus: 'error' })
      await flushPromises()
    })
    expect(takeBackgroundResult).toHaveBeenCalledTimes(2)
  })

  it('serializes scope changes and lets the latest scope recover after the prior read settles', async () => {
    const firstRead = deferred<NativeMobileVoiceBackgroundResult | null>()
    let activeReads = 0
    let maxActiveReads = 0
    const takeBackgroundResult = vi.fn(() => {
      activeReads += 1
      maxActiveReads = Math.max(maxActiveReads, activeReads)
      const result = takeBackgroundResult.mock.calls.length === 1 ? firstRead.promise : Promise.resolve(null)
      return result.finally(() => { activeReads -= 1 })
    })
    const harness = await renderPollHarness({ nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult) })

    await act(async () => {
      harness.rerender({ pollScopeKey: 'profile-b' })
      await flushPromises()
    })
    await act(async () => {
      harness.rerender({ pollScopeKey: 'profile-a' })
      await flushPromises()
    })
    await act(async () => {
      firstRead.resolve(null)
      await flushPromises()
    })

    expect(maxActiveReads).toBe(1)
    expect(takeBackgroundResult).toHaveBeenCalledTimes(2)
  })

  it('contains a rejected recovery read with product-safe copy', async () => {
    const takeBackgroundResult = vi.fn(async () => { throw new Error('native transport detail') })
    const harness = await renderPollHarness({ nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult) })

    await act(async () => { await flushPromises() })
    expect(harness.options.setLastError).toHaveBeenCalledWith('Voice result could not be opened. Try again.')
  })

  it('skips a result already reconciled for the captured scope', async () => {
    const reconcileNativeAssistantPersistence = vi.fn(async () => true)
    const showNativeMobileBackgroundTurn = vi.fn(async () => true)
    const nativeBackgroundReconciledKeysRef = { current: new Set(['generation:7']) }
    const takeBackgroundResult = vi.fn()
      .mockResolvedValueOnce(backgroundResult({ generation: 7 }))
      .mockResolvedValueOnce(null)
    await renderPollHarness({
      nativeMobileVoice: nativeMobileVoicePort(takeBackgroundResult),
      nativeBackgroundReconciledKeysRef,
      reconcileNativeAssistantPersistence,
      showNativeMobileBackgroundTurn,
    })

    expect(reconcileNativeAssistantPersistence).not.toHaveBeenCalled()
    expect(showNativeMobileBackgroundTurn).not.toHaveBeenCalled()
  })

  it('keeps a consumed native result across same-scope handler rerenders', async () => {
    const result = backgroundResult({ generation: 41 })
    const pendingResult = deferred<NativeMobileVoiceBackgroundResult | null>()
    const nativeMobileVoice = nativeMobileVoicePort(vi.fn()
      .mockReturnValueOnce(pendingResult.promise)
      .mockResolvedValue(null))
    const firstReconcile = vi.fn(async () => false)
    const latestReconcile = vi.fn(async () => false)
    const harness = await renderPollHarness({
      nativeMobileVoice,
      pollScopeKey: 'profile-a',
      localHistory: { revision: 1 },
      reconcileNativeAssistantPersistence: firstReconcile,
    })

    await act(async () => {
      harness.rerender({
        localHistory: { revision: 2 },
        reconcileNativeAssistantPersistence: latestReconcile,
      })
    })
    await act(async () => {
      pendingResult.resolve(result)
      await flushPromises()
    })

    expect(firstReconcile).not.toHaveBeenCalled()
    expect(latestReconcile).toHaveBeenCalledWith('generation:41', result)
    expect(harness.options.setVoiceCaptureStatus).toHaveBeenCalledWith('error')
    expect(harness.options.setLastError).toHaveBeenCalledWith('This voice request could not be saved. Try again.')
  })

  it('rejects a consumed native result after a semantic scope change', async () => {
    const pendingResult = deferred<NativeMobileVoiceBackgroundResult | null>()
    const nativeMobileVoice = nativeMobileVoicePort(vi.fn()
      .mockReturnValueOnce(pendingResult.promise)
      .mockResolvedValue(null))
    const reconcileNativeAssistantPersistence = vi.fn(async () => false)
    const harness = await renderPollHarness({
      nativeMobileVoice,
      pollScopeKey: 'profile-a',
      reconcileNativeAssistantPersistence,
    })

    await act(async () => {
      harness.rerender({ pollScopeKey: 'profile-b' })
    })
    await act(async () => {
      pendingResult.resolve(backgroundResult({ generation: 42 }))
      await flushPromises()
    })

    expect(reconcileNativeAssistantPersistence).not.toHaveBeenCalled()
    expect(harness.options.setVoiceCaptureStatus).not.toHaveBeenCalledWith('error')
    expect(harness.options.setLastError).not.toHaveBeenCalled()
  })

  it('does not apply a native result if scope changes while reconciliation is pending', async () => {
    const result = backgroundResult({ generation: 43 })
    const pendingReconcile = deferred<boolean>()
    const nativeMobileVoice = nativeMobileVoicePort(vi.fn()
      .mockResolvedValueOnce(result)
      .mockResolvedValue(null))
    const reconcileNativeAssistantPersistence = vi.fn(() => pendingReconcile.promise)
    const harness = await renderPollHarness({
      nativeMobileVoice,
      pollScopeKey: 'profile-a',
      reconcileNativeAssistantPersistence,
    })

    await act(async () => {
      await flushPromises()
      harness.rerender({ pollScopeKey: 'profile-b' })
    })
    await act(async () => {
      pendingReconcile.resolve(false)
      await flushPromises()
    })

    expect(reconcileNativeAssistantPersistence).toHaveBeenCalledWith('generation:43', result)
    expect(harness.options.setVoiceCaptureStatus).not.toHaveBeenCalledWith('error')
    expect(harness.options.setLastError).not.toHaveBeenCalled()
  })

  it('does not process a consumed native result after unmount', async () => {
    const pendingResult = deferred<NativeMobileVoiceBackgroundResult | null>()
    const nativeMobileVoice = nativeMobileVoicePort(vi.fn()
      .mockReturnValueOnce(pendingResult.promise)
      .mockResolvedValue(null))
    const reconcileNativeAssistantPersistence = vi.fn(async () => false)
    const harness = await renderPollHarness({
      nativeMobileVoice,
      pollScopeKey: 'profile-a',
      reconcileNativeAssistantPersistence,
    })

    await act(async () => {
      harness.unmount()
      pendingResult.resolve(backgroundResult({ generation: 44 }))
      await flushPromises()
    })

    expect(reconcileNativeAssistantPersistence).not.toHaveBeenCalled()
    expect(harness.options.setVoiceCaptureStatus).not.toHaveBeenCalledWith('error')
    expect(harness.options.setLastError).not.toHaveBeenCalled()
  })
})

async function renderPollHarness(overrides: Partial<UseAssistantNativeBackgroundResultPollOptions>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  let currentOptions = pollOptions(overrides)

  function Harness({ options }: { options: UseAssistantNativeBackgroundResultPollOptions }) {
    useAssistantNativeBackgroundResultPoll(options)
    return null
  }

  const rerender = (next: Partial<UseAssistantNativeBackgroundResultPollOptions>) => {
    currentOptions = { ...currentOptions, ...next }
    root.render(createElement(Harness, { options: currentOptions }))
  }
  const unmount = () => {
    const index = roots.indexOf(root)
    if (index >= 0) roots.splice(index, 1)
    root.unmount()
  }

  await act(async () => {
    rerender({})
    await flushPromises()
  })

  return {
    get options() { return currentOptions },
    rerender,
    unmount,
  }
}

function pollOptions(overrides: Partial<UseAssistantNativeBackgroundResultPollOptions>): UseAssistantNativeBackgroundResultPollOptions {
  const nativeMobileVoice = overrides.nativeMobileVoice ?? nativeMobileVoicePort(vi.fn(async () => null))
  return {
    localHistory: { revision: 0 },
    pollScopeKey: 'profile-a',
    usesNativeMobileVoice: true,
    nativeMobileVoice,
    nativeAssistantEventConsumerStatus: 'error',
    nativeBackgroundTerminalKeysRef: { current: new Set() },
    nativeBackgroundReconciledKeysRef: { current: new Set() },
    voiceTranscriptPreviewRef: { current: 'preview' },
    setText: vi.fn(),
    reconcileNativeAssistantPersistence: vi.fn(async () => true),
    showNativeMobileBackgroundTurn: vi.fn(async () => true),
    setVoiceCaptureStatus: vi.fn(),
    setLastError: vi.fn(),
    ...overrides,
  }
}

function nativeMobileVoicePort(takeBackgroundResult: NonNullable<NativeMobileVoicePort['takeBackgroundResult']>): NativeMobileVoicePort {
  return {
    status: vi.fn(async () => nativeMobileVoiceStatus()),
    start: vi.fn(async () => nativeMobileVoiceStatus()),
    finish: vi.fn(async () => nativeMobileVoiceStatus()),
    takeBackgroundResult,
    cancel: vi.fn(async () => nativeMobileVoiceStatus()),
    backgroundStatus: vi.fn(async () => nativeMobileVoiceStatus()),
    startBackground: vi.fn(async () => nativeMobileVoiceStatus({ backgroundActive: true })),
    stopBackground: vi.fn(async () => nativeMobileVoiceStatus()),
  }
}

function nativeMobileVoiceStatus(overrides: Partial<NativeMobileVoiceStatus> = {}): NativeMobileVoiceStatus {
  return {
    available: true,
    phase: 'idle',
    running: false,
    captureActive: false,
    reasonCode: null,
    redacted: true,
    ...overrides,
  }
}

function backgroundResult(overrides: Partial<NativeMobileVoiceBackgroundResult> = {}): NativeMobileVoiceBackgroundResult {
  return {
    generation: 1,
    transcript: 'summarize this',
    assistantText: null,
    errorCode: null,
    persisted: false,
    conversationId: null,
    persistenceErrorCode: 'native_voice_persistence_failed',
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
