import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { acquireAndroidSmokeLock, resolveAndroidSmokeLockPath } from './android-emulator-smoke-runner.mjs'
import { connectAndroidWebviewCdp } from './android-webview-cdp.mjs'

const DEFAULT_APP_ID = 'dev.aurora.desktop'
const DEFAULT_PACK_TIMEOUT_MS = 30 * 60_000
const DEFAULT_STATUS_TIMEOUT_MS = 120_000
const DEFAULT_WEBVIEW_TIMEOUT_MS = 180_000
const COMMAND_TIMEOUT_MS = 30_000
const PACK_POLL_MS = 2_000
const STATUS_POLL_MS = 500
const MAX_DIAGNOSTIC_BYTES = 24_000
const LIVE_TEST_PCM_CHUNK_BYTES = 3_200
const LIVE_TEST_PCM_SAMPLE_RATE_HZ = 16_000
const MAX_BACKGROUND_WAKE_ATTEMPTS = 2
// Refresh at one quarter of Android's 120-second abandonment window so slow
// on-device KWS remains isolated without disabling the bounded fail-safe.
const LIVE_TEST_INGRESS_RENEW_INTERVAL_MS = 30_000
export const ANDROID_BACKGROUND_WAKE_TEXT = 'Hey Aurora.'
export const ANDROID_BACKGROUND_COMMAND_TEXT = 'Confirm Android background voice.'
const DEFAULT_WAKE_PHRASES = {
  en: { phraseId: 'hey-aurora.en', phrase: 'Hey Aurora', language: 'en' },
  zh: { phraseId: 'ni-hao-aurora.zh', phrase: '你好 Aurora', language: 'zh' },
}
const VOICE_TEST_ARCHIVE = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_GB-cori-medium-int8.tar.bz2',
  sha256: '169ca8aff3adb271f009a4924c99928a811dbf2b52eaca2dbb460e8c34478c93',
  sizeBytes: 20_768_736,
  root: 'vits-piper-en_GB-cori-medium-int8',
  model: 'en_GB-cori-medium.onnx',
  config: 'en_GB-cori-medium.onnx.json',
}
const PIPER_FIXTURE_TOOL = 'piper-tts==1.2.0'
const ANDROID_VOICE_SERVICE = 'dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService'
const ANDROID_VOICE_STOP_ACTION = 'dev.aurora.tauri.nativeplugin.action.STOP_VOICE_CAPTURE'
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_ROOT = resolve(APP_ROOT, '../..')

const TASKS = ['stt', 'tts', 'vad', 'kws']
const DEFAULT_PACK_IDS = {
  stt: 'stt:whisper:tiny',
  tts: 'standard:piper:en_gb-cori-medium-int8',
  vad: 'vad:silero:current-int8',
  kws: 'kws:zipformer:zh-en-2025',
}
const RECOVERABLE_BACKGROUND_CAPTURE_ERRORS = new Set([
  'assistant_unavailable',
  'wake_not_detected',
  'speech_not_detected',
  'speech_timeout',
])

export function parseAdbDevices(output) {
  return String(output)
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'))
    .map((line) => {
      const [serial, state = '', ...details] = line.split(/\s+/u)
      return { serial, state, details: details.join(' '), line }
    })
    .filter((device) => device.serial && device.state === 'device')
}

export function resolveAndroidDeviceSerial(devicesOutput, explicitSerial) {
  const devices = parseAdbDevices(devicesOutput)
  if (explicitSerial) {
    if (!devices.some((device) => device.serial === explicitSerial)) {
      throw new Error(`Android device ${explicitSerial} is not connected.`)
    }
    return explicitSerial
  }
  const waydroid = devices.filter((device) => /waydroid/iu.test(device.line))
  if (waydroid.length === 1) return waydroid[0].serial
  if (waydroid.length > 1) {
    throw new Error(`More than one Waydroid device is connected: ${waydroid.map((item) => item.serial).join(', ')}`)
  }
  if (devices.length === 1) return devices[0].serial
  if (devices.length === 0) throw new Error('No authorized Android device is connected.')
  throw new Error('No Waydroid device could be selected from the connected Android devices.')
}

export function selectAndroidVoicePacks(catalogStatus, {
  language = 'en',
  explicitPackIds = {},
} = {}) {
  const entries = Array.isArray(catalogStatus?.entries) ? catalogStatus.entries : []
  if (entries.length === 0) throw new Error('The packaged Android speech catalog is empty.')
  const selected = {}
  for (const task of TASKS) {
    const compatible = entries
      .filter((entry) => entry?.runtimeTask === task && (entry.installed === true || entry.readyForInstall === true))
      .sort(compareVoicePackCandidates)
    const candidatePool = task === 'tts'
      ? compatible.filter((entry) => entry?.requiresReferenceAudio !== true)
      : compatible
    if (task === 'tts' && candidatePool.length === 0) {
      throw new Error('No TTS pack without reference audio is available for the live Android voice lane.')
    }
    const requested = explicitPackIds[task]
    const requestedEntry = requested ? candidatePool.find((entry) => entry.packId === requested) : undefined
    if (requested && !requestedEntry) {
      throw new Error(`Requested ${task.toUpperCase()} pack is unavailable on this device: ${requested}`)
    }
    const languageCandidates = candidatePool.filter((entry) => packMatchesLanguage(entry, language, task))
    const installedLanguageEntry = languageCandidates.find(
      (entry) => entry.installed === true && entry.readyForRuntime === true,
    )
    const languageEntry = languageCandidates[0]
    const installedEntry = candidatePool.find((entry) => entry.installed === true && entry.readyForRuntime === true)
    const activeEntry = candidatePool.find((entry) => entry.installed === true && entry.active === true)
    const defaultEntry = candidatePool.find((entry) => entry.packId === DEFAULT_PACK_IDS[task])
    const compatibleDefaultEntry = defaultEntry && packMatchesLanguage(defaultEntry, language, task)
      ? defaultEntry
      : undefined
    const installedDefaultEntry = compatibleDefaultEntry?.installed === true
      && compatibleDefaultEntry.readyForRuntime === true
      ? compatibleDefaultEntry
      : undefined
    const preferredKwsEntry = task === 'kws'
      ? installedDefaultEntry ?? compatibleDefaultEntry
      : undefined
    const entry = requestedEntry
      ?? preferredKwsEntry
      ?? installedLanguageEntry
      ?? languageEntry
      ?? installedEntry
      ?? activeEntry
      ?? candidatePool[0]
    if (!entry) throw new Error(`No installable Android ${task.toUpperCase()} pack is compatible with this device.`)
    selected[task] = entry
  }
  return selected
}

export function buildAndroidVoiceRuntimeProfile(packs, {
  language = 'en',
  profileId = 'aurora-waydroid-voice-live',
  wakePhrase = undefined,
} = {}) {
  for (const task of TASKS) {
    if (!packs?.[task]?.packId || !packs[task].engineRuntimeRevision) {
      throw new Error(`Android live voice profile is missing ${task.toUpperCase()} pack metadata.`)
    }
  }
  const wakeLanguage = wakeLanguageForPack(packs.kws, language)
  const selectedWakePhrase = sanitizeWakePhraseSelection(wakePhrase, wakeLanguage)
  const { phraseId, phrase } = selectedWakePhrase
  const kwsSelection = speechSelection(packs.kws)
  const wakeRevision = wakePhraseRevision({
    phrase,
    language: selectedWakePhrase.language,
    packId: kwsSelection.packId,
    packRevision: kwsSelection.packRevision,
  })
  return {
    version: 2,
    activeProfileId: profileId,
    profiles: [{
      version: 2,
      id: profileId,
      label: 'Android voice live check',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      localNode: {
        nodeName: 'Android voice device',
        stablePeerId: profileId,
        enabledCapabilityPacks: [],
        localSpeechPackState: 'ready',
        localSpeechSelection: {
          stt: speechSelection(packs.stt),
          tts: {
            ...speechSelection(packs.tts),
            voiceId: packs.tts.packId,
            voiceRevision: packs.tts.engineRuntimeRevision,
          },
          vad: speechSelection(packs.vad),
          kws: kwsSelection,
          wakePhrase: {
            phraseId,
            phrase,
            language: selectedWakePhrase.language,
            revision: wakeRevision,
          },
        },
      },
    }],
  }
}

export function mergeAndroidVoiceRuntimeProfile(existingDocument, packs, options = {}) {
  const existing = cloneRuntimeProfileDocument(existingDocument)
  const active = existing?.profiles?.find((profile) => profile?.id === existing.activeProfileId)
  const stablePeerId = active?.localNode?.stablePeerId?.trim()
  if (!active || !stablePeerId) return buildAndroidVoiceRuntimeProfile(packs, options)

  const voiceProfile = buildAndroidVoiceRuntimeProfile(packs, {
    ...options,
    profileId: active.id,
  }).profiles[0]
  active.localNode = {
    ...active.localNode,
    localSpeechPackState: 'ready',
    localSpeechSelection: voiceProfile.localNode.localSpeechSelection,
  }
  return existing
}

function cloneRuntimeProfileDocument(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.profiles)) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

function parseStoredRuntimeProfile(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return cloneRuntimeProfileDocument(JSON.parse(value))
  } catch {
    return null
  }
}

export function wakePhraseSelectionFromEnvironment(language = 'en') {
  const phrase = process.env.AURORA_ANDROID_WAKE_PHRASE?.trim()
  if (!phrase) return undefined
  const phraseId = process.env.AURORA_ANDROID_WAKE_PHRASE_ID?.trim()
    || phrase
      .toLocaleLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, '-')
      .replace(/^-+|-+$/gu, '')
      .concat(`.${language}`)
  return { phraseId, phrase, language }
}

function sanitizeWakePhraseSelection(selection, fallbackLanguage) {
  if (!selection) return DEFAULT_WAKE_PHRASES[fallbackLanguage] ?? DEFAULT_WAKE_PHRASES.en
  const phrase = String(selection.phrase ?? '').trim().replace(/\s+/gu, ' ')
  const phraseId = String(selection.phraseId ?? '').trim()
  const language = String(selection.language ?? fallbackLanguage).trim() || fallbackLanguage
  if (!phrase || !phraseId) {
    throw new Error(`Invalid Android live wake phrase selection: ${JSON.stringify(selection)}`)
  }
  return { phraseId, phrase, language }
}

export function wakePhraseRevision({ phrase, language, packId, packRevision }) {
  const normalized = [
    String(phrase).trim().replace(/\s+/gu, ' ').toLocaleLowerCase(),
    String(language).toLocaleLowerCase(),
    String(packId),
    String(packRevision),
  ].join('\n')
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `wakephrase-v1-${hash.toString(36).padStart(7, '0')}`
}

export async function runAndroidVoiceLiveSmoke() {
  const adb = resolveAdbCommand()
  const devicesOutput = commandOutput(adb, ['devices', '-l'])
  const serial = resolveAndroidDeviceSerial(
    devicesOutput,
    process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL,
  )
  const releaseLock = await acquireAndroidSmokeLock({
    lockPath: resolveAndroidSmokeLockPath(serial),
  })
  const appId = process.env.AURORA_ANDROID_APP_ID ?? DEFAULT_APP_ID
  const apk = process.env.AURORA_ANDROID_APK ? resolve(process.env.AURORA_ANDROID_APK) : findApk()
  const context = { adb, serial, appId }
  let fixtures
  let webview

  try {
    if (!apk || !existsSync(apk)) {
      throw new Error('No Android APK found. Build it once before running android:voice:live.')
    }
    assertApkFreshness(apk)
    adbRun(context, ['wait-for-device'], { timeoutMs: 60_000 })
    if (process.env.AURORA_ANDROID_SKIP_INSTALL !== '1') installApk(context, apk)
    grantVoicePermissions(context)
    adbRun(context, ['logcat', '-c'])

    launchApp(context)
    webview = await connectInstalledWebview(context)
    let invoke = (command, args) => invokeTauri(webview.client, command, args)

    const initialCatalog = await invoke('aurora_android_voice_pack_catalog_status')
    const packs = selectAndroidVoicePacks(initialCatalog, {
      language: process.env.AURORA_ANDROID_VOICE_LANGUAGE ?? 'en',
      explicitPackIds: explicitPackIdsFromEnvironment(),
    })
    for (const task of TASKS) {
      await ensurePackReady(invoke, task, packs[task])
    }

    const readyCatalog = await invoke('aurora_android_voice_pack_catalog_status')
    const readyPacks = resolveSelectedCatalogEntries(readyCatalog, packs)
    const storedProfile = await invoke('aurora_thin_profile_get')
    const profile = mergeAndroidVoiceRuntimeProfile(parseStoredRuntimeProfile(storedProfile?.value), readyPacks, {
      language: process.env.AURORA_ANDROID_VOICE_LANGUAGE ?? 'en',
      wakePhrase: wakePhraseSelectionFromEnvironment(process.env.AURORA_ANDROID_VOICE_LANGUAGE ?? 'en'),
    })
    await armLiveTestPcmIngress(invoke)
    const profileResult = await invoke('aurora_thin_profile_set', { value: JSON.stringify(profile) })
    if (profileResult?.ok !== true) {
      throw new Error(`Android voice profile was not applied: ${JSON.stringify(profileResult)}`)
    }

    const activeProfile = profile.profiles.find((candidate) => candidate.id === profile.activeProfileId)
    if (!activeProfile?.localNode?.localSpeechSelection?.wakePhrase?.phrase) {
      throw new Error('Android voice profile has no active wake phrase after preserving device identity.')
    }
    fixtures = prepareVoiceFixtures({
      wakeText: activeProfile.localNode.localSpeechSelection.wakePhrase.phrase,
    })
    const automaticBackgroundStart = await proveAutomaticBackgroundStart(invoke)
    const notificationStop = await proveNotificationStop(context, invoke)
    webview.close()
    webview = null
    adbRun(context, ['shell', 'am', 'force-stop', context.appId])
    launchApp(context)
    webview = await connectInstalledWebview(context)
    invoke = (command, args) => invokeTauri(webview.client, command, args)
    await pollVoiceStatus(
      invoke,
      backgroundMicrophoneReadyForInjection,
      'background restart after foreground app reopen',
      { allowRecoverableBackgroundErrors: true },
    )
    notificationStop.restartedOnReopen = true
    await stopVoiceAndRequireRelease(context, invoke)
    const foreground = await proveForegroundVoice(context, invoke, fixtures.foregroundPcm)
    webview.close()
    webview = null
    adbRun(context, ['shell', 'am', 'force-stop', context.appId])
    launchApp(context)
    webview = await connectInstalledWebview(context)
    invoke = (command, args) => invokeTauri(webview.client, command, args)
    const background = await proveBackgroundVoice(context, invoke, fixtures.backgroundPcm)

    webview.close()
    webview = null
    const sticky = await proveStickyRestart(context, background.status.acceptedSamples)
    launchApp(context)
    webview = await connectInstalledWebview(context)
    let resumedInvoke = (command, args) => invokeTauri(webview.client, command, args)
    const resumed = await pollVoiceStatus(
      resumedInvoke,
      (status) => status.running === true
        && status.backgroundSessionActive === true
        && status.captureActive === true
        && Number(status.acceptedSamples) > 0,
      'sticky background restart',
      { allowRecoverableBackgroundErrors: true },
    )
    const forceStop = await proveForceStopPersistence(context, resumedInvoke, readyPacks)
    webview.close()
    webview = null
    launchApp(context)
    webview = await connectInstalledWebview(context)
    resumedInvoke = (command, args) => invokeTauri(webview.client, command, args)
    const afterForceStop = await pollVoiceStatus(
      resumedInvoke,
      backgroundMicrophoneReadyForInjection,
      'automatic background restart after force-stop and app reopen',
      { allowRecoverableBackgroundErrors: true },
    )
    const persistedCatalog = await resumedInvoke('aurora_android_voice_pack_catalog_status')
    assertSelectedPacksPersisted(persistedCatalog, readyPacks)

    await stopVoiceAndRequireRelease(context, resumedInvoke)
    const finalForegroundStart = await resumedInvoke('aurora_android_voice_foreground_service_start', {
      request: { remoteAudioConsent: false, backgroundSession: false },
    })
    if (finalForegroundStart?.started !== true) {
      throw new Error(`Foreground restart after force-stop was rejected: ${JSON.stringify(finalForegroundStart)}`)
    }
    await pollVoiceStatus(
      resumedInvoke,
      (status) => status.running === true && status.captureActive === true && Number(status.acceptedSamples) > 0,
      'foreground restart after force-stop',
    )
    await stopVoiceAndRequireRelease(context, resumedInvoke)

    const result = {
      ok: true,
      device: deviceMetadata(context, devicesOutput),
      apk: { path: apk, sha256: sha256File(apk) },
      packs: Object.fromEntries(TASKS.map((task) => [task, readyPacks[task].packId])),
      automaticBackgroundStart,
      foreground,
      background: {
        acceptedSamples: background.status.acceptedSamples,
        microphoneSignalDetected: background.status.microphoneSignalDetected,
        completedTurns: background.status.completedTurns,
        failedTurns: background.status.failedTurns,
        localTurnOutcome: background.status.liveOutcome,
        serviceVisible: background.serviceVisible,
        notificationVisible: background.notificationVisible,
        wakeLockHeld: background.wakeLockHeld,
        doze: background.doze,
      },
      notificationStop,
      sticky: { ...sticky, acceptedSamples: resumed.acceptedSamples },
      forceStop,
      assistantRoute: 'local-only',
      finalStatus: summarizeVoiceStatus(await resumedInvoke('aurora_android_voice_foreground_service_status')),
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    const diagnostics = collectDiagnostics(context)
    console.error(JSON.stringify({
      ok: false,
      error: errorMessage(error),
      diagnostics,
    }, null, 2))
    throw error
  } finally {
    await bestEffortStopVoice(context, webview)
    webview?.close()
    adbTry(context, ['shell', 'dumpsys', 'deviceidle', 'unforce'])
    adbTry(context, ['shell', 'input', 'keyevent', 'WAKEUP'])
    fixtures?.close()
    releaseLock()
  }
}

async function proveAutomaticBackgroundStart(invoke) {
  const active = await pollVoiceStatus(
    invoke,
    backgroundMicrophoneReadyForInjection,
    'automatic background start after hands-free configuration',
    { allowRecoverableBackgroundErrors: true },
  )
  if (active.backgroundStoppedByUser === true) {
    throw new Error(`Automatic background start retained a stale user-stop marker: ${JSON.stringify(active)}`)
  }
  return {
    started: true,
    captureBackend: active.captureBackend,
    acceptedSamples: active.acceptedSamples,
  }
}

async function proveForegroundVoice(context, invoke, foregroundPcm) {
  const before = await invoke('aurora_android_voice_foreground_service_status')
  assertReadyVoiceStatus(before)
  await armLiveTestPcmIngress(invoke)
  const startedAt = Date.now()
  const start = await invoke('aurora_android_voice_foreground_service_start', {
    request: { remoteAudioConsent: false, backgroundSession: false },
  })
  if (start?.started !== true) throw new Error(`Foreground voice start was rejected: ${JSON.stringify(start)}`)
  const active = await pollVoiceStatus(
    invoke,
    (status) => status.running === true
      && status.captureActive === true
      && status.runtimeActive === true
      && (status.runtimePhase === 'starting' || status.runtimePhase === 'listening')
      && status.captureBackend === 'android-audiorecord-rust-queue'
      && status.backendAudioEvidenceRequired === false,
    'foreground native PCM gate',
  )
  const captureReadyAt = Date.now()
  if (Number(active.acceptedSamples) !== 0) {
    throw new Error(`Foreground microphone audio entered native ingress before the fixture: ${JSON.stringify(active)}`)
  }
  await armLiveTestPcmIngress(invoke)
  await injectLiveTestPcm(invoke, foregroundPcm)
  const injectionCompletedAt = Date.now()
  const finish = await invoke('aurora_android_voice_foreground_service_finish')
  if (finish?.finished !== true) throw new Error(`Foreground voice finish was rejected: ${JSON.stringify(finish)}`)
  const completed = await pollVoiceStatus(
    invoke,
    // Native session counters restart for each focused capture. Compare the
    // terminal state with this session's active zero-sample baseline, not the
    // stopped background session that preceded it.
    (status) => focusedTranscriptionCompleted(active, status),
    'foreground local transcription turn',
  )
  const settledAt = Date.now()
  const focusedResult = await invoke('aurora_android_voice_foreground_service_status', {
    request: { takeFocusedResult: true },
  })
  const transcript = typeof focusedResult?.focusedTranscript === 'string'
    ? focusedResult.focusedTranscript.trim()
    : ''
  if (!transcript) {
    throw new Error(`Foreground native transcription completed without a transcript: ${JSON.stringify(focusedResult)}`)
  }

  const lifecycleStart = await invoke('aurora_android_voice_foreground_service_start', {
    request: { remoteAudioConsent: false, backgroundSession: false },
  })
  if (lifecycleStart?.started !== true) {
    throw new Error(`Foreground lifecycle restart was rejected: ${JSON.stringify(lifecycleStart)}`)
  }
  const lifecycleActive = await pollVoiceStatus(
    invoke,
    (status) => status.running === true
      && status.captureActive === true
      && status.runtimeActive === true
      && status.captureBackend === 'android-audiorecord-rust-queue'
      && Number(status.acceptedSamples) > 0,
    'foreground lifecycle microphone capture',
  )
  adbRun(context, ['shell', 'input', 'keyevent', 'HOME'])
  const afterHome = await pollVoiceStatus(
    invoke,
    (status) => status.running !== true && status.captureActive !== true,
    'foreground HOME release',
  )
  const serviceVisible = serviceIsVisible(context)
  const notificationVisible = notificationIsVisible(context)
  const wakeLockHeld = wakeLockIsHeld(context)
  if (serviceVisible || notificationVisible || wakeLockHeld) {
    throw new Error(
      `Foreground voice did not release the OS-owned mic path after HOME: service=${serviceVisible}, notification=${notificationVisible}, wakeLock=${wakeLockHeld}`,
    )
  }
  if (afterHome.captureActive === true || afterHome.running === true) {
    throw new Error(`Foreground voice still active after HOME: ${JSON.stringify(afterHome)}`)
  }
  await stopVoiceAndRequireRelease(context, invoke)
  return {
    acceptedSamples: lifecycleActive.acceptedSamples,
    captureBackend: active.captureBackend,
    completedTurns: completed.completedTurns,
    failedTurns: completed.failedTurns,
    transcript,
    localTurnOutcome: 'transcribed',
    timingMs: {
      captureReady: captureReadyAt - startedAt,
      fixtureIngress: injectionCompletedAt - captureReadyAt,
      transcriptionAfterFinish: settledAt - injectionCompletedAt,
      total: settledAt - startedAt,
    },
    serviceVisible,
    notificationVisible,
  }
}

export function focusedTranscriptionCompleted(baseline, status) {
  return status?.running !== true
    && status?.captureActive !== true
    && Number(status?.acceptedSamples ?? 0) > Number(baseline?.acceptedSamples ?? 0)
    && Number(status?.completedTurns ?? 0) > Number(baseline?.completedTurns ?? 0)
    && Number(status?.failedTurns ?? 0) === Number(baseline?.failedTurns ?? 0)
    && !status?.captureError
}

async function proveBackgroundVoice(context, invoke, backgroundPcm) {
  const before = await invoke('aurora_android_voice_foreground_service_status')
  assertReadyVoiceStatus(before, { background: true })
  const active = await pollVoiceStatus(
    invoke,
    backgroundMicrophoneReadyForInjection,
    'background microphone capture',
    { allowRecoverableBackgroundErrors: true },
  )
  await armLiveTestPcmIngress(invoke)
  const completed = await completeBackgroundWakeTurn(invoke, backgroundPcm, active, { acceptRearmed: true })
  if (completed.liveOutcome !== 'rearmed' || Number(completed.failedTurns) <= Number(active.failedTurns ?? 0)) {
    throw new Error(`Background local transcription did not re-arm after the optional assistant route was unavailable: ${JSON.stringify(completed)}`)
  }
  if (Number(completed.acceptedSamples) <= Number(active.acceptedSamples ?? 0)) {
    throw new Error('Background native PCM samples were not accepted while completing the local turn.')
  }
  adbRun(context, ['shell', 'input', 'keyevent', 'HOME'])
  await sleep(1_500)
  const serviceVisible = serviceIsVisible(context)
  const notificationVisible = notificationIsVisible(context)
  const wakeLockHeld = wakeLockIsHeld(context)
  if (!serviceVisible || !notificationVisible || !wakeLockHeld) {
    throw new Error(
      `Background voice lost durable OS state after HOME: service=${serviceVisible}, notification=${notificationVisible}, wakeLock=${wakeLockHeld}`,
    )
  }
  const doze = await exerciseScreenOffAndDoze(context)
  if (!serviceIsVisible(context) || !wakeLockIsHeld(context)) {
    throw new Error('Background voice did not retain its service and wake lock through screen-off.')
  }
  return {
    status: completed,
    serviceVisible,
    notificationVisible,
    wakeLockHeld,
    doze,
  }
}

async function proveNotificationStop(context, invoke) {
  await tapNotificationStop(context)
  const stopped = await pollVoiceStatus(
    invoke,
    (status) => status.running !== true
      && status.captureActive !== true
      && status.backgroundStoppedByUser === true,
    'notification Stop action',
  )
  await sleep(1_000)
  const stillStopped = await invoke('aurora_android_voice_foreground_service_status')
  if (stillStopped.running === true || stillStopped.backgroundStoppedByUser !== true) {
    throw new Error(`Background voice ignored the notification Stop action: ${JSON.stringify(stillStopped)}`)
  }

  return {
    stopped: stopped.backgroundStoppedByUser === true,
    remainedStoppedUntilReopen: true,
    restartedOnReopen: false,
  }
}

async function tapNotificationStop(context) {
  adbRun(context, ['shell', 'cmd', 'statusbar', 'expand-notifications'])
  await sleep(1_000)
  const hierarchy = adbOutput(context, ['exec-out', 'uiautomator', 'dump', '/dev/tty'])
  const action = hierarchy.match(
    /<node[^>]*text="Stop"[^>]*resource-id="android:id\/action0"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/u,
  )
  if (!action) {
    adbTry(context, ['shell', 'cmd', 'statusbar', 'collapse'])
    throw new Error('Aurora background voice notification did not expose its Stop action.')
  }
  const left = Number(action[1])
  const top = Number(action[2])
  const right = Number(action[3])
  const bottom = Number(action[4])
  adbRun(context, [
    'shell',
    'input',
    'tap',
    String(Math.round((left + right) / 2)),
    String(Math.round((top + bottom) / 2)),
  ])
  await sleep(500)
  adbRun(context, ['shell', 'cmd', 'statusbar', 'collapse'])
}

async function proveStickyRestart(context, previousSamples) {
  const previousPid = appPid(context)
  if (!previousPid) throw new Error('Android voice process is not running before sticky restart check.')
  const killed = adbTry(context, ['shell', 'am', 'crash', '--user', '0', context.appId])
  if (!killed.ok) {
    throw new Error(`Android could not induce process death for sticky restart proof: ${killed.output}`)
  }
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_STICKY_RESTART_TIMEOUT_MS ?? 90_000)
  let restartedPid = ''
  while (Date.now() < deadline) {
    restartedPid = appPid(context)
    if (restartedPid && restartedPid !== previousPid && serviceIsVisible(context) && wakeLockIsHeld(context)) break
    await sleep(1_000)
  }
  if (!restartedPid || restartedPid === previousPid) {
    throw new Error('Android did not recreate the durable voice service after process death.')
  }
  return { method: 'am crash', previousPid, restartedPid, previousSamples }
}

async function proveForceStopPersistence(context, invoke, packs) {
  launchApp(context)
  const before = await invoke('aurora_android_voice_foreground_service_status')
  if (before.backgroundSessionActive !== true || before.captureActive !== true) {
    const start = await invoke('aurora_android_voice_foreground_service_start', {
      request: { remoteAudioConsent: false, backgroundSession: true },
    })
    if (start?.started !== true) throw new Error(`Background restart before force-stop was rejected: ${JSON.stringify(start)}`)
  }
  await pollVoiceStatus(
    invoke,
    (status) => status.backgroundSessionActive === true && status.captureActive === true && Number(status.acceptedSamples) > 0,
    'background capture before force-stop',
    { allowRecoverableBackgroundErrors: true },
  )
  adbRun(context, ['shell', 'am', 'force-stop', context.appId])
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && (appPid(context) || serviceIsVisible(context))) await sleep(500)
  if (appPid(context) || serviceIsVisible(context)) {
    throw new Error('Android force-stop did not stop the application and voice service.')
  }
  return {
    stopped: true,
    selectedPacks: Object.fromEntries(TASKS.map((task) => [task, packs[task].packId])),
  }
}

async function stopVoiceAndRequireRelease(context, invoke) {
  await invoke('aurora_android_voice_foreground_service_cancel')
  await pollVoiceStatus(
    invoke,
    (status) => status.running !== true
      && status.captureActive !== true,
    'voice stop',
  )
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && wakeLockIsHeld(context)) await sleep(250)
  if (wakeLockIsHeld(context)) throw new Error('Android background voice wake lock remained held after stop.')
}

async function ensurePackReady(invoke, task, selectedEntry) {
  let catalog = await invoke('aurora_android_voice_pack_catalog_status')
  let entry = catalogEntry(catalog, selectedEntry.packId)
  if (!entry) throw new Error(`Android ${task.toUpperCase()} pack disappeared from the catalog: ${selectedEntry.packId}`)
  if (entry.installed !== true) {
    if (process.env.AURORA_ANDROID_SKIP_PACK_DOWNLOAD === '1') {
      throw new Error(`Android ${task.toUpperCase()} pack is not installed: ${entry.packId}`)
    }
    const started = await invoke('aurora_android_voice_pack_download', {
      request: { packId: entry.packId, task, activate: true, forceDownload: false },
    })
    const jobId = started?.jobId
    if (!jobId) throw new Error(`Android ${task.toUpperCase()} pack download did not return a job: ${JSON.stringify(started)}`)
    await pollPackJob(invoke, jobId, task)
  } else if (entry.active !== true) {
    const activated = await invoke('aurora_android_voice_pack_activate', {
      request: { packId: entry.packId, task },
    })
    if (activated?.activated !== true) {
      throw new Error(`Android ${task.toUpperCase()} pack activation failed: ${JSON.stringify(activated)}`)
    }
  }
  catalog = await invoke('aurora_android_voice_pack_catalog_status')
  entry = catalogEntry(catalog, selectedEntry.packId)
  if (entry?.installed !== true || entry?.active !== true || entry?.readyForRuntime !== true) {
    throw new Error(`Android ${task.toUpperCase()} pack is not runtime-ready: ${JSON.stringify(entry)}`)
  }
}

async function pollPackJob(invoke, jobId, task) {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_PACK_TIMEOUT_MS ?? DEFAULT_PACK_TIMEOUT_MS)
  while (Date.now() < deadline) {
    const status = await invoke('aurora_android_voice_pack_download_status', { request: { jobId } })
    if (status?.status === 'completed') return status
    if (status?.status === 'failed') {
      throw new Error(`Android ${task.toUpperCase()} pack job failed: ${JSON.stringify(status)}`)
    }
    await sleep(PACK_POLL_MS)
  }
  throw new Error(`Android ${task.toUpperCase()} pack job timed out: ${jobId}`)
}

async function pollVoiceStatus(invoke, predicate, label, options = {}) {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_VOICE_STATUS_TIMEOUT_MS ?? DEFAULT_STATUS_TIMEOUT_MS)
  const allowRecoverableBackgroundErrors = options.allowRecoverableBackgroundErrors === true
  let last
  while (Date.now() < deadline) {
    last = await invoke('aurora_android_voice_foreground_service_status')
    if (predicate(last)) return last
    if (
      allowRecoverableBackgroundErrors
      && last?.backgroundSessionActive === true
      && typeof last?.captureError === 'string'
      && RECOVERABLE_BACKGROUND_CAPTURE_ERRORS.has(last.captureError)
    ) {
      await sleep(STATUS_POLL_MS)
      continue
    }
    if (typeof last?.captureError === 'string' && last.captureError) {
      throw new Error(`Android ${label} faulted: ${JSON.stringify(last)}`)
    }
    await sleep(STATUS_POLL_MS)
  }
  throw new Error(`Android ${label} timed out. Last status: ${JSON.stringify(last)}`)
}

export function isRecoverableBackgroundCaptureError(errorCode) {
  return RECOVERABLE_BACKGROUND_CAPTURE_ERRORS.has(String(errorCode))
}

export function backgroundVoiceAcceptsInjectedPcm(status) {
  return status?.running === true
    && status?.backgroundSessionActive === true
    && status?.captureActive === true
    && status?.runtimeActive === true
    && (
      status?.runtimePhase === 'starting'
      || status?.runtimePhase === 'waiting-for-wake'
      || status?.runtimePhase === 'listening'
    )
    && !status?.captureError
}

export function backgroundMicrophoneReadyForInjection(status) {
  return backgroundVoiceAcceptsInjectedPcm(status)
    && status?.captureBackend === 'android-audiorecord-rust-queue'
    && status?.backendAudioEvidenceRequired === false
}

export function classifyBackgroundWakeAttempt(baseline, status) {
  const captureOwned = status?.running === true
    && status?.backgroundSessionActive === true
    && status?.captureActive === true
  const active = captureOwned
    && status?.runtimeActive === true
  const completed = Number(status?.completedTurns ?? 0) > Number(baseline?.completedTurns ?? 0)
  if (completed && captureOwned && !status?.captureError) return 'completed'

  if (status?.running !== true || status?.backgroundSessionActive !== true) return 'failed'
  const captureError = typeof status?.captureError === 'string' ? status.captureError : ''
  if (captureError && !isRecoverableBackgroundCaptureError(captureError)) return 'failed'

  const failed = Number(status?.failedTurns ?? 0) > Number(baseline?.failedTurns ?? 0)
  if (!failed) return 'pending'
  const generationAdvanced = Number(status?.sessionGeneration ?? 0) > Number(baseline?.sessionGeneration ?? 0)
  if (generationAdvanced && backgroundVoiceAcceptsInjectedPcm(status)) return 'rearmed'
  if (!generationAdvanced && active && !captureError) return 'failed'
  return 'pending'
}

export async function completeBackgroundWakeTurn(invoke, pcm, initialStatus, { acceptRearmed = false } = {}) {
  let last = initialStatus
  let acceptedSamplesAfterPreviousBatch = null
  for (let attempt = 1; attempt <= MAX_BACKGROUND_WAKE_ATTEMPTS; attempt += 1) {
    const baseline = await pollVoiceStatus(
      invoke,
      backgroundVoiceAcceptsInjectedPcm,
      `background PCM gate before wake attempt ${attempt}`,
      { allowRecoverableBackgroundErrors: true },
    )
    if (acceptedSamplesAfterPreviousBatch != null
      && Number(baseline.acceptedSamples) !== acceptedSamplesAfterPreviousBatch) {
      throw new Error(
        `Live microphone audio entered native ingress between background fixture attempts: ${JSON.stringify(baseline)}`,
      )
    }
    await armLiveTestPcmIngress(invoke)
    const transitionStatus = await injectLiveTestPcm(invoke, pcm, { backgroundBaseline: baseline })
    const afterInjection = transitionStatus
      ?? await invoke('aurora_android_voice_foreground_service_status')
    acceptedSamplesAfterPreviousBatch = Number(afterInjection.acceptedSamples ?? 0)
    const outcome = await pollBackgroundWakeAttempt(invoke, baseline, attempt)
    last = outcome.status
    if (outcome.state === 'completed') {
      if (Number(last.completedTurns) <= Number(initialStatus?.completedTurns ?? 0)) {
        throw new Error(`Android background wake completion counter did not advance: ${JSON.stringify(last)}`)
      }
      return { ...last, liveOutcome: 'completed' }
    }
    if (outcome.state === 'rearmed' && acceptRearmed) {
      return { ...last, liveOutcome: 'rearmed' }
    }
    if (attempt === MAX_BACKGROUND_WAKE_ATTEMPTS) break
  }
  throw new Error(
    `Android background wakeword voice turn did not complete after ${MAX_BACKGROUND_WAKE_ATTEMPTS} grounded attempts. Last status: ${JSON.stringify(last)}`,
  )
}

async function pollBackgroundWakeAttempt(invoke, baseline, attempt) {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_VOICE_STATUS_TIMEOUT_MS ?? DEFAULT_STATUS_TIMEOUT_MS)
  let nextIngressRenewalAt = Date.now() + LIVE_TEST_INGRESS_RENEW_INTERVAL_MS
  let last
  while (Date.now() < deadline) {
    last = await invoke('aurora_android_voice_foreground_service_status')
    const state = classifyBackgroundWakeAttempt(baseline, last)
    if (state === 'completed' || state === 'rearmed') return { state, status: last }
    if (state === 'failed') {
      throw new Error(`Android background wake attempt ${attempt} faulted: ${JSON.stringify(last)}`)
    }
    if (Date.now() >= nextIngressRenewalAt) {
      const renewed = await armLiveTestPcmIngress(invoke, { required: false })
      if (!renewed) {
        const refreshedStatus = await invoke('aurora_android_voice_foreground_service_status')
        const refreshedState = classifyBackgroundWakeAttempt(baseline, refreshedStatus)
        if (refreshedState === 'completed' || refreshedState === 'rearmed') {
          return { state: refreshedState, status: refreshedStatus }
        }
        throw new Error(
          `Android background wake attempt ${attempt} lost exclusive PCM ingress: ${JSON.stringify(refreshedStatus)}`,
        )
      }
      nextIngressRenewalAt = Date.now() + LIVE_TEST_INGRESS_RENEW_INTERVAL_MS
    }
    await sleep(STATUS_POLL_MS)
  }
  throw new Error(
    `Android background wake attempt ${attempt} did not complete or rearm with a newer session generation. Last status: ${JSON.stringify(last)}`,
  )
}

function assertReadyVoiceStatus(status, { background = false } = {}) {
  const required = ['manifestReady', 'microphoneGranted', 'notificationReady', 'nativeSessionReady']
  if (background) required.push('localDuplexReady', 'backgroundRuntimeReady', 'backgroundStartable')
  else required.push('startable')
  const missing = required.filter((field) => status?.[field] !== true)
  if (status?.platform !== 'android' || missing.length > 0) {
    throw new Error(`Android voice is not ready (${missing.join(', ')}): ${JSON.stringify(status)}`)
  }
}

function assertSelectedPacksPersisted(catalog, packs) {
  for (const task of TASKS) {
    const entry = catalogEntry(catalog, packs[task].packId)
    if (entry?.installed !== true || entry?.active !== true || entry?.readyForRuntime !== true) {
      throw new Error(`Android ${task.toUpperCase()} pack did not persist across force-stop: ${packs[task].packId}`)
    }
  }
}

function resolveSelectedCatalogEntries(catalog, selected) {
  return Object.fromEntries(TASKS.map((task) => {
    const entry = catalogEntry(catalog, selected[task].packId)
    if (!entry) throw new Error(`Selected Android ${task.toUpperCase()} pack is absent after activation.`)
    return [task, entry]
  }))
}

function catalogEntry(catalog, packId) {
  return Array.isArray(catalog?.entries) ? catalog.entries.find((entry) => entry?.packId === packId) : undefined
}

function speechSelection(entry) {
  return { packId: entry.packId, packRevision: entry.engineRuntimeRevision }
}

function packMatchesLanguage(entry, language, task) {
  if (task === 'vad') return true
  const normalized = String(entry?.language ?? '').toLocaleLowerCase()
  const target = String(language).toLocaleLowerCase().split(/[-_]/u)[0]
  if (task === 'stt' && normalized === 'multi') return true
  return normalized
    .split(/[\s,/]+/u)
    .some((candidate) => (
      candidate === target
      || candidate.startsWith(`${target}-`)
      || candidate.startsWith(`${target}_`)
    ))
}

function wakeLanguageForPack(entry, fallback) {
  const value = `${entry?.language ?? ''} ${entry?.packId ?? ''}`.toLocaleLowerCase()
  const supportsChinese = /(^|[\s._:-])(zh|cn|chinese|wenet)([\s._:-]|$)/u.test(value)
  const supportsEnglish = /(^|[\s._:-])(en|english|giga|gigaspeech)([\s._:-]|$)/u.test(value)
  if (supportsChinese && supportsEnglish) {
    return String(fallback).toLocaleLowerCase().startsWith('zh') ? 'zh' : 'en'
  }
  if (supportsChinese) return 'zh'
  if (supportsEnglish) return 'en'
  return String(fallback).toLocaleLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function explicitPackIdsFromEnvironment() {
  return {
    stt: process.env.AURORA_ANDROID_STT_PACK_ID,
    tts: process.env.AURORA_ANDROID_TTS_PACK_ID,
    vad: process.env.AURORA_ANDROID_VAD_PACK_ID,
    kws: process.env.AURORA_ANDROID_KWS_PACK_ID,
  }
}

export function prepareVoiceFixtures({ wakeText = ANDROID_BACKGROUND_WAKE_TEXT } = {}) {
  const directory = mkdtempSync(join(os.tmpdir(), 'aurora-android-voice-'))
  try {
    const archive = join(directory, 'voice.tar.bz2')
    commandRun('curl', [
      '--fail',
      '--ipv4',
      '--location',
      '--retry',
      '3',
      '--retry-all-errors',
      '--connect-timeout',
      '20',
      '--silent',
      '--show-error',
      '--output',
      archive,
      VOICE_TEST_ARCHIVE.url,
    ], { timeoutMs: 10 * 60_000 })
    if (statSync(archive).size !== VOICE_TEST_ARCHIVE.sizeBytes || sha256File(archive) !== VOICE_TEST_ARCHIVE.sha256) {
      throw new Error('Pinned Android live voice fixture archive failed size or SHA-256 verification.')
    }
    commandRun('tar', ['-xjf', archive, '-C', directory], { timeoutMs: 5 * 60_000 })
    const modelRoot = join(directory, VOICE_TEST_ARCHIVE.root)
    const model = join(modelRoot, VOICE_TEST_ARCHIVE.model)
    const config = join(modelRoot, VOICE_TEST_ARCHIVE.config)
    const foregroundPcm = renderVoiceFixture({
      directory,
      name: 'foreground',
      text: 'Confirm Android foreground voice.',
      model,
      config,
      trailingSilenceSeconds: 1,
    })
    const backgroundWakePcm = renderVoiceFixture({
      directory,
      name: 'background-wake',
      text: wakeText.endsWith('.') ? wakeText : `${wakeText}.`,
      model,
      config,
      trailingSilenceSeconds: 1,
    })
    const backgroundCommandPcm = renderVoiceFixture({
      directory,
      name: 'background-command',
      text: ANDROID_BACKGROUND_COMMAND_TEXT,
      model,
      config,
      trailingSilenceSeconds: 2,
    })
    const backgroundPcm = Buffer.concat([backgroundWakePcm, backgroundCommandPcm])
    return {
      foregroundPcm,
      backgroundPcm,
      close() {
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function renderVoiceFixture({ directory, name, text, model, config, trailingSilenceSeconds }) {
  const wav = join(directory, `${name}.wav`)
  commandRunWithInput(
    'uvx',
    ['--from', PIPER_FIXTURE_TOOL, 'piper', '-m', model, '-c', config, '-f', wav, '--sentence-silence', '0.4'],
    `${text}\n`,
    { cwd: WORKSPACE_ROOT, timeoutMs: 5 * 60_000 },
  )
  const samples = wavToPcm16Mono(readFileSync(wav), LIVE_TEST_PCM_SAMPLE_RATE_HZ)
  if (samples.length === 0 || samples.length % 2 !== 0) {
    throw new Error(`Generated Android ${name} voice fixture is not PCM16 mono audio.`)
  }
  const silence = Buffer.alloc(LIVE_TEST_PCM_SAMPLE_RATE_HZ * 2 * trailingSilenceSeconds)
  return Buffer.concat([samples, silence])
}

export function wavToPcm16Mono(wav, targetSampleRateHz = LIVE_TEST_PCM_SAMPLE_RATE_HZ) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF'
    || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Android voice fixture is not a RIFF/WAVE file.')
  }

  let format
  let samples
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + size
    if (dataEnd > wav.length) throw new Error(`Android voice fixture has a truncated ${id} chunk.`)
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Android voice fixture has an invalid format chunk.')
      format = {
        encoding: wav.readUInt16LE(dataStart),
        channels: wav.readUInt16LE(dataStart + 2),
        sampleRateHz: wav.readUInt32LE(dataStart + 4),
        blockAlign: wav.readUInt16LE(dataStart + 12),
        bitsPerSample: wav.readUInt16LE(dataStart + 14),
      }
    } else if (id === 'data') {
      samples = wav.subarray(dataStart, dataEnd)
    }
    offset = dataEnd + (size % 2)
  }

  if (!format || !samples || format.encoding !== 1 || format.bitsPerSample !== 16
    || format.channels < 1 || format.sampleRateHz < 1
    || format.blockAlign !== format.channels * 2 || targetSampleRateHz < 1) {
    throw new Error('Android voice fixture must be PCM16 audio with valid channel and sample-rate metadata.')
  }

  const sourceFrames = Math.floor(samples.length / format.blockAlign)
  if (sourceFrames === 0) return Buffer.alloc(0)
  const targetFrames = Math.max(1, Math.round(sourceFrames * targetSampleRateHz / format.sampleRateHz))
  const output = Buffer.allocUnsafe(targetFrames * 2)
  const sampleAt = (frame) => {
    let total = 0
    for (let channel = 0; channel < format.channels; channel += 1) {
      total += samples.readInt16LE(frame * format.blockAlign + channel * 2)
    }
    return total / format.channels
  }
  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = frame * format.sampleRateHz / targetSampleRateHz
    const leftFrame = Math.min(Math.floor(sourcePosition), sourceFrames - 1)
    const rightFrame = Math.min(leftFrame + 1, sourceFrames - 1)
    const fraction = sourcePosition - leftFrame
    const value = Math.round(sampleAt(leftFrame) * (1 - fraction) + sampleAt(rightFrame) * fraction)
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, value)), frame * 2)
  }
  return output
}

export async function injectLiveTestPcm(invoke, pcm, { backgroundBaseline } = {}) {
  if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length % 2 !== 0) {
    throw new Error('Android live voice PCM fixture is empty or misaligned.')
  }
  let acceptedFrames = 0
  for (let offset = 0; offset < pcm.length; offset += LIVE_TEST_PCM_CHUNK_BYTES) {
    const frame = pcm.subarray(offset, Math.min(offset + LIVE_TEST_PCM_CHUNK_BYTES, pcm.length))
    const result = await invoke('aurora_android_voice_live_test_inject_pcm', {
      request: { pcmBase64: frame.toString('base64') },
    })
    if (result?.accepted !== true) {
      const status = backgroundBaseline
        ? await invoke('aurora_android_voice_foreground_service_status')
        : undefined
      if (backgroundPcmRejectionEndsInjection(result, status, backgroundBaseline, acceptedFrames)) {
        return status
      }
      throw new Error(
        `Android live voice PCM frame was rejected after ${acceptedFrames} accepted frames: ${JSON.stringify({ result, status })}`,
      )
    }
    acceptedFrames += 1
    await sleep(90)
  }
  return undefined
}

export function backgroundPcmRejectionEndsInjection(rejection, status, baseline, acceptedFrames) {
  if (rejection?.reason !== 'voice_session_not_accepting_audio' || acceptedFrames <= 0) return false
  const captureOwned = status?.running === true
    && status?.backgroundSessionActive === true
    && status?.captureActive === true
  if (!captureOwned) return false
  if (Number(status?.completedTurns ?? 0) > Number(baseline?.completedTurns ?? 0)) return true
  if (
    Number(status?.failedTurns ?? 0) > Number(baseline?.failedTurns ?? 0)
    && isRecoverableBackgroundCaptureError(status?.captureError)
  ) return true
  if (status?.captureError) return false
  return status?.runtimeActive === true
    && [
      'processing',
      'transcribing',
      'waiting-for-response',
      'preparing-speech',
      'speaking',
      'stopping',
    ].includes(status?.runtimePhase)
}

export async function armLiveTestPcmIngress(invoke, { required = true } = {}) {
  const result = await invoke('aurora_android_voice_live_test_inject_pcm', {
    request: { pcmBase64: '', armIngress: true },
  })
  const accepted = result?.accepted === true
  if (!accepted && required) {
    throw new Error(`Android live voice PCM ingress could not be armed: ${JSON.stringify(result)}`)
  }
  return accepted
}

async function bestEffortStopVoice(context, webview) {
  if (!context?.adb || !context?.serial) return
  if (webview?.client) {
    try {
      await invokeTauri(webview.client, 'aurora_android_voice_foreground_service_cancel')
    } catch {
      // The process may already be dead; the explicit service action below is authoritative cleanup.
    }
  }
  if (serviceIsVisible(context) || wakeLockIsHeld(context)) {
    adbTry(context, [
      'shell',
      'am',
      'startservice',
      '-n',
      `${context.appId}/${ANDROID_VOICE_SERVICE}`,
      '-a',
      ANDROID_VOICE_STOP_ACTION,
    ])
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && (serviceIsVisible(context) || wakeLockIsHeld(context))) await sleep(250)
  if (serviceIsVisible(context) || wakeLockIsHeld(context)) {
    adbTry(context, ['shell', 'am', 'force-stop', context.appId])
  }
}

function parseJson(value) {
  try { return JSON.parse(value) } catch { return {} }
}

export async function connectInstalledWebview(context) {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_WEBVIEW_TIMEOUT_MS ?? DEFAULT_WEBVIEW_TIMEOUT_MS)
  let lastError
  while (Date.now() < deadline) {
    const pid = appPid(context)
    if (!pid) {
      await sleep(1_000)
      continue
    }
    const sockets = adbOutput(context, ['shell', 'cat', '/proc/net/unix'], { allowFailure: true })
    const socket = [`webview_devtools_remote_${pid}`, 'webview_devtools_remote']
      .find((candidate) => sockets.includes(`@${candidate}`))
    if (!socket) {
      await sleep(1_000)
      continue
    }
    let port
    try {
      port = adbOutput(context, ['forward', 'tcp:0', `localabstract:${socket}`]).trim()
      const client = await connectAndroidWebviewCdp({ port, commandTimeoutMs: COMMAND_TIMEOUT_MS })
      await waitForTauriInvoke(client, deadline)
      return {
        client,
        pid,
        port,
        close() {
          client.close()
          adbTry(context, ['forward', '--remove', `tcp:${port}`])
        },
      }
    } catch (error) {
      lastError = error
      if (port) adbTry(context, ['forward', '--remove', `tcp:${port}`])
      await sleep(1_000)
    }
  }
  throw new Error(`Android packaged WebView did not expose Tauri invoke: ${errorMessage(lastError)}`)
}

async function waitForTauriInvoke(client, deadline) {
  while (Date.now() < deadline) {
    const response = await client.send('Runtime.evaluate', {
      expression: `JSON.stringify({ready: document.readyState, invoke: typeof window.__TAURI_INTERNALS__?.invoke})`,
      returnByValue: true,
      awaitPromise: true,
    })
    const raw = response.result?.result?.value
    const state = typeof raw === 'string' ? parseJson(raw) : {}
    if (state.invoke === 'function' && state.ready !== 'loading') return
    await sleep(500)
  }
  throw new Error('Tauri invoke did not become ready in the packaged Android WebView.')
}

export async function invokeTauri(client, command, args = undefined) {
  const commandJson = JSON.stringify(command)
  const argsJson = JSON.stringify(args ?? {})
  const response = await client.send('Runtime.evaluate', {
    expression: `(async () => {
      try {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') throw new Error('tauri_invoke_unavailable');
        const result = await window.__TAURI_INTERNALS__.invoke(${commandJson}, ${argsJson});
        return JSON.stringify({ ok: true, result: result ?? null });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: typeof error?.message === 'string' ? error.message : String(error),
        });
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  }, Math.max(COMMAND_TIMEOUT_MS, Number(process.env.AURORA_ANDROID_INVOKE_TIMEOUT_MS ?? COMMAND_TIMEOUT_MS)))
  const raw = response.result?.result?.value
  if (typeof raw !== 'string') {
    throw new Error(`Tauri command ${command} returned no serialized value: ${JSON.stringify(response)}`)
  }
  const envelope = parseJson(raw)
  if (envelope.ok !== true) throw new Error(`Tauri command ${command} failed: ${envelope.error ?? raw}`)
  return envelope.result
}

async function exerciseScreenOffAndDoze(context) {
  adbRun(context, ['shell', 'input', 'keyevent', 'SLEEP'])
  await sleep(1_500)
  const idle = adbTry(context, ['shell', 'dumpsys', 'deviceidle', 'force-idle'])
  if (idle.ok) await sleep(2_000)
  const result = {
    attempted: true,
    supported: idle.ok,
    output: bounded(idle.output),
  }
  adbTry(context, ['shell', 'dumpsys', 'deviceidle', 'unforce'])
  adbTry(context, ['shell', 'input', 'keyevent', 'WAKEUP'])
  adbTry(context, ['shell', 'wm', 'dismiss-keyguard'])
  await sleep(1_000)
  return result
}

function serviceIsVisible(context) {
  const output = adbOutput(context, ['shell', 'dumpsys', 'activity', 'services', context.appId], { allowFailure: true })
  return output.includes('AuroraRuntimeForegroundService')
}

function notificationIsVisible(context) {
  const output = adbOutput(context, ['shell', 'dumpsys', 'notification', '--noredact'], { allowFailure: true })
  return notificationIsVisibleFromDump(output, context.appId)
}

export function notificationIsVisibleFromDump(output, appId) {
  const text = String(output ?? '')
  // Android 16 switched the active-record header from braces to parentheses;
  // keep both documented dumps distinct from channel-only metadata.
  const hasActiveRecord = text.includes('NotificationRecord{')
    || text.includes('NotificationRecord(')
    || text.includes('StatusBarNotification(')
  return (
    hasActiveRecord &&
    text.includes(`pkg=${appId}`) &&
    (text.includes('aurora_voice_capture') || text.includes('Aurora voice controls'))
  )
}

export function wakeLockIsHeldFromDump(output) {
  const text = String(output ?? '')
  const activeSectionStart = text.indexOf('Wake Locks:')
  if (activeSectionStart < 0) return false
  const activeSectionEnd = text.indexOf('\nSuspend Blockers:', activeSectionStart)
  const activeSection = activeSectionEnd < 0
    ? text.slice(activeSectionStart)
    : text.slice(activeSectionStart, activeSectionEnd)
  return activeSection.includes('aurora_voice_background')
}

function wakeLockIsHeld(context) {
  const output = adbOutput(context, ['shell', 'dumpsys', 'power'], { allowFailure: true })
  return wakeLockIsHeldFromDump(output)
}

function installApk(context, apk) {
  adbRun(context, ['install', '-r', '-g', apk], {
    timeoutMs: Number(process.env.AURORA_ANDROID_INSTALL_TIMEOUT_MS ?? 10 * 60_000),
  })
}

function grantVoicePermissions(context) {
  adbRun(context, ['shell', 'pm', 'grant', context.appId, 'android.permission.RECORD_AUDIO'])
  const sdk = Number(adbOutput(context, ['shell', 'getprop', 'ro.build.version.sdk']).trim())
  if (sdk >= 33) {
    adbRun(context, ['shell', 'pm', 'grant', context.appId, 'android.permission.POST_NOTIFICATIONS'])
  }
}

function launchApp(context) {
  const activity = `${context.appId}/.MainActivity`
  adbRun(context, ['shell', 'am', 'start', '-W', '-n', activity])
}

function appPid(context) {
  return adbOutput(context, ['shell', 'pidof', context.appId], { allowFailure: true }).trim().split(/\s+/u)[0] ?? ''
}

function deviceMetadata(context, devicesOutput) {
  return {
    serial: context.serial,
    deviceLine: parseAdbDevices(devicesOutput).find((device) => device.serial === context.serial)?.line ?? context.serial,
    sdk: adbOutput(context, ['shell', 'getprop', 'ro.build.version.sdk'], { allowFailure: true }).trim(),
    release: adbOutput(context, ['shell', 'getprop', 'ro.build.version.release'], { allowFailure: true }).trim(),
    abi: adbOutput(context, ['shell', 'getprop', 'ro.product.cpu.abi'], { allowFailure: true }).trim(),
    fingerprint: adbOutput(context, ['shell', 'getprop', 'ro.build.fingerprint'], { allowFailure: true }).trim(),
  }
}

function summarizeVoiceStatus(status) {
  return {
    running: status?.running === true,
    captureActive: status?.captureActive === true,
    backgroundSessionActive: status?.backgroundSessionActive === true,
    acceptedSamples: Number(status?.acceptedSamples ?? 0),
    completedTurns: Number(status?.completedTurns ?? 0),
    failedTurns: Number(status?.failedTurns ?? 0),
    runtimePhase: status?.runtimePhase ?? null,
    captureError: status?.captureError ?? null,
  }
}

function collectDiagnostics(context) {
  if (!context?.adb || !context?.serial) return { unavailable: true }
  const logcat = adbOutput(context, ['logcat', '-d', '-t', '600'], { allowFailure: true })
    .split(/\r?\n/u)
    .filter((line) => /AuroraNativePlugin|AuroraRuntimeForegroundService|RustStdoutStderr|AndroidRuntime|dev\.aurora\.desktop/iu.test(line))
    .slice(-160)
    .join('\n')
  return {
    package: bounded(adbOutput(context, ['shell', 'dumpsys', 'package', context.appId], { allowFailure: true })),
    services: bounded(adbOutput(context, ['shell', 'dumpsys', 'activity', 'services', context.appId], { allowFailure: true })),
    notification: bounded(adbOutput(context, ['shell', 'dumpsys', 'notification', '--noredact'], { allowFailure: true })),
    power: bounded(adbOutput(context, ['shell', 'dumpsys', 'power'], { allowFailure: true })),
    logcat: bounded(logcat),
  }
}

function findApk() {
  const roots = [
    'src-tauri/gen/android/app/build/outputs/apk/universal/debug',
    'src-tauri/gen/android/app/build/outputs/apk/x86_64/debug',
    'src-tauri/gen/android/app/build/outputs/apk/universal/release',
    'src-tauri/gen/android/app/build/outputs/apk',
  ]
  const candidates = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const path of walk(root)) {
      if (!path.endsWith('.apk') || path.endsWith('-unsigned.apk')) continue
      candidates.push(resolve(path))
    }
  }
  if (candidates.length === 0) return null
  return candidates
    .map((apk) => ({ apk, mtimeMs: statSync(apk).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.apk ?? null
}

function apkFreshnessInputs() {
  return [
    'scripts/install-android-native-plugin.mjs',
    'src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt',
    'src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt',
    'src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml',
    'src-tauri/build.rs',
    'src-tauri/permissions/aurora-android-native-plugin.toml',
    'src-tauri/src/lib.rs',
  ].map((relativePath) => resolve(APP_ROOT, relativePath))
}

function assertApkFreshness(apk) {
  const apkTime = statSync(apk).mtimeMs
  const latestSourceTime = Math.max(...apkFreshnessInputs().map((path) => statSync(path).mtimeMs))
  if (apkTime < latestSourceTime) {
    throw new Error(
      `Selected Android APK is older than the voice slice sources. Build a fresh APK or set AURORA_ANDROID_APK: ${apk}`,
    )
  }
}

function compareVoicePackCandidates(left, right) {
  const leftRank = packCandidateRank(left)
  const rightRank = packCandidateRank(right)
  if (leftRank !== rightRank) return leftRank - rightRank
  return Number(left.sizeBytes ?? Number.MAX_SAFE_INTEGER) - Number(right.sizeBytes ?? Number.MAX_SAFE_INTEGER)
}

function packCandidateRank(entry) {
  if (entry?.installed === true && entry?.readyForRuntime === true && entry?.active === true) return 0
  if (entry?.installed === true && entry?.readyForRuntime === true) return 1
  if (entry?.installed === true && entry?.active === true) return 2
  if (entry?.installed === true) return 3
  if (entry?.readyForRuntime === true) return 4
  return 5
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function resolveAdbCommand() {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : undefined,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : undefined,
    join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
    join(os.homedir(), '.local/share/android-sdk/platform-tools/adb'),
    'adb',
  ].filter(Boolean)
  return candidates.find((candidate) => {
    if (candidate !== 'adb' && !existsSync(candidate)) return false
    return spawnSync(candidate, ['version'], { stdio: 'ignore' }).status === 0
  }) ?? 'adb'
}

function adbRun(context, args, options = {}) {
  return commandRun(context.adb, ['-s', context.serial, ...args], options)
}

function adbOutput(context, args, { allowFailure = false } = {}) {
  const result = spawnSync(context.adb, ['-s', context.serial, ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`adb -s ${context.serial} ${args.join(' ')} failed: ${output.trim()}`)
  }
  return output
}

function adbTry(context, args) {
  const result = spawnSync(context.adb, ['-s', context.serial, ...args], { encoding: 'utf8' })
  if (result.error) return { ok: false, output: result.error.message }
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

function commandRun(command, args, { cwd, timeoutMs } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      stdio: 'inherit',
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    })
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') throw new Error(`${command} timed out after ${timeoutMs}ms`)
    throw error
  }
}

function commandRunWithInput(command, args, input, { cwd, timeoutMs } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      input,
      stdio: ['pipe', 'inherit', 'inherit'],
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    })
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') throw new Error(`${command} timed out after ${timeoutMs}ms`)
    throw error
  }
}

function commandOutput(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' })
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function bounded(value) {
  const text = String(value ?? '')
  return text.length <= MAX_DIAGNOSTIC_BYTES ? text : text.slice(-MAX_DIAGNOSTIC_BYTES)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown_error')
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  try {
    await runAndroidVoiceLiveSmoke()
  } catch {
    process.exitCode = 1
  }
}
