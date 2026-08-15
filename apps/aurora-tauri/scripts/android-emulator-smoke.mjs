import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { connectAndroidWebviewCdp } from './android-webview-cdp.mjs'

const NATIVE_PAYLOAD_LOGCAT_ARGS = [
  'logcat',
  '-d',
  '-t',
  '2000',
  'RustStdoutStderr:I',
  '*:S',
]

const DEFAULT_DEVICE_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000

const adb = resolveAdbCommand()

export async function runAndroidEmulatorSmoke() {
  const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
  const apk = process.env.AURORA_ANDROID_APK ?? findApk()

  if (!apk) {
    throw new Error('No Android APK found. Run pnpm --filter @aurora/tauri-ui android:build:apk first.')
  }

  run(adb, ['wait-for-device'], {
    timeoutMs: resolvePositiveTimeout(
      process.env.AURORA_ANDROID_DEVICE_WAIT_TIMEOUT_MS,
      DEFAULT_DEVICE_WAIT_TIMEOUT_MS,
    ),
    timeoutCode: 'android_device_wait_timeout',
  })
  installApk(apk)
  run(adb, ['logcat', '-c'])
  launchApp(appId)
  dismissSystemUiAnrDialog()

  const payloadJson = waitForPayloadJson()
  if (!payloadJson) {
    throw new Error('Android native plugin payload log was not observed after app launch.')
  }
  const payload = validateNativePayload(payloadJson)
  const webview = await waitForWebviewMount(appId)
  assertNoWebviewConsoleErrors()

  console.log(`Installed APK: ${apk}`)
  console.log(`Launched package: ${appId}`)
  console.log(`Android native plugin payload bytes: ${Buffer.byteLength(payloadJson, 'utf8')}`)
  console.log(`Android native plugin payload platform: ${payload.platform}`)
  console.log(`Android WebView title: ${webview.title}`)
  console.log(`Android WebView rendered text bytes: ${Buffer.byteLength(webview.bodyText, 'utf8')}`)

  return {
    apk,
    appId,
    payload,
    payloadJson,
    webview,
  }
}

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

function run(command, args, { timeoutMs, timeoutCode = 'android_command_timeout' } = {}) {
  try {
    return execFileSync(command, args, {
      stdio: 'inherit',
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    })
  } catch (error) {
    if (timeoutMs !== undefined && error?.code === 'ETIMEDOUT') {
      throw new Error(`${timeoutCode}: adb command exceeded ${timeoutMs}ms`)
    }
    throw error
  }
}

function resolvePositiveTimeout(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function installApk(apk) {
  const remoteApk = `/data/local/tmp/aurora-smoke-${Date.now()}.apk`
  try {
    run(adb, ['push', apk, remoteApk])
    run(adb, ['shell', 'chmod', '644', remoteApk])
    run(adb, ['shell', 'pm', 'install', '-r', remoteApk], {
      timeoutMs: resolvePositiveTimeout(
        process.env.AURORA_ANDROID_INSTALL_TIMEOUT_MS,
        DEFAULT_INSTALL_TIMEOUT_MS,
      ),
      timeoutCode: 'android_install_timeout',
    })
  } finally {
    spawnSync(adb, ['shell', 'rm', '-f', remoteApk], { stdio: 'ignore' })
  }
}

function launchApp(appId) {
  try {
    run(adb, ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'])
  } catch {
    run(adb, ['shell', 'am', 'start', '-n', `${appId}/.MainActivity`])
  }
}

function dismissSystemUiAnrDialog() {
  const result = spawnSync(adb, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.error || result.status !== 0) return
  const output = `${result.stdout}\n${result.stderr}`
  if (!output.includes("System UI isn't responding")) return
  const wait = output.match(/text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
  if (!wait) return
  const [, left, top, right, bottom] = wait.map(Number)
  run(adb, ['shell', 'input', 'tap', String(Math.floor((left + right) / 2)), String(Math.floor((top + bottom) / 2))])
}

async function waitForWebviewMount(appId) {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_WEBVIEW_TIMEOUT_MS ?? 240_000)
  let lastState = null
  let lastError = null
  let lastAnrCheckAt = 0

  while (Date.now() < deadline) {
    const crashEvidence = recentAndroidCrashEvidence(appId)
    if (isFatalAndroidWebviewCrash(crashEvidence)) {
      throw new Error(
        `Android package ${appId} reported a fatal WebView renderer crash:\n${crashEvidence}`,
      )
    }
    if (Date.now() - lastAnrCheckAt > 5000) {
      dismissSystemUiAnrDialog()
      lastAnrCheckAt = Date.now()
    }
    const pid = adbOutput(['shell', 'pidof', appId], { allowPidofNoProcess: true }).trim().split(/\s+/)[0]
    if (!pid) {
      const crashEvidence = recentAndroidCrashEvidence(appId)
      lastError = new Error(
        crashEvidence
          ? `Android package ${appId} is not running. Recent crash evidence:\n${crashEvidence}`
          : `Android package ${appId} is not running.`,
      )
      await sleep(1000)
      continue
    }

    const socketName = `webview_devtools_remote_${pid}`
    const sockets = adbOutput(['shell', 'cat', '/proc/net/unix'])
    if (!sockets.includes(`@${socketName}`)) {
      await sleep(1000)
      continue
    }

    let port = null
    try {
      port = adbOutput(['forward', 'tcp:0', `localabstract:${socketName}`]).trim()
      const result = await inspectWebview(port, deadline)
      lastState = result.state
      if (result.state.rootChildren > 0 && result.state.bodyText.trim().length > 0) {
        return result.state
      }
      if (result.errors.length > 0) {
        lastError = new Error(result.errors.join('\n'))
      }
    } catch (error) {
      lastError = error
    } finally {
      if (port) {
        spawnSync(adb, ['forward', '--remove', `tcp:${port}`], { stdio: 'ignore' })
      }
    }

    await sleep(1000)
  }

  const state = lastState ? JSON.stringify(lastState) : '<unavailable>'
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? 'no CDP error was reported')
  throw new Error(
    `Android WebView did not mount the Aurora frontend before timeout. Last state: ${state}. CDP detail: ${detail}`,
  )
}

async function inspectWebview(port, deadline) {
  const errors = []
  const client = await connectAndroidWebviewCdp({
    port,
    onEvent(message) {
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails
        errors.push(details?.exception?.description ?? details?.text ?? 'Uncaught WebView exception')
      }
      if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        errors.push(message.params.entry.text)
      }
    },
  })

  try {
    await client.send('Runtime.enable')
    await client.send('Log.enable')

    let state = {
      url: client.target?.url ?? '',
      title: client.target?.title ?? '',
      readyState: 'loading',
      rootChildren: 0,
      bodyText: '',
      mainWidth: 0,
      mobileNavigationHeight: 0,
      mobileNavigationPaddingBottom: 0,
      mobileNavigationPosition: '',
    }
    let readySince = null
    const stabilityMs = Number(process.env.AURORA_ANDROID_WEBVIEW_STABILITY_MS ?? 10_000)

    while (Date.now() < deadline) {
      const response = await client.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
          bodyText: document.body?.innerText ?? '',
          mainWidth: document.querySelector('main#content, main')?.getBoundingClientRect().width
            ?? document.documentElement.clientWidth
            ?? 0,
          mobileNavigationHeight: document.querySelector('[aria-label="Mobile navigation"]')?.getBoundingClientRect().height ?? 0,
          mobileNavigationPaddingBottom: (() => {
            const navigation = document.querySelector('[aria-label="Mobile navigation"]')
            return navigation ? Number.parseFloat(getComputedStyle(navigation).paddingBottom) : 0
          })(),
          mobileNavigationPosition: (() => {
            const navigation = document.querySelector('[aria-label="Mobile navigation"]')
            return navigation ? getComputedStyle(navigation).position : ''
          })()
        })`,
        returnByValue: true,
        awaitPromise: true,
      })
      const value = response.result?.result?.value
      if (typeof value === 'string') {
        state = JSON.parse(value)
      }
      if (errors.length > 0) {
        return { state, errors }
      }
      if (isStableAuroraWebviewState(state)) {
        readySince ??= Date.now()
        if (Date.now() - readySince >= stabilityMs) {
          return { state, errors }
        }
      } else {
        readySince = null
      }
      await sleep(500)
    }

    return { state, errors }
  } finally {
    client.close()
  }
}

function assertNoWebviewConsoleErrors() {
  const output = adbOutput(['logcat', '-d', '-t', '2000'])
  const errors = output
    .split(/\r?\n/)
    .filter((line) => /\sE\s+Tauri\/Console:/.test(line))
  if (errors.length > 0) {
    throw new Error(`Android WebView reported console errors:\n${errors.join('\n')}`)
  }
}

function hasAuroraReadyText(bodyText) {
  return bodyText.includes('Text chat with Aurora')
    || bodyText.includes('Set up Aurora on this device')
}

function isStableAuroraWebviewState(state) {
  if (state.rootChildren <= 0 || !hasAuroraReadyText(state.bodyText) || state.mainWidth < 300) {
    return false
  }
  if (state.bodyText.includes('Set up Aurora on this device')) return true
  return state.mobileNavigationHeight >= 40
    && state.mobileNavigationHeight <= 128
    && state.mobileNavigationPaddingBottom >= 40
    && state.mobileNavigationPosition === 'fixed'
}

function adbOutput(args, { allowPidofNoProcess = false } = {}) {
  const result = spawnSync(adb, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (allowPidofNoProcess && isPidofNoProcessResult(args, result)) return result.stdout
    throw new Error(`${adb} ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`)
  }
  return result.stdout
}

function isPidofNoProcessResult(args, result) {
  return args[0] === 'shell'
    && args[1] === 'pidof'
    && args.length === 3
    && result.status === 1
    && result.stdout.trim() === ''
    && result.stderr.trim() === ''
}

function recentAndroidCrashEvidence(appId) {
  const result = spawnSync(adb, ['logcat', '-d', '-t', '300'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return ''

  return `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((line) => {
      const lower = line.toLowerCase()
      return line.includes(appId)
        || line.includes('FATAL EXCEPTION')
        || line.includes('AndroidRuntime')
        || lower.includes('force finishing')
        || lower.includes('has died')
        || lower.includes('crashpad_client_linux')
        || lower.includes('render process')
        || (lower.includes('chromium') && lower.includes('fatal'))
    })
    .slice(-40)
    .join('\n')
    .trim()
}

function isFatalAndroidWebviewCrash(evidence) {
  const lower = evidence.toLowerCase()
  return lower.includes('crashpad_client_linux')
    || lower.includes('render process')
    || (lower.includes('chromium') && lower.includes('fatal'))
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

function waitForPayloadJson() {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_SMOKE_TIMEOUT_MS ?? 60_000)
  while (Date.now() < deadline) {
    const logcat = spawnSync(adb, NATIVE_PAYLOAD_LOGCAT_ARGS, { encoding: 'utf8' })
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
    if (candidate === 'adb') return spawnSync(candidate, ['version'], { stdio: 'ignore' }).status === 0
    return existsSync(candidate) && spawnSync(candidate, ['version'], { stdio: 'ignore' }).status === 0
  }) ?? 'adb'
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
    'aurora.android.secureStorage',
    'aurora.android.adminUnlock',
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
    'android.secureCredentialStorage',
    'android.adminUnlock',
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

  const secureStorage = payload.secureStorage
  if (!secureStorage || typeof secureStorage !== 'object') {
    throw new Error('Android native plugin payload is missing secureStorage.')
  }
  if (secureStorage.backend !== 'android-keystore' || secureStorage.persisted !== true || secureStorage.secretsRedacted !== true) {
    throw new Error('Android secureStorage must report android-keystore, persisted=true, and secretsRedacted=true.')
  }

  const adminUnlock = payload.adminUnlock
  if (!adminUnlock || typeof adminUnlock !== 'object') {
    throw new Error('Android native plugin payload is missing adminUnlock.')
  }
  for (const field of ['available', 'requestable', 'deviceSecure', 'biometricReady', 'lastDenied', 'secretsRedacted']) {
    if (typeof adminUnlock[field] !== 'boolean') {
      throw new Error(`Android adminUnlock.${field} must be a boolean.`)
    }
  }
  assertNativeState('adminUnlock.state', adminUnlock.state)
  if (adminUnlock.privacyClass !== 'admin-critical') {
    throw new Error('Android adminUnlock.privacyClass must be admin-critical.')
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

const invokedAsScript =
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  await runAndroidEmulatorSmoke()
}
