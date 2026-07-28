'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CheckCircle2, ChevronDown, Copy, Cpu, FileText, Image as ImageIcon, Laptop, LoaderCircle, MessageSquarePlus, Mic, Network, Paperclip, Radio, RotateCcw, Route as RouteIcon, ArrowUp, ShieldAlert, StopCircle, Volume2, WifiOff, Wrench, XCircle, X } from 'lucide-react'
import type {
  AttachmentContextIngestResponse,
  AttachmentContextItem,
  AttachmentContextItemResult,
  AttachmentContextPrivacyClass,
  AttachmentContextSourceChannel,
  AttachmentContextStatus,
  AssistantInferencePolicy,
  AssistantMessage as SdkAssistantMessage,
  AssistantRoutePolicy,
  AssistantStreamUpdate,
  AuroraClient,
  AuroraError,
  AuroraResponse,
  DBGetSessionResponse,
  DBSessionRecord,
  VoiceRuntimeEvent,
  ModelRuntimeCatalogResponse,
  ModelRuntimeModelInfo,
  ModelRuntimeProviderInfo
} from '@aurora/client'
import type { AssistantVoiceRoutes, RouteAvailability } from './shell-data'
import { RouteSheet } from './route-sheet'
import { AudioRecorderVisualizer } from './audio-recorder-visualizer'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle
} from '#components/ui/attachment'
import { Bubble, BubbleContent } from '#components/ui/bubble'
import { Button } from '#components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#components/ui/collapsible'
import { Marker, MarkerContent } from '#components/ui/marker'
import { Message, MessageContent, MessageFooter, MessageHeader } from '#components/ui/message'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '#components/ui/message-scroller'
import { ToolFallbackArgs, ToolFallbackContent, ToolFallbackResult, ToolFallbackRoot } from '#components/assistant-ui/tool-fallback'
import { ModelSelector, type ModelOption } from '#components/assistant-ui/model-selector'
import { EvidenceBadge, PrivacyBadge, StatusBadge, presentableSignal } from './status-badges'
import { AURORA_RELEASE_FOCUSED_MEDIA_EVENT, getAuroraSurfaceProfile } from './platform-surface'
import type { AuroraSurfaceProfile } from './platform-surface'


export interface AssistantViewProps {
  client: AuroraClient
  route: RouteAvailability
  cancellationRoute?: RouteAvailability | undefined
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
  recentVoiceEvents?: VoiceRuntimeEvent[] | undefined
  storageKey?: string
  initialSession?: AssistantSessionSnapshot | undefined
  runtimeHealth?: AssistantRuntimeHealth | undefined
}

export interface AssistantRuntimeHealth {
  selectedModel: string | null
  routeLabel: string
  sidecarHealth: string
  gatewayHealth: string
}

export interface AssistantExecutionOption {
  id: string
  mode: 'local' | 'dispatch'
  label: string
  description: string
  routePolicy: AssistantRoutePolicy
}

export interface AssistantModelChoice {
  id: string
  model: ModelOption
  provider: ModelRuntimeProviderInfo | null
  runtimeModel: ModelRuntimeModelInfo | null
  automatic: boolean
}

export interface AssistantModelChoiceGroup {
  id: string
  heading: string
  choices: AssistantModelChoice[]
  scope: 'default' | 'this device' | 'connected device'
}

export interface AssistantModelSourceGroup {
  id: string
  heading: string
  description: string
  providerGroups: AssistantModelChoiceGroup[]
  modelCount: number
  scope: 'local' | 'peer'
}

export type AssistantUiMessageStatus = 'sent' | 'sending' | 'streaming' | 'failed' | 'cancelled'

export interface AssistantToolCallCard {
  id: string
  name: string
  sessionId?: string | null | undefined
  status: 'requested' | 'running' | 'completed' | 'failed' | 'requires_action'
  riskClass: string
  target: string
  dataLeavesDevice: boolean
  summary: string
  auditId: string | null
  payloadPreview: Record<string, unknown> | null
  resultPreview?: Record<string, unknown> | string | null | undefined
  error?: string | null | undefined
  errorDetails?: Record<string, unknown> | string | null | undefined
  pendingId?: string | null | undefined
  approvalRequestId?: string | null | undefined
  approvalExpiresAt?: number | null | undefined
  policyDecisionId?: string | null | undefined
  resolving?: boolean | undefined
}

export interface AssistantUiMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  text: string
  createdAt: string
  status: AssistantUiMessageStatus
  error?: string | undefined
  toolCalls?: AssistantToolCallCard[] | undefined
  sources?: string[] | undefined
  modelLabel?: string | null | undefined
  providerLabel?: string | null | undefined
  routeLabel?: string | null | undefined
  executionPeerId?: string | null | undefined
}

type AssistantApprovalGrantScope = 'once' | 'session' | 'until_expiry' | 'always' | 'deny_once' | 'deny_always'

export interface AssistantSessionSnapshot {
  sessionId: string | null
  messages: AssistantUiMessage[]
}

export type AssistantStreamStatus = 'idle' | 'streaming' | 'fallback' | 'lost' | 'cancelled'

export interface AssistantStreamState {
  status: AssistantStreamStatus
  lastEventId: string | null
  message: string | null
}

export interface AssistantControlState {
  canSend: boolean
  canCancel: boolean
  cancelReason: string
}

export type AttachmentTrayStatus =
  | 'staged'
  | 'uploading'
  | 'accepted'
  | 'redacted'
  | 'stored'
  | 'unsupported'
  | 'rejected'
  | 'error'

export interface AssistantAttachmentDraft {
  id: string
  kind: 'text' | 'url' | 'file' | 'image'
  label: string
  detail: string
  contentText?: string | null
  url?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  previewUrl?: string | null
  sourceChannel: AttachmentContextSourceChannel
  sourceDisplayName: string
  privacyClass: AttachmentContextPrivacyClass
  status: AttachmentTrayStatus
  progress: number
  message: string
  reasonCode?: string | null
  redacted: boolean
}

export type VoiceCaptureStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'permission-denied' | 'no-device' | 'error'

export interface VoiceCapabilityChip {
  id: string
  label: string
  state: RouteAvailability['state']
  privacyClass: 'public' | 'personal' | 'sensitive' | 'secret' | 'raw-audio' | 'credential' | 'admin-critical'
  providerLabel: string
  detail: string
  blockers: string[]
  evidence: string[]
}

export interface VoiceControlModel {
  id: string
  label: string
  state: RouteAvailability['state']
  enabled: boolean
  reason: string
  route: RouteAvailability | null
}

export interface VoiceEventRow {
  id: string
  label: string
  state: RouteAvailability['state']
  detail: string
}

export interface AssistantVoiceModel {
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
  privacyClass: 'raw-audio'
  retentionPolicy: string
  sessionTtl: string
  transport: string
  platformTruth: string
  visualizerSourceLabel: string
  targetLabel: string
  chips: VoiceCapabilityChip[]
  controls: VoiceControlModel[]
  events: VoiceEventRow[]
  routeSheetRoute: RouteAvailability
  remoteAudioRoute: RouteAvailability
  waveformBars: number[]
}

const defaultStorageKey = 'aurora.assistant.session.v1'
const emptyNativePermissionList: Array<{ name: string; granted: boolean }> = []
const emptyNativeCapabilityList: Array<{ name: string; enabled: boolean }> = []
const emptyVoiceEventList: VoiceRuntimeEvent[] = []
const defaultContextLimits = {
  max_items: 8,
  max_item_bytes: 262_144,
  max_total_bytes: 1_048_576,
  max_text_chars: 120_000
}

const assistantAttachmentPickerAccept = 'image/*,application/pdf,application/json,text/plain,text/markdown,.txt,.md,.markdown,.json'

type BrowserFileSystemFileHandle = { getFile: () => Promise<File> }
type BrowserOpenFilePicker = (options?: {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<BrowserFileSystemFileHandle[]>

export function AssistantView({
  client,
  route,
  cancellationRoute,
  voiceRoutes,
  nativePlatform = 'not available',
  nativeAvailable = false,
  nativePermissions = emptyNativePermissionList,
  nativeCapabilities = emptyNativeCapabilityList,
  recentVoiceEvents = emptyVoiceEventList,
  storageKey = defaultStorageKey,
  initialSession,
  runtimeHealth
}: AssistantViewProps) {
  const [session, setSession] = useState<AssistantSessionSnapshot>(() => initialSession ?? defaultAssistantSessionForTransport(client.transport.kind))
  const [sessionIndex, setSessionIndex] = useState<DBSessionRecord[]>([])
  const [sessionIndexLoading, setSessionIndexLoading] = useState(false)
  const [sessionIndexError, setSessionIndexError] = useState<string | null>(null)
  const [sessionAuthScope, setSessionAuthScope] = useState(() => {
    const auth = client.auth.snapshot()
    return `${auth.state}:${auth.principalId ?? ''}`
  })
  const sessionAuthScopeRef = useRef(sessionAuthScope)
  const [text, setText] = useState('')
  const [privacyClass] = useState<AttachmentContextPrivacyClass>('personal')
  const [attachments, setAttachments] = useState<AssistantAttachmentDraft[]>([])
  const attachmentsRef = useRef<AssistantAttachmentDraft[]>([])
  const [lastResult, setLastResult] = useState<SdkAssistantMessage | null>(null)
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  const [runtimeProviderLabel, setRuntimeProviderLabel] = useState<string | null>(null)
  const [localModelCatalog, setLocalModelCatalog] = useState<ModelRuntimeCatalogResponse | null>(null)
  const [dispatchModelCatalog, setDispatchModelCatalog] = useState<ModelRuntimeCatalogResponse | null>(null)
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true)
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null)
  const [executionOptionId, setExecutionOptionId] = useState('local')
  const [selectedModelChoiceId, setSelectedModelChoiceId] = useState('automatic')
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [lastError, setLastError] = useState<string | null>(null)
  const [lastPrompt, setLastPrompt] = useState<string | null>(null)
  const [streamState, setStreamState] = useState<AssistantStreamState>(() => idleAssistantStreamState())
  const [voiceConsentGranted, setVoiceConsentGranted] = useState(false)
  const [voiceCaptureStatus, setVoiceCaptureStatusState] = useState<VoiceCaptureStatus>('idle')
  const [activeAssistantPendingId, setActiveAssistantPendingId] = useState<string | null>(null)
  const [voiceResponsePendingId, setVoiceResponsePendingId] = useState<string | null>(null)
  const [voiceEvents, setVoiceEvents] = useState<VoiceRuntimeEvent[]>(recentVoiceEvents)
  const [voiceWaveformBars, setVoiceWaveformBars] = useState<number[]>(() => idleWaveformBars())
  const [voiceElapsedSeconds, setVoiceElapsedSeconds] = useState(0)
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceAudioContextRef = useRef<AudioContext | null>(null)
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null)
  const voiceMediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const voiceScriptProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const voicePcmChunksRef = useRef<Float32Array[]>([])
  const voicePcmSampleRateRef = useRef(16_000)
  const voicePartialTranscribeTimerRef = useRef<number | null>(null)
  const voicePartialTranscribeInFlightRef = useRef(false)
  const voiceRecordingGenerationRef = useRef(0)
  const voiceFinalizeOnStopRef = useRef(false)
  const voiceAnalyserFrameRef = useRef<number | null>(null)
  const activeVoiceSessionRef = useRef<string | null>(null)
  const ownedVoiceSessionIdsRef = useRef<Set<string>>(new Set())
  const coordinatorVoiceSessionIdsRef = useRef<Set<string>>(new Set())
  const voiceSessionStartedAtRef = useRef<number | null>(null)
  const appliedVoiceEventIdsRef = useRef<Set<string>>(new Set())
  const voiceCaptureStatusRef = useRef<VoiceCaptureStatus>('idle')
  const voicePendingAssistantIdRef = useRef<string | null>(null)
  const voiceTranscriptPreviewRef = useRef('')
  const sessionLoadGenerationRef = useRef(0)
  function setVoiceCaptureStatus(next: VoiceCaptureStatus) {
    voiceCaptureStatusRef.current = next
    setVoiceCaptureStatusState(next)
  }
  const voiceToggleInFlightRef = useRef(false)
  const voiceResponseTimeoutRef = useRef<number | null>(null)
  const readAloudFallbackTimerRef = useRef<number | null>(null)
  const readAloudFallbackTokenRef = useRef(0)
  const [speakingMessageIdState, setSpeakingMessageIdState] = useState<string | null>(null)
  const speakingMessageIdRef = useRef<string | null>(null)
  const lastAssistantMessageIdRef = useRef<string | null>(null)
  const streamedTtsQueueRef = useRef<string[]>([])
  const streamedTtsAudioRef = useRef<HTMLAudioElement | null>(null)
  function setSpeakingMessageId(next: string | null) {
    speakingMessageIdRef.current = next
    setSpeakingMessageIdState(next)
  }
  const activePendingIdRef = useRef<string | null>(null)
  const cancelledPendingIdsRef = useRef<Set<string>>(new Set())
  const executionOptions = useMemo(() => assistantExecutionOptions(route), [route])
  const executionPeerLabels = useMemo(
    () => {
      const labels = new Map<string, string>()
      for (const candidate of route.candidateProviders) {
        if (!isRemoteRouteCandidate(candidate)) continue
        const peerId = candidate.peerId ?? peerIdFromProviderIdentity(candidate.providerId ?? candidate.id)
        if (!peerId) continue
        labels.set(peerId, executionPeerLabel(candidate.nodeName ?? candidate.label, peerId))
      }
      for (const option of executionOptions) {
        if (option.mode === 'dispatch' && option.routePolicy.peerId) {
          labels.set(option.routePolicy.peerId, option.label)
        }
      }
      return labels
    },
    [executionOptions, route.candidateProviders]
  )
  const selectedExecution = executionOptions.find((option) => option.id === executionOptionId) ?? executionOptions[0]!
  const routePolicy = selectedExecution.routePolicy
  const activeModelCatalog = selectedExecution.mode === 'local' ? localModelCatalog : dispatchModelCatalog
  const modelChoices = useMemo(
    () => assistantModelChoices(activeModelCatalog, selectedExecution),
    [activeModelCatalog, selectedExecution]
  )
  const modelChoiceGroups = useMemo(
    () => assistantModelChoiceGroups(modelChoices, selectedExecution),
    [modelChoices, selectedExecution]
  )
  const modelSourceGroups = useMemo(
    () => assistantModelSourceGroups(modelChoiceGroups, selectedExecution, executionOptions),
    [executionOptions, modelChoiceGroups, selectedExecution]
  )
  const selectedModelChoice = modelChoices.find((choice) => choice.id === selectedModelChoiceId) ?? modelChoices[0]!
  const inferencePolicy = assistantInferencePolicy(selectedModelChoice, route)
  const supportsPersistedSessions = client.transport.kind !== 'mock' && client.transport.kind !== 'mesh'
  const sessionMessages = session.messages
  const isSending = sessionMessages.some((message) => message.status === 'sending')
  const isStreaming = sessionMessages.some((message) => message.status === 'streaming')
  const hasContextUpload = attachments.some((attachment) => attachment.status === 'uploading')
  const controls = assistantControlsForRoute(route, cancellationRoute, isSending || isStreaming || hasContextUpload)
  const canSend = controls.canSend && (!supportsPersistedSessions || Boolean(session.sessionId)) && !sessionIndexLoading
  const canAttach = !route.disabled && !isSending && !isStreaming && !hasContextUpload
  const attachmentsAwaitingValidation = attachments.filter((attachment) =>
    attachment.status === 'staged' || attachment.status === 'error'
  )
  const assistantBusy = Boolean(activeAssistantPendingId) || isSending || sessionMessages.some(isAssistantPendingWork)
  const voiceBusy = voiceCaptureStatus === 'processing' || Boolean(voiceResponsePendingId)
  const retryableFailure = Boolean(lastPrompt) && (
    streamState.status === 'lost' ||
    streamState.status === 'fallback' ||
    voiceCaptureStatus === 'error' ||
    sessionMessages.some((message) => message.status === 'failed')
  )
  const primaryComposerAction: 'send' | 'stop' | 'retry' = retryableFailure ? 'retry' : assistantBusy || voiceBusy ? 'stop' : 'send'
  const primaryComposerDisabled = primaryComposerAction === 'send'
    ? !canSend || hasContextUpload || text.trim().length === 0
    : primaryComposerAction === 'retry'
      ? !lastPrompt || !canSend
      : false
  const primaryComposerLabel = primaryComposerAction === 'retry' ? 'Retry' : primaryComposerAction === 'stop' ? 'Stop' : 'Send'
  const primaryComposerAriaLabel = primaryComposerAction === 'retry'
    ? 'Retry last assistant prompt'
    : primaryComposerAction === 'stop'
      ? 'Stop assistant generation'
      : 'Send assistant prompt'
  const contextSummary = summarizeAttachments(attachments)
  const runtimeStrip = useMemo(
    () => buildAssistantRuntimeStrip(runtimeHealth, modelLabel, route, client.transport.kind),
    [runtimeHealth, modelLabel, route, client.transport.kind]
  )
  const surfaceProfile = useMemo(() => getAuroraSurfaceProfile({
    runtimeMode: client.transport.kind === 'tauri-local' ? 'desktop-local' : client.transport.kind === 'native-mobile' ? 'mobile' : undefined,
    transportKind: client.transport.kind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent
  }), [client.transport.kind, nativePlatform])
  const remotePrivacyWarning = assistantRemotePrivacyWarning(route)
  const voiceModel = useMemo(
    () => buildAssistantVoiceModel({
      client,
      route,
      voiceRoutes,
      nativePlatform,
      nativeAvailable,
      nativePermissions,
      nativeCapabilities,
      captureStatus: voiceCaptureStatus,
      consentGranted: voiceConsentGranted,
      voiceEvents,
      waveformBars: voiceWaveformBars
    }),
    [
      client,
      route,
      voiceRoutes,
      nativePlatform,
      nativeAvailable,
      nativePermissions,
      nativeCapabilities,
      voiceCaptureStatus,
      voiceConsentGranted,
      voiceEvents,
      voiceWaveformBars
    ]
  )

  function enqueueStreamedTtsAudio(update: AssistantStreamUpdate) {
    const chunk = update.ttsAudio
    if (!chunk) return
    if (surfaceProfile.usesLocalSidecar) return
    if (chunk.final) {
      if (!streamedTtsAudioRef.current && streamedTtsQueueRef.current.length === 0) {
        setSpeakingMessageId(null)
      }
      return
    }
    if (!chunk.audioData || typeof window === 'undefined') return
    const bytes = base64ToUint8Array(chunk.audioData)
    if (bytes.byteLength === 0) return
    const encoding = (chunk.encoding ?? 'wav').toLowerCase()
    const mimeType = chunk.mimeType ?? (encoding === 'raw' ? 'audio/wav' : `audio/${encoding}`)
    const url = window.URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    streamedTtsQueueRef.current.push(url)
    void drainStreamedTtsAudioQueue()
  }

  async function drainStreamedTtsAudioQueue() {
    if (streamedTtsAudioRef.current) return
    const nextUrl = streamedTtsQueueRef.current.shift()
    if (!nextUrl || typeof Audio === 'undefined') {
      if (!nextUrl) setSpeakingMessageId(null)
      return
    }
    const audio = new Audio(nextUrl)
    streamedTtsAudioRef.current = audio
    const cleanup = () => {
      if (streamedTtsAudioRef.current === audio) streamedTtsAudioRef.current = null
      window.URL.revokeObjectURL(nextUrl)
      void drainStreamedTtsAudioQueue()
    }
    audio.onended = cleanup
    audio.onerror = cleanup
    try {
      await audio.play()
    } catch {
      cleanup()
    }
  }

  function stopStreamedTtsPlayback() {
    const activeAudio = streamedTtsAudioRef.current
    streamedTtsAudioRef.current = null
    activeAudio?.pause()
    for (const url of streamedTtsQueueRef.current) {
      window.URL.revokeObjectURL(url)
    }
    streamedTtsQueueRef.current = []
    setSpeakingMessageId(null)
  }

  async function initializePersistedSessions(generation: number) {
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const listed = await client.memory.listSessions({ type: 'chat', limit: 100 })
      if (!listed.ok) throw listed.error

      let sessions = listed.data.sessions
      let activeSessionId = listed.data.active_session_id ?? sessions[0]?.id ?? null
      if (!activeSessionId) {
        const created = await client.memory.createSession({ type: 'chat' })
        if (!created.ok) throw created.error
        sessions = [created.data.session]
        activeSessionId = created.data.session.id
      }

      const loaded = await client.memory.getSession({
        session_id: activeSessionId,
        activate: true
      })
      if (!loaded.ok) throw loaded.error
      if (sessionLoadGenerationRef.current !== generation) return

      setSessionIndex(upsertSessionByModification(sessions, loaded.data.session))
      setSession(assistantSessionFromPersisted(loaded.data))
    } catch (error) {
      if (sessionLoadGenerationRef.current !== generation) return
      setSessionIndex([])
      setSession(emptyAssistantSession())
      setSessionIndexError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
    } finally {
      if (sessionLoadGenerationRef.current === generation) {
        setSessionIndexLoading(false)
      }
    }
  }

  useEffect(() => {
    return client.auth.subscribe((auth) => {
      const nextScope = `${auth.state}:${auth.principalId ?? ''}`
      if (sessionAuthScopeRef.current === nextScope) return
      sessionAuthScopeRef.current = nextScope
      if (supportsPersistedSessions) {
        sessionLoadGenerationRef.current += 1
        resetConversationUi(emptyAssistantSession())
        setSessionIndex([])
        setSessionIndexError(null)
        setSessionIndexLoading(true)
      }
      setSessionAuthScope(nextScope)
    })
  }, [client, supportsPersistedSessions])

  useEffect(() => {
    if (client.transport.kind === 'mock') {
      const stored = loadAssistantSession(storageKey)
      const nextSession = initialSession ?? (stored.sessionId || stored.messages.length > 0 ? stored : defaultAssistantSessionForTransport(client.transport.kind))
      setSession(nextSession)
      setSessionIndex([])
      setSessionIndexLoading(false)
      setSessionIndexError(null)
      return
    }
    if (!supportsPersistedSessions) {
      setSession(emptyAssistantSession())
      setSessionIndex([])
      setSessionIndexLoading(false)
      setSessionIndexError('Saved chats are unavailable for this connection.')
      return
    }

    const generation = sessionLoadGenerationRef.current + 1
    sessionLoadGenerationRef.current = generation
    setSession(emptyAssistantSession())
    setSessionIndex([])
    void initializePersistedSessions(generation)
  }, [client, client.transport.kind, initialSession, sessionAuthScope, storageKey, supportsPersistedSessions])

  useEffect(() => {
    if (client.transport.kind !== 'mock') return
    persistAssistantSession(storageKey, { ...session, messages: sessionMessages })
  }, [client.transport.kind, session, sessionMessages, storageKey])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) revokeAttachmentPreview(attachment)
  }, [])

  useEffect(() => () => {
    abortRef.current?.abort()
    clearVoiceResponseTimeout()
    clearReadAloudFallbackTimer()
    stopStreamedTtsPlayback()
    stopLocalCapture()
  }, [])

  useEffect(() => {
    let active = true
    setModelCatalogLoading(true)
    setModelCatalogError(null)
    void (async () => {
      const catalog = await client.models.listCatalog({
        include_unavailable: true,
        include_operations: false,
        includeRemote: true,
        includeCloudModels: true
      })
      const remoteCatalogs = await Promise.all(
        executionOptions
          .filter((option) => option.mode === 'dispatch')
          .map(async (execution) => {
            try {
              const remoteCatalog = await client.models.listCatalog({
                include_unavailable: true,
                include_operations: false,
                includeRemote: true,
                includeCloudModels: true,
                meshSelector: {
                  peerId: execution.routePolicy.peerId ?? null,
                  providerId: execution.routePolicy.providerId ?? null,
                  serviceInstanceId: execution.routePolicy.serviceInstanceId ?? null,
                  dataScope: route.item.privacyClass
                }
              })
              return { catalog: remoteCatalog, execution }
            } catch {
              return null
            }
          })
      )
      return mergeAssistantModelCatalogs(
        catalog,
        remoteCatalogs.filter((entry) => entry !== null)
      )
    })()
      .then((catalog) => {
        if (!active) return
        setLocalModelCatalog(catalog)
        const provider = selectedRuntimeProvider(
          catalog.providers.find((candidate) => candidate.provider_id === catalog.selected_provider_id) ?? null,
          catalog.providers
        )
        if (provider?.model_id) setModelLabel(provider.model_id)
        if (provider?.display_name) setRuntimeProviderLabel(provider.display_name)
        setModelCatalogLoading(false)
      })
      .catch((error) => {
        if (!active) return
        setModelCatalogError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
        setModelCatalogLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, executionOptions, route.item.privacyClass])

  useEffect(() => {
    if (selectedExecution.mode !== 'dispatch') {
      setDispatchModelCatalog(null)
      setModelCatalogLoading(localModelCatalog === null)
      setModelCatalogError(null)
      return
    }
    let active = true
    setModelCatalogLoading(true)
    setModelCatalogError(null)
    void client.models.listCatalog({
      include_unavailable: true,
      include_operations: false,
      includeRemote: true,
      includeCloudModels: true,
      meshSelector: {
        peerId: selectedExecution.routePolicy.peerId ?? null,
        providerId: selectedExecution.routePolicy.providerId ?? null,
        serviceInstanceId: selectedExecution.routePolicy.serviceInstanceId ?? null,
        dataScope: route.item.privacyClass
      }
    })
      .then((catalog) => {
        if (!active) return
        setDispatchModelCatalog(catalog)
        setModelCatalogLoading(false)
      })
      .catch((error) => {
        if (!active) return
        setDispatchModelCatalog(null)
        setModelCatalogError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
        setModelCatalogLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, localModelCatalog, route.item.privacyClass, selectedExecution])

  useEffect(() => {
    if (modelChoices.some((choice) => choice.id === selectedModelChoiceId)) return
    setSelectedModelChoiceId(defaultAssistantModelChoiceId(modelChoices, activeModelCatalog, selectedExecution))
  }, [activeModelCatalog, modelChoices, selectedExecution, selectedModelChoiceId])

  useEffect(() => {
    if (recentVoiceEvents.length === 0) return
    setVoiceEvents((current) => mergeVoiceRuntimeEvents(recentVoiceEvents, current).slice(0, 12))
  }, [recentVoiceEvents])

  useEffect(() => {
    voiceCaptureStatusRef.current = voiceCaptureStatus
  }, [voiceCaptureStatus])

  useEffect(() => {
    if (!surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    const releaseFocusedCapture = (event?: Event) => {
      const hidden = document.visibilityState === 'hidden'
      const blurred = typeof document.hasFocus === 'function' && !document.hasFocus()
      const nativeRelease = event?.type === AURORA_RELEASE_FOCUSED_MEDIA_EVENT
      if (!hidden && !blurred && !nativeRelease) return
      if (!voiceStreamRef.current) return
      stopLocalCapture({ finalizeTranscription: false })
      if (voiceCaptureStatusRef.current === 'listening') {
        setVoiceCaptureStatus('idle')
        activeVoiceSessionRef.current = null
        ownedVoiceSessionIdsRef.current.clear()
        voicePendingAssistantIdRef.current = null
        setVoiceResponsePendingId(null)
        setStreamState((current) => ({
          ...current,
          status: 'lost',
          message: 'Microphone listening stopped because Aurora was no longer the active window.'
        }))
      }
    }
    document.addEventListener('visibilitychange', releaseFocusedCapture)
    window.addEventListener('blur', releaseFocusedCapture)
    window.addEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedCapture)
    return () => {
      document.removeEventListener('visibilitychange', releaseFocusedCapture)
      window.removeEventListener('blur', releaseFocusedCapture)
      window.removeEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedCapture)
    }
  }, [surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk])

  useEffect(() => {
    const active = voiceCaptureStatus === 'listening' || voiceCaptureStatus === 'processing' || voiceCaptureStatus === 'speaking'
    if (!active) {
      voiceSessionStartedAtRef.current = null
      setVoiceElapsedSeconds(0)
      return
    }
    if (voiceSessionStartedAtRef.current === null) voiceSessionStartedAtRef.current = Date.now()
    const tick = () => {
      const startedAt = voiceSessionStartedAtRef.current ?? Date.now()
      setVoiceElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }
    tick()
    const interval = window.setInterval(tick, 1000)
    return () => window.clearInterval(interval)
  }, [voiceCaptureStatus])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      try {
        for await (const event of client.assistant.streamVoiceEvents({ signal: controller.signal })) {
          if (!active) return
          applyVoiceRuntimeEvent(event)
          if (event.kind !== 'audio_level') {
            setVoiceEvents((current) => [event, ...current].slice(0, 12))
          }
        }
      } catch (error) {
        if (active) {
          const message = productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error)))
          const currentVoiceState = voiceCaptureStatusRef.current
          if (currentVoiceState === 'listening' || currentVoiceState === 'processing' || currentVoiceState === 'speaking') {
            setLastError(message)
            setStreamState((current) => ({ ...current, status: 'lost', message }))
          }
          setVoiceEvents((current) => current)
        }
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [client])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void (async () => {
      try {
        for await (const update of client.assistant.streamVoiceAssistantResponses({ signal: controller.signal })) {
          if (!active) return
          applyVoiceAssistantResponse(update)
        }
      } catch {
        if (active) {
          const pendingId = voicePendingAssistantIdRef.current
          if (pendingId) {
            markVoiceAssistantFailed(pendingId, 'Voice response stream disconnected before Aurora returned a final response.')
          } else {
            setStreamState((current) => current)
          }
        }
      }
    })()
    return () => {
      active = false
      controller.abort()
    }
  }, [client])

  function resetConversationUi(nextSession: AssistantSessionSnapshot) {
    abortRef.current?.abort()
    stopLocalCapture()
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    cancelledPendingIdsRef.current.clear()
    activePendingIdRef.current = null
    for (const attachment of attachmentsRef.current) revokeAttachmentPreview(attachment)
    setAttachments([])
    setSession(nextSession)
    setLastResult(null)
    setLastError(null)
    setLastPrompt(null)
    setStreamState(idleAssistantStreamState())
    voiceTranscriptPreviewRef.current = ''
    setText('')
  }

  async function openPersistedSession(sessionId: string, activate = true) {
    if (!supportsPersistedSessions) return
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const loaded = await client.memory.getSession({
        session_id: sessionId,
        activate
      })
      if (!loaded.ok) throw loaded.error
      setSessionIndex((current) => upsertSessionByModification(current, loaded.data.session))
      resetConversationUi(assistantSessionFromPersisted(loaded.data))
      window.setTimeout(() => textAreaRef.current?.focus(), 0)
    } catch (error) {
      setSessionIndexError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
    } finally {
      setSessionIndexLoading(false)
    }
  }

  async function refreshPersistedSessionIndex() {
    if (!supportsPersistedSessions) return
    const listed = await client.memory.listSessions({ type: 'chat', limit: 100 })
    if (!listed.ok) {
      setSessionIndexError(productAssistantErrorCopy(listed.error))
      return
    }
    setSessionIndex(sortSessionsByModification(listed.data.sessions))
    setSessionIndexError(null)
  }

  async function createPersistedChatSession(): Promise<DBSessionRecord | null> {
    if (!supportsPersistedSessions) return null
    const created = await client.memory.createSession({ type: 'chat' })
    if (!created.ok) {
      const failureCopy = productAssistantErrorCopy(created.error)
      setSessionIndexError(failureCopy)
      setLastError(failureCopy)
      return null
    }
    setSessionIndex((current) => upsertSessionByModification(current, created.data.session))
    setSessionIndexError(null)
    return created.data.session
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await submitCurrentPrompt()
  }

  async function submitCurrentPrompt() {
    const prompt = text.trim()
    if (!prompt || !canSend || hasContextUpload) return
    // Attachment ingestion is intentionally not wired yet. Keep previews in the UI,
    // but never block or mutate message sending until the backend contract supports it.
    await startAssistantTurn(prompt)
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      event.preventDefault()
      insertComposerNewline()
      return
    }
    event.preventDefault()
    if (primaryComposerAction === 'send' && !primaryComposerDisabled) {
      void submitCurrentPrompt()
    }
  }

  function insertComposerNewline() {
    const element = textAreaRef.current
    if (!element) {
      setText((current) => `${current}\n`)
      return
    }
    const start = element.selectionStart
    const end = element.selectionEnd
    const next = `${text.slice(0, start)}\n${text.slice(end)}`
    setText(next)
    window.setTimeout(() => {
      element.selectionStart = start + 1
      element.selectionEnd = start + 1
    }, 0)
  }

  async function startAssistantTurn(prompt: string, replayFrom: string | null = null) {
    const now = new Date().toISOString()
    const requestId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    let turnSessionId = session.sessionId
    if (!turnSessionId && supportsPersistedSessions) {
      const created = await createPersistedChatSession()
      if (!created) return
      turnSessionId = created.id
    }
    turnSessionId ??= requestId
    const userMessage: AssistantUiMessage = {
      id: `user-${requestId}`,
      role: 'user',
      text: prompt,
      createdAt: now,
      status: 'sent'
    }
      const pendingMessage: AssistantUiMessage = {
      id: requestId,
      role: 'assistant',
      text: replayFrom ? 'Replaying stream from last backend event...' : 'Waiting for Aurora stream...',
      createdAt: now,
      status: 'streaming',
      modelLabel: selectedModelChoice.runtimeModel?.display_name
        ?? selectedModelChoice.runtimeModel?.model_id
        ?? modelLabel
        ?? runtimeHealth?.selectedModel
        ?? null,
      providerLabel: selectedModelChoice.provider?.display_name ?? runtimeProviderLabel ?? route.providerLabel,
      routeLabel: selectedExecution.mode === 'local' ? 'Local' : selectedExecution.label,
      executionPeerId: selectedExecution.routePolicy.peerId
    }

    setText('')
    setLastPrompt(prompt)
    setLastError(null)
    setStreamState({ status: 'streaming', lastEventId: replayFrom, message: replayFrom ? 'Replaying from last known event.' : null })
    setSession((current) => ({
      ...current,
      sessionId: current.sessionId ?? turnSessionId,
      messages: [...current.messages, userMessage, pendingMessage]
    }))

    const abort = new AbortController()
    abortRef.current = abort
    activePendingIdRef.current = pendingMessage.id
    setActiveAssistantPendingId(pendingMessage.id)
    cancelledPendingIdsRef.current.delete(pendingMessage.id)
    let terminalSeen = false
    try {
      for await (const update of client.assistant.streamMessage({
        text: prompt,
        sessionId: turnSessionId,
        requestId,
        routePolicy,
        inferencePolicy,
        signal: abort.signal,
        replayFrom,
        clientTtsPlayback: !surfaceProfile.usesLocalSidecar
      })) {
        applyAssistantStreamUpdate(update, pendingMessage.id)
        if (update.kind === 'completed') {
          terminalSeen = true
          continue
        }
        if (isAssistantStreamHardTerminal(update)) {
          terminalSeen = true
          break
        }
      }
      if (!terminalSeen && !abort.signal.aborted && !cancelledPendingIdsRef.current.has(pendingMessage.id)) {
        markAssistantTurnFailed(pendingMessage.id, 'Assistant stream ended before Aurora returned a final response. Retry will resend the last prompt.')
      }
    } catch (error) {
      if (!abort.signal.aborted && !cancelledPendingIdsRef.current.has(pendingMessage.id)) {
        markAssistantTurnFailed(pendingMessage.id, productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
      }
    } finally {
      if (abortRef.current === abort) abortRef.current = null
      if (activePendingIdRef.current === pendingMessage.id) activePendingIdRef.current = null
      setActiveAssistantPendingId((current) => current === pendingMessage.id ? null : current)
      void refreshPersistedSessionIndex()
    }
  }

  function markAssistantTurnFailed(pendingId: string, failureCopy: string) {
    setLastError(failureCopy)
    setStreamState((current) => ({
      status: 'lost',
      lastEventId: current.lastEventId,
      message: failureCopy
    }))
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? {
              ...message,
              text: message.text.trim() && message.text !== 'Waiting for Aurora stream...' ? message.text : failureCopy,
              status: 'failed',
              error: failureCopy
            }
          : message
      )
    }))
  }

  async function ingestPendingAttachments(): Promise<'ready' | 'blocked'> {
    if (attachments.some((attachment) => attachment.status === 'rejected' || attachment.status === 'unsupported')) {
      setLastError('Remove rejected or unsupported context items before sending.')
      return 'blocked'
    }
    const pending = attachments.filter((attachment) => attachment.status === 'staged' || attachment.status === 'error')
    if (pending.length === 0) return 'ready'

    setLastError(null)
    setAttachments((current) =>
      current.map((attachment) =>
        pending.some((candidate) => candidate.id === attachment.id)
          ? { ...attachment, status: 'uploading', progress: 48, message: 'Uploading context metadata through Aurora' }
          : attachment
      )
    )

    const result = await client.assistant.ingestContext({
      items: pending.map(attachmentToContextItem),
      session_id: session.sessionId,
      namespace: 'assistant.attachments',
      storage_policy: 'ephemeral',
      privacy_class: privacyClass,
      limits: defaultContextLimits
    })

    if (!result.ok) {
      const message = productAssistantErrorCopy(result.error)
      setLastError(message)
      setAttachments((current) =>
        current.map((attachment) =>
          pending.some((candidate) => candidate.id === attachment.id)
            ? { ...attachment, status: 'error', progress: 0, message }
            : attachment
        )
      )
      return 'blocked'
    }

    applyContextIngestResult(pending, result.data)
    return result.data.accepted && !result.data.rejected ? 'ready' : 'blocked'
  }

  function applyContextIngestResult(
    pending: AssistantAttachmentDraft[],
    response: AttachmentContextIngestResponse
  ) {
    const outcomes = mapContextIngestOutcomesByPendingIndex(response)
    setAttachments((current) =>
      current.map((attachment) => {
        const pendingIndex = pending.findIndex((candidate) => candidate.id === attachment.id)
        if (pendingIndex === -1) return attachment
        const outcome = outcomes.get(pendingIndex)
        if (!outcome) {
          return { ...attachment, status: 'error', progress: 0, message: 'No backend outcome was returned for this context item.' }
        }
        return {
          ...attachment,
          status: attachmentStatusFromBackend(outcome.status),
          progress: isAcceptedContextStatus(outcome.status) ? 100 : 0,
          message: outcome.message || outcome.reason_code || 'Context ingestion completed.',
          reasonCode: outcome.reason_code,
          redacted: outcome.redacted
        }
      })
    )
    if (response.rejected) {
      setLastError('Some context items were rejected or unsupported. Remove or revise them before retrying.')
    }
  }

  function applyAssistantResult(result: AuroraResponse<import('@aurora/client').AssistantSendMessageResult>, pendingId: string) {
    if (result.ok) {
      setLastResult(result.data.response)
      setModelLabel(result.data.modelLabel)
      const providerLabel = metadataStringValue(result.data.metadata, 'provider_label') ?? metadataStringValue(result.data.metadata, 'provider') ?? runtimeProviderLabel ?? route.providerLabel
      setRuntimeProviderLabel(providerLabel)
      setSession((current) => ({
        sessionId: result.data.sessionId,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                id: result.data.response.id,
                role: 'assistant',
                text: result.data.response.text,
                createdAt: result.data.response.createdAt,
                status: 'sent',
                modelLabel: result.data.modelLabel,
                providerLabel,
                routeLabel: selectedExecution.mode === 'local' ? 'Local' : selectedExecution.label,
                executionPeerId: selectedExecution.routePolicy.peerId
              }
            : message
        )
      }))
      return
    }

    const failureCopy = productAssistantErrorCopy(result.error)
    setLastError(failureCopy)
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? {
              ...message,
              text: failureCopy,
              status: 'failed',
              error: failureCopy
            }
          : message
      )
    }))
  }

  function applyAssistantStreamUpdate(update: AssistantStreamUpdate, pendingId: string) {
    if (cancelledPendingIdsRef.current.has(pendingId)) return
    if (update.eventId) {
      setStreamState((current) => ({ ...current, lastEventId: update.eventId }))
    }
    if (update.modelLabel) setModelLabel(update.modelLabel)
    const updateProviderLabel = metadataStringValue(update.metadata ?? {}, 'provider_label') ?? metadataStringValue(update.metadata ?? {}, 'provider')
    if (updateProviderLabel) setRuntimeProviderLabel(updateProviderLabel)
    if (update.kind === 'transport_lost') {
      const failureCopy = productAssistantErrorCopy(update.error ?? new Error('Assistant stream disconnected.'))
      setLastError(failureCopy)
      setStreamState((current) => ({
        status: 'lost',
        lastEventId: current.lastEventId,
        message: 'The answer was interrupted. Replay will continue from the last saved update when available.'
      }))
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                text: message.text.trim() ? message.text : failureCopy,
                status: 'failed',
                error: failureCopy
              }
            : message
        )
      }))
      return
    }
    if (update.kind === 'tool') {
      setSession((current) => ({
        ...current,
        sessionId: update.sessionId ?? current.sessionId,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantToolUpdate(message, update) : message
        )
      }))
      setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora needs your approval before continuing.' }))
      return
    }
    if (update.kind === 'tts_audio_chunk') {
      clearReadAloudFallbackTimer()
      enqueueStreamedTtsAudio(update)
      if (lastAssistantMessageIdRef.current === null) lastAssistantMessageIdRef.current = pendingId
      if (!speakingMessageIdRef.current) setSpeakingMessageId(lastAssistantMessageIdRef.current)
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantAudioChunkUpdate(message, update) : message
        )
      }))
      setStreamState((current) => ({
        ...current,
        status: current.status === 'streaming' ? 'streaming' : current.status,
        message: 'TTS audio chunk received; playback state is separate from the composer.'
      }))
      return
    }
    if (update.kind === 'failed') {
      const failureCopy = productAssistantErrorCopy(update.error ?? new Error(update.text))
      setLastError(failureCopy)
      setStreamState((current) => ({ ...current, status: 'lost', message: failureCopy }))
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                text: failureCopy,
                status: 'failed',
                error: failureCopy
              }
            : message
        )
      }))
      return
    }
    if (update.kind === 'fallback') {
      setStreamState((current) => ({
        status: 'fallback',
        lastEventId: update.eventId ?? current.lastEventId,
        message: 'Streaming was unavailable; Aurora returned a final non-streaming response.'
      }))
    }
    if (update.kind === 'completed' || update.kind === 'fallback') {
      setLastResult({
        id: update.eventId ?? `assistant-${Date.now()}`,
        role: 'assistant',
        text: update.text,
        createdAt: new Date().toISOString()
      })
        const finalAssistantId = update.messageId ?? pendingId
        lastAssistantMessageIdRef.current = finalAssistantId
        setSession((current) => {
        const existing = current.messages.find((message) => message.id === finalAssistantId)
        const baseMessage: AssistantUiMessage = existing ?? {
          id: finalAssistantId,
          role: 'assistant',
          text: '',
          createdAt: new Date().toISOString(),
          status: 'streaming',
          modelLabel: modelLabel ?? runtimeHealth?.selectedModel ?? null,
          providerLabel: runtimeProviderLabel ?? route.providerLabel,
          routeLabel: selectedExecution.mode === 'local' ? 'Local' : selectedExecution.label,
          executionPeerId: selectedExecution.routePolicy.peerId
        }
        const terminalMessage = applyAssistantTerminalUpdate({
          ...baseMessage,
          modelLabel: update.modelLabel ?? baseMessage.modelLabel,
          providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? baseMessage.providerLabel,
          routeLabel: baseMessage.routeLabel ?? (selectedExecution.mode === 'local' ? 'Local' : selectedExecution.label),
          executionPeerId: baseMessage.executionPeerId ?? selectedExecution.routePolicy.peerId
        }, update)
        lastAssistantMessageIdRef.current = terminalMessage.id
        const replaced = current.messages.some((message) => message.id === terminalMessage.id)
        return {
          sessionId: update.sessionId ?? current.sessionId ?? session.sessionId,
          messages: replaced
            ? current.messages.map((message) => message.id === terminalMessage.id ? terminalMessage : message)
            : [...current.messages, terminalMessage]
        }
      })
      if (update.kind === 'completed') {
      setStreamState((current) => ({ ...current, status: 'idle', message: 'Aurora finished responding.' }))
      }
      return
    }
    if (update.kind === 'delta') {
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantStreamDelta(message, update) : message
        )
      }))
    }
  }

  function applyVoiceRuntimeEvent(event: VoiceRuntimeEvent) {
    const eventKey = voiceRuntimeEventKey(event)
    if (event.kind !== 'audio_level') {
      if (appliedVoiceEventIdsRef.current.has(eventKey)) return
      appliedVoiceEventIdsRef.current.add(eventKey)
    }
    if (event.kind === 'audio_level') {
      if (!shouldApplyVoiceRuntimeEvent(event, activeVoiceSessionRef.current, voiceCaptureStatusRef.current)) return
      setVoiceWaveformBars(event.bars?.length ? event.bars : waveformBarsFromLevel(event.level ?? 0, event.peak ?? event.level ?? 0))
      if (event.sessionId) {
        ownedVoiceSessionIdsRef.current.add(event.sessionId)
        activeVoiceSessionRef.current = event.sessionId
      }
      return
    }
    if (event.kind === 'wakeword_detected') {
      setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: event.text ? `Wake word heard: ${event.text}` : 'Wake word heard.'
      }))
      return
    }
    if (event.kind === 'session_started') {
      if (event.sessionId) {
        const activeSessionId = activeVoiceSessionRef.current
        if (shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, voiceCaptureStatusRef.current)) return
        if (!ownedVoiceSessionIdsRef.current.has(event.sessionId) && !isLocalVoiceEventSource(event)) return
        ownedVoiceSessionIdsRef.current.add(event.sessionId)
        if (isAuthoritativeCoordinatorSessionStart(event)) {
          coordinatorVoiceSessionIdsRef.current.add(event.sessionId)
        }
        activeVoiceSessionRef.current = event.sessionId
      }
      voiceTranscriptPreviewRef.current = ''
      setText('')
      setVoiceCaptureStatus('listening')
      setStreamState((current) => ({ ...current, status: 'streaming', message: event.text ? `Wake word heard: ${event.text}` : 'Aurora is listening.' }))
      if (surfaceProfile.voiceCapture.canUseWebViewVisualizer) {
        void startLocalAudioCapture({ recordForTranscription: false, optionalVisualizer: true }).catch((error: unknown) => {
          setLastError(productAudioCaptureErrorCopy(error))
        })
      }
      return
    }
    if (event.kind === 'transcription_partial') {
      if (!isAuthoritativeVoiceTranscriptEvent(event)) return
      const transcriptSessionId = event.sessionId ?? activeVoiceSessionRef.current
      if (!transcriptSessionId || !coordinatorVoiceSessionIdsRef.current.has(transcriptSessionId)) return
      if (!shouldApplyVoiceRuntimeEvent(event, activeVoiceSessionRef.current, voiceCaptureStatusRef.current)) return
      if (event.sessionId) {
        ownedVoiceSessionIdsRef.current.add(event.sessionId)
        activeVoiceSessionRef.current = event.sessionId
      }
      if (event.text) {
        const preview = mergeTranscriptText(voiceTranscriptPreviewRef.current, event.text, { appendOnMiss: false })
        voiceTranscriptPreviewRef.current = preview
        setText(preview)
      }
      setVoiceCaptureStatus('listening')
      return
    }
    if (event.kind === 'transcription_final') {
      if (!isAuthoritativeVoiceTranscriptEvent(event)) return
      const transcriptSessionId = event.sessionId ?? activeVoiceSessionRef.current
      if (!transcriptSessionId || !coordinatorVoiceSessionIdsRef.current.has(transcriptSessionId)) return
      if (!shouldApplyVoiceRuntimeEvent(event, activeVoiceSessionRef.current, voiceCaptureStatusRef.current)) return
      if (event.sessionId) {
        ownedVoiceSessionIdsRef.current.add(event.sessionId)
        activeVoiceSessionRef.current = event.sessionId
      }
      const transcript = mergeTranscriptText(voiceTranscriptPreviewRef.current, event.text ?? '', { appendOnMiss: false }).trim()
      stopLocalCapture({ finalizeTranscription: false })
      setVoiceCaptureStatus('idle')
      setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
      if (!transcript) {
        setVoiceCaptureStatus('idle')
        return
      }
      const userId = `voice-user-${event.sessionId ?? eventKey}`
      const pendingId = event.sessionId ?? `voice-assistant-${eventKey}`
      voicePendingAssistantIdRef.current = pendingId
      setVoiceResponsePendingId(pendingId)
      armVoiceResponseTimeout(pendingId)
      voiceTranscriptPreviewRef.current = ''
      setText('')
      setLastPrompt(transcript)
      setSession((current) => {
        const hasUser = current.messages.some((message) => message.id === userId)
        const hasPending = current.messages.some((message) => message.id === pendingId)
        return {
          sessionId: event.sessionId ?? current.sessionId,
          messages: [
            ...current.messages,
            ...(hasUser ? [] : [{
              id: userId,
              role: 'user' as const,
              text: transcript,
              createdAt: event.occurredAt,
              status: 'sent' as const
            }]),
            ...(hasPending ? [] : [{
              id: pendingId,
              role: 'assistant' as const,
              text: 'Aurora is processing your voice request…',
              createdAt: new Date().toISOString(),
              status: 'streaming' as const,
              modelLabel: modelLabel ?? runtimeHealth?.selectedModel ?? null,
              providerLabel: runtimeProviderLabel ?? route.providerLabel,
              routeLabel: 'Local'
            }])
          ]
        }
      })
      return
    }
    if (event.kind === 'session_ended') {
      if (!shouldApplyVoiceSessionEndEvent(event, activeVoiceSessionRef.current, voiceCaptureStatusRef.current)) return
      stopLocalCapture({ finalizeTranscription: false })
      setSpeakingMessageId(null)
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      return
    }
    if (event.kind === 'tts_started') {
      clearReadAloudFallbackTimer()
      settleVoicePendingFromObservedText(event.text, 'tts_started')
      settleSubstantiveStreamingAssistantMessages('tts_started')
      // TTS playback must not keep the composer or push-to-talk controls in a stop state.
      if (voiceCaptureStatusRef.current !== 'listening') {
        stopLocalCapture({ finalizeTranscription: false })
        setVoiceCaptureStatus('idle')
      }
      if (!speakingMessageIdRef.current && lastAssistantMessageIdRef.current) {
        setSpeakingMessageId(lastAssistantMessageIdRef.current)
      }
      return
    }
    if (event.kind === 'tts_stopped' || event.kind === 'tts_paused' || event.kind === 'tts_resumed') {
      if (event.kind === 'tts_stopped') setSpeakingMessageId(null)
      if (voiceCaptureStatusRef.current !== 'listening') setVoiceCaptureStatus('idle')
      return
    }
    if (event.kind === 'tts_error') {
      clearReadAloudFallbackTimer()
      setSpeakingMessageId(null)
      if (event.reason) setLastError(event.reason)
      setVoiceCaptureStatus('idle')
      return
    }
    if (event.state === 'denied' || event.state === 'error' || event.state === 'timeout' || event.state === 'disconnected') {
      setVoiceCaptureStatus(event.state === 'denied' ? 'permission-denied' : 'error')
      if (event.reason) setLastError(event.reason)
    }
  }

  function applyVoiceAssistantResponse(update: AssistantStreamUpdate) {
    const pendingId = voicePendingAssistantIdRef.current
    if (update.modelLabel) setModelLabel(update.modelLabel)
    const providerLabel = metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? runtimeProviderLabel ?? route.providerLabel
    if (providerLabel) setRuntimeProviderLabel(providerLabel)
    if (!pendingId && supportsPersistedSessions && update.sessionId && (update.kind === 'completed' || update.kind === 'fallback')) {
      setVoiceCaptureStatus('idle')
      setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      setStreamState((current) => ({ ...current, status: 'idle', message: 'Voice response was saved to the active chat.' }))
      void openPersistedSession(update.sessionId, false)
      return
    }
    if (update.kind === 'failed' || update.kind === 'transport_lost') {
      const failureCopy = productAssistantErrorCopy(update.error ?? new Error(update.text || 'Voice assistant response failed.'))
      setLastError(failureCopy)
      setVoiceCaptureStatus('error')
      voicePendingAssistantIdRef.current = null
      setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      if (!pendingId) return
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? { ...message, text: failureCopy, status: 'failed', error: failureCopy } : message
        )
      }))
      return
    }
    const textDelta = update.textDelta || update.text
    if (update.kind === 'delta' && pendingId) {
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantStreamDelta(message, { ...update, textDelta }) : message
        )
      }))
      return
    }
    if (update.kind === 'tool' && pendingId) {
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantToolUpdate(message, update, 'Aurora is processing your voice request…') : message
        )
      }))
      return
    }
    if (update.kind === 'tts_audio_chunk') {
      clearReadAloudFallbackTimer()
      enqueueStreamedTtsAudio(update)
      if (pendingId && !speakingMessageIdRef.current) setSpeakingMessageId(pendingId)
      if (pendingId) {
        setSession((current) => ({
          ...current,
          messages: current.messages.map((message) =>
            message.id === pendingId ? applyAssistantAudioChunkUpdate(message, update) : message
          )
        }))
      }
      setVoiceCaptureStatus('idle')
      setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
      setStreamState((current) => ({ ...current, status: 'idle', message: 'Voice response audio chunk received; composer is ready.' }))
      return
    }
    if (update.kind !== 'completed' && update.kind !== 'fallback') return
    setVoiceCaptureStatus('idle')
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
    clearVoiceResponseTimeout()
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    setStreamState((current) => ({ ...current, status: 'idle', message: 'Voice response received from Aurora.' }))
    setSession((current) => {
      const finalAssistantId = update.messageId ?? pendingId ?? `assistant-voice-${Date.now()}`
      const existing = current.messages.find((message) => message.id === finalAssistantId)
      const assistantMessage = applyAssistantTerminalUpdate({
        id: finalAssistantId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        status: 'streaming',
        modelLabel: update.modelLabel ?? modelLabel,
        providerLabel,
        routeLabel: 'Local',
        ...(existing || {})
      }, update)
      setLastResult({
        id: assistantMessage.id,
        role: 'assistant',
        text: assistantMessage.text,
        createdAt: assistantMessage.createdAt
      })
      lastAssistantMessageIdRef.current = assistantMessage.id
      const replaced = current.messages.some((message) => message.id === assistantMessage.id)
      return {
        sessionId: update.sessionId ?? current.sessionId,
        messages: replaced
          ? current.messages.map((message) => message.id === assistantMessage.id ? assistantMessage : message)
          : [...current.messages, assistantMessage]
      }
    })
  }


  function armVoiceResponseTimeout(pendingId: string) {
    clearVoiceResponseTimeout()
    if (typeof window === 'undefined') return
    voiceResponseTimeoutRef.current = window.setTimeout(() => {
      if (voicePendingAssistantIdRef.current !== pendingId) return
      markVoiceAssistantFailed(pendingId, 'Aurora did not return a voice response before the response timeout. Retry will resend the final transcript.')
    }, 120_000)
  }

  function clearVoiceResponseTimeout() {
    if (voiceResponseTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(voiceResponseTimeoutRef.current)
    }
    voiceResponseTimeoutRef.current = null
  }

  function markVoiceAssistantFailed(pendingId: string, failureCopy: string) {
    setLastError(failureCopy)
    setVoiceCaptureStatus('error')
    setStreamState((current) => ({
      status: 'lost',
      lastEventId: current.lastEventId,
      message: failureCopy
    }))
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
    clearVoiceResponseTimeout()
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === pendingId
          ? { ...message, text: failureCopy, status: 'failed', error: failureCopy }
          : message
      )
    }))
  }

  function settleSubstantiveStreamingAssistantMessages(reason: 'tts_started' | 'response_text_observed') {
    let settledVoicePending = false
    let settledActivePending = false
    setSession((current) => {
      let changed = false
      const messages = current.messages.map((message) => {
        if ((message.status === 'streaming' || message.status === 'sending') && hasSubstantiveAssistantText(message)) {
          changed = true
          if (message.id === voicePendingAssistantIdRef.current) settledVoicePending = true
          if (message.id === activePendingIdRef.current) settledActivePending = true
          return { ...message, status: 'sent' as const }
        }
        return message
      })
      return changed ? { ...current, messages } : current
    })
    if (settledVoicePending) {
      voicePendingAssistantIdRef.current = null
      setVoiceResponsePendingId(null)
      clearVoiceResponseTimeout()
    }
    if (settledActivePending) {
      activePendingIdRef.current = null
      setActiveAssistantPendingId(null)
    }
    setStreamState((current) => current.status === 'streaming'
      ? { ...current, status: 'idle', message: reason === 'tts_started' ? 'Assistant response received; TTS playback is separate.' : current.message }
      : current)
  }

  function settleVoicePendingFromObservedText(observedText: string | null, reason: 'tts_started' | 'assistant_response') {
    const pendingId = voicePendingAssistantIdRef.current
    const textFromPlayback = observedText?.trim()
    if (!pendingId || !textFromPlayback) return
    let settled = false
    setSession((current) => {
      let changed = false
      const messages = current.messages.map((message) => {
        if (message.id !== pendingId) return message
        changed = true
        settled = true
        return {
          ...message,
          text: isAssistantPlaceholderText(message.text) ? textFromPlayback : message.text,
          status: 'sent' as const
        }
      })
      return changed ? { ...current, messages } : current
    })
    if (!settled) return
    lastAssistantMessageIdRef.current = pendingId
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
    clearVoiceResponseTimeout()
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    setVoiceCaptureStatus('idle')
    setStreamState((current) => current.status === 'streaming'
      ? {
          ...current,
          status: 'idle',
          message: reason === 'tts_started'
            ? 'Assistant text observed from TTS playback; generation is complete.'
            : 'Voice response received from Aurora.'
        }
      : current)
  }

  async function readAssistantMessageAloud(message: AssistantUiMessage) {
    const speakableText = message.text.trim()
    if (!speakableText) return
    if (speakingMessageIdRef.current === message.id) {
      await stopReadAloud('user_interrupt')
      return
    }
    setLastError(null)
    setSpeakingMessageId(message.id)
    lastAssistantMessageIdRef.current = message.id
    try {
      const result = await client.assistant.requestReadAloud({ text: speakableText, interrupt: true })
      if (result.ok) {
        setStreamState((current) => ({ ...current, message: 'Reading assistant response through Aurora TTS.' }))
        scheduleBrowserReadAloudFallback(speakableText, message.id)
        return
      }
      throw result.error
    } catch (error) {
      if (browserReadAloud(speakableText, message.id)) {
        setStreamState((current) => ({ ...current, message: 'Aurora is reading this response on this device.' }))
        return
      }
      setSpeakingMessageId(null)
      setLastError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
    }
  }

  async function resolveAssistantToolApproval(
    tool: AssistantToolCallCard,
    approve: boolean,
    grantScope: AssistantApprovalGrantScope
  ) {
    if (!tool.pendingId && !tool.approvalRequestId) {
      setLastError('This tool approval card is missing backend approval identifiers.')
      return
    }
    setLastError(null)
    setSession((current) => ({
      ...current,
      messages: current.messages.map((message) => ({
        ...message,
        toolCalls: message.toolCalls?.map((candidate) =>
          candidate.id === tool.id ? { ...candidate, resolving: true } : candidate
        )
      }))
    }))
    try {
      const request: Parameters<typeof client.assistant.resumeToolApproval>[0] = {
        approve,
        grant_scope: grantScope,
        session_id: tool.sessionId ?? session.sessionId,
        approver_principal_id: 'aurora-ui',
        reason: approve ? `Approved ${tool.name} from assistant inline card.` : `Denied ${tool.name} from assistant inline card.`
      }
      if (tool.pendingId !== undefined) request.pending_id = tool.pendingId
      if (tool.approvalRequestId !== undefined) request.approval_request_id = tool.approvalRequestId
      const result = await client.assistant.resumeToolApproval(request)
      if (!result.ok) throw result.error
      const response = result.data
      if (!response.ok) throw new Error(response.error ?? 'Tool approval resume failed.')
      const assistantText = typeof response.assistant_text === 'string' ? response.assistant_text : ''
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) => {
          if (!message.toolCalls?.some((candidate) => candidate.id === tool.id)) return message
          return {
            ...message,
            text: assistantText.trim()
              ? assistantText
              : approve
                ? message.text
                : 'Aurora will continue without this tool because it was denied.',
            status: approve ? 'sent' : 'failed',
            toolCalls: message.toolCalls.map((candidate) =>
              candidate.id === tool.id
                ? {
                    ...candidate,
                    resolving: false,
                    status: approve ? 'completed' : 'failed',
                    summary: approve
                      ? 'Approved inline and executed by Aurora.'
                      : 'Denied inline by the operator.',
                    error: approve ? null : 'approval_denied',
                    resultPreview: approve ? response.tool_result ?? candidate.resultPreview ?? null : candidate.resultPreview ?? null
                  }
                : candidate
            )
          }
        })
      }))
    } catch (error) {
      const message = productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error)))
      setLastError(message)
      setSession((current) => ({
        ...current,
        messages: current.messages.map((chatMessage) => ({
          ...chatMessage,
          toolCalls: chatMessage.toolCalls?.map((candidate) =>
            candidate.id === tool.id
              ? { ...candidate, resolving: false, status: 'failed', error: message }
              : candidate
          )
        }))
      }))
    }
  }

  async function stopReadAloud(reason: string) {
    clearReadAloudFallbackTimer()
    readAloudFallbackTokenRef.current += 1
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    setSpeakingMessageId(null)
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      scopes: ['tts_playback'],
      reason
    })
    if (!result.ok) setLastError(productAssistantErrorCopy(result.error))
  }

  function clearReadAloudFallbackTimer() {
    if (readAloudFallbackTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(readAloudFallbackTimerRef.current)
    }
    readAloudFallbackTimerRef.current = null
  }

  function browserReadAloud(textToSpeak: string, messageId: string | null = null): boolean {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(textToSpeak)
    const token = readAloudFallbackTokenRef.current
    if (messageId) setSpeakingMessageId(messageId)
    utterance.onend = () => {
      if (readAloudFallbackTokenRef.current === token && (!messageId || speakingMessageIdRef.current === messageId)) {
        setSpeakingMessageId(null)
      }
    }
    utterance.onerror = () => {
      if (readAloudFallbackTokenRef.current === token && (!messageId || speakingMessageIdRef.current === messageId)) {
        setSpeakingMessageId(null)
      }
    }
    window.speechSynthesis.speak(utterance)
    return true
  }

  function scheduleBrowserReadAloudFallback(textToSpeak: string, messageId: string) {
    if (typeof window === 'undefined') return
    clearReadAloudFallbackTimer()
    const token = readAloudFallbackTokenRef.current + 1
    readAloudFallbackTokenRef.current = token
    readAloudFallbackTimerRef.current = window.setTimeout(() => {
      if (readAloudFallbackTokenRef.current !== token) return
      if (browserReadAloud(textToSpeak, messageId)) {
      setStreamState((current) => ({ ...current, message: 'Aurora is reading this response on this device.' }))
      }
    }, 2500)
  }

  async function onCancel() {
    if (!controls.canCancel) return
    const pendingId = activePendingIdRef.current
    if (pendingId) cancelledPendingIdsRef.current.add(pendingId)
    abortRef.current?.abort()
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      reason: 'user_interrupt'
    })
    if (result.ok) {
      setStreamState((current) => ({ ...current, status: 'cancelled', message: `Interrupt ${result.data.status}` }))
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.status === 'streaming' || message.status === 'sending'
            ? { ...message, status: 'cancelled', text: message.text.trim() ? message.text : 'Stopped by user.' }
            : message
        )
      }))
      return
    }
    setLastError(productAssistantErrorCopy(result.error))
  }

  async function retryLastPrompt(replay = false) {
    if (!lastPrompt || !canSend) return
    await startAssistantTurn(replay ? lastPrompt : lastPrompt, replay ? streamState.lastEventId : null)
  }

  async function onPrimaryComposerAction() {
    if (primaryComposerAction === 'retry') {
      await retryLastPrompt(false)
      return
    }
    if (primaryComposerAction !== 'stop') return
    if (voiceCaptureStatus === 'listening') {
      await toggleLocalCapture()
      return
    }
    await onCancel()
  }

  async function openAttachmentPicker() {
    if (!canAttach) return
    const picker = typeof window === 'undefined'
      ? undefined
      : (window as unknown as { showOpenFilePicker?: BrowserOpenFilePicker }).showOpenFilePicker
    if (!picker) {
      attachmentInputRef.current?.click()
      return
    }
    try {
      const handles = await picker({
        multiple: true,
        excludeAcceptAllOption: true,
        types: [{
          description: 'Aurora context files',
          accept: {
            'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
            'application/pdf': ['.pdf'],
            'application/json': ['.json'],
            'text/plain': ['.txt'],
            'text/markdown': ['.md', '.markdown']
          }
        }]
      })
      const files = await Promise.all(handles.map((handle) => handle.getFile()))
      await stageAttachmentFiles(files)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      attachmentInputRef.current?.click()
    }
  }

  async function onFileInput(files: FileList | null) {
    if (!files || !canAttach) return
    await stageAttachmentFiles([...files])
  }

  async function stageAttachmentFiles(files: File[]) {
    const drafts = await Promise.all(files.map((file) => fileToAttachmentDraft(file, 'chat', privacyClass)))
    const supported = drafts.filter((draft) => draft.status !== 'rejected' && draft.status !== 'unsupported')
    // The picker should filter these, but some WebViews still expose an "All files" path.
    // Silently drop unsupported files so the composer never shows rejected attachment cards.
    if (supported.length === 0) return
    setAttachments((current) => [...current, ...supported])
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id)
      if (removed) revokeAttachmentPreview(removed)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  function requestVoiceToggle() {
    if (voiceToggleInFlightRef.current) return
    voiceToggleInFlightRef.current = true
    const unlock = typeof window === 'undefined'
      ? null
      : window.setTimeout(() => {
          voiceToggleInFlightRef.current = false
        }, 12_000)
    void toggleLocalCapture().finally(() => {
      if (unlock !== null) window.clearTimeout(unlock)
      voiceToggleInFlightRef.current = false
    })
  }

  async function startCoordinatorPushToTalk(sessionId: string, options: { fallback?: boolean } = {}): Promise<boolean> {
    activeVoiceSessionRef.current = sessionId
    ownedVoiceSessionIdsRef.current.add(sessionId)
    setVoiceConsentGranted(true)
    setVoiceCaptureStatus('listening')
    setStreamState((current) => ({
      ...current,
      status: 'streaming',
      message: options.fallback
        ? 'Focused microphone access was unavailable; Aurora is listening on this computer instead.'
        : 'Starting microphone listening on this computer...'
    }))
    try {
      const started = await client.assistant.startVoiceListen({ sessionId, timeoutMs: 8_000 })
      if (!started.ok) {
        activeVoiceSessionRef.current = null
        ownedVoiceSessionIdsRef.current.delete(sessionId)
        setLastError(productAssistantErrorCopy(started.error))
        setVoiceCaptureStatus('error')
        setStreamState((current) => ({ ...current, status: 'lost', message: productAssistantErrorCopy(started.error) }))
        return false
      }
      activeVoiceSessionRef.current = started.data.sessionId
      ownedVoiceSessionIdsRef.current.add(started.data.sessionId)
      coordinatorVoiceSessionIdsRef.current.add(started.data.sessionId)
      setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: options.fallback
          ? 'Aurora is listening on this computer.'
          : 'Aurora is listening on this computer.'
      }))
      void startLocalAudioCapture({ recordForTranscription: false, optionalVisualizer: true }).catch(() => {
        setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora is listening on this computer; live microphone levels are unavailable.' }))
      })
      return true
    } catch (error) {
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.delete(sessionId)
      const message = productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error)))
      setLastError(message)
      setVoiceCaptureStatus('error')
      setStreamState((current) => ({ ...current, status: 'lost', message }))
      return false
    }
  }

  async function interruptTtsForVoiceCapture() {
    if (speakingMessageIdRef.current) setSpeakingMessageId(null)
    clearReadAloudFallbackTimer()
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      scopes: ['tts_playback'],
      reason: 'voice_capture_started'
    })
    if (!result.ok) setLastError(productAssistantErrorCopy(result.error))
  }

  async function toggleLocalCapture() {
    const currentCaptureStatus = voiceCaptureStatusRef.current
    if (currentCaptureStatus === 'listening') {
      const sessionId = activeVoiceSessionRef.current
      if (sessionId && coordinatorVoiceSessionIdsRef.current.has(sessionId)) {
        const stopped = await client.assistant.stopVoiceListen({ sessionId, reason: 'user_request' })
        if (!stopped.ok) setLastError(productAssistantErrorCopy(stopped.error))
      }
      stopLocalCapture({ finalizeTranscription: currentCaptureStatus === 'listening' })
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      voicePendingAssistantIdRef.current = null
      setVoiceResponsePendingId(null)
      return
    }
    const sessionId = `voice-${Date.now()}`
    voiceTranscriptPreviewRef.current = ''
    setLastError(null)
    void interruptTtsForVoiceCapture()
    if (!surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk) {
      await startCoordinatorPushToTalk(sessionId)
      return
    }

    activeVoiceSessionRef.current = sessionId
    ownedVoiceSessionIdsRef.current.add(sessionId)
    try {
      setVoiceConsentGranted(true)
      setVoiceCaptureStatus('listening')
      setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: 'Requesting focused microphone access for push-to-talk…'
      }))
      await startLocalAudioCapture({ recordForTranscription: true })
      setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: surfaceProfile.kind === 'desktop-local'
          ? 'Focused push-to-talk is using this window. Background wake listening remains separate.'
          : 'Focused browser microphone capture is active.'
      }))
      return
    } catch (error) {
      stopLocalCapture({ finalizeTranscription: false })
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      if (surfaceProfile.kind === 'desktop-local' && surfaceProfile.usesLocalSidecar) {
        setLastError(null)
        const fallbackStarted = await startCoordinatorPushToTalk(sessionId, { fallback: true })
        if (fallbackStarted) return
      }
      const name = error instanceof DOMException ? error.name : ''
      setLastError(productAudioCaptureErrorCopy(error))
      setVoiceCaptureStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'permission-denied' : 'no-device')
    }
  }

  async function startLocalAudioCapture({ recordForTranscription, optionalVisualizer = false }: { recordForTranscription: boolean; optionalVisualizer?: boolean }) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('This platform did not expose a browser microphone API to the Aurora UI.')
    }
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }),
      8_000,
      new Error('Timed out waiting for microphone permission or device samples.')
    )
    voiceStreamRef.current = stream
    const audioStarted = startVoiceWaveform(stream, { recordForTranscription })
    if (recordForTranscription && !audioStarted) {
      stopLocalCapture({ finalizeTranscription: false })
      throw new Error('This platform can show microphone permission but did not expose Web Audio samples for transcription.')
    }
    if (recordForTranscription) {
      const generation = voiceRecordingGenerationRef.current + 1
      voiceRecordingGenerationRef.current = generation
      voiceFinalizeOnStopRef.current = true
      voiceTranscriptPreviewRef.current = ''
      voicePcmChunksRef.current = []
      scheduleRealtimeTranscriptionPreview(generation)
    } else if (!audioStarted && !optionalVisualizer) {
      throw new Error('This platform did not expose Web Audio microphone levels to the Aurora UI.')
    }
  }

  function stopLocalCapture({ finalizeTranscription = false }: { finalizeTranscription?: boolean } = {}) {
    const generation = voiceRecordingGenerationRef.current
    const shouldFinalize = finalizeTranscription && voicePcmChunksRef.current.length > 0
    voiceFinalizeOnStopRef.current = finalizeTranscription
    clearPartialTranscriptionTimer()
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    voiceStreamRef.current = null
    stopVoiceWaveform()
    setVoiceWaveformBars(idleWaveformBars())
    if (shouldFinalize) {
      void transcribeRecordedBrowserAudio({ final: true, generation })
    } else if (!finalizeTranscription) {
      voicePcmChunksRef.current = []
    }
  }

  function clearPartialTranscriptionTimer() {
    if (voicePartialTranscribeTimerRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(voicePartialTranscribeTimerRef.current)
    }
    voicePartialTranscribeTimerRef.current = null
  }

  function scheduleRealtimeTranscriptionPreview(generation: number) {
    if (typeof window === 'undefined') return
    if (voicePartialTranscribeTimerRef.current !== null) return
    voicePartialTranscribeTimerRef.current = window.setTimeout(() => {
      voicePartialTranscribeTimerRef.current = null
      if (voicePartialTranscribeInFlightRef.current) return
      if (voiceRecordingGenerationRef.current !== generation) return
      if (voicePcmChunksRef.current.length === 0) {
        scheduleRealtimeTranscriptionPreview(generation)
        return
      }
      voicePartialTranscribeInFlightRef.current = true
      void transcribeRecordedBrowserAudio({ final: false, generation })
        .finally(() => {
          voicePartialTranscribeInFlightRef.current = false
          if (voiceCaptureStatusRef.current === 'listening' && voiceRecordingGenerationRef.current === generation) {
            scheduleRealtimeTranscriptionPreview(generation)
          }
        })
    }, 900)
  }

  function startVoiceWaveform(stream: MediaStream, options: { recordForTranscription?: boolean } = {}): boolean {
    stopVoiceWaveform()
    if (typeof window === 'undefined') return false
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return false
    const context = new AudioContextCtor()
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.35
    source.connect(analyser)
    voiceAudioContextRef.current = context
    voiceMediaSourceRef.current = source
    voiceAnalyserRef.current = analyser
    voicePcmSampleRateRef.current = context.sampleRate
    if (options.recordForTranscription) {
      const processor = context.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0)
        voicePcmChunksRef.current.push(new Float32Array(channel))
      }
      source.connect(processor)
      processor.connect(context.destination)
      voiceScriptProcessorRef.current = processor
    }
    const samples = new Uint8Array(analyser.fftSize)
    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      setVoiceWaveformBars(waveformBarsFromTimeDomain(samples, 24))
      voiceAnalyserFrameRef.current = window.requestAnimationFrame(tick)
    }
    tick()
    return true
  }

  function stopVoiceWaveform() {
    if (voiceAnalyserFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(voiceAnalyserFrameRef.current)
    }
    voiceAnalyserFrameRef.current = null
    const processor = voiceScriptProcessorRef.current
    voiceScriptProcessorRef.current = null
    if (processor) {
      processor.onaudioprocess = null
      withIgnoredAudioDisconnect(() => processor.disconnect())
    }
    const source = voiceMediaSourceRef.current
    voiceMediaSourceRef.current = null
    if (source) withIgnoredAudioDisconnect(() => source.disconnect())
    voiceAnalyserRef.current = null
    const context = voiceAudioContextRef.current
    voiceAudioContextRef.current = null
    if (context && context.state !== 'closed') void context.close()
  }

  function recordedPcmBase64(recentSeconds?: number): string | null {
    const chunks = voicePcmChunksRef.current
    if (chunks.length === 0) return null
    const sourceRate = voicePcmSampleRateRef.current || 16_000
    const samples = flattenPcmChunks(chunks, recentSeconds ? Math.ceil(sourceRate * recentSeconds) : undefined)
    if (samples.length < sourceRate * 0.35) return null
    return floatPcmToBase64(samples, sourceRate, 16_000)
  }

  async function transcribeRecordedBrowserAudio({ final, generation }: { final: boolean; generation: number }) {
    if (final) setVoiceCaptureStatus('processing')
    try {
      const audioData = recordedPcmBase64(final ? undefined : 12)
      if (!audioData) {
        if (final) {
          setLastError('No microphone audio was captured. Check microphone permission and try push-to-talk again.')
          setVoiceCaptureStatus('idle')
        }
        return
      }
      const result = await client.assistant.transcribeVoiceAudio({
        audio_data: audioData,
        format: 'raw',
        sample_rate: 16000,
        channels: 1,
        model: final ? 'accurate' : 'realtime'
      })
      if (voiceRecordingGenerationRef.current !== generation && !final) return
      if (!result.ok) {
        if (final) {
          setLastError(productAssistantErrorCopy(result.error))
          setVoiceCaptureStatus('error')
        }
        return
      }
      const transcript = result.data.text.trim()
      if (!transcript) {
        if (final) {
          setLastError('No speech was transcribed from the recorded audio.')
          setVoiceCaptureStatus('idle')
          voicePcmChunksRef.current = []
        }
        return
      }
      if (!final) {
        if (voiceCaptureStatusRef.current !== 'listening') return
        const preview = mergeTranscriptText(voiceTranscriptPreviewRef.current, transcript, { appendOnMiss: false })
        voiceTranscriptPreviewRef.current = preview
        setText(preview)
        return
      }
      voicePcmChunksRef.current = []
      const finalTranscript = mergeTranscriptText(voiceTranscriptPreviewRef.current, transcript, { appendOnMiss: false }).trim()
      voiceTranscriptPreviewRef.current = ''
      await startAssistantTurn(finalTranscript || transcript)
      setVoiceCaptureStatus('idle')
    } catch (error) {
      if (final) {
        setLastError(productAudioCaptureErrorCopy(error))
        setVoiceCaptureStatus('error')
      }
    }
  }

  async function startNewConversation() {
    if (supportsPersistedSessions) {
      setSessionIndexLoading(true)
      const created = await createPersistedChatSession()
      setSessionIndexLoading(false)
      if (!created) return
      resetConversationUi({ sessionId: created.id, messages: [] })
    } else {
      resetConversationUi(emptyAssistantSession())
    }
    textAreaRef.current?.focus()
  }

  return (
    <section className="aui-assistant" aria-labelledby="assistant-title">
      <h1 id="assistant-title" className="aui-sr-only">Text chat with Aurora</h1>
      <AssistantRuntimeStrip health={runtimeStrip} />

      {streamState.status === 'lost' || streamState.status === 'fallback' ? (
        <div className="aui-stream-banner" role="status" aria-live="polite">
          <WifiOff size={17} aria-hidden />
          <span>{streamState.message}</span>
          <button type="button" onClick={() => void retryLastPrompt(true)} disabled={!lastPrompt || !canSend}>
            <RotateCcw size={15} aria-hidden />
            <span>Replay</span>
          </button>
        </div>
      ) : null}

      <div className="aui-assistant-grid">
        <ConversationRail
          session={{ ...session, messages: sessionMessages }}
          sessions={sessionIndex}
          route={route}
          transportKind={client.transport.kind}
          loading={sessionIndexLoading}
          error={sessionIndexError}
          disabled={assistantBusy || voiceBusy}
          onSelectConversation={(sessionId) => void openPersistedSession(sessionId)}
          onNewConversation={() => void startNewConversation()}
        />

        <div className="aui-chat-workspace" data-first-viewport-work="assistant-chat-composer" aria-label="Primary chat workspace">
          <MessageScrollerProvider autoScroll>
            <MessageScroller className="aui-chat-panel" aria-label="Assistant conversation thread" aria-live="polite">
              <MessageScrollerViewport className="aui-chat-scroller-viewport">
                <MessageScrollerContent className="aui-chat-scroller-content">
                  {sessionMessages.length === 0 ? (
                    <MessageScrollerItem messageId="assistant-empty">
                      <Marker className="aui-chat-empty" variant="border">
                        <MarkerContent>
                          <strong>Start with a prompt</strong>
                          <span>Responses appear only after the SDK returns final Orchestrator output.</span>
                        </MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  ) : (
                    sessionMessages.map((message) => (
                      <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'}>
                        <ChatBubble
                          message={message}
                          onReadAloud={readAssistantMessageAloud}
                          onResolveToolApproval={resolveAssistantToolApproval}
                          speakingMessageId={speakingMessageIdState}
                          executionPeerLabels={executionPeerLabels}
                        />
                      </MessageScrollerItem>
                    ))
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>

          <form className="aui-assistant-form" onSubmit={onSubmit} aria-label="Prompt composer" data-voice-active={voiceCaptureStatus === 'listening' ? 'true' : undefined}>
            <div className="aui-composer-toolbar" aria-label="Route/model selector">
              <div className="aui-composer-selectors">
                <ModelSelector.Root
                  models={executionOptions.map((option) => ({
                    id: option.id,
                    name: option.mode === 'local' ? 'Locally' : `Dispatch to ${option.label}`,
                    description: option.description,
                    icon: option.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
                  }))}
                  value={selectedExecution.id}
                  onValueChange={(value) => {
                    setExecutionOptionId(value)
                    setSelectedModelChoiceId('automatic')
                    setModelSearchQuery('')
                  }}
                >
                  <ModelSelector.Trigger
                    variant="ghost"
                    size="sm"
                    className="aui-execution-selector-trigger"
                    aria-label={`Executing ${selectedExecution.mode === 'local' ? 'locally' : `by dispatch to ${selectedExecution.label}`}`}
                  >
                    {selectedExecution.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />}
                    <span className="aui-selector-prefix">Executing</span>
                    <strong>{selectedExecution.mode === 'local' ? 'locally' : `dispatch to ${selectedExecution.label}`}</strong>
                  </ModelSelector.Trigger>
                  <ModelSelector.Content searchable={false} className="aui-execution-selector-content">
                    <ModelSelector.List>
                      <ModelSelector.Group heading="Execution">
                        {executionOptions.map((option) => {
                          const model = {
                            id: option.id,
                            name: option.mode === 'local' ? 'Locally' : `Dispatch to ${option.label}`,
                            description: option.description,
                            icon: option.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
                          }
                          return <ModelSelector.Item key={option.id} model={model} />
                        })}
                      </ModelSelector.Group>
                    </ModelSelector.List>
                  </ModelSelector.Content>
                </ModelSelector.Root>

                <ModelSelector.Root
                  models={modelChoices.map((choice) => choice.model)}
                  value={selectedModelChoice.id}
                  onValueChange={(value) => {
                    setSelectedModelChoiceId(value)
                    setModelSearchQuery('')
                  }}
                >
                  <ModelSelector.Trigger
                    variant="ghost"
                    size="sm"
                    className="aui-assistant-model-selector-trigger"
                    aria-label={`Model: ${selectedModelChoice.model.name}`}
                    title={modelCatalogError ?? undefined}
                  >
                    <Cpu aria-hidden />
                    <span className="aui-selector-prefix">Model</span>
                    <ModelSelector.Value showEffort={false} />
                    {modelCatalogLoading ? <LoaderCircle className="aui-spin" aria-label="Loading models" /> : null}
                  </ModelSelector.Trigger>
                  <ModelSelector.Content searchable className="aui-assistant-model-selector-content">
                    <ModelSelector.Search
                      placeholder="Search available models..."
                      value={modelSearchQuery}
                      onValueChange={setModelSearchQuery}
                    />
                    <ModelSelector.List>
                      <ModelSelector.Empty>{modelCatalogLoading ? 'Loading available models…' : 'No available models.'}</ModelSelector.Empty>
                      {modelChoiceGroups.filter((group) => group.scope === 'default').map((group) => (
                        <ModelSelector.Group key={group.id} heading={group.heading}>
                          {group.choices.map((choice) => <ModelSelector.Item key={choice.id} model={choice.model} />)}
                        </ModelSelector.Group>
                      ))}
                      {modelSourceGroups.map((source) => (
                        <AssistantModelSourceSection
                          key={source.id}
                          source={source}
                          query={modelSearchQuery}
                        />
                      ))}
                    </ModelSelector.List>
                  </ModelSelector.Content>
                </ModelSelector.Root>
              </div>
              <div className="aui-composer-route-context">
                <PrivacyBadge privacy={route.item.privacyClass} />
                {attachments.length > 0 ? <span className="aui-composer-attachment-count">{attachments.length} attached</span> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="aui-route-details-trigger"
                  onClick={() => setRouteDetailsOpen(true)}
                  aria-expanded={routeDetailsOpen}
                  aria-controls="assistant-route-panel"
                  aria-label="Open route details"
                  title="Route details"
                >
                  <RouteIcon aria-hidden />
                </Button>
              </div>
            </div>
            <label htmlFor="assistant-prompt" className="aui-sr-only">Prompt</label>
            {voiceCaptureStatus === 'listening' ? (
              <div className="aui-composer-recorder-row">
                <AudioRecorderVisualizer
                  status={voiceCaptureStatus}
                  bars={voiceModel.waveformBars}
                  elapsedSeconds={voiceElapsedSeconds}
                  showControls={false}
                  className="aui-composer-recorder-panel"
                  title="Listening"
                  sourceLabel={surfaceProfile.kind === 'desktop-local' ? 'WebView microphone' : 'Browser microphone'}
                  detail="Live microphone level"
                />
              </div>
            ) : null}
            <input
              id="assistant-context-file-input"
              ref={attachmentInputRef}
              className="aui-sr-only"
              type="file"
              aria-label="Attach context files"
              multiple
              accept={assistantAttachmentPickerAccept}
              disabled={!canAttach}
              onChange={(event) => {
                void onFileInput(event.currentTarget.files)
                event.currentTarget.value = ''
              }}
            />
            <section className="aui-sr-only" aria-labelledby="assistant-context-title">
              <h2 id="assistant-context-title">Attachment context status</h2>
              <p>{contextSummary.ready} ready, {contextSummary.blocked} blocked</p>
            </section>
            {attachments.length > 0 ? (
              <ComposerAttachmentPreview attachments={attachments} onRemove={removeAttachment} />
            ) : null}
            <div className="aui-composer-control-row">
              <button
                type="button"
                className="aui-secondary-button aui-composer-icon"
                disabled={!canAttach}
                aria-label="Attach context"
                onClick={() => void openAttachmentPicker()}
              >
                <Paperclip size={18} aria-hidden />
              </button>
              <div className="aui-composer-input-shell" data-voice-active={voiceCaptureStatus === 'listening' ? 'true' : undefined}>
                <textarea
                  id="assistant-prompt"
                  ref={textAreaRef}
                  value={text}
                  onChange={(event) => setText(event.currentTarget.value)}
                  onKeyDown={onComposerKeyDown}
                  disabled={!canSend && voiceCaptureStatus !== 'listening'}
                  readOnly={voiceCaptureStatus === 'listening'}
                  placeholder={route.disabled ? 'Assistant capability is unavailable' : voiceCaptureStatus === 'listening' ? 'Realtime transcription appears here…' : 'Ask Aurora...'}
                  rows={voiceCaptureStatus === 'listening' ? 2 : 1}
                />
              </div>
              <button
                type="button"
                className="aui-secondary-button aui-composer-icon"
                data-voice-state={voiceCaptureStatus === 'listening' ? 'listening' : 'idle'}
                disabled={voiceCaptureStatus === 'processing'}
                onClick={(event) => { event.preventDefault(); requestVoiceToggle() }}
                aria-label={voiceCaptureStatus === 'listening' ? 'Stop listening' : 'Push to talk'}
                title={voiceCaptureStatus === 'listening' ? 'Stop listening' : 'Push to talk'}
              >
                {voiceCaptureStatus === 'listening' ? <StopCircle size={18} aria-hidden /> : <Mic size={18} aria-hidden />}
                <span className="aui-sr-only">{voiceCaptureStatus === 'listening' ? 'Stop listening' : 'Push to talk'}</span>
              </button>
              <button
                type={primaryComposerAction === 'send' ? 'submit' : 'button'}
                className="aui-composer-send"
                data-composer-action={primaryComposerAction}
                disabled={primaryComposerDisabled}
                aria-label={primaryComposerAriaLabel}
                onClick={primaryComposerAction === 'send' ? undefined : () => void onPrimaryComposerAction()}
              >
                {primaryComposerAction === 'retry' ? <RotateCcw size={17} aria-hidden /> : primaryComposerAction === 'stop' ? <StopCircle size={17} aria-hidden /> : <ArrowUp size={17} aria-hidden />}
                <span className="aui-button-label">{primaryComposerLabel}</span>
              </button>
            </div>
            <p className="aui-mobile-composer-note">
              Aurora executes locally by default. Dispatch routes appear before any data leaves this device.
            </p>
          </form>
        </div>

        <aside
          id="assistant-route-panel"
          className="aui-route-panel"
          aria-label="Assistant route and privacy details"
          aria-hidden={routeDetailsOpen ? undefined : true}
          data-open={routeDetailsOpen ? 'true' : 'false'}
        >
          <div className="aui-route-panel-head">
            <h2>Route &amp; privacy sheet</h2>
            <button type="button" onClick={() => setRouteDetailsOpen(false)} aria-label="Close route and privacy sheet">
              <X size={17} aria-hidden />
            </button>
          </div>
          <dl>
	            <div><dt>Device or service</dt><dd>{assistantRouteProviderCopy(route)}</dd></div>
            <div><dt>Availability</dt><dd>{route.state}</dd></div>
            <div><dt>Privacy</dt><dd>{route.item.privacyClass}</dd></div>
            <div><dt>Selector</dt><dd>{route.selectorRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Approval</dt><dd>{route.approvalRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Cancellation</dt><dd>{controls.canCancel ? 'supported' : controls.cancelReason}</dd></div>
            <div><dt>Last stream event</dt><dd>{streamState.lastEventId ?? 'none'}</dd></div>
            <div><dt>Model</dt><dd>{safeAssistantRuntimeValue(modelLabel, lastResult ? 'not reported' : 'model response pending')}</dd></div>
            <div><dt>Context</dt><dd>{contextSummary.ready} ready, {contextSummary.blocked} blocked</dd></div>
          </dl>
          <p>{presentableSignal(route.explanation)}</p>
          {remotePrivacyWarning ? <p className="aui-privacy-route-warning" role="status">{remotePrivacyWarning}</p> : null}
          {route.disabled ? <p role="alert">Assistant send is disabled: {presentableSignal(route.blockers.join(', ') || 'capability unavailable')}.</p> : null}
          {lastError ? <p role="alert">{lastError}</p> : null}
          {routeDetailsOpen ? (
            <RouteSheet
              client={client}
              title="Assistant route preview"
              description="Aurora checks where this prompt can run before it leaves this device."
              payload={{
                message: text.trim() || '<pending prompt>',
                session_id: session.sessionId,
                route_surface: route.item.id
              }}
              routeRequest={{
                topic: `${route.item.capabilityModule}.${route.item.capabilityMethod ?? ''}`,
                method: route.item.capabilityMethod ?? null,
                include_candidates: true
              }}
              privacyClass={route.item.privacyClass}
              auditReceiptTarget={route.providerLabel}
              requiresAdminAction={route.requiresAdminAction}
            />
          ) : null}
        </aside>
      </div>

    </section>
  )
}

function assistantVoicePlatformTruth(model: AssistantVoiceModel): string {
  return model.platformTruth
}

function AssistantRuntimeStrip({ health }: { health: AssistantRuntimeHealth }) {
  return (
    <section className="aui-assistant-runtime-strip" aria-label="Assistant status">
      <p className="aui-runtime-secondary-label">
        Local service status is available for this computer, while the assistant conversation remains the primary page.
      </p>
      <dl>
        <div><dt>Selected model</dt><dd>{health.selectedModel ?? 'model pending'}</dd></div>
        <div><dt>Model state</dt><dd>{health.selectedModel ? 'configured' : 'model status pending'}</dd></div>
        <div><dt>Route</dt><dd>{health.routeLabel}</dd></div>
        <div><dt>Local service</dt><dd>{health.sidecarHealth}</dd></div>
        <div><dt>Gateway</dt><dd>{health.gatewayHealth}</dd></div>
      </dl>
    </section>
  )
}

export function buildAssistantRuntimeStrip(
  runtimeHealth: AssistantRuntimeHealth | undefined,
  modelLabel: string | null,
  route: RouteAvailability,
  transportKind: string
): AssistantRuntimeHealth {
  return {
    selectedModel: safeAssistantRuntimeValue(runtimeHealth?.selectedModel ?? modelLabel, null),
    routeLabel: safeAssistantRuntimeValue(runtimeHealth?.routeLabel, route.state === 'available-remote' ? 'Connected Aurora device' : 'This device') ?? 'This device',
    sidecarHealth: safeAssistantRuntimeValue(runtimeHealth?.sidecarHealth, transportKind === 'mock' ? 'Preview ready' : 'Status pending') ?? 'Status pending',
    gatewayHealth: safeAssistantRuntimeValue(runtimeHealth?.gatewayHealth, productConnectionCopy(transportKind)) ?? 'Connection status ready'
  }
}

function assistantRouteChips(route: RouteAvailability): Array<{ id: string; label: string; state: RouteAvailability['state'] }> {
  const localCandidate = route.candidateProviders.find((candidate) => /local/i.test(`${candidate.id} ${candidate.label}`))
  const remoteCandidate = route.candidateProviders.find((candidate) => /remote|cloud|http/i.test(`${candidate.id} ${candidate.label} ${candidate.reason}`))
  const meshCandidate = route.candidateProviders.find((candidate) => /mesh|peer/i.test(`${candidate.id} ${candidate.label} ${candidate.reason}`))
  return [
    {
      id: 'local',
      label: localCandidate ? `Local ${safeAssistantRuntimeValue(localCandidate.label, 'destination')}` : `Local ${assistantRouteProviderCopy(route)}`,
      state: localCandidate?.state ?? (route.providerLabel.toLowerCase().includes('local') ? route.state : 'pending')
    },
    {
      id: 'remote',
      label: remoteCandidate ? `Remote ${safeAssistantRuntimeValue(remoteCandidate.label, 'destination')}` : 'Remote route pending',
      state: remoteCandidate?.state ?? 'pending'
    },
    {
      id: 'mesh',
      label: meshCandidate ? `Mesh ${safeAssistantRuntimeValue(meshCandidate.label, 'destination')}` : 'Mesh route pending',
      state: meshCandidate?.state ?? 'pending'
    }
  ]
}

function messageRoleLabel(role: AssistantUiMessage['role']): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'Aurora'
  if (role === 'system') return 'System'
  return 'Tool'
}

function routeStateShortLabel(state: RouteAvailability['state']): string {
  if (state === 'available-local') return 'Local'
  if (state === 'available-remote') return 'Remote'
  if (state === 'privacy-blocked') return 'Needs consent'
  return presentableSignal(state)
}

function isAssistantToolCallCard(value: unknown): value is AssistantToolCallCard {
  if (typeof value !== 'object' || value === null) return false
  const tool = value as Partial<AssistantToolCallCard>
  return (
    typeof tool.id === 'string' &&
    typeof tool.name === 'string' &&
    (tool.sessionId === undefined || tool.sessionId === null || typeof tool.sessionId === 'string') &&
    (tool.status === 'requested' || tool.status === 'running' || tool.status === 'completed' || tool.status === 'failed' || tool.status === 'requires_action') &&
    typeof tool.riskClass === 'string' &&
    typeof tool.target === 'string' &&
    typeof tool.dataLeavesDevice === 'boolean' &&
    typeof tool.summary === 'string' &&
    (tool.auditId === null || typeof tool.auditId === 'string') &&
    (tool.payloadPreview === null || (typeof tool.payloadPreview === 'object' && !Array.isArray(tool.payloadPreview)))
  )
}

export function buildAssistantVoiceModel(input: {
  client: AuroraClient
  route: RouteAvailability
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
  voiceEvents?: VoiceRuntimeEvent[] | undefined
  waveformBars?: number[] | undefined
}): AssistantVoiceModel {
  const transcription = input.voiceRoutes?.transcription ?? missingVoiceRoute('voice-transcription', 'Remote transcription', 'Transcription.Transcribe', 'raw-audio')
  const wakeProcess = input.voiceRoutes?.wakeProcess ?? missingVoiceRoute('voice-wake-process', 'Wake audio processing', 'WakeWord.ProcessAudio', 'raw-audio')
  const wakeControl = input.voiceRoutes?.wakeControl ?? missingVoiceRoute('voice-wake-control', 'Wake foreground control', 'WakeWord.Control', 'raw-audio')
  const ttsSynthesize = input.voiceRoutes?.ttsSynthesize ?? missingVoiceRoute('voice-tts-synthesize', 'TTS synthesis', 'TTS.Synthesize', 'personal')
  const ttsStop = input.voiceRoutes?.ttsStop ?? missingVoiceRoute('voice-tts-stop', 'TTS playback stop', 'TTS.Stop', 'personal')
  const nativeCapture = nativeCaptureState(input.nativeAvailable ?? false, input.nativePlatform ?? 'not available', input.nativePermissions ?? [], input.nativeCapabilities ?? [])
  const surfaceProfile = getAuroraSurfaceProfile({
    runtimeMode: input.client.transport.kind === 'tauri-local' ? 'desktop-local' : input.client.transport.kind === 'native-mobile' ? 'mobile' : undefined,
    transportKind: input.client.transport.kind,
    nativePlatform: input.nativePlatform
  })
  const browserCaptureState = browserCaptureAvailability(surfaceProfile, input.captureStatus)
  const remoteAudioRoute = remoteAudioRouteFor(transcription, ttsSynthesize, wakeProcess)

  return {
    captureStatus: input.captureStatus,
    consentGranted: input.consentGranted,
    privacyClass: 'raw-audio',
    retentionPolicy: remoteAudioRoute.disabled ? 'not retained: route unavailable' : 'transient unless backend retention policy says otherwise',
    sessionTtl: input.consentGranted ? 'current UI session' : 'consent not granted',
    transport: input.client.transport.kind,
    platformTruth: surfaceProfile.voiceCapture.detail,
    visualizerSourceLabel: surfaceProfile.kind === 'desktop-local' ? 'WebView microphone / daemon wake events' : 'Browser microphone',
    targetLabel: remoteAudioRoute.providerLabel,
    chips: [
      {
        id: 'browser-capture',
        label: 'Browser capture',
        state: browserCaptureState.state,
        privacyClass: 'raw-audio',
        providerLabel: browserCaptureState.providerLabel,
        detail: browserCaptureState.detail,
        blockers: browserCaptureState.blockers,
        evidence: [input.client.transport.kind, 'browser getUserMedia']
      },
      nativeCapture,
      voiceChip('remote-processing', 'Remote processing', transcription, 'raw-audio', input.consentGranted
        ? 'Remote STT route has UI session consent.'
        : 'Remote STT route requires consent before audio leaves this device.'),
      voiceChip('wake', 'Wake and background', wakeControl.disabled ? wakeProcess : wakeControl, 'raw-audio', wakeDetail(input.nativePlatform ?? 'not available', wakeControl, wakeProcess)),
      voiceChip('tts', 'TTS synthesis', ttsSynthesize, 'personal', 'Batch synthesis is separate from playback hardware control.'),
      voiceChip('playback', 'Local playback', ttsStop, 'personal', 'Playback stop/control is separate from remote synthesis.')
    ],
    controls: [
      {
        id: 'push-to-talk',
        label: input.captureStatus === 'listening' || input.captureStatus === 'processing' || input.captureStatus === 'speaking' ? 'Stop listening' : 'Push to talk',
        state: pushToTalkControlState(surfaceProfile, browserCaptureState.state),
        enabled: pushToTalkControlState(surfaceProfile, browserCaptureState.state) !== 'unsupported',
        reason: surfaceProfile.voiceCapture.detail,
        route: null
      },
      {
        id: 'remote-consent',
        label: input.consentGranted ? 'Revoke audio consent' : 'Grant session consent',
        state: remoteAudioRoute.disabled ? remoteAudioRoute.state : input.consentGranted ? 'available-local' : 'privacy-blocked',
        enabled: !remoteAudioRoute.disabled || remoteAudioRoute.state === 'privacy-blocked',
        reason: input.consentGranted
          ? 'Consent can be revoked before starting another remote audio session.'
          : 'Required before raw audio is routed to a remote peer/provider.',
        route: remoteAudioRoute
      },
      voiceAction('remote-transcription', 'Start transcription', transcription, input.captureStatus, input.consentGranted),
      voiceAction('wakeword', 'Wake foreground', wakeControl.disabled ? wakeProcess : wakeControl, input.captureStatus, input.consentGranted),
      voiceAction('tts-synthesize', 'Synthesize speech', ttsSynthesize, input.captureStatus, input.consentGranted),
      voiceAction('playback-stop', 'Stop playback', ttsStop, input.captureStatus, input.consentGranted)
    ],
    events: voiceEventRows(input.captureStatus, transcription, input.voiceEvents ?? []),
    routeSheetRoute: remoteAudioRoute,
    remoteAudioRoute,
    waveformBars: input.waveformBars ?? waveformBars(input.captureStatus)
  }
}

function VoiceModePanel({
  client,
  model,
  captureStatus,
  elapsedSeconds,
  onToggleCapture,
  onToggleConsent
}: {
  client: AuroraClient
  model: AssistantVoiceModel
  captureStatus: VoiceCaptureStatus
  elapsedSeconds: number
  onToggleCapture: () => void
  onToggleConsent: () => void
}) {
  return (
    <section className="aui-voice-panel" aria-labelledby="assistant-voice-title">
      <header className="aui-voice-header">
        <div>
          <p className="aui-kicker">Voice</p>
          <h2 id="assistant-voice-title">Voice modes</h2>
        </div>
        <div className="aui-assistant-badges" aria-label="Voice status">
          <PrivacyBadge privacy={model.privacyClass} />
          <EvidenceBadge label={productConnectionCopy(model.transport)} />
          <EvidenceBadge label={model.consentGranted ? 'consent granted' : 'consent required'} />
          <EvidenceBadge label={model.targetLabel} />
        </div>
      </header>

      <div className="aui-voice-chip-grid" aria-label="Voice mode capability states">
        {model.chips.map((chip) => (
          <article key={chip.id} className="aui-voice-chip">
            <header>
              <strong>{chip.label}</strong>
              <StatusBadge state={chip.state} />
            </header>
            <p>{chip.detail}</p>
            <div className="aui-settings-inline">
              <PrivacyBadge privacy={chip.privacyClass} />
              <EvidenceBadge label={chip.providerLabel} />
            </div>
            <small>{presentableSignal(chip.blockers.length > 0 ? chip.blockers.join(', ') : chip.evidence.join(', '))}</small>
          </article>
        ))}
      </div>

      <p className="aui-voice-platform-note">{assistantVoicePlatformTruth(model)}</p>

      <div className="aui-voice-body">
        <section className="aui-voice-controls" aria-labelledby="voice-controls-title">
          <h3 id="voice-controls-title">Session controls</h3>
          <AudioRecorderVisualizer
            status={captureStatus}
            bars={model.waveformBars}
            elapsedSeconds={elapsedSeconds}
            variant="panel"
            sourceLabel={model.visualizerSourceLabel}
            onToggle={onToggleCapture}
          />
          <div className="aui-voice-action-grid">
            {model.controls.filter((control) => control.id !== 'push-to-talk').map((control) => {
              const isCapture = control.id === 'push-to-talk'
              const isConsent = control.id === 'remote-consent'
              return (
                <button
                  key={control.id}
                  type="button"
                  disabled={!control.enabled}
                  onPointerUp={isCapture ? (event) => { if (event.button === 0) { event.preventDefault(); onToggleCapture() } } : undefined}
                  onClick={isCapture ? (event) => { event.preventDefault() } : isConsent ? onToggleConsent : undefined}
                >
                  {isCapture ? <Mic size={16} aria-hidden /> : control.id.includes('tts') || control.id.includes('playback') ? <Volume2 size={16} aria-hidden /> : <Radio size={16} aria-hidden />}
                  <span>{control.label}</span>
                </button>
              )
            })}
          </div>
          <ul className="aui-voice-reasons" aria-live="polite">
            {model.controls.map((control) => (
              <li key={control.id}>
                <StatusBadge state={control.state} />
                <span>{presentableSignal(control.reason)}</span>
              </li>
            ))}
          </ul>
        </section>

        <aside className="aui-voice-privacy" aria-label="Audio route privacy details">
          <h3>Audio privacy</h3><span className="aui-sr-only">Route sheet</span>
          <dl>
            <div><dt>Privacy class</dt><dd>{model.privacyClass}</dd></div>
            <div><dt>Destination</dt><dd>{presentableSignal(model.targetLabel)}</dd></div>
            <div><dt>Connection</dt><dd>{productConnectionCopy(model.transport)}</dd></div>
            <div><dt>Retention</dt><dd>{model.retentionPolicy}</dd></div>
            <div><dt>Session TTL</dt><dd>{model.sessionTtl}</dd></div>
          </dl>
          <RouteSheet
            client={client}
            title="Audio route and consent"
            description="Microphone audio leaves this device only when the selected destination, consent, privacy indicator, and policy allow it."
            payload={{
              audio_privacy_class: model.privacyClass,
              capture_state: model.captureStatus,
              retention_policy: model.retentionPolicy,
              session_ttl: model.sessionTtl
            }}
            routeRequest={{
              topic: model.routeSheetRoute.item.capabilityMethod
                ? `${model.routeSheetRoute.item.capabilityModule}.${model.routeSheetRoute.item.capabilityMethod}`
                : model.routeSheetRoute.item.capabilityModule,
              method: model.routeSheetRoute.item.capabilityMethod ?? null,
              include_candidates: true
            }}
            dataClasses={['raw-audio', model.routeSheetRoute.item.privacyClass]}
            privacyClass="raw-audio"
            consentGranted={model.consentGranted}
            privacyIndicatorShown={model.captureStatus === 'listening' || model.consentGranted}
            auditReceiptTarget={model.targetLabel}
            requiresAdminAction={model.routeSheetRoute.requiresAdminAction}
          />
        </aside>
      </div>

    </section>
  )
}

export function attachmentToContextItem(attachment: AssistantAttachmentDraft): AttachmentContextItem {
  const source = {
    channel: attachment.sourceChannel,
    display_name: attachment.sourceDisplayName,
    mime_type: attachment.mimeType ?? null,
    uri: attachment.url ?? null,
    shared_at: new Date().toISOString()
  }
  return {
    kind: attachment.kind,
    content_text: attachment.contentText ?? null,
    url: attachment.url ?? null,
    title: attachment.label,
    filename: attachment.filename ?? null,
    mime_type: attachment.mimeType ?? null,
    size_bytes: attachment.sizeBytes ?? null,
    source,
    metadata: {
      ui_status: attachment.status,
      route_privacy_class: attachment.privacyClass
    }
  }
}

export function attachmentStatusFromBackend(status: AttachmentContextStatus): AttachmentTrayStatus {
  if (status === 'accepted' || status === 'redacted' || status === 'stored') return status
  if (status === 'unsupported') return 'unsupported'
  return 'rejected'
}

export function isAcceptedContextStatus(status: AttachmentContextStatus): boolean {
  return status === 'accepted' || status === 'redacted' || status === 'stored'
}

export function contextIngestOutcomeIndex(itemId: string): number | null {
  const productionMatch = /^context-(\d+)-.+$/.exec(itemId)
  if (productionMatch) return Number(productionMatch[1])
  const mockMatch = /^mock-context-(\d+)$/.exec(itemId)
  if (mockMatch) return Number(mockMatch[1])
  return null
}

export function mapContextIngestOutcomesByPendingIndex(
  response: Pick<AttachmentContextIngestResponse, 'accepted_items' | 'rejected_items'>
): Map<number, AttachmentContextItemResult> {
  const outcomes = new Map<number, AttachmentContextItemResult>()
  for (const outcome of [...response.accepted_items, ...response.rejected_items]) {
    const index = contextIngestOutcomeIndex(outcome.item_id)
    if (index === null) continue
    outcomes.set(index, outcome)
  }
  return outcomes
}

export function emptyAssistantSession(): AssistantSessionSnapshot {
  return { sessionId: null, messages: [] }
}

export function assistantSessionFromPersisted(
  response: DBGetSessionResponse
): AssistantSessionSnapshot {
  return {
    sessionId: response.session.id,
    messages: response.messages.map(assistantUiMessageFromPersisted)
  }
}

function assistantUiMessageFromPersisted(
  message: Record<string, unknown>,
  index: number
): AssistantUiMessage {
  const role = message.role === 'assistant' || message.role === 'system' || message.role === 'tool'
    ? message.role
    : 'user'
  const createdAt = typeof message.timestamp === 'string'
    ? message.timestamp
    : typeof message.created_at === 'string'
      ? message.created_at
      : new Date(0).toISOString()
  const metadata = message.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
    ? message.metadata as Record<string, unknown>
    : {}
  const executionPeerId = metadataStringValue(metadata, 'execution_peer_id')
    ?? (
      metadata.dispatch_selector
      && typeof metadata.dispatch_selector === 'object'
      && !Array.isArray(metadata.dispatch_selector)
        ? metadataStringValue(metadata.dispatch_selector as Record<string, unknown>, 'peer_id')
        : null
    )
  const execution = metadataStringValue(metadata, 'execution')
  const executionPeerName = metadataStringValue(metadata, 'execution_peer_name')
  return {
    id: typeof message.id === 'string' ? message.id : `persisted-message-${index}`,
    role,
    text: typeof message.content === 'string'
      ? message.content
      : typeof message.text === 'string'
        ? message.text
        : '',
    createdAt,
    status: 'sent',
    modelLabel: metadataStringValue(metadata, 'model'),
    providerLabel: metadataStringValue(metadata, 'provider_label') ?? metadataStringValue(metadata, 'provider'),
    routeLabel: execution === 'local' ? 'Local' : executionPeerName,
    executionPeerId
  }
}

function upsertSessionByModification(
  sessions: DBSessionRecord[],
  updated: DBSessionRecord
): DBSessionRecord[] {
  return sortSessionsByModification([
    updated,
    ...sessions.filter((session) => session.id !== updated.id)
  ])
}

function sortSessionsByModification(sessions: DBSessionRecord[]): DBSessionRecord[] {
  return [...sessions].sort((left, right) => {
    const activityDelta = sessionModificationTimestamp(right) - sessionModificationTimestamp(left)
    return activityDelta !== 0 ? activityDelta : left.id.localeCompare(right.id)
  })
}

function sessionModificationTimestamp(session: DBSessionRecord): number {
  const updatedAt = Date.parse(session.updated_at)
  if (Number.isFinite(updatedAt)) return updatedAt
  const createdAt = Date.parse(session.created_at)
  return Number.isFinite(createdAt) ? createdAt : 0
}

function sessionTypeLabel(type: string): string {
  const normalized = type.trim()
  return normalized ? `${normalized[0]?.toUpperCase() ?? ''}${normalized.slice(1)}` : 'Session'
}

function formatSessionActivity(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'recently'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (elapsedSeconds < 60) return 'now'
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

function defaultAssistantSessionForTransport(transportKind: string): AssistantSessionSnapshot {
  if (transportKind !== 'mock') return emptyAssistantSession()
  const createdAt = '2026-06-19T00:00:00Z'
  return {
    sessionId: 'Draft launch announcement',
    messages: [
      {
        id: 'demo-user-launch',
        role: 'user',
        text: 'Draft a short launch announcement for the Aurora 0.9 release.',
        createdAt,
        status: 'sent'
      },
      {
        id: 'demo-assistant-launch',
        role: 'assistant',
        text: `Here's a concise draft:\n\nAurora 0.9 is here. Your private assistant now runs across desktop, server, mesh and mobile with a unified operator cockpit for services, RBAC, and diagnostics. Every route is observable, every admin action is auditable, and local-first is the default.`,
        createdAt,
        status: 'sent',
        sources: ['release-notes.md', 'changelog/0.9.0']
      },
      {
        id: 'demo-user-health',
        role: 'user',
        text: 'Now check our latest deployment health and summarize any warnings.',
        createdAt,
        status: 'sent'
      },
      {
        id: 'demo-assistant-health',
        role: 'assistant',
        text: 'I can call diagnostics to read current service health. This is a read-only action on the local node.',
        createdAt,
        status: 'sent',
        toolCalls: [
          {
            id: 'demo-tool-diagnostics',
            name: 'diagnostics.serviceHealth',
            status: 'requested',
            riskClass: 'Read-only',
            target: 'Gateway',
            dataLeavesDevice: false,
            summary: 'Read current service health and warning states from the local Gateway.',
            auditId: null,
            payloadPreview: { scope: 'all-services', includeLogs: false }
          }
        ]
      }
    ]
  }
}

export function idleAssistantStreamState(): AssistantStreamState {
  return { status: 'idle', lastEventId: null, message: null }
}

export function loadAssistantSession(storageKey: string): AssistantSessionSnapshot {
  if (typeof window === 'undefined') return emptyAssistantSession()
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyAssistantSession()
    const parsed = JSON.parse(raw) as Partial<AssistantSessionSnapshot>
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isAssistantUiMessage) : []
    }
  } catch {
    return emptyAssistantSession()
  }
}

export function persistAssistantSession(storageKey: string, session: AssistantSessionSnapshot): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, JSON.stringify(session))
}

export function routePolicyFromRoute(
  route: RouteAvailability,
  provider = route.candidateProviders.find((candidate) => candidate.selectable && !isRemoteRouteCandidate(candidate))
    ?? route.candidateProviders.find((candidate) => !isRemoteRouteCandidate(candidate))
): AssistantRoutePolicy {
  return {
    providerId: provider?.providerId ?? provider?.id ?? null,
    peerId: null,
    serviceInstanceId: null,
    routeState: route.state,
    fallbackBehavior: route.state === 'degraded' ? 'backend-reported degraded route' : null,
    privacyClass: route.item.privacyClass,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired
  }
}

export function assistantExecutionOptions(route: RouteAvailability): AssistantExecutionOption[] {
  const options: AssistantExecutionOption[] = [{
    id: 'local',
    mode: 'local',
    label: 'Locally',
    description: 'Run the assistant here. The model may be local, cloud-backed, or shared by a peer.',
    routePolicy: routePolicyFromRoute(route)
  }]
  const seen = new Set<string>()
  for (const candidate of route.candidateProviders) {
    if (!candidate.selectable || !isRemoteRouteCandidate(candidate)) continue
    const peerId = candidate.peerId ?? peerIdFromProviderIdentity(candidate.providerId ?? candidate.id)
    const serviceInstanceId = candidate.serviceInstanceId ?? serviceInstanceFromProviderIdentity(candidate.providerId ?? candidate.id)
    const providerId = candidate.providerId ?? candidate.id
    const identity = peerId ?? serviceInstanceId ?? providerId
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    const peerLabel = executionPeerLabel(candidate.nodeName ?? candidate.label, peerId)
    options.push({
      id: `dispatch:${identity}`,
      mode: 'dispatch',
      label: peerLabel,
      description: `Dispatch the assistant turn to ${peerLabel}; that peer executes the request.`,
      routePolicy: {
        providerId,
        peerId,
        serviceInstanceId,
        routeState: candidate.state,
        fallbackBehavior: candidate.state === 'degraded' ? candidate.reason : null,
        privacyClass: route.item.privacyClass,
        selectorRequired: route.selectorRequired,
        approvalRequired: route.approvalRequired
      }
    })
  }
  return options
}

export function mergeAssistantModelCatalogs(
  localCatalog: ModelRuntimeCatalogResponse,
  remoteCatalogs: Array<{
    catalog: ModelRuntimeCatalogResponse
    execution: AssistantExecutionOption
  }>
): ModelRuntimeCatalogResponse {
  const providers = new Map(
    localCatalog.providers.map((provider) => [provider.provider_id, provider])
  )
  const unavailable = new Set(localCatalog.unavailable)
  const internalOnly = new Set(localCatalog.internal_only)

  for (const { catalog, execution } of remoteCatalogs) {
    for (const provider of catalog.providers) {
      if (!providerIsRemote(provider) || !providerMatchesExecution(provider, execution)) continue
      providers.set(provider.provider_id, provider)
    }
    for (const providerId of catalog.unavailable) {
      if (providers.has(providerId)) unavailable.add(providerId)
    }
    for (const providerId of catalog.internal_only) {
      if (providers.has(providerId)) internalOnly.add(providerId)
    }
  }

  const mergedProviders = [...providers.values()]
  return {
    ...localCatalog,
    providers: mergedProviders,
    provider_index: Object.fromEntries(
      mergedProviders.map((provider) => [
        provider.provider_id,
        provider.models?.map((model) => model.model_id) ?? []
      ])
    ),
    unavailable: [...unavailable],
    internal_only: [...internalOnly]
  }
}

export function assistantModelChoices(
  catalog: ModelRuntimeCatalogResponse | null,
  execution: AssistantExecutionOption
): AssistantModelChoice[] {
  const configuredProvider = catalog
    ? selectedRuntimeProvider(
        catalog.providers.find((provider) => provider.provider_id === catalog.selected_provider_id) ?? null,
        catalog.providers
      )
    : null
  const configuredModel = configuredProvider?.models?.find((model) => model.model_id === configuredProvider.model_id)
    ?? configuredProvider?.models?.find((model) => model.default)
  const automatic: AssistantModelChoice = {
    id: 'automatic',
    model: {
      id: 'automatic',
      name: execution.mode === 'local'
        ? `${configuredModel?.display_name ?? configuredProvider?.model_id ?? 'Configured default'}${configuredProvider ? ' · configured' : ''}`
        : 'Peer default',
      description: execution.mode === 'local'
        ? configuredProvider
          ? `Configured default · ${configuredProvider.display_name}`
          : 'Let Aurora choose from the configured, available model routes.'
        : `${execution.label} chooses from the models it shares and permits.`,
      icon: execution.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
    },
    provider: null,
    runtimeModel: null,
    automatic: true
  }
  if (!catalog) return [automatic]

  const choices = catalog.providers
    .filter((provider) => providerUsableForAssistant(provider))
    .filter((provider) => execution.mode === 'local' || providerMatchesExecution(provider, execution))
    .flatMap((provider) => {
      const models = provider.models?.filter((model) => model.available !== false) ?? []
      const availableModels = models.length > 0
        ? models
        : provider.model_id
          ? [{
              model_id: provider.model_id,
              display_name: provider.model_id,
              provider_id: provider.provider_id,
              secrets_redacted: true
            } satisfies ModelRuntimeModelInfo]
          : []
      return availableModels.map((runtimeModel): AssistantModelChoice => {
        const providerDisplayName = modelProviderDisplayName(provider, execution)
        const location = providerIsRemote(provider)
          ? `Shared by ${provider.provider_peer_id ?? provider.display_name}`
          : provider.provider_type === 'cloud' || /cloud|openai|anthropic|google/i.test(`${provider.provider_kind} ${provider.backend_kind} ${provider.provider_type}`)
            ? 'Cloud model'
            : 'Available on this device'
        const id = assistantModelChoiceId(provider.provider_id, runtimeModel.model_id)
        return {
          id,
          model: {
            id,
            name: runtimeModel.display_name || runtimeModel.model_id,
            description: `${providerDisplayName} · ${location}`,
            icon: providerIsRemote(provider) ? <Network aria-hidden /> : <Cpu aria-hidden />,
            keywords: [providerDisplayName, provider.display_name, provider.provider_id, runtimeModel.model_id, location]
          },
          provider,
          runtimeModel,
          automatic: false
        }
      })
    })
  return [automatic, ...choices]
}

export function assistantModelChoiceGroups(
  choices: AssistantModelChoice[],
  execution: AssistantExecutionOption
): AssistantModelChoiceGroup[] {
  const automatic = choices.filter((choice) => choice.automatic)
  const localProviders = new Map<string, AssistantModelChoiceGroup>()
  const peerProviders = new Map<string, AssistantModelChoiceGroup>()

  for (const choice of choices) {
    if (choice.automatic || !choice.provider) continue
    const provider = choice.provider
    const remote = providerIsRemote(provider)
    const id = remote
      ? `peer:${provider.provider_peer_id ?? 'remote'}:${provider.provider_id}`
      : `local:${provider.provider_id}`
    const target = remote ? peerProviders : localProviders
    const existing = target.get(id)
    if (existing) {
      existing.choices.push(choice)
      continue
    }
    target.set(id, {
      id,
      heading: `${modelProviderDisplayName(provider, execution)} · ${modelCountLabel(1)}`,
      choices: [choice],
      scope: remote ? 'connected device' : 'this device'
    })
  }

  const groups: AssistantModelChoiceGroup[] = automatic.length > 0
    ? [{
        id: 'configured-default',
        heading: execution.mode === 'local' ? 'Configured default' : `${execution.label} default`,
        choices: automatic,
        scope: 'default'
      }]
    : []
  groups.push(...localProviders.values(), ...peerProviders.values())
  for (const group of groups) {
    if (group.scope === 'default') continue
    group.heading = group.heading.replace(/1 model$/, modelCountLabel(group.choices.length))
  }
  return groups
}

export function assistantModelSourceGroups(
  providerGroups: AssistantModelChoiceGroup[],
  execution: AssistantExecutionOption,
  executionOptions: AssistantExecutionOption[] = [execution]
): AssistantModelSourceGroup[] {
  const sources = new Map<string, AssistantModelSourceGroup>()
  for (const group of providerGroups) {
    if (group.scope === 'default' || group.choices.length === 0) continue
    const provider = group.choices[0]?.provider
    if (!provider) continue
    const remote = providerIsRemote(provider)
    const peerId = remote
      ? provider.provider_peer_id ?? peerIdFromProviderIdentity(provider.provider_id) ?? 'remote'
      : null
    const peerLabel = remote ? modelProviderPeerLabel(provider, execution, executionOptions) : null
    const sourceId = remote ? `source:peer:${peerId}` : 'source:local'
    const existing = sources.get(sourceId)
    if (existing) {
      existing.providerGroups.push(group)
      existing.modelCount += group.choices.length
      continue
    }
    sources.set(sourceId, {
      id: sourceId,
      heading: remote
        ? execution.mode === 'dispatch' ? `Dispatch · ${peerLabel}` : `Shared by ${peerLabel}`
        : 'This device',
      description: remote
        ? execution.mode === 'dispatch'
          ? `Models ${peerLabel} allows for dispatched assistant execution.`
          : `Models advertised and permitted by ${peerLabel}.`
        : 'Models configured on this Aurora device, grouped by provider.',
      providerGroups: [group],
      modelCount: group.choices.length,
      scope: remote ? 'peer' : 'local'
    })
  }
  return [...sources.values()]
}

function AssistantModelSourceSection({
  source,
  query
}: {
  source: AssistantModelSourceGroup
  query: string
}) {
  const [open, setOpen] = useState(source.scope === 'local')
  const searching = query.trim().length > 0
  const visibleProviders = source.providerGroups.filter((group) =>
    !searching || group.choices.some((choice) => assistantModelChoiceMatches(choice, query))
  )
  if (visibleProviders.length === 0) return null
  const visibleModelCount = visibleProviders.reduce((total, group) =>
    total + group.choices.filter((choice) => !searching || assistantModelChoiceMatches(choice, query)).length, 0
  )
  return (
    <div className="aui-model-source-section" data-source-scope={source.scope}>
      <ModelSelector.Separator className="mx-0" />
      <Collapsible open={searching || open} onOpenChange={(next) => {
        if (!searching) setOpen(next)
      }}>
        <CollapsibleTrigger type="button" className="aui-model-source-trigger">
          {source.scope === 'peer' ? <Network aria-hidden /> : <Laptop aria-hidden />}
          <span className="aui-model-group-copy">
            <strong>{source.heading}</strong>
            <small>{source.description}</small>
          </span>
          <span className="aui-model-group-count">{modelCountLabel(searching ? visibleModelCount : source.modelCount)}</span>
          <ChevronDown className="aui-model-group-chevron" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="aui-model-source-content">
          {visibleProviders.map((group) => (
            <AssistantModelProviderSection key={group.id} group={group} query={query} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function AssistantModelProviderSection({
  group,
  query
}: {
  group: AssistantModelChoiceGroup
  query: string
}) {
  const [open, setOpen] = useState(false)
  const searching = query.trim().length > 0
  const visibleChoices = group.choices.filter((choice) =>
    !searching || assistantModelChoiceMatches(choice, query)
  )
  if (visibleChoices.length === 0) return null
  const provider = visibleChoices[0]?.provider
  return (
    <Collapsible
      open={searching || open}
      onOpenChange={(next) => {
        if (!searching) setOpen(next)
      }}
      className="aui-model-provider-section"
    >
      <CollapsibleTrigger type="button" className="aui-model-provider-trigger">
        {providerIsRemote(provider!) ? <Network aria-hidden /> : <Cpu aria-hidden />}
        <span>{group.heading.replace(/\s+·\s+\d+\s+models?$/, '')}</span>
        <span className="aui-model-group-count">{modelCountLabel(visibleChoices.length)}</span>
        <ChevronDown className="aui-model-group-chevron" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="aui-model-provider-content">
        <ModelSelector.Group>
          {visibleChoices.map((choice) => <ModelSelector.Item key={choice.id} model={choice.model} />)}
        </ModelSelector.Group>
      </CollapsibleContent>
    </Collapsible>
  )
}

function assistantModelChoiceMatches(choice: AssistantModelChoice, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [
    choice.model.id,
    choice.model.name,
    choice.model.description ?? '',
    ...(choice.model.keywords ?? [])
  ].some((value) => value.toLowerCase().includes(normalized))
}

export function defaultAssistantModelChoiceId(
  choices: AssistantModelChoice[],
  catalog: ModelRuntimeCatalogResponse | null,
  execution: AssistantExecutionOption
): string {
  if (execution.mode === 'dispatch' || !catalog) return 'automatic'
  const selectedProvider = selectedRuntimeProvider(
    catalog.providers.find((provider) => provider.provider_id === catalog.selected_provider_id) ?? null,
    catalog.providers
  )
  if (!selectedProvider) return 'automatic'
  const selectedModelId = selectedProvider.default_model_id
    ?? selectedProvider.models?.find((model) => model.default)?.model_id
    ?? selectedProvider.model_id
  if (!selectedModelId) return 'automatic'
  const id = assistantModelChoiceId(selectedProvider.provider_id, selectedModelId)
  return choices.some((choice) => choice.id === id) ? id : 'automatic'
}

export function assistantInferencePolicy(
  choice: AssistantModelChoice,
  route: RouteAvailability
): AssistantInferencePolicy | null {
  if (choice.automatic || !choice.provider || !choice.runtimeModel) return null
  const provider = choice.provider
  const remote = providerIsRemote(provider)
  return {
    providerId: provider.provider_id,
    peerId: remote ? provider.provider_peer_id ?? peerIdFromProviderIdentity(provider.provider_id) : null,
    serviceInstanceId: remote
      ? provider.provider_service_instance_id ?? serviceInstanceFromProviderIdentity(provider.provider_id)
      : null,
    runtimeProviderId: remote ? null : provider.provider_id,
    modelId: choice.runtimeModel.model_id,
    privacyClass: route.item.privacyClass,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired,
    dataLeavesDevice: remote || provider.provider_type === 'cloud'
  }
}

function assistantModelChoiceId(providerId: string, modelId: string): string {
  return `model:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`
}

function providerUsableForAssistant(provider: ModelRuntimeProviderInfo): boolean {
  if (!provider.enabled) return false
  return !/unavailable|misconfigured|offline|error|disabled/i.test(provider.health)
}

function providerIsRemote(provider: ModelRuntimeProviderInfo): boolean {
  return /mesh|remote|peer/i.test(`${provider.provider_kind ?? ''}`)
    || /^(?:mesh|remote):/i.test(provider.provider_id)
}

function modelProviderDisplayName(
  provider: ModelRuntimeProviderInfo,
  execution: AssistantExecutionOption
): string {
  if (execution.mode !== 'dispatch') return provider.display_name
  const peerId = execution.routePolicy.peerId
  return peerId
    ? provider.display_name.replace(new RegExp(`\\s*\\(${escapeRegExp(peerId)}\\)\\s*$`), '')
    : provider.display_name
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function providerMatchesExecution(
  provider: ModelRuntimeProviderInfo,
  execution: AssistantExecutionOption
): boolean {
  const peerId = execution.routePolicy.peerId
  const serviceInstanceId = execution.routePolicy.serviceInstanceId
  if (!providerIsRemote(provider)) return false
  if (peerId && provider.provider_peer_id === peerId) return true
  if (serviceInstanceId && provider.provider_service_instance_id === serviceInstanceId) return true
  const evidence = `${provider.provider_id} ${provider.provider_peer_id ?? ''} ${provider.provider_service_instance_id ?? ''}`
  return Boolean(peerId && evidence.includes(peerId))
}

function modelProviderPeerLabel(
  provider: ModelRuntimeProviderInfo,
  execution: AssistantExecutionOption,
  executionOptions: AssistantExecutionOption[]
): string {
  if (execution.mode === 'dispatch') return execution.label
  const peerId = provider.provider_peer_id ?? peerIdFromProviderIdentity(provider.provider_id)
  const option = executionOptions.find((candidate) =>
    candidate.mode === 'dispatch' && candidate.routePolicy.peerId === peerId
  )
  return option?.label ?? peerId ?? 'Peer'
}

function modelCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}

function isRemoteRouteCandidate(candidate: RouteAvailability['candidateProviders'][number]): boolean {
  return /mesh|remote/i.test(`${candidate.providerKind ?? ''} ${candidate.providerId ?? ''} ${candidate.id} ${candidate.serviceInstanceId ?? ''} ${candidate.label}`)
}

function peerIdFromProviderIdentity(providerId: string): string | null {
  const match = /^(?:remote|mesh):([^:]+):/i.exec(providerId)
  return match?.[1] ?? null
}

function serviceInstanceFromProviderIdentity(providerId: string): string | null {
  const match = /^(?:remote|mesh):([^:]+):([^:]+)/i.exec(providerId)
  return match ? `${match[0].startsWith('mesh:') ? 'mesh' : 'remote'}:${match[1]}:${match[2]}` : null
}

function executionPeerLabel(label: string, peerId: string | null): string {
  const providerLabel = label.split(' / ')[0]?.trim() ?? ''
  const readable = providerLabel.replace(/^(?:remote|mesh):/i, '').replace(/[:/_-]+Orchestrator.*$/i, '')
  return readable || peerId || 'Peer'
}

export function assistantRemotePrivacyWarning(route: RouteAvailability): string | null {
  const privacyClass = route.item.privacyClass
  if (privacyClass === 'public') return null
  const remoteOrMeshEvidence = [
    route.providerLabel,
    route.explanation,
    ...route.candidateProviders.flatMap((candidate) => [candidate.id, candidate.label, candidate.reason])
  ].join(' ')
  const remoteOrMeshFallback =
    route.state === 'available-remote' ||
    route.state === 'degraded' ||
    route.selectorRequired ||
    /remote|mesh|peer|cloud|http|fallback/i.test(remoteOrMeshEvidence)
  if (!remoteOrMeshFallback) return null
  const label = privacyClass === 'raw-audio'
    ? 'Raw audio'
    : privacyClass.charAt(0).toUpperCase() + privacyClass.slice(1)
  return `${label} data needs privacy review before another device can help; nothing leaves until consent, privacy indicator, and policy allow it.`
}

export function productAssistantErrorCopy(error: AuroraError | Error): string {
  if ('code' in error && error.code === 'timeout') return 'Aurora timed out before returning a final assistant response.'
  if ('code' in error && (error.code === 'auth' || error.code === 'permission')) return 'Assistant request denied. Review access and try again.'
  if ('code' in error && (error.code === 'unavailable_service' || error.code === 'unsupported_feature')) return 'Assistant service is unavailable for this Aurora setup.'
  if ('code' in error && error.code === 'privacy_blocked') return 'Assistant request is blocked until the required privacy choice is made.'
  if ('code' in error && error.code === 'transport_loss') return 'Assistant response was interrupted before Aurora finished.'
  return 'Assistant request failed. Try again.'
}

export const assistantErrorMessage = productAssistantErrorCopy

export function assistantControlsForRoute(
  route: RouteAvailability,
  cancellationRoute: RouteAvailability | undefined,
  busy: boolean
): AssistantControlState {
  const canSend = !route.disabled && !busy
  if (!busy) {
    return {
      canSend,
      canCancel: false,
      cancelReason: 'no active response'
    }
  }
  if (!cancellationRoute) {
    return {
      canSend,
      canCancel: false,
      cancelReason: 'Stop is unavailable for this response.'
    }
  }
  if (cancellationRoute.disabled) {
    return {
      canSend,
      canCancel: false,
      cancelReason: 'Stop is unavailable for this response.'
    }
  }
  return {
    canSend,
    canCancel: true,
    cancelReason: 'Stop is available for this response.'
  }
}


export function isAssistantStreamHardTerminal(update: Pick<AssistantStreamUpdate, 'kind'>): boolean {
  return update.kind === 'failed' || update.kind === 'fallback' || update.kind === 'transport_lost'
}

export function applyAssistantStreamDelta(message: AssistantUiMessage, update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  if (!update.textDelta) return message
  const currentText = message.text === 'Waiting for Aurora stream...' || message.text === 'Replaying stream from last backend event...'
    ? ''
    : message.text
  return {
    ...message,
    text: `${currentText}${update.textDelta}`,
    status: 'streaming',
    modelLabel: update.modelLabel ?? message.modelLabel,
    providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? message.providerLabel
  }
}

export function applyAssistantToolUpdate(
  message: AssistantUiMessage,
  update: AssistantStreamUpdate,
  placeholder = 'Waiting for Aurora stream...'
): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  const toolCall = assistantToolCallFromUpdate(update)
  return {
    ...message,
    text: message.text.trim() && message.text !== placeholder
      ? message.text
      : toolCall.status === 'requires_action'
        ? 'Aurora paused for a tool approval decision.'
        : `Aurora is ${toolCall.status === 'failed' ? 'reporting a tool error' : toolCall.status === 'completed' ? 'finished using a tool' : 'using a tool'}.`,
    toolCalls: upsertAssistantToolCall(message.toolCalls, toolCall)
  }
}

export function applyAssistantAudioChunkUpdate(message: AssistantUiMessage, _update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  if (!hasSubstantiveAssistantText(message)) return message
  return { ...message, status: 'sent' }
}

function base64ToUint8Array(value: string): Uint8Array {
  if (typeof atob !== 'function') return new Uint8Array()
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function applyAssistantTerminalUpdate(message: AssistantUiMessage, update: AssistantStreamUpdate): AssistantUiMessage {
  if (message.status === 'cancelled') return message
  const terminalText = update.text.trim() || !hasSubstantiveAssistantText(message)
    ? update.text
    : message.text
  return {
    ...message,
    id: update.messageId ?? message.id,
    role: 'assistant',
    text: terminalText,
    createdAt: message.createdAt,
    status: 'sent',
    modelLabel: update.modelLabel ?? message.modelLabel,
    providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? message.providerLabel,
    routeLabel: message.routeLabel,
    toolCalls: message.toolCalls
  }
}

export function mergeTranscriptText(
  previous: string,
  incoming: string,
  options: { appendOnMiss: boolean }
): string {
  const previousWords = transcriptWords(previous)
  const incomingWords = transcriptWords(incoming)
  if (previousWords.length === 0) return incomingWords.join(' ')
  if (incomingWords.length === 0) return previousWords.join(' ')

  const previousKeys = previousWords.map(transcriptWordKey)
  const incomingKeys = incomingWords.map(transcriptWordKey)
  if (incomingKeys.slice(0, previousKeys.length).every((word, index) => word === previousKeys[index])) {
    return incomingWords.join(' ')
  }
  if (previousKeys.length === incomingKeys.length && previousKeys.every((word, index) => word === incomingKeys[index])) {
    return incomingWords.join(' ')
  }

  let bestPreviousIndex = -1
  let bestLength = 0
  for (let previousIndex = 0; previousIndex < previousKeys.length; previousIndex += 1) {
    let length = 0
    while (
      previousIndex + length < previousKeys.length &&
      length < incomingKeys.length &&
      previousKeys[previousIndex + length] === incomingKeys[length]
    ) {
      length += 1
    }
    if (length > bestLength) {
      bestPreviousIndex = previousIndex
      bestLength = length
    }
  }

  const minOverlap = Math.min(previousKeys.length, incomingKeys.length) <= 5 ? 2 : 3
  if (bestPreviousIndex >= 0 && bestLength >= minOverlap) {
    return [...previousWords.slice(0, bestPreviousIndex), ...incomingWords].join(' ')
  }

  return options.appendOnMiss
    ? [...previousWords, ...incomingWords].join(' ')
    : incomingWords.join(' ')
}

export function isAuthoritativeVoiceTranscriptEvent(event: Pick<VoiceRuntimeEvent, 'kind' | 'topic'>): boolean {
  if (event.kind !== 'transcription_partial' && event.kind !== 'transcription_final') return true
  const topic = event.topic ?? ''
  // Transcription.Result is the lower-level STT service result. The
  // STTCoordinator republishes authoritative per-session Partial and
  // UserSpeechCaptured/Final events after timeout refresh, merge, and state
  // gating. Treating both as chat finals creates duplicate voice turns.
  if (topic === 'Transcription.Result') return false
  return true
}

export function isAuthoritativeCoordinatorSessionStart(
  event: Pick<VoiceRuntimeEvent, 'kind' | 'topic' | 'sourcePeerId' | 'targetPeerId' | 'targetDeviceId'>
): boolean {
  return event.kind === 'session_started'
    && event.topic === 'STTCoordinator.SessionStarted'
    && isLocalVoiceEventSource(event)
}

function transcriptWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

function transcriptWordKey(word: string): string {
  return word.replace(/[^\p{L}\p{N}_]+/gu, '').toLocaleLowerCase()
}

function normalizeAssistantMessageText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function isAssistantPlaceholderText(text: string): boolean {
  return /^(waiting for aurora stream|replaying stream from last backend event|aurora is processing your voice request)/i.test(text.trim())
}

function hasSubstantiveAssistantText(message: AssistantUiMessage): boolean {
  return message.role === 'assistant' && Boolean(normalizeAssistantMessageText(message.text)) && !isAssistantPlaceholderText(message.text)
}

function isAssistantPendingWork(message: AssistantUiMessage): boolean {
  if (message.role !== 'assistant') return false
  if (message.status === 'sending') return true
  if (message.status !== 'streaming') return false
  return !hasSubstantiveAssistantText(message)
}

function createAttachmentDraft(input: {
  kind: AssistantAttachmentDraft['kind']
  label: string
  detail: string
  contentText?: string | null
  url?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  previewUrl?: string | null
  sourceChannel: AttachmentContextSourceChannel
  privacyClass: AttachmentContextPrivacyClass
}): AssistantAttachmentDraft {
  return {
    id: `context-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    contentText: input.contentText ?? null,
    url: input.url ?? null,
    filename: input.filename ?? null,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    previewUrl: input.previewUrl ?? null,
    sourceChannel: input.sourceChannel,
    sourceDisplayName: sourceLabel(input.sourceChannel),
    privacyClass: input.privacyClass,
    status: 'staged',
    progress: 0,
    message: input.contentText
      ? 'Staged for backend validation.'
      : 'Preview staged; Aurora will receive file metadata only until binary extraction is enabled.',
    reasonCode: null,
    redacted: false
  }
}

async function fileToAttachmentDraft(
  file: File,
  sourceChannel: AttachmentContextSourceChannel,
  privacyClass: AttachmentContextPrivacyClass
): Promise<AssistantAttachmentDraft> {
  const validation = validateAssistantAttachmentFile(file)
  if (!validation.allowed) {
    return {
      ...createAttachmentDraft({
        kind: 'file',
        label: file.name,
        detail: `${file.type || 'unknown type'} / ${formatBytes(file.size)}`,
        filename: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        sourceChannel,
        privacyClass
      }),
      status: 'rejected',
      progress: 0,
      message: validation.reason
    }
  }
  const isTextLike = validation.kind === 'text' || validation.kind === 'json'
  const isImage = validation.kind === 'image'
  const previewUrl = isImage || validation.kind === 'pdf' ? URL.createObjectURL(file) : null
  const contentText = isTextLike
    ? await file.text()
    : `${isImage ? 'Image' : 'PDF'} attachment: ${file.name} (${file.type || validation.mimeType || 'unknown type'}, ${formatBytes(file.size)}). Binary content is previewed in the UI; extracted file content is not included in this text context yet.`
  return createAttachmentDraft({
    kind: isImage ? 'image' : 'file',
    label: file.name,
    detail: `${validation.label} · ${formatBytes(file.size)}`,
    contentText,
    previewUrl,
    filename: file.name,
    mimeType: file.type || validation.mimeType,
    sizeBytes: file.size,
    sourceChannel,
    privacyClass
  })
}

function validateAssistantAttachmentFile(file: File):
  | { allowed: true; kind: 'image' | 'pdf' | 'text' | 'json'; label: string; mimeType: string | null }
  | { allowed: false; reason: string } {
  const name = file.name.toLowerCase()
  const mime = file.type || ''
  const imageMime = imageMimeTypeFromFile(name, mime)
  if (imageMime) return { allowed: true, kind: 'image', label: imageMime, mimeType: imageMime }
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return { allowed: true, kind: 'pdf', label: 'PDF', mimeType: 'application/pdf' }
  if (mime === 'application/json' || mime === 'text/json' || name.endsWith('.json')) return { allowed: true, kind: 'json', label: 'JSON', mimeType: mime || 'application/json' }
  if (mime === 'text/plain' || mime === 'text/markdown' || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
    return { allowed: true, kind: 'text', label: name.endsWith('.md') || name.endsWith('.markdown') ? 'Markdown' : 'Text', mimeType: mime || 'text/plain' }
  }
  return { allowed: false, reason: 'Unsupported attachment type. Add only images, PDF, JSON, .txt, or .md files.' }
}

function imageMimeTypeFromFile(name: string, mime: string): string | null {
  if (mime.startsWith('image/')) return mime
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.gif')) return 'image/gif'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.bmp')) return 'image/bmp'
  return null
}

function summarizeAttachments(attachments: AssistantAttachmentDraft[]): { ready: number; blocked: number } {
  return attachments.reduce(
    (summary, attachment) => {
      if (['accepted', 'redacted', 'stored'].includes(attachment.status)) summary.ready += 1
      if (['unsupported', 'rejected', 'error'].includes(attachment.status)) summary.blocked += 1
      return summary
    },
    { ready: 0, blocked: 0 }
  )
}

function attachmentStateBadge(status: AttachmentTrayStatus) {
  if (status === 'accepted' || status === 'stored' || status === 'redacted') return 'available-local' as const
  if (status === 'uploading' || status === 'staged') return 'pending' as const
  if (status === 'unsupported') return 'unsupported' as const
  return 'denied' as const
}

function missingVoiceRoute(
  id: string,
  label: string,
  capability: string,
  privacyClass: VoiceCapabilityChip['privacyClass']
): RouteAvailability {
  const [capabilityModule, capabilityMethod] = capability.split('.')
  return {
    item: {
      id,
      label,
      href: '/',
      capabilityModule: capabilityModule ?? capability,
      capabilityMethod: capabilityMethod ?? capability,
      methodType: 'use' as const,
      privacyClass,
      fallbackState: 'unsupported' as const,
      adminGated: false,
      expectedTask: 'service contract'
    },
    state: 'unsupported',
    explanation: `${capability} capability status is not available in the SDK snapshot.`,
    providerLabel: 'service contract pending',
    blockers: ['capability_not_advertised'],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['missing voice route'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: false
  }
}

function nativeCaptureState(
  nativeAvailable: boolean,
  nativePlatform: string,
  nativePermissions: Array<{ name: string; granted: boolean }>,
  nativeCapabilities: Array<{ name: string; enabled: boolean }>
): VoiceCapabilityChip {
  const permissionCandidates = nativePermissions.filter((entry) => voiceNativeKey(entry.name))
  const capabilityCandidates = nativeCapabilities.filter((entry) => voiceNativeKey(entry.name))
  const permission = permissionCandidates.find((entry) => !entry.granted) ?? permissionCandidates[0]
  const capability = capabilityCandidates.find((entry) => entry.enabled) ?? capabilityCandidates[0]
  const state = !nativeAvailable
    ? 'unsupported'
    : permission && !permission.granted
      ? 'privacy-blocked'
      : capability?.enabled
        ? 'available-local'
        : 'unsupported'
  return {
    id: 'native-capture',
    label: 'Native capture',
    state,
    privacyClass: 'raw-audio',
    providerLabel: nativeAvailable ? nativePlatform : 'Not available',
    detail: state === 'available-local'
      ? 'This device reports microphone or voice capture support.'
      : state === 'privacy-blocked'
        ? nativePlatform.toLowerCase().includes('ios')
          ? 'iOS foreground capture is blocked until microphone permission, raw-audio consent, and a visible stop/revoke path are available.'
          : 'Native capture is blocked until the platform microphone permission is granted.'
        : 'Device capture stays disabled until Aurora can confirm microphone support.',
    blockers: state === 'available-local' ? [] : [permission && !permission.granted ? `device permission missing: ${permission.name}` : 'voice capture unavailable'],
    evidence: nativeAvailable ? ['native-manifest'] : []
  }
}

function voiceNativeKey(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.includes('microphone') || normalized.includes('voice') || normalized.includes('audio')
}

function browserCaptureAvailability(
  surfaceProfile: AuroraSurfaceProfile,
  captureStatus: VoiceCaptureStatus
): Pick<VoiceCapabilityChip, 'state' | 'providerLabel' | 'detail' | 'blockers'> {
  if (surfaceProfile.kind === 'desktop-local') {
    return {
      state: captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking' ? 'available-local' : 'pending',
      providerLabel: 'This computer',
      detail: surfaceProfile.voiceCapture.detail,
      blockers: []
    }
  }
  if (surfaceProfile.isMobile) {
    return {
      state: captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking' ? 'available-local' : 'pending',
      providerLabel: 'This device',
      detail: surfaceProfile.voiceCapture.detail,
      blockers: []
    }
  }
  if (captureStatus === 'listening') {
    return {
      state: 'available-local',
      providerLabel: 'This device',
      detail: 'Local browser microphone stream is active on this device.',
      blockers: []
    }
  }
  if (captureStatus === 'processing' || captureStatus === 'speaking') {
    return {
      state: 'available-local',
      providerLabel: 'This device',
      detail: captureStatus === 'processing' ? 'Captured audio is being processed.' : 'Assistant speech playback is active.',
      blockers: []
    }
  }
  if (captureStatus === 'permission-denied') {
    return {
      state: 'denied',
      providerLabel: 'This device',
      detail: 'Browser microphone permission was denied.',
      blockers: ['browser_microphone_permission_denied']
    }
  }
  if (captureStatus === 'no-device') {
    return {
      state: 'unsupported',
      providerLabel: 'This device',
      detail: 'This device did not expose a microphone.',
      blockers: ['browser_microphone_api_missing']
    }
  }
  if (captureStatus === 'error') {
    return {
      state: 'degraded',
      providerLabel: 'This device',
      detail: 'Browser microphone capture failed; retry or inspect device settings.',
      blockers: ['browser_microphone_error']
    }
  }
  return {
    state: 'pending',
    providerLabel: 'browser getUserMedia',
    detail: 'Local capture waits for the browser permission prompt.',
    blockers: []
  }
}

function pushToTalkControlState(
  surfaceProfile: AuroraSurfaceProfile,
  browserState: RouteAvailability['state']
): RouteAvailability['state'] {
  if (surfaceProfile.kind === 'desktop-local') return 'available-local'
  if (surfaceProfile.isMobile) return browserState === 'unsupported' ? 'pending' : browserState
  return browserState
}

function voiceChip(
  id: string,
  label: string,
  route: RouteAvailability,
  privacyClass: VoiceCapabilityChip['privacyClass'],
  detail: string
): VoiceCapabilityChip {
  return {
    id,
    label,
    state: route.state,
    privacyClass,
    providerLabel: route.providerLabel,
    detail,
    blockers: route.blockers,
    evidence: route.evidenceSources
  }
}

function wakeDetail(nativePlatform: string, wakeControl: RouteAvailability, wakeProcess: RouteAvailability): string {
  if (nativePlatform.toLowerCase().includes('ios')) {
    return 'iOS wake/background assistant behavior remains foreground-only or app-owned through Siri/Shortcuts/App Intents, widgets, share sheet, deep links, or notifications; system assistant ownership is unavailable.'
  }
  if (nativePlatform.toLowerCase().includes('android')) {
    return 'Android wake/background behavior requires foreground service and native plugin status.'
  }
  if (!wakeControl.disabled) return 'Wake control is foreground-capable through backend route status.'
  if (!wakeProcess.disabled) return 'Wake audio processing exists, but foreground/background control is not advertised.'
  return 'Wakeword remains unsupported until backend and native capture capability status exists.'
}

function remoteAudioRouteFor(...routes: RouteAvailability[]): RouteAvailability {
  return routes.find((route) => route.state === 'available-remote' || route.state === 'privacy-blocked') ??
    routes.find((route) => !route.disabled) ??
    routes[0]!
}

function voiceAction(
  id: string,
  label: string,
  route: RouteAvailability,
  captureStatus: VoiceCaptureStatus,
  consentGranted: boolean
): VoiceControlModel {
  if (route.disabled) {
    return {
      id,
      label,
      state: route.state,
      enabled: false,
      reason: presentableSignal(route.blockers.join(', ') || route.explanation),
      route
    }
  }
  if ((route.state === 'available-remote' || route.selectorRequired) && !consentGranted) {
    return {
      id,
      label,
      state: 'privacy-blocked',
      enabled: false,
      reason: 'Grant session consent before routing microphone/audio work to a remote peer.',
      route
    }
  }
  if ((id === 'remote-transcription' || id === 'wakeword') && captureStatus !== 'listening') {
    return {
      id,
      label,
      state: 'pending',
      enabled: false,
      reason: 'Start local capture before creating an audio session.',
      route
    }
  }
  return {
    id,
    label,
    state: route.state,
    enabled: false,
    reason: 'Audio can start after this device confirms microphone access.',
    route
  }
}

function voiceEventRows(
  captureStatus: VoiceCaptureStatus,
  transcription: RouteAvailability,
  voiceEvents: VoiceRuntimeEvent[]
): VoiceEventRow[] {
  const captureFailure: VoiceEventRow | null =
    captureStatus === 'permission-denied'
      ? { id: 'permission-loss', label: 'Local permission loss', state: 'denied', detail: 'Browser or native microphone permission was lost or denied.' }
      : captureStatus === 'no-device' || captureStatus === 'error'
        ? { id: 'capture-error', label: 'Capture error', state: captureStatus === 'no-device' ? 'unsupported' : 'degraded', detail: 'Local capture failed before audio could be routed.' }
        : null
  const rows = [
    { id: 'partial', label: 'Partial transcription', state: transcription.disabled ? 'unsupported' : 'pending', detail: 'Incremental text remains tied to backend stream events.' },
    { id: 'final', label: 'Final transcription', state: transcription.disabled ? 'unsupported' : transcription.state, detail: 'Final text must come from Transcription service status.' },
    { id: 'tts-started', label: 'Speech started', state: 'pending', detail: 'Playback starts after Aurora confirms speech has begun.' },
    { id: 'tts-stopped', label: 'Speech stopped', state: 'pending', detail: 'Stop and cancel controls wait for Aurora to finish stopping speech.' },
    { id: 'timeout', label: 'Timeout', state: 'degraded', detail: 'Timeouts remain visible as retryable voice session outcomes.' },
    { id: 'cancelled', label: 'Cancelled', state: 'pending', detail: 'Cancellation must revoke or stop the current audio session.' },
    { id: 'remote-denied', label: 'Remote denial', state: 'denied', detail: 'Policy, selector, or peer denial is shown without silent fallback.' },
    { id: 'peer-disconnect', label: 'Peer disconnect', state: 'stale', detail: 'Remote peer loss makes the current provider unselectable.' },
    ...(captureFailure ? [captureFailure] : [])
  ] satisfies VoiceEventRow[]
  return applyVoiceEvidenceRows(rows, voiceEvents)
}

function applyVoiceEvidenceRows(rows: VoiceEventRow[], voiceEvents: VoiceRuntimeEvent[]): VoiceEventRow[] {
  if (voiceEvents.length === 0) return rows
  const latestByRow = new Map<string, VoiceRuntimeEvent>()
  for (const event of voiceEvents) {
    const rowId = voiceEventRowId(event)
    if (!rowId || latestByRow.has(rowId)) continue
    latestByRow.set(rowId, event)
  }
  return rows.map((row) => {
    const event = latestByRow.get(row.id)
    if (!event) return row
    return {
      ...row,
      state: availabilityForVoiceEvent(event, row.state),
      detail: voiceEvidenceDetail(event)
    }
  })
}

function voiceEventRowId(event: VoiceRuntimeEvent): string | null {
  if (event.kind === 'transcription_partial') return 'partial'
  if (event.kind === 'transcription_final') return 'final'
  if (event.kind === 'tts_started') return 'tts-started'
  if (event.kind === 'tts_stopped' || event.kind === 'tts_paused' || event.kind === 'tts_resumed') return 'tts-stopped'
  if (event.kind === 'stt_timeout') return 'timeout'
  if (event.kind === 'audio_cancelled' || event.kind === 'session_ended') return 'cancelled'
  if (event.kind === 'audio_denied' || event.kind === 'stt_error' || event.kind === 'tts_error') return 'remote-denied'
  if (event.kind === 'audio_disconnected') return 'peer-disconnect'
  return null
}

function availabilityForVoiceEvent(event: VoiceRuntimeEvent, fallback: VoiceEventRow['state']): VoiceEventRow['state'] {
  if (event.state === 'denied' || event.state === 'error') return 'denied'
  if (event.state === 'disconnected') return 'stale'
  if (event.state === 'timeout') return 'degraded'
  if (event.state === 'cancelled') return 'pending'
  if (event.state === 'listening' || event.state === 'processing' || event.state === 'speaking' || event.state === 'paused') return 'available-local'
  return fallback
}

function voiceEvidenceDetail(event: VoiceRuntimeEvent): string {
  const text = event.text ? ` / ${event.text}` : ''
  const reason = event.reason ? ` / ${event.reason}` : ''
  const peer = event.targetPeerId ?? event.sourcePeerId ?? 'local'
  const session = event.sessionId ?? 'no-session'
  const correlation = event.correlationId ?? 'no-correlation'
  return `${event.topic ?? event.kind} status from ${peer}; session ${session}; correlation ${correlation}; privacy ${event.privacyClass}${text}${reason}`
}

function waveformBars(captureStatus: VoiceCaptureStatus): number[] {
  if (captureStatus === 'listening') return [24, 48, 72, 52, 84, 38, 64, 46, 76, 30, 58, 42]
  if (captureStatus === 'processing') return [32, 32, 36, 40, 46, 54, 62, 70, 58, 46, 38, 34]
  if (captureStatus === 'speaking') return [42, 70, 48, 82, 52, 88, 58, 76, 44, 64, 36, 56]
  if (captureStatus === 'permission-denied' || captureStatus === 'error') return [18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18]
  return [12, 20, 14, 22, 16, 18, 12, 20, 14, 22, 16, 18]
}

function idleWaveformBars(): number[] {
  return Array.from({ length: 24 }, () => 8)
}

function voiceRuntimeEventKey(event: VoiceRuntimeEvent): string {
  const sequence = typeof event.raw.sequence === 'number' || typeof event.raw.sequence === 'string'
    ? String(event.raw.sequence)
    : null
  return event.id ?? `${event.kind}:${event.sessionId ?? 'session'}:${sequence ?? event.text ?? ''}:${event.occurredAt}`
}

function isOwnedVoiceRuntimeEvent(event: VoiceRuntimeEvent, activeSessionId: string | null): boolean {
  if (!activeSessionId) return false
  return event.sessionId === activeSessionId
}

function shouldApplyVoiceRuntimeEvent(
  event: VoiceRuntimeEvent,
  activeSessionId: string | null,
  captureStatus: VoiceCaptureStatus
): boolean {
  if (isOwnedVoiceRuntimeEvent(event, activeSessionId)) return true
  const local = isLocalVoiceEventSource(event)
  if (event.kind === 'session_started') return local && !shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, captureStatus)
  if (event.kind === 'transcription_partial' || event.kind === 'transcription_final') {
    // WebView push-to-talk calls Transcription directly and owns its response in
    // transcribeRecordedBrowserAudio. Ignore sessionless bus echoes while a UI
    // capture session is active; daemon wakeword/STTCoordinator finals carry the
    // owned session id and pass the check above.
    if (activeSessionId && !event.sessionId) return false
    if (shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, captureStatus)) return false
    return local
  }
  const activeCapture = captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking'
  if (!activeCapture) return false
  if (shouldIgnoreForeignVoiceSessionEvent(event, activeSessionId, captureStatus)) return false
  return local
}

function shouldIgnoreForeignVoiceSessionEvent(
  event: VoiceRuntimeEvent,
  activeSessionId: string | null,
  captureStatus: VoiceCaptureStatus
): boolean {
  if (!activeSessionId || !event.sessionId || event.sessionId === activeSessionId) return false
  const activeCapture = captureStatus === 'listening' || captureStatus === 'processing'
  return activeCapture && activeSessionId.startsWith('voice-')
}

function shouldApplyVoiceSessionEndEvent(
  event: VoiceRuntimeEvent,
  activeSessionId: string | null,
  captureStatus: VoiceCaptureStatus
): boolean {
  if (event.kind !== 'session_ended') return false
  if (isOwnedVoiceRuntimeEvent(event, activeSessionId)) return true
  const activeCapture = captureStatus === 'listening' || captureStatus === 'processing'
  if (activeCapture && activeSessionId) return false
  return isLocalVoiceEventSource(event)
}

function isLocalVoiceEventSource(
  event: Pick<VoiceRuntimeEvent, 'sourcePeerId' | 'targetPeerId' | 'targetDeviceId'>
): boolean {
  const provenance = [event.sourcePeerId, event.targetPeerId, event.targetDeviceId].filter(Boolean)
  if (provenance.length === 0) return true
  return provenance.every((value) => /^(local|localhost|internal|self|system|gateway|aurora)$/i.test(value ?? ''))
}

function mergeVoiceRuntimeEvents(...groups: VoiceRuntimeEvent[][]): VoiceRuntimeEvent[] {
  const seen = new Set<string>()
  const merged: VoiceRuntimeEvent[] = []
  for (const event of groups.flat()) {
    const key = voiceRuntimeEventKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(event)
  }
  return merged
}

function waveformBarsFromLevel(level: number, peak: number): number[] {
  const safeLevel = Math.max(0, Math.min(100, level))
  const safePeak = Math.max(safeLevel, Math.min(100, peak))
  const shape = [0.38, 0.72, 0.54, 0.9, 0.62, 1, 0.76, 0.46, 0.84, 0.58, 0.68, 0.42, 0.94, 0.64, 0.5, 0.8, 0.56, 0.72, 0.44, 0.88, 0.6, 0.78, 0.48, 0.7]
  return shape.map((weight, index) => {
    const peakAccent = index % 5 === 0 ? safePeak * 0.28 : 0
    return Math.max(6, Math.min(100, Math.round(6 + safeLevel * weight + peakAccent)))
  })
}

function withIgnoredAudioDisconnect(disconnect: () => void) {
  try {
    disconnect()
  } catch {
    // Web Audio nodes may already be disconnected during rapid stop/retry.
  }
}

function flattenPcmChunks(chunks: Float32Array[], maxSamples?: number): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const wanted = maxSamples === undefined ? total : Math.min(total, maxSamples)
  const output = new Float32Array(wanted)
  let writeOffset = wanted
  let remaining = wanted
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index]
    if (!chunk) continue
    const take = Math.min(chunk.length, remaining)
    writeOffset -= take
    output.set(chunk.subarray(chunk.length - take), writeOffset)
    remaining -= take
  }
  return output
}

function floatPcmToBase64(samples: Float32Array, sourceRate: number, targetRate: number): string {
  const resampled = resampleFloat32(samples, sourceRate, targetRate)
  const buffer = new ArrayBuffer(resampled.length * 2)
  const view = new DataView(buffer)
  let offset = 0
  for (const sample of resampled) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += 2
  }
  return arrayBufferToBase64(buffer)
}

function waveformBarsFromTimeDomain(samples: Uint8Array, barCount: number): number[] {
  if (samples.length === 0 || barCount <= 0) return idleWaveformBars()
  const bars: number[] = []
  const segmentSize = Math.max(1, Math.floor(samples.length / barCount))
  for (let bar = 0; bar < barCount; bar += 1) {
    const start = bar * segmentSize
    const end = bar === barCount - 1 ? samples.length : Math.min(samples.length, start + segmentSize)
    let sumSquares = 0
    let count = 0
    for (let index = start; index < end; index += 1) {
      const centered = ((samples[index] ?? 128) - 128) / 128
      sumSquares += centered * centered
      count += 1
    }
    const rms = count > 0 ? Math.sqrt(sumSquares / count) : 0
    bars.push(Math.max(8, Math.min(96, Math.round(8 + rms * 220))))
  }
  return bars
}

function productAudioCaptureErrorCopy(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone permission was denied.'
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No microphone was found on this device.'
    }
    return 'Microphone capture failed. Try again.'
  }
  return 'Microphone capture failed. Try again.'
}

function resampleFloat32(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const sourceIndex = index * ratio
    const left = Math.floor(sourceIndex)
    const right = Math.min(input.length - 1, left + 1)
    const weight = sourceIndex - left
    output[index] = (input[left] ?? 0) * (1 - weight) + (input[right] ?? 0) * weight
  }
  return output
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T> {
  if (typeof window === 'undefined') return promise
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(timeoutError), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function revokeAttachmentPreview(attachment: Pick<AssistantAttachmentDraft, 'previewUrl'>): void {
  if (!attachment.previewUrl || typeof URL === 'undefined') return
  URL.revokeObjectURL(attachment.previewUrl)
}

function sourceLabel(source: AttachmentContextSourceChannel): string {
  if (source === 'mobile_share_sheet') return 'mobile share sheet'
  if (source === 'deep_link') return 'deep link'
  if (source === 'browser_extension') return 'browser extension'
  if (source === 'desktop') return 'desktop'
  if (source === 'api') return 'API'
  return 'chat composer'
}

function urlLabel(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return 'URL context'
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ConversationRail({
  session,
  sessions,
  route,
  transportKind,
  loading,
  error,
  disabled,
  onSelectConversation,
  onNewConversation
}: {
  session: AssistantSessionSnapshot
  sessions: DBSessionRecord[]
  route: RouteAvailability
  transportKind: string
  loading: boolean
  error: string | null
  disabled: boolean
  onSelectConversation: (sessionId: string) => void
  onNewConversation: () => void
}) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLowerCase()
  const rows = assistantConversationRows(session, sessions, transportKind)
    .filter((row) => normalizedSearch.length === 0 || `${row.title} ${row.route}`.toLowerCase().includes(normalizedSearch))
  return (
    <aside className="aui-conversation-rail" aria-labelledby="assistant-recent-chats-title">
      <h2 id="assistant-recent-chats-title" className="aui-sr-only">Recent chats</h2><span className="aui-sr-only">Conversation rail</span><div className="aui-sr-only" aria-label="Assistant local remote mesh route chips"><span>Search recent conversations</span><span>Local {assistantRouteProviderCopy(route)}</span><span>Remote route pending</span><span>Mesh route pending</span></div>
      <header>
        <Button type="button" variant="ghost" size="sm" onClick={onNewConversation} disabled={disabled || loading || transportKind === 'mesh'} aria-label="New conversation" className="aui-thread-new-button">
          <MessageSquarePlus aria-hidden />
          <span>New conversation</span>
        </Button>
      </header>
      <ul aria-label="Assistant conversation list">
        {error ? (
          <li className="empty" role="status">{error}</li>
        ) : loading && rows.length === 0 ? (
          <li className="empty">Loading conversations…</li>
        ) : rows.length === 0 ? (
          <li className="empty">No matching conversations.</li>
        ) : rows.map((row) => (
          <li key={row.id} className={row.active ? 'active' : undefined}>
            <Button type="button" variant="ghost" aria-current={row.active ? 'true' : undefined} disabled={disabled || loading} onClick={() => onSelectConversation(row.id)} className="aui-thread-row-button">
              <strong>{row.title}</strong>
              <span><EvidenceBadge label={row.route} /> <time>{row.updated}</time></span>
            </Button>
          </li>
        ))}
      </ul>
    </aside>
  )
}


function assistantConversationRows(session: AssistantSessionSnapshot, sessions: DBSessionRecord[], transportKind: string): Array<{ id: string; title: string; route: string; updated: string; active: boolean }> {
  if (transportKind === 'mock') {
    return [
      { id: 'draft-launch', title: 'Draft launch announcement', route: 'Local', updated: '2m ago', active: true },
      { id: 'quarterly', title: 'Summarize quarterly metrics', route: 'Remote', updated: '1h ago', active: false },
      { id: 'mesh-notes', title: 'Refactor mesh routing notes', route: 'Mesh Peer', updated: '5h ago', active: false },
      { id: 'journal', title: 'Personal journal reflection', route: 'Local', updated: 'yesterday', active: false }
    ]
  }
  return sessions.map((record) => ({
    id: record.id,
    title: record.title?.trim() || 'New chat',
    route: sessionTypeLabel(record.type),
    updated: `${formatSessionActivity(record.updated_at)} · ${record.message_count} ${record.message_count === 1 ? 'message' : 'messages'}`,
    active: record.id === session.sessionId
  }))
}

function ComposerAttachmentPreview({ attachments, onRemove }: { attachments: AssistantAttachmentDraft[]; onRemove: (id: string) => void }) {
  return (
    <AttachmentGroup className="aui-composer-attachment-preview" aria-label="Attached context previews">
      {attachments.map((attachment) => (
        <Attachment key={attachment.id} state={attachmentStateForUi(attachment.status)} size="sm" orientation="vertical" className={`aui-composer-attachment-card aui-attachment-${attachment.status} aui-attachment-kind-${attachment.kind}`}>
          <AttachmentMedia variant={attachment.previewUrl && attachment.mimeType?.startsWith('image/') ? 'image' : 'icon'} className="aui-composer-attachment-media">
            {attachment.previewUrl && attachment.mimeType?.startsWith('image/') ? (
              <img src={attachment.previewUrl} alt={attachment.label} />
            ) : attachment.mimeType?.startsWith('image/') ? (
              <ImageIcon aria-hidden />
            ) : (
              <FileText aria-hidden />
            )}
          </AttachmentMedia>
          <div className="aui-composer-attachment-bottom">
            <AttachmentContent className="aui-composer-attachment-meta">
              <AttachmentTitle>{attachment.label}</AttachmentTitle>
              <AttachmentDescription>{attachment.detail}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions className="aui-composer-attachment-actions">
              <AttachmentAction type="button" aria-label={`Remove ${attachment.label}`} onClick={() => onRemove(attachment.id)}>
                <X aria-hidden />
              </AttachmentAction>
            </AttachmentActions>
          </div>
        </Attachment>
      ))}
    </AttachmentGroup>
  )
}

function attachmentStateForUi(status: AttachmentTrayStatus): 'idle' | 'uploading' | 'processing' | 'error' | 'done' {
  if (status === 'uploading') return 'uploading'
  if (status === 'staged') return 'idle'
  if (status === 'accepted' || status === 'redacted' || status === 'stored') return 'done'
  return 'error'
}

function ChatBubble({
  message,
  onReadAloud,
  onResolveToolApproval,
  speakingMessageId,
  executionPeerLabels
}: {
  message: AssistantUiMessage
  onReadAloud?: (message: AssistantUiMessage) => void
  onResolveToolApproval?: ((tool: AssistantToolCallCard, approve: boolean, grantScope: AssistantApprovalGrantScope) => void) | undefined
  speakingMessageId?: string | null
  executionPeerLabels?: ReadonlyMap<string, string>
}) {
  const [copied, setCopied] = useState(false)
  const assistant = message.role === 'assistant'
  const runtimeLabel = assistantMessageRuntimeLabel(message, executionPeerLabels)
  const align = message.role === 'user' ? 'end' : 'start'
  const variant = message.role === 'user' ? 'tinted' : assistant ? 'outline' : 'muted'
  const isSpeaking = speakingMessageId === message.id
  function copyMessageText() {
    if (typeof navigator !== 'undefined') {
      void navigator.clipboard?.writeText(message.text)
    }
    setCopied(true)
    if (typeof window !== 'undefined') window.setTimeout(() => setCopied(false), 1100)
  }
  return (
    <Message align={align} className={`aui-chat-message aui-chat-${message.role} aui-chat-${message.status}`}>
      <MessageContent className="aui-chat-message-content">
        <MessageHeader className="aui-chat-message-header">
          <strong>{assistant ? 'Aurora' : messageRoleLabel(message.role)}</strong>
          {assistant ? <span className="aui-chat-runtime">{runtimeLabel}</span> : <span>{message.status}</span>}
          {assistant ? <span className="aui-sr-only">Aurora · {message.status}</span> : null}
        </MessageHeader>
        {assistant && message.toolCalls?.length ? (
          <div className="aui-assistant-tool-cards" aria-label="Assistant tool call cards">
            {message.toolCalls.map((tool) => (
              <AssistantToolCallCardView
                key={tool.id}
                tool={tool}
                onResolveToolApproval={onResolveToolApproval}
              />
            ))}
          </div>
        ) : null}
        <Bubble align={align} variant={variant} className="aui-chat-bubble-wrap">
          <BubbleContent className="aui-chat-bubble">
            <p>{message.text}</p>
            {message.sources?.length ? (
              <div className="aui-message-sources"><span>Sources:</span>{message.sources.map((source) => <code key={source}>{source}</code>)}</div>
            ) : null}
          </BubbleContent>
        </Bubble>
        {assistant ? (
          <MessageFooter className="aui-message-actions" aria-label="Assistant message actions">
            <Button type="button" variant="ghost" size="xs" onClick={copyMessageText} className="aui-message-action-button">
              <Copy size={12} aria-hidden data-icon="inline-start" />
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onReadAloud?.(message)}
              disabled={!message.text.trim() || message.status === 'streaming'}
              className="aui-message-action-button"
              data-speaking={isSpeaking ? 'true' : undefined}
              aria-pressed={isSpeaking}
            >
              {isSpeaking ? <StopCircle size={12} aria-hidden data-icon="inline-start" /> : <Volume2 size={12} aria-hidden data-icon="inline-start" />}
              <span>{isSpeaking ? 'Stop' : 'Read aloud'}</span>
            </Button>
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  )
}

export function assistantMessageRuntimeLabel(
  message: AssistantUiMessage,
  executionPeerLabels: ReadonlyMap<string, string> = new Map()
): string {
  const execution = safeAssistantRuntimeValue(
    message.routeLabel || (message.executionPeerId ? executionPeerLabels.get(message.executionPeerId) ?? null : null),
    message.executionPeerId ? 'Connected Aurora device' : 'Local'
  ) ?? 'Local'
  const model = safeAssistantRuntimeValue(message.modelLabel, null)
  return model && execution !== model ? `${execution} · ${model}` : execution
}

function safeAssistantRuntimeValue(value: string | null | undefined, fallback: string | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  if (isInternalAssistantLabel(trimmed)) return fallback
  return trimmed
}

function isInternalAssistantLabel(value: string): boolean {
  return /\b(?:transport|fallback|runtime|provider|consumer|hybrid|manifest|schema|protocol|sidecar|thin|signaling|datachannel|gateway|orchestrator|tooling|stt|tts|db)\b/i.test(value)
    || /[a-z]+:\/\/|[A-Z][A-Za-z]+\.[A-Z][A-Za-z]+|[{"]|secret|token/i.test(value)
}

function productConnectionCopy(value: string | null | undefined): string {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return 'Connection status pending'
  if (normalized.includes('tauri') || normalized.includes('native') || normalized.includes('local') || normalized.includes('mock')) return 'Connected on this device'
  if (normalized.includes('web') || normalized.includes('http') || normalized.includes('remote')) return 'Connected to Aurora'
  return 'Connection status ready'
}

function assistantRouteModeLabel(route: RouteAvailability): string {
  if (route.state === 'available-local') return 'Local'
  if (route.state === 'available-remote') return /mesh|peer/i.test(route.providerLabel) ? 'Mesh' : 'Remote'
  if (/mesh|peer/i.test(route.providerLabel)) return 'Mesh'
  if (/openai|cloud|remote/i.test(route.providerLabel)) return 'Remote'
  return route.providerLabel
}

function assistantRouteProviderCopy(route: RouteAvailability): string {
  if (route.state === 'available-remote' || /mesh|peer|remote|cloud/i.test(route.providerLabel)) return 'Connected Aurora device'
  return 'This device'
}

function selectedRuntimeProvider(
  provider: ModelRuntimeProviderInfo | null,
  providers: ModelRuntimeProviderInfo[]
): ModelRuntimeProviderInfo | null {
  return provider ?? providers.find((candidate) => candidate.selected) ?? null
}

function AssistantToolCallCardView({
  tool,
  onResolveToolApproval
}: {
  tool: AssistantToolCallCard
  onResolveToolApproval?: ((tool: AssistantToolCallCard, approve: boolean, grantScope: AssistantApprovalGrantScope) => void) | undefined
}) {
  const statusLabel = toolStatusLabel(tool.status)
  const StatusIcon = toolStatusIcon(tool.status)
  const previewText = toolInlinePreview(tool)
  const triggerLabel = `${statusLabel}: Aurora action`
  return (
    <ToolFallbackRoot
      className={`aui-assistant-tool-inline aui-tool-call-${tool.status}`}
      defaultOpen={tool.status === 'requires_action'}
      aria-label="Assistant action status"
    >
      <CollapsibleTrigger className="aui-assistant-tool-trigger" aria-label={triggerLabel}>
        <StatusIcon aria-hidden />
        <span className="aui-assistant-tool-title">
          <span className="aui-assistant-tool-status">{statusLabel}</span>
          <strong>{toolTitleCopy(tool)}</strong>
        </span>
        {previewText ? <span className="aui-assistant-tool-preview">{previewText}</span> : null}
        <ChevronDown aria-hidden className="aui-assistant-tool-chevron" />
      </CollapsibleTrigger>
      <span className="aui-sr-only">Action details</span>
      <dl className="aui-sr-only">
        <div><dt>Status</dt><dd>{statusLabel}</dd></div>
        <div><dt>Account history</dt><dd>{tool.auditId ? 'Will be updated' : 'Pending'}</dd></div>
      </dl>
      <ToolFallbackContent className="aui-assistant-tool-details">
        <dl className="aui-assistant-tool-metadata">
          <div><dt>Status</dt><dd>{statusLabel}</dd></div>
          <div><dt>Review</dt><dd>{toolReviewCopy(tool)}</dd></div>
          <div><dt>Destination</dt><dd>{toolDestinationCopy(tool)}</dd></div>
          <div><dt>Data leaves device</dt><dd>{tool.dataLeavesDevice ? 'Yes' : 'No'}</dd></div>
          <div><dt>Account history</dt><dd>{tool.auditId ? 'Will be updated' : 'Pending'}</dd></div>
        </dl>
        <p className="aui-assistant-tool-summary">{toolSummaryCopy(tool)}</p>
        {tool.error ? (
          <div className="aui-tool-fallback-error">
            <p className="aui-tool-fallback-error-header">Action could not finish.</p>
            <p className="aui-tool-fallback-error-reason">{toolErrorCopy(tool)}</p>
          </div>
        ) : null}
        {tool.payloadPreview ? <ToolFallbackArgs argsText="Request details hidden before review." /> : null}
        {tool.resultPreview !== null && tool.resultPreview !== undefined ? <ToolFallbackResult result="Result details saved with the conversation." /> : null}
      </ToolFallbackContent>
      {tool.status === 'requires_action' ? (
        <div className="aui-assistant-tool-actions" aria-label="Assistant action approval choices">
          <Button
            type="button"
            size="xs"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId)}
            onClick={() => onResolveToolApproval?.(tool, true, 'once')}
          >
            Approve once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId)}
            onClick={() => onResolveToolApproval?.(tool, true, 'session')}
          >
            Session
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId)}
            onClick={() => onResolveToolApproval?.(tool, true, 'until_expiry')}
          >
            Until expiry
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId)}
            onClick={() => onResolveToolApproval?.(tool, true, 'always')}
          >
            Always
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="aui-action-chip"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId)}
            onClick={() => onResolveToolApproval?.(tool, false, 'deny_once')}
          >
            Deny once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="aui-action-chip"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId)}
            onClick={() => onResolveToolApproval?.(tool, false, 'deny_always')}
          >
            Block
          </Button>
        </div>
      ) : null}
    </ToolFallbackRoot>
  )
}

function assistantToolCallFromUpdate(update: AssistantStreamUpdate): AssistantToolCallCard {
  const metadata = update.metadata ?? {}
  const tool = update.tool
  const structuredTool = tool as (typeof tool & { errorDetails?: Record<string, unknown> | string | null }) | null
  const name = tool?.name
    ?? metadataStringValue(metadata, 'tool_name')
    ?? metadataStringValue(metadata, 'toolName')
    ?? metadataStringValue(metadata, 'name')
    ?? 'tool.requested'
  const status = toolStatusFromUpdate(update)
  return {
    id: tool?.id ?? update.eventId ?? `${name}-${Date.now()}`,
    name,
    sessionId: update.sessionId,
    status,
    riskClass: tool?.riskClass ?? metadataStringValue(metadata, 'risk_class') ?? metadataStringValue(metadata, 'riskClass') ?? 'backend-evaluated',
    target: tool?.target ?? metadataStringValue(metadata, 'target') ?? metadataStringValue(metadata, 'provider') ?? 'Aurora tool provider',
    dataLeavesDevice: tool?.dataLeavesDevice ?? metadataBooleanValue(metadata, 'data_leaves_device') ?? metadataBooleanValue(metadata, 'dataLeavesDevice') ?? false,
    summary: tool?.summary ?? (update.text || metadataStringValue(metadata, 'summary') || toolSummaryForStatus(status)),
    auditId: update.audit.correlationId ?? null,
    payloadPreview: tool?.payloadPreview
      ?? metadataObjectValue(metadata, 'payload_preview')
      ?? metadataObjectValue(metadata, 'payloadPreview')
      ?? metadataObjectValue(metadata, 'redacted_args_preview')
      ?? metadataObjectValue(metadata, 'argsPreview'),
    resultPreview: tool?.resultPreview ?? metadataObjectValue(metadata, 'result_preview') ?? metadataObjectValue(metadata, 'resultPreview') ?? metadataStringValue(metadata, 'result_preview') ?? metadataStringValue(metadata, 'resultPreview'),
    error: tool?.error ?? metadataStringValue(metadata, 'error') ?? null,
    errorDetails: structuredTool?.errorDetails
      ?? metadataObjectValue(metadata, 'error_details')
      ?? metadataObjectValue(metadata, 'errorDetails')
      ?? metadataStringValue(metadata, 'error_details')
      ?? metadataStringValue(metadata, 'errorDetails'),
    pendingId: tool?.pendingId ?? metadataStringValue(metadata, 'pending_id') ?? metadataStringValue(metadata, 'pendingId') ?? null,
    approvalRequestId: tool?.approvalRequestId ?? metadataStringValue(metadata, 'approval_request_id') ?? metadataStringValue(metadata, 'approvalRequestId') ?? null,
    approvalExpiresAt: typeof tool?.approvalExpiresAt === 'number'
      ? tool.approvalExpiresAt
      : metadataNumberValue(metadata, 'approval_expires_at') ?? metadataNumberValue(metadata, 'approvalExpiresAt') ?? null,
    policyDecisionId: tool?.policyDecisionId ?? metadataStringValue(metadata, 'policy_decision_id') ?? metadataStringValue(metadata, 'policyDecisionId') ?? null
  }
}

function upsertAssistantToolCall(
  current: AssistantToolCallCard[] | undefined,
  next: AssistantToolCallCard
): AssistantToolCallCard[] {
  const existing = current ?? []
  const index = existing.findIndex((tool) => tool.id === next.id)
  if (index === -1) return [...existing, next]
  return existing.map((tool, currentIndex) => currentIndex === index ? mergeAssistantToolCall(tool, next) : tool)
}

function mergeAssistantToolCall(current: AssistantToolCallCard, next: AssistantToolCallCard): AssistantToolCallCard {
  return {
    ...current,
    ...next,
    sessionId: next.sessionId ?? current.sessionId ?? null,
    riskClass: next.riskClass || current.riskClass,
    target: next.target || current.target,
    summary: next.summary || current.summary,
    auditId: next.auditId ?? current.auditId,
    payloadPreview: next.payloadPreview ?? current.payloadPreview,
    resultPreview: next.resultPreview ?? current.resultPreview ?? null,
    error: next.error ?? current.error ?? null,
    errorDetails: next.errorDetails ?? current.errorDetails ?? null,
    pendingId: next.pendingId ?? current.pendingId ?? null,
    approvalRequestId: next.approvalRequestId ?? current.approvalRequestId ?? null,
    approvalExpiresAt: next.approvalExpiresAt ?? current.approvalExpiresAt ?? null,
    policyDecisionId: next.policyDecisionId ?? current.policyDecisionId ?? null,
    resolving: next.resolving ?? current.resolving
  }
}


function toolSummaryForStatus(status: AssistantToolCallCard['status']): string {
  if (status === 'requires_action') return 'Aurora paused this tool call until an operator approves or denies it.'
  if (status === 'failed') return 'Tool execution failed; Aurora will continue with the available context.'
  if (status === 'completed') return 'Tool execution completed and the result was returned to Aurora.'
  if (status === 'running') return 'Tool execution is running.'
  return 'Tool call requested by Aurora.'
}

function toolStatusLabel(status: AssistantToolCallCard['status']): string {
  if (status === 'requires_action') return 'Needs approval'
  if (status === 'completed') return 'Done'
  if (status === 'failed') return 'Errored'
  if (status === 'running') return 'Running'
  return 'Requested'
}

function toolStatusIcon(status: AssistantToolCallCard['status']) {
  if (status === 'completed') return CheckCircle2
  if (status === 'failed') return XCircle
  if (status === 'running') return LoaderCircle
  if (status === 'requires_action') return ShieldAlert
  return Wrench
}

function toolInlinePreview(tool: AssistantToolCallCard): string | null {
  if (tool.status === 'failed') return 'Action could not finish.'
  if (tool.status === 'completed') return 'Action finished.'
  if (tool.status === 'requires_action') return 'Review before continuing.'
  if (tool.status === 'running') return 'Action is running.'
  return 'Action requested.'
}

function toolTitleCopy(tool: AssistantToolCallCard): string {
  if (tool.status === 'requires_action') return 'Action needs approval'
  if (tool.status === 'completed') return 'Action finished'
  if (tool.status === 'failed') return 'Action needs attention'
  if (tool.status === 'running') return 'Action in progress'
  return 'Assistant action'
}

function toolReviewCopy(tool: AssistantToolCallCard): string {
  if (tool.status === 'requires_action') return 'Review required'
  if (tool.status === 'failed') return 'Needs attention'
  if (tool.riskClass === 'low') return 'Standard review'
  return 'Reviewed by Aurora'
}

function toolDestinationCopy(tool: AssistantToolCallCard): string {
  return tool.dataLeavesDevice ? 'Approved destination' : 'This device'
}

function toolSummaryCopy(tool: AssistantToolCallCard): string {
  if (tool.status === 'requires_action') return 'Aurora paused this action until you approve or deny it.'
  if (tool.status === 'failed') return 'Aurora could not finish this action.'
  if (tool.status === 'completed') return 'Aurora finished this action.'
  if (tool.status === 'running') return 'Aurora is working on this action.'
  return 'Aurora requested this action.'
}

function toolErrorCopy(_tool: AssistantToolCallCard): string {
  return 'Review the conversation or account history for details.'
}

function compactToolPreviewValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = formatToolPreviewValue(value)
  return text === '-' ? null : text
}

function formatToolPreviewValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return '-'
  if (Array.isArray(value)) {
    const compact = value.map((item) => formatToolPreviewValue(item)).join(', ')
    return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const preferred = ['query', 'text', 'value', 'description', 'title', 'name']
      .map((key) => record[key])
      .find((candidate) => typeof candidate === 'string' && candidate.trim())
    if (typeof preferred === 'string') return preferred
    try {
      const serialized = JSON.stringify(value)
      return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized
    } catch {
      return '[object]'
    }
  }
  return String(value)
}

function toolStatusFromUpdate(update: AssistantStreamUpdate): AssistantToolCallCard['status'] {
  const structuredStatus = update.tool?.status?.toLowerCase()
  if (structuredStatus === 'requested' || structuredStatus === 'running' || structuredStatus === 'completed' || structuredStatus === 'failed' || structuredStatus === 'requires_action') return structuredStatus
  const value = metadataStringValue(update.metadata ?? {}, 'status')?.toLowerCase()
  if (value === 'requested' || value === 'requires_action') return value
  if (value === 'running' || value === 'completed' || value === 'failed') return value
  if (update.text.toLowerCase().includes('completed')) return 'completed'
  if (update.text.toLowerCase().includes('failed')) return 'failed'
  return 'requested'
}

function metadataStringValue(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function metadataBooleanValue(metadata: Record<string, unknown>, key: string): boolean | null {
  const value = metadata[key]
  return typeof value === 'boolean' ? value : null
}

function metadataNumberValue(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metadataObjectValue(metadata: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = metadata[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function isAssistantUiMessage(value: unknown): value is AssistantUiMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Partial<AssistantUiMessage>
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant' || message.role === 'system' || message.role === 'tool') &&
    typeof message.text === 'string' &&
    typeof message.createdAt === 'string' &&
    (message.toolCalls === undefined || (Array.isArray(message.toolCalls) && message.toolCalls.every(isAssistantToolCallCard))) &&
    (message.sources === undefined || (Array.isArray(message.sources) && message.sources.every((source) => typeof source === 'string'))) &&
    (message.status === 'sent' ||
      message.status === 'sending' ||
      message.status === 'streaming' ||
      message.status === 'failed' ||
      message.status === 'cancelled')
  )
}
