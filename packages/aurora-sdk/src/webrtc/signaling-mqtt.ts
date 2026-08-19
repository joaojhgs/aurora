import mqtt from 'mqtt'

import { SignalingSessionAllowlist } from './signaling-allowlist.js'

/** MQTT-over-WebSocket signaling for Aurora WebRTC thin clients.
 *
 * This module is intentionally kept behind the dedicated SDK WebRTC subpath.
 * MQTT.js is imported statically inside that subpath so browser bundlers cannot
 * strand a nested lazy chunk before signaling starts. Importing the subpath in
 * SSR/test environments remains safe because no MQTT connection is created
 * until `connect()` runs in a browser/WebView.
 */

export type SignalingChannel = 'presence' | 'offer' | 'answer' | 'candidate' | 'broadcast'

export interface MqttSignalingRoom {
  appId: string
  room: string
  signalingPeerId: string
  stablePeerId?: string
  nodeName?: string
  metadata?: Record<string, unknown>
}

export interface MqttSignalingEnvelope {
  type: string
  app_id?: string
  room?: string
  from?: string
  to?: string | undefined
  peer_id?: string | undefined
  stable_peer_id?: string | undefined
  node_name?: string | undefined
  sdp?: string
  candidate?: string
  [key: string]: unknown
}

export interface MqttSignalingMessage {
  channel: SignalingChannel
  topic: string
  from: string
  stablePeerId?: string | undefined
  envelope: MqttSignalingEnvelope
  raw: Uint8Array
}

/** One peer observed announcing itself in the room. Discovery, not authority. */
export interface MqttSignalingPresence {
  signalingPeerId: string
  stablePeerId?: string | undefined
  nodeName?: string | undefined
  /** True when the announcement is a departure rather than an arrival. */
  departed: boolean
  envelope: MqttSignalingEnvelope
}

export interface MqttSignalingDiagnostics {
  selectedBrokerOrigin?: string | undefined
  attempts: Array<{ broker: string; ok: boolean; error?: string }>
  reconnectCount: number
  lastError?: string | undefined
}

export interface MqttSealOpen {
  seal(envelope: MqttSignalingEnvelope): Uint8Array | Promise<Uint8Array>
  open(payload: Uint8Array): MqttSignalingEnvelope | Promise<MqttSignalingEnvelope>
}

export interface MqttPublishPacket {
  waitForPublish?: () => Promise<void> | void
}

export interface MqttSubscribeOptions {
  qos: 0 | 1
}

export interface MqttPublishOptions extends MqttSubscribeOptions {
  retain: boolean
  properties?: { messageExpiryInterval?: number }
}

export interface MqttClientLike {
  on(event: 'connect', handler: () => void): this
  on(event: 'message', handler: (topic: string, payload: Uint8Array | Buffer | string) => void): this
  on(event: 'close' | 'offline' | 'error', handler: (error?: unknown) => void): this
  subscribe(topic: string, options: MqttSubscribeOptions): void | Promise<void>
  subscribeAsync?(topic: string, options: MqttSubscribeOptions): Promise<unknown>
  unsubscribe(topic: string): void | Promise<void>
  unsubscribeAsync?(topic: string): Promise<unknown>
  publish(topic: string, payload: Uint8Array, options: MqttPublishOptions): MqttPublishPacket | Promise<MqttPublishPacket | void> | void
  publishAsync?(topic: string, payload: Uint8Array, options: MqttPublishOptions): Promise<unknown>
  end(force?: boolean): void | Promise<void>
  endAsync?(force?: boolean): Promise<void>
}

export interface MqttConnectOptions {
  protocolVersion: 5
  reconnectPeriod: 0
  keepalive: number
  username?: string | undefined
  password?: string | undefined
  will?: {
    topic: string
    payload: Uint8Array
    qos: 1
    retain: true
    properties?: { messageExpiryInterval?: number }
  }
}

export type MqttClientFactory = (brokerUrl: string, options: MqttConnectOptions) => MqttClientLike | Promise<MqttClientLike>

export interface MqttSignalingOptions {
  brokers: readonly string[]
  topicRoot?: string
  username?: string | undefined
  password?: string | undefined
  production?: boolean
  allowInsecureLoopback?: boolean
  expectedStablePeerId?: string
  expectedSignalingPeerId?: string
  /**
   * Per-session allowlist deciding which peer may drive this session. Supply the
   * session's own allowlist to keep discovery and session binding separable; if
   * it is omitted one is derived from the expected identities above.
   */
  allowlist?: SignalingSessionAllowlist
  maxPayloadBytes?: number
  connectTimeoutMs?: number
  reconnect?: {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    jitterRatio?: number
  }
  crypto: MqttSealOpen
  mqttFactory?: MqttClientFactory
  randomId?: () => string
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  sleep?: (ms: number) => Promise<void>
}

export interface MqttSignalingClientSnapshot {
  connected: boolean
  closed: boolean
  room?: MqttSignalingRoom | undefined
  signalingPeerId?: string | undefined
  expectedStablePeerId?: string | undefined
  selectedBrokerOrigin?: string | undefined
  reconnectCount: number
  lastRedactedError?: string | undefined
}

const DEFAULT_TOPIC_ROOT = 'aurora'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024
const DEFAULT_KEEPALIVE_SECONDS = 15
const DEPARTURE_EXPIRY_SECONDS = 300
const PRESENCE_QOS = 1 as const
const DIRECT_QOS = 0 as const
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function bytesFromPayload(payload: Uint8Array | Buffer | string): Uint8Array {
  if (typeof payload === 'string') return new TextEncoder().encode(payload)
  return payload instanceof Uint8Array ? new Uint8Array(payload) : new Uint8Array(payload)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function safeString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined
}

export function randomSignalingPeerId(randomBytes?: (length: number) => Uint8Array): string {
  const source = randomBytes ?? ((length: number) => {
    const crypto = globalThis.crypto
    if (!crypto?.getRandomValues) {
      throw new Error('WebCrypto getRandomValues is required to create a signaling id')
    }
    return crypto.getRandomValues(new Uint8Array(length))
  })
  return Array.from(source(16), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function topicBase(root: string, appId: string, room: string, channel: SignalingChannel | `presence/${string}`): string {
  return `${root}/${appId}/${room}/${channel}`
}

export function directTopic(root: string, appId: string, room: string, channel: 'offer' | 'answer' | 'candidate', peerId: string): string {
  return `${topicBase(root, appId, room, channel)}/${peerId}`
}

export function roomSubscriptions(root: string, appId: string, room: string, signalingPeerId: string): Array<{ topic: string; qos: 0 | 1 }> {
  return [
    { topic: topicBase(root, appId, room, 'presence/+'), qos: PRESENCE_QOS },
    { topic: directTopic(root, appId, room, 'offer', signalingPeerId), qos: DIRECT_QOS },
    { topic: directTopic(root, appId, room, 'answer', signalingPeerId), qos: DIRECT_QOS },
    { topic: directTopic(root, appId, room, 'candidate', signalingPeerId), qos: DIRECT_QOS },
    { topic: topicBase(root, appId, room, 'broadcast'), qos: DIRECT_QOS }
  ]
}

export function redactBrokerUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '<invalid-broker-url>'
  }
}

function validateBrokerUrl(url: string, options: Pick<MqttSignalingOptions, 'production' | 'allowInsecureLoopback'>): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error('Browser MQTT signaling requires ws:// or wss:// broker URLs')
  }
  if (options.production !== false && parsed.protocol !== 'wss:') {
    throw new Error('Production MQTT signaling requires wss:// broker URLs')
  }
  if (parsed.protocol === 'ws:' && !options.allowInsecureLoopback) {
    throw new Error('ws:// signaling is only allowed for explicit loopback development')
  }
  if (parsed.protocol === 'ws:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('ws:// signaling is restricted to loopback development brokers')
  }
}

async function defaultMqttFactory(brokerUrl: string, options: MqttConnectOptions): Promise<MqttClientLike> {
  if (typeof window === 'undefined') {
    throw new Error('MQTT signaling runtime is browser/WebView-only; inject mqttFactory for tests or SSR')
  }
  return mqtt.connect(brokerUrl, options as unknown as Record<string, unknown>) as unknown as MqttClientLike
}

function computeBackoff(attempt: number, options: MqttSignalingOptions): number {
  const reconnect = options.reconnect ?? {}
  const base = reconnect.baseDelayMs ?? 250
  const max = reconnect.maxDelayMs ?? 5_000
  const jitter = reconnect.jitterRatio ?? 0.2
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt - 1))
  const noise = raw * jitter * 0.5
  return Math.max(0, Math.round(raw - noise))
}

export class MqttWebSocketSignalingClient {
  readonly signalingPeerId: string
  private readonly options: MqttSignalingOptions
  private readonly root: string
  readonly allowlist: SignalingSessionAllowlist
  private readonly handlers = new Set<(message: MqttSignalingMessage) => void | Promise<void>>()
  private readonly presenceObservers = new Set<(presence: MqttSignalingPresence) => void>()
  private readonly diagnosticsState: MqttSignalingDiagnostics = { attempts: [], reconnectCount: 0 }
  private client: MqttClientLike | null = null
  private room: MqttSignalingRoom | undefined
  private selectedBroker: string | undefined
  private closed = false
  private explicitClose = false
  private connected = false
  private reconnecting = false
  private departurePublished = false

  constructor(options: MqttSignalingOptions) {
    if (options.brokers.length === 0) throw new Error('At least one MQTT signaling broker is required')
    this.options = options
    this.root = options.topicRoot ?? DEFAULT_TOPIC_ROOT
    this.signalingPeerId = options.randomId?.() ?? randomSignalingPeerId()
    this.allowlist = options.allowlist ?? new SignalingSessionAllowlist({
      expectedStablePeerId: options.expectedStablePeerId,
      expectedSignalingPeerId: options.expectedSignalingPeerId
    })
  }

  snapshot(): MqttSignalingClientSnapshot {
    return {
      connected: this.connected,
      closed: this.closed,
      room: this.room,
      signalingPeerId: this.signalingPeerId,
      expectedStablePeerId: this.options.expectedStablePeerId,
      selectedBrokerOrigin: this.selectedBroker ? redactBrokerUrl(this.selectedBroker) : undefined,
      reconnectCount: this.diagnosticsState.reconnectCount,
      lastRedactedError: this.diagnosticsState.lastError
    }
  }

  diagnostics(): MqttSignalingDiagnostics {
    return {
      attempts: [...this.diagnosticsState.attempts],
      reconnectCount: this.diagnosticsState.reconnectCount,
      selectedBrokerOrigin: this.diagnosticsState.selectedBrokerOrigin,
      lastError: this.diagnosticsState.lastError
    }
  }

  onMessage(handler: (message: MqttSignalingMessage) => void | Promise<void>): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /**
   * Observe every peer announcing itself in the room, including peers this
   * session will never talk to. This is the discovery channel the roster is
   * built from; it grants nothing.
   */
  onPresence(observer: (presence: MqttSignalingPresence) => void): () => void {
    this.presenceObservers.add(observer)
    return () => this.presenceObservers.delete(observer)
  }

  async connect(room: Omit<MqttSignalingRoom, 'signalingPeerId'> & { signalingPeerId?: string }): Promise<void> {
    if (this.closed) throw new Error('Cannot connect a closed MQTT signaling client')
    this.room = { ...room, signalingPeerId: room.signalingPeerId ?? this.signalingPeerId }
    const willPayload = await this.options.crypto.seal(this.presenceEnvelope('presence_departed'))
    const factory = this.options.mqttFactory ?? defaultMqttFactory
    let lastError: unknown

    for (const broker of this.options.brokers) {
      try {
        validateBrokerUrl(broker, this.options)
        this.departurePublished = false
        const connectOptions: MqttConnectOptions = {
          protocolVersion: 5,
          reconnectPeriod: 0,
          keepalive: DEFAULT_KEEPALIVE_SECONDS,
          will: {
            topic: this.topic(`presence/${this.room.signalingPeerId}`),
            payload: willPayload,
            qos: PRESENCE_QOS,
            retain: true,
            properties: { messageExpiryInterval: DEPARTURE_EXPIRY_SECONDS }
          }
        }
        if (this.options.username !== undefined) connectOptions.username = this.options.username
        if (this.options.password !== undefined) connectOptions.password = this.options.password
        const client = await factory(broker, connectOptions)
        await this.awaitConnect(client, broker)
        this.installClient(client, broker)
        await this.restoreRoomState()
        this.diagnosticsState.attempts.push({ broker: redactBrokerUrl(broker), ok: true })
        return
      } catch (error) {
        lastError = error
        this.diagnosticsState.attempts.push({ broker: redactBrokerUrl(broker), ok: false, error: this.redactError(error) })
        this.diagnosticsState.lastError = this.redactError(error)
      }
    }
    throw new Error(`MQTT signaling failed to connect to ${this.options.brokers.length} broker(s): ${this.redactError(lastError)}`)
  }

  async send(channel: 'offer' | 'answer' | 'candidate', envelope: MqttSignalingEnvelope, toPeer: string): Promise<void>
  async send(channel: 'broadcast', envelope: MqttSignalingEnvelope): Promise<void>
  async send(channel: 'offer' | 'answer' | 'candidate' | 'broadcast', envelope: MqttSignalingEnvelope, toPeer?: string): Promise<void> {
    if (!this.client || !this.room) throw new Error('MQTT signaling is not connected')
    const outbound: MqttSignalingEnvelope = {
      ...envelope,
      type: envelope.type ?? channel,
      app_id: this.room.appId,
      room: this.room.room,
      from: this.room.signalingPeerId
    }
    const target = toPeer ?? envelope.to
    if (target !== undefined) outbound.to = target
    const stablePeerId = this.room.stablePeerId ?? envelope.stable_peer_id
    if (stablePeerId !== undefined) outbound.stable_peer_id = stablePeerId
    const nodeName = this.room.nodeName ?? envelope.node_name
    if (nodeName !== undefined) outbound.node_name = nodeName
    const payload = await this.options.crypto.seal(outbound)
    await this.publish(channel === 'broadcast' ? this.topic('broadcast') : this.direct(channel, toPeer ?? ''), payload, {
      qos: DIRECT_QOS,
      retain: false
    })
  }

  async announcePresence(): Promise<void> {
    if (!this.client || !this.room || !this.connected) {
      throw new Error('MQTT signaling is not connected')
    }
    const payload = await this.options.crypto.seal(this.presenceEnvelope('presence'))
    await this.publish(this.topic(`presence/${this.room.signalingPeerId}`), payload, {
      qos: PRESENCE_QOS,
      retain: true
    })
  }

  async leave(): Promise<void> {
    if (!this.client || !this.room || !this.connected) return
    const payload = await this.options.crypto.seal(this.presenceEnvelope('presence_departed'))
    await this.publish(this.topic(`presence/${this.room.signalingPeerId}`), payload, {
      qos: PRESENCE_QOS,
      retain: true,
      properties: { messageExpiryInterval: DEPARTURE_EXPIRY_SECONDS }
    })
    this.departurePublished = true
    for (const { topic } of roomSubscriptions(this.root, this.room.appId, this.room.room, this.room.signalingPeerId)) {
      await this.unsubscribe(topic)
    }
    this.connected = false
  }

  async close(reason = 'explicit_close'): Promise<void> {
    void reason
    this.explicitClose = true
    const client = this.client
    let departedGracefully = this.departurePublished
    try {
      if (client && this.room && this.connected) {
        await this.leave()
        departedGracefully = true
      }
    } catch (error) {
      this.diagnosticsState.lastError = this.redactError(error)
    } finally {
      this.closed = true
      this.connected = false
      this.client = null
      try {
        if (client) {
          if (typeof client.endAsync === 'function') {
            await client.endAsync(!departedGracefully)
          } else {
            await client.end(!departedGracefully)
          }
        }
      } finally {
        this.handlers.clear()
      }
    }
  }

  private installClient(client: MqttClientLike, broker: string): void {
    this.client = client
    this.selectedBroker = broker
    this.connected = true
    this.diagnosticsState.selectedBrokerOrigin = redactBrokerUrl(broker)
    client.on('message', (topic, payload) => {
      void this.handleRawMessage(topic, bytesFromPayload(payload))
    })
    client.on('close', () => {
      this.connected = false
      if (!this.explicitClose) void this.reconnectAfterTransientClose()
    })
    client.on('offline', () => {
      this.connected = false
      if (!this.explicitClose) void this.reconnectAfterTransientClose()
    })
    client.on('error', (error?: unknown) => {
      this.diagnosticsState.lastError = this.redactError(error)
    })
  }

  private async awaitConnect(client: MqttClientLike, broker: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let done = false
      const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
      const fail = (error: unknown, fallback: string) => {
        if (done) return
        done = true
        ;(this.options.clearTimeout ?? globalThis.clearTimeout)(timer)
        reject(error instanceof Error ? error : new Error(String(error ?? fallback)))
      }
      const timer = (this.options.setTimeout ?? globalThis.setTimeout)(() => {
        if (done) return
        done = true
        reject(new Error(`Timed out connecting to ${redactBrokerUrl(broker)}`))
      }, timeoutMs)
      client.on('connect', () => {
        if (done) return
        done = true
        ;(this.options.clearTimeout ?? globalThis.clearTimeout)(timer)
        resolve()
      })
      client.on('error', (error?: unknown) => {
        fail(error, 'MQTT connect failed')
      })
      client.on('close', () => fail(undefined, 'MQTT connection closed before it was ready'))
      client.on('offline', () => fail(undefined, 'MQTT connection went offline before it was ready'))
    })
  }

  private async restoreRoomState(): Promise<void> {
    if (!this.client || !this.room) return
    for (const sub of roomSubscriptions(this.root, this.room.appId, this.room.room, this.room.signalingPeerId)) {
      await this.subscribe(sub.topic, { qos: sub.qos })
    }
    await this.announcePresence()
  }

  private async reconnectAfterTransientClose(): Promise<void> {
    if (this.reconnecting || this.explicitClose || this.closed || !this.room) return
    this.reconnecting = true
    try {
      const configuredMaxAttempts = this.options.reconnect?.maxAttempts
      const maxAttempts = configuredMaxAttempts === undefined || configuredMaxAttempts === 0
        ? Number.POSITIVE_INFINITY
        : Math.max(1, Math.floor(configuredMaxAttempts))
      const room = this.room
      for (let attempt = 1; attempt <= maxAttempts && !this.explicitClose && !this.closed; attempt += 1) {
        this.diagnosticsState.reconnectCount += 1
        await (this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(computeBackoff(attempt, this.options))
        try {
          await this.connect(room)
          return
        } catch (error) {
          this.diagnosticsState.lastError = this.redactError(error)
        }
      }
    } finally {
      this.reconnecting = false
    }
  }

  private async handleRawMessage(topic: string, payload: Uint8Array): Promise<void> {
    if (!this.room || payload.byteLength > (this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES)) return
    const channel = this.channelFromTopic(topic)
    if (!channel) return
    let envelope: MqttSignalingEnvelope
    try {
      const opened = await this.options.crypto.open(payload)
      if (!isRecord(opened)) return
      envelope = opened as MqttSignalingEnvelope
    } catch (error) {
      this.diagnosticsState.lastError = 'malformed_or_undecryptable_signaling_payload'
      return
    }
    if (!this.envelopeMatches(channel, envelope)) return
    const from = safeString(envelope.from ?? envelope.peer_id)
    if (!from || from === this.room.signalingPeerId) return
    const stablePeerId = safeString(envelope.stable_peer_id)
    // Discovery first: every peer that announces itself in the room is
    // observable, so a three-node room reports three devices. Being observed
    // is not permission to drive a session — the allowlist below decides that.
    if (channel === 'presence') this.observePresence(from, stablePeerId, envelope)
    if (!this.allowlist.admits({ channel, from, stablePeerId })) return
    const message: MqttSignalingMessage = { channel, topic, from, envelope, raw: payload }
    if (stablePeerId !== undefined) message.stablePeerId = stablePeerId
    for (const handler of [...this.handlers]) await handler(message)
  }

  private observePresence(from: string, stablePeerId: string | undefined, envelope: MqttSignalingEnvelope): void {
    if (this.presenceObservers.size === 0) return
    const presence: MqttSignalingPresence = {
      signalingPeerId: from,
      departed: envelope.type === 'presence_departed',
      envelope
    }
    if (stablePeerId !== undefined) presence.stablePeerId = stablePeerId
    const nodeName = safeString(envelope.node_name, 128)
    if (nodeName !== undefined) presence.nodeName = nodeName
    for (const observer of [...this.presenceObservers]) observer(presence)
  }

  private envelopeMatches(channel: SignalingChannel, envelope: MqttSignalingEnvelope): boolean {
    if (!this.room) return false
    if (safeString(envelope.app_id) && envelope.app_id !== this.room.appId) return false
    if (safeString(envelope.room) && envelope.room !== this.room.room) return false
    if (channel !== 'presence' && safeString(envelope.to) && envelope.to !== this.room.signalingPeerId) return false
    const type = safeString(envelope.type, 64)
    if (!type) return false
    if (channel === 'presence') return type === 'presence' || type === 'presence_departed'
    if (channel === 'broadcast') return true
    return type === channel
  }

  private channelFromTopic(topic: string): SignalingChannel | null {
    if (!this.room) return null
    const prefix = `${this.root}/${this.room.appId}/${this.room.room}/`
    if (!topic.startsWith(prefix)) return null
    const rest = topic.slice(prefix.length)
    const [channel] = rest.split('/')
    if (channel === 'presence' || channel === 'offer' || channel === 'answer' || channel === 'candidate' || channel === 'broadcast') {
      return channel
    }
    return null
  }

  private presenceEnvelope(type: 'presence' | 'presence_departed'): MqttSignalingEnvelope {
    if (!this.room) throw new Error('Cannot build presence before joining a room')
    const envelope: MqttSignalingEnvelope = {
      type,
      app_id: this.room.appId,
      room: this.room.room,
      peer_id: this.room.signalingPeerId,
      from: this.room.signalingPeerId,
      ...this.room.metadata
    }
    if (this.room.stablePeerId !== undefined) envelope.stable_peer_id = this.room.stablePeerId
    if (this.room.nodeName !== undefined) envelope.node_name = this.room.nodeName
    return envelope
  }

  private topic(channel: SignalingChannel | `presence/${string}`): string {
    if (!this.room) throw new Error('MQTT signaling room has not been joined')
    return topicBase(this.root, this.room.appId, this.room.room, channel)
  }

  private direct(channel: 'offer' | 'answer' | 'candidate', peerId: string): string {
    if (!this.room) throw new Error('MQTT signaling room has not been joined')
    return directTopic(this.root, this.room.appId, this.room.room, channel, peerId)
  }

  private async publish(topic: string, payload: Uint8Array, options: MqttPublishOptions): Promise<void> {
    if (!this.client) throw new Error('MQTT signaling is not connected')
    if (typeof this.client.publishAsync === 'function') {
      await this.client.publishAsync(topic, payload, options)
      return
    }
    const result = await this.client.publish(topic, payload, options)
    const wait = result?.waitForPublish
    if (typeof wait === 'function') await wait.call(result)
  }

  private async subscribe(topic: string, options: MqttSubscribeOptions): Promise<void> {
    if (!this.client) throw new Error('MQTT signaling is not connected')
    if (typeof this.client.subscribeAsync === 'function') {
      await this.client.subscribeAsync(topic, options)
      return
    }
    await this.client.subscribe(topic, options)
  }

  private async unsubscribe(topic: string): Promise<void> {
    if (!this.client) return
    if (typeof this.client.unsubscribeAsync === 'function') {
      await this.client.unsubscribeAsync(topic)
      return
    }
    await this.client.unsubscribe(topic)
  }

  private redactError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error')
    return this.options.brokers.reduce(
      (redacted, broker) => redacted.split(broker).join(redactBrokerUrl(broker)),
      message,
    )
  }
}
