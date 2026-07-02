import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AppShell,
  AssistantView,
  MemoryView,
  MeshPeersResource,
  ModelsView,
  OnboardingView,
  RouteMatrix,
  SettingsPermissionsView,
  StateSurface,
  ToolApprovalPanel,
  auroraNavSections,
  buildShellSnapshot,
  loadingShellSnapshot,
  navItemSnapshot,
  type AuroraNavItem,
  type AuroraShellSnapshot,
  type RouteAvailability
} from '@aurora/ui'
import type {
  AndroidLocalLightInferenceStatus,
  TauriAndroidBaselineStatus,
  TauriIosInvocationStatus,
  TauriNativeFeatureStatus,
  TauriNativePermissionStatus,
  TauriSidecarStatus
} from '@aurora/client'
import { createAuroraTauriRuntime } from './aurora-client'

const navItems = auroraNavSections.flatMap((section) => section.items)

export function AuroraTauriApp() {
  const runtime = useMemo(() => createAuroraTauriRuntime(), [])
  const [snapshot, setSnapshot] = useState<AuroraShellSnapshot>(loadingShellSnapshot)
  const [currentPath, setCurrentPath] = useState(() => currentBrowserPath())
  const [sidecar, setSidecar] = useState<TauriSidecarStatus | null>(null)
  const [nativePermissions, setNativePermissions] = useState<TauriNativePermissionStatus | null>(null)
  const [nativeFeatures, setNativeFeatures] = useState<Record<string, TauriNativeFeatureStatus | null>>({})
  const [iosInvocationStatus, setIosInvocationStatus] = useState<TauriIosInvocationStatus | null>(null)
  const [iosLocalLightStatus, setIosLocalLightStatus] = useState<AndroidLocalLightInferenceStatus | null>(null)
  const [androidBaseline, setAndroidBaseline] = useState<TauriAndroidBaselineStatus | null>(null)

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
      const [
        nextSnapshot,
        nextSidecar,
        nextNativePermissions,
        tray,
        notifications,
        iosVoice,
        iosInvocation,
        iosLocalLight,
        iosBackground,
        dialogs,
        audio,
        iosKeychain,
        iosBiometrics,
        android
      ] = await Promise.all([
        buildShellSnapshot(runtime.client),
        localSidecar ? Promise.resolve(localSidecar) : runtime.sidecarStatus().catch(() => null),
        runtime.nativePermissionStatus().catch(() => null),
        runtime.trayStatus().catch(() => null),
        runtime.notificationStatus().catch(() => null),
        runtime.iosVoiceStatus().catch(() => null),
        runtime.iosInvocationStatus().catch(() => null),
        runtime.iosLocalLightInferenceStatus().catch(() => null),
        runtime.iosBackgroundStatus().catch(() => null),
        runtime.dialogStatus().catch(() => null),
        runtime.audioBridgeStatus().catch(() => null),
        runtime.iosSecureStorageStatus().catch(() => null),
        runtime.iosBiometricStatus().catch(() => null),
        runtime.androidBaselineStatus().catch(() => null)
      ])
      if (!cancelled) {
        setSnapshot(nextSnapshot)
        setSidecar(nextSidecar)
        setNativePermissions(nextNativePermissions)
        setNativeFeatures({ tray, notifications, iosVoice, iosBackground, dialogs, audio, iosKeychain, iosBiometrics })
        setIosInvocationStatus(iosInvocation)
        setIosLocalLightStatus(iosLocalLight)
        setAndroidBaseline(android)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [runtime])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPopState = () => setCurrentPath(currentBrowserPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((href: string) => {
    const nextPath = normalizePath(href)
    setCurrentPath(nextPath)
    if (typeof window !== 'undefined' && normalizePath(window.location.pathname) !== nextPath) {
      window.history.pushState({}, '', nextPath)
    }
  }, [])

  const localMode = runtime.mode === 'desktop-local'
  const sidecarEvidence = sidecar
    ? `${sidecar.mode ?? 'unknown'}; gateway=${sidecar.gatewayUrl ?? 'not configured'}; running=${String(sidecar.running)}`
    : 'native sidecar status unavailable in this runtime'
  const nativeContext: NativeContext = {
    runtimeMode: runtime.mode,
    localMode,
    sidecar,
    sidecarEvidence,
    nativePermissions,
    nativeFeatures,
    iosInvocationStatus,
    iosLocalLightStatus,
    androidBaseline
  }

  return (
    <AppShell snapshot={snapshot} currentPath={currentPath} onNavigate={navigate}>
      <TauriRouteContent
        path={currentPath}
        snapshot={snapshot}
        nativeContext={nativeContext}
        client={runtime.client}
        shutdown={runtime.shutdown}
      />
    </AppShell>
  )
}

interface NativeContext {
  runtimeMode: string
  localMode: boolean
  sidecar: TauriSidecarStatus | null
  sidecarEvidence: string
  nativePermissions: TauriNativePermissionStatus | null
  nativeFeatures: Record<string, TauriNativeFeatureStatus | null>
  iosInvocationStatus: TauriIosInvocationStatus | null
  iosLocalLightStatus: AndroidLocalLightInferenceStatus | null
  androidBaseline: TauriAndroidBaselineStatus | null
}

function TauriRouteContent({
  path,
  snapshot,
  nativeContext,
  client,
  shutdown
}: {
  path: string
  snapshot: AuroraShellSnapshot
  nativeContext: NativeContext
  client: ReturnType<typeof createAuroraTauriRuntime>['client']
  shutdown: () => Promise<void>
}) {
  const route = routeForPath(snapshot, path)
  const assistantNativePermissions = useMemo(
    () => snapshot.nativePermissions.map((permission) => ({ name: permission.name, granted: permission.granted })),
    [snapshot.nativePermissions]
  )
  const assistantNativeCapabilities = useMemo(
    () => snapshot.nativeCapabilities.map((capability) => ({ name: capability.name, enabled: capability.enabled })),
    [snapshot.nativeCapabilities]
  )
  switch (route.item.id) {
    case 'assistant':
      return (
        <AssistantView
          client={client}
          route={route}
          cancellationRoute={snapshot.assistantCancellationRoute ?? undefined}
          voiceRoutes={snapshot.assistantVoiceRoutes}
          nativePlatform={snapshot.nativePlatform}
          nativeAvailable={snapshot.nativeAvailable}
          nativePermissions={assistantNativePermissions}
          nativeCapabilities={assistantNativeCapabilities}
        />
      )
    case 'models':
      return <ModelsView client={client} />
    case 'memory':
    case 'data':
      return <MemoryView client={client} route={route} />
    case 'tools':
      return <ToolApprovalPanel client={client} route={route} />
    case 'mesh':
      return <MeshPeersResource client={client} route={route} />
    case 'settings':
    case 'native':
      return <SettingsPermissionsView snapshot={snapshot} />
    case 'onboarding':
      return <OnboardingView client={client} snapshot={snapshot} />
    case 'diagnostics':
      return <TauriDiagnosticsPage snapshot={snapshot} nativeContext={nativeContext} shutdown={shutdown} />
    default:
      return <TauriRoutePlaceholder route={route} snapshot={snapshot} />
  }
}

function TauriDiagnosticsPage({
  snapshot,
  nativeContext,
  shutdown
}: {
  snapshot: AuroraShellSnapshot
  nativeContext: NativeContext
  shutdown: () => Promise<void>
}) {
  return (
    <div className="ata-page-stack">
      <StateSurface
        title={nativeContext.localMode ? 'Desktop local shell' : 'Desktop thin shell'}
        state={snapshot.loadState === 'error' ? 'denied' : nativeContext.sidecar?.running ? 'available-local' : nativeContext.localMode ? 'pending' : 'available-remote'}
        description="Aurora desktop uses the official Tauri shell while keeping service truth behind AuroraClient."
        evidence={nativeContext.sidecarEvidence}
        actionLabel={nativeContext.sidecar?.lastError ?? null}
      />
      <section className="ata-panel">
        <h2>Native boundary</h2>
        <dl className="ata-facts">
          <div><dt>Runtime mode</dt><dd>{runtimeModeLabel(nativeContext.runtimeMode)}</dd></div>
          <div><dt>SDK transport</dt><dd>{transportKindLabel(snapshot.transportKind)}</dd></div>
          <div><dt>Sidecar supervisor</dt><dd>{nativeContext.sidecar?.running ? 'running' : nativeContext.localMode ? 'stopped or unavailable' : 'not used in thin mode'}</dd></div>
          <div><dt>Native manifest</dt><dd>{snapshot.nativeAvailable ? snapshot.nativePlatform : 'unavailable'}</dd></div>
          <div><dt>Tray</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.tray)}</dd></div>
          <div><dt>Notifications</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.notifications)}</dd></div>
          <div><dt>iOS microphone capture</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.iosVoice)}</dd></div>
          <div><dt>iOS background voice</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.iosBackground)}</dd></div>
          <div><dt>Dialogs</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.dialogs)}</dd></div>
          <div><dt>Audio bridge</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.audio)}</dd></div>
          <div><dt>iOS Keychain</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.iosKeychain)}</dd></div>
          <div><dt>Face ID / Touch ID</dt><dd>{nativeFeatureLabel(nativeContext.nativeFeatures.iosBiometrics)}</dd></div>
          <div><dt>iOS invocation</dt><dd>{iosInvocationLabel(nativeContext.iosInvocationStatus)}</dd></div>
          <div><dt>iOS local-light inference</dt><dd>{localLightInferenceLabel(nativeContext.iosLocalLightStatus)}</dd></div>
          <div><dt>Android baseline</dt><dd>{androidBaselineLabel(nativeContext.androidBaseline)}</dd></div>
          <div><dt>Assistant role probe</dt><dd>{assistantRoleProbeLabel(nativeContext.androidBaseline)}</dd></div>
          <div><dt>Denied native defaults</dt><dd>{nativeContext.nativePermissions?.deniedByDefault.join(', ') ?? 'not available'}</dd></div>
        </dl>
        <button className="ata-secondary" type="button" onClick={() => void shutdown()}>
          Shut down shell
        </button>
      </section>
      <RouteMatrix routes={snapshot.routes} />
    </div>
  )
}

function TauriRoutePlaceholder({ route, snapshot }: { route: RouteAvailability; snapshot: AuroraShellSnapshot }) {
  return (
    <div className="ata-page-stack">
      <StateSurface
        title={route.item.label}
        state={route.state}
        description={route.explanation}
        evidence={`${route.providerLabel}; blockers=${route.blockers.join(', ') || 'none'}`}
        actionLabel={route.requiresAdminAction ? 'AdminAction required' : route.disabled ? 'Capability unavailable' : null}
      />
      <section className="ata-panel ata-placeholder-panel">
        <h2>{route.item.label} route</h2>
        <p>
          This Tauri route is now navigable. A full product page still needs to be mounted for this feature; the shell
          keeps backend capability evidence visible instead of rendering the assistant diagnostics on the wrong page.
        </p>
        <dl className="ata-facts">
          <div><dt>Expected task</dt><dd>{route.item.expectedTask}</dd></div>
          <div><dt>Privacy class</dt><dd>{route.item.privacyClass}</dd></div>
          <div><dt>Routeable</dt><dd>{route.routeable ? 'yes' : 'no'}</dd></div>
          <div><dt>Snapshot</dt><dd>{snapshot.evidenceSource}</dd></div>
        </dl>
      </section>
    </div>
  )
}

function routeForPath(snapshot: AuroraShellSnapshot, path: string): RouteAvailability {
  const normalized = normalizePath(path)
  const item = itemForPath(normalized) ?? navItems[0]!
  return snapshot.routes.find((route) => route.item.id === item.id) ?? fallbackRoute(item)
}

function itemForPath(path: string): AuroraNavItem | undefined {
  const normalized = normalizePath(path)
  return navItems.find((item) => normalizePath(item.href) === normalized)
}

function fallbackRoute(item: AuroraNavItem): RouteAvailability {
  return {
    item: navItemSnapshot(item),
    state: item.fallbackState,
    explanation: 'Capability state is loading from AuroraClient.',
    providerLabel: 'pending backend evidence',
    blockers: ['loading'],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['pending SDK request'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: item.methodType === 'manage'
  }
}

function currentBrowserPath(): string {
  if (typeof window === 'undefined') return '/'
  return normalizePath(window.location.pathname)
}

function normalizePath(path: string): string {
  if (!path || path === '') return '/'
  const withoutHash = path.split('#')[0] || '/'
  return withoutHash.endsWith('/') && withoutHash !== '/' ? withoutHash.slice(0, -1) : withoutHash
}

function runtimeModeLabel(mode: string): string {
  if (mode === 'mock') return 'mock (degraded development fixture only)'
  if (mode === 'desktop-local') return 'desktop-local (real local Tauri sidecar stack)'
  if (mode === 'desktop-thin') return 'desktop-thin (Gateway-backed, no local sidecar)'
  return mode
}

function transportKindLabel(kind: string): string {
  if (kind === 'mock') return 'mock (SDK fixture transport; development fallback only)'
  if (kind === 'tauri-local') return 'tauri-local (Tauri command bridge)'
  if (kind === 'http') return 'http (Aurora Gateway transport)'
  return kind
}

function nativeFeatureLabel(feature: TauriNativeFeatureStatus | null | undefined): string {
  if (!feature) return 'not available'
  if (feature.available) return `${feature.capability} available`
  return `${feature.capability} denied by default`
}

function iosInvocationLabel(status: TauriIosInvocationStatus | null | undefined): string {
  if (!status) return 'Siri/Shortcuts/App Intents integration; no system assistant role claim.'
  const state = status.available ? status.surface : 'not available'
  return `${state}; no system assistant role claim.`
}

function localLightInferenceLabel(status: AndroidLocalLightInferenceStatus | null | undefined): string {
  if (!status) return 'local-light inference provider pending native evidence.'
  return `${status.platform} ${status.providerId} ${status.state}; backend model catalog required=${String(status.backendModelCatalogRequired)}`
}

function androidBaselineLabel(status: TauriAndroidBaselineStatus | null): string {
  if (!status) return 'not available'
  return `${status.feature} ${status.state}; platform=${status.platform}`
}

function assistantRoleProbeLabel(status: TauriAndroidBaselineStatus | null): string {
  if (!status) return 'not available'
  return status.assistantRole.probeImplemented
    ? 'native probe implemented'
    : `probe deferred; role availability unknown; ${status.assistantRole.reason}`
}
