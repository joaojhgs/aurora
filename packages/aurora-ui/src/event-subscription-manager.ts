import type { AuroraEvent, AuroraEventSubscription, AuroraSubscribeOptions } from '@aurora/client'

export type ManagedEventSubscriptionStatus = 'connecting' | 'connected' | 'error' | 'reconnecting'

export interface ManagedEventSubscriptionCallbacks<TPayload = unknown> {
  onEvent: (event: AuroraEvent<TPayload>) => void
  onError?: (error: unknown) => void
  onStatus?: (status: ManagedEventSubscriptionStatus, metadata?: { error?: unknown; lastEventId?: string | null }) => void
}

export interface ManagedEventSubscriptionRequest<TPayload = unknown> extends ManagedEventSubscriptionCallbacks<TPayload> {
  scopeId: string
  stream: string
  topics: readonly string[]
  kinds?: readonly string[] | undefined
  lastEventId?: string | null | undefined
  replayFrom?: string | null | undefined
  backfill?: boolean | undefined
  reconnect?: AuroraSubscribeOptions['reconnect'] | undefined
  open: (options: AuroraSubscribeOptions & { signal: AbortSignal }) => AuroraEventSubscription<TPayload>
  isTerminalError?: (error: unknown) => boolean
}

export interface ManagedEventSubscriptionLease {
  readonly key: string
  release: () => void
}

export interface EventSubscriptionManagerOptions {
  maxTopics?: number | undefined
  leaseTtlMs?: number | undefined
  reconnectDelayMs?: number | undefined
}

interface ManagedEventSubscriptionListener<TPayload = unknown> extends ManagedEventSubscriptionCallbacks<TPayload> {
  released: boolean
}

interface ManagedEventSubscriptionEntry<TPayload = unknown> {
  key: string
  scopeId: string
  stream: string
  topics: readonly string[]
  kinds?: readonly string[] | undefined
  lastEventId: string | null
  replayFrom: string | null
  backfill: boolean
  reconnect: AuroraSubscribeOptions['reconnect']
  open: (options: AuroraSubscribeOptions & { signal: AbortSignal }) => AuroraEventSubscription<TPayload>
  isTerminalError: (error: unknown) => boolean
  listeners: Set<ManagedEventSubscriptionListener<TPayload>>
  status: ManagedEventSubscriptionStatus
  statusMetadata: { error?: unknown; lastEventId?: string | null }
  generation: number
  controller: AbortController | null
  subscription: AuroraEventSubscription<TPayload> | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  ttlTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_MAX_TOPICS = 64
const DEFAULT_LEASE_TTL_MS = 60_000
const DEFAULT_RECONNECT_DELAY_MS = 1_000

export class EventSubscriptionManager {
  private readonly entries = new Map<string, ManagedEventSubscriptionEntry>()
  private readonly maxTopics: number
  private readonly leaseTtlMs: number
  private readonly reconnectDelayMs: number

  constructor(options: EventSubscriptionManagerOptions = {}) {
    this.maxTopics = options.maxTopics ?? DEFAULT_MAX_TOPICS
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
  }

  acquire<TPayload = unknown>(request: ManagedEventSubscriptionRequest<TPayload>): ManagedEventSubscriptionLease {
    const topics = normalizeManagedTopics(request.topics)
    const key = managedSubscriptionKey(request.scopeId, request.stream, topics, request.kinds)
    this.assertTopicQuota(key, topics)
    let entry = this.entries.get(key) as ManagedEventSubscriptionEntry<TPayload> | undefined
    const isNewEntry = !entry
    if (!entry) {
      entry = {
        key,
        scopeId: request.scopeId,
        stream: request.stream,
        topics,
        kinds: request.kinds,
        lastEventId: request.lastEventId ?? null,
        replayFrom: request.replayFrom ?? request.lastEventId ?? null,
        backfill: request.backfill ?? true,
        reconnect: request.reconnect ?? false,
        open: request.open,
        isTerminalError: request.isTerminalError ?? (() => false),
        listeners: new Set(),
        status: 'connecting',
        statusMetadata: { lastEventId: request.lastEventId ?? null },
        generation: 0,
        controller: null,
        subscription: null,
        reconnectTimer: null,
        ttlTimer: null,
      }
      this.entries.set(key, entry as ManagedEventSubscriptionEntry)
    }

    const listener: ManagedEventSubscriptionListener<TPayload> = { ...request, released: false }
    entry.listeners.add(listener)
    if (isNewEntry) {
      this.start(entry)
    } else {
      listener.onStatus?.(entry.status, { lastEventId: entry.lastEventId, ...entry.statusMetadata })
    }

    return {
      key,
      release: () => {
        if (listener.released) return
        listener.released = true
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0) this.closeEntry(entry, 'last listener released')
      }
    }
  }

  closeAll(reason = 'event subscription manager closed'): void {
    for (const entry of [...this.entries.values()]) this.closeEntry(entry, reason)
  }

  activeTopicCount(): number {
    return activeTopicSet(this.entries.values()).size
  }

  activeSubscriptionCount(): number {
    return this.entries.size
  }

  private assertTopicQuota(key: string, topics: readonly string[]): void {
    const next = activeTopicSet([...this.entries.entries()].filter(([entryKey]) => entryKey !== key).map(([, entry]) => entry))
    for (const topic of topics) next.add(topic)
    if (next.size > this.maxTopics) {
      throw new Error(`Event subscription topic quota exceeded (${next.size}/${this.maxTopics}).`)
    }
  }

  private start<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>): void {
    entry.generation += 1
    const generation = entry.generation
    clearManagedTimer(entry.reconnectTimer)
    entry.reconnectTimer = null
    clearManagedTimer(entry.ttlTimer)
    entry.ttlTimer = null
    entry.controller = new AbortController()
    entry.subscription = null
    this.emitStatus(entry, 'connecting')
    void this.consume(entry, generation)
  }

  private async consume<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, generation: number): Promise<void> {
    const controller = entry.controller
    if (!controller) return
    let subscription: AuroraEventSubscription<TPayload> | null = null
    try {
      subscription = entry.open({
        stream: entry.stream,
        topics: [...entry.topics],
        ...(entry.kinds ? { kinds: [...entry.kinds] } : {}),
        lastEventId: entry.lastEventId,
        replayFrom: entry.lastEventId ?? entry.replayFrom,
        backfill: entry.backfill,
        reconnect: entry.reconnect,
        signal: controller.signal,
      })
      if (!this.entryIsActive(entry, generation)) return
      entry.subscription = subscription
      if (this.leaseTtlMs > 0) {
        entry.ttlTimer = setTimeout(() => {
          if (!this.entryIsActive(entry, generation) || entry.listeners.size === 0) return
          this.restartEntry(entry, 'event subscription ttl renewal')
        }, this.leaseTtlMs)
      }
      await subscription.ready
      if (!this.entryIsActive(entry, generation)) return
      this.emitStatus(entry, 'connected')
      for await (const event of subscription) {
        if (!this.entryIsActive(entry, generation)) return
        entry.lastEventId = event.id ?? entry.lastEventId
        this.emitEvent(entry, event)
        this.emitStatus(entry, 'connected', { lastEventId: entry.lastEventId })
      }
      if (!this.entryIsActive(entry, generation)) return
      this.scheduleReconnect(entry, new Error('Event subscription closed before all listeners released.'))
    } catch (error) {
      if (!this.entryIsActive(entry, generation)) return
      if (entry.isTerminalError(error)) {
        this.emitError(entry, error)
        this.emitStatus(entry, 'error', { error, lastEventId: entry.lastEventId })
        return
      }
      this.scheduleReconnect(entry, error)
    } finally {
      if (this.entryIsActive(entry, generation)) {
        clearManagedTimer(entry.ttlTimer)
        entry.ttlTimer = null
        entry.subscription = null
        subscription?.close('event subscription manager cleanup')
      }
    }
  }

  private scheduleReconnect<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, error: unknown): void {
    this.emitError(entry, error)
    this.emitStatus(entry, 'reconnecting', { error, lastEventId: entry.lastEventId })
    clearManagedTimer(entry.reconnectTimer)
    entry.reconnectTimer = setTimeout(() => {
      if (!this.entries.has(entry.key) || entry.listeners.size === 0) return
      this.restartEntry(entry, 'event subscription reconnect')
    }, this.reconnectDelayMs)
  }

  private restartEntry<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, reason: string): void {
    entry.controller?.abort()
    entry.subscription?.close(reason)
    this.start(entry)
  }

  private closeEntry<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, reason: string): void {
    this.entries.delete(entry.key)
    clearManagedTimer(entry.reconnectTimer)
    clearManagedTimer(entry.ttlTimer)
    entry.reconnectTimer = null
    entry.ttlTimer = null
    entry.controller?.abort()
    entry.controller = null
    entry.subscription?.close(reason)
    entry.subscription = null
  }

  private entryIsActive<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, generation: number): boolean {
    return this.entries.get(entry.key) === entry && entry.generation === generation && entry.controller?.signal.aborted !== true
  }

  private emitEvent<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, event: AuroraEvent<TPayload>): void {
    for (const listener of entry.listeners) {
      if (!listener.released) listener.onEvent(event)
    }
  }

  private emitError<TPayload>(entry: ManagedEventSubscriptionEntry<TPayload>, error: unknown): void {
    for (const listener of entry.listeners) {
      if (!listener.released) listener.onError?.(error)
    }
  }

  private emitStatus<TPayload>(
    entry: ManagedEventSubscriptionEntry<TPayload>,
    status: ManagedEventSubscriptionStatus,
    metadata: { error?: unknown; lastEventId?: string | null } = {},
  ): void {
    entry.status = status
    entry.statusMetadata = { lastEventId: entry.lastEventId, ...metadata }
    for (const listener of entry.listeners) {
      if (!listener.released) listener.onStatus?.(status, entry.statusMetadata)
    }
  }
}

export function managedSubscriptionKey(
  scopeId: string,
  stream: string,
  topics: readonly string[],
  kinds?: readonly string[] | undefined,
): string {
  return JSON.stringify({
    scopeId,
    stream,
    topics: [...normalizeManagedTopics(topics)].sort(),
    kinds: kinds ? [...new Set(kinds)].sort() : [],
  })
}

export function normalizeManagedTopics(topics: readonly string[]): string[] {
  const normalized = topics.map((topic) => topic.trim())
  if (normalized.length === 0) throw new Error('Event subscription topics must be explicitly enumerated.')
  for (const topic of normalized) {
    if (!topic) throw new Error('Event subscription topic cannot be empty.')
    if (!/^[A-Za-z0-9_.:/-]+$/u.test(topic) || /[*#+]/u.test(topic)) {
      throw new Error(`Event subscription topic must be an exact Aurora event topic: ${topic}`)
    }
  }
  return [...new Set(normalized)]
}

function activeTopicSet(entries: Iterable<ManagedEventSubscriptionEntry>): Set<string> {
  const topics = new Set<string>()
  for (const entry of entries) {
    for (const topic of entry.topics) topics.add(topic)
  }
  return topics
}

function clearManagedTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer)
}
