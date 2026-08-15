import { describe, expect, it } from 'vitest'
import { getAuroraSurfaceProfile, sanitizeRuntimeProfile } from '@aurora/ui'
import {
  AURORA_DEBUG_UI_LAUNCH_PRESETS,
  applyDebugUiLaunchToRuntimeProfile,
  listAuroraDebugUiLaunchPresetIds,
  resolveAuroraDebugUiLaunch,
  shellRuntimeModeFromSurfaceKind,
} from './debug-ui-launch'

describe('debug UI launch presets', () => {
  it('resolves every named preset from env and maps to the intended surface profile', () => {
    for (const presetId of listAuroraDebugUiLaunchPresetIds()) {
      const definition = AURORA_DEBUG_UI_LAUNCH_PRESETS[presetId]
      const launch = resolveAuroraDebugUiLaunch({
        NODE_ENV: 'development',
        NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
        NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET: presetId,
      })

      expect(launch).toMatchObject({
        preset: presetId,
        runtimeMode: definition.runtimeMode,
        nodeMode: definition.nodeMode,
      })

      const profile = sanitizeRuntimeProfile(
        applyDebugUiLaunchToRuntimeProfile(launch!, undefined),
      )
      const surface = getAuroraSurfaceProfile({
        runtimeMode: launch!.runtimeMode,
        nodeMode: profile.nodeMode,
        runtimeTier: profile.runtimeTier,
        nativePlatform: launch!.nativePlatform,
        userAgent: launch!.userAgent,
        transportKind: profile.nodeMode === 'mesh-node' ? 'mesh' : 'http',
      })

      expect(surface.nodeMode).toBe(definition.nodeMode)
      expect(surface.isRemoteConsole).toBe(definition.nodeMode === 'remote-console')
      expect(surface.ownsLocalNodeState).toBe(definition.nodeMode === 'mesh-node')

      if (presetId.startsWith('web-')) {
        expect(surface.kind).toBe('web')
        expect(surface.isWebThin).toBe(true)
      }
      if (presetId === 'desktop-local') {
        expect(surface.kind).toBe('desktop-local')
        expect(surface.usesLocalSidecar).toBe(true)
        expect(surface.canManageLocalServiceConfiguration).toBe(true)
      }
      if (presetId === 'desktop-thin-remote' || presetId === 'desktop-node') {
        expect(surface.kind).toBe('desktop-thin')
        expect(surface.usesLocalSidecar).toBe(false)
      }
      if (presetId.startsWith('android-')) {
        expect(surface.kind).toBe('android')
        expect(surface.isAndroid).toBe(true)
      }
      if (presetId.startsWith('ios-')) {
        expect(surface.kind).toBe('ios')
        expect(surface.isIos).toBe(true)
      }
      if (presetId === 'mobile-node') {
        expect(surface.kind).toBe('mobile')
        expect(surface.isMobile).toBe(true)
      }
    }
  })

  it('stays inert in production even when public debug values are present', () => {
    expect(resolveAuroraDebugUiLaunch({
      NODE_ENV: 'production',
      NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
      NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET: 'desktop-local',
    })).toBeNull()
  })

  it('synthesizes a product-safe runtime profile for shell ownership', () => {
    const launch = resolveAuroraDebugUiLaunch({
      NODE_ENV: 'development',
      NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
      NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET: 'android-node',
    })
    expect(launch).not.toBeNull()
    const profile = sanitizeRuntimeProfile(
      applyDebugUiLaunchToRuntimeProfile(launch!, undefined),
    )
    expect(profile.nodeMode).toBe('mesh-node')
    expect(profile.label).toBe('This device')
    expect(profile.localNode.nodeName).toBe('This device')
    expect(profile.localNode.enabledCapabilityPacks).toContain('native-actions')
    expect(profile.localNode.meshMembership?.webrtcProfile.room).toBe('ui-launch-android-node')
  })

  it('maps hosted web surface kinds back to the web-thin shell mode alias', () => {
    expect(shellRuntimeModeFromSurfaceKind('web')).toBe('web-thin')
    expect(shellRuntimeModeFromSurfaceKind('desktop-local')).toBe('desktop-local')
  })
})
