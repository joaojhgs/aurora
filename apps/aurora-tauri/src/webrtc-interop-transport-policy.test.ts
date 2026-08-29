// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { forbiddenInteropTransportRequests } from '../../../tests/e2e/webrtc_interop/assertions.js'

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
})
