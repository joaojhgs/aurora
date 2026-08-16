import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = resolve(appRoot, 'scripts/android-voice-live-smoke.mjs')

async function liveSmokeModule() {
  return import(pathToFileURL(scriptPath).href) as Promise<{
    parseAdbDevices(output: string): Array<{ serial: string; state: string; line: string }>
    resolveAndroidDeviceSerial(output: string, explicit?: string): string
    selectAndroidVoicePacks(status: unknown, options?: unknown): Record<string, CatalogEntry>
    buildAndroidVoiceRuntimeProfile(
      packs: Record<string, CatalogEntry>,
      options: { gatewayUrl: string; language?: string },
    ): RuntimeDocument
    wakePhraseRevision(input: {
      phrase: string
      language: string
      packId: string
      packRevision: string
    }): string
    notificationIsVisibleFromDump(output: string, appId: string): boolean
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
    classifyBackgroundWakeAttempt(baseline: Record<string, unknown>, status: Record<string, unknown>):
      'completed' | 'rearmed' | 'failed' | 'pending'
    parseGatewayRequestBody(value: string): Record<string, unknown>
    ANDROID_BACKGROUND_WAKE_TEXT: string
    ANDROID_BACKGROUND_COMMAND_TEXT: string
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
    homeConnection: { mode: string; gatewayUrl: string }
    localNode: {
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
    ]

    const selected = module.selectAndroidVoicePacks({ entries }, { language: 'en' })
    expect(selected.stt.packId).toBe('stt:whisper:tiny')
    expect(selected.tts.packId).toBe('standard:piper:en_gb-cori-medium-int8')
    expect(selected.vad.packId).toBe('vad:silero:current-int8')
    expect(selected.kws.packId).toBe('kws:zipformer:gigaspeech')

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

  it('rejects malformed Gateway fixture requests instead of counting them as completed turns', async () => {
    const module = await liveSmokeModule()

    expect(module.parseGatewayRequestBody('{"session_id":"session-1"}')).toEqual({
      session_id: 'session-1',
    })
    expect(() => module.parseGatewayRequestBody('{')).toThrow('not valid JSON')
    expect(() => module.parseGatewayRequestBody('[]')).toThrow('must be a JSON object')
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
    for (const errorCode of ['wake_not_detected', 'speech_not_detected', 'speech_timeout']) {
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
      microphoneSignalDetected: true,
      acceptedSamples: 0,
    })).toBe(true)
  })

  it('re-polls the native gate immediately before every background PCM batch', () => {
    const source = readFileSync(scriptPath, 'utf8')
    const turnBody = source.slice(
      source.indexOf('async function completeBackgroundWakeTurn'),
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

    for (const runtimePhase of ['processing', 'speaking', 'stopping']) {
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

    expect(module.backgroundPcmRejectionEndsInjection(rejection, baseline, baseline, 0)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection(rejection, baseline, baseline, 12)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection(rejection, {
      ...baseline,
      captureActive: false,
      runtimePhase: 'processing',
    }, baseline, 12)).toBe(false)
    expect(module.backgroundPcmRejectionEndsInjection({
      accepted: false,
      reason: 'pcm_ingress_rejected',
    }, {
      ...baseline,
      runtimePhase: 'processing',
    }, baseline, 12)).toBe(false)
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

  it('arms exclusive ingress before each service start and rejects any pre-fixture microphone push', () => {
    const source = readFileSync(scriptPath, 'utf8')
    for (const functionName of ['proveForegroundVoice', 'proveBackgroundVoice']) {
      const start = source.indexOf(`async function ${functionName}`)
      const nextFunction = source.indexOf('\nasync function ', start + 1)
      const body = source.slice(start, nextFunction)
      expect(body.indexOf('await armLiveTestPcmIngress(invoke)')).toBeLessThan(
        body.indexOf("await invoke('aurora_android_voice_foreground_service_start'"),
      )
      expect(body).toContain('Number(active.acceptedSamples) !== 0')
    }
  })

  it('renders the wake phrase separately from the post-wake command', async () => {
    const module = await liveSmokeModule()
    expect(module.ANDROID_BACKGROUND_WAKE_TEXT).toBe('Hey Aurora.')
    expect(module.ANDROID_BACKGROUND_COMMAND_TEXT).toBe('Confirm Android background voice.')
    const source = readFileSync(scriptPath, 'utf8')
    expect(source).toContain('Buffer.concat([backgroundWakePcm, backgroundCommandPcm])')
    expect(source).not.toContain("text: 'Hey Aurora. Confirm Android background voice.'")
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
      gatewayUrl: 'http://127.0.0.1:38177',
      language: 'en',
    })
    const selection = profile.profiles[0].localNode.localSpeechSelection

    expect(profile.version).toBe(2)
    expect(profile.profiles[0].homeConnection).toEqual({
      mode: 'http-only',
      gatewayUrl: 'http://127.0.0.1:38177',
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

  it('checks foreground, screen-off, sticky restart, force-stop, and final cleanup', () => {
    const source = readFileSync(scriptPath, 'utf8')
    for (const invariant of [
      'captureBackend === \'android-audiorecord-rust-queue\'',
      "['shell', 'input', 'keyevent', 'HOME']",
      "['shell', 'input', 'keyevent', 'SLEEP']",
      "['shell', 'dumpsys', 'deviceidle', 'force-idle']",
      "['shell', 'am', 'crash', '--user', '0', context.appId]",
      "['shell', 'am', 'force-stop', context.appId]",
      "'aurora_android_voice_live_test_inject_pcm'",
      'Number(status.completedTurns)',
      'assistantGatewayRequestCount(gateway)',
      'bestEffortStopVoice(context, webview)',
      'wakeLockIsHeld(context)',
      'assertSelectedPacksPersisted',
      'stopVoiceAndRequireRelease',
    ]) {
      expect(source).toContain(invariant)
    }
    const foregroundBody = source.slice(
      source.indexOf('async function proveForegroundVoice'),
      source.indexOf('async function proveBackgroundVoice'),
    )
    const backgroundBody = source.slice(
      source.indexOf('async function proveBackgroundVoice'),
      source.indexOf('async function proveStickyRestart'),
    )
    expect(foregroundBody).toContain('microphoneSignalDetected: active.microphoneSignalDetected')
    expect(foregroundBody).toContain('status.microphoneSignalDetected === true')
    expect(backgroundBody).toContain('completed.microphoneSignalDetected !== true')
    expect(source).not.toContain(
      "'pm', 'grant', context.appId, 'android.permission.FOREGROUND_SERVICE_MICROPHONE'",
    )
    expect(source).not.toContain("['shell', 'run-as'")
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
