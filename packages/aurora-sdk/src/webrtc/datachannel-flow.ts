export interface DataChannelLike {
  readyState: string
  bufferedAmount: number
  bufferedAmountLowThreshold: number
  send(data: string | ArrayBuffer | ArrayBufferView): void
  addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
  removeEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
  on?(type: string, listener: (...args: unknown[]) => void): void
  removeListener?(type: string, listener: (...args: unknown[]) => void): void
}

export interface DataChannelFlowLimits {
  lowWatermarkBytes: number
  highWatermarkBytes: number
  maxQueueBytes: number
}

export const DEFAULT_DATA_CHANNEL_FLOW_LIMITS: DataChannelFlowLimits = {
  lowWatermarkBytes: 64 * 1024,
  highWatermarkBytes: 512 * 1024,
  maxQueueBytes: 16 * 1024 * 1024
}

export class DataChannelFlowController {
  private readonly limits: DataChannelFlowLimits
  private readonly pending = new Set<() => void>()
  private closed = false

  constructor(private readonly channel: DataChannelLike, limits: Partial<DataChannelFlowLimits> = {}) {
    this.limits = { ...DEFAULT_DATA_CHANNEL_FLOW_LIMITS, ...limits }
    this.channel.bufferedAmountLowThreshold = this.limits.lowWatermarkBytes
    this.onBufferedAmountLow = this.onBufferedAmountLow.bind(this)
    this.onClose = this.onClose.bind(this)
    this.addListener('bufferedamountlow', this.onBufferedAmountLow)
    this.addListener('close', this.onClose)
    this.addListener('error', this.onClose)
  }

  async send(payload: string | ArrayBuffer | ArrayBufferView, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || this.channel.readyState !== 'open') return false
    const byteLength = estimatePayloadBytes(payload)
    if (byteLength > this.limits.maxQueueBytes) return false

    while (!this.closed && this.channel.readyState === 'open') {
      if (signal?.aborted) return false
      if (this.channel.bufferedAmount <= this.limits.highWatermarkBytes) break
      await this.waitForDrain(signal)
    }
    if (this.closed || this.channel.readyState !== 'open') return false
    if (this.channel.bufferedAmount + byteLength > this.limits.maxQueueBytes) return false
    this.channel.send(payload)
    return true
  }

  close(): void {
    this.onClose()
  }

  private async waitForDrain(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.pending.delete(finish)
        resolve()
      }
      this.pending.add(finish)
      const abort = () => {
        this.pending.delete(finish)
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (this.closed) {
        abort()
      }
    })
  }

  private onBufferedAmountLow(): void {
    if (this.channel.bufferedAmount > this.limits.lowWatermarkBytes) return
    for (const resolve of [...this.pending]) resolve()
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    for (const resolve of [...this.pending]) resolve()
    this.pending.clear()
    this.removeListener('bufferedamountlow', this.onBufferedAmountLow)
    this.removeListener('close', this.onClose)
    this.removeListener('error', this.onClose)
  }

  private addListener(type: string, listener: (...args: unknown[]) => void): void {
    if (typeof this.channel.addEventListener === 'function') {
      this.channel.addEventListener(type, listener as EventListener)
      return
    }
    if (typeof this.channel.on === 'function') {
      this.channel.on(type, listener)
    }
  }

  private removeListener(type: string, listener: (...args: unknown[]) => void): void {
    if (typeof this.channel.removeEventListener === 'function') {
      this.channel.removeEventListener(type, listener as EventListener)
      return
    }
    if (typeof this.channel.removeListener === 'function') {
      this.channel.removeListener(type, listener)
    }
  }
}

export async function sendOrderedWithBackpressure(
  channel: DataChannelLike,
  payload: string | ArrayBuffer | ArrayBufferView,
  options: Partial<DataChannelFlowLimits> = {},
  signal?: AbortSignal
): Promise<boolean> {
  const controller = new DataChannelFlowController(channel, options)
  try {
    return await controller.send(payload, signal)
  } finally {
    controller.close()
  }
}

function estimatePayloadBytes(payload: string | ArrayBuffer | ArrayBufferView): number {
  if (typeof payload === 'string') {
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(payload).length : payload.length
  }
  if (payload instanceof ArrayBuffer) return payload.byteLength
  return payload.byteLength
}
