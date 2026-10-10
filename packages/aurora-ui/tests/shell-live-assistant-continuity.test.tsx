// @vitest-environment jsdom

import { act, createElement, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { QueryClient } from '@tanstack/react-query'
import type { AuroraClient, AuroraEvent } from '@aurora/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AppShell,
  AuroraQueryProvider,
  createAuroraQueryClient,
  getAuroraSurfaceProfile,
  invalidateAuroraQueriesForShellEvent,
  loadingShellSnapshot,
  patchShellSnapshotForEvent,
  shouldRefreshShellSnapshot,
  useAuroraLiveShellEvents,
  useAuroraQueryScopeKey,
  useAuroraStateScopeId,
  type AuroraShellSnapshot,
} from '../src'
import { useAssistantStreamStore } from '../src/state/assistant-stream-store'
import { useConnectionStore } from '../src/state/connection-store'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount()
  })
  document.body.innerHTML = ''
  useAssistantStreamStore.getState().reset()
  useConnectionStore.getState().reset()
  vi.restoreAllMocks()
})

describe('live shell assistant continuity', () => {
  it('updates shell badges from pushed config and health events without remounting or resetting an in-flight assistant stream', async () => {
    const client = new LiveShellClientDouble()
    const queryClient = createAuroraQueryClient()
    const mounts = vi.fn()
    const unmounts = vi.fn()
    const refreshSnapshot = vi.fn(async () => readyShellSnapshot({
      nodeName: 'Continuity Aurora',
      capabilityFreshness: 'fresh',
      connectionState: 'connected',
      evidenceSource: 'refreshed shell snapshot',
    }))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(createElement(ShellContinuityHarness, {
        client: client as unknown as AuroraClient,
        queryClient,
        refreshSnapshot,
        mounts,
        unmounts,
      }))
      await flushShellEffects()
    })

    expect(client.healthOptions).toHaveLength(1)
    expect(client.configOptions).toHaveLength(1)
    expect(shellStatusText(container)).toContain('Healthy')
    expect(runtimeChipText(container)).toContain('connected')
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
    expect(assistantStreamState()).toEqual(expect.objectContaining({
      state: 'requested',
      messageId: 'assistant-in-flight',
      text: 'partial assistant answer',
    }))

    await act(async () => {
      client.configSubs[0]!.push(shellEvent('config-live-1', 'config.updated', { key_path: 'services.tts.voice' }))
      await flushShellEffects()
    })

    expect(shellStatusText(container)).toContain('Needs attention')
    expect(runtimeChipText(container)).toContain('attention')
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
    expect(assistantStreamState()).toEqual(expect.objectContaining({
      state: 'requested',
      messageId: 'assistant-in-flight',
      text: 'partial assistant answer',
    }))

    await act(async () => {
      client.healthSubs[0]!.push(shellEvent('health-live-1', 'health.stale', { status: 'offline' }))
      await flushShellEffects()
    })

    expect(shellStatusText(container)).toContain('Offline')
    expect(runtimeChipText(container)).toContain('offline')
    expect(mounts).toHaveBeenCalledTimes(1)
    expect(unmounts).not.toHaveBeenCalled()
    expect(assistantStreamState()).toEqual(expect.objectContaining({
      state: 'requested',
      messageId: 'assistant-in-flight',
      text: 'partial assistant answer',
    }))
    expect(refreshSnapshot).toHaveBeenCalledTimes(2)
  })
})

function ShellContinuityHarness({
  client,
  queryClient,
  refreshSnapshot,
  mounts,
  unmounts,
}: {
  client: AuroraClient
  queryClient: QueryClient
  refreshSnapshot: () => Promise<AuroraShellSnapshot>
  mounts: () => void
  unmounts: () => void
}) {
  const surfaceProfile = useMemo(() => getAuroraSurfaceProfile({ transportKind: 'mock' }), [])
  const queryScope = useMemo(() => ({ backend: 'mock', profileId: 'profile-continuity', peerId: 'peer-continuity' }), [])
  return (
    <AuroraQueryProvider client={client} surfaceProfile={surfaceProfile} queryClient={queryClient} queryScope={queryScope}>
      <LiveShellApp client={client} queryClient={queryClient} queryScope={queryScope} refreshSnapshot={refreshSnapshot} mounts={mounts} unmounts={unmounts} />
    </AuroraQueryProvider>
  )
}

function LiveShellApp({
  client,
  queryClient,
  queryScope,
  refreshSnapshot,
  mounts,
  unmounts,
}: {
  client: AuroraClient
  queryClient: QueryClient
  queryScope: { backend: string; profileId: string; peerId: string }
  refreshSnapshot: () => Promise<AuroraShellSnapshot>
  mounts: () => void
  unmounts: () => void
}) {
  const [snapshot, setSnapshot] = useState<AuroraShellSnapshot>(() => readyShellSnapshot({ nodeName: 'Continuity Aurora' }))
  const scopeKey = useAuroraQueryScopeKey()
  const handleLiveShellEvent = useCallback((event: AuroraEvent) => {
    setSnapshot((current) => patchShellSnapshotForEvent(current, event).snapshot)
    invalidateAuroraQueriesForShellEvent(queryClient, event, scopeKey)
    if (shouldRefreshShellSnapshot(event)) {
      void refreshSnapshot().then((nextSnapshot) => {
        setSnapshot((current) => ({
          ...current,
          serverVersion: nextSnapshot.serverVersion ?? null,
        }))
      }).catch(() => undefined)
    }
  }, [queryClient, refreshSnapshot, scopeKey])

  useAuroraLiveShellEvents({
    client,
    scopeId: scopeKey[1],
    queryScope,
    onEvent: handleLiveShellEvent,
  })

  return (
    <AppShell snapshot={snapshot} currentPath="/" runtimeMode="web" nodeMode="remote-console">
      <AssistantContinuityProbe mounts={mounts} unmounts={unmounts} />
    </AppShell>
  )
}

function AssistantContinuityProbe({ mounts, unmounts }: { mounts: () => void; unmounts: () => void }) {
  const scopeId = useAuroraStateScopeId()
  useEffect(() => {
    mounts()
    const store = useAssistantStreamStore.getState()
    store.activateScope(scopeId)
    store.begin('assistant-in-flight', { scopeId })
    store.append('partial assistant answer', { scopeId })
    return () => {
      unmounts()
    }
  }, [mounts, scopeId, unmounts])
  return <p data-testid="assistant-continuity-probe">Assistant stream stays mounted.</p>
}

class LiveShellClientDouble {
  readonly healthSubs: ControlledSubscription[] = []
  readonly configSubs: ControlledSubscription[] = []
  readonly healthOptions: unknown[] = []
  readonly configOptions: unknown[] = []
  readonly transport = { kind: 'mock', request: vi.fn() }
  readonly auth = {
    snapshot: () => ({
      state: 'authenticated',
      principalId: 'principal-continuity',
      deviceId: 'device-continuity',
      peerId: 'peer-continuity',
      credentialKind: 'test',
      source: 'test',
      tokenExpiresAt: null,
      status: 200,
      isAdmin: false,
      effectivePermissions: [],
    }),
    subscribe: () => () => undefined,
  }
  readonly events = {
    watchHealth: vi.fn((options: unknown) => {
      this.healthOptions.push(options)
      const subscription = new ControlledSubscription()
      this.healthSubs.push(subscription)
      return subscription
    }),
    watchConfig: vi.fn((options: unknown) => {
      this.configOptions.push(options)
      const subscription = new ControlledSubscription()
      this.configSubs.push(subscription)
      return subscription
    }),
  }
}

class ControlledSubscription implements AsyncIterable<AuroraEvent>, AsyncIterator<AuroraEvent> {
  readonly ready = Promise.resolve()
  readonly closed: Promise<void>
  readonly closeReasons: unknown[] = []
  private readonly queued: AuroraEvent[] = []
  private pending: { resolve: (result: IteratorResult<AuroraEvent>) => void; reject: (error: unknown) => void } | null = null
  private ended = false
  private resolveClosed: () => void = () => undefined

  constructor() {
    this.closed = new Promise<void>((resolve) => { this.resolveClosed = resolve })
  }

  [Symbol.asyncIterator](): AsyncIterator<AuroraEvent> {
    return this
  }

  next(): Promise<IteratorResult<AuroraEvent>> {
    const event = this.queued.shift()
    if (event) return Promise.resolve({ done: false, value: event })
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  push(event: AuroraEvent): void {
    if (this.ended) return
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.resolve({ done: false, value: event })
      return
    }
    this.queued.push(event)
  }

  close(reason?: unknown): void {
    this.closeReasons.push(reason)
    this.end()
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    if (this.pending) {
      const pending = this.pending
      this.pending = null
      pending.resolve({ done: true, value: undefined })
    }
    this.resolveClosed()
  }
}

function readyShellSnapshot(overrides: Partial<AuroraShellSnapshot> = {}): AuroraShellSnapshot {
  return {
    ...loadingShellSnapshot,
    loadState: 'ready',
    connectionState: 'connected',
    capabilityFreshness: 'fresh',
    nodeName: 'Continuity Aurora',
    transportKind: 'mock',
    evidenceSource: 'test snapshot',
    error: null,
    ...overrides,
  }
}

function shellEvent(id: string, kind: string, payload: Record<string, unknown> = {}): AuroraEvent {
  return {
    id,
    kind,
    topic: null,
    method: null,
    busTopic: null,
    payload,
    audit: {
      correlationId: null,
      eventKind: kind,
      peerId: null,
      principalId: null,
      targetPeerId: null,
      method: null,
      busTopic: null,
      toolId: null,
      resourceId: null,
      status: null,
      transport: 'mock',
      redaction: { secretsRedacted: true, redactedFields: [], source: 'sdk', warnings: [] },
    },
    redaction: { secretsRedacted: true, redactedFields: [], source: 'sdk', warnings: [] },
    receivedAt: new Date(0).toISOString(),
  }
}

function shellStatusText(container: HTMLElement): string {
  return container.querySelector('[aria-label="Aurora shell status"]')?.textContent ?? ''
}

function runtimeChipText(container: HTMLElement): string {
  return container.querySelector('[aria-label="Aurora version and connection state"]')?.textContent ?? ''
}

function assistantStreamState() {
  const state = useAssistantStreamStore.getState()
  return {
    activeScopeId: state.activeScopeId,
    state: state.state,
    messageId: state.messageId,
    text: state.text,
  }
}

async function flushShellEffects(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
