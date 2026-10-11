'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AuroraError,
  type AuroraClient,
  type AuroraEvent,
  type AuroraEventSubscription,
  type AuroraSubscribeOptions
} from '@aurora/client'

const DEFAULT_MAX_NATIVE_GAP_RECOVERIES = 1

export interface UseAuroraEventsOptions<TPayload = unknown> extends AuroraSubscribeOptions {
  client: Pick<AuroraClient, 'events'> | null | undefined
  enabled?: boolean | undefined
  maxEvents?: number | undefined
  maxGapRecoveries?: number | undefined
  bootstrapSnapshot?: boolean | undefined
  lifecycleScopeKey?: string | null | undefined
  onSnapshot?: (
    snapshot: AuroraEventsSnapshot<TPayload>,
    context: AuroraEventsSnapshotContext<TPayload>
  ) => AuroraEventsSnapshotRecoveryDecision | void | Promise<AuroraEventsSnapshotRecoveryDecision | void>
}

export interface AuroraEventsSnapshot<TPayload = unknown> {
  events: Array<AuroraEvent<TPayload>>
  lastSequenceId: string | null
  replayComplete: boolean
  subjects?: unknown[] | undefined
}

export interface AuroraEventsSnapshotContext<TPayload = unknown> {
  reason: 'bootstrap' | 'recovery'
  gap: AuroraEvent<TPayload> | null
  firstMissingSequence: number | null
}

export interface AuroraEventsSnapshotRecoveryDecision {
  recovered: true
  replayEvents?: boolean | undefined
  resumeEventId?: string | null | undefined
}

export interface AuroraEventsRecoveryState {
  status: 'idle' | 'recovering' | 'recovered' | 'unrecoverable'
  firstMissingSequence: number | null
  lastSequenceId: string | null
  replayComplete: boolean | null
  subjects: unknown[] | null
}

export interface UseAuroraEventsResult<TPayload = unknown> {
  status: 'idle' | 'connecting' | 'streaming' | 'recovering' | 'closed' | 'error'
  events: Array<AuroraEvent<TPayload>>
  lastEventId: string | null
  error: Error | null
  recovery: AuroraEventsRecoveryState
}

interface InternalAuroraEventsState<TPayload> extends UseAuroraEventsResult<TPayload> {
  client: Pick<AuroraClient, 'events'> | null | undefined
  scopeKey: string
}

type NativeEventResumeUnsubscribe = () => void | Promise<void>
type NativeEventResumeSubscriber = (listener: () => void) => NativeEventResumeUnsubscribe | Promise<NativeEventResumeUnsubscribe>

interface NativeEventLifecycleSource {
  subscribeNativeResume?: NativeEventResumeSubscriber
}

export function useAuroraEvents<TPayload = unknown>(
  options: UseAuroraEventsOptions<TPayload>,
  onEvent?: (event: AuroraEvent<TPayload>) => void | Promise<void>
): UseAuroraEventsResult<TPayload> {
  const {
    client,
    enabled = true,
    maxEvents = 100,
    maxGapRecoveries = DEFAULT_MAX_NATIVE_GAP_RECOVERIES,
    bootstrapSnapshot = false,
    lifecycleScopeKey = null,
    onSnapshot,
    signal,
    ...subscribeOptions
  } = options
  const onEventRef = useRef(onEvent)
  const onSnapshotRef = useRef(onSnapshot)
  const currentScopeRef = useRef({ client, scopeKey: '', enabled, signal })
  const nativeResumeInvalidationRef = useRef<(() => void) | null>(null)
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  const seenEventOrderRef = useRef<string[]>([])
  const safeMaxEvents = normalizeMaxEvents(maxEvents)
  const safeMaxGapRecoveries = normalizeMaxGapRecoveries(maxGapRecoveries)
  const nativeLifecycleSource = subscribeOptions.source === 'native'
    ? client?.events as NativeEventLifecycleSource | null | undefined
    : null
  const invalidateActiveNativeScope = useCallback(() => {
    nativeResumeInvalidationRef.current?.()
  }, [])
  const nativeLifecycle = useNativeEventResumeEpoch(
    enabled && subscribeOptions.source === 'native',
    nativeLifecycleSource,
    invalidateActiveNativeScope
  )
  const nativeLifecycleEpoch = nativeLifecycle.epoch
  const subjectKey = useMemo(
    () => JSON.stringify({ subject: subscribeOptions.subject ?? null, subjects: subscribeOptions.subjects ?? [] }),
    [subscribeOptions.subject, subscribeOptions.subjects]
  )
  const topicsKey = useMemo(() => JSON.stringify(subscribeOptions.topics ?? []), [subscribeOptions.topics])
  const kindsKey = useMemo(() => JSON.stringify(subscribeOptions.kinds ?? []), [subscribeOptions.kinds])
  const headersKey = useMemo(() => safeStableKey(subscribeOptions.headers), [subscribeOptions.headers])
  const payloadKey = useMemo(() => safeStableKey(subscribeOptions.payload), [subscribeOptions.payload])
  const auditKey = useMemo(() => safeStableKey(subscribeOptions.audit), [subscribeOptions.audit])
  const reconnectKey = useMemo(() => safeStableKey(subscribeOptions.reconnect), [subscribeOptions.reconnect])
  const scopeKey = useMemo(
    () => safeStableKey({
      source: subscribeOptions.source ?? null,
      stream: subscribeOptions.stream ?? null,
      protocol: subscribeOptions.protocol ?? null,
      path: subscribeOptions.path ?? null,
      lastEventId: subscribeOptions.lastEventId ?? null,
      replayFrom: subscribeOptions.replayFrom ?? null,
      lastSequenceId: subscribeOptions.lastSequenceId ?? null,
      backfill: subscribeOptions.backfill ?? null,
      correlationId: subscribeOptions.correlationId ?? null,
      timeoutMs: subscribeOptions.timeoutMs ?? null,
      subjectKey,
      topicsKey,
      kindsKey,
      headersKey,
      payloadKey,
      auditKey,
      reconnectKey,
      bootstrapSnapshot,
      lifecycleScopeKey,
      safeMaxEvents,
      safeMaxGapRecoveries,
      nativeLifecycleEpoch,
      nativeLifecycleError: nativeLifecycle.error?.message ?? null
    }),
    [
      subscribeOptions.source,
      subscribeOptions.stream,
      subscribeOptions.protocol,
      subscribeOptions.path,
      subscribeOptions.lastEventId,
      subscribeOptions.replayFrom,
      subscribeOptions.lastSequenceId,
      subscribeOptions.backfill,
      subscribeOptions.correlationId,
      subscribeOptions.timeoutMs,
      subjectKey,
      topicsKey,
      kindsKey,
      headersKey,
      payloadKey,
      auditKey,
      reconnectKey,
      bootstrapSnapshot,
      lifecycleScopeKey,
      safeMaxEvents,
      safeMaxGapRecoveries,
      nativeLifecycleEpoch,
      nativeLifecycle.error
    ]
  )
  const resetState = (): UseAuroraEventsResult<TPayload> => ({
    status: enabled && client ? 'connecting' : 'idle',
    events: [],
    lastEventId: subscribeOptions.lastEventId ?? null,
    error: null,
    recovery: idleRecovery()
  })
  const [state, setState] = useState<InternalAuroraEventsState<TPayload>>({
    ...resetState(),
    client,
    scopeKey
  })
  const visibleState = state.client === client && state.scopeKey === scopeKey
    ? state
    : { ...resetState(), client, scopeKey }
  currentScopeRef.current = { client, scopeKey, enabled, signal }

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    onSnapshotRef.current = onSnapshot
  }, [onSnapshot])

  useEffect(() => {
    seenEventIdsRef.current = new Set()
    seenEventOrderRef.current = []
    if (!enabled || !client) {
      setState({ ...resetState(), client, scopeKey })
      return
    }
    if (nativeLifecycle.error) {
      setState({
        ...resetState(),
        client,
        scopeKey,
        status: 'error',
        error: nativeLifecycle.error,
        recovery: {
          ...idleRecovery(),
          status: 'unrecoverable'
        }
      })
      return
    }

    const controller = new AbortController()
    let cancelled = false
    let cursorEventId = subscribeOptions.lastEventId ?? subscribeOptions.replayFrom ?? null
    let cursorSequence = normalizeCursorSequenceId(subscribeOptions.lastSequenceId)
    let recoveriesUsed = 0
    let resumeInvalidated = false
    let activeSubscription: AuroraEventSubscription<TPayload> | null = null
    const isCurrentScope = () => currentScopeRef.current.client === client
      && currentScopeRef.current.scopeKey === scopeKey
      && currentScopeRef.current.enabled === enabled
      && currentScopeRef.current.signal === signal
      && enabled
    const isInactiveScope = () => cancelled || resumeInvalidated || controller.signal.aborted || signal?.aborted === true || !isCurrentScope()
    const abortFromExternalSignal = () => {
      controller.abort()
      activeSubscription?.close('external-abort')
      if (cancelled || !isCurrentScope()) return
      setState((current) => isCurrentScope() && !cancelled
        ? { ...current, status: 'closed', error: null }
        : current)
    }
    nativeResumeInvalidationRef.current = () => {
      if (cancelled || resumeInvalidated || subscribeOptions.source !== 'native') return
      resumeInvalidated = true
      controller.abort()
      activeSubscription?.close('native-resume')
    }
    setState({ ...resetState(), client, scopeKey })
    if (signal?.aborted) {
      abortFromExternalSignal()
    } else {
      signal?.addEventListener('abort', abortFromExternalSignal, { once: true })
    }
    const updateScopedState = (
      updater: (current: UseAuroraEventsResult<TPayload>) => UseAuroraEventsResult<TPayload>
    ) => {
      if (isInactiveScope()) return
      setState((current) => {
        const base = current.client === client && current.scopeKey === scopeKey ? current : { ...resetState(), client, scopeKey }
        return { ...updater(base), client, scopeKey }
      })
    }

    const handleNormalEvent = async (event: AuroraEvent<TPayload>) => {
      if (isInactiveScope() || isDuplicateEvent(event, seenEventIdsRef.current, seenEventOrderRef.current, safeMaxEvents)) return
      const onEventForScope = onEventRef.current
      await onEventForScope?.(event)
      if (isInactiveScope()) return
      if (event.id) {
        cursorEventId = event.id
        if (subscribeOptions.source === 'native' && sequenceNumberFromNativeId(event.id) !== null) {
          cursorSequence = event.id
        }
      }
      updateScopedState((current) => ({
        ...current,
        status: 'streaming',
        error: null,
        lastEventId: event.id ?? current.lastEventId,
        events: appendBounded(current.events, event, safeMaxEvents)
      }))
    }

    const consumeSnapshot = async (
      context: AuroraEventsSnapshotContext<TPayload>
    ): Promise<'resubscribe' | 'continue'> => {
      if (isInactiveScope()) return 'continue'
      if (typeof client.events.snapshot !== 'function') throw new Error('Native event snapshot is unavailable')
      const onSnapshotForScope = onSnapshotRef.current
      const snapshotAfterSequence = context.firstMissingSequence !== null
        ? Math.max(0, context.firstMissingSequence - 1)
        : sequenceNumberFromNativeId(cursorSequence ?? cursorEventId)
      const snapshot = await client.events.snapshot<TPayload>({
        ...subscribeOptions,
        source: 'native',
        signal: controller.signal,
        ...(snapshotAfterSequence !== null ? { afterSequence: snapshotAfterSequence } : {})
      })
      if (isInactiveScope()) return 'continue'
      updateScopedState((current) => ({
        ...current,
        status: 'recovering',
        recovery: {
          status: 'recovering',
          firstMissingSequence: context.firstMissingSequence,
          lastSequenceId: snapshot.lastSequenceId,
          replayComplete: snapshot.replayComplete,
          subjects: snapshot.subjects ?? null
        }
      }))
      const decision = await onSnapshotForScope?.(snapshot, context)
      if (isInactiveScope()) return 'continue'
      const recoveredFromSnapshot = snapshot.replayComplete || decision?.recovered === true
      if (!recoveredFromSnapshot) {
        throw new Error('Native event snapshot did not complete replay and subject state was not acknowledged')
      }
      const replayEvents = snapshot.replayComplete && decision?.replayEvents !== false
      if (replayEvents) {
        for (const snapshotEvent of snapshot.events) {
          if (snapshotEvent.kind === 'native.events.gap') throw new Error('Native event snapshot contained a nested gap')
          await handleNormalEvent(snapshotEvent)
          if (isInactiveScope()) return 'continue'
        }
      }
      cursorSequence = snapshot.lastSequenceId
      cursorEventId = decision?.resumeEventId ?? snapshot.lastSequenceId ?? cursorEventId
      updateScopedState((current) => ({
        ...current,
        status: 'streaming',
        lastEventId: cursorEventId ?? current.lastEventId,
        recovery: {
          status: 'recovered',
          firstMissingSequence: context.firstMissingSequence,
          lastSequenceId: snapshot.lastSequenceId,
          replayComplete: snapshot.replayComplete,
          subjects: snapshot.subjects ?? null
        }
      }))
      return context.reason === 'recovery' ? 'resubscribe' : 'continue'
    }

    const bootstrapFromSnapshot = async () => {
      if (!bootstrapSnapshot || isInactiveScope()) return
      updateScopedState((current) => ({
        ...current,
        status: 'recovering',
        error: null,
        recovery: {
          status: 'recovering',
          firstMissingSequence: null,
          lastSequenceId: null,
          replayComplete: null,
          subjects: null
        }
      }))
      await consumeSnapshot({ reason: 'bootstrap', gap: null, firstMissingSequence: null })
    }

    const handleGapEvent = async (event: AuroraEvent<TPayload>): Promise<'resubscribe' | 'continue'> => {
      const firstMissingSequence = readFirstMissingSequence(event)
      if (firstMissingSequence === null) throw new Error('Native event gap is missing firstMissingSequence')
      if (recoveriesUsed >= safeMaxGapRecoveries) {
        throw new Error('Native event gap recovery retry limit reached')
      }
      recoveriesUsed += 1
      if (!isDuplicateEvent(event, seenEventIdsRef.current, seenEventOrderRef.current, safeMaxEvents)) {
        const onEventForScope = onEventRef.current
        await onEventForScope?.(event)
        if (isInactiveScope()) return 'resubscribe'
        updateScopedState((current) => ({
          ...current,
          status: 'recovering',
          error: null,
          events: appendBounded(current.events, event, safeMaxEvents),
          recovery: {
            status: 'recovering',
            firstMissingSequence,
            lastSequenceId: null,
            replayComplete: null,
            subjects: null
          }
        }))
      } else {
        updateScopedState((current) => ({
          ...current,
          status: 'recovering',
          error: null,
          recovery: {
            status: 'recovering',
            firstMissingSequence,
            lastSequenceId: current.recovery.lastSequenceId,
            replayComplete: current.recovery.replayComplete,
            subjects: current.recovery.subjects
          }
        }))
      }
      return await consumeSnapshot({ reason: 'recovery', gap: event, firstMissingSequence })
    }

    const recoverNativeTransportLoss = async (error: unknown): Promise<boolean> => {
      if (isInactiveScope()) return false
      if (
        subscribeOptions.source !== 'native'
        || !(error instanceof AuroraError)
        || error.code !== 'transport_loss'
        || recoveriesUsed >= safeMaxGapRecoveries
      ) {
        throw error
      }
      recoveriesUsed += 1
      updateScopedState((current) => ({
        ...current,
        status: 'recovering',
        error: null,
        recovery: {
          status: 'recovering',
          firstMissingSequence: null,
          lastSequenceId: current.recovery.lastSequenceId,
          replayComplete: null,
          subjects: null
        }
      }))
      return await consumeSnapshot({
        reason: 'recovery',
        gap: null,
        firstMissingSequence: null
      }) === 'resubscribe'
    }

    const markUnrecoverable = (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error('Aurora native event recovery failed')
      updateScopedState((current) => ({
        ...current,
        status: 'error',
        error: normalized,
        recovery: {
          ...current.recovery,
          status: current.recovery.status === 'idle' ? 'unrecoverable' : current.recovery.status === 'recovered' ? 'recovered' : 'unrecoverable'
        }
      }))
    }

    void (async () => {
      try {
        await bootstrapFromSnapshot()
        if (isInactiveScope()) return
        while (!isInactiveScope()) {
          const subscription = client.events.subscribe<TPayload>({
            ...subscribeOptions,
            lastEventId: cursorEventId,
            lastSequenceId: cursorSequence ?? subscribeOptions.lastSequenceId,
            signal: controller.signal
          })
          activeSubscription = subscription
          let shouldResubscribe = false
          let closeReason = 'component-unmounted'
          try {
            let subscriptionReady = true
            try {
              await subscription.ready
            } catch (error) {
              subscriptionReady = false
              shouldResubscribe = await recoverNativeTransportLoss(error)
              if (shouldResubscribe) closeReason = 'native-transport-recovered'
            }
            if (subscriptionReady && !isInactiveScope()) {
              updateScopedState((current) => ({
                ...current,
                status: 'streaming',
                error: null
              }))
              const iterator = subscription[Symbol.asyncIterator]()
              while (!isInactiveScope()) {
                let result: IteratorResult<AuroraEvent<TPayload>>
                try {
                  result = await iterator.next()
                } catch (error) {
                  shouldResubscribe = await recoverNativeTransportLoss(error)
                  if (shouldResubscribe) closeReason = 'native-transport-recovered'
                  break
                }
                if (result.done || isInactiveScope()) break
                const event = result.value
                if (event.kind === 'native.events.gap') {
                  shouldResubscribe = await handleGapEvent(event) === 'resubscribe'
                  if (shouldResubscribe) closeReason = 'native-gap-recovered'
                  break
                }
                await handleNormalEvent(event)
              }
            }
          } finally {
            if (activeSubscription === subscription) activeSubscription = null
            subscription.close(closeReason)
          }
          if (!shouldResubscribe) break
        }
        if (!isInactiveScope()) {
          updateScopedState((current) => ({
            ...current,
            status: 'closed',
            error: null
          }))
        }
      } catch (error) {
        if (cancelled) return
        if (controller.signal.aborted) {
          return
        }
        markUnrecoverable(error)
      }
    })()

    return () => {
      cancelled = true
      if (nativeResumeInvalidationRef.current) nativeResumeInvalidationRef.current = null
      controller.abort()
      activeSubscription?.close('component-unmounted')
      signal?.removeEventListener('abort', abortFromExternalSignal)
    }
  }, [
    client,
    enabled,
    safeMaxEvents,
    safeMaxGapRecoveries,
    bootstrapSnapshot,
    scopeKey,
    subscribeOptions.source,
    subscribeOptions.stream,
    subscribeOptions.protocol,
    subscribeOptions.path,
    subscribeOptions.lastEventId,
    subscribeOptions.replayFrom,
    subscribeOptions.lastSequenceId,
    subscribeOptions.backfill,
    subscribeOptions.correlationId,
    subscribeOptions.timeoutMs,
    signal,
    nativeLifecycle.error,
    subjectKey,
    topicsKey,
    kindsKey,
    headersKey,
    payloadKey,
    auditKey,
    reconnectKey
  ])

  return visibleResultFromState(visibleState)
}

function useNativeEventResumeEpoch(
  enabled: boolean,
  lifecycleSource: NativeEventLifecycleSource | null | undefined,
  invalidateActiveNativeScope: () => void
): { epoch: number; error: Error | null } {
  const [epoch, setEpoch] = useState(0)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!enabled) {
      setError(null)
      return
    }
    let active = true
    let unsubscribeNativeResume: NativeEventResumeUnsubscribe | null = null
    const documentTarget = typeof document === 'undefined' ? null : document
    const markRegistrationUnavailable = (reason: unknown) => {
      const normalized = nativeResumeUnavailableError(reason)
      if (active) setError(normalized)
    }
    const bump = () => {
      if (!active) return
      invalidateActiveNativeScope()
      setEpoch((current) => current + 1)
    }
    const bumpOnVisible = () => {
      if (documentTarget?.visibilityState === 'hidden') return
      bump()
    }

    setError(null)
    documentTarget?.addEventListener('visibilitychange', bumpOnVisible)
    try {
      const nativeResumeSubscription = lifecycleSource?.subscribeNativeResume?.(bump)
      void Promise.resolve(nativeResumeSubscription)
        .then((unsubscribe) => {
          if (typeof unsubscribe !== 'function') return
          if (!active) {
            runNativeResumeCleanup(unsubscribe)
            return
          }
          unsubscribeNativeResume = unsubscribe
        })
        .catch(markRegistrationUnavailable)
    } catch (reason) {
      markRegistrationUnavailable(reason)
    }
    return () => {
      active = false
      documentTarget?.removeEventListener('visibilitychange', bumpOnVisible)
      if (unsubscribeNativeResume) runNativeResumeCleanup(unsubscribeNativeResume)
    }
  }, [enabled, lifecycleSource, invalidateActiveNativeScope])

  return { epoch, error }
}

function nativeResumeUnavailableError(reason: unknown): Error {
  const detail = reason instanceof Error && reason.message ? ` ${reason.message}` : ''
  return new Error(`Aurora native resume recovery is unavailable.${detail}`)
}

function runNativeResumeCleanup(unsubscribe: NativeEventResumeUnsubscribe): void {
  try {
    void Promise.resolve(unsubscribe()).catch(() => undefined)
  } catch {
    // Cleanup happens during scope changes and unmount; contain listener teardown failures.
  }
}

function visibleResultFromState<TPayload>(state: UseAuroraEventsResult<TPayload>): UseAuroraEventsResult<TPayload> {
  return {
    status: state.status,
    events: state.events,
    lastEventId: state.lastEventId,
    error: state.error,
    recovery: state.recovery
  }
}

function appendBounded<TPayload>(
  events: Array<AuroraEvent<TPayload>>,
  event: AuroraEvent<TPayload>,
  maxEvents: number
): Array<AuroraEvent<TPayload>> {
  if (maxEvents <= 0) return []
  const next = [...events, event]
  return next.length > maxEvents ? next.slice(next.length - maxEvents) : next
}

function isDuplicateEvent(event: AuroraEvent, seen: Set<string>, order: string[], maxEvents: number): boolean {
  const key = eventDedupeKey(event)
  if (!key) return false
  if (seen.has(key)) return true
  seen.add(key)
  order.push(key)
  const dedupeLimit = Math.max(1, maxEvents)
  while (order.length > dedupeLimit) {
    const oldest = order.shift()
    if (oldest) seen.delete(oldest)
  }
  return false
}

function eventDedupeKey(event: AuroraEvent): string | null {
  if (event.id) return `id:${event.id}`
  const payload = event.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const sequence = (payload as Record<string, unknown>).sequence ?? (payload as Record<string, unknown>).sequenceId
  if (typeof sequence === 'string' || typeof sequence === 'number') return `sequence:${event.kind}:${sequence}`
  return null
}

function readFirstMissingSequence(event: AuroraEvent): number | null {
  const payload = event.payload
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>).firstMissingSequence
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  }
  if (!event.id?.startsWith('native:gap:')) return null
  const fromId = Number(event.id.slice('native:gap:'.length))
  return Number.isSafeInteger(fromId) && fromId >= 0 ? fromId : null
}

function normalizeCursorSequenceId(value: number | string | null | undefined): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return `native:${value}`
  if (typeof value === 'string' && value.trim()) return value.startsWith('native:') ? value : `native:${value}`
  return null
}

function sequenceNumberFromNativeId(value: string | null | undefined): number | null {
  if (!value?.startsWith('native:')) return null
  const sequence = Number(value.slice('native:'.length))
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null
}

function normalizeMaxEvents(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function normalizeMaxGapRecoveries(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_NATIVE_GAP_RECOVERIES
}

function idleRecovery(): AuroraEventsRecoveryState {
  return {
    status: 'idle',
    firstMissingSequence: null,
    lastSequenceId: null,
    replayComplete: null,
    subjects: null
  }
}

function safeStableKey(value: unknown): string {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}
