'use client'

import { useEffect, useState } from 'react'
import type { MeshPeerRosterSnapshot, SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot } from './web-thin-runtime'

export const THIN_PEER_DIAGNOSTICS_SAMPLE_INTERVAL_MS = 3_000

export interface ThinPeerDiagnosticsProjection {
  snapshot: BrowserWebRtcSnapshot | null
  roster: MeshPeerRosterSnapshot | null
  evidence: SelectedCandidatePairEvidence | null
  evidenceByPeer: ReadonlyMap<string, SelectedCandidatePairEvidence>
  latencyMs: number | null
}

const emptyEvidenceByPeer = new Map<string, SelectedCandidatePairEvidence>()

export function useThinPeerDiagnosticsProjection(
  thinPeer: BrowserWebRtcPeerController | undefined,
  sampleIntervalMs = THIN_PEER_DIAGNOSTICS_SAMPLE_INTERVAL_MS,
): ThinPeerDiagnosticsProjection {
  const [projection, setProjection] = useState<ThinPeerDiagnosticsProjection>(() => initialProjection(thinPeer))

  useEffect(() => {
    if (!thinPeer) {
      setProjection(emptyProjection())
      return
    }

    let disposed = false
    let measuring = false
    let activeSampleKey: string | null = null
    let rerunAfterCurrent = false
    let timeoutId: number | null = null

    const clearPendingMeasurement = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }
    }

    const publishTransportState = (
      nextSnapshot: BrowserWebRtcSnapshot,
      nextRoster = thinPeer.roster(),
    ) => {
      setProjection((current) => ({
        ...current,
        snapshot: nextSnapshot,
        roster: nextRoster,
      }))
    }

    const clearEvidence = (
      nextSnapshot = thinPeer.snapshot(),
      nextRoster = thinPeer.roster(),
    ) => {
      rerunAfterCurrent = false
      clearPendingMeasurement()
      setProjection({
        snapshot: nextSnapshot,
        roster: nextRoster,
        evidence: null,
        evidenceByPeer: emptyEvidenceByPeer,
        latencyMs: null,
      })
    }

    const requestMeasurement = () => {
      clearPendingMeasurement()
      const currentSnapshot = thinPeer.snapshot()
      const currentRoster = thinPeer.roster()
      if (disposed) return
      if (!shouldSample(currentSnapshot)) {
        clearEvidence(currentSnapshot, currentRoster)
        return
      }
      const nextSampleKey = sampleKey(currentSnapshot, currentRoster)
      if (measuring) {
        rerunAfterCurrent ||= nextSampleKey !== activeSampleKey
        return
      }
      void measure()
    }

    const scheduleMeasurement = () => {
      clearPendingMeasurement()
      const currentSnapshot = thinPeer.snapshot()
      if (disposed || !shouldSample(currentSnapshot)) return
      timeoutId = window.setTimeout(requestMeasurement, sampleIntervalMs)
    }

    const measure = async () => {
      if (disposed || measuring) return
      const currentSnapshot = thinPeer.snapshot()
      const currentRoster = thinPeer.roster()
      if (!shouldSample(currentSnapshot)) {
        clearEvidence(currentSnapshot, currentRoster)
        return
      }

      measuring = true
      activeSampleKey = sampleKey(currentSnapshot, currentRoster)
      try {
        const connectedPeerIds = currentRoster?.peers
          .filter((entry) => entry.snapshot.state === 'authorized')
          .map((entry) => entry.peerId) ?? []
        const evidenceEntries = await Promise.all(connectedPeerIds.map(async (peerId) => [
          peerId,
          await thinPeer.getSelectedCandidatePairEvidence(peerId),
        ] as const))
        const evidenceByPeer = new Map(evidenceEntries)
        const primarySnapshot = thinPeer.snapshot()
        const primaryRoster = thinPeer.roster()
        const primaryPeerId = primaryRoster?.primaryPeerId ?? primarySnapshot.expectedStablePeerId
        const evidence = primaryPeerId
          ? evidenceByPeer.get(primaryPeerId) ?? await thinPeer.getSelectedCandidatePairEvidence()
          : await thinPeer.getSelectedCandidatePairEvidence()
        const latestSnapshot = thinPeer.snapshot()
        const latestRoster = thinPeer.roster()
        if (!disposed && shouldSample(latestSnapshot) && sampleKey(latestSnapshot, latestRoster) === activeSampleKey) {
          setProjection({
            snapshot: latestSnapshot,
            roster: latestRoster,
            evidence,
            evidenceByPeer,
            latencyMs: latencyFromEvidence(evidence),
          })
        }
      } catch {
        if (!disposed) {
          const latestSnapshot = thinPeer.snapshot()
          const latestRoster = thinPeer.roster()
          if (shouldSample(latestSnapshot) && sampleKey(latestSnapshot, latestRoster) === activeSampleKey) {
            setProjection({
              snapshot: latestSnapshot,
              roster: latestRoster,
              evidence: null,
              evidenceByPeer: emptyEvidenceByPeer,
              latencyMs: null,
            })
          }
        }
      } finally {
        measuring = false
        activeSampleKey = null
        if (disposed) return
        if (rerunAfterCurrent) {
          rerunAfterCurrent = false
          requestMeasurement()
        } else {
          scheduleMeasurement()
        }
      }
    }

    const handleSnapshot = (nextSnapshot: BrowserWebRtcSnapshot) => {
      const nextRoster = thinPeer.roster()
      if (shouldSample(nextSnapshot)) {
        publishTransportState(nextSnapshot, nextRoster)
        requestMeasurement()
      } else {
        clearEvidence(nextSnapshot, nextRoster)
      }
    }

    const handleRoster = (nextRoster: MeshPeerRosterSnapshot) => {
      const nextSnapshot = thinPeer.snapshot()
      if (shouldSample(nextSnapshot)) {
        publishTransportState(nextSnapshot, nextRoster)
        requestMeasurement()
      } else {
        clearEvidence(nextSnapshot, nextRoster)
      }
    }

    const handleVisibilityChange = () => {
      requestMeasurement()
    }

    const unsubscribeSnapshot = thinPeer.subscribe(handleSnapshot)
    const unsubscribeRoster = thinPeer.subscribeRoster(handleRoster)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      disposed = true
      rerunAfterCurrent = false
      clearPendingMeasurement()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      unsubscribeRoster()
      unsubscribeSnapshot()
    }
  }, [sampleIntervalMs, thinPeer])

  return projection
}

function initialProjection(thinPeer: BrowserWebRtcPeerController | undefined): ThinPeerDiagnosticsProjection {
  if (!thinPeer) return emptyProjection()
  return {
    snapshot: thinPeer.snapshot(),
    roster: thinPeer.roster(),
    evidence: null,
    evidenceByPeer: emptyEvidenceByPeer,
    latencyMs: null,
  }
}

function emptyProjection(): ThinPeerDiagnosticsProjection {
  return {
    snapshot: null,
    roster: null,
    evidence: null,
    evidenceByPeer: emptyEvidenceByPeer,
    latencyMs: null,
  }
}

function shouldSample(snapshot: BrowserWebRtcSnapshot): boolean {
  return snapshot.status === 'authorized'
    && snapshot.state === 'authorized'
    && snapshot.visible !== false
    && document.visibilityState !== 'hidden'
}

function sampleKey(snapshot: BrowserWebRtcSnapshot, roster: MeshPeerRosterSnapshot | null): string {
  const peerIds = roster?.peers
    .filter((entry) => entry.snapshot.state === 'authorized')
    .map((entry) => entry.peerId)
    .sort()
    .join(',') ?? ''
  return [
    roster?.primaryPeerId ?? '',
    snapshot.expectedStablePeerId ?? '',
    snapshot.connectedStablePeerId ?? '',
    peerIds,
  ].join('|')
}

function latencyFromEvidence(evidence: SelectedCandidatePairEvidence | null): number | null {
  const value = evidence?.roundTripTimeMs
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}
