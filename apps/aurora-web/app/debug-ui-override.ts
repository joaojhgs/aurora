/**
 * Dev-only runtime override for UI surface, role, admin, and viewport frame.
 *
 * Query contract (kept on `/` so product routes stay `/mesh`, `/settings`, …):
 *   aurora-surface=web|desktop-local|desktop-thin|android|ios
 *   aurora-role=remote-console|mesh-node|python-full
 *   aurora-admin=0|1
 *   aurora-viewport=phone|tablet|full
 *
 * Viewport is independent of surface/role. Mobile surfaces (android/ios/mobile)
 * default to `phone` when the param is omitted; desktop/web default to `full`.
 * Persistence: same values in the `aurora-debug-ui` cookie and sessionStorage.
 * Production (`NODE_ENV === 'production'`) ignores query, cookie, and storage.
 */

export const AURORA_DEBUG_UI_QUERY_SURFACE = 'aurora-surface'
export const AURORA_DEBUG_UI_QUERY_ROLE = 'aurora-role'
export const AURORA_DEBUG_UI_QUERY_ADMIN = 'aurora-admin'
export const AURORA_DEBUG_UI_QUERY_VIEWPORT = 'aurora-viewport'
export const AURORA_DEBUG_UI_COOKIE_NAME = 'aurora-debug-ui'
export const AURORA_DEBUG_UI_STORAGE_KEY = 'aurora-debug-ui'
export const AURORA_DEBUG_UI_OVERRIDE_EVENT = 'aurora-debug-ui-override'
export const AURORA_DEBUG_UI_ROOT_ID = 'aurora-debug-ui-root'
export const AURORA_DEBUG_VIEWPORT_ROOT_ID = 'aurora-debug-viewport-root'
export const AURORA_DEBUG_COMPACT_ATTR = 'data-aurora-debug-compact'

export const AURORA_DEBUG_UI_SURFACES = [
  'web',
  'desktop-local',
  'desktop-thin',
  'android',
  'ios',
  'mobile',
] as const

export const AURORA_DEBUG_UI_ROLES = [
  'remote-console',
  'mesh-node',
  'python-full',
] as const

export const AURORA_DEBUG_UI_VIEWPORTS = [
  'full',
  'tablet',
  'phone',
] as const

export type AuroraDebugUiSurface = (typeof AURORA_DEBUG_UI_SURFACES)[number]
export type AuroraDebugUiRole = (typeof AURORA_DEBUG_UI_ROLES)[number]
export type AuroraDebugUiViewport = (typeof AURORA_DEBUG_UI_VIEWPORTS)[number]

export type AuroraDebugUiViewportSize = {
  readonly width: number
  readonly height: number
}

export const AURORA_DEBUG_UI_VIEWPORT_PRESETS: Record<
  Exclude<AuroraDebugUiViewport, 'full'>,
  AuroraDebugUiViewportSize
> = {
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
}

export type AuroraDebugUiOverride = {
  readonly surface: AuroraDebugUiSurface
  readonly role: AuroraDebugUiRole
  readonly admin: boolean
  readonly viewport: AuroraDebugUiViewport
  readonly viewportExplicit: boolean
}

export const AURORA_DEBUG_UI_DEFAULT_OVERRIDE: AuroraDebugUiOverride = {
  surface: 'web',
  role: 'remote-console',
  admin: false,
  viewport: 'full',
  viewportExplicit: false,
}

const SURFACE_ALIASES: Record<string, AuroraDebugUiSurface> = {
  web: 'web',
  'web-thin': 'web',
  'hosted-web': 'web',
  'thin-shell': 'web',
  'desktop-local': 'desktop-local',
  'desktop-thin': 'desktop-thin',
  android: 'android',
  'android-node': 'android',
  ios: 'ios',
  'ios-node': 'ios',
  mobile: 'mobile',
}

const ROLE_ALIASES: Record<string, AuroraDebugUiRole> = {
  'remote-console': 'remote-console',
  connect: 'remote-console',
  'connect-to-aurora': 'remote-console',
  'mesh-node': 'mesh-node',
  'make-this-device-available': 'mesh-node',
  'python-full': 'python-full',
  'run-aurora-on-this-computer': 'python-full',
}

const VIEWPORT_ALIASES: Record<string, AuroraDebugUiViewport> = {
  full: 'full',
  none: 'full',
  desktop: 'full',
  tablet: 'tablet',
  ipad: 'tablet',
  phone: 'phone',
  mobile: 'phone',
  iphone: 'phone',
}

export function isAuroraDebugUiProductionEnv(nodeEnv: string | undefined): boolean {
  return (nodeEnv ?? '').trim().toLowerCase() === 'production'
}

export function isAuroraDebugUiSurface(value: string): value is AuroraDebugUiSurface {
  return (AURORA_DEBUG_UI_SURFACES as readonly string[]).includes(value)
}

export function isAuroraDebugUiRole(value: string): value is AuroraDebugUiRole {
  return (AURORA_DEBUG_UI_ROLES as readonly string[]).includes(value)
}

export function isAuroraDebugUiViewport(value: string): value is AuroraDebugUiViewport {
  return (AURORA_DEBUG_UI_VIEWPORTS as readonly string[]).includes(value)
}

export function isMobileAuroraDebugUiSurface(surface: AuroraDebugUiSurface): boolean {
  return surface === 'android' || surface === 'ios' || surface === 'mobile'
}

export function defaultAuroraDebugUiViewport(surface: AuroraDebugUiSurface): AuroraDebugUiViewport {
  return isMobileAuroraDebugUiSurface(surface) ? 'phone' : 'full'
}

export function auroraDebugUiViewportPreset(
  viewport: AuroraDebugUiViewport,
): AuroraDebugUiViewportSize | null {
  if (viewport === 'full') return null
  return AURORA_DEBUG_UI_VIEWPORT_PRESETS[viewport]
}

export function parseAuroraDebugUiSurface(value: string | null | undefined): AuroraDebugUiSurface | null {
  const normalized = normalize(value)
  return SURFACE_ALIASES[normalized] ?? null
}

export function parseAuroraDebugUiRole(value: string | null | undefined): AuroraDebugUiRole | null {
  const normalized = normalize(value)
  return ROLE_ALIASES[normalized] ?? null
}

export function parseAuroraDebugUiAdmin(value: string | null | undefined): boolean | null {
  if (value == null || value.trim() === '') return null
  const normalized = normalize(value)
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
  return null
}

export function parseAuroraDebugUiViewport(value: string | null | undefined): AuroraDebugUiViewport | null {
  const normalized = normalize(value)
  return VIEWPORT_ALIASES[normalized] ?? null
}

export function parseAuroraDebugUiOverride(
  source: string | URLSearchParams | null | undefined,
): AuroraDebugUiOverride | null {
  const params = toSearchParams(source)
  if (!params) return null
  const surface = parseAuroraDebugUiSurface(params.get(AURORA_DEBUG_UI_QUERY_SURFACE))
  const role = parseAuroraDebugUiRole(params.get(AURORA_DEBUG_UI_QUERY_ROLE))
  const admin = parseAuroraDebugUiAdmin(params.get(AURORA_DEBUG_UI_QUERY_ADMIN))
  const viewport = parseAuroraDebugUiViewport(params.get(AURORA_DEBUG_UI_QUERY_VIEWPORT))
  if (surface == null && role == null && admin == null && viewport == null) return null
  const resolvedSurface = surface ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE.surface
  return {
    surface: resolvedSurface,
    role: role ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE.role,
    admin: admin ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE.admin,
    viewport: viewport ?? defaultAuroraDebugUiViewport(resolvedSurface),
    viewportExplicit: viewport != null,
  }
}

export function parseAuroraDebugUiOverrideFromCookie(
  cookieHeader: string | null | undefined,
): AuroraDebugUiOverride | null {
  const raw = readCookieValue(cookieHeader, AURORA_DEBUG_UI_COOKIE_NAME)
  if (!raw) return null
  try {
    return parseAuroraDebugUiOverride(decodeURIComponent(raw))
  } catch {
    return parseAuroraDebugUiOverride(raw)
  }
}

export function serializeAuroraDebugUiOverride(override: AuroraDebugUiOverride): string {
  const params = new URLSearchParams()
  params.set(AURORA_DEBUG_UI_QUERY_SURFACE, override.surface)
  params.set(AURORA_DEBUG_UI_QUERY_ROLE, override.role)
  params.set(AURORA_DEBUG_UI_QUERY_ADMIN, override.admin ? '1' : '0')
  if (override.viewportExplicit) {
    params.set(AURORA_DEBUG_UI_QUERY_VIEWPORT, override.viewport)
  }
  return params.toString()
}

export function auroraDebugUiOverrideSearch(override: AuroraDebugUiOverride): string {
  return `?${serializeAuroraDebugUiOverride(override)}`
}

export function mergeAuroraDebugUiOverride(
  current: AuroraDebugUiOverride | null | undefined,
  patch: Partial<AuroraDebugUiOverride>,
): AuroraDebugUiOverride {
  const surface = patch.surface ?? current?.surface ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE.surface
  const surfaceChanged = patch.surface != null && patch.surface !== current?.surface
  const patchSetsViewport = patch.viewport != null
  const currentExplicit = current?.viewportExplicit === true
  const currentMatchesOldDefault = current != null
    && current.viewport === defaultAuroraDebugUiViewport(current.surface)
  let viewport: AuroraDebugUiViewport
  let viewportExplicit: boolean
  if (patchSetsViewport) {
    viewport = patch.viewport
    viewportExplicit = true
  } else if (surfaceChanged && (!currentExplicit || currentMatchesOldDefault)) {
    viewport = defaultAuroraDebugUiViewport(surface)
    viewportExplicit = false
  } else {
    viewport = current?.viewport ?? defaultAuroraDebugUiViewport(surface)
    viewportExplicit = currentExplicit
  }
  return {
    surface,
    role: patch.role ?? current?.role ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE.role,
    admin: patch.admin ?? current?.admin ?? AURORA_DEBUG_UI_DEFAULT_OVERRIDE.admin,
    viewport,
    viewportExplicit,
  }
}

export function resolveAuroraDebugUiOverride(input: {
  nodeEnv?: string
  search?: string | URLSearchParams | null
  cookie?: string | null
  sessionStorage?: string | null
} = {}): AuroraDebugUiOverride | null {
  if (isAuroraDebugUiProductionEnv(input.nodeEnv)) return null
  return parseAuroraDebugUiOverride(input.search)
    ?? parseAuroraDebugUiOverrideFromCookie(input.cookie)
    ?? parseAuroraDebugUiOverride(input.sessionStorage)
}

export function readBrowserAuroraDebugUiSources(): {
  search?: string
  cookie?: string
  sessionStorage?: string | null
} {
  if (typeof window === 'undefined') return {}
  return {
    search: window.location.search,
    cookie: typeof document === 'undefined' ? undefined : document.cookie,
    sessionStorage: readSessionStorage(),
  }
}

export function persistAuroraDebugUiOverride(
  override: AuroraDebugUiOverride,
  location: Pick<Location, 'pathname' | 'search' | 'hash'> | null = typeof window === 'undefined' ? null : window.location,
): AuroraDebugUiOverride {
  const serialized = serializeAuroraDebugUiOverride(override)
  writeSessionStorage(serialized)
  writeCookie(serialized)
  if (typeof window !== 'undefined' && location) {
    const url = `${location.pathname}${auroraDebugUiOverrideSearch(override)}${location.hash}`
    window.history.replaceState(window.history.state, '', url)
  }
  return override
}

export function preserveAuroraDebugUiSearch(href: string, currentSearch = typeof window === 'undefined' ? '' : window.location.search): string {
  const next = new URL(href, 'http://aurora.local')
  const current = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch)
  for (const key of [
    AURORA_DEBUG_UI_QUERY_SURFACE,
    AURORA_DEBUG_UI_QUERY_ROLE,
    AURORA_DEBUG_UI_QUERY_ADMIN,
    AURORA_DEBUG_UI_QUERY_VIEWPORT,
  ]) {
    const value = current.get(key)
    if (value && !next.searchParams.has(key)) next.searchParams.set(key, value)
  }
  return `${next.pathname}${next.search}${next.hash}`
}

function toSearchParams(source: string | URLSearchParams | null | undefined): URLSearchParams | null {
  if (!source) return null
  if (source instanceof URLSearchParams) return source
  const trimmed = source.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('?') || trimmed.includes('=')) {
    return new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed)
  }
  return null
}

function readCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.split('=')
    if (rawName?.trim() !== name) continue
    return rest.join('=').trim()
  }
  return null
}

function writeCookie(value: string): void {
  if (typeof document === 'undefined') return
  document.cookie = `${AURORA_DEBUG_UI_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; SameSite=Lax`
}

function readSessionStorage(): string | null {
  try {
    return window.sessionStorage.getItem(AURORA_DEBUG_UI_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeSessionStorage(value: string): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(AURORA_DEBUG_UI_STORAGE_KEY, value)
  } catch {
    // Ignore quota / private-mode failures; cookie + query still apply.
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}
