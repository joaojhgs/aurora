'use client'

import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { GATEWAY_EVENT_TOPICS, normalizeError, type AuroraClient, type AuroraError, type AuroraErrorCode, type AuroraEvent } from '@aurora/client'
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AuroraShellSnapshot } from './shell-data'
import { createAuroraQueryScopeId, type AuroraQueryScopeInput } from './query'
import { useConnectionStore, type AuroraLiveStreamName } from './state/connection-store'
import { EventSubscriptionManager, type ManagedEventSubscriptionLease, type ManagedEventSubscriptionStatus } from './event-subscription-manager'

type EventPayload = Record<string, unknown>

const HOSTED_LIVE_SHELL_TRACE_LIMIT = 64
export type HostedLiveShellTraceStage =
  | 'sdk.received'
  | 'sdk.filter.accepted'
  | 'sdk.filter.rejected'
  | 'ui.accepted'
  | 'handler.before'
  | 'handler.after'
  | 'snapshot.completed'
  | 'snapshot.discarded'
  | 'snapshot.failed'

export type HostedLiveShellTraceEntry = {
  stage: HostedLiveShellTraceStage
  stream?: AuroraLiveStreamName
  kind?: string
  id?: string | null
  freshness?: AuroraShellSnapshot['capabilityFreshness']
}

type HostedLiveShellTraceState = {
  counts: Partial<Record<HostedLiveShellTraceStage, number>>
  entries: HostedLiveShellTraceEntry[]
}

type HostedLiveShellTraceWindow = Window & {
  __auroraHostedLiveShellTrace?: () => HostedLiveShellTraceState
}

function hostedLiveShellTraceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST === '1'
}

export function recordHostedLiveShellTrace(entry: HostedLiveShellTraceEntry): void {
  if (!hostedLiveShellTraceEnabled() || typeof window === 'undefined') return
  const traceWindow = window as HostedLiveShellTraceWindow
  const current = traceWindow.__auroraHostedLiveShellTrace?.() ?? { counts: {}, entries: [] }
  const counts = { ...current.counts, [entry.stage]: (current.counts[entry.stage] ?? 0) + 1 }
  const entries = [...current.entries, entry].slice(-HOSTED_LIVE_SHELL_TRACE_LIMIT)
  traceWindow.__auroraHostedLiveShellTrace = () => ({ counts: { ...counts }, entries: [...entries] })
}

const LIVE_SHELL_RECONNECT_DELAY_MS = 1_000
const TERMINAL_LIVE_SHELL_ERROR_CODES = new Set<AuroraErrorCode>([
  'auth',
  'permission',
  'privacy_blocked',
  'native_permission_missing',
  'unsupported_feature',
  'validation'
])

export const LIVE_SHELL_EVENT_TOPICS: Record<AuroraLiveStreamName, readonly string[]> = {
  health: [GATEWAY_EVENT_TOPICS.statusChanged],
  config: [GATEWAY_EVENT_TOPICS.statusChanged],
}

const LIVE_SHELL_EVENT_KINDS: Record<AuroraLiveStreamName, readonly string[]> = {
  health: ['service.announced', 'service.stale'],
  config: ['config.updated', 'config.validation_failed'],
}

const liveShellEventManagers = new WeakMap<AuroraClient, EventSubscriptionManager>()

export function getLiveShellEventSubscriptionManager(client: AuroraClient): EventSubscriptionManager {
  const existing = liveShellEventManagers.get(client)
  if (existing) return existing
  const manager = new EventSubscriptionManager({ maxTopics: 8, reconnectDelayMs: LIVE_SHELL_RECONNECT_DELAY_MS })
  liveShellEventManagers.set(client, manager)
  return manager
}

export type AuroraLiveShellCursorMap = Record<AuroraLiveStreamName, string | null>

export interface ShellEventPatchResult {
  snapshot: AuroraShellSnapshot
  shouldRefreshSnapshot: boolean
}

function payloadRecord(payload: unknown): EventPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as EventPayload
    : {}
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function freshnessValue(value: unknown): AuroraShellSnapshot['capabilityFreshness'] | null {
  if (value === 'current') return 'fresh'
  return value === 'pending' || value === 'fresh' || value === 'stale' ? value : null
}

const SHELL_REFRESH_EVENT_KINDS = new Set([
  'config.updated',
  'config.reload',
  'service.announced',
  'service.stale',
  'health.stale'
])

export function shouldRefreshShellSnapshot(event: Pick<AuroraEvent, 'kind'>): boolean {
  return SHELL_REFRESH_EVENT_KINDS.has(event.kind)
}

export function shellEventQueryKeys(
  event: Pick<AuroraEvent, 'kind'>,
  scopeKey: QueryKey = ['aurora'],
): readonly QueryKey[] {
  if (!shouldRefreshShellSnapshot(event)) return []
  return [scopeKey]
}

export function invalidateAuroraQueriesForShellEvent(
  queryClient: QueryClient,
  event: Pick<AuroraEvent, 'kind'>,
  scopeKey?: QueryKey,
): void {
  for (const queryKey of shellEventQueryKeys(event, scopeKey)) {
    void queryClient.invalidateQueries({ queryKey })
  }
}

/**
 * Applies only evidence present in an authoritative event. It intentionally
 * keeps the existing route graph until a fresh SDK read completes.
 */
export function patchShellSnapshotForEvent(
  snapshot: AuroraShellSnapshot,
  event: Pick<AuroraEvent, 'kind' | 'payload' | 'receivedAt'>
): ShellEventPatchResult {
  const payload = payloadRecord(event.payload)
  const next = { ...snapshot }
  const reportedFreshness = freshnessValue(payload.capability_freshness ?? payload.capabilityFreshness)
  const reportedStatus = textValue(payload.status)?.toLowerCase()
  let shouldRefreshSnapshot = false

  if (event.kind === 'config.updated' || event.kind === 'config.reload') {
    next.capabilityFreshness = 'stale'
    next.evidenceSource = 'Configuration changed; refreshing feature availability'
    shouldRefreshSnapshot = true
  } else if (event.kind === 'config.validation_failed') {
    next.capabilityFreshness = 'stale'
    next.evidenceSource = 'Configuration validation failed; feature availability is stale'
  } else if (event.kind === 'service.announced') {
    next.capabilityFreshness = reportedFreshness ?? next.capabilityFreshness
    next.evidenceSource = 'Aurora service availability changed; refreshing feature availability'
    shouldRefreshSnapshot = true
  } else if (event.kind === 'service.stale') {
    next.capabilityFreshness = 'stale'
    next.evidenceSource = 'Aurora service reported stale availability'
    shouldRefreshSnapshot = true
  } else if (event.kind === 'health.stale') {
    next.capabilityFreshness = 'stale'
    next.evidenceSource = 'Aurora health stream reported stale availability'
    next.connectionState = 'offline'
    shouldRefreshSnapshot = true
  } else if (event.kind === 'health.updated') {
    next.capabilityFreshness = reportedFreshness ?? next.capabilityFreshness
    next.evidenceSource = 'Aurora health stream'
    if (reportedStatus === 'healthy' || reportedStatus === 'ready' || reportedStatus === 'connected' || reportedStatus === 'running') {
      next.connectionState = 'connected'
    } else if (reportedStatus === 'offline' || reportedStatus === 'unavailable' || reportedStatus === 'unhealthy') {
      next.connectionState = 'offline'
      next.capabilityFreshness = 'stale'
    }
  }

  return { snapshot: next, shouldRefreshSnapshot }
}

export interface AuroraLiveShellEventsOptions {
  client: AuroraClient
  enabled?: boolean
  scopeId?: string | undefined
  queryScope?: AuroraQueryScopeInput | null | undefined
  onEvent: (event: AuroraEvent) => void
  onError?: (error: AuroraError) => void
}

export function liveShellCursorsForScopeChange(
  cursors: AuroraLiveShellCursorMap,
  currentScopeId: string | null,
  nextScopeId: string,
): { scopeId: string; cursors: AuroraLiveShellCursorMap } {
  if (currentScopeId === nextScopeId) return { scopeId: nextScopeId, cursors }
  return { scopeId: nextScopeId, cursors: { health: null, config: null } }
}

function useShellSubscriptionsPaused(): boolean {
  const [paused, setPaused] = useState(() => typeof document !== 'undefined' ? document.hidden : false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const setFromVisibility = () => setPaused(document.hidden)
    const pause = () => setPaused(true)
    const resume = () => setPaused(document.hidden)

    document.addEventListener('visibilitychange', setFromVisibility)
    window.addEventListener('aurora:app-background', pause)
    window.addEventListener('aurora:app-foreground', resume)
    window.addEventListener('aurora-app-background', pause)
    window.addEventListener('aurora-app-foreground', resume)
    return () => {
      document.removeEventListener('visibilitychange', setFromVisibility)
      window.removeEventListener('aurora:app-background', pause)
      window.removeEventListener('aurora:app-foreground', resume)
      window.removeEventListener('aurora-app-background', pause)
      window.removeEventListener('aurora-app-foreground', resume)
    }
  }, [])

  return paused
}

/**
 * Owns the health/config subscriptions for a mounted shell. Event streams are
 * additive evidence; unsupported transports simply remain on query fallback.
 */
export function useAuroraLiveShellEvents({
  client,
  enabled = true,
  scopeId,
  queryScope = null,
  onEvent,
  onError,
}: AuroraLiveShellEventsOptions): void {
  const subscriptionsPaused = useShellSubscriptionsPaused()
  const cursorsRef = useRef<AuroraLiveShellCursorMap>({ health: null, config: null })
  const cursorScopeRef = useRef<string | null>(null)
  const resolvedScopeId = scopeId ?? createAuroraQueryScopeId(client, queryScope ?? {})

  useEffect(() => {
    if (!enabled) return

    const hostedTestWindow = typeof window !== 'undefined' && process.env.NEXT_PUBLIC_AURORA_HOSTED_PEER_TEST === '1'
      ? window as Window & { __auroraHostedLiveShellState?: () => unknown; __auroraHostedLiveShellTrace?: () => HostedLiveShellTraceState }
      : null
    const hostedTestStateProbe = hostedTestWindow
      ? () => {
          const state = useConnectionStore.getState()
          return {
            scopeId: state.scopeId,
            health: state.streams.health.state,
            config: state.streams.config.state,
          }
        }
      : null
    if (hostedTestWindow && hostedTestStateProbe) {
      hostedTestWindow.__auroraHostedLiveShellState = hostedTestStateProbe
    }

    const scopedCursors = liveShellCursorsForScopeChange(cursorsRef.current, cursorScopeRef.current, resolvedScopeId)
    cursorScopeRef.current = scopedCursors.scopeId
    cursorsRef.current = scopedCursors.cursors

    const connection = useConnectionStore.getState()
    if (subscriptionsPaused) {
      connection.setStreamState('health', 'reconnecting', { scopeId: resolvedScopeId })
      connection.setStreamState('config', 'reconnecting', { scopeId: resolvedScopeId })
      return
    }

    let active = true
    const manager = getLiveShellEventSubscriptionManager(client)
    const leases = new Set<ManagedEventSubscriptionLease>()
    connection.setStreamState('health', 'connecting', { scopeId: resolvedScopeId })
    connection.setStreamState('config', 'connecting', { scopeId: resolvedScopeId })

    const isCurrentScope = () => active && cursorScopeRef.current === resolvedScopeId

    const setStreamStatus = (stream: AuroraLiveStreamName, status: ManagedEventSubscriptionStatus, error?: unknown, lastEventId?: string | null) => {
      if (!isCurrentScope()) return
      if (status === 'connected') {
        useConnectionStore.getState().setStreamState(stream, 'connected', {
          scopeId: resolvedScopeId,
          lastEventId: lastEventId ?? cursorsRef.current[stream],
        })
        return
      }
      if (status === 'connecting') {
        useConnectionStore.getState().setStreamState(stream, 'connecting', { scopeId: resolvedScopeId })
        return
      }
      const normalized = error ? normalizeError(error) : null
      if (status === 'error') {
        if (normalized) onError?.(normalized)
        useConnectionStore.getState().setStreamState(stream, 'error', {
          scopeId: resolvedScopeId,
          ...(normalized ? { error: normalized.message } : {}),
        })
        return
      }
      if (normalized) onError?.(normalized)
      useConnectionStore.getState().setStreamState(stream, 'reconnecting', {
        scopeId: resolvedScopeId,
        ...(normalized ? { error: normalized.message } : {}),
      })
    }

    const acquireSubscription = (stream: AuroraLiveStreamName) => manager.acquire<EventPayload>({
      scopeId: resolvedScopeId,
      stream,
      topics: LIVE_SHELL_EVENT_TOPICS[stream],
      kinds: LIVE_SHELL_EVENT_KINDS[stream],
      lastEventId: cursorsRef.current[stream],
      replayFrom: cursorsRef.current[stream],
      backfill: true,
      reconnect: false,
      open: (options) => stream === 'health'
        ? client.events.watchHealth<EventPayload>({
          ...options,
          ...(hostedTestWindow ? { diagnostic: (input) => recordHostedLiveShellTrace({
            stage: `sdk.${input.stage}` as HostedLiveShellTraceStage,
            stream,
            kind: input.event.kind,
            id: input.event.id,
          }) } : {}),
          ...(queryScope?.peerId ? { payload: { selector: { peer_id: queryScope.peerId } } } : {}),
        })
        : client.events.watchConfig<EventPayload>({
          ...options,
          ...(hostedTestWindow ? { diagnostic: (input) => recordHostedLiveShellTrace({
            stage: `sdk.${input.stage}` as HostedLiveShellTraceStage,
            stream,
            kind: input.event.kind,
            id: input.event.id,
          }) } : {}),
          ...(queryScope?.peerId ? { payload: { selector: { peer_id: queryScope.peerId } } } : {}),
        }),
      isTerminalError: isTerminalLiveShellError,
      onEvent: (event) => {
        if (!isCurrentScope()) return
        if (hostedTestWindow) {
          recordHostedLiveShellTrace({ stage: 'ui.accepted', stream, kind: event.kind, id: event.id })
        }
        cursorsRef.current = { ...cursorsRef.current, [stream]: event.id }
        useConnectionStore.getState().setStreamState(stream, 'connected', {
          scopeId: resolvedScopeId,
          lastEventId: event.id
        })
        onEvent(event)
      },
      onStatus: (status, metadata) => setStreamStatus(stream, status, metadata?.error, metadata?.lastEventId),
    })

    leases.add(acquireSubscription('health'))
    leases.add(acquireSubscription('config'))

    return () => {
      active = false
      if (hostedTestWindow?.__auroraHostedLiveShellState === hostedTestStateProbe) {
        delete hostedTestWindow.__auroraHostedLiveShellState
      }
      for (const lease of leases) lease.release()
      leases.clear()
    }
  }, [client, enabled, onError, onEvent, queryScope?.backend, queryScope?.peerId, queryScope?.profileId, resolvedScopeId, subscriptionsPaused])
}

function isTerminalLiveShellError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? TERMINAL_LIVE_SHELL_ERROR_CODES.has((error as { code?: AuroraErrorCode }).code as AuroraErrorCode)
    : false
}

export function createShellEventSnapshotUpdater(
  setSnapshot: Dispatch<SetStateAction<AuroraShellSnapshot>>,
  refreshSnapshot: () => Promise<AuroraShellSnapshot>
): (event: AuroraEvent) => void {
  return (event) => {
    setSnapshot((snapshot) => patchShellSnapshotForEvent(snapshot, event).snapshot)
    if (shouldRefreshShellSnapshot(event)) {
      void refreshSnapshot().then((next) => setSnapshot(next)).catch(() => undefined)
    }
  }
}
