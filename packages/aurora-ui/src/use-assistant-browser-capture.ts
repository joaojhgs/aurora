import type { AssistantRoutePolicy, AuroraClient, AuroraError } from '@aurora/client'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { RouteAvailability } from './shell-data'
import type { AssistantStreamState, AssistantVoiceModel, VoiceCaptureStatus } from './assistant-view'
import type { ReadyBrowserSpeechPacksRuntimeStatus } from './use-assistant-voice'
import {
  browserVoiceRuntimeEventToVoiceEvent,
  defaultSameOriginSherpaAssetUrls,
  int16PcmToLittleEndianBase64,
  loadAuroraBrowserVoiceRuntimeFactory,
  productAudioCaptureErrorCopy,
  voiceCaptureStatusForStartError,
  type AuroraBrowserCapturedAudio,
  type AuroraBrowserVoiceRuntimeInstance,
  type BrowserVoiceRuntimeEventSnapshot,
} from './assistant-browser-voice-runtime'
export type BrowserVoiceTurnSettlementOutcome = 'complete' | 'abandon' | 'cancel'
export interface BrowserVoiceTurnSettlement {
  token: number
  state: 'open' | 'settling' | 'settled'
  outcome: BrowserVoiceTurnSettlementOutcome | null
  promise: Promise<boolean> | null
}
export interface BrowserCaptureControllerContext {
  client: AuroraClient
  readyBrowserSpeechPacks: ReadyBrowserSpeechPacksRuntimeStatus | null
  voiceModel: AssistantVoiceModel
  browserVoiceRuntimeRef: MutableRefObject<AuroraBrowserVoiceRuntimeInstance | null>
  browserVoiceRuntimeEventUnsubscribeRef: MutableRefObject<(() => void) | null>
  browserVoiceOperationTokenRef: MutableRefObject<number>
  browserVoiceTurnSettlementRef: MutableRefObject<BrowserVoiceTurnSettlement | null>
  browserVoiceLocalTranscriptRef: MutableRefObject<string>
  activeVoiceSessionRef: MutableRefObject<string | null>
  ownedVoiceSessionIdsRef: MutableRefObject<Set<string>>
  coordinatorVoiceSessionIdsRef: MutableRefObject<Set<string>>
  voicePendingAssistantIdRef: MutableRefObject<string | null>
  voiceCaptureStatusRef: MutableRefObject<VoiceCaptureStatus>
  voiceTranscriptPreviewRef: MutableRefObject<string>
  setText: (text: string) => void
  setLastError: Dispatch<SetStateAction<string | null>>
  setStreamState: Dispatch<SetStateAction<AssistantStreamState>>
  setVoiceCaptureStatus: (next: VoiceCaptureStatus) => void
  setVoiceEvents: Dispatch<SetStateAction<import('@aurora/client').VoiceRuntimeEvent[]>>
  setVoiceResponsePendingId: (pendingId: string | null) => void
  setVoiceWaveformBars: Dispatch<SetStateAction<number[]>>
  waveformBarsFromLevel: (level: number, peak: number) => number[]
  mergeVoiceRuntimeEvents: (...groups: import('@aurora/client').VoiceRuntimeEvent[][]) => import('@aurora/client').VoiceRuntimeEvent[]
  routePolicyFromRoute: (route: RouteAvailability) => AssistantRoutePolicy
  productAssistantErrorCopy: (error: AuroraError | Error) => string
  startAssistantTurn: (prompt: string) => Promise<boolean>
}
export function createBrowserCaptureController(ctx: BrowserCaptureControllerContext) {
  function browserVoiceLifecycleEligibility() {
    const visible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden'
    const focused = typeof document === 'undefined' || typeof document.hasFocus !== 'function' || document.hasFocus()
    const eligible = visible && focused
    return {
      foregroundOnly: true as const,
      visible,
      frozen: false,
      eligible,
      reason: eligible ? 'visible' as const : 'hidden' as const
    }
  }
  function releaseBrowserVoiceCaptureForLifecycle() {
    releaseBrowserVoiceCaptureForReason('lifecycle_lost')
    if (ctx.voiceCaptureStatusRef.current !== 'listening' && ctx.voiceCaptureStatusRef.current !== 'processing') return
    ctx.setVoiceCaptureStatus('idle')
    ctx.activeVoiceSessionRef.current = null
    ctx.ownedVoiceSessionIdsRef.current.clear()
    ctx.coordinatorVoiceSessionIdsRef.current.clear()
    ctx.voicePendingAssistantIdRef.current = null
    ctx.setVoiceResponsePendingId(null)
    ctx.setStreamState((current) => ({
      ...current,
      status: 'lost',
      message: 'Microphone listening stopped because Aurora was no longer the active window.'
    }))
  }
  function releaseBrowserVoiceCaptureForReason(reason: string) {
    void cancelBrowserVoiceCaptureForReason(reason)
  }
  async function cancelBrowserVoiceCaptureForReason(reason: string) {
    const token = ctx.browserVoiceOperationTokenRef.current
    ctx.browserVoiceOperationTokenRef.current = token + 1
    const settlement = ctx.browserVoiceTurnSettlementRef.current
    if (ctx.voiceCaptureStatusRef.current === 'processing' || settlement?.token === token && settlement.state === 'settling') {
      await settleBrowserVoiceTurn(token, 'cancel', reason)
      return
    }
    await cancelBrowserVoiceRuntime(reason)
  }
  async function browserVoiceRuntime(): Promise<AuroraBrowserVoiceRuntimeInstance> {
    if (!ctx.browserVoiceRuntimeRef.current) {
      const createAuroraBrowserVoiceRuntime = await loadAuroraBrowserVoiceRuntimeFactory()
      const runtimeOptions = {
        ownerId: 'aurora-assistant-view',
        lifecycle: browserVoiceLifecycleEligibility,
        audio: {
          onAudioLevel: (level: number, peak: number) => {
            ctx.setVoiceWaveformBars(ctx.waveformBarsFromLevel(level * 100, peak * 100))
          }
        },
        onAudioLifecycleLost: releaseBrowserVoiceCaptureForLifecycle,
        onPageLifecycleLost: releaseBrowserVoiceCaptureForLifecycle
      }
      const runtime = createAuroraBrowserVoiceRuntime(
        ctx.readyBrowserSpeechPacks
          ? {
              ...runtimeOptions,
              modelBindings: ctx.readyBrowserSpeechPacks.modelBindings,
              sherpaAssets: defaultSameOriginSherpaAssetUrls(),
            }
          : runtimeOptions
      )
      ctx.browserVoiceRuntimeEventUnsubscribeRef.current = runtime.onEvent(handleBrowserVoiceRuntimeEvent)
      ctx.browserVoiceRuntimeRef.current = runtime
    }
    return ctx.browserVoiceRuntimeRef.current
  }
  function handleBrowserVoiceRuntimeEvent(event: BrowserVoiceRuntimeEventSnapshot) {
    if (event.kind === 'frame_accepted') return
    ctx.setVoiceEvents((current) => ctx.mergeVoiceRuntimeEvents([
      browserVoiceRuntimeEventToVoiceEvent(event)
    ], current).slice(0, 12))
    if (event.sessionId) {
      ctx.ownedVoiceSessionIdsRef.current.add(event.sessionId)
      ctx.activeVoiceSessionRef.current = event.sessionId
    }
    if (event.kind === 'session_started') {
      ctx.browserVoiceLocalTranscriptRef.current = ''
      ctx.setVoiceCaptureStatus('listening')
      return
    }
    if (event.kind === 'voice_inference') {
      const nextText = event.inference?.stt.at(-1)?.text.trim()
      if (nextText) ctx.browserVoiceLocalTranscriptRef.current = nextText
    }
    if (event.kind === 'frame_dropped') {
      ctx.setLastError('Microphone capture is continuing with reduced quality.')
      ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Microphone capture is continuing with reduced quality.' }))
      return
    }
    if (event.kind === 'lifecycle_lost') {
      releaseBrowserVoiceCaptureForLifecycle()
      return
    }
    if (event.kind === 'error') {
      ctx.setLastError('Microphone capture failed. Try again.')
      ctx.setVoiceCaptureStatus('error')
    }
  }
  function clearBrowserVoiceRuntimeEventSubscription() {
    ctx.browserVoiceRuntimeEventUnsubscribeRef.current?.()
    ctx.browserVoiceRuntimeEventUnsubscribeRef.current = null
  }

  async function cancelBrowserVoiceRuntime(reason: string) {
    const runtime = ctx.browserVoiceRuntimeRef.current
    if (!runtime) return
    try {
      await runtime.cancel(reason)
    } catch {}
  }

  async function forceDisposeBrowserVoiceRuntime(runtime: AuroraBrowserVoiceRuntimeInstance) {
    if (ctx.browserVoiceRuntimeRef.current === runtime) ctx.browserVoiceRuntimeRef.current = null
    clearBrowserVoiceRuntimeEventSubscription()
    try {
      await runtime.dispose()
    } catch {}
  }

  async function settleBrowserVoiceTurn(token: number, outcome: BrowserVoiceTurnSettlementOutcome, reason = 'cancelled'): Promise<{ claimed: boolean; succeeded: boolean; current: boolean }> {
    const settlement = ctx.browserVoiceTurnSettlementRef.current
    if (!settlement || settlement.token !== token || settlement.state !== 'open') {
      return { claimed: false, succeeded: true, current: ctx.browserVoiceOperationTokenRef.current === token }
    }
    settlement.state = 'settling'
    settlement.outcome = outcome
    const runtime = ctx.browserVoiceRuntimeRef.current
    if (!runtime) {
      settlement.state = 'settled'
      return { claimed: true, succeeded: true, current: ctx.browserVoiceOperationTokenRef.current === token }
    }
    const run = (async () => {
      try {
        if (outcome === 'complete') await runtime.completeTurn()
        else if (outcome === 'abandon') await runtime.abandonTurn()
        else await runtime.cancel(reason)
        return true
      } catch {
        if (outcome === 'complete') {
          try {
            await runtime.cancel('turn_completed_failed')
          } catch {
            await forceDisposeBrowserVoiceRuntime(runtime)
            return false
          }
        } else {
          await forceDisposeBrowserVoiceRuntime(runtime)
        }
        return false
      }
    })()
    settlement.promise = run
    const succeeded = await run
    if (ctx.browserVoiceTurnSettlementRef.current === settlement) settlement.state = 'settled'
    return { claimed: true, succeeded, current: ctx.browserVoiceOperationTokenRef.current === token }
  }

  async function waitForBrowserVoiceTurnSettlement(token: number): Promise<void> {
    const settlement = ctx.browserVoiceTurnSettlementRef.current
    if (!settlement || settlement.token !== token || !settlement.promise) return
    await settlement.promise.catch(() => false)
  }

  async function waitForSettlingBrowserVoiceTurn(): Promise<void> {
    const settlement = ctx.browserVoiceTurnSettlementRef.current
    if (!settlement || settlement.state !== 'settling' || !settlement.promise) return
    await settlement.promise.catch(() => false)
  }

  async function disposeBrowserVoiceRuntime() {
    const runtime = ctx.browserVoiceRuntimeRef.current
    ctx.browserVoiceRuntimeRef.current = null
    clearBrowserVoiceRuntimeEventSubscription()
    if (!runtime) return
    try {
      await runtime.dispose()
    } catch {}
  }

  async function startBrowserVoiceCapture(sessionId: string): Promise<boolean> {
    const token = ctx.browserVoiceOperationTokenRef.current + 1
    ctx.browserVoiceOperationTokenRef.current = token
    await waitForSettlingBrowserVoiceTurn()
    if (ctx.browserVoiceOperationTokenRef.current !== token) return false
    if (!browserVoiceLifecycleEligibility().eligible) {
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      ctx.setVoiceCaptureStatus('idle')
      return false
    }
    ctx.browserVoiceTurnSettlementRef.current = { token, state: 'open', outcome: null, promise: null }
    ctx.activeVoiceSessionRef.current = sessionId
    ctx.ownedVoiceSessionIdsRef.current.add(sessionId)
    ctx.setVoiceCaptureStatus('listening')
    ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Requesting focused microphone access for push-to-talk…' }))
    try {
      const runtime = await browserVoiceRuntime()
      const started = await runtime.start()
      if (ctx.browserVoiceOperationTokenRef.current !== token) return false
      ctx.activeVoiceSessionRef.current = started.sessionId
      ctx.ownedVoiceSessionIdsRef.current.add(started.sessionId)
      ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Focused microphone capture is active.' }))
      return true
    } catch (error) {
      if (ctx.browserVoiceOperationTokenRef.current !== token) return false
      await cancelBrowserVoiceRuntime('start_failed')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      const nextStatus = voiceCaptureStatusForStartError(error)
      ctx.setLastError(nextStatus === 'idle' ? null : productAudioCaptureErrorCopy(error))
      ctx.setVoiceCaptureStatus(nextStatus)
      return false
    }
  }

  async function stopBrowserVoiceCapture() {
    const runtime = ctx.browserVoiceRuntimeRef.current
    if (!runtime) return
    const token = ctx.browserVoiceOperationTokenRef.current
    ctx.setVoiceCaptureStatus('processing')
    ctx.setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    let captured: AuroraBrowserCapturedAudio = null
    try {
      captured = await runtime.stop()
    } catch (error) {
      if (ctx.browserVoiceOperationTokenRef.current !== token) return
      await cancelBrowserVoiceRuntime('stop_failed')
      ctx.setLastError(productAudioCaptureErrorCopy(error))
      ctx.setVoiceCaptureStatus('error')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      return
    }
    if (ctx.browserVoiceOperationTokenRef.current !== token) {
      await settleBrowserVoiceTurn(token, 'abandon', 'stale_capture')
      return
    }
    if (!captured || captured.sampleCount === 0 || captured.pcm.length === 0) {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'empty_audio')
      if (!settled.current) return
      ctx.setLastError('No microphone audio was captured. Check microphone permission and try push-to-talk again.')
      ctx.setVoiceCaptureStatus('idle')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      return
    }
    let transcript = ctx.readyBrowserSpeechPacks?.capabilities.stt ? ctx.browserVoiceLocalTranscriptRef.current.trim() : ''
    if (!transcript) {
      let result: Awaited<ReturnType<typeof ctx.client.assistant.transcribeVoiceAudio>>
      try {
        result = await ctx.client.assistant.transcribeVoiceAudio({
          audio_data: int16PcmToLittleEndianBase64(captured.pcm),
          format: 'raw',
          sample_rate: 16000,
          channels: 1,
          model: 'accurate',
          routePolicy: ctx.routePolicyFromRoute(ctx.voiceModel.transcriptionRoute)
        })
      } catch (error) {
        const settled = await settleBrowserVoiceTurn(token, 'abandon', 'transcription_failed')
        if (ctx.browserVoiceOperationTokenRef.current !== token) return
        if (!settled.current) return
        ctx.setLastError(ctx.productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
        ctx.setVoiceCaptureStatus('error')
        ctx.activeVoiceSessionRef.current = null
        ctx.ownedVoiceSessionIdsRef.current.clear()
        return
      }
      if (ctx.browserVoiceOperationTokenRef.current !== token) {
        await settleBrowserVoiceTurn(token, 'abandon', 'stale_transcription')
        return
      }
      if (!result.ok) {
        const settled = await settleBrowserVoiceTurn(token, 'abandon', 'transcription_failed')
        if (!settled.current) return
        ctx.setLastError(ctx.productAssistantErrorCopy(result.error))
        ctx.setVoiceCaptureStatus('error')
        ctx.activeVoiceSessionRef.current = null
        ctx.ownedVoiceSessionIdsRef.current.clear()
        return
      }
      transcript = result.data.text.trim()
    }
    if (!transcript) {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'empty_transcription')
      if (!settled.current) return
      ctx.setLastError('No speech was transcribed from the recorded audio.')
      ctx.setVoiceCaptureStatus('idle')
      ctx.activeVoiceSessionRef.current = null
      ctx.ownedVoiceSessionIdsRef.current.clear()
      return
    }
    ctx.voiceTranscriptPreviewRef.current = ''
    ctx.setText('')
    let succeeded = false
    try {
      succeeded = await ctx.startAssistantTurn(transcript)
    } catch (error) {
      if (ctx.browserVoiceOperationTokenRef.current !== token) {
        await settleBrowserVoiceTurn(token, 'abandon', 'stale_assistant')
        return
      }
      ctx.setLastError(ctx.productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
      succeeded = false
    }
    if (ctx.browserVoiceOperationTokenRef.current !== token) {
      await settleBrowserVoiceTurn(token, 'abandon', 'stale_assistant')
      return
    }
    if (succeeded) {
      const completed = await settleBrowserVoiceTurn(token, 'complete')
      if (!completed.current) return
      if (completed.succeeded) {
        ctx.setVoiceCaptureStatus('idle')
      } else {
        ctx.setLastError('Voice request finished, but Aurora could not close listening cleanly.')
        ctx.setVoiceCaptureStatus('error')
      }
    } else {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'assistant_failed')
      if (!settled.current) return
      ctx.setVoiceCaptureStatus('error')
    }
    ctx.activeVoiceSessionRef.current = null
    ctx.ownedVoiceSessionIdsRef.current.clear()
  }

  return {
    browserVoiceRuntime,
    cancelBrowserVoiceRuntime,
    clearBrowserVoiceRuntimeEventSubscription,
    disposeBrowserVoiceRuntime,
    releaseBrowserVoiceCaptureForLifecycle,
    releaseBrowserVoiceCaptureForReason,
    cancelBrowserVoiceCaptureForReason,
    settleBrowserVoiceTurn,
    waitForBrowserVoiceTurnSettlement,
    startBrowserVoiceCapture,
    stopBrowserVoiceCapture,
  }
}

export type BrowserCaptureController = ReturnType<typeof createBrowserCaptureController>
