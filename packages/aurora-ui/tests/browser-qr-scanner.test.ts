// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeMeshInviteToken, scanQrInviteWithBrowserCamera } from '../src/index'

const invite = encodeMeshInviteToken({
  kind: 'aurora.mesh.invite',
  version: 1,
  generated_at: '2026-07-27T00:00:00Z',
  node: {
    peer_id: 'host-peer',
    node_name: 'Aurora host',
  },
  signaling: {
    provider: 'mqtt',
    app_id: 'aurora',
    room: 'scanner-room',
    room_password: 'scanner-secret',
    mqtt_brokers: ['wss://signal.example.test/mqtt'],
  },
  webrtc: {
    app_layer_e2ee: true,
    stun_servers: [],
    turn_servers: [],
  },
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('browser QR invite scanner', () => {
  it('returns a valid Aurora invite and always releases the camera/overlay', async () => {
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }))
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const detect = vi.fn(async () => [{ rawValue: invite }])
    vi.stubGlobal('BarcodeDetector', class {
      detect = detect
    })

    await expect(scanQrInviteWithBrowserCamera({ timeoutMs: 500 })).resolves.toBe(invite)

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: 'environment' } },
    })
    expect(detect).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[aria-label="Scan Aurora QR invite"]')).toBeNull()
  })

  it('fails before camera access when browser QR decoding is unavailable', async () => {
    const getUserMedia = vi.fn()
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    vi.stubGlobal('BarcodeDetector', undefined)

    await expect(scanQrInviteWithBrowserCamera()).rejects.toThrow(
      /does not provide camera QR decoding/i,
    )
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})
