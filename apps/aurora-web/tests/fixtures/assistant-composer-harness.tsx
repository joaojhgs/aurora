import React, { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AssistantComposer } from '../../../../packages/aurora-ui/src/assistant-composer'
import type {
  AssistantConversationRow,
  AssistantExecutionOption,
  AssistantModelChoice,
  AssistantModelChoiceGroup,
  AssistantModelSourceGroup,
  AssistantVoiceModel,
  VoiceCaptureStatus,
  VoiceControlModel,
} from '../../../../packages/aurora-ui/src/assistant-view'
import type { AssistantRoutePolicy } from '@aurora/client'
import type { RouteAvailability } from '../../../../packages/aurora-ui/src/shell-data'

export const assistantComposerHarnessUsage = 'Register with component harness case=assistant-composer; optional query: handsfree=available|absent|active, voice=idle|listening|speaking|playing, compact=phone|tablet, text=...'

type HandsFreeHarnessState = 'available' | 'absent' | 'active'

const routeableVoiceRoute = routeAvailability('voice-transcription', 'Connected speech', 'Transcription.Transcribe', 'available-local')
const routeableWakeRoute = routeAvailability('voice-wake-control', 'Hands-free voice', 'WakeWord.Control', 'available-local')
const routeableSpeechRoute = routeAvailability('voice-tts-synthesize', 'Spoken replies', 'TTS.Synthesize', 'available-local')

const conversationRows: AssistantConversationRow[] = [
  { id: 'today', title: 'Today', route: 'This device', updated: 'Now', active: true },
  { id: 'earlier', title: 'Earlier request', route: 'This device', updated: '10:15', active: false },
]

const localExecutionOption: AssistantExecutionOption = {
  id: 'local-device',
  mode: 'local',
  runner: 'aurora-route',
  label: 'This device',
  description: 'Runs on this device.',
  routePolicy: harnessRoutePolicy(),
  executionPeerId: null,
  transportHost: true,
  modelCatalogHost: 'this-device',
}

const remoteExecutionOption: AssistantExecutionOption = {
  id: 'home-device',
  mode: 'dispatch',
  runner: 'aurora-route',
  label: 'Home device',
  description: 'Runs on a connected device.',
  routePolicy: harnessRoutePolicy(),
  executionPeerId: 'home-device',
  transportHost: false,
  modelCatalogHost: 'connected-device',
}

const executionOptions: AssistantExecutionOption[] = [localExecutionOption, remoteExecutionOption]

const localModelChoice: AssistantModelChoice = {
  id: 'aurora-small',
  model: {
    id: 'aurora-small',
    name: 'Aurora Small',
    description: 'Deterministic harness model',
  },
  provider: null,
  runtimeModel: null,
  automatic: true,
}

const modelChoices: AssistantModelChoice[] = [localModelChoice]
const modelChoiceGroups: AssistantModelChoiceGroup[] = [
  {
    id: 'default',
    heading: 'Available models',
    choices: modelChoices,
    scope: 'default',
  },
]
const modelSourceGroups: AssistantModelSourceGroup[] = []

export function AssistantComposerHarness() {
  const search = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
  const handsFreeState = parseHandsFreeState(search.get('handsfree') ?? search.get('hands-free'))
  const voiceStatus = parseVoiceStatus(search.get('voice'))
  const compact = search.get('compact')
  const compactFrameWidth = compact === 'phone' ? '390px' : compact === 'tablet' ? '768px' : '100%'
  const [text, setText] = useState(search.get('text') ?? 'Check the composer controls')
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false)
  const [selectedExecutionId, setSelectedExecutionId] = useState(localExecutionOption.id)
  const [selectedModelId, setSelectedModelId] = useState(localModelChoice.id)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
  const voiceModel = useMemo(() => assistantVoiceModel(voiceStatus), [voiceStatus])
  const handsFreeControl = handsFreeState === 'absent' ? undefined : handsFreeVoiceControl(handsFreeState === 'active')
  const selectedExecution = executionOptions.find((option) => option.id === selectedExecutionId) ?? localExecutionOption
  const selectedModelChoice = modelChoices.find((choice) => choice.id === selectedModelId) ?? localModelChoice

  useEffect(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.dataset.auroraSurface = 'desktop-local'
    document.body.dataset.auroraSurface = 'desktop-local'
    document.documentElement.toggleAttribute('data-aurora-debug-compact', compact === 'phone' || compact === 'tablet')
    if (compact === 'phone' || compact === 'tablet') document.documentElement.dataset.auroraDebugCompact = compact
    else delete document.documentElement.dataset.auroraDebugCompact
  }, [compact])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) event.preventDefault()
  }

  return (
    <section
      aria-label="Assistant composer harness"
      data-assistant-composer-harness="true"
      data-hands-free-state={handsFreeState}
      data-voice-state={voiceStatus}
      style={{
        minHeight: '100dvh',
        display: 'grid',
        alignContent: 'end',
        background: 'var(--aui-bg, #05070a)',
        color: 'var(--aui-ink, #f8fafc)',
      }}
    >
      <div
        className="aurora-debug-viewport-frame"
        data-fixture-viewport="assistant-composer"
        style={{ width: compactFrameWidth, maxWidth: '100%', minWidth: 0, justifySelf: 'center' }}
      >
        <div className="aui-assistant" style={{ minHeight: 0 }}>
          <AssistantComposer
            onSubmit={handleSubmit}
            voiceCaptureStatus={voiceStatus}
            mobileHistoryOpen={mobileHistoryOpen}
            onMobileHistoryOpenChange={setMobileHistoryOpen}
            conversationRows={conversationRows}
            conversationHasMore={false}
            conversationPageLoading={false}
            conversationPageError={null}
            onLoadMoreConversations={() => undefined}
            sessionIndexLoading={false}
            sessionIndexError={null}
            conversationDisabled={false}
            newConversationDisabled={false}
            onSelectConversation={() => undefined}
            onNewConversation={() => undefined}
            executionOptions={executionOptions}
            selectedExecution={selectedExecution}
            onExecutionOptionChange={setSelectedExecutionId}
            modelChoices={modelChoices}
            selectedModelChoice={selectedModelChoice}
            onModelChoiceChange={setSelectedModelId}
            modelCatalogError={null}
            modelCatalogLoading={false}
            modelSearchQuery=""
            onModelSearchQueryChange={() => undefined}
            modelChoiceGroups={modelChoiceGroups}
            modelSourceGroups={modelSourceGroups}
            attachments={[]}
            contextSummary={{ ready: 0, blocked: 0 }}
            attachmentInputRef={attachmentInputRef}
            attachmentPickerAccept="image/*,text/plain"
            canAttach
            onFileInput={() => undefined}
            onRemoveAttachment={() => undefined}
            onOpenAttachmentPicker={() => undefined}
            connectedVoiceAccessGranted
            remoteAudioConsentPending={false}
            onToggleRemoteAudioConsent={() => undefined}
            textAreaRef={textAreaRef}
            text={text}
            onTextChange={setText}
            onComposerKeyDown={handleKeyDown}
            canSend
            routeDisabled={false}
            voiceModel={voiceModel}
            voiceElapsedSeconds={voiceStatus === 'listening' ? 42 : 0}
            nativeMobileBackgroundOwnsMicrophone={false}
            onRequestVoiceToggle={() => undefined}
            voiceCaptureButtonLabel={voiceStatus === 'listening' ? 'Stop listening' : 'Push to talk'}
            usesNativeDesktopVoice={handsFreeState !== 'absent'}
            handsFreeControl={handsFreeControl}
            handsFreeActive={handsFreeState === 'active'}
            onToggleNativeDesktopBackgroundWake={async () => true}
            primaryComposerAction="send"
            primaryComposerDisabled={false}
            primaryComposerAriaLabel="Send message"
            primaryComposerLabel="Send"
            onPrimaryComposerAction={() => undefined}
            lastError={null}
          />
        </div>
      </div>
    </section>
  )
}

export default AssistantComposerHarness

function parseHandsFreeState(value: string | null): HandsFreeHarnessState {
  if (value === 'absent' || value === 'off' || value === 'none') return 'absent'
  if (value === 'active' || value === 'on') return 'active'
  return 'available'
}

function parseVoiceStatus(value: string | null): VoiceCaptureStatus {
  if (value === 'playing') return 'speaking'
  if (value === 'listening' || value === 'processing' || value === 'speaking' || value === 'permission-denied' || value === 'no-device' || value === 'error') return value
  return 'idle'
}

function assistantVoiceModel(captureStatus: VoiceCaptureStatus): AssistantVoiceModel {
  return {
    captureStatus,
    consentGranted: true,
    privacyClass: 'raw-audio',
    retentionPolicy: 'Only while this harness is open.',
    sessionTtl: 'Harness session.',
    transport: 'component-harness',
    platformTruth: 'Harness microphone state is deterministic.',
    visualizerSourceLabel: 'Harness microphone',
    targetLabel: 'This device',
    chips: [],
    controls: [
      {
        id: 'push-to-talk',
        label: captureStatus === 'listening' ? 'Stop listening' : 'Push to talk',
        state: 'available-local',
        enabled: true,
        reason: 'Harness push-to-talk control is available.',
        route: null,
      },
      handsFreeVoiceControl(false),
    ],
    events: [],
    routeSheetRoute: routeableVoiceRoute,
    remoteAudioRoute: routeableVoiceRoute,
    transcriptionRoute: routeableVoiceRoute,
    speechRoute: routeableSpeechRoute,
    waveformBars: Array.from({ length: 64 }, (_, index) => 18 + ((index * 13) % 58)),
  }
}

function handsFreeVoiceControl(active: boolean): VoiceControlModel {
  return {
    id: 'background-wake',
    label: active ? 'Stop hands-free' : 'Hands-free',
    state: 'available-local',
    enabled: true,
    reason: 'Hands-free voice is available in this harness.',
    route: routeableWakeRoute,
  }
}

function harnessRoutePolicy(): AssistantRoutePolicy {
  return {
    providerId: 'local-device',
    peerId: null,
    serviceInstanceId: 'aurora-local',
    routeState: 'available-local',
    fallbackBehavior: 'none',
    privacyClass: 'personal',
    selectorRequired: false,
    approvalRequired: false,
  }
}

function routeAvailability(id: string, label: string, path: string, state: RouteAvailability['state']): RouteAvailability {
  const disabled = state === 'unsupported' || state === 'offline' || state === 'privacy-blocked' || state === 'denied'
  return {
    item: {
      id,
      label,
      href: `/harness/${id}`,
      capabilityModule: path.includes('.') ? path.split('.')[0] ?? 'Harness' : 'Harness',
      capabilityMethod: path,
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: state,
      expectedTask: `${label} route for the assistant composer harness.`,
    },
    state,
    explanation: disabled ? `${label} is unavailable in this harness.` : `${label} is available in this harness.`,
    providerLabel: 'This device',
    blockers: disabled ? ['harness_unavailable'] : [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['assistant-composer-harness'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: !disabled,
    disabled,
    requiresAdminAction: false,
  }
}
