import { useEffect, useMemo, useState } from 'react'
import { AppShell, RouteMatrix, StateSurface, buildShellSnapshot, loadingShellSnapshot } from '@aurora/ui'
import type { AuroraShellSnapshot } from '@aurora/ui'
import type { TauriSidecarStatus } from '@aurora/client'
import { createAuroraTauriRuntime } from './aurora-client'

export function AuroraTauriApp() {
  const runtime = useMemo(() => createAuroraTauriRuntime(), [])
  const [snapshot, setSnapshot] = useState<AuroraShellSnapshot>(loadingShellSnapshot)
  const [sidecar, setSidecar] = useState<TauriSidecarStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [nextSnapshot, nextSidecar] = await Promise.all([
        buildShellSnapshot(runtime.client),
        runtime.sidecarStatus().catch(() => null)
      ])
      if (!cancelled) {
        setSnapshot(nextSnapshot)
        setSidecar(nextSidecar)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [runtime])

  const localMode = runtime.mode === 'desktop-local'
  const sidecarEvidence = sidecar
    ? `${sidecar.mode ?? 'unknown'}; gateway=${sidecar.gatewayUrl ?? 'not configured'}; running=${String(sidecar.running)}`
    : 'native sidecar status unavailable in this runtime'

  return (
    <AppShell snapshot={snapshot}>
      <div className="ata-page-stack">
        <StateSurface
          title={localMode ? 'Desktop local shell' : 'Desktop thin shell'}
          state={snapshot.loadState === 'error' ? 'denied' : sidecar?.running ? 'available-local' : localMode ? 'pending' : 'available-remote'}
          description="Aurora desktop uses the official Tauri shell while keeping service truth behind AuroraClient."
          evidence={sidecarEvidence}
          actionLabel={sidecar?.lastError ?? null}
        />
        <section className="ata-panel">
          <h2>Native boundary</h2>
          <dl className="ata-facts">
            <div><dt>Runtime mode</dt><dd>{runtime.mode}</dd></div>
            <div><dt>SDK transport</dt><dd>{snapshot.transportKind}</dd></div>
            <div><dt>Sidecar supervisor</dt><dd>{sidecar?.running ? 'running' : 'not started by TAURI-001'}</dd></div>
            <div><dt>Native manifest</dt><dd>{snapshot.nativeAvailable ? snapshot.nativePlatform : 'unavailable'}</dd></div>
          </dl>
          <button className="ata-secondary" type="button" onClick={() => void runtime.shutdown()}>
            Shut down shell
          </button>
        </section>
        <RouteMatrix routes={snapshot.routes} />
      </div>
    </AppShell>
  )
}
