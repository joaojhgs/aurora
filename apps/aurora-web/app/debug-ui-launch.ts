import type { AuroraNodeMode, AuroraRuntimeProfileV2, AuroraRuntimeTier } from '@aurora/ui'

export type AuroraDebugUiLaunchPresetDefinition = {
  readonly runtimeMode: string
  readonly nodeMode: AuroraNodeMode
  readonly runtimeTier: AuroraRuntimeTier
  readonly nativePlatform?: string
  readonly userAgent?: string
  readonly label: string
}

/**
 * Dev-only UI surface/role presets for local `next dev` quick actions.
 * Production resolution is always inert; runtime roles come from saved profiles.
 */
export const AURORA_DEBUG_UI_LAUNCH_PRESETS = {
  'web-remote': {
    runtimeMode: 'web-thin',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    label: 'Hosted web · remote console',
  },
  'web-node': {
    runtimeMode: 'web-thin',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    label: 'Hosted web · mesh node',
  },
  'desktop-local': {
    runtimeMode: 'desktop-local',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    nativePlatform: 'linux',
    label: 'Desktop native · local node',
  },
  'desktop-thin-remote': {
    runtimeMode: 'desktop-thin',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    nativePlatform: 'linux',
    label: 'Desktop thin · management UI',
  },
  'desktop-node': {
    runtimeMode: 'desktop-thin',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    nativePlatform: 'linux',
    label: 'Desktop client · mesh node',
  },
  'android-remote': {
    runtimeMode: 'android',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    nativePlatform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
    label: 'Android · remote console',
  },
  'android-node': {
    runtimeMode: 'android-node',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    nativePlatform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
    label: 'Android · mesh node',
  },
  'ios-remote': {
    runtimeMode: 'ios',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    nativePlatform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    label: 'iOS · remote console',
  },
  'ios-node': {
    runtimeMode: 'ios',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    nativePlatform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    label: 'iOS · mesh node',
  },
  'mobile-node': {
    runtimeMode: 'mobile',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    label: 'Mobile WebView · mesh node',
  },
} as const satisfies Record<string, AuroraDebugUiLaunchPresetDefinition>

export type AuroraDebugUiLaunchPresetId = keyof typeof AURORA_DEBUG_UI_LAUNCH_PRESETS

export type AuroraDebugUiLaunch = AuroraDebugUiLaunchPresetDefinition & {
  readonly preset: AuroraDebugUiLaunchPresetId
  readonly enabled: true
}

const DEBUG_FLAG_ENV = 'NEXT_PUBLIC_AURORA_DEBUG_UI'
const DEBUG_PRESET_ENV = 'NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET'
const DEBUG_GATEWAY_URL = 'http://127.0.0.1:8000'
const DEBUG_SIGNALING_URL = 'ws://127.0.0.1:8000/ws/signaling'

export function isAuroraDebugUiLaunchPresetId(value: string): value is AuroraDebugUiLaunchPresetId {
  return Object.prototype.hasOwnProperty.call(AURORA_DEBUG_UI_LAUNCH_PRESETS, value)
}

export function listAuroraDebugUiLaunchPresetIds(): AuroraDebugUiLaunchPresetId[] {
  return Object.keys(AURORA_DEBUG_UI_LAUNCH_PRESETS) as AuroraDebugUiLaunchPresetId[]
}

export function resolveAuroraDebugUiLaunch(
  env: NodeJS.ProcessEnv = process.env,
): AuroraDebugUiLaunch | null {
  if (!isDebugUiLaunchEnabled(env)) return null

  const presetId = normalize(env[DEBUG_PRESET_ENV])
  if (presetId && isAuroraDebugUiLaunchPresetId(presetId)) {
    return {
      preset: presetId,
      enabled: true,
      ...AURORA_DEBUG_UI_LAUNCH_PRESETS[presetId],
    }
  }
  return null
}

export function applyDebugUiLaunchToRuntimeProfile(
  launch: AuroraDebugUiLaunch,
  stored: AuroraRuntimeProfileV2 | undefined,
): AuroraRuntimeProfileV2 {
  const profileId = `ui-launch-${launch.preset}`
  const existing = stored?.id === profileId ? stored : undefined
  const existingLocalNode = existing?.localNode
  const enabledCapabilityPacks = launch.nodeMode === 'mesh-node'
    ? uniqueCapabilityPacks([
      ...(existingLocalNode?.enabledCapabilityPacks ?? []),
      'native-actions',
      'local-tools',
      'foreground-voice',
    ])
    : []

  return {
    version: 2,
    id: profileId,
    label: 'This device',
    nodeMode: launch.nodeMode,
    runtimeTier: launch.runtimeTier,
    ...(launch.nodeMode === 'remote-console'
      ? {
        homeConnection: existing?.homeConnection ?? {
          mode: 'http-only' as const,
          gatewayUrl: DEBUG_GATEWAY_URL,
        },
      }
      : existing?.homeConnection
        ? { homeConnection: existing.homeConnection }
        : {}),
    localNode: {
      nodeName: 'This device',
      stablePeerId: existingLocalNode?.stablePeerId ?? `${profileId}-peer`,
      enabledCapabilityPacks,
      ...(existingLocalNode?.localSpeechPackState
        ? { localSpeechPackState: existingLocalNode.localSpeechPackState }
        : {}),
      ...(existingLocalNode?.localSpeechSelection
        ? { localSpeechSelection: existingLocalNode.localSpeechSelection }
        : {}),
      ...(launch.nodeMode === 'mesh-node'
        ? {
          meshMembership: existingLocalNode?.meshMembership ?? {
            signalingUrl: DEBUG_SIGNALING_URL,
            webrtcProfile: {
              mode: 'webrtc-only' as const,
              appId: 'aurora',
              room: profileId,
              roomSecretRef: `ref:${profileId}`,
              signalingBrokers: [DEBUG_SIGNALING_URL],
              allowInsecureLoopbackSignaling: true,
            },
          },
        }
        : {}),
    },
  }
}

export function shellRuntimeModeFromSurfaceKind(kind: string): string {
  return kind === 'web' ? 'web-thin' : kind
}

function isDebugUiLaunchEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') return false
  if (truthy(env[DEBUG_FLAG_ENV])) return true
  return Boolean(normalize(env[DEBUG_PRESET_ENV]))
}

function uniqueCapabilityPacks(
  packs: AuroraRuntimeProfileV2['localNode']['enabledCapabilityPacks'],
): AuroraRuntimeProfileV2['localNode']['enabledCapabilityPacks'] {
  return [...new Set(packs)]
}

function normalize(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function truthy(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}
