'use client'

import { useMemo, type ReactNode } from 'react'
import type { AuroraClient } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { SettingsPermissionsView } from './settings-permissions-view'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { AuroraRuntimeProfileV2 } from './runtime-profile'
import type { AuroraLocalSpeechCatalogPort } from './browser-speech-pack'

/** @deprecated Settings is a single This-device page; retained so existing hosts keep compiling. */
export type SettingsViewTab = 'general' | 'voice' | 'configuration' | 'advanced'

export interface SettingsViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  configRoute: RouteAvailability
  dataRoute: RouteAvailability
  /** @deprecated Ignored: Settings is a single This-device page. */
  initialTab?: SettingsViewTab
  runtimeProfile?: AuroraRuntimeProfileV2 | null | undefined
  surfaceProfile?: AuroraSurfaceProfile | null | undefined
  localSpeechCatalog?: AuroraLocalSpeechCatalogPort | null | undefined
  onLocalSpeechSelectionConfirmed?: ((selection: NonNullable<AuroraRuntimeProfileV2['localNode']['localSpeechSelection']>) => void | Promise<void>) | undefined
  /** @deprecated Ignored: Settings is local-only and does not branch on admin. */
  sessionIsAdmin?: boolean | undefined
  onRequestNativeAccess?: ((permissionId: string) => Promise<void> | void) | undefined
  onNavigate?: ((href: string) => void) | undefined
  /** Optional host-supplied content rendered in This device → Connection & role (e.g. Tauri "Change device setup"). */
  connectionRoleContent?: ReactNode | undefined
}

export function SettingsView({
  snapshot,
  runtimeProfile = null,
  surfaceProfile = null,
  onRequestNativeAccess,
  connectionRoleContent
}: SettingsViewProps) {
  const profile = useMemo(() => surfaceProfile ?? getAuroraSurfaceProfile({
    transportKind: snapshot.transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
    nodeMode: runtimeProfile?.nodeMode ?? null,
    runtimeTier: runtimeProfile?.runtimeTier ?? null,
    enabledCapabilityPacks: runtimeProfile?.nodeMode === 'mesh-node' ? runtimeProfile.localNode.enabledCapabilityPacks : [],
    localSpeechPackState: runtimeProfile?.localNode.localSpeechPackState ?? null
  }), [surfaceProfile, snapshot.nativePlatform, snapshot.transportKind, runtimeProfile])

  return (
    <section className="flex flex-col gap-4" aria-label="Settings">
      <SettingsPermissionsView
        snapshot={snapshot}
        surface="settings"
        currentPath="/settings"
        runtimeProfile={runtimeProfile}
        surfaceProfile={profile}
        onRequestNativeAccess={onRequestNativeAccess}
        connectionRoleContent={connectionRoleContent}
      />
    </section>
  )
}
