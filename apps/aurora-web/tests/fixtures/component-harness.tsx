import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuroraClient, MockAuroraTransport, type RoutePolicyEvaluation } from '@aurora/client'
import { RoutePolicyView, RouteSheet, routePolicyScenarios, type RoutePolicyScenarioId, type RoutePolicySnapshot } from '@aurora/ui'
import { ManagedVoicesSection, type ManagedVoiceConfirmation, type ManagedVoiceRow } from '../../../../packages/aurora-ui/src/voice-settings-managed-voices-section'
import { AudioRecorderVisualizer } from '../../../../packages/aurora-ui/src/audio-recorder-visualizer'
import { Button } from '@aurora/ui/primitives'
import { Button as PopoverButton } from '@aurora/ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@aurora/ui/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@aurora/ui/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@aurora/ui/components/ui/sheet'
import { AssistantComposerHarness } from './assistant-composer-harness'
import { Per277AssistantHarness } from './per277-assistant-harness'
import { ToolFallbackArgs, ToolFallbackResult, ToolFallbackError } from '../../../../packages/aurora-ui/src/components/assistant-ui/tool-fallback'
import { AssistantOlderMessagesControl } from '../../../../packages/aurora-ui/src/assistant-view-shell'
import { MessageScroller, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '../../../../packages/aurora-ui/src/components/ui/message-scroller'

const client = new AuroraClient({ transport: new MockAuroraTransport() })
const loadingClient = new AuroraClient({ transport: new MockAuroraTransport() })
loadingClient.routes.evaluatePolicy = () => new Promise<RoutePolicyEvaluation>(() => undefined)
const approvalScope = { scope: 'session', decision: 'approve' } as const
const localCandidate = {
  provider_id: 'local-device',
  peer_id: '',
  provider_kind: 'local',
  service_instance_id: 'aurora-local',
  module: 'orchestrator',
  version: '1.0.0',
  included: true,
  selected: true,
  reason_code: 'local_preferred',
  reason: 'Runs on this device.',
  latency_ms: 8,
  active_calls: 0,
  max_concurrent: 4,
  available_capacity: 4,
  blockers: [],
}
const meshCandidate = {
  provider_id: 'home-peer',
  peer_id: 'home-peer-1',
  provider_kind: 'mesh',
  service_instance_id: 'aurora-home',
  module: 'orchestrator',
  version: '1.0.0',
  included: true,
  selected: false,
  reason_code: 'mesh_authorized',
  reason: 'Authorized home peer is available.',
  latency_ms: 24,
  active_calls: 1,
  max_concurrent: 4,
  available_capacity: 3,
  blockers: [],
}
const routeEvaluation = {
  decision: 'allowed',
  allowed: true,
  availability: 'available-local',
  reasonCode: 'policy_allowed',
  repairPath: null,
  privacyClass: 'personal',
  dataClasses: ['personal'],
  explicitSelectorRequired: true,
  approval: {
    required: false,
    status: 'not-required',
    scopes: [approvalScope],
    matchedScope: approvalScope,
  },
  route: {
    topic: 'Orchestrator.Chat',
    module: 'orchestrator',
    selected_target: 'local-device',
    selected_peer_id: null,
    selected_service_instance_id: 'aurora-local',
    selected_provider_id: 'local-device',
    selector_valid: true,
    selector_validation_code: 'valid',
    selector_validation_message: 'Selection available.',
    fallback_behavior: 'none',
    candidates: [localCandidate, meshCandidate],
    blockers: [],
    security_privacy_blockers: [],
    secrets_redacted: true,
  },
  selectedCandidate: localCandidate,
  blockers: [],
  preview: {
    topic: 'Orchestrator.Chat',
    module: 'orchestrator',
    method: 'Orchestrator.Chat',
    providerId: 'local-device',
    peerId: null,
    serviceInstanceId: 'aurora-local',
    providerKind: 'local',
    trustTier: 'trusted-device',
    transport: 'local',
    fallbackBehavior: 'none',
    egressDestination: 'local',
    expectedPersistence: 'local-audit',
    auditReceiptTarget: 'local-audit',
    dataClasses: ['personal'],
    privacyClass: 'personal',
    selector: { target: 'local-device' },
    payloadPreview: { prompt: '[hidden]' },
    secretsRedacted: true,
    blockers: [],
  },
} satisfies RoutePolicyEvaluation

function ComponentHarness() {
  const search = new URLSearchParams(window.location.search)
  const harnessCase = search.get('case') ?? 'route-sheet'
  document.documentElement.classList.toggle('dark', search.get('theme') !== 'light')
  document.documentElement.dataset.auroraSurface = search.get('surface') ?? 'web'
  document.body.dataset.auroraSurface = search.get('surface') ?? 'web'

  if (harnessCase === 'assistant-composer') return <AssistantComposerHarness />

  return (
    <main className="visual-harness-shell" data-aurora-ui-visual-component-harness={harnessCase}>
      <div className="visual-harness-panel">
        {harnessCase === 'route-sheet' ? <RouteSheetHarness /> : null}
        {harnessCase === 'route-sheet-loading' ? <RouteSheet client={loadingClient} title="Route and privacy" /> : null}
        {harnessCase === 'tool-details' ? <ToolDetailsHarness /> : null}
        {harnessCase === 'route-policy' ? <RoutePolicyHarness /> : null}
        {harnessCase === 'audio-recorder' ? <AudioRecorderHarness /> : null}
        {harnessCase === 'managed-voices-confirmation' ? <ManagedVoicesConfirmationHarness confirmationOpen /> : null}
        {harnessCase === 'managed-voices-populated' ? <ManagedVoicesConfirmationHarness confirmationOpen={false} /> : null}
        {harnessCase === 'dialog-open' ? <DialogHarness /> : null}
        {harnessCase === 'sheet-open' ? <SheetHarness /> : null}
        {harnessCase === 'popover-open' ? <PopoverHarness /> : null}
        {harnessCase === 'playwright-threshold' ? <ThresholdHarness /> : null}
        {harnessCase === 'per277-assistant-stream' || harnessCase === 'per277-local-history' ? <Per277AssistantHarness caseName={harnessCase} /> : null}
        {harnessCase === 'history-scroller' ? <HistoryScrollerHarness /> : null}
      </div>
    </main>
  )
}

function HistoryScrollerHarness() {
  const [scope, setScope] = useState('scope-a')
  const [conversation, setConversation] = useState('conversation-a')
  const [messages, setMessages] = useState(() => Array.from({ length: 12 }, (_, index) => ({ id: `${conversation}-message-${index}`, height: 72 })))
  const [hasMore, setHasMore] = useState(true)
  const [loadState, setLoadState] = useState<'idle' | 'pending' | 'settled'>('idle')
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const loadRequestRef = React.useRef(0)
  const loadOlder = async () => {
    const requestId = ++loadRequestRef.current
    const scopeAtLoad = scope
    const conversationAtLoad = conversation
    setLoadState('pending')
    await new Promise((resolve) => window.setTimeout(resolve, 80))
    if (requestId !== loadRequestRef.current || scopeAtLoad !== scope || conversationAtLoad !== conversation) {
      setLoadState('settled')
      return
    }
    setMessages((current) => [...Array.from({ length: 8 }, (_, index) => ({ id: `${conversationAtLoad}-older-${index}`, height: 72 })), ...current])
    setHasMore(false)
    setLoadState('settled')
  }
  const switchScope = () => { loadRequestRef.current += 1; setScope(scope === 'scope-a' ? 'scope-b' : 'scope-a'); setLoadState('idle') }
  const switchConversation = () => { loadRequestRef.current += 1; const next = conversation === 'conversation-a' ? 'conversation-b' : 'conversation-a'; setConversation(next); setScope(scope === 'scope-a' ? 'scope-b' : 'scope-a'); setMessages(Array.from({ length: 12 }, (_, index) => ({ id: `${next}-message-${index}`, height: 72 }))); setHasMore(true); setLoadState('idle') }
  const grow = () => setMessages((current) => current.map((message, index) => index === 0 ? { ...message, height: 240 } : message))
  const append = () => setMessages((current) => [...current, { id: `${conversation}-appended-${current.length}`, height: 72 }])
  return <section data-history-scroller-fixture data-history-load-state={loadState}><button type="button" data-history-switch-scope onClick={switchScope}>Switch scope</button><button type="button" data-history-switch-conversation onClick={switchConversation}>Switch conversation</button><button type="button" data-history-grow onClick={grow}>Grow delayed row</button><button type="button" data-history-append onClick={append}>Append message</button><MessageScrollerProvider autoScroll><MessageScroller data-aurora-part="assistant-thread" aria-label="Assistant conversation thread"><MessageScrollerViewport ref={viewportRef} style={{ height: 420, overflowY: 'auto', overflowAnchor: 'none' }}><AssistantOlderMessagesControl viewportRef={viewportRef} conversationId={conversation} streamScopeId={scope} historyScopeKey={scope} hasMore={hasMore} loading={loadState === 'pending'} error={null} onLoad={loadOlder} /><MessageScrollerContent>{messages.map((message) => <MessageScrollerItem key={message.id} messageId={message.id} style={{ height: message.height }}><div style={{ height: '100%' }}>{message.id}</div></MessageScrollerItem>)}</MessageScrollerContent></MessageScrollerViewport></MessageScroller></MessageScrollerProvider></section>
}

function ManagedVoicesConfirmationHarness({ confirmationOpen }: { confirmationOpen: boolean }) {
  const profile: ManagedVoiceRow = { voiceId: 'aurora-en-us', label: 'Aurora English', detail: 'English (US) · 48 kHz · 42 MB', ready: true, installable: false, canDelete: true, canExport: true, canRemove: false, canSetDefault: true, badge: 'Ready' }
  const confirmation: ManagedVoiceConfirmation = { kind: 'delete', profile }
  return <section aria-labelledby="managed-voices-fixture-title"><h1 id="managed-voices-fixture-title">Voices available to Aurora</h1><ManagedVoicesSection
    adminReason="Refreshing the spoken reply voice"
    adminReasonValueLength={34}
    adminReviewConfirmed
    adminActionReady
    actionPending={false}
    managementState="ready"
    managedProfiles={[profile]}
    canShowInstall
    canTransferCloneVoices={false}
    installingVoiceId={null}
    pendingActionKey={null}
    confirmAction={confirmationOpen ? confirmation : null}
    importFileInputRef={{ current: null }}
    onAdminReasonChange={() => undefined}
    onAdminReviewConfirmedChange={() => undefined}
    onLoadManagedProfiles={() => undefined}
    onSetDefaultProfile={() => undefined}
    onInstallProfile={() => undefined}
    onRequestConfirmation={() => undefined}
    onExportCloneVoice={() => undefined}
    onImportCloneVoice={() => undefined}
    onImportFileChange={() => undefined}
    onRunConfirmedAction={() => undefined}
  /></section>
}

function RoutePolicyHarness() {
  const [selectedScenarioId, setSelectedScenarioId] = useState<RoutePolicyScenarioId>('assistant_prompt')
  const evaluation: RoutePolicyEvaluation = {
    ...routeEvaluation,
    route: {
      ...routeEvaluation.route,
      candidates: [localCandidate, meshCandidate, {
        ...meshCandidate,
        provider_id: 'unavailable-shared-device',
        peer_id: 'unavailable-shared-device',
        included: false,
        reason_code: 'device_offline',
        reason: 'This device is offline.',
        blockers: [{
          code: 'device_offline',
          message: 'This shared device is unavailable. Check that it is connected, then choose it again.',
          severity: 'error',
          provider_id: 'unavailable-shared-device',
          peer_id: 'unavailable-shared-device',
          security_privacy: false,
        }],
      }],
    },
  }
  const snapshot: RoutePolicySnapshot = {
    loadState: 'degraded',
    generatedAt: null,
    secretsRedacted: true,
    routeState: 'available-local',
    routeReason: 'This device is ready.',
    policyCapabilityState: 'available-local',
    policyCapabilityReason: 'Choose where Aurora runs each task.',
    configCapabilityState: 'available-local',
    configCapabilityReason: 'Settings are available.',
    canEditPolicy: false,
    scenarios: routePolicyScenarios().map((scenario) => ({
      scenario,
      state: scenario.id === 'admin_action' ? 'denied' : 'available-local',
      evaluation,
      error: null,
    })),
    selectedScenarioId,
    persistedReceipt: null,
    error: null,
    warnings: ['One of your shared devices is offline. Choose another device to continue.'],
    evidenceSource: 'visual-fixture',
  }
  return <RoutePolicyView snapshot={snapshot} onSelectScenario={setSelectedScenarioId} />
}

function AudioRecorderHarness() {
  const bars = Array.from({ length: 96 }, (_, index) => 12 + (index * 17) % 75)
  const noop = () => undefined
  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <h1>Voice recorder states</h1>
      <AudioRecorderVisualizer status="idle" onToggle={noop} onReset={noop} onSend={noop} />
      <AudioRecorderVisualizer status="listening" bars={bars} elapsedSeconds={83} variant="panel" sourceLabel="Microphone" onToggle={noop} onReset={noop} onSend={noop} />
      <AudioRecorderVisualizer status="permission-denied" disabled onToggle={noop} onReset={noop} onSend={noop} />
      <div style={{ position: 'static', gridColumn: '1 / -1', gridRow: 2, minWidth: 0, width: '100%', alignSelf: 'stretch', transform: 'none', pointerEvents: 'none', zIndex: 2, animation: 'aui-composer-recorder-in 0.16s ease-out' }}>
        <AudioRecorderVisualizer status="speaking" bars={bars} elapsedSeconds={12} variant="composer" className="min-h-9 w-full" onToggle={noop} onReset={noop} onSend={noop} />
      </div>
    </section>
  )
}

function RouteSheetHarness() {
  return (
    <>
      <h1 className="aui-sr-only">Route sheet visual harness</h1>
      <RouteSheet
        client={client}
        title="Route and privacy"
        description="Review the selected destination before Aurora continues."
        initialEvaluation={routeEvaluation}
        defaultScope="session"
        adminActionState="confirmed"
        consentGranted
        privacyIndicatorShown
        allowCloudFallback={false}
      />
    </>
  )
}

function ToolDetailsHarness() {
  return (
    <section style={{ display: 'grid', gap: 24 }}>
      <h1>Tool request and result</h1>
      <ToolFallbackArgs argsText={'{\n  "query": "Tomorrow’s appointments"\n}'} />
      <ToolFallbackResult result={{ appointments: [{ title: 'Team meeting', time: '10:00' }], saved: true }} />
      <ToolFallbackError status={{ type: 'incomplete', reason: 'error', error: 'This device is unavailable. Reconnect it and try again.' }} />
    </section>
  )
}

function DialogHarness() {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connection choice</DialogTitle>
          <DialogDescription>Production dialog primitives in their open state.</DialogDescription>
        </DialogHeader>
        <Button>Keep selection</Button>
      </DialogContent>
    </Dialog>
  )
}

function SheetHarness() {
  return (
    <Sheet open>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Production sheet primitives in their open state.</SheetDescription>
        </SheetHeader>
        <nav className="mt-4 grid gap-2 text-sm" aria-label="Harness navigation">
          <a href="#assistant">Assistant</a>
          <a href="#settings">Settings</a>
          <a href="#devices">Devices</a>
        </nav>
      </SheetContent>
    </Sheet>
  )
}

function PopoverHarness() {
  return (
    <section className="grid gap-6" aria-labelledby="popover-harness-title">
      <h1 id="popover-harness-title" className="text-xl font-semibold tracking-tight">Open component popover</h1>
      <Popover open triggerId="popover-harness-trigger">
        <PopoverTrigger id="popover-harness-trigger" className="mx-auto" render={<PopoverButton variant="outline"><span>Open choice</span></PopoverButton>} />
        <PopoverContent align="start">
          <p className="text-sm font-medium">Model choice</p>
          <p className="text-xs text-muted-foreground">Production popover primitives in their open state.</p>
        </PopoverContent>
      </Popover>
    </section>
  )
}

function ThresholdHarness() {
  return (
    <section aria-labelledby="threshold-harness-title" className="grid min-h-[260px] place-items-center">
      <h1 id="threshold-harness-title" className="aui-sr-only">Playwright threshold visual harness</h1>
      <div className="visual-threshold-target" data-visual-threshold-target>
        <span>Stable production-layout target</span>
      </div>
    </section>
  )
}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing component harness root')
createRoot(rootElement).render(<ComponentHarness />)
