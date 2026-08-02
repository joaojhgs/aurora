import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runAndroidEmulatorSmoke() {
  const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
  const apk = process.env.AURORA_ANDROID_APK ?? findApk()

  if (!apk) {
    throw new Error('No Android APK found. Run pnpm --filter @aurora/tauri-ui android:build:apk first.')
  }

  run('adb', ['wait-for-device'])
  run('adb', ['install', '-r', apk])
  run('adb', ['logcat', '-c'])
  launchApp(appId)

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

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function launchApp(appId) {
  try {
    run('adb', ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'])
  } catch {
    run('adb', ['shell', 'am', 'start', '-n', `${appId}/.MainActivity`])
  }
}

async function waitForWebviewMount(appId) {
  const deadline = Date.now() + Number(process.env.AURORA_ANDROID_WEBVIEW_TIMEOUT_MS ?? 90_000)
  let lastState = null
  let lastError = null

  while (Date.now() < deadline) {
    const pid = adbOutput(['shell', 'pidof', appId]).trim().split(/\s+/)[0]
    if (!pid) {
      lastError = new Error(`Android package ${appId} is not running.`)
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
        spawnSync('adb', ['forward', '--remove', `tcp:${port}`], { stdio: 'ignore' })
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
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(5000),
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`Android WebView DevTools target lookup returned HTTP ${response.status}.`)
    }
    return response.json()
  })
  const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  if (!target) {
    throw new Error('Android WebView DevTools did not expose a page target.')
  }

  const errors = []
  const client = await connectCdp(target.webSocketDebuggerUrl, (message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails
      errors.push(details?.exception?.description ?? details?.text ?? 'Uncaught WebView exception')
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      errors.push(message.params.entry.text)
    }
  })

  try {
    await client.send('Runtime.enable')
    await client.send('Log.enable')

    let state = {
      url: target.url ?? '',
      title: target.title ?? '',
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
          mainWidth: document.querySelector('main#content')?.getBoundingClientRect().width ?? 0,
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
      if (
        state.rootChildren > 0
        && state.bodyText.includes('Text chat with Aurora')
        && state.mainWidth >= 300
        && state.mobileNavigationHeight >= 40
        && state.mobileNavigationHeight <= 128
        && state.mobileNavigationPaddingBottom >= 40
        && state.mobileNavigationPosition === 'fixed'
      ) {
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

async function connectCdp(url, onEvent) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let sequence = 0

  await new Promise((resolvePromise, rejectPromise) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', rejectPromise, { once: true })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const resolvePromise = pending.get(message.id)
      pending.delete(message.id)
      resolvePromise(message)
      return
    }
    onEvent(message)
  })

  return {
    send(method, params = {}) {
      const id = ++sequence
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(new Error(`Android WebView CDP command timed out: ${method}`))
        }, 5000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          if (message.error) {
            rejectPromise(new Error(`Android WebView CDP ${method} failed: ${message.error.message}`))
            return
          }
          resolvePromise(message)
        })
      })
    },
    close() {
      socket.close()
    },
  }
}

function adbOutput(args) {
  const result = spawnSync('adb', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`)
  }
  return result.stdout
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
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
