// @vitest-environment jsdom
import { useEffect, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshPeerRosterSnapshot, SelectedCandidatePairEvidence } from '@aurora/client/webrtc'

import {
  THIN_PEER_DIAGNOSTICS_SAMPLE_INTERVAL_MS,
  useThinPeerDiagnosticsProjection,
  type ThinPeerDiagnosticsProjection,
} from '../src/thin-peer-diagnostics'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot } from '../src/web-thin-runtime'

const roots: Root[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setDocumentVisibility('visible')
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  setDocumentVisibility('visible')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useThinPeerDiagnosticsProjection', () => {
  it('samples the primary roster peer and exposes the resulting latency', async () => {
    const peer = new FakeThinPeer({
      peerId: 'peer-a',
      evidence: evidence(42),
    })
    const projections: ThinPeerDiagnosticsProjection[] = []

    render(<DiagnosticsProbe peer={peer.controller} onProjection={(projection) => projections.push(projection)} />)
    await flushReactWork()

    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledWith('peer-a')
    const latest = lastProjection(projections)
    expect(latest.snapshot?.expectedStablePeerId).toBe('peer-a')
    expect(latest.roster?.primaryPeerId).toBe('peer-a')
    expect(latest.evidence?.roundTripTimeMs).toBe(42)
    expect(latest.evidenceByPeer.get('peer-a')?.roundTripTimeMs).toBe(42)
    expect(latest.latencyMs).toBe(42)
  })

  it('keeps one sampler active for repeated snapshot and roster notifications', async () => {
    vi.useFakeTimers()
    const firstSample = deferred<SelectedCandidatePairEvidence>()
    const peer = new FakeThinPeer({
      peerId: 'peer-a',
      evidence: firstSample.promise,
    })
    const projections: ThinPeerDiagnosticsProjection[] = []

    render(<DiagnosticsProbe peer={peer.controller} onProjection={(projection) => projections.push(projection)} />)
    await flushReactWork()

    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)
    act(() => {
      peer.emitSnapshot({ ...peer.snapshot(), updatedAt: '2026-09-16T12:01:00.000Z' })
      peer.emitRoster(rosterSnapshot('peer-a', peer.snapshot()))
    })
    await flushReactWork()
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)

    peer.setEvidence(evidence(51))
    await act(async () => {
      firstSample.resolve(evidence(50))
      await Promise.resolve()
    })
    await flushReactWork()
    expect(lastProjection(projections).latencyMs).toBe(50)

    act(() => {
      vi.advanceTimersByTime(THIN_PEER_DIAGNOSTICS_SAMPLE_INTERVAL_MS - 1)
    })
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    await flushReactWork()
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(2)
    expect(lastProjection(projections).latencyMs).toBe(51)
  })

  it('clears diagnostics when the page is hidden and resumes from fresh evidence when visible', async () => {
    vi.useFakeTimers()
    const peer = new FakeThinPeer({
      peerId: 'peer-a',
      evidence: evidence(64),
    })
    const projections: ThinPeerDiagnosticsProjection[] = []

    render(<DiagnosticsProbe peer={peer.controller} onProjection={(projection) => projections.push(projection)} />)
    await flushReactWork()
    expect(lastProjection(projections).latencyMs).toBe(64)

    act(() => {
      peer.emitSnapshot(authorizedSnapshot({ expectedStablePeerId: 'peer-a', visible: false }))
    })
    await flushReactWork()
    expect(lastProjection(projections).latencyMs).toBeNull()
    expect(lastProjection(projections).evidence).toBeNull()

    act(() => {
      vi.advanceTimersByTime(THIN_PEER_DIAGNOSTICS_SAMPLE_INTERVAL_MS)
    })
    await flushReactWork()
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)

    peer.setEvidence(evidence(72))
    act(() => {
      peer.emitSnapshot(authorizedSnapshot({ expectedStablePeerId: 'peer-a', visible: true }))
    })
    await flushReactWork()
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(2)
    expect(lastProjection(projections).latencyMs).toBe(72)
  })

  it('resumes sampling on document visibility without waiting for a peer event', async () => {
    vi.useFakeTimers()
    const peer = new FakeThinPeer({
      peerId: 'peer-a',
      evidence: evidence(28),
    })
    const projections: ThinPeerDiagnosticsProjection[] = []

    render(<DiagnosticsProbe peer={peer.controller} onProjection={(projection) => projections.push(projection)} />)
    await flushReactWork()
    expect(lastProjection(projections).latencyMs).toBe(28)

    act(() => {
      setDocumentVisibility('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flushReactWork()
    expect(lastProjection(projections).latencyMs).toBeNull()
    expect(lastProjection(projections).evidence).toBeNull()

    act(() => {
      vi.advanceTimersByTime(THIN_PEER_DIAGNOSTICS_SAMPLE_INTERVAL_MS)
    })
    await flushReactWork()
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)

    peer.setEvidence(evidence(33))
    act(() => {
      setDocumentVisibility('visible')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flushReactWork()

    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(2)
    expect(lastProjection(projections).snapshot?.expectedStablePeerId).toBe('peer-a')
    expect(lastProjection(projections).latencyMs).toBe(33)
  })

  it('ignores a deferred primary fallback result when the selected peer changes mid-measurement', async () => {
    const fallbackSample = deferred<SelectedCandidatePairEvidence>()
    const peer = new FakeThinPeer({
      peerId: 'peer-a',
      primaryPeerId: 'peer-b',
      evidence: (peerId?: string) => (peerId === 'peer-a' ? evidence(41) : fallbackSample.promise),
    })
    const projections: ThinPeerDiagnosticsProjection[] = []

    render(<DiagnosticsProbe peer={peer.controller} onProjection={(projection) => projections.push(projection)} />)
    await flushReactWork()
    expect(peer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(2)

    peer.setEvidence((peerId?: string) => (peerId === 'peer-c' ? evidence(91) : fallbackSample.promise))
    act(() => {
      const nextSnapshot = authorizedSnapshot({ expectedStablePeerId: 'peer-c', connectedStablePeerId: 'peer-c' })
      peer.emitSnapshot(nextSnapshot)
      peer.emitRoster(rosterSnapshot('peer-c', nextSnapshot))
    })
    await act(async () => {
      fallbackSample.resolve(evidence(77))
      await Promise.resolve()
    })
    await flushReactWork()

    expect(lastProjection(projections).snapshot?.expectedStablePeerId).toBe('peer-c')
    expect(lastProjection(projections).latencyMs).toBe(91)
    expect(lastProjection(projections).evidence?.roundTripTimeMs).not.toBe(77)
  })

  it('ignores late measurement results after the controller identity changes', async () => {
    const staleSample = deferred<SelectedCandidatePairEvidence>()
    const stalePeer = new FakeThinPeer({
      peerId: 'peer-a',
      evidence: staleSample.promise,
    })
    const currentPeer = new FakeThinPeer({
      peerId: 'peer-b',
      evidence: evidence(88),
    })
    const projections: ThinPeerDiagnosticsProjection[] = []
    const root = createTestRoot()

    act(() => {
      root.render(<DiagnosticsProbe peer={stalePeer.controller} onProjection={(projection) => projections.push(projection)} />)
    })
    await flushReactWork()
    expect(stalePeer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)

    act(() => {
      root.render(<DiagnosticsProbe peer={currentPeer.controller} onProjection={(projection) => projections.push(projection)} />)
    })
    await act(async () => {
      staleSample.resolve(evidence(31))
      await Promise.resolve()
    })
    await flushReactWork()

    expect(currentPeer.getSelectedCandidatePairEvidence).toHaveBeenCalledTimes(1)
    const latest = lastProjection(projections)
    expect(latest.snapshot?.expectedStablePeerId).toBe('peer-b')
    expect(latest.evidence?.roundTripTimeMs).toBe(88)
    expect(latest.latencyMs).toBe(88)
  })
})

interface DiagnosticsProbeProps {
  peer: BrowserWebRtcPeerController | undefined
  onProjection(projection: ThinPeerDiagnosticsProjection): void
}

function DiagnosticsProbe({ peer, onProjection }: DiagnosticsProbeProps): null {
  const projection = useThinPeerDiagnosticsProjection(peer)
  useEffect(() => {
    onProjection(projection)
  }, [onProjection, projection])
  return null
}

type EvidenceSource = SelectedCandidatePairEvidence | Promise<SelectedCandidatePairEvidence> | ((peerId?: string) => SelectedCandidatePairEvidence | Promise<SelectedCandidatePairEvidence>)

class FakeThinPeer {
  private currentSnapshot: BrowserWebRtcSnapshot
  private currentRoster: MeshPeerRosterSnapshot
  private currentEvidence: EvidenceSource
  private readonly snapshotListeners = new Set<(snapshot: BrowserWebRtcSnapshot) => void>()
  private readonly rosterListeners = new Set<(roster: MeshPeerRosterSnapshot) => void>()
  readonly getSelectedCandidatePairEvidence = vi.fn(async (peerId?: string) => typeof this.currentEvidence === 'function' ? this.currentEvidence(peerId) : this.currentEvidence)
  readonly controller: BrowserWebRtcPeerController

  constructor(options: { peerId: string; primaryPeerId?: string; evidence: EvidenceSource }) {
    this.currentSnapshot = authorizedSnapshot({ expectedStablePeerId: options.peerId, connectedStablePeerId: options.peerId })
    this.currentRoster = rosterSnapshot(options.primaryPeerId ?? options.peerId, this.currentSnapshot, [options.peerId])
    this.currentEvidence = options.evidence
    this.controller = {
      snapshot: () => this.snapshot(),
      roster: () => this.roster(),
      subscribe: (listener: (snapshot: BrowserWebRtcSnapshot) => void) => this.subscribe(listener),
      subscribeRoster: (listener: (roster: MeshPeerRosterSnapshot) => void) => this.subscribeRoster(listener),
      getSelectedCandidatePairEvidence: this.getSelectedCandidatePairEvidence,
    } as unknown as BrowserWebRtcPeerController
  }

  snapshot(): BrowserWebRtcSnapshot {
    return this.currentSnapshot
  }

  roster(): MeshPeerRosterSnapshot {
    return this.currentRoster
  }

  setEvidence(nextEvidence: EvidenceSource) {
    this.currentEvidence = nextEvidence
  }

  emitSnapshot(nextSnapshot: BrowserWebRtcSnapshot) {
    this.currentSnapshot = nextSnapshot
    this.currentRoster = rosterSnapshot(nextSnapshot.expectedStablePeerId ?? 'peer-a', nextSnapshot)
    for (const listener of this.snapshotListeners) listener(nextSnapshot)
  }

  emitRoster(nextRoster: MeshPeerRosterSnapshot) {
    this.currentRoster = nextRoster
    for (const listener of this.rosterListeners) listener(nextRoster)
  }

  private subscribe(listener: (snapshot: BrowserWebRtcSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    listener(this.currentSnapshot)
    return () => this.snapshotListeners.delete(listener)
  }

  private subscribeRoster(listener: (roster: MeshPeerRosterSnapshot) => void): () => void {
    this.rosterListeners.add(listener)
    listener(this.currentRoster)
    return () => this.rosterListeners.delete(listener)
  }
}

function authorizedSnapshot(partial: Partial<BrowserWebRtcSnapshot> = {}): BrowserWebRtcSnapshot {
  return {
    state: 'authorized',
    connectionMode: 'webrtc-only',
    icePathCategory: 'host',
    protocolCapabilities: [],
    reconnectCount: 0,
    pendingCallCount: 0,
    pendingStreamCount: 0,
    pendingSubscriptionCount: 0,
    pendingFragmentCount: 0,
    bufferPressureHighWaterBytes: 0,
    sentFragmentCount: 0,
    receivedFragmentCount: 0,
    updatedAt: '2026-09-16T12:00:00.000Z',
    status: 'authorized',
    secureContext: true,
    visible: true,
    focused: true,
    hasHttpFallback: false,
    secretsPersisted: true,
    ...partial,
  }
}

function rosterSnapshot(
  primaryPeerId: string,
  snapshot: BrowserWebRtcSnapshot,
  peerIds: readonly string[] = [primaryPeerId],
): MeshPeerRosterSnapshot {
  return {
    primaryPeerId,
    peers: peerIds.map((peerId) => ({
      peerId,
      primary: peerId === primaryPeerId,
      nodeName: 'Home device',
      snapshot: peerId === (snapshot.expectedStablePeerId ?? primaryPeerId)
        ? snapshot
        : authorizedSnapshot({ expectedStablePeerId: peerId, connectedStablePeerId: peerId }),
    })),
    discovered: [],
    updatedAt: snapshot.updatedAt,
  }
}

function evidence(roundTripTimeMs: number): SelectedCandidatePairEvidence {
  return {
    selected: true,
    category: 'host',
    roundTripTimeMs,
    statsSource: 'RTCPeerConnection.getStats',
    rawAddressRedacted: true,
  }
}

function render(element: ReactElement): HTMLElement {
  const root = createTestRoot()
  act(() => {
    root.render(element)
  })
  return document.body
}

function createTestRoot(): Root {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  return root
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function lastProjection(projections: readonly ThinPeerDiagnosticsProjection[]): ThinPeerDiagnosticsProjection {
  const projection = projections.at(-1)
  if (!projection) throw new Error('No diagnostics projection was published')
  return projection
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function setDocumentVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  })
}
