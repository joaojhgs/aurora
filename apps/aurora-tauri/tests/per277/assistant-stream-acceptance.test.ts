import { describe, expect, it } from 'vitest'

import {
  buildAssistantChunks,
  validateAssistantStreamReport,
} from '../../scripts/per277-assistant-stream-acceptance.mjs'

describe('PER-277 assistant stream acceptance helpers', () => {
  it('builds 140 deterministic assistant delta chunks by default', () => {
    const chunks = buildAssistantChunks()

    expect(chunks).toHaveLength(140)
    expect(chunks[0]).toMatchObject({ id: 'per277-delta-001', sequence: 1, text: 'chunk-001 ' })
    expect(chunks[139]).toMatchObject({ id: 'per277-delta-140', sequence: 140, text: 'chunk-140 ' })
  })

  it('requires ordered correlated deltas and a completed final text', () => {
    const chunks = buildAssistantChunks(3)
    const correlationId = 'per277-test-correlation'
    const received = [
      event(chunks[0], correlationId),
      event(chunks[1], correlationId),
      event(chunks[2], correlationId),
      {
        id: 'per277-completed',
        kind: 'assistant.completed',
        topic: 'Orchestrator.Response',
        payload: {
          text: chunks.map((chunk) => chunk.text).join(''),
          correlation_id: correlationId,
        },
        audit: { correlationId, transport: 'http' },
      },
    ]

    const report = validateAssistantStreamReport({
      chunks,
      correlationId,
      received,
      gateway: {
        requestCount: 1,
        requests: [{
          stream: 'assistant',
          topics: ['Orchestrator.Response', 'TTS.AudioChunk'],
          kinds: ['assistant.delta', 'assistant.completed'],
          correlationId,
          hasAuthorization: true,
        }],
        secretsRedacted: true,
      },
      timings: { firstEventLatencyMs: 1, totalMs: 2 },
      maxTotalMs: null,
    })

    expect(report.ok).toBe(true)
    expect(report.observed.deltaCount).toBe(3)
    expect(report.observed.finalTextBytes).toBe(Buffer.byteLength('chunk-001 chunk-002 chunk-003 ', 'utf8'))
  })

  it('rejects duplicate or out-of-order stream ids', () => {
    const chunks = buildAssistantChunks(2)
    const correlationId = 'per277-test-correlation'
    const received = [
      event(chunks[1], correlationId),
      event(chunks[0], correlationId),
      {
        id: 'per277-completed',
        kind: 'assistant.completed',
        topic: 'Orchestrator.Response',
        payload: {
          text: chunks.map((chunk) => chunk.text).join(''),
          correlation_id: correlationId,
        },
        audit: { correlationId, transport: 'http' },
      },
    ]

    expect(() => validateAssistantStreamReport({
      chunks,
      correlationId,
      received,
      gateway: {
        requestCount: 1,
        requests: [{
          stream: 'assistant',
          topics: ['Orchestrator.Response'],
          kinds: ['assistant.delta', 'assistant.completed'],
          correlationId,
          hasAuthorization: true,
        }],
        secretsRedacted: true,
      },
      timings: { firstEventLatencyMs: 1, totalMs: 2 },
      maxTotalMs: null,
    })).toThrow(/id mismatch/u)
  })
})

function event(chunk: { id: string; sequence: number; text: string }, correlationId: string) {
  return {
    id: chunk.id,
    kind: 'assistant.delta',
    topic: 'Orchestrator.Response',
    payload: {
      text: chunk.text,
      sequence: chunk.sequence,
      correlation_id: correlationId,
    },
    audit: { correlationId, transport: 'http' },
  }
}
