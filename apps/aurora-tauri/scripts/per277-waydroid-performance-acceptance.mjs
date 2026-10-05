import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { connectAndroidWebviewCdp } from './android-webview-cdp.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const defaultReportPath = resolve(appDir, 'reports/per277-waydroid-performance-acceptance.json')
const DEFAULT_APP_ID = 'dev.aurora.desktop'
const DEFAULT_TIMEOUT_MS = 240_000
const DEFAULT_STABLE_FRAMES = 4
const DEFAULT_ROUTES = [
  { id: 'assistant', href: '/', landmark: 'Text chat' },
  { id: 'mesh', href: '/mesh', landmark: 'Connected devices' },
  { id: 'settings', href: '/settings', landmark: 'Settings' },
]

export async function runPer277WaydroidPerformanceAcceptance(options = {}) {
  const adb = resolveAdbCommand(options.adb)
  const serial = resolveAndroidDeviceSerial(adbDevices(adb), options.serial ?? process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL)
  const appId = nonEmptyString(options.appId ?? process.env.AURORA_ANDROID_APP_ID, DEFAULT_APP_ID)
  const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.PER277_WAYDROID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const stableFrames = positiveInteger(options.stableFrames ?? process.env.PER277_WAYDROID_STABLE_FRAMES, DEFAULT_STABLE_FRAMES)
  const reportPath = resolve(String(options.reportPath ?? process.env.PER277_WAYDROID_PERFORMANCE_REPORT ?? defaultReportPath))
  const minimumNavFps = optionalPositiveNumber(options.minimumNavFps ?? process.env.PER277_WAYDROID_MIN_NAV_FPS)
  const maximumRouteInteractiveMs = optionalPositiveNumber(options.maximumRouteInteractiveMs ?? process.env.PER277_WAYDROID_MAX_ROUTE_INTERACTIVE_MS)
  const routes = normalizeRoutes(options.routes ?? process.env.PER277_WAYDROID_ROUTES)
  const deadline = Date.now() + timeoutMs
  const device = readAndroidDeviceMetadata(adb, serial)
  assertWaydroidDevice(device)

  const launch = launchApp(adb, serial, appId)
  const webview = await connectToRunningWebview({ adb, serial, appId, deadline })
  let cdp = webview.client
  const observations = []
  try {
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    const home = await waitForInteractive(cdp, {
      route: routes[0],
      deadline,
      stableFrames,
      phase: 'cold-home',
    })
    observations.push({ routeId: routes[0].id, href: routes[0].href, phase: 'cold-home', ...home })

    for (const route of routes.slice(1)) {
      const measurement = await measureRouteNavigation(cdp, { route, deadline, stableFrames })
      observations.push(measurement)
    }
  } finally {
    cdp?.close()
    if (webview.forwardedPort) removeForward(adb, serial, webview.forwardedPort)
  }

  const report = buildWaydroidPerformanceReport({
    appId,
    device,
    launch,
    observations,
    budgets: { minimumNavFps, maximumRouteInteractiveMs },
  })
  await writeJsonReport(reportPath, report)
  if (!report.ok) throw new Error(`PER-277 Waydroid performance acceptance failed: ${report.errors.join('; ')}`)
  return report
}

export function parseAdbDevices(output) {
  return String(output ?? '')
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('*'))
    .map((line) => {
      const [serial, state = '', ...details] = line.split(/\s+/u)
      return { serial, state, details: details.join(' '), line }
    })
    .filter((device) => device.serial && device.state === 'device')
}

export function resolveAndroidDeviceSerial(devicesOutput, explicitSerial) {
  const devices = Array.isArray(devicesOutput) ? devicesOutput : parseAdbDevices(devicesOutput)
  const requested = typeof explicitSerial === 'string' ? explicitSerial.trim() : ''
  if (requested) {
    if (!devices.some((device) => device.serial === requested)) {
      throw new Error(`Android device ${requested} is not connected or authorized.`)
    }
    return requested
  }
  const waydroid = devices.filter((device) => /waydroid/iu.test(device.line))
  if (waydroid.length === 1) return waydroid[0].serial
  if (waydroid.length > 1) throw new Error(`More than one Waydroid device is connected: ${waydroid.map((device) => device.serial).join(', ')}`)
  if (devices.length === 0) throw new Error('No authorized Android device is connected.')
  throw new Error('No Waydroid device could be selected; set AURORA_ANDROID_DEVICE_SERIAL or ANDROID_SERIAL explicitly.')
}

export function calculateFrameMetrics(samples, durationMs) {
  const deltas = samples
    .map((sample) => Number(sample.deltaMs))
    .filter((value) => Number.isFinite(value) && value >= 0)
  const frames = deltas.length
  const averageFps = durationMs > 0 ? frames / (durationMs / 1000) : 0
  const sorted = [...deltas].sort((a, b) => a - b)
  return {
    frames,
    averageFps: round(averageFps),
    droppedFrameCount: deltas.filter((delta) => delta > 50).length,
    maxFrameDeltaMs: round(Math.max(0, ...deltas)),
    p95FrameDeltaMs: round(percentile(sorted, 0.95)),
  }
}

export function buildWaydroidPerformanceReport({ appId, device, launch, observations, budgets }) {
  const errors = []
  if (device.deviceClass !== 'waydroid') errors.push(`expected Waydroid device, received ${device.deviceClass}`)
  for (const observation of observations) {
    if (!observation.interactive) errors.push(`${observation.routeId} did not become interactive`)
    if (typeof budgets.minimumNavFps === 'number' && observation.phase === 'navigation' && observation.frameMetrics.averageFps < budgets.minimumNavFps) {
      errors.push(`${observation.routeId} average FPS ${observation.frameMetrics.averageFps} below PER277_WAYDROID_MIN_NAV_FPS=${budgets.minimumNavFps}`)
    }
    if (typeof budgets.maximumRouteInteractiveMs === 'number' && observation.phase === 'navigation' && observation.interactiveMs > budgets.maximumRouteInteractiveMs) {
      errors.push(`${observation.routeId} interactive ${observation.interactiveMs}ms exceeded PER277_WAYDROID_MAX_ROUTE_INTERACTIVE_MS=${budgets.maximumRouteInteractiveMs}ms`)
    }
  }
  return {
    ok: errors.length === 0,
    scenario: 'per277-waydroid-interactive-frame-timing',
    appId,
    device,
    launch,
    observations,
    budgets: {
      minimumNavFps: budgets.minimumNavFps ?? null,
      maximumRouteInteractiveMs: budgets.maximumRouteInteractiveMs ?? null,
    },
    errors,
    generatedAt: new Date().toISOString(),
    secretsRedacted: true,
  }
}

async function measureRouteNavigation(client, { route, deadline, stableFrames }) {
  await client.send('Runtime.evaluate', {
    expression: frameSamplerExpression('per277StartFrameSampler'),
    awaitPromise: true,
    returnByValue: true,
  })
  const startedAt = performance.now()
  await client.send('Runtime.evaluate', {
    expression: navigationExpression(route.href),
    awaitPromise: true,
    returnByValue: true,
  })
  const interactive = await waitForInteractive(client, { route, deadline, stableFrames, phase: 'navigation' })
  const finishedAt = performance.now()
  const frameSamples = await readFrameSamples(client)
  const durationMs = round(finishedAt - startedAt)
  return {
    routeId: route.id,
    href: route.href,
    phase: 'navigation',
    interactive: interactive.interactive,
    interactiveMs: durationMs,
    document: interactive.document,
    frameMetrics: calculateFrameMetrics(frameSamples, durationMs),
  }
}

async function waitForInteractive(client, { route, deadline, stableFrames, phase }) {
  let stable = 0
  let last = null
  while (Date.now() < deadline) {
    const state = await evaluateJson(client, interactiveExpression(route))
    last = state
    if (state.readyState === 'complete' && state.rootChildren > 0 && state.mainVisible && state.routeMatches && state.landmarkPresent) {
      stable += 1
      if (stable >= stableFrames) {
        return {
          interactive: true,
          phase,
          document: state,
        }
      }
    } else {
      stable = 0
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${route.id} to become interactive. Last state: ${JSON.stringify(last)}`)
}

async function connectToRunningWebview({ adb, serial, appId, deadline }) {
  let lastError = null
  while (Date.now() < deadline) {
    const pid = adbOutput(adb, serial, ['shell', 'pidof', appId], { allowFailure: true }).trim().split(/\s+/u)[0]
    if (!pid) {
      lastError = new Error(`Android package ${appId} is not running.`)
      await delay(500)
      continue
    }
    const socketName = `webview_devtools_remote_${pid}`
    const sockets = adbOutput(adb, serial, ['shell', 'cat', '/proc/net/unix'], { allowFailure: true })
    if (!sockets.includes(`@${socketName}`)) {
      lastError = new Error(`WebView DevTools socket ${socketName} is not ready.`)
      await delay(500)
      continue
    }
    let forwardedPort = null
    try {
      forwardedPort = adbOutput(adb, serial, ['forward', 'tcp:0', `localabstract:${socketName}`]).trim()
      const client = await connectAndroidWebviewCdp({ port: forwardedPort })
      return { client, forwardedPort }
    } catch (error) {
      lastError = error
      if (forwardedPort) removeForward(adb, serial, forwardedPort)
      await delay(500)
    }
  }
  throw lastError ?? new Error('Timed out waiting for Android WebView CDP connection.')
}

function launchApp(adb, serial, appId) {
  adbOutput(adb, serial, ['shell', 'am', 'force-stop', appId], { allowFailure: true })
  const startedAt = performance.now()
  let raw = ''
  try {
    raw = adbOutput(adb, serial, ['shell', 'am', 'start', '-W', '-n', `${appId}/.MainActivity`])
  } catch {
    raw = adbOutput(adb, serial, ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'])
  }
  return {
    hostLaunchCommandMs: round(performance.now() - startedAt),
    amStartTotalTimeMs: parseAmStartMetric(raw, 'TotalTime'),
    amStartWaitTimeMs: parseAmStartMetric(raw, 'WaitTime'),
    raw: redactAdbOutput(raw),
  }
}

function parseAmStartMetric(output, name) {
  const match = new RegExp(`^${name}:\\s*(\\d+)`, 'mu').exec(String(output ?? ''))
  return match ? Number(match[1]) : null
}

function readAndroidDeviceMetadata(adb, serial) {
  const line = parseAdbDevices(adbDevices(adb)).find((device) => device.serial === serial)?.line ?? serial
  const release = adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.release'], { allowFailure: true }).trim()
  const sdk = adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.sdk'], { allowFailure: true }).trim()
  const abi = adbOutput(adb, serial, ['shell', 'getprop', 'ro.product.cpu.abi'], { allowFailure: true }).trim()
  const webview = adbOutput(adb, serial, ['shell', 'dumpsys', 'webviewupdate'], { allowFailure: true }).split('\n').slice(0, 12).join('\n')
  return {
    serial,
    deviceClass: /waydroid/iu.test(line) ? 'waydroid' : 'android',
    adbLine: line,
    release,
    sdk,
    abi,
    webviewSummary: redactAdbOutput(webview),
  }
}

function assertWaydroidDevice(device) {
  if (device.deviceClass !== 'waydroid') {
    throw new Error(`PER-277 local Android performance acceptance must run on Waydroid; selected ${device.serial} (${device.adbLine}).`)
  }
}

function normalizeRoutes(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_ROUTES
  return value.split(',').map((entry) => {
    const [id, href, ...landmarkParts] = entry.split(':')
    const landmark = landmarkParts.join(':')
    if (!id || !href || !landmark) throw new Error(`Invalid PER277_WAYDROID_ROUTES entry: ${entry}`)
    return { id, href, landmark }
  })
}

async function readFrameSamples(client) {
  const result = await evaluateJson(client, `JSON.stringify(window.__PER277_FRAME_SAMPLES__ ?? [])`)
  return Array.isArray(result) ? result : []
}

async function evaluateJson(client, expression) {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const value = response.result?.result?.value
  if (typeof value !== 'string') return value
  return JSON.parse(value)
}

function interactiveExpression(route) {
  return `JSON.stringify((() => {
    const main = document.querySelector('main#content, main');
    const bodyText = document.body?.innerText ?? '';
    const mainRect = main?.getBoundingClientRect();
    return {
      href: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
      mainVisible: Boolean(main && mainRect && mainRect.width >= 300 && mainRect.height > 0),
      routeMatches: location.pathname === ${JSON.stringify(route.href)} || (${JSON.stringify(route.href)} === '/' && location.pathname === '/'),
      landmark: ${JSON.stringify(route.landmark)},
      landmarkPresent: bodyText.toLowerCase().includes(${JSON.stringify(route.landmark.toLowerCase())}),
      activeElement: document.activeElement?.tagName ?? null,
    };
  })())`
}

function navigationExpression(href) {
  return `(async () => {
    const href = ${JSON.stringify(href)};
    const link = Array.from(document.querySelectorAll('a[href]')).find((candidate) => new URL(candidate.href, location.href).pathname === href);
    if (link) {
      const rect = link.getBoundingClientRect();
      link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      link.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      link.click();
      return JSON.stringify({ ok: true, mode: 'link-click', href });
    }
    history.pushState({}, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return JSON.stringify({ ok: true, mode: 'history-push', href });
  })()`
}

function frameSamplerExpression(functionName) {
  return `(async () => {
    const samples = [];
    window.__PER277_FRAME_SAMPLES__ = samples;
    window.__PER277_FRAME_SAMPLER_ACTIVE__ = true;
    let last = performance.now();
    function tick(now) {
      if (!window.__PER277_FRAME_SAMPLER_ACTIVE__) return;
      samples.push({ atMs: now, deltaMs: now - last });
      last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return JSON.stringify({ ok: true, name: ${JSON.stringify(functionName)} });
  })()`
}

function adbDevices(adb) {
  return execFileSync(adb, ['devices', '-l'], { encoding: 'utf8' })
}

function adbOutput(adb, serial, args, { allowFailure = false } = {}) {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`adb ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function removeForward(adb, serial, port) {
  spawnSync(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`], { stdio: 'ignore' })
}

function resolveAdbCommand(explicit) {
  const candidates = [
    explicit,
    process.env.ADB,
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : undefined,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : undefined,
    join(os.homedir(), 'Android/Sdk/platform-tools/adb'),
    join(os.homedir(), '.local/share/android-sdk/platform-tools/adb'),
    'adb',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { stdio: 'ignore' })
    if (probe.status === 0) return candidate
  }
  throw new Error('Could not find adb. Set ADB, ANDROID_HOME, or ANDROID_SDK_ROOT.')
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function optionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${String(value)}`)
  return parsed
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function round(value) {
  return Math.round(value * 100) / 100
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function redactAdbOutput(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/(token|secret|password|api[_-]?key)=([^\s,;]+)/giu, '$1=[redacted]')
    .slice(0, 4000)
}

async function writeJsonReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  try {
    const report = await runPer277WaydroidPerformanceAcceptance()
    console.log(JSON.stringify({ ok: report.ok, report: process.env.PER277_WAYDROID_PERFORMANCE_REPORT ?? defaultReportPath }, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
