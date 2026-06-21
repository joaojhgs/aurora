import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Smartphone, ToggleLeft } from 'lucide-react'
import type { AvailabilityState, PrivacyClass } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type SettingsMutationState = 'idle' | 'optimistic' | 'rollback-error' | 'disabled'

export interface SettingsPrivacyControl {
  id: string
  label: string
  description: string
  state: AvailabilityState
  privacyClass: PrivacyClass
  providerLabel: string
  enabled: boolean
  disabled: boolean
  requiresAdminAction: boolean
  mutationState: SettingsMutationState
  blockers: string[]
  evidence: string[]
}

export interface SettingsNativePermissionCard {
  id: string
  label: string
  state: AvailabilityState
  granted: boolean
  capabilityEnabled: boolean
  requestEnabled: boolean
  detail: string
  blockers: string[]
  evidence: string[]
}

export interface SettingsPermissionsModel {
  loadState: AuroraShellSnapshot['loadState']
  settingsRoute: RouteAvailability | null
  nativeRoute: RouteAvailability | null
  privacyControls: SettingsPrivacyControl[]
  nativePermissions: SettingsNativePermissionCard[]
  routeDefaults: Array<{ id: string; label: string; value: string; state: AvailabilityState; detail: string }>
  adminActionLabel: string
  fallbackLabel: string
  error: string | null
}

export interface SettingsPermissionsViewProps {
  snapshot: AuroraShellSnapshot
}

export function SettingsPermissionsView({ snapshot }: SettingsPermissionsViewProps) {
  const model = buildSettingsPermissionsModel(snapshot)
  return (
    <section className="aui-settings" aria-labelledby="settings-permissions-title">
      <header className="aui-settings-header">
        <div>
          <p className="aui-kicker">Settings</p>
          <h1 id="settings-permissions-title">Settings and permissions</h1>
          <p>
            Privacy defaults, permission posture, native capability claims, and fallback behavior are rendered from
            AuroraClient capability evidence. Unsupported native or backend features stay disabled with a repair path.
          </p>
        </div>
        <div className="aui-settings-badges" aria-label="Settings evidence">
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={snapshot.nativeAvailable ? `native ${snapshot.nativePlatform}` : 'native unsupported'} />
          <EvidenceBadge label={snapshot.secretsRedacted ? 'secrets redacted' : 'redaction unknown'} />
        </div>
      </header>

      {model.error ? (
        <div className="aui-settings-alert" role="alert">
          <AlertTriangle size={17} aria-hidden />
          <span>{model.error}</span>
        </div>
      ) : null}

      <div className="aui-settings-grid">
        <section className="aui-settings-panel" aria-labelledby="privacy-defaults-title">
          <PanelTitle
            icon={<ShieldCheck size={18} aria-hidden />}
            title="Privacy defaults"
            description="Route, selector, and fallback controls remain AdminAction-gated whenever the backend marks them manage/admin-critical."
            id="privacy-defaults-title"
          />
          <div className="aui-settings-controls">
            {model.privacyControls.map((control) => (
              <PrivacyControlRow key={control.id} control={control} />
            ))}
          </div>
        </section>

        <section className="aui-settings-panel" aria-labelledby="native-permissions-title">
          <PanelTitle
            icon={<Smartphone size={18} aria-hidden />}
            title="Native permissions"
            description="Desktop, Android, and iOS claims only appear when the SDK native manifest reports them."
            id="native-permissions-title"
          />
          {model.nativePermissions.length > 0 ? (
            <div className="aui-native-list">
              {model.nativePermissions.map((permission) => (
                <NativePermissionRow key={permission.id} permission={permission} />
              ))}
            </div>
          ) : (
            <div className="aui-settings-empty">
              <EvidenceBadge label="empty" />
              <p>No native permission manifest is available for this deployment mode.</p>
            </div>
          )}
        </section>
      </div>

      <section className="aui-settings-panel" aria-labelledby="route-policy-title">
        <PanelTitle
          icon={<RefreshCw size={18} aria-hidden />}
          title="Route and fallback policy"
          description="Fallback success is shown only when route/capability evidence supports it; explicit selector failures remain hard failures."
          id="route-policy-title"
        />
        <div className="aui-route-defaults">
          {model.routeDefaults.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </div>
              <StatusBadge state={item.state} />
              <code>{item.value}</code>
            </article>
          ))}
        </div>
        <dl className="aui-settings-facts">
          <div><dt>Admin confirmation</dt><dd>{model.adminActionLabel}</dd></div>
          <div><dt>Fallback behavior</dt><dd>{model.fallbackLabel}</dd></div>
          <div><dt>Backend truth</dt><dd>{snapshot.evidenceSource}</dd></div>
        </dl>
      </section>
    </section>
  )
}

export function buildSettingsPermissionsModel(snapshot: AuroraShellSnapshot): SettingsPermissionsModel {
  const settingsRoute = routeById(snapshot, 'settings')
  const nativeRoute = routeById(snapshot, 'native')
  const availableRemote = snapshot.routes.filter((route) => route.state === 'available-remote')
  const degraded = snapshot.routes.filter((route) => route.state === 'degraded')
  const selectorRequired = snapshot.routes.filter((route) => route.selectorRequired)
  const denied = snapshot.routes.filter((route) => route.state === 'denied')
  const privacyBlocked = snapshot.routes.filter((route) => route.state === 'privacy-blocked')
  const errorText = snapshot.loadState === 'error' ? snapshot.error ?? 'AuroraClient settings evidence failed to load.' : null
  const adminRequired = Boolean(settingsRoute?.requiresAdminAction)
  const settingsDisabled = !settingsRoute || settingsRoute.disabled || snapshot.loadState !== 'ready'

  return {
    loadState: snapshot.loadState,
    settingsRoute,
    nativeRoute,
    privacyControls: [
      privacyControl({
        id: 'prefer-local',
        label: 'Prefer local processing',
        description: 'Keep service choices on the local node unless route evidence and policy allow remote use.',
        state: snapshot.loadState === 'loading' ? 'pending' : settingsRoute?.state ?? 'unsupported',
        privacyClass: 'sensitive',
        providerLabel: settingsRoute?.providerLabel ?? 'Config.Get pending',
        enabled: !settingsDisabled && availableRemote.length === 0,
        disabled: settingsDisabled,
        requiresAdminAction: adminRequired,
        blockers: settingsRoute?.blockers ?? ['settings_route_missing'],
        evidence: settingsRoute?.evidenceSources ?? []
      }),
      privacyControl({
        id: 'explicit-selector',
        label: 'Require explicit remote selectors',
        description: 'Remote peer, provider, hardware, audio, and data actions must expose target identity before execution.',
        state: selectorRequired.length > 0 ? 'privacy-blocked' : settingsRoute?.state ?? 'unsupported',
        privacyClass: 'admin-critical',
        providerLabel: `${selectorRequired.length} selector-gated routes`,
        enabled: selectorRequired.length > 0,
        disabled: settingsDisabled,
        requiresAdminAction: adminRequired,
        blockers: selectorRequired.flatMap((route) => route.blockers),
        evidence: selectorRequired.flatMap((route) => route.evidenceSources)
      }),
      privacyControl({
        id: 'block-explicit-fallback',
        label: 'Block fallback after explicit target failure',
        description: 'Explicit selector failures must not silently fall back to another peer or provider.',
        state: denied.length > 0 ? 'denied' : privacyBlocked.length > 0 ? 'privacy-blocked' : 'available-local',
        privacyClass: 'admin-critical',
        providerLabel: `${denied.length + privacyBlocked.length} hard-blocked routes`,
        enabled: true,
        disabled: settingsDisabled,
        requiresAdminAction: adminRequired,
        blockers: [...denied, ...privacyBlocked].flatMap((route) => route.blockers),
        evidence: [...denied, ...privacyBlocked].flatMap((route) => route.evidenceSources)
      })
    ],
    nativePermissions: nativePermissionCards(snapshot, nativeRoute),
    routeDefaults: [
      {
        id: 'remote-providers',
        label: 'Remote providers',
        value: String(availableRemote.length),
        state: availableRemote.length > 0 ? 'available-remote' : 'unsupported',
        detail: availableRemote.length > 0 ? 'Remote routes require visible provider identity.' : 'No selectable remote provider is reported.'
      },
      {
        id: 'degraded-fallback',
        label: 'Degraded or fallback routes',
        value: String(degraded.length),
        state: degraded.length > 0 ? 'degraded' : 'available-local',
        detail: degraded.length > 0 ? 'At least one route has reduced capability or fallback.' : 'No degraded route is reported.'
      },
      {
        id: 'denied-routes',
        label: 'Denied or privacy-blocked routes',
        value: String(denied.length + privacyBlocked.length),
        state: denied.length > 0 ? 'denied' : privacyBlocked.length > 0 ? 'privacy-blocked' : 'available-local',
        detail: denied.length + privacyBlocked.length > 0 ? 'Repair requires backend permission, selector, consent, or policy changes.' : 'No denied route is reported.'
      }
    ],
    adminActionLabel: adminRequired
      ? 'AdminAction draft, confirmation, and audit are required before settings mutations.'
      : 'No AdminAction requirement was reported for this settings route.',
    fallbackLabel: degraded.length > 0
      ? 'Fallback is visible as degraded capability evidence.'
      : 'No fallback route is currently reported by the capability graph.',
    error: errorText
  }
}

function PrivacyControlRow({ control }: { control: SettingsPrivacyControl }) {
  const icon = control.mutationState === 'rollback-error'
    ? <AlertTriangle size={18} aria-hidden />
    : control.enabled
      ? <CheckCircle2 size={18} aria-hidden />
      : <ToggleLeft size={18} aria-hidden />
  return (
    <article className="aui-settings-control" data-state={control.mutationState}>
      <div className="aui-settings-control-icon">{icon}</div>
      <div>
        <h3>{control.label}</h3>
        <p>{control.description}</p>
        <div className="aui-settings-inline">
          <StatusBadge state={control.state} />
          <PrivacyBadge privacy={control.privacyClass} />
          <EvidenceBadge label={control.providerLabel} />
        </div>
        <small>{control.blockers.length > 0 ? control.blockers.join(', ') : 'No blocker reported.'}</small>
      </div>
      <button type="button" disabled={control.disabled || control.requiresAdminAction}>
        {control.requiresAdminAction ? 'AdminAction required' : control.enabled ? 'Enabled' : 'Unavailable'}
      </button>
    </article>
  )
}

function NativePermissionRow({ permission }: { permission: SettingsNativePermissionCard }) {
  return (
    <article className="aui-native-card">
      <div className="aui-settings-control-icon">
        {permission.granted ? <CheckCircle2 size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}
      </div>
      <div>
        <h3>{permission.label}</h3>
        <p>{permission.detail}</p>
        <div className="aui-settings-inline">
          <StatusBadge state={permission.state} />
          <EvidenceBadge label={permission.capabilityEnabled ? 'capability enabled' : 'capability disabled'} />
          <EvidenceBadge label={permission.evidence.join(', ') || 'no evidence'} />
        </div>
      </div>
      <button type="button" disabled={!permission.requestEnabled}>
        {permission.requestEnabled ? 'Request permission' : permission.granted ? 'Granted' : 'Request unavailable'}
      </button>
    </article>
  )
}

function PanelTitle({
  icon,
  title,
  description,
  id
}: {
  icon: ReactNode
  title: string
  description: string
  id: string
}) {
  return (
    <header className="aui-settings-panel-title">
      <span>{icon}</span>
      <div>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
    </header>
  )
}

function privacyControl(input: Omit<SettingsPrivacyControl, 'mutationState'>): SettingsPrivacyControl {
  return {
    ...input,
    mutationState: input.disabled ? 'disabled' : input.enabled ? 'optimistic' : 'rollback-error',
    blockers: unique(input.blockers),
    evidence: unique(input.evidence)
  }
}

function nativePermissionCards(
  snapshot: AuroraShellSnapshot,
  nativeRoute: RouteAvailability | null
): SettingsNativePermissionCard[] {
  const permissionNames = new Set([
    ...snapshot.nativePermissions.map((permission) => permission.name),
    ...snapshot.nativeCapabilities.map((capability) => capability.name)
  ])
  return [...permissionNames].sort().map((name) => {
    const permission = snapshot.nativePermissions.find((candidate) => candidate.name === name)
    const capability = snapshot.nativeCapabilities.find((candidate) => candidate.name === name)
    const granted = permission?.granted ?? false
    const capabilityEnabled = capability?.enabled ?? granted
    const state: AvailabilityState = granted && capabilityEnabled
      ? 'available-local'
      : snapshot.nativeAvailable
        ? 'privacy-blocked'
        : 'unsupported'
    return {
      id: name,
      label: nativePermissionLabel(name),
      state,
      granted,
      capabilityEnabled,
      requestEnabled: false,
      detail: granted
        ? 'Native manifest reports this permission as granted.'
        : 'Permission request is disabled until a native request command is advertised by the SDK/native manifest.',
      blockers: granted ? [] : [`native permission missing: ${name}`],
      evidence: nativeRoute?.evidenceSources ?? (snapshot.nativeAvailable ? ['native-manifest'] : [])
    }
  })
}

function routeById(snapshot: AuroraShellSnapshot, id: string): RouteAvailability | null {
  return snapshot.routes.find((route) => route.item.id === id) ?? null
}

function nativePermissionLabel(name: string): string {
  return name
    .replace(/^aurora\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_.]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}
