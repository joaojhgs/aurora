'use client'

import { useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Mic, RefreshCw, ShieldCheck, Smartphone, ToggleLeft, Volume2 } from 'lucide-react'
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
import { getAuroraSurfaceProfile } from './platform-surface'
import { safeErrorCopy } from './product-copy'
import { PrivacyBadge, StatusBadge } from './status-badges'
import { PageHeader } from './state-surface'
import { Button, Card, DataTable, MetaGrid, StatStrip, type DataColumn } from './primitives'
import { cn } from '#lib/utils'
import { Input } from '#components/ui/input'

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

export interface SettingsVoiceBehaviorCard {
  id: string
  label: string
  state: AvailabilityState
  enabled: boolean
  defaultLabel: string
  privacyClass: PrivacyClass
  providerLabel: string
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
  voiceBehavior: SettingsVoiceBehaviorCard[]
  nativePermissions: SettingsNativePermissionCard[]
  nativeIntegrations: SettingsNativeIntegrationCard[]
  nativeLimitations: Array<{ id: string; label: string; detail: string; evidence: string }>
  routeDefaults: Array<{ id: string; label: string; value: string; state: AvailabilityState; detail: string }>
  nativePlatformIntegrations: NativePlatformIntegration[]
  nativeReleaseGates: NativeReleaseGate[]
  nativeDeviceMatrix: NativeDeviceMatrixRow[]
  nativePolicyNotes: string[]
  assistantBehavior: Array<{ id: string; label: string; value: string; state: AvailabilityState; detail: string }>
  userExperienceDefaults: Array<{ id: string; label: string; value: string; state: AvailabilityState; detail: string }>
  adminActionLabel: string
  fallbackLabel: string
  error: string | null
}

export type SettingsPermissionsSurface = 'settings' | 'native'

export interface SettingsPermissionsViewProps {
  snapshot: AuroraShellSnapshot
  surface?: SettingsPermissionsSurface
  currentPath?: string
  hideTabs?: boolean | undefined
  onRequestNativeAccess?: ((permissionId: string) => Promise<void> | void) | undefined
}

export function SettingsPermissionsView({
  snapshot,
  surface,
  currentPath,
  hideTabs = false,
  onRequestNativeAccess
}: SettingsPermissionsViewProps) {
  const routePath = currentPath ?? browserPathname()
  const activeSurface = surface ?? (routePath === '/settings/native' ? 'native' : 'settings')
  const model = buildSettingsPermissionsModel(snapshot)
  if (activeSurface === 'native') {
    return (
      <NativeSettingsSurface
        snapshot={snapshot}
        model={model}
        hideTabs={hideTabs}
        onRequestNativeAccess={onRequestNativeAccess}
      />
    )
  }
  return <RouteSettingsSurface snapshot={snapshot} model={model} hideTabs={hideTabs} />
}

function browserPathname(): string | null {
  return typeof globalThis.location?.pathname === 'string' ? globalThis.location.pathname : null
}

function RouteSettingsSurface({
  snapshot,
  model,
  hideTabs
}: {
  snapshot: AuroraShellSnapshot
  model: SettingsPermissionsModel
  hideTabs: boolean
}) {
  return (
    <div className="flex flex-col gap-4">
      {hideTabs ? null : <SettingsTabs active="general" />}
      <PageHeader
        id="settings-permissions-title"
        eyebrow="Settings"
        title="General"
        description="Privacy defaults, voice behavior, and assistant preferences."
      />

      {model.error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          <AlertTriangle size={17} aria-hidden />
          <span>{model.error}</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <PanelTitle
            icon={<ShieldCheck size={18} aria-hidden />}
            title="Privacy defaults"
            description="Aurora keeps sensitive choices visible and requires confirmation before they change."
            id="privacy-defaults-title"
          />
          <div className="flex flex-col gap-3">
            {model.privacyControls.map((control) => (
              <PrivacyControlRow key={control.id} control={control} />
            ))}
          </div>
        </Card>

        <Card>
          <PanelTitle
            icon={<Volume2 size={18} aria-hidden />}
            title="Voice behavior"
            description="Push-to-talk, wake behavior, and spoken replies are shown with the access needed before they can be used."
            id="voice-behavior-title"
          />
          <div className="flex flex-col gap-3">
            {model.voiceBehavior.map((item) => (
              <VoiceBehaviorRow key={item.id} item={item} />
            ))}
          </div>
        </Card>

        <Card>
          <PanelTitle
            icon={<Mic size={18} aria-hidden />}
            title="Assistant behavior"
            description="Assistant defaults show what is ready, what needs review, and what can be changed next."
            id="assistant-behavior-title"
          />
          <div className="flex flex-col gap-2.5">
            {model.assistantBehavior.map((item) => (
              <RouteDefaultRow key={item.id} label={item.label} detail={item.detail} state={item.state} value={item.value} />
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <PanelTitle
          icon={<ToggleLeft size={18} aria-hidden />}
          title="Theme, accessibility, and local storage"
          description="Display and local preferences stay on this device unless you choose otherwise."
          id="theme-accessibility-storage-title"
        />
        <div className="flex flex-col gap-2.5">
          {model.userExperienceDefaults.map((item) => (
            <RouteDefaultRow key={item.id} label={item.label} detail={item.detail} state={item.state} value={item.value} />
          ))}
        </div>
      </Card>

      <Card>
        <PanelTitle
          icon={<RefreshCw size={18} aria-hidden />}
          title="Connection choices"
          description="Aurora shows when another device can help and when a chosen device needs attention."
          id="route-policy-title"
        />
        <div className="flex flex-col gap-2.5">
          {model.routeDefaults.map((item) => (
            <RouteDefaultRow key={item.id} label={item.label} detail={item.detail} state={item.state} value={item.value} />
          ))}
        </div>
        <MetaGrid
          items={[
            { label: 'Admin confirmation', value: model.adminActionLabel },
            { label: 'Backup choice', value: model.fallbackLabel },
          ]}
          columns={1}
        />
      </Card>
    </div>
  )
}

function RouteDefaultRow({ label, detail, state, value }: { label: string; detail: string; state: AvailabilityState; value: string }) {
  return (
    <article className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
      <div className="flex flex-col gap-0.5">
        <strong className="text-sm">{label}</strong>
        <span className="text-xs text-muted-foreground">{detail}</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge state={state} />
        <code className="font-mono text-xs text-muted-foreground">{value}</code>
      </div>
    </article>
  )
}

function NativeSettingsSurface({
  snapshot,
  model,
  hideTabs,
  onRequestNativeAccess
}: {
  snapshot: AuroraShellSnapshot
  model: SettingsPermissionsModel
  hideTabs: boolean
  onRequestNativeAccess?: ((permissionId: string) => Promise<void> | void) | undefined
}) {
  const accessRows = nativeAccessRows(model, snapshot)
  const grantedCount = accessRows.filter((permission) => permission.granted).length
  const requestableCount = accessRows.filter((permission) => permission.requestEnabled).length
  const [requestingPermissionId, setRequestingPermissionId] = useState<string | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)

  async function requestAccess(permissionId: string) {
    if (!onRequestNativeAccess || requestingPermissionId) return
    setRequestingPermissionId(permissionId)
    setRequestError(null)
    try {
      await onRequestNativeAccess(permissionId)
    } catch (error) {
      setRequestError(safeErrorCopy(error).title)
    } finally {
      setRequestingPermissionId(null)
    }
  }

  const permissionColumns: Array<DataColumn<SettingsNativePermissionCard>> = [
    {
      key: 'capability',
      header: 'Capability',
      render: (permission) => (
        <span className="flex flex-col gap-0.5">
          <strong>{nativeAccessLabel(permission.id)}</strong>
          <small className="text-xs text-muted-foreground">{nativeAccessDetail(permission)}</small>
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      render: (permission) => (
        <span className="flex flex-col gap-1">
          <StatusBadge state={permission.state} />
          <small className="text-xs text-muted-foreground">
            {permission.granted
              ? 'Allowed on this device.'
              : permission.requestEnabled
                ? 'Your device will ask for confirmation.'
                : 'Review this device\'s settings.'}
          </small>
        </span>
      )
    },
    {
      key: 'permission',
      header: 'Device access',
      hideAt: 'md',
      render: (permission) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-xs">{permission.granted ? 'Allowed' : permission.requestEnabled ? 'Can request' : 'Needs review'}</span>
          {permission.evidence.length > 0 ? <small className="text-xs text-muted-foreground">{permission.granted ? 'This device can use it.' : 'The next step will be shown here.'}</small> : null}
        </span>
      )
    },
    {
      key: 'action',
      header: 'Action',
      align: 'end',
      render: (permission) => {
        const requesting = requestingPermissionId === permission.id
        const canRequest = permission.requestEnabled && Boolean(onRequestNativeAccess) && requestingPermissionId === null
        return (
          <Button
            variant={permission.requestEnabled ? 'primary' : 'ghost'}
            disabled={!canRequest}
            disabledReason={
              permission.granted
                ? 'This access is already allowed.'
                : onRequestNativeAccess
                  ? 'This access must be changed in device settings.'
                  : 'Open Aurora on this device to change this access.'
            }
            onClick={() => void requestAccess(permission.id)}
          >
            {requesting ? 'Opening…' : permission.requestEnabled ? 'Request access' : permission.granted ? 'Allowed' : 'Needs setup'}
          </Button>
        )
      }
    }
  ]

  return (
    <section className="flex flex-col gap-4" aria-labelledby="settings-native-title">
      {hideTabs ? null : <SettingsTabs active="advanced" />}
      <PageHeader
        eyebrow="Settings"
        id="settings-native-title"
        title="Advanced"
        description="Additional device and account choices."
      />

      {model.error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          <AlertTriangle size={17} aria-hidden />
          <span>{model.error}</span>
        </div>
      ) : null}

      {accessRows.length > 0 ? (
        <Card>
          <PanelTitle
            icon={<Smartphone size={18} aria-hidden />}
            title="Device access"
            description="Choose which device features Aurora may use. Your device always asks before granting new access."
            id="device-access-title"
          />
          <StatStrip
            ariaLabel="Device access summary"
            items={[
              { label: 'Allowed', value: grantedCount, tone: grantedCount > 0 ? 'success' : 'default' },
              { label: 'Available to request', value: requestableCount, tone: requestableCount > 0 ? 'warning' : 'default' }
            ]}
          />
          {requestError ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
              <AlertTriangle size={17} aria-hidden />
              <span>{requestError}</span>
            </div>
          ) : null}
          <DataTable
            className="mt-3"
            columns={permissionColumns}
            rows={accessRows}
            getRowKey={(permission) => permission.id}
            empty="No device access choices are available here."
          />
        </Card>
      ) : null}

      <AdvancedSettingsSections model={model} snapshot={snapshot} />
      <SettingsDataBlock />
    </section>
  )
}

function nativeAccessRows(model: SettingsPermissionsModel, snapshot: AuroraShellSnapshot): SettingsNativePermissionCard[] {
  if (snapshot.nativePlatform !== 'android') return []
  const ids = [
    'android.assistantRole',
    'aurora.android.microphone',
    'aurora.android.notifications',
    'aurora.android.voiceForegroundService'
  ]
  return ids
    .map((id) => model.nativePermissions.find((permission) => permission.id === id))
    .filter((permission): permission is SettingsNativePermissionCard => Boolean(permission))
}

function nativeAccessLabel(permissionId: string): string {
  if (permissionId === 'android.assistantRole') return 'Default assistant'
  if (permissionId === 'aurora.android.microphone') return 'Microphone'
  if (permissionId === 'aurora.android.notifications') return 'Notifications'
  if (permissionId === 'aurora.android.voiceForegroundService') return 'Hands-free listening'
  return 'Device feature'
}

function nativeAccessDetail(permission: SettingsNativePermissionCard): string {
  if (permission.id === 'android.assistantRole') {
    return permission.granted
      ? 'Aurora is selected as this device\'s assistant.'
      : 'Choose Aurora if you want the device assistant action to open it.'
  }
  if (permission.id === 'aurora.android.microphone') {
    return 'Needed to hear push-to-talk and hands-free requests.'
  }
  if (permission.id === 'aurora.android.notifications') {
    return 'Needed for visible hands-free controls while Aurora is not on screen.'
  }
  if (permission.id === 'aurora.android.voiceForegroundService') {
    return 'Keeps a user-started listening session visible and easy to stop.'
  }
  return 'Review whether Aurora may use this feature on your device.'
}

function SettingsTabs({ active }: { active: 'general' | 'configuration' | 'advanced' }) {
  const tabs = [
    { id: 'general' as const, label: 'General', href: '/settings' },
    { id: 'configuration' as const, label: 'Configuration', href: '/admin/config' },
    { id: 'advanced' as const, label: 'Advanced', href: '/settings/native' }
  ]
  return (
    <nav className="flex items-center gap-1 border-b border-border" aria-label="Settings sections">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={tab.href}
          className={cn(
            'border-b-2 border-transparent px-3.5 py-2 text-sm font-medium text-muted-foreground -mb-px',
            tab.id === active && 'border-primary text-foreground'
          )}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  )
}

function AdvancedSettingsSections({ model, snapshot }: { model: SettingsPermissionsModel; snapshot: AuroraShellSnapshot }) {
  const sections = [
    {
      section: 'Routes',
      entries: model.routeDefaults.map((item) => ({ key: item.id, label: item.label, description: item.detail, value: item.value }))
    },
    {
      section: 'Experience',
      entries: model.userExperienceDefaults.map((item) => ({ key: item.id, label: item.label, description: item.detail, value: item.value }))
    },
    {
      section: 'Platform',
      entries: [
        { key: 'connection', label: 'Connection', description: 'How this screen is connected.', value: surfaceConnectionLabel(snapshot) },
        { key: 'device', label: 'Device', description: 'Where Aurora is running.', value: surfaceDeviceLabel(snapshot) },
        { key: 'available-access', label: 'Available access', description: 'Device features ready to use.', value: String(model.nativePermissions.filter((permission) => permission.granted).length) }
      ]
    }
  ]
  return (
    <div className="flex flex-col gap-4">
      {sections.map((section) => (
        <Card key={section.section} title={section.section}>
          <div className="flex flex-col gap-3">
            {section.entries.map((entry) => (
              <label key={entry.key} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_minmax(0,260px)] sm:items-center">
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium">{entry.label}</span>
                  <small className="text-xs text-muted-foreground">{entry.description}</small>
                </span>
                <Input value={entry.value} readOnly className="font-mono text-xs" />
              </label>
            ))}
          </div>
        </Card>
      ))}
    </div>
  )
}

function SettingsDataBlock() {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <strong className="text-sm font-medium">Export or delete your data</strong>
          <p className="mt-0.5 text-xs text-muted-foreground">Preview affected records before either action runs.</p>
        </div>
        <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2">
          <Button variant="outline" className="w-full justify-center sm:w-auto">Export my data</Button>
          <Button variant="danger" className="w-full justify-center sm:w-auto">Delete my data</Button>
        </div>
      </div>
    </Card>
  )
}

export function buildSettingsPermissionsModel(snapshot: AuroraShellSnapshot): SettingsPermissionsModel {
  const settingsRoute = routeById(snapshot, 'settings')
  const nativeRoute = routeById(snapshot, 'native')
  const availableRemote = snapshot.routes.filter((route) => route.state === 'available-remote')
  const degraded = snapshot.routes.filter((route) => route.state === 'degraded')
  const selectorRequired = snapshot.routes.filter((route) => route.selectorRequired)
  const selectorHardBlocked = selectorRequired.filter((route) => route.disabled || route.state === 'denied' || route.state === 'privacy-blocked')
  const denied = snapshot.routes.filter((route) => route.state === 'denied')
  const privacyBlocked = snapshot.routes.filter((route) => route.state === 'privacy-blocked')
  const errorText = snapshot.loadState === 'error' ? settingsErrorCopy(snapshot.error) : null
  const routeAdminRequired = Boolean(settingsRoute?.requiresAdminAction)
  const mutationAdminRequired = true
  const settingsDisabled = !settingsRoute || settingsRoute.disabled || snapshot.loadState !== 'ready'

  return {
    loadState: snapshot.loadState,
    settingsRoute,
    nativeRoute,
    privacyControls: [
      privacyControl({
        id: 'prefer-local',
        label: 'Prefer local processing',
        description: 'Keep sensitive work on this device unless your choices allow another trusted device.',
        state: snapshot.loadState === 'loading' ? 'pending' : settingsRoute?.state ?? 'unsupported',
        privacyClass: 'sensitive',
        providerLabel: safeRouteLabel(settingsRoute, 'Settings are still loading.'),
        enabled: !settingsDisabled && availableRemote.length === 0,
        disabled: settingsDisabled,
        requiresAdminAction: mutationAdminRequired,
        blockers: settingsRoute?.blockers ?? ['settings_route_missing'],
        evidence: settingsRoute?.evidenceSources ?? []
      }),
      privacyControl({
        id: 'explicit-selector',
        label: 'Require explicit remote selectors',
        description: 'Ask before using another device for sensitive work.',
        state: selectorHardBlocked.length > 0 ? 'privacy-blocked' : selectorRequired.length > 0 ? 'degraded' : settingsRoute?.state ?? 'unsupported',
        privacyClass: 'admin-critical',
        providerLabel: selectorRequired.length > 0 ? `${selectorRequired.length} choices need review` : 'No extra review needed',
        enabled: selectorRequired.length > 0,
        disabled: settingsDisabled,
        requiresAdminAction: mutationAdminRequired,
        blockers: selectorRequired.flatMap((route) => route.blockers),
        evidence: selectorRequired.flatMap((route) => route.evidenceSources)
      }),
      privacyControl({
        id: 'block-explicit-fallback',
        label: 'Stop after a chosen device fails',
        description: 'If a chosen device cannot finish, Aurora asks before trying somewhere else.',
        state: denied.length > 0 ? 'denied' : privacyBlocked.length > 0 ? 'privacy-blocked' : 'available-local',
        privacyClass: 'admin-critical',
        providerLabel: denied.length + privacyBlocked.length > 0 ? `${denied.length + privacyBlocked.length} choices need attention` : 'No blocked choices',
        enabled: true,
        disabled: settingsDisabled,
        requiresAdminAction: mutationAdminRequired,
        blockers: [...denied, ...privacyBlocked].flatMap((route) => route.blockers),
        evidence: [...denied, ...privacyBlocked].flatMap((route) => route.evidenceSources)
      })
    ],
    voiceBehavior: voiceBehaviorCards(snapshot),
    nativePermissions: nativePermissionCards(snapshot, nativeRoute),
    nativeIntegrations: nativeIntegrationCards(snapshot),
    nativeLimitations: (snapshot.nativePlatformLimitations ?? []).map((limitation) => ({
      id: limitation.id,
      label: safeCopy(limitation.label, 'Device limitation'),
      detail: nativeLimitationDetail(limitation.id, limitation.userCopy),
      evidence: limitation.evidenceSource
    })),
    nativePlatformIntegrations: snapshot.nativePlatformIntegrations,
    nativeReleaseGates: snapshot.nativeReleaseGates,
    nativeDeviceMatrix: snapshot.nativeDeviceMatrix,
    nativePolicyNotes: snapshot.nativePolicyNotes,
    assistantBehavior: assistantBehaviorDefaults(snapshot),
    userExperienceDefaults: userExperienceDefaults(settingsRoute, snapshot),
    routeDefaults: [
      {
        id: 'remote-providers',
        label: 'Other devices',
        value: String(availableRemote.length),
        state: availableRemote.length > 0 ? 'available-remote' : 'unsupported',
        detail: availableRemote.length > 0 ? 'Another device is available for selected work.' : 'No other device is available right now.'
      },
      {
        id: 'degraded-fallback',
        label: 'Needs attention',
        value: String(degraded.length),
        state: degraded.length > 0 ? 'degraded' : 'available-local',
        detail: degraded.length > 0 ? 'At least one choice has reduced access.' : 'All available choices look ready.'
      },
      {
        id: 'denied-routes',
        label: 'Blocked choices',
        value: String(denied.length + privacyBlocked.length),
        state: privacyBlocked.length > 0 ? 'privacy-blocked' : denied.length > 0 ? 'denied' : 'available-local',
        detail: denied.length + privacyBlocked.length > 0 ? 'Review access, consent, or device selection.' : 'No blocked choice is reported.'
      }
    ],
    adminActionLabel: mutationAdminRequired
      ? routeAdminRequired
        ? 'Confirmation is required before settings can be viewed or changed.'
        : 'Confirmation is required before settings can be changed.'
      : 'No extra confirmation is required right now.',
    fallbackLabel: degraded.length > 0
      ? 'Aurora will ask before using another reduced-access choice.'
      : 'No backup choice is active right now.',
    error: errorText
  }
}

function assistantBehaviorDefaults(snapshot: AuroraShellSnapshot): SettingsPermissionsModel['assistantBehavior'] {
  const assistantRoute = routeById(snapshot, 'assistant')
  return [
    {
      id: 'assistant-route',
      label: 'Assistant route default',
      value: safeRouteLabel(assistantRoute, 'Assistant is still loading.'),
      state: assistantRoute?.state ?? 'unsupported',
      detail: 'Assistant requests wait for your device and privacy choices.'
    },
    {
      id: 'cancellation',
      label: 'Cancellation behavior',
      value: safeRouteLabel(snapshot.assistantCancellationRoute ?? null, 'Stop control is still loading.'),
      state: snapshot.assistantCancellationRoute?.state ?? 'unsupported',
      detail: 'Stop stays visible so spoken replies can be interrupted.'
    },
    {
      id: 'voice-consent',
      label: 'Voice consent default',
      value: 'foreground explicit consent',
      state: worstVoiceState([
        snapshot.assistantVoiceRoutes.transcription.state,
        snapshot.assistantVoiceRoutes.wakeProcess.state,
        snapshot.assistantVoiceRoutes.ttsSynthesize.state
      ]),
      detail: 'Voice capture and wake behavior stay off unless device access and consent allow them.'
    }
  ]
}

function userExperienceDefaults(
  settingsRoute: RouteAvailability | null,
  snapshot: AuroraShellSnapshot
): SettingsPermissionsModel['userExperienceDefaults'] {
  const settingsState = snapshot.loadState === 'loading' ? 'pending' : settingsRoute?.state ?? 'unsupported'
  return [
    {
      id: 'theme',
      label: 'Theme default',
      value: 'system theme',
      state: settingsState,
      detail: 'Theme follows your device preference until editing is available here.'
    },
    {
      id: 'accessibility',
      label: 'Accessibility default',
      value: 'Follows this device',
      state: settingsState,
      detail: 'Comfort and motion preferences stay with this screen.'
    },
    {
      id: 'local-storage',
      label: 'Saved preferences',
      value: snapshot.secretsRedacted ? 'Display choices only' : 'Checking',
      state: snapshot.secretsRedacted ? 'available-local' : 'degraded',
      detail: 'Only display preferences are kept on this device.'
    }
  ]
}

function VoiceBehaviorRow({ item }: { item: SettingsVoiceBehaviorCard }) {
  const icon = item.enabled ? <CheckCircle2 size={18} aria-hidden /> : <Mic size={18} aria-hidden />
  return (
    <article className="aui-settings-row flex items-start gap-3 rounded-lg border border-border/60 p-3" data-state={item.enabled ? 'optimistic' : 'disabled'}>
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="flex flex-1 flex-col gap-1.5">
        <h3 className="text-sm font-medium">{item.label}</h3>
        <p className="text-xs text-muted-foreground">{item.detail}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge state={item.state} />
          {item.privacyClass === 'raw-audio' ? (
            <span className="inline-flex h-5 w-fit items-center justify-center rounded-4xl bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">Voice</span>
          ) : (
            <PrivacyBadge privacy={item.privacyClass} />
          )}
        </div>
        <small className="text-xs text-muted-foreground">{item.enabled ? 'Configured' : 'Needs configuration'}</small>
      </div>
      <Button variant="ghost" disabled>
        {item.enabled ? 'Needs confirmation' : 'Not ready'}
      </Button>
    </article>
  )
}

function NativeIntegrationRow({ integration }: { integration: SettingsNativeIntegrationCard }) {
  return (
    <article className="aui-settings-row flex items-start gap-3 rounded-lg border border-border/60 p-3">
      <div className="mt-0.5 text-muted-foreground">
        {integration.state === 'unsupported' ? <AlertTriangle size={18} aria-hidden /> : <CheckCircle2 size={18} aria-hidden />}
      </div>
      <div className="flex flex-1 flex-col gap-1.5">
        <h3 className="text-sm font-medium">{integration.label}</h3>
        <p className="text-xs text-muted-foreground">{integration.detail}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge state={integration.state} />
          <PrivacyBadge privacy={integration.privacyClass} />
        </div>
        <small className="text-xs text-muted-foreground">{safeCopy(integration.capability, 'Device feature')}</small>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0.5">
            <dt className="text-muted-foreground">Action</dt>
            <dd className="font-medium">{safeCopy(integration.backendMethod, 'Review setup')}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0.5">
            <dt className="text-muted-foreground">Access</dt>
            <dd className="font-medium">{integration.permission ? 'Needs device access' : 'No extra access'}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start sm:gap-0.5">
            <dt className="text-muted-foreground">System assistant role</dt>
            <dd className="font-medium">{integration.siriReplacement ? 'claimed' : 'false'}</dd>
          </div>
        </dl>
      </div>
      <Button variant="ghost" disabled>
        {integration.state === 'unsupported' ? 'Not ready' : 'Needs device review'}
      </Button>
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
    <article className="aui-settings-row flex items-start gap-3 rounded-lg border border-border/60 p-3" data-state={control.mutationState}>
      <div className="mt-0.5 text-muted-foreground">{icon}</div>
      <div className="flex flex-1 flex-col gap-1.5">
        <h3 className="text-sm font-medium">{control.label}</h3>
        <p className="text-xs text-muted-foreground">{control.description}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge state={control.state} />
          <PrivacyBadge privacy={control.privacyClass} />
        </div>
        <small className="text-xs text-muted-foreground">{safeCopy(control.providerLabel, 'Review this setting.')}</small>
      </div>
      <Button variant="ghost" disabled={control.disabled || control.requiresAdminAction}>
        {control.requiresAdminAction ? 'Needs confirmation' : control.enabled ? 'Enabled' : 'Not ready'}
      </Button>
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
    <header className="mb-3 flex items-start gap-2.5">
      <span className="mt-0.5 text-muted-foreground" aria-hidden>{icon}</span>
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
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

function voiceBehaviorCards(snapshot: AuroraShellSnapshot): SettingsVoiceBehaviorCard[] {
  const voice = snapshot.assistantVoiceRoutes
  const microphone = snapshot.nativePermissions.find((permission) => permission.name.toLowerCase().includes('microphone'))
  const microphoneState: AvailabilityState = microphone
    ? microphone.granted
      ? 'available-local'
      : 'privacy-blocked'
    : snapshot.nativeAvailable
      ? 'privacy-blocked'
      : 'unsupported'
  const microphoneEvidence = microphone
    ? [`native microphone granted=${String(microphone.granted)}`, microphone.nativeState ?? 'native manifest']
    : [snapshot.nativeAvailable ? 'native microphone grant not reported' : 'browser/native microphone permission required']
  const wakeState = worstVoiceState([voice.wakeProcess.state, voice.wakeControl.state, microphoneState])
  const ttsState = worstVoiceState([voice.ttsSynthesize.state, voice.ttsStop.state])
  return [
    voiceBehaviorCard({
      id: 'push-to-talk',
      label: 'Push-to-talk',
      route: voice.transcription,
      state: worstVoiceState([voice.transcription.state, microphoneState]),
      enabled: routeEnabled(voice.transcription) && microphoneState !== 'unsupported',
      defaultLabel: 'foreground explicit consent',
      privacyClass: 'raw-audio',
      detail: 'Foreground capture requires user action, voice consent, and a ready speech setting.',
      extraEvidence: microphoneEvidence,
      extraBlockers: microphoneState === 'privacy-blocked' ? ['microphone permission required'] : []
    }),
    voiceBehaviorCard({
      id: 'wake-mode',
      label: 'Wake mode',
      route: voice.wakeProcess,
      state: wakeState,
      enabled: routeEnabled(voice.wakeProcess) && routeEnabled(voice.wakeControl) && microphoneState === 'available-local',
      defaultLabel: snapshot.nativePlatform === 'ios' ? 'foreground/app-owned only' : 'desktop local only until policy passes',
      privacyClass: 'raw-audio',
      detail: snapshot.nativePlatform === 'ios'
        ? 'iOS wake behavior stays inside foreground Aurora screens.'
        : 'Wake behavior requires microphone access and a ready wake setting before it can be enabled.',
      extraEvidence: [...microphoneEvidence, ...voice.wakeControl.evidenceSources],
      extraBlockers: [...voice.wakeControl.blockers, microphoneState === 'available-local' ? '' : 'native microphone gate not satisfied'].filter(Boolean)
    }),
    voiceBehaviorCard({
      id: 'spoken-replies',
      label: 'Spoken replies',
      route: voice.ttsSynthesize,
      state: ttsState,
      enabled: routeEnabled(voice.ttsSynthesize) && routeEnabled(voice.ttsStop),
      defaultLabel: 'speaker output with stop control',
      privacyClass: 'personal',
      detail: 'Spoken replies are available only when speech and stop controls are both ready.',
      extraEvidence: voice.ttsStop.evidenceSources,
      extraBlockers: voice.ttsStop.blockers
    })
  ]
}

function voiceBehaviorCard(input: {
  id: string
  label: string
  route: RouteAvailability
  state: AvailabilityState
  enabled: boolean
  defaultLabel: string
  privacyClass: PrivacyClass
  detail: string
  extraEvidence: string[]
  extraBlockers: string[]
}): SettingsVoiceBehaviorCard {
  return {
    id: input.id,
    label: input.label,
    state: input.state,
    enabled: input.enabled,
    defaultLabel: input.defaultLabel,
    privacyClass: input.privacyClass,
    providerLabel: safeRouteLabel(input.route, 'Not ready'),
    detail: input.detail,
    blockers: unique([...input.route.blockers, ...input.extraBlockers]),
    evidence: unique([...input.route.evidenceSources, ...input.extraEvidence])
  }
}

function routeEnabled(route: RouteAvailability): boolean {
  return route.routeable && !route.disabled && (route.state === 'available-local' || route.state === 'available-remote' || route.state === 'degraded')
}

function worstVoiceState(states: AvailabilityState[]): AvailabilityState {
  if (states.includes('denied')) return 'denied'
  if (states.includes('privacy-blocked')) return 'privacy-blocked'
  if (states.includes('unsupported')) return 'unsupported'
  if (states.includes('pending')) return 'pending'
  if (states.includes('degraded')) return 'degraded'
  if (states.includes('available-local')) return 'available-local'
  if (states.includes('available-remote')) return 'available-remote'
  return states[0] ?? 'unsupported'
}

function nativePermissionCards(
  snapshot: AuroraShellSnapshot,
  nativeRoute: RouteAvailability | null
): SettingsNativePermissionCard[] {
  const permissionNames = new Set([
    ...snapshot.nativePermissions.map((permission) => permission.name),
    ...snapshot.nativeCapabilities.map((capability) => capability.name)
  ].filter((name) => nativeNameAppliesToPlatform(name, snapshot.nativePlatform)))
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
      detail: nativePermissionDetail(name, granted, capabilityEnabled, requestEnabled, nativeState, snapshot),
      blockers: nativePermissionBlockers(name, granted, state, nativeState),
      evidence: nativeRoute?.evidenceSources ?? (snapshot.nativeAvailable ? ['native-manifest'] : [])
    }
  })
  const androidRows = androidNativePermissionCards(snapshot)
  const androidIds = new Set(androidRows.map((row) => row.id))
  return [...genericRows.filter((row) => !androidIds.has(row.id)), ...androidRows]
}

function nativeNameAppliesToPlatform(name: string, platform: string): boolean {
  const normalized = name.toLowerCase()
  const platformName = platform.toLowerCase()
  if (normalized.startsWith('aurora.android') || normalized.startsWith('android.')) {
    return platformName.includes('android')
  }
  if (normalized.startsWith('aurora.ios') || normalized.startsWith('ios.')) {
    return platformName.includes('ios')
  }
  if (normalized.startsWith('desktop.')) {
    return platformName.includes('tauri-desktop') || platformName.includes('desktop')
  }
  return true
}

function availabilityFromNativeIntegration(support: NativeMobileIntegration['support']): AvailabilityState {
  if (support === 'supported') return 'available-local'
  if (support === 'supported-path') return 'degraded'
  if (support === 'planned' || support === 'pending') return 'pending'
  if (support === 'blocked') return 'privacy-blocked'
  return 'unsupported'
}

function nativeIntegrationCards(snapshot: AuroraShellSnapshot): SettingsNativeIntegrationCard[] {
  return snapshot.nativeMobileIntegrations
    .filter((integration) => {
      return integration.platform === snapshot.nativePlatform
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
  if (nativeState === 'pending_native_target') return 'pending'
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
        label: safeCopy(entrypoint.label, nativePermissionLabel(entrypoint.id)),
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
    'aurora.iosSiriReplacement': 'iOS System Assistant Role',
    'aurora.iosAppIntents': 'iOS App Intents',
    'aurora.iosShortcuts': 'iOS Shortcuts',
    'aurora.iosShareExtension': 'iOS share extension',
    'aurora.iosWidgets': 'iOS widgets',
    'aurora.iosDeepLinks': 'iOS deep links',
    'aurora.iosFileAssociations': 'iOS file associations',
    'aurora.iosEntrypointPayload': 'iOS entrypoint payload',
    'aurora.iosLocalLightInference': 'iOS Local Light Inference',
    'aurora.nativeCapabilityManifest': 'Desktop app features',
    'aurora.nativePermissionStatus': 'Desktop app access',
    'aurora.trayStatus': 'Tauri tray status',
    'aurora.notificationsStatus': 'Tauri notifications status',
    'aurora.notificationsSend': 'Tauri notifications send',
    'aurora.dialogStatus': 'Tauri dialog status',
    'aurora.dialogOpen': 'Tauri dialog open',
    'aurora.localFileRead': 'Tauri local file read',
    'aurora.localFileWrite': 'Tauri local file write',
    'aurora.secureFileHandle': 'Tauri secure file handle',
    'aurora.audioBridgeStatus': 'Tauri audio bridge status',
    'aurora.audioCapture': 'Tauri audio capture',
    'aurora.audioPlayback': 'Tauri audio playback',
    'aurora.updater': 'Tauri updater',
    'aurora.secureStorage': 'Tauri secure storage',
    'desktop.signedUpdater': 'Tauri signed updater',
    'desktop.tray': 'Tauri tray',
    'native.notifications': 'Native notifications',
    'native.dialogs': 'Native dialogs',
    'native.secureFileHandles': 'Native secure file handles',
    'native.filesystem': 'Native filesystem',
    'native.audio': 'Native audio',
    'native.audioCapture': 'Native audio capture',
    'native.audioPlayback': 'Native audio playback',
    'native.secureCredentialStorage': 'Native secure credential storage',
    'aurora.android.assistantRoleStatus': 'Android assistant role status',
    'aurora.android.assistantRoleRequest': 'Android assistant role request',
    'aurora.android.microphone': 'Android microphone audio',
    'aurora.android.microphoneRequest': 'Android microphone access request',
    'aurora.android.notifications': 'Android notifications',
    'aurora.android.notificationsRequest': 'Android notifications request',
    'aurora.android.foregroundServiceMicrophone': 'Android foreground microphone service',
    'aurora.android.voiceForegroundService': 'Android foreground voice service',
    'aurora.android.voiceForegroundStart': 'Android foreground voice start',
    'aurora.android.secureStorage': 'Android Keystore secure storage',
    'aurora.android.biometric': 'Android biometrics',
    'aurora.android.adminUnlock': 'Android biometric admin unlock',
    'aurora.android.shareIntent': 'Android share sheet',
    'aurora.android.deepLink': 'Android deep link',
    'android.assistantRole.status': 'Android assistant role status',
    'android.assistantRole.request': 'Android assistant role request',
    'android.microphoneCapture': 'Android microphone audio',
    'android.microphonePermissionRequest': 'Android microphone access request',
    'android.notifications': 'Android notifications',
    'android.notificationPermissionRequest': 'Android notifications request',
    'android.foregroundService': 'Android foreground service',
    'android.voiceForegroundService': 'Android foreground voice service',
    'android.voiceForegroundService.start': 'Android foreground voice start',
    'android.secureCredentialStorage': 'Android Keystore secure storage',
    'android.biometric': 'Android biometrics',
    'android.adminUnlock': 'Android biometric admin unlock',
    'android.shareIntent': 'Android share sheet',
    'android.deepLink': 'Android deep link',
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
    'ios.localLightInference.provider': 'iOS local-light model source',
    'ios.localLightInference.modelRuntime': 'iOS local-light model engine',
    'ios.localLightInference.fallback': 'iOS local-light backup'
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
  nativeState: string | null = null,
  snapshot?: AuroraShellSnapshot
): string {
  const profile = snapshot ? getAuroraSurfaceProfile({
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform
  }) : null
  if (name === 'aurora.iosKeychain' || name === 'ios.keychain.secureCredentialStorage') {
    return capabilityEnabled || granted
      ? 'Sensitive sign-in details can be kept in the iOS keychain.'
      : 'Use the iOS app on a supported Apple device to keep sensitive sign-in details there.'
  }
  if (name === 'aurora.iosBiometricUnlock' || name === 'ios.biometric.adminUnlock') {
    return capabilityEnabled || granted
      ? 'Face ID or Touch ID can help confirm sensitive changes.'
      : 'Face ID/Touch ID admin unlock requires LocalAuthentication on an iOS device or simulator.'
  }
  if (name === 'ios.appIntents' || name === 'ios.shortcuts') {
    return 'Siri and Shortcuts can open specific Aurora actions.'
  }
  if (name === 'aurora.iosMicrophoneCapture' || name === 'ios.voiceForegroundCapture') {
    return 'iOS voice capture works while Aurora is open and needs microphone access plus a visible stop control.'
  }
  if (name === 'ios.notifications') {
    return 'iOS notifications need your approval and can bring you back to Aurora.'
  }
  if (name === 'aurora.iosBackgroundAudio' || name === 'ios.backgroundVoice') {
    return 'Always-on listening is unavailable on iOS; use Aurora while it is open or start actions from iOS shortcuts and links.'
  }
  if (name === 'ios.appOwnedInvocation') {
    return 'iOS can start Aurora actions from Siri, Shortcuts, widgets, the share sheet, and links.'
  }
  if (name === 'ios.shareExtension' || name === 'ios.widgets' || name === 'ios.deepLinks') {
    return 'iOS can open Aurora from widgets, sharing, and links.'
  }
  if (name === 'ios.siriReplacement') {
    return 'iOS does not allow Aurora to become the default assistant.'
  }
  if (name === 'aurora.iosLocalLightInference' || name.startsWith('ios.localLightInference')) {
    return 'Local iOS models need a supported device and an available model before selection.'
  }
  if (nativeState === 'degraded') return 'This feature has limited access on this device.'
  if (nativeState === 'fallback') return 'This feature can use a backup path with limited access.'
  if (name.startsWith('aurora.android.') || name.startsWith('android.')) {
    return requestEnabled
      ? 'Android can ask for this access from here.'
      : 'Android access depends on device support, your approval, and app setup.'
  }
  if (name.startsWith('aurora.') || name.startsWith('native.') || name.startsWith('desktop.')) {
    return profile?.isDesktop ? 'This desktop feature depends on app setup and device access.' : 'This device feature depends on app setup and device access.'
  }
  if (granted) return 'This access is allowed.'
  if (requestEnabled) return 'Aurora can ask for this access from here.'
  return 'Aurora cannot ask for this access from here yet.'
}

function nativeLimitationDetail(id: string, detail: string): string {
  if (id === 'noSiriReplacement') return 'iOS does not allow Aurora to become the default assistant.'
  if (id === 'foregroundConsentRequired') return 'Voice capture needs foreground use, clear consent, and a visible stop control.'
  return safeCopy(detail, 'This device cannot use that feature right now.')
}

function surfaceConnectionLabel(snapshot: AuroraShellSnapshot): string {
  const profile = getAuroraSurfaceProfile({
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform
  })
  if (profile.usesLocalSidecar) return 'This computer'
  if (profile.isMobile) return 'Mobile app'
  if (profile.isWebThin) return 'Connected browser'
  return 'Aurora app'
}

function surfaceDeviceLabel(snapshot: AuroraShellSnapshot): string {
  const profile = getAuroraSurfaceProfile({
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform
  })
  if (profile.isAndroid) return 'Android device'
  if (profile.isIos) return 'iOS device'
  if (profile.isDesktop) return 'Desktop computer'
  return 'This device'
}

function safeRouteLabel(route: RouteAvailability | null, fallback: string): string {
  if (!route) return fallback
  if (route.disabled || route.state === 'denied' || route.state === 'privacy-blocked') return 'Needs review'
  if (route.state === 'pending') return 'Still loading'
  if (route.state === 'degraded') return 'Limited access'
  if (route.state === 'available-remote') return 'Available on another device'
  if (route.state === 'available-local') return 'Available on this device'
  return fallback
}

function settingsErrorCopy(error: unknown): string {
  const copy = safeErrorCopy(error)
  if (!copy.action || copy.title.toLowerCase().includes(copy.action.toLowerCase())) return copy.title
  return `${copy.title}. ${copy.action}.`
}

function safeCopy(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || containsInternalCopy(trimmed)) return fallback
  return trimmed
}

function containsInternalCopy(value: string): boolean {
  return /\b(?:proof|evidence|fixtures?|assertions?|implement(?:ation|ed|ing)?|tested|debug(?:ging)?|fallback|provider|consumer|hybrid|manifest|contracts?|protocol|transport|runtime|schema|migrations?|sqlite|indexeddb|opfs|sidecar|thin|AdminAction|method|key[-_ ]?paths?|raw|permission)\b|\b(?:services|gateway|auth|config|orchestrator|tts|stt|db|tooling|scheduler)\.[a-z0-9_.]+\b/iu.test(value)
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
