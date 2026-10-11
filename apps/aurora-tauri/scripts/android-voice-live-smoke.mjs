import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { acquireAndroidSmokeLock, resolveAndroidSmokeLockPath } from './android-emulator-smoke-runner.mjs'
import { connectAndroidWebviewCdp } from './android-webview-cdp.mjs'
import { pairFreshPythonWithAndroid } from './android-native-turn-pairing.mjs'

const DEFAULT_APP_ID = 'dev.aurora.desktop'
const DEFAULT_PACK_TIMEOUT_MS = 30 * 60_000
const DEFAULT_STATUS_TIMEOUT_MS = 120_000
const DEFAULT_WEBVIEW_TIMEOUT_MS = 180_000
const COMMAND_TIMEOUT_MS = 30_000
const NOTIFICATION_INTERACTION_MODE_ENV = 'AURORA_ANDROID_NOTIFICATION_INTERACTION'
const NOTIFICATION_INTERACTION_MODES = new Set(['automatic', 'external'])
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
export const ANDROID_NATIVE_TURN_PCM_LABEL = 'deterministic Android background PCM fixture'
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
export const ANDROID_NATIVE_TURN_ACCEPTANCE_ENV = 'AURORA_ANDROID_NATIVE_TURN_ACCEPTANCE'
export const AUTHORIZED_NATIVE_ASSISTANT_METHOD = 'Orchestrator.ExternalUserInput'
const NATIVE_EVENT_BRIDGE_ACCEPTANCE_ENV = 'AURORA_ANDROID_NATIVE_EVENT_BRIDGE_ACCEPTANCE'
const NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE_ENV = 'AURORA_ANDROID_NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE'
const ANDROID_MAIN_FLOW_ONLY_ENV = 'AURORA_ANDROID_MAIN_FLOW_ONLY'
const NATIVE_EVENT_BRIDGE_HIDE_DELAY_MS = 1_500
const NATIVE_ASSISTANT_EVENT_KINDS = [
  'assistant.delta',
  'assistant.completed',
  'assistant.failed',
  'assistant.tool',
  'tool.requested',
  'tool.running',
  'tool.completed',
  'tool.failed',
  'tool.requires_action',
  'voice.turn.started',
  'voice.turn.transcribing',
  'voice.turn.requesting',
  'voice.turn.speaking',
  'voice.turn.finalized',
  'voice.turn.failed',
  'native.events.gap',
]
const NATIVE_TERMINAL_EVENT_KINDS = new Set([
  'assistant.completed',
  'assistant.failed',
  'voice.turn.finalized',
  'voice.turn.failed',
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
  homeGatewayUrl = undefined,
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
  const homeConnection = homeGatewayUrl === undefined
    ? undefined
    : { mode: 'http-only', gatewayUrl: normalizeAndroidVoiceGatewayUrl(homeGatewayUrl) }
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
      ...(homeConnection ? { homeConnection } : {}),
      localNode: {
        nodeName: 'Android voice device',
        stablePeerId: profileId,
        enabledCapabilityPacks: [],
        meshMembership: androidVoiceLiveTestMeshMembership(),
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

function androidVoiceLiveTestMeshMembership() {
  // The offline voice-profile fixture needs the required mesh-node wire shape;
  // its reserved example endpoint is not a real peer or connection.
  return {
    signalingUrl: 'wss://signal.example.test',
    webrtcProfile: {
      mode: 'webrtc-only',
      appId: 'aurora',
      room: 'family-room',
      roomSecretRef: 'ref:memory:family-room',
      signalingBrokers: ['wss://signal.example.test'],
    },
  }
}

function normalizeAndroidVoiceGatewayUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A configured owned Android voice gateway endpoint is required for a new voice profile.')
  }
  let endpoint
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error('The configured Android voice gateway endpoint is invalid.')
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || !endpoint.hostname
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) {
    throw new Error('The configured Android voice gateway endpoint must be an HTTP(S) origin/path without credentials, query, or fragment.')
  }
  return endpoint.toString().replace(/\/$/u, '')
}

function hasAndroidVoiceHomeConnection(profile) {
  const connection = profile?.homeConnection
  if (!connection || typeof connection !== 'object') return false
  const hasGateway = typeof connection.gatewayUrl === 'string' && Boolean(connection.gatewayUrl.trim())
  const webrtc = connection.webrtcProfile
  const hasWebRtcProfile = Boolean(webrtc && typeof webrtc === 'object')
  const hasExpectedHomePeer = typeof connection.homePeerId === 'string' && Boolean(connection.homePeerId.trim())
    || typeof webrtc?.expectedStablePeerId === 'string' && Boolean(webrtc.expectedStablePeerId.trim())

  if (connection.mode === 'http-only') return hasGateway
  if (connection.mode === 'webrtc-only') return hasWebRtcProfile && hasExpectedHomePeer
  if (connection.mode === 'webrtc-preferred') return hasGateway && hasWebRtcProfile
  return false
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

export async function runAndroidVoiceLiveSmoke({ environment = process.env, pairing = null, modelFixture = null } = {}) {
  const inheritedEnvironment = process.env
  const environmentOverlay = environment === inheritedEnvironment ? null : Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [key, inheritedEnvironment[key]]),
  )
  let adb
  let devicesOutput
  let serial
  let releaseLock = () => {}
  let appId
  let apk
  let context
  let nativeEventBridgeAcceptance
  let nativeEventBridgeStallAcceptance
  let successfulNativeTurnAcceptance
  let fixtures
  let webview
  let originalProfileValue
  let profileRestoration = 'not_attempted'
  let pairingCleanup
  let pairingEvidence
  let primaryError
  try {
    if (environmentOverlay) Object.assign(inheritedEnvironment, environment)
    adb = resolveAdbCommand()
    devicesOutput = commandOutput(adb, ['devices', '-l'])
    serial = resolveAndroidDeviceSerial(
      devicesOutput,
      process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL,
    )
    releaseLock = await acquireAndroidSmokeLock({
      lockPath: resolveAndroidSmokeLockPath(serial),
    })
    appId = process.env.AURORA_ANDROID_APP_ID ?? DEFAULT_APP_ID
    apk = process.env.AURORA_ANDROID_APK ? resolve(process.env.AURORA_ANDROID_APK) : findApk()
    context = { adb, serial, appId }
    nativeEventBridgeAcceptance = nativeEventBridgeAcceptanceEnabled()
    nativeEventBridgeStallAcceptance = nativeEventBridgeStallAcceptanceEnabled()
    successfulNativeTurnAcceptance = successfulNativeTurnAcceptanceEnabled()
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
    originalProfileValue = storedProfile?.value
    const existingProfile = parseStoredRuntimeProfile(originalProfileValue)
    const existingActiveProfile = existingProfile?.profiles?.find((candidate) => candidate?.id === existingProfile.activeProfileId)
    const ownedGatewayUrl = pairing?.gatewayUrl ?? environment.AURORA_THREE_NODE_GATEWAY_URL
    const profile = mergeAndroidVoiceRuntimeProfile(existingProfile, readyPacks, {
      language: process.env.AURORA_ANDROID_VOICE_LANGUAGE ?? 'en',
      wakePhrase: wakePhraseSelectionFromEnvironment(process.env.AURORA_ANDROID_VOICE_LANGUAGE ?? 'en'),
      ...(!existingActiveProfile && ownedGatewayUrl ? { homeGatewayUrl: ownedGatewayUrl } : {}),
    })
    let activeProfile = profile.profiles.find((candidate) => candidate.id === profile.activeProfileId)
    if (!hasAndroidVoiceHomeConnection(activeProfile)) {
      throw new Error('Android voice profile has no admitted home route; configure an owned reachable gateway or retain an existing home connection.')
    }
    await armLiveTestPcmIngress(invoke)
    const profileResult = await invoke('aurora_thin_profile_set', { value: JSON.stringify(profile) })
    if (profileResult?.ok !== true) {
      throw new Error(`Android voice profile was not applied: ${JSON.stringify(profileResult)}`)
    }
    const profileReadback = parseStoredRuntimeProfile((await invoke('aurora_thin_profile_get'))?.value)
    const readbackActiveProfile = profileReadback?.profiles?.find((candidate) => candidate?.id === profileReadback.activeProfileId)
    if (readbackActiveProfile?.id !== activeProfile?.id
      || JSON.stringify(readbackActiveProfile?.homeConnection) !== JSON.stringify(activeProfile?.homeConnection)) {
      throw new Error('Android voice profile home route did not match the public save readback.')
    }
    activeProfile = readbackActiveProfile
    if (!activeProfile?.localNode?.localSpeechSelection?.wakePhrase?.phrase) {
      throw new Error('Android voice profile has no active wake phrase after preserving device identity.')
    }
    if (pairing) {
      const pairingAndroid = {
        get client() {
          return webview?.client
        },
      }
      const paired = await pairFreshPythonWithAndroid({
        android: pairingAndroid,
        invoke: (command, args) => invokeTauri(webview.client, command, args),
        navigateToMesh: async () => {
          webview.close()
          adbRun(context, ['shell', 'am', 'force-stop', '--user', 'current', context.appId])
          launchApp(context)
          webview = await connectInstalledWebview(context)
          await navigateAndroidToMesh(webview.client)
        },
        request: pairing.request,
        gatewayUrl: pairing.gatewayUrl,
        gatewayApiKey: pairing.gatewayApiKey,
        inviteText: pairing.inviteText,
        pythonPeerId: pairing.pythonPeerId,
      })
      pairingCleanup = paired.cleanup
      pairingEvidence = paired
      const pairedProfile = parseStoredRuntimeProfile((await invoke('aurora_thin_profile_get'))?.value)
      activeProfile = pairedProfile?.profiles.find((candidate) => candidate.id === pairedProfile.activeProfileId) ?? activeProfile
      if (!hasAndroidVoiceHomeConnection(activeProfile)) {
        throw new Error('Android pairing removed the admitted home route required for background voice.')
      }
    }
    fixtures = prepareVoiceFixtures({
      wakeText: activeProfile.localNode.localSpeechSelection.wakePhrase.phrase,
    })
    if (process.env[ANDROID_MAIN_FLOW_ONLY_ENV] === '1') {
      if (!successfulNativeTurnAcceptance || !nativeEventBridgeAcceptance || nativeEventBridgeStallAcceptance) {
        throw new Error('Android main-flow-only mode requires the successful authorized native turn and event bridge, with slow-consumer acceptance disabled.')
      }
      await stopVoiceAndRequireRelease(context, invoke)
      const start = await invoke('aurora_android_voice_foreground_service_start', {
        request: { remoteAudioConsent: false, backgroundSession: true },
      })
      if (start?.started !== true) {
        throw new Error(`Explicit Android background voice start was rejected: ${JSON.stringify(start)}`)
      }
      const started = await pollVoiceStatus(
        invoke,
        backgroundMicrophoneReadyForInjection,
        'explicit background voice start',
        { allowRecoverableBackgroundErrors: true },
      )
      assertReadyVoiceStatus(started, { background: true })
      const background = await proveBackgroundVoice(context, invoke, fixtures.backgroundPcm, {
        successful: true,
        activeProfile,
        pairingEvidence,
        modelFixture,
        mainFlowOnly: true,
        nativeEventBridge: ({ active, runTurn }) => proveNativeEventBridgeAcceptance(context, webview, invoke, {
          active,
          activeProfile,
          runTurn,
          modelFixture,
          reopenForTurnUi: async () => {
            launchApp(context)
            return await connectInstalledWebview(context)
          },
          mainFlowOnly: true,
          slowConsumer: false,
        }),
      })
      if (background.attachedWebview) {
        webview = background.attachedWebview
        invoke = (command, args) => invokeTauri(webview.client, command, args)
      }
      const notificationStop = await proveNotificationStop(context, invoke, {
        interactionMode: notificationInteractionMode(),
      })
      delete notificationStop.remainedStoppedUntilReopen
      delete notificationStop.restartedOnReopen
      notificationStop.postStopReopenMeasured = false
      const result = {
        ok: true,
        device: deviceMetadata(context, devicesOutput),
        apk: { path: apk, sha256: sha256File(apk) },
        packs: Object.fromEntries(TASKS.map((task) => [task, readyPacks[task].packId])),
        explicitBackgroundStart: { accepted: true, backgroundSession: true, remoteAudioConsent: false },
        background: {
          acceptedSamples: background.status.acceptedSamples,
          microphoneSignalDetected: background.status.microphoneSignalDetected,
          completedTurns: background.status.completedTurns,
          failedTurns: background.status.failedTurns,
          serviceVisible: background.serviceVisible,
          notificationVisible: background.notificationVisible,
          nativeEventBridge: background.nativeEventBridge,
        },
        successfulNativeTurnEvidence: background.acceptanceEvidence,
        notificationStop,
        captureAndServiceReleased: notificationStop.stopped === true
          && notificationStop.serviceStopped === true
          && notificationStop.notificationDismissed === true,
        unmeasuredScenarios: [
          'automaticStart',
          'failureRecovery',
          'repeatedReopen',
          'stickyProcessRestart',
          'forceStopRestart',
          'forcedDoze',
          'slowConsumer',
          'foregroundCapture',
          'physicalMicrophoneCapture',
        ],
        acceptanceMode: 'connected-native-main-flow',
        finalStatus: summarizeVoiceStatus(await invoke('aurora_android_voice_foreground_service_status')),
      }
      console.log(JSON.stringify(result, null, 2))
      return result
    }
    await stopVoiceAndRequireRelease(context, invoke)
    const explicitBackgroundStart = await proveExplicitBackgroundStart(invoke)
    const notificationStop = await proveNotificationStop(context, invoke, {
      interactionMode: notificationInteractionMode(),
    })
    await stopVoiceAndRequireRelease(context, invoke)
    notificationStop.publicCancelConfirmed = true
    webview.close()
    webview = null
    adbRun(context, ['shell', 'am', 'force-stop', context.appId])
    launchApp(context)
    webview = await connectInstalledWebview(context)
    invoke = (command, args) => invokeTauri(webview.client, command, args)
    await pollVoiceStatus(
      invoke,
      (status) => status.running !== true
        && status.captureActive !== true
        && status.backgroundSessionActive !== true,
      'notification Stop remains effective after app reopen',
      { allowRecoverableBackgroundErrors: true },
    )
    delete notificationStop.remainedStoppedUntilReopen
    notificationStop.remainedStoppedAfterReopen = true
    notificationStop.restartedOnReopen = false
    const explicitBackgroundReenable = await proveExplicitBackgroundStart(invoke)
    await stopVoiceAndRequireRelease(context, invoke)
    const foreground = await proveForegroundVoice(context, invoke, fixtures.foregroundPcm)
    webview.close()
    webview = null
    adbRun(context, ['shell', 'am', 'force-stop', context.appId])
    launchApp(context)
    webview = await connectInstalledWebview(context)
    invoke = (command, args) => invokeTauri(webview.client, command, args)
    await pollVoiceStatus(
      invoke,
      (status) => status.running !== true
        && status.captureActive !== true
        && status.backgroundSessionActive !== true,
      'foreground cancellation remains effective after app reopen',
      { allowRecoverableBackgroundErrors: true },
    )
    const explicitBackgroundAfterForeground = await proveExplicitBackgroundStart(invoke)
    const background = await proveBackgroundVoice(context, invoke, fixtures.backgroundPcm, {
      successful: successfulNativeTurnAcceptance,
      activeProfile,
      pairingEvidence,
      modelFixture,
      nativeEventBridge: nativeEventBridgeAcceptance
        ? ({ active, runTurn }) => proveNativeEventBridgeAcceptance(context, webview, invoke, {
          active,
          activeProfile,
          runTurn,
          modelFixture,
          reopenForTurnUi: async () => {
            launchApp(context)
            return await connectInstalledWebview(context)
          },
          slowConsumer: nativeEventBridgeStallAcceptance,
        })
        : null,
    })

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
      explicitBackgroundStart,
      explicitBackgroundReenable,
      explicitBackgroundAfterForeground,
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
        ...(background.nativeEventBridge ? { nativeEventBridge: background.nativeEventBridge } : {}),
      },
      notificationStop,
      sticky: { ...sticky, acceptedSamples: resumed.acceptedSamples },
      forceStop,
      assistantRoute: successfulNativeTurnAcceptance ? background.acceptanceEvidence?.route ?? null : 'local-only',
      ...(successfulNativeTurnAcceptance && background.acceptanceEvidence
        ? { successfulNativeTurnEvidence: background.acceptanceEvidence }
        : {}),
      acceptanceMode: successfulNativeTurnAcceptance ? 'successful-authorized-remote' : 'failure-recovery-local',
      finalStatus: summarizeVoiceStatus(await resumedInvoke('aurora_android_voice_foreground_service_status')),
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    primaryError = error
    const diagnostics = context ? collectDiagnostics(context) : { unavailable: true }
    console.error(JSON.stringify({
      ok: false,
      stage: 'main',
      code: fixedFailureCode(error),
      diagnostics,
    }, null, 2))
  } finally {
    const cleanupErrors = []
    const cleanupFailures = []
    const recordCleanupFailure = (stage, error) => {
      cleanupErrors.push(error)
      cleanupFailures.push({ stage, code: fixedFailureCode(error) })
    }
    try {
      if (pairingCleanup) {
        if (!webview?.client) {
          launchApp(context)
          webview = await connectInstalledWebview(context)
        } else {
          try {
            await invokeTauri(webview.client, 'aurora_thin_profile_get')
          } catch {
            webview.close()
            launchApp(context)
            webview = await connectInstalledWebview(context)
          }
        }
        await pairingCleanup()
      }
    } catch (error) {
      recordCleanupFailure('pairing_cleanup', error)
    }
    try {
      if (originalProfileValue !== undefined) {
        if (!webview?.client) {
          launchApp(context)
          webview = await connectInstalledWebview(context)
        }
        const restoreValue = originalProfileValue === null
          ? JSON.stringify({ version: 2, activeProfileId: null, profiles: [] })
          : originalProfileValue
        const restored = await invokeTauri(webview.client, 'aurora_thin_profile_set', { value: restoreValue })
        if (restored?.ok !== true) throw new Error('Android profile restoration was rejected.')
        const readback = await invokeTauri(webview.client, 'aurora_thin_profile_get')
        if (readback?.value !== restoreValue) throw new Error('Android profile restoration readback did not match the expected original value.')
        profileRestoration = originalProfileValue === null
          ? 'semantic_empty_verified'
          : 'exact_original_value_verified'
      } else {
        profileRestoration = 'not_required'
      }
    } catch (error) {
      recordCleanupFailure('profile_restore', error)
    }
    try {
      await bestEffortStopVoice(context, webview)
    } catch (error) {
      recordCleanupFailure('voice_stop', error)
    }
    try {
      webview?.close()
    } catch (error) {
      recordCleanupFailure('webview_close', error)
    }
    try { if (context) adbTry(context, ['shell', 'dumpsys', 'deviceidle', 'unforce']) } catch (error) { recordCleanupFailure('device_idle_unforce', error) }
    try { if (context) adbTry(context, ['shell', 'input', 'keyevent', 'WAKEUP']) } catch (error) { recordCleanupFailure('device_wakeup', error) }
    try {
      fixtures?.close()
    } catch (error) {
      recordCleanupFailure('fixtures_close', error)
    }
    try {
      releaseLock()
    } catch (error) {
      recordCleanupFailure('lock_release', error)
    }
    try {
      if (environmentOverlay) {
        for (const [key, value] of Object.entries(environmentOverlay)) {
          if (value === undefined) delete inheritedEnvironment[key]
          else inheritedEnvironment[key] = value
        }
      }
    } catch (error) {
      recordCleanupFailure('environment_restore', error)
    }
    console.error(JSON.stringify({
      stage: 'cleanup',
      cleanupOk: cleanupFailures.length === 0,
      errorCount: cleanupFailures.length,
      failures: cleanupFailures,
      originalProfile: {
        valuePresent: originalProfileValue !== undefined,
        valueIsNull: originalProfileValue === null,
        valueIsString: typeof originalProfileValue === 'string',
      },
      profileRestoration,
    }))
    if (primaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], 'Android voice smoke failed and cleanup also failed.')
    if (primaryError) throw primaryError
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Android voice smoke cleanup failed.')
  }
}

async function proveExplicitBackgroundStart(invoke) {
  const start = await invoke('aurora_android_voice_foreground_service_start', {
    request: { remoteAudioConsent: false, backgroundSession: true },
  })
  if (start?.started !== true) {
    throw new Error(`Explicit Android background voice start was rejected: ${JSON.stringify(start)}`)
  }
  const active = await pollVoiceStatus(
    invoke,
    backgroundMicrophoneReadyForInjection,
    'explicit initial background start',
    { allowRecoverableBackgroundErrors: true },
  )
  assertReadyVoiceStatus(active, { background: true })
  return {
    accepted: true,
    mode: 'explicit',
    backgroundSession: true,
    remoteAudioConsent: false,
    captureBackend: active.captureBackend,
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
  const injectionStatus = await injectLiveTestPcm(
    invoke,
    foregroundPcm,
    { focusedBaseline: active },
  )
  const injectionCompletedAt = Date.now()
  if (!focusedTranscriptionCompleted(active, injectionStatus)) {
    const finish = await invoke('aurora_android_voice_foreground_service_finish')
    if (finish?.finished !== true) throw new Error(`Foreground voice finish was rejected: ${JSON.stringify(finish)}`)
  }
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

export function successfulNativeTurnAcceptanceEnabled(environment = process.env) {
  return environment[ANDROID_NATIVE_TURN_ACCEPTANCE_ENV] === '1'
}

/**
 * Validate the successful remote assistant result required by the optional
 * native-turn acceptance lane. The existing local voice smoke intentionally
 * remains a re-arm/failure recovery check.
 */
export function assertSuccessfulNativeTurn({ active, completed, pairingEvidence = null, modelFixture = null, failedTurnsBefore = 0 }) {
  const generation = nativeTurnGeneration(completed)
  if (completed?.liveOutcome === 'rearmed' || completed?.captureError === 'assistant_unavailable') {
    throw new Error(`Successful native turn received the local assistant-unavailable recovery path: ${JSON.stringify({ outcome: completed?.liveOutcome, captureError: completed?.captureError })}`)
  }
  if (active?.voiceRoute?.configured !== true) {
    throw new Error(`Successful native turn requires the native voice route to be configured by the active profile: ${JSON.stringify(active?.voiceRoute ?? null)}`)
  }
  if (pairingEvidence?.authenticated !== true || pairingEvidence?.bilaterallyApproved !== true || pairingEvidence?.nativeSessionBound !== true || typeof pairingEvidence?.pythonPeerId !== 'string' || !pairingEvidence.pythonPeerId) {
    throw new Error(`Successful native turn requires the freshly paired Python peer to be authenticated and bilaterally approved.`)
  }
  if (completed?.liveOutcome !== 'completed' && completed?.completed !== true && completed?.assistantCompleted !== true) {
    throw new Error(`Successful native turn did not complete an assistant response: ${JSON.stringify(completed)}`)
  }
  if (generation == null || nativeTurnGeneration(active) === generation) {
    throw new Error(`Successful native turn did not advance the turn generation: ${JSON.stringify({ active, completed })}`)
  }
  if (Number(completed?.failedTurns ?? 0) > Number(failedTurnsBefore)) {
    throw new Error(`Successful native turn increased failed-turn count: ${JSON.stringify({ failedTurnsBefore, failedTurnsAfter: completed?.failedTurns })}`)
  }
  if (typeof modelFixture?.turnId !== 'string' || !modelFixture.turnId || typeof modelFixture.completedText !== 'string' || !modelFixture.completedText) {
    throw new Error('Successful native turn requires the unique owned model fixture identity.')
  }
  return {
    route: { configured: true, reason: active.voiceRoute.reason ?? 'voice_route_configured' },
    method: AUTHORIZED_NATIVE_ASSISTANT_METHOD,
    methodSource: 'apps/aurora-tauri/src-tauri/src/native_mesh_assistant.rs',
    pythonPeerId: pairingEvidence.pythonPeerId,
    nativeSessionBound: true,
    fixture: { label: 'deterministic OpenAI-compatible model fixture', turnId: modelFixture.turnId, completedText: modelFixture.completedText },
    pcmLabel: ANDROID_NATIVE_TURN_PCM_LABEL,
    generation,
    failedTurnsBefore,
    failedTurnsAfter: Number(completed?.failedTurns ?? 0),
  }
}

export function assertNativeTurnUiRecovery({ partialText, pendingVisible, completedText, expectedText }) {
  if (typeof partialText !== 'string' || partialText.trim().length === 0) {
    throw new Error('Successful native turn UI acceptance did not observe visible partial assistant text.')
  }
  if (pendingVisible !== true) {
    throw new Error('Successful native turn UI acceptance did not observe the pending assistant state.')
  }
  if (typeof completedText !== 'string' || completedText.trim().length === 0) {
    throw new Error('Successful native turn UI acceptance did not observe the completed assistant reply.')
  }
  if (expectedText && completedText !== expectedText) {
    throw new Error('Successful native turn UI acceptance observed an unexpected completed assistant reply.')
  }
  return { partialObserved: true, pendingObserved: true, completedObserved: true }
}

export function assertNativeTurnPersistenceUniqueness({ beforeRows, afterRows, reopenedRows, generation }) {
  const before = Array.isArray(beforeRows) ? beforeRows : []
  const after = Array.isArray(afterRows) ? afterRows : []
  const reopened = Array.isArray(reopenedRows) ? reopenedRows : []
  const added = after.filter((row) => !before.some((prior) => prior?.id === row?.id))
  const users = added.filter((row) => row?.role === 'user')
  const assistants = added.filter((row) => row?.role === 'assistant')
  if (users.length !== 1 || assistants.length !== 1) {
    throw new Error(`Successful native turn expected exactly one user and assistant row; observed ${JSON.stringify({ users: users.length, assistants: assistants.length })}`)
  }
  if (JSON.stringify(after) !== JSON.stringify(reopened)) {
    throw new Error('Successful native turn rows changed after UI reopen.')
  }
  const generations = [...new Set(added.map((row) => row?.generation).filter((value) => value != null))]
  if (generation != null && generations.length > 0 && (generations.length !== 1 || generations[0] !== generation)) {
    throw new Error(`Successful native turn persisted rows do not share generation ${generation}.`)
  }
  return { userRows: 1, assistantRows: 1, sameGeneration: true, duplicateRows: false }
}

async function proveBackgroundVoice(context, invoke, backgroundPcm, {
  nativeEventBridge = null,
  successful = false,
  activeProfile = null,
  pairingEvidence = null,
  modelFixture = null,
  mainFlowOnly = false,
} = {}) {
  const before = await invoke('aurora_android_voice_foreground_service_status')
  assertReadyVoiceStatus(before, { background: true })
  const active = await pollVoiceStatus(
    invoke,
    backgroundMicrophoneReadyForInjection,
    'background microphone capture',
    { allowRecoverableBackgroundErrors: true },
  )
  await armLiveTestPcmIngress(invoke)
  if (modelFixture?.arm) await modelFixture.arm()
  const turnRunner = () => completeBackgroundWakeTurn(invoke, backgroundPcm, active, { acceptRearmed: !successful })
  const observedTurn = nativeEventBridge
    ? await nativeEventBridge({ active, runTurn: turnRunner })
    : { completed: await turnRunner(), report: null }
  const completed = observedTurn.completed
  if (!successful && (completed.liveOutcome !== 'rearmed' || Number(completed.failedTurns) <= Number(active.failedTurns ?? 0))) {
    throw new Error(`Background local transcription did not re-arm after the optional assistant route was unavailable: ${JSON.stringify(completed)}`)
  }
  if (Number(completed.acceptedSamples) <= Number(active.acceptedSamples ?? 0)) {
    throw new Error('Background native PCM samples were not accepted while completing the local turn.')
  }
  const acceptanceEvidence = successful
    ? assertSuccessfulNativeTurn({ active, completed, pairingEvidence, modelFixture, failedTurnsBefore: Number(active.failedTurns ?? 0) })
    : null
  if (!mainFlowOnly) {
    adbRun(context, ['shell', 'input', 'keyevent', 'HOME'])
    await sleep(1_500)
  }
  const serviceVisible = serviceIsVisible(context)
  const notificationVisible = notificationIsVisible(context)
  const wakeLockHeld = wakeLockIsHeld(context)
  if (!serviceVisible || !notificationVisible || !wakeLockHeld) {
    throw new Error(
      `Background voice lost durable OS state after HOME: service=${serviceVisible}, notification=${notificationVisible}, wakeLock=${wakeLockHeld}`,
    )
  }
  const doze = mainFlowOnly ? null : await exerciseScreenOffAndDoze(context)
  if (!mainFlowOnly && (!serviceIsVisible(context) || !wakeLockIsHeld(context))) {
    throw new Error('Background voice did not retain its service and wake lock through screen-off.')
  }
  return {
    status: completed,
    serviceVisible,
    notificationVisible,
    wakeLockHeld,
    doze,
    ...(observedTurn.attachedWebview ? { attachedWebview: observedTurn.attachedWebview } : {}),
    ...(observedTurn.report ? { nativeEventBridge: observedTurn.report } : {}),
    ...(acceptanceEvidence ? { acceptanceEvidence } : {}),
  }
}

function nativeEventBridgeAcceptanceEnabled() {
  return process.env[NATIVE_EVENT_BRIDGE_ACCEPTANCE_ENV] === '1'
}

function nativeEventBridgeStallAcceptanceEnabled() {
  return process.env[NATIVE_EVENT_BRIDGE_STALL_ACCEPTANCE_ENV] === '1'
}

async function proveNativeEventBridgeAcceptance(context, webview, invoke, {
  active,
  activeProfile,
  runTurn,
  modelFixture = null,
  reopenForTurnUi = null,
  slowConsumer = false,
  mainFlowOnly = false,
}) {
  if (!webview?.client) throw new Error('Native event bridge acceptance requires an attached Android WebView.')
  const localDataScope = localDataScopeFromRuntimeProfile(activeProfile)
  const beforeSnapshot = await nativeEventSnapshot(invoke)
  const beforeLocalData = await nativeTurnLocalDataSnapshot(invoke, localDataScope, 'beforeTurn')
  const beforePlaybackCounters = await nativePlaybackCounterSnapshot(invoke, 'beforeTurn')
  const afterSequence = nativeEventSequenceFromCursor(beforeSnapshot?.lastSequenceId)
  let collector = null
  let collectorWebview = webview
  let completed
  let uiHiddenDuringTurn = false
  let reopenedWebview = null
  let secondReopenedWebview = null
  try {
    collector = await startNativeEventCollector(webview, {
      afterSequence,
      acknowledgeEvents: slowConsumer !== true,
    })
    if (mainFlowOnly) {
      await stopNativeEventCollector(webview, collector, { verify: true })
      collector = null
    }
    adbRun(context, ['shell', 'input', 'keyevent', 'HOME'])
    uiHiddenDuringTurn = true
    const turn = runTurn()
    if (modelFixture) {
      await modelFixture.waitPending()
      reopenedWebview = reopenForTurnUi ? await reopenForTurnUi() : await connectInstalledWebview(context)
      await waitForRenderedNativeTurn(reopenedWebview.client, {
        partialText: modelFixture.partialText,
        pending: true,
      })
      await modelFixture.resume()
    } else {
      const hideDelayMs = Number(process.env.AURORA_ANDROID_NATIVE_EVENT_BRIDGE_HIDE_DELAY_MS ?? NATIVE_EVENT_BRIDGE_HIDE_DELAY_MS)
      const earlyTurn = await Promise.race([
        turn.then(() => true, () => true),
        sleep(Number.isFinite(hideDelayMs) ? hideDelayMs : NATIVE_EVENT_BRIDGE_HIDE_DELAY_MS).then(() => false),
      ])
      if (earlyTurn) {
        await turn
        throw new Error('Background voice turn settled before the UI could be hidden for native event bridge acceptance.')
      }
    }
    completed = await turn
    const afterHiddenLocalData = await nativeTurnLocalDataSnapshot(invoke, localDataScope, 'afterHiddenCompletion')
    const afterHiddenPlaybackCounters = await nativePlaybackCounterSnapshot(invoke, 'afterHiddenCompletion')
    if (!reopenedWebview) {
      launchApp(context)
      reopenedWebview = await connectInstalledWebview(context)
    }
    if (modelFixture) {
      await waitForRenderedNativeTurn(reopenedWebview.client, {
        completedText: modelFixture.completedText,
      })
    }
    const replayInvoke = (command, args) => invokeTauri(reopenedWebview.client, command, args)
    if (mainFlowOnly) {
      collectorWebview = reopenedWebview
      collector = await startNativeEventCollector(reopenedWebview, { afterSequence })
    }
    const liveCollector = mainFlowOnly
      ? await waitForNativeEventCollectorTurn(reopenedWebview, completed)
      : await readNativeEventCollector(webview)
    const replaySnapshot = await nativeEventSnapshot(replayInvoke, { afterSequence })
    const afterFirstReopenLocalData = await nativeTurnLocalDataSnapshot(replayInvoke, localDataScope, 'afterFirstReopen')
    const afterFirstReopenPlaybackCounters = await nativePlaybackCounterSnapshot(replayInvoke, 'afterFirstReopen')
    const report = assertNativeEventBridgeProgression({
      active,
      completed,
      beforeSnapshot,
      liveCollector,
      replaySnapshot,
      afterSequence,
      uiHiddenDuringTurn,
      allowGapEvents: slowConsumer === true,
      allowIncompleteReplay: slowConsumer === true,
    })
    if (mainFlowOnly) {
      report.repeatedReopen = { measured: false, reason: 'Skipped by main-flow-only selection.' }
      report.slowConsumer = { measured: false, reason: 'Skipped by main-flow-only selection.' }
      report.localDataSnapshots = assertNativeTurnLocalDataRecovery({
        beforeTurn: beforeLocalData,
        afterHiddenCompletion: afterHiddenLocalData,
        afterFirstReopen: afterFirstReopenLocalData,
        expectedConversationId: report.correlation?.conversationId,
        assistantResultExpected: nativeTurnRequiresPersistedAssistantResult(report, null),
        verifySecondReopen: false,
      })
      report.persistedResultUniquenessMeasured = true
      report.duplicatePersistedResult = false
      delete report.persistedResultUnsupportedReason
      report.nativePlaybackCounters = assertNativePlaybackNoReplay({
        beforeTurn: beforePlaybackCounters,
        afterHiddenCompletion: afterHiddenPlaybackCounters,
        afterFirstReopen: afterFirstReopenPlaybackCounters,
        verifySecondReopen: false,
      })
      report.ttsReplayMeasured = true
      report.nativeTtsPlaybackMeasured = true
      delete report.ttsReplayUnsupportedReason
      delete report.nativeTtsPlaybackUnsupportedReason
      report.ownedEventCollectorDetachedDuringTurn = true
      await stopNativeEventCollector(reopenedWebview, collector, { verify: true })
      collector = null
      webview.close()
      return { completed, report, attachedWebview: reopenedWebview }
    }
    adbRun(context, ['shell', 'input', 'keyevent', 'HOME'])
    await sleep(500)
    launchApp(context)
    secondReopenedWebview = await connectInstalledWebview(context)
    const secondReplayInvoke = (command, args) => invokeTauri(secondReopenedWebview.client, command, args)
    const secondReplaySnapshot = await nativeEventSnapshot(secondReplayInvoke, { afterSequence })
    const afterSecondReopenLocalData = await nativeTurnLocalDataSnapshot(secondReplayInvoke, localDataScope, 'afterSecondReopen')
    const afterSecondReopenPlaybackCounters = await nativePlaybackCounterSnapshot(secondReplayInvoke, 'afterSecondReopen')
    report.nativePlaybackCounters = assertNativePlaybackNoReplay({
      beforeTurn: beforePlaybackCounters,
      afterHiddenCompletion: afterHiddenPlaybackCounters,
      afterFirstReopen: afterFirstReopenPlaybackCounters,
      afterSecondReopen: afterSecondReopenPlaybackCounters,
    })
    report.ttsReplayMeasured = true
    report.nativeTtsPlaybackMeasured = true
    delete report.ttsReplayUnsupportedReason
    delete report.nativeTtsPlaybackUnsupportedReason
    report.localDataSnapshots = assertNativeTurnLocalDataRecovery({
      beforeTurn: beforeLocalData,
      afterHiddenCompletion: afterHiddenLocalData,
      afterFirstReopen: afterFirstReopenLocalData,
      afterSecondReopen: afterSecondReopenLocalData,
      expectedConversationId: report.correlation?.conversationId,
      assistantResultExpected: nativeTurnRequiresPersistedAssistantResult(report, report.nativePlaybackCounters),
    })
    report.persistedResultUniquenessMeasured = true
    report.duplicatePersistedResult = false
    delete report.persistedResultUnsupportedReason
    report.secondReplayLastSequenceId = secondReplaySnapshot?.lastSequenceId ?? null
    secondReopenedWebview.close()
    secondReopenedWebview = null
    if (slowConsumer === true) {
      report.slowConsumer = assertNativeEventBridgeSlowConsumerRecovery({
        active,
        completed,
        liveCollector,
        replaySnapshot,
        afterSequence,
      })
    }
    await stopNativeEventCollector(webview, collector)
    reopenedWebview.close()
    reopenedWebview = null
    return { completed, report }
  } catch (error) {
    await stopNativeEventCollector(collectorWebview, collector).catch(() => {})
    reopenedWebview?.close()
    secondReopenedWebview?.close()
    throw error
  }
}

async function waitForRenderedNativeTurn(client, { partialText, completedText, pending = false, timeoutMs = DEFAULT_STATUS_TIMEOUT_MS } = {}) {
  const expected = completedText ?? partialText
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluateWebviewJson(client, `(() => {
      const thread = document.querySelector('[aria-label="Assistant conversation thread"]');
      return JSON.stringify({
        text: thread?.textContent ?? '',
        pending: Boolean(thread?.querySelector('[role="status"][aria-busy="true"]')),
      });
    })()`)
    if (typeof state.text === 'string' && (!expected || state.text.includes(expected)) && (!pending || state.pending === true)) return state
    await sleep(250)
  }
  throw new Error(`Rendered native turn did not reach the expected ${pending ? 'partial pending' : 'completed'} state.`)
}

async function navigateAndroidToMesh(client) {
  // Profile writes do not rebuild the live Tauri runtime. The caller opens a
  // fresh app process so the normal startup path hydrates the persisted role.
  await waitForTauriInvoke(client, Date.now() + DEFAULT_WEBVIEW_TIMEOUT_MS)
  await client.send('Runtime.evaluate', {
    expression: "window.history.pushState({}, '', '/mesh'); window.dispatchEvent(new PopStateEvent('popstate'));",
    returnByValue: true,
  }, COMMAND_TIMEOUT_MS)
  await waitForWebviewPath(client, '/mesh')
  await waitForRenderedAndroidMeshControls(client)
}

async function waitForRenderedAndroidMeshControls(client, timeoutMs = DEFAULT_WEBVIEW_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluateWebviewJson(client, `JSON.stringify({
      path: window.location.pathname,
      connectedDevicesHeading: [...document.querySelectorAll('h1')]
        .some((heading) => heading.textContent?.trim() === 'Connected devices'),
      connectDevice: [...document.querySelectorAll('button')].some((button) =>
        button.textContent?.trim() === 'Connect device'
        && !button.disabled
        && button.getClientRects().length > 0),
    })`)
    if (state.path === '/mesh' && state.connectedDevicesHeading && state.connectDevice) return state
    await sleep(250)
  }
  throw new Error('Android mesh screen did not render the enabled Connect device control after profile reload.')
}

async function waitForWebviewPath(client, expectedPath, timeoutMs = DEFAULT_WEBVIEW_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await evaluateWebviewJson(client, 'JSON.stringify({ path: window.location.pathname })')
    if (state.path === expectedPath) return state
    await sleep(250)
  }
  throw new Error(`Android WebView did not navigate to ${expectedPath}.`)
}

export function localDataScopeFromRuntimeProfile(activeProfile) {
  const profileId = typeof activeProfile?.id === 'string' ? activeProfile.id.trim() : ''
  const localNodeId = typeof activeProfile?.localNode?.stablePeerId === 'string'
    ? activeProfile.localNode.stablePeerId.trim()
    : ''
  if (!profileId || !localNodeId) {
    throw new Error('Native turn local-data snapshot requires an active profile id and stable local node id.')
  }
  return { profileId, localNodeId }
}

async function nativeTurnLocalDataSnapshot(invoke, scope, phase) {
  await invoke('aurora_local_data_open', { request: scope })
  const conversations = arrayResult(await localDataRepositoryOperation(invoke, {
    kind: 'conversations.listConversations',
    profileId: scope.profileId,
    localNodeId: scope.localNodeId,
  }), 'conversations')
  const rawCounts = await localDataRepositoryOperation(invoke, {
    kind: 'conversations.listMessageCounts',
    profileId: scope.profileId,
    localNodeId: scope.localNodeId,
  })
  const conversationIds = [...new Set([
    ...conversations.map((conversation) => stringField(conversation, 'id')).filter(Boolean),
    ...Object.keys(objectResult(rawCounts, 'message counts')),
  ])].sort()
  const messagesByConversation = {}
  for (const conversationId of conversationIds) {
    messagesByConversation[conversationId] = sanitizeLocalDataMessages(arrayResult(
      await localDataRepositoryOperation(invoke, {
        kind: 'conversations.listMessages',
        profileId: scope.profileId,
        localNodeId: scope.localNodeId,
        conversationId,
      }),
      `messages for ${conversationId}`,
    ))
  }
  const messageCounts = {}
  for (const conversationId of conversationIds) {
    const listedCount = Number(objectResult(rawCounts, 'message counts')[conversationId])
    const rowCount = messagesByConversation[conversationId].length
    if (Number.isFinite(listedCount) && listedCount !== rowCount) {
      throw new Error(`Native turn local-data snapshot count mismatch for ${conversationId}: listed=${listedCount}, rows=${rowCount}`)
    }
    messageCounts[conversationId] = rowCount
  }
  return {
    phase,
    conversationIds,
    messageCounts,
    messagesByConversation,
  }
}

async function localDataRepositoryOperation(invoke, operation) {
  return await invoke('aurora_local_data_repository_operation', { request: { operation } })
}

function sanitizeLocalDataMessages(messages) {
  return messages.map((message) => ({
    id: requiredStringField(message, 'id'),
    conversationId: requiredStringField(message, 'conversationId'),
    sequence: requiredFiniteNumberField(message, 'sequence'),
    role: requiredStringField(message, 'role'),
    status: requiredStringField(message, 'status'),
    createdAtMs: requiredFiniteNumberField(message, 'createdAtMs'),
  })).sort(compareLocalDataMessages)
}

export function assertNativeTurnLocalDataRecovery({
  beforeTurn,
  afterHiddenCompletion,
  afterFirstReopen,
  afterSecondReopen,
  expectedConversationId = null,
  assistantResultExpected = false,
  verifySecondReopen = true,
}) {
  assertLocalDataSnapshotShape(beforeTurn, 'beforeTurn')
  assertLocalDataSnapshotShape(afterHiddenCompletion, 'afterHiddenCompletion')
  assertLocalDataSnapshotShape(afterFirstReopen, 'afterFirstReopen')
  if (verifySecondReopen) assertLocalDataSnapshotShape(afterSecondReopen, 'afterSecondReopen')
  assertExistingLocalDataRowsUnchanged(beforeTurn, afterHiddenCompletion)
  assertLocalDataSnapshotsEqual(afterHiddenCompletion, afterFirstReopen, 'first UI recovery')
  if (verifySecondReopen) assertLocalDataSnapshotsEqual(afterHiddenCompletion, afterSecondReopen, 'second UI recovery')

  const nativeDelta = localDataMessageDelta(beforeTurn, afterHiddenCompletion)
  const userRows = nativeDelta.newRows.filter((row) => row.role === 'user')
  const assistantRows = nativeDelta.newRows.filter((row) => row.role === 'assistant')
  const otherRows = nativeDelta.newRows.filter((row) => row.role !== 'user' && row.role !== 'assistant')
  if (userRows.length !== 1) {
    throw new Error(`Native turn local-data recovery expected exactly one new user row; observed ${userRows.length}.`)
  }
  if (assistantResultExpected === true && assistantRows.length !== 1) {
    throw new Error(`Native turn local-data recovery expected exactly one new assistant row; observed ${assistantRows.length}.`)
  }
  if (assistantRows.length > 1) {
    throw new Error(`Native turn local-data recovery observed duplicate assistant rows: ${JSON.stringify(redactLocalDataRows(assistantRows))}`)
  }
  if (otherRows.length > 0) {
    throw new Error(`Native turn local-data recovery observed unexpected row roles: ${JSON.stringify(redactLocalDataRows(otherRows))}`)
  }
  if (nativeDelta.conversationIds.length !== 1) {
    throw new Error(`Native turn local-data recovery changed ${nativeDelta.conversationIds.length} conversations: ${JSON.stringify(nativeDelta.conversationIds)}`)
  }
  if (expectedConversationId && nativeDelta.conversationIds[0] !== expectedConversationId) {
    throw new Error(`Native turn local-data recovery persisted rows in ${nativeDelta.conversationIds[0]}, expected correlated conversation ${expectedConversationId}.`)
  }
  const expectedSequences = [...nativeDelta.newRows]
    .sort(compareLocalDataMessages)
    .map((row) => row.sequence)
  for (let index = 1; index < expectedSequences.length; index += 1) {
    if (expectedSequences[index] !== expectedSequences[index - 1] + 1) {
      throw new Error(`Native turn local-data recovery rows are not adjacent by sequence: ${JSON.stringify(expectedSequences)}`)
    }
  }

  const redactedDelta = {
    conversationId: nativeDelta.conversationIds[0],
    newRows: redactLocalDataRows(nativeDelta.newRows),
  }
  return {
    beforeTurn: redactedLocalDataSnapshot(beforeTurn),
    afterHiddenCompletion: {
      ...redactedLocalDataSnapshot(afterHiddenCompletion),
      nativeDelta: redactedDelta,
    },
    afterFirstReopen: {
      ...redactedLocalDataSnapshot(afterFirstReopen),
      sameAsAfterHiddenCompletion: true,
    },
    ...(verifySecondReopen
      ? { afterSecondReopen: { ...redactedLocalDataSnapshot(afterSecondReopen), sameAsAfterHiddenCompletion: true } }
      : { afterSecondReopen: null, secondReopenMeasured: false }),
    persistedResultUniquenessMeasured: true,
    duplicatePersistedResult: false,
    assistantResultExpected: assistantResultExpected === true,
  }
}

function arrayResult(value, label) {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to return an array.`)
  return value
}

function objectResult(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to return an object.`)
  }
  return value
}

function stringField(value, field) {
  return typeof value?.[field] === 'string' && value[field].length > 0 ? value[field] : null
}

function requiredStringField(value, field) {
  const result = stringField(value, field)
  if (!result) throw new Error(`Local data message row is missing ${field}.`)
  return result
}

function requiredFiniteNumberField(value, field) {
  const result = Number(value?.[field])
  if (!Number.isFinite(result)) throw new Error(`Local data message row is missing ${field}.`)
  return result
}

function compareLocalDataMessages(left, right) {
  return String(left.conversationId).localeCompare(String(right.conversationId))
    || Number(left.sequence) - Number(right.sequence)
    || String(left.id).localeCompare(String(right.id))
}

function assertLocalDataSnapshotShape(snapshot, label) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error(`Missing local-data snapshot: ${label}.`)
  if (!Array.isArray(snapshot.conversationIds)) throw new Error(`Local-data snapshot ${label} is missing conversation ids.`)
  objectResult(snapshot.messageCounts, `${label} message counts`)
  objectResult(snapshot.messagesByConversation, `${label} messages`)
  const expectedIds = [...snapshot.conversationIds].sort()
  const messageIds = Object.keys(snapshot.messagesByConversation).sort()
  if (JSON.stringify(expectedIds) !== JSON.stringify(messageIds)) {
    throw new Error(`Local-data snapshot ${label} has mismatched conversation/message keys.`)
  }
  for (const conversationId of expectedIds) {
    const messages = arrayResult(snapshot.messagesByConversation[conversationId], `${label} ${conversationId} messages`)
    const count = Number(snapshot.messageCounts[conversationId])
    if (!Number.isFinite(count) || count !== messages.length) {
      throw new Error(`Local-data snapshot ${label} has an invalid count for ${conversationId}.`)
    }
    for (const message of messages) {
      requiredStringField(message, 'id')
      requiredStringField(message, 'conversationId')
      requiredStringField(message, 'role')
      requiredStringField(message, 'status')
      requiredFiniteNumberField(message, 'sequence')
      requiredFiniteNumberField(message, 'createdAtMs')
      if (message.conversationId !== conversationId) {
        throw new Error(`Local-data snapshot ${label} contains a message in the wrong conversation.`)
      }
    }
  }
}

function assertExistingLocalDataRowsUnchanged(beforeTurn, afterHiddenCompletion) {
  const beforeRows = localDataRowsById(beforeTurn)
  const afterRows = localDataRowsById(afterHiddenCompletion)
  for (const [id, beforeRow] of beforeRows) {
    const afterRow = afterRows.get(id)
    if (!afterRow) throw new Error(`Native turn local-data recovery removed existing row ${id}.`)
    if (JSON.stringify(beforeRow) !== JSON.stringify(afterRow)) {
      throw new Error(`Native turn local-data recovery changed existing row ${id}.`)
    }
  }
}

function assertLocalDataSnapshotsEqual(expected, actual, label) {
  const expectedComparable = comparableLocalDataSnapshot(expected)
  const actualComparable = comparableLocalDataSnapshot(actual)
  if (JSON.stringify(expectedComparable) !== JSON.stringify(actualComparable)) {
    throw new Error(`Native turn local-data snapshot changed after ${label}: ${JSON.stringify({
      expectedHash: localDataSnapshotHash(expectedComparable),
      actualHash: localDataSnapshotHash(actualComparable),
      expected: redactedLocalDataSnapshot(expected),
      actual: redactedLocalDataSnapshot(actual),
    })}`)
  }
}

function localDataMessageDelta(beforeTurn, afterHiddenCompletion) {
  const beforeRows = localDataRowsById(beforeTurn)
  const afterRows = [...localDataRowsById(afterHiddenCompletion).values()]
  const newRows = afterRows
    .filter((row) => !beforeRows.has(row.id))
    .sort(compareLocalDataMessages)
  return {
    newRows,
    conversationIds: [...new Set(newRows.map((row) => row.conversationId))].sort(),
  }
}

function localDataRowsById(snapshot) {
  const rows = new Map()
  for (const conversationId of snapshot.conversationIds) {
    for (const row of snapshot.messagesByConversation[conversationId] ?? []) {
      if (rows.has(row.id)) throw new Error(`Duplicate local-data message id in snapshot: ${row.id}.`)
      rows.set(row.id, { ...row })
    }
  }
  return rows
}

function comparableLocalDataSnapshot(snapshot) {
  const messagesByConversation = {}
  for (const conversationId of [...snapshot.conversationIds].sort()) {
    messagesByConversation[conversationId] = [...snapshot.messagesByConversation[conversationId]]
      .sort(compareLocalDataMessages)
  }
  return {
    conversationIds: [...snapshot.conversationIds].sort(),
    messageCounts: Object.fromEntries(Object.entries(snapshot.messageCounts).sort(([left], [right]) => left.localeCompare(right))),
    messagesByConversation,
  }
}

function redactedLocalDataSnapshot(snapshot) {
  return {
    conversationIds: [...snapshot.conversationIds],
    messageCounts: { ...snapshot.messageCounts },
    messageRowsHash: localDataSnapshotHash(comparableLocalDataSnapshot(snapshot)),
  }
}

function redactLocalDataRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    sequence: row.sequence,
    status: row.status,
    createdAtMs: row.createdAtMs,
  }))
}

function localDataSnapshotHash(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16)
}


function nativeTerminalEvidenceKinds(events, subjects) {
  return [...new Set([
    ...(Array.isArray(events) ? events : []).map((event) => nativeEventKind(event)),
    ...(Array.isArray(subjects) ? subjects : []).map((subject) => subject?.kind),
  ].filter(Boolean))].sort()
}

export function nativeTurnRequiresPersistedAssistantResult(report, playbackReport) {
  const matchingObservedKinds = Array.isArray(report?.matchingObservedKinds) ? report.matchingObservedKinds : []
  const terminalKinds = [...new Set([
    ...(Array.isArray(report?.terminalKinds) ? report.terminalKinds : []),
    ...(Array.isArray(report?.terminalEventKinds) ? report.terminalEventKinds : []),
    ...(Array.isArray(report?.terminalSubjectKinds) ? report.terminalSubjectKinds : []),
  ])]
  if (matchingObservedKinds.includes('assistant.completed') || terminalKinds.includes('assistant.completed')) {
    return true
  }
  const finalized = matchingObservedKinds.includes('voice.turn.finalized')
    || terminalKinds.includes('voice.turn.finalized')
  return finalized === true
    && playbackReport?.measured === true
    && Array.isArray(playbackReport.advancedDuringHiddenCompletion)
    && playbackReport.advancedDuringHiddenCompletion.includes('globalAudioTrackWrittenSamples')
}

async function nativePlaybackCounterSnapshot(invoke, phase) {
  const raw = await invoke('aurora_android_voice_live_test_playback_counters')
  return sanitizeNativePlaybackCounters(raw, phase)
}

export function sanitizeNativePlaybackCounters(raw, phase = 'sample') {
  if (raw?.available !== true) {
    throw new Error(`Native playback counters are unavailable for ${phase}; build the dedicated Android voice-live debuggable capability.`)
  }
  const snapshot = { phase, available: true }
  for (const field of NATIVE_PLAYBACK_COUNTER_FIELDS) {
    snapshot[field] = requiredPlaybackCounter(raw, field, phase)
  }
  return snapshot
}

export function assertNativePlaybackNoReplay({
  beforeTurn,
  afterHiddenCompletion,
  afterFirstReopen,
  afterSecondReopen,
  verifySecondReopen = true,
}) {
  for (const [label, snapshot] of Object.entries({
    beforeTurn,
    afterHiddenCompletion,
    afterFirstReopen,
    ...(verifySecondReopen ? { afterSecondReopen } : {}),
  })) {
    assertNativePlaybackSnapshot(snapshot, label)
  }
  assertPlaybackAdvanced(beforeTurn, afterHiddenCompletion)
  assertPlaybackStable(afterHiddenCompletion, afterFirstReopen, 'first UI recovery')
  if (verifySecondReopen) assertPlaybackStable(afterHiddenCompletion, afterSecondReopen, 'second UI recovery')
  if (afterHiddenCompletion.globalFailureCount !== 0) {
    throw new Error(`Native playback counters reported failures after hidden completion: ${afterHiddenCompletion.globalFailureCount}`)
  }
  return {
    beforeTurn: redactNativePlaybackSnapshot(beforeTurn),
    afterHiddenCompletion: redactNativePlaybackSnapshot(afterHiddenCompletion),
    afterFirstReopen: {
      ...redactNativePlaybackSnapshot(afterFirstReopen),
      sameAsAfterHiddenCompletion: true,
    },
    ...(verifySecondReopen
      ? { afterSecondReopen: { ...redactNativePlaybackSnapshot(afterSecondReopen), sameAsAfterHiddenCompletion: true } }
      : { afterSecondReopen: null, secondReopenMeasured: false }),
    measured: true,
    replayedDuringRecovery: false,
    advancedDuringHiddenCompletion: playbackAdvancedFields(beforeTurn, afterHiddenCompletion),
  }
}

const NATIVE_PLAYBACK_COUNTER_FIELDS = [
  'globalPlayCallCount',
  'globalChunkEnqueueCount',
  'globalFinalChunkQueuedCount',
  'globalDrainNonEmptyCount',
  'globalAckCount',
  'globalCompleteCount',
  'globalFailureCount',
  'globalAudioTrackPlayCallCount',
  'globalAudioTrackWrittenSamples',
]

const NATIVE_PLAYBACK_PROGRESS_FIELDS = [
  'globalPlayCallCount',
  'globalChunkEnqueueCount',
  'globalFinalChunkQueuedCount',
  'globalDrainNonEmptyCount',
  'globalAckCount',
  'globalCompleteCount',
  'globalAudioTrackPlayCallCount',
  'globalAudioTrackWrittenSamples',
]

const NATIVE_PLAYBACK_NO_REPLAY_FIELDS = NATIVE_PLAYBACK_COUNTER_FIELDS
  .filter((field) => field !== 'globalAudioTrackPlayCallCount')

function requiredPlaybackCounter(raw, field, phase) {
  const value = Number(raw?.[field])
  if (!Number.isFinite(value)) {
    throw new Error(`Native playback counter ${field} is missing for ${phase}.`)
  }
  return value
}

function assertNativePlaybackSnapshot(snapshot, label) {
  if (!snapshot || snapshot.available !== true) throw new Error(`Native playback counter snapshot ${label} is unavailable.`)
  for (const field of NATIVE_PLAYBACK_COUNTER_FIELDS) {
    if (!Number.isFinite(Number(snapshot[field]))) {
      throw new Error(`Native playback counter snapshot ${label} is missing ${field}.`)
    }
  }
}

function assertPlaybackAdvanced(beforeTurn, afterHiddenCompletion) {
  const advanced = playbackAdvancedFields(beforeTurn, afterHiddenCompletion)
  if (advanced.length === 0) {
    throw new Error('Native playback counters did not advance during hidden native completion.')
  }
  if (afterHiddenCompletion.globalPlayCallCount <= beforeTurn.globalPlayCallCount) {
    throw new Error('Native playback request epoch did not advance during hidden native completion.')
  }
  if (afterHiddenCompletion.globalAudioTrackWrittenSamples <= beforeTurn.globalAudioTrackWrittenSamples) {
    throw new Error('Native playback AudioTrack written samples did not advance during hidden native speech.')
  }
  for (const field of NATIVE_PLAYBACK_COUNTER_FIELDS) {
    if (afterHiddenCompletion[field] < beforeTurn[field]) {
      throw new Error(`Native playback counter ${field} regressed during hidden completion.`)
    }
  }
}

function assertPlaybackStable(expected, actual, label) {
  for (const field of NATIVE_PLAYBACK_NO_REPLAY_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw new Error(`Native playback counter ${field} changed during ${label}: before=${expected[field]}, after=${actual[field]}`)
    }
  }
}

function playbackAdvancedFields(beforeTurn, afterHiddenCompletion) {
  return NATIVE_PLAYBACK_PROGRESS_FIELDS
    .filter((field) => afterHiddenCompletion[field] > beforeTurn[field])
}

function redactNativePlaybackSnapshot(snapshot) {
  return {
    globalPlayCallCount: snapshot.globalPlayCallCount,
    globalChunkEnqueueCount: snapshot.globalChunkEnqueueCount,
    globalFinalChunkQueuedCount: snapshot.globalFinalChunkQueuedCount,
    globalDrainNonEmptyCount: snapshot.globalDrainNonEmptyCount,
    globalAckCount: snapshot.globalAckCount,
    globalCompleteCount: snapshot.globalCompleteCount,
    globalFailureCount: snapshot.globalFailureCount,
    globalAudioTrackPlayCallCount: snapshot.globalAudioTrackPlayCallCount,
    globalAudioTrackWrittenSamples: snapshot.globalAudioTrackWrittenSamples,
  }
}

async function nativeEventSnapshot(invoke, { afterSequence } = {}) {
  const request = { kinds: NATIVE_ASSISTANT_EVENT_KINDS }
  if (afterSequence != null) request.afterSequence = afterSequence
  return await invoke('aurora_native_event_snapshot', { request })
}

async function startNativeEventCollector(webview, { afterSequence, acknowledgeEvents = true } = {}) {
  const request = { source: 'native', kinds: NATIVE_ASSISTANT_EVENT_KINDS, backfill: false }
  if (afterSequence != null) request.lastSequenceId = `native:${afterSequence}`
  return await evaluateWebviewJson(webview.client, `(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== 'function') throw new Error('tauri_invoke_unavailable');
    const internals = globalThis.__TAURI_INTERNALS__;
    const eventApi = globalThis.__TAURI__?.event ?? globalThis.__TAURI_EVENT__ ?? globalThis.__TAURI__;
    const rawListen = eventApi?.listen;
    const listen = typeof rawListen === 'function'
      ? (...args) => rawListen.apply(eventApi, args)
      : async (eventName, handler) => {
        if (typeof internals?.transformCallback !== 'function') throw new Error('tauri_event_listen_unavailable');
        const eventId = internals.transformCallback((event) => handler(event), false);
        await invoke('plugin:event|listen', { event: eventName, target: { kind: 'Any' }, handler: eventId });
        return async () => invoke('plugin:event|unlisten', { event: eventName, eventId });
      };
    const previous = globalThis.__auroraNativeEventSmoke;
    if (previous?.unlistenEvents) await previous.unlistenEvents().catch(() => {});
    if (previous?.unlistenClosed) await previous.unlistenClosed().catch(() => {});
    if (previous?.descriptor?.subscriptionId) {
      await invoke('aurora_unsubscribe', { request: { subscriptionId: previous.descriptor.subscriptionId } }).catch(() => {});
    }
    const state = {
      events: [],
      closed: [],
      descriptor: null,
      ready: false,
      startedAt: Date.now(),
      errors: [],
      acknowledgeEvents: ${JSON.stringify(acknowledgeEvents)},
      acknowledged: [],
      withheldAcks: [],
    };
    globalThis.__auroraNativeEventSmoke = state;
    let descriptor = null;
    try {
      descriptor = await invoke('aurora_subscribe', { request: ${JSON.stringify(request)} });
      state.descriptor = descriptor;
      const nativeEventId = (payload) => {
        const eventShaped = (value) => value && typeof value === 'object' && typeof value.kind === 'string'
          && (typeof value.id === 'string' || typeof value.eventId === 'string' || Number.isFinite(Number(value.sequence)));
        const raw = eventShaped(payload)
          ? payload
          : payload?.event ?? payload?.payload?.event ?? (eventShaped(payload?.payload) ? payload.payload : payload);
        if (!raw || typeof raw !== 'object') return null;
        if (typeof raw.id === 'string') return raw.id;
        if (typeof raw.eventId === 'string') return raw.eventId;
        if (Number.isFinite(Number(raw.sequence))) return 'native:' + Number(raw.sequence);
        return null;
      };
      state.unlistenEvents = await listen(descriptor.eventName, (event) => {
        const payload = event?.payload ?? event ?? null;
        const eventId = nativeEventId(payload);
        state.events.push({ receivedAt: Date.now(), payload });
        if (!eventId) return;
        if (state.acknowledgeEvents !== true) {
          state.withheldAcks.push({ eventId, receivedAt: Date.now() });
          return;
        }
        void invoke('aurora_native_event_ack', { request: { subscriptionId: descriptor.subscriptionId, eventId } })
          .then(() => { state.acknowledged.push({ eventId, receivedAt: Date.now() }); })
          .catch((error) => { state.errors.push(error?.message ?? String(error)); });
      });
      state.unlistenClosed = await listen(descriptor.eventName + '/closed', (event) => {
        state.closed.push({ receivedAt: Date.now(), payload: event?.payload ?? event ?? null });
      });
      await invoke('aurora_activate_subscription', { request: { subscriptionId: descriptor.subscriptionId } });
      state.ready = true;
      return JSON.stringify({
        ready: state.ready,
        descriptor: state.descriptor,
        eventCount: state.events.length,
        closedCount: state.closed.length,
        acknowledgeEvents: state.acknowledgeEvents,
      });
    } catch (error) {
      state.errors.push(error?.message ?? String(error));
      if (state.unlistenEvents) await state.unlistenEvents().catch(() => {});
      if (state.unlistenClosed) await state.unlistenClosed().catch(() => {});
      if (descriptor?.subscriptionId) {
        await invoke('aurora_unsubscribe', { request: { subscriptionId: descriptor.subscriptionId } }).catch(() => {});
      }
      globalThis.__auroraNativeEventSmoke = null;
      throw error;
    }
  })()`, COMMAND_TIMEOUT_MS)
}

async function waitForNativeEventCollectorTurn(webview, completed, timeoutMs = DEFAULT_STATUS_TIMEOUT_MS) {
  const generation = nativeTurnGeneration(completed)
  if (generation == null) throw new Error('Native event replay requires a completed turn generation.')
  const deadline = Date.now() + timeoutMs
  let collector = null
  while (Date.now() < deadline) {
    collector = await readNativeEventCollector(webview)
    const observedEvents = normalizeNativeCollectedEvents(collector.events)
    const events = observedEvents.filter((event) => nativeVoiceObservationMatchesGeneration(event, generation))
    if ((collector.errors ?? []).length > 0) {
      throw new Error(`Native event replay acknowledgement failed: ${nativeBridgeSummaryJson({ generation, collector })}`)
    }
    const acknowledgedIds = new Set((collector.acknowledged ?? []).map((entry) => entry.eventId))
    const acksComplete = collector.acknowledgeEvents === true && observedEvents.every((event) => {
      const id = nativeEventAckId(event)
      return id == null || acknowledgedIds.has(id)
    })
    const hasTurnEvent = events.some((event) => nativeEventKind(event)?.startsWith?.('voice.turn.'))
    const hasTerminalEvent = events.some((event) => NATIVE_TERMINAL_EVENT_KINDS.has(nativeEventKind(event)))
    if (collector.ready === true && hasTurnEvent && hasTerminalEvent && acksComplete) return collector
    await sleep(250)
  }
  throw new Error(`Fresh native event subscriber did not replay the completed turn and terminal event: ${nativeBridgeSummaryJson({ generation, collector })}`)
}

async function readNativeEventCollector(webview) {
  return await evaluateWebviewJson(webview.client, `(async () => {
    const state = globalThis.__auroraNativeEventSmoke;
    if (!state) return JSON.stringify({ ready: false, events: [], closed: [], errors: ['collector_missing'] });
    return JSON.stringify({
      ready: state.ready === true,
      descriptor: state.descriptor ?? null,
      events: state.events ?? [],
      closed: state.closed ?? [],
      errors: state.errors ?? [],
      acknowledgeEvents: state.acknowledgeEvents === true,
      acknowledged: state.acknowledged ?? [],
      withheldAcks: state.withheldAcks ?? [],
    });
  })()`, COMMAND_TIMEOUT_MS)
}

async function stopNativeEventCollector(webview, collector, { verify = false } = {}) {
  if (!webview?.client || !collector?.descriptor?.subscriptionId) {
    if (verify) throw new Error('Cannot detach the owned native event collector without its WebView and subscription id.')
    return
  }
  await evaluateWebviewJson(webview.client, `(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    const state = globalThis.__auroraNativeEventSmoke;
    const subscriptionId = ${JSON.stringify(collector.descriptor.subscriptionId)};
    if (${JSON.stringify(verify)} && state?.descriptor?.subscriptionId !== subscriptionId) {
      throw new Error('owned_native_event_collector_mismatch');
    }
    if (state?.unlistenEvents) {
      if (${JSON.stringify(verify)}) await state.unlistenEvents();
      else await state.unlistenEvents().catch(() => {});
    }
    if (state?.unlistenClosed) {
      if (${JSON.stringify(verify)}) await state.unlistenClosed();
      else await state.unlistenClosed().catch(() => {});
    }
    if (typeof invoke !== 'function') {
      if (${JSON.stringify(verify)}) throw new Error('tauri_invoke_unavailable');
    } else if (${JSON.stringify(verify)}) {
      const result = await invoke('aurora_unsubscribe', { request: { subscriptionId } });
      if (result?.closed !== true || result?.subscriptionId !== subscriptionId) {
        throw new Error('owned_native_event_unsubscribe_unconfirmed');
      }
    } else {
      await invoke('aurora_unsubscribe', { request: { subscriptionId } }).catch(() => {});
    }
    globalThis.__auroraNativeEventSmoke = null;
    return JSON.stringify({ stopped: true, subscriptionId, unsubscribeVerified: ${JSON.stringify(verify)} });
  })()`, COMMAND_TIMEOUT_MS)
}

async function evaluateWebviewJson(client, expression, timeoutMs = COMMAND_TIMEOUT_MS) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs)
  const raw = response.result?.result?.value
  if (typeof raw !== 'string') {
    throw new Error(`WebView evaluation returned no serialized value: ${JSON.stringify(response)}`)
  }
  return parseJson(raw)
}

export function assertNativeEventBridgeProgression({
  active,
  completed,
  beforeSnapshot,
  liveCollector,
  replaySnapshot,
  afterSequence,
  uiHiddenDuringTurn,
  allowGapEvents = false,
  allowIncompleteReplay = false,
}) {
  const liveEvents = normalizeNativeCollectedEvents(liveCollector?.events)
  const replayEvents = normalizeNativeSnapshotEvents(replaySnapshot?.events)
  const events = uniqueNativeEvents([...liveEvents, ...replayEvents])
    .filter((event) => nativeEventAfterSequenceOrGap(event, afterSequence))
  const subjects = Array.isArray(replaySnapshot?.subjects) ? replaySnapshot.subjects : []
  const observedKinds = [...new Set(events.map((event) => nativeEventKind(event)).filter(Boolean))].sort()
  const gapEvents = events.filter((event) => nativeEventKind(event) === 'native.events.gap')
  assertNativeEventSequencesMonotonic(liveEvents, 'live native events')
  assertNativeEventSequencesMonotonic(replayEvents, 'native replay snapshot events')
  if (typeof replaySnapshot?.lastSequenceId !== 'string' || replaySnapshot.lastSequenceId.length === 0) {
    throw new Error(`Native event snapshot did not report a native cursor: ${nativeBridgeSummaryJson({ replaySnapshot })}`)
  }
  if (gapEvents.length > 0 && allowGapEvents !== true) {
    throw new Error(`Native event subscription reported a replay gap: ${nativeBridgeSummaryJson({ gapEvents })}`)
  }
  if (uiHiddenDuringTurn !== true) {
    throw new Error('Native event bridge acceptance requires the UI to be hidden during the background turn.')
  }
  const completedGeneration = nativeTurnGeneration(completed)
  if (completedGeneration == null) {
    throw new Error(`Native event bridge acceptance requires a completed background turn generation: ${nativeBridgeSummaryJson({ active, completed })}`)
  }
  if (nativeTurnGeneration(active) === completedGeneration) {
    throw new Error(`Native event bridge acceptance did not observe a new background turn generation: ${nativeBridgeSummaryJson({ active, completed })}`)
  }
  if (allowGapEvents !== true) {
    assertNormalNativeEventAcks({ liveCollector, liveEvents, afterSequence })
  }

  const matchingLiveEvents = liveEvents
    .filter((event) => nativeEventAfterSequenceOrGap(event, afterSequence))
    .filter((event) => nativeVoiceObservationMatchesGeneration(event, completedGeneration))
  const matchingReplayEvents = replayEvents
    .filter((event) => nativeEventAfterSequenceOrGap(event, afterSequence))
    .filter((event) => nativeVoiceObservationMatchesGeneration(event, completedGeneration))
  const matchingSubjects = subjects.filter((subject) => nativeVoiceObservationMatchesGeneration(subject, completedGeneration))
  const matchingEvents = uniqueNativeEvents([...matchingLiveEvents, ...matchingReplayEvents])
  const correlation = assertNativeTurnCorrelation({ completed, events: matchingEvents, subjects: matchingSubjects })
  const matchingObservedKinds = [...new Set(matchingEvents.map((event) => nativeEventKind(event)).filter(Boolean))].sort()
  const matchingTerminalEvents = matchingEvents.filter((event) => NATIVE_TERMINAL_EVENT_KINDS.has(nativeEventKind(event)))
  const matchingTerminalSubjects = matchingSubjects.filter((subject) => subject?.terminal === true || NATIVE_TERMINAL_EVENT_KINDS.has(subject?.kind))
  const liveVoiceEvents = matchingLiveEvents.filter((event) => nativeEventKind(event)?.startsWith?.('voice.turn.'))
  const replayVoiceEvents = matchingReplayEvents.filter((event) => nativeEventKind(event)?.startsWith?.('voice.turn.'))
  const replayVoiceSubjects = matchingSubjects.filter((subject) => subject?.kind?.startsWith?.('voice.turn.'))

  if (replaySnapshot?.replayComplete !== true && (allowIncompleteReplay !== true || (replayVoiceEvents.length === 0 && replayVoiceSubjects.length === 0))) {
    throw new Error(`Native event replay did not complete after ${beforeSnapshot?.lastSequenceId ?? 'start'}: ${nativeBridgeSummaryJson({ replaySnapshot })}`)
  }

  if (liveVoiceEvents.length === 0) {
    throw new Error(`Native event bridge did not deliver live events for background turn generation ${completedGeneration}: ${nativeBridgeSummaryJson({ liveEvents, observedKinds })}`)
  }
  if (replayVoiceEvents.length === 0 && replayVoiceSubjects.length === 0) {
    throw new Error(`Native event replay did not recover background turn generation ${completedGeneration}: ${nativeBridgeSummaryJson({ matchingObservedKinds, subjects })}`)
  }
  if (matchingTerminalEvents.length === 0 && matchingTerminalSubjects.length === 0) {
    throw new Error(`Native event bridge did not expose a terminal state for background turn generation ${completedGeneration}: ${nativeBridgeSummaryJson({ matchingObservedKinds, matchingSubjects })}`)
  }

  assertNativeTurnTerminalSemantics({
    generation: completedGeneration,
    liveEvents: matchingLiveEvents,
    replayEvents: matchingReplayEvents,
    subjects: matchingSubjects,
  })

  return {
    enabled: true,
    baselineLastSequenceId: beforeSnapshot?.lastSequenceId ?? null,
    replayLastSequenceId: replaySnapshot?.lastSequenceId ?? null,
    replayComplete: replaySnapshot?.replayComplete === true,
    uiHiddenDuringTurn,
    uiReopened: true,
    liveEventCount: liveEvents.length,
    replayEventCount: replayEvents.length,
    subjectCount: subjects.length,
    matchingLiveEventCount: matchingLiveEvents.length,
    matchingReplayEventCount: matchingReplayEvents.length,
    matchingReplaySubjectCount: matchingSubjects.length,
    replayRecovered: replayVoiceEvents.length > 0 || replayVoiceSubjects.length > 0,
    observedKinds,
    gapEventCount: gapEvents.length,
    gapReasons: [...new Set(gapEvents.map((event) => nativeEventPayload(event)?.reason).filter(Boolean))].sort(),
    matchingObservedKinds,
    terminalKinds: nativeTerminalEvidenceKinds(matchingTerminalEvents, matchingTerminalSubjects),
    terminalEventKinds: [...new Set(matchingTerminalEvents.map((event) => nativeEventKind(event)).filter(Boolean))].sort(),
    terminalSubjectKinds: [...new Set(matchingTerminalSubjects.map((subject) => subject?.kind).filter(Boolean))].sort(),
    terminalSubjectCount: matchingTerminalSubjects.length,
    backgroundOutcome: completed?.liveOutcome ?? null,
    baselineGeneration: active?.sessionGeneration ?? null,
    completedGeneration,
    correlation,
    persistedResultUniquenessMeasured: false,
    duplicatePersistedResult: null,
    persistedResultUnsupportedReason: 'The Android live smoke can assert native terminal event and subject identity; existing public Android live APIs do not expose saved conversation row ids or persisted row counts.',
    ttsReplayMeasured: false,
    ttsReplayUnsupportedReason: 'Existing public Android live APIs do not expose native TTS playback request ids or playback counts.',
    nativeTtsPlaybackMeasured: false,
    nativeTtsPlaybackUnsupportedReason: 'Existing public Android live APIs do not expose native TTS playback request ids or playback counts.',
  }
}

export function assertNativeTurnCorrelation({ completed, events = [], subjects = [] }) {
  const completedPayload = nativeEventPayload(completed)
  const completedRequestId = completed?.requestId ?? completed?.request_id ?? completedPayload?.requestId ?? completedPayload?.request_id
  const completedConversationId = completed?.conversationId ?? completed?.conversation_id ?? completedPayload?.conversationId ?? completedPayload?.conversation_id
  const correlated = [...events, ...subjects].map((item) => {
    const payload = nativeEventPayload(item)
    const itemRequestId = item?.requestId ?? item?.request_id ?? payload?.requestId ?? payload?.request_id
    const itemConversationId = item?.conversationId ?? item?.conversation_id ?? payload?.conversationId ?? payload?.conversation_id
    return { item, requestId: itemRequestId, conversationId: itemConversationId }
  }).filter(({ requestId, conversationId }) => requestId && conversationId)
  const pairs = [...new Set(correlated.map(({ requestId, conversationId }) => `${requestId}\u0000${conversationId}`))]
  if (pairs.length !== 1) {
    throw new Error(`Native turn acceptance requires one request/conversation correlation pair; observed ${pairs.length}.`)
  }
  const [requestId, conversationId] = pairs[0].split('\u0000')
  for (const item of [...events, ...subjects]) {
    const payload = nativeEventPayload(item)
    const itemRequestId = item?.requestId ?? item?.request_id ?? payload?.requestId ?? payload?.request_id
    const itemConversationId = item?.conversationId ?? item?.conversation_id ?? payload?.conversationId ?? payload?.conversation_id
    if (!itemRequestId && !itemConversationId) continue
    if (!itemRequestId || !itemConversationId || itemRequestId !== requestId || itemConversationId !== conversationId) {
      throw new Error(`Native turn acceptance observed a partial or conflicting correlation id: ${nativeBridgeSummaryJson({ item, requestId, conversationId })}`)
    }
  }
  const terminalItems = [...events, ...subjects].filter((item) => NATIVE_TERMINAL_EVENT_KINDS.has(nativeEventKind(item)) || item?.terminal === true)
  if (!terminalItems.some((item) => {
    const payload = nativeEventPayload(item)
    const itemRequestId = item?.requestId ?? item?.request_id ?? payload?.requestId ?? payload?.request_id
    const itemConversationId = item?.conversationId ?? item?.conversation_id ?? payload?.conversationId ?? payload?.conversation_id
    return itemRequestId === requestId && itemConversationId === conversationId
  })) {
    throw new Error(`Native turn acceptance terminal evidence was not correlated to request ${requestId} and conversation ${conversationId}.`)
  }
  if ((completedRequestId && completedRequestId !== requestId) || (completedConversationId && completedConversationId !== conversationId)) {
    throw new Error(`Native turn completion correlation disagrees with event subjects: ${nativeBridgeSummaryJson({ completed, requestId, conversationId })}`)
  }
  const matches = correlated.filter(({ requestId: itemRequestId, conversationId: itemConversationId }) => itemRequestId === requestId && itemConversationId === conversationId)
  if (matches.length === 0) {
    throw new Error(`Native turn acceptance observed no event or subject for request ${requestId} and conversation ${conversationId}.`)
  }
  return { requestId, conversationId, matchingEventCount: matches.length }
}


export function assertNativeEventBridgeSlowConsumerRecovery({
  active,
  completed,
  liveCollector,
  replaySnapshot,
  afterSequence,
}) {
  const liveEvents = normalizeNativeCollectedEvents(liveCollector?.events)
    .filter((event) => nativeEventAfterSequenceOrGap(event, afterSequence))
  const replayEvents = normalizeNativeSnapshotEvents(replaySnapshot?.events)
    .filter((event) => nativeEventAfterSequenceOrGap(event, afterSequence))
  const subjects = Array.isArray(replaySnapshot?.subjects) ? replaySnapshot.subjects : []
  const completedGeneration = nativeTurnGeneration(completed)
  if (completedGeneration == null) {
    throw new Error(`Slow native event bridge acceptance requires a completed generation: ${nativeBridgeSummaryJson({ completed })}`)
  }
  if (nativeTurnGeneration(active) === completedGeneration) {
    throw new Error(`Slow native event bridge acceptance did not advance the background generation: ${nativeBridgeSummaryJson({ active, completed })}`)
  }
  if (Number(completed?.acceptedSamples ?? 0) <= Number(active?.acceptedSamples ?? 0)) {
    throw new Error(`Slow native event bridge acceptance did not advance speech samples while acknowledgement was withheld: ${nativeBridgeSummaryJson({ active, completed })}`)
  }
  if (liveCollector?.acknowledgeEvents !== false) {
    throw new Error(`Slow native event bridge acceptance requires acknowledgement withholding: ${nativeBridgeSummaryJson({ liveCollector })}`)
  }
  const withheldAckCount = Array.isArray(liveCollector?.withheldAcks) ? liveCollector.withheldAcks.length : 0
  if (withheldAckCount === 0) {
    throw new Error(`Slow native event bridge acceptance did not withhold a native event acknowledgement: ${nativeBridgeSummaryJson({ liveCollector })}`)
  }

  const matchingLiveEvents = liveEvents.filter((event) => nativeVoiceObservationMatchesGeneration(event, completedGeneration))
  const matchingReplayEvents = replayEvents.filter((event) => nativeVoiceObservationMatchesGeneration(event, completedGeneration))
  const matchingSubjects = subjects.filter((subject) => nativeVoiceObservationMatchesGeneration(subject, completedGeneration))
  if (matchingLiveEvents.length === 0) {
    throw new Error(`Slow native event bridge acceptance did not receive an initial live event before withholding ack: ${nativeBridgeSummaryJson({ liveEvents, completedGeneration })}`)
  }
  if (matchingReplayEvents.length === 0 && matchingSubjects.length === 0) {
    throw new Error(`Slow native event bridge acceptance did not recover the completed turn from replay or subject snapshot: ${nativeBridgeSummaryJson({ completedGeneration, subjects })}`)
  }
  const gapEvents = uniqueNativeEvents([...liveEvents, ...replayEvents])
    .filter((event) => nativeEventKind(event) === 'native.events.gap')
  const terminalEvents = [...matchingLiveEvents, ...matchingReplayEvents]
    .filter((event) => NATIVE_TERMINAL_EVENT_KINDS.has(nativeEventKind(event)))
  const terminalSubjects = matchingSubjects
    .filter((subject) => subject?.terminal === true || NATIVE_TERMINAL_EVENT_KINDS.has(subject?.kind))
  if (terminalEvents.length === 0 && terminalSubjects.length === 0) {
    throw new Error(`Slow native event bridge acceptance did not expose terminal state from snapshot recovery: ${nativeBridgeSummaryJson({ completedGeneration, matchingSubjects })}`)
  }
  assertNativeTurnTerminalSemantics({
    generation: completedGeneration,
    liveEvents: matchingLiveEvents,
    replayEvents: matchingReplayEvents,
    subjects: matchingSubjects,
  })
  return {
    enabled: true,
    acknowledgementWithheld: true,
    withheldAckCount,
    acknowledgedCount: Array.isArray(liveCollector?.acknowledged) ? liveCollector.acknowledged.length : 0,
    closedCount: Array.isArray(liveCollector?.closed) ? liveCollector.closed.length : 0,
    hubGapObserved: gapEvents.length > 0,
    gapReasons: [...new Set(gapEvents.map((event) => nativeEventPayload(event)?.reason).filter(Boolean))].sort(),
    snapshotRecovered: matchingReplayEvents.length > 0 || matchingSubjects.length > 0,
    matchingLiveEventCount: matchingLiveEvents.length,
    matchingReplayEventCount: matchingReplayEvents.length,
    matchingReplaySubjectCount: matchingSubjects.length,
    completedGeneration,
    acceptedSamplesBefore: active?.acceptedSamples ?? null,
    acceptedSamplesAfter: completed?.acceptedSamples ?? null,
    limitation: gapEvents.length > 0
      ? null
      : 'The live script withheld one-event acknowledgement and proved snapshot recovery plus voice progress; this run did not observe a native hub overrun gap because the production subscribe command does not expose a small subscriber capacity.',
  }
}


function assertNormalNativeEventAcks({ liveCollector, liveEvents, afterSequence }) {
  if (liveCollector?.acknowledgeEvents !== true) {
    throw new Error(`Native event bridge normal mode did not acknowledge native events: ${nativeBridgeSummaryJson({ liveCollector })}`)
  }
  const errors = Array.isArray(liveCollector?.errors) ? liveCollector.errors : []
  if (errors.length > 0) {
    throw new Error(`Native event bridge normal mode reported acknowledgement errors: ${nativeBridgeSummaryJson({ liveCollector })}`)
  }
  const acknowledgedIds = new Set(
    (Array.isArray(liveCollector?.acknowledged) ? liveCollector.acknowledged : [])
      .map((entry) => entry?.eventId)
      .filter((id) => typeof id === 'string' && id.length > 0),
  )
  const observedIds = liveEvents
    .filter((event) => nativeEventSequence(event) == null || afterSequence == null || nativeEventSequence(event) > afterSequence)
    .map((event) => nativeEventAckId(event))
    .filter((id) => typeof id === 'string' && id.length > 0)
  const missingAckIds = observedIds.filter((id) => !acknowledgedIds.has(id))
  if (missingAckIds.length > 0) {
    throw new Error(`Native event bridge normal mode received events without successful acknowledgement: ${nativeBridgeSummaryJson({ liveCollector, missingAckIds })}`)
  }
}

function nativeEventAfterSequenceOrGap(event, afterSequence) {
  if (afterSequence == null) return true
  const sequence = nativeEventSequence(event)
  if (sequence == null || sequence > afterSequence) return true
  if (nativeEventKind(event) !== 'native.events.gap') return false
  const payload = nativeEventPayload(event)
  const firstMissingSequence = Number(payload?.firstMissingSequence ?? payload?.first_missing_sequence)
  const nextAvailableSequence = Number(payload?.nextAvailableSequence ?? payload?.next_available_sequence)
  return (Number.isFinite(firstMissingSequence) && firstMissingSequence > afterSequence)
    || (Number.isFinite(nextAvailableSequence) && nextAvailableSequence > afterSequence)
}

function nativeEventAckId(event) {
  if (!event || typeof event !== 'object') return null
  if (typeof event.id === 'string') return event.id
  if (typeof event.eventId === 'string') return event.eventId
  const sequence = nativeEventSequence(event)
  return sequence == null ? null : `native:${sequence}`
}

function nativeBridgeSummaryJson(input) {
  return JSON.stringify(nativeBridgeSummary(input))
}

function nativeBridgeSummary(input) {
  return {
    active: summarizeNativeTurn(input?.active),
    completed: summarizeNativeTurn(input?.completed),
    completedGeneration: input?.completedGeneration ?? null,
    liveCollector: summarizeNativeCollector(input?.liveCollector),
    liveEvents: summarizeNativeEvents(input?.liveEvents),
    replaySnapshot: summarizeNativeSnapshot(input?.replaySnapshot),
    gapEvents: summarizeNativeEvents(input?.gapEvents),
    subjects: summarizeNativeSubjects(input?.subjects),
    matchingSubjects: summarizeNativeSubjects(input?.matchingSubjects),
    observedKinds: Array.isArray(input?.observedKinds) ? input.observedKinds : undefined,
    matchingObservedKinds: Array.isArray(input?.matchingObservedKinds) ? input.matchingObservedKinds : undefined,
    missingAckIds: Array.isArray(input?.missingAckIds) ? input.missingAckIds : undefined,
  }
}

function summarizeNativeCollector(collector) {
  if (!collector || typeof collector !== 'object') return null
  return {
    ready: collector.ready === true,
    acknowledgeEvents: collector.acknowledgeEvents === true,
    eventCount: Array.isArray(collector.events) ? collector.events.length : 0,
    acknowledgedCount: Array.isArray(collector.acknowledged) ? collector.acknowledged.length : 0,
    acknowledgedIds: summarizeNativeIds(collector.acknowledged),
    withheldAckCount: Array.isArray(collector.withheldAcks) ? collector.withheldAcks.length : 0,
    withheldAckIds: summarizeNativeIds(collector.withheldAcks),
    closedCount: Array.isArray(collector.closed) ? collector.closed.length : 0,
    errorCount: Array.isArray(collector.errors) ? collector.errors.length : 0,
  }
}

function summarizeNativeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null
  return {
    lastSequenceId: typeof snapshot.lastSequenceId === 'string' ? snapshot.lastSequenceId : null,
    replayComplete: snapshot.replayComplete === true,
    eventCount: Array.isArray(snapshot.events) ? snapshot.events.length : 0,
    events: summarizeNativeEvents(snapshot.events),
    subjectCount: Array.isArray(snapshot.subjects) ? snapshot.subjects.length : 0,
    subjects: summarizeNativeSubjects(snapshot.subjects),
  }
}

function summarizeNativeEvents(events) {
  if (!Array.isArray(events)) return undefined
  return events.map((event) => ({
    id: nativeEventAckId(event),
    sequence: nativeEventSequence(event),
    kind: nativeEventKind(event),
    generation: nativeTurnGeneration(event),
    reason: nativeEventPayload(event)?.reason ?? undefined,
  }))
}

function summarizeNativeSubjects(subjects) {
  if (!Array.isArray(subjects)) return undefined
  return subjects.map((subject) => ({
    id: typeof subject?.id === 'string' ? subject.id : undefined,
    subject: typeof subject?.subject === 'string' ? subject.subject : undefined,
    kind: typeof subject?.kind === 'string' ? subject.kind : undefined,
    generation: nativeTurnGeneration(subject),
    terminal: subject?.terminal === true,
    persisted: subject?.persisted === true,
  }))
}

function summarizeNativeTurn(turn) {
  if (!turn || typeof turn !== 'object') return null
  return {
    generation: nativeTurnGeneration(turn),
    acceptedSamples: Number.isFinite(Number(turn.acceptedSamples)) ? Number(turn.acceptedSamples) : null,
    liveOutcome: typeof turn.liveOutcome === 'string' ? turn.liveOutcome : null,
  }
}

function summarizeNativeIds(entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .map((entry) => (typeof entry?.eventId === 'string' ? entry.eventId : null))
    .filter(Boolean)
}

function normalizeNativeCollectedEvents(entries) {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => normalizeNativeEventPayload(entry?.payload ?? entry)).filter(Boolean)
}

function normalizeNativeSnapshotEvents(entries) {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => normalizeNativeEventPayload(entry)).filter(Boolean)
}

function normalizeNativeEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (isNativeAuroraEvent(payload)) return payload
  if (isNativeAuroraEvent(payload.event)) return payload.event
  if (isNativeAuroraEvent(payload.payload)) return payload.payload
  if (isNativeAuroraEvent(payload.payload?.event)) return payload.payload.event
  return null
}

function isNativeAuroraEvent(value) {
  if (!value || typeof value !== 'object') return false
  return typeof value.kind === 'string'
    && (nativeEventSequence(value) != null || typeof value.id === 'string' || typeof value.eventId === 'string')
}

function uniqueNativeEvents(events) {
  const seen = new Set()
  const unique = []
  for (const event of events) {
    const key = nativeEventIdentity(event)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(event)
  }
  return unique
}

function nativeEventIdentity(event) {
  if (nativeEventKind(event) === 'native.events.gap') {
    const payload = nativeEventPayload(event)
    return [
      event?.id ?? event?.eventId ?? event?.sequence ?? 'gap',
      nativeEventKind(event),
      payload?.reason ?? '',
      payload?.firstMissingSequence ?? payload?.first_missing_sequence ?? '',
      payload?.nextAvailableSequence ?? payload?.next_available_sequence ?? '',
    ].join(':')
  }
  return String(event?.id ?? event?.eventId ?? event?.sequence ?? JSON.stringify(event))
}

function nativeEventKind(event) {
  return event?.kind ?? event?.eventKind ?? event?.payload?.kind ?? null
}

function nativeEventPayload(item) {
  return item?.payload && typeof item.payload === 'object' ? item.payload : item
}

function nativeTurnGeneration(item) {
  const payload = nativeEventPayload(item)
  const value = payload?.generation ?? item?.generation ?? item?.sessionGeneration ?? item?.session_generation
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nativeVoiceObservationMatchesGeneration(item, generation) {
  if (!item || typeof item !== 'object') return false
  const expectedSubject = `voice:${generation}`
  const itemGeneration = nativeTurnGeneration(item)
  if (itemGeneration === generation) return true
  if (item.subject === expectedSubject) return true
  if (Array.isArray(item.subjects) && item.subjects.includes(expectedSubject)) return true
  const payload = nativeEventPayload(item)
  return payload?.subject === expectedSubject || (Array.isArray(payload?.subjects) && payload.subjects.includes(expectedSubject))
}

function nativeEventSequence(event) {
  const direct = Number(event?.sequence ?? event?.sequenceId ?? event?.sequence_id)
  if (Number.isFinite(direct)) return direct
  return nativeEventSequenceFromCursor(event?.id ?? event?.eventId ?? event?.lastSequenceId)
}

function nativeEventSequenceFromCursor(cursor) {
  const match = typeof cursor === 'string' ? /^native:(\d+)$/u.exec(cursor) : null
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

function assertNativeEventSequencesMonotonic(events, label) {
  let previous = null
  for (const event of events) {
    const sequence = nativeEventSequence(event)
    if (sequence == null) continue
    if (previous != null && sequence < previous) {
      throw new Error(`${label} regressed from sequence ${previous} to sequence ${sequence}.`)
    }
    previous = sequence
  }
}

function assertNativeTurnTerminalSemantics({ generation, liveEvents, replayEvents, subjects }) {
  const eventTerminals = [...liveEvents, ...replayEvents]
    .filter((event) => nativeEventKind(event)?.startsWith?.('voice.turn.'))
    .filter((event) => NATIVE_TERMINAL_EVENT_KINDS.has(nativeEventKind(event)))
  const subjectTerminals = subjects
    .filter((subject) => subject?.kind?.startsWith?.('voice.turn.'))
    .filter((subject) => subject?.terminal === true || NATIVE_TERMINAL_EVENT_KINDS.has(subject?.kind))
  const terminalKinds = new Set([
    ...eventTerminals.map((event) => nativeEventKind(event)),
    ...subjectTerminals.map((subject) => subject?.kind),
  ].filter(Boolean))
  if (terminalKinds.size > 1) {
    throw new Error(`Native event bridge reported conflicting terminal states for background turn generation ${generation}: ${JSON.stringify([...terminalKinds].sort())}`)
  }

  const terminalSequences = [...new Set(eventTerminals
    .map((event) => nativeEventSequence(event))
    .filter((sequence) => sequence != null))]
  if (terminalSequences.length > 1) {
    throw new Error(`Native event bridge reported duplicate terminal results for background turn generation ${generation}: ${terminalSequences.map((sequence) => `native:${sequence}`).join(', ')}`)
  }

  const terminalSequence = terminalSequences[0]
  if (terminalSequence != null) {
    const laterNonTerminal = [...liveEvents, ...replayEvents]
      .filter((event) => nativeEventKind(event)?.startsWith?.('voice.turn.'))
      .filter((event) => !NATIVE_TERMINAL_EVENT_KINDS.has(nativeEventKind(event)))
      .map((event) => nativeEventSequence(event))
      .filter((sequence) => sequence != null && sequence > terminalSequence)
    if (laterNonTerminal.length > 0) {
      throw new Error(`Native event bridge reported non-terminal events after the terminal state for background turn generation ${generation}: ${JSON.stringify(laterNonTerminal)}`)
    }
  }
}

async function proveNotificationStop(context, invoke, { interactionMode = notificationInteractionMode() } = {}) {
  const preconditions = await assertNotificationStopPreconditions(context, invoke)
  const stopped = interactionMode === 'external'
    ? await waitForExternalNotificationStop(context, invoke)
    : await tapNotificationStop(context).then(() => pollNotificationStopPostconditions(context, invoke))
  const stillStopped = stopped.status

  return {
    interactionMode,
    preconditions,
    stopped: stopped.status.backgroundStoppedByUser === true,
    stoppedStatus: summarizeVoiceStatus(stopped.status),
    finalStoppedStatus: summarizeVoiceStatus(stillStopped),
    serviceStopped: stopped.serviceVisible === false,
    notificationDismissed: stopped.notificationVisible === false,
    remainedStoppedUntilReopen: true,
    restartedOnReopen: false,
  }
}

export function notificationInteractionMode(value = process.env[NOTIFICATION_INTERACTION_MODE_ENV]) {
  const mode = value == null || value === '' ? 'automatic' : String(value).trim().toLowerCase()
  if (!NOTIFICATION_INTERACTION_MODES.has(mode)) {
    throw new Error(`Unsupported Android notification interaction mode: ${mode}`)
  }
  return mode
}

export function notificationStopPostcondition(status) {
  return status?.running !== true
    && status?.captureActive !== true
    && status?.backgroundStoppedByUser === true
}

export async function pollNotificationStopPostconditions(context, invoke, {
  sleepFn = sleep,
  serviceVisible = () => serviceIsVisibleStrict(context),
  notificationVisible = () => notificationIsVisibleStrict(context),
  timeoutMs = Number(process.env.AURORA_ANDROID_VOICE_STATUS_TIMEOUT_MS ?? DEFAULT_STATUS_TIMEOUT_MS),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs
  let last
  while (now() < deadline) {
    last = await invoke('aurora_android_voice_foreground_service_status')
    const serviceStillVisible = serviceVisible() === true
    const notificationStillVisible = notificationVisible() === true
    if (notificationStopPostcondition(last) && !serviceStillVisible && !notificationStillVisible) {
      return {
        status: last,
        serviceVisible: serviceStillVisible,
        notificationVisible: notificationStillVisible,
      }
    }
    await sleepFn(STATUS_POLL_MS)
  }
  throw new Error(`Android notification Stop postconditions timed out. Last status: ${JSON.stringify({
    status: last,
    serviceVisible: serviceVisible() === true,
    notificationVisible: notificationVisible() === true,
  })}`)
}

export async function assertNotificationStopPreconditions(context, invoke, {
  serviceVisible = serviceIsVisible(context),
  notificationVisible = notificationIsVisible(context),
} = {}) {
  const status = await invoke('aurora_android_voice_foreground_service_status')
  if (status?.running !== true || status?.backgroundSessionActive !== true || status?.captureActive !== true
    || serviceVisible !== true || notificationVisible !== true) {
    throw new Error(`Notification Stop preconditions were not live: ${JSON.stringify({
      status: summarizeVoiceStatus(status), serviceVisible, notificationVisible,
    })}`)
  }
  return { status: summarizeVoiceStatus(status), serviceVisible, notificationVisible }
}

export async function waitForExternalNotificationStop(context, invoke, {
  emit = (marker) => console.log(JSON.stringify(marker)),
  expand = () => adbRun(context, ['shell', 'cmd', 'statusbar', 'expand-notifications']),
  collapse = () => adbTry(context, ['shell', 'cmd', 'statusbar', 'collapse']),
  wake = () => adbTry(context, ['shell', 'input', 'keyevent', 'WAKEUP']),
  dismissKeyguard = () => adbTry(context, ['shell', 'wm', 'dismiss-keyguard']),
  wait = sleep,
  serviceVisible = () => serviceIsVisibleStrict(context),
  notificationVisible = () => notificationIsVisibleStrict(context),
  now = () => Date.now(),
  timeoutMs = Number(process.env.AURORA_ANDROID_VOICE_STATUS_TIMEOUT_MS ?? DEFAULT_STATUS_TIMEOUT_MS),
} = {}) {
  collapse()
  wake()
  dismissKeyguard()
  expand()
  await wait(750)
  emit({
    event: 'notification_stop_waiting',
    interactionMode: 'external',
    deadline: Date.now() + Number(process.env.AURORA_ANDROID_VOICE_STATUS_TIMEOUT_MS ?? DEFAULT_STATUS_TIMEOUT_MS),
    postcondition: 'backgroundStoppedByUser_and_capture_inactive_and_service_stopped',
  })
  try {
    return await pollNotificationStopPostconditions(context, invoke, {
      sleepFn: wait,
      serviceVisible,
      notificationVisible,
      now,
      timeoutMs,
    })
  } finally {
    collapse()
  }
}

async function tapNotificationStop(context) {
  adbTry(context, ['shell', 'cmd', 'statusbar', 'collapse'])
  adbTry(context, ['shell', 'input', 'keyevent', 'WAKEUP'])
  adbTry(context, ['shell', 'wm', 'dismiss-keyguard'])
  adbRun(context, ['shell', 'cmd', 'statusbar', 'expand-notifications'])
  await sleep(750)
  let capture = captureUiAutomatorHierarchy(context)
  assertNotificationHierarchyAvailable(capture)
  let action = auroraNotificationNodeBounds(
    capture.hierarchy,
    {
      resourceId: 'android:id/action0',
      text: 'Stop',
    },
    context.appId,
  )
  // Decorated custom notifications expose actions below the expanded content.
  // Expand bounded notification rows until Aurora's real PendingIntent-backed
  // action is present instead of assuming SystemUI renders it while collapsed.
  for (let attempt = 0; !action && attempt < 6; attempt += 1) {
    const expand = auroraNotificationNodeBounds(
      capture.hierarchy,
      {
        resourceId: 'android:id/expand_button',
        contentDesc: 'Expand',
      },
      context.appId,
    )
    if (!expand) break
    adbRun(context, [
      'shell',
      'input',
      'tap',
      String(Math.round((expand.left + expand.right) / 2)),
      String(Math.round((expand.top + expand.bottom) / 2)),
    ])
    await sleep(750)
    capture = captureUiAutomatorHierarchy(context)
    assertNotificationHierarchyAvailable(capture)
    action = auroraNotificationNodeBounds(
      capture.hierarchy,
      {
        resourceId: 'android:id/action0',
        text: 'Stop',
      },
      context.appId,
    )
  }
  if (!action) {
    adbTry(context, ['shell', 'cmd', 'statusbar', 'collapse'])
    throw new Error('Aurora background voice notification did not expose its Stop action.')
  }
  adbRun(context, [
    'shell',
    'input',
    'tap',
    String(Math.round((action.left + action.right) / 2)),
    String(Math.round((action.top + action.bottom) / 2)),
  ])
  await sleep(500)
  adbRun(context, ['shell', 'cmd', 'statusbar', 'collapse'])
}

export function parseUiAutomatorCapture({ status, stdout = '', stderr = '', error = null }) {
  const captured = String(stdout)
  const hierarchy = captured.replace(/UI hierchary dumped to: \/dev\/tty\r?\n?$/u, '')
  const diagnostic = {
    exitCode: status,
    stdout: String(stdout),
    stderr: String(stderr),
    ...(error ? {
      error: {
        message: String(error.message ?? error),
        ...(error.code ? { code: String(error.code) } : {}),
      },
    } : {}),
  }
  if (status !== 0 || !/^\s*<\?xml[\s\S]*<hierarchy\b[\s\S]*<\/hierarchy>\s*$/u.test(hierarchy)) {
    return { ok: false, hierarchy: '', diagnostic }
  }
  return { ok: true, hierarchy, diagnostic }
}

function captureUiAutomatorHierarchy(context) {
  const result = spawnSync(
    context.adb,
    ['-s', context.serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
    { encoding: 'utf8' },
  )
  if (result.error) {
    return parseUiAutomatorCapture({
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    })
  }
  return parseUiAutomatorCapture({
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  })
}

function assertNotificationHierarchyAvailable(capture) {
  if (capture.ok) return
  throw new Error(`notification hierarchy unavailable: ${JSON.stringify(capture.diagnostic)}`)
}
export function auroraNotificationNodeBounds(hierarchy, attributes = {}, appId = DEFAULT_APP_ID) {
  const stack = []
  for (const match of String(hierarchy ?? '').matchAll(/<node\b[^>]*\/>|<node\b[^>]*>|<\/node>/gu)) {
    const token = match[0]
    if (token === '</node>') {
      const frame = stack.pop()
      if (!frame) continue
      if (frame.notificationRow && frame.hasAuroraContent && frame.targetBounds) {
        return frame.targetBounds
      }
      mergeNotificationFrame(stack.at(-1), frame)
      continue
    }

    const resourceId = xmlAttribute(token, 'resource-id')
    const frame = {
      notificationRow: resourceId?.endsWith(':id/expandableNotificationRow') === true,
      hasAuroraContent: (resourceId === 'android:id/app_name_text'
        && xmlAttribute(token, 'text') === 'Aurora')
        || resourceId?.startsWith(`${appId}:id/aurora_notification_`) === true,
      targetBounds: notificationNodeMatches(token, attributes)
        ? notificationNodeBounds(token)
        : undefined,
    }
    if (token.endsWith('/>')) {
      mergeNotificationFrame(stack.at(-1), frame)
    } else {
      stack.push(frame)
    }
  }
  return undefined
}

function mergeNotificationFrame(parent, child) {
  if (!parent) return
  parent.hasAuroraContent ||= child.hasAuroraContent
  parent.targetBounds ??= child.targetBounds
}

function notificationNodeMatches(node, attributes) {
  return (attributes.text === undefined || xmlAttribute(node, 'text') === attributes.text)
    && (attributes.resourceId === undefined || xmlAttribute(node, 'resource-id') === attributes.resourceId)
    && (attributes.contentDesc === undefined || xmlAttribute(node, 'content-desc') === attributes.contentDesc)
}

function notificationNodeBounds(node) {
  const bounds = xmlAttribute(node, 'bounds')?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u)
  if (!bounds) return undefined
  return {
    left: Number(bounds[1]),
    top: Number(bounds[2]),
    right: Number(bounds[3]),
    bottom: Number(bounds[4]),
  }
}

function xmlAttribute(node, name) {
  return node.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'u'))?.[1]
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

export async function injectLiveTestPcm(
  invoke,
  pcm,
  { backgroundBaseline, focusedBaseline } = {},
) {
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
      const status = backgroundBaseline || focusedBaseline
        ? await invoke('aurora_android_voice_foreground_service_status')
        : undefined
      if (backgroundPcmRejectionEndsInjection(result, status, backgroundBaseline, acceptedFrames)) {
        return status
      }
      if (focusedPcmRejectionEndsInjection(result, status, focusedBaseline, acceptedFrames)) {
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

export function focusedPcmRejectionEndsInjection(rejection, status, baseline, acceptedFrames) {
  if (rejection?.reason !== 'voice_session_not_accepting_audio' || acceptedFrames <= 0) return false
  if (Number(status?.acceptedSamples ?? 0) <= Number(baseline?.acceptedSamples ?? 0)) return false
  if (Number(status?.failedTurns ?? 0) !== Number(baseline?.failedTurns ?? 0)) return false
  if (status?.captureError) return false
  if (focusedTranscriptionCompleted(baseline, status)) return true
  const captureOwned = status?.running === true
    && status?.backgroundSessionActive !== true
    && status?.captureActive === true
    && status?.runtimeActive === true
  return captureOwned && ['processing', 'transcribing', 'stopping'].includes(status?.runtimePhase)
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

function serviceIsVisibleStrict(context) {
  return adbOutput(context, ['shell', 'dumpsys', 'activity', 'services', context.appId])
    .includes('AuroraRuntimeForegroundService')
}

function notificationIsVisible(context) {
  const output = adbOutput(context, ['shell', 'dumpsys', 'notification', '--noredact'], { allowFailure: true })
  return notificationIsVisibleFromDump(output, context.appId)
}

function notificationIsVisibleStrict(context) {
  return notificationIsVisibleFromDump(
    adbOutput(context, ['shell', 'dumpsys', 'notification', '--noredact']),
    context.appId,
  )
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
  adbRun(context, ['shell', 'pm', 'grant', '--user', 'current', context.appId, 'android.permission.RECORD_AUDIO'])
  const sdk = Number(adbOutput(context, ['shell', 'getprop', 'ro.build.version.sdk']).trim())
  if (sdk >= 33) {
    adbRun(context, ['shell', 'pm', 'grant', '--user', 'current', context.appId, 'android.permission.POST_NOTIFICATIONS'])
  }
}

function launchApp(context) {
  const activity = `${context.appId}/.MainActivity`
  adbRun(context, ['shell', 'am', 'start', '--user', 'current', '-W', '-n', activity])
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

function fixedFailureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (['EACCES', 'EEXIST', 'EISDIR', 'ENOENT', 'ENOTDIR', 'EPERM', 'ETIMEDOUT'].includes(code)) return code
  if (error instanceof AggregateError) return 'aggregate_failure'
  return 'operation_failed'
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
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      stage: 'cli',
      code: fixedFailureCode(error),
    }))
    process.exitCode = 1
  }
}
