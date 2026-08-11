'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CheckCircle2, ChevronDown, Copy, Cpu, FileText, History, Image as ImageIcon, Laptop, LoaderCircle, MessageSquarePlus, Mic, Network, Paperclip, Radio, RotateCcw, Route as RouteIcon, ArrowUp, ShieldAlert, StopCircle, Volume2, WifiOff, Wrench, XCircle, X } from 'lucide-react'
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
  AuthSessionSnapshot,
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
import type { LightweightConfirmationEvent, LightweightOrchestrator } from '@aurora/client/lightweight-orchestrator'
import {
  buildEnvelopeAad,
  createLocalConversations,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EnvelopeCryptoPort,
  type LocalConversationSummary,
  type LocalDataScope,
  type LocalDataSession,
} from '@aurora/client/local-data'
import {
  createAuroraBrowserVoiceRuntime,
} from '@aurora/voice-web/browser'
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
import { Badge } from '#components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#components/ui/sheet'
import { EvidenceBadge, StatusBadge } from './status-badges'
import { AURORA_RELEASE_FOCUSED_MEDIA_EVENT, getAuroraSurfaceProfile } from './platform-surface'
import type { AuroraSurfaceProfile } from './platform-surface'
import type { NativeDesktopVoicePhase, NativeDesktopVoicePort, NativeDesktopVoiceStatus, NativeDesktopVoiceStopReason } from './native-desktop-voice'
import type { NativeMobileVoicePort } from './native-mobile-voice'
import {
  createLightweightAssistantOrchestrator,
  isLightweightLocalAssistantAvailable,
  type LightweightAssistantDependencies,
} from './local-assistant/lightweight-assistant'


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
  executionHost?: 'this-device' | 'connected-device'
  localAssistant?: LightweightAssistantDependencies | null | undefined
  surfaceProfile?: AuroraSurfaceProfile | undefined
  nativeVoice?: NativeDesktopVoicePort | null | undefined
  nativeMobileVoice?: NativeMobileVoicePort | null | undefined
}

export interface AssistantRuntimeHealth {
  selectedModel: string | null
  routeLabel: string
  sidecarHealth: string
  gatewayHealth: string
}

function assistantAuthScope(auth: AuthSessionSnapshot): string {
  return `${auth.state}:${auth.principalId ?? ''}:${[...auth.effectivePermissions].sort().join(',')}`
}

export interface AssistantExecutionOption {
  id: string
  mode: 'local' | 'dispatch'
  runner: 'aurora-route' | 'lightweight-local'
  label: string
  description: string
  routePolicy: AssistantRoutePolicy
  executionPeerId: string | null
  transportHost: boolean
  modelCatalogHost: 'mixed' | 'this-device' | 'connected-device'
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
  localConfirmationToken?: string | null | undefined
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

interface AssistantConversationRow {
  id: string
  title: string
  route: string
  updated: string
  active: boolean
}

interface LocalAssistantHistoryDependencies {
  localData: LocalDataSession
  envelopeCrypto: EnvelopeCryptoPort
  scope: LocalDataScope
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
  transcriptionRoute: RouteAvailability
  speechRoute: RouteAvailability
  waveformBars: number[]
}

interface StreamedTtsAudioPlayback {
  readonly audio: HTMLAudioElement
  readonly url: string
  released: boolean
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
type AuroraBrowserVoiceRuntimeInstance = ReturnType<typeof createAuroraBrowserVoiceRuntime>
type AuroraBrowserCapturedAudio = Awaited<ReturnType<AuroraBrowserVoiceRuntimeInstance['stop']>>
type BrowserVoiceTurnSettlementOutcome = 'complete' | 'abandon' | 'cancel'
interface BrowserVoiceRuntimeEventSnapshot {
  readonly kind: string
  readonly sessionId: string | null
  readonly generation: number
  readonly sequence: number | null
  readonly sampleCount: number
  readonly byteLength: number
  readonly queuedBytes: number
  readonly reason: string | null
  readonly redacted: true
  readonly occurredAtMs: number
}
interface BrowserVoiceTurnSettlement {
  token: number
  state: 'open' | 'settling' | 'settled'
  outcome: BrowserVoiceTurnSettlementOutcome | null
  promise: Promise<boolean> | null
}

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
  runtimeHealth,
  executionHost = 'this-device',
  localAssistant = null,
  surfaceProfile: providedSurfaceProfile,
  nativeVoice = null,
  nativeMobileVoice = null
}: AssistantViewProps) {
  const [session, setSession] = useState<AssistantSessionSnapshot>(() => initialSession ?? defaultAssistantSessionForTransport(client.transport.kind))
  const [sessionIndex, setSessionIndex] = useState<DBSessionRecord[]>([])
  const [localConversationRows, setLocalConversationRows] = useState<AssistantConversationRow[]>([])
  const [sessionIndexLoading, setSessionIndexLoading] = useState(false)
  const [sessionIndexError, setSessionIndexError] = useState<string | null>(null)
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false)
  const [sessionAuthScope, setSessionAuthScope] = useState(() => {
    const auth = client.auth.snapshot()
    return assistantAuthScope(auth)
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
  const [voiceConsentGranted, setVoiceConsentGrantedState] = useState(false)
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
  const activeVoiceSessionRef = useRef<string | null>(null)
  const ownedVoiceSessionIdsRef = useRef<Set<string>>(new Set())
  const coordinatorVoiceSessionIdsRef = useRef<Set<string>>(new Set())
  const voiceSessionStartedAtRef = useRef<number | null>(null)
  const appliedVoiceEventIdsRef = useRef<Set<string>>(new Set())
  const voiceCaptureStatusRef = useRef<VoiceCaptureStatus>('idle')
  const voicePendingAssistantIdRef = useRef<string | null>(null)
  const voiceTranscriptPreviewRef = useRef('')
  const voiceConsentGrantedRef = useRef(false)
  const voiceConsentRouteKeyRef = useRef<string | null>(null)
  const browserVoiceRuntimeRef = useRef<AuroraBrowserVoiceRuntimeInstance | null>(null)
  const browserVoiceRuntimeEventUnsubscribeRef = useRef<(() => void) | null>(null)
  const browserVoiceOperationTokenRef = useRef(0)
  const browserVoiceTurnSettlementRef = useRef<BrowserVoiceTurnSettlement | null>(null)
  const nativeVoiceStatusRef = useRef<NativeDesktopVoiceStatus | null>(null)
  const nativeVoiceGenerationRef = useRef<number | null>(null)
  const nativeVoiceOperationTokenRef = useRef(0)
  const nativeVoicePendingCancelReasonRef = useRef<NativeDesktopVoiceStopReason | null>(null)
  const nativeVoiceCancelledGenerationsRef = useRef<Set<number>>(new Set())
  const nativeMobileVoiceOperationTokenRef = useRef(0)
  const nativeMobileVoiceStartInFlightRef = useRef(false)
  const assistantViewDisposedRef = useRef(false)
  const sessionLoadGenerationRef = useRef(0)
  function setVoiceCaptureStatus(next: VoiceCaptureStatus) {
    voiceCaptureStatusRef.current = next
    setVoiceCaptureStatusState(next)
  }
  const voiceToggleInFlightRef = useRef(false)
  const voiceResponseTimeoutRef = useRef<number | null>(null)
  const readAloudFallbackTokenRef = useRef(0)
  const [speakingMessageIdState, setSpeakingMessageIdState] = useState<string | null>(null)
  const speakingMessageIdRef = useRef<string | null>(null)
  const lastAssistantMessageIdRef = useRef<string | null>(null)
  const streamedTtsQueueRef = useRef<string[]>([])
  const streamedTtsAudioRef = useRef<StreamedTtsAudioPlayback | null>(null)
  function setSpeakingMessageId(next: string | null) {
    speakingMessageIdRef.current = next
    setSpeakingMessageIdState(next)
  }
  const activePendingIdRef = useRef<string | null>(null)
  const cancelledPendingIdsRef = useRef<Set<string>>(new Set())
  const localConfirmationOrchestratorsRef = useRef<Map<string, LightweightOrchestrator>>(new Map())
  const localAssistantAvailable = localAssistant !== null && isLightweightLocalAssistantAvailable(localAssistant)
  const localOrchestrator = useMemo(
    () => localAssistant === null ? null : createLightweightAssistantOrchestrator(localAssistant),
    [localAssistant]
  )
  const localHistory = useMemo(
    () => resolveLocalAssistantHistoryDependencies(localAssistant, executionHost),
    [
      executionHost,
      localAssistant?.localData,
      localAssistant?.envelopeCrypto,
      localAssistant?.scope?.localNodeId,
      localAssistant?.scope?.profileId,
    ]
  )
  const executionOptions = useMemo(
    () => assistantExecutionOptions(route, { executionHost, localExecutionAvailable: localAssistantAvailable }),
    [executionHost, localAssistantAvailable, route]
  )
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
        if (option.mode === 'dispatch' && option.executionPeerId) {
          labels.set(option.executionPeerId, option.label)
        }
      }
      return labels
    },
    [executionOptions, route.candidateProviders]
  )
  const selectedExecution = executionOptions.find((option) => option.id === executionOptionId) ?? executionOptions[0]!
  const localExecutionMessageLabel = 'Local'
  const routePolicy = selectedExecution.routePolicy
  const activeModelCatalog = selectedExecution.mode === 'local' || selectedExecution.transportHost
    ? localModelCatalog
    : dispatchModelCatalog
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
  const usesLocalConversationHistory = localHistory !== null
  const supportsPersistedSessions = !usesLocalConversationHistory
    && client.transport.kind !== 'mock'
    && client.transport.kind !== 'mesh'
  const conversationRows = usesLocalConversationHistory
    ? localConversationRows.map((row) => ({ ...row, active: row.id === session.sessionId }))
    : assistantConversationRows(session, sessionIndex, client.transport.kind)
  const sessionMessages = session.messages
  const isSending = sessionMessages.some((message) => message.status === 'sending')
  const isStreaming = sessionMessages.some((message) => message.status === 'streaming')
  const hasContextUpload = attachments.some((attachment) => attachment.status === 'uploading')
  const controls = selectedExecution.runner === 'lightweight-local'
    ? {
        canSend: localOrchestrator !== null && !isSending && !isStreaming && !hasContextUpload,
        canCancel: isSending || isStreaming,
        cancelReason: isSending || isStreaming ? 'Stop is available for this response.' : 'no active response'
      }
    : assistantControlsForRoute(route, cancellationRoute, isSending || isStreaming || hasContextUpload)
  const canSend = controls.canSend && (!supportsPersistedSessions || Boolean(session.sessionId)) && !sessionIndexLoading
  const canAttach = controls.canSend && !isSending && !isStreaming && !hasContextUpload
  const attachmentsAwaitingValidation = attachments.filter((attachment) =>
    attachment.status === 'staged' || attachment.status === 'error'
  )
  const assistantBusy = Boolean(activeAssistantPendingId) || isSending || sessionMessages.some(isAssistantPendingWork)
  const voiceBusy = voiceCaptureStatus === 'processing' || Boolean(voiceResponsePendingId)
  const retryableFailure = Boolean(lastPrompt) && (
    streamState.status === 'lost' ||
    streamState.status === 'fallback' ||
    streamState.status === 'cancelled' ||
    voiceCaptureStatus === 'error' ||
    sessionMessages.some((message) => message.status === 'failed')
  )
  const hasFreshPrompt = text.trim().length > 0
  const primaryComposerAction: 'send' | 'stop' | 'retry' = retryableFailure && !hasFreshPrompt
    ? 'retry'
    : assistantBusy || voiceBusy
      ? 'stop'
      : 'send'
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
    () => ({
      ...buildAssistantRuntimeStrip(runtimeHealth, modelLabel, route, client.transport.kind),
      selectedModel: safeAssistantRuntimeValue(selectedModelChoice.model.name, modelLabel),
      routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label
    }),
    [client.transport.kind, localExecutionMessageLabel, modelLabel, route, runtimeHealth, selectedExecution, selectedModelChoice.model.name]
  )
  const surfaceProfile = useMemo(() => providedSurfaceProfile ?? getAuroraSurfaceProfile({
    runtimeMode: client.transport.kind === 'tauri-local' ? 'desktop-local' : client.transport.kind === 'native-mobile' ? 'mobile' : undefined,
    transportKind: client.transport.kind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent
  }), [client.transport.kind, nativePlatform, providedSurfaceProfile])
  const usesNativeDesktopVoice = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop'
  const usesNativeMobileVoice = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'mobile-native'
  const usesFocusedBrowserVoiceRuntime = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'webview-focused'
  const receivesCoordinatorVoiceEvents = surfaceProfile.voiceCapture.wakewordOwner === 'coordinator-daemon'
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
      surfaceProfile,
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
      surfaceProfile,
      voiceCaptureStatus,
      voiceConsentGranted,
      voiceEvents,
      voiceWaveformBars
    ]
  )
  const voiceConsentRouteKey = useMemo(
    () => remoteAudioConsentRouteKey(voiceModel.remoteAudioRoute),
    [voiceModel.remoteAudioRoute]
  )
  const connectedVoiceAccessGranted = voiceConsentGranted && voiceConsentRouteKeyRef.current === voiceConsentRouteKey

  useEffect(() => {
    if (!voiceConsentGranted) return
    if (voiceConsentRouteKeyRef.current === voiceConsentRouteKey) return
    setRemoteAudioConsent(false)
  }, [voiceConsentGranted, voiceConsentRouteKey])

  function setRemoteAudioConsent(granted: boolean) {
    voiceConsentGrantedRef.current = granted
    voiceConsentRouteKeyRef.current = granted ? voiceConsentRouteKey : null
    setVoiceConsentGrantedState(granted)
  }

  function remoteAudioConsentForCurrentRoute(route = voiceModel.remoteAudioRoute): boolean | null {
    if (!requiresRemoteAudioConsent(route)) return false
    if (
      voiceConsentGrantedRef.current &&
      voiceConsentRouteKeyRef.current === remoteAudioConsentRouteKey(route)
    ) return true
    const message = 'Review connected voice access before starting speech.'
    setLastError(message)
    setVoiceCaptureStatus('idle')
    setStreamState((current) => ({ ...current, status: 'lost', message }))
    return null
  }

  function defaultVoiceRoutePolicy(route: RouteAvailability): AssistantRoutePolicy | null {
    const routePolicy = routePolicyFromRoute(route)
    if (
      route.selectorRequired
      && !routePolicy.providerId
      && !routePolicy.peerId
      && !routePolicy.serviceInstanceId
    ) {
      const message = 'Choose a connected voice device before starting speech.'
      setLastError(message)
      setVoiceCaptureStatus('idle')
      setStreamState((current) => ({ ...current, status: 'lost', message }))
      return null
    }
    return routePolicy
  }

  async function toggleRemoteAudioConsent() {
    if (voiceConsentGrantedRef.current && voiceConsentRouteKeyRef.current === voiceConsentRouteKey) {
      await stopActiveRemoteAudioForConsentRevoke()
      setRemoteAudioConsent(false)
      return
    }
    setLastError(null)
    setRemoteAudioConsent(true)
  }

  async function stopActiveRemoteAudioForConsentRevoke() {
    if (!requiresRemoteAudioConsent(voiceModel.remoteAudioRoute)) return
    if (!['listening', 'processing', 'speaking'].includes(voiceCaptureStatusRef.current)) return
    if (usesNativeDesktopVoice) {
      await cancelNativeDesktopVoice('user_request')
    } else if (usesNativeMobileVoice) {
      await cancelNativeMobileVoice()
    } else if (usesFocusedBrowserVoiceRuntime) {
      await cancelBrowserVoiceCaptureForReason('consent_revoked')
    } else {
      const sessionId = activeVoiceSessionRef.current
      if (sessionId && coordinatorVoiceSessionIdsRef.current.has(sessionId)) {
        const stopped = await client.assistant.stopVoiceListen({
          sessionId,
          reason: 'user_request',
          routePolicy: routePolicyFromRoute(voiceModel.transcriptionRoute)
        })
        if (!stopped.ok) setLastError(productAssistantErrorCopy(stopped.error))
      }
    }
    setVoiceCaptureStatus('idle')
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
  }

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
    if (!chunk.audioData) return
    enqueueTtsAudio(chunk.audioData, chunk.encoding ?? 'wav', chunk.mimeType)
  }

  function enqueueTtsAudio(audioData: string, encoding: string, explicitMimeType?: string | null): boolean {
    if (typeof window === 'undefined' || typeof window.URL?.createObjectURL !== 'function') return false
    const bytes = base64ToUint8Array(audioData)
    if (bytes.byteLength === 0) return false
    const normalizedEncoding = encoding.toLowerCase()
    const mimeType = explicitMimeType ?? (normalizedEncoding === 'raw' ? 'audio/wav' : `audio/${normalizedEncoding}`)
    const url = window.URL.createObjectURL(new Blob([bytes], { type: mimeType }))
    streamedTtsQueueRef.current.push(url)
    void drainStreamedTtsAudioQueue()
    return true
  }

  async function drainStreamedTtsAudioQueue() {
    if (streamedTtsAudioRef.current) return
    const nextUrl = streamedTtsQueueRef.current.shift()
    if (!nextUrl || typeof Audio === 'undefined') {
      if (!nextUrl) setSpeakingMessageId(null)
      return
    }
    const audio = new Audio(nextUrl)
    const playback: StreamedTtsAudioPlayback = { audio, url: nextUrl, released: false }
    streamedTtsAudioRef.current = playback
    const cleanup = () => {
      if (playback.released) return
      playback.released = true
      if (streamedTtsAudioRef.current === playback) streamedTtsAudioRef.current = null
      window.URL.revokeObjectURL(playback.url)
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
    const activePlayback = streamedTtsAudioRef.current
    streamedTtsAudioRef.current = null
    if (activePlayback && !activePlayback.released) {
      activePlayback.released = true
      activePlayback.audio.onended = null
      activePlayback.audio.onerror = null
      activePlayback.audio.pause()
      activePlayback.audio.removeAttribute('src')
      activePlayback.audio.load()
      window.URL.revokeObjectURL(activePlayback.url)
    }
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

  async function initializeLocalSessions(
    generation: number,
    history: LocalAssistantHistoryDependencies,
  ) {
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const rows = await loadLocalAssistantConversationRows(history)
      if (sessionLoadGenerationRef.current !== generation) return
      setLocalConversationRows(rows)
      const activeSessionId = session.sessionId && rows.some((row) => row.id === session.sessionId)
        ? session.sessionId
        : rows[0]?.id ?? null
      if (activeSessionId) {
        const messages = await loadLocalAssistantConversationMessages(history, activeSessionId)
        if (sessionLoadGenerationRef.current !== generation) return
        setSession({ sessionId: activeSessionId, messages })
      } else {
        setSession(emptyAssistantSession())
      }
    } catch {
      if (sessionLoadGenerationRef.current !== generation) return
      setLocalConversationRows([])
      setSession(emptyAssistantSession())
      setSessionIndexError('Saved chats could not be opened. Your data was not changed.')
    } finally {
      if (sessionLoadGenerationRef.current === generation) {
        setSessionIndexLoading(false)
      }
    }
  }

  useEffect(() => {
    return client.auth.subscribe((auth) => {
      const nextScope = assistantAuthScope(auth)
      if (sessionAuthScopeRef.current === nextScope) return
      sessionAuthScopeRef.current = nextScope
      if (supportsPersistedSessions || usesLocalConversationHistory) {
        sessionLoadGenerationRef.current += 1
        resetConversationUi(emptyAssistantSession())
        setSessionIndex([])
        setLocalConversationRows([])
        setSessionIndexError(null)
        setSessionIndexLoading(true)
      }
      setSessionAuthScope(nextScope)
    })
  }, [client, supportsPersistedSessions, usesLocalConversationHistory])

  useEffect(() => {
    if (usesLocalConversationHistory && localHistory) {
      const generation = sessionLoadGenerationRef.current + 1
      sessionLoadGenerationRef.current = generation
      setSessionIndex([])
      setLocalConversationRows([])
      void initializeLocalSessions(generation, localHistory)
      return
    }
    if (client.transport.kind === 'mock') {
      const stored = loadAssistantSession(storageKey)
      const nextSession = initialSession ?? (stored.sessionId || stored.messages.length > 0 ? stored : defaultAssistantSessionForTransport(client.transport.kind))
      setSession(nextSession)
      setSessionIndex([])
      setLocalConversationRows([])
      setSessionIndexLoading(false)
      setSessionIndexError(null)
      return
    }
    if (!supportsPersistedSessions) {
      setSession(emptyAssistantSession())
      setSessionIndex([])
      setLocalConversationRows([])
      setSessionIndexLoading(false)
      setSessionIndexError('Saved chats are unavailable for this connection.')
      return
    }

    const generation = sessionLoadGenerationRef.current + 1
    sessionLoadGenerationRef.current = generation
    setSession(emptyAssistantSession())
    setSessionIndex([])
    setLocalConversationRows([])
    void initializePersistedSessions(generation)
  }, [client, client.transport.kind, initialSession, localHistory, sessionAuthScope, storageKey, supportsPersistedSessions, usesLocalConversationHistory])

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
    assistantViewDisposedRef.current = true
    abortRef.current?.abort()
    for (const orchestrator of localConfirmationOrchestratorsRef.current.values()) orchestrator.cancel()
    localConfirmationOrchestratorsRef.current.clear()
    clearVoiceResponseTimeout()
    stopStreamedTtsPlayback()
    void cancelNativeDesktopVoice('shutdown')
    nativeMobileVoiceOperationTokenRef.current += 1
    if (nativeMobileVoiceStartInFlightRef.current || voiceCaptureStatusRef.current === 'listening' || voiceCaptureStatusRef.current === 'processing') {
      void cancelNativeMobileVoice({ updateUi: false })
    }
    const token = browserVoiceOperationTokenRef.current
    browserVoiceOperationTokenRef.current += 1
    void (async () => {
      const settled = await settleBrowserVoiceTurn(token, 'cancel', 'disposed')
      if (!settled.claimed && browserVoiceTurnSettlementRef.current?.token === token) {
        await waitForBrowserVoiceTurnSettlement(token)
      }
      await disposeBrowserVoiceRuntime()
    })()
  }, [])

  useEffect(() => {
    let active = true
    setModelCatalogLoading(true)
    setModelCatalogError(null)
    void (async () => {
      const catalog = await client.models.listCatalog({
        include_unavailable: true,
        include_operations: false,
        includeRemote: true
      })
      const remoteCatalogs = await Promise.all(
        executionOptions
          .filter((option) => option.mode === 'dispatch' && !option.transportHost)
          .map(async (execution) => {
            try {
              const remoteCatalog = await client.models.listCatalog({
                include_unavailable: true,
                include_operations: false,
                includeRemote: true,
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
        if (provider?.model_id) setModelLabel('Configured default')
        if (provider) setRuntimeProviderLabel('Selected model source')
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
    if (selectedExecution.mode !== 'dispatch' || selectedExecution.transportHost) {
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
    if (!usesNativeDesktopVoice) return
    let active = true
    let unsubscribe: (() => void) | null = null
    if (!nativeVoice) {
      nativeVoiceStatusRef.current = null
      nativeVoiceGenerationRef.current = null
      setVoiceCaptureStatus('no-device')
      setLastError('Voice is unavailable in this desktop app.')
      return
    }
    void (async () => {
      try {
        const status = await nativeVoice.status()
        if (!active) return
        if (!maybeCancelDeferredNativeDesktopVoiceStatus(status)) {
          applyNativeDesktopVoiceStatus(status)
        }
        const nextUnsubscribe = await nativeVoice.subscribe((event) => {
          if (!active) return
          if (maybeCancelDeferredNativeDesktopVoiceStatus(event.status)) return
          applyNativeDesktopVoiceStatus(event.status)
        })
        if (!active) {
          nextUnsubscribe()
          return
        }
        unsubscribe = nextUnsubscribe
      } catch {
        if (!active) return
        nativeVoiceStatusRef.current = null
        nativeVoiceGenerationRef.current = null
        setVoiceCaptureStatus('error')
        setLastError('Voice could not start. Check this device and try again.')
      }
    })()
    return () => {
      active = false
      if (unsubscribe) unsubscribe()
    }
  }, [nativeVoice, usesNativeDesktopVoice])

  useEffect(() => {
    if (!usesNativeMobileVoice || !nativeMobileVoice) return
    let active = true
    void nativeMobileVoice.status().then((status) => {
      if (!active) return
      if (!status.available) {
        setVoiceCaptureStatus('no-device')
      } else if (status.phase === 'faulted') {
        setVoiceCaptureStatus('error')
      } else if (status.captureActive) {
        setVoiceCaptureStatus('listening')
      }
    }).catch(() => {
      if (active) setVoiceCaptureStatus('error')
    })
    return () => {
      active = false
    }
  }, [nativeMobileVoice, usesNativeMobileVoice])

  useEffect(() => {
    if (!surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk) return
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    const releaseFocusedCapture = (event?: Event) => {
      const hidden = document.visibilityState === 'hidden'
      const blurred = typeof document.hasFocus === 'function' && !document.hasFocus()
      const nativeRelease = event?.type === AURORA_RELEASE_FOCUSED_MEDIA_EVENT
      if (!hidden && !blurred && !nativeRelease) return
      if (usesNativeDesktopVoice) {
        requestNativeDesktopVoiceCancel('window_hidden')
        return
      }
      if (usesNativeMobileVoice) {
        void cancelNativeMobileVoice()
        return
      }
      if (!browserVoiceRuntimeRef.current) return
      releaseBrowserVoiceCaptureForLifecycle()
    }
    document.addEventListener('visibilitychange', releaseFocusedCapture)
    window.addEventListener('blur', releaseFocusedCapture)
    window.addEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedCapture)
    return () => {
      document.removeEventListener('visibilitychange', releaseFocusedCapture)
      window.removeEventListener('blur', releaseFocusedCapture)
      window.removeEventListener(AURORA_RELEASE_FOCUSED_MEDIA_EVENT, releaseFocusedCapture)
    }
  }, [surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk, usesNativeDesktopVoice, usesNativeMobileVoice])

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
    if (!receivesCoordinatorVoiceEvents) return
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
  }, [client, receivesCoordinatorVoiceEvents, sessionAuthScope])

  useEffect(() => {
    if (!receivesCoordinatorVoiceEvents) return
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
  }, [client, receivesCoordinatorVoiceEvents, sessionAuthScope])

  function resetConversationUi(nextSession: AssistantSessionSnapshot) {
    abortRef.current?.abort()
    releaseBrowserVoiceCaptureForReason('conversation_reset')
    activeVoiceSessionRef.current = null
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
    setVoiceCaptureStatus('idle')
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

  async function openLocalSession(sessionId: string) {
    if (!localHistory) return
    setSessionIndexLoading(true)
    setSessionIndexError(null)
    try {
      const messages = await loadLocalAssistantConversationMessages(localHistory, sessionId)
      resetConversationUi({ sessionId, messages })
      setMobileHistoryOpen(false)
      window.setTimeout(() => textAreaRef.current?.focus(), 0)
    } catch {
      setSessionIndexError('This chat could not be opened. Your saved data was not changed.')
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

  async function refreshLocalSessionIndex() {
    if (!localHistory) return
    try {
      setLocalConversationRows(await loadLocalAssistantConversationRows(localHistory))
      setSessionIndexError(null)
    } catch {
      setSessionIndexError('Saved chats could not be refreshed. Your data was not changed.')
    }
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

  async function startAssistantTurn(prompt: string, replayFrom: string | null = null): Promise<boolean> {
    const now = new Date().toISOString()
    const requestId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    let turnSessionId = usesLocalConversationHistory || supportsPersistedSessions
      ? session.sessionId
      : null
    if (!turnSessionId && supportsPersistedSessions) {
      const created = await createPersistedChatSession()
      if (!created) return false
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
      text: replayFrom ? 'Restoring Aurora’s response...' : 'Waiting for Aurora...',
      createdAt: now,
      status: 'streaming',
      modelLabel: selectedModelChoice.model.name,
      providerLabel: selectedModelChoice.provider ? 'Selected model source' : runtimeProviderLabel ?? route.providerLabel,
      routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
      executionPeerId: selectedExecution.executionPeerId
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
    let turnSucceeded = false
    let completedRemoteUpdate: AssistantStreamUpdate | null = null
    let remoteToolEventSequence = 0
    try {
      if (selectedExecution.runner === 'lightweight-local') {
        if (!localOrchestrator) throw new Error('On-device assistant is unavailable.')
        const result = await localOrchestrator.runTurn({
          text: prompt,
          conversationId: turnSessionId,
          providerId: inferencePolicy?.runtimeProviderId ?? inferencePolicy?.providerId ?? null,
          modelId: inferencePolicy?.modelId ?? null,
          signal: abort.signal
        })
        terminalSeen = true
        turnSucceeded = result.status !== 'cancelled'
        await applyLightweightAssistantResult(result, pendingMessage.id, localOrchestrator)
      } else {
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
          if (update.kind === 'tool' && localHistory) {
            const toolRecordId = `${requestId}-connected-tool-${remoteToolEventSequence}`
            remoteToolEventSequence += 1
            try {
              await persistConnectedAssistantTurnToLocalHistory(localHistory, {
                conversationId: turnSessionId,
                requestId,
                prompt,
                response: null,
                runtime: null,
                toolEvents: [{
                  recordId: toolRecordId,
                  card: assistantToolCallFromUpdate(update),
                  createdAtMs: Date.now(),
                }],
                createdAtMs: Date.parse(now),
              })
            } catch {
              setSessionIndexError('This activity could not be saved on this device.')
            }
          }
          if (update.kind === 'completed' || update.kind === 'fallback') {
            completedRemoteUpdate = update
            turnSucceeded = true
          }
          if (update.kind === 'completed') {
            terminalSeen = true
            continue
          }
          if (isAssistantStreamHardTerminal(update)) {
            terminalSeen = true
            break
          }
        }
        if (completedRemoteUpdate && localHistory) {
          try {
            await persistConnectedAssistantTurnToLocalHistory(localHistory, {
              conversationId: turnSessionId,
              requestId,
              prompt,
              response: completedRemoteUpdate.text,
              runtime: {
                routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
                executionPeerId: selectedExecution.executionPeerId,
                modelLabel: completedRemoteUpdate.modelLabel ?? selectedModelChoice.model.name,
                providerLabel: metadataStringValue(completedRemoteUpdate.metadata, 'provider_label')
                  ?? metadataStringValue(completedRemoteUpdate.metadata, 'provider')
                  ?? selectedModelChoice.provider?.display_name
                  ?? runtimeProviderLabel
                  ?? null,
              },
              toolEvents: [],
              createdAtMs: Date.parse(now),
            })
          } catch {
            setSessionIndexError('This reply could not be saved on this device.')
          }
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
      if (usesLocalConversationHistory) {
        void refreshLocalSessionIndex()
      } else {
        void refreshPersistedSessionIndex()
      }
    }
    return turnSucceeded && !abort.signal.aborted && !cancelledPendingIdsRef.current.has(pendingMessage.id)
  }

  async function applyLightweightAssistantResult(
    result: Awaited<ReturnType<LightweightOrchestrator['runTurn']>>,
    pendingId: string,
    orchestrator: LightweightOrchestrator
  ): Promise<void> {
    if (result.status === 'awaiting_confirmation' && result.confirmation) {
      const confirmation = result.confirmation
      localConfirmationOrchestratorsRef.current.set(confirmation.token, orchestrator)
      setSession((current) => ({
        sessionId: result.conversationId,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? {
                ...message,
                text: result.assistantText.trim() || 'Aurora needs your approval before continuing.',
                status: 'sent',
                toolCalls: [lightweightConfirmationToolCard(confirmation)],
                routeLabel: localExecutionMessageLabel,
                executionPeerId: null
              }
            : message
        )
      }))
      setStreamState({ status: 'idle', lastEventId: null, message: 'Aurora needs your approval before continuing.' })
      return
    }
    if (result.status === 'cancelled') {
      setSession((current) => ({
        sessionId: result.conversationId,
        messages: current.messages.map((message) =>
          message.id === pendingId
            ? { ...message, text: 'Stopped by user.', status: 'cancelled' }
            : message
        )
      }))
      setStreamState({ status: 'cancelled', lastEventId: null, message: 'Aurora stopped responding.' })
      return
    }
    const completedText = result.assistantText.trim()
    const createdAt = new Date().toISOString()
    let persistedMessages: AssistantUiMessage[] | null = null
    if (localHistory) {
      try {
        await persistLatestLocalAssistantRuntime(localHistory, {
          conversationId: result.conversationId,
          response: completedText,
          runtime: {
            routeLabel: localExecutionMessageLabel,
            executionPeerId: null,
            modelLabel: selectedModelChoice.model.name,
            providerLabel: selectedModelChoice.provider?.display_name ?? 'Selected model source',
          },
        })
        persistedMessages = await loadLocalAssistantConversationMessages(localHistory, result.conversationId)
      } catch {
        persistedMessages = null
      }
    }
    setLastResult({ id: pendingId, role: 'assistant', text: completedText, createdAt })
    setModelLabel(selectedModelChoice.model.name)
    setSession((current) => {
      const enrichedPersistedMessages = persistedMessages
        ? enrichLatestLocalAssistantMessage(persistedMessages, {
            text: completedText,
            modelLabel: selectedModelChoice.model.name,
            providerLabel: selectedModelChoice.provider?.display_name ?? 'Selected model source',
            routeLabel: localExecutionMessageLabel,
          })
        : null
      return {
        sessionId: result.conversationId,
        messages: enrichedPersistedMessages
          ? preserveActiveAssistantTurnIds(enrichedPersistedMessages, current.messages, pendingId)
          : current.messages.map((message) =>
              message.id === pendingId
                ? {
                    ...message,
                    text: completedText,
                    createdAt,
                    status: 'sent',
                    modelLabel: selectedModelChoice.model.name,
                    providerLabel: selectedModelChoice.provider?.display_name ?? 'Selected model source',
                    routeLabel: localExecutionMessageLabel,
                    executionPeerId: null
                  }
                : message
            )
      }
    })
    setStreamState({ status: 'idle', lastEventId: null, message: 'Aurora finished responding.' })
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
              text: message.text.trim() && message.text !== 'Waiting for Aurora...' ? message.text : failureCopy,
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
                ...message,
                text: result.data.response.text,
                createdAt: result.data.response.createdAt,
                status: 'sent',
                modelLabel: result.data.modelLabel,
                providerLabel,
                routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
                executionPeerId: selectedExecution.executionPeerId
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
        sessionId: usesLocalConversationHistory ? current.sessionId : update.sessionId ?? current.sessionId,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantToolUpdate(message, update) : message
        )
      }))
      setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora needs your approval before continuing.' }))
      return
    }
    if (update.kind === 'tts_audio_chunk') {
      const hasPlayableAudio = update.ttsAudio?.final !== true && Boolean(update.ttsAudio?.audioData)
      if (hasPlayableAudio) {
        if (lastAssistantMessageIdRef.current === null) lastAssistantMessageIdRef.current = pendingId
        if (!speakingMessageIdRef.current) setSpeakingMessageId(lastAssistantMessageIdRef.current)
      }
      enqueueStreamedTtsAudio(update)
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.id === pendingId ? applyAssistantAudioChunkUpdate(message, update) : message
        )
      }))
      setStreamState((current) => ({
        ...current,
        status: current.status === 'streaming' ? 'streaming' : current.status,
        message: update.ttsAudio?.final
          ? 'Aurora finished speaking.'
          : hasPlayableAudio
            ? 'Aurora is speaking.'
            : current.message
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
        message: 'Aurora continued with a complete response.'
      }))
    }
    if (update.kind === 'completed' || update.kind === 'fallback') {
      setLastResult({
        id: pendingId,
        role: 'assistant',
        text: update.text,
        createdAt: new Date().toISOString()
      })
        const finalAssistantId = pendingId
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
          routeLabel: selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label,
          executionPeerId: selectedExecution.executionPeerId
        }
        const terminalMessage = applyAssistantTerminalUpdate({
          ...baseMessage,
          modelLabel: update.modelLabel ?? baseMessage.modelLabel,
          providerLabel: metadataStringValue(update.metadata, 'provider_label') ?? metadataStringValue(update.metadata, 'provider') ?? baseMessage.providerLabel,
          routeLabel: baseMessage.routeLabel ?? (selectedExecution.mode === 'local' ? localExecutionMessageLabel : selectedExecution.label),
          executionPeerId: baseMessage.executionPeerId ?? selectedExecution.executionPeerId
        }, update)
        lastAssistantMessageIdRef.current = terminalMessage.id
        const replaced = current.messages.some((message) => message.id === terminalMessage.id)
        return {
          sessionId: usesLocalConversationHistory
            ? current.sessionId ?? session.sessionId
            : update.sessionId ?? current.sessionId ?? session.sessionId,
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
              routeLabel: localExecutionMessageLabel
            }])
          ]
        }
      })
      return
    }
    if (event.kind === 'session_ended') {
      if (!shouldApplyVoiceSessionEndEvent(event, activeVoiceSessionRef.current, voiceCaptureStatusRef.current)) return
      setSpeakingMessageId(null)
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      return
    }
    if (event.kind === 'tts_started') {
      settleVoicePendingFromObservedText(event.text, 'tts_started')
      settleSubstantiveStreamingAssistantMessages('tts_started')
      // TTS playback must not keep the composer or push-to-talk controls in a stop state.
      if (voiceCaptureStatusRef.current !== 'listening') {
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
      const hasPlayableAudio = update.ttsAudio?.final !== true && Boolean(update.ttsAudio?.audioData)
      if (hasPlayableAudio && pendingId && !speakingMessageIdRef.current) setSpeakingMessageId(pendingId)
      enqueueStreamedTtsAudio(update)
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
      setStreamState((current) => ({
        ...current,
        status: 'idle',
        message: update.ttsAudio?.final
          ? 'Aurora finished speaking.'
          : hasPlayableAudio
            ? 'Aurora is speaking.'
            : current.message
      }))
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
      const finalAssistantId = pendingId ?? update.messageId ?? `assistant-voice-${Date.now()}`
      const existing = current.messages.find((message) => message.id === finalAssistantId)
      const assistantMessage = applyAssistantTerminalUpdate({
        id: finalAssistantId,
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString(),
        status: 'streaming',
        modelLabel: update.modelLabel ?? modelLabel,
        providerLabel,
        routeLabel: localExecutionMessageLabel,
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

  function applyNativeDesktopVoiceStatus(status: NativeDesktopVoiceStatus) {
    nativeVoiceStatusRef.current = status
    nativeVoiceGenerationRef.current = status.generation
    setVoiceCaptureStatus(nativeDesktopVoiceCaptureStatus(status.phase))
    if (!status.available || status.phase === 'unavailable') {
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      setSpeakingMessageId(null)
      return
    }
    if (status.generation !== null) {
      const sessionId = `native-desktop-${status.generation}`
      activeVoiceSessionRef.current = sessionId
      ownedVoiceSessionIdsRef.current.add(sessionId)
    }
    if (status.phase === 'idle' || status.phase === 'stopping' || status.phase === 'faulted') {
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      setSpeakingMessageId(null)
    }
    if (status.phase === 'listening') {
      setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora is listening.' }))
    } else if (status.phase === 'processing') {
      setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    } else if (status.phase === 'speaking') {
      setStreamState((current) => ({ ...current, status: 'streaming', message: 'Aurora is speaking.' }))
    } else if (status.phase === 'faulted') {
      setLastError('Voice could not start. Check this device and try again.')
      setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice could not start. Check this device and try again.' }))
    }
  }

  function maybeCancelDeferredNativeDesktopVoiceStatus(status: NativeDesktopVoiceStatus): boolean {
    const reason = nativeVoicePendingCancelReasonRef.current
      ?? (assistantViewDisposedRef.current ? 'shutdown' : null)
    if (reason === null) return false
    if (status.generation !== null && nativeVoice) {
      void cancelNativeDesktopVoiceGeneration(status.generation, reason)
    }
    return true
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
    const routePolicy = defaultVoiceRoutePolicy(voiceModel.speechRoute)
    if (!routePolicy) return
    setLastError(null)
    setSpeakingMessageId(message.id)
    lastAssistantMessageIdRef.current = message.id
    try {
      if (surfaceProfile.usesLocalSidecar) {
        const result = await client.assistant.requestReadAloud({
          text: speakableText,
          interrupt: true,
          routePolicy
        })
        if (!result.ok) throw result.error
        setStreamState((current) => ({ ...current, message: 'Reading assistant response through Aurora TTS.' }))
        return
      }
      const result = await client.assistant.synthesizeReadAloud({
        text: speakableText,
        voice: null,
        speed: 1,
        format: 'wav',
        routePolicy
      })
      if (!result.ok) throw result.error
      if (!enqueueTtsAudio(result.data.audio_data, result.data.format)) {
        throw new Error('This device could not start audio playback.')
      }
      setStreamState((current) => ({ ...current, message: 'Aurora is reading this response on this device.' }))
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
    if (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken) {
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
      if (tool.localConfirmationToken) {
        const orchestrator = localConfirmationOrchestratorsRef.current.get(tool.localConfirmationToken)
        if (!orchestrator) throw new Error('This on-device approval has expired.')
        const result = await orchestrator.resumeConfirmation({
          token: tool.localConfirmationToken,
          decision: approve ? 'approve' : 'deny',
          grantScope
        })
        localConfirmationOrchestratorsRef.current.delete(tool.localConfirmationToken)
        const assistantText = result.assistantText.trim()
        setSession((current) => ({
          sessionId: result.conversationId,
          messages: current.messages.map((message) => {
            if (!message.toolCalls?.some((candidate) => candidate.id === tool.id)) return message
            return {
              ...message,
              text: assistantText || (approve
                ? 'Aurora finished the approved action.'
                : 'Aurora stopped this action because it was denied.'),
              status: 'sent',
              toolCalls: message.toolCalls.map((candidate) =>
                candidate.id === tool.id
                  ? {
                      ...candidate,
                      resolving: false,
                      status: approve && result.status === 'completed' ? 'completed' : 'failed',
                      summary: approve && result.status === 'completed'
                        ? 'Approved and completed on this device.'
                        : 'Denied on this device.',
                      error: approve && result.status === 'completed' ? null : 'approval_denied'
                    }
                  : candidate
              )
            }
          })
        }))
        setStreamState({
          status: 'idle',
          lastEventId: null,
          message: approve && result.status === 'completed'
            ? 'Aurora finished the approved action.'
            : 'The action was denied.'
        })
        return
      }
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
      if (tool.localConfirmationToken) {
        localConfirmationOrchestratorsRef.current.delete(tool.localConfirmationToken)
      }
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
    readAloudFallbackTokenRef.current += 1
    stopStreamedTtsPlayback()
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
    }
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      scopes: ['tts_playback'],
      reason
    })
    if (!result.ok) setLastError(productAssistantErrorCopy(result.error))
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

  async function onCancel() {
    if (!controls.canCancel) return
    const pendingId = activePendingIdRef.current
    if (pendingId) cancelledPendingIdsRef.current.add(pendingId)
    abortRef.current?.abort()
    if (selectedExecution.runner === 'lightweight-local') {
      localOrchestrator?.cancel()
      setStreamState((current) => ({ ...current, status: 'cancelled', message: 'Aurora stopped responding.' }))
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
    await startAssistantTurn(lastPrompt, replay ? streamState.lastEventId : null)
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
    if (usesNativeDesktopVoice && (voiceCaptureStatus === 'processing' || voiceCaptureStatus === 'speaking')) {
      await cancelNativeDesktopVoice('user_request')
      setStreamState((current) => ({ ...current, status: 'cancelled', message: 'Aurora stopped listening.' }))
      return
    }
    if (usesFocusedBrowserVoiceRuntime && voiceCaptureStatus === 'processing') {
      const token = browserVoiceOperationTokenRef.current
      browserVoiceOperationTokenRef.current = token + 1
      const pendingId = activePendingIdRef.current
      if (pendingId) cancelledPendingIdsRef.current.add(pendingId)
      abortRef.current?.abort()
      if (selectedExecution.runner === 'lightweight-local') {
        localOrchestrator?.cancel()
      } else if (pendingId) {
        void client.assistant.cancel({
          sessionId: session.sessionId,
          reason: 'user_interrupt'
        }).catch(() => undefined)
      }
      await settleBrowserVoiceTurn(token, 'abandon', 'user_interrupt')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      activePendingIdRef.current = null
      setActiveAssistantPendingId(null)
      setSession((current) => ({
        ...current,
        messages: current.messages.map((message) =>
          message.status === 'streaming' || message.status === 'sending'
            ? { ...message, status: 'cancelled', text: message.text.trim() ? message.text : 'Stopped by user.' }
            : message
        )
      }))
      setVoiceCaptureStatus('idle')
      setStreamState((current) => ({ ...current, status: 'cancelled', message: 'Aurora stopped listening.' }))
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
      if (browserErrorName(error) === 'AbortError') return
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
    const waitingForHostedSettlement = usesFocusedBrowserVoiceRuntime
      && voiceCaptureStatusRef.current === 'idle'
      && browserVoiceTurnSettlementRef.current?.state === 'settling'
    if (voiceToggleInFlightRef.current && !waitingForHostedSettlement) return
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
    setVoiceCaptureStatus('listening')
    setStreamState((current) => ({
      ...current,
      status: 'streaming',
      message: options.fallback
        ? 'Focused microphone access was unavailable; Aurora is listening on this computer instead.'
        : 'Starting microphone listening on this computer...'
    }))
    try {
      const started = await client.assistant.startVoiceListen({
        sessionId,
        timeoutMs: 8_000,
        routePolicy: routePolicyFromRoute(voiceModel.transcriptionRoute)
      })
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
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
    const result = await client.assistant.cancel({
      sessionId: session.sessionId,
      scopes: ['tts_playback'],
      reason: 'voice_capture_started'
    })
    if (!result.ok) setLastError(productAssistantErrorCopy(result.error))
  }

  async function startNativeDesktopVoice(): Promise<boolean> {
    const remoteAudioConsent = remoteAudioConsentForCurrentRoute(voiceModel.transcriptionRoute)
    if (remoteAudioConsent === null) return false
    if (!nativeVoice) {
      nativeVoiceStatusRef.current = null
      nativeVoiceGenerationRef.current = null
      setVoiceCaptureStatus('no-device')
      setLastError('Voice is unavailable in this desktop app.')
      setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice is unavailable in this desktop app.' }))
      return false
    }
    const token = nativeVoiceOperationTokenRef.current + 1
    nativeVoiceOperationTokenRef.current = token
    nativeVoicePendingCancelReasonRef.current = null
    nativeVoiceCancelledGenerationsRef.current.clear()
    setStreamState((current) => ({ ...current, status: 'streaming', message: 'Starting voice...' }))
    try {
      const status = await nativeVoice.start({
        trigger: 'focused_push_to_talk',
        remoteAudioConsent
      })
      const pendingReason = nativeVoicePendingCancelReasonRef.current
      if (
        assistantViewDisposedRef.current
        || nativeVoiceOperationTokenRef.current !== token
        || pendingReason !== null
      ) {
        const reason = pendingReason ?? (assistantViewDisposedRef.current ? 'shutdown' : 'user_request')
        let cancelled = status.generation === null
        if (status.generation !== null) {
          cancelled = await cancelNativeDesktopVoiceGeneration(status.generation, reason)
          if (!cancelled && assistantViewDisposedRef.current && reason === 'shutdown') {
            void retryDetachedNativeDesktopVoiceCancel(nativeVoice, status.generation, reason)
          }
        }
        if (nativeVoiceOperationTokenRef.current === token) {
          if (cancelled) {
            nativeVoiceGenerationRef.current = null
            nativeVoiceStatusRef.current = null
            nativeVoicePendingCancelReasonRef.current = null
            if (!assistantViewDisposedRef.current) {
              setVoiceCaptureStatus('idle')
              activeVoiceSessionRef.current = null
              ownedVoiceSessionIdsRef.current.clear()
              coordinatorVoiceSessionIdsRef.current.clear()
            }
          } else {
            nativeVoiceGenerationRef.current = status.generation
            nativeVoiceStatusRef.current = status
            if (status.generation !== null) {
              const sessionId = `native-desktop-${status.generation}`
              activeVoiceSessionRef.current = sessionId
              ownedVoiceSessionIdsRef.current.add(sessionId)
            }
            if (!assistantViewDisposedRef.current) {
              setVoiceCaptureStatus('error')
              setLastError('Voice could not stop cleanly. Try again.')
              setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice could not stop cleanly. Try again.' }))
            }
          }
        }
        return false
      }
      applyNativeDesktopVoiceStatus(status)
      if (!status.available || status.phase === 'unavailable') {
        setLastError('Voice is unavailable in this desktop app.')
        setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice is unavailable in this desktop app.' }))
        return false
      }
      if (status.phase === 'faulted') return false
      return true
    } catch {
      nativeVoiceStatusRef.current = null
      nativeVoiceGenerationRef.current = null
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      coordinatorVoiceSessionIdsRef.current.clear()
      if (!assistantViewDisposedRef.current && nativeVoiceOperationTokenRef.current === token) {
        setVoiceCaptureStatus('error')
        setLastError('Voice could not start. Check this device and try again.')
        setStreamState((current) => ({ ...current, status: 'lost', message: 'Voice could not start. Check this device and try again.' }))
      }
      return false
    }
  }

  async function finishNativeDesktopVoice(): Promise<boolean> {
    const generation = nativeVoiceGenerationRef.current
    if (!nativeVoice || generation === null) {
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return false
    }
    setVoiceCaptureStatus('processing')
    setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    try {
      applyNativeDesktopVoiceStatus(await nativeVoice.finish({ generation, reason: 'user_request' }))
      return true
    } catch {
      setVoiceCaptureStatus('error')
      setLastError('Voice could not stop cleanly. Try again.')
      return false
    }
  }

  function requestNativeDesktopVoiceCancel(reason: NativeDesktopVoiceStopReason) {
    void cancelNativeDesktopVoice(reason)
  }

  async function cancelNativeDesktopVoiceGeneration(
    generation: number,
    reason: NativeDesktopVoiceStopReason
  ): Promise<boolean> {
    if (!nativeVoice || nativeVoiceCancelledGenerationsRef.current.has(generation)) return false
    try {
      await nativeVoice.cancel({ generation, reason })
      nativeVoiceCancelledGenerationsRef.current.add(generation)
      return true
    } catch {
      return false
    }
  }

  async function retryDetachedNativeDesktopVoiceCancel(
    port: NativeDesktopVoicePort,
    generation: number,
    reason: NativeDesktopVoiceStopReason
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await Promise.resolve()
      try {
        await port.cancel({ generation, reason })
        nativeVoiceCancelledGenerationsRef.current.add(generation)
        return true
      } catch {
        // App shutdown remains the final native-owner safeguard if bounded retries fail.
      }
    }
    return false
  }

  async function cancelNativeDesktopVoice(reason: NativeDesktopVoiceStopReason): Promise<boolean> {
    nativeVoicePendingCancelReasonRef.current = reason
    const generation = nativeVoiceGenerationRef.current
    if (!nativeVoice || generation === null) return false
    nativeVoiceOperationTokenRef.current += 1
    try {
      const status = await nativeVoice.cancel({ generation, reason })
      nativeVoiceCancelledGenerationsRef.current.add(generation)
      applyNativeDesktopVoiceStatus(status)
      nativeVoicePendingCancelReasonRef.current = null
      return true
    } catch {
      setVoiceCaptureStatus('error')
      setLastError('Voice could not stop cleanly. Try again.')
      return false
    }
  }

  async function startNativeMobileVoice(): Promise<boolean> {
    const remoteAudioConsent = remoteAudioConsentForCurrentRoute(voiceModel.transcriptionRoute)
    if (remoteAudioConsent === null) return false
    if (!nativeMobileVoice) {
      setVoiceCaptureStatus('no-device')
      setLastError('Voice is unavailable on this device.')
      return false
    }
    setStreamState((current) => ({ ...current, status: 'streaming', message: 'Starting voice...' }))
    const operationToken = ++nativeMobileVoiceOperationTokenRef.current
    nativeMobileVoiceStartInFlightRef.current = true
    try {
      const status = await nativeMobileVoice.start({ remoteAudioConsent })
      if (assistantViewDisposedRef.current || operationToken !== nativeMobileVoiceOperationTokenRef.current) {
        await nativeMobileVoice.cancel().catch(() => undefined)
        return false
      }
      if (!status.available || status.phase === 'unavailable' || status.phase === 'faulted') {
        setVoiceCaptureStatus('error')
        setLastError('Voice could not start. Check microphone access on this device.')
        return false
      }
      setVoiceCaptureStatus('listening')
      return true
    } catch {
      if (assistantViewDisposedRef.current || operationToken !== nativeMobileVoiceOperationTokenRef.current) return false
      setVoiceCaptureStatus('error')
      setLastError('Voice could not start. Check microphone access on this device.')
      return false
    } finally {
      if (operationToken === nativeMobileVoiceOperationTokenRef.current) {
        nativeMobileVoiceStartInFlightRef.current = false
      }
    }
  }

  async function finishNativeMobileVoice(): Promise<boolean> {
    if (!nativeMobileVoice) return false
    setVoiceCaptureStatus('processing')
    setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    try {
      const status = await nativeMobileVoice.finish()
      if (status.phase === 'faulted') {
        setVoiceCaptureStatus('error')
        setLastError('Voice could not finish cleanly. Try again.')
        return false
      }
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return true
    } catch {
      setVoiceCaptureStatus('error')
      setLastError('Voice could not finish cleanly. Try again.')
      return false
    }
  }

  async function cancelNativeMobileVoice(options: { updateUi?: boolean } = {}): Promise<boolean> {
    if (!nativeMobileVoice) return false
    nativeMobileVoiceOperationTokenRef.current += 1
    const updateUi = options.updateUi !== false
    try {
      await nativeMobileVoice.cancel()
      if (updateUi) setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return true
    } catch {
      if (updateUi) {
        setVoiceCaptureStatus('error')
        setLastError('Voice could not stop cleanly. Try again.')
      }
      return false
    }
  }

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
    if (voiceCaptureStatusRef.current !== 'listening' && voiceCaptureStatusRef.current !== 'processing') return
    setVoiceCaptureStatus('idle')
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
    coordinatorVoiceSessionIdsRef.current.clear()
    voicePendingAssistantIdRef.current = null
    setVoiceResponsePendingId(null)
    setStreamState((current) => ({
      ...current,
      status: 'lost',
      message: 'Microphone listening stopped because Aurora was no longer the active window.'
    }))
  }

  function releaseBrowserVoiceCaptureForReason(reason: string) {
    void cancelBrowserVoiceCaptureForReason(reason)
  }

  async function cancelBrowserVoiceCaptureForReason(reason: string) {
    const token = browserVoiceOperationTokenRef.current
    browserVoiceOperationTokenRef.current = token + 1
    const settlement = browserVoiceTurnSettlementRef.current
    if (
      voiceCaptureStatusRef.current === 'processing'
      || settlement?.token === token && settlement.state === 'settling'
    ) {
      await settleBrowserVoiceTurn(token, 'cancel', reason)
      return
    }
    await cancelBrowserVoiceRuntime(reason)
  }

  function browserVoiceRuntime(): AuroraBrowserVoiceRuntimeInstance {
    if (!browserVoiceRuntimeRef.current) {
      const runtime = createAuroraBrowserVoiceRuntime({
        ownerId: 'aurora-assistant-view',
        lifecycle: browserVoiceLifecycleEligibility,
        audio: {
          onAudioLevel: (level, peak) => {
            setVoiceWaveformBars(waveformBarsFromLevel(level * 100, peak * 100))
          }
        },
        onAudioLifecycleLost: releaseBrowserVoiceCaptureForLifecycle,
        onPageLifecycleLost: releaseBrowserVoiceCaptureForLifecycle
      })
      browserVoiceRuntimeEventUnsubscribeRef.current = runtime.onEvent(handleBrowserVoiceRuntimeEvent)
      browserVoiceRuntimeRef.current = runtime
    }
    return browserVoiceRuntimeRef.current
  }

  function handleBrowserVoiceRuntimeEvent(event: BrowserVoiceRuntimeEventSnapshot) {
    setVoiceEvents((current) => mergeVoiceRuntimeEvents([
      browserVoiceRuntimeEventToVoiceEvent(event)
    ], current).slice(0, 12))
    if (event.sessionId) {
      ownedVoiceSessionIdsRef.current.add(event.sessionId)
      activeVoiceSessionRef.current = event.sessionId
    }
    if (event.kind === 'session_started') {
      setVoiceCaptureStatus('listening')
      return
    }
    if (event.kind === 'frame_dropped') {
      setLastError('Microphone capture is continuing with reduced quality.')
      setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: 'Microphone capture is continuing with reduced quality.'
      }))
      return
    }
    if (event.kind === 'lifecycle_lost') {
      releaseBrowserVoiceCaptureForLifecycle()
      return
    }
    if (event.kind === 'error') {
      setLastError('Microphone capture failed. Try again.')
      setVoiceCaptureStatus('error')
    }
  }

  function clearBrowserVoiceRuntimeEventSubscription() {
    browserVoiceRuntimeEventUnsubscribeRef.current?.()
    browserVoiceRuntimeEventUnsubscribeRef.current = null
  }

  async function cancelBrowserVoiceRuntime(reason: string) {
    const runtime = browserVoiceRuntimeRef.current
    if (!runtime) return
    try {
      await runtime.cancel(reason)
    } catch {
      // Best-effort cleanup; product state is reset by the caller.
    }
  }

  async function forceDisposeBrowserVoiceRuntime(runtime: AuroraBrowserVoiceRuntimeInstance) {
    if (browserVoiceRuntimeRef.current === runtime) browserVoiceRuntimeRef.current = null
    clearBrowserVoiceRuntimeEventSubscription()
    try {
      await runtime.dispose()
    } catch {
      // Best-effort forced recovery; the next capture recreates the runtime.
    }
  }

  async function settleBrowserVoiceTurn(
    token: number,
    outcome: BrowserVoiceTurnSettlementOutcome,
    reason = 'cancelled'
  ): Promise<{ claimed: boolean; succeeded: boolean; current: boolean }> {
    const settlement = browserVoiceTurnSettlementRef.current
    if (!settlement || settlement.token !== token || settlement.state !== 'open') {
      return { claimed: false, succeeded: true, current: browserVoiceOperationTokenRef.current === token }
    }
    settlement.state = 'settling'
    settlement.outcome = outcome
    const runtime = browserVoiceRuntimeRef.current
    if (!runtime) {
      settlement.state = 'settled'
      return { claimed: true, succeeded: true, current: browserVoiceOperationTokenRef.current === token }
    }
    const run = (async () => {
      try {
        if (outcome === 'complete') {
          await runtime.completeTurn()
        } else if (outcome === 'abandon') {
          await runtime.abandonTurn()
        } else {
          await runtime.cancel(reason)
        }
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
    if (browserVoiceTurnSettlementRef.current === settlement) {
      settlement.state = 'settled'
    }
    return { claimed: true, succeeded, current: browserVoiceOperationTokenRef.current === token }
  }

  async function waitForBrowserVoiceTurnSettlement(token: number): Promise<void> {
    const settlement = browserVoiceTurnSettlementRef.current
    if (!settlement || settlement.token !== token || !settlement.promise) return
    await settlement.promise.catch(() => false)
  }

  async function waitForSettlingBrowserVoiceTurn(): Promise<void> {
    const settlement = browserVoiceTurnSettlementRef.current
    if (!settlement || settlement.state !== 'settling' || !settlement.promise) return
    await settlement.promise.catch(() => false)
  }

  async function disposeBrowserVoiceRuntime() {
    const runtime = browserVoiceRuntimeRef.current
    browserVoiceRuntimeRef.current = null
    clearBrowserVoiceRuntimeEventSubscription()
    if (!runtime) return
    try {
      await runtime.dispose()
    } catch {
      // Best-effort teardown during unmount.
    }
  }

  async function startBrowserVoiceCapture(sessionId: string): Promise<boolean> {
    const token = browserVoiceOperationTokenRef.current + 1
    browserVoiceOperationTokenRef.current = token
    await waitForSettlingBrowserVoiceTurn()
    if (browserVoiceOperationTokenRef.current !== token) return false
    if (!browserVoiceLifecycleEligibility().eligible) {
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      setVoiceCaptureStatus('idle')
      return false
    }
    browserVoiceTurnSettlementRef.current = { token, state: 'open', outcome: null, promise: null }
    activeVoiceSessionRef.current = sessionId
    ownedVoiceSessionIdsRef.current.add(sessionId)
    setVoiceCaptureStatus('listening')
    setStreamState((current) => ({
      ...current,
      status: 'streaming',
      message: 'Requesting focused microphone access for push-to-talk…'
    }))
    try {
      const started = await browserVoiceRuntime().start()
      if (browserVoiceOperationTokenRef.current !== token) {
        return false
      }
      activeVoiceSessionRef.current = started.sessionId
      ownedVoiceSessionIdsRef.current.add(started.sessionId)
      setStreamState((current) => ({
        ...current,
        status: 'streaming',
        message: 'Focused microphone capture is active.'
      }))
      return true
    } catch (error) {
      if (browserVoiceOperationTokenRef.current !== token) return false
      await cancelBrowserVoiceRuntime('start_failed')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      const nextStatus = voiceCaptureStatusForStartError(error)
      setLastError(nextStatus === 'idle' ? null : productAudioCaptureErrorCopy(error))
      setVoiceCaptureStatus(nextStatus)
      return false
    }
  }

  async function stopBrowserVoiceCapture() {
    const runtime = browserVoiceRuntimeRef.current
    if (!runtime) return
    const token = browserVoiceOperationTokenRef.current
    setVoiceCaptureStatus('processing')
    setStreamState((current) => ({ ...current, status: 'streaming', message: 'Voice captured. Aurora is processing the request.' }))
    let captured: AuroraBrowserCapturedAudio = null
    try {
      captured = await runtime.stop()
    } catch (error) {
      if (browserVoiceOperationTokenRef.current !== token) return
      await cancelBrowserVoiceRuntime('stop_failed')
      setLastError(productAudioCaptureErrorCopy(error))
      setVoiceCaptureStatus('error')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return
    }
    if (browserVoiceOperationTokenRef.current !== token) {
      await settleBrowserVoiceTurn(token, 'abandon', 'stale_capture')
      return
    }
    if (!captured || captured.sampleCount === 0 || captured.pcm.length === 0) {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'empty_audio')
      if (!settled.current) return
      setLastError('No microphone audio was captured. Check microphone permission and try push-to-talk again.')
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return
    }
    let result: Awaited<ReturnType<typeof client.assistant.transcribeVoiceAudio>>
    try {
      result = await client.assistant.transcribeVoiceAudio({
        audio_data: int16PcmToLittleEndianBase64(captured.pcm),
        format: 'raw',
        sample_rate: 16000,
        channels: 1,
        model: 'accurate',
        routePolicy: routePolicyFromRoute(voiceModel.transcriptionRoute)
      })
    } catch (error) {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'transcription_failed')
      if (browserVoiceOperationTokenRef.current !== token) return
      if (!settled.current) return
      setLastError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
      setVoiceCaptureStatus('error')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return
    }
    if (browserVoiceOperationTokenRef.current !== token) {
      await settleBrowserVoiceTurn(token, 'abandon', 'stale_transcription')
      return
    }
    if (!result.ok) {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'transcription_failed')
      if (!settled.current) return
      setLastError(productAssistantErrorCopy(result.error))
      setVoiceCaptureStatus('error')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return
    }
    const transcript = result.data.text.trim()
    if (!transcript) {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'empty_transcription')
      if (!settled.current) return
      setLastError('No speech was transcribed from the recorded audio.')
      setVoiceCaptureStatus('idle')
      activeVoiceSessionRef.current = null
      ownedVoiceSessionIdsRef.current.clear()
      return
    }
    voiceTranscriptPreviewRef.current = ''
    setText('')
    let succeeded = false
    try {
      succeeded = await startAssistantTurn(transcript)
    } catch (error) {
      if (browserVoiceOperationTokenRef.current !== token) {
        await settleBrowserVoiceTurn(token, 'abandon', 'stale_assistant')
        return
      }
      setLastError(productAssistantErrorCopy(error instanceof Error ? error : new Error(String(error))))
      succeeded = false
    }
    if (browserVoiceOperationTokenRef.current !== token) {
      await settleBrowserVoiceTurn(token, 'abandon', 'stale_assistant')
      return
    }
    if (succeeded) {
      const completed = await settleBrowserVoiceTurn(token, 'complete')
      if (!completed.current) return
      if (completed.succeeded) {
        setVoiceCaptureStatus('idle')
      } else {
        setLastError('Voice request finished, but Aurora could not close listening cleanly.')
        setVoiceCaptureStatus('error')
      }
    } else {
      const settled = await settleBrowserVoiceTurn(token, 'abandon', 'assistant_failed')
      if (!settled.current) return
      setVoiceCaptureStatus('error')
    }
    activeVoiceSessionRef.current = null
    ownedVoiceSessionIdsRef.current.clear()
  }

  async function toggleLocalCapture() {
    const currentCaptureStatus = voiceCaptureStatusRef.current
    if (usesNativeDesktopVoice && currentCaptureStatus === 'error' && nativeVoiceGenerationRef.current !== null) {
      await cancelNativeDesktopVoice('user_request')
      return
    }
    if (currentCaptureStatus === 'listening') {
      if (usesNativeDesktopVoice) {
        await finishNativeDesktopVoice()
        return
      }
      if (usesNativeMobileVoice) {
        await finishNativeMobileVoice()
        return
      }
      const sessionId = activeVoiceSessionRef.current
      if (usesFocusedBrowserVoiceRuntime) {
        await stopBrowserVoiceCapture()
        coordinatorVoiceSessionIdsRef.current.clear()
        voicePendingAssistantIdRef.current = null
        setVoiceResponsePendingId(null)
        return
      }
      const coordinatorOwnsCapture = Boolean(
        sessionId && coordinatorVoiceSessionIdsRef.current.has(sessionId)
      )
      if (sessionId && coordinatorOwnsCapture) {
        const stopped = await client.assistant.stopVoiceListen({
          sessionId,
          reason: 'user_request',
          routePolicy: routePolicyFromRoute(voiceModel.transcriptionRoute)
        })
        if (!stopped.ok) setLastError(productAssistantErrorCopy(stopped.error))
      }
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
    if (surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'unavailable') {
      setVoiceCaptureStatus('no-device')
      setLastError('Voice is unavailable on this device right now.')
      return
    }
    if (remoteAudioConsentForCurrentRoute(voiceModel.transcriptionRoute) === null) return
    if (!defaultVoiceRoutePolicy(voiceModel.transcriptionRoute)) return
    if (usesNativeDesktopVoice) {
      await startNativeDesktopVoice()
      return
    }
    if (usesNativeMobileVoice) {
      await interruptTtsForVoiceCapture()
      await startNativeMobileVoice()
      return
    }
    void interruptTtsForVoiceCapture()
    if (!surfaceProfile.voiceCapture.avoidCoordinatorPushToTalk) {
      await startCoordinatorPushToTalk(sessionId)
      return
    }

    if (usesFocusedBrowserVoiceRuntime) {
      await startBrowserVoiceCapture(sessionId)
      return
    }

    setVoiceCaptureStatus('no-device')
    setLastError('Voice is unavailable on this device right now.')
  }

  async function startNewConversation() {
    if (usesLocalConversationHistory) {
      resetConversationUi(emptyAssistantSession())
    } else if (supportsPersistedSessions) {
      setSessionIndexLoading(true)
      const created = await createPersistedChatSession()
      setSessionIndexLoading(false)
      if (!created) return
      resetConversationUi({ sessionId: created.id, messages: [] })
    } else {
      resetConversationUi(emptyAssistantSession())
    }
    setMobileHistoryOpen(false)
    textAreaRef.current?.focus()
  }

  return (
    <section className="aui-assistant" aria-labelledby="assistant-title">
      <h1 id="assistant-title" className="aui-sr-only">Text chat with Aurora</h1>
      <AssistantRuntimeStrip health={runtimeStrip} />

      {streamState.status === 'lost' || streamState.status === 'fallback' || streamState.status === 'cancelled' ? (
        <div className="aui-stream-banner" role="status" aria-live="polite">
          <WifiOff size={17} aria-hidden />
          <span>{streamState.message}</span>
          <button
            type="button"
            onClick={() => void retryLastPrompt(streamState.status !== 'cancelled')}
            disabled={!lastPrompt || !canSend}
          >
            <RotateCcw size={15} aria-hidden />
            <span>{streamState.status === 'cancelled' ? 'Retry' : 'Replay'}</span>
          </button>
        </div>
      ) : null}

      <div className="aui-assistant-grid">
        <ConversationRail
          rows={conversationRows}
          loading={sessionIndexLoading}
          error={sessionIndexError}
          disabled={assistantBusy || voiceBusy}
          newConversationDisabled={client.transport.kind === 'mesh' && !usesLocalConversationHistory}
          onSelectConversation={(sessionId) => {
            if (usesLocalConversationHistory) {
              void openLocalSession(sessionId)
            } else {
              void openPersistedSession(sessionId)
            }
          }}
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
                          <span>Aurora will show responses here after it finishes answering.</span>
                        </MarkerContent>
                      </Marker>
                    </MessageScrollerItem>
                  ) : (
                    sessionMessages.map((message) => (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
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
              <MobileConversationSheet
                open={mobileHistoryOpen}
                onOpenChange={setMobileHistoryOpen}
                rows={conversationRows}
                loading={sessionIndexLoading}
                error={sessionIndexError}
                disabled={assistantBusy || voiceBusy}
                newConversationDisabled={client.transport.kind === 'mesh' && !usesLocalConversationHistory}
                onSelectConversation={(sessionId) => {
                  if (usesLocalConversationHistory) {
                    void openLocalSession(sessionId)
                  } else {
                    void openPersistedSession(sessionId).finally(() => setMobileHistoryOpen(false))
                  }
                }}
                onNewConversation={() => void startNewConversation()}
              />
              <div className="aui-composer-selectors">
                <ModelSelector.Root
                  models={executionOptions.map((option) => {
                    const optionLabel = safeAssistantRuntimeValue(option.label, 'Connected Aurora device') ?? 'Connected Aurora device'
                    return {
                      id: option.id,
                      name: option.mode === 'local' ? 'This device' : optionLabel,
                      description: option.description,
                      icon: option.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
                    }
                  })}
                  value={selectedExecution.id}
                  onValueChange={(value) => {
                    if (value === selectedExecution.id) return
                    setExecutionOptionId(value)
                    setSelectedModelChoiceId('automatic')
                    setModelSearchQuery('')
                  }}
                >
                  <ModelSelector.Trigger
                    variant="ghost"
                    size="sm"
                    className="aui-execution-selector-trigger"
                    aria-label={`Using ${selectedExecution.mode === 'local' ? 'this device' : safeAssistantRuntimeValue(selectedExecution.label, 'Connected Aurora device') ?? 'Connected Aurora device'}`}
                  >
                    {selectedExecution.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />}
                    <span className="aui-selector-prefix">Using</span>
                    <strong>{selectedExecution.mode === 'local' ? 'this device' : safeAssistantRuntimeValue(selectedExecution.label, 'Connected Aurora device') ?? 'Connected Aurora device'}</strong>
                  </ModelSelector.Trigger>
                  <ModelSelector.Content side="top" searchable={false} className="aui-execution-selector-content">
                    <ModelSelector.List>
                      <ModelSelector.Group heading="Device">
                        {executionOptions.map((option) => {
                          const optionLabel = safeAssistantRuntimeValue(option.label, 'Connected Aurora device') ?? 'Connected Aurora device'
                          const model = {
                            id: option.id,
                            name: option.mode === 'local' ? 'This device' : optionLabel,
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
                  <ModelSelector.Content side="top" searchable className="aui-assistant-model-selector-content">
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
                <AssistantPrivacyBadge privacy={route.item.privacyClass} />
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
                  sourceLabel="This device microphone"
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
              <button
                type="button"
                className="aui-secondary-button aui-composer-icon"
                data-voice-access={connectedVoiceAccessGranted ? 'granted' : 'required'}
                aria-label={connectedVoiceAccessGranted ? 'Stop connected voice access' : 'Allow connected voice'}
                title={connectedVoiceAccessGranted ? 'Stop connected voice access' : 'Allow connected voice'}
                onClick={(event) => { event.preventDefault(); void toggleRemoteAudioConsent() }}
              >
                <ShieldAlert size={18} aria-hidden />
                <span className="aui-sr-only">{connectedVoiceAccessGranted ? 'Stop connected voice access' : 'Allow connected voice'}</span>
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
            {lastError && (voiceCaptureStatus === 'permission-denied' || voiceCaptureStatus === 'no-device' || voiceCaptureStatus === 'error') ? (
              <p className="aui-composer-voice-recovery" data-voice-recovery="true" role="alert">{lastError}</p>
            ) : null}
            <p className="aui-mobile-composer-note">
              Aurora uses this device by default. You can review another device before anything is sent.
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
            <div><dt>Privacy</dt><dd>{assistantPrivacyClassCopy(route.item.privacyClass)}</dd></div>
            <div><dt>Selector</dt><dd>{route.selectorRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Approval</dt><dd>{route.approvalRequired ? 'required' : 'not required'}</dd></div>
            <div><dt>Cancellation</dt><dd>{controls.canCancel ? 'supported' : controls.cancelReason}</dd></div>
            <div><dt>Model</dt><dd>{safeAssistantRuntimeValue(modelLabel, lastResult ? 'not reported' : 'model response pending')}</dd></div>
            <div><dt>Context</dt><dd>{contextSummary.ready} ready, {contextSummary.blocked} blocked</dd></div>
          </dl>
          <p>{assistantRouteExplanationCopy(route)}</p>
          {remotePrivacyWarning ? <p className="aui-privacy-route-warning" role="status">{remotePrivacyWarning}</p> : null}
          {route.disabled ? <p role="alert">Assistant send is disabled: {assistantRouteBlockerCopy(route)}.</p> : null}
          {lastError ? <p role="alert">{lastError}</p> : null}
          {routeDetailsOpen ? (
            <>
              <VoiceModePanel
                client={client}
                model={voiceModel}
                captureStatus={voiceCaptureStatus}
                elapsedSeconds={voiceElapsedSeconds}
                onToggleCapture={requestVoiceToggle}
                onToggleConsent={() => { void toggleRemoteAudioConsent() }}
              />
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
            </>
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
        Connection and model status for this conversation.
      </p>
      <dl>
        <div><dt>Selected model</dt><dd>{health.selectedModel ?? 'model pending'}</dd></div>
        <div><dt>Model state</dt><dd>{health.selectedModel ? 'configured' : 'model status pending'}</dd></div>
        <div><dt>Answers from</dt><dd>{health.routeLabel}</dd></div>
        <div><dt>On this device</dt><dd>{health.sidecarHealth}</dd></div>
        <div><dt>Connection</dt><dd>{health.gatewayHealth}</dd></div>
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
  const routeLabel = safeAssistantRuntimeValue(
    runtimeHealth?.routeLabel,
    route.state === 'available-remote' ? 'Connected Aurora device' : 'This device'
  ) ?? 'This device'
  return {
    selectedModel: safeAssistantRuntimeValue(runtimeHealth?.selectedModel ?? modelLabel, null),
    routeLabel: /^local$/i.test(routeLabel) ? 'This device' : routeLabel,
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
  if (state === 'denied') return 'Denied'
  if (state === 'degraded') return 'Limited'
  if (state === 'stale') return 'Needs refresh'
  if (state === 'pending') return 'Pending'
  return 'Unavailable'
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
  surfaceProfile?: AuroraSurfaceProfile | undefined
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
  const surfaceProfile = input.surfaceProfile ?? getAuroraSurfaceProfile({
    runtimeMode: input.client.transport.kind === 'tauri-local' ? 'desktop-local' : input.client.transport.kind === 'native-mobile' ? 'mobile' : undefined,
    transportKind: input.client.transport.kind,
    nativePlatform: input.nativePlatform
  })
  const browserCaptureState = browserCaptureAvailability(surfaceProfile, input.captureStatus)
  const remoteAudioRoute = remoteAudioRouteFor(transcription, wakeProcess)
  const localSpeechPack = surfaceProfile.localSpeechPack

  return {
    captureStatus: input.captureStatus,
    consentGranted: input.consentGranted,
    privacyClass: 'raw-audio',
    retentionPolicy: remoteAudioRoute.disabled
      ? 'Not stored because speech help is unavailable.'
      : 'The connected device controls whether audio is saved.',
    sessionTtl: input.consentGranted ? 'Until you leave or turn off access.' : 'Not allowed.',
    transport: input.client.transport.kind,
    platformTruth: 'This device microphone is used while Aurora is open.',
    visualizerSourceLabel: 'This device microphone',
    targetLabel: remoteAudioRoute.providerLabel,
    chips: [
      {
        id: 'browser-capture',
        label: 'Device microphone',
        state: browserCaptureState.state,
        privacyClass: 'raw-audio',
        providerLabel: browserCaptureState.providerLabel,
        detail: browserCaptureState.detail,
        blockers: browserCaptureState.blockers,
        evidence: ['device_voice_status']
      },
      {
        id: 'local-speech-pack',
        label: localSpeechPack.label,
        state: localSpeechPack.availabilityState,
        privacyClass: 'raw-audio',
        providerLabel: 'This device',
        detail: localSpeechPack.detail,
        blockers: localSpeechPack.blockers,
        evidence: ['local_speech_pack_state']
      },
      nativeCapture,
      voiceChip('remote-processing', 'Connected speech help', transcription, 'raw-audio', input.consentGranted
        ? 'Session consent is active for speech help.'
        : 'Session consent is required before audio leaves this device.'),
      voiceChip(
        'wake',
        surfaceProfile.voiceCapture.wakewordRequiresFocus ? 'Wake while open' : 'Wake and background',
        wakeControl.disabled ? wakeProcess : wakeControl,
        'raw-audio',
        wakeDetail(input.nativePlatform ?? 'not available', wakeControl, wakeProcess)
      ),
      voiceChip('tts', 'Speech generation', ttsSynthesize, 'personal', 'Speech can be prepared before playback starts.'),
      voiceChip('playback', 'Local playback', ttsStop, 'personal', 'Playback stop/control is separate from remote synthesis.')
    ],
    controls: [
      {
        id: 'push-to-talk',
        label: input.captureStatus === 'listening' || input.captureStatus === 'processing' || input.captureStatus === 'speaking' ? 'Stop listening' : 'Push to talk',
        state: pushToTalkControlState(surfaceProfile, browserCaptureState.state),
        enabled: pushToTalkControlState(surfaceProfile, browserCaptureState.state) !== 'unsupported',
        reason: 'This device microphone is ready while Aurora is open.',
        route: null
      },
      {
        id: 'remote-consent',
        label: input.consentGranted ? 'Revoke audio consent' : 'Grant session consent',
        state: remoteAudioRoute.disabled ? remoteAudioRoute.state : input.consentGranted ? 'available-local' : 'privacy-blocked',
        enabled: !remoteAudioRoute.disabled || remoteAudioRoute.state === 'privacy-blocked',
        reason: input.consentGranted
          ? 'Consent can be revoked before starting another audio session.'
          : 'Required before microphone audio is shared with a connected device.',
        route: remoteAudioRoute
      },
      voiceAction('remote-transcription', 'Start speech capture', transcription, input.captureStatus, input.consentGranted),
      voiceAction('wakeword', 'Wake foreground', wakeControl.disabled ? wakeProcess : wakeControl, input.captureStatus, input.consentGranted),
      voiceAction('tts-synthesize', 'Synthesize speech', ttsSynthesize, input.captureStatus, input.consentGranted),
      voiceAction('playback-stop', 'Stop playback', ttsStop, input.captureStatus, input.consentGranted)
    ],
    events: voiceEventRows(input.captureStatus, transcription, input.voiceEvents ?? []),
    routeSheetRoute: remoteAudioRoute,
    remoteAudioRoute,
    transcriptionRoute: transcription,
    speechRoute: ttsSynthesize,
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
          <AssistantPrivacyBadge privacy={model.privacyClass} />
          <EvidenceBadge label={productConnectionCopy(model.transport)} />
          <EvidenceBadge label={model.consentGranted ? 'consent granted' : 'consent required'} />
          <EvidenceBadge label={voiceDestinationCopy(model.targetLabel)} />
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
              <AssistantPrivacyBadge privacy={chip.privacyClass} />
              <EvidenceBadge label={voiceProviderCopy(chip.providerLabel)} />
            </div>
            <small>{voiceChipStatusCopy(chip)}</small>
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
                <span>{voiceControlReasonCopy(control)}</span>
              </li>
            ))}
          </ul>
        </section>

        <aside className="aui-voice-privacy" aria-label="Audio sharing details">
          <h3>Audio privacy</h3><span className="aui-sr-only">Connection details</span>
          <dl>
            <div><dt>Audio type</dt><dd>{assistantPrivacyClassCopy(model.privacyClass)}</dd></div>
            <div><dt>Destination</dt><dd>{voiceDestinationCopy(model.targetLabel)}</dd></div>
            <div><dt>Connection</dt><dd>{productConnectionCopy(model.transport)}</dd></div>
            <div><dt>Audio storage</dt><dd>{model.retentionPolicy}</dd></div>
            <div><dt>Access duration</dt><dd>{model.sessionTtl}</dd></div>
          </dl>
          <RouteSheet
            client={client}
            title="Review audio sharing"
            description="Aurora shares microphone audio only after you allow it and the selected device is available."
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
  const uiMessage: AssistantUiMessage = {
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
  if (role === 'tool') {
    uiMessage.toolCalls = [assistantToolCallFromPersisted(message, metadata, uiMessage)]
  }
  return uiMessage
}

function assistantToolCallFromPersisted(
  message: Record<string, unknown>,
  metadata: Record<string, unknown>,
  uiMessage: AssistantUiMessage
): AssistantToolCallCard {
  const tool = metadataObjectValue(metadata, 'tool')
    ?? metadataObjectValue(metadata, 'tool_call')
    ?? metadataObjectValue(metadata, 'toolCall')
    ?? metadata
  const status = persistedToolStatus(
    metadataStringValue(tool, 'status')
      ?? metadataStringValue(metadata, 'status')
      ?? metadataStringValue(message, 'status')
  )
  const name = metadataStringValue(tool, 'name')
    ?? metadataStringValue(tool, 'tool_name')
    ?? metadataStringValue(tool, 'toolName')
    ?? metadataStringValue(tool, 'global_tool_id')
    ?? metadataStringValue(metadata, 'global_tool_id')
    ?? metadataStringValue(message, 'tool_name')
    ?? 'assistant-action'
  const route = metadataStringValue(metadata, 'execution') ?? metadataStringValue(tool, 'route')
  const dataLeavesDevice = metadataBooleanValue(tool, 'data_leaves_device')
    ?? metadataBooleanValue(tool, 'dataLeavesDevice')
    ?? route === 'remote'
  return {
    id: metadataStringValue(tool, 'id')
      ?? metadataStringValue(tool, 'tool_call_id')
      ?? metadataStringValue(tool, 'toolCallId')
      ?? metadataStringValue(message, 'tool_call_id')
      ?? uiMessage.id,
    name,
    sessionId: metadataStringValue(metadata, 'session_id') ?? metadataStringValue(message, 'session_id'),
    status,
    riskClass: metadataStringValue(tool, 'risk_class')
      ?? metadataStringValue(tool, 'riskClass')
      ?? metadataStringValue(metadata, 'risk_class')
      ?? 'reviewed',
    target: metadataStringValue(tool, 'target')
      ?? metadataStringValue(metadata, 'execution_peer_name')
      ?? (dataLeavesDevice ? 'Connected Aurora device' : 'This device'),
    dataLeavesDevice,
    summary: metadataStringValue(tool, 'summary')
      ?? (uiMessage.text.trim() ? uiMessage.text : toolSummaryForStatus(status)),
    auditId: metadataStringValue(metadata, 'correlation_id')
      ?? metadataStringValue(metadata, 'correlationId')
      ?? metadataStringValue(message, 'correlation_id'),
    payloadPreview: metadataObjectValue(tool, 'payload_preview')
      ?? metadataObjectValue(tool, 'payloadPreview')
      ?? metadataObjectValue(tool, 'arguments')
      ?? metadataObjectValue(metadata, 'payload_preview'),
    resultPreview: metadataObjectValue(tool, 'result_preview')
      ?? metadataObjectValue(tool, 'resultPreview')
      ?? metadataStringValue(tool, 'result_preview')
      ?? metadataStringValue(tool, 'resultPreview')
      ?? (status === 'completed' && uiMessage.text.trim() ? 'Result details saved with the conversation.' : null),
    error: status === 'failed'
      ? metadataStringValue(tool, 'error') ?? metadataStringValue(metadata, 'error') ?? 'action_incomplete'
      : null,
    errorDetails: metadataObjectValue(tool, 'error_details')
      ?? metadataObjectValue(tool, 'errorDetails')
      ?? metadataStringValue(tool, 'error_details')
      ?? metadataStringValue(tool, 'errorDetails'),
    pendingId: metadataStringValue(tool, 'pending_id')
      ?? metadataStringValue(tool, 'pendingId')
      ?? metadataStringValue(metadata, 'pending_id'),
    approvalRequestId: metadataStringValue(tool, 'approval_request_id')
      ?? metadataStringValue(tool, 'approvalRequestId')
      ?? metadataStringValue(metadata, 'approval_request_id'),
    approvalExpiresAt: metadataNumberValue(tool, 'approval_expires_at')
      ?? metadataNumberValue(tool, 'approvalExpiresAt')
      ?? metadataNumberValue(metadata, 'approval_expires_at'),
    policyDecisionId: metadataStringValue(tool, 'policy_decision_id')
      ?? metadataStringValue(tool, 'policyDecisionId')
      ?? metadataStringValue(metadata, 'policy_decision_id')
  }
}

function persistedToolStatus(value: string | null): AssistantToolCallCard['status'] {
  const normalized = value?.toLowerCase().replace(/[\s-]+/gu, '_') ?? ''
  if (normalized.includes('requires_action') || normalized.includes('approval') || normalized === 'pending') return 'requires_action'
  if (normalized.includes('running') || normalized.includes('requested')) return 'running'
  if (normalized.includes('fail') || normalized.includes('error') || normalized === 'cancelled') return 'failed'
  return 'completed'
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
  provider = selectedRoutePolicyProvider(route)
): AssistantRoutePolicy {
  const providerId = provider?.providerId ?? provider?.id ?? null
  const remoteProvider = provider && isRemoteRouteCandidate(provider) ? provider : null
  return {
    providerId,
    peerId: remoteProvider ? remoteProvider.peerId ?? (providerId ? peerIdFromProviderIdentity(providerId) : null) : null,
    serviceInstanceId: remoteProvider ? remoteProvider.serviceInstanceId ?? (providerId ? serviceInstanceFromProviderIdentity(providerId) : null) : null,
    routeState: route.state,
    fallbackBehavior: route.state === 'degraded' ? 'backend-reported degraded route' : null,
    privacyClass: route.item.privacyClass,
    selectorRequired: route.selectorRequired,
    approvalRequired: route.approvalRequired
  }
}

function selectedRoutePolicyProvider(route: RouteAvailability): RouteAvailability['candidateProviders'][number] | undefined {
  if (route.selectorRequired) return undefined
  const local = route.candidateProviders.find((candidate) => candidate.selectable && !isRemoteRouteCandidate(candidate))
    ?? route.candidateProviders.find((candidate) => !isRemoteRouteCandidate(candidate))
  if (local && route.state !== 'available-remote') return local
  const remote = route.candidateProviders.find((candidate) => candidate.selectable && isRemoteRouteCandidate(candidate))
    ?? route.candidateProviders.find(isRemoteRouteCandidate)
  return remote ?? local ?? route.candidateProviders.find((candidate) => candidate.selectable) ?? route.candidateProviders[0]
}

export interface AssistantExecutionContext {
  executionHost?: 'this-device' | 'connected-device'
  localExecutionAvailable?: boolean
}

export function assistantExecutionOptions(
  route: RouteAvailability,
  context: AssistantExecutionContext = {}
): AssistantExecutionOption[] {
  const executionHost = context.executionHost ?? 'this-device'
  const options: AssistantExecutionOption[] = []
  if (executionHost === 'this-device' || context.localExecutionAvailable === true) {
    options.push({
      id: 'local',
      mode: 'local',
      runner: context.localExecutionAvailable === true ? 'lightweight-local' : 'aurora-route',
      label: 'Local',
      description: 'Run the assistant on this device. The model may run here, use a cloud service, or be shared by another device.',
      routePolicy: context.localExecutionAvailable === true
        ? { ...routePolicyFromRoute(route), providerId: null, peerId: null, serviceInstanceId: null }
        : routePolicyFromRoute(route),
      executionPeerId: null,
      transportHost: false,
      modelCatalogHost: executionHost === 'connected-device' ? 'connected-device' : 'mixed'
    })
  }
  const seen = new Set<string>()
  for (const candidate of route.candidateProviders) {
    if (!candidate.selectable) continue
    const remoteCandidate = isRemoteRouteCandidate(candidate)
    if (executionHost !== 'connected-device' && !remoteCandidate) continue
    const peerId = candidate.peerId ?? peerIdFromProviderIdentity(candidate.providerId ?? candidate.id)
    const serviceInstanceId = candidate.serviceInstanceId ?? serviceInstanceFromProviderIdentity(candidate.providerId ?? candidate.id)
    const providerId = candidate.providerId ?? candidate.id
    const identity = peerId ?? serviceInstanceId ?? providerId
    if (!identity || seen.has(identity)) continue
    seen.add(identity)
    const peerLabel = executionPeerLabel(candidate.nodeName ?? candidate.label, peerId)
    const transportHost = executionHost === 'connected-device' && !remoteCandidate
    options.push({
      id: `dispatch:${transportHost ? 'connected:' : ''}${identity}`,
      mode: 'dispatch',
      runner: 'aurora-route',
      label: peerLabel,
      description: `Send this turn to ${peerLabel}; that device handles the request.`,
      routePolicy: transportHost
        ? routePolicyFromRoute(route, candidate)
        : {
            providerId,
            peerId,
            serviceInstanceId,
            routeState: candidate.state,
            fallbackBehavior: candidate.state === 'degraded' ? candidate.reason : null,
            privacyClass: route.item.privacyClass,
            selectorRequired: route.selectorRequired,
            approvalRequired: route.approvalRequired
          },
      executionPeerId: peerId,
      transportHost,
      modelCatalogHost: 'connected-device'
    })
  }
  if (executionHost === 'connected-device' && !options.some((option) => option.mode === 'dispatch')) {
    options.push({
      id: 'dispatch:connected',
      mode: 'dispatch',
      runner: 'aurora-route',
      label: 'Connected Aurora device',
      description: 'Dispatch the assistant turn to the connected Aurora device.',
      routePolicy: routePolicyFromRoute(route),
      executionPeerId: null,
      transportHost: true,
      modelCatalogHost: 'connected-device'
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
  const automatic: AssistantModelChoice = {
    id: 'automatic',
    model: {
      id: 'automatic',
      name: execution.mode === 'local'
        ? 'Configured default'
        : 'Automatic',
      description: execution.mode === 'local'
        ? configuredProvider
          ? 'Aurora uses the configured model for this device.'
          : 'Let Aurora choose from the configured, available model routes.'
        : 'The selected connected device chooses from the models it shares and permits.',
      icon: execution.mode === 'local' ? <Laptop aria-hidden /> : <Network aria-hidden />
    },
    provider: null,
    runtimeModel: null,
    automatic: true
  }
  if (!catalog) return [automatic]

  const usableProviders = catalog.providers
    .filter((provider) => providerUsableForAssistant(provider))
    .filter((provider) => execution.mode === 'local' || execution.transportHost || providerMatchesExecution(provider, execution))
  const choices = usableProviders
    .flatMap((provider, providerIndex) => {
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
      return availableModels.map((runtimeModel, modelIndex): AssistantModelChoice => {
        const providerClass = execution.modelCatalogHost === 'connected-device'
          ? 'connected'
          : assistantModelProviderClass(provider)
        const providerLabel = safeAssistantCatalogLabel(
          provider.display_name,
          assistantModelProviderLabel(providerClass, providerIndex + 1)
        )
        const modelLabel = safeAssistantCatalogLabel(
          runtimeModel.display_name || runtimeModel.model_id,
          assistantModelLabel(providerClass, providerIndex + 1, modelIndex + 1)
        )
        const id = assistantModelChoiceId(provider.provider_id, runtimeModel.model_id)
        return {
          id,
          model: {
            id,
            name: modelLabel,
            description: assistantModelDescription(providerClass, providerLabel),
            icon: execution.modelCatalogHost === 'connected-device' || providerIsRemote(provider)
              ? <Network aria-hidden />
              : <Cpu aria-hidden />,
            keywords: assistantModelKeywords(providerClass, providerIndex + 1, modelIndex + 1, providerLabel, modelLabel)
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
    const remote = execution.modelCatalogHost === 'connected-device' || providerIsRemote(provider)
    const id = remote
      ? `peer:${provider.provider_peer_id ?? 'remote'}:${provider.provider_id}`
      : `local:${provider.provider_id}`
    const target = remote ? peerProviders : localProviders
    const existing = target.get(id)
    if (existing) {
      existing.choices.push(choice)
      continue
    }
    const providerClass = remote ? 'connected' : assistantModelProviderClass(provider)
    const providerOrdinal = target.size + 1
    const providerLabel = safeAssistantCatalogLabel(
      provider.display_name,
      assistantModelProviderLabel(providerClass, providerOrdinal)
    )
    target.set(id, {
      id,
      heading: `${providerLabel} · ${modelCountLabel(1)}`,
      choices: [choice],
      scope: remote ? 'connected device' : 'this device'
    })
  }

  const groups: AssistantModelChoiceGroup[] = automatic.length > 0
    ? [{
        id: 'configured-default',
        heading: execution.mode === 'local' ? 'Configured default' : 'Automatic',
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
  const connectedHostExecution = executionOptions.find((option) => option.transportHost)
  for (const group of providerGroups) {
    if (group.scope === 'default' || group.choices.length === 0) continue
    const provider = group.choices[0]?.provider
    if (!provider) continue
    const remote = execution.modelCatalogHost === 'connected-device' || providerIsRemote(provider)
    const peerId = remote
      ? execution.modelCatalogHost === 'connected-device'
        ? connectedHostExecution?.executionPeerId ?? 'connected-host'
        : provider.provider_peer_id ?? peerIdFromProviderIdentity(provider.provider_id) ?? 'remote'
      : null
    const sourceId = remote ? `source:peer:${peerId}` : 'source:local'
    const existing = sources.get(sourceId)
    if (existing) {
      existing.providerGroups.push(group)
      existing.modelCount += group.choices.length
      continue
    }
    const sourceOrdinal = [...sources.values()].filter((source) => source.scope === 'peer').length + 1
    sources.set(sourceId, {
      id: sourceId,
      heading: remote
        ? execution.modelCatalogHost === 'connected-device'
          ? execution.mode === 'dispatch'
            ? execution.label
            : connectedHostExecution?.label ?? 'Connected Aurora device'
          : execution.mode === 'dispatch' ? 'Selected connected device' : `Connected device ${sourceOrdinal}`
        : 'This device',
      description: remote
        ? execution.mode === 'dispatch'
          ? 'Models allowed for assistant work on the selected connected device.'
          : 'Models shared by a connected Aurora device.'
        : 'Models configured on this Aurora device, grouped by source.',
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
  const [open, setOpen] = useState(true)
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
  const [open, setOpen] = useState(true)
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
        {group.scope === 'connected device' ? <Network aria-hidden /> : <Cpu aria-hidden />}
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
  if (!catalog) return 'automatic'
  const selectedProvider = selectedRuntimeProvider(
    catalog.providers.find((provider) => provider.provider_id === catalog.selected_provider_id) ?? null,
    catalog.providers
  )
  if (!selectedProvider) return 'automatic'
  const selectedModelId = selectedProvider.default_model_id
    ?? selectedProvider.models?.find((model) => model.default)?.model_id
    ?? selectedProvider.model_id
  if (!selectedModelId) return 'automatic'
  return choices.find((choice) =>
    !choice.automatic &&
    choice.provider?.provider_id === selectedProvider.provider_id &&
    choice.runtimeModel?.model_id === selectedModelId
  )?.id ?? 'automatic'
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
  return `model-choice-${stableAssistantChoiceToken(`${providerId}\u001f${modelId}`)}`
}

function stableAssistantChoiceToken(value: string): string {
  let forward = 0x811c9dc5
  let reverse = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    forward = Math.imul(forward ^ value.charCodeAt(index), 0x01000193)
    reverse = Math.imul(reverse ^ value.charCodeAt(value.length - index - 1), 0x01000193)
  }
  return `${(forward >>> 0).toString(36)}-${(reverse >>> 0).toString(36)}`
}

function providerUsableForAssistant(provider: ModelRuntimeProviderInfo): boolean {
  if (!provider.enabled) return false
  return !/unavailable|misconfigured|offline|error|disabled/i.test(provider.health)
}

function providerIsRemote(provider: ModelRuntimeProviderInfo): boolean {
  return /mesh|remote|peer/i.test(`${provider.provider_kind ?? ''}`)
    || /^(?:mesh|remote):/i.test(provider.provider_id)
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

type AssistantModelProviderClass = 'connected' | 'cloud' | 'local'

function assistantModelProviderClass(provider: ModelRuntimeProviderInfo): AssistantModelProviderClass {
  if (providerIsRemote(provider)) return 'connected'
  const trustedClass = `${provider.provider_type ?? ''} ${provider.provider_kind ?? ''} ${provider.backend_kind ?? ''}`.toLowerCase()
  if (/\bcloud\b/.test(trustedClass) || /\b(?:openai|anthropic|google)\b/.test(trustedClass)) return 'cloud'
  return 'local'
}

function assistantModelProviderLabel(providerClass: AssistantModelProviderClass, ordinal: number): string {
  if (providerClass === 'connected') return `Connected device ${ordinal}`
  if (providerClass === 'cloud') return `Cloud service ${ordinal}`
  return `This device ${ordinal}`
}

function assistantModelLabel(
  providerClass: AssistantModelProviderClass,
  providerOrdinal: number,
  modelOrdinal: number
): string {
  if (providerClass === 'connected') return `Connected device model ${providerOrdinal}.${modelOrdinal}`
  if (providerClass === 'cloud') return `Cloud model ${providerOrdinal}.${modelOrdinal}`
  return `Local model ${providerOrdinal}.${modelOrdinal}`
}

function assistantModelDescription(
  providerClass: AssistantModelProviderClass,
  providerLabel: string
): string {
  if (providerClass === 'connected') return `${providerLabel} shares this model for approved assistant work.`
  if (providerClass === 'cloud') return `${providerLabel} can help when your privacy choices allow it.`
  return `${providerLabel} runs on this device.`
}

function assistantModelKeywords(
  providerClass: AssistantModelProviderClass,
  providerOrdinal: number,
  modelOrdinal: number,
  providerLabel: string,
  modelLabel: string
): string[] {
  return [
    providerClass === 'connected' ? 'connected device' : providerClass === 'cloud' ? 'cloud service' : 'local device',
    `choice group ${providerOrdinal}`,
    `model ${modelOrdinal}`,
    providerLabel,
    modelLabel
  ]
}

function safeAssistantCatalogLabel(value: string | null | undefined, fallback: string): string {
  const label = value?.trim()
  if (!label || label.length > 96 || isInternalAssistantLabel(label)) return fallback
  return label
}

function modelCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}

function isRemoteRouteCandidate(candidate: RouteAvailability['candidateProviders'][number]): boolean {
  return /mesh|remote/i.test(`${candidate.providerKind ?? ''} ${candidate.providerId ?? ''} ${candidate.id} ${candidate.serviceInstanceId ?? ''} ${candidate.label}`)
}

function requiresRemoteAudioConsent(route: RouteAvailability): boolean {
  return route.state === 'available-remote' ||
    route.selectorRequired ||
    (route.state !== 'available-local' && route.candidateProviders.some(isRemoteRouteCandidate))
}

function remoteAudioConsentRouteKey(route: RouteAvailability): string {
  const candidateKey = route.candidateProviders
    .filter((candidate) => candidate.selectable || isRemoteRouteCandidate(candidate))
    .map((candidate) => [
      candidate.id,
      candidate.providerId ?? '',
      candidate.peerId ?? '',
      candidate.serviceInstanceId ?? '',
      candidate.state,
      candidate.selectable ? 'selectable' : 'fixed'
    ].join(':'))
    .sort()
    .join('|')
  return [
    route.item.id,
    route.item.capabilityMethod ?? '',
    route.state,
    route.selectorRequired ? 'selector' : 'direct',
    route.providerLabel,
    candidateKey
  ].join('::')
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
  if (/^(?:local|local-peer)$/i.test(readable)) return 'This device'
  return readable || peerId || 'Connected device'
}

function AssistantPrivacyBadge({ privacy }: { privacy: string }) {
  return <Badge variant={assistantPrivacyVariant(privacy)}>{assistantPrivacyClassCopy(privacy)}</Badge>
}

export function assistantPrivacyClassCopy(privacy: string | null | undefined): string {
  switch (privacy) {
    case 'public':
      return 'Public'
    case 'personal':
      return 'Personal'
    case 'sensitive':
      return 'Sensitive'
    case 'secret':
      return 'Private'
    case 'raw-audio':
      return 'Microphone audio'
    case 'credential':
      return 'Credential'
    case 'admin-critical':
      return 'Protected'
    default:
      return 'Sensitive'
  }
}

function assistantPrivacyVariant(privacy: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (privacy === 'admin-critical' || privacy === 'secret' || privacy === 'credential') return 'destructive'
  if (privacy === 'sensitive' || privacy === 'raw-audio') return 'secondary'
  return 'outline'
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
  const label = assistantPrivacyClassCopy(privacyClass)
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
  const currentText = message.text === 'Waiting for Aurora...' || message.text === 'Restoring Aurora’s response...'
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
  placeholder = 'Waiting for Aurora...'
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
    id: message.id,
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
    explanation: 'Voice support is unavailable right now.',
    providerLabel: 'Not available',
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
    label: 'Device voice',
    state,
    privacyClass: 'raw-audio',
    providerLabel: nativeAvailable ? 'This device' : 'Not available',
    detail: state === 'available-local'
      ? 'This device reports microphone or voice capture support.'
      : state === 'privacy-blocked'
        ? nativePlatform.toLowerCase().includes('ios')
          ? 'iOS voice capture is blocked until microphone permission, audio consent, and a visible stop/revoke path are available.'
          : 'Device voice capture is blocked until microphone permission is granted.'
        : 'Device capture stays disabled until Aurora can confirm microphone support.',
    blockers: state === 'available-local' ? [] : [permission && !permission.granted ? 'device_permission_missing' : 'voice_capture_unavailable'],
    evidence: nativeAvailable ? ['device_voice_status'] : []
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
  if (surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop') {
    if (captureStatus === 'no-device') {
      return {
        state: 'unsupported',
        providerLabel: 'Desktop app',
        detail: 'Voice is unavailable in this desktop app.',
        blockers: ['desktop_voice_unavailable']
      }
    }
    if (captureStatus === 'error' || captureStatus === 'permission-denied') {
      return {
        state: captureStatus === 'permission-denied' ? 'denied' : 'degraded',
        providerLabel: 'Desktop app',
        detail: 'Voice could not start. Check this device and try again.',
        blockers: ['desktop_voice_error']
      }
    }
    return {
      state: captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking' ? 'available-local' : 'pending',
      providerLabel: 'Desktop app',
      detail: 'Voice is handled by the desktop app.',
      blockers: []
    }
  }
  if (surfaceProfile.kind === 'desktop-local') {
    return {
      state: captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking' ? 'available-local' : 'pending',
      providerLabel: 'This computer',
      detail: 'This device microphone is ready for focused voice capture.',
      blockers: []
    }
  }
  if (surfaceProfile.isMobile) {
    return {
      state: captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking' ? 'available-local' : 'pending',
      providerLabel: 'This device',
      detail: 'This device microphone is ready while Aurora is open.',
      blockers: []
    }
  }
  if (captureStatus === 'listening') {
    return {
      state: 'available-local',
      providerLabel: 'This device',
      detail: 'This device microphone is active.',
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
      detail: 'Microphone permission was denied.',
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
      detail: 'Microphone capture failed; retry or inspect device settings.',
      blockers: ['browser_microphone_error']
    }
  }
  return {
    state: 'pending',
    providerLabel: 'This device',
    detail: 'Local capture waits for the browser permission prompt.',
    blockers: []
  }
}

function pushToTalkControlState(
  surfaceProfile: AuroraSurfaceProfile,
  browserState: RouteAvailability['state']
): RouteAvailability['state'] {
  if (surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop') return browserState
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
    return 'iOS voice controls stay available only while Aurora is open or started from system shortcuts.'
  }
  if (nativePlatform.toLowerCase().includes('android')) {
    return 'Android voice controls need this device to confirm foreground voice support.'
  }
  if (!wakeControl.disabled) return 'Foreground voice control is available on this device.'
  if (!wakeProcess.disabled) return 'Voice audio can be checked, but hands-free control is unavailable.'
  return 'Hands-free voice control is unavailable right now.'
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
      reason: assistantRouteBlockerCopy(route),
      route
    }
  }
  if ((route.state === 'available-remote' || route.selectorRequired) && !consentGranted) {
    return {
      id,
      label,
      state: 'privacy-blocked',
      enabled: false,
      reason: 'Grant session consent before sharing microphone audio with a connected device.',
      route
    }
  }
  if (route.selectorRequired) {
    return {
      id,
      label,
      state: 'privacy-blocked',
      enabled: false,
      reason: 'Choose a connected voice device before starting speech.',
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
      ? { id: 'permission-loss', label: 'Local permission loss', state: 'denied', detail: 'Microphone permission was lost or denied.' }
      : captureStatus === 'no-device' || captureStatus === 'error'
        ? { id: 'capture-error', label: 'Capture error', state: captureStatus === 'no-device' ? 'unsupported' : 'degraded', detail: 'Local capture failed before audio could be routed.' }
        : null
  const rows = [
    { id: 'partial', label: 'Partial speech text', state: transcription.disabled ? 'unsupported' : 'pending', detail: 'Aurora is listening for more speech.' },
    { id: 'final', label: 'Final speech text', state: transcription.disabled ? 'unsupported' : transcription.state, detail: 'Aurora is ready to use the final speech text.' },
    { id: 'tts-started', label: 'Speech started', state: 'pending', detail: 'Playback starts after Aurora confirms speech has begun.' },
    { id: 'tts-stopped', label: 'Speech stopped', state: 'pending', detail: 'Stop and cancel controls wait for Aurora to finish stopping speech.' },
    { id: 'timeout', label: 'Timeout', state: 'degraded', detail: 'Timeouts remain visible as retryable voice session outcomes.' },
    { id: 'cancelled', label: 'Cancelled', state: 'pending', detail: 'Cancellation must revoke or stop the current audio session.' },
    { id: 'remote-denied', label: 'Connected help denied', state: 'denied', detail: 'A privacy choice or connected device prevented voice help.' },
    { id: 'peer-disconnect', label: 'Connected device offline', state: 'stale', detail: 'A connected device stopped responding.' },
    ...(captureFailure ? [captureFailure] : [])
  ] satisfies VoiceEventRow[]
  return applyVoiceEvidenceRows(rows, voiceEvents)
}

function nativeDesktopVoiceCaptureStatus(phase: NativeDesktopVoicePhase): VoiceCaptureStatus {
  switch (phase) {
    case 'unavailable':
      return 'no-device'
    case 'starting':
    case 'listening':
      return 'listening'
    case 'processing':
      return 'processing'
    case 'speaking':
      return 'speaking'
    case 'faulted':
      return 'error'
    case 'idle':
    case 'stopping':
      return 'idle'
  }
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
  if (event.state === 'denied' || event.state === 'error') return 'Voice needs attention before it can continue.'
  if (event.state === 'disconnected') return 'A connected device stopped responding.'
  if (event.state === 'timeout') return 'Voice took too long; try again.'
  if (event.state === 'cancelled') return 'Voice was cancelled for this session.'
  if (event.kind === 'transcription_partial') return 'Aurora is hearing speech.'
  if (event.kind === 'transcription_final') return 'Aurora received the final speech text.'
  if (event.kind === 'tts_started') return 'Aurora started speaking.'
  if (event.kind === 'tts_stopped' || event.kind === 'tts_paused' || event.kind === 'tts_resumed') return 'Speech playback changed.'
  if (event.kind === 'stt_timeout') return 'Voice took too long; try again.'
  if (event.kind === 'audio_cancelled' || event.kind === 'session_ended') return 'Voice stopped for this session.'
  if (event.kind === 'audio_denied' || event.kind === 'stt_error' || event.kind === 'tts_error') return 'Voice needs attention before it can continue.'
  if (event.kind === 'audio_disconnected') return 'A connected device stopped responding.'
  if (event.state === 'listening') return 'This device is listening.'
  if (event.state === 'processing') return 'Aurora is processing audio.'
  if (event.state === 'speaking') return 'Aurora is speaking.'
  if (event.state === 'paused') return 'Voice is paused.'
  return 'Voice status changed.'
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
    // Focused push-to-talk owns its response locally. Ignore sessionless echoes
    // while a UI capture session is active; background finals carry the owned
    // session id and pass the check above.
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

function browserVoiceRuntimeEventToVoiceEvent(event: BrowserVoiceRuntimeEventSnapshot): VoiceRuntimeEvent {
  const kind = browserVoiceRuntimeEventKind(event.kind)
  return {
    id: `browser-${event.kind}-${event.generation}-${event.sequence ?? 'session'}-${event.occurredAtMs}`,
    kind,
    topic: null,
    sessionId: event.sessionId,
    correlationId: null,
    sourcePeerId: null,
    targetPeerId: null,
    targetDeviceId: null,
    consentDecision: null,
    policyDecisionId: null,
    privacyClass: 'microphone',
    state: browserVoiceRuntimeEventState(event.kind),
    text: null,
    level: null,
    peak: null,
    bars: null,
    reason: event.reason,
    redacted: event.redacted,
    occurredAt: new Date(event.occurredAtMs).toISOString(),
    audit: browserVoiceRuntimeEventAudit(event.kind),
    raw: {
      kind: event.kind,
      sequence: event.sequence,
      generation: event.generation,
      sampleCount: event.sampleCount,
      byteLength: event.byteLength,
      queuedBytes: event.queuedBytes,
      redacted: event.redacted
    }
  }
}

function browserVoiceRuntimeEventKind(kind: string): VoiceRuntimeEvent['kind'] {
  if (kind === 'session_started') return 'session_started'
  if (kind === 'session_stopped' || kind === 'session_cancelled') return 'audio_cancelled'
  if (kind === 'lifecycle_lost') return 'audio_disconnected'
  if (kind === 'frame_dropped' || kind === 'error') return 'stt_error'
  return 'audio_started'
}

function browserVoiceRuntimeEventState(kind: string): VoiceRuntimeEvent['state'] {
  if (kind === 'session_started' || kind === 'frame_accepted' || kind === 'frame_dropped') return 'listening'
  if (kind === 'session_stopped') return 'processing'
  if (kind === 'session_cancelled') return 'cancelled'
  if (kind === 'lifecycle_lost') return 'disconnected'
  if (kind === 'error') return 'error'
  return 'idle'
}

function browserVoiceRuntimeEventAudit(kind: string): VoiceRuntimeEvent['audit'] {
  return {
    correlationId: null,
    eventKind: kind,
    peerId: null,
    principalId: null,
    targetPeerId: null,
    method: null,
    busTopic: null,
    toolId: null,
    resourceId: null,
    status: null,
    transport: 'browser',
    redaction: {
      secretsRedacted: true,
      redactedFields: [],
      source: 'sdk',
      warnings: []
    }
  }
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

function productAudioCaptureErrorCopy(error: unknown): string {
  const code = voiceCaptureErrorCode(error)
  if (code === 'audio_source_permission_denied') {
    return 'Microphone permission was denied.'
  }
  if (code === 'audio_source_no_input_device') {
    return 'No microphone was found on this device.'
  }
  if (code === 'start_cancelled' || code === 'audio_source_start_cancelled') {
    return 'Microphone start was cancelled. Try again.'
  }
  if (
    code === 'audio_source_unavailable' ||
    code === 'audio_source_start_timeout' ||
    code === 'audio_source_suspended' ||
    code === 'audio_source_start_failed' ||
    code === 'start_failed'
  ) {
    return 'Microphone capture failed. Try again.'
  }
  const name = browserErrorName(error)
  if (name) {
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Microphone permission was denied.'
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found on this device.'
    }
    return 'Microphone capture failed. Try again.'
  }
  return 'Microphone capture failed. Try again.'
}

function voiceCaptureStatusForStartError(error: unknown): VoiceCaptureStatus {
  const code = voiceCaptureErrorCode(error)
  if (code === 'audio_source_permission_denied') return 'permission-denied'
  if (code === 'audio_source_no_input_device') return 'no-device'
  if (code === 'start_cancelled' || code === 'audio_source_start_cancelled') return 'idle'
  const name = browserErrorName(error)
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied'
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'no-device'
  return 'error'
}

function voiceCaptureErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function browserErrorName(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return ''
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' ? name : ''
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

function int16PcmToLittleEndianBase64(samples: Int16Array): string {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true)
  }
  return arrayBufferToBase64(buffer)
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
  rows,
  loading,
  error,
  disabled,
  newConversationDisabled,
  onSelectConversation,
  onNewConversation
}: {
  rows: AssistantConversationRow[]
  loading: boolean
  error: string | null
  disabled: boolean
  newConversationDisabled: boolean
  onSelectConversation: (sessionId: string) => void
  onNewConversation: () => void
}) {
  return (
    /* Conversation rail */
    <aside className="aui-conversation-rail" aria-labelledby="assistant-recent-chats-title">
      <h2 id="assistant-recent-chats-title" className="aui-sr-only">Recent chats</h2>
      <header>
        <Button type="button" variant="ghost" size="sm" onClick={onNewConversation} disabled={disabled || loading || newConversationDisabled} aria-label="New conversation" className="aui-thread-new-button">
          <MessageSquarePlus aria-hidden />
          <span>New conversation</span>
        </Button>
      </header>
      <ConversationList
        rows={rows}
        loading={loading}
        error={error}
        disabled={disabled}
        onSelectConversation={onSelectConversation}
      />
    </aside>
  )
}

function MobileConversationSheet({
  open,
  onOpenChange,
  rows,
  loading,
  error,
  disabled,
  newConversationDisabled,
  onSelectConversation,
  onNewConversation,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: AssistantConversationRow[]
  loading: boolean
  error: string | null
  disabled: boolean
  newConversationDisabled: boolean
  onSelectConversation: (sessionId: string) => void
  onNewConversation: () => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger
        render={(
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="aui-mobile-history-trigger"
            aria-label="Open conversations"
          />
        )}
      >
        <History aria-hidden />
        <span>Chats</span>
      </SheetTrigger>
      <SheetContent side="left" className="aui-conversation-sheet">
        <SheetHeader>
          <SheetTitle>Conversations</SheetTitle>
          <SheetDescription>Open a recent chat or start a new one.</SheetDescription>
        </SheetHeader>
        <div className="aui-conversation-sheet-actions">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNewConversation}
            disabled={disabled || loading || newConversationDisabled}
            aria-label="New conversation"
            className="aui-thread-new-button"
          >
            <MessageSquarePlus aria-hidden />
            <span>New conversation</span>
          </Button>
        </div>
        <ConversationList
          rows={rows}
          loading={loading}
          error={error}
          disabled={disabled}
          onSelectConversation={onSelectConversation}
          className="aui-conversation-sheet-list"
        />
      </SheetContent>
    </Sheet>
  )
}

function ConversationList({
  rows,
  loading,
  error,
  disabled,
  onSelectConversation,
  className,
}: {
  rows: AssistantConversationRow[]
  loading: boolean
  error: string | null
  disabled: boolean
  onSelectConversation: (sessionId: string) => void
  className?: string
}) {
  return (
    <ul className={className} aria-label="Assistant conversation list">
      {error ? (
        <li className="empty" role="status">{error}</li>
      ) : loading && rows.length === 0 ? (
        <li className="empty">Loading conversations…</li>
      ) : rows.length === 0 ? (
        <li className="empty">No conversations yet.</li>
      ) : rows.map((row) => (
        <li key={row.id} className={row.active ? 'active' : undefined}>
          <Button type="button" variant="ghost" aria-current={row.active ? 'true' : undefined} disabled={disabled || loading} onClick={() => onSelectConversation(row.id)} className="aui-thread-row-button">
            <strong>{row.title}</strong>
            <span><EvidenceBadge label={row.route} /> <time>{row.updated}</time></span>
          </Button>
        </li>
      ))}
    </ul>
  )
}


function assistantConversationRows(session: AssistantSessionSnapshot, sessions: DBSessionRecord[], transportKind: string): AssistantConversationRow[] {
  if (transportKind === 'mock') {
    return [
      { id: 'draft-launch', title: 'Plan a weekend trip', route: 'This device', updated: '2m ago', active: true },
      { id: 'quarterly', title: 'Summarize a reading list', route: 'Connected device', updated: '1h ago', active: false },
      { id: 'mesh-notes', title: 'Prepare a grocery list', route: 'Connected device', updated: '5h ago', active: false },
      { id: 'journal', title: 'Personal journal reflection', route: 'This device', updated: 'yesterday', active: false }
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

function resolveLocalAssistantHistoryDependencies(
  localAssistant: LightweightAssistantDependencies | null,
  executionHost: AssistantViewProps['executionHost'],
): LocalAssistantHistoryDependencies | null {
  if (executionHost !== 'connected-device') return null
  const localData = localAssistant?.localData
  const envelopeCrypto = localAssistant?.envelopeCrypto
  const scope = localAssistant?.scope
  if (
    !localData
    || typeof localData.conversations?.listConversations !== 'function'
    || typeof localData.conversations?.listMessages !== 'function'
    || !envelopeCrypto
    || typeof envelopeCrypto.decrypt !== 'function'
    || !scope
    || !scope.profileId
    || !scope.localNodeId
  ) return null
  return { localData, envelopeCrypto, scope }
}

async function persistConnectedAssistantTurnToLocalHistory(
  history: LocalAssistantHistoryDependencies,
  input: {
    conversationId: string
    requestId: string
    prompt: string
    response: string | null
    runtime: {
      routeLabel: string
      executionPeerId: string | null
      modelLabel: string | null
      providerLabel: string | null
    } | null
    toolEvents: Array<{
      recordId: string
      card: AssistantToolCallCard
      createdAtMs: number
    }>
    createdAtMs: number
  },
): Promise<void> {
  if (
    history.localData.profileId !== history.scope.profileId
    || history.localData.localNodeId !== history.scope.localNodeId
  ) {
    throw new Error('Local conversation scope does not match the active profile.')
  }

  const userMessageId = `${input.requestId}-local-user`
  const assistantMessageId = `${input.requestId}-connected-assistant`
  const activityCreatedAtMs = Math.max(
    input.createdAtMs,
    ...input.toolEvents.map((event) => event.createdAtMs),
    input.response === null ? input.createdAtMs : Date.now(),
  )
  const [userEnvelope, assistantEnvelope, assistantRuntimeEnvelope, toolRecords] = await Promise.all([
    encryptLocalAssistantText(history, userMessageId, input.prompt),
    input.response === null
      ? Promise.resolve(null)
      : encryptLocalAssistantText(history, assistantMessageId, input.response),
    input.response === null || input.runtime === null
      ? Promise.resolve(null)
      : encryptLocalAssistantMessageRuntime(history, assistantMessageId, input.runtime),
    Promise.all(input.toolEvents.map(async (event): Promise<ConversationMessageRecord> => ({
      id: event.recordId,
      conversationId: input.conversationId,
      sequence: 0,
      role: 'tool',
      contentEnvelope: null,
      toolEnvelope: await encryptLocalAssistantToolCard(history, event.recordId, event.card),
      status: event.card.status === 'failed' ? 'failed' : 'complete',
      createdAtMs: event.createdAtMs,
    }))),
  ])

  await history.localData.transaction(async (repositories) => {
    const existingConversation = (await repositories.conversations.listConversations())
      .find((conversation) => conversation.id === input.conversationId)
    if (
      existingConversation
      && (
        existingConversation.profileId !== history.scope.profileId
        || existingConversation.localNodeId !== history.scope.localNodeId
      )
    ) {
      throw new Error('Local conversation belongs to a different profile.')
    }

    const conversation: ConversationRecord = existingConversation
      ? {
          ...existingConversation,
          updatedAtMs: Math.max(existingConversation.updatedAtMs, activityCreatedAtMs),
        }
      : {
          id: input.conversationId,
          profileId: history.scope.profileId,
          localNodeId: history.scope.localNodeId,
          titleEnvelope: null,
          createdAtMs: input.createdAtMs,
          updatedAtMs: activityCreatedAtMs,
          archivedAtMs: null,
        }
    await repositories.conversations.upsertConversation(conversation)

    const existingMessages = await repositories.conversations.listMessages(input.conversationId)
    let nextSequence = existingMessages.reduce(
      (next, message) => Math.max(next, message.sequence + 1),
      0,
    )
    const records: ConversationMessageRecord[] = [
      {
        id: userMessageId,
        conversationId: input.conversationId,
        sequence: nextSequence,
        role: 'user',
        contentEnvelope: userEnvelope,
        toolEnvelope: null,
        status: 'complete',
        createdAtMs: input.createdAtMs,
      },
      ...toolRecords,
      ...(assistantEnvelope === null ? [] : [{
        id: assistantMessageId,
        conversationId: input.conversationId,
        sequence: 0,
        role: 'assistant' as const,
        contentEnvelope: assistantEnvelope,
        toolEnvelope: assistantRuntimeEnvelope,
        status: 'complete' as const,
        createdAtMs: activityCreatedAtMs,
      }]),
    ]
    const existingIds = new Set(existingMessages.map((message) => message.id))
    for (const record of records) {
      if (existingIds.has(record.id)) continue
      await repositories.conversations.appendMessage({ ...record, sequence: nextSequence })
      nextSequence += 1
    }
  })
}

async function encryptLocalAssistantText(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  text: string,
): Promise<ConversationMessageRecord['contentEnvelope']> {
  return await history.envelopeCrypto.encrypt(
    'local-structured-data',
    new TextEncoder().encode(text),
    buildEnvelopeAad({
      table: 'aurora_messages',
      recordId: messageId,
      field: 'content_envelope_json',
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId,
    }),
  )
}

async function encryptLocalAssistantToolCard(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  card: AssistantToolCallCard,
): Promise<ConversationMessageRecord['toolEnvelope']> {
  const persistedCard: AssistantToolCallCard = {
    ...card,
    localConfirmationToken: null,
    resolving: false,
  }
  return await history.envelopeCrypto.encrypt(
    'local-structured-data',
    new TextEncoder().encode(JSON.stringify({
      assistantToolCall: persistedCard,
      secretsRedacted: true,
    })),
    buildEnvelopeAad({
      table: 'aurora_messages',
      recordId: messageId,
      field: 'tool_envelope_json',
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId,
    }),
  )
}

async function encryptLocalAssistantMessageRuntime(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  runtime: {
    routeLabel: string
    executionPeerId: string | null
    modelLabel: string | null
    providerLabel: string | null
  },
  existingEnvelope: ConversationMessageRecord['toolEnvelope'] = null,
): Promise<ConversationMessageRecord['toolEnvelope']> {
  const existingPayload = await localAssistantToolEnvelopePayload(
    history,
    messageId,
    existingEnvelope,
  )
  return await history.envelopeCrypto.encrypt(
    'local-structured-data',
    new TextEncoder().encode(JSON.stringify({
      ...existingPayload,
      assistantRuntime: runtime,
      secretsRedacted: true,
    })),
    buildEnvelopeAad({
      table: 'aurora_messages',
      recordId: messageId,
      field: 'tool_envelope_json',
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId,
    }),
  )
}

async function persistLatestLocalAssistantRuntime(
  history: LocalAssistantHistoryDependencies,
  input: {
    conversationId: string
    response: string
    runtime: {
      routeLabel: string
      executionPeerId: string | null
      modelLabel: string | null
      providerLabel: string | null
    }
  },
): Promise<void> {
  const messages = await history.localData.conversations.listMessages(input.conversationId)
  const candidates = messages
    .filter((message) => message.role === 'assistant' && message.status === 'complete')
    .reverse()
  let target = candidates[0] ?? null
  for (const candidate of candidates) {
    if (await localAssistantMessageText(history, candidate) === input.response) {
      target = candidate
      break
    }
  }
  if (!target) throw new Error('Completed local assistant message was not saved.')
  const toolEnvelope = await encryptLocalAssistantMessageRuntime(
    history,
    target.id,
    input.runtime,
    target.toolEnvelope,
  )
  await history.localData.transaction(async (repositories) => {
    const current = (await repositories.conversations.listMessages(input.conversationId))
      .find((message) => message.id === target.id)
    if (!current) throw new Error('Completed local assistant message is unavailable.')
    await repositories.conversations.appendMessage({ ...current, toolEnvelope })
  })
}

async function localAssistantToolEnvelopePayload(
  history: LocalAssistantHistoryDependencies,
  messageId: string,
  envelope: ConversationMessageRecord['toolEnvelope'],
): Promise<Record<string, unknown>> {
  if (!envelope) return {}
  try {
    const plaintext = await decryptLocalAssistantText(history, {
      envelope,
      table: 'aurora_messages',
      recordId: messageId,
      field: 'tool_envelope_json',
    })
    const parsed: unknown = JSON.parse(plaintext)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function loadLocalAssistantConversationRows(
  history: LocalAssistantHistoryDependencies,
): Promise<AssistantConversationRow[]> {
  const conversations = createLocalConversations(history.localData)
  const summaries = await conversations.listConversations({
    scope: history.scope,
    includeArchived: false,
    limit: 100,
  })
  return await Promise.all(summaries.map(async (summary) => ({
    id: summary.record.id,
    title: await localAssistantConversationTitle(history, conversations, summary),
    route: 'This device',
    updated: `${formatSessionActivity(new Date(summary.record.updatedAtMs).toISOString())} · ${summary.messageCount} ${summary.messageCount === 1 ? 'message' : 'messages'}`,
    active: false,
  })))
}

async function localAssistantConversationTitle(
  history: LocalAssistantHistoryDependencies,
  conversations: ReturnType<typeof createLocalConversations>,
  summary: LocalConversationSummary,
): Promise<string> {
  if (summary.record.titleEnvelope) {
    const title = await decryptLocalAssistantText(history, {
      envelope: summary.record.titleEnvelope,
      table: 'aurora_conversations',
      recordId: summary.record.id,
      field: 'title_envelope_json',
    })
    if (title.trim()) return conciseConversationTitle(title)
  }
  const messages = await conversations.listMessages({
    scope: history.scope,
    conversationId: summary.record.id,
    limit: 64,
  })
  const firstPrompt = messages.find((message) => message.role === 'user' && message.contentEnvelope)
  if (!firstPrompt?.contentEnvelope) return 'New chat'
  const prompt = await decryptLocalAssistantText(history, {
    envelope: firstPrompt.contentEnvelope,
    table: 'aurora_messages',
    recordId: firstPrompt.id,
    field: 'content_envelope_json',
  })
  return conciseConversationTitle(prompt)
}

async function loadLocalAssistantConversationMessages(
  history: LocalAssistantHistoryDependencies,
  conversationId: string,
): Promise<AssistantUiMessage[]> {
  const conversations = createLocalConversations(history.localData)
  const records = await conversations.listMessages({
    scope: history.scope,
    conversationId,
    limit: 2_000,
  })
  const messages: AssistantUiMessage[] = []
  let pendingToolCards: AssistantToolCallCard[] = []
  let pendingToolCreatedAt: string | null = null
  let pendingToolStatus: AssistantUiMessageStatus = 'sent'
  for (const record of records) {
    if (record.role === 'tool') {
      const tool = await localAssistantToolCallCard(history, record)
      pendingToolCards = upsertAssistantToolCall(pendingToolCards, tool)
      pendingToolCreatedAt = new Date(record.createdAtMs).toISOString()
      pendingToolStatus = localAssistantMessageStatus(record.status)
      continue
    }
    const runtime = record.role === 'assistant'
      ? await localAssistantMessageRuntime(history, record)
      : null
    const message: AssistantUiMessage = {
      id: record.id,
      role: record.role,
      text: await localAssistantMessageText(history, record),
      createdAt: new Date(record.createdAtMs).toISOString(),
      status: localAssistantMessageStatus(record.status),
      routeLabel: runtime?.routeLabel ?? 'This device',
      executionPeerId: runtime?.executionPeerId ?? null,
      modelLabel: runtime?.modelLabel ?? null,
      providerLabel: runtime?.providerLabel ?? null,
    }
    if (record.role === 'assistant' && pendingToolCards.length > 0) {
      message.toolCalls = pendingToolCards
      pendingToolCards = []
      pendingToolCreatedAt = null
      pendingToolStatus = 'sent'
    }
    messages.push(message)
  }
  if (pendingToolCards.length > 0) {
    messages.push({
      id: `local-tool-${pendingToolCards.map((tool) => tool.id).join('-')}`,
      role: 'assistant',
      text: '',
      createdAt: pendingToolCreatedAt ?? new Date().toISOString(),
      status: pendingToolStatus,
      toolCalls: pendingToolCards,
      routeLabel: 'This device',
      executionPeerId: null,
    })
  }
  return messages
}

async function localAssistantMessageRuntime(
  history: LocalAssistantHistoryDependencies,
  record: ConversationMessageRecord,
): Promise<Pick<AssistantUiMessage, 'routeLabel' | 'executionPeerId' | 'modelLabel' | 'providerLabel'> | null> {
  if (record.role !== 'assistant' || !record.toolEnvelope) return null
  let payload: Record<string, unknown>
  try {
    const plaintext = await decryptLocalAssistantText(history, {
      envelope: record.toolEnvelope,
      table: 'aurora_messages',
      recordId: record.id,
      field: 'tool_envelope_json',
    })
    const parsed: unknown = JSON.parse(plaintext)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const runtime = metadataObjectValue(payload, 'assistantRuntime')
  if (!runtime) return null
  return {
    routeLabel: safeAssistantRuntimeValue(metadataStringValue(runtime, 'routeLabel'), null),
    executionPeerId: metadataStringValue(runtime, 'executionPeerId'),
    modelLabel: safeAssistantRuntimeValue(metadataStringValue(runtime, 'modelLabel'), null),
    providerLabel: safeAssistantRuntimeValue(metadataStringValue(runtime, 'providerLabel'), null),
  }
}

async function localAssistantToolCallCard(
  history: LocalAssistantHistoryDependencies,
  record: ConversationMessageRecord,
): Promise<AssistantToolCallCard> {
  let payload: Record<string, unknown> = {}
  if (record.toolEnvelope) {
    const plaintext = await decryptLocalAssistantText(history, {
      envelope: record.toolEnvelope,
      table: 'aurora_messages',
      recordId: record.id,
      field: 'tool_envelope_json',
    })
    try {
      const parsed: unknown = JSON.parse(plaintext)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      payload = {}
    }
  }
  const persistedCard = metadataObjectValue(payload, 'assistantToolCall')
  if (persistedCard && isAssistantToolCallCard(persistedCard)) {
    return {
      ...persistedCard,
      sessionId: record.conversationId,
      localConfirmationToken: null,
      resolving: false,
    }
  }
  const toolCall = metadataObjectValue(payload, 'toolCall') ?? {}
  const route = metadataStringValue(toolCall, 'route')
  const data = payload.data
  const resultPreview = typeof data === 'string'
    ? data
    : typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : data === null || data === undefined
        ? null
        : 'Saved with this chat'
  const status = localAssistantToolCardStatus(record.status)
  const errorCode = metadataStringValue(payload, 'errorCode')
  return {
    id: metadataStringValue(toolCall, 'id') ?? record.id,
    name: metadataStringValue(payload, 'globalToolId')
      ?? metadataStringValue(toolCall, 'toolName')
      ?? 'assistant-action',
    sessionId: record.conversationId,
    status,
    riskClass: 'reviewed',
    target: route === 'remote' ? 'Connected Aurora device' : 'This device',
    dataLeavesDevice: route === 'remote',
    summary: toolSummaryForStatus(status),
    auditId: metadataStringValue(payload, 'correlationId'),
    payloadPreview: metadataObjectValue(toolCall, 'arguments'),
    resultPreview,
    error: status === 'failed' ? errorCode ?? 'action_incomplete' : null,
    errorDetails: null,
    pendingId: null,
    approvalRequestId: null,
    approvalExpiresAt: null,
    policyDecisionId: null,
  }
}

function localAssistantToolCardStatus(
  status: ConversationMessageRecord['status'],
): AssistantToolCallCard['status'] {
  if (status === 'pending') return 'requires_action'
  if (status === 'complete') return 'completed'
  return 'failed'
}

function enrichLatestLocalAssistantMessage(
  messages: AssistantUiMessage[],
  runtime: {
    text: string
    modelLabel: string
    providerLabel: string
    routeLabel: string
  },
): AssistantUiMessage[] {
  const latestAssistantIndex = messages.reduce(
    (latest, message, index) => message.role === 'assistant' ? index : latest,
    -1,
  )
  return messages.map((message, index) => index === latestAssistantIndex
    ? {
        ...message,
        text: runtime.text || message.text,
        modelLabel: runtime.modelLabel,
        providerLabel: runtime.providerLabel,
        routeLabel: runtime.routeLabel,
        executionPeerId: null,
      }
    : message)
}

export function preserveActiveAssistantTurnIds(
  persistedMessages: AssistantUiMessage[],
  currentMessages: AssistantUiMessage[],
  pendingId: string,
): AssistantUiMessage[] {
  const pendingIndex = currentMessages.findIndex((message) => message.id === pendingId)
  if (pendingIndex < 0) return persistedMessages
  const activeUser = currentMessages
    .slice(0, pendingIndex)
    .reverse()
    .find((message) => message.role === 'user')
  const latestAssistantIndex = persistedMessages.reduce(
    (latest, message, index) => message.role === 'assistant' ? index : latest,
    -1,
  )
  if (latestAssistantIndex < 0) return persistedMessages
  const latestUserIndex = persistedMessages.reduce(
    (latest, message, index) => index < latestAssistantIndex && message.role === 'user' ? index : latest,
    -1,
  )
  return persistedMessages.map((message, index) => {
    if (index === latestAssistantIndex) return { ...message, id: pendingId }
    if (activeUser && index === latestUserIndex) return { ...message, id: activeUser.id }
    return message
  })
}

async function localAssistantMessageText(
  history: LocalAssistantHistoryDependencies,
  record: ConversationMessageRecord,
): Promise<string> {
  if (record.contentEnvelope) {
    const content = await decryptLocalAssistantText(history, {
      envelope: record.contentEnvelope,
      table: 'aurora_messages',
      recordId: record.id,
      field: 'content_envelope_json',
    })
    if (content.trim() || record.role !== 'tool') return content
  }
  if (record.role === 'tool') {
    if (record.status === 'pending') return 'This action was waiting for approval.'
    if (record.status === 'failed') return 'This action did not finish.'
    if (record.status === 'cancelled') return 'This action was cancelled.'
    return 'Action completed.'
  }
  if (record.status === 'failed') return 'This response did not finish.'
  if (record.status === 'cancelled' || record.status === 'pending') return 'This response was stopped.'
  return 'Saved message'
}

async function decryptLocalAssistantText(
  history: LocalAssistantHistoryDependencies,
  input: {
    envelope: NonNullable<ConversationMessageRecord['contentEnvelope']>
    table: 'aurora_conversations' | 'aurora_messages'
    recordId: string
    field: 'title_envelope_json' | 'content_envelope_json' | 'tool_envelope_json'
  },
): Promise<string> {
  const plaintext = await history.envelopeCrypto.decrypt(
    input.envelope,
    buildEnvelopeAad({
      table: input.table,
      recordId: input.recordId,
      field: input.field,
      profileId: history.scope.profileId,
      localNodeId: history.scope.localNodeId,
    }),
  )
  return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
}

function conciseConversationTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized) return 'New chat'
  return normalized.length <= 64 ? normalized : `${normalized.slice(0, 61).trimEnd()}…`
}

function localAssistantMessageStatus(
  status: ConversationMessageRecord['status'],
): AssistantUiMessageStatus {
  if (status === 'complete') return 'sent'
  if (status === 'pending') return 'sending'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
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
  const hasMessageText = message.text.trim().length > 0
  const hasToolCards = (message.toolCalls?.length ?? 0) > 0
  const isToolOnlyMessage = hasToolCards && (message.role === 'tool' || (assistant && isAssistantToolOnlyText(message.text)))
  const toolCards = message.toolCalls?.length ? (
    <div className="aui-assistant-tool-cards" aria-label="Assistant tool call cards">
      {message.toolCalls.map((tool) => (
        <AssistantToolCallCardView
          key={tool.id}
          tool={tool}
          onResolveToolApproval={onResolveToolApproval}
        />
      ))}
    </div>
  ) : null
  function copyMessageText() {
    if (typeof navigator !== 'undefined') {
      void navigator.clipboard?.writeText(message.text)
    }
    setCopied(true)
    if (typeof window !== 'undefined') window.setTimeout(() => setCopied(false), 1100)
  }
  if (isToolOnlyMessage && toolCards) {
    return (
      <Message align="start" className={`aui-chat-message aui-chat-tool aui-chat-${message.status}`}>
        <MessageContent className="aui-chat-message-content">
          {toolCards}
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message align={align} className={`aui-chat-message aui-chat-${message.role} aui-chat-${message.status}`}>
      <MessageContent className="aui-chat-message-content">
        <MessageHeader className="aui-chat-message-header">
          <strong>{assistant ? 'Aurora' : messageRoleLabel(message.role)}</strong>
          {assistant ? <span className="aui-chat-runtime">{runtimeLabel}</span> : <span>{message.status}</span>}
          {assistant ? <span className="aui-sr-only">Aurora · {message.status}</span> : null}
        </MessageHeader>
        {assistant ? toolCards : null}
        {hasMessageText ? (
          <Bubble align={align} variant={variant} className="aui-chat-bubble-wrap">
            <BubbleContent className="aui-chat-bubble">
              <p>{message.text}</p>
              {message.sources?.length ? (
                <div className="aui-message-sources"><span>Sources:</span>{message.sources.map((source) => <code key={source}>{source}</code>)}</div>
              ) : null}
            </BubbleContent>
          </Bubble>
        ) : null}
        {assistant && hasMessageText ? (
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

function isAssistantToolOnlyText(value: string): boolean {
  const normalized = value.replace(/\s+/gu, ' ').trim().toLowerCase()
  if (!normalized) return true
  return normalized === 'aurora paused for a tool approval decision.'
    || normalized === 'aurora is using a tool.'
    || normalized === 'aurora is finished using a tool.'
    || normalized === 'aurora is reporting a tool error.'
    || normalized === 'this action was waiting for approval.'
    || normalized === 'this action did not finish.'
    || normalized === 'this action was cancelled.'
    || normalized === 'action completed.'
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
  return /\b(?:mock|transport|fallback|runtime|provider|consumer|hybrid|manifest|schema|protocol|sidecar|thin|signaling|datachannel|gateway|orchestrator|tooling|stt|tts|db)\b/i.test(value)
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

function assistantRouteExplanationCopy(route: RouteAvailability): string {
  if (route.disabled) return assistantRouteBlockerCopy(route)
  if (route.state === 'available-remote') return 'Assistant is available through a connected Aurora device.'
  if (route.state === 'available-local') return 'Assistant is available on this device.'
  if (route.state === 'privacy-blocked') return 'Assistant needs a privacy choice before continuing.'
  if (route.state === 'degraded' || route.state === 'stale') return 'Assistant is available with limited status.'
  return 'Assistant status is unavailable right now.'
}

function assistantRouteBlockerCopy(route: RouteAvailability): string {
  const raw = `${route.state} ${route.blockers.join(' ')} ${route.explanation}`.toLowerCase()
  if (/auth|permission|denied|forbidden/.test(raw)) return 'Review access before continuing'
  if (/privacy|consent|selector/.test(raw)) return 'Make the required privacy choice before continuing'
  if (/offline|timeout|stale|unavailable|unsupported|missing/.test(raw)) return 'This assistant route is unavailable right now'
  return 'This assistant route is unavailable right now'
}

function voiceProviderCopy(value: string | null | undefined): string {
  const raw = (value ?? '').toLowerCase()
  if (!raw || raw === 'not available') return 'Not available'
  if (/remote|peer|mesh|cloud/.test(raw)) return 'Connected Aurora device'
  return 'This device'
}

function voiceDestinationCopy(value: string | null | undefined): string {
  return voiceProviderCopy(value)
}

function voiceChipStatusCopy(chip: VoiceCapabilityChip): string {
  if (chip.state === 'available-local' || chip.state === 'available-remote') return 'Ready'
  if (chip.state === 'privacy-blocked') return 'Privacy choice needed'
  if (chip.state === 'denied') return 'Permission needed'
  if (chip.state === 'pending') return 'Waiting for confirmation'
  if (chip.state === 'degraded' || chip.state === 'stale') return 'Needs attention'
  return 'Unavailable'
}

function voiceControlReasonCopy(control: VoiceControlModel): string {
  if (control.enabled) return 'Ready'
  if (control.reason === 'Choose a connected voice device before starting speech.') return control.reason
  if (control.state === 'privacy-blocked') return 'Grant session consent before sharing audio with another device.'
  if (control.state === 'denied') return 'Permission is needed before continuing.'
  if (control.state === 'pending') return 'Start local capture before creating an audio session.'
  if (control.state === 'degraded' || control.state === 'stale') return 'Audio is temporarily unavailable.'
  return 'Audio can start after this device confirms microphone access.'
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
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'once')}
          >
            Approve once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'session')}
          >
            Session
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'until_expiry')}
          >
            Until expiry
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="aui-action-chip aui-action-approve"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, true, 'always')}
          >
            Always
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="aui-action-chip"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
            onClick={() => onResolveToolApproval?.(tool, false, 'deny_once')}
          >
            Deny once
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="aui-action-chip"
            disabled={tool.resolving || (!tool.pendingId && !tool.approvalRequestId && !tool.localConfirmationToken)}
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

function lightweightConfirmationToolCard(
  confirmation: LightweightConfirmationEvent
): AssistantToolCallCard {
  const prepared = confirmation.prepared
  const toolCall = confirmation.toolCall
  return {
    id: toolCall.id,
    name: prepared.global_tool_id || toolCall.toolName,
    sessionId: confirmation.conversationId,
    status: 'requires_action',
    riskClass: prepared.trust_tier ?? prepared.capability_class ?? 'review required',
    target: toolCall.route === 'local' ? 'This device' : 'Connected Aurora device',
    dataLeavesDevice: toolCall.route === 'remote',
    summary: 'Review this action before Aurora continues.',
    auditId: prepared.correlation_id ?? null,
    payloadPreview: null,
    resultPreview: null,
    error: null,
    pendingId: null,
    approvalRequestId: null,
    approvalExpiresAt: null,
    policyDecisionId: prepared.policy_decision.decision_id ?? null,
    localConfirmationToken: confirmation.token
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
