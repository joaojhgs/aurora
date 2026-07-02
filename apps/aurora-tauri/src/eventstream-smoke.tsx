import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuroraClient, TauriLocalTransport, type AuroraEvent } from '@aurora/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

interface SmokeReport {
  ok: boolean
  scenario: string
  receivedEvent?: SmokeReceivedEvent
  sdkClosed?: boolean
  error?: string
  secretsRedacted: true
}

interface SmokeReceivedEvent {
  id?: string | null
  kind?: string
  topic?: string | null
  payloadSummary: {
    present: boolean
    keys: string[]
    redacted: true
  }
  transport?: string | null
  correlationId?: string | null
}

export function mountEventStreamSmoke(element: HTMLElement) {
  createRoot(element).render(
    <React.StrictMode>
      <EventStreamSmoke />
    </React.StrictMode>
  )
}

function EventStreamSmoke() {
  const [status, setStatus] = useState('starting')

  useEffect(() => {
    let cancelled = false
    runEventStreamSmoke((next) => {
      if (!cancelled) setStatus(next)
    }).catch((error: unknown) => {
      console.error('Aurora EventStream smoke failed', redactSmokeError(error))
      if (!cancelled) setStatus('failed')
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Aurora EventStream Smoke</h1>
      <p data-testid="eventstream-smoke-status">{status}</p>
    </main>
  )
}

async function runEventStreamSmoke(setStatus: (status: string) => void) {
  const reportUrl = import.meta.env.VITE_AURORA_EVENTSTREAM_SMOKE_REPORT_URL
  const reportBase: SmokeReport = {
    ok: false,
    scenario: 'tauri-local-gateway-sse-to-sdk-subscription',
    secretsRedacted: true
  }

  try {
    setStatus('subscribing')
    const transport = new TauriLocalTransport({ invoke, listen })
    const client = new AuroraClient({ transport })
    const subscription = client.events.watchHealth({
      correlationId: 'tauri-eventstream-smoke',
      backfill: false
    })
    const iterator = subscription[Symbol.asyncIterator]()
    const result = await withTimeout(iterator.next(), 15_000, 'timed out waiting for EventStream smoke event')
    if (result.done || !result.value) {
      throw new Error('EventStream subscription closed before delivering an event')
    }
    const event = result.value
    subscription.close('eventstream-smoke-complete')
    await withTimeout(subscription.closed, 5_000, 'timed out waiting for SDK subscription close')
    await iterator.return?.()

    if (event.kind !== 'health.updated') {
      throw new Error(`Unexpected smoke event kind: ${event.kind}`)
    }
    setStatus('reporting')
    await postReport(reportUrl, {
      ...reportBase,
      ok: true,
      receivedEvent: serializeEvent(event),
      sdkClosed: true
    })
    setStatus('passed')
  } catch (error) {
    const message = redactSmokeError(error)
    await postReport(reportUrl, {
      ...reportBase,
      error: message
    })
    setStatus('failed')
    throw error
  }
}

export function serializeEventForSmokeReport(event: AuroraEvent): SmokeReceivedEvent {
  return {
    id: event.id,
    kind: event.kind,
    topic: event.topic,
    payloadSummary: summarizePayload(event.payload),
    transport: event.audit?.transport ?? null,
    correlationId: event.audit?.correlationId ?? null
  }
}

function serializeEvent(event: AuroraEvent): SmokeReceivedEvent {
  return serializeEventForSmokeReport(event)
}

function summarizePayload(payload: unknown): SmokeReceivedEvent['payloadSummary'] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { present: payload !== undefined && payload !== null, keys: [], redacted: true }
  }
  return {
    present: true,
    keys: Object.keys(payload).sort(),
    redacted: true
  }
}

export function redactSmokeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\bBearer\s+[^,\s;'"}`\]]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(authorization|x-aurora-sidecar-token|token|secret|password|api[_-]?key|private[_-]?key|raw[_-]?audio|audio(?:[_-]?(?:bytes|data|samples))?|pcm16)\s*[:=]\s*["']?[^,\s;'"}`\]]+/gi,
      '$1=[redacted]'
    )
}

async function postReport(url: string | undefined, report: SmokeReport) {
  if (!url) {
    throw new Error('VITE_AURORA_EVENTSTREAM_SMOKE_REPORT_URL is required')
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report)
  })
  if (!response.ok) {
    throw new Error(`smoke report server returned HTTP ${response.status}`)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
