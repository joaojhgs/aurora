export type RejectedSubscriptionTopic = {
  topic: string
  reason: string
}

export type SubscribeResult = {
  id: string
  subscriptionId: string
  accepted: boolean
  acceptedTopics: string[]
  rejectedTopics: RejectedSubscriptionTopic[]
  correlationIds: string[]
  ttlSeconds: number
  reason: string | null
  idempotent: boolean
}

interface SubscriptionRecord {
  id: string
  peerId: string
  topics: string[]
  correlationIds: string[]
  acceptedTopics: string[]
  rejectedTopics: RejectedSubscriptionTopic[]
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface MeshEventSubscriptionSnapshot {
  id: string
  peerId: string
  topics: string[]
  correlationIds: string[]
  acceptedTopics: string[]
  rejectedTopics: RejectedSubscriptionTopic[]
  expiresAt: number
}

export interface MeshEventSubscriptionRegistryOptions {
  maxTopicsPerPeer?: number
  maxSubscriptionsPerPeer?: number
  maxTtlSeconds?: number
  clock?: () => number
}

const DEFAULT_MAX_TOPICS_PER_PEER = 64
const DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER = 32
const DEFAULT_MAX_TTL_SECONDS = 300
const MAX_TOPIC_LENGTH = 256
const MAX_CORRELATION_IDS = 32
const MAX_CORRELATION_ID_LENGTH = 128
const VALID_TOPIC_RE = /^[A-Za-z0-9_.:/-]+$/

export class MeshEventSubscriptionRegistry {
  private readonly maxTopicsPerPeer: number
  private readonly maxSubscriptionsPerPeer: number
  private readonly maxTtlSeconds: number
  private readonly clock: () => number
  private readonly subscriptions = new Map<string, SubscriptionRecord>()

  constructor(options: MeshEventSubscriptionRegistryOptions = {}) {
    this.maxTopicsPerPeer = options.maxTopicsPerPeer ?? DEFAULT_MAX_TOPICS_PER_PEER
    this.maxSubscriptionsPerPeer = options.maxSubscriptionsPerPeer ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_PEER
    this.maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS
    this.clock = options.clock ?? (() => Date.now() / 1000)
  }

  subscribe(input: {
    peerId: string
    id: string
    topics: string[]
    correlationIds?: string[]
    ttlSeconds?: number
    exactTopics?: boolean
  }): SubscribeResult {
    const peerId = requireIdentifier(input.peerId, 'peer_id')
    const id = requireIdentifier(input.id, 'id')
    const topics = normalizeTopics(input.topics, this.maxTopicsPerPeer, input.exactTopics ?? true)
    const correlationIds = normalizeIdentifiers(input.correlationIds ?? [], MAX_CORRELATION_IDS, 'correlation_id')
    const ttlSeconds = normalizeTtl(input.ttlSeconds ?? this.maxTtlSeconds, this.maxTtlSeconds)
    const now = this.clock()
    this.cleanup({ now })

    const existing = this.subscriptions.get(id)
    if (existing && existing.peerId === peerId) {
      existing.topics = topics
      existing.correlationIds = correlationIds
      existing.acceptedTopics = [...topics]
      existing.rejectedTopics = []
      existing.updatedAt = now
      existing.expiresAt = now + ttlSeconds
      return {
        id,
        subscriptionId: id,
        accepted: true,
        acceptedTopics: [...topics],
        rejectedTopics: [],
        correlationIds,
        ttlSeconds,
        reason: null,
        idempotent: true
      }
    }

    const peerCount = [...this.subscriptions.values()].filter((subscription) => subscription.peerId === peerId).length
    if (peerCount >= this.maxSubscriptionsPerPeer) {
      return {
        id,
        subscriptionId: id,
        accepted: false,
        acceptedTopics: [],
        rejectedTopics: topics.map((topic) => ({ topic, reason: 'subscription quota exceeded' })),
        correlationIds,
        ttlSeconds,
        reason: 'subscription quota exceeded',
        idempotent: false
      }
    }

    const acceptedTopics = [...topics]
    const record: SubscriptionRecord = {
      id,
      peerId,
      topics,
      correlationIds,
      acceptedTopics,
      rejectedTopics: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlSeconds
    }
    this.subscriptions.set(id, record)
    return {
      id,
      subscriptionId: id,
      accepted: true,
      acceptedTopics,
      rejectedTopics: [],
      correlationIds,
      ttlSeconds,
      reason: null,
      idempotent: false
    }
  }

  unsubscribe(peerId: string, subscriptionId: string): boolean {
    const peer = requireIdentifier(peerId, 'peer_id')
    const id = requireIdentifier(subscriptionId, 'subscription_id')
    const existing = this.subscriptions.get(id)
    if (!existing || existing.peerId !== peer) return false
    return this.subscriptions.delete(id)
  }

  isInterested(input: {
    peerId: string
    topic: string
    correlationId?: string | null
    now?: number
  }): boolean {
    const peerId = requireIdentifier(input.peerId, 'peer_id')
    const topic = requireTopic(input.topic)
    const now = input.now ?? this.clock()
    this.cleanup({ now })
    for (const subscription of this.subscriptions.values()) {
      if (subscription.peerId !== peerId) continue
      if (subscription.expiresAt <= now) continue
      if (!subscription.acceptedTopics.includes(topic)) continue
      if (input.correlationId && subscription.correlationIds.length > 0 && !subscription.correlationIds.includes(input.correlationId)) {
        continue
      }
      return true
    }
    return false
  }

  cleanup(input: { now?: number } = {}): number {
    const now = input.now ?? this.clock()
    let removed = 0
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.expiresAt <= now) {
        this.subscriptions.delete(id)
        removed += 1
      }
    }
    return removed
  }

  snapshot(peerId?: string | null): MeshEventSubscriptionSnapshot[] {
    const now = this.clock()
    this.cleanup({ now })
    return [...this.subscriptions.values()]
      .filter((subscription) => !peerId || subscription.peerId === peerId)
      .map((subscription) => ({
        id: subscription.id,
        peerId: subscription.peerId,
        topics: [...subscription.topics],
        correlationIds: [...subscription.correlationIds],
        acceptedTopics: [...subscription.acceptedTopics],
        rejectedTopics: subscription.rejectedTopics.map((item) => ({ ...item })),
        expiresAt: subscription.expiresAt
      }))
  }
}

function normalizeTopics(topics: string[], maxTopics: number, exactTopics: boolean): string[] {
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new Error('topics must be a non-empty array')
  }
  if (topics.length > maxTopics) {
    throw new Error('topics exceed peer subscription cap')
  }
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const topic of topics) {
    const parsed = requireTopic(topic)
    if (exactTopics && (parsed.includes('*') || parsed.includes('+'))) {
      throw new Error('wildcard topics are not supported in v1')
    }
    if (!seen.has(parsed)) {
      normalized.push(parsed)
      seen.add(parsed)
    }
  }
  return normalized
}

function normalizeIdentifiers(values: string[], maxCount: number, fieldName: string): string[] {
  if (values.length > maxCount) {
    throw new Error(`${fieldName}s exceed peer subscription cap`)
  }
  const parsed: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = requireIdentifier(value, fieldName)
    if (!seen.has(normalized)) {
      parsed.push(normalized)
      seen.add(normalized)
    }
  }
  return parsed
}

function normalizeTtl(ttlSeconds: number, maxTtlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > maxTtlSeconds) {
    throw new Error('ttl_seconds must be a positive bounded number')
  }
  return ttlSeconds
}

function requireIdentifier(value: string, fieldName: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_CORRELATION_ID_LENGTH) {
    throw new Error(`${fieldName} must be a non-empty bounded string`)
  }
  return value
}

function requireTopic(value: string): string {
  if (typeof value !== 'string' || !value || value.length > MAX_TOPIC_LENGTH || !VALID_TOPIC_RE.test(value)) {
    throw new Error('topic must be a bounded exact topic')
  }
  return value
}
