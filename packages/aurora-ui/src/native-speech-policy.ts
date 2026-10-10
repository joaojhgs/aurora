'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createAuroraNativeNodeConfigStore,
  defaultBackgroundTranscriptionPolicy,
  resolveBackgroundTranscriptionState,
  resolveSpeechStageRouting,
  TauriLocalTransport,
  type AssistantRoutePolicy,
  type AndroidBackgroundTranscriptionStatus,
  type AuroraBackgroundTranscriptionPolicy,
  type AuroraNodeConfigDocumentV2,
  type AuroraNativeNodeConfigReadReceipt,
  type AuroraSpeechStage,
  type AuroraSpeechStageConfig,
  type BackgroundTranscriptionState,
} from '@aurora/client'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { RouteAvailability, RouteProviderCandidate } from './shell-data'
import { isRemoteRouteCandidate, routePolicyFromRoute } from './assistant-execution-routing'

export type SpeechRoutingChoice = 'local_first' | 'network_first' | 'local_only' | 'network_only'
export type NativeSpeechPolicyState = 'hidden' | 'loading' | 'ready' | 'unavailable' | 'saving'
export type NativeTranscriptionCaptureState = 'idle' | 'starting' | 'listening' | 'transcribing' | 'completed' | 'failed'

export interface NativeBackgroundTranscriptionStatus {
  availability: 'loading' | 'available' | 'unavailable' | 'unsupported'
  captureState: NativeTranscriptionCaptureState | null
  facts: AndroidBackgroundTranscriptionStatus | null
  policyState: BackgroundTranscriptionState | null
  reason: string | null
  message: string | null
}

const NATIVE_NODE_CONFIG_READY_EVENT = 'aurora-node-config-document-token-ready'
const NATIVE_NODE_CONFIG_READY_TIMEOUT_MS = 30_000
const NATIVE_SPEECH_POLICY_SAVED_EVENT = 'aurora-native-speech-policy-saved'
const BACKGROUND_TRANSCRIPTION_STATUS_POLL_MS = 5_000

function initialBackgroundTranscriptionStatus(
  surface: Pick<AuroraSurfaceProfile, 'isAndroid' | 'isIos'> | null | undefined,
): NativeBackgroundTranscriptionStatus {
  if (surface?.isAndroid) {
    return { availability: 'loading', captureState: null, facts: null, policyState: null, reason: null, message: null }
  }
  return {
    availability: 'unsupported',
    captureState: null,
    facts: null,
    policyState: null,
    reason: 'unsupported',
    message: surface?.isIos
      ? 'Continuous transcription is not available on this device.'
      : 'Transcription is not available on this device.',
  }
}

function unavailableBackgroundTranscriptionStatus(): NativeBackgroundTranscriptionStatus {
  return {
    availability: 'unavailable',
    captureState: null,
    facts: null,
    policyState: null,
    reason: null,
    message: 'Aurora could not confirm whether transcription is active.',
  }
}

export interface NativeSpeechPolicyController {
  state: NativeSpeechPolicyState
  message: string | null
  sttChoice: SpeechRoutingChoice
  ttsChoice: SpeechRoutingChoice
  backgroundTranscription: AuroraBackgroundTranscriptionPolicy
  backgroundTranscriptionStatus: NativeBackgroundTranscriptionStatus
  changeChoice: (stage: 'stt' | 'tts', choice: SpeechRoutingChoice) => void
  changeBackgroundTranscription: (update: Partial<Pick<AuroraBackgroundTranscriptionPolicy, 'ambient' | 'notification' | 'retentionDays'>>) => void
  requestMicrophonePermission: () => Promise<void>
  save: () => Promise<void>
  routePolicy: (stage: 'stt' | 'tts', route: RouteAvailability) => AssistantRoutePolicy
}

const ROUTING_CHOICES: ReadonlyArray<{ value: SpeechRoutingChoice; label: string }> = [
  { value: 'local_first', label: 'This device first, then a connected device' },
  { value: 'network_first', label: 'Connected device first, then this device' },
  { value: 'local_only', label: 'This device only' },
  { value: 'network_only', label: 'Connected device only' },
]

export { ROUTING_CHOICES }

export function nativeSpeechPolicyAvailable(surface: AuroraSurfaceProfile | null | undefined): boolean {
  return surface?.usesNativeShell === true
    && surface.ownsLocalNodeState
    && surface.canManageNativeSpeechPolicy
}

export function speechRoutingChoice(config: AuroraSpeechStageConfig): SpeechRoutingChoice {
  if (config.routing.prefer === 'local_only') return 'local_only'
  if (config.routing.prefer === 'network_only') return 'network_only'
  if (config.routing.prefer === 'network') return config.routing.fallback === 'local' ? 'network_first' : 'network_only'
  return config.routing.fallback === 'network' ? 'local_first' : 'local_only'
}

export function routingForSpeechChoice(choice: SpeechRoutingChoice): AuroraSpeechStageConfig['routing'] {
  switch (choice) {
    case 'local_first': return { prefer: 'local', fallback: 'network' }
    case 'network_first': return { prefer: 'network', fallback: 'local' }
    case 'local_only': return { prefer: 'local_only', fallback: 'error' }
    case 'network_only': return { prefer: 'network_only', fallback: 'error' }
  }
}

export function resolveNativeSpeechRoutePolicy(input: {
  config: AuroraNodeConfigDocumentV2
  stage: 'stt' | 'tts'
  route: RouteAvailability
  surface: AuroraSurfaceProfile
}): AssistantRoutePolicy {
  const { config, stage, route, surface } = input
  const localAvailable = stage === 'stt'
    ? surface.localSpeechPack.canRunLocalStt
    : surface.localSpeechPack.canRunLocalTts
  const resolution = resolveSpeechStageRouting({
    stage,
    config,
    localCapability: {
      available: localAvailable,
      reason: localAvailable ? null : 'Local speech is unavailable on this device.',
    },
    remoteCandidates: remoteSpeechCandidates(route, stage),
  })
  const base = routePolicyFromRoute(route)
  const candidate = resolution.attempt.candidate
  if (resolution.source === 'local') {
    return {
      ...base,
      providerId: null,
      peerId: null,
      serviceInstanceId: null,
      fallbackBehavior: resolution.record.reason,
    }
  }
  const peerId = resolution.selector?.peer_id ?? candidate?.peerId ?? null
  if (!peerId) throw new Error('A connected speech device is unavailable.')
  return {
    ...base,
    providerId: resolution.selector?.provider_id ?? candidate?.providerId ?? null,
    peerId,
    serviceInstanceId: resolution.selector?.service_instance_id ?? candidate?.serviceInstanceId ?? null,
    fallbackBehavior: resolution.record.reason,
  }
}

function remoteSpeechCandidates(route: RouteAvailability, stage: 'stt' | 'tts') {
  return route.candidateProviders.flatMap((candidate: RouteProviderCandidate) => {
    if (!candidate.selectable || !isRemoteRouteCandidate(candidate)) return []
    const providerId = candidate.providerId ?? candidate.id
    const peerId = candidate.peerId ?? peerIdFromIdentity(providerId)
    if (!peerId) return []
    return [{
      peerId,
      providerId,
      serviceInstanceId: candidate.serviceInstanceId ?? null,
      module: stage === 'stt' ? 'Transcription' : 'TTS',
      eligible: true,
    }]
  })
}

function peerIdFromIdentity(identity: string): string | null {
  const match = /^(?:remote|mesh):([^:]+):/i.exec(identity)
  return match?.[1] ?? null
}

function nativeNodeConfigDocumentIsReady(): boolean {
  const nativeWindow = window as Window & { __AURORA_NODE_CONFIG_DOCUMENT_TOKEN__?: unknown }
  const token = nativeWindow.__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)
}

function waitForNativeNodeConfigDocument(
  signal: AbortSignal,
  onTimeout: () => void,
): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Native speech settings are unavailable.'))
  }
  if (nativeNodeConfigDocumentIsReady()) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: number | null = null
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout !== null) window.clearTimeout(timeout)
      window.removeEventListener(NATIVE_NODE_CONFIG_READY_EVENT, onReady)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onReady = () => {
      if (nativeNodeConfigDocumentIsReady()) finish()
    }
    const onAbort = () => finish(new Error('Native speech settings are unavailable.'))
    timeout = window.setTimeout(() => {
      timeout = null
      onTimeout()
    }, NATIVE_NODE_CONFIG_READY_TIMEOUT_MS)
    window.addEventListener(NATIVE_NODE_CONFIG_READY_EVENT, onReady)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else onReady()
  })
}

export function useNativeSpeechPolicy(
  surface: AuroraSurfaceProfile | null | undefined,
  scopeKey = '',
): NativeSpeechPolicyController {
  const enabled = nativeSpeechPolicyAvailable(surface)
  const isAndroid = surface?.isAndroid === true
  const isIos = surface?.isIos === true
  const surfaceKind = surface?.physicalKind ?? null
  const [documentEntry, setDocumentEntry] = useState<{
    scopeKey: string
    generation: number
    document: AuroraNodeConfigDocumentV2
  } | null>(null)
  const [state, setState] = useState<NativeSpeechPolicyState>(enabled ? 'loading' : 'hidden')
  const [message, setMessage] = useState<string | null>(null)
  const [sttChoice, setSttChoice] = useState<SpeechRoutingChoice>('local_first')
  const [ttsChoice, setTtsChoice] = useState<SpeechRoutingChoice>('local_first')
  const [backgroundTranscription, setBackgroundTranscription] = useState<AuroraBackgroundTranscriptionPolicy>(defaultBackgroundTranscriptionPolicy)
  const [backgroundTranscriptionStatusEntry, setBackgroundTranscriptionStatusEntry] = useState<{
    scopeKey: string
    generation: number
    status: NativeBackgroundTranscriptionStatus
  }>(() => ({ scopeKey, generation: 0, status: initialBackgroundTranscriptionStatus(surface) }))
  const backgroundTranscriptionStatusRef = useRef(backgroundTranscriptionStatusEntry)
  backgroundTranscriptionStatusRef.current = backgroundTranscriptionStatusEntry
  const [viewScopeKey, setViewScopeKey] = useState(scopeKey)
  const [choiceScopeKey, setChoiceScopeKey] = useState<string | null>(null)
  const scopeGenerationRef = useRef({ scopeKey, enabled, isAndroid, isIos, surfaceKind, generation: 0 })
  const receiptRef = useRef<{
    scopeKey: string
    generation: number
    receipt: AuroraNativeNodeConfigReadReceipt
  } | null>(null)
  const refreshRef = useRef<{
    scopeKey: string
    generation: number
    refresh: () => Promise<boolean>
  } | null>(null)
  const refreshSourceRef = useRef<object>({})
  const statusSequenceRef = useRef(0)
  const statusOperationRef = useRef<number | null>(null)
  const permissionGrantSyncRef = useRef<string | null>(null)
  const acknowledgedDocumentRef = useRef<{
    scopeKey: string
    generation: number
    document: AuroraNodeConfigDocumentV2
  } | null>(null)
  if (scopeGenerationRef.current.scopeKey !== scopeKey
    || scopeGenerationRef.current.enabled !== enabled
    || scopeGenerationRef.current.isAndroid !== isAndroid
    || scopeGenerationRef.current.isIos !== isIos
    || scopeGenerationRef.current.surfaceKind !== surfaceKind) {
    scopeGenerationRef.current = {
      scopeKey,
      enabled,
      isAndroid,
      isIos,
      surfaceKind,
      generation: scopeGenerationRef.current.generation + 1,
    }
  }
  const storeRef = useRef<{
    scopeKey: string
    generation: number
    store: ReturnType<typeof createAuroraNativeNodeConfigStore>
    transport: TauriLocalTransport
  } | null>(null)
  const document = documentEntry?.scopeKey === scopeKey
    && documentEntry.generation === scopeGenerationRef.current.generation
    ? documentEntry.document
    : null
  const visibleState = viewScopeKey === scopeKey
    ? state
    : enabled ? 'loading' : 'hidden'
  const visibleMessage = viewScopeKey === scopeKey ? message : null
  const visibleSttChoice = choiceScopeKey === scopeKey ? sttChoice : 'local_first'
  const visibleTtsChoice = choiceScopeKey === scopeKey ? ttsChoice : 'local_first'
  const visibleBackgroundTranscription = choiceScopeKey === scopeKey
    ? backgroundTranscription
    : defaultBackgroundTranscriptionPolicy()
  const backgroundTranscriptionStatus = backgroundTranscriptionStatusEntry.scopeKey === scopeKey
    && backgroundTranscriptionStatusEntry.generation === scopeGenerationRef.current.generation
    ? backgroundTranscriptionStatusEntry.status
    : initialBackgroundTranscriptionStatus(surface)
  const setBackgroundTranscriptionStatus = (status: NativeBackgroundTranscriptionStatus) => {
    const entry = {
      scopeKey,
      generation: scopeGenerationRef.current.generation,
      status,
    }
    backgroundTranscriptionStatusRef.current = entry
    setBackgroundTranscriptionStatusEntry(entry)
  }

  useEffect(() => {
    const scopeGeneration = scopeGenerationRef.current.generation
    const isCurrent = () => scopeGenerationRef.current.scopeKey === scopeKey
      && scopeGenerationRef.current.enabled === enabled
      && scopeGenerationRef.current.isAndroid === isAndroid
      && scopeGenerationRef.current.isIos === isIos
      && scopeGenerationRef.current.surfaceKind === surfaceKind
      && scopeGenerationRef.current.generation === scopeGeneration
    if (!enabled) {
      storeRef.current = null
      receiptRef.current = null
      acknowledgedDocumentRef.current = null
      statusSequenceRef.current += 1
      refreshRef.current = null
      setDocumentEntry(null)
      setViewScopeKey(scopeKey)
      setChoiceScopeKey(null)
      setBackgroundTranscription(defaultBackgroundTranscriptionPolicy())
      setBackgroundTranscriptionStatus(initialBackgroundTranscriptionStatus(surface))
      setState('hidden')
      setMessage(null)
      return
    }
    let active = true
    const readiness = new AbortController()
    const canUpdate = () => active && isCurrent()
    let readSequence = 0
    let latestDocument: AuroraNodeConfigDocumentV2 | null = null
    let statusTimer: number | null = null
    let statusReadInFlight = false
    storeRef.current = null
    receiptRef.current = null
    acknowledgedDocumentRef.current = null
    statusSequenceRef.current += 1
    permissionGrantSyncRef.current = null
    setDocumentEntry(null)
    setViewScopeKey(scopeKey)
    setChoiceScopeKey(null)
    setBackgroundTranscription(defaultBackgroundTranscriptionPolicy())
    setBackgroundTranscriptionStatus(initialBackgroundTranscriptionStatus(surface))
    setState('loading')
    setMessage(null)
    try {
      const transport = new TauriLocalTransport()
      const store = createAuroraNativeNodeConfigStore(transport)
      storeRef.current = { scopeKey, generation: scopeGeneration, store, transport }
      const documentReady = waitForNativeNodeConfigDocument(readiness.signal, () => {
        if (!canUpdate()) return
        setState('unavailable')
        setMessage('Speech settings could not be loaded on this device.')
      })
      const updateTranscriptionStatus = async (
        document: AuroraNodeConfigDocumentV2,
        synchronize = false,
      ): Promise<void> => {
        if (!isAndroid) {
          if (canUpdate()) setBackgroundTranscriptionStatus(initialBackgroundTranscriptionStatus({ isAndroid, isIos }))
          return
        }
        if (statusReadInFlight || statusOperationRef.current !== null) return
        const acknowledged = acknowledgedDocumentRef.current
        if (!acknowledged || acknowledged.scopeKey !== scopeKey
          || acknowledged.generation !== scopeGeneration
          || acknowledged.document.revision !== document.revision) return
        statusReadInFlight = true
        const sequence = ++statusSequenceRef.current
        try {
          let status = synchronize
            ? await transport.synchronizeAndroidBackgroundTranscription()
            : await transport.getAndroidVoiceForegroundServiceStatus()
          let currentDocument = acknowledgedDocumentRef.current
          if (!canUpdate() || sequence !== statusSequenceRef.current
            || currentDocument?.scopeKey !== scopeKey
            || currentDocument.generation !== scopeGeneration
            || currentDocument.document.revision !== document.revision) return
          let facts = status.transcription
          if (!facts) {
            setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
            return
          }
          const priorStatus = backgroundTranscriptionStatusRef.current
          const priorPermission = priorStatus.scopeKey === scopeKey && priorStatus.generation === scopeGeneration
            ? priorStatus.status.facts?.permission
            : undefined
          const grantSyncKey = `${scopeKey}:${scopeGeneration}:${document.revision}`
          if (!synchronize && priorPermission !== 'granted' && facts.permission === 'granted'
            && document.backgroundTranscription.enabled && permissionGrantSyncRef.current !== grantSyncKey) {
            permissionGrantSyncRef.current = grantSyncKey
            statusOperationRef.current = sequence
            try {
              status = await transport.synchronizeAndroidBackgroundTranscription()
            } finally {
              if (statusOperationRef.current === sequence) statusOperationRef.current = null
            }
            currentDocument = acknowledgedDocumentRef.current
            if (!canUpdate() || sequence !== statusSequenceRef.current
              || currentDocument?.scopeKey !== scopeKey
              || currentDocument.generation !== scopeGeneration
              || currentDocument.document.revision !== document.revision) return
            facts = status.transcription
            if (!facts) {
              setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
              return
            }
          }
          const policyState = resolveBackgroundTranscriptionState(currentDocument.document, facts)
          setBackgroundTranscriptionStatus({
            availability: 'available',
            captureState: facts.state,
            facts,
            policyState,
            reason: facts.reason ?? policyState.reason,
            message: null,
          })
        } catch {
          const currentDocument = acknowledgedDocumentRef.current
          if (canUpdate() && sequence === statusSequenceRef.current
            && currentDocument?.scopeKey === scopeKey
            && currentDocument.generation === scopeGeneration
            && currentDocument.document.revision === document.revision) {
            setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
          }
        } finally {
          statusReadInFlight = false
        }
      }
      const scheduleStatusPoll = () => {
        if (!canUpdate() || !isAndroid || statusTimer !== null) return
        statusTimer = window.setTimeout(() => {
          statusTimer = null
          const currentDocument = acknowledgedDocumentRef.current
          if (!canUpdate() || !latestDocument || !currentDocument
            || currentDocument.scopeKey !== scopeKey || currentDocument.generation !== scopeGeneration) return
          void updateTranscriptionStatus(currentDocument.document).finally(scheduleStatusPoll)
        }, BACKGROUND_TRANSCRIPTION_STATUS_POLL_MS)
      }
      const refresh = async (synchronizeNative = false): Promise<boolean> => {
        const sequence = ++readSequence
        try {
          await documentReady
          const receipt = await store.read()
          if (!canUpdate() || sequence !== readSequence) return false
          latestDocument = receipt.document
          acknowledgedDocumentRef.current = { scopeKey, generation: scopeGeneration, document: receipt.document }
          receiptRef.current = { scopeKey, generation: scopeGeneration, receipt }
          setDocumentEntry({ scopeKey, generation: scopeGeneration, document: receipt.document })
          setSttChoice(speechRoutingChoice(receipt.document.speech.stages.stt))
          setTtsChoice(speechRoutingChoice(receipt.document.speech.stages.tts))
          setBackgroundTranscription(receipt.document.backgroundTranscription)
          setChoiceScopeKey(scopeKey)
          setState('ready')
          setMessage(null)
          await updateTranscriptionStatus(receipt.document, synchronizeNative)
          return true
        } catch {
          if (!canUpdate() || sequence !== readSequence) return false
          receiptRef.current = null
          setState('unavailable')
          setMessage('Speech settings could not be loaded on this device.')
          return false
        }
      }
      const onPolicySaved = (event: Event) => {
        const detail = (event as CustomEvent<{ scopeKey?: unknown; source?: unknown }>).detail
        if (detail?.scopeKey === scopeKey && detail.source !== refreshSourceRef.current) {
          void refresh()
        }
      }
      refreshRef.current = { scopeKey, generation: scopeGeneration, refresh }
      window.addEventListener(NATIVE_SPEECH_POLICY_SAVED_EVENT, onPolicySaved)
      void refresh(isAndroid).then((loaded) => {
        if (loaded) scheduleStatusPoll()
      })
      return () => {
        window.removeEventListener(NATIVE_SPEECH_POLICY_SAVED_EVENT, onPolicySaved)
        if (refreshRef.current?.refresh === refresh) refreshRef.current = null
        active = false
        statusSequenceRef.current += 1
        if (statusOperationRef.current !== null) statusOperationRef.current = null
        acknowledgedDocumentRef.current = null
        if (statusTimer !== null) window.clearTimeout(statusTimer)
        readiness.abort()
      }
    } catch {
      setState('unavailable')
      setMessage('Speech settings could not be loaded on this device.')
    }
    return () => {
      active = false
      readiness.abort()
    }
  }, [enabled, isAndroid, isIos, scopeKey, surfaceKind])

  const changeChoice = useCallback((stage: 'stt' | 'tts', choice: SpeechRoutingChoice) => {
    if (stage === 'stt') setSttChoice(choice)
    else setTtsChoice(choice)
    setMessage(null)
  }, [])

  const changeBackgroundTranscription = useCallback((update: Partial<Pick<AuroraBackgroundTranscriptionPolicy, 'ambient' | 'notification' | 'retentionDays'>>) => {
    setBackgroundTranscription((current) => {
      const next = { ...current, ...update }
      if (update.ambient === true) next.notification = false
      if (update.notification === true) next.ambient = false
      next.enabled = next.ambient || next.notification
      return next
    })
    setMessage(null)
  }, [])

  const requestMicrophonePermission = useCallback(async () => {
    const entry = storeRef.current
    const scopeGeneration = scopeGenerationRef.current.generation
    const isCurrent = () => enabled
      && isAndroid
      && scopeGenerationRef.current.scopeKey === scopeKey
      && scopeGenerationRef.current.generation === scopeGeneration
      && entry?.scopeKey === scopeKey
      && entry.generation === scopeGeneration
    if (!isCurrent() || !entry || visibleState !== 'ready' || statusOperationRef.current !== null) return
    const operation = ++statusSequenceRef.current
    statusOperationRef.current = operation
    try {
      await entry.transport.requestAndroidPermission('microphone')
      if (!isCurrent() || operation !== statusSequenceRef.current) return
      const acknowledged = acknowledgedDocumentRef.current
      if (!acknowledged || acknowledged.scopeKey !== scopeKey || acknowledged.generation !== scopeGeneration) return
      const status = await entry.transport.getAndroidVoiceForegroundServiceStatus()
      const currentDocument = acknowledgedDocumentRef.current
      if (!isCurrent() || operation !== statusSequenceRef.current
        || currentDocument?.scopeKey !== scopeKey
        || currentDocument.generation !== scopeGeneration
        || currentDocument.document.revision !== acknowledged.document.revision) return
      const facts = status.transcription
      if (!facts) {
        setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
        return
      }
      let latestStatus = status
      if (backgroundTranscriptionStatus.facts?.permission !== 'granted'
        && facts.permission === 'granted'
        && acknowledged.document.backgroundTranscription.enabled) {
        const synchronized = await entry.transport.synchronizeAndroidBackgroundTranscription()
        if (!isCurrent() || operation !== statusSequenceRef.current) return
        latestStatus = synchronized
      }
      const latestFacts = latestStatus.transcription
      if (!latestFacts) {
        setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
        return
      }
      const policyState = resolveBackgroundTranscriptionState(acknowledged.document, latestFacts)
      setBackgroundTranscriptionStatus({
        availability: 'available',
        captureState: latestFacts.state,
        facts: latestFacts,
        policyState,
        reason: latestFacts.reason ?? policyState.reason,
        message: null,
      })
    } catch {
      if (isCurrent() && operation === statusSequenceRef.current) {
        setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
      }
    } finally {
      if (statusOperationRef.current === operation) statusOperationRef.current = null
    }
  }, [backgroundTranscriptionStatus.facts?.permission, enabled, isAndroid, scopeKey, visibleState])

  const save = useCallback(async () => {
    const entry = storeRef.current
    const receiptEntry = receiptRef.current
    const scopeGeneration = scopeGenerationRef.current.generation
    const isCurrent = () => enabled
      && scopeGenerationRef.current.scopeKey === scopeKey
      && scopeGenerationRef.current.enabled === enabled
      && scopeGenerationRef.current.generation === scopeGeneration
      && entry?.scopeKey === scopeKey
      && entry.generation === scopeGeneration
    if (!isCurrent() || !entry || !receiptEntry
      || receiptEntry.scopeKey !== scopeKey || receiptEntry.generation !== scopeGeneration
      || visibleState !== 'ready') return
    const refreshCurrentStore = async () => {
      const refreshEntry = refreshRef.current
      if (refreshEntry?.scopeKey !== scopeKey || refreshEntry.generation !== scopeGeneration) return false
      return refreshEntry.refresh()
    }
    const store = entry.store
    setState('saving')
    setViewScopeKey(scopeKey)
    setMessage(null)
    try {
      const current = receiptEntry.receipt.document
      const next: AuroraNodeConfigDocumentV2 = {
        ...current,
        revision: current.revision + 1,
        updatedAtMs: Date.now(),
        speech: {
          ...current.speech,
          stages: {
            ...current.speech.stages,
            stt: { ...current.speech.stages.stt, routing: routingForSpeechChoice(sttChoice) },
            tts: { ...current.speech.stages.tts, routing: routingForSpeechChoice(ttsChoice) },
          },
        },
        backgroundTranscription: visibleBackgroundTranscription,
      }
      if (!isCurrent()) return
      const saved = await store.save(receiptEntry.receipt, next)
      if (!isCurrent()) return
      receiptRef.current = null
      acknowledgedDocumentRef.current = { scopeKey, generation: scopeGeneration, document: saved.document }
      const statusOperation = ++statusSequenceRef.current
      statusOperationRef.current = isAndroid ? statusOperation : null
      setBackgroundTranscription(saved.document.backgroundTranscription)
      setDocumentEntry({ scopeKey, generation: scopeGeneration, document: saved.document })
      let statusConfirmed = !isAndroid
      if (isAndroid) {
        try {
          const nativeStatus = await entry.transport.synchronizeAndroidBackgroundTranscription()
          if (!isCurrent() || statusOperation !== statusSequenceRef.current) return
          const facts = nativeStatus.transcription
          if (facts) {
            const policyState = resolveBackgroundTranscriptionState(saved.document, facts)
            setBackgroundTranscriptionStatus({
              availability: 'available',
              captureState: facts.state,
              facts,
              policyState,
              reason: facts.reason ?? policyState.reason,
              message: null,
            })
            statusConfirmed = true
          } else {
            setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
          }
        } catch {
          if (!isCurrent() || statusOperation !== statusSequenceRef.current) return
          setBackgroundTranscriptionStatus(unavailableBackgroundTranscriptionStatus())
        } finally {
          if (statusOperationRef.current === statusOperation) statusOperationRef.current = null
        }
      }
      window.dispatchEvent(new CustomEvent(NATIVE_SPEECH_POLICY_SAVED_EVENT, {
        detail: { scopeKey, source: refreshSourceRef.current },
      }))
      const refreshed = await refreshCurrentStore()
      if (!isCurrent()) return
      if (refreshed) {
        setMessage(statusConfirmed
          ? 'Saved for your next conversation.'
          : 'Saved, but current transcription status could not be confirmed.')
      }
    } catch {
      if (!isCurrent()) return
      const refreshed = await refreshCurrentStore()
      if (!isCurrent()) return
      if (refreshed) {
        setState('ready')
        setMessage('Speech settings changed elsewhere. Review the latest choices and try again.')
      } else {
        setState('unavailable')
        setMessage('Speech settings could not be refreshed on this device.')
      }
    }
  }, [enabled, isAndroid, scopeKey, sttChoice, ttsChoice, visibleBackgroundTranscription, visibleState])

  const routePolicy = useCallback((stage: 'stt' | 'tts', route: RouteAvailability): AssistantRoutePolicy => {
    if (!enabled) return routePolicyFromRoute(route)
    if (!document || visibleState !== 'ready') throw new Error('Speech settings are not ready on this device.')
    try {
      return resolveNativeSpeechRoutePolicy({ config: document, stage, route, surface: surface! })
    } catch {
      throw new Error('The selected speech option is unavailable on this device.')
    }
  }, [document, enabled, surface, visibleState])

  return {
    state: visibleState,
    message: visibleMessage,
    sttChoice: visibleSttChoice,
    ttsChoice: visibleTtsChoice,
    backgroundTranscription: visibleBackgroundTranscription,
    backgroundTranscriptionStatus,
    changeChoice,
    changeBackgroundTranscription,
    requestMicrophonePermission,
    save,
    routePolicy,
  }
}
