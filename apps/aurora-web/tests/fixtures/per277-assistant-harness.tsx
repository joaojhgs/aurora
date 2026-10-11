import React, { Profiler, useEffect, useMemo, useState } from 'react'
import { AuroraClient, MockAuroraTransport, ORCHESTRATOR_METHODS, type AuroraEvent } from '@aurora/client'
import {
  buildEnvelopeAad,
  MemoryLocalDataBackend,
  type ConversationMessageRecord,
  type ConversationRecord,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataBackend,
  type LocalDataSession,
} from '@aurora/client/local-data'
import { AssistantView, getAuroraSurfaceProfile, type RouteAvailability } from '@aurora/ui'
import { BrowserIndexedDbLocalDataBackend } from '@aurora/ui/local-data/browser'
import type { LightweightAssistantDependencies } from '@aurora/ui/local-assistant'

const DEFAULT_CHUNK_COUNT = 140
const DEFAULT_HISTORY_COUNT = 120
const STREAM_PROMPT = 'Run the PER-277 assistant stream measurement.'
const PROFILE_ID_PATTERN = /[^a-zA-Z0-9_.:-]+/gu
type Per277HistoryBackendKind = 'indexeddb' | 'memory'
const cleanedSeededHistories = new WeakSet<SeededHistory>()

export interface Per277AssistantMeasurementState {
  caseName: 'per277-assistant-stream' | 'per277-local-history'
  runId: string
  backendKind: string
  seedDurationMs: number | null
  mountedAt: number
  submittedAt: number | null
  firstVisibleAt: number | null
  finalVisibleAt: number | null
  finalText: string | null
  visibleDeltaCount: number
  expectedDeltaCount: number
  historyListVisibleAt: number | null
  historyFirstOpenVisibleAt: number | null
  historyAppendCompleteAt: number | null
  cleanupState: 'pending' | 'complete' | 'failed'
  cleanupError: string | null
  cleanupCompletedAt: number | null
  longTasks: Per277LongTask[]
  marks: Per277Mark[]
}

interface Per277LongTask {
  name: string
  startTime: number
  duration: number
}

interface Per277Mark {
  name: string
  startTime: number
}

declare global {
  interface Window {
    __PER277_ASSISTANT_MEASUREMENT__?: Per277AssistantMeasurementState
    __PER277_ASSISTANT_READY__?: boolean
    __PER277_ASSISTANT_SUBMIT__?: (() => Promise<void>) | undefined
    __PER277_HISTORY_OPEN_FIRST__?: (() => Promise<void>) | undefined
    __PER277_ASSISTANT_CLEANUP__?: (() => Promise<Per277CleanupResult>) | undefined
  }
}

export function Per277AssistantHarness({ caseName }: { caseName: string }) {
  const normalizedCase = caseName === 'per277-local-history' ? 'per277-local-history' : 'per277-assistant-stream'
  const search = new URLSearchParams(window.location.search)
  const runId = stableRunId(search.get('runId') ?? search.get('run_id'))
  const chunkCount = positiveInt(search.get('chunkCount') ?? search.get('chunk-count'), DEFAULT_CHUNK_COUNT)
  const historyCount = positiveInt(search.get('historyCount') ?? search.get('history-count'), DEFAULT_HISTORY_COUNT)
  const historyBackend = historyBackendKind(search.get('historyBackend') ?? search.get('history-backend'))

  document.documentElement.classList.toggle('dark', search.get('theme') !== 'light')
  document.documentElement.dataset.auroraSurface = search.get('surface') ?? search.get('aurora-surface') ?? 'android'
  document.body.dataset.auroraSurface = search.get('surface') ?? search.get('aurora-surface') ?? 'android'

  useEffect(() => initializeMeasurementState(normalizedCase, runId, chunkCount), [chunkCount, normalizedCase, runId])

  return normalizedCase === 'per277-local-history'
    ? <Per277LocalHistoryHarness runId={runId} historyCount={historyCount} historyBackend={historyBackend} />
    : <Per277AssistantStreamHarness runId={runId} chunkCount={chunkCount} />
}

function Per277AssistantStreamHarness({ runId, chunkCount }: { runId: string; chunkCount: number }) {
  const client = useMemo(() => createStreamingClient(chunkCount), [chunkCount])
  useAssistantDomObserver({ finalText: `chunk-${chunkCount}` })
  useSubmitBridge(STREAM_PROMPT)

  return (
    <Profiler id="per277.assistant-view" onRender={recordPer277ProfilerCommit}>
      <AssistantView
        client={client}
        route={assistantRoute()}
        storageKey={`per277-assistant-stream-${runId}`}
        executionHost="this-device"
        runtimeHealth={runtimeHealth('PER-277 stream')}
        surfaceProfile={surfaceProfile()}
      />
    </Profiler>
  )
}

function Per277LocalHistoryHarness({
  runId,
  historyCount,
  historyBackend,
}: {
  runId: string
  historyCount: number
  historyBackend: Per277HistoryBackendKind
}) {
  const profileId = `per277-profile-${runId}`
  const localNodeId = `per277-node-${runId}`
  const [seeded, setSeeded] = useState<SeededHistory | null>(null)
  const firstConversationId = seeded?.firstConversationId ?? null
  useAssistantDomObserver({ finalText: 'PER-277 history append response' })
  useHistoryOpenBridge(firstConversationId)
  useSubmitBridge('Append one local history turn for PER-277.')

  useEffect(() => {
    let cancelled = false
    const seedStartedAt = performance.now()
    mark('per277-history-seed-start')
    void seedLocalHistory(profileId, localNodeId, historyCount, historyBackend, runId).then((nextSeeded) => {
      if (cancelled) {
        void cleanupSeededHistory(nextSeeded).catch(() => undefined)
        return
      }
      mark('per277-history-seed-complete')
      mutateMeasurement((state) => {
        state.backendKind = nextSeeded.provenance
        state.seedDurationMs = performance.now() - seedStartedAt
      })
      setSeeded(nextSeeded)
    })
    return () => {
      cancelled = true
      void cleanupSeededHistory(seeded).catch(() => undefined)
    }
  }, [historyBackend, historyCount, localNodeId, profileId, runId])

  useEffect(() => {
    window.__PER277_ASSISTANT_CLEANUP__ = async () => await cleanupSeededHistory(seeded)
    return () => {
      window.__PER277_ASSISTANT_CLEANUP__ = undefined
      void cleanupSeededHistory(seeded).catch(() => undefined)
    }
  }, [seeded])

  if (!seeded) {
    return <section aria-label="PER-277 assistant history harness" data-per277-history-state="seeding">Preparing local conversations…</section>
  }

  return (
    <Profiler id="per277.assistant-view" onRender={recordPer277ProfilerCommit}>
      <AssistantView
        client={new AuroraClient({ transport: new MockAuroraTransport() })}
        route={assistantRoute()}
        storageKey={`per277-assistant-history-${runId}`}
        executionHost="connected-device"
        localAssistant={seeded.localAssistant}
        runtimeHealth={runtimeHealth('PER-277 history')}
        surfaceProfile={surfaceProfile()}
      />
    </Profiler>
  )
}

function createStreamingClient(chunkCount: number): AuroraClient {
  const transport = new MockAuroraTransport()
  transport.stream('*', async function* (request): AsyncIterable<AuroraEvent<Record<string, unknown>>> {
    const requestId = request.correlationId ?? 'per277-stream-request'
    const sessionId = requestId
    yield assistantEvent('assistant.connecting', requestId, sessionId, '', '', 0)
    for (let index = 1; index <= chunkCount; index += 1) {
      const delta = `${index === 1 ? '' : ' '}chunk-${index}`
      yield assistantEvent('assistant.delta', requestId, sessionId, delta, Array.from({ length: index }, (_, item) => `chunk-${item + 1}`).join(' '), index)
      await animationFrameDelay()
    }
    yield assistantEvent('assistant.completed', requestId, sessionId, '', Array.from({ length: chunkCount }, (_, item) => `chunk-${item + 1}`).join(' '), chunkCount + 1)
  })
  return new AuroraClient({ transport })
}

function assistantEvent(kind: string, requestId: string, sessionId: string, delta: string, text: string, sequence: number): AuroraEvent<Record<string, unknown>> {
  const payload = {
    kind,
    request_id: requestId,
    correlation_id: requestId,
    session_id: sessionId,
    message_id: requestId,
    text_delta: delta,
    delta,
    text,
    model: 'PER-277 deterministic stream',
    metadata: {
      source: 'per277-assistant-harness',
      sequence,
      secrets_redacted: true,
    },
    secrets_redacted: true,
  }
  const redaction = { secretsRedacted: true, redactedFields: [], source: 'sdk' as const, warnings: [] }
  return {
    id: `per277-${sequence}`,
    kind,
    topic: ORCHESTRATOR_METHODS.response,
    method: ORCHESTRATOR_METHODS.externalUserInput,
    busTopic: ORCHESTRATOR_METHODS.response,
    payload,
    audit: {
      correlationId: requestId,
      eventKind: kind,
      peerId: null,
      principalId: null,
      targetPeerId: null,
      method: ORCHESTRATOR_METHODS.externalUserInput,
      busTopic: ORCHESTRATOR_METHODS.response,
      toolId: null,
      resourceId: null,
      status: kind,
      transport: 'mock',
      redaction,
    },
    redaction,
    receivedAt: new Date().toISOString(),
  }
}

function useAssistantDomObserver({ finalText }: { finalText: string }) {
  useEffect(() => {
    window.__PER277_ASSISTANT_READY__ = true
    const observer = new MutationObserver(() => observeAssistantDom(finalText))
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    observeAssistantDom(finalText)
    return () => observer.disconnect()
  }, [finalText])
}

function useSubmitBridge(prompt: string) {
  useEffect(() => {
    window.__PER277_ASSISTANT_SUBMIT__ = async () => {
      const input = document.querySelector<HTMLTextAreaElement>('textarea')
      const form = input?.form
      if (!input || !form) throw new Error('PER-277 assistant composer is unavailable')
      mutateMeasurement((state) => {
        state.submittedAt = performance.now()
      })
      mark('per277-assistant-submit')
      setTextAreaValue(input, prompt)
      form.requestSubmit()
    }
    return () => {
      window.__PER277_ASSISTANT_SUBMIT__ = undefined
    }
  }, [prompt])
}

function useHistoryOpenBridge(conversationId: string | null) {
  useEffect(() => {
    window.__PER277_HISTORY_OPEN_FIRST__ = async () => {
      void conversationId
      const button = firstConversationButton()
      if (!button) throw new Error('PER-277 local history row is unavailable')
      mark('per277-history-first-open-request')
      button.click()
    }
    return () => {
      window.__PER277_HISTORY_OPEN_FIRST__ = undefined
    }
  }, [conversationId])
}

async function seedLocalHistory(
  profileId: string,
  localNodeId: string,
  count: number,
  backendKind: Per277HistoryBackendKind,
  runId: string,
): Promise<SeededHistory> {
  const backend = createHistoryBackend(backendKind, runId)
  const session = await backend.open(profileId, localNodeId)
  const crypto = plaintextEnvelopeCrypto()
  const scope = { profileId, localNodeId }
  const conversationIds = Array.from({ length: count }, (_, index) => `per277-conversation-${String(index + 1).padStart(3, '0')}`)
  const newestConversationId = conversationIds[conversationIds.length - 1] ?? 'per277-conversation-000'
  await session.transaction(async (repositories) => {
    for (let index = 1; index <= count; index += 1) {
      const conversationId = conversationIds[index - 1] ?? `per277-conversation-${String(index).padStart(3, '0')}`
      const createdAtMs = 1_800_000_000_000 + index * 1_000
      const conversation: ConversationRecord = {
        id: conversationId,
        profileId,
        localNodeId,
        titleEnvelope: await crypto.encrypt('local-structured-data', textBytes(`PER-277 seeded chat ${index}`), buildEnvelopeAad({ table: 'aurora_conversations', recordId: conversationId, field: 'title_envelope_json', profileId, localNodeId })),
        createdAtMs,
        updatedAtMs: createdAtMs,
        archivedAtMs: null,
      }
      await repositories.conversations.upsertConversation(conversation)
      for (let sequence = 0; sequence < 2; sequence += 1) {
        const role = sequence === 0 ? 'user' : 'assistant'
        const messageId = `${conversationId}-message-${sequence}`
        const message: ConversationMessageRecord = {
          id: messageId,
          conversationId,
          sequence,
          role,
          contentEnvelope: await crypto.encrypt('local-structured-data', textBytes(`${role} message for PER-277 seeded chat ${index}`), buildEnvelopeAad({ table: 'aurora_messages', recordId: messageId, field: 'content_envelope_json', profileId, localNodeId })),
          toolEnvelope: null,
          status: 'complete',
          createdAtMs: createdAtMs + sequence,
        }
        await repositories.conversations.appendMessage(message)
      }
    }
  })
  const localAssistant: LightweightAssistantDependencies = {
    provider: { complete: async () => ({ type: 'message', content: 'PER-277 history append response' }) },
    tools: emptyTools(),
    localData: session,
    envelopeCrypto: crypto,
    scope,
    availableTools: [],
    ids: createSequentialIds('per277-local'),
    nowMs: () => Date.now(),
  }
  return {
    backend,
    session,
    localAssistant,
    firstConversationId: newestConversationId,
    conversationIds,
    provenance: historyBackendProvenance(backendKind, backend),
  }
}

function createHistoryBackend(kind: Per277HistoryBackendKind, runId: string): LocalDataBackend {
  if (kind === 'memory') return new MemoryLocalDataBackend({ nowMs: () => 1_800_000_000_000 })
  return new BrowserIndexedDbLocalDataBackend({
    origin: typeof window === 'undefined' ? undefined : window.location.origin,
    indexedDB: typeof indexedDB === 'undefined' ? undefined : indexedDB,
    ownerId: `per277-history-${runId}`,
    nowMs: () => 1_800_000_000_000,
  })
}

function historyBackendProvenance(requestedKind: Per277HistoryBackendKind, backend: LocalDataBackend): string {
  return requestedKind === 'memory'
    ? `synthetic-memory-local-data-control:${backend.kind}`
    : `persistent-indexeddb-local-data:${backend.kind}`
}

interface SeededHistory {
  backend: LocalDataBackend
  session: LocalDataSession
  localAssistant: LightweightAssistantDependencies
  firstConversationId: string
  conversationIds: string[]
  provenance: string
}

interface Per277CleanupResult {
  state: 'complete' | 'failed'
  error: string | null
}

async function cleanupSeededHistory(seeded: SeededHistory | null): Promise<Per277CleanupResult> {
  if (!seeded || cleanedSeededHistories.has(seeded)) return { state: 'complete', error: null }
  try {
    await seeded.session.transaction(async (repositories) => {
      for (const conversationId of seeded.conversationIds) {
        await repositories.conversations.deleteConversation(conversationId)
      }
    })
    await seeded.backend.close()
    cleanedSeededHistories.add(seeded)
    mutateMeasurement((state) => {
      state.cleanupState = 'complete'
      state.cleanupError = null
      state.cleanupCompletedAt = performance.now()
    })
    return { state: 'complete', error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    mutateMeasurement((state) => {
      state.cleanupState = 'failed'
      state.cleanupError = message
      state.cleanupCompletedAt = performance.now()
    })
    return { state: 'failed', error: message }
  }
}

function plaintextEnvelopeCrypto(): EnvelopeCryptoPort {
  const values = new Map<string, Uint8Array>()
  let nextId = 0
  return {
    async encrypt(_purpose, plaintext) {
      const keyId = `per277-key-${nextId++}`
      values.set(keyId, plaintext.slice())
      return envelope(keyId)
    },
    async decrypt(encrypted) {
      const value = values.get(encrypted.keyId)
      if (!value) throw new Error('PER-277 plaintext envelope is unavailable')
      return value.slice()
    },
    async rotateKey() {
      return { previousKeyId: 'per277-key-previous', newKeyId: 'per277-key-next' }
    },
  }
}

function envelope(keyId: string): EncryptedDataEnvelopeV1 {
  return {
    version: 1,
    algorithm: 'AES-GCM-256',
    keyId,
    nonceB64Url: 'AAAAAAAAAAAAAAAA',
    ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
    createdAtMs: 1_800_000_000_000,
  }
}

function emptyTools(): NonNullable<LightweightAssistantDependencies['tools']> {
  return {
    async prepareExecution() { throw new Error('PER-277 tool execution is not used') },
    async requestApproval() { throw new Error('PER-277 tool approval is not used') },
    async confirmExecution() { throw new Error('PER-277 tool confirmation is not used') },
    async execute() { return { ok: false, status: 'not_found', error: 'PER-277 tool execution is not used' } },
  }
}

function createSequentialIds(prefix: string): () => string {
  let id = 0
  return () => `${prefix}-${id++}`
}

function assistantRoute(): RouteAvailability {
  return {
    item: {
      id: 'assistant',
      label: 'Assistant',
      href: '/',
      capabilityFeatureId: 'assistant',
      capabilityModule: 'orchestrator',
      capabilityMethod: 'Orchestrator.ExternalUserInput',
      methodType: 'use',
      privacyClass: 'personal',
      fallbackState: 'unsupported',
      expectedTask: 'assistant',
    },
    state: 'available-local',
    explanation: 'Assistant route available for PER-277 measurement.',
    providerLabel: 'This device',
    blockers: [],
    repairActions: [],
    candidateProviders: [{
      id: 'local-device',
      providerId: 'local-device',
      providerKind: 'local',
      peerId: null,
      nodeName: 'This device',
      serviceInstanceId: 'aurora-local',
      label: 'This device',
      state: 'available-local',
      selectable: true,
      reason: 'Available for measurement.',
      requiredAction: null,
    }],
    evidenceSources: ['per277-assistant-harness'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  }
}

function runtimeHealth(routeLabel: string) {
  return {
    selectedModel: 'PER-277 deterministic model',
    routeLabel,
    sidecarHealth: 'ready',
    gatewayHealth: 'ready',
  }
}

function surfaceProfile() {
  return getAuroraSurfaceProfile({
    runtimeMode: 'android',
    transportKind: 'mock',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    nativePlatform: 'android',
  })
}

function initializeMeasurementState(caseName: Per277AssistantMeasurementState['caseName'], runId: string, expectedDeltaCount: number): void {
  enableExistingAuroraProfilerBridge()
  window.__PER277_ASSISTANT_MEASUREMENT__ = {
    caseName,
    runId,
    backendKind: caseName === 'per277-local-history' ? 'pending' : 'mock-stream',
    seedDurationMs: null,
    mountedAt: performance.now(),
    submittedAt: null,
    firstVisibleAt: null,
    finalVisibleAt: null,
    finalText: null,
    visibleDeltaCount: 0,
    expectedDeltaCount,
    historyListVisibleAt: null,
    historyFirstOpenVisibleAt: null,
    historyAppendCompleteAt: null,
    cleanupState: caseName === 'per277-local-history' ? 'pending' : 'complete',
    cleanupError: null,
    cleanupCompletedAt: caseName === 'per277-local-history' ? null : performance.now(),
    longTasks: [],
    marks: [],
  }
  observeLongTasks()
  mark(caseName === 'per277-local-history' ? 'per277-history-mount-start' : 'per277-assistant-stream-mount-start')
}

function recordPer277ProfilerCommit(
  id: string,
  phase: 'mount' | 'update' | 'nested-update',
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
): void {
  const handle = profilerBridge()
  if (!handle?.enabled || handle.maxSamples <= 0) return
  const sample = {
    label: id,
    id,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  }
  handle.samples.push(sample)
  const overflow = handle.samples.length - handle.maxSamples
  if (overflow > 0) handle.samples.splice(0, overflow)
}

function observeAssistantDom(finalText: string): void {
  const bodyText = document.body.textContent ?? ''
  const chunkMatches = bodyText.match(/chunk-\d+/gu) ?? []
  mutateMeasurement((state) => {
    if (chunkMatches.length > state.visibleDeltaCount) state.visibleDeltaCount = chunkMatches.length
    if (state.submittedAt !== null && state.firstVisibleAt === null && chunkMatches.length > 0) {
      state.firstVisibleAt = performance.now()
      mark('per277-assistant-first-delta-visible')
    }
    if (state.finalVisibleAt === null && bodyText.includes(finalText)) {
      state.finalVisibleAt = performance.now()
      state.finalText = finalText
      mark(state.caseName === 'per277-local-history' ? 'per277-history-append-complete' : 'per277-assistant-final-visible')
      if (state.caseName === 'per277-local-history') state.historyAppendCompleteAt = state.finalVisibleAt
    }
    if (state.caseName === 'per277-local-history' && state.historyListVisibleAt === null && bodyText.includes('PER-277 seeded chat')) {
      state.historyListVisibleAt = performance.now()
      mark('per277-history-list-visible')
    }
    if (state.caseName === 'per277-local-history' && state.historyFirstOpenVisibleAt === null && bodyText.includes('assistant message for PER-277 seeded chat')) {
      state.historyFirstOpenVisibleAt = performance.now()
      mark('per277-history-first-open-visible')
    }
  })
}

function observeLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      mutateMeasurement((state) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration })
        }
      })
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    // Long task observation is browser-dependent; the measurement script records availability.
  }
}

function mark(name: string): void {
  performance.mark(name)
  mutateMeasurement((state) => {
    state.marks.push({ name, startTime: performance.now() })
  })
}

function mutateMeasurement(mutator: (state: Per277AssistantMeasurementState) => void): void {
  const state = window.__PER277_ASSISTANT_MEASUREMENT__
  if (!state) return
  mutator(state)
}

function setTextAreaValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function firstConversationButton(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  return buttons.find((button) => /PER-277 seeded chat/u.test(button.textContent ?? '')) ?? null
}

function stableRunId(value: string | null): string {
  return (value?.trim() || `run-${Date.now()}`).replace(PROFILE_ID_PATTERN, '-').slice(0, 80)
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function historyBackendKind(value: string | null): Per277HistoryBackendKind {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'indexeddb') return 'indexeddb'
  if (normalized === 'memory') return 'memory'
  throw new Error('historyBackend must be indexeddb or memory')
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

async function animationFrameDelay(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

interface Per277ProfilerBridge {
  enabled: boolean
  maxSamples: number
  samples: Array<{
    label: string
    id: string
    phase: 'mount' | 'update' | 'nested-update'
    actualDuration: number
    baseDuration: number
    startTime: number
    commitTime: number
  }>
}

function enableExistingAuroraProfilerBridge(): void {
  const handle = profilerBridge()
  if (!handle) return
  handle.enabled = true
  handle.maxSamples = 10_000
}

function profilerBridge(): Per277ProfilerBridge | undefined {
  return (window as Window & { __AURORA_REACT_PROFILER__?: Per277ProfilerBridge }).__AURORA_REACT_PROFILER__
}
