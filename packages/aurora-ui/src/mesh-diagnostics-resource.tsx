'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  MeshDiagnosticsView,
  buildMeshDiagnosticsSnapshot,
  loadingMeshDiagnosticsSnapshot,
  reconcileMeshDiagnosticsWithThinPeer,
  type MeshDiagnosticsSnapshot,
  type SupportBundleExportState
} from './mesh-diagnostics-view'
import type { MeshDiagnosticsResourceProps } from './mesh-diagnostics-view'

export function MeshDiagnosticsResource({ client, route, thinPeer }: MeshDiagnosticsResourceProps) {
  const [snapshot, setSnapshot] = useState<MeshDiagnosticsSnapshot>(loadingMeshDiagnosticsSnapshot)
  const [thinPeerSnapshot, setThinPeerSnapshot] = useState(() => thinPeer?.snapshot() ?? null)
  const [exportState, setExportState] = useState<SupportBundleExportState>({ status: 'idle', message: null })
  const [reauthConfirmed, setReauthConfirmed] = useState(false)

  useEffect(() => {
    if (!thinPeer) {
      setThinPeerSnapshot(null)
      return
    }
    return thinPeer.subscribe((nextThinSnapshot) => {
      setThinPeerSnapshot(nextThinSnapshot)
      setSnapshot((current) =>
        reconcileMeshDiagnosticsWithThinPeer(
          current,
          nextThinSnapshot,
          current,
        ),
      )
    })
  }, [thinPeer])

  const loadDiagnostics = useCallback(async () => {
    const next = await buildMeshDiagnosticsSnapshot(client, route)
    setSnapshot((current) =>
      reconcileMeshDiagnosticsWithThinPeer(
        next,
        thinPeer?.snapshot() ?? thinPeerSnapshot,
        current,
      ),
    )
  }, [client, route, thinPeer, thinPeerSnapshot])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingMeshDiagnosticsSnapshot)
    void buildMeshDiagnosticsSnapshot(client, route).then((next) => {
      if (!cancelled) {
        setSnapshot((current) =>
          reconcileMeshDiagnosticsWithThinPeer(
            next,
            thinPeer?.snapshot() ?? thinPeerSnapshot,
            current,
          ),
        )
      }
    })
    return () => {
      cancelled = true
    }
  }, [client, route, thinPeer])

  const exportSupportBundle = useCallback(async () => {
    if (!reauthConfirmed) {
      setExportState({ status: 'error', message: 'Confirm recent approval before exporting support data.' })
      return
    }
    setExportState({ status: 'pending', message: 'Preparing support data...' })
    try {
      const result = await client.diagnostics.exportSupportBundle({
        request: { event_limit: 10, audit_limit: 10, include_capability_catalog: true },
        reason: 'Operator requested a redacted diagnostics support bundle from the Aurora UI.',
        reauthConfirmed,
        affectedResources: ['diagnostics.support_bundle', 'diagnostics.redaction_preview', 'diagnostics.audit_receipt']
      })
      setExportState({
        status: 'success',
        message: `Support data exported. Reference ${result.data.correlation_id ?? 'available'}; receipt ${result.confirmation.audit_receipt}.`
      })
      const next = await buildMeshDiagnosticsSnapshot(client, route)
      setSnapshot((current) =>
        reconcileMeshDiagnosticsWithThinPeer(
          next,
          thinPeer?.snapshot() ?? thinPeerSnapshot,
          current,
        ),
      )
    } catch (error) {
      setExportState({ status: 'error', message: error instanceof Error ? 'Support data export failed. Try again.' : 'Support data export failed.' })
    }
  }, [client, route, reauthConfirmed, thinPeer, thinPeerSnapshot])

  return (
    <MeshDiagnosticsView
      snapshot={snapshot}
      route={route}
      onRefresh={loadDiagnostics}
      onExportSupportBundle={exportSupportBundle}
      supportBundleExportState={exportState}
      reauthConfirmed={reauthConfirmed}
      onReauthConfirmedChange={setReauthConfirmed}
    />
  )
}
