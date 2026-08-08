import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(testDir, '..', '..')
const sourceRoot = resolve(packageRoot, 'Sources', 'AuroraNativePlugin')
const sessionHost = readFileSync(resolve(sourceRoot, 'AuroraIOSVoiceSessionHost.swift'), 'utf8')
const capture = readFileSync(resolve(sourceRoot, 'AuroraIOSVoiceCapture.swift'), 'utf8')
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
assert(sessionHost.includes('capture = nil'), 'session host must destroy borrowed audio before Rust free')
assert(sessionHost.includes('remoteAudioConsent'), 'session host must preserve explicit remote consent')
assert(
  plugin.includes('nativeTurnTransportAvailable = false'),
  'public iOS capability must remain withheld until runtime evidence exists',
)
assert(!sessionHost.includes('print('), 'session host must not log credentials or audio state')
assert(!sessionHost.includes('bearerToken'), 'session host must not expose credential getters')

console.log('iOS native voice session source policy passed')
