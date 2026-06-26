import { useEffect, useMemo, useState } from 'react'
import { AppShell, RouteMatrix, StateSurface, buildShellSnapshot, loadingShellSnapshot } from '@aurora/ui'
import type { AuroraShellSnapshot } from '@aurora/ui'
import type { TauriNativeFeatureStatus, TauriNativePermissionStatus, TauriSidecarStatus } from '@aurora/client'
import { createAuroraTauriRuntime } from './aurora-client'

export function AuroraTauriApp() {
  const runtime = useMemo(() => createAuroraTauriRuntime(), [])
  const [snapshot, setSnapshot] = useState<AuroraShellSnapshot>(loadingShellSnapshot)
  const [sidecar, setSidecar] = useState<TauriSidecarStatus | null>(null)
  const [nativePermissions, setNativePermissions] = useState<TauriNativePermissionStatus | null>(null)
  const [nativeFeatures, setNativeFeatures] = useState<Record<string, TauriNativeFeatureStatus | null>>({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      const localSidecar =
        runtime.mode === 'desktop-local'
          ? await runtime.startSidecar().catch((error: unknown) => ({
              running: false,
              mode: 'desktop-local-start-failed',
              lastError: error instanceof Error ? error.message : String(error),
              details: {}
            }))
          : null
      const [nextSnapshot, nextSidecar, nextNativePermissions, tray, notifications, dialogs, audio] = await Promise.all([
        buildShellSnapshot(runtime.client),
        localSidecar ? Promise.resolve(localSidecar) : runtime.sidecarStatus().catch(() => null),
        runtime.nativePermissionStatus().catch(() => null),
        runtime.trayStatus().catch(() => null),
        runtime.notificationStatus().catch(() => null),
        runtime.dialogStatus().catch(() => null),
        runtime.audioBridgeStatus().catch(() => null)
      ])
      if (!cancelled) {
        setSnapshot(nextSnapshot)
        setSidecar(nextSidecar)
        setNativePermissions(nextNativePermissions)
        setNativeFeatures({ tray, notifications, dialogs, audio })
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
            <div><dt>Sidecar supervisor</dt><dd>{sidecar?.running ? 'running' : localMode ? 'stopped or unavailable' : 'not used in thin mode'}</dd></div>
            <div><dt>Native manifest</dt><dd>{snapshot.nativeAvailable ? snapshot.nativePlatform : 'unavailable'}</dd></div>
            <div><dt>Tray</dt><dd>{nativeFeatureLabel(nativeFeatures.tray)}</dd></div>
            <div><dt>Notifications</dt><dd>{nativeFeatureLabel(nativeFeatures.notifications)}</dd></div>
            <div><dt>Dialogs</dt><dd>{nativeFeatureLabel(nativeFeatures.dialogs)}</dd></div>
            <div><dt>Audio bridge</dt><dd>{nativeFeatureLabel(nativeFeatures.audio)}</dd></div>
            <div><dt>iOS invocation</dt><dd>Siri/Shortcuts/App Intents integration; no Siri replacement claim.</dd></div>
            <div><dt>Denied native defaults</dt><dd>{nativePermissions?.deniedByDefault.join(', ') ?? 'not available'}</dd></div>
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

function nativeFeatureLabel(feature: TauriNativeFeatureStatus | null | undefined): string {
  if (!feature) return 'not available'
  if (feature.available) return `${feature.capability} available`
  return `${feature.capability} denied by default`
}
