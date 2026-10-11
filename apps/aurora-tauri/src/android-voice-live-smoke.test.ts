import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = resolve(appRoot, 'scripts/android-voice-live-smoke.mjs')

async function liveSmokeModule() {
  return import(pathToFileURL(scriptPath).href) as Promise<{
    parseAdbDevices(output: string): Array<{ serial: string; state: string; line: string }>
    resolveAndroidDeviceSerial(output: string, explicit?: string): string
    selectAndroidVoicePacks(status: unknown, options?: unknown): Record<string, CatalogEntry>
    buildAndroidVoiceRuntimeProfile(
      packs: Record<string, CatalogEntry>,
      options?: {
        language?: string
        wakePhrase?: { phraseId: string; phrase: string; language: string }
        homeGatewayUrl?: string
      },
    ): RuntimeDocument
    mergeAndroidVoiceRuntimeProfile(
      existingDocument: RuntimeDocument | null,
      packs: Record<string, CatalogEntry>,
      options?: {
        language?: string
        wakePhrase?: { phraseId: string; phrase: string; language: string }
        homeGatewayUrl?: string
      },
    ): RuntimeDocument
    wakePhraseRevision(input: {
      phrase: string
      language: string
      packId: string
      packRevision: string
    }): string
    notificationIsVisibleFromDump(output: string, appId: string): boolean
    notificationInteractionMode(value?: string | null): 'automatic' | 'external'
    notificationStopPostcondition(status: Record<string, unknown>): boolean
    pollNotificationStopPostconditions(context: unknown, invoke: (command: string) => Promise<Record<string, unknown>>, options: {
      sleepFn: (ms: number) => Promise<void>
      serviceVisible: () => boolean
      notificationVisible: () => boolean
      timeoutMs: number
      now: () => number
    }): Promise<{ status: Record<string, unknown>; serviceVisible: boolean; notificationVisible: boolean }>
    assertNotificationStopPreconditions(context: unknown, invoke: (command: string) => Promise<Record<string, unknown>>, options: { serviceVisible: boolean; notificationVisible: boolean }): Promise<Record<string, unknown>>
    waitForExternalNotificationStop(context: unknown, invoke: (command: string) => Promise<Record<string, unknown>>, options: {
      emit: (marker: Record<string, unknown>) => void
      expand: () => void
      collapse: () => void
      wake: () => void
      dismissKeyguard: () => void
      wait: (ms: number) => Promise<void>
      serviceVisible?: () => boolean
      notificationVisible?: () => boolean
      now?: () => number
      timeoutMs?: number
    }): Promise<Record<string, unknown>>
    parseUiAutomatorCapture(input: {
      status: number | null
      stdout?: string
      stderr?: string
      error?: { message?: string; code?: string }
    }): {
      ok: boolean
      hierarchy: string
      diagnostic: {
        exitCode: number | null
        stdout: string
        stderr: string
        error?: { message: string; code?: string }
      }
    }
    auroraNotificationNodeBounds(
      hierarchy: string,
      attributes: { text?: string; resourceId?: string; contentDesc?: string },
      appId?: string,
    ): { left: number; top: number; right: number; bottom: number } | undefined
    wakeLockIsHeldFromDump(output: string): boolean
    isRecoverableBackgroundCaptureError(errorCode: unknown): boolean
    backgroundVoiceAcceptsInjectedPcm(status: Record<string, unknown>): boolean
    backgroundMicrophoneReadyForInjection(status: Record<string, unknown>): boolean
    backgroundPcmRejectionEndsInjection(
      rejection: Record<string, unknown>,
      status: Record<string, unknown>,
      baseline: Record<string, unknown>,
      acceptedFrames: number,
    ): boolean
    focusedPcmRejectionEndsInjection(
      rejection: Record<string, unknown>,
      status: Record<string, unknown>,
      baseline: Record<string, unknown>,
      acceptedFrames: number,
    ): boolean
    injectLiveTestPcm(
      invoke: (command: string, args?: unknown) => Promise<Record<string, unknown>>,
      pcm: Buffer,
      options?: { focusedBaseline?: Record<string, unknown> },
    ): Promise<Record<string, unknown> | undefined>
    focusedTranscriptionCompleted(
      baseline: Record<string, unknown>,
      status: Record<string, unknown>,
    ): boolean
    classifyBackgroundWakeAttempt(baseline: Record<string, unknown>, status: Record<string, unknown>):
      'completed' | 'rearmed' | 'failed' | 'pending'
    assertNativeEventBridgeProgression(input: Record<string, unknown>): {
      enabled: boolean
      completedGeneration: number
      matchingLiveEventCount: number
      replayRecovered: boolean
      duplicatePersistedResult: boolean | null
      [key: string]: unknown
    }
    assertNativeEventBridgeSlowConsumerRecovery(input: Record<string, unknown>): {
      enabled: boolean
      acknowledgementWithheld: boolean
      withheldAckCount: number
      hubGapObserved: boolean
      snapshotRecovered: boolean
      limitation: string | null
      [key: string]: unknown
    }
    localDataScopeFromRuntimeProfile(activeProfile: Record<string, unknown>): { profileId: string; localNodeId: string }
    assertNativeTurnLocalDataRecovery(input: Record<string, unknown>): {
      persistedResultUniquenessMeasured: boolean
      duplicatePersistedResult: boolean
      afterHiddenCompletion: {
        nativeDelta: {
          conversationId: string
          newRows: Array<{ id: string; role: string; sequence: number; status: string }>
        }
      }
      afterFirstReopen: { sameAsAfterHiddenCompletion: boolean }
      afterSecondReopen: { sameAsAfterHiddenCompletion: boolean }
      [key: string]: unknown
    }
    sanitizeNativePlaybackCounters(input: Record<string, unknown>, phase?: string): Record<string, unknown>
    nativeTurnRequiresPersistedAssistantResult(report: Record<string, unknown>, playbackReport: Record<string, unknown>): boolean
    assertNativePlaybackNoReplay(input: Record<string, unknown>): {
      measured: boolean
      replayedDuringRecovery: boolean
      advancedDuringHiddenCompletion: string[]
      afterFirstReopen: { sameAsAfterHiddenCompletion: boolean }
      afterSecondReopen: { sameAsAfterHiddenCompletion: boolean }
      [key: string]: unknown
    }
    wavToPcm16Mono(wav: Buffer, targetSampleRateHz?: number): Buffer
    ANDROID_BACKGROUND_WAKE_TEXT: string
    ANDROID_BACKGROUND_COMMAND_TEXT: string
    successfulNativeTurnAcceptanceEnabled(environment?: Record<string, string | undefined>): boolean
    assertSuccessfulNativeTurn(input: Record<string, unknown>): Record<string, unknown>
    assertNativeTurnUiRecovery(input: Record<string, unknown>): Record<string, boolean>
    assertNativeTurnPersistenceUniqueness(input: Record<string, unknown>): Record<string, unknown>
    assertNativeTurnCorrelation(input: Record<string, unknown>): {
      requestId: string
      conversationId: string
      matchingEventCount: number
    }
  }>
}

interface CatalogEntry {
  packId: string
  engineRuntimeRevision: string
  runtimeTask: string
  language: string
  sizeBytes: number
  installed: boolean
  active: boolean
  readyForInstall: boolean
  readyForRuntime: boolean
  requiresReferenceAudio?: boolean
}

interface RuntimeDocument {
  version: number
  activeProfileId: string
  profiles: Array<{
    id: string
    label?: string
    nodeMode: string
    runtimeTier: string
    homeConnection?: { mode: string; gatewayUrl: string; peerId?: string }
    localNode: {
      nodeName?: string
      stablePeerId: string
      enabledCapabilityPacks?: string[]
      meshMembership?: Record<string, unknown>
      localSpeechPackState?: string
      localSpeechSelection: Record<string, {
        packId?: string
        packRevision?: string
        voiceId?: string
        voiceRevision?: string
        phraseId?: string
        phrase?: string
        language?: string
        revision?: string
      }>
    }
  }>
}

function event(sequence: number, kind: string, generation: number, payload: Record<string, unknown> = {}) {
  return {
    id: `native:${sequence}`,
    sequence,
    kind,
    payload: {
      generation,
      requestId: `request-${generation}`,
      conversationId: `conversation-${generation}`,
      ...payload,
    },
    subjects: [`voice:${generation}`],
  }
}

function subject(kind: string, generation: number, overrides: Record<string, unknown> = {}) {
  return {
    subject: `voice:${generation}`,
    kind,
    generation,
    requestId: `request-${generation}`,
    conversationId: `conversation-${generation}`,
    terminal: false,
    ...overrides,
  }
}

function localDataMessage(
  id: string,
  conversationId: string,
  sequence: number,
  role: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    conversationId,
    sequence,
    role,
    status: 'complete',
    createdAtMs: 1_700_000_000_000 + sequence,
    ...overrides,
  }
}

function localDataSnapshot(
  phase: string,
  messagesByConversation: Record<string, Array<Record<string, unknown>>>,
) {
  const conversationIds = Object.keys(messagesByConversation).sort()
  return {
    phase,
    conversationIds,
    messageCounts: Object.fromEntries(
      conversationIds.map((conversationId) => [conversationId, messagesByConversation[conversationId]?.length ?? 0]),
    ),
    messagesByConversation,
  }
}

function playbackCounters(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    globalPlayCallCount: 10,
    globalChunkEnqueueCount: 30,
    globalFinalChunkQueuedCount: 10,
    globalDrainNonEmptyCount: 9,
    globalAckCount: 29,
    globalCompleteCount: 9,
    globalFailureCount: 0,
    globalAudioTrackPlayCallCount: 10,
    globalAudioTrackWrittenSamples: 16_000,
    ...overrides,
  }
}


function acknowledgedCollector(events: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  const eventShaped = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    return typeof candidate.kind === 'string'
      && (typeof candidate.id === 'string' || typeof candidate.eventId === 'string' || Number.isFinite(Number(candidate.sequence)))
  }
  return {
    acknowledgeEvents: true,
    acknowledged: events.map((entry) => {
      const payload = (entry as { payload?: unknown }).payload as Record<string, unknown> | undefined
      const raw = eventShaped(payload)
        ? payload!
        : ((payload?.event ?? (eventShaped(payload?.payload) ? payload?.payload : payload)) as Record<string, unknown> | undefined) ?? entry
      const sequence = Number(raw.sequence)
      const eventId = typeof raw.id === 'string'
        ? raw.id
        : typeof raw.eventId === 'string'
          ? raw.eventId
          : Number.isFinite(sequence)
            ? `native:${sequence}`
            : undefined
      return { eventId }
    }).filter((entry) => typeof entry.eventId === 'string'),
    errors: [],
    events,
    ...overrides,
  }
}

function entry(
  task: string,
  packId: string,
  language: string,
  sizeBytes: number,
  overrides: Partial<CatalogEntry> = {},
): CatalogEntry {
  return {
    packId,
    engineRuntimeRevision: `revision-${task}`,
    runtimeTask: task,
    language,
    sizeBytes,
    installed: false,
    active: false,
    readyForInstall: true,
    readyForRuntime: false,
    ...overrides,
  }
}

describe('Android packaged voice live smoke harness', () => {
  it('keeps successful remote acceptance opt-in and rejects the existing local recovery result', async () => {
    const module = await liveSmokeModule()
    expect(module.successfulNativeTurnAcceptanceEnabled({})).toBe(false)
    expect(module.successfulNativeTurnAcceptanceEnabled({ AURORA_ANDROID_NATIVE_TURN_ACCEPTANCE: '1' })).toBe(true)
    expect(() => module.assertSuccessfulNativeTurn({
      active: { sessionGeneration: 4 },
      completed: { sessionGeneration: 5, liveOutcome: 'rearmed', captureError: 'assistant_unavailable' },
    })).toThrow(/assistant-unavailable recovery path/u)
    expect(module.assertSuccessfulNativeTurn({
      active: { sessionGeneration: 4, voiceRoute: { configured: true } },
      completed: { sessionGeneration: 5, liveOutcome: 'completed', assistantCompleted: true, failedTurns: 0 },
      pairingEvidence: { authenticated: true, bilaterallyApproved: true, nativeSessionBound: true, pythonPeerId: 'python-peer-5' },
      modelFixture: { turnId: 'turn-5', completedText: 'Fixture completed response turn-5' },
    })).toMatchObject({
      route: { configured: true },
      method: 'Orchestrator.ExternalUserInput',
      methodSource: 'apps/aurora-tauri/src-tauri/src/native_mesh_assistant.rs',
      pythonPeerId: 'python-peer-5',
      fixture: { turnId: 'turn-5', completedText: 'Fixture completed response turn-5' },
      generation: 5,
    })
    expect(() => module.assertSuccessfulNativeTurn({
      active: { sessionGeneration: 4, voiceRoute: { configured: false } },
      completed: { sessionGeneration: 5, liveOutcome: 'completed', assistantCompleted: true },
    })).toThrow(/voice route to be configured/u)
  })

  it('requires actual UI partial, pending, and completed observations', async () => {
    const module = await liveSmokeModule()
    expect(module.assertNativeTurnUiRecovery({
      partialText: 'Fixture partial',
      pendingVisible: true,
      completedText: 'Fixture complete',
      expectedText: 'Fixture complete',
    })).toEqual({ partialObserved: true, pendingObserved: true, completedObserved: true })
    expect(() => module.assertNativeTurnUiRecovery({
      partialText: '', pendingVisible: true, completedText: 'Fixture complete',
    })).toThrow(/partial assistant text/u)
  })

  it('correlates native events to one request and persisted conversation', async () => {
    const module = await liveSmokeModule()
    expect(module.assertNativeTurnCorrelation({
      completed: { sessionGeneration: 5, liveOutcome: 'completed' },
      events: [event(41, 'assistant.delta', 5)],
      subjects: [subject('assistant.completed', 5, { terminal: true })],
    })).toMatchObject({ requestId: 'request-5', conversationId: 'conversation-5' })
    expect(() => module.assertNativeTurnCorrelation({
      completed: { sessionGeneration: 5, liveOutcome: 'completed' },
      events: [event(41, 'assistant.delta', 5), event(42, 'assistant.delta', 6)],
      subjects: [],
    })).toThrow(/one request\/conversation correlation pair/u)
    expect(() => module.assertNativeTurnCorrelation({
      completed: { sessionGeneration: 5, liveOutcome: 'completed' },
      events: [event(41, 'assistant.delta', 5), { ...event(42, 'assistant.completed', 5), payload: { generation: 5, requestId: 'request-5' } }],
      subjects: [],
    })).toThrow(/partial or conflicting correlation id/u)
    expect(() => module.assertNativeTurnCorrelation({
      completed: { sessionGeneration: 5, liveOutcome: 'completed' },
      events: [event(41, 'assistant.delta', 5)],
      subjects: [{ kind: 'assistant.completed', generation: 5, terminal: true }],
    })).toThrow(/terminal evidence was not correlated/u)
  })

  it('requires one user and one assistant row and stable rows after reopen', async () => {
    const module = await liveSmokeModule()
    const rows = [
      { id: 'u-5', role: 'user', generation: 5 },
      { id: 'a-5', role: 'assistant', generation: 5 },
    ]
    expect(module.assertNativeTurnPersistenceUniqueness({
      beforeRows: [], afterRows: rows, reopenedRows: structuredClone(rows), generation: 5,
    })).toMatchObject({ userRows: 1, assistantRows: 1, duplicateRows: false })
    expect(() => module.assertNativeTurnPersistenceUniqueness({
      beforeRows: [], afterRows: [...rows, { id: 'a-5-duplicate', role: 'assistant', generation: 5 }],
      reopenedRows: [...rows, { id: 'a-5-duplicate', role: 'assistant', generation: 5 }], generation: 5,
    })).toThrow(/exactly one user and assistant/u)
  })
  it('selects Waydroid explicitly and keeps every device command serial-scoped', async () => {
    const module = await liveSmokeModule()
    const devices = [
      'List of devices attached',
      'emulator-5554 device product:sdk model:sdk_gphone transport_id:1',
      '192.168.240.112:5555 device product:waydroid model:WayDroid device:waydroid transport_id:2',
      '',
    ].join('\n')

    expect(module.parseAdbDevices(devices)).toHaveLength(2)
    expect(module.resolveAndroidDeviceSerial(devices)).toBe('192.168.240.112:5555')
    expect(module.resolveAndroidDeviceSerial(devices, 'emulator-5554')).toBe('emulator-5554')

    const source = readFileSync(scriptPath, 'utf8')
    expect(source).toContain("['-s', context.serial, ...args]")
    expect(source).toContain("commandOutput(adb, ['devices', '-l'])")
    expect(source).not.toContain('writeFileSync')
  })

  it('chooses the compatible production defaults and preserves explicit selections', async () => {
    const module = await liveSmokeModule()
    const entries = [
      entry('stt', 'stt:whisper:tiny', 'multi', 116_204_861),
      entry('stt', 'stt:whisper:tiny.en', 'en', 118_071_777),
      entry('tts', 'standard:piper:en_gb-cori-medium-int8', 'en-gb', 20_768_736),
      entry('tts', 'standard:piper:en_us-john-medium-int8', 'en-us', 20_800_096),
      entry('vad', 'vad:silero:current-int8', 'und', 212_860),
      entry('kws', 'kws:zipformer:gigaspeech', 'en', 17_626_723),
      entry('kws', 'kws:zipformer:zh-en-2025', 'en zh', 32_885_699),
    ]

    const selected = module.selectAndroidVoicePacks({ entries }, { language: 'en' })
    expect(selected.stt.packId).toBe('stt:whisper:tiny')
    expect(selected.tts.packId).toBe('standard:piper:en_gb-cori-medium-int8')
    expect(selected.vad.packId).toBe('vad:silero:current-int8')
    expect(selected.kws.packId).toBe('kws:zipformer:zh-en-2025')

    const explicit = module.selectAndroidVoicePacks(
      { entries },
      { language: 'en', explicitPackIds: { tts: 'standard:piper:en_us-john-medium-int8' } },
    )
    expect(explicit.tts.packId).toBe('standard:piper:en_us-john-medium-int8')
  })

  it('treats notification channel metadata as invisible unless an active record is present', async () => {
    const module = await liveSmokeModule()
    const appId = 'dev.aurora.desktop'
    const metadataOnlyDump = [
      `AppSettings: ${appId} (10127) importance=DEFAULT userSet=false`,
      "NotificationChannel{mId='aurora_voice_capture', mName=Aurora voice capture, mImportance=2}",
      'Usage Stats:',
      `  key='${appId}'`,
    ].join('\n')
    const activeRecordDump = [
      `NotificationRecord{1a2b3c pkg=${appId} channelId=aurora_voice_capture`,
      `  sbn=StatusBarNotification(pkg=${appId} user=UserHandle{0})`,
      '  notification=Notification(channel=aurora_voice_capture)',
    ].join('\n')
    const android16ActiveRecordDump = [
      `NotificationRecord(0x0fb00776: pkg=${appId} user=UserHandle{0} id=4203`,
      '  notification=Notification(channel=aurora_voice_capture)',
      '  android.title=String (Aurora voice controls)',
    ].join('\n')

    expect(module.notificationIsVisibleFromDump(metadataOnlyDump, appId)).toBe(false)
    expect(module.notificationIsVisibleFromDump(activeRecordDump, appId)).toBe(true)
    expect(module.notificationIsVisibleFromDump(android16ActiveRecordDump, appId)).toBe(true)
  })

  it('locates notification controls after a rich notification expands', async () => {
    const module = await liveSmokeModule()
    const appId = 'dev.aurora.desktop'
    const collapsedHierarchy = [
      '<hierarchy>',
      '<node resource-id="com.android.systemui:id/expandableNotificationRow">',
      `<node text="Waiting for wake word" resource-id="${appId}:id/aurora_notification_voice_state" bounds="[12,16][220,40]" />`,
      '<node text="" resource-id="android:id/expand_button" content-desc="Expand" bounds="[280,16][320,56]" />',
      '</node>',
      '</hierarchy>',
    ].join('')
    const expandedHierarchy = [
      '<hierarchy>',
      '<node resource-id="com.android.systemui:id/expandableNotificationRow">',
      '<node text="Recorder" resource-id="android:id/app_name_text" bounds="[12,16][92,40]" />',
      '<node text="Stop" resource-id="android:id/action0" bounds="[4,60][20,80]" />',
      '</node>',
      '<node resource-id="com.android.systemui:id/expandableNotificationRow">',
      '<node text="Aurora" resource-id="android:id/app_name_text" bounds="[12,96][92,120]" />',
      '<node content-desc="Stop" bounds="[24,120][96,168]" class="android.widget.Button" ',
      'resource-id="android:id/action0" text="Stop" />',
      '</node>',
      '</hierarchy>',
    ].join('')

    expect(module.auroraNotificationNodeBounds(collapsedHierarchy, {
      resourceId: 'android:id/expand_button',
      contentDesc: 'Expand',
    })).toEqual({ left: 280, top: 16, right: 320, bottom: 56 })
    expect(module.auroraNotificationNodeBounds(collapsedHierarchy, {
      resourceId: 'android:id/action0',
      text: 'Stop',
    })).toBeUndefined()
    expect(module.auroraNotificationNodeBounds(expandedHierarchy, {
      resourceId: 'android:id/action0',
      text: 'Stop',
    })).toEqual({ left: 24, top: 120, right: 96, bottom: 168 })
  })
  it('classifies notification hierarchy capture failures without misreporting a missing action', async () => {
    const module = await liveSmokeModule()
    const valid = module.parseUiAutomatorCapture({
      status: 0,
      stdout: '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node /></hierarchy>',
    })
    expect(valid.ok).toBe(true)
    expect(valid.hierarchy).toContain('<hierarchy>')

    const xmlWithPlatformNotice = '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node /></hierarchy>'
    const validWithPlatformNotice = module.parseUiAutomatorCapture({
      status: 0,
      stdout: `${xmlWithPlatformNotice}UI hierchary dumped to: /dev/tty\n`,
    })
    expect(validWithPlatformNotice).toEqual({
      ok: true,
      hierarchy: xmlWithPlatformNotice,
      diagnostic: {
        exitCode: 0,
        stdout: `${xmlWithPlatformNotice}UI hierchary dumped to: /dev/tty\n`,
        stderr: '',
      },
    })

    const invalidXml = module.parseUiAutomatorCapture({
      status: 0,
      stdout: 'java.lang.IllegalStateException: UiAutomationService already registered!',
      stderr: 'uiautomator crashed',
    })
    expect(invalidXml).toEqual({
      ok: false,
      hierarchy: '',
      diagnostic: {
        exitCode: 0,
        stdout: 'java.lang.IllegalStateException: UiAutomationService already registered!',
        stderr: 'uiautomator crashed',
      },
    })

    const commandFailed = module.parseUiAutomatorCapture({
      status: 1,
      stdout: '',
      stderr: 'UiAutomationService already registered',
    })
    expect(commandFailed.ok).toBe(false)
    expect(commandFailed.diagnostic).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'UiAutomationService already registered',
    })

    const erroredCapture = module.parseUiAutomatorCapture({
      status: null,
      stdout: '<partial hierarchy output>',
      stderr: 'spawn interrupted',
      error: { message: 'spawnSync uiautomator failed', code: 'EPIPE' },
    })
    expect(erroredCapture).toEqual({
      ok: false,
      hierarchy: '',
      diagnostic: {
        exitCode: null,
        stdout: '<partial hierarchy output>',
        stderr: 'spawn interrupted',
        error: { message: 'spawnSync uiautomator failed', code: 'EPIPE' },
      },
    })

    const validHierarchy = module.parseUiAutomatorCapture({
      status: 0,
      stdout: '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node resource-id="com.android.systemui:id/expandableNotificationRow"><node text="Aurora" resource-id="android:id/app_name_text" /></node></hierarchy>',
    })
    const missingAction = module.auroraNotificationNodeBounds(
      validHierarchy.hierarchy,
      { resourceId: 'android:id/action0', text: 'Stop' },
    )
    expect(missingAction).toBeUndefined()
  })

  it('keeps notification interaction automatic by default and accepts only the opt-in external mode', async () => {
    const module = await liveSmokeModule()
    expect(module.notificationInteractionMode(null)).toBe('automatic')
    expect(module.notificationInteractionMode('external')).toBe('external')
    expect(() => module.notificationInteractionMode('synthetic')).toThrow(/Unsupported Android notification interaction mode/u)
  })

  it('waits for a real stop transition and always cleans up the external notification shade', async () => {
    const module = await liveSmokeModule()
    const stopped = { running: false, captureActive: false, backgroundStoppedByUser: true }
    const calls: string[] = []
    const markers: Array<Record<string, unknown>> = []
    const result = await module.waitForExternalNotificationStop({}, async () => stopped, {
      emit: (marker) => markers.push(marker),
      expand: () => calls.push('expand'), collapse: () => calls.push('collapse'),
      wake: () => calls.push('wake'), dismissKeyguard: () => calls.push('dismiss'),
      wait: async () => { calls.push('settle'); calls.push('wait') },
      serviceVisible: () => false, notificationVisible: () => false,
    })
    expect(result.status).toEqual(stopped)
    expect(markers[0]).toMatchObject({ event: 'notification_stop_waiting', interactionMode: 'external' })
    expect(calls).toEqual(['collapse', 'wake', 'dismiss', 'expand', 'settle', 'wait', 'collapse'])
  })

  it('fails a missing transition while collapsing the external notification shade', async () => {
    const module = await liveSmokeModule()
    const calls: string[] = []
    await expect(module.waitForExternalNotificationStop({}, async () => ({ running: true, captureActive: true, backgroundStoppedByUser: false }), {
      emit: () => {}, expand: () => calls.push('expand'), collapse: () => calls.push('collapse'),
      wake: () => {}, dismissKeyguard: () => {}, wait: async () => {},
      serviceVisible: () => false, notificationVisible: () => false,
      now: (() => { let time = 0; return () => { time += 100; return time } })(),
      timeoutMs: 100,
    })).rejects.toThrow(/timed out/u)
    expect(calls).toEqual(['collapse', 'expand', 'collapse'])
  })

  it('rejects external interaction when the live stop preconditions are absent', async () => {
    const module = await liveSmokeModule()
    await expect(module.assertNotificationStopPreconditions({}, async () => ({ running: true, backgroundSessionActive: true, captureActive: true }), {
      serviceVisible: true, notificationVisible: false,
    })).rejects.toThrow(/preconditions were not live/u)
    await expect(module.assertNotificationStopPreconditions({}, async () => ({ running: true, backgroundSessionActive: true, captureActive: true }), {
      serviceVisible: true, notificationVisible: true,
    })).resolves.toMatchObject({ serviceVisible: true, notificationVisible: true })
  })

  it('waits for service and notification removal after status stops', async () => {
    const module = await liveSmokeModule()
    let servicePresent = true
    let notificationPresent = true
    const result = await module.pollNotificationStopPostconditions({}, async () => ({
      running: false,
      captureActive: false,
      backgroundStoppedByUser: true,
    }), {
      sleepFn: async () => { servicePresent = false; notificationPresent = false },
      serviceVisible: () => servicePresent,
      notificationVisible: () => notificationPresent,
      timeoutMs: 100,
      now: () => 0,
    })
    expect(result.status.backgroundStoppedByUser).toBe(true)
    expect(result.serviceVisible).toBe(false)
    expect(result.notificationVisible).toBe(false)
  })

  it('fails closed when an OS visibility query fails during stop validation', async () => {
    const module = await liveSmokeModule()
    await expect(module.pollNotificationStopPostconditions({}, async () => ({
      running: false, captureActive: false, backgroundStoppedByUser: true,
    }), {
      sleepFn: async () => {},
      serviceVisible: () => { throw new Error('dumpsys unavailable') },
      notificationVisible: () => false,
      timeoutMs: 100,
      now: () => 0,
    })).rejects.toThrow(/dumpsys unavailable/u)
  })

  it('keeps local voice smoke separate from the owned connected-main service and broker setup', () => {
    const source = readFileSync(scriptPath, 'utf8')
    const connectedMainSource = readFileSync(
      resolve(appRoot, 'scripts/run-android-native-turn-ui-acceptance.mjs'),
      'utf8',
    )

    for (const forbidden of [
      "from 'node:http'",
      'createGatewayFixture',
      'assistantGatewayRequestCount',
      "['reverse'",
      '/api/Orchestrator/ExternalUserInput',
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(connectedMainSource).toContain("spawn('uv', ['run', 'python', 'main.py']")
    expect(connectedMainSource).toContain('reverseLoopbackBroker(environment, environment.AURORA_THREE_NODE_BROKER_URL)')
    expect(connectedMainSource).toContain("'reverse', '--no-rebind'")
    expect(source).toContain("assistantRoute: successfulNativeTurnAcceptance ? background.acceptanceEvidence?.route ?? null : 'local-only'")
    expect(source).toContain("acceptanceMode: successfulNativeTurnAcceptance ? 'successful-authorized-remote' : 'failure-recovery-local'")
    expect(source).toContain('remoteAudioConsent: false')
    expect(source).toContain("const PIPER_FIXTURE_TOOL = 'piper-tts==1.2.0'")
    expect(source).toContain("'uvx',")
    expect(source).toContain("['--from', PIPER_FIXTURE_TOOL, 'piper'")
    expect(source).not.toContain("['run', 'piper'")
    expect(source).not.toContain('soundfile')
    expect(source).not.toContain('scipy')
  })

  it('converts fixture WAV audio to dependency-free PCM16 mono at the native sample rate', async () => {
    const module = await liveSmokeModule()
    const samples = [
      [1_000, 3_000],
      [3_000, 5_000],
      [5_000, 7_000],
      [7_000, 9_000],
    ]
    const data = Buffer.alloc(samples.length * 4)
    samples.forEach(([left, right], frame) => {
      data.writeInt16LE(left!, frame * 4)
      data.writeInt16LE(right!, frame * 4 + 2)
    })
    const wav = Buffer.alloc(44 + data.length)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(wav.length - 8, 4)
    wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(2, 22)
    wav.writeUInt32LE(8_000, 24)
    wav.writeUInt32LE(32_000, 28)
    wav.writeUInt16LE(4, 32)
    wav.writeUInt16LE(16, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(data.length, 40)
    data.copy(wav, 44)

    const pcm = module.wavToPcm16Mono(wav, 16_000)
    expect(pcm.length).toBe(16)
    expect(Array.from({ length: 8 }, (_, index) => pcm.readInt16LE(index * 2))).toEqual([
      2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 8_000,
    ])
  })

  it('ignores historical wake-lock log entries after the active lock is released', async () => {
    const module = await liveSmokeModule()
    const historyOnlyDump = [
      'Wake Locks: size=0',
      '',
      'Suspend Blockers: size=5',
      '',
      'Wake Lock Log',
      '  08-16 09:11:08.910 - 10127 - ACQ dev.aurora.desktop:aurora_voice_background (partial)',
      '  08-16 09:12:45.085 - 10127 - REL dev.aurora.desktop:aurora_voice_background',
    ].join('\n')
    const activeDump = [
      'Wake Locks: size=1',
      "  PARTIAL_WAKE_LOCK 'dev.aurora.desktop:aurora_voice_background' ACQ=-1s (uid=10127)",
      '',
      'Suspend Blockers: size=6',
    ].join('\n')

    expect(module.wakeLockIsHeldFromDump(historyOnlyDump)).toBe(false)
    expect(module.wakeLockIsHeldFromDump(activeDump)).toBe(true)
  })

  it('keeps recoverable background wake misses out of the fatal path', async () => {
    const module = await liveSmokeModule()
    for (const errorCode of ['assistant_unavailable', 'wake_not_detected', 'speech_not_detected', 'speech_timeout']) {
      expect(module.isRecoverableBackgroundCaptureError(errorCode)).toBe(true)
    }
    for (const errorCode of ['audio_focus_lost', 'voice_runtime_unavailable', '', null]) {
      expect(module.isRecoverableBackgroundCaptureError(errorCode)).toBe(false)
    }
  })

  it('classifies completion, verified rearm, fatal state, and in-flight recovery separately', async () => {
    const module = await liveSmokeModule()
    const baseline = {
      running: true,
      backgroundSessionActive: true,
      captureActive: true,
      runtimeActive: true,
      runtimePhase: 'starting',
      sessionGeneration: 4,
      completedTurns: 2,
      failedTurns: 1,
      captureError: null,
    }

    expect(module.classifyBackgroundWakeAttempt(baseline, {
      ...baseline,
      completedTurns: 3,
    })).toBe('completed')
    expect(module.classifyBackgroundWakeAttempt(baseline, {
      ...baseline,
      runtimeActive: false,
      runtimePhase: 'idle',
      completedTurns: 3,
    })).toBe('completed')
    expect(module.classifyBackgroundWakeAttempt(baseline, {
      ...baseline,
      sessionGeneration: 5,
      failedTurns: 2,
    })).toBe('rearmed')
    expect(module.classifyBackgroundWakeAttempt(baseline, {
      ...baseline,
      runtimePhase: 'idle',
      sessionGeneration: 5,
      failedTurns: 2,
    })).toBe('pending')
    expect(module.classifyBackgroundWakeAttempt(baseline, {
      ...baseline,
      captureError: 'audio_focus_lost',
    })).toBe('failed')
    expect(module.classifyBackgroundWakeAttempt(baseline, {
      ...baseline,
      runtimeActive: false,
      failedTurns: 2,
      captureError: 'wake_not_detected',
    })).toBe('pending')
  })

  it('waits for the native PCM gate instead of a synthetic background rearm snapshot', async () => {
    const module = await liveSmokeModule()
    const active = {
      running: true,
      backgroundSessionActive: true,
      captureActive: true,
      runtimeActive: true,
      captureError: null,
    }

    expect(module.backgroundVoiceAcceptsInjectedPcm({ ...active, runtimePhase: 'idle' })).toBe(false)
    expect(module.backgroundVoiceAcceptsInjectedPcm({ ...active, runtimePhase: 'starting' })).toBe(true)
    expect(module.backgroundVoiceAcceptsInjectedPcm({ ...active, runtimePhase: 'waiting-for-wake' })).toBe(true)
    expect(module.backgroundVoiceAcceptsInjectedPcm({ ...active, runtimePhase: 'listening' })).toBe(true)
    expect(module.backgroundVoiceAcceptsInjectedPcm({
      ...active,
      runtimePhase: 'starting',
      captureError: 'audio_focus_lost',
    })).toBe(false)

    expect(module.backgroundMicrophoneReadyForInjection({
      ...active,
      runtimePhase: 'starting',
      captureBackend: 'android-audiorecord-rust-queue',
      microphoneSignalDetected: false,
      backendAudioEvidenceRequired: false,
      acceptedSamples: 0,
    })).toBe(true)
    expect(module.backgroundMicrophoneReadyForInjection({
      ...active,
      runtimePhase: 'starting',
      captureBackend: 'android-audiorecord-rust-queue',
      backendAudioEvidenceRequired: true,
    })).toBe(false)
  })

  it('re-polls the native gate immediately before every background PCM batch', () => {
    const source = readFileSync(scriptPath, 'utf8')
    const turnBody = source.slice(
      source.indexOf('function completeBackgroundWakeTurn'),
      source.indexOf('async function pollBackgroundWakeAttempt'),
    )
    expect(turnBody).toContain('const baseline = await pollVoiceStatus(')
    expect(turnBody).toContain('backgroundVoiceAcceptsInjectedPcm,')
    expect(turnBody).toContain('await armLiveTestPcmIngress(invoke)')
    expect(turnBody).toContain('Number(baseline.acceptedSamples) !== acceptedSamplesAfterPreviousBatch')
    expect(turnBody.indexOf('await pollVoiceStatus(')).toBeLessThan(
      turnBody.indexOf('await injectLiveTestPcm(invoke, pcm, { backgroundBaseline: baseline })'),
    )
  })

  it('stops a grounded background fixture after the runtime advances past microphone input', async () => {
    const module = await liveSmokeModule()
    const baseline = {
      running: true,
      backgroundSessionActive: true,
      captureActive: true,
      runtimeActive: true,
      runtimePhase: 'listening',
      completedTurns: 4,
      captureError: null,
    }
    const rejection = { accepted: false, reason: 'voice_session_not_accepting_audio' }

    for (const runtimePhase of [
      'processing',
      'transcribing',
      'waiting-for-response',
      'preparing-speech',
      'speaking',
      'stopping',
    ]) {
      expect(module.backgroundPcmRejectionEndsInjection(rejection, {
        ...baseline,
        runtimePhase,
      }, baseline, 12)).toBe(true)
    }
    expect(module.backgroundPcmRejectionEndsInjection(rejection, {
      ...baseline,
      runtimeActive: false,
      runtimePhase: 'idle',
      completedTurns: 5,
    }, baseline, 12)).toBe(true)
    expect(module.backgroundPcmRejectionEndsInjection(rejection, {
      ...baseline,
      runtimeActive: false,
      runtimePhase: 'faulted',
      captureError: 'wake_not_detected',
      failedTurns: 1,
    }, baseline, 12)).toBe(true)

    expect(module.backgroundPcmRejectionEndsInjection(rejection, baseline, baseline, 0)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection(rejection, baseline, baseline, 12)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection(rejection, {
      ...baseline,
      captureActive: false,
      runtimePhase: 'processing',
    }, baseline, 12)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection(rejection, {
      ...baseline,
      runtimeActive: false,
      runtimePhase: 'faulted',
      captureError: 'audio_focus_lost',
      failedTurns: 1,
    }, baseline, 12)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection({
      accepted: false,
      reason: 'pcm_ingress_rejected',
    }, {
      ...baseline,
      runtimePhase: 'processing',
    }, baseline, 12)).toBe(false)
  })

  it('stops a focused fixture only after accepted PCM advances into transcription', async () => {
    const module = await liveSmokeModule()
    const baseline = {
      running: true,
      backgroundSessionActive: false,
      captureActive: true,
      runtimeActive: true,
      runtimePhase: 'listening',
      acceptedSamples: 0,
      completedTurns: 0,
      failedTurns: 0,
      captureError: null,
    }
    const advanced = {
      ...baseline,
      runtimePhase: 'transcribing',
      acceptedSamples: 16_000,
    }
    const rejection = { accepted: false, reason: 'voice_session_not_accepting_audio' }

    expect(module.focusedPcmRejectionEndsInjection(rejection, advanced, baseline, 21)).toBe(true)
    expect(module.focusedPcmRejectionEndsInjection(rejection, baseline, baseline, 21)).toBe(false)
    expect(module.focusedPcmRejectionEndsInjection(rejection, {
      ...advanced,
      captureError: 'audio_focus_lost',
    }, baseline, 21)).toBe(false)
    expect(module.focusedPcmRejectionEndsInjection(rejection, advanced, baseline, 0)).toBe(false)
    expect(module.focusedPcmRejectionEndsInjection({
      accepted: false,
      reason: 'audio_queue_closed',
    }, advanced, baseline, 21)).toBe(false)
    expect(module.focusedPcmRejectionEndsInjection(rejection, {
      ...advanced,
      running: false,
      captureActive: false,
      runtimeActive: false,
      runtimePhase: 'idle',
      completedTurns: 1,
    }, baseline, 21)).toBe(true)

    const invoke = vi.fn(async (command: string) => {
      if (command === 'aurora_android_voice_foreground_service_status') return advanced
      if (invoke.mock.calls.filter(([called]) => called === 'aurora_android_voice_live_test_inject_pcm').length === 1) {
        return { accepted: true }
      }
      return rejection
    })
    const status = await module.injectLiveTestPcm(
      invoke,
      Buffer.alloc(32_768),
      { focusedBaseline: baseline },
    )
    expect(status).toEqual(advanced)
    expect(invoke).toHaveBeenCalledWith('aurora_android_voice_foreground_service_status')
  })

  it('renews exclusive ingress while a slow background attempt is still pending', () => {
    const source = readFileSync(scriptPath, 'utf8')
    const pollBody = source.slice(
      source.indexOf('async function pollBackgroundWakeAttempt'),
      source.indexOf('function assertReadyVoiceStatus'),
    )

    expect(source).toContain('const LIVE_TEST_INGRESS_RENEW_INTERVAL_MS = 30_000')
    expect(pollBody).toContain(
      'let nextIngressRenewalAt = Date.now() + LIVE_TEST_INGRESS_RENEW_INTERVAL_MS',
    )
    expect(pollBody).toContain('await armLiveTestPcmIngress(invoke, { required: false })')
    expect(pollBody).toContain('if (Date.now() >= nextIngressRenewalAt) {')
    expect(pollBody).toContain('classifyBackgroundWakeAttempt(baseline, refreshedStatus)')
    expect(pollBody.indexOf("if (state === 'completed' || state === 'rearmed')")).toBeLessThan(
      pollBody.indexOf('await armLiveTestPcmIngress(invoke, { required: false })'),
    )
    expect(pollBody).toContain('nextIngressRenewalAt = Date.now() + LIVE_TEST_INGRESS_RENEW_INTERVAL_MS')
  })

  it('arms exclusive ingress before each capture and rejects any pre-fixture microphone push', () => {
    const source = readFileSync(scriptPath, 'utf8')
    const foregroundStart = source.indexOf('async function proveForegroundVoice')
    const foregroundBody = source.slice(foregroundStart, source.indexOf('\nasync function ', foregroundStart + 1))
    expect(foregroundBody.indexOf('await armLiveTestPcmIngress(invoke)')).toBeLessThan(
      foregroundBody.indexOf("await invoke('aurora_android_voice_foreground_service_start'"),
    )
    expect(foregroundBody).toContain('Number(active.acceptedSamples) !== 0')

    const profileSet = source.indexOf("await invoke('aurora_thin_profile_set'")
    expect(source.lastIndexOf('await armLiveTestPcmIngress(invoke)', profileSet)).toBeGreaterThan(-1)
  })

  it('renders the wake phrase separately from the post-wake command', async () => {
    const module = await liveSmokeModule()
    expect(module.ANDROID_BACKGROUND_WAKE_TEXT).toBe('Hey Aurora.')
    expect(module.ANDROID_BACKGROUND_COMMAND_TEXT).toBe('Confirm Android background voice.')
    const source = readFileSync(scriptPath, 'utf8')
    expect(source).toContain('Buffer.concat([backgroundWakePcm, backgroundCommandPcm])')
    expect(source).not.toContain("text: 'Hey Aurora. Confirm Android background voice.'")
  })

  it('accepts native bridge evidence only for the completed background turn generation', async () => {
    const module = await liveSmokeModule()
    const report = module.assertNativeEventBridgeProgression({
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      liveCollector: acknowledgedCollector([
        { payload: { subscriptionId: 'subscription-1', event: event(11, 'voice.turn.started', 41) } },
        { payload: { subscriptionId: 'subscription-1', event: event(12, 'voice.turn.finalized', 41, { persisted: true }) } },
      ]),
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: true,
        events: [event(12, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })

    expect(report.enabled).toBe(true)
    expect(report.completedGeneration).toBe(41)
    expect(report.matchingLiveEventCount).toBe(2)
    expect(report.matchingReplayEventCount).toBe(1)
    expect(report.observedKinds).toContain('voice.turn.started')
    expect(report.terminalKinds).toEqual(['voice.turn.finalized'])
    expect(report.terminalEventKinds).toEqual(['voice.turn.finalized'])
    expect(report.terminalSubjectKinds).toEqual(['voice.turn.finalized'])
    expect(report.replayLastSequenceId).toBe('native:12')
    expect(report.replayComplete).toBe(true)
    expect(report.replayRecovered).toBe(true)
    expect(report.duplicatePersistedResult).toBeNull()
    expect(report.persistedResultUniquenessMeasured).toBe(false)
    expect(report.persistedResultUnsupportedReason).toMatch(/saved conversation row ids/u)
    expect(report.nativeTtsPlaybackMeasured).toBe(false)
    expect(report.nativeTtsPlaybackUnsupportedReason).toMatch(/playback request ids/u)
  })

  it('derives the Android local-data snapshot scope from the active runtime profile', async () => {
    const module = await liveSmokeModule()
    expect(module.localDataScopeFromRuntimeProfile({
      id: 'profile-android',
      localNode: { stablePeerId: 'node-android' },
    })).toEqual({ profileId: 'profile-android', localNodeId: 'node-android' })

    expect(() => module.localDataScopeFromRuntimeProfile({
      id: 'profile-android',
      localNode: {},
    })).toThrow(/stable local node id/u)
  })

  it('accepts one native persisted user row and one assistant row without exposing content', async () => {
    const module = await liveSmokeModule()
    const beforeTurn = localDataSnapshot('beforeTurn', {
      'conversation-1': [
        localDataMessage('message-1', 'conversation-1', 0, 'user'),
        localDataMessage('message-2', 'conversation-1', 1, 'assistant'),
      ],
    })
    const afterHiddenCompletion = localDataSnapshot('afterHiddenCompletion', {
      'conversation-1': [
        ...beforeTurn.messagesByConversation['conversation-1']!,
        localDataMessage('voice-user-41', 'conversation-1', 2, 'user', {
          contentEnvelope: { plaintext: 'secret transcript must not be reported' },
        }),
        localDataMessage('voice-assistant-41', 'conversation-1', 3, 'assistant', {
          contentEnvelope: { plaintext: 'secret answer must not be reported' },
        }),
      ],
    })

    const report = module.assertNativeTurnLocalDataRecovery({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: structuredClone(afterHiddenCompletion),
      afterSecondReopen: structuredClone(afterHiddenCompletion),
      assistantResultExpected: true,
    })

    expect(report.persistedResultUniquenessMeasured).toBe(true)
    expect(report.duplicatePersistedResult).toBe(false)
    expect(report.afterHiddenCompletion.nativeDelta).toEqual({
      conversationId: 'conversation-1',
      newRows: [
        expect.objectContaining({ id: 'voice-user-41', role: 'user', sequence: 2, status: 'complete' }),
        expect.objectContaining({ id: 'voice-assistant-41', role: 'assistant', sequence: 3, status: 'complete' }),
      ],
    })
    expect(report.afterFirstReopen.sameAsAfterHiddenCompletion).toBe(true)
    expect(report.afterSecondReopen.sameAsAfterHiddenCompletion).toBe(true)
    expect(JSON.stringify(report)).not.toContain('secret transcript')
    expect(JSON.stringify(report)).not.toContain('secret answer')
  })

  it('rejects different-id duplicate U2/A2 rows instead of relying on primary-key uniqueness', async () => {
    const module = await liveSmokeModule()
    const beforeTurn = localDataSnapshot('beforeTurn', {
      'conversation-1': [
        localDataMessage('message-1', 'conversation-1', 0, 'user'),
      ],
    })
    const afterHiddenCompletion = localDataSnapshot('afterHiddenCompletion', {
      'conversation-1': [
        ...beforeTurn.messagesByConversation['conversation-1']!,
        localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
        localDataMessage('voice-user-41-duplicate', 'conversation-1', 2, 'user'),
        localDataMessage('voice-assistant-41', 'conversation-1', 3, 'assistant'),
        localDataMessage('voice-assistant-41-duplicate', 'conversation-1', 4, 'assistant'),
      ],
    })

    expect(() => module.assertNativeTurnLocalDataRecovery({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: structuredClone(afterHiddenCompletion),
      afterSecondReopen: structuredClone(afterHiddenCompletion),
      assistantResultExpected: true,
    })).toThrow(/exactly one new user row/u)

    expect(() => module.assertNativeTurnLocalDataRecovery({
      beforeTurn,
      afterHiddenCompletion: localDataSnapshot('afterHiddenCompletion', {
        'conversation-1': [
          ...beforeTurn.messagesByConversation['conversation-1']!,
          localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
          localDataMessage('voice-assistant-41', 'conversation-1', 2, 'assistant'),
          localDataMessage('voice-assistant-41-duplicate', 'conversation-1', 3, 'assistant'),
        ],
      }),
      afterFirstReopen: localDataSnapshot('afterFirstReopen', {
        'conversation-1': [
          ...beforeTurn.messagesByConversation['conversation-1']!,
          localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
          localDataMessage('voice-assistant-41', 'conversation-1', 2, 'assistant'),
          localDataMessage('voice-assistant-41-duplicate', 'conversation-1', 3, 'assistant'),
        ],
      }),
      afterSecondReopen: localDataSnapshot('afterSecondReopen', {
        'conversation-1': [
          ...beforeTurn.messagesByConversation['conversation-1']!,
          localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
          localDataMessage('voice-assistant-41', 'conversation-1', 2, 'assistant'),
          localDataMessage('voice-assistant-41-duplicate', 'conversation-1', 3, 'assistant'),
        ],
      }),
      assistantResultExpected: true,
    })).toThrow(/expected exactly one new assistant row; observed 2/u)
  })

  it('rejects row mutation or added rows during either UI recovery reopen', async () => {
    const module = await liveSmokeModule()
    const beforeTurn = localDataSnapshot('beforeTurn', {
      'conversation-1': [
        localDataMessage('message-1', 'conversation-1', 0, 'user'),
      ],
    })
    const afterHiddenCompletion = localDataSnapshot('afterHiddenCompletion', {
      'conversation-1': [
        ...beforeTurn.messagesByConversation['conversation-1']!,
        localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
        localDataMessage('voice-assistant-41', 'conversation-1', 2, 'assistant'),
      ],
    })

    expect(() => module.assertNativeTurnLocalDataRecovery({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: localDataSnapshot('afterFirstReopen', {
        'conversation-1': [
          beforeTurn.messagesByConversation['conversation-1']![0]!,
          localDataMessage('voice-user-41', 'conversation-1', 1, 'assistant'),
          localDataMessage('voice-assistant-41', 'conversation-1', 2, 'assistant'),
        ],
      }),
      afterSecondReopen: structuredClone(afterHiddenCompletion),
      assistantResultExpected: true,
    })).toThrow(/changed after first UI recovery/u)

    expect(() => module.assertNativeTurnLocalDataRecovery({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: structuredClone(afterHiddenCompletion),
      afterSecondReopen: localDataSnapshot('afterSecondReopen', {
        'conversation-1': [
          ...afterHiddenCompletion.messagesByConversation['conversation-1']!,
          localDataMessage('voice-assistant-41-duplicate', 'conversation-1', 3, 'assistant'),
        ],
      }),
      assistantResultExpected: true,
    })).toThrow(/changed after second UI recovery/u)
  })

  it('measures native playback counters advancing during the hidden turn and staying stable during recovery', async () => {
    const module = await liveSmokeModule()
    const beforeTurn = module.sanitizeNativePlaybackCounters(playbackCounters(), 'beforeTurn')
    const afterHiddenCompletion = module.sanitizeNativePlaybackCounters(playbackCounters({
      globalPlayCallCount: 11,
      globalChunkEnqueueCount: 34,
      globalFinalChunkQueuedCount: 11,
      globalDrainNonEmptyCount: 10,
      globalAckCount: 33,
      globalCompleteCount: 10,
      globalAudioTrackPlayCallCount: 12,
      globalAudioTrackWrittenSamples: 32_000,
    }), 'afterHiddenCompletion')

    const report = module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: structuredClone(afterHiddenCompletion),
      afterSecondReopen: structuredClone(afterHiddenCompletion),
    })

    expect(report.measured).toBe(true)
    expect(report.replayedDuringRecovery).toBe(false)
    expect(report.advancedDuringHiddenCompletion).toContain('globalPlayCallCount')
    expect(report.advancedDuringHiddenCompletion).toContain('globalChunkEnqueueCount')
    expect(report.advancedDuringHiddenCompletion).toContain('globalAudioTrackWrittenSamples')
    expect(report.afterFirstReopen.sameAsAfterHiddenCompletion).toBe(true)
    expect(report.afterSecondReopen.sameAsAfterHiddenCompletion).toBe(true)
    expect(JSON.stringify(report)).not.toContain('internal')
  })

  it('rejects unavailable playback counters and recovery replay increments', async () => {
    const module = await liveSmokeModule()
    expect(() => module.sanitizeNativePlaybackCounters({ available: false }, 'beforeTurn')).toThrow(/unavailable/u)

    const beforeTurn = module.sanitizeNativePlaybackCounters(playbackCounters(), 'beforeTurn')
    const afterHiddenCompletion = module.sanitizeNativePlaybackCounters(playbackCounters({
      globalPlayCallCount: 11,
      globalChunkEnqueueCount: 34,
      globalFinalChunkQueuedCount: 11,
      globalDrainNonEmptyCount: 10,
      globalAckCount: 33,
      globalCompleteCount: 10,
      globalAudioTrackPlayCallCount: 12,
      globalAudioTrackWrittenSamples: 32_000,
    }), 'afterHiddenCompletion')

    const diagnosticOnlyReopen = module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: {
        ...afterHiddenCompletion,
        globalAudioTrackPlayCallCount: Number(afterHiddenCompletion.globalAudioTrackPlayCallCount) + 1,
      },
      afterSecondReopen: structuredClone(afterHiddenCompletion),
    })
    expect(diagnosticOnlyReopen.replayedDuringRecovery).toBe(false)

    expect(() => module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: {
        ...afterHiddenCompletion,
        globalPlayCallCount: Number(afterHiddenCompletion.globalPlayCallCount) + 1,
      },
      afterSecondReopen: structuredClone(afterHiddenCompletion),
    })).toThrow(/globalPlayCallCount changed during first UI recovery/u)
    expect(() => module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion,
      afterFirstReopen: structuredClone(afterHiddenCompletion),
      afterSecondReopen: {
        ...afterHiddenCompletion,
        globalAudioTrackWrittenSamples: Number(afterHiddenCompletion.globalAudioTrackWrittenSamples) + 1600,
      },
    })).toThrow(/globalAudioTrackWrittenSamples changed during second UI recovery/u)
  })

  it('rejects hidden completion when playback counters do not advance, PCM writes do not advance, or failures appear', async () => {
    const module = await liveSmokeModule()
    const beforeTurn = module.sanitizeNativePlaybackCounters(playbackCounters(), 'beforeTurn')
    const unchanged = module.sanitizeNativePlaybackCounters(playbackCounters(), 'afterHiddenCompletion')
    expect(() => module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion: unchanged,
      afterFirstReopen: structuredClone(unchanged),
      afterSecondReopen: structuredClone(unchanged),
    })).toThrow(/did not advance/u)

    const requestOnly = module.sanitizeNativePlaybackCounters(playbackCounters({
      globalPlayCallCount: 11,
    }), 'afterHiddenCompletion')
    expect(() => module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion: requestOnly,
      afterFirstReopen: structuredClone(requestOnly),
      afterSecondReopen: structuredClone(requestOnly),
    })).toThrow(/AudioTrack written samples did not advance/u)

    const failed = module.sanitizeNativePlaybackCounters(playbackCounters({
      globalPlayCallCount: 11,
      globalChunkEnqueueCount: 34,
      globalFinalChunkQueuedCount: 11,
      globalDrainNonEmptyCount: 10,
      globalAckCount: 33,
      globalCompleteCount: 10,
      globalFailureCount: 1,
      globalAudioTrackPlayCallCount: 12,
      globalAudioTrackWrittenSamples: 32_000,
    }), 'afterHiddenCompletion')
    expect(() => module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion: failed,
      afterFirstReopen: structuredClone(failed),
      afterSecondReopen: structuredClone(failed),
    })).toThrow(/reported failures/u)
  })

  it('requires a persisted assistant row when finalized recovery is subject-only with actual hidden PCM playback', async () => {
    const module = await liveSmokeModule()
    const bridgeReport = module.assertNativeEventBridgeProgression({
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      liveCollector: acknowledgedCollector([
        { payload: { subscriptionId: 'subscription-1', event: event(11, 'voice.turn.started', 41) } },
      ]),
      replaySnapshot: {
        lastSequenceId: 'native:11',
        replayComplete: true,
        events: [],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })
    expect(bridgeReport.terminalKinds).toEqual(['voice.turn.finalized'])
    expect(bridgeReport.terminalEventKinds).toEqual([])
    expect(bridgeReport.terminalSubjectKinds).toEqual(['voice.turn.finalized'])

    const beforeTurn = module.sanitizeNativePlaybackCounters(playbackCounters(), 'beforeTurn')
    const afterHiddenCompletionPlayback = module.sanitizeNativePlaybackCounters(playbackCounters({
      globalPlayCallCount: 11,
      globalChunkEnqueueCount: 34,
      globalFinalChunkQueuedCount: 11,
      globalDrainNonEmptyCount: 10,
      globalAckCount: 33,
      globalCompleteCount: 10,
      globalAudioTrackPlayCallCount: 12,
      globalAudioTrackWrittenSamples: 32_000,
    }), 'afterHiddenCompletion')
    const playbackReport = module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion: afterHiddenCompletionPlayback,
      afterFirstReopen: structuredClone(afterHiddenCompletionPlayback),
      afterSecondReopen: structuredClone(afterHiddenCompletionPlayback),
    })
    expect(module.nativeTurnRequiresPersistedAssistantResult(bridgeReport, playbackReport)).toBe(true)

    const beforeRows = localDataSnapshot('beforeTurn', {
      'conversation-1': [localDataMessage('message-1', 'conversation-1', 0, 'user')],
    })
    const afterRows = localDataSnapshot('afterHiddenCompletion', {
      'conversation-1': [
        ...beforeRows.messagesByConversation['conversation-1']!,
        localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
      ],
    })
    expect(() => module.assertNativeTurnLocalDataRecovery({
      beforeTurn: beforeRows,
      afterHiddenCompletion: afterRows,
      afterFirstReopen: structuredClone(afterRows),
      afterSecondReopen: structuredClone(afterRows),
      assistantResultExpected: module.nativeTurnRequiresPersistedAssistantResult(bridgeReport, playbackReport),
    })).toThrow(/expected exactly one new assistant row/u)
  })

  it('requires a persisted assistant row for finalized native speech with actual hidden PCM playback', async () => {
    const module = await liveSmokeModule()
    const beforeTurn = module.sanitizeNativePlaybackCounters(playbackCounters(), 'beforeTurn')
    const afterHiddenCompletionPlayback = module.sanitizeNativePlaybackCounters(playbackCounters({
      globalPlayCallCount: 11,
      globalChunkEnqueueCount: 34,
      globalFinalChunkQueuedCount: 11,
      globalDrainNonEmptyCount: 10,
      globalAckCount: 33,
      globalCompleteCount: 10,
      globalAudioTrackPlayCallCount: 12,
      globalAudioTrackWrittenSamples: 32_000,
    }), 'afterHiddenCompletion')
    const playbackReport = module.assertNativePlaybackNoReplay({
      beforeTurn,
      afterHiddenCompletion: afterHiddenCompletionPlayback,
      afterFirstReopen: structuredClone(afterHiddenCompletionPlayback),
      afterSecondReopen: structuredClone(afterHiddenCompletionPlayback),
    })
    const bridgeReport = {
      matchingObservedKinds: ['voice.turn.finalized'],
      terminalKinds: ['voice.turn.finalized'],
    }
    expect(module.nativeTurnRequiresPersistedAssistantResult(bridgeReport, playbackReport)).toBe(true)

    const beforeRows = localDataSnapshot('beforeTurn', {
      'conversation-1': [localDataMessage('message-1', 'conversation-1', 0, 'user')],
    })
    const afterRows = localDataSnapshot('afterHiddenCompletion', {
      'conversation-1': [
        ...beforeRows.messagesByConversation['conversation-1']!,
        localDataMessage('voice-user-41', 'conversation-1', 1, 'user'),
      ],
    })
    expect(() => module.assertNativeTurnLocalDataRecovery({
      beforeTurn: beforeRows,
      afterHiddenCompletion: afterRows,
      afterFirstReopen: structuredClone(afterRows),
      afterSecondReopen: structuredClone(afterRows),
      assistantResultExpected: module.nativeTurnRequiresPersistedAssistantResult(bridgeReport, playbackReport),
    })).toThrow(/expected exactly one new assistant row/u)
  })

  it('rejects unrelated replay state and missing live bridge delivery for native acceptance', async () => {
    const module = await liveSmokeModule()
    const input = {
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      liveCollector: acknowledgedCollector([{ payload: event(11, 'voice.turn.finalized', 41, { persisted: true }) }]),
      replaySnapshot: {
        lastSequenceId: 'native:11',
        replayComplete: true,
        events: [event(11, 'voice.turn.finalized', 39, {
          persisted: true,
          requestId: 'request-41',
          conversationId: 'conversation-41',
        })],
        subjects: [subject('voice.turn.finalized', 39, {
          terminal: true,
          persisted: true,
          requestId: 'request-41',
          conversationId: 'conversation-41',
        })],
      },
    }

    expect(() => module.assertNativeEventBridgeProgression(input)).toThrow(/replay did not recover background turn generation 41/u)
    expect(() => module.assertNativeEventBridgeProgression({
      ...input,
      liveCollector: acknowledgedCollector([{
        payload: event(11, 'voice.turn.finalized', 39, {
          persisted: true,
          requestId: 'request-41',
          conversationId: 'conversation-41',
        }),
      }]),
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: true,
        events: [event(12, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })).toThrow(/did not deliver live events for background turn generation 41/u)
  })

  it('requires replay recovery separately from matching live native bridge events', async () => {
    const module = await liveSmokeModule()

    expect(() => module.assertNativeEventBridgeProgression({
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      liveCollector: acknowledgedCollector([{ payload: event(11, 'voice.turn.finalized', 41, { persisted: true }) }]),
      replaySnapshot: {
        lastSequenceId: 'native:11',
        replayComplete: true,
        events: [],
        subjects: [],
      },
    })).toThrow(/replay did not recover/u)
  })

  it('requires hidden UI and completed replay before claiming native bridge acceptance', async () => {
    const module = await liveSmokeModule()
    const input = {
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      liveCollector: acknowledgedCollector([{ payload: { event: event(11, 'voice.turn.finalized', 41, { persisted: true }) } }]),
      replaySnapshot: {
        lastSequenceId: 'native:11',
        replayComplete: true,
        events: [event(11, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    }

    expect(() => module.assertNativeEventBridgeProgression({
      ...input,
      uiHiddenDuringTurn: false,
    })).toThrow(/UI to be hidden/u)
    expect(() => module.assertNativeEventBridgeProgression({
      ...input,
      replaySnapshot: {
        ...input.replaySnapshot,
        replayComplete: false,
      },
    })).toThrow(/replay did not complete/u)
  })


  it('acks accepted native events in the normal collector and can withhold ack for slow-consumer recovery', () => {
    const source = readFileSync(scriptPath, 'utf8')
    const collectorBody = source.slice(
      source.indexOf('async function startNativeEventCollector'),
      source.indexOf('async function readNativeEventCollector'),
    )
    expect(collectorBody).toContain("invoke('aurora_native_event_ack'")
    expect(collectorBody).toContain('state.acknowledged.push')
    expect(collectorBody).toContain('state.withheldAcks.push')
    expect(collectorBody).toContain('acknowledgeEvents: ${JSON.stringify(acknowledgeEvents)}')
    expect(source).toContain("const NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE_ENV = 'AURORA_ANDROID_NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE'")
    expect(source).toContain('slowConsumer: nativeEventBridgeStallAcceptance')
    expect(source).toContain('allowIncompleteReplay: slowConsumer === true')
    expect(source).toContain('assertNativeEventBridgeSlowConsumerRecovery')
  })


  it('rejects normal native bridge evidence when ack mode, ack errors, or event acknowledgements are missing', async () => {
    const module = await liveSmokeModule()
    const normalEvent = { payload: { event: event(11, 'voice.turn.finalized', 41, { persisted: true }) } }
    const input = {
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      liveCollector: acknowledgedCollector([normalEvent]),
      replaySnapshot: {
        lastSequenceId: 'native:11',
        replayComplete: true,
        events: [event(11, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    }

    expect(() => module.assertNativeEventBridgeProgression({
      ...input,
      liveCollector: acknowledgedCollector([normalEvent], { acknowledgeEvents: false, withheldAcks: [{ eventId: 'native:11' }], acknowledged: [] }),
    })).toThrow(/normal mode did not acknowledge native events/u)
    expect(() => module.assertNativeEventBridgeProgression({
      ...input,
      liveCollector: acknowledgedCollector([normalEvent], { errors: ['ack failed'] }),
    })).toThrow(/acknowledgement errors/u)
    expect(() => module.assertNativeEventBridgeProgression({
      ...input,
      liveCollector: acknowledgedCollector([normalEvent], { acknowledged: [] }),
    })).toThrow(/without successful acknowledgement/u)
  })


  it('redacts native event and subject payloads from bridge assertion failures', async () => {
    const module = await liveSmokeModule()
    const sensitiveText = 'secret live transcript should not appear'

    expect(() => module.assertNativeEventBridgeSlowConsumerRecovery({
      active: { sessionGeneration: 40, acceptedSamples: 20_000 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed', acceptedSamples: 44_000 },
      afterSequence: 10,
      liveCollector: {
        acknowledgeEvents: false,
        withheldAcks: [{ eventId: 'native:11' }],
        acknowledged: [],
        events: [{ payload: event(11, 'voice.turn.started', 41, { transcript: sensitiveText }) }],
      },
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: true,
        events: [],
        subjects: [subject('voice.turn.requesting', 41, { transcript: sensitiveText })],
      },
    })).toThrow(/terminal state/u)

    try {
      module.assertNativeEventBridgeSlowConsumerRecovery({
        active: { sessionGeneration: 40, acceptedSamples: 20_000 },
        completed: { sessionGeneration: 41, liveOutcome: 'rearmed', acceptedSamples: 44_000 },
        afterSequence: 10,
        liveCollector: {
          acknowledgeEvents: false,
          withheldAcks: [{ eventId: 'native:11' }],
          acknowledged: [],
          events: [{ payload: event(11, 'voice.turn.started', 41, { transcript: sensitiveText }) }],
        },
        replaySnapshot: {
          lastSequenceId: 'native:12',
          replayComplete: true,
          events: [],
          subjects: [subject('voice.turn.requesting', 41, { transcript: sensitiveText })],
        },
      })
    } catch (error) {
      expect(String(error)).not.toContain(sensitiveText)
    }
  })

  it('accepts slow native consumption when ack is withheld and snapshot recovery exposes the terminal turn', async () => {
    const module = await liveSmokeModule()
    const report = module.assertNativeEventBridgeProgression({
      active: { sessionGeneration: 40, acceptedSamples: 20_000 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed', acceptedSamples: 44_000 },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
      allowGapEvents: true,
      allowIncompleteReplay: true,
      liveCollector: {
        acknowledgeEvents: false,
        withheldAcks: [{ eventId: 'native:11' }],
        acknowledged: [],
        events: [{ payload: { subscriptionId: 'subscription-1', event: event(11, 'voice.turn.started', 41) } }],
      },
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: false,
        events: [
          event(10, 'voice.turn.transcribing', 41),
          {
            ...event(10, 'native.events.gap', 41, {
              reason: 'subscriber_overrun',
              firstMissingSequence: 11,
              nextAvailableSequence: 12,
            }),
            subjects: [],
          },
        ],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })
    const slow = module.assertNativeEventBridgeSlowConsumerRecovery({
      active: { sessionGeneration: 40, acceptedSamples: 20_000 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed', acceptedSamples: 44_000 },
      afterSequence: 10,
      liveCollector: {
        acknowledgeEvents: false,
        withheldAcks: [{ eventId: 'native:11' }],
        acknowledged: [],
        events: [{ payload: { subscriptionId: 'subscription-1', event: event(11, 'voice.turn.started', 41) } }],
      },
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: false,
        events: [
          event(10, 'voice.turn.transcribing', 41),
          {
            ...event(10, 'native.events.gap', 41, {
              reason: 'subscriber_overrun',
              firstMissingSequence: 11,
              nextAvailableSequence: 12,
            }),
            subjects: [],
          },
        ],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })

    expect(report.replayComplete).toBe(false)
    expect(report.gapEventCount).toBe(1)
    expect(report.gapReasons).toContain('subscriber_overrun')
    expect(report.matchingObservedKinds).not.toContain('voice.turn.transcribing')
    expect(slow.enabled).toBe(true)
    expect(slow.acknowledgementWithheld).toBe(true)
    expect(slow.withheldAckCount).toBe(1)
    expect(slow.hubGapObserved).toBe(true)
    expect(slow.snapshotRecovered).toBe(true)
    expect(slow.limitation).toBeNull()
  })

  it('reports the live slow-consumer limitation when ack withholding recovers from snapshot without a hub gap', async () => {
    const module = await liveSmokeModule()
    const slow = module.assertNativeEventBridgeSlowConsumerRecovery({
      active: { sessionGeneration: 40, acceptedSamples: 20_000 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed', acceptedSamples: 44_000 },
      afterSequence: 10,
      liveCollector: {
        acknowledgeEvents: false,
        withheldAcks: [{ eventId: 'native:11' }],
        acknowledged: [],
        events: [{ payload: { subscriptionId: 'subscription-1', event: event(11, 'voice.turn.started', 41) } }],
      },
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: true,
        events: [],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })

    expect(slow.hubGapObserved).toBe(false)
    expect(slow.snapshotRecovered).toBe(true)
    expect(slow.limitation).toMatch(/does not expose a small subscriber capacity/u)
  })

  it('enforces terminal uniqueness and ordering without counting same-sequence replay overlap as duplicate', async () => {
    const module = await liveSmokeModule()
    const base = {
      active: { sessionGeneration: 40 },
      completed: { sessionGeneration: 41, liveOutcome: 'rearmed' },
      beforeSnapshot: { lastSequenceId: 'native:10' },
      afterSequence: 10,
      uiHiddenDuringTurn: true,
    }

    expect(() => module.assertNativeEventBridgeProgression({
      ...base,
      liveCollector: acknowledgedCollector([
        { payload: event(11, 'voice.turn.started', 41) },
        { payload: event(12, 'voice.turn.finalized', 41, { persisted: true }) },
      ]),
      replaySnapshot: {
        lastSequenceId: 'native:12',
        replayComplete: true,
        events: [event(12, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })).not.toThrow()

    expect(() => module.assertNativeEventBridgeProgression({
      ...base,
      liveCollector: acknowledgedCollector([
        { payload: event(11, 'voice.turn.started', 41) },
        { payload: event(12, 'voice.turn.finalized', 41, { persisted: true }) },
      ]),
      replaySnapshot: {
        lastSequenceId: 'native:13',
        replayComplete: true,
        events: [event(13, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })).toThrow(/duplicate terminal results/u)

    expect(() => module.assertNativeEventBridgeProgression({
      ...base,
      liveCollector: acknowledgedCollector([
        { payload: event(12, 'voice.turn.finalized', 41, { persisted: true }) },
        { payload: event(13, 'voice.turn.requesting', 41) },
      ]),
      replaySnapshot: {
        lastSequenceId: 'native:13',
        replayComplete: true,
        events: [event(12, 'voice.turn.finalized', 41, { persisted: true })],
        subjects: [subject('voice.turn.finalized', 41, { terminal: true, persisted: true })],
      },
    })).toThrow(/non-terminal events after the terminal state/u)
  })

  it('prefers already installed runtime-ready packs and skips reference-required TTS for the live lane', async () => {
    const module = await liveSmokeModule()
    const entries = [
      entry('stt', 'stt:whisper:tiny', 'multi', 116_204_861),
      entry('stt', 'stt:whisper:medium', 'multi', 126_204_861, {
        installed: true,
        readyForInstall: false,
        readyForRuntime: true,
      }),
      entry('tts', 'pockettts:en_us-raven-small', 'en-us', 18_204_861, {
        installed: true,
        readyForInstall: false,
        readyForRuntime: true,
        requiresReferenceAudio: true,
      }),
      entry('tts', 'standard:piper:en_gb-cori-medium-int8', 'en-gb', 20_768_736, {
        installed: false,
        readyForRuntime: false,
      }),
      entry('vad', 'vad:silero:current-int8', 'und', 212_860, {
        installed: true,
        readyForRuntime: true,
      }),
      entry('kws', 'kws:zipformer:gigaspeech', 'en', 17_626_723, {
        installed: true,
        readyForRuntime: true,
      }),
    ]

    const selected = module.selectAndroidVoicePacks({ entries }, { language: 'en' })
    expect(selected.stt.packId).toBe('stt:whisper:medium')
    expect(selected.tts.packId).toBe('standard:piper:en_gb-cori-medium-int8')
    expect(selected.tts.requiresReferenceAudio).not.toBe(true)
  })

  it('selects a requested language before an installed English default', async () => {
    const module = await liveSmokeModule()
    const entries = [
      entry('stt', 'stt:whisper:tiny', 'multi', 116_204_861, {
        installed: true,
        readyForRuntime: true,
      }),
      entry('tts', 'standard:piper:en_gb-cori-medium-int8', 'en-gb', 20_768_736, {
        installed: true,
        active: true,
        readyForRuntime: true,
      }),
      entry('tts', 'standard:piper:fr_fr-siwis-medium-int8', 'fr-fr', 21_102_000),
      entry('vad', 'vad:silero:current-int8', 'und', 212_860),
      entry('kws', 'kws:zipformer:gigaspeech', 'en', 17_626_723),
    ]

    const selected = module.selectAndroidVoicePacks({ entries }, { language: 'fr' })
    expect(selected.stt.packId).toBe('stt:whisper:tiny')
    expect(selected.tts.packId).toBe('standard:piper:fr_fr-siwis-medium-int8')
  })

  it('creates a valid runtime profile with local packs and deterministic wake phrase state', async () => {
    const module = await liveSmokeModule()
    const packs = {
      stt: entry('stt', 'stt:whisper:tiny', 'multi', 116_204_861),
      tts: entry('tts', 'standard:piper:en_gb-cori-medium-int8', 'en-gb', 20_768_736),
      vad: entry('vad', 'vad:silero:current-int8', 'und', 212_860),
      kws: entry('kws', 'kws:zipformer:gigaspeech', 'en', 17_626_723),
    }
    const profile = module.buildAndroidVoiceRuntimeProfile(packs, {
      language: 'en',
      homeGatewayUrl: 'https://gateway.example.test',
    })
    const selection = profile.profiles[0].localNode.localSpeechSelection

    expect(profile.version).toBe(2)
    expect(profile.profiles[0].nodeMode).toBe('mesh-node')
    expect(profile.profiles[0].runtimeTier).toBe('lightweight-ts')
    expect(profile.profiles[0].homeConnection).toEqual({
      mode: 'http-only',
      gatewayUrl: 'https://gateway.example.test',
    })
    expect(selection.tts).toMatchObject({
      packId: packs.tts.packId,
      packRevision: packs.tts.engineRuntimeRevision,
      voiceId: packs.tts.packId,
      voiceRevision: packs.tts.engineRuntimeRevision,
    })
    expect(selection.wakePhrase).toMatchObject({
      phraseId: 'hey-aurora.en',
      phrase: 'Hey Aurora',
      language: 'en',
    })
    expect(selection.wakePhrase.revision).toBe(module.wakePhraseRevision({
      phrase: 'Hey Aurora',
      language: 'en',
      packId: packs.kws.packId,
      packRevision: packs.kws.engineRuntimeRevision,
    }))
  })

  it('preserves provisioned identity, pairing, and mesh state while refreshing voice packs', async () => {
    const module = await liveSmokeModule()
    const packs = {
      stt: entry('stt', 'stt:whisper:tiny', 'multi', 116_204_861),
      tts: entry('tts', 'standard:piper:en_gb-cori-medium-int8', 'en-gb', 20_768_736),
      vad: entry('vad', 'vad:silero:current-int8', 'und', 212_860),
      kws: entry('kws', 'kws:zipformer:gigaspeech', 'en', 17_626_723),
    }
    const existing: RuntimeDocument = {
      version: 2,
      activeProfileId: 'profile-existing',
      profiles: [{
        id: 'profile-existing',
        label: 'My phone',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
        homeConnection: {
          mode: 'webrtc',
          gatewayUrl: 'https://peer.example.test',
          peerId: 'aurora-server',
        },
        localNode: {
          nodeName: 'Provisioned phone',
          stablePeerId: 'aurora-thin-existing',
          enabledCapabilityPacks: ['tools'],
          meshMembership: { roomId: 'room-existing' },
          localSpeechPackState: 'missing',
          localSpeechSelection: {},
        },
      }],
    }

    const merged = module.mergeAndroidVoiceRuntimeProfile(existing, packs, { language: 'en' })

    expect(merged).not.toBe(existing)
    expect(merged.activeProfileId).toBe('profile-existing')
    expect(merged.profiles[0]).toMatchObject({
      id: 'profile-existing',
      label: 'My phone',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      homeConnection: existing.profiles[0].homeConnection,
      localNode: {
        nodeName: 'Provisioned phone',
        stablePeerId: 'aurora-thin-existing',
        enabledCapabilityPacks: ['tools'],
        meshMembership: { roomId: 'room-existing' },
        localSpeechPackState: 'ready',
      },
    })
    expect(merged.profiles[0].localNode.localSpeechSelection.stt).toMatchObject({
      packId: packs.stt.packId,
      packRevision: packs.stt.engineRuntimeRevision,
    })
    expect(existing.profiles[0].localNode.localSpeechPackState).toBe('missing')
    expect(existing.profiles[0].localNode.localSpeechSelection).toEqual({})
  })

  it('lets the live lane select a deterministic wake phrase for the configured KWS pack', async () => {
    const module = await liveSmokeModule()
    const packs = {
      stt: entry('stt', 'stt:whisper:tiny', 'multi', 116_204_861),
      tts: entry('tts', 'standard:piper:en_gb-cori-medium-int8', 'en-gb', 20_768_736),
      vad: entry('vad', 'vad:silero:current-int8', 'und', 212_860),
      kws: entry('kws', 'kws:zipformer:zh-en-2025', 'en zh', 32_885_699),
    }

    const profile = module.buildAndroidVoiceRuntimeProfile(packs, {
      language: 'en',
      wakePhrase: { phraseId: 'light-up.en', phrase: 'Light up', language: 'en' },
    })

    expect(profile.profiles[0].localNode.localSpeechSelection.wakePhrase).toMatchObject({
      phraseId: 'light-up.en',
      phrase: 'Light up',
      language: 'en',
      revision: module.wakePhraseRevision({
        phrase: 'Light up',
        language: 'en',
        packId: packs.kws.packId,
        packRevision: packs.kws.engineRuntimeRevision,
      }),
    })
  })

  it('accepts a settled focused native transcript without requiring an assistant route', async () => {
    const module = await liveSmokeModule()
    const baseline = {
      acceptedSamples: 0,
      completedTurns: 4,
      failedTurns: 2,
    }

    expect(module.focusedTranscriptionCompleted(baseline, {
      running: false,
      captureActive: false,
      acceptedSamples: 60_852,
      completedTurns: 5,
      failedTurns: 2,
      captureError: null,
    })).toBe(true)
    expect(module.focusedTranscriptionCompleted(baseline, {
      running: false,
      captureActive: false,
      acceptedSamples: 60_852,
      completedTurns: 4,
      failedTurns: 3,
      captureError: 'assistant_unavailable',
    })).toBe(false)
  })

  it('compares focused completion with the current session after native counters reset', async () => {
    const module = await liveSmokeModule()
    const stoppedPreviousSession = {
      acceptedSamples: 96_000,
      completedTurns: 4,
      failedTurns: 0,
    }
    const activeFocusedSession = {
      acceptedSamples: 0,
      completedTurns: 0,
      failedTurns: 0,
    }
    const completedFocusedSession = {
      running: false,
      captureActive: false,
      acceptedSamples: 64_010,
      completedTurns: 1,
      failedTurns: 0,
      captureError: null,
    }

    expect(module.focusedTranscriptionCompleted(stoppedPreviousSession, completedFocusedSession)).toBe(false)
    expect(module.focusedTranscriptionCompleted(activeFocusedSession, completedFocusedSession)).toBe(true)
  })

  it('checks explicit initial background start, user Stop, reopen, foreground, screen-off, sticky restart, force-stop, and final cleanup', () => {
    const source = readFileSync(scriptPath, 'utf8')
    for (const invariant of [
      'captureBackend === \'android-audiorecord-rust-queue\'',
      "['shell', 'input', 'keyevent', 'HOME']",
      "['shell', 'input', 'keyevent', 'SLEEP']",
      "['shell', 'dumpsys', 'deviceidle', 'force-idle']",
      "['shell', 'am', 'crash', '--user', '0', context.appId]",
      "['shell', 'am', 'force-stop', context.appId]",
      "'aurora_android_voice_live_test_inject_pcm'",
      'focusedTranscriptionCompleted(active, status)',
      'request: { takeFocusedResult: true }',
      'const turnRunner = () => completeBackgroundWakeTurn(invoke, backgroundPcm, active, { acceptRearmed: !successful })',
      'bestEffortStopVoice(context, webview)',
      'wakeLockIsHeld(context)',
      'assertSelectedPacksPersisted',
      'stopVoiceAndRequireRelease',
      'proveExplicitBackgroundStart',
      'notification Stop remains effective after app reopen',
      'foreground cancellation remains effective after app reopen',
      'explicitBackgroundReenable',
      'remainedStoppedAfterReopen',
      'notificationStop.publicCancelConfirmed = true',
      'proveNotificationStop',
      "request: { remoteAudioConsent: false, backgroundSession: true }",
      "invoke('aurora_thin_profile_get')",
      'captureUiAutomatorHierarchy(context)',
      "resourceId: 'android:id/action0'",
      "contentDesc: 'Expand'",
      "'automatic background restart after force-stop and app reopen'",
    ]) {
      expect(source).toContain(invariant)
    }
    expect(source).toContain("'--ipv4'")
    expect(source).toContain("'--retry-all-errors'")
    expect(source).toContain('environment = process.env')
    const navigationStart = source.indexOf('navigateToMesh: async () => {')
    const navigationEnd = source.indexOf('\n        },', navigationStart)
    const navigationBody = source.slice(navigationStart, navigationEnd)
    expect(navigationStart).toBeGreaterThanOrEqual(0)
    expect(navigationEnd).toBeGreaterThan(navigationStart)
    expect(navigationBody).toContain('webview.close()')
    expect(navigationBody).toContain("adbRun(context, ['shell', 'am', 'force-stop', '--user', 'current', context.appId])")
    expect(navigationBody).toContain('launchApp(context)')
    expect(navigationBody).toContain('webview = await connectInstalledWebview(context)')
    expect(navigationBody).toContain('await navigateAndroidToMesh(webview.client)')
    expect(source).toContain('modelFixture,')
    expect(source).toContain('reopenForTurnUi')
    expect(source.indexOf("adbRun(context, ['shell', 'input', 'keyevent', 'HOME'])" , source.indexOf('async function proveNativeEventBridgeAcceptance')))
      .toBeLessThan(source.indexOf('const turn = runTurn()', source.indexOf('async function proveNativeEventBridgeAcceptance')))
    expect(source).not.toContain('advertisedMethodIds')
    expect(source).not.toContain('assistantRouteEvidenceFromProfile')
    expect(source).toContain("await invokeTauri(webview.client, 'aurora_thin_profile_get')")
    expect(source).toContain('webview = await connectInstalledWebview(context)')
    expect(source).toContain('Native turn acceptance terminal evidence was not correlated')
    const foregroundBody = source.slice(
      source.indexOf('async function proveForegroundVoice'),
      source.indexOf('async function proveBackgroundVoice'),
    )
    const backgroundBody = source.slice(
      source.indexOf('async function proveBackgroundVoice'),
      source.indexOf('async function proveStickyRestart'),
    )
    expect(foregroundBody).toContain('status.backendAudioEvidenceRequired === false')
    expect(foregroundBody).toContain('focusedTranscriptionCompleted(active, status)')
    expect(foregroundBody).toContain("localTurnOutcome: 'transcribed'")
    expect(foregroundBody).toContain('transcriptionAfterFinish: settledAt - injectionCompletedAt')
    expect(foregroundBody).not.toContain('status.microphoneSignalDetected === true')
    expect(backgroundBody).toContain('Number(completed.acceptedSamples) <= Number(active.acceptedSamples ?? 0)')
    expect(backgroundBody).toContain("completed.liveOutcome !== 'rearmed'")
    expect(source).not.toContain(
      "'pm', 'grant', context.appId, 'android.permission.FOREGROUND_SERVICE_MICROPHONE'",
    )
    expect(source).not.toContain("['shell', 'run-as'")
    expect(source).not.toContain('{ expectUserStop: true }')
    const freshnessBody = source.slice(
      source.indexOf('function apkFreshnessInputs()'),
      source.indexOf('function assertApkFreshness', source.indexOf('function apkFreshnessInputs()')),
    )
    for (const packagedInput of [
      'scripts/install-android-native-plugin.mjs',
      'src-tauri/build.rs',
      'src-tauri/permissions/aurora-android-native-plugin.toml',
      'src-tauri/src/lib.rs',
    ]) {
      expect(freshnessBody).toContain(packagedInput)
    }
    expect(freshnessBody).not.toContain('scripts/android-voice-live-smoke.mjs')
  })
})
