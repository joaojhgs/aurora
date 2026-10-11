'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AuroraClient, AuroraEvent } from '@aurora/client'

import { useAuroraEvents, type AuroraEventsSnapshot, type UseAuroraEventsResult } from './use-aurora-events'

export type NativePeerConnectionBadgeState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface NativePeerConnectionStateDetails {
  peerConnectionScopeId?: string | null
  scopeId?: string | null
  lastEventId?: string | null
  error?: string | null
}

export interface NativePeerConnectionStoreState {
  peerConnectionScopeId: string | null
  setPeerState(state: NativePeerConnectionBadgeState, details?: NativePeerConnectionStateDetails): void
}

export interface NativePeerConnectionStorePort extends Partial<NativePeerConnectionStoreState> {
  getState?(): NativePeerConnectionStoreState
}

export interface NativePeerRuntimeSnapshot {
  state?: string | null | undefined
  status?: string | null | undefined
  expectedStablePeerId?: string | null | undefined
  connectedStablePeerId?: string | null | undefined
  connectedSignalingPeerId?: string | null | undefined
  nodeName?: string | null | undefined
  updatedAt?: string | null | undefined
}

export interface NativePeerRuntimeSnapshotSource {
  snapshot(): NativePeerRuntimeSnapshot | null | undefined
}

export interface NativePeerStatePayload {
  peerId?: string | null | undefined
  peer_id?: string | null | undefined
  connected?: boolean | null | undefined
  sessions?: number | null | undefined
  status?: string | null | undefined
  state?: string | null | undefined
}

export interface NativePeerEventsOptions {
  client: Pick<AuroraClient, 'events'> | null | undefined
  peerId: string | null | undefined
  scopeId: string | null | undefined
  connectionStore?: NativePeerConnectionStorePort | null | undefined
  runtimePeer?: NativePeerRuntimeSnapshotSource | null | undefined
  enabled?: boolean | undefined
  nativeEventsSupported?: boolean | undefined
  maxEvents?: number | undefined
}

export interface NativePeerEventsResult extends UseAuroraEventsResult<NativePeerStatePayload> {
  nativeEventsEnabled: boolean
  peerId: string | null
  scopeId: string | null
}

const NATIVE_PEER_EVENT_KIND = 'mesh.peer.state_changed'

export function useNativePeerEvents(options: NativePeerEventsOptions): NativePeerEventsResult {
  const {
    client,
    peerId = null,
    scopeId = null,
    connectionStore = null,
    runtimePeer = null,
    enabled = true,
    nativeEventsSupported = false,
    maxEvents = 4
  } = options
  const normalizedPeerId = normalizeId(peerId)
  const normalizedScopeId = normalizeId(scopeId)
  const hasRuntimePeer = Boolean(runtimePeer)
  const nativeEventsEnabled = Boolean(enabled && nativeEventsSupported && client && normalizedPeerId && normalizedScopeId)
  const lastStoreWriteRef = useRef<string | null>(null)

  const applyConnectionState = useCallback((
    state: NativePeerConnectionBadgeState,
    details: { lastEventId?: string | null; error?: string | null } = {}
  ) => {
    if (!normalizedScopeId) return false
    const writeKey = JSON.stringify({
      scopeId: normalizedScopeId,
      state,
      lastEventId: details.lastEventId ?? null,
      error: details.error ?? null,
    })
    if (lastStoreWriteRef.current === writeKey) return true
    const applied = applyPeerConnectionState(connectionStore, normalizedScopeId, state, details)
    if (applied) lastStoreWriteRef.current = writeKey
    return applied
  }, [connectionStore, normalizedScopeId])

  useEffect(() => {
    lastStoreWriteRef.current = null
  }, [connectionStore, normalizedScopeId])

  useEffect(() => {
    if (!enabled || !normalizedScopeId || (!nativeEventsSupported && !hasRuntimePeer)) return undefined
    claimPeerConnectionScope(connectionStore, normalizedScopeId)
    return () => {
      releasePeerConnectionScope(connectionStore, normalizedScopeId)
    }
  }, [connectionStore, enabled, hasRuntimePeer, nativeEventsSupported, normalizedScopeId])

  useEffect(() => {
    if (!enabled || !normalizedPeerId || !normalizedScopeId) return
    const snapshot = runtimePeer?.snapshot()
    if (!snapshot || !snapshotMatchesPeer(snapshot, normalizedPeerId)) return
    applyConnectionState(mapRuntimeSnapshotToConnectionState(snapshot), {
      lastEventId: null,
      error: null
    })
  }, [applyConnectionState, enabled, normalizedPeerId, normalizedScopeId, runtimePeer])

  const handleEvent = useCallback((event: AuroraEvent<NativePeerStatePayload>) => {
    // Native peer events are observations for the connection badge; authorization remains Rust-owned.
    if (event.kind !== NATIVE_PEER_EVENT_KIND) return
    const payload = event.payload
    const eventPeerId = normalizeId(payload?.peerId ?? payload?.peer_id ?? event.audit.peerId)
    if (!normalizedPeerId || eventPeerId !== normalizedPeerId || !normalizedScopeId) return
    applyConnectionState(mapPeerPayloadToConnectionState(payload), {
      lastEventId: event.id ?? null,
      error: null
    })
  }, [applyConnectionState, normalizedPeerId, normalizedScopeId])

  const handleSnapshot = useCallback((snapshot: AuroraEventsSnapshot<NativePeerStatePayload>) => {
    if (!normalizedPeerId || !normalizedScopeId) return undefined
    const subjectState = findPeerSubjectState(snapshot.subjects, normalizedPeerId)
    if (!subjectState) return undefined
    applyConnectionState(mapSubjectStateToConnectionState(subjectState), {
      lastEventId: snapshot.lastSequenceId,
      error: null
    })
    return { recovered: true, replayEvents: false } as const
  }, [applyConnectionState, normalizedPeerId, normalizedScopeId])

  const eventOptions = useMemo(() => ({
    client,
    enabled: nativeEventsEnabled,
    source: 'native',
    kinds: [NATIVE_PEER_EVENT_KIND],
    subject: normalizedPeerId ?? undefined,
    maxEvents,
    bootstrapSnapshot: true,
    lifecycleScopeKey: normalizedScopeId,
    onSnapshot: handleSnapshot
  }), [client, handleSnapshot, maxEvents, nativeEventsEnabled, normalizedPeerId, normalizedScopeId])
  const state = useAuroraEvents<NativePeerStatePayload>(eventOptions, handleEvent)

  useEffect(() => {
    if (!state.error || !normalizedScopeId) return
    if (isUnsupportedNativeSourceError(state.error)) {
      releasePeerConnectionScope(connectionStore, normalizedScopeId)
      return
    }
    applyConnectionState('reconnecting', {
      lastEventId: state.lastEventId,
      error: state.error.message
    })
  }, [applyConnectionState, connectionStore, normalizedScopeId, state.error, state.lastEventId])

  return {
    ...state,
    nativeEventsEnabled,
    peerId: normalizedPeerId,
    scopeId: normalizedScopeId
  }
}

export function applyPeerConnectionState(
  store: NativePeerConnectionStorePort | null | undefined,
  scopeId: string,
  state: NativePeerConnectionBadgeState,
  details: { lastEventId?: string | null; error?: string | null } = {}
): boolean {
  const current = store?.getState?.() ?? store
  const setPeerState = current?.setPeerState ?? store?.setPeerState
  if (!current || !setPeerState) return false
  const currentScopeId = current.peerConnectionScopeId ?? null
  if (currentScopeId !== null && currentScopeId !== scopeId) return false
  setPeerState(state, {
    peerConnectionScopeId: scopeId,
    lastEventId: details.lastEventId ?? null,
    error: details.error ?? null
  })
  return true
}

export function claimPeerConnectionScope(
  store: NativePeerConnectionStorePort | null | undefined,
  scopeId: string
): boolean {
  const current = store?.getState?.() ?? store
  const setPeerState = current?.setPeerState ?? store?.setPeerState
  if (!current || !setPeerState) return false
  if ((current.peerConnectionScopeId ?? null) === scopeId) return true
  setPeerState('connecting', {
    peerConnectionScopeId: scopeId,
    lastEventId: null,
    error: null
  })
  return true
}

export function releasePeerConnectionScope(
  store: NativePeerConnectionStorePort | null | undefined,
  scopeId: string
): boolean {
  const current = store?.getState?.() ?? store
  const setPeerState = current?.setPeerState ?? store?.setPeerState
  if (!current || !setPeerState || (current.peerConnectionScopeId ?? null) !== scopeId) return false
  setPeerState('disconnected', {
    peerConnectionScopeId: null,
    lastEventId: null,
    error: null
  })
  return true
}

function mapRuntimeSnapshotToConnectionState(snapshot: NativePeerRuntimeSnapshot): NativePeerConnectionBadgeState {
  return mapStatusToConnectionState(snapshot.status ?? snapshot.state)
}

function mapPeerPayloadToConnectionState(payload: NativePeerStatePayload | null | undefined): NativePeerConnectionBadgeState {
  if (payload?.connected === true) return 'connected'
  if (payload?.connected === false) return 'disconnected'
  return mapStatusToConnectionState(payload?.status ?? payload?.state)
}

function mapSubjectStateToConnectionState(subject: Record<string, unknown>): NativePeerConnectionBadgeState {
  return mapStatusToConnectionState(readString(subject.status) ?? readString(subject.state))
}

function mapStatusToConnectionState(value: string | null | undefined): NativePeerConnectionBadgeState {
  const normalized = value?.toLowerCase()
  if (normalized === 'connected' || normalized === 'authorized' || normalized === 'authenticated' || normalized === 'ready') return 'connected'
  if (normalized === 'connecting' || normalized === 'discovering-peer' || normalized === 'negotiating') return 'connecting'
  if (normalized === 'reconnecting' || normalized === 'reconnect-authenticating') return 'reconnecting'
  if (normalized === 'failed' || normalized === 'error' || normalized === 'denied') return 'error'
  return 'disconnected'
}

function snapshotMatchesPeer(snapshot: NativePeerRuntimeSnapshot, peerId: string): boolean {
  return snapshot.expectedStablePeerId === peerId
    || snapshot.connectedStablePeerId === peerId
    || snapshot.connectedSignalingPeerId === peerId
}

function findPeerSubjectState(subjects: unknown[] | undefined, peerId: string): Record<string, unknown> | null {
  if (!Array.isArray(subjects)) return null
  for (const subject of subjects) {
    if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) continue
    const record = subject as Record<string, unknown>
    const subjectId = readString(record.subject) ?? readString(record.peerId) ?? readString(record.peer_id)
    if (subjectId === peerId) return record
  }
  return null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isUnsupportedNativeSourceError(error: Error): boolean {
  return (error as Error & { code?: unknown }).code === 'unsupported_feature'
}

function normalizeId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
