import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rootIndexPath = resolve(packageRoot, 'src/index.ts')
const webrtcIndexPath = resolve(packageRoot, 'src/webrtc/index.ts')
const packageJsonPath = resolve(packageRoot, 'package.json')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('WebRTC package boundary', () => {
  it('keeps the SDK root source graph free of WebRTC runtime imports', () => {
    const root = read(rootIndexPath)
    expect(root).not.toMatch(/from ['"]\.\/webrtc\//u)
    expect(root).not.toMatch(/from ['"]\.\/webrtc['"]/u)
    expect(root).not.toContain('deriveRoomKeys')
    expect(root).not.toContain('MqttWebSocketSignalingClient')
    expect(root).not.toContain('WebRtcPeerSession')
  })

  it('uses a dedicated WebRTC subpath and preserves protocol descriptor subpath', () => {
    const pkg = JSON.parse(read(packageJsonPath))
    expect(pkg.exports['./webrtc']).toEqual({
      types: './dist/webrtc/index.d.ts',
      import: './dist/webrtc/index.js',
      default: './dist/webrtc/index.js'
    })
    expect(pkg.exports['./webrtc-protocol-contract']).toEqual({
      types: './dist/webrtc-protocol-contract.d.ts',
      import: './dist/webrtc-protocol-contract.js',
      default: './dist/webrtc-protocol-contract.js'
    })
    expect(pkg.dependencies).toEqual({
      '@noble/hashes': '2.2.0',
      mqtt: '5.15.2'
    })
  })

  it('does not expose raw room/data keys, bearer tokens, raw RTC objects, or MQTT package adapter types', () => {
    const subpath = read(webrtcIndexPath)
    expect(subpath).not.toMatch(/RoomKeys|RoomCryptoOptions|deriveRoomKeys|kData|kSig/u)
    expect(subpath).not.toMatch(/rawBearerToken/u)
    expect(subpath).not.toMatch(/RTC(?:PeerConnection|DataChannel|IceServer|Configuration)/u)
    expect(subpath).not.toMatch(/MqttClientLike|MqttClientFactory|MqttConnectOptions|MqttPublishOptions|MqttSubscribeOptions|MqttPublishPacket/u)
  })

  it('imports the source subpath under Node/SSR without touching browser globals', async () => {
    const oldWindow = (globalThis as Record<string, unknown>).window
    const oldWorker = (globalThis as Record<string, unknown>).Worker
    const oldRtc = (globalThis as Record<string, unknown>).RTCPeerConnection
    try {
      delete (globalThis as Record<string, unknown>).window
      delete (globalThis as Record<string, unknown>).Worker
      delete (globalThis as Record<string, unknown>).RTCPeerConnection
      const mod = await import('../src/webrtc/index.js')
      expect(mod.PAIRING_PROTOCOL_VERSION).toBe(2)
      expect(typeof mod.MqttWebSocketSignalingClient).toBe('function')
      expect(typeof mod.WebRtcPeerSession).toBe('function')
    } finally {
      if (oldWindow !== undefined) (globalThis as Record<string, unknown>).window = oldWindow
      if (oldWorker !== undefined) (globalThis as Record<string, unknown>).Worker = oldWorker
      if (oldRtc !== undefined) (globalThis as Record<string, unknown>).RTCPeerConnection = oldRtc
    }
  })

  it('points package exports at build artifacts once the SDK build has run', () => {
    const pkg = JSON.parse(read(packageJsonPath))
    for (const target of [pkg.exports['./webrtc'].import, pkg.exports['./webrtc'].types, './dist/webrtc/crypto-worker.js']) {
      expect(target.startsWith('./dist/')).toBe(true)
      expect(existsSync(resolve(packageRoot, target))).toBe(true)
    }
  })
})
