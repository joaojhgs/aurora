import { AuroraOverlayShell, type AuroraOverlayLevel, type AuroraOverlayMessage, type AuroraOverlayMode, type AuroraVoiceOverlayState } from '@aurora/ui'
import { normalizeVoiceRuntimeEvent, type AssistantStreamUpdate, type AuroraEvent, type AuroraEventSubscription, type VoiceRuntimeEvent } from '@aurora/client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import owlSrc from './assets/aurora-owl.png'
import { createAuroraTauriRuntime } from './aurora-client'

const DEFAULT_HOTKEY = 'CommandOrControl+K'
const ERROR_HIDE_MS = 1_800
const CONFIG_RETRY_MS = 1_000
const INPUT_FALLBACK_LEVEL = 0.16
const PROCESSING_FALLBACK_LEVEL = 0.12
export const TTS_EVENT_TOPICS = ['TTS.Started', 'TTS.Resumed', 'TTS.AudioChunk', 'TTS.Stopped', 'TTS.Paused', 'TTS.Error'] as const
export const TTS_EVENT_KINDS = ['tts.started', 'tts.resumed', 'tts.audio_chunk', 'tts.audio.chunk', 'tts.chunk', 'tts.stopped', 'tts.paused', 'tts.error'] as const
export const TTS_CHUNK_EVENT_TOPICS = ['TTS.AudioChunk'] as const
export const TTS_CHUNK_EVENT_KINDS = ['tts.audio_chunk', 'tts.audio.chunk', 'tts.chunk'] as const

function passthroughForOverlayMode(mode: AuroraOverlayMode): boolean {
  return mode === 'hidden'
}

type OverlayConfig = {
  enabled: boolean
  voiceEnabled: boolean
  textHotkey: string
  autoCloseDelayMs: number
}

type OverlayConfigLoadResult = { config: OverlayConfig; loaded: boolean }

const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  enabled: true,
  voiceEnabled: true,
  textHotkey: DEFAULT_HOTKEY,
  autoCloseDelayMs: 1_200
}

const EXPLICIT_VOICE_INPUT_REASONS = new Set([
  'wakeword',
  'wakeworddetected',
  'userinput',
  'input',
  'audiostarted',
  'sessionstarted'
])

type VoiceListeningFallbackInput = {
  previousMode: AuroraOverlayMode
  payload: unknown
  activeTtsPlayback: Pick<ActiveTtsPlayback, 'active'>
  voiceState: AuroraVoiceOverlayState
}

export function shouldInitializeVoiceListeningFallback({
  previousMode,
  payload,
  activeTtsPlayback,
  voiceState
}: VoiceListeningFallbackInput): boolean {
  if (activeTtsPlayback.active || voiceState === 'speaking') return false
  if (hasExplicitVoiceInputReason(payload)) return true
  return previousMode !== 'voice' && voiceState !== 'processing'
}

export function AuroraOverlayApp() {
  const runtime = useMemo(() => createAuroraTauriRuntime(), [])
  const [mode, setMode] = useState<AuroraOverlayMode>('hidden')
  const [voiceState, setVoiceState] = useState<AuroraVoiceOverlayState>('listening')
  const [level, setLevel] = useState<AuroraOverlayLevel | null>(null)
  const [messages, setMessages] = useState<AuroraOverlayMessage[]>([])
  const [thinking, setThinking] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [overlayConfig, setOverlayConfig] = useState<OverlayConfig>(DEFAULT_OVERLAY_CONFIG)
  const overlayConfigRef = useRef<OverlayConfig>(DEFAULT_OVERLAY_CONFIG)
  const hideTimerRef = useRef<number | null>(null)
  const messageAbortRef = useRef<AbortController | null>(null)
  const modeRef = useRef<AuroraOverlayMode>('hidden')
  const voiceStateRef = useRef<AuroraVoiceOverlayState>('listening')
  const activeVoiceSessionRef = useRef<ActiveVoiceSession>({ active: false, sessionId: null, correlationId: null })
  const activeTtsPlaybackRef = useRef<ActiveTtsPlayback>({ active: false })

  useEffect(() => {
    voiceStateRef.current = voiceState
  }, [voiceState])

  useEffect(() => {
    overlayConfigRef.current = overlayConfig
  }, [overlayConfig])

  const setTrackedVoiceState = useCallback((state: AuroraVoiceOverlayState) => {
    voiceStateRef.current = state
    setVoiceState(state)
  }, [])

  const setOverlayPassthrough = useCallback((enabled: boolean) => {
    void runtime.overlaySetPassthrough?.(enabled)
  }, [runtime])

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const applyOverlayMode = useCallback((nextMode: AuroraOverlayMode) => {
    clearHideTimer()
    modeRef.current = nextMode
    setMode(nextMode)
    setOverlayPassthrough(passthroughForOverlayMode(nextMode))
    if (nextMode === 'hidden') {
      setLevel(null)
    }
  }, [clearHideTimer, setOverlayPassthrough])

  const requestShowOverlay = useCallback((nextMode: Exclude<AuroraOverlayMode, 'hidden'>) => {
    const currentConfig = overlayConfigRef.current
    if (!currentConfig.enabled || (nextMode === 'voice' && !currentConfig.voiceEnabled)) return
    applyOverlayMode(nextMode)
    void runtime.overlayShow?.(nextMode)
  }, [applyOverlayMode, runtime])

  const requestHideOverlay = useCallback(() => {
    applyOverlayMode('hidden')
    void runtime.overlayHide?.()
  }, [applyOverlayMode, runtime])

  const hideLater = useCallback((delayMs?: number) => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => {
      requestHideOverlay()
    }, delayMs ?? overlayConfigRef.current.autoCloseDelayMs)
  }, [clearHideTimer, requestHideOverlay])

  const applyLoadedOverlayConfig = useCallback((config: OverlayConfig) => {
    overlayConfigRef.current = config
    setOverlayConfig(config)
    if (config.enabled) {
      void runtime.overlayRegisterHotkey?.(config.textHotkey)
    } else {
      void runtime.overlayUnregisterHotkey?.()
      if (modeRef.current !== 'hidden') requestHideOverlay()
    }
  }, [requestHideOverlay, runtime])

  useEffect(() => {
    let disposed = false
    let retryTimer: number | null = null

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
        retryTimer = null
      }
    }

    const reloadAndApplyConfig = async (retryIfUnavailable: boolean) => {
      const result = await loadOverlayConfig(runtime.client)
      if (disposed) return
      clearRetryTimer()
      if (result.loaded) {
        applyLoadedOverlayConfig(result.config)
      } else if (retryIfUnavailable) {
        retryTimer = window.setTimeout(() => {
          void reloadAndApplyConfig(true)
        }, CONFIG_RETRY_MS)
      }
    }

    void reloadAndApplyConfig(true)

    return () => {
      disposed = true
      clearRetryTimer()
    }
  }, [applyLoadedOverlayConfig, runtime])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const subscription = runtime.client.events.watchConfig<Record<string, unknown>>({
      kinds: ['config.updated', 'config.reload'],
      signal: controller.signal
    })

    const reloadAndApplyConfig = async () => {
      const result = await loadOverlayConfig(runtime.client)
      if (!disposed && result.loaded) applyLoadedOverlayConfig(result.config)
    }

    void (async () => {
      try {
        for await (const event of subscription) {
          if (disposed) return
          if (shouldReloadOverlayConfig(event)) {
            void reloadAndApplyConfig()
          }
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted) console.warn('Aurora overlay config watch failed', error)
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      subscription.close('overlay-config-watch-unmount')
      setOverlayPassthrough(true)
      clearHideTimer()
      messageAbortRef.current?.abort()
    }
  }, [applyLoadedOverlayConfig, clearHideTimer, runtime, setOverlayPassthrough])

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    const listenOverlayMode = runtime.listenOverlayMode ?? (async () => () => undefined)
    listenOverlayMode((payload) => {
      if (disposed) return
      const requestedMode = readOverlayMode(payload)
      if (requestedMode === 'hidden') {
        applyOverlayMode('hidden')
      } else if (requestedMode === 'voice' || requestedMode === 'text') {
        const currentConfig = overlayConfigRef.current
        if (!currentConfig.enabled || (requestedMode === 'voice' && !currentConfig.voiceEnabled)) {
          requestHideOverlay()
          return
        }
        const previousMode = modeRef.current
        applyOverlayMode(requestedMode)
        if (requestedMode === 'voice' && shouldInitializeVoiceListeningFallback({
          previousMode,
          payload,
          activeTtsPlayback: activeTtsPlaybackRef.current,
          voiceState: voiceStateRef.current
        })) {
          setTrackedVoiceState('listening')
          setLevel(inputFallbackLevel())
        }
      }
    }).then((dispose) => {
      if (disposed) {
        dispose()
      } else {
        unsubscribe = dispose
      }
    }).catch(() => {
      unsubscribe = null
    })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [applyOverlayMode, requestHideOverlay, runtime, setTrackedVoiceState])

  useEffect(() => {
    let disposed = false
    void runtime.overlayStatus?.().then((status) => {
      if (disposed || !status) return
      if (status.visible && (status.mode === 'voice' || status.mode === 'text')) {
        const currentConfig = overlayConfigRef.current
        if (!currentConfig.enabled || (status.mode === 'voice' && !currentConfig.voiceEnabled)) {
          requestHideOverlay()
          return
        }
        const previousMode = modeRef.current
        applyOverlayMode(status.mode)
        if (status.mode === 'voice' && shouldInitializeVoiceListeningFallback({
          previousMode,
          payload: status,
          activeTtsPlayback: activeTtsPlaybackRef.current,
          voiceState: voiceStateRef.current
        })) {
          setTrackedVoiceState('listening')
          setLevel(inputFallbackLevel())
        }
      } else {
        applyOverlayMode('hidden')
      }
    })
    return () => {
      disposed = true
    }
  }, [applyOverlayMode, requestHideOverlay, runtime, setTrackedVoiceState])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of runtime.client.assistant.streamVoiceEvents({ signal: controller.signal })) {
          applyVoiceRuntimeEvent(event, {
            showOverlay: requestShowOverlay,
            hideLater,
            setVoiceState: setTrackedVoiceState,
            setLevel,
            getVoiceState: () => voiceStateRef.current,
            activeVoiceSession: activeVoiceSessionRef.current,
            activeTtsPlayback: activeTtsPlaybackRef.current
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setTrackedVoiceState('error')
          requestShowOverlay('voice')
          hideLater(ERROR_HIDE_MS)
          console.warn('Aurora overlay voice event stream failed', error)
        }
      }
    })()
    return () => controller.abort()
  }, [hideLater, runtime, requestShowOverlay, setTrackedVoiceState])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const update of runtime.client.assistant.streamVoiceAssistantResponses({ signal: controller.signal })) {
          applyVoiceAssistantUpdate(update, {
            showOverlay: requestShowOverlay,
            hideLater,
            setVoiceState: setTrackedVoiceState,
            setLevel,
            activeTtsPlayback: activeTtsPlaybackRef.current
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setTrackedVoiceState('error')
          requestShowOverlay('voice')
          hideLater(ERROR_HIDE_MS)
          console.warn('Aurora overlay voice assistant stream failed', error)
        }
      }
    })()
    return () => controller.abort()
  }, [hideLater, runtime, requestShowOverlay, setTrackedVoiceState])

  useEffect(() => {
    const controller = new AbortController()
    const directTtsOptions = {
      topics: [...TTS_EVENT_TOPICS],
      kinds: [...TTS_EVENT_KINDS],
      reconnect: { maxAttempts: 120, initialDelayMs: 250, maxDelayMs: 2000 },
      signal: controller.signal
    }
    const directTtsChunkOptions = {
      topics: [...TTS_CHUNK_EVENT_TOPICS],
      kinds: [...TTS_CHUNK_EVENT_KINDS],
      reconnect: { maxAttempts: 120, initialDelayMs: 250, maxDelayMs: 2000 },
      signal: controller.signal
    }
    const subscriptions: Array<AuroraEventSubscription<Record<string, unknown>>> = []

    const consumeDirectTtsStream = async (subscription: AuroraEventSubscription<Record<string, unknown>>, label: string) => {
      try {
        for await (const event of subscription) {
          applyDirectTtsEvent(event, {
            showOverlay: requestShowOverlay,
            hideLater,
            setVoiceState: setTrackedVoiceState,
            setLevel,
            activeTtsPlayback: activeTtsPlaybackRef.current
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`Aurora overlay direct ${label} TTS event stream failed`, error)
      }
    }

    const startDirectTtsStream = (
      label: string,
      createSubscription: () => AuroraEventSubscription<Record<string, unknown>>
    ) => {
      try {
        const subscription = createSubscription()
        subscriptions.push(subscription)
        void consumeDirectTtsStream(subscription, label)
      } catch (error) {
        if (!controller.signal.aborted) console.warn(`Aurora overlay direct ${label} TTS event stream unavailable`, error)
      }
    }

    startDirectTtsStream('voice', () => runtime.client.events.subscribe<Record<string, unknown>>({
      stream: 'voice',
      ...directTtsOptions
    }))
    startDirectTtsStream('default', () => runtime.client.events.subscribe<Record<string, unknown>>(directTtsOptions))
    startDirectTtsStream('assistant', () => runtime.client.events.streamAssistant<Record<string, unknown>, unknown>(undefined, directTtsOptions))
    startDirectTtsStream('chunk', () => runtime.client.events.streamAssistant<Record<string, unknown>, unknown>(undefined, directTtsChunkOptions))

    return () => {
      controller.abort()
      subscriptions.forEach((subscription) => subscription.close('overlay-direct-tts-unmount'))
    }
  }, [hideLater, runtime, requestShowOverlay, setTrackedVoiceState])

  const submitText = useCallback((text: string) => {
    const userId = `user-${Date.now()}`
    const assistantId = `assistant-${Date.now()}`
    setMessages((current) => [...current, { id: userId, role: 'user', text }, { id: assistantId, role: 'assistant', text: '' }])
    setThinking(true)
    messageAbortRef.current?.abort()
    const controller = new AbortController()
    messageAbortRef.current = controller

    void (async () => {
      try {
        for await (const update of runtime.client.assistant.streamMessage({ text, signal: controller.signal })) {
          setThinking(false)
          if (update.kind === 'failed' || update.kind === 'transport_lost') {
            const errorText = update.error?.message ?? update.text ?? 'Aurora could not complete that request.'
            setMessages((current) => updateAssistantMessage(current, assistantId, errorText, false))
            break
          }
          if (update.kind === 'completed' || update.kind === 'fallback') {
            if (update.text) {
              setMessages((current) => updateAssistantMessage(current, assistantId, update.text, false))
            }
            break
          }
          if (update.textDelta || update.text) {
            setMessages((current) => updateAssistantMessage(current, assistantId, update.textDelta || update.text, true))
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setMessages((current) => updateAssistantMessage(current, assistantId, 'Aurora could not complete that request.', false))
          console.warn('Aurora overlay text stream failed', error)
        }
      } finally {
        if (messageAbortRef.current === controller) messageAbortRef.current = null
        setThinking(false)
      }
    })()
  }, [runtime])

  return (
    <AuroraOverlayShell
      mode={mode}
      owlSrc={owlSrc}
      voiceState={voiceState}
      level={level}
      messages={messages}
      thinking={thinking}
      pinned={pinned}
      onCloseVoice={requestHideOverlay}
      onCloseText={requestHideOverlay}
      onTextSubmit={submitText}
      onVoiceClick={() => {
        clearActiveTtsPlayback(activeTtsPlaybackRef.current)
        requestShowOverlay('voice')
        setTrackedVoiceState('listening')
        setLevel(inputFallbackLevel())
      }}
      onTogglePin={() => setPinned((current) => !current)}
      onPointerPassthroughChange={setOverlayPassthrough}
      onStartDrag={() => runtime.overlayStartDrag?.()}
      onMoveBy={(dx, dy) => runtime.overlayMoveBy?.(dx, dy)}
    />
  )
}

type VoiceRuntimeSinks = {
  showOverlay: (mode: 'voice' | 'text') => void
  hideLater: (delayMs?: number) => void
  setVoiceState: (state: AuroraVoiceOverlayState) => void
  setLevel: (level: AuroraOverlayLevel | null) => void
  getVoiceState: () => AuroraVoiceOverlayState
  activeVoiceSession: ActiveVoiceSession
  activeTtsPlayback: ActiveTtsPlayback
}

export function applyVoiceRuntimeEvent(event: VoiceRuntimeEvent, sinks: VoiceRuntimeSinks) {
  const ttsSpeakingIsAuthoritative = () => sinks.activeTtsPlayback.active || sinks.getVoiceState() === 'speaking'

  if (event.kind === 'wakeword_detected') {
    if (ttsSpeakingIsAuthoritative()) return
    markActiveVoiceSession(sinks.activeVoiceSession, event)
    sinks.showOverlay('voice')
    sinks.setVoiceState('listening')
    sinks.setLevel(inputFallbackLevel())
    return
  }

  if (event.kind === 'audio_level') {
    if (!isActiveVoiceSessionEvent(sinks.activeVoiceSession, event)) return
    if (ttsSpeakingIsAuthoritative()) return
    sinks.showOverlay('voice')
    sinks.setVoiceState('listening')
    sinks.setLevel(inputLevelFromVoiceEvent(event))
    return
  }

  if (event.kind === 'session_started' || event.kind === 'audio_started') {
    if (ttsSpeakingIsAuthoritative()) return
    markActiveVoiceSession(sinks.activeVoiceSession, event)
    sinks.showOverlay('voice')
    sinks.setVoiceState('listening')
    sinks.setLevel(inputFallbackLevel())
    return
  }

  if (event.kind === 'transcription_partial' || event.kind === 'transcription_final') {
    markActiveVoiceSession(sinks.activeVoiceSession, event)
    if (sinks.activeTtsPlayback.active) return
    sinks.showOverlay('voice')
    sinks.setVoiceState('processing')
    sinks.setLevel(inputFallbackLevel(PROCESSING_FALLBACK_LEVEL))
    return
  }

  if (
    event.kind === 'tts_started'
    || event.kind === 'tts_resumed'
    || (event.kind as string) === 'tts_audio_chunk'
  ) {
    markActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('speaking')
    sinks.setLevel(outputLevelFromVoiceEvent(event))
    return
  }

  if (event.kind === 'tts_paused') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('muted')
    return
  }

  if (event.kind === 'stt_error' || event.kind === 'tts_error' || event.kind === 'audio_denied' || event.kind === 'audio_disconnected' || event.kind === 'audio_cancelled') {
    if (event.kind !== 'tts_error' && sinks.activeTtsPlayback.active) return
    if (event.kind === 'tts_error') clearActiveTtsPlayback(sinks.activeTtsPlayback)
    clearActiveVoiceSession(sinks.activeVoiceSession, event)
    sinks.showOverlay('voice')
    sinks.setVoiceState('error')
    sinks.hideLater(ERROR_HIDE_MS)
    return
  }

  if (event.kind === 'tts_stopped' || event.kind === 'session_ended' || event.kind === 'audio_stopped' || event.kind === 'stt_timeout') {
    if (event.kind === 'tts_stopped') {
      clearActiveTtsPlayback(sinks.activeTtsPlayback)
      sinks.hideLater()
      return
    }
    clearActiveVoiceSession(sinks.activeVoiceSession, event)
    if (sinks.activeTtsPlayback.active) return
    sinks.hideLater()
  }
}

function inputFallbackLevel(level = INPUT_FALLBACK_LEVEL): AuroraOverlayLevel {
  return { level: clampAudioLevel(level), peak: clampAudioLevel(level * 1.35), source: 'synthetic' }
}

function inputLevelFromVoiceEvent(event: VoiceRuntimeEvent): AuroraOverlayLevel {
  return overlayLevelFromVoiceEvent(event, 'input')
}

function outputLevelFromVoiceEvent(event: VoiceRuntimeEvent): AuroraOverlayLevel {
  return overlayLevelFromVoiceEvent(
    event,
    'output',
    deterministicPulse(
      [
        event.id,
        event.kind,
        event.sessionId,
        event.correlationId,
        event.occurredAt
      ].filter(Boolean).join(':'),
      0.48,
      0.92
    )
  )
}

function overlayLevelFromVoiceEvent(
  event: VoiceRuntimeEvent,
  source: AuroraOverlayLevel['source'],
  fallbackLevel = 0
): AuroraOverlayLevel {
  const level = normalizeAudioValue(event.level)
  const peak = normalizeAudioValue(event.peak)
  const bars = normalizeAudioBars(event.bars)
  const measured = level !== null || peak !== null || bars !== null
  return {
    level: level ?? peak ?? averageNormalizedBars(bars) ?? clampAudioLevel(fallbackLevel),
    ...(peak !== null ? { peak } : {}),
    ...(bars !== null ? { bars } : {}),
    source: measured ? source : 'synthetic'
  }
}

function outputLevelFromTtsChunk(update: AssistantStreamUpdate): AuroraOverlayLevel {
  const chunk = update.ttsAudio
  const measured = outputLevelFromPayload({ audioData: chunk?.audioData ?? null })
  if (measured) return measured

  const sequence = chunk?.sequence ?? 0
  const durationMs = chunk?.durationMs ?? 0
  const audioLength = chunk?.audioData?.length ?? 0
  const seed = [
    update.eventId,
    chunk?.chunkId,
    sequence,
    durationMs,
    audioLength
  ].filter((part) => part !== null && part !== undefined).join(':')
  const structuralPulse = 0.44
    + (Math.abs(Math.sin((sequence + 1) * 1.37)) * 0.18)
    + (durationMs > 0 ? Math.min(0.18, durationMs / 1_800) : 0)
    + (audioLength > 0 ? Math.min(0.18, (audioLength % 2_048) / 5_800) : 0)
  return {
    level: clampAudioLevel(structuralPulse + deterministicPulse(seed, 0, 0.18)),
    source: 'synthetic'
  }
}


type DirectTtsSinks = {
  showOverlay: (mode: 'voice' | 'text') => void
  hideLater: (delayMs?: number) => void
  setVoiceState: (state: AuroraVoiceOverlayState) => void
  setLevel: (level: AuroraOverlayLevel | null) => void
  activeTtsPlayback: ActiveTtsPlayback
}

export function applyDirectTtsEvent(event: AuroraEvent<Record<string, unknown>>, sinks: DirectTtsSinks) {
  const payload = directEventPayload(event)
  const topic = event.topic ?? event.busTopic ?? event.method ?? readStringValue(payload, 'topic', 'bus_topic', 'busTopic')
  const kind = ttsEventKind(event.kind, topic, readStringValue(payload, 'kind', 'event_kind', 'eventKind', 'type'))
  if (!kind) {
    const normalized = normalizeVoiceRuntimeEvent(event)
    if (normalized) applyDirectTtsRuntimeEvent(normalized, sinks)
    return
  }

  if (kind === 'audio_chunk') {
    markActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('speaking')
    sinks.setLevel(outputLevelFromPayload(payload) ?? outputSyntheticLevelFromPayload(event, payload))
    return
  }

  if (kind === 'started' || kind === 'resumed') {
    markActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('speaking')
    sinks.setLevel(outputLevelFromPayload(payload) ?? outputSyntheticLevelFromPayload(event, payload))
    return
  }

  if (kind === 'paused') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('muted')
    return
  }

  if (kind === 'error') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('error')
    sinks.hideLater(ERROR_HIDE_MS)
    return
  }

  if (kind === 'stopped') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.hideLater()
  }
}

function applyDirectTtsRuntimeEvent(event: VoiceRuntimeEvent, sinks: DirectTtsSinks) {
  if (event.kind === 'tts_started' || event.kind === 'tts_resumed' || (event.kind as string) === 'tts_audio_chunk') {
    markActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('speaking')
    sinks.setLevel(outputLevelFromVoiceEvent(event))
    return
  }
  if (event.kind === 'tts_paused') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('muted')
    return
  }
  if (event.kind === 'tts_error') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('error')
    sinks.hideLater(ERROR_HIDE_MS)
    return
  }
  if (event.kind === 'tts_stopped') {
    clearActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.hideLater()
  }
}

function ttsEventKind(kind: string, topic: string | null | undefined, payloadKind: string | null): 'started' | 'resumed' | 'audio_chunk' | 'stopped' | 'paused' | 'error' | null {
  const key = `${kind} ${topic ?? ''} ${payloadKind ?? ''}`.toLowerCase().replace(/[_.-]/g, '')
  if (!key.includes('tts')) return null
  if (key.includes('audiochunk') || key.includes('chunk')) return 'audio_chunk'
  if (key.includes('started')) return 'started'
  if (key.includes('resumed')) return 'resumed'
  if (key.includes('stopped')) return 'stopped'
  if (key.includes('paused')) return 'paused'
  if (key.includes('error')) return 'error'
  return null
}

function directEventPayload(event: AuroraEvent<Record<string, unknown>>): Record<string, unknown> {
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}
  const redacted = readObject(payload.redacted_payload) ?? readObject(payload.redactedPayload)
  return redacted ? { ...payload, ...redacted } : payload
}

function outputLevelFromPayload(payload: Record<string, unknown>): AuroraOverlayLevel | null {
  const direct = overlayLevelFromPayload(payload, 'output')
  if (direct) return direct

  const audioValue = firstDefinedPayloadValue(payload, 'audioData', 'audio_data', 'audio', 'chunk', 'pcm', 'data')
  const encoded = typeof audioValue === 'string' ? audioValue : null
  if (encoded) {
    const measured = levelFromEncodedTtsAudio(encoded)
    if (measured) return measured
  }
  const numericSamples = numericArrayValue(audioValue)
  if (numericSamples) return levelFromNumericSamples(numericSamples)
  return null
}

function overlayLevelFromPayload(payload: Record<string, unknown>, source: AuroraOverlayLevel['source']): AuroraOverlayLevel | null {
  const level = normalizeAudioValue(readNumberValue(payload, 'level', 'rms', 'audio_level', 'audioLevel'))
  const peak = normalizeAudioValue(readNumberValue(payload, 'peak', 'peak_level', 'peakLevel'))
  const bars = normalizeAudioBars(readNumberArrayValue(payload, 'bars', 'waveform', 'waveformBars'))
  if (level === null && peak === null && bars === null) return null
  return {
    level: level ?? peak ?? averageNormalizedBars(bars) ?? 0,
    ...(peak !== null ? { peak } : {}),
    ...(bars !== null ? { bars } : {}),
    source
  }
}

function outputSyntheticLevelFromPayload(event: AuroraEvent<unknown>, payload: Record<string, unknown>): AuroraOverlayLevel {
  const sequence = readNumberValue(payload, 'sequence', 'seq', 'index') ?? 0
  const durationMs = readNumberValue(payload, 'duration_ms', 'durationMs') ?? 0
  const audioValue = firstDefinedPayloadValue(payload, 'audioData', 'audio_data', 'audio', 'chunk', 'pcm', 'data')
  const audioLength = typeof audioValue === 'string' ? audioValue.length : Array.isArray(audioValue) ? audioValue.length : 0
  const seed = [event.id, event.kind, event.topic, event.busTopic, sequence, durationMs, audioLength].filter((part) => part !== null && part !== undefined).join(':')
  return {
    level: clampAudioLevel(0.48 + deterministicPulse(seed, 0, 0.34) + (durationMs > 0 ? Math.min(0.12, durationMs / 2_000) : 0)),
    source: 'synthetic'
  }
}

function levelFromEncodedTtsAudio(audioData: string | null): AuroraOverlayLevel | null {
  const bytes = decodeBase64Bytes(audioData)
  if (!bytes || bytes.length < 2) return null
  return levelFromPcmSamples(readPcmSamples(bytes))
}

function decodeBase64Bytes(audioData: string | null): Uint8Array | null {
  if (!audioData) return null
  const normalized = audioData
    .replace(/^data:[^,]*,/i, '')
    .replace(/\s/g, '')
  if (!normalized) return null
  try {
    const binary = window.atob(normalized)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index) & 0xff
    }
    return bytes
  } catch {
    return null
  }
}

type PcmSamples = {
  samples: Float32Array
  channels: number
}

function readPcmSamples(bytes: Uint8Array): PcmSamples | null {
  const wav = readWavPcmSamples(bytes)
  if (wav) return wav
  return readRawPcm16Samples(bytes)
}

function readWavPcmSamples(bytes: Uint8Array): PcmSamples | null {
  if (bytes.length < 44 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let audioFormat = 0
  let channels = 1
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkDataOffset = offset + 8
    if (chunkDataOffset + chunkSize > bytes.length) break

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      audioFormat = view.getUint16(chunkDataOffset, true)
      channels = Math.max(1, view.getUint16(chunkDataOffset + 2, true))
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset
      dataLength = chunkSize
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2)
  }

  if (audioFormat !== 1 || dataOffset < 0 || dataLength <= 0 || bitsPerSample !== 16) return null
  return readPcm16Samples(bytes, dataOffset, dataLength, channels)
}

function readRawPcm16Samples(bytes: Uint8Array): PcmSamples | null {
  return readPcm16Samples(bytes, 0, bytes.length - (bytes.length % 2), 1)
}

function readPcm16Samples(bytes: Uint8Array, offset: number, length: number, channels: number): PcmSamples | null {
  const sampleCount = Math.floor(length / 2)
  if (sampleCount <= 0 || offset < 0 || offset + sampleCount * 2 > bytes.length) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, sampleCount * 2)
  const samples = new Float32Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = clampAudioLevel(Math.abs(view.getInt16(index * 2, true) / 32768))
  }
  return { samples, channels }
}

function levelFromPcmSamples(pcm: PcmSamples | null): AuroraOverlayLevel | null {
  if (!pcm || pcm.samples.length === 0) return null
  let peak = 0
  let sumSquares = 0
  for (const sample of pcm.samples) {
    peak = Math.max(peak, sample)
    sumSquares += sample * sample
  }
  return {
    level: clampAudioLevel(Math.sqrt(sumSquares / pcm.samples.length)),
    peak: clampAudioLevel(peak),
    bars: pcmBars(pcm.samples),
    source: 'output'
  }
}

function pcmBars(samples: Float32Array, segmentCount = 16): number[] {
  const bars: number[] = []
  const segmentSize = Math.max(1, Math.ceil(samples.length / segmentCount))
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = segment * segmentSize
    const end = Math.min(samples.length, start + segmentSize)
    if (start >= end) {
      bars.push(0)
      continue
    }
    let sumSquares = 0
    for (let index = start; index < end; index += 1) {
      sumSquares += samples[index] * samples[index]
    }
    bars.push(clampAudioLevel(Math.sqrt(sumSquares / (end - start))))
  }
  return bars
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return ''
  let value = ''
  for (let index = offset; index < offset + length; index += 1) value += String.fromCharCode(bytes[index])
  return value
}

function processingLevelFromAssistantUpdate(update: AssistantStreamUpdate): AuroraOverlayLevel {
  const seed = [
    update.eventId,
    update.messageId,
    update.kind,
    update.textDelta.length,
    update.tool?.id,
    update.tool?.status
  ].filter((part) => part !== null && part !== undefined).join(':')
  return {
    level: deterministicPulse(seed, PROCESSING_FALLBACK_LEVEL, 0.28),
    source: 'synthetic'
  }
}

function normalizeAudioValue(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clampAudioLevel(value > 1 ? value / 100 : value)
}

function normalizeAudioBars(bars: number[] | null | undefined): number[] | null {
  if (!Array.isArray(bars)) return null
  const normalized = bars
    .map(normalizeAudioValue)
    .filter((value): value is number => value !== null)
  return normalized.length > 0 ? normalized : null
}

function averageNormalizedBars(bars: number[] | null | undefined): number | null {
  const normalized = Array.isArray(bars) ? bars : normalizeAudioBars(bars)
  if (!normalized) return null
  return clampAudioLevel(normalized.reduce((sum, value) => sum + value, 0) / normalized.length)
}

function deterministicPulse(seed: string, min = 0.36, max = 0.82): number {
  const range = Math.max(0, max - min)
  return clampAudioLevel(min + hashUnit(seed || 'aurora-overlay') * range)
}

function hashUnit(seed: string): number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function clampAudioLevel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

type ActiveVoiceSession = {
  active: boolean
  sessionId: string | null
  correlationId: string | null
}

type ActiveTtsPlayback = {
  active: boolean
}

function markActiveVoiceSession(active: ActiveVoiceSession, event: VoiceRuntimeEvent) {
  active.active = true
  if (event.sessionId) active.sessionId = event.sessionId
  if (event.correlationId) active.correlationId = event.correlationId
}

function clearActiveVoiceSession(active: ActiveVoiceSession, event: VoiceRuntimeEvent) {
  if (!event.sessionId && !event.correlationId) {
    active.active = false
    active.sessionId = null
    active.correlationId = null
    return
  }
  if (isActiveVoiceSessionEvent(active, event)) {
    active.active = false
    active.sessionId = null
    active.correlationId = null
  }
}

function isActiveVoiceSessionEvent(active: ActiveVoiceSession, event: VoiceRuntimeEvent): boolean {
  if (!active.active) return false
  if (event.sessionId && active.sessionId) return event.sessionId === active.sessionId
  if (event.correlationId && active.correlationId) return event.correlationId === active.correlationId
  return !event.sessionId && !event.correlationId
}

function markActiveTtsPlayback(active: ActiveTtsPlayback) {
  active.active = true
}

function clearActiveTtsPlayback(active: ActiveTtsPlayback) {
  active.active = false
}

type AssistantUpdateSinks = {
  showOverlay: (mode: 'voice' | 'text') => void
  hideLater: (delayMs?: number) => void
  setVoiceState: (state: AuroraVoiceOverlayState) => void
  setLevel: (level: AuroraOverlayLevel | null) => void
  activeTtsPlayback: ActiveTtsPlayback
}

export function applyVoiceAssistantUpdate(update: AssistantStreamUpdate, sinks: AssistantUpdateSinks) {
  if (update.kind === 'tts_audio_chunk') {
    markActiveTtsPlayback(sinks.activeTtsPlayback)
    sinks.showOverlay('voice')
    sinks.setVoiceState('speaking')
    sinks.setLevel(outputLevelFromTtsChunk(update))
    return
  }
  if (update.kind === 'delta' || update.kind === 'tool') {
    if (sinks.activeTtsPlayback.active) return
    sinks.showOverlay('voice')
    sinks.setVoiceState('processing')
    sinks.setLevel(processingLevelFromAssistantUpdate(update))
    return
  }
  if (update.kind === 'failed' || update.kind === 'transport_lost') {
    if (sinks.activeTtsPlayback.active) return
    sinks.showOverlay('voice')
    sinks.setVoiceState('error')
    sinks.hideLater(ERROR_HIDE_MS)
    return
  }
  if (update.kind === 'completed' || update.kind === 'fallback') {
    if (sinks.activeTtsPlayback.active) return
    sinks.showOverlay('voice')
    sinks.setVoiceState('processing')
    sinks.setLevel(processingLevelFromAssistantUpdate(update))
    sinks.hideLater()
  }
}

function updateAssistantMessage(
  messages: AuroraOverlayMessage[],
  id: string,
  text: string,
  append: boolean
): AuroraOverlayMessage[] {
  return messages.map((message) => {
    if (message.id !== id) return message
    return {
      ...message,
      text: append ? `${message.text ?? ''}${text}` : text
    }
  })
}

function readOverlayMode(payload: unknown): AuroraOverlayMode | null {
  if (typeof payload === 'string') {
    if (payload === 'voice' || payload === 'text' || payload === 'hidden') return payload
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const mode = 'mode' in payload ? (payload as { mode?: unknown }).mode : null
  if (mode === 'voice' || mode === 'text' || mode === 'hidden') return mode
  return null
}

function hasExplicitVoiceInputReason(payload: unknown): boolean {
  const data = readObject(payload)
  if (!data) return false
  const reason = readStringValue(data, 'reason', 'event_kind', 'eventKind', 'kind', 'type', 'source')
  if (!reason) return false
  return EXPLICIT_VOICE_INPUT_REASONS.has(normalizeVoiceInputReason(reason))
}

function normalizeVoiceInputReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/[\s_.-]+/g, '')
}

function shouldReloadOverlayConfig(event: { kind?: string; topic?: string | null; busTopic?: string | null; payload?: unknown }): boolean {
  if (event.kind === 'config.reload') return true
  const topic = event.topic ?? event.busTopic
  if (topic && topic !== 'Config.Updated' && topic !== 'config.updated') return false
  if (event.kind && event.kind !== 'config.updated') return true

  const payload = readObject(event.payload)
  if (!payload) return true

  const candidateKeys = [
    payload.key_path,
    payload.keyPath,
    payload.key,
    payload.path,
    payload.section,
    payload.config_section,
    payload.configSection
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  const affectedSections = readStringArray(payload.affected_sections) ?? readStringArray(payload.affectedSections)
  if (affectedSections) candidateKeys.push(...affectedSections)

  if (candidateKeys.length === 0) return true
  return candidateKeys.some(isOverlayConfigPath)
}

function isOverlayConfigPath(path: string): boolean {
  const normalized = path.trim()
  return normalized === 'ui'
    || normalized === 'ui.desktop_overlay'
    || normalized.startsWith('ui.desktop_overlay.')
    || 'ui.desktop_overlay'.startsWith(`${normalized}.`)
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return strings.length > 0 ? strings : null
}

function firstDefinedPayloadValue(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = payload[key]
    if (value !== undefined && value !== null) return value
  }
  return null
}

function readNumberValue(payload: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function readNumberArrayValue(payload: Record<string, unknown>, ...keys: string[]): number[] | null {
  for (const key of keys) {
    const normalized = numericArrayValue(payload[key])
    if (normalized) return normalized
  }
  return null
}

function numericArrayValue(value: unknown): number[] | null {
  if (!Array.isArray(value) && !(value instanceof Float32Array) && !(value instanceof Uint8Array) && !(value instanceof Int16Array)) return null
  const values = Array.from(value).map((item) => typeof item === 'number' ? item : Number(item)).filter(Number.isFinite)
  return values.length > 0 ? values : null
}

function levelFromNumericSamples(samples: number[]): AuroraOverlayLevel | null {
  if (samples.length === 0) return null
  const normalized = samples.map((value) => normalizeAudioValue(Math.abs(value)) ?? 0)
  let peak = 0
  let sumSquares = 0
  for (const sample of normalized) {
    peak = Math.max(peak, sample)
    sumSquares += sample * sample
  }
  return {
    level: clampAudioLevel(Math.sqrt(sumSquares / normalized.length)),
    peak: clampAudioLevel(peak),
    bars: normalized.slice(0, 16),
    source: 'output'
  }
}

function readStringValue(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  }
  return null
}

function readBooleanValue(payload: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'boolean') return value
  }
  return null
}

async function loadOverlayConfig(client: ReturnType<typeof createAuroraTauriRuntime>['client']): Promise<OverlayConfigLoadResult> {
  try {
    const response = await client.config.get({ section: 'ui' })
    if (!response.ok) return { config: DEFAULT_OVERLAY_CONFIG, loaded: false }
    const config = readObject(response.data.config)
    if (!config) return { config: DEFAULT_OVERLAY_CONFIG, loaded: false }
    const ui = readObject(config.ui) ?? config
    const desktopOverlay = readObject(ui.desktop_overlay)
    if (!desktopOverlay) return { config: DEFAULT_OVERLAY_CONFIG, loaded: true }
    return {
      config: {
        enabled: readBoolean(desktopOverlay?.enabled, DEFAULT_OVERLAY_CONFIG.enabled),
        voiceEnabled: readBoolean(desktopOverlay?.voice_overlay_enabled, DEFAULT_OVERLAY_CONFIG.voiceEnabled),
        textHotkey: readString(desktopOverlay?.text_hotkey, DEFAULT_OVERLAY_CONFIG.textHotkey),
        autoCloseDelayMs: readNonNegativeNumber(desktopOverlay?.auto_close_delay_ms, DEFAULT_OVERLAY_CONFIG.autoCloseDelayMs)
      },
      loaded: true
    }
  } catch (error) {
    console.warn('Aurora overlay config unavailable; retrying before registering hotkey', error)
    return { config: DEFAULT_OVERLAY_CONFIG, loaded: false }
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
