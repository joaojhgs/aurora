'use client'

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

export type AuroraConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
export type AuroraPeerConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'
export type AuroraLiveStreamName = 'health' | 'config'
export type AuroraLiveStreamState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'disconnected'

export interface ConnectionStreamSnapshot {
  state: AuroraLiveStreamState
  lastEventId: string | null
  lastEventAt: number | null
  error: string | null
}

export interface ConnectionPeerSnapshot {
  state: AuroraPeerConnectionState
  lastEventId: string | null
  lastEventAt: number | null
  error: string | null
}

export interface ConnectionStoreState {
  scopeId: string | null
  peerConnectionScopeId: string | null
  state: AuroraConnectionState
  lastEventId: string | null
  lastEventAt: number | null
  error: string | null
  streams: Record<AuroraLiveStreamName, ConnectionStreamSnapshot>
  peer: ConnectionPeerSnapshot
  setState: (state: AuroraConnectionState, details?: { scopeId?: string | null; lastEventId?: string | null; error?: string | null }) => void
  setPeerState: (state: AuroraPeerConnectionState, details?: { peerConnectionScopeId?: string | null; lastEventId?: string | null; error?: string | null }) => void
  setStreamState: (stream: AuroraLiveStreamName, state: AuroraLiveStreamState, details?: { scopeId?: string | null; lastEventId?: string | null; error?: string | null }) => void
  reset: () => void
}

const initialStreamSnapshot: ConnectionStreamSnapshot = {
  state: 'idle',
  lastEventId: null,
  lastEventAt: null,
  error: null
}

const initialPeerSnapshot: ConnectionPeerSnapshot = {
  state: 'disconnected',
  lastEventId: null,
  lastEventAt: null,
  error: null
}

const initialConnectionState = {
  scopeId: null,
  peerConnectionScopeId: null,
  state: 'disconnected' as AuroraConnectionState,
  lastEventId: null,
  lastEventAt: null,
  error: null,
  streams: {
    health: initialStreamSnapshot,
    config: initialStreamSnapshot
  },
  peer: initialPeerSnapshot
}

function aggregateConnectionState(streams: ConnectionStoreState['streams']): AuroraConnectionState {
  if (streams.health.state === 'connected' && streams.config.state === 'connected') return 'connected'
  if (streams.health.state === 'connecting' || streams.config.state === 'connecting') return 'connecting'
  if (streams.health.state === 'error' && streams.config.state === 'error') return 'disconnected'
  if (streams.health.state === 'error' || streams.config.state === 'error') return 'reconnecting'
  if (streams.health.state === 'reconnecting' || streams.config.state === 'reconnecting') return 'reconnecting'
  return 'disconnected'
}

export const useConnectionStore = create<ConnectionStoreState>()(
  subscribeWithSelector((set) => ({
    ...initialConnectionState,
    setState: (state, details = {}) => set((current) => ({
      ...current,
      scopeId: details.scopeId === undefined ? current.scopeId : details.scopeId,
      state,
      lastEventId: details.lastEventId === undefined ? current.lastEventId : details.lastEventId,
      lastEventAt: Date.now(),
      error: details.error === undefined ? null : details.error
    })),
    setPeerState: (peerState, details = {}) => set((current) => {
      const peerConnectionScopeId = details.peerConnectionScopeId === undefined
        ? current.peerConnectionScopeId
        : details.peerConnectionScopeId
      const peerScopeChanged = current.peerConnectionScopeId !== null && peerConnectionScopeId !== current.peerConnectionScopeId
      return {
        ...current,
        peerConnectionScopeId,
        peer: {
          state: peerState,
          lastEventId: peerScopeChanged ? details.lastEventId ?? null : (details.lastEventId === undefined ? current.peer.lastEventId : details.lastEventId),
          lastEventAt: Date.now(),
          error: details.error === undefined ? null : details.error
        }
      }
    }),
    setStreamState: (stream, streamState, details = {}) => set((current) => {
      const scopeId = details.scopeId === undefined ? current.scopeId : details.scopeId
      const scopeChanged = current.scopeId !== null && scopeId !== current.scopeId
      const baseStreams = scopeChanged
        ? initialConnectionState.streams
        : current.streams
      const nextStream = {
        ...baseStreams[stream],
        state: streamState,
        lastEventId: details.lastEventId === undefined ? baseStreams[stream].lastEventId : details.lastEventId,
        lastEventAt: Date.now(),
        error: details.error === undefined ? null : details.error
      }
      const streams = {
        ...baseStreams,
        [stream]: nextStream
      }
      const state = aggregateConnectionState(streams)
      const lastEventId = details.lastEventId === undefined ? current.lastEventId : details.lastEventId
      return {
        ...current,
        scopeId,
        streams,
        state,
        lastEventId,
        lastEventAt: Date.now(),
        error: details.error === undefined ? (scopeChanged || state === 'connected' ? null : current.error) : details.error
      }
    }),
    reset: () => set(initialConnectionState)
  }))
)

export const selectConnectionState = (state: ConnectionStoreState): AuroraConnectionState => state.state
export const selectConnectionIsLive = (state: ConnectionStoreState): boolean => state.state === 'connected'
export const selectConnectionScopeId = (state: ConnectionStoreState): string | null => state.scopeId
export const selectPeerConnectionScopeId = (state: ConnectionStoreState): string | null => state.peerConnectionScopeId
export const selectPeerConnectionState = (state: ConnectionStoreState): AuroraPeerConnectionState => state.peer.state
export const selectPeerConnectionIsLive = (state: ConnectionStoreState): boolean => state.peer.state === 'connected'
