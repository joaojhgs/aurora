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
const plugin = readFileSync(resolve(sourceRoot, 'AuroraNativePlugin.swift'), 'utf8')
const header = readFileSync(
  resolve(packageRoot, 'Sources', 'CAuroraIOSVoiceBridge', 'include', 'aurora_ios_voice_bridge.h'),
  'utf8',
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

for (const symbol of [
  'aurora_ios_voice_session_new',
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
assert(plugin.includes('voiceCredentialSet'), 'native plugin must expose credential provisioning')
assert(plugin.includes('voiceCredentialDelete'), 'native plugin must expose credential deletion')
assert(plugin.includes('voiceCredentialStatus'), 'native plugin must expose redacted credential status')
assert(plugin.includes('AuroraIOSVoiceSessionHost('), 'foreground start must construct the Rust session host')
assert(plugin.includes('voiceSession?.cancel'), 'foreground stop must cancel the Rust session generation')
assert(plugin.includes('voiceForegroundCaptureFinish'), 'foreground PTT must expose a finish command')
assert(plugin.includes('session.finish(generation: generation)'), 'finish must complete the Rust generation')
assert(plugin.includes('voiceSessionGeneration'), 'foreground lifecycle must retain generation identity')
for (const notification of [
  'AVAudioSession.interruptionNotification',
  'AVAudioSession.routeChangeNotification',
  'AVAudioSession.mediaServicesWereResetNotification',
]) {
  assert(sessionHost.includes(notification), `session host must observe ${notification}`)
}
assert(sessionHost.includes('cancelForLifecycleChange'), 'audio lifecycle changes must cancel the Rust generation')
assert(sessionHost.includes('removeLifecycleObservers'), 'audio lifecycle observers must be removed on teardown')
assert(sessionHost.includes('object: audioSession'), 'lifecycle observers must be scoped to Aurora audio session')
assert(playback.includes('aurora_ios_audio_output_drain'), 'playback must drain Rust-owned output')
assert(playback.includes('aurora_ios_audio_output_acknowledge'), 'playback must acknowledge consumed output')
assert(playback.includes('AVAudioPlayerNode'), 'playback must use native AVAudioPlayerNode')
assert(playback.includes('aurora_ios_audio_output_close'), 'playback must close output on stop')
assert(playback.includes('chunkInFlight'), 'playback must acknowledge one chunk before draining another')
assert(
  plugin.includes('nativeTurnTransportAvailable = false'),
  'public iOS capability must remain withheld until runtime evidence exists',
)
assert(!sessionHost.includes('print('), 'session host must not log credentials or audio state')
assert(!sessionHost.includes('bearerToken'), 'session host must not expose credential getters')
assert(!credentialStore.includes('invoke.resolve(record.bearer)'), 'credential store must not return raw bearer values')

console.log('iOS native voice session source policy passed')
