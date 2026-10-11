import { describe, expect, it } from 'vitest'
import {
  redactPerformanceText,
  sanitizeAssistantMeasurementReport,
  sanitizeTraceEvents,
  sanitizeWebTraceArtifact,
} from './per277-measure-assistant-ui.mjs'

const forbidden = /PER277_PRIVATE_CANARY_A7F2|token-123|bearer-secret|room-secret|api-key-value|alice|private-query|custom secret mark|SensitiveProfiler|stack private|selector-secret/iu

describe('PER-277 assistant UI measurement redaction', () => {
  it('sanitizes CDP trace events while preserving timing evidence', () => {
    const events = sanitizeTraceEvents([
      {
        cat: 'blink.user_timing',
        name: 'custom secret mark token-123',
        ph: 'X',
        pid: 7,
        tid: 8,
        ts: 100,
        dur: 12.5,
        args: {
          frame: 4,
          ok: true,
          url: 'https://example.test/?token=token-123',
          message: 'PER277_PRIVATE_CANARY_A7F2',
          nested: { count: 2, source: 'selector-secret' },
        },
      },
      {
        cat: 'devtools.timeline',
        name: 'Layout',
        ph: 'I',
        ts: 120,
        args: { dirtyObjects: 9 },
      },
    ])

    expect(events[0]).toMatchObject({
      cat: 'blink.user_timing',
      name: '[redacted-user-timing]',
      ph: 'X',
      pid: 7,
      tid: 8,
      ts: 100,
      dur: 12.5,
      args: { frame: 4, ok: true, nested: { count: 2 } },
    })
    expect(events[0]?.args).not.toHaveProperty('url')
    expect(events[0]?.args).not.toHaveProperty('message')
    expect(events[1]).toMatchObject({ name: 'Layout', ts: 120, args: { dirtyObjects: 9 } })
    expect(JSON.stringify(events)).not.toMatch(forbidden)
  })

  it('wraps sanitized traces with explicit redaction provenance', () => {
    const trace = sanitizeWebTraceArtifact({
      traceEvents: [{ cat: 'blink.user_timing', name: 'PER277_PRIVATE_CANARY_A7F2', ts: 1, args: { duration: 22 } }],
    })

    expect(trace).toMatchObject({
      scenario: 'per277-web-cdp-trace',
      eventCount: 1,
      secretsRedacted: true,
    })
    expect(trace.traceSanitization).toContain('allowlisted')
    expect(trace.events[0]).toMatchObject({ name: '[redacted-user-timing]', ts: 1, args: { duration: 22 } })
    expect(JSON.stringify(trace)).not.toMatch(forbidden)
  })

  it('redacts report URLs, console/page errors, marks, profiler labels, and error strings without dropping metrics', () => {
    const report = sanitizeAssistantMeasurementReport({
      scenario: 'per277-assistant-stream',
      url: 'https://user:pass@example.test/per277?case=stream&token=token-123&private-query=PER277_PRIVATE_CANARY_A7F2#secret-fragment',
      generatedAt: '2026-09-16T00:00:00.000Z',
      navigationWallMs: 345.6,
      tracePath: '/home/alice/per277/raw-trace.json',
      metrics: { JSHeapUsedSize: 12345 },
      navigation: {
        name: 'https://example.test/per277?token=token-123&private-query=PER277_PRIVATE_CANARY_A7F2',
        startTime: 0,
        duration: 88,
        type: 'navigate',
      },
      measurement: {
        submittedAt: 10,
        finalVisibleAt: 30,
        visibleDeltaCount: 140,
        cleanupError: 'cleanup failed token=token-123 /home/alice/private',
        backendKind: 'indexeddb',
      },
      summary: { finalVisibleLatencyMs: 20, visibleDeltaCount: 140 },
      profiler: {
        labels: ['SensitiveProfiler token-123'],
        sampleCount: 1,
        commitDistribution: { count: 1, p95: 4.2 },
        samples: [{ label: 'SensitiveProfiler token-123', actualDuration: 4.2, startTime: 20 }],
      },
      longTasks: [{ name: 'custom secret mark', startTime: 1, duration: 55 }],
      marks: [{ name: 'custom secret mark', startTime: 2, duration: 0 }],
      consoleMessages: [{ type: 'error', text: 'Bearer bearer-secret token=token-123' }],
      pageErrors: ['stack private token=token-123 at /home/alice/app.tsx'],
      cleanup: { state: 'failed', error: 'roomSecret=room-secret' },
      parameters: { chunkCount: 140, historyCount: 120, historyBackend: 'indexeddb', timeoutMs: 30000, profileDir: '/home/alice/profile' },
    })

    expect(report).toMatchObject({
      scenario: 'per277-assistant-stream',
      navigationWallMs: 345.6,
      tracePath: 'raw-trace.json',
      secretsRedacted: true,
      metrics: { JSHeapUsedSize: 12345 },
      navigation: { startTime: 0, duration: 88, type: 'navigate' },
      measurement: {
        submittedAt: 10,
        finalVisibleAt: 30,
        visibleDeltaCount: 140,
        cleanupError: '[redacted-text]',
        backendKind: 'indexeddb',
      },
      profiler: {
        labels: ['[redacted-profiler-label]'],
        sampleCount: 1,
        commitDistribution: { count: 1, p95: 4.2 },
        samples: [{ label: '[redacted-profiler-label]', actualDuration: 4.2, startTime: 20 }],
      },
      parameters: { chunkCount: 140, historyCount: 120, historyBackend: 'indexeddb', timeoutMs: 30000, profileDir: '[redacted-path]' },
    })
    expect(report.url).toBe('https://example.test/per277?[redacted]#[redacted]')
    expect(report.consoleMessages).toEqual([{ type: 'error', text: '[redacted-text]' }])
    expect(report.pageErrors).toEqual(['[redacted-text]'])
    expect(report.marks[0]).toMatchObject({ name: '[redacted-text]', startTime: 2, duration: 0 })
    expect(JSON.stringify(report)).not.toMatch(forbidden)
  })

  it('redacts common secret-bearing text directly', () => {
    expect(redactPerformanceText('Bearer bearer-secret token=token-123 https://example.test/?api_key=api-key-value /home/alice/file'))
      .not.toMatch(forbidden)
  })
})
