import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { acquireAndroidSmokeLock } from './android-emulator-smoke-runner.mjs'
import { connectInstalledWebview, invokeTauri, parseAdbDevices, resolveAndroidDeviceSerial } from './android-voice-live-smoke.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_ID = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const EXPECTED_TEXT = process.env.AURORA_ANDROID_RECORDING_EXPECTED_TEXT ?? 'Aurora recording main flow'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_FEED_TIMEOUT_MS = 120_000
const MAX_FEED_TIMEOUT_MS = 300_000
const COMMAND_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 500
const REMOTE_UI_DUMP = `/sdcard/aurora-recording-ui-${process.pid}.xml`
const REPORT_PATH = resolve(
  SCRIPT_DIR,
  '../../../.omx/evidence/orca-recording-main-flow-20261010/latest.json',
)

export async function runAndroidRecordingMainFlow({ environment = process.env } = {}) {
  const audioSource = requiredEnvironment(environment, 'AURORA_ANDROID_RECORDING_AUDIO_SOURCE')
  const microphoneFeedArgv = requiredMicrophoneFeedArgv(environment)
  const serial = requiredEnvironment(environment, 'AURORA_ANDROID_DEVICE_SERIAL')
  const apk = resolve(requiredEnvironment(environment, 'AURORA_ANDROID_APK'))
  const expectedText = environment.AURORA_ANDROID_RECORDING_EXPECTED_TEXT?.trim() || EXPECTED_TEXT
  const expectedNormalized = normalizeText(expectedText)
  const timeoutMs = positiveInteger(environment.AURORA_ANDROID_RECORDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const feedTimeoutMs = Math.min(
    positiveInteger(environment.AURORA_ANDROID_RECORDING_FEED_TIMEOUT_MS, DEFAULT_FEED_TIMEOUT_MS),
    MAX_FEED_TIMEOUT_MS,
  )
  if (!expectedNormalized) throw new Error('missing_expected_transcript: set AURORA_ANDROID_RECORDING_EXPECTED_TEXT')
  if (!existsSync(apk)) throw new Error(`missing_packaged_apk: ${apk}`)

  const adb = resolveAdb(environment)
  const devicesOutput = commandOutput(adb, ['devices', '-l'])
  const actualSerial = resolveAndroidDeviceSerial(devicesOutput, serial)
  if (actualSerial !== serial) throw new Error(`android_serial_mismatch: requested=${serial}, resolved=${actualSerial}`)
  const selectedDevice = parseAdbDevices(devicesOutput).find((device) => device.serial === serial)
  if (!/waydroid/iu.test(selectedDevice?.line ?? '')) throw new Error(`android_device_not_waydroid: ${serial}`)

  const releaseLock = await acquireAndroidSmokeLock({
    lockPath: resolve(os.tmpdir(), `aurora-android-smoke-${serial.replace(/[^a-zA-Z0-9._-]/gu, '_')}.lock`),
    waitTimeoutMs: timeoutMs,
  })
  const context = { adb, serial, appId: APP_ID }
  let webview
  let originalPolicy
  let originalProfileId
  let scope
  let ownedSessionId
  let policyChanged = false
  let savedPolicyRevision
  let startedByHarness = false
  let report
  let primaryError

  try {
    console.log(`Android recording main flow uses ${serial}; microphone route: ${audioSource}`)
    commandRun(context, ['wait-for-device'], 60_000)
    context.currentUserId = readCurrentAndroidUser(context)
    installApk(context, apk)
    grantMicrophone(context)
    launchApp(context)
    webview = await connectSelectedUserWebview(context)
    let invoke = (command, args) => invokeTauri(webview.client, command, args)

    const initialProfile = parseStoredProfile(await invoke('aurora_thin_profile_get'))
    const activeProfile = initialProfile.profiles?.find((profile) => profile.id === initialProfile.activeProfileId)
    if (!activeProfile?.id || !activeProfile.localNode?.stablePeerId) {
      throw new Error('missing_active_local_profile: settings need a selected local node profile')
    }
    originalProfileId = activeProfile.id
    scope = { profileId: activeProfile.id, localNodeId: activeProfile.localNode.stablePeerId }

    originalPolicy = await readPolicy(invoke, webview.client)
    assertCurrentAndroidUser(context)
    await openSettings(webview.client)
    policyChanged = true
    assertCurrentAndroidUser(context)
    await setNotificationPolicyFromSettings(webview.client, timeoutMs)
    const enabledPolicy = await waitForPolicy(invoke, webview.client, (document) =>
      document.backgroundTranscription?.enabled === true
      && document.backgroundTranscription?.ambient === false
      && document.backgroundTranscription?.notification === true,
      timeoutMs,
    )
    savedPolicyRevision = enabledPolicy.revision

    assertCurrentAndroidUser(context)
    const synchronized = await invoke('aurora_android_background_transcription_sync')
    const readiness = await pollStatus(invoke, (status) => status.transcription?.permission === 'granted'
      && status.transcription?.sttAvailable === true
      && status.transcription?.archiveAvailable === true
      && status.notificationReady === true,
    'native_transcription_ready', timeoutMs)
    if (synchronized?.transcription && synchronized.transcription.notification !== true) {
      throw new Error(`native_policy_sync_missing_notification_mode: ${JSON.stringify(synchronized.transcription)}`)
    }
    if (readiness.transcription?.captureMode) {
      throw new Error(`recording_already_active: ${readiness.transcription.captureMode}`)
    }

    await openArchive(invoke, scope)
    const sessionsBefore = await listSessions(invoke, scope)
    if (sessionsBefore.some((session) => session.lifecycle === 'active')) {
      throw new Error('active_transcript_exists_before_start: refusing to overlap an existing capture')
    }
    const sessionIdsBefore = new Set(sessionsBefore.map((session) => session.id))
    const sessionStartedAt = Date.now()

    await tapNotificationAction(context, 'Start transcription')
    startedByHarness = true
    const recordingStatus = await pollStatus(invoke, (status) =>
      status.transcription?.captureMode === 'notification'
      && ['starting', 'listening', 'transcribing'].includes(status.transcription?.state),
    'notification_transcription_start', timeoutMs)

    const activeSession = await pollForOwnedSession(invoke, scope, sessionIdsBefore, sessionStartedAt, timeoutMs)
    ownedSessionId = activeSession.id
    assertCurrentAndroidUser(context)
    commandRun(context, ['shell', 'input', 'keyevent', 'HOME'], 10_000)
    await runMicrophoneFeed(microphoneFeedArgv, feedTimeoutMs)

    await tapNotificationAction(context, 'Stop')
    const stoppedStatus = await pollStatus(invoke, (status) =>
      status.transcription?.captureMode == null
      && status.transcription?.state === 'completed'
      && status.transcription?.foreground === false,
    'notification_transcription_stop', timeoutMs)
    startedByHarness = false

    webview.close()
    webview = null
    assertCurrentAndroidUser(context)
    commandRun(context, ['shell', 'am', 'force-stop', '--user', context.currentUserId, APP_ID], 30_000)
    launchApp(context)
    webview = await connectSelectedUserWebview(context)
    invoke = (command, args) => invokeTauri(webview.client, command, args)

    const reopenedProfile = parseStoredProfile(await invoke('aurora_thin_profile_get'))
    const reopenedActiveProfile = reopenedProfile.profiles?.find((profile) => profile.id === reopenedProfile.activeProfileId)
    if (reopenedActiveProfile?.id !== originalProfileId
      || reopenedActiveProfile?.localNode?.stablePeerId !== scope.localNodeId) {
      throw new Error('active_profile_changed_during_recording: refusing cross-profile cleanup')
    }

    await openArchive(invoke, scope)
    const persisted = await readAndVerifyTranscript(invoke, scope, ownedSessionId, expectedNormalized)
    assertCurrentAndroidUser(context)
    await deleteOwnedSession(invoke, scope, ownedSessionId)
    ownedSessionId = undefined

    if (policyChanged) {
      assertCurrentAndroidUser(context)
      await assertOriginalProfile(invoke, originalProfileId, scope)
      await restorePolicy(invoke, webview.client, originalPolicy.document.backgroundTranscription)
      policyChanged = false
    }
    const finalStatus = await pollStatus(invoke, (status) =>
      status.transcription?.captureMode == null && status.transcription?.foreground === false,
    'recording_cleanup', timeoutMs)

    report = {
      outcome: 'succeeded',
      deviceSerial: serial,
      appId: APP_ID,
      apkPath: apk,
      audioSource,
      activeProfileId: scope.profileId,
      localNodeId: scope.localNodeId,
      savedPolicyRevision,
      recordingState: recordingStatus.transcription.state,
      stoppedState: stoppedStatus.transcription.state,
      reopenedSessionLifecycle: persisted.lifecycle,
      reopenedTranscriptMatched: true,
      encryptedEnvelopePresent: persisted.encryptedEnvelopePresent,
      ownedCaptureDeleted: true,
      policyRestored: true,
      finalCaptureMode: finalStatus.transcription.captureMode ?? null,
      completedAt: new Date().toISOString(),
    }
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = []
    try {
      if (startedByHarness && webview) {
        const invoke = (command, args) => invokeTauri(webview.client, command, args)
        await tapNotificationAction(context, 'Stop').catch(() => {})
        await pollStatus(invoke, (status) => status.transcription?.captureMode == null, 'capture_cleanup', 15_000)
      }
    } catch (error) {
      cleanupErrors.push(`stop capture: ${errorMessage(error)}`)
    }
    try {
      if (webview && ownedSessionId && scope) {
        assertCurrentAndroidUser(context)
        const invoke = (command, args) => invokeTauri(webview.client, command, args)
        await openArchive(invoke, scope)
        await deleteOwnedSession(invoke, scope, ownedSessionId)
        ownedSessionId = undefined
      }
    } catch (error) {
      cleanupErrors.push(`delete owned capture: ${errorMessage(error)}`)
    }
    try {
      if (webview && policyChanged && originalPolicy) {
        assertCurrentAndroidUser(context)
        const invoke = (command, args) => invokeTauri(webview.client, command, args)
        await assertOriginalProfile(invoke, originalProfileId, scope)
        await restorePolicy(invoke, webview.client, originalPolicy.document.backgroundTranscription)
        policyChanged = false
      }
    } catch (error) {
      cleanupErrors.push(`restore saved policy: ${errorMessage(error)}`)
    }
    try {
      commandRun(context, ['shell', 'rm', '-f', REMOTE_UI_DUMP], 10_000)
    } catch (error) {
      cleanupErrors.push(`remove owned UI dump: ${errorMessage(error)}`)
    }
    webview?.close()
    releaseLock()
    if (cleanupErrors.length) {
      primaryError = new Error(`${primaryError ? `${errorMessage(primaryError)}; ` : ''}cleanup incomplete: ${cleanupErrors.join('; ')}`)
    }
  }

  if (primaryError) {
    await writeReport({
      outcome: 'failed',
      deviceSerial: serial,
      audioSource,
      failure: errorMessage(primaryError),
      completedAt: new Date().toISOString(),
    })
    throw primaryError
  }
  await writeReport(report)
  console.log(JSON.stringify(report, null, 2))
  return report
}

async function openSettings(client) {
  await evaluate(client, "(() => { window.history.pushState({}, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); return true })()")
  await pollPage(client, "Boolean(document.querySelector('#background-transcription-notification'))", 'settings_transcription_controls')
}

async function setNotificationPolicyFromSettings(client, timeoutMs) {
  await setSettingsCheckbox(client, '#background-transcription-ambient', false, timeoutMs)
  await setSettingsCheckbox(client, '#background-transcription-notification', true, timeoutMs)
  const saved = await evaluate(client, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Save choices');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`)
  if (saved !== true) throw new Error('settings_save_choices_unavailable')
}

async function setSettingsCheckbox(client, selector, desired, timeoutMs) {
  const initial = await readSettingsCheckbox(client, selector)
  if (initial == null) throw new Error(`settings_checkbox_unavailable: ${selector}`)
  if (initial !== desired) {
    const clicked = await evaluate(client, `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.click();
      return true;
    })()`)
    if (clicked !== true) throw new Error(`settings_checkbox_click_unavailable: ${selector}`)
  }
  await poll(async () => {
    const checked = await readSettingsCheckbox(client, selector)
    return checked === desired ? checked : null
  }, `settings_checkbox_state:${selector}:${desired}`, timeoutMs)
}

async function readSettingsCheckbox(client, selector) {
  return await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const ariaChecked = element.getAttribute('aria-checked');
    if (ariaChecked === 'true' || ariaChecked === 'false') return ariaChecked === 'true';
    return typeof element.checked === 'boolean' ? element.checked : null;
  })()`)
}

async function readPolicy(invoke, client) {
  const token = await evaluate(client, 'window.__AURORA_NODE_CONFIG_DOCUMENT_TOKEN__ ?? null')
  if (typeof token !== 'string' || token.length !== 64) throw new Error('native_node_config_document_token_unavailable')
  const receipt = await invoke('aurora_node_config_policy_read', { documentToken: token })
  if (typeof receipt?.documentJson !== 'string' || typeof receipt?.draftHandle !== 'string') {
    throw new Error('native_node_config_policy_read_invalid')
  }
  return { document: JSON.parse(receipt.documentJson), draftHandle: receipt.draftHandle, documentToken: token }
}

async function waitForPolicy(invoke, client, predicate, timeoutMs) {
  return await poll(async () => {
    const receipt = await readPolicy(invoke, client)
    return predicate(receipt.document) ? receipt.document : null
  }, 'settings_policy_save', timeoutMs)
}

async function restorePolicy(invoke, client, backgroundTranscription) {
  const receipt = await readPolicy(invoke, client)
  if (samePolicy(receipt.document.backgroundTranscription, backgroundTranscription)) return
  const draft = {
    ...receipt.document,
    revision: receipt.document.revision + 1,
    updatedAtMs: Date.now(),
    backgroundTranscription,
  }
  const response = await invoke('aurora_node_config_policy_compare_and_swap', {
    documentToken: receipt.documentToken,
    draftHandle: receipt.draftHandle,
    expectedRevision: receipt.document.revision,
    draftJson: JSON.stringify(draft),
  })
  if (response?.savedRevision !== draft.revision) throw new Error('native_policy_restore_cas_not_confirmed')
  await invoke('aurora_android_background_transcription_sync')
}

async function assertOriginalProfile(invoke, profileId, scope) {
  const profile = parseStoredProfile(await invoke('aurora_thin_profile_get'))
  const active = profile.profiles?.find((item) => item.id === profile.activeProfileId)
  if (active?.id !== profileId || active?.localNode?.stablePeerId !== scope.localNodeId) {
    throw new Error('active_profile_changed_during_recording: policy restoration skipped')
  }
}

async function pollStatus(invoke, predicate, label, timeoutMs) {
  return await poll(async () => {
    const status = await invoke('aurora_android_voice_foreground_service_status')
    return predicate(status) ? status : null
  }, label, timeoutMs)
}

async function openArchive(invoke, scope) {
  await invoke('aurora_local_data_open', { request: scope })
}

async function listSessions(invoke, scope) {
  const value = await repositoryOperation(invoke, {
    kind: 'transcripts.listSessions',
    ...scope,
    options: { limit: 500 },
  })
  if (!Array.isArray(value)) throw new Error('transcript_session_list_invalid')
  return value
}

async function pollForOwnedSession(invoke, scope, previousIds, startedAt, timeoutMs) {
  return await poll(async () => {
    const sessions = await listSessions(invoke, scope)
    const candidates = sessions.filter((session) => !previousIds.has(session.id)
      && session.captureMode === 'notification'
      && session.profileId === scope.profileId
      && session.localNodeId === scope.localNodeId
      && session.createdAtMs >= startedAt)
    if (candidates.length > 1) throw new Error('multiple_new_notification_sessions: refusing ambiguous cleanup')
    return candidates[0] ?? null
  }, 'owned_notification_session', timeoutMs)
}

async function readAndVerifyTranscript(invoke, scope, sessionId, expectedNormalized) {
  const sessions = await listSessions(invoke, scope)
  const session = sessions.find((item) => item.id === sessionId)
  if (!session || session.profileId !== scope.profileId || session.localNodeId !== scope.localNodeId
    || session.captureMode !== 'notification' || session.lifecycle !== 'completed') {
    throw new Error('reopened_transcript_session_not_completed_in_active_profile')
  }
  const segments = await repositoryOperation(invoke, {
    kind: 'transcripts.listSegments',
    ...scope,
    sessionId,
    options: { limit: 1000 },
  })
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('reopened_transcript_segments_missing')
  const plaintext = []
  for (const segment of segments) {
    if (!segment?.textEnvelope?.ciphertextAndTagB64Url) throw new Error('transcript_ciphertext_missing')
    const aad = Buffer.from(JSON.stringify({
      envelopeVersion: 1,
      field: 'text_envelope_json',
      localNodeId: scope.localNodeId,
      profileId: scope.profileId,
      recordId: segment.id,
      table: 'aurora_transcript_segments',
    })).toString('base64url')
    const decrypted = await invoke('aurora_local_data_envelope_decrypt', {
      request: {
        profileId: scope.profileId,
        localNodeId: scope.localNodeId,
        envelope: segment.textEnvelope,
        aadB64Url: aad,
      },
    })
    if (typeof decrypted?.plaintextB64Url !== 'string') throw new Error('transcript_decryption_response_invalid')
    plaintext.push(Buffer.from(decrypted.plaintextB64Url, 'base64url').toString('utf8'))
  }
  if (!normalizeText(plaintext.join(' ')).includes(expectedNormalized)) {
    throw new Error('reopened_transcript_did_not_match_spoken_phrase')
  }
  return {
    lifecycle: session.lifecycle,
    encryptedEnvelopePresent: true,
    segmentCount: segments.length,
  }
}

async function deleteOwnedSession(invoke, scope, sessionId) {
  const result = await repositoryOperation(invoke, {
    kind: 'transcripts.deleteSession',
    ...scope,
    sessionId,
  })
  if (result?.deleted !== true) throw new Error('owned_transcript_cleanup_not_confirmed')
}

async function repositoryOperation(invoke, operation) {
  return await invoke('aurora_local_data_repository_operation', { request: { operation } })
}

async function tapNotificationAction(context, label) {
  assertCurrentAndroidUser(context)
  await commandTry(context, ['shell', 'cmd', 'statusbar', 'collapse'])
  await commandTry(context, ['shell', 'input', 'keyevent', 'WAKEUP'])
  await commandTry(context, ['shell', 'wm', 'dismiss-keyguard'])
  commandRun(context, ['shell', 'cmd', 'statusbar', 'expand-notifications'], 10_000)
  const deadline = Date.now() + 10_000
  let bounds
  while (Date.now() < deadline && !bounds) {
    const xml = captureUiHierarchy(context)
    bounds = findNotificationAction(xml, label)
    if (!bounds) {
      const expand = findNotificationExpand(xml)
      if (expand) {
        commandRun(context, [
          'shell', 'input', 'tap',
          String(Math.round((expand.left + expand.right) / 2)),
          String(Math.round((expand.top + expand.bottom) / 2)),
        ], 10_000)
        await sleep(500)
      } else {
        await sleep(500)
      }
    }
  }
  if (!bounds) throw new Error(`notification_action_unavailable: ${label}`)
  commandRun(context, [
    'shell', 'input', 'tap',
    String(Math.round((bounds.left + bounds.right) / 2)),
    String(Math.round((bounds.top + bounds.bottom) / 2)),
  ], 10_000)
  await commandTry(context, ['shell', 'cmd', 'statusbar', 'collapse'])
}

function captureUiHierarchy(context) {
  commandRun(context, ['shell', 'uiautomator', 'dump', REMOTE_UI_DUMP], 15_000)
  const xml = commandOutput(context.adb, ['-s', context.serial, 'exec-out', 'cat', REMOTE_UI_DUMP])
  if (!xml.includes('<hierarchy')) throw new Error('notification_ui_hierarchy_unavailable')
  return xml
}

function findNotificationAction(xml, label) {
  for (const [, attributes] of xml.matchAll(/<node\b([^>]*)\/>/gu)) {
    const node = parseXmlAttributes(attributes)
    if (node['resource-id'] !== 'android:id/action0' || node.text !== label) continue
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(node.bounds ?? '')
    if (!match) continue
    return { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) }
  }
  return null
}

function findNotificationExpand(xml) {
  for (const [, attributes] of xml.matchAll(/<node\b([^>]*)\/>/gu)) {
    const node = parseXmlAttributes(attributes)
    if (node['resource-id'] !== 'android:id/expand_button' && node['content-desc'] !== 'Expand') continue
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(node.bounds ?? '')
    if (!match) continue
    return { left: Number(match[1]), top: Number(match[2]), right: Number(match[3]), bottom: Number(match[4]) }
  }
  return null
}

function parseXmlAttributes(value) {
  return Object.fromEntries([...value.matchAll(/([\w:-]+)="([^"]*)"/gu)].map((match) => [match[1], decodeXml(match[2])]))
}

function decodeXml(value) {
  return value.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')
}

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => { try { return JSON.stringify({ value: (${expression}) }) } catch (error) { return JSON.stringify({ error: String(error) }) } })()`,
    returnByValue: true,
    awaitPromise: true,
  }, COMMAND_TIMEOUT_MS)
  const raw = response.result?.result?.value
  if (typeof raw !== 'string') throw new Error('webview_evaluation_return_missing')
  const parsed = JSON.parse(raw)
  if (parsed.error) throw new Error(`webview_evaluation_failed: ${parsed.error}`)
  return parsed.value
}

async function pollPage(client, predicateExpression, label) {
  const deadline = Date.now() + positiveInteger(process.env.AURORA_ANDROID_WEBVIEW_TIMEOUT_MS, 180_000)
  while (Date.now() < deadline) {
    if (await evaluate(client, predicateExpression)) return
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`webview_prerequisite_timeout: ${label}`)
}

async function poll(operation, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await operation()
    if (value != null) return value
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error(`main_flow_timeout: ${label}`)
}

async function runMicrophoneFeed(argv, timeoutMs) {
  const [command, ...args] = argv
  await new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = [stderr, stdout].filter(Boolean).join('\n').trim()
        const reason = error.code === 'ETIMEDOUT' || error.killed
          ? `timed out after ${timeoutMs}ms`
          : detail || errorMessage(error)
        reject(new Error(`microphone_feed_failed: ${command}: ${reason}`))
        return
      }
      resolvePromise()
    })
  })
}

function installApk(context, apk) {
  assertCurrentAndroidUser(context)
  commandRun(context, ['install', '-r', '--user', context.currentUserId, apk], 10 * 60_000)
}

function grantMicrophone(context) {
  assertCurrentAndroidUser(context)
  commandRun(context, ['shell', 'pm', 'grant', '--user', context.currentUserId, APP_ID, 'android.permission.RECORD_AUDIO'], 15_000)
  assertCurrentAndroidUser(context)
  commandTry(context, ['shell', 'pm', 'grant', '--user', context.currentUserId, APP_ID, 'android.permission.POST_NOTIFICATIONS'])
}

function launchApp(context) {
  assertCurrentAndroidUser(context)
  commandRun(context, ['shell', 'am', 'start', '--user', context.currentUserId, '-W', '-n', `${context.appId}/.MainActivity`], 30_000)
}

function readCurrentAndroidUser(context) {
  const value = commandRun(context, ['shell', 'am', 'get-current-user']).trim()
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('android_current_user_unavailable')
  return value
}

function assertCurrentAndroidUser(context) {
  const currentUserId = readCurrentAndroidUser(context)
  if (currentUserId !== context.currentUserId) throw new Error('android_current_user_changed')
}

async function connectSelectedUserWebview(context) {
  const webview = await connectInstalledWebview(context)
  try {
    assertWebviewOwnedByCurrentUser(context, webview)
    return webview
  } catch {
    try { webview.close() } catch { /* Best-effort close before failing closed. */ }
    throw new Error('android_webview_user_owner_unconfirmed')
  }
}

function assertWebviewOwnedByCurrentUser(context, webview) {
  assertCurrentAndroidUser(context)
  if (typeof webview?.pid !== 'string' || !/^[1-9]\d*$/u.test(webview.pid)) {
    throw new Error('webview_pid_unavailable')
  }
  // Match the kernel-reported WebView process UID to PackageManager's UID
  // for this exact package and selected Android user; do not infer user ids.
  const packageRows = commandRun(context, [
    'shell', 'pm', 'list', 'packages', '-U', '--user', context.currentUserId, context.appId,
  ]).split(/\r?\n/u).filter((line) => line.trim().startsWith(`package:${context.appId} `))
  if (packageRows.length !== 1) throw new Error('selected_user_package_uid_ambiguous')
  const packageMatch = /^package:(\S+)\s+uid:(\d+)$/u.exec(packageRows[0].trim())
  if (!packageMatch || packageMatch[1] !== context.appId) throw new Error('selected_user_package_uid_unavailable')

  const processStatus = commandRun(context, ['shell', 'cat', `/proc/${webview.pid}/status`])
  const uidLine = processStatus.split(/\r?\n/u).find((line) => /^Uid:\s/u.test(line))
  const processUids = uidLine?.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/u)
  if (!processUids || processUids.slice(1).some((uid) => uid !== packageMatch[2])) {
    throw new Error('webview_process_uid_mismatch')
  }
  assertCurrentAndroidUser(context)
}

function commandRun(context, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return runCommand(context.adb, ['-s', context.serial, ...args], timeoutMs)
}

function commandTry(context, args) {
  try { return { ok: true, output: commandRun(context, args) } }
  catch (error) { return { ok: false, output: errorMessage(error) } }
}

function commandOutput(command, args) {
  return runCommand(command, args, COMMAND_TIMEOUT_MS)
}

function runCommand(command, args, timeoutMs) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`command_failed: ${command} ${args.join(' ')}: ${output || errorMessage(error)}`)
  }
}

function resolveAdb(environment) {
  const candidates = [environment.ADB, environment.ANDROID_HOME && `${environment.ANDROID_HOME}/platform-tools/adb`, environment.ANDROID_SDK_ROOT && `${environment.ANDROID_SDK_ROOT}/platform-tools/adb`, 'adb'].filter(Boolean)
  for (const candidate of candidates) {
    try { execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 5_000 }); return candidate }
    catch { /* check the next configured executable */ }
  }
  throw new Error('missing_adb: install Android platform tools or set ADB')
}

function parseStoredProfile(value) {
  const raw = typeof value?.value === 'string' ? value.value : value
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw && typeof raw === 'object' ? raw : {}
}

function samePolicy(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim()
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`missing_prerequisite: set ${name} to a confirmed value before using the Waydroid microphone flow`)
  return value
}

function requiredMicrophoneFeedArgv(environment) {
  const name = 'AURORA_ANDROID_RECORDING_MIC_FEED_ARGV'
  const value = environment[name]?.trim()
  if (!value) throw new Error(`missing_prerequisite: set ${name} to a JSON argv array for a real microphone feed`)
  let argv
  try { argv = JSON.parse(value) }
  catch { throw new Error(`invalid_prerequisite: ${name} must be a JSON argv array of strings`) }
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((part) => typeof part !== 'string') || !argv[0].trim()) {
    throw new Error(`invalid_prerequisite: ${name} must be a non-empty JSON argv array with an executable first`)
  }
  return argv
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function writeReport(value) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true })
  writeFileSync(REPORT_PATH, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  try {
    await runAndroidRecordingMainFlow()
  } catch (error) {
    console.error(errorMessage(error))
    process.exitCode = 1
  }
}
