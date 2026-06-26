import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
const apk = process.env.AURORA_ANDROID_APK ?? findApk()

if (!apk) {
  throw new Error('No Android APK found. Run pnpm --filter @aurora/tauri-ui android:build:apk first.')
}

run('adb', ['wait-for-device'])
run('adb', ['install', '-r', apk])
run('adb', ['logcat', '-c'])
run('adb', ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'])

const payloadJson = waitForPayloadJson()
if (!payloadJson) {
  throw new Error('Android native plugin payload log was not observed after app launch.')
}
const payload = validateNativePayload(payloadJson)

console.log(`Installed APK: ${apk}`)
console.log(`Launched package: ${appId}`)
console.log(`Android native plugin payload bytes: ${Buffer.byteLength(payloadJson, 'utf8')}`)
console.log(`Android native plugin payload platform: ${payload.platform}`)

function findApk() {
  const roots = [
    'src-tauri/gen/android/app/build/outputs/apk/universal/debug',
    'src-tauri/gen/android/app/build/outputs/apk/universal/release',
    'src-tauri/gen/android/app/build/outputs/apk'
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    const found = walk(root).find((path) => path.endsWith('.apk') && !path.endsWith('-unsigned.apk'))
    if (found) return found
  }
  return null
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function waitForPayloadJson() {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_SMOKE_TIMEOUT_MS ?? 60_000)
  while (Date.now() < deadline) {
    const logcat = spawnSync('adb', ['logcat', '-d', '-t', '2000'], { encoding: 'utf8' })
    if (logcat.error) {
      throw logcat.error
    }
    const output = `${logcat.stdout}\n${logcat.stderr}`
    const payload = extractChunkedPayload(output) ?? extractLegacyPayload(output)
    if (payload) return payload
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000)
  }
  return null
}

function extractChunkedPayload(output) {
  const lines = output.split(/\r?\n/)
  const beginPattern = /aurora_android_native_plugin_payload_begin chunks=(\d+) bytes=(\d+)/
  const chunkPattern = /aurora_android_native_plugin_payload_chunk index=(\d+) total=(\d+) data=(.*)$/
  const endPattern = /aurora_android_native_plugin_payload_end chunks=(\d+)/

  let expectedChunks = null
  let expectedBytes = null
  let endObserved = false
  const chunks = new Map()

  for (const line of lines) {
    const begin = line.match(beginPattern)
    if (begin) {
      expectedChunks = Number(begin[1])
      expectedBytes = Number(begin[2])
      endObserved = false
      chunks.clear()
      continue
    }

    const chunk = line.match(chunkPattern)
    if (chunk && expectedChunks !== null) {
      const index = Number(chunk[1])
      const total = Number(chunk[2])
      if (total === expectedChunks && index >= 0 && index < expectedChunks) {
        chunks.set(index, chunk[3])
      }
      continue
    }

    const end = line.match(endPattern)
    if (end && expectedChunks !== null && Number(end[1]) === expectedChunks) {
      endObserved = true
    }
  }

  if (expectedChunks === null || !endObserved || chunks.size !== expectedChunks) {
    return null
  }

  const payload = Array.from({ length: expectedChunks }, (_, index) => chunks.get(index) ?? '').join('')
  if (expectedBytes !== null && Buffer.byteLength(payload, 'utf8') !== expectedBytes) {
    throw new Error(
      `Android native plugin payload byte count mismatch: expected ${expectedBytes}, got ${Buffer.byteLength(payload, 'utf8')}.`
    )
  }
  return payload
}

function extractLegacyPayload(output) {
  const marker = 'aurora_android_native_plugin_payload='
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.includes(marker))
  if (!line) return null
  return line.slice(line.indexOf(marker) + marker.length)
}

function validateNativePayload(payloadJson) {
  const payload = JSON.parse(payloadJson)
  const assistantRole = payload.assistantRole
  if (!assistantRole || typeof assistantRole !== 'object') {
    throw new Error('Android native plugin payload is missing assistantRole.')
  }

  if (payload.platform !== 'android') {
    throw new Error(`Android native plugin payload platform must be android, got ${String(payload.platform)}.`)
  }

  for (const field of [
    'sdkSupportsRole',
    'handlesAssistActivity',
    'declaresVoiceInteractionService',
    'roleAvailable',
    'packageQualified',
    'roleHeld',
    'requestable',
    'denied',
    'oemUnavailable'
  ]) {
    if (typeof assistantRole[field] !== 'boolean') {
      throw new Error(`Android native plugin assistantRole.${field} must be a boolean.`)
    }
  }
  if (assistantRole.packageQualified && (!assistantRole.handlesAssistActivity || !assistantRole.declaresVoiceInteractionService)) {
    throw new Error('Android assistant role packageQualified requires both ASSIST activity and VoiceInteractionService evidence.')
  }
  if (assistantRole.requestable && (!assistantRole.roleAvailable || !assistantRole.packageQualified || assistantRole.roleHeld)) {
    throw new Error('Android assistant role requestable must imply roleAvailable, packageQualified, and not roleHeld.')
  }

  assertStateMap('permissionStates', payload.permissionStates, [
    'aurora.android.assistantRoleRequest',
    'aurora.android.assistantRoleStatus',
    'aurora.android.microphone',
    'aurora.android.notifications',
    'aurora.android.biometric',
    'aurora.android.localNetwork',
    'aurora.android.foregroundServiceMicrophone',
    'aurora.android.filePick',
    'aurora.android.shareIntent',
    'aurora.android.deepLink',
    'aurora.android.appWidget',
    'aurora.android.appShortcut',
    'aurora.android.quickTile',
    'aurora.android.entrypointPayload'
  ])
  assertStateMap('capabilityStates', payload.capabilityStates, [
    'android.assistantRole.available',
    'android.assistantRole.packageQualified',
    'android.assistantRole.held',
    'android.assistantRole.request',
    'android.assistantRole.denied',
    'android.assistantRole.oemUnavailable',
    'android.microphoneCapture',
    'android.notifications',
    'android.biometric',
    'android.localNetwork',
    'android.foregroundService',
    'android.filePick',
    'android.shareIntent',
    'android.deepLink',
    'android.appWidget',
    'android.appShortcut',
    'android.quickTile',
    'android.entrypointPayload',
    'android.fallbackEntrypoints'
  ])

  if (!Array.isArray(payload.fallbackEntrypoints) || payload.fallbackEntrypoints.length === 0) {
    throw new Error('Android native plugin payload is missing fallbackEntrypoints.')
  }
  for (const entry of payload.fallbackEntrypoints) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('Android native plugin fallbackEntrypoints entries must be objects.')
    }
    if (typeof entry.id !== 'string' || typeof entry.available !== 'boolean' || typeof entry.capability !== 'string') {
      throw new Error('Android native plugin fallbackEntrypoints entries must include id, available, and capability.')
    }
    assertNativeState(`fallbackEntrypoints.${entry.id}.state`, entry.state)
  }
  assertRequiredEntry(payload.fallbackEntrypoints, 'share_intent')
  assertRequiredEntry(payload.fallbackEntrypoints, 'deep_link')
  assertRequiredEntry(payload.fallbackEntrypoints, 'app_widget')
  assertRequiredEntry(payload.fallbackEntrypoints, 'app_shortcut')
  assertRequiredEntry(payload.fallbackEntrypoints, 'quick_tile')

  if (!Array.isArray(payload.entrypoints) || payload.entrypoints.length === 0) {
    throw new Error('Android native plugin payload is missing entrypoints.')
  }
  for (const entrypoint of payload.entrypoints) {
    if (!entrypoint || typeof entrypoint !== 'object') {
      throw new Error('Android native plugin entrypoints entries must be objects.')
    }
    for (const field of ['id', 'label', 'capability', 'permission', 'intentAction', 'payloadCommand']) {
      if (typeof entrypoint[field] !== 'string') {
        throw new Error(`Android native plugin entrypoint.${field} must be a string.`)
      }
    }
    if (typeof entrypoint.available !== 'boolean' || typeof entrypoint.manifestDeclared !== 'boolean' || typeof entrypoint.backendRequired !== 'boolean') {
      throw new Error('Android native plugin entrypoints must include available, manifestDeclared, and backendRequired booleans.')
    }
    assertNativeState(`entrypoints.${entrypoint.id}.state`, entrypoint.state)
  }
  assertRequiredEntry(payload.entrypoints, 'share_sheet')
  assertRequiredEntry(payload.entrypoints, 'deep_link')
  assertRequiredEntry(payload.entrypoints, 'quick_tile')

  if (!Array.isArray(payload.mobileIntegrations) || payload.mobileIntegrations.length === 0) {
    throw new Error('Android native plugin payload is missing mobileIntegrations.')
  }
  assertRequiredEntry(payload.mobileIntegrations, 'androidShareSheet')
  assertRequiredEntry(payload.mobileIntegrations, 'androidDeepLinks')
  assertRequiredEntry(payload.mobileIntegrations, 'androidWidget')
  assertRequiredEntry(payload.mobileIntegrations, 'androidQuickTile')

  const lastEntrypointPayload = payload.lastEntrypointPayload
  if (!lastEntrypointPayload || typeof lastEntrypointPayload !== 'object') {
    throw new Error('Android native plugin payload is missing lastEntrypointPayload.')
  }
  if (lastEntrypointPayload.secretsRedacted !== true) {
    throw new Error('Android native plugin lastEntrypointPayload must be redacted.')
  }
  for (const field of ['categories', 'extras']) {
    if (!Array.isArray(lastEntrypointPayload[field])) {
      throw new Error(`Android native plugin lastEntrypointPayload.${field} must be an array.`)
    }
  }

  if (assistantRole.roleHeld === false) {
    const availableFallback = payload.fallbackEntrypoints.some((entry) => entry?.available === true)
    if (!availableFallback) {
      throw new Error('Android native plugin payload must keep fallback entrypoints available when roleHeld=false.')
    }
  }

  return payload
}

function assertRequiredEntry(entries, id) {
  if (!entries.some((entry) => entry?.id === id)) {
    throw new Error(`Android native plugin payload is missing entry ${id}.`)
  }
}

function assertStateMap(label, value, requiredKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Android native plugin payload is missing ${label}.`)
  }
  for (const key of requiredKeys) {
    assertNativeState(`${label}.${key}`, value[key])
  }
}

function assertNativeState(label, value) {
  const allowed = ['available', 'needs_native_permission', 'unsupported_platform', 'degraded', 'fallback']
  if (!allowed.includes(value)) {
    throw new Error(`Android native plugin ${label} must be one of ${allowed.join(', ')}.`)
  }
}
