import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getAuroraSurfaceProfile, sanitizeRuntimeProfile } from '@aurora/ui'
import {
  AURORA_DEBUG_UI_LAUNCH_PRESETS,
  applyDebugUiLaunchToRuntimeProfile,
  debugUiLaunchQuery,
  debugUiLaunchSanitizeOptions,
  debugUiLaunchSessionIsAdmin,
  debugUiOverrideJson,
  isAuroraDebugUiPickerEnabled,
  launchFromDebugUiOverride,
  listAuroraDebugUiLaunchPresetIds,
  overrideFromDebugUiLaunch,
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
        debugUiLaunchSanitizeOptions(launch!),
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
        expect(profile.runtimeTier).toBe('python-full')
      }
      if (presetId === 'web-remote') {
        expect(debugUiLaunchSessionIsAdmin(launch!)).toBe(false)
      }
      if (presetId === 'web-remote-admin') {
        expect(debugUiLaunchSessionIsAdmin(launch!)).toBe(true)
        expect(surface.kind).toBe('web')
        expect(profile.nodeMode).toBe('remote-console')
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

  it('resolves the same named presets from query params without a baked env preset', () => {
    for (const presetId of listAuroraDebugUiLaunchPresetIds()) {
      const definition = AURORA_DEBUG_UI_LAUNCH_PRESETS[presetId]
      const launch = resolveAuroraDebugUiLaunch({
        nodeEnv: 'development',
        search: debugUiLaunchQuery(launchFromDebugUiOverride(overrideFromDebugUiLaunch(definition))),
      })

      expect(launch).toMatchObject({
        preset: presetId,
        runtimeMode: definition.runtimeMode,
        nodeMode: definition.nodeMode,
        override: overrideFromDebugUiLaunch(definition),
      })
    }
  })

  it('maps python-full role onto a mesh-node runtime with the full local tier', () => {
    const launch = resolveAuroraDebugUiLaunch({
      nodeEnv: 'development',
      search: 'aurora-surface=desktop-local&aurora-role=python-full&aurora-admin=0',
    })
    expect(launch).toMatchObject({
      preset: 'desktop-local',
      nodeMode: 'mesh-node',
      runtimeTier: 'python-full',
      override: {
        surface: 'desktop-local',
        role: 'python-full',
        admin: false,
      },
    })
  })

  it('stays inert in production even when public debug values are present', () => {
    expect(resolveAuroraDebugUiLaunch({
      NODE_ENV: 'production',
      NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
      NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET: 'desktop-local',
    })).toBeNull()
    expect(resolveAuroraDebugUiLaunch({
      nodeEnv: 'production',
      search: 'aurora-surface=android&aurora-role=mesh-node&aurora-admin=1',
      cookie: 'aurora-debug-ui=aurora-surface=ios&aurora-role=python-full&aurora-admin=1',
    })).toBeNull()
    expect(isAuroraDebugUiPickerEnabled({
      NODE_ENV: 'production',
      NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
    })).toBe(false)
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

  it('enables the debug flag via static process.env and keeps named presets as a test fallback only', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'debug-ui-launch.ts'), 'utf8')
    expect(source).toContain('process.env.NEXT_PUBLIC_AURORA_DEBUG_UI')
    expect(source).toContain('process.env.NODE_ENV')
    expect(source).toContain('readBrowserAuroraDebugUiSources')
    expect(source).not.toContain('VITE_AURORA_RUNTIME_MODE')
  })

  it('mounts debug chrome from the client layout wrapper and disables Next overlapping indicator', () => {
    const appDir = dirname(fileURLToPath(import.meta.url))
    const layout = readFileSync(join(appDir, 'layout.tsx'), 'utf8')
    const shell = readFileSync(join(appDir, 'path-aware-shell.tsx'), 'utf8')
    const globals = readFileSync(join(appDir, 'globals.css'), 'utf8')
    const proxy = readFileSync(join(appDir, '..', 'proxy.ts'), 'utf8')
    const nextConfig = readFileSync(join(appDir, '..', 'next.config.mjs'), 'utf8')
    const host = readFileSync(join(appDir, 'debug-ui-host.tsx'), 'utf8')
    expect(layout).toContain('DebugUiIndicator')
    expect(layout).toContain('./debug-ui-host')
    expect(layout).not.toContain('./debug-ui-picker')
    expect(layout).toContain('process.env.NODE_ENV !== \'production\'')
    expect(layout).toContain('process.env.NEXT_PUBLIC_AURORA_DEBUG_UI === \'1\'')
    expect(shell).toContain('./debug-ui-host')
    expect(shell).not.toContain('./debug-ui-picker')
    expect(globals).not.toContain('aurora-debug-ui')
    expect(globals).not.toContain('aurora-debug-viewport')
    expect(host).toContain("process.env.NEXT_PUBLIC_AURORA_DEBUG_UI === '1'")
    expect(host).toContain("import('./debug-ui-picker')")
    expect(proxy).toContain('isAuroraDebugUiPickerEnabled')
    expect(nextConfig).toContain('devIndicators: false')
  })

  it('preserves an explicit tablet viewport when the surface matches a named preset', () => {
    const launch = resolveAuroraDebugUiLaunch({
      nodeEnv: 'development',
      search: 'aurora-surface=android&aurora-role=mesh-node&aurora-admin=0&aurora-viewport=tablet',
    })
    expect(launch?.override).toMatchObject({
      surface: 'android',
      role: 'mesh-node',
      viewport: 'tablet',
      viewportExplicit: true,
    })
  })

  it('enables the debug picker from the public flag even without an override', () => {
    expect(isAuroraDebugUiPickerEnabled({
      NODE_ENV: 'development',
      NEXT_PUBLIC_AURORA_DEBUG_UI: '1',
    })).toBe(true)
    expect(isAuroraDebugUiPickerEnabled({
      NODE_ENV: 'development',
      search: 'aurora-surface=android&aurora-role=mesh-node&aurora-admin=0',
    })).toBe(false)
    const launch = resolveAuroraDebugUiLaunch({
      nodeEnv: 'development',
      search: 'aurora-surface=android&aurora-role=mesh-node&aurora-admin=0',
    })
    expect(debugUiOverrideJson(launch)).toMatchObject({
      enabled: true,
      surface: 'android',
      viewport: 'phone',
    })
  })
})
