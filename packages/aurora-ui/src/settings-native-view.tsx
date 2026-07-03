import type { AuroraShellSnapshot } from './shell-data'
import {
  SettingsPermissionsView,
  buildSettingsPermissionsModel,
  type SettingsPermissionsViewProps
} from './settings-permissions-view'

export type SettingsNativeViewProps = Omit<SettingsPermissionsViewProps, 'surface' | 'currentPath'> & {
  currentPath?: '/settings/native'
}

export interface NativePlatformEvidenceArtifact {
  id: 'desktop-local' | 'web-fallback' | 'android-preflight' | 'ios-preflight'
  label: string
  transportKind: string
  nativePlatform: string
  nativeAvailable: boolean
  evidenceSource: string
  loadState: AuroraShellSnapshot['loadState']
  settingsNativeRouteState: string
  nativePermissionRows: number
  nativeIntegrationRows: number
  unsupportedAvailableClaims: string[]
  thinClientUsable: boolean
  localPythonRequired: boolean
  notes: string[]
}

export function SettingsNativeView({ snapshot }: SettingsNativeViewProps) {
  return <SettingsPermissionsView snapshot={snapshot} surface="native" currentPath="/settings/native" />
}

export function buildNativePlatformEvidenceArtifact(
  id: NativePlatformEvidenceArtifact['id'],
  snapshot: AuroraShellSnapshot
): NativePlatformEvidenceArtifact {
  const model = buildSettingsPermissionsModel(snapshot)
  const unsupportedAvailableClaims = [
    ...model.nativePermissions
      .filter((permission) => permission.state === 'unsupported' && (permission.granted || permission.capabilityEnabled || permission.requestEnabled))
      .map((permission) => permission.id),
    ...model.nativeIntegrations
      .filter((integration) => integration.state === 'unsupported' && integration.support !== 'unsupported')
      .map((integration) => integration.id)
  ].sort()
  const mobileThin = id === 'android-preflight' || id === 'ios-preflight'
  return {
    id,
    label: platformEvidenceLabel(id),
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
    nativeAvailable: snapshot.nativeAvailable,
    evidenceSource: snapshot.evidenceSource,
    loadState: snapshot.loadState,
    settingsNativeRouteState: model.nativeRoute?.state ?? 'unsupported',
    nativePermissionRows: model.nativePermissions.length,
    nativeIntegrationRows: model.nativeIntegrations.length,
    unsupportedAvailableClaims,
    thinClientUsable: mobileThin
      ? ['native-mobile', 'http', 'mock'].includes(snapshot.transportKind) && snapshot.loadState !== 'loading'
      : id === 'web-fallback',
    localPythonRequired: id === 'desktop-local',
    notes: platformEvidenceNotes(id, snapshot)
  }
}

export function buildNativePlatformEvidenceJson(
  snapshots: Record<NativePlatformEvidenceArtifact['id'], AuroraShellSnapshot>
): string {
  const artifacts = (['desktop-local', 'web-fallback', 'android-preflight', 'ios-preflight'] as const)
    .map((id) => buildNativePlatformEvidenceArtifact(id, snapshots[id]))
  return JSON.stringify({ kind: 'aurora-native-platform-status', artifacts }, null, 2)
}

export const buildNativePlatformStatusArtifact = buildNativePlatformEvidenceArtifact
export const buildNativePlatformStatusJson = buildNativePlatformEvidenceJson

function platformEvidenceLabel(id: NativePlatformEvidenceArtifact['id']): string {
  if (id === 'desktop-local') return 'Desktop Tauri local native status'
  if (id === 'web-fallback') return 'Web browser fallback status'
  if (id === 'android-preflight') return 'Android mobile thin preflight status'
  return 'iOS mobile thin preflight status'
}

function platformEvidenceNotes(id: NativePlatformEvidenceArtifact['id'], snapshot: AuroraShellSnapshot): string[] {
  if (id === 'desktop-local') {
    return [
      'Desktop native claims require Tauri manifest status.',
      snapshot.nativeAvailable ? `Native platform reported: ${snapshot.nativePlatform}.` : 'Native manifest missing.'
    ]
  }
  if (id === 'web-fallback') {
    return [
      'Web fallback must not claim Tauri, Android, or iOS native permissions.',
      'Remote Gateway/auth pairing remains the thin-client path.'
    ]
  }
  if (id === 'android-preflight') {
    return [
      'Android is a mobile thin client: endpoint or mesh pairing first, no local Python sidecar requirement.',
      'Assistant role remains conditional on RoleManager, package qualification, OEM support, and user grant.'
    ]
  }
  return [
    'iOS is a mobile thin client: endpoint or mesh pairing first, no local Python sidecar requirement.',
    'Invocation is app-owned through App Intents, Shortcuts, widgets, share, or deep links; no system assistant replacement claim.'
  ]
}
