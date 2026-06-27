import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck, Smartphone, ToggleLeft } from 'lucide-react'
import type {
  AndroidAssistantRoleStatus,
  AndroidFallbackEntrypoint,
  AndroidNativeEntrypoint,
  AvailabilityState,
  NativeDeviceMatrixRow,
  NativeMobileIntegration,
  NativePlatformIntegration,
  NativeReleaseGate,
  PrivacyClass
} from '@aurora/client'
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

export interface SettingsNativeIntegrationCard {
  id: string
  label: string
  state: AvailabilityState
  support: NativeMobileIntegration['support']
  capability: string
  permission: string | null
  privacyClass: PrivacyClass
  invocation: string | null
  backendMethod: string | null
  requiresConfirmation: boolean
  siriReplacement: false
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
  nativeIntegrations: SettingsNativeIntegrationCard[]
  nativeLimitations: Array<{ id: string; label: string; detail: string; evidence: string }>
  routeDefaults: Array<{ id: string; label: string; value: string; state: AvailabilityState; detail: string }>
  nativePlatformIntegrations: NativePlatformIntegration[]
  nativeReleaseGates: NativeReleaseGate[]
  nativeDeviceMatrix: NativeDeviceMatrixRow[]
  nativePolicyNotes: string[]
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
            description="Desktop, Android, and iOS claims only appear when the SDK native manifest reports them; iOS is limited to Siri/Shortcuts/App Intents integration and app-owned surfaces."
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
          {model.nativeIntegrations.length > 0 ? (
            <div className="aui-native-list" aria-label="Native integrations">
              {model.nativeIntegrations.map((integration) => (
                <NativeIntegrationRow key={integration.id} integration={integration} />
              ))}
            </div>
          ) : null}
          {model.nativeLimitations.length > 0 ? (
            <dl className="aui-settings-facts">
              {model.nativeLimitations.map((limitation) => (
                <div key={limitation.id}>
                  <dt>{limitation.label}</dt>
                  <dd>{limitation.detail} Evidence: {limitation.evidence}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </section>
      </div>

      <section className="aui-settings-panel" aria-labelledby="ios-integration-title">
        <PanelTitle
          icon={<Smartphone size={18} aria-hidden />}
          title="Siri/Shortcuts/App Intents integration"
          description="iOS uses app-owned invocation surfaces. It is not advertised as the system Siri assistant."
          id="ios-integration-title"
        />
        {model.nativePlatformIntegrations.length > 0 || model.nativeReleaseGates.length > 0 ? (
          <div className="aui-route-defaults">
            {model.nativePlatformIntegrations.map((integration) => (
              <article key={integration.id}>
                <div>
                  <strong>{integration.label}</strong>
                  <span>{integration.detail}</span>
                </div>
                <StatusBadge state={integrationStatusState(integration.status)} />
                <code>{integration.evidence.join(', ') || 'native manifest'}</code>
              </article>
            ))}
            {model.nativeReleaseGates.map((gate) => (
              <article key={gate.id}>
                <div>
                  <strong>{gate.label}</strong>
                  <span>{gate.detail}</span>
                </div>
                <StatusBadge state={releaseGateState(gate.status)} />
                <code>{gate.command ?? gate.requiredEvidence}</code>
              </article>
            ))}
          </div>
        ) : (
          <div className="aui-settings-empty">
            <EvidenceBadge label="native-manifest" />
            <p>No iOS integration or release-gate manifest is available for this deployment mode.</p>
          </div>
        )}
        {model.nativePolicyNotes.length > 0 ? (
          <ul className="aui-provider-list" aria-label="iOS policy notes">
            {model.nativePolicyNotes.map((note) => <li key={note}><span>{note}</span></li>)}
          </ul>
        ) : null}
        {model.nativeDeviceMatrix.length > 0 ? (
          <dl className="aui-settings-facts">
            {model.nativeDeviceMatrix.map((row) => (
              <div key={row.id}>
                <dt>{row.target}</dt>
                <dd>{row.status}: {row.evidence}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </section>

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
    nativeIntegrations: nativeIntegrationCards(snapshot),
    nativeLimitations: (snapshot.nativePlatformLimitations ?? []).map((limitation) => ({
      id: limitation.id,
      label: limitation.label,
      detail: limitation.userCopy,
      evidence: limitation.evidenceSource
    })),
    nativePlatformIntegrations: snapshot.nativePlatformIntegrations,
    nativeReleaseGates: snapshot.nativeReleaseGates,
    nativeDeviceMatrix: snapshot.nativeDeviceMatrix,
    nativePolicyNotes: snapshot.nativePolicyNotes,
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

function NativeIntegrationRow({ integration }: { integration: SettingsNativeIntegrationCard }) {
  return (
    <article className="aui-native-card">
      <div className="aui-settings-control-icon">
        {integration.state === 'unsupported' ? <AlertTriangle size={18} aria-hidden /> : <CheckCircle2 size={18} aria-hidden />}
      </div>
      <div>
        <h3>{integration.label}</h3>
        <p>{integration.detail}</p>
        <div className="aui-settings-inline">
          <StatusBadge state={integration.state} />
          <PrivacyBadge privacy={integration.privacyClass} />
          <EvidenceBadge label={integration.support} />
          {integration.invocation ? <EvidenceBadge label={integration.invocation} /> : null}
          {integration.requiresConfirmation ? <EvidenceBadge label="confirmation required" /> : null}
        </div>
        <small>{integration.blockers.length > 0 ? integration.blockers.join(', ') : 'No blocker reported.'}</small>
        <dl className="aui-settings-facts">
          <div><dt>Backend method</dt><dd>{integration.backendMethod ?? 'backend evidence required'}</dd></div>
          <div><dt>Permission</dt><dd>{integration.permission ?? 'none'}</dd></div>
          <div><dt>System assistant role</dt><dd>{integration.siriReplacement ? 'claimed' : 'false'}</dd></div>
        </dl>
      </div>
      <button type="button" disabled>
        {integration.state === 'unsupported' ? 'Unsupported' : 'Requires native verification'}
      </button>
    </article>
  )
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
        <small>{permission.blockers.length > 0 ? permission.blockers.join(', ') : 'No blocker reported.'}</small>
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
  const genericRows = [...permissionNames].sort().map((name) => {
    const permission = snapshot.nativePermissions.find((candidate) => candidate.name === name)
    const capability = snapshot.nativeCapabilities.find((candidate) => candidate.name === name)
    const granted = permission?.granted ?? false
    const capabilityEnabled = capability?.enabled ?? granted
    const nativeState = capability?.nativeState ?? permission?.nativeState ?? null
    const state = isUnsupportedIosSurface(name)
      ? 'unsupported'
      : availabilityFromNativeState(nativeState, granted, capabilityEnabled, snapshot.nativeAvailable)
    const requestEnabled = !granted && nativeRequestAvailable(name, snapshot)
    return {
      id: name,
      label: nativePermissionLabel(name),
      state,
      granted,
      capabilityEnabled,
      requestEnabled,
      detail: nativePermissionDetail(name, granted, capabilityEnabled, requestEnabled, nativeState),
      blockers: nativePermissionBlockers(name, granted, state, nativeState),
      evidence: nativeRoute?.evidenceSources ?? (snapshot.nativeAvailable ? ['native-manifest'] : [])
    }
  })
  const androidRows = androidNativePermissionCards(snapshot)
  const androidIds = new Set(androidRows.map((row) => row.id))
  return [...genericRows.filter((row) => !androidIds.has(row.id)), ...androidRows]
}

function availabilityFromNativeIntegration(support: NativeMobileIntegration['support']): AvailabilityState {
  if (support === 'supported') return 'available-local'
  if (support === 'supported-path') return 'degraded'
  if (support === 'planned') return 'pending'
  if (support === 'blocked') return 'privacy-blocked'
  return 'unsupported'
}

function nativeIntegrationCards(snapshot: AuroraShellSnapshot): SettingsNativeIntegrationCard[] {
  return snapshot.nativeMobileIntegrations
    .filter((integration) => {
      if (integration.platform === snapshot.nativePlatform) {
        return true
      }
      return snapshot.nativePlatform === 'tauri-desktop' && integration.platform === 'ios'
    })
    .map((integration) => {
      const state = availabilityFromNativeIntegration(integration.support)
      const blockers = [
        state === 'unsupported' ? integration.userCopy : '',
        integration.permission && snapshot.nativePermissions.some((permission) =>
          permission.name === integration.permission && !permission.granted
        )
          ? `native permission missing: ${integration.permission}`
          : ''
      ].filter(Boolean)
      return {
        id: integration.id,
        label: integration.label,
        state,
        support: integration.support,
        capability: integration.capability,
        permission: integration.permission,
        privacyClass: integration.privacyClass,
        invocation: integration.invocation ?? null,
        backendMethod: integration.backendMethod ?? null,
        requiresConfirmation: integration.requiresConfirmation ?? false,
        siriReplacement: false,
        detail: integration.userCopy,
        blockers,
        evidence: unique([integration.evidenceSource, integration.verifier])
      }
    })
}

function isSiriReplacementPermission(name: string): boolean {
  return name === 'aurora.iosSiriReplacement' || name === 'ios.siriReplacement'
}

function isUnsupportedIosSurface(name: string): boolean {
  return isSiriReplacementPermission(name) ||
    name === 'aurora.iosBackgroundAudio' ||
    name === 'ios.backgroundVoice'
}

function nativePermissionBlockers(
  name: string,
  granted: boolean,
  state: AvailabilityState,
  nativeState: string | null
): string[] {
  if (granted || nativeState === 'fallback') return []
  if (isSiriReplacementPermission(name)) return ['ios_siri_replacement_unavailable']
  if (name === 'aurora.iosBackgroundAudio' || name === 'ios.backgroundVoice') {
    return ['ios_background_voice_limited']
  }
  if (state === 'unsupported') return []
  return [`native permission missing: ${name}`]
}

function nativeRequestAvailable(name: string, snapshot: AuroraShellSnapshot): boolean {
  if (snapshot.nativePlatform !== 'android' || !snapshot.nativeAvailable) return false
  const normalized = name.toLowerCase()
  const requestNames = new Set([
    ...snapshot.nativePermissions.filter((permission) => permission.granted).map((permission) => permission.name.toLowerCase()),
    ...snapshot.nativeCapabilities.filter((capability) => capability.enabled).map((capability) => capability.name.toLowerCase())
  ])
  if (normalized.includes('assistantrole')) {
    return requestNames.has('aurora.android.assistantrolerequest') ||
      requestNames.has('android.assistantrole.request')
  }
  if (normalized.includes('microphone') || normalized.includes('audiocapture')) {
    return requestNames.has('aurora.android.microphonerequest') ||
      requestNames.has('android.microphonepermissionrequest')
  }
  if (normalized.includes('notification')) {
    return requestNames.has('aurora.android.notificationsrequest') ||
      requestNames.has('android.notificationpermissionrequest')
  }
  if (normalized.includes('voiceforeground') || normalized.includes('foregroundservice')) {
    return requestNames.has('aurora.android.voiceforegroundstart') ||
      requestNames.has('android.voiceforegroundservice.start')
  }
  return false
}

function availabilityFromNativeState(
  nativeState: string | null,
  granted: boolean,
  capabilityEnabled: boolean,
  nativeAvailable: boolean
): AvailabilityState {
  if (!nativeAvailable || nativeState === 'unsupported_platform') return 'unsupported'
  if (nativeState === 'available') return granted && capabilityEnabled ? 'available-local' : 'privacy-blocked'
  if (nativeState === 'needs_native_permission') return 'privacy-blocked'
  if (nativeState === 'degraded' || nativeState === 'fallback') return 'degraded'
  return granted && capabilityEnabled ? 'available-local' : 'privacy-blocked'
}

function routeById(snapshot: AuroraShellSnapshot, id: string): RouteAvailability | null {
  return snapshot.routes.find((route) => route.item.id === id) ?? null
}

function androidNativePermissionCards(snapshot: AuroraShellSnapshot): SettingsNativePermissionCard[] {
  const rows: SettingsNativePermissionCard[] = []
  const assistant = snapshot.nativeAssistantRole
  if (assistant) {
    rows.push({
      id: 'android.assistantRole',
      label: 'Android assistant role',
      state: androidAssistantRoleAvailability(assistant),
      granted: assistant.roleHeld,
      capabilityEnabled: assistant.roleAvailable && assistant.packageQualified && !assistant.denied && !assistant.oemUnavailable,
      requestEnabled: assistant.requestable && !assistant.roleHeld && !assistant.denied,
      detail: assistant.reason,
      blockers: androidAssistantRoleBlockers(assistant),
      evidence: androidAssistantRoleEvidence(assistant)
    })
  }

  for (const entrypoint of snapshot.nativeFallbackEntrypoints) {
    rows.push({
      id: `android.fallback.${entrypoint.id}`,
      label: `Android ${nativePermissionLabel(entrypoint.id)}`,
      state: androidNativeStateToAvailability(entrypoint.state, entrypoint.available),
      granted: entrypoint.available,
      capabilityEnabled: entrypoint.available,
      requestEnabled: false,
      detail: entrypoint.reason,
      blockers: entrypoint.available ? [] : [`android fallback unavailable: ${entrypoint.id}`],
      evidence: androidFallbackEntrypointEvidence(entrypoint)
    })
  }

  for (const entrypoint of snapshot.nativeEntrypoints) {
    if (!('intentAction' in entrypoint)) continue
    rows.push({
      id: `android.entrypoint.${entrypoint.id}`,
      label: entrypoint.label,
      state: androidNativeStateToAvailability(entrypoint.state, entrypoint.available),
      granted: entrypoint.available,
      capabilityEnabled: entrypoint.available,
      requestEnabled: false,
      detail: entrypoint.reason,
      blockers: entrypoint.available ? [] : [`android entrypoint unavailable: ${entrypoint.id}`],
      evidence: androidNativeEntrypointEvidence(entrypoint)
    })
  }

  return rows
}

function androidNativeStateToAvailability(state: string, available: boolean): AvailabilityState {
  if (state === 'available') return 'available-local'
  if (state === 'needs_native_permission') return 'privacy-blocked'
  if (state === 'unsupported_platform') return 'unsupported'
  if (state === 'degraded') return 'degraded'
  if (state === 'fallback') return 'degraded'
  return available ? 'available-local' : 'unsupported'
}

function androidAssistantRoleAvailability(assistant: AndroidAssistantRoleStatus): AvailabilityState {
  if (assistant.denied) return 'denied'
  if (!assistant.roleAvailable || assistant.oemUnavailable) {
    return assistant.fallbackAvailable ? 'degraded' : 'unsupported'
  }
  if (!assistant.packageQualified) return assistant.fallbackAvailable ? 'degraded' : 'unsupported'
  if (assistant.roleHeld) return 'available-local'
  if (assistant.requestable) return 'privacy-blocked'
  return assistant.fallbackAvailable ? 'degraded' : 'unsupported'
}

function androidAssistantRoleBlockers(assistant: AndroidAssistantRoleStatus): string[] {
  return [
    !assistant.roleAvailable || assistant.oemUnavailable ? 'assistant_role_oem_unavailable' : '',
    !assistant.packageQualified ? 'assistant_role_package_not_qualified' : '',
    assistant.denied ? 'assistant_role_denied' : '',
    assistant.requestable && !assistant.roleHeld ? 'assistant_role_user_grant_required' : ''
  ].filter(Boolean)
}

function androidAssistantRoleEvidence(assistant: AndroidAssistantRoleStatus): string[] {
  return unique([
    assistant.evidenceSource,
    `RoleManager.isRoleAvailable(${assistant.roleName})=${String(assistant.roleAvailable)}`,
    `RoleManager.isRoleHeld(${assistant.roleName})=${String(assistant.roleHeld)}`,
    `package qualification probe=${assistant.packageQualified ? 'qualified' : 'not-qualified'}`,
    `requestable=${String(assistant.requestable)}`,
    `oemUnavailable=${String(assistant.oemUnavailable)}`,
    `fallbackAvailable=${String(assistant.fallbackAvailable)}`
  ])
}

function androidFallbackEntrypointEvidence(entrypoint: AndroidFallbackEntrypoint): string[] {
  return unique([
    entrypoint.capability ?? '',
    entrypoint.permission ?? '',
    entrypoint.intentAction ?? '',
    `manifestDeclared=${String(entrypoint.manifestDeclared ?? false)}`,
    `backendRequired=${String(entrypoint.backendRequired ?? false)}`
  ])
}

function androidNativeEntrypointEvidence(entrypoint: AndroidNativeEntrypoint): string[] {
  return unique([
    entrypoint.capability,
    entrypoint.permission ?? '',
    entrypoint.intentAction,
    `manifestDeclared=${String(entrypoint.manifestDeclared)}`,
    `backendRequired=${String(entrypoint.backendRequired)}`,
    `payloadCommand=${entrypoint.payloadCommand}`
  ])
}

function nativePermissionLabel(name: string): string {
  const labels: Record<string, string> = {
    'aurora.iosKeychain': 'iOS Keychain',
    'aurora.iosBiometricUnlock': 'Face ID / Touch ID admin unlock',
    'ios.keychain.secureCredentialStorage': 'iOS Keychain secure storage',
    'ios.biometric.adminUnlock': 'Face ID / Touch ID admin unlock',
    'aurora.iosVoiceStatus': 'iOS voice status',
    'aurora.iosBackgroundStatus': 'iOS background voice status',
    'aurora.iosMicrophoneCapture': 'iOS microphone capture',
    'aurora.iosBackgroundAudio': 'iOS background voice',
    'aurora.iosSiriReplacement': 'iOS System Assistant Role Unsupported',
    'aurora.iosAppIntents': 'iOS App Intents',
    'aurora.iosShortcuts': 'iOS Shortcuts',
    'aurora.iosLocalLightInference': 'iOS Local Light Inference',
    'ios.voiceForegroundCapture': 'Foreground voice capture',
    'ios.notifications': 'iOS notifications',
    'ios.backgroundVoice': 'Background voice',
    'ios.appOwnedInvocation': 'App-owned invocation',
    'ios.appIntents': 'App Intents',
    'ios.shortcuts': 'Shortcuts',
    'ios.shareExtension': 'Share extension',
    'ios.widgets': 'Widgets',
    'ios.deepLinks': 'Deep links',
    'ios.siriReplacement': 'System assistant role',
    'ios.localLightInference.provider': 'iOS local-light inference provider',
    'ios.localLightInference.modelRuntime': 'iOS local-light model runtime',
    'ios.localLightInference.fallback': 'iOS local-light fallback'
  }
  if (labels[name]) return labels[name]
  return name
    .replace(/^aurora\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_.]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function nativePermissionDetail(
  name: string,
  granted: boolean,
  capabilityEnabled: boolean,
  requestEnabled = false,
  nativeState: string | null = null
): string {
  if (name === 'aurora.iosKeychain' || name === 'ios.keychain.secureCredentialStorage') {
    return capabilityEnabled || granted
      ? 'Tokens, mesh credentials, and admin unlock secrets use iOS Keychain evidence from the native manifest.'
      : 'iOS Keychain requires the Tauri iOS native plugin and Xcode-built app target.'
  }
  if (name === 'aurora.iosBiometricUnlock' || name === 'ios.biometric.adminUnlock') {
    return capabilityEnabled || granted
      ? 'Face ID/Touch ID can confirm admin unlocks before backend AdminAction confirmation and audit.'
      : 'Face ID/Touch ID admin unlock requires LocalAuthentication on an iOS device or simulator.'
  }
  if (name === 'ios.appIntents' || name === 'ios.shortcuts') {
    return 'Siri/Shortcuts/App Intents integration is app-owned and scoped to concrete Aurora actions.'
  }
  if (name === 'aurora.iosMicrophoneCapture' || name === 'ios.voiceForegroundCapture') {
    return 'iOS microphone capture is foreground-only and requires AVAudioSession record permission, raw-audio consent, backend audio evidence, and a visible stop/revoke path.'
  }
  if (name === 'ios.notifications') {
    return 'iOS notifications require user authorization and can return users to Aurora, but they cannot provide always-on assistant wake.'
  }
  if (name === 'aurora.iosBackgroundAudio' || name === 'ios.backgroundVoice') {
    return 'Always-on background listening is unavailable on iOS; use foreground capture, notifications, Shortcuts, App Intents, widgets, share sheet, or deep links.'
  }
  if (name === 'ios.appOwnedInvocation') {
    return 'iOS invocation stays app-owned through Siri/Shortcuts/App Intents, widgets, share sheet, and deep links; system assistant ownership is unavailable.'
  }
  if (name === 'ios.shareExtension' || name === 'ios.widgets' || name === 'ios.deepLinks') {
    return 'iOS entrypoints stay inside app-owned extension, widget, share, and deep-link surfaces.'
  }
  if (name === 'ios.siriReplacement') {
    return 'iOS does not allow third-party default assistant ownership; only Siri/Shortcuts/App Intents integration is shown.'
  }
  if (name === 'aurora.iosLocalLightInference' || name.startsWith('ios.localLightInference')) {
    return 'iOS Core ML/MLC/ExecuTorch-style local-light inference is a capability-gated provider; backend model catalog and device/model proof are required before selection.'
  }
  if (granted) return 'Native manifest reports this permission as granted.'
  if (requestEnabled) return 'Native manifest advertises an Android permission request command for this state.'
  if (nativeState === 'degraded') return 'Native manifest reports a degraded or partial platform path for this feature.'
  if (nativeState === 'fallback') return 'Native manifest reports this as a fallback entrypoint instead of primary capability.'
  return 'Permission request is disabled until a native request command is advertised by the SDK/native manifest.'
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function integrationStatusState(status: NativePlatformIntegration['status']): AvailabilityState {
  if (status === 'supported') return 'available-local'
  if (status === 'partial') return 'degraded'
  if (status === 'requires-native-target') return 'privacy-blocked'
  if (status === 'deferred') return 'pending'
  return 'unsupported'
}

function releaseGateState(status: NativeReleaseGate['status']): AvailabilityState {
  if (status === 'passed') return 'available-local'
  if (status === 'pending') return 'pending'
  if (status === 'blocked') return 'denied'
  if (status === 'requires-credentials') return 'privacy-blocked'
  if (status === 'requires-macos' || status === 'requires-xcode') return 'degraded'
  return 'unsupported'
}
