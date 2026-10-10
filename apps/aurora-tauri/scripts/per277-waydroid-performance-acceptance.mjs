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
  { id: 'assistant', href: '/', heading: 'Text chat with Aurora' },
  { id: 'mesh', href: '/mesh', heading: 'Connected devices' },
  { id: 'settings', href: '/settings', heading: 'This device' },
]
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'blink.user_timing',
  'disabled-by-default-devtools.timeline.frame',
].join(',')

export async function runPer277WaydroidPerformanceAcceptance(options = {}) {
  const adb = resolveAdbCommand(options.adb)
  const serial = resolveAndroidDeviceSerial(adbDevices(adb), options.serial ?? process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL)
  const appId = nonEmptyString(options.appId ?? process.env.AURORA_ANDROID_APP_ID, DEFAULT_APP_ID)
  const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.PER277_WAYDROID_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const stableFrames = positiveInteger(options.stableFrames ?? process.env.PER277_WAYDROID_STABLE_FRAMES, DEFAULT_STABLE_FRAMES)
  const reportPath = resolve(String(options.reportPath ?? process.env.PER277_WAYDROID_PERFORMANCE_REPORT ?? defaultReportPath))
  const artifactDir = resolve(String(options.artifactDir ?? process.env.PER277_WAYDROID_ARTIFACT_DIR ?? defaultArtifactDir(reportPath)))
  const minimumNavFps = optionalPositiveNumber(options.minimumNavFps ?? process.env.PER277_WAYDROID_MIN_NAV_FPS)
  const maximumRouteInteractiveMs = optionalPositiveNumber(options.maximumRouteInteractiveMs ?? process.env.PER277_WAYDROID_MAX_ROUTE_INTERACTIVE_MS)
  const routes = normalizeRoutes(options.routes ?? process.env.PER277_WAYDROID_ROUTES)
  const deadline = Date.now() + timeoutMs
  const budgets = { minimumNavFps, maximumRouteInteractiveMs }
  let device = null
  let launch = null
  const observations = []

  try {
    device = readAndroidDeviceMetadata(adb, serial)
    assertWaydroidDevice(device)

    const coldStartStartedAt = performance.now()
    launch = launchApp(adb, serial, appId)
    const traceCollector = createCdpTraceCollector()
    const scriptCollector = createCdpScriptCoverageCollector()
    const webview = await connectToRunningWebview({
      adb,
      serial,
      appId,
      deadline,
      onEvent(message) {
        traceCollector.onEvent(message)
        scriptCollector.onEvent(message)
      },
    })
    const client = webview.client
    try {
      await client.send('Runtime.enable')
      await client.send('Log.enable')
      const coldHomeScriptMeasurement = await startColdHomeScriptMeasurement(client, scriptCollector)
      const home = await waitForInteractive(client, { route: routes[0], deadline, stableFrames, phase: 'cold-home' })
      const coldHomeScriptArtifact = await stopColdHomeScriptMeasurement(client, scriptCollector, coldHomeScriptMeasurement, {
        route: routes[0],
        artifactDir,
      })
      observations.push({
        routeId: routes[0].id,
        href: routes[0].href,
        phase: 'cold-home',
        interactive: home.interactive,
        interactiveMs: round(performance.now() - coldStartStartedAt),
        document: home.document,
        frameMetrics: null,
        navigation: null,
        traceArtifact: null,
        scriptCoverage: coldHomeScriptArtifact.summary,
      })
      for (const route of routes.slice(1)) {
        observations.push(await measureRouteNavigation(client, { route, deadline, stableFrames, artifactDir, traceCollector }))
      }
    } finally {
      client.close()
      if (webview.forwardedPort) removeForward(adb, serial, webview.forwardedPort)
    }

    const report = buildWaydroidPerformanceReport({ appId, device, launch, observations, budgets, expectedRoutes: routes })
    await writeJsonReport(reportPath, report)
    if (!report.ok) throw new Error(`PER-277 Waydroid performance acceptance failed: ${report.errors.join('; ')}`)
    return report
  } catch (error) {
    const report = buildWaydroidPerformanceReport({
      appId,
      device: device ?? { serial, deviceClass: 'unknown', adbLine: serial, release: null, sdk: null, abi: null, webviewSummary: '' },
      launch: launch ?? { hostLaunchCommandMs: null, amStartTotalTimeMs: null, amStartWaitTimeMs: null, raw: '' },
      observations,
      budgets,
      expectedRoutes: routes,
      fatalError: redactAdbOutput(error instanceof Error ? error.message : String(error)),
    })
    await writeJsonReport(reportPath, report)
    throw error
  }
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
    if (!devices.some((device) => device.serial === requested)) throw new Error(`Android device ${requested} is not connected or authorized.`)
    return requested
  }
  const waydroid = devices.filter((device) => /waydroid/iu.test(device.line))
  if (waydroid.length === 1) return waydroid[0].serial
  if (waydroid.length > 1) throw new Error(`More than one Waydroid device is connected: ${waydroid.map((device) => device.serial).join(', ')}`)
  if (devices.length === 0) throw new Error('No authorized Android device is connected.')
  throw new Error('No Waydroid device could be selected; set AURORA_ANDROID_DEVICE_SERIAL or ANDROID_SERIAL explicitly.')
}

export function calculateFrameMetrics(samples, durationMs) {
  const deltas = samples.map((sample) => Number(sample.deltaMs)).filter((value) => Number.isFinite(value) && value >= 0)
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

export function mergeCoverageRanges(ranges) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({ startOffset: Number(range?.startOffset), endOffset: Number(range?.endOffset) }))
    .filter((range) => Number.isFinite(range.startOffset) && Number.isFinite(range.endOffset) && range.endOffset > range.startOffset)
    .sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)
  const merged = []
  for (const range of normalized) {
    const last = merged.at(-1)
    if (last && range.startOffset <= last.endOffset) {
      last.endOffset = Math.max(last.endOffset, range.endOffset)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

export function calculateUsedScriptBytes(source, coverageFunctions) {
  const sourceText = String(source ?? '')
  const ranges = (Array.isArray(coverageFunctions) ? coverageFunctions : [])
    .flatMap((fn) => fn?.ranges ?? [])
    .map((range) => ({
      startOffset: clampInteger(range?.startOffset, 0, sourceText.length),
      endOffset: clampInteger(range?.endOffset, 0, sourceText.length),
      count: Number(range?.count ?? 0),
    }))
    .filter((range) => range.endOffset > range.startOffset && Number.isFinite(range.count))
  if (ranges.length === 0) return 0

  const boundaries = [...new Set(ranges.flatMap((range) => [range.startOffset, range.endOffset]))].sort((left, right) => left - right)
  let usedBytes = 0
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const startOffset = boundaries[index]
    const endOffset = boundaries[index + 1]
    const containingRanges = ranges.filter((range) => range.startOffset <= startOffset && range.endOffset >= endOffset)
    const innermostSpan = Math.min(...containingRanges.map((range) => range.endOffset - range.startOffset))
    const innermostRanges = containingRanges.filter((range) => range.endOffset - range.startOffset === innermostSpan)
    if (innermostRanges.some((range) => range.count > 0)) usedBytes += utf8ByteLength(sourceText.slice(startOffset, endOffset))
  }
  return usedBytes
}

export function isInteractiveDocumentState(state) {
  return Boolean(
    state
      && state.readyState === 'complete'
      && state.rootChildren > 0
      && state.mainVisible
      && state.routeMatches
      && state.headingPresent
      && !state.loadingPresent
  )
}

export function buildWaydroidPerformanceReport({ appId, device, launch, observations, budgets, expectedRoutes = [], fatalError = null }) {
  const errors = []
  const expectedRouteList = Array.isArray(expectedRoutes) ? expectedRoutes : []
  const observationList = Array.isArray(observations) ? observations : []
  const observationsByRoute = new Map(observationList.map((observation) => [observation.routeId, observation]))

  if (fatalError) errors.push(fatalError)
  if (device.deviceClass !== 'waydroid') errors.push(`expected Waydroid device, received ${device.deviceClass}`)
  if (expectedRouteList.length === 0) errors.push('expected route list is empty')
  if (observationList.length === 0) errors.push('no route observations were recorded')
  for (const route of expectedRouteList) {
    if (!observationsByRoute.has(route.id)) errors.push(`missing observation for expected route ${route.id}`)
  }
  for (const observation of observationList) {
    if (!observation.interactive) errors.push(`${observation.routeId} did not become interactive`)
    if (observation.phase === 'cold-home') {
      const coverage = observation.scriptCoverage
      if (coverage?.ok !== true) {
        errors.push(`${observation.routeId} cold-home script coverage did not complete successfully`)
      }
      if (!Number.isFinite(coverage?.parsedScriptCount) || coverage.parsedScriptCount <= 0) {
        errors.push(`${observation.routeId} cold-home script coverage did not record parsed scripts`)
      }
      if (!Number.isFinite(coverage?.measuredScriptCount) || coverage.measuredScriptCount <= 0) {
        errors.push(`${observation.routeId} cold-home script coverage did not measure any script source`)
      }
      if (!Number.isFinite(coverage?.totalParsedJsBytes) || coverage.totalParsedJsBytes <= 0) {
        errors.push(`${observation.routeId} cold-home script coverage did not record positive parsed JS bytes`)
      }
      for (const coverageError of coverageErrors(coverage)) {
        errors.push(`${observation.routeId} cold-home script coverage: ${coverageError}`)
      }
    }
    if (observation.phase === 'navigation') {
      if (observation.navigation?.mode !== 'visible-link-click' || observation.navigation?.ok !== true) {
        errors.push(`${observation.routeId} navigation did not use a successful visible link click`)
      }
      if (typeof budgets.minimumNavFps === 'number') {
        const fps = observation.frameMetrics?.averageFps
        if (!Number.isFinite(fps)) errors.push(`${observation.routeId} is missing navigation FPS metrics required by PER277_WAYDROID_MIN_NAV_FPS`)
        else if (fps < budgets.minimumNavFps) errors.push(`${observation.routeId} average FPS ${fps} below PER277_WAYDROID_MIN_NAV_FPS=${budgets.minimumNavFps}`)
      }
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
    expectedRoutes: expectedRouteList.map((route) => ({ id: route.id, href: route.href, heading: route.heading })),
    observations: observationList,
    budgets: {
      minimumNavFps: budgets.minimumNavFps ?? null,
      maximumRouteInteractiveMs: budgets.maximumRouteInteractiveMs ?? null,
    },
    fatalError,
    errors,
    generatedAt: new Date().toISOString(),
    secretsRedacted: true,
  }
}

async function measureRouteNavigation(client, { route, deadline, stableFrames, artifactDir, traceCollector }) {
  const traceSession = await startCdpTrace(client, traceCollector, route)
  let navigation = null
  const startedAt = performance.now()
  try {
    await client.send('Runtime.evaluate', { expression: frameSamplerExpression(), awaitPromise: true, returnByValue: true })
    navigation = await evaluateJson(client, navigationExpression(route.href))
    if (navigation?.ok !== true || navigation.mode !== 'visible-link-click') {
      throw new Error(`Could not navigate to ${route.id} with a visible link: ${JSON.stringify(navigation)}`)
    }
    const interactive = await waitForInteractive(client, { route, deadline, stableFrames, phase: 'navigation' })
    const durationMs = round(performance.now() - startedAt)
    const frameCapture = await stopFrameSampler(client)
    const traceArtifact = await stopCdpTrace(client, traceCollector, traceSession, { route, artifactDir })
    return {
      routeId: route.id,
      href: route.href,
      phase: 'navigation',
      interactive: interactive.interactive,
      interactiveMs: durationMs,
      document: interactive.document,
      frameMetrics: {
        ...calculateFrameMetrics(frameCapture.samples, frameCapture.durationMs),
        samplingDurationMs: round(frameCapture.durationMs),
        clock: 'webview-performance',
      },
      navigation,
      traceArtifact,
    }
  } catch (error) {
    try {
      await stopFrameSampler(client)
    } catch {
      // Preserve the original route failure.
    }
    try {
      await stopCdpTrace(client, traceCollector, traceSession, { route, artifactDir })
    } catch {
      // Trace capture is best-effort evidence; route failure remains authoritative.
    }
    throw error
  }
}

async function waitForInteractive(client, { route, deadline, stableFrames, phase }) {
  let stable = 0
  let last = null
  while (Date.now() < deadline) {
    const state = await evaluateJson(client, interactiveExpression(route))
    last = state
    if (isInteractiveDocumentState(state)) {
      stable += 1
      if (stable >= stableFrames) return { interactive: true, phase, document: state }
    } else {
      stable = 0
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${route.id} to become interactive. Last state: ${JSON.stringify(last)}`)
}

async function connectToRunningWebview({ adb, serial, appId, deadline, onEvent }) {
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
      const cdp = await connectAndroidWebviewCdp({ port: forwardedPort, onEvent })
      return { client: cdp, forwardedPort }
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

function readAndroidDeviceMetadata(adb, serial) {
  const line = parseAdbDevices(adbDevices(adb)).find((device) => device.serial === serial)?.line ?? serial
  return {
    serial,
    deviceClass: /waydroid/iu.test(line) ? 'waydroid' : 'android',
    adbLine: line,
    release: adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.release'], { allowFailure: true }).trim(),
    sdk: adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.sdk'], { allowFailure: true }).trim(),
    abi: adbOutput(adb, serial, ['shell', 'getprop', 'ro.product.cpu.abi'], { allowFailure: true }).trim(),
    webviewSummary: redactAdbOutput(adbOutput(adb, serial, ['shell', 'dumpsys', 'webviewupdate'], { allowFailure: true }).split('\n').slice(0, 12).join('\n')),
  }
}

function assertWaydroidDevice(device) {
  if (device.deviceClass !== 'waydroid') throw new Error(`PER-277 local Android performance acceptance must run on Waydroid; selected ${device.serial} (${device.adbLine}).`)
}

function normalizeRoutes(value) {
  if (Array.isArray(value)) return value.map(normalizeRoute)
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_ROUTES
  return value.split(',').map((entry) => {
    const [id, href, ...headingParts] = entry.split(':')
    const heading = headingParts.join(':')
    return normalizeRoute({ id, href, heading }, entry)
  })
}

function normalizeRoute(route, source = JSON.stringify(route)) {
  const id = nonEmptyString(route.id, '')
  const href = nonEmptyString(route.href, '')
  const heading = nonEmptyString(route.heading ?? route.landmark, '')
  if (!id || !href || !heading) throw new Error(`Invalid PER277_WAYDROID_ROUTES entry: ${source}`)
  return { id, href, heading }
}

export async function stopFrameSampler(client) {
  const capture = await evaluateJson(client, `JSON.stringify((() => {
    const stoppedAt = performance.now();
    window.__PER277_FRAME_SAMPLER_ACTIVE__ = false;
    return {
      samples: window.__PER277_FRAME_SAMPLES__ ?? [],
      durationMs: stoppedAt - window.__PER277_FRAME_SAMPLER_STARTED_AT__,
    };
  })())`)
  if (!Array.isArray(capture?.samples) || !Number.isFinite(capture.durationMs) || capture.durationMs <= 0) {
    throw new Error('WebView frame sampling did not return a valid monotonic duration.')
  }
  return capture
}

async function evaluateJson(client, expression) {
  const response = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  const value = response.result?.result?.value
  return typeof value === 'string' ? JSON.parse(value) : value
}

function interactiveExpression(route) {
  return `JSON.stringify((() => {
    const expectedHeading = ${JSON.stringify(route.heading)};
    const expectedHeadingLower = expectedHeading.toLowerCase();
    const main = document.querySelector('main#content, main');
    const mainRect = main?.getBoundingClientRect();
    const mainText = main?.innerText ?? '';
    const mainTextLower = mainText.toLowerCase();
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const candidateNodes = main
      ? Array.from(main.querySelectorAll('h1,h2,h3,[role="heading"],section[aria-label],article[aria-label],[role="region"][aria-label]'))
      : [];
    const visibleMainHeadings = candidateNodes
      .filter((node) => isVisible(node))
      .map((node) => ((node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim()))
      .filter(Boolean);
    const loadingPresent = Boolean(
      main?.matches('[aria-busy="true"]')
        || main?.querySelector('[aria-busy="true"]')
        || /(^|\\s)Loading(\\s|$|…|\\.)/u.test(mainText)
    );
    return {
      href: location.href,
      pathname: location.pathname,
      readyState: document.readyState,
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
      mainVisible: Boolean(main && mainRect && mainRect.width >= 300 && mainRect.height > 0),
      routeMatches: location.pathname === ${JSON.stringify(route.href)} || (${JSON.stringify(route.href)} === '/' && location.pathname === '/'),
      expectedHeading,
      visibleMainHeadings,
      headingPresent: visibleMainHeadings.some((text) => text.toLowerCase().includes(expectedHeadingLower)),
      mainTextIncludesExpectedHeading: mainTextLower.includes(expectedHeadingLower),
      loadingPresent,
    };
  })())`
}

function navigationExpression(href) {
  return `(async () => {
    const href = ${JSON.stringify(href)};
    const targetPath = new URL(href, location.href).pathname;
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && element.getAttribute('aria-disabled') !== 'true';
    };
    const links = Array.from(document.querySelectorAll('a[href]'));
    const link = links.find((candidate) => new URL(candidate.href, location.href).pathname === targetPath && isVisible(candidate));
    if (!link) {
      return JSON.stringify({
        ok: false,
        mode: 'visible-link-click',
        error: 'visible_link_not_found',
        href,
        candidates: links
          .filter((candidate) => new URL(candidate.href, location.href).pathname === targetPath)
          .map((candidate) => ({ text: (candidate.innerText || candidate.textContent || '').trim(), visible: isVisible(candidate) })),
      });
    }
    const rect = link.getBoundingClientRect();
    link.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    link.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    link.click();
    return JSON.stringify({
      ok: true,
      mode: 'visible-link-click',
      href,
      linkText: (link.innerText || link.textContent || '').trim(),
      navLabel: link.closest('nav')?.getAttribute('aria-label') ?? null,
      rect: { width: Math.round(rect.width), height: Math.round(rect.height) },
    });
  })()`
}

function frameSamplerExpression() {
  return `(async () => {
    const samples = [];
    window.__PER277_FRAME_SAMPLES__ = samples;
    window.__PER277_FRAME_SAMPLER_ACTIVE__ = true;
    let last = performance.now();
    window.__PER277_FRAME_SAMPLER_STARTED_AT__ = last;
    function tick(now) {
      if (!window.__PER277_FRAME_SAMPLER_ACTIVE__) return;
      samples.push({ atMs: now, deltaMs: now - last });
      last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return JSON.stringify({ ok: true });
  })()`
}

function createCdpScriptCoverageCollector() {
  const scripts = new Map()
  return {
    onEvent(message) {
      if (message?.method !== 'Debugger.scriptParsed') return
      const params = message.params ?? {}
      if (!params.scriptId) return
      scripts.set(String(params.scriptId), {
        scriptId: String(params.scriptId),
        url: redactReportUrl(params.url ?? ''),
        hash: params.hash ?? null,
        startLine: Number.isFinite(params.startLine) ? params.startLine : null,
        startColumn: Number.isFinite(params.startColumn) ? params.startColumn : null,
        endLine: Number.isFinite(params.endLine) ? params.endLine : null,
        endColumn: Number.isFinite(params.endColumn) ? params.endColumn : null,
        executionContextId: Number.isFinite(params.executionContextId) ? params.executionContextId : null,
      })
    },
    snapshot() {
      return new Map(scripts)
    },
    reset() {
      scripts.clear()
    },
  }
}

async function startColdHomeScriptMeasurement(client, scriptCollector) {
  const startedAt = performance.now()
  const errors = []
  scriptCollector.reset()
  try {
    await client.send('Performance.enable', {}, 5_000)
  } catch (error) {
    errors.push(`Performance.enable: ${redactAdbOutput(error instanceof Error ? error.message : String(error))}`)
  }
  try {
    await client.send('Debugger.enable', {}, 5_000)
  } catch (error) {
    errors.push(`Debugger.enable: ${redactAdbOutput(error instanceof Error ? error.message : String(error))}`)
  }
  try {
    await client.send('Profiler.enable', {}, 5_000)
    await client.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true }, 5_000)
  } catch (error) {
    errors.push(`Profiler.startPreciseCoverage: ${redactAdbOutput(error instanceof Error ? error.message : String(error))}`)
  }
  return { ok: errors.length === 0, startedAt, errors }
}

async function stopColdHomeScriptMeasurement(client, scriptCollector, measurement, { route, artifactDir }) {
  const errors = [...(measurement?.errors ?? [])]
  let coverage = null
  let metrics = null
  try {
    coverage = await client.send('Profiler.takePreciseCoverage', {}, 10_000)
  } catch (error) {
    errors.push(`Profiler.takePreciseCoverage: ${redactAdbOutput(error instanceof Error ? error.message : String(error))}`)
  }
  try {
    await client.send('Profiler.stopPreciseCoverage', {}, 5_000)
  } catch (error) {
    errors.push(`Profiler.stopPreciseCoverage: ${redactAdbOutput(error instanceof Error ? error.message : String(error))}`)
  }
  try {
    metrics = await client.send('Performance.getMetrics', {}, 5_000)
  } catch (error) {
    errors.push(`Performance.getMetrics: ${redactAdbOutput(error instanceof Error ? error.message : String(error))}`)
  }

  const parsedScripts = scriptCollector.snapshot()
  const sourceRows = await collectCoverageSourceRows(client, coverage?.result?.result ?? coverage?.result ?? [], parsedScripts, errors)
  if (sourceRows.length === 0) errors.push('Profiler precise coverage and Debugger.scriptParsed returned no script records.')
  const summary = summarizeScriptCoverage(sourceRows, metrics, measurement, errors)
  const path = resolve(artifactDir, `per277-${safeFilePart(route.id)}-cold-home-js-coverage.json`)
  await writeJsonReport(path, {
    scenario: 'per277-waydroid-cold-home-js-coverage',
    routeId: route.id,
    href: route.href,
    summary,
    scripts: sourceRows,
    generatedAt: new Date().toISOString(),
    secretsRedacted: true,
    sourceTextStored: false,
  })
  return { summary: { ...summary, artifactPath: path }, path }
}

async function collectCoverageSourceRows(client, coverageResult, parsedScripts, errors) {
  const entries = Array.isArray(coverageResult) ? coverageResult : []
  const coverageByScriptId = new Map()
  for (const entry of entries) {
    const scriptId = String(entry?.scriptId ?? '')
    if (scriptId && !coverageByScriptId.has(scriptId)) coverageByScriptId.set(scriptId, entry)
  }
  const scriptIds = [...new Set([...parsedScripts.keys(), ...coverageByScriptId.keys()])]
  const rows = []
  for (const scriptId of scriptIds) {
    const entry = coverageByScriptId.get(scriptId)
    const parsed = parsedScripts.get(scriptId) ?? { scriptId, url: redactReportUrl(entry?.url ?? ''), hash: null }
    const functions = Array.isArray(entry?.functions) ? entry.functions : []
    const row = {
      scriptId,
      url: redactReportUrl(entry?.url || parsed.url || ''),
      hash: parsed.hash ?? null,
      parsed: parsedScripts.has(scriptId),
      covered: coverageByScriptId.has(scriptId),
      functionCount: functions.length,
      rangeCount: functions.reduce((sum, fn) => sum + (Array.isArray(fn?.ranges) ? fn.ranges.length : 0), 0),
      sourceBytes: null,
      usedBytes: null,
      error: null,
    }
    try {
      const sourceResponse = await client.send('Debugger.getScriptSource', { scriptId }, 10_000)
      const source = sourceResponse.result?.scriptSource
      if (typeof source !== 'string') throw new Error('Debugger.getScriptSource returned no scriptSource')
      row.sourceBytes = utf8ByteLength(source)
      row.usedBytes = calculateUsedScriptBytes(source, functions)
    } catch (error) {
      row.error = redactAdbOutput(error instanceof Error ? error.message : String(error))
      errors.push(`Debugger.getScriptSource(${scriptId}): ${row.error}`)
    }
    rows.push(row)
  }
  return rows.sort((left, right) => (right.sourceBytes ?? 0) - (left.sourceBytes ?? 0) || left.scriptId.localeCompare(right.scriptId))
}

function summarizeScriptCoverage(rows, metrics, measurement, errors) {
  const rigorousRows = rows.filter((row) => Number.isFinite(row.sourceBytes) && Number.isFinite(row.usedBytes))
  const totalParsedJsBytes = rigorousRows.reduce((sum, row) => sum + row.sourceBytes, 0)
  const totalUsedJsBytes = rigorousRows.reduce((sum, row) => sum + row.usedBytes, 0)
  const metricMap = Object.fromEntries((metrics?.result?.metrics ?? metrics?.metrics ?? []).map((metric) => [metric.name, metric.value]))
  return {
    ok: errors.length === 0 && rigorousRows.length === rows.length,
    startedBeforeInteractive: true,
    durationMs: round(performance.now() - (measurement?.startedAt ?? performance.now())),
    scriptCount: rows.length,
    measuredScriptCount: rigorousRows.length,
    parsedScriptCount: rows.filter((row) => row.parsed).length,
    coveredScriptCount: rows.filter((row) => row.covered).length,
    totalParsedJsBytes,
    totalUsedJsBytes,
    sourceByteMethod: 'Debugger.getScriptSource utf8 byte length',
    usedByteMethod: 'innermost precise-coverage count over non-overlapping interval boundaries encoded as utf8 source slices',
    performanceMetrics: {
      ScriptDuration: metricMap.ScriptDuration ?? null,
      TaskDuration: metricMap.TaskDuration ?? null,
      JSHeapUsedSize: metricMap.JSHeapUsedSize ?? null,
      JSHeapTotalSize: metricMap.JSHeapTotalSize ?? null,
    },
    errors,
  }
}

function createCdpTraceCollector() {
  let active = false
  let events = []
  let complete = false
  let completeWaiters = []
  return {
    onEvent(message) {
      if (!active) return
      if (message?.method === 'Tracing.dataCollected' && Array.isArray(message.params?.value)) {
        events.push(...message.params.value)
      }
      if (message?.method === 'Tracing.tracingComplete') {
        complete = true
        const waiters = completeWaiters
        completeWaiters = []
        waiters.forEach((resolvePromise) => resolvePromise())
      }
    },
    start() {
      active = true
      complete = false
      events = []
      completeWaiters = []
    },
    async waitForComplete(timeoutMs) {
      if (complete) return
      await Promise.race([
        new Promise((resolvePromise) => completeWaiters.push(resolvePromise)),
        rejectAfter(timeoutMs, `CDP trace did not complete within ${timeoutMs}ms`),
      ])
    },
    stop() {
      active = false
      const snapshot = events
      events = []
      return snapshot
    },
    abort() {
      active = false
      events = []
      complete = false
      completeWaiters = []
    },
  }
}

async function startCdpTrace(client, traceCollector, route) {
  traceCollector.start()
  try {
    await client.send('Tracing.start', {
      categories: TRACE_CATEGORIES,
      transferMode: 'ReportEvents',
      options: 'sampling-frequency=10000',
    }, 5_000)
    return { ok: true, routeId: route.id }
  } catch (error) {
    traceCollector.abort()
    return { ok: false, routeId: route.id, error: redactAdbOutput(error instanceof Error ? error.message : String(error)) }
  }
}

async function stopCdpTrace(client, traceCollector, traceSession, { route, artifactDir }) {
  if (!traceSession?.ok) return traceSession
  try {
    await client.send('Tracing.end', {}, 5_000)
    await traceCollector.waitForComplete(5_000)
    const events = sanitizeTraceEvents(traceCollector.stop())
    const path = resolve(artifactDir, `per277-${safeFilePart(route.id)}-cdp-trace.json`)
    await writeJsonReport(path, {
      scenario: 'per277-waydroid-cdp-navigation-trace',
      routeId: route.id,
      href: route.href,
      categories: TRACE_CATEGORIES.split(','),
      eventCount: events.length,
      events,
      generatedAt: new Date().toISOString(),
      secretsRedacted: true,
      traceSanitization: 'allowlisted timing/category/name fields and numeric/boolean args only',
    })
    return { ok: true, path, eventCount: events.length, categories: TRACE_CATEGORIES.split(',') }
  } catch (error) {
    traceCollector.abort()
    return { ok: false, routeId: route.id, error: redactAdbOutput(error instanceof Error ? error.message : String(error)) }
  }
}

function adbDevices(adb) {
  return execFileSync(adb, ['devices', '-l'], { encoding: 'utf8' })
}

function adbOutput(adb, serial, args, { allowFailure = false } = {}) {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && !allowFailure) throw new Error(`adb ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`)
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

function defaultArtifactDir(reportPath) {
  return reportPath.replace(/\.json$/u, '-artifacts')
}

function parseAmStartMetric(output, name) {
  const match = new RegExp(`^${name}:\\s*(\\d+)`, 'mu').exec(String(output ?? ''))
  return match ? Number(match[1]) : null
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

function rejectAfter(ms, message) {
  return new Promise((_resolve, rejectPromise) => setTimeout(() => rejectPromise(new Error(message)), ms))
}

function safeFilePart(value) {
  return String(value ?? 'route').replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'route'
}

function coverageErrors(coverage) {
  return Array.isArray(coverage?.errors)
    ? coverage.errors.map((error) => redactAdbOutput(error)).filter(Boolean)
    : []
}

export function sanitizeTraceEvents(events) {
  return (Array.isArray(events) ? events : []).map((event) => {
    const sanitized = {}
    if (typeof event?.cat === 'string') sanitized.cat = redactTraceLabel(event.cat)
    if (typeof event?.name === 'string') sanitized.name = redactTraceEventName(event.name, event.cat)
    if (typeof event?.ph === 'string') sanitized.ph = redactTraceLabel(event.ph)
    for (const key of ['pid', 'tid', 'ts', 'dur', 'tdur', 'tts']) {
      if (Number.isFinite(event?.[key])) sanitized[key] = event[key]
    }
    const args = sanitizeTraceArgs(event?.args)
    if (Object.keys(args).length > 0) sanitized.args = args
    return sanitized
  })
}

function sanitizeTraceArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const sanitized = {}
  for (const [key, argValue] of Object.entries(value)) {
    const safeKey = safeTraceArgKey(key)
    if (!safeKey) continue
    if (Number.isFinite(argValue) || typeof argValue === 'boolean') sanitized[safeKey] = argValue
    else if (argValue && typeof argValue === 'object' && !Array.isArray(argValue)) {
      const nested = sanitizeTraceArgs(argValue)
      if (Object.keys(nested).length > 0) sanitized[safeKey] = nested
    }
  }
  return sanitized
}

function safeTraceArgKey(key) {
  const normalized = String(key ?? '').replace(/[^a-z0-9._-]+/giu, '_').slice(0, 80)
  if (!normalized || /(url|uri|text|message|stack|script|source|data|token|secret|password|auth|query|args|snapshot)/iu.test(normalized)) return null
  return normalized
}

function redactTraceEventName(name, category) {
  if (/blink\.user_timing/iu.test(String(category ?? ''))) return '[redacted-user-timing]'
  return redactTraceLabel(name)
}

function redactTraceLabel(value) {
  const text = redactAdbOutput(value)
  if (/(:\/\/|[?&=]|^data:|^javascript:)/iu.test(text)) return '[redacted]'
  return text.slice(0, 160)
}

function clampInteger(value, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength
}

function redactReportUrl(value) {
  const raw = String(value ?? '')
  if (/^(data|javascript):/iu.test(raw)) return `${raw.split(':', 1)[0]}:[redacted]`
  try {
    const url = new URL(raw)
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|secret|password|api[_-]?key|authorization|auth)/iu.test(key)) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch {
    return redactAdbOutput(raw)
  }
}

function redactAdbOutput(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]').replace(/(token|secret|password|api[_-]?key)=([^\s,;]+)/giu, '$1=[redacted]').slice(0, 4000)
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
