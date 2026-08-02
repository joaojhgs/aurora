import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  MqttWebSocketSignalingClient,
  directTopic,
  randomSignalingPeerId,
  redactBrokerUrl,
  roomSubscriptions,
  topicBase,
  type MqttClientLike,
  type MqttConnectOptions,
  type MqttPublishOptions,
  type MqttSignalingEnvelope
} from '../src/webrtc/signaling-mqtt.js'

class FakeMqttClient implements MqttClientLike {
  handlers = new Map<string, Array<(...args: any[]) => void>>()
  subscriptions: Array<{ topic: string; qos: 0 | 1 }> = []
  unsubscriptions: string[] = []
  publishes: Array<{ topic: string; payload: Uint8Array; options: MqttPublishOptions }> = []
  ended = false
  endForce: boolean | undefined

  on(event: any, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, ...args: any[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args)
  }

  subscribe(topic: string, options: { qos: 0 | 1 }) {
    this.subscriptions.push({ topic, qos: options.qos })
  }

  async subscribeAsync(topic: string, options: { qos: 0 | 1 }) {
    this.subscribe(topic, options)
  }

  unsubscribe(topic: string) {
    this.unsubscriptions.push(topic)
  }

  async unsubscribeAsync(topic: string) {
    this.unsubscribe(topic)
  }

  publish(topic: string, payload: Uint8Array, options: MqttPublishOptions) {
    this.publishes.push({ topic, payload, options })
    return { waitForPublish: vi.fn() }
  }

  async publishAsync(topic: string, payload: Uint8Array, options: MqttPublishOptions) {
    this.publish(topic, payload, options)
  }

  end(force?: boolean) {
    this.ended = true
    this.endForce = force
  }

  async endAsync(force?: boolean) {
    this.end(force)
  }
}

function jsonCrypto() {
  return {
    async seal(envelope: MqttSignalingEnvelope) {
      return new TextEncoder().encode(JSON.stringify(envelope))
    },
    async open(payload: Uint8Array) {
      return JSON.parse(new TextDecoder().decode(payload)) as MqttSignalingEnvelope
    }
  }
}

function delayedFactory(client: FakeMqttClient) {
  const calls: Array<{ url: string; options: MqttConnectOptions }> = []
  const factory = vi.fn((url: string, options: MqttConnectOptions) => {
    calls.push({ url, options })
    setTimeout(() => client.emit('connect'), 0)
    return client
  })
  return { calls, factory }
}

const room = {
  appId: 'aurora-fixture',
  room: 'lab-room',
  signalingPeerId: 'peer-offer',
  stablePeerId: 'stable-offer',
  nodeName: 'Fixture Offerer'
}

describe('MQTT WebSocket signaling contract', () => {
  it('builds Python-compatible topics and subscriptions', () => {
    expect(topicBase('aurora', 'aurora-fixture', 'lab-room', 'presence/peer-offer')).toBe(
      'aurora/aurora-fixture/lab-room/presence/peer-offer'
    )
    expect(directTopic('aurora', 'aurora-fixture', 'lab-room', 'offer', 'peer-offer')).toBe(
      'aurora/aurora-fixture/lab-room/offer/peer-offer'
    )
    expect(roomSubscriptions('aurora', 'aurora-fixture', 'lab-room', 'peer-offer')).toEqual([
      { topic: 'aurora/aurora-fixture/lab-room/presence/+', qos: 1 },
      { topic: 'aurora/aurora-fixture/lab-room/offer/peer-offer', qos: 0 },
      { topic: 'aurora/aurora-fixture/lab-room/answer/peer-offer', qos: 0 },
      { topic: 'aurora/aurora-fixture/lab-room/candidate/peer-offer', qos: 0 },
      { topic: 'aurora/aurora-fixture/lab-room/broadcast', qos: 0 }
    ])
  })


  it('matches committed Python signaling fixture topics and subscription QoS', () => {
    const fixture = JSON.parse(readFileSync(resolve(process.cwd(), '../../tests/fixtures/webrtc_web_thin_protocol_vectors.json'), 'utf8'))
    expect(topicBase('aurora', 'aurora-fixture', 'lab-room', 'presence/peer-offer')).toBe(fixture.signaling.topics.presence_peer)
    expect(directTopic('aurora', 'aurora-fixture', 'lab-room', 'offer', 'peer-offer')).toBe(fixture.signaling.topics.offer_to_peer)
    expect(directTopic('aurora', 'aurora-fixture', 'lab-room', 'answer', 'peer-offer')).toBe(fixture.signaling.topics.answer_to_peer)
    expect(directTopic('aurora', 'aurora-fixture', 'lab-room', 'candidate', 'peer-offer')).toBe(fixture.signaling.topics.candidate_to_peer)
    expect(roomSubscriptions('aurora', 'aurora-fixture', 'lab-room', 'peer-offer')).toEqual(fixture.signaling.subscriptions)
  })

  it('connects with retained QoS1 will/presence and QoS0 direct sends', async () => {
    const client = new FakeMqttClient()
    const { calls, factory } = delayedFactory(client)
    const signaling = new MqttWebSocketSignalingClient({
      brokers: ['wss://user:secret@mqtt.example.test/mqtt?token=nope'],
      crypto: jsonCrypto(),
      mqttFactory: factory,
      randomId: () => 'peer-offer'
    })

    await signaling.connect(room)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options.keepalive).toBe(15)
    expect(calls[0]?.options.will).toEqual(
      expect.objectContaining({
        topic: 'aurora/aurora-fixture/lab-room/presence/peer-offer',
        qos: 1,
        retain: true,
        properties: { messageExpiryInterval: 300 }
      })
    )
    expect(client.subscriptions).toEqual(roomSubscriptions('aurora', 'aurora-fixture', 'lab-room', 'peer-offer'))
    expect(client.publishes[0]).toEqual(
      expect.objectContaining({
        topic: 'aurora/aurora-fixture/lab-room/presence/peer-offer',
        options: expect.objectContaining({ qos: 1, retain: true })
      })
    )

    await signaling.announcePresence()
    expect(client.publishes[1]).toEqual(
      expect.objectContaining({
        topic: 'aurora/aurora-fixture/lab-room/presence/peer-offer',
        options: expect.objectContaining({ qos: 1, retain: true })
      })
    )

    await signaling.send('offer', { type: 'offer', sdp: 'v=0\r\nunchanged' }, 'peer-answer')
    expect(client.publishes.at(-1)).toEqual(
      expect.objectContaining({
        topic: 'aurora/aurora-fixture/lab-room/offer/peer-answer',
        options: { qos: 0, retain: false }
      })
    )
    const sent = JSON.parse(new TextDecoder().decode(client.publishes.at(-1)?.payload))
    expect(sent.sdp).toBe('v=0\r\nunchanged')
  })

  it('filters expected stable peers, malformed payloads, own messages, and unrelated rooms', async () => {
    const client = new FakeMqttClient()
    const { factory } = delayedFactory(client)
    const seen: unknown[] = []
    const signaling = new MqttWebSocketSignalingClient({
      brokers: ['wss://mqtt.example.test/mqtt'],
      crypto: jsonCrypto(),
      mqttFactory: factory,
      randomId: () => 'peer-offer',
      expectedStablePeerId: 'stable-answer'
    })
    signaling.onMessage((message) => {
      seen.push(message.envelope)
    })
    await signaling.connect(room)

    const emit = (envelope: Record<string, unknown>, topic = 'aurora/aurora-fixture/lab-room/offer/peer-offer') => {
      client.emit('message', topic, new TextEncoder().encode(JSON.stringify(envelope)))
    }
    emit({ type: 'offer', app_id: 'aurora-fixture', room: 'other', from: 'peer-answer', to: 'peer-offer', stable_peer_id: 'stable-answer' })
    emit({ type: 'offer', app_id: 'aurora-fixture', room: 'lab-room', from: 'peer-answer', to: 'peer-offer', stable_peer_id: 'wrong' })
    emit({ type: 'offer', app_id: 'aurora-fixture', room: 'lab-room', from: 'peer-offer', to: 'peer-offer', stable_peer_id: 'stable-answer' })
    client.emit('message', 'aurora/aurora-fixture/lab-room/offer/peer-offer', new TextEncoder().encode('{not-json'))
    emit({ type: 'offer', app_id: 'aurora-fixture', room: 'lab-room', from: 'peer-answer', to: 'peer-offer', stable_peer_id: 'stable-answer', sdp: 'exact-sdp' })

    await Promise.resolve()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(expect.objectContaining({ sdp: 'exact-sdp' }))
    expect(signaling.diagnostics().lastError).toBe('malformed_or_undecryptable_signaling_payload')
  })

  it('publishes an acknowledged departure before closing the signaling session', async () => {
    const client = new FakeMqttClient()
    const signaling = new MqttWebSocketSignalingClient({
      brokers: ['wss://mqtt.example.test/mqtt'],
      crypto: jsonCrypto(),
      mqttFactory: delayedFactory(client).factory,
      randomId: () => 'peer-offer'
    })

    await signaling.connect(room)
    await signaling.close()

    const departure = JSON.parse(
      new TextDecoder().decode(client.publishes.at(-1)?.payload)
    )
    expect(departure).toEqual(expect.objectContaining({
      type: 'presence_departed',
      peer_id: 'peer-offer',
      stable_peer_id: 'stable-offer'
    }))
    expect(client.publishes.at(-1)?.options).toEqual({
      qos: 1,
      retain: true,
      properties: { messageExpiryInterval: 300 }
    })
    expect(client.unsubscriptions).toEqual(
      roomSubscriptions('aurora', 'aurora-fixture', 'lab-room', 'peer-offer')
        .map(({ topic }) => topic)
    )
    expect(client.ended).toBe(true)
    expect(client.endForce).toBe(false)
    expect(signaling.snapshot()).toEqual(expect.objectContaining({
      connected: false,
      closed: true
    }))
  })

  it('fails over brokers, redacts diagnostics, restores room state on reconnect, and suppresses explicit close reconnect', async () => {
    const first = new FakeMqttClient()
    const second = new FakeMqttClient()
    const factory = vi.fn((url: string) => {
      const client = url.includes('one') ? first : second
      setTimeout(() => (url.includes('one') ? client.emit('error', new Error(`boom ${url}`)) : client.emit('connect')), 0)
      return client
    })
    const signaling = new MqttWebSocketSignalingClient({
      brokers: ['wss://user:pass@one.example.test/mqtt?secret=1', 'wss://two.example.test/mqtt'],
      crypto: jsonCrypto(),
      mqttFactory: factory,
      randomId: () => 'peer-offer',
      sleep: async () => undefined,
      reconnect: { maxAttempts: 1 }
    })

    await signaling.connect(room)
    expect(signaling.snapshot().selectedBrokerOrigin).toBe('wss://two.example.test')
    expect(signaling.diagnostics().attempts[0]?.broker).toBe('wss://one.example.test')
    expect(signaling.diagnostics().attempts[0]?.error).not.toContain('pass')
    expect(second.subscriptions).toHaveLength(5)

    second.emit('close')
    await Promise.resolve()
    await Promise.resolve()
    expect(signaling.diagnostics().reconnectCount).toBeGreaterThanOrEqual(1)

    await signaling.close()
    const callsBefore = factory.mock.calls.length
    second.emit('close')
    await Promise.resolve()
    expect(factory.mock.calls.length).toBe(callsBefore)
  })

  it('keeps reconnecting after close-only failures and restores retained presence', async () => {
    const clients: FakeMqttClient[] = []
    const factory = vi.fn(() => {
      const client = new FakeMqttClient()
      clients.push(client)
      const attempt = clients.length
      setTimeout(() => {
        if (attempt === 1 || attempt === 4) client.emit('connect')
        else client.emit('close')
      }, 0)
      return client
    })
    const signaling = new MqttWebSocketSignalingClient({
      brokers: ['wss://mqtt.example.test/mqtt'],
      crypto: jsonCrypto(),
      mqttFactory: factory,
      randomId: () => 'peer-offer',
      sleep: async () => undefined,
      connectTimeoutMs: 1_000,
      reconnect: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
    })

    await signaling.connect(room)
    clients[0]?.emit('offline')

    await vi.waitFor(() => expect(clients).toHaveLength(4))
    await vi.waitFor(() => expect(signaling.snapshot().connected).toBe(true))
    expect(signaling.diagnostics().reconnectCount).toBe(3)
    expect(clients[3]?.subscriptions).toEqual(roomSubscriptions('aurora', 'aurora-fixture', 'lab-room', 'peer-offer'))
    expect(clients[3]?.publishes[0]).toEqual(expect.objectContaining({
      topic: 'aurora/aurora-fixture/lab-room/presence/peer-offer',
      options: expect.objectContaining({ qos: 1, retain: true })
    }))

    await signaling.close()
  })

  it('enforces production WSS and only allows ws loopback when explicitly configured', async () => {
    const factory = vi.fn()
    await expect(
      new MqttWebSocketSignalingClient({ brokers: ['ws://mqtt.example.test/mqtt'], crypto: jsonCrypto(), mqttFactory: factory }).connect(room)
    ).rejects.toThrow(/wss|loopback/i)
    await expect(
      new MqttWebSocketSignalingClient({ brokers: ['ws://127.0.0.1:1884/mqtt'], allowInsecureLoopback: true, production: false, crypto: jsonCrypto(), mqttFactory: delayedFactory(new FakeMqttClient()).factory }).connect(room)
    ).resolves.toBeUndefined()
  })

  it('is SSR import safe and creates random signaling IDs distinct from stable identity', () => {
    expect(redactBrokerUrl('wss://user:pass@example.test/mqtt?secret=1')).toBe('wss://example.test')
    expect(randomSignalingPeerId(() => new Uint8Array(16).fill(0xab))).toBe('abababababababababababababababab')
    const client = new MqttWebSocketSignalingClient({
      brokers: ['wss://mqtt.example.test/mqtt'],
      crypto: jsonCrypto(),
      mqttFactory: delayedFactory(new FakeMqttClient()).factory,
      randomId: () => 'random-session-id'
    })
    expect(client.signalingPeerId).toBe('random-session-id')
    expect(client.signalingPeerId).not.toBe('stable-offer')
  })
})
