#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_CHUNK_COUNT = 140
const DEFAULT_HISTORY_COUNT = 120

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  const url = requiredOption(options, 'url')
  const output = resolve(requiredOption(options, 'output'))
  const profileDir = resolve(options.get('profile-dir') ?? `${dirname(output)}/chromium-profile-per277-assistant`)
  const tracePath = resolveTracePath(output, options.get('trace'))
  const scenario = options.get('scenario') ?? (url.includes('per277-local-history') ? 'per277-local-history' : 'per277-assistant-stream')
  const timeoutMs = positiveInt(options.get('timeout-ms'), DEFAULT_TIMEOUT_MS)
  const chunkCount = positiveInt(options.get('chunk-count'), DEFAULT_CHUNK_COUNT)
  const historyCount = positiveInt(options.get('history-count'), DEFAULT_HISTORY_COUNT)
  const requestedHistoryBackend = historyBackendKind(options.get('history-backend'), '--history-backend')
  const finalUrl = urlWithDefaults(url, scenario, chunkCount, historyCount, requestedHistoryBackend)
  const actualHistoryBackend = historyBackendFromUrl(finalUrl)

  if (tracePath === output) throw new Error('PER-277 assistant trace path must be distinct from --output')
  await mkdir(dirname(output), { recursive: true })
  await mkdir(dirname(tracePath), { recursive: true })

  const context = await chromium.launchPersistentContext(profileDir, {
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  })

  await context.addInitScript(() => {
    const handle = {
      version: 1,
      enabled: true,
      maxSamples: 10_000,
      samples: [],
      reset() {
        handle.samples.length = 0
      },
      configure(options = {}) {
        if (typeof options.enabled === 'boolean') handle.enabled = options.enabled
        if (typeof options.maxSamples === 'number' && Number.isFinite(options.maxSamples)) {
          handle.maxSamples = Math.max(0, Math.min(10_000, Math.floor(options.maxSamples)))
          const overflow = handle.samples.length - handle.maxSamples
          if (overflow > 0) handle.samples.splice(0, overflow)
        }
      },
    }
    window.__AURORA_REACT_PROFILER__ = handle
  })

  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const consoleMessages = []
  const pageErrors = []
  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() })
  })
  page.on('pageerror', (error) => {
    pageErrors.push(error instanceof Error ? error.message : String(error))
  })

  let traceStarted = false
  let cleanupAttempted = false
  try {
    await cdp.send('Performance.enable')
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline',
      options: 'sampling-frequency=10000',
      transferMode: 'ReturnAsStream',
    })
    traceStarted = true

    const navigationStartedAt = performance.now()
    await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForFunction(() => window.__PER277_ASSISTANT_READY__ === true, null, { timeout: timeoutMs })

    if (scenario === 'per277-local-history') {
      await page.waitForFunction(() => {
        const state = window.__PER277_ASSISTANT_MEASUREMENT__
        return Boolean(state?.historyListVisibleAt)
      }, null, { timeout: timeoutMs })
      await page.evaluate(async () => {
        if (!window.__PER277_HISTORY_OPEN_FIRST__) throw new Error('PER-277 history open hook missing')
        await window.__PER277_HISTORY_OPEN_FIRST__()
      })
      await page.waitForFunction(() => {
        const state = window.__PER277_ASSISTANT_MEASUREMENT__
        return Boolean(state?.historyFirstOpenVisibleAt)
      }, null, { timeout: timeoutMs })
    }

    await page.evaluate(async () => {
      if (!window.__PER277_ASSISTANT_SUBMIT__) throw new Error('PER-277 assistant submit hook missing')
      await window.__PER277_ASSISTANT_SUBMIT__()
    })
    await page.waitForFunction((activeScenario) => {
      const state = window.__PER277_ASSISTANT_MEASUREMENT__
      if (!state?.finalVisibleAt) return false
      if (activeScenario === 'per277-assistant-stream') return state.visibleDeltaCount >= state.expectedDeltaCount
      return Boolean(state.historyAppendCompleteAt)
    }, scenario, { timeout: timeoutMs })

    await page.waitForTimeout(250)
    const navigationWallMs = performance.now() - navigationStartedAt
    const metrics = await cdp.send('Performance.getMetrics')
    const rawTrace = traceStarted ? await stopTrace(cdp) : { events: [], unavailable: true }
    traceStarted = false
    const trace = sanitizeWebTraceArtifact(rawTrace)
    await writeFile(tracePath, JSON.stringify(trace, null, 2))

    const browserState = await page.evaluate(() => ({
      measurement: window.__PER277_ASSISTANT_MEASUREMENT__ ?? null,
      profiler: window.__AURORA_REACT_PROFILER__ ? {
        version: window.__AURORA_REACT_PROFILER__.version,
        enabled: window.__AURORA_REACT_PROFILER__.enabled,
        maxSamples: window.__AURORA_REACT_PROFILER__.maxSamples,
        samples: window.__AURORA_REACT_PROFILER__.samples,
      } : null,
      navigation: performance.getEntriesByType('navigation').map((entry) => entry.toJSON?.() ?? entry)[0] ?? null,
      marks: performance.getEntriesByType('mark').map((entry) => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })),
    }))

    const cleanup = await cleanupAssistantPage(page)
    cleanupAttempted = true
    const cleanupMeasurement = await page.evaluate(() => {
      const state = window.__PER277_ASSISTANT_MEASUREMENT__
      if (!state) return null
      return {
        cleanupState: state.cleanupState,
        cleanupError: state.cleanupError,
        cleanupCompletedAt: state.cleanupCompletedAt,
      }
    }).catch(() => null)
    const measurement = browserState.measurement && cleanupMeasurement
      ? { ...browserState.measurement, ...cleanupMeasurement }
      : browserState.measurement
    const profilerSamples = Array.isArray(browserState.profiler?.samples) ? browserState.profiler.samples : []
    const commitDurations = profilerSamples.map((sample) => sample.actualDuration).filter((value) => typeof value === 'number' && Number.isFinite(value))
    const summary = summarizeMeasurement(measurement)
    const report = {
      scenario,
      url: finalUrl,
      generatedAt: new Date().toISOString(),
      navigationWallMs,
      tracePath,
      metrics: Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value])),
      navigation: browserState.navigation,
      measurement,
      summary,
      profiler: {
        labels: [...new Set(profilerSamples.map((sample) => sample.label))].sort(),
        sampleCount: profilerSamples.length,
        commitDistribution: distribution(commitDurations),
        samples: profilerSamples,
      },
      longTasks: measurement?.longTasks ?? [],
      marks: browserState.marks,
      consoleMessages,
      pageErrors,
      cleanup,
      parameters: {
        chunkCount,
        historyCount,
        historyBackend: actualHistoryBackend,
        timeoutMs,
        profileDir,
      },
    }
    await writeFile(output, JSON.stringify(sanitizeAssistantMeasurementReport(report), null, 2))
  } finally {
    if (!cleanupAttempted) await cleanupAssistantPage(page).catch(() => undefined)
    if (traceStarted) {
      await stopTrace(cdp).catch(() => undefined)
    }
    await context.close()
  }

}

function parseArgs(argv) {
  const parsed = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      parsed.set(key, next)
      index += 1
    } else {
      parsed.set(key, 'true')
    }
  }
  return parsed
}

function requiredOption(options, key) {
  const value = options.get(key)
  if (!value) throw new Error(`Missing required --${key}`)
  return value
}

function resolveTracePath(outputPath, explicitTracePath) {
  if (explicitTracePath) return resolve(explicitTracePath)
  const extension = extname(outputPath)
  const name = extension ? basename(outputPath, extension) : basename(outputPath)
  return resolve(join(dirname(outputPath), `${name}.cdp-trace.json`))
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function historyBackendKind(value, label = 'historyBackend') {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === '' || normalized === 'indexeddb') return 'indexeddb'
  if (normalized === 'memory') return 'memory'
  throw new Error(`${label} must be indexeddb or memory`)
}

function historyBackendFromUrl(value) {
  const parsed = new URL(value)
  return historyBackendKind(parsed.searchParams.get('historyBackend') ?? parsed.searchParams.get('history-backend'), 'historyBackend URL parameter')
}

function urlWithDefaults(rawUrl, scenario, chunkCount, historyCount, historyBackend) {
  const next = new URL(rawUrl)
  if (!next.searchParams.has('case')) next.searchParams.set('case', scenario)
  if (!next.searchParams.has('chunkCount')) next.searchParams.set('chunkCount', String(chunkCount))
  if (!next.searchParams.has('historyCount')) next.searchParams.set('historyCount', String(historyCount))
  if (!next.searchParams.has('historyBackend') && !next.searchParams.has('history-backend')) next.searchParams.set('historyBackend', historyBackend)
  if (!next.searchParams.has('theme')) next.searchParams.set('theme', 'dark')
  if (!next.searchParams.has('surface')) next.searchParams.set('surface', 'android')
  if (!next.searchParams.has('aurora-surface')) next.searchParams.set('aurora-surface', 'android')
  if (!next.searchParams.has('aurora-role')) next.searchParams.set('aurora-role', 'mesh-node')
  if (!next.searchParams.has('aurora-tier')) next.searchParams.set('aurora-tier', 'lightweight-ts')
  if (!next.searchParams.has('aurora-admin')) next.searchParams.set('aurora-admin', '0')
  if (!next.searchParams.has('aurora-viewport')) next.searchParams.set('aurora-viewport', 'phone')
  return next.toString()
}

async function cleanupAssistantPage(page) {
  try {
    const result = await page.evaluate(async () => await window.__PER277_ASSISTANT_CLEANUP__?.())
    if (result && typeof result === 'object') return result
    return { state: 'complete', error: null }
  } catch (error) {
    return { state: 'failed', error: redactPerformanceText(error instanceof Error ? error.message : String(error)) }
  }
}

async function stopTrace(cdp) {
  const chunks = []
  const tracingComplete = new Promise((resolve, reject) => {
    cdp.once('Tracing.tracingComplete', async ({ stream }) => {
      try {
        if (!stream) {
          resolve({ events: [], stream: null })
          return
        }
        while (true) {
          const read = await cdp.send('IO.read', { handle: stream })
          if (read.data) chunks.push(read.data)
          if (read.eof) break
        }
        await cdp.send('IO.close', { handle: stream }).catch(() => undefined)
        const text = chunks.join('')
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
  })
  await cdp.send('Tracing.end')
  return await tracingComplete
}

function distribution(values) {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, max: null, total: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    total: sorted.reduce((sum, value) => sum + value, 0),
  }
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index]
}

function summarizeMeasurement(measurement) {
  if (!measurement) return null
  const submittedAt = typeof measurement.submittedAt === 'number' ? measurement.submittedAt : null
  const firstVisibleAt = typeof measurement.firstVisibleAt === 'number' ? measurement.firstVisibleAt : null
  const finalVisibleAt = typeof measurement.finalVisibleAt === 'number' ? measurement.finalVisibleAt : null
  const historyListVisibleAt = typeof measurement.historyListVisibleAt === 'number' ? measurement.historyListVisibleAt : null
  const historyFirstOpenVisibleAt = typeof measurement.historyFirstOpenVisibleAt === 'number' ? measurement.historyFirstOpenVisibleAt : null
  const longTaskDurations = Array.isArray(measurement.longTasks)
    ? measurement.longTasks.map((task) => task.duration).filter((value) => typeof value === 'number' && Number.isFinite(value))
    : []
  return {
    firstVisibleLatencyMs: submittedAt !== null && firstVisibleAt !== null ? firstVisibleAt - submittedAt : null,
    finalVisibleLatencyMs: submittedAt !== null && finalVisibleAt !== null ? finalVisibleAt - submittedAt : null,
    historyListVisibleFromMountMs: historyListVisibleAt !== null && typeof measurement.mountedAt === 'number' ? historyListVisibleAt - measurement.mountedAt : null,
    historyFirstOpenVisibleFromListMs: historyFirstOpenVisibleAt !== null && historyListVisibleAt !== null ? historyFirstOpenVisibleAt - historyListVisibleAt : null,
    visibleDeltaCount: measurement.visibleDeltaCount ?? null,
    expectedDeltaCount: measurement.expectedDeltaCount ?? null,
    backendKind: measurement.backendKind ?? null,
    seedDurationMs: measurement.seedDurationMs ?? null,
    longTaskCount: Array.isArray(measurement.longTasks) ? measurement.longTasks.length : null,
    longestLongTaskMs: longTaskDurations.length > 0 ? Math.max(...longTaskDurations) : null,
  }
}

export function sanitizeWebTraceArtifact(trace) {
  const events = Array.isArray(trace?.traceEvents)
    ? trace.traceEvents
    : Array.isArray(trace?.events)
      ? trace.events
      : []
  return {
    scenario: 'per277-web-cdp-trace',
    eventCount: events.length,
    events: sanitizeTraceEvents(events),
    unavailable: trace?.unavailable === true,
    generatedAt: new Date().toISOString(),
    secretsRedacted: true,
    traceSanitization: 'allowlisted timing/category/name fields and numeric/boolean args only; URLs, text, source, stack, query, and token-like fields omitted or redacted',
  }
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

export function sanitizeAssistantMeasurementReport(report) {
  const sanitized = {
    ...report,
    url: redactReportUrl(report?.url),
    tracePath: typeof report?.tracePath === 'string' ? redactPerformanceText(basename(report.tracePath)) : null,
    navigation: sanitizeNavigationEntry(report?.navigation),
    measurement: sanitizeMeasurementObject(report?.measurement),
    summary: sanitizeStructuredValue(report?.summary, { redactStrings: true }),
    profiler: sanitizeProfilerReport(report?.profiler),
    longTasks: sanitizePerformanceEntries(report?.longTasks),
    marks: sanitizePerformanceEntries(report?.marks),
    consoleMessages: sanitizeConsoleMessages(report?.consoleMessages),
    pageErrors: sanitizePageErrors(report?.pageErrors),
    cleanup: sanitizeCleanupResult(report?.cleanup),
    parameters: sanitizeParameters(report?.parameters),
    secretsRedacted: true,
    reportSanitization: 'URLs and free-form text fields redacted; numeric timing, counts, booleans, scenario, and bounded status codes preserved',
  }
  return sanitized
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
  if (!normalized || /(url|uri|text|message|stack|script|source|data|token|secret|password|auth|query|args|snapshot|name)/iu.test(normalized)) return null
  return normalized
}

function redactTraceEventName(name, category) {
  if (/blink\.user_timing/iu.test(String(category ?? ''))) return '[redacted-user-timing]'
  return redactTraceLabel(name)
}

function redactTraceLabel(value) {
  const text = redactPerformanceText(value)
  if (/(:\/\/|[?&=]|^data:|^javascript:)/iu.test(text)) return '[redacted]'
  return text.slice(0, 160)
}

function sanitizeNavigationEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const sanitized = {}
  for (const [key, value] of Object.entries(entry)) {
    if (Number.isFinite(value) || typeof value === 'boolean') sanitized[key] = value
    else if (key === 'name' && typeof value === 'string') sanitized[key] = redactReportUrl(value)
    else if (typeof value === 'string' && /^(type|initiatorType|entryType)$/u.test(key)) sanitized[key] = redactTraceLabel(value)
  }
  return sanitized
}

function sanitizeMeasurementObject(value) {
  return sanitizeStructuredValue(value, { redactStrings: true })
}

function sanitizeProfilerReport(profiler) {
  if (!profiler || typeof profiler !== 'object') return null
  return {
    labels: Array.isArray(profiler.labels) ? profiler.labels.map(() => '[redacted-profiler-label]') : [],
    sampleCount: Number.isFinite(profiler.sampleCount) ? profiler.sampleCount : 0,
    commitDistribution: sanitizeStructuredValue(profiler.commitDistribution, { redactStrings: true }),
    samples: Array.isArray(profiler.samples) ? profiler.samples.map(sanitizeProfilerSample) : [],
  }
}

function sanitizeProfilerSample(sample) {
  if (!sample || typeof sample !== 'object') return {}
  const sanitized = {}
  for (const [key, value] of Object.entries(sample)) {
    if (key === 'label' || key === 'id') sanitized[key] = '[redacted-profiler-label]'
    else if (Number.isFinite(value) || typeof value === 'boolean') sanitized[key] = value
    else if (value == null) sanitized[key] = null
    else if (typeof value === 'string') sanitized[key] = redactPerformanceText(value)
    else if (value && typeof value === 'object') sanitized[key] = sanitizeStructuredValue(value, { redactStrings: true })
  }
  return sanitized
}

function sanitizePerformanceEntries(entries) {
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => sanitizeStructuredValue(entry, { redactStrings: true }))
}

function sanitizeConsoleMessages(messages) {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => ({
    type: redactTraceLabel(message?.type ?? 'unknown'),
    text: redactFreeText(message?.text),
  }))
}

function sanitizePageErrors(errors) {
  if (!Array.isArray(errors)) return []
  return errors.map((error) => redactFreeText(error))
}

function sanitizeCleanupResult(cleanup) {
  return sanitizeStructuredValue(cleanup, { redactStrings: true })
}

function sanitizeParameters(parameters) {
  if (!parameters || typeof parameters !== 'object') return null
  return {
    chunkCount: Number.isFinite(parameters.chunkCount) ? parameters.chunkCount : null,
    historyCount: Number.isFinite(parameters.historyCount) ? parameters.historyCount : null,
    historyBackend: redactTraceLabel(parameters.historyBackend),
    timeoutMs: Number.isFinite(parameters.timeoutMs) ? parameters.timeoutMs : null,
    profileDir: '[redacted-path]',
  }
}

function sanitizeStructuredValue(value, { redactStrings }) {
  if (value == null) return value
  if (Number.isFinite(value) || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactStrings ? redactPerformanceText(value) : value
  if (Array.isArray(value)) return value.map((item) => sanitizeStructuredValue(item, { redactStrings }))
  if (typeof value !== 'object') return null
  const sanitized = {}
  for (const [key, nested] of Object.entries(value)) {
    const safeKey = String(key ?? '').replace(/[^a-z0-9._-]+/giu, '_').slice(0, 80) || 'field'
    if (/(token|secret|password|api[_-]?key|authorization|auth)/iu.test(safeKey)) {
      sanitized[safeKey] = '[redacted]'
    } else if (typeof nested === 'string' && shouldRedactStructuredString(safeKey)) {
      sanitized[safeKey] = redactFreeText(nested)
    } else {
      sanitized[safeKey] = sanitizeStructuredValue(nested, { redactStrings })
    }
  }
  return sanitized
}


function shouldRedactStructuredString(key) {
  return /(name|label|message|error|text|stack|source|url|uri|query|path|file|selector|detail|reason)/iu.test(key)
}

function redactFreeText(value) {
  const text = redactPerformanceText(value)
  return text ? '[redacted-text]' : ''
}

function redactReportUrl(value) {
  const raw = String(value ?? '')
  if (!raw) return ''
  if (/^(data|javascript):/iu.test(raw)) return `${raw.split(':', 1)[0]}:[redacted]`
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    const query = url.search ? '?[redacted]' : ''
    const hash = url.hash ? '#[redacted]' : ''
    return `${url.origin}${url.pathname}${query}${hash}`
  } catch {
    return redactPerformanceText(raw)
  }
}

export function redactPerformanceText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s,;]+/giu, '[redacted-url]')
    .replace(/wss?:\/\/[^\s,;]+/giu, '[redacted-url]')
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/(token|secret|password|api[_-]?key|authorization|auth|roomSecret|invite)=([^\s,;&]+)/giu, '$1=[redacted]')
    .replace(/([?&](?:token|secret|password|api[_-]?key|authorization|auth|room|invite)=)[^\s,;&]+/giu, '$1[redacted]')
    .replace(/\b[A-Za-z]:\\[^\s,;]+/gu, '[redacted-path]')
    .replace(/\/(?:Users|home)\/[^\s,;]+/gu, '[redacted-path]')
    .slice(0, 4000)
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  try {
    await main()
  } catch (error) {
    console.error(redactPerformanceText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}

