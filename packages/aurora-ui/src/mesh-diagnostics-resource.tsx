'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  MeshDiagnosticsView,
  buildMeshDiagnosticsSnapshot,
  loadingMeshDiagnosticsSnapshot,
  type MeshDiagnosticsSnapshot
} from './mesh-diagnostics-view'
import type { MeshDiagnosticsResourceProps } from './mesh-diagnostics-view'

export function MeshDiagnosticsResource({ client, route }: MeshDiagnosticsResourceProps) {
  const [snapshot, setSnapshot] = useState<MeshDiagnosticsSnapshot>(loadingMeshDiagnosticsSnapshot)

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

  return <MeshDiagnosticsView snapshot={snapshot} route={route} onRefresh={loadDiagnostics} />
}
