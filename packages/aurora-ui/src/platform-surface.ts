export type AuroraSurfaceKind =
  | 'desktop-local'
  | 'desktop-thin'
  | 'web'
  | 'android'
  | 'ios'
  | 'mobile'
  | 'mock'
  | 'unknown'

export type AuroraSurfaceFeature =
  | 'desktopCommands'
  | 'sidecar'
  | 'ios'
  | 'android'
  | 'mobileNative'
  | 'webThin'
  | 'localOnly'

export interface AuroraSurfaceProfileInput {
  runtimeMode?: string | null | undefined
  transportKind?: string | null | undefined
  nativePlatform?: string | null | undefined
  userAgent?: string | null | undefined
}

export interface AuroraSurfaceProfile {
  kind: AuroraSurfaceKind
  label: string
  isDesktop: boolean
  isMobile: boolean
  isAndroid: boolean
  isIos: boolean
  usesLocalSidecar: boolean
  usesNativeShell: boolean
  supportsDesktopCommands: boolean
  supportsMobileNative: boolean
  supportsIosOnly: boolean
  supportsAndroidOnly: boolean
}

export function getAuroraSurfaceProfile(input: AuroraSurfaceProfileInput = {}): AuroraSurfaceProfile {
  const runtimeMode = normalize(input.runtimeMode)
  const transportKind = normalize(input.transportKind)
  const nativePlatform = normalize(input.nativePlatform)
  const userAgent = normalize(input.userAgent)

  const isAndroid = nativePlatform.includes('android') || userAgent.includes('android')
  const isIos = /\b(ios|iphone|ipad|ipod)\b/.test(nativePlatform) || /(iphone|ipad|ipod)/.test(userAgent)
  const runtimeSaysMobile = runtimeMode.includes('mobile') || transportKind === 'native-mobile'
  const isMobile = isAndroid || isIos || runtimeSaysMobile
  const usesLocalSidecar = runtimeMode === 'desktop-local' || transportKind === 'tauri-local'
  const isDesktopThin = runtimeMode === 'desktop-thin' || transportKind === 'tauri-thin'
  const usesNativeShell = usesLocalSidecar || isDesktopThin || transportKind.startsWith('tauri') || isMobile

  const kind: AuroraSurfaceKind = isAndroid
    ? 'android'
    : isIos
      ? 'ios'
      : usesLocalSidecar
        ? 'desktop-local'
        : isDesktopThin
          ? 'desktop-thin'
          : runtimeMode === 'mock' || transportKind === 'mock'
            ? 'mock'
            : transportKind === 'http'
              ? 'web'
              : isMobile
                ? 'mobile'
                : 'unknown'

  const isDesktop = kind === 'desktop-local' || kind === 'desktop-thin'
  return {
    kind,
    label: surfaceLabel(kind),
    isDesktop,
    isMobile,
    isAndroid,
    isIos,
    usesLocalSidecar,
    usesNativeShell,
    supportsDesktopCommands: usesLocalSidecar,
    supportsMobileNative: isMobile,
    supportsIosOnly: isIos,
    supportsAndroidOnly: isAndroid,
  }
}

export function shouldShowForSurface(profile: AuroraSurfaceProfile, feature: AuroraSurfaceFeature): boolean {
  switch (feature) {
    case 'desktopCommands':
      return profile.supportsDesktopCommands
    case 'sidecar':
    case 'localOnly':
      return profile.usesLocalSidecar
    case 'ios':
      return profile.supportsIosOnly
    case 'android':
      return profile.supportsAndroidOnly
    case 'mobileNative':
      return profile.supportsMobileNative
    case 'webThin':
      return profile.kind === 'web' || profile.kind === 'desktop-thin'
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function surfaceLabel(kind: AuroraSurfaceKind): string {
  switch (kind) {
    case 'desktop-local':
      return 'Desktop local'
    case 'desktop-thin':
      return 'Desktop thin'
    case 'web':
      return 'Web thin'
    case 'android':
      return 'Android thin'
    case 'ios':
      return 'iOS thin'
    case 'mobile':
      return 'Mobile thin'
    case 'mock':
      return 'Demo mode'
    case 'unknown':
      return 'Unknown surface'
  }
}
