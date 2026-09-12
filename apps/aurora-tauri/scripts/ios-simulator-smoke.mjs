#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeIosScreenshot,
  assertIosScreenshotVisible,
} from './ios-screenshot-evidence.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = resolve(
  process.env.AURORA_IOS_SIMULATOR_REPORT ??
    join(packageRoot, 'reports', 'ios-simulator-smoke.json'),
)
const screenshotPath = resolve(
  process.env.AURORA_IOS_SIMULATOR_SCREENSHOT ??
    join(packageRoot, 'reports', 'ios-simulator-smoke.png'),
)
const logPath = resolve(
  process.env.AURORA_IOS_SIMULATOR_LOG ??
    join(packageRoot, 'reports', 'ios-simulator-smoke.log'),
)
const startedAt = Date.now()
let selectedDevice = null
let bundleId = ''
let launchedPid = null
let bootedByHarness = false
let appPath = ''
let capturedLog = ''
let screenshotEvidence = null
let launchAttempts = 0

if (process.argv.includes('--print-app-path')) {
  process.stdout.write(`${resolveSimulatorApp()}\n`)
  process.exit(0)
}

try {
  appPath = resolveSimulatorApp()
  selectedDevice = selectSimulatorDevice(
    JSON.parse(
      runCapture('xcrun', ['simctl', 'list', 'devices', 'available', '-j']),
    ),
    process.env.AURORA_IOS_SIMULATOR_UDID,
  )

  if (selectedDevice.state !== 'Booted') {
    run('xcrun', ['simctl', 'boot', selectedDevice.udid])
    bootedByHarness = true
  }
  run('xcrun', ['simctl', 'bootstatus', selectedDevice.udid, '-b'])

  bundleId = runCapture('plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    join(appPath, 'Info.plist'),
  ]).trim()
  if (!bundleId) throw new Error('Built simulator app has no CFBundleIdentifier')

  run('xcrun', ['simctl', 'install', selectedDevice.udid, appPath])
  const maxLaunchAttempts = Math.max(
    1,
    Math.trunc(
      readNonNegativeDuration('AURORA_IOS_SIMULATOR_LAUNCH_ATTEMPTS', 2),
    ),
  )
  let renderError = null
  for (let attempt = 1; attempt <= maxLaunchAttempts; attempt += 1) {
    launchAttempts = attempt
    const launchOutput = runCapture('xcrun', [
      'simctl',
      'launch',
      selectedDevice.udid,
      bundleId,
    ])
    launchedPid = parseLaunchPid(launchOutput, bundleId)
    sleep(Number(process.env.AURORA_IOS_SIMULATOR_SETTLE_MS ?? 8_000))

    try {
      screenshotEvidence = captureVisibleScreenshot(selectedDevice.udid)
      renderError = null
      break
    } catch (error) {
      renderError = error instanceof Error ? error : new Error(String(error))
      capturedLog = collectProcessLog(selectedDevice.udid, launchedPid)
      assertNoCrashEvidence(capturedLog)
      if (attempt >= maxLaunchAttempts) throw renderError
      runBestEffort('xcrun', [
        'simctl',
        'terminate',
        selectedDevice.udid,
        bundleId,
      ])
      launchedPid = null
      sleep(Number(process.env.AURORA_IOS_SIMULATOR_RELAUNCH_SETTLE_MS ?? 2_000))
    }
  }
  if (renderError) throw renderError

  const appContainer = runCapture('xcrun', [
    'simctl',
    'get_app_container',
    selectedDevice.udid,
    bundleId,
    'app',
  ]).trim()
  if (!appContainer) throw new Error('simctl did not return an installed app container')

  capturedLog = collectProcessLog(selectedDevice.udid, launchedPid)
  assertNoCrashEvidence(capturedLog)

  // A successful terminate after the settle window proves the app remained alive.
  run('xcrun', ['simctl', 'terminate', selectedDevice.udid, bundleId])
  launchedPid = null

  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(logPath, capturedLog)
  writeAtomicJson(reportPath, {
    schema: 'aurora.ios-simulator-smoke.v1',
    status: 'passed',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    device: {
      name: selectedDevice.name,
      udid: selectedDevice.udid,
      runtime: selectedDevice.runtime,
    },
    appPath: redactedPath(appPath),
    bundleId,
    appStayedAliveThroughSettleWindow: true,
    launchAttempts,
    screenshotPath: redactedPath(screenshotPath),
    screenshotEvidence,
    logPath: redactedPath(logPath),
    pythonSidecarExpected: false,
    secretsRedacted: true,
  })
  console.log(`iOS simulator smoke passed for ${bundleId} on ${selectedDevice.name}`)
  console.log(`Report: ${reportPath}`)
} catch (error) {
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(logPath, capturedLog)
  writeAtomicJson(reportPath, {
    schema: 'aurora.ios-simulator-smoke.v1',
    status: 'failed',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    device: selectedDevice,
    appPath: appPath ? redactedPath(appPath) : null,
    bundleId: bundleId || null,
    launchedPid,
    launchAttempts,
    error: error instanceof Error ? error.message : String(error),
    screenshotPath: redactedPath(screenshotPath),
    screenshotEvidence,
    logPath: redactedPath(logPath),
    secretsRedacted: true,
  })
  throw error
} finally {
  if (launchedPid !== null && selectedDevice && bundleId) {
    runBestEffort('xcrun', [
      'simctl',
      'terminate',
      selectedDevice.udid,
      bundleId,
    ])
  }
  if (
    bootedByHarness &&
    selectedDevice &&
    process.env.AURORA_IOS_SIMULATOR_KEEP_BOOTED !== '1'
  ) {
    runBestEffort('xcrun', ['simctl', 'shutdown', selectedDevice.udid])
  }
}

function captureVisibleScreenshot(udid) {
  const timeoutMs = readNonNegativeDuration(
    'AURORA_IOS_SIMULATOR_RENDER_TIMEOUT_MS',
    20_000,
  )
  const retryMs = readNonNegativeDuration(
    'AURORA_IOS_SIMULATOR_SCREENSHOT_RETRY_MS',
    1_000,
  )
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let lastError = new Error('iOS simulator screenshot was not captured')

  mkdirSync(dirname(screenshotPath), { recursive: true })
  while (true) {
    attempts += 1
    try {
      run('xcrun', [
        'simctl',
        'io',
        udid,
        'screenshot',
        screenshotPath,
      ])
      if (!existsSync(screenshotPath) || statSync(screenshotPath).size === 0) {
        throw new Error('iOS simulator screenshot was not created')
      }
      screenshotEvidence = {
        ...analyzeIosScreenshot(screenshotPath),
        captureAttempts: attempts,
      }
      assertIosScreenshotVisible(
        screenshotEvidence,
        'iOS simulator screenshot',
      )
      return screenshotEvidence
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) throw lastError
    sleep(Math.min(retryMs || 1, remainingMs))
  }
}

function readNonNegativeDuration(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
  return value
}

function resolveSimulatorApp() {
  const configured = process.env.AURORA_IOS_SIMULATOR_APP
  if (configured) {
    const path = resolve(configured)
    assertSimulatorApp(path)
    return path
  }

  const root = resolve(
    process.env.AURORA_IOS_SIMULATOR_SEARCH_ROOT ??
      join(packageRoot, 'src-tauri', 'gen', 'apple'),
  )
  if (!existsSync(root)) {
    throw new Error(
      'Generated iOS build directory is missing; run the iOS simulator build first',
    )
  }
  const candidates = Array.from(walk(root))
    .filter((path) => path.endsWith('.app'))
    .sort((left, right) => {
      const thinDelta = Number(right.includes('aarch64-sim')) - Number(left.includes('aarch64-sim'))
      if (thinDelta !== 0) return thinDelta
      return statSync(right).mtimeMs - statSync(left).mtimeMs
    })
  const app = candidates[0]
  if (!app) throw new Error(`No .app simulator artifact found under ${root}`)
  assertSimulatorApp(app)
  return app
}

function assertSimulatorApp(path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`iOS simulator app does not exist: ${path}`)
  }
  if (!existsSync(join(path, 'Info.plist'))) {
    throw new Error(`iOS simulator app is missing Info.plist: ${path}`)
  }
}

function selectSimulatorDevice(listing, requestedUdid) {
  const candidates = Object.entries(listing.devices ?? {}).flatMap(
    ([runtime, devices]) =>
      (Array.isArray(devices) ? devices : [])
        .filter(
          (device) =>
            device?.isAvailable !== false &&
            device?.availabilityError == null,
        )
        .map((device) => ({ ...device, runtime })),
  )
  const requested = requestedUdid
    ? candidates.find((device) => device.udid === requestedUdid)
    : null
  if (requestedUdid && !requested) {
    throw new Error(
      `Requested iOS simulator ${requestedUdid} is not available`,
    )
  }
  if (requested) return requested

  const iphones = candidates.filter((device) =>
    String(device.name ?? '').startsWith('iPhone'),
  )
  const pool = iphones.length > 0 ? iphones : candidates
  pool.sort((left, right) => {
    const runtimeDelta = compareRuntime(right.runtime, left.runtime)
    if (runtimeDelta !== 0) return runtimeDelta
    const bootedDelta =
      Number(right.state === 'Booted') - Number(left.state === 'Booted')
    if (bootedDelta !== 0) return bootedDelta
    return String(right.name).localeCompare(String(left.name))
  })
  const selected = pool[0]
  if (!selected?.udid) throw new Error('No available iOS simulator was found')
  return selected
}

function compareRuntime(left, right) {
  const leftParts = runtimeVersion(left)
  const rightParts = runtimeVersion(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function runtimeVersion(runtime) {
  return String(runtime)
    .match(/iOS-(\d+(?:-\d+)*)$/)?.[1]
    ?.split('-')
    .map(Number) ?? [0]
}

function parseLaunchPid(output, expectedBundleId) {
  const match = output.match(
    new RegExp(`${escapeRegex(expectedBundleId)}:\\s*(\\d+)`),
  )
  if (!match) {
    throw new Error(
      `simctl launch did not return a process id for ${expectedBundleId}`,
    )
  }
  return Number(match[1])
}

function assertNoCrashEvidence(log) {
  const crashPatterns = [
    /Terminating app due to uncaught exception/i,
    /\bEXC_(?:CRASH|BAD_ACCESS)\b/i,
    /dyld: Library not loaded/i,
    /\bfatal error:/i,
  ]
  const matched = crashPatterns.find((pattern) => pattern.test(log))
  if (matched) {
    throw new Error(`iOS simulator log contains crash evidence matching ${matched}`)
  }
}

function collectProcessLog(udid, processId) {
  if (processId == null) return capturedLog
  return runCapture(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'show',
      '--style',
      'compact',
      '--last',
      '2m',
      '--predicate',
      `processIdentifier == ${processId}`,
    ],
    { allowFailure: true },
  )
}

function* walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app')) yield path
      else yield* walk(path)
    }
  }
}

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status}: ${result.stderr.trim()}`,
    )
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function runBestEffort(command, args) {
  spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
  })
}

function sleep(milliseconds) {
  if (milliseconds <= 0) return
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  )
}

function writeAtomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temporaryPath, path)
}

function redactedPath(path) {
  const absolute = resolve(path)
  const local = relative(packageRoot, absolute)
  if (!local.startsWith('..') && !isAbsolute(local)) return `<package-root>/${local}`
  return `<external>/${basename(absolute)}`
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
