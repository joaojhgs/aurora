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
  isWebThin: boolean
  voiceCapture: AuroraVoiceCapturePolicy
}

export type AuroraVoiceCaptureOwner = 'coordinator-daemon' | 'webview-focused' | 'mobile-native' | 'unavailable'

export interface AuroraVoiceCapturePolicy {
  /** Foreground push-to-talk can capture from the WebView with getUserMedia. */
  focusedPushToTalkOwner: AuroraVoiceCaptureOwner
  /** Wakeword owner for this surface. Desktop-local stays daemon-owned to avoid duplicate events. */
  wakewordOwner: AuroraVoiceCaptureOwner
  /** Whether wakeword is honest only while the WebView/browser is focused. */
  wakewordRequiresFocus: boolean
  /** Whether the UI may start a WebView recorder for live waveform bars. */
  canUseWebViewVisualizer: boolean
  /** Whether the UI should avoid STTCoordinator.Listen for push-to-talk to prevent duplicate daemon events. */
  avoidCoordinatorPushToTalk: boolean
  /** Short operator-facing note for settings/voice copy. */
  detail: string
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
  const isWebThin = kind === 'web' || kind === 'desktop-thin'
  const voiceCapture = getAuroraVoiceCapturePolicy(kind)
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
    isWebThin,
    voiceCapture,
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

export function getAuroraVoiceCapturePolicy(kind: AuroraSurfaceKind): AuroraVoiceCapturePolicy {
  switch (kind) {
    case 'desktop-local':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'coordinator-daemon',
        wakewordRequiresFocus: false,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Desktop local uses STTCoordinator for daemon wakeword; focused push-to-talk uses WebView microphone capture to avoid duplicate wake/listen events.'
      }
    case 'desktop-thin':
    case 'web':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Thin web capture uses browser getUserMedia only while the page is focused; audio is sent through SDK/Gateway contracts.'
      }
    case 'android':
    case 'ios':
    case 'mobile':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'mobile-native',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Mobile push-to-talk can use focused WebView capture now; durable wake/background capture requires the platform-native mobile adapter.'
      }
    case 'mock':
    case 'unknown':
      return {
        focusedPushToTalkOwner: 'unavailable',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: false,
        avoidCoordinatorPushToTalk: true,
        detail: 'Voice capture is unavailable until the runtime surface is known and microphone permission is granted.'
      }
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
