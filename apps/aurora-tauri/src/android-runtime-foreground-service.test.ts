import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { findForbiddenProductionCopyTerms } from '../../../packages/aurora-ui/src/product-copy-forbidden-terms'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const servicePath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt'
const pluginPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'
const canonicalManifestPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml'
const notificationIconPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/res/drawable/ic_aurora_notification.xml'
const manifestMergePath = 'apps/aurora-tauri/scripts/install-android-native-plugin.mjs'
const preflightPath = 'apps/aurora-tauri/scripts/android-preflight.mjs'

function repoText(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start, `missing anchor: ${from}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(to, start + from.length)
  expect(end, `missing anchor: ${to}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/**
 * Notification copy the user reads in the shade. Extracted from the Kotlin so
 * the copy contract is checked against what actually ships, not a duplicate.
 */
function shadeCopy(service: string): string[] {
  const literals: string[] = []
  const textBody = sliceBetween(
    service,
    'private fun notificationTextFor(',
    'private fun enterForeground(',
  )
  for (const match of textBody.matchAll(/"([^"\n]+)"/gu)) {
    literals.push(match[1])
  }
  const notification = sliceBetween(
    service,
    'private fun foregroundNotification(',
    'private fun backgroundSessionRequested()',
  )
  for (const match of notification.matchAll(/\.setContentTitle\("([^"]+)"\)/gu)) {
    literals.push(match[1])
  }
  const channel = sliceBetween(
    service,
    'private fun ensureNotificationChannel()',
    'private fun foregroundNotification(',
  )
  for (const match of channel.matchAll(/"([^"\n]+)"/gu)) {
    if (match[1] !== 'aurora_voice_capture') literals.push(match[1])
  }
  return literals.filter((value) => value.length > 0)
}

describe('one Aurora in the notification shade', () => {
  it('keeps microphone PCM flowing while the native engine waits for the wake phrase', () => {
    const service = repoText(servicePath)
    const inputGate = sliceBetween(
      service,
      'private fun voiceRuntimeAcceptsMicrophoneInput(',
      '/** JNI handle for the bounded Rust-owned PCM ingress queue. */',
    )

    expect(inputGate).toContain('1L, 2L, 7L -> true')
  })

  it('keeps a single reference-counted foreground service for voice and connected devices', () => {
    const service = repoText(servicePath)

    // One service class, one notification id, one channel.
    expect(service).toContain('class AuroraRuntimeForegroundService : Service()')
    expect(service.match(/: Service\(\)/gu)?.length ?? 0).toBe(1)
    expect(service.match(/private const val AURORA_RUNTIME_NOTIFICATION_ID = \d+/gu)?.length ?? 0).toBe(1)
    expect(service.match(/startForeground\(/gu)?.length ?? 0).toBe(3)
    expect(
      sliceBetween(service, 'private fun enterForeground(', 'private fun foregroundServiceTypes('),
    ).toContain('startForeground(')

    // The reasons are reference counted, clamped, and serialised.
    expect(service).toContain('enum class AuroraRuntimeForegroundReason(val id: String)')
    expect(service).toContain('VOICE("voice")')
    expect(service).toContain('DEVICE_LINK("device_link")')
    const ledger = sliceBetween(
      service,
      'object AuroraRuntimeForegroundLedger {',
      'class AuroraRuntimeForegroundService',
    )
    for (const mutator of ['fun acquire(', 'fun acquireOnce(', 'fun release(', 'fun clear(', 'fun activeReasons(']) {
      const body = ledger.slice(ledger.indexOf(mutator))
      expect(body.slice(0, body.indexOf('\n\n')), mutator).toContain('synchronized(guard)')
    }
    expect(ledger).toContain('if (next <= 0)')
    expect(ledger).not.toContain('counts[reason] = next - 1')
  })

  it('starts on the first reason and stops only after the last one is released', () => {
    const service = repoText(servicePath)

    const onStart = sliceBetween(
      service,
      'override fun onStartCommand',
      'private fun isBackgroundVoiceSessionAvailable',
    )
    expect(onStart).toContain('AuroraRuntimeForegroundLedger.acquireOnce(AuroraRuntimeForegroundReason.VOICE)')
    expect(onStart).toContain('if (intent?.action == ACTION_SYNC_REASONS)')

    const sync = sliceBetween(service, 'private fun syncForegroundReasons(', 'private fun ensureNotificationChannel()')
    expect(sync).toContain('val reasons = AuroraRuntimeForegroundLedger.activeReasons()')
    expect(sync).toContain('if (reasons.isNotEmpty())')
    expect(sync).toContain('enterForeground(')
    expect(sync).toContain('stopForegroundAndRemoveNotification()')
    expect(sync).toContain('if (startId == null) stopSelf() else stopSelfResult(startId)')
    // A held device connection must never be torn down by voice teardown racing it.
    expect(sync.indexOf('if (reasons.isNotEmpty())')).toBeLessThan(sync.indexOf('stopSelf()'))

    // Voice ending releases only its own reason.
    const terminal = sliceBetween(
      service,
      'private fun stopAfterTerminalFailure',
      'private fun stopForegroundAndRemoveNotification',
    )
    expect(terminal).toContain('AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.VOICE)')
    expect(terminal).toContain('if (remaining.isNotEmpty())')
    expect(terminal.indexOf('if (remaining.isNotEmpty())')).toBeLessThan(terminal.indexOf('stopForegroundAndRemoveNotification()'))
    expect(terminal.indexOf('return')).toBeLessThan(terminal.indexOf('stopForegroundAndRemoveNotification()'))

    // The device-link holds are balanced and drive the same one service.
    const hold = sliceBetween(service, 'fun holdDeviceLink(context: Context)', 'fun releaseDeviceLink(')
    expect(hold).toContain('AuroraRuntimeForegroundLedger.acquire(AuroraRuntimeForegroundReason.DEVICE_LINK)')
    expect(hold).toContain('AuroraRuntimeForegroundService::class.java')
    expect(hold).toContain('context.startForegroundService(intent)')
    const release = sliceBetween(service, 'fun releaseDeviceLink(context: Context)', 'fun activeForegroundReasonIds()')
    expect(release).toContain('AuroraRuntimeForegroundLedger.release(AuroraRuntimeForegroundReason.DEVICE_LINK)')
    expect(release).toContain('if (!running) return')
  })

  it('restarts an assistant invocation after the previous native turn finishes tearing down', () => {
    const service = repoText(servicePath)
    const plugin = repoText(pluginPath)
    const onStart = sliceBetween(
      service,
      'override fun onStartCommand',
      'private fun isBackgroundVoiceSessionAvailable',
    )
    const pendingStart = sliceBetween(
      service,
      'private fun resumePendingAssistantStart()',
      'private fun isBackgroundVoiceSessionAvailable',
    )
    const attach = sliceBetween(
      service,
      'private fun attachNativeVoiceSession(',
      'private fun invalidateNativeVoiceInitialization()',
    )
    const initialize = sliceBetween(
      service,
      'private fun beginNativeVoiceInitialization(',
      'private fun createNativeVoiceSession(',
    )
    const completeInitialization = sliceBetween(
      service,
      'private fun completeNativeVoiceInitialization()',
      'override fun onDestroy()',
    )
    const finish = sliceBetween(
      service,
      'private fun finishNativeSession()',
      'private fun handleFinishedSessionStats(',
    )
    const handleFinished = sliceBetween(
      service,
      'private fun handleFinishedSessionStats(',
      'private fun rearmBackgroundSession(',
    )
    const destroy = sliceBetween(service, 'override fun onDestroy()', 'override fun onBind(')
    const terminal = sliceBetween(
      service,
      'private fun stopAfterTerminalFailure',
      'private fun stopForegroundAndRemoveNotification',
    )

    expect(onStart).toContain('if (intent?.action == ACTION_START_ASSISTANT)')
    expect(onStart).toContain('pendingAssistantStartId = startId')
    expect(onStart).toContain('invalidateNativeVoiceInitialization()')
    expect(onStart).toContain('releaseNativeVoiceResourcesAsync()')
    expect(onStart).toContain('resumePendingAssistantStart()')
    expect(pendingStart).toContain('if (capture != null || session != null || initializationInFlight.get()) return')
    expect(pendingStart).toContain('pendingAssistantStartId = null')
    expect(pendingStart).toContain('startNativeVoiceSession(')
    expect(initialize).toContain('if (destroyed || generation != initializationGeneration)')
    expect(initialize).toContain('completeNativeVoiceInitialization()')
    expect(initialize).not.toContain('initializationInFlight.set(false)\n                return@Runnable')
    expect(attach).toContain('completeNativeVoiceInitialization()')
    expect(completeInitialization).toContain('initializationInFlight.set(false)')
    expect(completeInitialization).toContain('finishHandler.post { resumePendingAssistantStart() }')
    expect(finish).toContain('if (session !== nativeSession)')
    expect(finish).toContain('resumePendingAssistantStart()')
    expect(finish).toContain('awaitFinishedSession(nativeSession)')
    expect(finish).toContain('if (session !== nativeSession) {')
    expect(handleFinished).toContain(
      'finishHandler.postDelayed({ awaitFinishedSession(nativeSession) }, 100L)',
    )
    expect(destroy).toContain('pendingAssistantStartId = null')
    expect(terminal).toContain('pendingAssistantStartId = null')
    const startCommand = sliceBetween(
      plugin,
      'fun startVoiceForegroundService(invoke: Invoke)',
      'fun injectVoicePcmForLiveTest(invoke: Invoke)',
    )
    expect(startCommand).toContain(
      'else action = AuroraRuntimeForegroundService.ACTION_START_ASSISTANT',
    )
  })

  it('yields durable wake listening to focused push-to-talk and restores it afterwards', () => {
    const service = repoText(servicePath)
    const onStart = sliceBetween(
      service,
      'override fun onStartCommand',
      'private fun isBackgroundVoiceSessionAvailable',
    )
    const finish = sliceBetween(
      service,
      'private fun finishNativeSession()',
      'private fun awaitFinishedSession()',
    )
    const terminal = sliceBetween(
      service,
      'private fun stopAfterTerminalFailure',
      'private fun stopForegroundAndRemoveNotification',
    )

    expect(service).toContain('private var resumeBackgroundAfterFocusedTurn = false')
    expect(onStart).toContain('if (backgroundSessionActive && backgroundSessionRequested())')
    expect(onStart).toContain('resumeBackgroundAfterFocusedTurn = true')
    expect(finish).toContain('if (!resumeBackgroundAfterFocusedTurn)')
    expect(terminal).toContain('restartDurableBackgroundAfterFocusedTurn()')
    expect(service).toContain('action = ACTION_START_BACKGROUND')
  })

  it('publishes focused transcription before closing capture and starts the next session fresh', () => {
    const service = repoText(servicePath)
    const finish = sliceBetween(
      service,
      'private fun finishNativeSession()',
      'private fun awaitFinishedSession()',
    )
    const start = sliceBetween(
      service,
      'private fun startNativeVoiceSession(',
      'private fun resumePendingAssistantStart()',
    )

    expect(finish).toContain('capture = null')
    expect(finish).toContain('runtimeActive = true')
    expect(finish).toContain('runtimePhase = "processing"')
    expect(finish).toContain('updateNotification(captureSnapshot)')
    expect(finish.indexOf('capture = null')).toBeLessThan(
      finish.indexOf('updateNotification(captureSnapshot)'),
    )
    expect(finish.indexOf('updateNotification(captureSnapshot)')).toBeLessThan(
      finish.indexOf('nativeLifecycleExecutor.execute'),
    )
    expect(start).toContain('lastNotificationFingerprint.set(null)')
    expect(start.indexOf('lastNotificationFingerprint.set(null)')).toBeLessThan(
      start.indexOf('beginNativeVoiceInitialization('),
    )
  })

  it('declares both foreground service types and claims only the ones it may', () => {
    const canonicalManifest = repoText(canonicalManifestPath)
    const merge = repoText(manifestMergePath)
    const preflight = repoText(preflightPath)
    const service = repoText(servicePath)

    for (const source of [canonicalManifest, merge]) {
      expect(source).toContain('android.permission.FOREGROUND_SERVICE_MICROPHONE')
      expect(source).toContain('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE')
      expect(source).toContain('android.permission.CHANGE_NETWORK_STATE')
      expect(source).toContain('android:foregroundServiceType="microphone|connectedDevice"')
      expect(source).toContain('dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService')
    }
    expect(preflight).toContain('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE')
    expect(preflight).toContain('android.permission.CHANGE_NETWORK_STATE')
    // dataSync is deliberately not used: connectedDevice carries the right
    // meaning and is outside the Android 15 daily budget.
    expect(canonicalManifest).not.toContain('dataSync')
    expect(merge).not.toContain('dataSync')

    const types = sliceBetween(service, 'private fun foregroundServiceTypes(', 'private fun syncForegroundReasons(')
    expect(types).toContain('Build.VERSION.SDK_INT < Build.VERSION_CODES.Q')
    expect(types).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE')
    expect(types).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE')
    // The microphone type is claimed only once its permission is granted, so a
    // connected-device-only run never trips the Android 14 type check.
    expect(types).toContain('checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED')
    expect(types).toContain('if (types == 0) types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE')

    const enterForeground = sliceBetween(service, 'private fun enterForeground(', 'private fun foregroundServiceTypes(')
    expect(enterForeground).toContain('catch (error: SecurityException)')
    expect(enterForeground).toContain('AuroraRuntimeForegroundLedger.clear(AuroraRuntimeForegroundReason.DEVICE_LINK)')
    expect(enterForeground).toContain('ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE')
  })

  it('degrades visibly when notifications are denied without ending a session', () => {
    const service = repoText(servicePath)
    const plugin = repoText(pluginPath)

    expect(service).toContain('var notificationsSuppressed: Boolean = false')
    const update = sliceBetween(service, 'private fun updateNotification(', 'private fun notificationTextFor(')
    expect(update).toContain('notificationsSuppressed = !canPostNotifications()')
    expect(update).toContain('if (notificationsSuppressed) {')
    expect(update).toContain('lastNotificationFingerprint.set(null)')
    expect(update.indexOf('notificationsSuppressed = !canPostNotifications()')).toBeLessThan(
      update.indexOf('lastNotificationFingerprint.get() == fingerprint'),
    )
    expect(update.indexOf('manager.notify(')).toBeLessThan(
      update.lastIndexOf('lastNotificationFingerprint.set(fingerprint)'),
    )
    expect(update).not.toContain('stopSelf')
    expect(update).not.toContain('stopAfterTerminalFailure')

    // Readiness no longer refuses to start a session the user asked for.
    const readiness = sliceBetween(
      service,
      'private fun isBackgroundVoiceSessionAvailable()',
      'private fun hasPostNotificationsPermission()',
    )
    expect(readiness).toContain('notificationsSuppressed = !canPostNotifications()')
    expect(readiness).not.toContain('!canPostNotifications()) return false')

    const status = sliceBetween(plugin, 'private fun voiceForegroundServiceStatusObject(', 'private fun voiceForegroundState(')
    expect(status).toContain('val focusedRuntimeReady = localDuplexReady')
    expect(status).not.toContain('gatewaySpeechReady')
    expect(status).not.toContain('val focusedRuntimeReady = nativeRouteReady &&')
    expect(plugin).toContain('private fun hasForegroundServiceConnectedDevicePermission()')
    expect(plugin).toContain('hasPackagePermission(Manifest.permission.CHANGE_NETWORK_STATE)')
    expect(status).toContain('val startable = microphoneGranted && foregroundServiceReady && manifestReady && focusedRuntimeReady')
    expect(status).toContain('ret.put("notificationsSuppressed"')
    expect(status).toContain('ret.put("foregroundReasons"')
    expect(status).not.toContain('notificationReady && focusedRuntimeReady')
    // Still reported as degraded so the product can say so.
    const state = sliceBetween(plugin, 'private fun voiceForegroundState(', 'private fun voiceForegroundReason(')
    expect(state).toContain('if (!notificationReady) return "degraded"')
    const reason = sliceBetween(plugin, 'private fun voiceForegroundReason(', 'private fun nativeCapabilitySnapshot()')
    expect(reason).toContain('if (!notificationReady) return "notification_delivery_unavailable"')
  })

  it('keeps the one shade entry in product language', () => {
    const service = repoText(servicePath)
    const notificationIcon = repoText(notificationIconPath)
    const copy = shadeCopy(service)

    expect(copy.length).toBeGreaterThanOrEqual(6)
    expect(copy).toContain('Aurora')
    expect(copy.some((line) => line.includes('devices'))).toBe(true)
    for (const line of copy) {
      expect(findForbiddenProductionCopyTerms(line).map((term) => term.id), line).toEqual([])
    }
    // The starting text and the Stop action label are user-facing too.
    expect(findForbiddenProductionCopyTerms('Preparing voice…')).toEqual([])
    expect(service).toContain('"Preparing voice…"')
    for (const [value, phase] of [
      ['8L', 'transcribing'],
      ['9L', 'waiting-for-response'],
      ['10L', 'preparing-speech'],
    ]) {
      expect(service).toContain(`${value} -> "${phase}"`)
    }
    for (const stateCopy of [
      'Say “$wakePhrase” to begin. Tap Stop to end.',
      'Aurora heard you. Keep speaking.',
      'Listening. Tap again when finished.',
      'Understanding what you said…',
      'Understanding what you said… Tap Stop to end.',
      'Aurora is thinking…',
      'Aurora is thinking… Tap Stop to end.',
      'Preparing the answer to speak…',
      'Preparing the answer to speak… Tap Stop to end.',
      'Another app is using the microphone. Aurora will resume automatically.',
      'Working on your request. Tap Stop to end.',
      'Aurora is speaking. Tap Stop to end.',
    ]) {
      expect(service).toContain(`"${stateCopy}"`)
    }
    expect(service).toContain('.setSmallIcon(R.drawable.ic_aurora_notification)')
    expect(service).not.toContain('resources.getIdentifier(')
    expect(notificationIcon).toContain('android:fillColor="#FFFFFFFF"')
    expect(notificationIcon).toContain('android:fillType="evenOdd"')
    expect(notificationIcon).toContain('M12,1.5L15.1,5.4')
    expect(notificationIcon).not.toContain('M4,4h40v40h-40z')
  })
})
