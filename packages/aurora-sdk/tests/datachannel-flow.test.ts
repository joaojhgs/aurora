import { describe, expect, it } from 'vitest'

import { DataChannelFlowController, sendOrderedWithBackpressure } from '../src/webrtc/index.js'

class FakeDataChannel {
  readyState = 'open'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  sent: Array<string | ArrayBuffer | ArrayBufferView> = []
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()

  send(payload: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(payload)
    this.bufferedAmount += typeof payload === 'string' ? payload.length : payload.byteLength
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(type) ?? new Set()
    bucket.add(listener)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  drainTo(bufferedAmount: number): void {
    this.bufferedAmount = bufferedAmount
    for (const listener of this.listeners.get('bufferedamountlow') ?? []) {
      listener()
    }
  }
}

describe('DataChannel flow control', () => {
  it('waits for bufferedamountlow and aborts on close', async () => {
    const channel = new FakeDataChannel()
    const controller = new DataChannelFlowController(channel, {
      lowWatermarkBytes: 4,
      highWatermarkBytes: 8,
      maxQueueBytes: 64
    })

    channel.bufferedAmount = 16
    const signal = new AbortController()
    const send = controller.send('hello', signal.signal)
    channel.drainTo(2)
    await expect(send).resolves.toBe(true)
    expect(channel.sent).toEqual(['hello'])

    channel.readyState = 'closed'
    await expect(sendOrderedWithBackpressure(channel, 'again')).resolves.toBe(false)
    signal.abort()
    controller.close()
  })

  it('rejects payloads larger than the bounded queue', async () => {
    const channel = new FakeDataChannel()
    await expect(
      sendOrderedWithBackpressure(channel, 'x'.repeat(128), { maxQueueBytes: 16 })
    ).resolves.toBe(false)
  })
})
