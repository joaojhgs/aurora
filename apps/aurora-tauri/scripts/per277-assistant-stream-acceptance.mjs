import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { AuroraClient, HttpGatewayTransport } from '@aurora/client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const defaultReportPath = resolve(appDir, 'reports/per277-assistant-stream-acceptance.json')
const DEFAULT_CHUNK_COUNT = 140
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CORRELATION_ID = 'per277-correlated-assistant-stream'

export async function runPer277AssistantStreamAcceptance(options = {}) {
  const chunkCount = positiveInteger(options.chunkCount ?? process.env.PER277_ASSISTANT_STREAM_CHUNKS, DEFAULT_CHUNK_COUNT)
  const timeoutMs = positiveInteger(options.timeoutMs ?? process.env.PER277_ASSISTANT_STREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const correlationId = nonEmptyString(options.correlationId ?? process.env.PER277_ASSISTANT_STREAM_CORRELATION_ID, DEFAULT_CORRELATION_ID)
  const reportPath = resolve(String(options.reportPath ?? process.env.PER277_ASSISTANT_STREAM_REPORT ?? defaultReportPath))
  const maxTotalMs = optionalPositiveNumber(options.maxTotalMs ?? process.env.PER277_ASSISTANT_STREAM_MAX_TOTAL_MS)
  const chunkIntervalMs = nonNegativeInteger(options.chunkIntervalMs ?? process.env.PER277_ASSISTANT_STREAM_CHUNK_INTERVAL_MS, 0)
  const chunks = buildAssistantChunks(chunkCount)
  const gateway = await createAssistantStreamGateway({ chunks, correlationId, chunkIntervalMs })
  const controller = new AbortController()
  const startedAt = performance.now()
  const timeout = setTimeout(() => controller.abort(new Error(`PER-277 assistant stream timed out after ${timeoutMs}ms`)), timeoutMs)

  try {
    const client = new AuroraClient({
      transport: new HttpGatewayTransport({
        baseUrl: gateway.baseUrl,
        bearerToken: 'per277-loopback-stream-token',
        defaultTimeoutMs: timeoutMs,
      }),
    })
    const subscription = client.events.streamAssistant(undefined, {
      correlationId,
      backfill: false,
      reconnect: { maxAttempts: 0 },
      signal: controller.signal,
      headers: { 'X-Aurora-PER277-Acceptance': 'assistant-stream' },
      audit: {
        correlationId,
        method: 'Orchestrator.ExternalUserInput',
        busTopic: 'Orchestrator.ExternalUserInput',
        transport: 'http',
      },
    })
    const received = []
    let firstEventAt = null
    for await (const event of subscription) {
      if (firstEventAt === null) firstEventAt = performance.now()
      received.push(event)
      if (event.kind === 'assistant.completed') {
        subscription.close('per277-completed')
        break
      }
    }
    await Promise.race([subscription.closed, rejectAfter(5_000, 'subscription did not close after completed event')])
    const report = validateAssistantStreamReport({
      chunks,
      correlationId,
      received,
      gateway: gateway.snapshot(),
      timings: {
        firstEventLatencyMs: firstEventAt === null ? null : round(firstEventAt - startedAt),
        totalMs: round(performance.now() - startedAt),
      },
      maxTotalMs,
    })
    await writeJsonReport(reportPath, report)
    return report
  } catch (error) {
    await writeJsonReport(reportPath, {
      ok: false,
      scenario: 'per277-assistant-140-correlated-stream',
      error: redactError(error),
      expected: { chunkCount, correlationId },
      gateway: gateway.snapshot(),
      generatedAt: new Date().toISOString(),
      secretsRedacted: true,
    })
    throw error
  } finally {
    clearTimeout(timeout)
    controller.abort()
    await gateway.close()
  }
}

export function buildAssistantChunks(count = DEFAULT_CHUNK_COUNT) {
  return Array.from({ length: count }, (_value, index) => {
    const sequence = index + 1
    return {
      id: `per277-delta-${String(sequence).padStart(3, '0')}`,
      sequence,
      text: `chunk-${String(sequence).padStart(3, '0')} `,
    }
  })
}

export async function createAssistantStreamGateway({ chunks, correlationId, chunkIntervalMs = 0 }) {
  const requests = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, service: 'per277-assistant-stream-gateway' }))
      return
    }
    if (url.pathname !== '/api/events/stream') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found', secretsRedacted: true }))
      return
    }

    const requestRecord = {
      url: request.url,
      stream: url.searchParams.get('stream'),
      topics: url.searchParams.getAll('topic'),
      kinds: url.searchParams.getAll('kind'),
      correlationId: url.searchParams.get('correlation_id'),
      hasAuthorization: Boolean(request.headers.authorization),
      acceptanceHeader: request.headers['x-aurora-per277-acceptance'] ?? null,
      openedAt: new Date().toISOString(),
      closed: false,
    }
    requests.push(requestRecord)
    request.on('close', () => {
      requestRecord.closed = true
      requestRecord.closedAt = new Date().toISOString()
    })

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-aurora-correlation-id': correlationId,
    })
    response.write(': per277 assistant stream ready\n\n')

    for (const chunk of chunks) {
      writeSse(response, assistantDeltaEvent(chunk, correlationId))
      if (chunkIntervalMs > 0) await delay(chunkIntervalMs)
    }
    writeSse(response, assistantCompletedEvent(chunks, correlationId))
    response.end()
  })
  const baseUrl = await listen(server)
  return {
    baseUrl,
    snapshot() {
      return {
        requestCount: requests.length,
        requests: requests.map((request) => ({ ...request })),
        secretsRedacted: true,
      }
    },
    close() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise())
      })
    },
  }
}

export function validateAssistantStreamReport({ chunks, correlationId, received, gateway, timings, maxTotalMs }) {
  const deltas = received.filter((event) => event.kind === 'assistant.delta')
  const completed = received.filter((event) => event.kind === 'assistant.completed')
  const expectedText = chunks.map((chunk) => chunk.text).join('')
  const errors = []
  const request = gateway.requests[0]

  if (gateway.requestCount !== 1) errors.push(`expected exactly one stream request, received ${gateway.requestCount}`)
  if (!request) {
    errors.push('gateway did not receive a stream request')
  } else {
    if (request.stream !== 'assistant') errors.push(`expected stream=assistant, received ${String(request.stream)}`)
    if (!request.topics.includes('Orchestrator.Response')) errors.push('missing Orchestrator.Response topic query')
    if (!request.kinds.includes('assistant.delta')) errors.push('missing assistant.delta kind query')
    if (!request.kinds.includes('assistant.completed')) errors.push('missing assistant.completed kind query')
    if (request.correlationId !== correlationId) errors.push(`expected query correlation ${correlationId}, received ${String(request.correlationId)}`)
    if (!request.hasAuthorization) errors.push('fetch-backed SSE authorization header was not sent')
  }

  if (deltas.length !== chunks.length) errors.push(`expected ${chunks.length} assistant.delta events, received ${deltas.length}`)
  if (completed.length !== 1) errors.push(`expected one assistant.completed event, received ${completed.length}`)

  for (let index = 0; index < chunks.length; index += 1) {
    const expected = chunks[index]
    const observed = deltas[index]
    if (!observed) break
    const payload = asRecord(observed.payload)
    if (observed.id !== expected.id) errors.push(`delta ${index} id mismatch: ${String(observed.id)} !== ${expected.id}`)
    if (observed.topic !== 'Orchestrator.Response') errors.push(`delta ${index} topic mismatch: ${String(observed.topic)}`)
    if (stringField(payload, 'text', 'delta', 'content') !== expected.text) errors.push(`delta ${index} text mismatch`)
    if (numberField(payload, 'sequence', 'index', 'chunk_index') !== expected.sequence) errors.push(`delta ${index} sequence mismatch`)
    if (eventCorrelation(observed, payload) !== correlationId) errors.push(`delta ${index} correlation mismatch`)
  }

  const completedPayload = asRecord(completed[0]?.payload)
  const completedText = stringField(completedPayload, 'text', 'final_text', 'content') ?? ''
  if (completedText !== expectedText) errors.push('assistant.completed final text did not equal the concatenated delta text')
  if (completed[0] && eventCorrelation(completed[0], completedPayload) !== correlationId) errors.push('assistant.completed correlation mismatch')
  if (typeof maxTotalMs === 'number' && timings.totalMs > maxTotalMs) {
    errors.push(`total stream time ${timings.totalMs}ms exceeded PER277_ASSISTANT_STREAM_MAX_TOTAL_MS=${maxTotalMs}ms`)
  }

  const report = {
    ok: errors.length === 0,
    scenario: 'per277-assistant-140-correlated-stream',
    expected: {
      chunkCount: chunks.length,
      correlationId,
      finalTextBytes: Buffer.byteLength(expectedText, 'utf8'),
      optionalMaxTotalMs: maxTotalMs ?? null,
    },
    observed: {
      eventCount: received.length,
      deltaCount: deltas.length,
      completedCount: completed.length,
      idsInOrder: deltas.map((event) => event.id),
      finalTextBytes: Buffer.byteLength(completedText, 'utf8'),
      transports: [...new Set(received.map((event) => event.audit?.transport ?? null))],
      topics: [...new Set(received.map((event) => event.topic ?? null))],
    },
    timings,
    gateway,
    errors,
    generatedAt: new Date().toISOString(),
    secretsRedacted: true,
  }
  if (!report.ok) throw new Error(`PER-277 assistant stream acceptance failed: ${errors.join('; ')}`)
  return report
}

function assistantDeltaEvent(chunk, correlationId) {
  return {
    id: chunk.id,
    kind: 'assistant.delta',
    topic: 'Orchestrator.Response',
    correlation_id: correlationId,
    payload: { text: chunk.text, delta: chunk.text, sequence: chunk.sequence, correlation_id: correlationId, request_id: correlationId },
    audit: audit(correlationId),
    redaction: { secrets_redacted: true },
  }
}

function assistantCompletedEvent(chunks, correlationId) {
  const text = chunks.map((chunk) => chunk.text).join('')
  return {
    id: 'per277-completed',
    kind: 'assistant.completed',
    topic: 'Orchestrator.Response',
    correlation_id: correlationId,
    payload: { text, final_text: text, chunk_count: chunks.length, correlation_id: correlationId, request_id: correlationId },
    audit: audit(correlationId),
    redaction: { secrets_redacted: true },
  }
}

function audit(correlationId) {
  return {
    correlation_id: correlationId,
    method: 'Orchestrator.Response',
    bus_topic: 'Orchestrator.Response',
    transport: 'sse',
    redaction: { secrets_redacted: true },
  }
}

function writeSse(response, event) {
  response.write(`id: ${event.id}\n`)
  response.write(`event: ${event.kind}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function listen(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') rejectPromise(new Error('PER-277 assistant stream gateway did not bind to TCP'))
      else resolvePromise(`http://127.0.0.1:${address.port}`)
    })
  })
}

function eventCorrelation(event, payload) {
  return event.audit?.correlationId ?? event.audit?.correlation_id ?? event.correlationId ?? event.correlation_id ?? payload.correlation_id ?? payload.correlationId ?? null
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function stringField(record, ...keys) {
  for (const key of keys) if (typeof record[key] === 'string') return record[key]
  return null
}

function numberField(record, ...keys) {
  for (const key of keys) if (Number.isFinite(record[key])) return Number(record[key])
  return null
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
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

async function writeJsonReport(path, report) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function redactError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]').replace(/(token|secret|password|api[_-]?key)=([^\s,;]+)/giu, '$1=[redacted]')
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedAsScript) {
  try {
    const report = await runPer277AssistantStreamAcceptance()
    console.log(JSON.stringify({ ok: report.ok, report: process.env.PER277_ASSISTANT_STREAM_REPORT ?? defaultReportPath }, null, 2))
  } catch (error) {
    console.error(redactError(error))
    process.exitCode = 1
  }
}
