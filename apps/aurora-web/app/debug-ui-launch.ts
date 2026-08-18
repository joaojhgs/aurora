import type { AuroraNodeMode, AuroraRuntimeProfileV2, AuroraRuntimeTier, RuntimeProfileValidationOptions } from '@aurora/ui'
import {
  isAuroraDebugUiProductionEnv,
  parseAuroraDebugUiOverride,
  parseAuroraDebugUiOverrideFromCookie,
  readBrowserAuroraDebugUiSources,
  serializeAuroraDebugUiOverride,
  defaultAuroraDebugUiViewport,
  type AuroraDebugUiOverride,
  type AuroraDebugUiRole,
  type AuroraDebugUiSurface,
  type AuroraDebugUiViewport,
} from './debug-ui-override'

export type AuroraDebugUiLaunchSessionRole = 'member' | 'admin'

export type AuroraDebugUiLaunchPresetDefinition = {
  readonly runtimeMode: string
  readonly nodeMode: AuroraNodeMode
  readonly runtimeTier: AuroraRuntimeTier
  readonly sessionRole: AuroraDebugUiLaunchSessionRole
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
    sessionRole: 'member',
    label: 'Hosted web · remote console',
  },
  'web-remote-admin': {
    runtimeMode: 'web-thin',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    sessionRole: 'admin',
    label: 'Hosted web · remote console admin',
  },
  'web-node': {
    runtimeMode: 'web-thin',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    sessionRole: 'member',
    label: 'Hosted web · mesh node',
  },
  'desktop-local': {
    runtimeMode: 'desktop-local',
    nodeMode: 'mesh-node',
    runtimeTier: 'python-full',
    sessionRole: 'member',
    nativePlatform: 'linux',
    label: 'Desktop native · local node',
  },
  'desktop-thin-remote': {
    runtimeMode: 'desktop-thin',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    sessionRole: 'member',
    nativePlatform: 'linux',
    label: 'Desktop thin · management UI',
  },
  'desktop-node': {
    runtimeMode: 'desktop-thin',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    sessionRole: 'member',
    nativePlatform: 'linux',
    label: 'Desktop client · mesh node',
  },
  'android-remote': {
    runtimeMode: 'android',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    sessionRole: 'member',
    nativePlatform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
    label: 'Android · remote console',
  },
  'android-node': {
    runtimeMode: 'android-node',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    sessionRole: 'member',
    nativePlatform: 'android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
    label: 'Android · mesh node',
  },
  'ios-remote': {
    runtimeMode: 'ios',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    sessionRole: 'member',
    nativePlatform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    label: 'iOS · remote console',
  },
  'ios-node': {
    runtimeMode: 'ios',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    sessionRole: 'member',
    nativePlatform: 'ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    label: 'iOS · mesh node',
  },
  'mobile-node': {
    runtimeMode: 'mobile',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    sessionRole: 'member',
    label: 'Mobile WebView · mesh node',
  },
} as const satisfies Record<string, AuroraDebugUiLaunchPresetDefinition>

export type AuroraDebugUiLaunchPresetId = keyof typeof AURORA_DEBUG_UI_LAUNCH_PRESETS

export type AuroraDebugUiLaunch = AuroraDebugUiLaunchPresetDefinition & {
  readonly preset: string
  readonly enabled: true
  readonly override: AuroraDebugUiOverride
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

function isDebugUiLaunchEnabled(debugEnv: { nodeEnv: string; flag: string | undefined; preset: string | undefined }): boolean {
  if (debugEnv.nodeEnv !== 'development' && debugEnv.nodeEnv !== 'test') return false
  if (truthy(debugEnv.flag)) return true
  return Boolean(normalize(debugEnv.preset))
}

function readDebugUiLaunchEnv(env: NodeJS.ProcessEnv): {
  nodeEnv: string
  flag: string | undefined
  preset: string | undefined
} {
  if (env === process.env) {
    return {
      nodeEnv: process.env.NODE_ENV ?? '',
      flag: process.env.NEXT_PUBLIC_AURORA_DEBUG_UI,
      preset: process.env.NEXT_PUBLIC_AURORA_DEBUG_UI_PRESET,
    }
  }
  return {
    nodeEnv: env.NODE_ENV ?? '',
    flag: env[DEBUG_FLAG_ENV],
    preset: env[DEBUG_PRESET_ENV],
  }
}

export type AuroraDebugUiLaunchSource = {
  env?: NodeJS.ProcessEnv
  search?: string | URLSearchParams | null
  cookie?: string | null
  sessionStorage?: string | null
  nodeEnv?: string
}

export function resolveAuroraDebugUiLaunch(
  source: NodeJS.ProcessEnv | AuroraDebugUiLaunchSource = process.env,
): AuroraDebugUiLaunch | null {
  const parsed = parseLaunchSource(source)
  if (isAuroraDebugUiProductionEnv(parsed.nodeEnv)) return null

  const override = parseAuroraDebugUiOverride(parsed.search)
    ?? parseAuroraDebugUiOverrideFromCookie(parsed.cookie)
    ?? parseAuroraDebugUiOverride(parsed.sessionStorage)
  if (override) return launchFromDebugUiOverride(override)

  if (!isDebugUiLaunchEnabled(parsed.debugEnv)) return null
  const presetId = normalize(parsed.debugEnv.preset)
  if (presetId && isAuroraDebugUiLaunchPresetId(presetId)) {
    return launchFromNamedPreset(presetId)
  }
  return null
}

export function isAuroraDebugUiPickerEnabled(
  source: NodeJS.ProcessEnv | AuroraDebugUiLaunchSource = process.env,
): boolean {
  const parsed = parseLaunchSource(source)
  if (isAuroraDebugUiProductionEnv(parsed.nodeEnv)) return false
  return truthy(parsed.debugEnv.flag)
}

export function launchFromDebugUiOverride(override: AuroraDebugUiOverride): AuroraDebugUiLaunch {
  const matched = matchNamedPreset(override)
  if (matched) {
    return {
      ...launchFromNamedPreset(matched),
      override,
    }
  }
  return {
    preset: syntheticPresetId(override),
    enabled: true,
    override,
    ...launchFieldsFromOverride(override),
    label: debugUiOverrideLabel(override),
  }
}

export function overrideFromDebugUiLaunch(
  launch: Pick<AuroraDebugUiLaunch, 'override'> | Pick<AuroraDebugUiLaunchPresetDefinition, 'runtimeMode' | 'nodeMode' | 'runtimeTier' | 'sessionRole'>,
): AuroraDebugUiOverride {
  if ('override' in launch && launch.override) return launch.override
  const definition = launch as AuroraDebugUiLaunchPresetDefinition
  const surface = surfaceFromRuntimeMode(definition.runtimeMode)
  return {
    surface,
    role: roleFromLaunch(definition),
    admin: definition.sessionRole === 'admin',
    viewport: defaultAuroraDebugUiViewport(surface),
    viewportExplicit: false,
  }
}

export function debugUiLaunchQuery(launch: AuroraDebugUiLaunch): string {
  return serializeAuroraDebugUiOverride(launch.override)
}

export function debugUiLaunchSanitizeOptions(
  launch: Pick<AuroraDebugUiLaunchPresetDefinition, 'runtimeTier'>,
): RuntimeProfileValidationOptions {
  return launch.runtimeTier === 'python-full' ? { allowPythonFull: true } : {}
}

export function debugUiLaunchSessionIsAdmin(
  launch: Pick<AuroraDebugUiLaunchPresetDefinition, 'sessionRole'>,
): boolean {
  return launch.sessionRole === 'admin'
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

export function debugUiOverrideJson(launch: AuroraDebugUiLaunch | null): {
  enabled: boolean
  surface: AuroraDebugUiSurface | null
  role: AuroraDebugUiRole | null
  admin: boolean | null
  viewport: AuroraDebugUiViewport | null
  preset: string | null
  query: string | null
} {
  if (!launch) {
    const pickerEnabled = isAuroraDebugUiPickerEnabled()
    return {
      enabled: pickerEnabled,
      surface: null,
      role: null,
      admin: null,
      viewport: null,
      preset: null,
      query: null,
    }
  }
  return {
    enabled: true,
    surface: launch.override.surface,
    role: launch.override.role,
    admin: launch.override.admin,
    viewport: launch.override.viewport,
    preset: launch.preset,
    query: debugUiLaunchQuery(launch),
  }
}

function launchFromNamedPreset(presetId: AuroraDebugUiLaunchPresetId): AuroraDebugUiLaunch {
  const definition = AURORA_DEBUG_UI_LAUNCH_PRESETS[presetId]
  return {
    preset: presetId,
    enabled: true,
    override: overrideFromDebugUiLaunch(definition),
    ...definition,
  }
}

function matchNamedPreset(override: AuroraDebugUiOverride): AuroraDebugUiLaunchPresetId | null {
  for (const presetId of listAuroraDebugUiLaunchPresetIds()) {
    const definition = AURORA_DEBUG_UI_LAUNCH_PRESETS[presetId]
    if (surfaceFromRuntimeMode(definition.runtimeMode) !== override.surface) continue
    if (roleFromLaunch(definition) !== override.role) continue
    if ((definition.sessionRole === 'admin') !== override.admin) continue
    return presetId
  }
  return null
}

function launchFieldsFromOverride(override: AuroraDebugUiOverride): AuroraDebugUiLaunchPresetDefinition {
  const roleFields = roleLaunchFields(override.role)
  const surfaceFields = surfaceLaunchFields(override.surface, override.role)
  return {
    ...surfaceFields,
    ...roleFields,
    sessionRole: override.admin ? 'admin' : 'member',
    label: debugUiOverrideLabel(override),
  }
}

function surfaceLaunchFields(
  surface: AuroraDebugUiSurface,
  role: AuroraDebugUiRole,
): Pick<AuroraDebugUiLaunchPresetDefinition, 'runtimeMode' | 'nativePlatform' | 'userAgent'> {
  switch (surface) {
    case 'web':
      return { runtimeMode: 'web-thin' }
    case 'desktop-local':
      return { runtimeMode: 'desktop-local', nativePlatform: 'linux' }
    case 'desktop-thin':
      return { runtimeMode: 'desktop-thin', nativePlatform: 'linux' }
    case 'android':
      return {
        runtimeMode: role === 'mesh-node' ? 'android-node' : 'android',
        nativePlatform: 'android',
        userAgent: AURORA_DEBUG_UI_LAUNCH_PRESETS['android-remote'].userAgent,
      }
    case 'ios':
      return {
        runtimeMode: 'ios',
        nativePlatform: 'ios',
        userAgent: AURORA_DEBUG_UI_LAUNCH_PRESETS['ios-remote'].userAgent,
      }
    case 'mobile':
      return { runtimeMode: 'mobile' }
  }
}

function roleLaunchFields(role: AuroraDebugUiRole): Pick<AuroraDebugUiLaunchPresetDefinition, 'nodeMode' | 'runtimeTier'> {
  switch (role) {
    case 'remote-console':
      return { nodeMode: 'remote-console', runtimeTier: 'none' }
    case 'mesh-node':
      return { nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts' }
    case 'python-full':
      return { nodeMode: 'mesh-node', runtimeTier: 'python-full' }
  }
}

function surfaceFromRuntimeMode(runtimeMode: string): AuroraDebugUiSurface {
  if (runtimeMode.startsWith('android')) return 'android'
  if (runtimeMode.startsWith('ios')) return 'ios'
  if (runtimeMode === 'desktop-local') return 'desktop-local'
  if (runtimeMode === 'desktop-thin') return 'desktop-thin'
  if (runtimeMode.includes('mobile')) return 'mobile'
  return 'web'
}

function roleFromLaunch(
  launch: Pick<AuroraDebugUiLaunchPresetDefinition, 'nodeMode' | 'runtimeTier'>,
): AuroraDebugUiRole {
  if (launch.runtimeTier === 'python-full') return 'python-full'
  return launch.nodeMode === 'mesh-node' ? 'mesh-node' : 'remote-console'
}

function syntheticPresetId(override: AuroraDebugUiOverride): string {
  return `${override.surface}-${override.role}${override.admin ? '-admin' : ''}`
}

function debugUiOverrideLabel(override: AuroraDebugUiOverride): string {
  const surface = override.surface === 'web' ? 'Hosted web' : override.surface
  const role = override.role === 'python-full'
    ? 'full local runtime'
    : override.role === 'mesh-node'
      ? 'mesh node'
      : 'remote console'
  return `${surface} · ${role}${override.admin ? ' admin' : ''}`
}

function parseLaunchSource(source: NodeJS.ProcessEnv | AuroraDebugUiLaunchSource): {
  nodeEnv: string
  debugEnv: { nodeEnv: string; flag: string | undefined; preset: string | undefined }
  search?: string | URLSearchParams | null
  cookie?: string | null
  sessionStorage?: string | null
} {
  const launchSource = isLaunchSource(source) ? source : { env: source }
  const env = launchSource.env ?? (isLaunchSource(source) ? process.env : source)
  const debugEnv = readDebugUiLaunchEnv(env)
  const nodeEnv = launchSource.nodeEnv ?? debugEnv.nodeEnv
  const browser = shouldReadBrowserSources(source, launchSource)
    ? readBrowserAuroraDebugUiSources()
    : {}
  return {
    nodeEnv,
    debugEnv: { ...debugEnv, nodeEnv },
    search: launchSource.search ?? browser.search,
    cookie: launchSource.cookie ?? browser.cookie,
    sessionStorage: launchSource.sessionStorage ?? browser.sessionStorage,
  }
}

function shouldReadBrowserSources(
  source: NodeJS.ProcessEnv | AuroraDebugUiLaunchSource,
  launchSource: AuroraDebugUiLaunchSource,
): boolean {
  if (source === process.env) return true
  if (!isLaunchSource(source)) return false
  return launchSource.search == null && launchSource.cookie == null && launchSource.sessionStorage == null
}

function isLaunchSource(value: NodeJS.ProcessEnv | AuroraDebugUiLaunchSource): value is AuroraDebugUiLaunchSource {
  return Object.prototype.hasOwnProperty.call(value, 'search')
    || Object.prototype.hasOwnProperty.call(value, 'cookie')
    || Object.prototype.hasOwnProperty.call(value, 'sessionStorage')
    || Object.prototype.hasOwnProperty.call(value, 'env')
    || Object.prototype.hasOwnProperty.call(value, 'nodeEnv')
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
