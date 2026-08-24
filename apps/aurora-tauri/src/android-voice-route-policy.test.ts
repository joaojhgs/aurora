import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const kotlinPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativePlugin.kt'
const voiceStorePath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt'
const assistActivityPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraAssistActivity.kt'
const assistantRolePath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraAssistantRole.kt'
const speechPackPath =
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraNativeSpeechPacks.kt'
const nativeDownloaderPath = 'rust/crates/aurora-voice-native/src/downloader.rs'
const permissionPath = 'apps/aurora-tauri/src-tauri/permissions/aurora-android-native-plugin.toml'
const liveTestPermissionPath = 'apps/aurora-tauri/src-tauri/permissions/aurora-android-voice-live-e2e.toml'
const capabilityPath = 'apps/aurora-tauri/src-tauri/capabilities/aurora-android-thin.json'
const tauriLibPath = 'apps/aurora-tauri/src-tauri/src/lib.rs'
const meshSessionPath = 'apps/aurora-tauri/src-tauri/src/mesh_session.rs'

function repoText(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('Android native voice route policy', () => {
  it('runs native pack installation with a bounded dedicated stack and no proxy bypass', () => {
    const plugin = repoText(kotlinPath)
    const downloader = repoText(nativeDownloaderPath)
    const downloadJobBody = plugin.slice(
      plugin.indexOf('val jobId = "voice_pack_'),
      plugin.indexOf('fun voicePackDownloadStatus', plugin.indexOf('val jobId = "voice_pack_')),
    )
    const activationBody = plugin.slice(
      plugin.indexOf('fun setActiveVoicePack(invoke: Invoke)'),
      plugin.indexOf('fun removeVoicePack(invoke: Invoke)'),
    )
    const pinnedClientBody = downloader.slice(
      downloader.indexOf('async fn client_for_pinned_url'),
      downloader.indexOf('async fn resolve_public_addrs', downloader.indexOf('async fn client_for_pinned_url')),
    )

    expect(plugin).toContain('private const val VOICE_PACK_INSTALL_STACK_SIZE_BYTES = 16L * 1024L * 1024L')
    expect(downloadJobBody).toContain('Thread(')
    expect(downloadJobBody).toContain('"aurora-voice-pack-install"')
    expect(downloadJobBody).toContain('VOICE_PACK_INSTALL_STACK_SIZE_BYTES')
    expect(downloadJobBody).not.toContain('kotlin.concurrent.thread')
    expect(activationBody).toContain('candidate.packId !in recordedInstalledPackIds()')
    expect(activationBody).toContain('val verifyAndActivate = Runnable')
    expect(activationBody).toContain('"aurora-voice-pack-activation"')
    expect(activationBody).toContain('VOICE_PACK_INSTALL_STACK_SIZE_BYTES')
    expect(activationBody.indexOf('isPackReadyForRuntime(candidate)')).toBeGreaterThan(
      activationBody.indexOf('val verifyAndActivate = Runnable'),
    )
    const failedReadinessBranch = activationBody.slice(
      activationBody.indexOf('if (!isPackReadyForRuntime(candidate))'),
      activationBody.indexOf('} else {', activationBody.indexOf('if (!isPackReadyForRuntime(candidate))')),
    )
    expect(failedReadinessBranch).not.toContain('setActivePack(candidate, task)')
    expect(pinnedClientBody).toContain('.no_proxy()')
    expect(pinnedClientBody.indexOf('.no_proxy()')).toBeLessThan(
      pinnedClientBody.indexOf('.resolve_to_addrs(host, &pinned)'),
    )
  })

  it('reuses one native speech-pack manager while catalog polling overlaps installation', () => {
    const androidAudio = repoText('apps/aurora-tauri/src-tauri/src/android_audio.rs')
    const plugin = repoText(kotlinPath)
    const catalogStatus = plugin.slice(
      plugin.indexOf('private fun voicePackCatalogStatusObject'),
      plugin.indexOf('private fun voicePackPrefs', plugin.indexOf('private fun voicePackCatalogStatusObject')),
    )

    expect(androidAudio).toContain(
      'static MANAGERS: OnceLock<Mutex<HashMap<PathBuf, Arc<SpeechPackManager>>>>',
    )
    expect(androidAudio).toContain('if let Some(manager) = managers.get(&root)')
    expect(androidAudio).toContain('managers.insert(root, Arc::clone(&manager))')
    expect(catalogStatus).toContain('val installedPackIds = recordedInstalledPackIds()')
    expect(catalogStatus).toContain('val installed = entry.packId in installedPackIds')
    expect(catalogStatus).not.toContain('val installed = isPackInstalledForRuntime(entry)')
    expect(catalogStatus).not.toContain('isPackReadyForRuntime(entry)')
  })

  it('derives the encrypted voice route from profile and native peer credentials', () => {
    const kotlin = repoText(kotlinPath)
    const voiceStore = repoText(voiceStorePath)

    for (const invariant of [
      'syncNativeVoiceRoute()',
      'voiceRouteCandidate',
      'loadUnexpiredThinPeerCredential',
      'AuroraVoiceNativeConfigStore.setRoute(activity, candidate.gateway, bearer)',
      'AuroraVoiceNativeConfigStore.clearRoute(activity)',
      'voice_route_credential_missing',
      'voice_route_profile_missing',
      'voice_route_invalid',
    ]) {
      expect(kotlin).toContain(invariant)
    }
    expect(voiceStore).toContain('fun setRoute(context: Context, gateway: String, bearer: String)')
    expect(voiceStore).toContain('fun clearRoute(context: Context)')
    expect(voiceStore).toContain('VOICE_GATEWAY_KEY')
    expect(voiceStore).toContain('VOICE_BEARER_KEY')
    expect(voiceStore).toContain('VOICE_REMOTE_AUDIO_CONSENT_KEY')
    const setRouteBody = voiceStore.slice(
      voiceStore.indexOf('fun setRoute(context: Context, gateway: String, bearer: String)'),
      voiceStore.indexOf('fun clearRoute(context: Context)', voiceStore.indexOf('fun setRoute(context: Context, gateway: String, bearer: String)')),
    )
    expect(setRouteBody).toContain('.remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)')
    const clearRouteBody = voiceStore.slice(
      voiceStore.indexOf('fun clearRoute(context: Context)'),
      voiceStore.indexOf('fun load(context: Context)', voiceStore.indexOf('fun clearRoute(context: Context)')),
    )
    expect(clearRouteBody).toContain('.remove(VOICE_REMOTE_AUDIO_CONSENT_KEY)')
    expect(voiceStore).toContain('?: false')
  })

  it('keeps Android voice cleartext limited to loopback routes', () => {
    const voiceStore = repoText(voiceStorePath)
    const manifest = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml',
    )
    const networkSecurity = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/res/xml/aurora_network_security_config.xml',
    )

    expect(voiceStore).toContain('scheme == "https" || (scheme == "http" && loopback)')
    expect(manifest).toContain('android:usesCleartextTraffic="false"')
    expect(manifest).toContain('android:networkSecurityConfig="@xml/aurora_network_security_config"')
    expect(networkSecurity).toContain('<base-config cleartextTrafficPermitted="false" />')
    expect(networkSecurity).toContain('<domain includeSubdomains="false">localhost</domain>')
    expect(networkSecurity).toContain('<domain includeSubdomains="false">127.0.0.1</domain>')
    expect(networkSecurity).not.toContain('includeSubdomains="true"')
    expect(voiceStore).not.toContain('host == "::1"')
  })

  it('starts assistant and background voice through the native session with fail-closed readiness', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const manifest = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/AndroidManifest.xml',
    )
    const assistActivity = repoText(assistActivityPath)
    const assistantRole = repoText(assistantRolePath)
    const assistantService = repoText(
      'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraVoiceInteractionSessionService.kt',
    )

    expect(plugin).toContain('if (args.backgroundSession && !status.getBoolean("backgroundStartable"))')
    expect(plugin).toContain('reason", "background_voice_unavailable"')
    expect(plugin).toContain('if (args.backgroundSession) action = AuroraRuntimeForegroundService.ACTION_START_BACKGROUND')
    expect(foregroundService).toContain('ACTION_START_ASSISTANT')
    expect(foregroundService).not.toContain('BACKGROUND_VOICE_AVAILABLE')
    expect(foregroundService).toContain('backgroundSession && !isBackgroundVoiceSessionAvailable()')
    expect(foregroundService).toContain('if (backgroundSession) it.startBackground() else it.start()')
    expect(foregroundService).toContain('private const val VOICE_SERVICE_PREFS = "aurora_voice_foreground_service_state"')
    expect(foregroundService).toContain('PowerManager.PARTIAL_WAKE_LOCK')
    expect(manifest).toContain('android.permission.WAKE_LOCK')
    expect(assistantService).toContain('action = AuroraRuntimeForegroundService.ACTION_START_ASSISTANT')
    expect(assistantService).not.toContain('AuroraVoiceNativeConfigStore.setRemoteAudioConsent')
    expect(assistActivity).toContain('if (!applicationContext.isAuroraAssistantRoleHeld())')
    expect(assistActivity.indexOf('if (!applicationContext.isAuroraAssistantRoleHeld())')).toBeLessThan(
      assistActivity.indexOf('ACTION_START_ASSISTANT'),
    )
    expect(assistantService).toContain('if (!context.isAuroraAssistantRoleHeld())')
    expect(assistantService).toContain('voice_service_start_failed')
    expect(assistantRole).toContain('roleManager?.isRoleHeld(RoleManager.ROLE_ASSISTANT) == true')
    expect(assistantRole).toContain('Settings.Secure.getString(contentResolver, "assistant")')
    expect(assistantRole).toContain('ComponentName.unflattenFromString')

    const backgroundReadinessBody = foregroundService.slice(
      foregroundService.indexOf('private fun isBackgroundVoiceSessionAvailable()'),
      foregroundService.indexOf('private fun hasPostNotificationsPermission()', foregroundService.indexOf('private fun isBackgroundVoiceSessionAvailable()')),
    )
    expect(backgroundReadinessBody).toContain('Manifest.permission.RECORD_AUDIO')
    expect(backgroundReadinessBody).toContain('Manifest.permission.FOREGROUND_SERVICE_MICROPHONE')
    expect(backgroundReadinessBody).toContain('canPostNotifications()')
    expect(backgroundReadinessBody).toContain('AuroraVoiceNativeConfigStore.isConfigured(this)')
    expect(backgroundReadinessBody).toContain('val installedPackIds = recordedInstalledPackIds()')
    for (const task of ['STT', 'TTS', 'VAD', 'KWS']) {
      expect(backgroundReadinessBody).toContain(
        `isActivePackReady(AuroraSpeechPackTask.${task}, catalog, installedPackIds, referenceSelectionReady)`,
      )
    }
    expect(backgroundReadinessBody).toContain('wakePhraseSelection() != null')
    expect(backgroundReadinessBody).not.toContain('AuroraNativeSpeechPackBridge.resolve')

    const onCreateBody = foregroundService.slice(
      foregroundService.indexOf('override fun onCreate()'),
      foregroundService.indexOf('override fun onStartCommand', foregroundService.indexOf('override fun onCreate()')),
    )
    expect(onCreateBody).not.toContain('AuroraVoiceNativeConfigStore.load')
    expect(onCreateBody).not.toContain('AuroraNativeVoiceSessionBridge')

    const onStartBody = foregroundService.slice(
      foregroundService.indexOf('override fun onStartCommand'),
      foregroundService.indexOf('private fun isBackgroundVoiceSessionAvailable', foregroundService.indexOf('override fun onStartCommand')),
    )
    expect(onStartBody.indexOf('enterForeground(')).toBeLessThan(
      onStartBody.indexOf('backgroundSession && !isBackgroundVoiceSessionAvailable()'),
    )
    expect(onStartBody.indexOf('beginNativeVoiceInitialization(backgroundSession, startId)')).toBeGreaterThan(
      onStartBody.indexOf('backgroundSession && !isBackgroundVoiceSessionAvailable()'),
    )
    expect(onStartBody).not.toContain('createNativeVoiceSession(')
    expect(onStartBody).not.toContain('AuroraNativeVoiceSessionBridge(')
  })

  it('makes only an explicitly enabled hands-free session durable across Android process recreation', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const pluginStartBody = plugin.slice(
      plugin.indexOf('fun startVoiceForegroundService(invoke: Invoke)'),
      plugin.indexOf('fun finishVoiceForegroundService(invoke: Invoke)'),
    )
    const onStartBody = foregroundService.slice(
      foregroundService.indexOf('override fun onStartCommand'),
      foregroundService.indexOf('private fun isBackgroundVoiceSessionAvailable'),
    )
    const restartModeBody = foregroundService.slice(
      foregroundService.indexOf('private fun serviceRestartMode()'),
      foregroundService.indexOf('private fun stopAfterTerminalFailure'),
    )
    const durableStartBody = foregroundService.slice(
      foregroundService.indexOf('private fun enableDurableBackgroundSession()'),
      foregroundService.indexOf('private fun serviceRestartMode()'),
    )
    const terminalStopBody = foregroundService.slice(
      foregroundService.indexOf('private fun stopAfterTerminalFailure'),
      foregroundService.indexOf('private fun stopForegroundAndRemoveNotification'),
    )
    const audioFocusBody = foregroundService.slice(
      foregroundService.indexOf('private val audioFocusListener'),
      foregroundService.indexOf('override fun onCreate()'),
    )
    const permanentFocusLossBody = audioFocusBody.slice(
      audioFocusBody.indexOf('AudioManager.AUDIOFOCUS_LOSS -> {'),
      audioFocusBody.indexOf('AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,'),
    )
    const stopActionBody = onStartBody.slice(
      onStartBody.indexOf('if (intent?.action == ACTION_STOP)'),
      onStartBody.indexOf('if (intent?.action == ACTION_FINISH)'),
    )
    const finishActionBody = onStartBody.slice(
      onStartBody.indexOf('if (intent?.action == ACTION_FINISH)'),
      onStartBody.indexOf('val persistedBackgroundRequest'),
    )
    const pluginStopBody = plugin.slice(
      plugin.indexOf('fun stopVoiceForegroundService(invoke: Invoke)'),
      plugin.indexOf('fun finishVoiceForegroundService(invoke: Invoke)'),
    )

    expect(onStartBody).toContain('val explicitBackgroundStart = intent?.action == ACTION_START_BACKGROUND')
    expect(onStartBody).toContain('val stickyRestart = intent == null && persistedBackgroundRequest')
    expect(onStartBody).toContain('if (intent == null && !stickyRestart)')
    expect(onStartBody).toContain('val durableBackgroundSession = explicitBackgroundStart || stickyRestart ||')
    expect(onStartBody).toContain('val backgroundSession = durableBackgroundSession')
    expect(onStartBody).not.toContain(
      'durableBackgroundSession || intent?.action == ACTION_START_ASSISTANT',
    )
    expect(onStartBody).toContain('if (durableBackgroundSession && !enableDurableBackgroundSession())')
    expect(onStartBody).toContain('return serviceRestartMode()')
    const competingBackgroundStartBody = onStartBody.slice(
      onStartBody.indexOf('if (explicitBackgroundStart && !backgroundSessionActive)'),
      onStartBody.indexOf(
        'if (explicitBackgroundStart && !enableDurableBackgroundSession())',
        onStartBody.indexOf('if (explicitBackgroundStart && !backgroundSessionActive)'),
      ),
    )
    expect(competingBackgroundStartBody).toContain(
      'if (explicitBackgroundStart && !backgroundSessionActive)',
    )
    expect(competingBackgroundStartBody).toContain('return serviceRestartMode()')
    expect(competingBackgroundStartBody).not.toContain('stopAfterTerminalFailure')
    expect(competingBackgroundStartBody).not.toContain('invalidateNativeVoiceInitialization')
    expect(onStartBody).not.toContain('START_STICKY')
    expect(restartModeBody).toContain(
      'if (backgroundSessionRequested()) START_STICKY else START_NOT_STICKY',
    )
    expect(durableStartBody.indexOf('acquireBackgroundWakeLock()')).toBeLessThan(
      durableStartBody.indexOf('persistBackgroundSessionRequested(true)'),
    )
    expect(stopActionBody).toContain('stopAfterTerminalFailure()')
    expect(finishActionBody).toContain('stopAfterTerminalFailure(startId)')
    expect(finishActionBody).toContain('finishNativeSession()')
    expect(terminalStopBody).toContain('clearBackgroundSessionPersistence()')
    expect(terminalStopBody).toContain('stopForegroundAndRemoveNotification()')
    expect(permanentFocusLossBody).toContain('captureError = "audio_focus_lost"')
    expect(permanentFocusLossBody).toContain('releaseNativeVoiceResourcesAsync()')
    expect(permanentFocusLossBody).toContain(
      'captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)',
    )
    expect(permanentFocusLossBody).toContain('stopAfterTerminalFailure()')
    expect(permanentFocusLossBody).not.toContain('durableBackgroundSession')
    expect(pluginStopBody).toContain('action = AuroraRuntimeForegroundService.ACTION_STOP')
    expect(pluginStopBody).toContain('activity.startService(stopIntent)')
    expect(pluginStopBody).not.toContain('activity.stopService(')
    expect(pluginStartBody).toContain('status.getBoolean("focusedVoiceActive")')
    expect(pluginStartBody).toContain('ret.put("started", false)')
    expect(pluginStartBody).toContain('ret.put("reason", "foreground_voice_busy")')
    expect(foregroundService).not.toContain('override fun onTrimMemory')
  })

  it('keeps status polling non-authoritative and initializes verified voice sessions off the main thread', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const androidAudio = repoText('apps/aurora-tauri/src-tauri/src/android_audio.rs')
    const statusBodies = [
      plugin.slice(
        plugin.indexOf('private fun localLightInferenceStatusObject()'),
        plugin.indexOf('private fun packageHandlesAssist'),
      ),
      plugin.slice(
        plugin.indexOf('private fun voicePackCatalogStatusObject()'),
        plugin.indexOf('private fun voicePackPrefs'),
      ),
      plugin.slice(
        plugin.indexOf('private fun voiceForegroundServiceStatusObject'),
        plugin.indexOf('private fun nativeCapabilitySnapshot'),
      ),
    ]
    for (const body of statusBodies) {
      expect(body).toContain('recordedInstalledPackIds()')
      expect(body).not.toContain('isPackInstalledForRuntime(')
      expect(body).not.toContain('isPackReadyForRuntime(')
      expect(body).not.toContain('AuroraNativeSpeechPackBridge.resolve')
    }

    const initializationBody = foregroundService.slice(
      foregroundService.indexOf('private fun beginNativeVoiceInitialization'),
      foregroundService.indexOf('private fun createNativeVoiceSession'),
    )
    expect(initializationBody).toContain('initializationInFlight.compareAndSet(false, true)')
    expect(initializationBody).toContain('nativeLifecycleExecutor.execute')
    expect(initializationBody).not.toContain('Thread(')
    expect(initializationBody).toContain('finishHandler.post')
    expect(initializationBody).toContain('closeNativeResources(')
    expect(initializationBody).toContain('if (backgroundSession) it.startBackground() else it.start()')

    const attachBody = foregroundService.slice(
      foregroundService.indexOf('private fun attachNativeVoiceSession'),
      foregroundService.indexOf('private fun invalidateNativeVoiceInitialization'),
    )
    expect(attachBody).toContain('destroyed || generation != initializationGeneration')
    expect(attachBody).toContain('closeOrphanNativeSessionAsync(')
    expect(attachBody).not.toContain('nativeSession?.close()')
    expect(attachBody).toContain('AuroraAudioCapture(')
    expect(attachBody).toContain('captureCallback@{ snapshot ->')
    expect(attachBody).toContain(
      'if (destroyed || capture !== audioCapture || session !== nativeSession) return@captureCallback',
    )

    const onDestroyBody = foregroundService.slice(
      foregroundService.indexOf('override fun onDestroy()'),
      foregroundService.indexOf('override fun onBind'),
    )
    expect(onDestroyBody).toContain('destroyed = true')
    expect(onDestroyBody).toContain('releaseBackgroundWakeLock()')
    expect(onDestroyBody).toContain('invalidateNativeVoiceInitialization()')
    expect(onDestroyBody).toContain('releaseNativeVoiceResourcesAsync()')
    expect(onDestroyBody).not.toContain('capture?.close()')
    expect(onDestroyBody).not.toContain('stopNativeSession()')
    expect(onDestroyBody).toContain('captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)')
    expect(onDestroyBody).not.toContain('captureSnapshot = emptySnapshot(captureError)')
    expect(onDestroyBody).not.toContain('clearBackgroundSessionPersistence()')

    expect(foregroundService).toContain('ThreadPoolExecutor(')
    expect(foregroundService).toContain('"aurora-voice-runtime-lifecycle"')
    expect(foregroundService).toContain('LinkedBlockingQueue<Runnable>()')

    const releaseBody = foregroundService.slice(
      foregroundService.indexOf('private fun releaseNativeVoiceResourcesAsync()'),
      foregroundService.indexOf('private fun closeOrphanNativeSessionAsync('),
    )
    const closeResourcesBody = foregroundService.slice(
      foregroundService.indexOf('private fun closeNativeResources('),
      foregroundService.indexOf('private fun finishNativeSession()'),
    )
    expect(closeResourcesBody).toContain('captureToClose?.close()')
    expect(closeResourcesBody).toContain('playbackToClose?.close()')
    expect(closeResourcesBody).toContain('nativeSession.cancel(generationToCancel)')
    expect(closeResourcesBody).toContain('nativeSession?.close()')
    expect(releaseBody).toContain('nativeLifecycleExecutor.execute')
    expect(releaseBody).toContain('captureSnapshot = terminalSnapshot(captureSnapshot, null, captureError)')
    expect(releaseBody).toContain('abandonAudioFocus()')
    expect(releaseBody).toContain('audioFocusRequest = null')
    expect(foregroundService).toContain(
      'sessionGeneration = stats?.getOrElse(VOICE_STATS_SESSION_GENERATION_INDEX)',
    )
    expect(foregroundService).toContain('} ?: 0L,')
    expect(foregroundService).toContain(
      'queuedOutputChunks = stats?.getOrElse(VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX)',
    )
    expect(releaseBody).not.toContain('Thread(')
    expect(releaseBody).not.toContain('clearBackgroundSessionPersistence()')
    for (const detach of [
      'capture = null',
      'playback = null',
      'session = null',
      'sessionGeneration = 0L',
    ]) {
      expect(releaseBody.indexOf(detach)).toBeGreaterThanOrEqual(0)
      expect(releaseBody.indexOf(detach)).toBeLessThan(
        releaseBody.indexOf('nativeLifecycleExecutor.execute'),
      )
    }

    const finishBody = foregroundService.slice(
      foregroundService.indexOf('private fun finishNativeSession()'),
      foregroundService.indexOf('private fun awaitFinishedSession()'),
    )
    expect(finishBody).toContain('captureToClose?.close()')
    expect(finishBody).toContain('nativeSession.finish(generationToFinish)')
    expect(finishBody).toContain('nativeLifecycleExecutor.execute')
    expect(finishBody).not.toContain('Thread(')

    const awaitFinishedBody = foregroundService.slice(
      foregroundService.indexOf('private fun awaitFinishedSession()'),
      foregroundService.indexOf('private fun updateNotification'),
    )
    expect(awaitFinishedBody).toContain('nativeLifecycleExecutor.execute')
    expect(awaitFinishedBody).toContain('handleFinishedSessionStats(')
    expect(awaitFinishedBody).toContain('session !== nativeSession')
    expect(awaitFinishedBody).toContain('captureSnapshot = terminalSnapshot(captureSnapshot, stats, captureError)')
    expect(awaitFinishedBody.indexOf('nativeSession.stats()')).toBeGreaterThan(
      awaitFinishedBody.indexOf('nativeLifecycleExecutor.execute'),
    )

    const terminalSnapshotBody = foregroundService.slice(
      foregroundService.indexOf('private fun terminalSnapshot('),
      foregroundService.indexOf('private fun updateNotification'),
    )
    expect(terminalSnapshotBody).toContain('acceptedChunks = stats?.getOrElse(0)')
    expect(terminalSnapshotBody).toContain('runtimeActive = false')
    expect(terminalSnapshotBody).toContain('completedTurns = stats?.getOrElse(VOICE_STATS_COMPLETED_TURNS_INDEX)')
    expect(terminalSnapshotBody).toContain('failedTurns = stats?.getOrElse(VOICE_STATS_FAILED_TURNS_INDEX)')

    const notificationBody = foregroundService.slice(
      foregroundService.indexOf('private fun updateNotification'),
      foregroundService.indexOf('private fun ensureNotificationChannel'),
    )
    expect(foregroundService).toContain('private val lastNotificationText = AtomicReference<String?>(null)')
    expect(notificationBody).toContain('lastNotificationText.getAndSet(text) == text')
    expect(notificationBody).toContain('return')

    const nativeCreateBody = androidAudio.slice(
      androidAudio.indexOf('Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeCreateWithPackSelection'),
      androidAudio.indexOf('Java_dev_aurora_tauri_nativeplugin_AuroraNativeVoiceSessionBridge_nativeStart'),
    )
    expect(nativeCreateBody).toContain('AndroidVoiceSessionConfig::with_local_pack_selection')
    expect(nativeCreateBody).toContain('AndroidVoiceSession::new(config, 8, 4_096, 16)')
  })

  it('re-arms recoverable background turns on the loaded native session and stops on terminal faults', () => {
    const foregroundService = repoText(voiceStorePath)
    const androidAudio = repoText('apps/aurora-tauri/src-tauri/src/android_audio.rs')
    const nativeSession = repoText('rust/crates/aurora-voice-native/src/android_session.rs')
    const onStartBody = foregroundService.slice(
      foregroundService.indexOf('override fun onStartCommand'),
      foregroundService.indexOf('private fun isBackgroundVoiceSessionAvailable'),
    )
    const attachBody = foregroundService.slice(
      foregroundService.indexOf('private fun attachNativeVoiceSession'),
      foregroundService.indexOf('private fun invalidateNativeVoiceInitialization'),
    )
    const finishedBody = foregroundService.slice(
      foregroundService.indexOf('private fun handleFinishedSessionStats'),
      foregroundService.indexOf('private fun terminalSnapshot'),
    )
    const rearmBody = foregroundService.slice(
      foregroundService.indexOf('private fun rearmBackgroundSession'),
      foregroundService.indexOf('private fun terminalSnapshot'),
    )
    const stopBody = foregroundService.slice(
      foregroundService.indexOf('private fun stopAfterTerminalFailure'),
      foregroundService.indexOf('private fun stopForegroundAndRemoveNotification'),
    )

    expect(foregroundService).toMatch(/var backgroundSessionActive: Boolean = false\s+private set/)
    expect(foregroundService).toContain('private var backgroundSessionRearmEnabled = false')
    expect(onStartBody).toContain('backgroundSessionActive = backgroundSession')
    expect(onStartBody).toContain('backgroundSessionRearmEnabled = durableBackgroundSession')
    expect(attachBody).toMatch(/else if \(backgroundSessionActive\) \{\s*awaitFinishedSession\(\)/)
    expect(finishedBody).toContain('auroraVoiceRuntimeError(')
    expect(finishedBody).toContain('isRecoverableBackgroundTurn(errorCode)')
    expect(finishedBody).toContain('backgroundSessionRearmEnabled &&')
    expect(finishedBody).toContain('rearmBackgroundSession(nativeSession, stats)')
    expect(finishedBody).toContain('stopAfterTerminalFailure()')
    expect(rearmBody).toContain('nativeLifecycleExecutor.execute')
    expect(rearmBody).toContain('nativeSession.clearIngress()')
    expect(rearmBody).toContain('nativeSession.startBackground()')
    expect(rearmBody.indexOf('nativeSession.clearIngress()')).toBeLessThan(
      rearmBody.indexOf('nativeSession.startBackground()'),
    )
    expect(rearmBody).toContain('sessionGeneration = restartedGeneration')
    expect(rearmBody).toContain('awaitFinishedSession()')
    expect(rearmBody).not.toContain('createNativeVoiceSession(')
    expect(rearmBody).not.toContain('capture?.close()')
    expect(stopBody).toContain('backgroundSessionRearmEnabled = false')
    expect(stopBody).toContain('releaseNativeVoiceResourcesAsync()')
    expect(stopBody.indexOf('releaseNativeVoiceResourcesAsync()')).toBeLessThan(
      stopBody.indexOf('AuroraRuntimeForegroundLedger.activeReasons()'),
    )
    expect(foregroundService).toContain(
      'private const val VOICE_PLAYBACK_WRITE_TIMEOUT_MILLIS = 2_000L',
    )
    expect(foregroundService).toContain('AudioTrack.WRITE_NON_BLOCKING')
    expect(foregroundService).not.toContain('drainWithoutPlayback')
    expect(foregroundService).toContain('fun failPlayback(errorCode: String)')
    expect(foregroundService).toContain('bridge.failPlayback("android_audio_track_write_failed")')
    expect(foregroundService).toContain('if (!writeChunkBounded(currentTrack, samples))')
    expect(foregroundService).toContain('bridge.acknowledgeDrained()')

    for (const code of ['wake_not_detected', 'speech_not_detected', 'speech_timeout']) {
      expect(nativeSession).toContain(`"${code}"`)
      expect(androidAudio).toContain(`Some("${code}")`)
      expect(foregroundService).toContain(`"${code}"`)
    }
  })

  it('captures Android native voice at the proven KWS cadence and reframes VAD in Rust', () => {
    const foregroundService = repoText(voiceStorePath)
    const voiceCore = repoText('rust/crates/aurora-voice-core/src/lib.rs')
    const captureStartBody = foregroundService.slice(
      foregroundService.indexOf('fun start(): Boolean'),
      foregroundService.indexOf('private fun readLoop', foregroundService.indexOf('fun start(): Boolean')),
    )

    expect(foregroundService).toContain('private const val VOICE_CAPTURE_FRAME_SAMPLES = SAMPLE_RATE_HZ / 10')
    expect(captureStartBody).toContain('val frameCapacity = VOICE_CAPTURE_FRAME_SAMPLES')
    expect(captureStartBody).not.toContain('minimumBuffer / 2')
    expect(voiceCore).toContain('VAD_WINDOW_SIZE_SAMPLES')
    expect(voiceCore).toContain('StreamingAudioFrame::end_tail')
  })

  it('keeps Android capture latest-biased without draining playback on input pressure', () => {
    const foregroundService = repoText(voiceStorePath)
    const androidAudio = repoText('apps/aurora-tauri/src-tauri/src/android_audio.rs')
    const nativeCapture = repoText('rust/crates/aurora-voice-native/src/android_capture.rs')
    const readLoopBody = foregroundService.slice(
      foregroundService.indexOf('private fun readLoop(frameCapacity: Int)'),
      foregroundService.indexOf('private fun fail(code: String)'),
    )
    const sessionBridgeBody = foregroundService.slice(
      foregroundService.indexOf('private class AuroraNativeVoiceSessionBridge'),
      foregroundService.indexOf('private class AuroraAudioCapture'),
    )

    expect(readLoopBody).not.toContain('drainOne()')
    expect(sessionBridgeBody).not.toContain('override fun drainOne(): Int = drainPcm().size')
    expect(androidAudio).toContain('session.ingress().push_latest')
    expect(nativeCapture).toContain('pub fn push_latest(')
  })

  it('limits deterministic live PCM injection to debuggable packages and the production ingress queue', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const rust = repoText('apps/aurora-tauri/src-tauri/src/lib.rs')
    const permission = repoText(permissionPath)
    const buildManifest = repoText('apps/aurora-tauri/src-tauri/build.rs')
    const injectionBody = plugin.slice(
      plugin.indexOf('fun injectVoicePcmForLiveTest(invoke: Invoke)'),
      plugin.indexOf('fun voicePackCatalogStatus(invoke: Invoke)'),
    )
    const captureInjectionBody = foregroundService.slice(
      foregroundService.indexOf('fun injectPcmForTest(samples: ShortArray): Int'),
      foregroundService.indexOf(
        'private fun fail(code: String)',
        foregroundService.indexOf('fun injectPcmForTest(samples: ShortArray): Int'),
      ),
    )
    const readLoopBody = foregroundService.slice(
      foregroundService.indexOf('private fun readLoop(frameCapacity: Int)'),
      foregroundService.indexOf('fun injectPcmForTest(samples: ShortArray): Int'),
    )
    const armIngressBody = captureInjectionBody.slice(
      captureInjectionBody.indexOf('fun armLiveTestIngressForTest(): Boolean'),
      captureInjectionBody.indexOf('private fun acquireOrRenewLiveTestIngressLocked()'),
    )

    expect(injectionBody.indexOf('ApplicationInfo.FLAG_DEBUGGABLE')).toBeLessThan(
      injectionBody.indexOf('invoke.parseArgs(AndroidVoiceLiveTestPcmArgs::class.java)'),
    )
    expect(injectionBody).toContain('if (args.armIngress)')
    expect(injectionBody).toContain('AuroraRuntimeForegroundService.armPcmIngressForTest()')
    expect(injectionBody.indexOf('if (args.armIngress)')).toBeLessThan(
      injectionBody.indexOf('Base64.decode(args.pcmBase64, Base64.NO_WRAP)'),
    )
    expect(injectionBody).toContain('VOICE_LIVE_TEST_PCM_MAX_BYTES')
    expect(injectionBody).toContain('Base64.decode(args.pcmBase64, Base64.NO_WRAP)')
    expect(injectionBody).toContain('bytes.size % 2 != 0')
    expect(injectionBody).toContain('ByteOrder.LITTLE_ENDIAN')
    expect(injectionBody).toContain('AuroraRuntimeForegroundService.injectPcmForTest(samples)')
    expect(captureInjectionBody).toContain('samples.size > VOICE_CAPTURE_FRAME_SAMPLES')
    expect(captureInjectionBody).toContain('synchronized(sequenceGuard)')
    expect(captureInjectionBody).toContain('voiceRuntimeAcceptsMicrophoneInput(stats)')
    expect(captureInjectionBody.indexOf('voiceRuntimeAcceptsMicrophoneInput(stats)')).toBeLessThan(
      captureInjectionBody.indexOf('acquireOrRenewLiveTestIngressLocked()'),
    )
    expect(captureInjectionBody).toContain('if (!acquireOrRenewLiveTestIngressLocked())')
    expect(captureInjectionBody).toContain('pushSequencedPcmLocked(samples, samples.size)')
    expect(captureInjectionBody).not.toContain('if (pushResult != 0) liveTestIngressLeaseUntilMillis = 0L')
    expect(captureInjectionBody).not.toContain('microphoneSignalDetected = true')
    expect(readLoopBody).toContain('microphoneSignalDetected = true')
    expect(readLoopBody).toContain('pushMicrophonePcm(buffer, read)')
    expect(captureInjectionBody).toContain('if (liveTestOwnsIngressLocked(runtimeStats))')
    expect(captureInjectionBody.indexOf('liveTestOwnsIngressLocked(runtimeStats)')).toBeLessThan(
      captureInjectionBody.indexOf('pushSequencedPcmLocked(samples, sampleCount)'),
    )
    expect(foregroundService).toContain('synchronized(sequenceGuard)')
    expect(foregroundService).toContain(
      'private const val VOICE_LIVE_TEST_INGRESS_MAX_HOLD_MILLIS = 120_000L',
    )
    expect(captureInjectionBody).toContain('voiceRuntimeAcceptsMicrophoneInput(stats)')
    expect(captureInjectionBody).toContain('if (!ownsIngress) {')
    expect(captureInjectionBody).toContain('liveTestIngressLeaseUntilMillis = 0L')
    expect(captureInjectionBody).toContain('LiveTestIngressLeaseState.AVAILABLE')
    expect(captureInjectionBody).toContain('LiveTestIngressLeaseState.OWNED')
    expect(captureInjectionBody).toContain('LiveTestIngressLeaseState.RELEASED')
    expect(captureInjectionBody).toContain('if (!liveTestOwnsIngressLocked(stats)) return false')
    expect(captureInjectionBody).toContain('liveTestIngressCompletedTurnsAtArm = completedTurns')
    expect(armIngressBody).toContain('val armed = synchronized(sequenceGuard)')
    expect(armIngressBody).toContain('if (!armed) publishSnapshot()')
    expect(armIngressBody.indexOf('if (!armed) publishSnapshot()')).toBeLessThan(
      armIngressBody.indexOf('return armed'),
    )
    expect(captureInjectionBody).toContain('VOICE_STATS_COMPLETED_TURNS_INDEX')
    expect(captureInjectionBody).not.toContain(
      'voiceRuntimeAcceptsMicrophoneInput(stats)\n        if (!ownsIngress)',
    )
    expect(foregroundService).toContain('liveTestIngressInitiallyArmed = initiallyArmed')
    expect(foregroundService).toContain('private var pendingLiveTestIngressArm = false')
    const liveTestPermission = repoText(liveTestPermissionPath)
    expect(permission).not.toContain('aurora_android_voice_live_test_inject_pcm')
    expect(liveTestPermission).toContain('aurora_android_voice_live_test_inject_pcm')
    for (const source of [rust, liveTestPermission, buildManifest]) {
      expect(source).toContain('aurora_android_voice_live_test_inject_pcm')
    }
    expect(rust).toContain('"injectVoicePcmForLiveTest"')
  })

  it('accepts microphone frames only while the runtime is listening and clears ingress before rearm', () => {
    const foregroundService = repoText(voiceStorePath)
    const androidAudio = repoText('apps/aurora-tauri/src-tauri/src/android_audio.rs')
    const nativeCapture = repoText('rust/crates/aurora-voice-native/src/android_capture.rs')
    const nativeSession = repoText('rust/crates/aurora-voice-native/src/android_session.rs')
    const readLoopBody = foregroundService.slice(
      foregroundService.indexOf('private fun readLoop(frameCapacity: Int)'),
      foregroundService.indexOf('private fun fail(code: String)'),
    )
    const rearmBody = foregroundService.slice(
      foregroundService.indexOf('private fun rearmBackgroundSession'),
      foregroundService.indexOf('private fun terminalSnapshot'),
    )

    expect(foregroundService).toContain('private fun voiceRuntimeAcceptsMicrophoneInput(stats: LongArray): Boolean')
    expect(readLoopBody).toContain('val runtimeStats = bridge.stats()')
    expect(readLoopBody).toContain('if (!voiceRuntimeAcceptsMicrophoneInput(runtimeStats))')
    expect(readLoopBody).toContain('pushMicrophonePcm(buffer, read)')
    expect(readLoopBody.indexOf('voiceRuntimeAcceptsMicrophoneInput(runtimeStats)')).toBeLessThan(
      readLoopBody.indexOf('pushSequencedPcmLocked(samples, sampleCount)'),
    )
    expect(readLoopBody).toContain('0 -> Unit')
    expect(readLoopBody).toContain('if (result == 0) sequence = currentSequence + 1L')
    expect(foregroundService).toContain('fun clearIngress(): Boolean')
    expect(foregroundService).toContain('private external fun nativeClearIngress(handle: Long): Int')
    expect(androidAudio).toContain('AuroraNativeVoiceSessionBridge_nativeClearIngress')
    expect(androidAudio).toContain('session.clear_ingress()')
    expect(nativeSession).toContain('pub fn clear_ingress(&self) -> bool')
    expect(nativeCapture).toContain('pub fn clear_pending(&self) -> bool')
    expect(rearmBody.indexOf('nativeSession.clearIngress()')).toBeLessThan(
      rearmBody.indexOf('nativeSession.startBackground()'),
    )
    expect(foregroundService).toContain('runtimePhase = "idle"')
  })

  it('advertises Android local speech only after exact installed pack and route readiness', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const speechPack = repoText(speechPackPath)
    const permission = repoText(permissionPath)
    const aclManifest = repoText('apps/aurora-tauri/src-tauri/gen/schemas/acl-manifests.json')
    const localLightBody = plugin.slice(
      plugin.indexOf('private fun localLightInferenceStatusObject()'),
      plugin.indexOf('private fun packageHandlesAssist', plugin.indexOf('private fun localLightInferenceStatusObject()')),
    )
    const catalogBody = plugin.slice(
      plugin.indexOf('private fun normalizeVoicePackCatalog(raw: String)'),
      plugin.indexOf('private fun findCatalogEntry', plugin.indexOf('private fun normalizeVoicePackCatalog(raw: String)')),
    )
    const downloadBody = plugin.slice(
      plugin.indexOf('private fun downloadPackToCache('),
      plugin.indexOf('private fun isPackDownloaded', plugin.indexOf('private fun downloadPackToCache(')),
    )
    const foregroundStatusBody = plugin.slice(
      plugin.indexOf('private fun voiceForegroundServiceStatusObject'),
      plugin.indexOf('private fun nativeCapabilitySnapshot', plugin.indexOf('private fun voiceForegroundServiceStatusObject')),
    )

    for (const command of [
      'fun voicePackCatalogStatus',
      'fun voicePackCatalog',
      'fun downloadVoicePack',
      'fun voicePackDownloadStatus',
      'fun setActiveVoicePack',
      'fun removeVoicePack',
    ]) {
      expect(plugin).toContain(command)
    }
    for (const command of [
      'aurora_android_voice_pack_catalog_status',
      'aurora_android_voice_pack_catalog_set',
      'aurora_android_voice_pack_download',
      'aurora_android_voice_pack_download_status',
      'aurora_android_voice_pack_activate',
      'aurora_android_voice_pack_remove',
    ]) {
      expect(permission).toContain(command)
      expect(repoText('apps/aurora-tauri/src-tauri/src/lib.rs')).toContain(command)
      expect(aclManifest).toContain(command)
    }

    expect(catalogBody).toContain('parseVoicePackUri(uri)')
    expect(catalogBody).toContain('isValidHexSha256(sha)')
    expect(catalogBody).toContain('engineRuntimeRevision.isBlank()')
    expect(catalogBody).toContain('supportedOperatingSystems.isEmpty()')
    expect(catalogBody).toContain('supportedAbis.isEmpty()')
    expect(catalogBody).toContain('tasks.isEmpty()')

    expect(downloadBody).toContain('validateAndParseVoicePackUri(source)')
    expect(downloadBody).toContain('resolvePackDownloadUri(uri, expectedSize)')
    expect(downloadBody).toContain('total > expectedSize')
    expect(downloadBody).toContain('total != expectedSize')
    expect(downloadBody).toContain('sha256 != actualHash')
    expect(downloadBody).toContain('replaceFileAtomically(temp, destination)')
    expect(plugin).toContain('connection.instanceFollowRedirects = false')
    expect(plugin).toContain('VOICE_PACK_DOWNLOAD_REDIRECT_LIMIT')
    expect(plugin).toContain('InetAddress.getAllByName(host)')
    expect(plugin).toContain('isPrivateOrLocalHostAddress')
    expect(plugin).toContain('uri.scheme?.lowercase(Locale.getDefault()) != "https"')

    expect(localLightBody).toContain('ret.put("available", activeCacheReady && routeConfigured)')
    expect(localLightBody).toContain('ret.put("modelRuntimeProvider", true)')
    expect(localLightBody).toContain('ret.put("engineReady", activeCacheReady)')
    expect(localLightBody).toContain('ret.put("rustCatalogBridgeReady", true)')
    expect(localLightBody).toContain('ret.put("activePackReadyForRuntime", activeCacheReady)')
    expect(localLightBody).toContain('ret.put("activePackCacheReady", activeCacheReady)')
    expect(localLightBody).toContain('ret.put("routeConfigured", routeConfigured)')
    expect(plugin).toContain('isRecordedPackReadyForRuntime(entry, installedPackIds, referenceSelectionReady)')
    expect(plugin).toContain('item.put("readyForInstall", task != null && isPackDownloadReady(entry))')
    expect(plugin).toContain('ret.put("available", catalog.isNotEmpty())')
    expect(plugin).toContain('backgroundSessionAllowed(installedPackIds, referenceSelectionReady)')
    expect(plugin).not.toContain('ret.put("available", backgroundSessionAllowed())')
    const downloadReadinessBody = plugin.slice(
      plugin.indexOf('private fun isPackDownloadReady'),
      plugin.indexOf('private fun isPackInstalledForRuntime', plugin.indexOf('private fun isPackDownloadReady')),
    )
    const offlineUriValidationBody = plugin.slice(
      plugin.indexOf('private fun parseVoicePackUri'),
      plugin.indexOf('private fun validateAndParseVoicePackUri', plugin.indexOf('private fun parseVoicePackUri')),
    )
    const resolvedUriValidationBody = plugin.slice(
      plugin.indexOf('private fun validateAndParseVoicePackUri'),
      plugin.indexOf('private fun isAllowedPackHost', plugin.indexOf('private fun validateAndParseVoicePackUri')),
    )
    expect(downloadReadinessBody).toContain('parseVoicePackUri(entry.uri)')
    expect(downloadReadinessBody).not.toContain('InetAddress.getAllByName')
    expect(offlineUriValidationBody).not.toContain('InetAddress.getAllByName')
    expect(resolvedUriValidationBody).toContain('InetAddress.getAllByName(host)')
    expect(plugin).toContain('private fun requestedPackTask(entry: VoicePackCatalogEntry, requestedTask: String): AuroraSpeechPackTask?')
    expect(plugin).toContain('requested == catalogTask -> requested')
    expect(plugin).toContain('else -> null')
    expect(plugin).toContain('return inferAuroraSpeechPackTask(entry.tasks) != null')
    expect(plugin).not.toContain('voicePackSupportedTaskTokens')
    expect(foregroundService).toContain('private fun isValidVoicePackUri(value: String): Boolean')
    expect(foregroundService).toContain('uri.scheme?.lowercase() == "https"')
    expect(foregroundService).toContain('uri.userInfo == null')
    expect(foregroundService).toContain('uri.fragment == null')
    expect(foregroundService).toContain('if (inferAuroraSpeechPackTask(entry.tasks) == null) return false')
    expect(foregroundService).not.toContain('voicePackNativeSupportedTasks')
    expect(speechPack).toContain('AURORA_TTS_REFERENCE_PREFS')
    expect(speechPack).toContain('AURORA_TTS_REFERENCE_MAX_SAMPLES')
    expect(plugin).toContain('activity.getSharedPreferences(AURORA_TTS_REFERENCE_PREFS, Context.MODE_PRIVATE)')
    expect(plugin).toContain('if (samples.size > AURORA_TTS_REFERENCE_MAX_SAMPLES) return false')
    expect(plugin).toContain('private fun clearLegacyTtsReferenceSelection()')
    expect(plugin).toMatch(/clearLegacyTtsReferenceSelection\(\)[\s\S]*ttsReferencePrefs\(\)\.edit\(\)/)
    expect(plugin).toContain('if (removedNow && task == AuroraSpeechPackTask.TTS)')
    expect(plugin).toContain('clearTtsReferenceSelection()')
    expect(foregroundService).toContain('getSharedPreferences(AURORA_TTS_REFERENCE_PREFS, Context.MODE_PRIVATE)')

    expect(foregroundStatusBody).toContain('val localDuplexReady = nativeRouteReady &&')
    expect(foregroundStatusBody).toContain('val backgroundRuntimeReady = localDuplexReady &&')
    expect(foregroundStatusBody).toContain('val installedPackIds = recordedInstalledPackIds()')
    expect(foregroundStatusBody).toContain('isActivePackReady(AuroraSpeechPackTask.VAD, installedPackIds, referenceSelectionReady)')
    expect(foregroundStatusBody).toContain('isActivePackReady(AuroraSpeechPackTask.KWS, installedPackIds, referenceSelectionReady)')
    expect(foregroundStatusBody).toContain('wakePhraseSelection() != null')
    expect(foregroundStatusBody).not.toContain('isPackReadyForRuntime')
    expect(foregroundStatusBody).not.toContain('AuroraNativeSpeechPackBridge.resolve')
    expect(foregroundStatusBody).toContain('val startable = microphoneGranted && foregroundServiceReady && manifestReady && nativeRouteReady')
    expect(foregroundStatusBody).toContain('val backgroundStartable = microphoneGranted && foregroundServiceReady && manifestReady && backgroundRuntimeReady')
    for (const statusField of [
      'runtimeActive',
      'runtimePhase',
      'sessionGeneration',
      'completedTurns',
      'failedTurns',
      'queuedOutputChunks',
    ]) {
      expect(foregroundStatusBody).toContain(`ret.put("${statusField}", capture.${statusField})`)
    }
    expect(foregroundStatusBody).toContain(
      'ret.put("microphoneSignalDetected", capture.microphoneSignalDetected)',
    )
    expect(foregroundService).toContain('private const val VOICE_STATS_RUNTIME_ACTIVE_INDEX = 5')
    expect(foregroundService).toContain('private const val VOICE_STATS_RUNTIME_PHASE_INDEX = 6')
    expect(foregroundService).toContain('private const val VOICE_STATS_SESSION_GENERATION_INDEX = 7')
    expect(foregroundService).toContain('private const val VOICE_STATS_COMPLETED_TURNS_INDEX = 8')
    expect(foregroundService).toContain('private const val VOICE_STATS_FAILED_TURNS_INDEX = 9')
    expect(foregroundService).toContain('private const val VOICE_STATS_QUEUED_OUTPUT_CHUNKS_INDEX = 10')
    expect(foregroundService).toContain('private const val VOICE_STATS_LAST_ERROR_INDEX = 11')
    expect(foregroundService).toContain('runtimeActive = stats.getOrElse(VOICE_STATS_RUNTIME_ACTIVE_INDEX) { 0 } != 0L')
    expect(foregroundService).toContain('runtimePhase = auroraVoiceRuntimePhase(stats.getOrElse(VOICE_STATS_RUNTIME_PHASE_INDEX) { 0 })')
    expect(foregroundService).toContain('auroraVoiceRuntimeError(stats.getOrElse(VOICE_STATS_LAST_ERROR_INDEX) { 0 })')
    for (const [value, phase] of [
      ['0L', 'idle'],
      ['1L', 'starting'],
      ['2L', 'listening'],
      ['3L', 'processing'],
      ['4L', 'speaking'],
      ['5L', 'stopping'],
      ['6L', 'faulted'],
    ]) {
      expect(foregroundService).toContain(`${value} -> "${phase}"`)
    }
    expect(foregroundService).toContain('else -> "unknown"')
    expect(foregroundService).not.toContain('BACKGROUND_VOICE_AVAILABLE')
    expect(foregroundService).toContain('backgroundSession && !isBackgroundVoiceSessionAvailable()')
  })

  it('finishes every Android pack job and accepts the largest catalogued speech archives', () => {
    const plugin = repoText(kotlinPath)
    const foregroundService = repoText(voiceStorePath)
    const speechPacks = repoText(speechPackPath)
    const speechCatalog = JSON.parse(
      repoText('rust/crates/aurora-voice-engine/resources/sherpa_onnx_speech_catalog.json'),
    ) as { entries: Array<{ archive: { byte_size: number } }> }
    const downloadCommandBody = plugin.slice(
      plugin.indexOf('fun downloadVoicePack(invoke: Invoke)'),
      plugin.indexOf('fun voicePackDownloadStatus(invoke: Invoke)'),
    )
    const terminalStateBody = downloadCommandBody.slice(downloadCommandBody.indexOf('try {'))

    expect(Math.max(...speechCatalog.entries.map((entry) => entry.archive.byte_size))).toBeGreaterThan(1024 ** 3)
    expect(speechPacks).toContain(
      'internal const val AURORA_SPEECH_PACK_MAX_ARCHIVE_BYTES = 3L * 1024L * 1024L * 1024L',
    )
    for (const source of [plugin, foregroundService]) {
      expect(source).toContain('AURORA_SPEECH_PACK_MAX_ARCHIVE_BYTES')
    }
    expect(plugin).toContain('val status: String = "queued"')
    expect(plugin).not.toContain('var status: String = "queued"')
    expect(plugin).toContain('voicePackDownloadJobs.computeIfPresent(jobId)')
    expect(terminalStateBody).toContain('catch (_: Exception)')
    expect(terminalStateBody).toContain('status = "failed"')
    expect(terminalStateBody).toContain('error = "download_failed"')
    expect(terminalStateBody).toContain('finally {')
    expect(terminalStateBody).toContain('current.status == "failed" && current.totalBytes <= 0')
    expect(terminalStateBody).toContain('completedAtMs = currentUnixMs()')
    expect(downloadCommandBody).toMatch(/finally \{[\s\S]*voicePackJobsByPack\.remove\(packId, jobId\)/)
  })

  it('keeps installed Android packs usable without network access', () => {
    const plugin = repoText(kotlinPath)
    const runtimeReadinessBody = plugin.slice(
      plugin.indexOf('private fun isPackReadyForRuntime'),
      plugin.indexOf('private fun ttsReferenceRequired'),
    )
    const descriptorReadinessBody = plugin.slice(
      plugin.indexOf('private fun isPackDescriptorRuntimeReady'),
      plugin.indexOf('private fun isPackDownloadReady'),
    )

    expect(runtimeReadinessBody).toContain('isPackDescriptorRuntimeReady(entry)')
    expect(runtimeReadinessBody).not.toContain('isPackDownloadReady(entry)')
    expect(descriptorReadinessBody).not.toContain('validateAndParseVoicePackUri')
  })

  it('accepts omitted reference fields for Android packs that do not require them', () => {
    const plugin = repoText(kotlinPath)
    const referenceArgsBody = plugin.slice(
      plugin.indexOf('interface AndroidVoicePackReferenceArgs'),
      plugin.indexOf('@InvokeArg\nclass AndroidVoicePackOperationStatusArgs'),
    )
    const referenceStoreBody = plugin.slice(
      plugin.indexOf('private fun storeTtsReferenceSelection'),
      plugin.indexOf('private fun clearTtsReferenceSelection'),
    )

    for (const declaration of [
      'var referenceId: String?',
      'var referenceAudioUri: String?',
      'var referenceText: String?',
      'var referenceRevision: String?',
      'var referenceSampleRateHz: Int?',
      'var referenceSamples: Array<Double>?',
    ]) {
      expect(referenceArgsBody).toContain(declaration)
    }
    expect(referenceStoreBody).toContain('args.referenceId?.trim().orEmpty()')
    expect(referenceStoreBody).toContain('args.referenceSamples.orEmpty()')
    expect(referenceStoreBody).toContain('args.referenceSampleRateHz ?: 0')
  })

  it('releases foreground microphone access on Android focus or foreground loss', () => {
    const plugin = repoText(kotlinPath)
    const runtime = repoText('apps/aurora-tauri/src/aurora-client.ts')

    const onPauseBody = plugin.slice(
      plugin.indexOf('override fun onPause()'),
      plugin.indexOf('override fun onStop()', plugin.indexOf('override fun onPause()')),
    )
    const onStopBody = plugin.slice(
      plugin.indexOf('override fun onStop()'),
      plugin.indexOf('override fun onDestroy', plugin.indexOf('override fun onStop()')),
    )
    const lifecycleBody = plugin.slice(
      plugin.indexOf('private fun lifecycleStatusObject'),
      plugin.indexOf('private fun emitLifecycle', plugin.indexOf('private fun lifecycleStatusObject')),
    )
    const listenerBody = runtime.slice(
      runtime.indexOf('export function installAndroidLifecyclePolicy'),
      runtime.indexOf('interface AndroidLifecyclePluginPayload', runtime.indexOf('export function installAndroidLifecyclePolicy')),
    )

    expect(onPauseBody).toContain('focused = false')
    expect(onPauseBody).toContain('denyPendingMicRequests()')
    expect(onPauseBody).toContain('emitLifecycle("pause")')
    expect(onStopBody).toContain('foreground = false')
    expect(onStopBody).toContain('focused = false')
    expect(onStopBody).toContain('denyPendingMicRequests()')
    expect(onStopBody).toContain('emitLifecycle("stop")')
    expect(lifecycleBody).toMatch(/AuroraRuntimeForegroundService\.running &&\s+AuroraRuntimeForegroundService\.backgroundSessionActive/)
    expect(lifecycleBody).toContain('ret.put("mustReleaseMicrophone", (!foreground || !focused) && !backgroundWakeword)')
    expect(lifecycleBody).toContain('ret.put("backgroundWakeword", backgroundWakeword)')
    expect(lifecycleBody).toContain('release_mic_until_explicit_resume')
    expect(listenerBody).toContain('payload.mustReleaseMicrophone === true')
    expect(listenerBody).toContain('payload.foreground === false || payload.focused === false')
    expect(listenerBody).toContain('payload.backgroundWakeword !== true')
    expect(listenerBody).toContain('AURORA_RELEASE_FOCUSED_MEDIA_EVENT')
  })

  it('exposes redacted live foreground reasons through the Android service dump hook', () => {
    const service = repoText(voiceStorePath)
    const dumpBody = service.slice(
      service.indexOf('override fun dump('),
      service.indexOf('override fun onCreate()', service.indexOf('override fun dump(')),
    )

    expect(dumpBody).toContain('aurora.runtime.running=')
    expect(dumpBody).toContain('aurora.runtime.foregroundReasons=')
    expect(dumpBody).toContain('aurora.runtime.foregroundServiceTypeMask=')
    expect(dumpBody).toContain('AuroraRuntimeForegroundLedger.activeReasons()')
    expect(dumpBody).not.toContain('VOICE_BEARER_KEY')
    expect(dumpBody).not.toContain('THIN_PROFILE_KEY')
  })

  it('gates the mesh dispatcher with the native mobile lifecycle', () => {
    const tauriLib = repoText(tauriLibPath)
    const meshSession = repoText(meshSessionPath)
    const windowEventBody = tauriLib.slice(
      tauriLib.indexOf('.on_window_event(move |window, event|'),
      tauriLib.indexOf('.run(tauri::generate_context!())'),
    )
    const suspendBody = meshSession.slice(
      meshSession.indexOf('pub async fn mark_surface_backgrounded'),
      meshSession.indexOf('pub async fn begin_native_assistant_call', meshSession.indexOf('pub async fn mark_surface_backgrounded')),
    )

    expect(windowEventBody).toContain('tauri::WindowEvent::Suspended')
    expect(windowEventBody).toContain('state.mark_surface_backgrounded().await')
    expect(windowEventBody).toContain('tauri::WindowEvent::Resumed')
    expect(windowEventBody).toContain('state.mark_surface_resumed().await')
    expect(windowEventBody).toContain('MESH_SURFACE_RESUMED_EVENT')
    expect(suspendBody).toContain('SurfaceLifecycle::Background')
    expect(suspendBody).toContain('native_surface_backgrounded = true')
    expect(suspendBody).toContain('native_surface_backgrounded = false')
    expect(meshSession).toContain('lifecycle == SurfaceLifecycle::Foreground && self.native_surface_backgrounded')
  })

  it('keeps assistant role selection behind the explicit request command', () => {
    const plugin = repoText(kotlinPath)
    const manifestBody = plugin.slice(
      plugin.indexOf('fun nativeCapabilityManifest(invoke: Invoke)'),
      plugin.indexOf('@Command\n    fun assistantRoleStatus', plugin.indexOf('fun nativeCapabilityManifest(invoke: Invoke)')),
    )
    const requestBody = plugin.slice(
      plugin.indexOf('fun requestAssistantRole(invoke: Invoke)'),
      plugin.indexOf('@Command\n    fun recordAssistantRoleResult', plugin.indexOf('fun requestAssistantRole(invoke: Invoke)')),
    )
    const startVoiceBody = plugin.slice(
      plugin.indexOf('fun startVoiceForegroundService(invoke: Invoke)'),
      plugin.indexOf('@Command\n    fun stopVoiceForegroundService', plugin.indexOf('fun startVoiceForegroundService(invoke: Invoke)')),
    )

    expect(manifestBody).toContain('assistantRoleStatusObject()')
    expect(manifestBody).toContain('permissions.put("aurora.android.assistantRoleRequest", assistantRoleRequestable)')
    expect(manifestBody).not.toContain('createRequestRoleIntent')
    expect(manifestBody).not.toContain('startActivityForResult')
    expect(requestBody).toContain('if (!status.getBoolean("requestable"))')
    expect(requestBody).toContain('roleManager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)')
    expect(requestBody).toContain('activity.startActivityForResult')
    expect(startVoiceBody).not.toContain('createRequestRoleIntent')
    expect(startVoiceBody).not.toContain('ACTION_START_ASSISTANT')
  })

  it('keeps the thin APK on narrow profile/peer-storage permissions', () => {
    const permission = repoText(permissionPath)
    const capability = repoText(capabilityPath)

    expect(permission).toContain('aurora_inbound_verifier_set')
    expect(permission).toContain('aurora_android_voice_foreground_service_start')
    expect(capability).not.toContain('aurora-secure-storage')
    expect(capability).not.toContain('aurora-secure-storage-set')
    expect(permission).not.toContain('aurora_secure_storage_set')
  })

  it('does not make route provisioning a role selector', () => {
    const kotlin = repoText(kotlinPath)
    const syncBody = kotlin.slice(
      kotlin.indexOf('private fun syncNativeVoiceRoute()'),
      kotlin.indexOf('private fun voiceRouteCandidate', kotlin.indexOf('private fun syncNativeVoiceRoute()')),
    )

    expect(kotlin).toContain('activeProfileId')
    expect(syncBody).toContain('candidate.gateway')
    expect(kotlin).toContain('Both remote-console and mesh-node profiles')
    expect(syncBody).not.toContain('nodeMode =')
    expect(syncBody).not.toContain('runtimeTier =')
    expect(syncBody).not.toContain('VITE_AURORA_RUNTIME_MODE')
  })

  it('fails closed when encrypted peer credentials are unreadable before route provisioning', () => {
    const kotlin = repoText(kotlinPath)
    const loadBody = kotlin.slice(
      kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      kotlin.indexOf(
        'private fun thinPeerStatusResponse',
        kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      ),
    )
    const syncBody = kotlin.slice(
      kotlin.indexOf('private fun syncNativeVoiceRoute()'),
      kotlin.indexOf(
        'private fun voiceRouteCandidate',
        kotlin.indexOf('private fun syncNativeVoiceRoute()'),
      ),
    )

    expect(loadBody).toContain('val key = thinPeerCredentialKey(peerId)')
    expect(loadBody).toContain('JSONObject(decryptSecureValue(stored))')
    expect(loadBody).toContain('validateThinPeerCredentialRecord(record)')
    expect(loadBody).toContain('catch (_: Exception)')
    expect(loadBody).toMatch(/securePrefs\(\)\.edit\(\)\.remove\(key\)\.apply\(\)[\s\S]*return null/)
    expect(syncBody).toContain('?.let(::loadUnexpiredThinPeerCredential)')
    expect(syncBody).toContain('AuroraVoiceNativeConfigStore.clearRoute(activity)')
    expect(syncBody).toMatch(/if \(candidate == null\) \{[\s\S]*AuroraVoiceNativeConfigStore\.clearRoute\(activity\)[\s\S]*voice_route_profile_missing/)
    expect(syncBody).toMatch(/if \(!loopback && bearer\.isBlank\(\)\) \{[\s\S]*AuroraVoiceNativeConfigStore\.clearRoute\(activity\)[\s\S]*voice_route_credential_missing/)
    expect(syncBody).toMatch(/catch \(_:\s*Exception\) \{[\s\S]*AuroraVoiceNativeConfigStore\.clearRoute\(activity\)[\s\S]*voice_route_invalid/)
    expect(syncBody).not.toContain('rawBearerToken", record.getString')
  })

  it('rejects stored peer credentials with missing bearer fields before route provisioning', () => {
    const kotlin = repoText(kotlinPath)
    const loadBody = kotlin.slice(
      kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      kotlin.indexOf(
        'private fun thinPeerStatusResponse',
        kotlin.indexOf('private fun loadUnexpiredThinPeerCredential(peerId: String)'),
      ),
    )
    const validatorBody = kotlin.slice(
      kotlin.indexOf('private fun validateThinPeerCredentialRecord(record: JSONObject)'),
      kotlin.indexOf(
        'private fun validateReconnectChallenge',
        kotlin.indexOf('private fun validateThinPeerCredentialRecord(record: JSONObject)'),
      ),
    )

    expect(loadBody).toMatch(/validateThinPeerCredentialRecord\(record\)[\s\S]*catch \(_:\s*Exception\)/)
    expect(loadBody).toMatch(/catch \(_:\s*Exception\) \{[\s\S]*securePrefs\(\)\.edit\(\)\.remove\(key\)\.apply\(\)[\s\S]*return null/)
    for (const field of [
      'tokenId',
      'claimantPeerId',
      'verifierPeerId',
      'claimantSignalingPeerId',
      'verifierSignalingPeerId',
      'roomName',
      'rawBearerToken',
    ]) {
      expect(validatorBody).toContain(`validateNonEmpty("${field}"`)
    }
    expect(validatorBody).toContain('validateOptionalJsonLong(record, "createdAtMs")')
    expect(validatorBody).toContain('validateOptionalJsonLong(record, "expiresAtMs", requirePositive = true)')
  })

  it('honors explicit Pocket reference mode instead of forcing every pockettts pack to need a user profile', () => {
    const plugin = repoText(kotlinPath)
    const service = repoText(voiceStorePath)
    const androidAudio = repoText('apps/aurora-tauri/src-tauri/src/android_audio.rs')
    const helper = repoText(speechPackPath)
    const helperBody = helper.slice(
      helper.indexOf('internal fun auroraTtsReferenceRequired'),
      helper.indexOf('internal fun auroraVoicePackReferenceAudioMode'),
    )

    expect(androidAudio).toContain('TtsVoiceCatalog::runtime()')
    expect(androidAudio).toContain('entry.requires_reference_profile()')
    expect(androidAudio).toContain('catalog_reference_audio_mode_label()')
    expect(helperBody).toContain('"internal" -> false')
    expect(helperBody).toContain('"profile" -> true')
    expect(helperBody).toContain('requiresReferenceAudio || modelFamily == "pockettts"')
    expect(plugin).toContain('auroraTtsReferenceRequired(')
    expect(plugin).toContain('entry.referenceAudioMode')
    expect(service).toContain('auroraTtsReferenceRequired(')
    expect(service).toContain('entry.referenceAudioMode')
    expect(plugin).not.toContain('entry.requiresReferenceAudio || entry.modelFamily == "pockettts"')
    expect(service).not.toContain('!entry.requiresReferenceAudio && entry.modelFamily != "pockettts"')
  })

  it('stores and loads Android audio-only clone profiles without written text', () => {
    const plugin = repoText(kotlinPath)
    const service = repoText(voiceStorePath)
    const helper = repoText(speechPackPath)
    const helperBody = helper.slice(
      helper.indexOf('internal fun auroraTtsReferenceAudioReady'),
      helper.indexOf('internal fun auroraTtsReferenceRequired'),
    )
    const pluginStoreBody = plugin.slice(
      plugin.indexOf('private fun storeTtsReferenceSelection'),
      plugin.indexOf('private fun clearTtsReferenceSelection'),
    )
    const pluginLoadBody = plugin.slice(
      plugin.indexOf('private fun ttsReferenceSelection()'),
      plugin.indexOf('private fun storeTtsReferenceSelection'),
    )
    const serviceLoadBody = service.slice(
      service.indexOf('private fun ttsReferenceSelection()'),
      service.indexOf('private fun parseReferenceSamples(raw: String?)'),
    )

    expect(helperBody).toContain('id.isNotBlank() && sampleRateHz > 0 && samples.isNotEmpty()')
    expect(helperBody).toContain('auroraTtsReferenceAudioReady(id, sampleRateHz, samples)')
    expect(helperBody).not.toContain('text.isNotBlank()')
    expect(pluginStoreBody).toContain('if (!auroraTtsReferenceAudioReady(id, sampleRateHz, samples)) return false')
    expect(pluginStoreBody).not.toContain('text.isBlank() || sampleRateHz')
    expect(pluginLoadBody).toContain('auroraTtsReferenceSelectionOrNull(')
    expect(pluginLoadBody).not.toContain('text.isNotBlank()')
    expect(pluginLoadBody).not.toContain('profileText.isNotBlank()')
    expect(serviceLoadBody).toContain('auroraTtsReferenceSelectionOrNull(')
    expect(serviceLoadBody).not.toContain('text.isNotBlank()')
    expect(serviceLoadBody).not.toContain('profileText.isNotBlank()')
  })
})
