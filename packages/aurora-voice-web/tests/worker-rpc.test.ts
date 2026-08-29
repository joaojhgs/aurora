import { describe, expect, it, vi } from 'vitest'

import {
  AuroraAcknowledgedWorkerHost,
  type AuroraBrowserWorkerPort
} from '../src/worker-rpc.js'
import {
  AURORA_VOICE_WORKER_PROTOCOL_VERSION,
  type AuroraVoiceWorkerRequestEnvelope,
  type AuroraVoiceWorkerResponseEnvelope
} from '../src/types.js'

describe('AuroraAcknowledgedWorkerHost', () => {
  it('uses transfer lists and correlates acknowledgements by bounded request id', async () => {
    const port = new FakeWorkerPort()
    const host = new AuroraAcknowledgedWorkerHost(port)
    const buffer = new ArrayBuffer(4)
    const result = host.request({ type: 'shutdown', generation: 7, reason: 'test' }, { transfer: [buffer] })

    expect(port.posts[0]?.message.requestId).toBe(1)
    expect(port.posts[0]?.transfer).toEqual([buffer])
    port.reply(0, { type: 'ack', sessionId: '', generation: 7, sequence: null })
    await expect(result).resolves.toMatchObject({ type: 'ack', generation: 7 })
  })

  it('times out pending requests and keeps later requests usable', async () => {
    vi.useFakeTimers()
    const port = new FakeWorkerPort()
    const host = new AuroraAcknowledgedWorkerHost(port, { timeoutMs: 10 })
    const pending = host.request({ type: 'shutdown', generation: 1, reason: 'test' })
    const timedOut = expect(pending).rejects.toMatchObject({ code: 'worker_timeout' })
    await vi.advanceTimersByTimeAsync(11)
    await timedOut

    const next = host.request({ type: 'shutdown', generation: 2, reason: 'test' })
    port.reply(1, { type: 'ack', sessionId: '', generation: 2, sequence: null })
    await expect(next).resolves.toMatchObject({ generation: 2 })
    vi.useRealTimers()
  })

  it('accepts the maximum production TTS timeout and rejects larger values', async () => {
    const port = new FakeWorkerPort()
    const host = new AuroraAcknowledgedWorkerHost(port)
    const pending = host.request(
      { type: 'shutdown', generation: 1, reason: 'test' },
      { timeoutMs: 900_000 }
    )
    port.reply(0, { type: 'ack', sessionId: '', generation: 1, sequence: null })
    await expect(pending).resolves.toMatchObject({ generation: 1 })
    await expect(
      host.request(
        { type: 'shutdown', generation: 2, reason: 'test' },
        { timeoutMs: 900_001 }
      )
    ).rejects.toMatchObject({ code: 'invalid_option' })
  })

  it('preserves only sanitized worker rejection codes', async () => {
    const port = new FakeWorkerPort()
    const host = new AuroraAcknowledgedWorkerHost(port)
    const specific = host.request({ type: 'shutdown', generation: 1, reason: 'test' })
    port.reply(0, {
      type: 'reject',
      sessionId: null,
      generation: 1,
      sequence: null,
      reason: 'model_hash_mismatch'
    })
    await expect(specific).rejects.toMatchObject({ code: 'model_hash_mismatch' })

    const unsafe = host.request({ type: 'shutdown', generation: 2, reason: 'test' })
    port.reply(1, {
      type: 'reject',
      sessionId: null,
      generation: 2,
      sequence: null,
      reason: 'secret/path'
    })
    await expect(unsafe).rejects.toMatchObject({ code: 'worker_rejected' })
  })

  it('ignores unknown late replies but rejects pending requests on malformed replies and worker crashes', async () => {
    const port = new FakeWorkerPort()
    const host = new AuroraAcknowledgedWorkerHost(port)
    const first = host.request({ type: 'shutdown', generation: 1, reason: 'test' })
    const second = host.request({ type: 'shutdown', generation: 2, reason: 'test' })
    port.emitMessage({ protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION, requestId: 99, response: { type: 'ack', sessionId: '', generation: 99, sequence: null } })

    port.reply(0, { type: 'ack', sessionId: '', generation: 1, sequence: null })
    port.reply(1, { type: 'ack', sessionId: '', generation: 2, sequence: null })
    await expect(first).resolves.toMatchObject({ generation: 1 })
    await expect(second).resolves.toMatchObject({ generation: 2 })

    const malformedFirst = host.request({ type: 'shutdown', generation: 4, reason: 'test' })
    const malformedSecond = host.request({ type: 'shutdown', generation: 5, reason: 'test' })
    port.emitMessage({ protocolVersion: 0, requestId: 3, response: { type: 'ack', sessionId: '', generation: 4, sequence: null } })
    await expect(malformedFirst).rejects.toMatchObject({ code: 'worker_protocol' })
    await expect(malformedSecond).rejects.toMatchObject({ code: 'worker_protocol' })

    const third = host.request({ type: 'shutdown', generation: 3, reason: 'test' })
    port.emitFatal('error')
    await expect(third).rejects.toMatchObject({ code: 'worker_failed' })
  })

  it('enforces max in-flight requests', async () => {
    const port = new FakeWorkerPort()
    const host = new AuroraAcknowledgedWorkerHost(port, { maxInFlight: 1 })
    const first = host.request({ type: 'shutdown', generation: 1, reason: 'test' })
    await expect(host.request({ type: 'shutdown', generation: 2, reason: 'test' })).rejects.toMatchObject({ code: 'worker_backpressure' })
    port.reply(0, { type: 'ack', sessionId: '', generation: 1, sequence: null })
    await expect(first).resolves.toMatchObject({ generation: 1 })
  })
})

class FakeWorkerPort implements AuroraBrowserWorkerPort {
  readonly posts: { readonly message: AuroraVoiceWorkerRequestEnvelope; readonly transfer: readonly Transferable[] }[] = []
  private messageListener: ((event: MessageEvent<unknown>) => void) | null = null
  private fatalListeners: (() => void)[] = []

  postMessage(message: AuroraVoiceWorkerRequestEnvelope, transfer: readonly Transferable[] = []): void {
    this.posts.push({ message, transfer })
  }

  addEventListener(type: 'message' | 'messageerror' | 'error', listener: ((event: MessageEvent<unknown>) => void) | (() => void)): void {
    if (type === 'message') {
      this.messageListener = listener as (event: MessageEvent<unknown>) => void
      return
    }
    this.fatalListeners.push(listener as () => void)
  }

  removeEventListener(): void {
    // Test fake keeps listener lifecycle intentionally simple.
  }

  reply(index: number, response: AuroraVoiceWorkerResponseEnvelope['response']): void {
    const post = this.posts[index]
    if (post === undefined) throw new Error('missing post')
    this.emitMessage({
      protocolVersion: AURORA_VOICE_WORKER_PROTOCOL_VERSION,
      requestId: post.message.requestId,
      response
    })
  }

  emitMessage(data: unknown): void {
    this.messageListener?.({ data } as MessageEvent<unknown>)
  }

  emitFatal(_type: 'error' | 'messageerror'): void {
    for (const listener of this.fatalListeners) listener()
  }
}
