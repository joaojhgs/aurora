import type { AuroraShellSnapshot } from './shell-data'
import { getAuroraSurfaceProfile } from './platform-surface'
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

export function SettingsNativeView({ snapshot, currentPath = '/settings/native', ...props }: SettingsNativeViewProps) {
  return <SettingsPermissionsView {...props} snapshot={snapshot} surface="native" currentPath={currentPath} />
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
  const profile = getAuroraSurfaceProfile({
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform
  })
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
      ? (profile.supportsMobileNative || profile.isWebThin || snapshot.transportKind === 'mock') && snapshot.loadState !== 'loading'
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
  if (id === 'desktop-local') return 'Desktop app status'
  if (id === 'web-fallback') return 'Browser status'
  if (id === 'android-preflight') return 'Android app readiness'
  return 'iOS app readiness'
}

function platformEvidenceNotes(id: NativePlatformEvidenceArtifact['id'], snapshot: AuroraShellSnapshot): string[] {
  if (id === 'desktop-local') {
    return [
      'Desktop features are shown only when this app can use them.',
      snapshot.nativeAvailable ? 'Desktop features are available on this device.' : 'Desktop features are not available on this device.'
    ]
  }
  if (id === 'web-fallback') {
    return [
      'Browser sessions use features from a connected Aurora device.',
      'Pair this browser before using features that live on another device.'
    ]
  }
  if (id === 'android-preflight') {
    return [
      'Connect Android to Aurora before using features from another device.',
      'Assistant role remains conditional on RoleManager, package qualification, OEM support, and user grant.'
    ]
  }
  return [
    'Connect iOS to Aurora before using features from another device.',
    'Aurora actions stay inside the app, Shortcuts, widgets, share sheet, and links.'
  ]
}
