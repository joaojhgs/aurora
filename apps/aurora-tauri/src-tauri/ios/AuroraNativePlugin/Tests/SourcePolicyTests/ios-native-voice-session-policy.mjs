import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(testDir, '..', '..')
const sourceRoot = resolve(packageRoot, 'Sources', 'AuroraNativePlugin')
const sessionHost = readFileSync(resolve(sourceRoot, 'AuroraIOSVoiceSessionHost.swift'), 'utf8')
const playback = readFileSync(resolve(sourceRoot, 'AuroraIOSVoicePlayback.swift'), 'utf8')
const capture = readFileSync(resolve(sourceRoot, 'AuroraIOSVoiceCapture.swift'), 'utf8')
const credentialStore = readFileSync(
  resolve(sourceRoot, 'AuroraIOSVoiceCredentialStore.swift'),
  'utf8',
)
const packManager = readFileSync(resolve(sourceRoot, 'AuroraIOSVoicePackManager.swift'), 'utf8')
const plugin = readFileSync(resolve(sourceRoot, 'AuroraNativePlugin.swift'), 'utf8')
const header = readFileSync(
  resolve(packageRoot, 'Sources', 'CAuroraIOSVoiceBridge', 'include', 'aurora_ios_voice_bridge.h'),
  'utf8',
)
const nativeAbi = readFileSync(resolve(packageRoot, '..', '..', 'src', 'ios_voice.rs'), 'utf8')
const tauriLib = readFileSync(resolve(packageRoot, '..', '..', 'src', 'lib.rs'), 'utf8')
const nativeSession = readFileSync(
  resolve(packageRoot, '..', '..', '..', '..', '..', 'rust', 'crates', 'aurora-voice-native', 'src', 'ios_session.rs'),
  'utf8',
)
const loadRecordBody = credentialStore.match(
  /private static func loadRecord\(\) throws -> AuroraIOSVoiceCredentialRecord\? \{[\s\S]*?\n  private static func validateGateway/,
)?.[0] ?? ''

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertIncludesAll(source, snippets, messagePrefix) {
  for (const snippet of snippets) {
    assert(source.includes(snippet), `${messagePrefix}: ${snippet}`)
  }
}

for (const symbol of [
  'aurora_ios_voice_session_new',
  'aurora_ios_voice_session_new_with_pack_bindings',
  'aurora_ios_voice_session_audio_state',
  'aurora_ios_voice_session_start',
  'aurora_ios_voice_session_start_background',
  'aurora_ios_voice_session_finish',
  'aurora_ios_voice_session_cancel',
  'aurora_ios_voice_session_status',
  'aurora_ios_voice_session_close',
  'aurora_ios_voice_session_free',
]) {
  assert(header.includes(symbol), `missing iOS voice ABI symbol ${symbol}`)
  assert(sessionHost.includes(symbol), `Swift session host does not call ${symbol}`)
}

assert(capture.includes('borrowingState state'), 'capture host must support Rust-owned ingress')
assert(capture.includes('self.ownsState = false'), 'borrowed ingress must not be freed by Swift')
assert(capture.includes('sequenceLock'), 'capture sequence allocation must be synchronized across audio/lifecycle threads')
assert(capture.includes('nextSequence()'), 'capture callback must use synchronized sequence allocation')
assert(sessionHost.includes('capture = nil'), 'session host must destroy borrowed audio before Rust free')
assert(sessionHost.includes('remoteAudioConsent'), 'session host must preserve explicit remote consent')
assert(
  sessionHost.includes('AuroraIOSVoiceCredentialStore.load'),
  'session host must support native stored credentials',
)
assert(
  sessionHost.includes('requiredSlots: ["vad", "kws", "stt", "tts"]')
    && sessionHost.includes('AuroraIOSVoicePackManager.boundPackBindings')
    && sessionHost.includes('requiredTaskPackUnavailable'),
  'session host must require the full local voice pack set before native session construction',
)
assert(!sessionHost.includes('requiredSlots: ["stt"]'), 'session host must not allow STT-only native sessions')
assert(
  sessionHost.includes('AuroraIosVoiceTaskPackBinding')
    && sessionHost.includes('aurora_ios_voice_session_new_with_pack_bindings'),
  'session host must pass selected pack bindings to Rust',
)
for (const exactBindingField of [
  'pack_id',
  'expected_sha256',
  'expected_size_bytes',
  'runtime_revision',
  'model_family',
  'reference_audio_path',
  'reference_audio_sha256',
  'reference_audio_size_bytes',
  'reference_audio_sample_rate_hz',
  'reference_text',
  'reference_revision',
  'files_json',
  'language',
  'sample_rate_hz',
  'frame_size',
]) {
  assert(header.includes(exactBindingField), `iOS ABI must carry exact binding field ${exactBindingField}`)
  assert(sessionHost.includes(exactBindingField), `Swift session host must pass ${exactBindingField}`)
  assert(nativeAbi.includes(exactBindingField), `Rust iOS ABI must parse exact binding field ${exactBindingField}`)
}
assertIncludesAll(
  nativeSession,
  [
    'build_local_ios_runtime',
    'verify_ios_pack_bindings',
    'verify_ios_pack_file_binding',
    'SherpaVadProvider',
    'SherpaKwsProvider',
    'SherpaFiniteSttEngine',
    'SherpaTtsProvider',
    'NativeVadBackend',
    'NativeKwsBackend',
    'NativeSttBackend',
    'NativeTtsBackend',
    'TaskPackBinding::from_ios_cached_sherpa',
    'catalog_model_family()',
    'from_catalog_pockettts_model',
    'verify_ios_tts_reference_binding',
    'tts_reference()',
    'required_file(vad_binding, "model")',
    'required_file(kws_binding, "encoder-int8")',
    'stt_decoder_file(stt_binding)',
    'required_file(tts_binding, "espeak-ng-data")',
    '#[cfg(not(feature = "ios-sherpa"))]',
    'Err(IosVoiceSessionCommandError::Unavailable)',
  ],
  'Rust iOS session must build local Sherpa providers from exact cached pack files and fail closed',
)
assert(
  credentialStore.includes('kSecAttrAccessibleWhenUnlockedThisDeviceOnly'),
  'voice credentials must be device-only Keychain data',
)
assert(
  credentialStore.includes('secretsRedacted'),
  'voice credential status must be explicitly redacted',
)
assert(
  credentialStore.includes('http" && !isLoopbackHost'),
  'cleartext voice gateways must be restricted to loopback',
)
assert(
  credentialStore.includes('private static func discardStoredRecord()')
    && credentialStore.includes('SecItemDelete(keychainQuery() as CFDictionary)'),
  'invalid stored voice credentials must delete only the dedicated Keychain record',
)
assert(
  /guard status == errSecSuccess, let data = result as\? Data else \{\n      throw AuroraIOSVoiceCredentialStoreError\.keychainFailure\n    \}\n    let record: AuroraIOSVoiceCredentialRecord/.test(loadRecordBody)
    && !loadRecordBody
      .slice(0, loadRecordBody.indexOf('let record: AuroraIOSVoiceCredentialRecord'))
      .includes('discardStoredRecord()'),
  'generic Keychain read failures must fail without deleting stored voice credentials',
)
assert(
  /do \{\n      record = try JSONDecoder\(\)\.decode\(AuroraIOSVoiceCredentialRecord\.self, from: data\)\n    \} catch \{\n      discardStoredRecord\(\)\n      throw AuroraIOSVoiceCredentialStoreError\.corruptRecord\n    \}/.test(loadRecordBody),
  'corrupt stored voice credentials must be deleted before failing closed',
)
assert(
  /do \{\n      _ = try validateGateway\(record\.gateway\)\n      _ = try validateBearer\(record\.bearer\)\n    \} catch let error as AuroraIOSVoiceCredentialStoreError \{\n      discardStoredRecord\(\)\n      throw error\n    \}/.test(loadRecordBody),
  'semantically invalid stored voice credentials must be deleted without weakening validation',
)
assert(plugin.includes('voiceCredentialSet'), 'native plugin must expose credential provisioning')
assert(plugin.includes('voiceCredentialDelete'), 'native plugin must expose credential deletion')
assert(plugin.includes('voiceCredentialStatus'), 'native plugin must expose redacted credential status')
assert(plugin.includes('AuroraIOSVoiceSessionHost('), 'foreground start must construct the Rust session host')
assert(plugin.includes('voiceSession?.cancel'), 'foreground stop must cancel the Rust session generation')
assert(plugin.includes('voiceForegroundCaptureFinish'), 'foreground PTT must expose a finish command')
assert(
  plugin.includes('voiceSessionGeneration = nil'),
  'successful foreground finish must clear generation identity before a later stop can cancel stale work',
)
assert(plugin.includes('voiceBackgroundCaptureStart'), 'explicit background voice must expose a separate start command')
assert(plugin.includes('startBackground()'), 'background start must use the Rust background-session ABI')
assert(plugin.includes('session.finish(generation: generation)'), 'finish must complete the Rust generation')
assert(plugin.includes('voiceSessionGeneration'), 'foreground lifecycle must retain generation identity')
assert(plugin.includes('voiceSession?.captureStats() ?? voiceCapture.stats()'), 'status must report Rust-owned capture stats after cutover')
for (const command of [
  'voicePackCatalogSet',
  'voicePackList',
  'voicePackStatus',
  'voicePackDownload',
  'voicePackRemove',
  'voiceTTSReferenceSet',
]) {
  assert(plugin.includes(command), `native plugin must expose ${command}`)
}
assert(
  !plugin.includes('nativeTurnTransportAvailable = false')
    && plugin.includes('nativeTurnTransportReady()')
    && plugin.includes('packCatalogReady'),
  'public iOS voice capture readiness must not be hardcoded off after pack/native bridge wiring',
)
assertIncludesAll(
  tauriLib,
  [
    'ios_local_light_inference_status_from_voice_packs',
    'ios_voice_pack_catalog_visible',
    'ios_ready_local_voice_model_id',
    'run_ios_plugin_command(native, "voicePackStatus", json!({}))',
    '"count": 558',
    'ios_voice_catalog_ready_but_required_packs_missing',
  ],
  'Rust iOS local-light bridge status must be derived from voice-pack catalog and active packs',
)
assert(
  !/available: false,\s*requestable: false,\s*model_runtime_provider: false/.test(tauriLib),
  'Rust iOS local-light status must not hardcode provider/requestability/model fields false',
)
for (const snippet of [
  'operationQueue.sync',
  'normalizeTrustedHosts',
  'hostAllowedByCatalog',
  'validateDownloadTarget',
  'resolvesToAllowedHost',
  'getaddrinfo',
  'isDisallowedIPv4',
  'isDisallowedIPv6',
  'willPerformHTTPRedirection',
  'Content-Length',
  'SHA256',
  'setTTSReference',
  'AuroraIOSVoiceTTSReferenceRecord',
  'maxReferenceBytes',
  'referenceDirectoryName',
  'writeAtomically',
  'replaceItemAt',
  'stagingPrefix',
  'metadata.json',
  'active.json',
  'trusted-hosts.json',
  'boundPackPaths(for slots:',
  'boundPackBindings(for slots:',
  'localSha256 == catalogEntry.sha256',
  'metadata.bytesDownloaded == catalogEntry.fileSize',
  'metadata.pack.runtimeRevision == catalogEntry.runtimeRevision',
  'modelFilesJson',
  'modelFiles',
  'modelFamily',
  'pockettts',
  'isSafeCachedModelFile',
  'sanitizeRelativePath',
  'catalogEntry.sampleRateHz > 0',
  'catalogEntry.frameSize > 0',
  'isSafeCachedPackFile',
  'isSymbolicLink',
  'entry.acknowledged',
  'embeddedCatalog',
  'aurora_ios_voice_pack_embedded_catalog_json',
]) {
  assert(packManager.includes(snippet), `voice pack manager must preserve safety policy: ${snippet}`)
}
assert(!packManager.includes('catalogEntryLimit'), 'iOS catalog fallback must not retain a 200-entry cap')
assert(
  packManager.includes('let sanitized = try entries.map')
    && !packManager.includes('compactMap { entry -> AuroraIOSVoicePackCatalogEntry?'),
  'invalid catalog entries must fail the whole catalog instead of being silently dropped',
)
assert(
  !packManager.includes('Bundle.main') && !packManager.includes('.onnx'),
  'voice pack manager must not use embedded model weights',
)
for (const notification of [
  'AVAudioSession.interruptionNotification',
  'AVAudioSession.routeChangeNotification',
  'AVAudioSession.mediaServicesWereResetNotification',
  'UIApplication.didEnterBackgroundNotification',
  'UIApplication.protectedDataWillBecomeUnavailableNotification',
  'ProcessInfo.powerStateDidChangeNotification',
  'UIApplication.willTerminateNotification',
]) {
  assert(sessionHost.includes(notification), `session host must observe ${notification}`)
}
assert(sessionHost.includes('cancelForLifecycleChange'), 'audio lifecycle changes must cancel the Rust generation')
assert(sessionHost.includes('removeLifecycleObservers'), 'audio lifecycle observers must be removed on teardown')
assert(sessionHost.includes('object: audioSession'), 'lifecycle observers must be scoped to Aurora audio session')
assert(sessionHost.includes('backgroundSessionActive'), 'lifecycle policy must distinguish explicit background sessions')
assert(sessionHost.includes('respectBackgroundSession: true'), 'foreground lifecycle loss must preserve only explicit background sessions')
assert(playback.includes('aurora_ios_audio_output_drain'), 'playback must drain Rust-owned output')
assert(playback.includes('aurora_ios_audio_output_acknowledge'), 'playback must acknowledge consumed output')
assert(playback.includes('AVAudioPlayerNode'), 'playback must use native AVAudioPlayerNode')
assert(playback.includes('aurora_ios_audio_output_close'), 'playback must close output on stop')
assert(playback.includes('chunkInFlight'), 'playback must acknowledge one chunk before draining another')
assert(!sessionHost.includes('print('), 'session host must not log credentials or audio state')
assert(!sessionHost.includes('bearerToken'), 'session host must not expose credential getters')
assert(!credentialStore.includes('invoke.resolve(record.bearer)'), 'credential store must not return raw bearer values')
assert(!packManager.includes('print('), 'pack manager must not log catalog or cache state')

console.log('iOS native voice session source policy passed')
