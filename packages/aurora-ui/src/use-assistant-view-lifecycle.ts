import { useEffect, useRef, type MutableRefObject } from 'react'
import type { LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import type { AssistantStreamState, VoiceCaptureStatus } from './assistant-view'
import type { NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { NativeMobileVoiceBackgroundResult, NativeMobileVoicePort } from './native-mobile-voice'
import type { NativeAssistantEventStatus } from './native-assistant-events'
import type { AuroraBrowserVoiceRuntimeInstance } from './assistant-browser-voice-runtime'
import type { BrowserVoiceTurnSettlement } from './use-assistant-browser-capture'

export interface UseAssistantViewCleanupLifecycleOptions {
  readonly browserSpeechPacksRevision: string
  readonly assistantViewDisposedRef: MutableRefObject<boolean>
  readonly abortRef: MutableRefObject<AbortController | null>
  readonly localConfirmationOrchestratorsRef: MutableRefObject<Map<string, LightweightOrchestrator>>
  readonly clearVoiceResponseTimeout: () => void
  readonly stopStreamedTtsPlayback: () => void
  readonly cancelNativeDesktopVoice: (reason: NativeDesktopVoiceStopReason) => Promise<boolean>
  readonly nativeMobileBackgroundWakeActiveRef: MutableRefObject<boolean>
  readonly nativeMobileVoiceOperationTokenRef: MutableRefObject<number>
  readonly nativeMobileVoiceStartInFlightRef: MutableRefObject<boolean>
  readonly voiceCaptureStatusRef: MutableRefObject<VoiceCaptureStatus>
  readonly cancelNativeMobileVoice: (options?: { updateUi?: boolean }) => Promise<boolean>
  readonly browserVoiceOperationTokenRef: MutableRefObject<number>
  readonly settleBrowserVoiceTurn: (token: number, outcome: 'complete' | 'abandon' | 'cancel', reason?: string) => Promise<{ claimed: boolean; succeeded: boolean; current: boolean }>
  readonly browserVoiceTurnSettlementRef: MutableRefObject<BrowserVoiceTurnSettlement | null>
  readonly waitForBrowserVoiceTurnSettlement: (token: number) => Promise<void>
  readonly disposeBrowserVoiceRuntime: () => Promise<void>
  readonly invalidateReadAloudFallback: () => void
  readonly browserVoiceRuntimeRef: MutableRefObject<AuroraBrowserVoiceRuntimeInstance | null>
  readonly clearBrowserVoiceRuntimeEventSubscription: () => void
}

export function useAssistantViewCleanupLifecycle(options: UseAssistantViewCleanupLifecycleOptions): void {
  useEffect(() => {
    options.assistantViewDisposedRef.current = false
    return () => {
      options.assistantViewDisposedRef.current = true
      options.abortRef.current?.abort()
      for (const orchestrator of options.localConfirmationOrchestratorsRef.current.values()) orchestrator.cancel()
      options.localConfirmationOrchestratorsRef.current.clear()
      options.clearVoiceResponseTimeout()
      options.stopStreamedTtsPlayback()
      void options.cancelNativeDesktopVoice('shutdown')
      const mobileBackgroundActive = options.nativeMobileBackgroundWakeActiveRef.current
      if (!mobileBackgroundActive) {
        options.nativeMobileVoiceOperationTokenRef.current += 1
      }
      if (!mobileBackgroundActive && (options.nativeMobileVoiceStartInFlightRef.current || options.voiceCaptureStatusRef.current === 'listening' || options.voiceCaptureStatusRef.current === 'processing')) {
        void options.cancelNativeMobileVoice({ updateUi: false })
      }
      const token = options.browserVoiceOperationTokenRef.current
      options.browserVoiceOperationTokenRef.current += 1
      void (async () => {
        const settled = await options.settleBrowserVoiceTurn(token, 'cancel', 'disposed')
        if (!settled.claimed && options.browserVoiceTurnSettlementRef.current?.token === token) {
          await options.waitForBrowserVoiceTurnSettlement(token)
        }
        await options.disposeBrowserVoiceRuntime()
      })()
    }
  }, [])

  useEffect(() => {
    options.invalidateReadAloudFallback()
    const runtime = options.browserVoiceRuntimeRef.current
    if (!runtime) return
    options.browserVoiceRuntimeRef.current = null
    options.clearBrowserVoiceRuntimeEventSubscription()
    void runtime.cancel('voice_selection_changed').catch(() => undefined)
    void runtime.dispose().catch(() => undefined)
  }, [options.browserSpeechPacksRevision])
}

export interface UseAssistantNativeBackgroundResultPollOptions {
  readonly localHistory: unknown
  readonly pollScopeKey: string
  readonly usesNativeMobileVoice: boolean
  readonly nativeMobileVoice: NativeMobileVoicePort | null | undefined
  readonly nativeAssistantEventConsumerStatus: NativeAssistantEventStatus
  readonly nativeBackgroundTerminalKeysRef: MutableRefObject<Set<string>>
  readonly nativeBackgroundReconciledKeysRef: MutableRefObject<Set<string>>
  readonly voiceTranscriptPreviewRef: MutableRefObject<string>
  readonly setText: (text: string) => void
  readonly reconcileNativeAssistantPersistence: (key: string, result: NativeMobileVoiceBackgroundResult) => Promise<boolean>
  readonly showNativeMobileBackgroundTurn: (result: NativeMobileVoiceBackgroundResult) => Promise<boolean>
  readonly setVoiceCaptureStatus: (status: VoiceCaptureStatus) => void
  readonly setLastError: (error: string | null) => void
}

export function useAssistantNativeBackgroundResultPoll(options: UseAssistantNativeBackgroundResultPollOptions): void {
  const mountedRef = useRef(false)
  const recoveryGenerationRef = useRef(0)
  const pollScopeKeyRef = useRef(options.pollScopeKey)
  const recoveryAttemptedScopeRef = useRef<string | null>(null)
  const committedRecoveryScopeRef = useRef(options.pollScopeKey)
  const recoveryFlightRef = useRef<Promise<void> | null>(null)
  const optionsRef = useRef(options)
  const handlersRef = useRef({
    reconcileNativeAssistantPersistence: options.reconcileNativeAssistantPersistence,
    showNativeMobileBackgroundTurn: options.showNativeMobileBackgroundTurn,
    setLastError: options.setLastError,
    setText: options.setText,
    setVoiceCaptureStatus: options.setVoiceCaptureStatus,
  })

  pollScopeKeyRef.current = options.pollScopeKey
  optionsRef.current = options
  handlersRef.current = {
    reconcileNativeAssistantPersistence: options.reconcileNativeAssistantPersistence,
    showNativeMobileBackgroundTurn: options.showNativeMobileBackgroundTurn,
    setLastError: options.setLastError,
    setText: options.setText,
    setVoiceCaptureStatus: options.setVoiceCaptureStatus,
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (
      committedRecoveryScopeRef.current !== options.pollScopeKey
      || (options.nativeAssistantEventConsumerStatus !== 'closed' && options.nativeAssistantEventConsumerStatus !== 'error')
    ) {
      recoveryAttemptedScopeRef.current = null
    }
    committedRecoveryScopeRef.current = options.pollScopeKey
  }, [options.nativeAssistantEventConsumerStatus, options.pollScopeKey])

  useEffect(() => {
    if (!options.usesNativeMobileVoice || !options.nativeMobileVoice?.takeBackgroundResult) return
    if (options.nativeAssistantEventConsumerStatus !== 'closed' && options.nativeAssistantEventConsumerStatus !== 'error') return
    let active = true
    const recoveryGeneration = recoveryGenerationRef.current + 1
    const recoveryScopeKey = options.pollScopeKey
    recoveryGenerationRef.current = recoveryGeneration
    const isCurrentRecovery = () => (
      active
      && mountedRef.current
      && recoveryGenerationRef.current === recoveryGeneration
      && pollScopeKeyRef.current === recoveryScopeKey
      && (optionsRef.current.nativeAssistantEventConsumerStatus === 'closed' || optionsRef.current.nativeAssistantEventConsumerStatus === 'error')
    )
    const drainBackgroundResults = async () => {
      const previousFlight = recoveryFlightRef.current
      if (previousFlight) await previousFlight
      if (!isCurrentRecovery() || recoveryAttemptedScopeRef.current === recoveryScopeKey) return
      recoveryAttemptedScopeRef.current = recoveryScopeKey
      try {
        for (let readCount = 0; readCount < 32 && isCurrentRecovery(); readCount += 1) {
          const result = await optionsRef.current.nativeMobileVoice?.takeBackgroundResult?.()
          if (!isCurrentRecovery()) break
          if (!result) break
          const transcript = result.transcript.trim()
          if (!transcript) continue
          const key = result.generation >= 0 ? `generation:${result.generation}` : result.conversationId ? `conversation:${result.conversationId}` : null
          const currentOptions = optionsRef.current
          const handlers = handlersRef.current
          if (key && currentOptions.nativeBackgroundTerminalKeysRef.current.has(key)) {
            await handlers.reconcileNativeAssistantPersistence(key, result)
            if (!isCurrentRecovery()) break
            continue
          }
          if (key && currentOptions.nativeBackgroundReconciledKeysRef.current.has(key)) continue
          currentOptions.voiceTranscriptPreviewRef.current = ''
          handlers.setText('')
          const opened = await (key
            ? handlers.reconcileNativeAssistantPersistence(key, result)
            : handlers.showNativeMobileBackgroundTurn(result))
          if (!isCurrentRecovery()) break
          if (!opened) {
            handlers.setVoiceCaptureStatus('error')
            handlers.setLastError('This voice request could not be saved. Try again.')
            continue
          }
          handlers.setVoiceCaptureStatus('idle')
          if (result.errorCode && !result.assistantText?.trim()) {
            handlers.setLastError('Aurora saved what you said but could not complete a response.')
          }
        }
      } catch {
        if (isCurrentRecovery()) {
          const handlers = handlersRef.current
          handlers.setVoiceCaptureStatus('error')
          handlers.setLastError('Voice result could not be opened. Try again.')
        }
      }
    }
    const flight = drainBackgroundResults()
    recoveryFlightRef.current = flight
    void flight.then(
      () => { if (recoveryFlightRef.current === flight) recoveryFlightRef.current = null },
      () => { if (recoveryFlightRef.current === flight) recoveryFlightRef.current = null },
    )
    return () => {
      active = false
    }
  }, [options.nativeMobileVoice, options.nativeAssistantEventConsumerStatus, options.pollScopeKey, options.usesNativeMobileVoice])
}
