import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuroraClient, TauriLocalTransport, type AuroraEvent } from '@aurora/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

interface SmokeReport {
  ok: boolean
  scenario: string
  receivedEvent?: {
    id?: string | null
    kind?: string
    topic?: string | null
    payload?: unknown
    transport?: string | null
    correlationId?: string | null
  }
  sdkClosed?: boolean
  error?: string
  secretsRedacted: true
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
      console.error('Aurora EventStream smoke failed', error)
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
    const message = error instanceof Error ? error.message : String(error)
    await postReport(reportUrl, {
      ...reportBase,
      error: message
    })
    setStatus('failed')
    throw error
  }
}

function serializeEvent(event: AuroraEvent): SmokeReport['receivedEvent'] {
  return {
    id: event.id,
    kind: event.kind,
    topic: event.topic,
    payload: event.payload,
    transport: event.audit?.transport ?? null,
    correlationId: event.audit?.correlationId ?? null
  }
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
