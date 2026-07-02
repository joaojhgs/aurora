'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  MeshDiagnosticsView,
  buildMeshDiagnosticsSnapshot,
  loadingMeshDiagnosticsSnapshot,
  type MeshDiagnosticsSnapshot,
  type SupportBundleExportState
} from './mesh-diagnostics-view'
import type { MeshDiagnosticsResourceProps } from './mesh-diagnostics-view'

export function MeshDiagnosticsResource({ client, route }: MeshDiagnosticsResourceProps) {
  const [snapshot, setSnapshot] = useState<MeshDiagnosticsSnapshot>(loadingMeshDiagnosticsSnapshot)
  const [exportState, setExportState] = useState<SupportBundleExportState>({ status: 'idle', message: null })
  const [reauthConfirmed, setReauthConfirmed] = useState(false)

  const loadDiagnostics = useCallback(async () => {
    setSnapshot(loadingMeshDiagnosticsSnapshot)
    setSnapshot(await buildMeshDiagnosticsSnapshot(client, route))
  }, [client, route])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingMeshDiagnosticsSnapshot)
    void buildMeshDiagnosticsSnapshot(client, route).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route])

  const exportSupportBundle = useCallback(async () => {
    if (!reauthConfirmed) {
      setExportState({ status: 'error', message: 'Confirm AdminAction reauthentication before exporting a support bundle.' })
      return
    }
    setExportState({ status: 'pending', message: 'Submitting Gateway.GetSupportBundle through AdminAction...' })
    try {
      const result = await client.diagnostics.exportSupportBundle({
        request: { event_limit: 10, audit_limit: 10, include_capability_catalog: true },
        reason: 'Operator requested a redacted diagnostics support bundle from the Aurora UI.',
        reauthConfirmed,
        affectedResources: ['diagnostics.support_bundle', 'diagnostics.redaction_preview', 'diagnostics.audit_receipt']
      })
      setExportState({
        status: 'success',
        message: `Exported redacted support bundle ${result.data.correlation_id ?? 'without correlation'} with audit receipt ${result.confirmation.audit_receipt}.`
      })
      setSnapshot(await buildMeshDiagnosticsSnapshot(client, route))
    } catch (error) {
      setExportState({ status: 'error', message: error instanceof Error ? error.message : 'Support-bundle export failed.' })
    }
  }, [client, route, reauthConfirmed])

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
