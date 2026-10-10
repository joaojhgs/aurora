import { describe, expect, it } from 'vitest'
import { selectConnectionIsLive, selectPeerConnectionIsLive, selectPeerConnectionScopeId, useConnectionStore } from './connection-store'

describe('connection store', () => {
  it('requires health and config streams before reporting a live connection', () => {
    useConnectionStore.getState().reset()
    useConnectionStore.getState().setStreamState('health', 'connected', { scopeId: 'scope-a', lastEventId: 'health-1' })
    let state = useConnectionStore.getState()
    expect(selectConnectionIsLive(state)).toBe(false)
    expect(state.state).toBe('disconnected')
    expect(state.streams.health.lastEventId).toBe('health-1')

    useConnectionStore.getState().setStreamState('config', 'connected', { scopeId: 'scope-a', lastEventId: 'config-1' })
    state = useConnectionStore.getState()
    expect(selectConnectionIsLive(state)).toBe(true)
    expect(state.lastEventId).toBe('config-1')
    useConnectionStore.getState().reset()
  })

  it('keeps peer link state separate from authoritative health and config readiness', () => {
    useConnectionStore.getState().reset()
    useConnectionStore.getState().setPeerState('connected', { peerConnectionScopeId: 'scope-a', lastEventId: 'peer-1' })
    const state = useConnectionStore.getState()
    expect(selectPeerConnectionIsLive(state)).toBe(true)
    expect(selectConnectionIsLive(state)).toBe(false)
    expect(state.state).toBe('disconnected')
    expect(state.peer.lastEventId).toBe('peer-1')
    expect(selectPeerConnectionScopeId(state)).toBe('scope-a')
    useConnectionStore.getState().reset()
  })

  it('keeps health and config replay cursors independent', () => {
    useConnectionStore.getState().reset()
    useConnectionStore.getState().setStreamState('health', 'connected', { scopeId: 'scope-a', lastEventId: 'health-42' })
    useConnectionStore.getState().setStreamState('config', 'error', { scopeId: 'scope-a', error: 'config failed' })
    const state = useConnectionStore.getState()
    expect(state.state).toBe('reconnecting')
    expect(state.streams.health.lastEventId).toBe('health-42')
    expect(state.streams.config.lastEventId).toBeNull()
    expect(state.error).toBe('config failed')
    useConnectionStore.getState().reset()
  })

  it('resets stream evidence when a new runtime scope takes ownership', () => {
    useConnectionStore.getState().reset()
    useConnectionStore.getState().setStreamState('health', 'connected', { scopeId: 'scope-a', lastEventId: 'health-a' })
    useConnectionStore.getState().setStreamState('config', 'connected', { scopeId: 'scope-a', lastEventId: 'config-a' })
    useConnectionStore.getState().setPeerState('connected', { peerConnectionScopeId: 'peer-scope-b', lastEventId: 'peer-b' })
    let state = useConnectionStore.getState()
    expect(state.scopeId).toBe('scope-a')
    expect(selectPeerConnectionScopeId(state)).toBe('peer-scope-b')
    expect(state.state).toBe('connected')
    expect(state.streams.health.lastEventId).toBe('health-a')
    expect(state.streams.config.lastEventId).toBe('config-a')

    useConnectionStore.getState().setStreamState('health', 'connecting', { scopeId: 'scope-b' })
    state = useConnectionStore.getState()
    expect(state.scopeId).toBe('scope-b')
    expect(selectPeerConnectionScopeId(state)).toBe('peer-scope-b')
    expect(state.streams.health.lastEventId).toBeNull()
    expect(state.streams.config.lastEventId).toBeNull()
    expect(state.peer.lastEventId).toBe('peer-b')
    expect(state.state).toBe('connecting')
    expect(state.error).toBeNull()
    useConnectionStore.getState().reset()
  })

  it('clears a previous stream error when a new runtime scope starts connecting', () => {
    useConnectionStore.getState().reset()
    useConnectionStore.getState().setStreamState('health', 'connected', { scopeId: 'scope-a', lastEventId: 'health-a' })
    useConnectionStore.getState().setStreamState('config', 'error', { scopeId: 'scope-a', error: 'config failed' })
    expect(useConnectionStore.getState().error).toBe('config failed')

    useConnectionStore.getState().setStreamState('health', 'connecting', { scopeId: 'scope-b' })
    const state = useConnectionStore.getState()
    expect(state.scopeId).toBe('scope-b')
    expect(state.state).toBe('connecting')
    expect(state.error).toBeNull()
    expect(state.streams.health.error).toBeNull()
    expect(state.streams.config.error).toBeNull()
    useConnectionStore.getState().reset()
  })
})
