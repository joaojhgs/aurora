// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

import {
  forbiddenInteropTransportRequests,
  pollInteropStatus,
} from '../../../tests/e2e/webrtc_interop/assertions.js'

describe('WebRTC interop transport request policy', () => {
  it('allows the exact Tauri channel bridge without permitting HTTP fallback', () => {
    const requests = [
      { url: 'http://127.0.0.1:34615/', kind: 'http' as const },
      {
        url: 'blob:http://127.0.0.1:34615/worker-id',
        kind: 'http' as const,
      },
      { url: 'ws://127.0.0.1:9001/mqtt', kind: 'websocket' as const },
      {
        url: 'http://ipc.localhost/plugin%3A__TAURI_CHANNEL__%7Cfetch',
        kind: 'http' as const,
      },
      { url: 'http://127.0.0.1:8000/api/rpc', kind: 'http' as const },
      { url: 'http://ipc.localhost/api/rpc', kind: 'http' as const },
      {
        url: 'https://ipc.localhost/plugin%3A__TAURI_CHANNEL__%7Cfetch',
        kind: 'http' as const,
      },
    ]

    expect(
      forbiddenInteropTransportRequests(
        requests,
        'http://127.0.0.1:34615/',
        'ws://127.0.0.1:9001/mqtt',
      ),
    ).toEqual(requests.slice(4))
  })

  it('retries transient status request failures while the peer stays usable', async () => {
    let currentTime = 0
    const request = vi
      .fn<(timeoutMs: number) => Promise<{ cancelled: boolean }>>()
      .mockRejectedValueOnce(new Error('DataChannel is temporarily unavailable'))
      .mockResolvedValueOnce({ cancelled: false })
      .mockResolvedValueOnce({ cancelled: true })

    const status = await pollInteropStatus({
      label: 'Python stream cancellation',
      timeoutMs: 100,
      requestTimeoutMs: 20,
      intervalMs: 5,
      request,
      isComplete: (value) => value.cancelled,
      isRetryableError: () => true,
      now: () => currentTime,
      delay: async (milliseconds) => {
        currentTime += milliseconds
      },
    })

    expect(status).toEqual({ cancelled: true })
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenCalledWith(20)
  })

  it('surfaces status failures immediately when the peer is no longer usable', async () => {
    const failure = new Error('WebRTC session closed')

    await expect(
      pollInteropStatus({
        label: 'Python stream cancellation',
        timeoutMs: 100,
        requestTimeoutMs: 20,
        intervalMs: 5,
        request: vi.fn().mockRejectedValue(failure),
        isComplete: () => false,
        isRetryableError: () => false,
      }),
    ).rejects.toBe(failure)
  })
})
