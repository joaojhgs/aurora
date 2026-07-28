import type { AuroraRuntimeTier, AuroraSurfaceKind, LegacyAuroraSurfaceKind } from './runtime-profile'
export type { AuroraSurfaceKind, LegacyAuroraSurfaceKind } from './runtime-profile'

/**
 * Native shells dispatch this event when foreground media must be released
 * without tearing down the control-plane WebRTC peer.
 */
export const AURORA_RELEASE_FOCUSED_MEDIA_EVENT = 'aurora:release-focused-media'

export type AuroraSurfaceFeature =
  | 'desktopCommands'
  | 'sidecar'
  | 'ios'
  | 'android'
  | 'mobileNative'
  | 'webThin'
  | 'webrtcThin'
  | 'localOnly'

export interface AuroraSurfaceProfileInput {
  runtimeMode?: string | null | undefined
  transportKind?: string | null | undefined
  nativePlatform?: string | null | undefined
  userAgent?: string | null | undefined
}

export interface AuroraSurfaceProfile {
  /** Physical runtime surface. Product role, transport, and runtime tier are modeled separately. */
  physicalKind: AuroraSurfaceKind
  /**
   * Deprecated compatibility alias for legacy deployment labels. New code must
   * use physicalKind plus runtime profile node/connection/tier fields.
   */
  kind: LegacyAuroraSurfaceKind
  legacyKind: LegacyAuroraSurfaceKind
  deploymentKind: LegacyAuroraSurfaceKind
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
  supportsWebRtcThin: boolean
  prefersWebRtcTransport: boolean
  /**
   * The shell owns a trusted local WebView origin (for example
   * `tauri.localhost` or the loopback Vite origin used by Tauri dev).
   *
   * Callers must still restrict the accepted hostname to Aurora's local
   * WebView/loopback allowlist. This flag never makes arbitrary HTTP origins
   * secure.
   */
  trustsNativeWebViewOrigin: boolean
  /** Local service configuration is owned by this client, not a remote peer. */
  canManageLocalServiceConfiguration: boolean
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

  const runtimeSaysAndroid = runtimeMode.startsWith('android')
  const runtimeSaysIos = runtimeMode.startsWith('ios')
  const nativeSaysAndroid = nativePlatform.includes('android')
  const nativeSaysIos = /\b(ios|iphone|ipad|ipod)\b/.test(nativePlatform)
  const userAgentSaysAndroid = userAgent.includes('android')
  const userAgentSaysIos = /(iphone|ipad|ipod)/.test(userAgent)
  const isAndroid = runtimeSaysAndroid || (
    !runtimeSaysIos && (nativeSaysAndroid || (!nativeSaysIos && userAgentSaysAndroid))
  )
  const isIos = runtimeSaysIos || (
    !runtimeSaysAndroid && (nativeSaysIos || (!nativeSaysAndroid && userAgentSaysIos))
  )
  const runtimeSaysMobile = runtimeMode.includes('mobile') || transportKind === 'native-mobile'
  const isMobile = isAndroid || isIos || runtimeSaysMobile
  const usesLocalSidecar = runtimeMode === 'desktop-local' || transportKind === 'tauri-local'
  const isDesktopThin = runtimeMode === 'desktop-thin' || transportKind === 'tauri-thin'
  const explicitWebThin = runtimeMode === 'web' || runtimeMode === 'web-thin' || runtimeMode === 'thin-shell'
  const usesWebRtcTransport = transportKind === 'mesh' || transportKind === 'webrtc' || transportKind === 'webrtc-preferred' || transportKind === 'webrtc-only'
  const usesNativeShell = usesLocalSidecar || isDesktopThin || transportKind.startsWith('tauri') || isMobile

  const legacyKind: LegacyAuroraSurfaceKind = isAndroid
    ? 'android'
    : isIos
      ? 'ios'
      : usesLocalSidecar
        ? 'desktop-local'
        : isDesktopThin
          ? 'desktop-thin'
          : runtimeMode === 'mock' || transportKind === 'mock'
            ? 'mock'
            : explicitWebThin || transportKind === 'http'
              ? 'web'
              : isMobile
                ? 'mobile'
                : 'unknown'

  const physicalKind: AuroraSurfaceKind = physicalSurfaceKind(legacyKind)
  const isDesktop = legacyKind === 'desktop-local' || legacyKind === 'desktop-thin'
  const isWebThin = legacyKind === 'web' || legacyKind === 'desktop-thin' || (isMobile && (transportKind === 'http' || usesWebRtcTransport))
  const supportsWebRtcThin = isWebThin || isMobile
  const prefersWebRtcTransport = usesWebRtcTransport
  const trustsNativeWebViewOrigin = usesNativeShell
  const canManageLocalServiceConfiguration = usesLocalSidecar || legacyKind === 'mock'
  const voiceCapture = getAuroraVoiceCapturePolicy(legacyKind)
  return {
    physicalKind,
    kind: legacyKind,
    legacyKind,
    deploymentKind: legacyKind,
    label: surfaceLabel(legacyKind),
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
    supportsWebRtcThin,
    prefersWebRtcTransport,
    trustsNativeWebViewOrigin,
    canManageLocalServiceConfiguration,
    voiceCapture,
  }
}

export function getAuroraPhysicalSurfaceKind(
  input: AuroraSurfaceProfileInput = {},
): AuroraSurfaceKind {
  return getAuroraSurfaceProfile(input).physicalKind
}

export function surfaceSupportsRuntimeTier(
  profile: AuroraSurfaceProfile,
  runtimeTier: AuroraRuntimeTier,
  options: { packageIncludesPython?: boolean | undefined } = {},
): boolean {
  switch (runtimeTier) {
    case 'none':
      return true
    case 'lightweight-ts':
      return profile.physicalKind !== 'unknown'
    case 'python-full':
      return profile.physicalKind === 'desktop-tauri' && options.packageIncludesPython === true
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
      return profile.kind === 'web' || profile.kind === 'desktop-thin' || profile.isMobile
    case 'webrtcThin':
      return profile.supportsWebRtcThin
  }
}

export function getAuroraVoiceCapturePolicy(kind: LegacyAuroraSurfaceKind): AuroraVoiceCapturePolicy {
  switch (kind) {
    case 'desktop-local':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'coordinator-daemon',
        wakewordRequiresFocus: false,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Background listening can stay on this computer while the visible microphone button uses foreground capture.'
      }
    case 'desktop-thin':
    case 'web':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Browser capture is available only while the page is focused.'
      }
    case 'android':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Android capture is available while Aurora is open in the foreground.'
      }
    case 'ios':
    case 'mobile':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'mobile-native',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Mobile push-to-talk is available while Aurora is open. Background voice depends on device support.'
      }
    case 'mock':
    case 'unknown':
      return {
        focusedPushToTalkOwner: 'unavailable',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: false,
        avoidCoordinatorPushToTalk: true,
        detail: 'Voice capture is unavailable until microphone access is ready.'
      }
  }
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function surfaceLabel(kind: LegacyAuroraSurfaceKind): string {
  switch (kind) {
    case 'desktop-local':
    case 'desktop-thin':
      return 'Desktop app'
    case 'web':
      return 'Web app'
    case 'android':
      return 'Android app'
    case 'ios':
      return 'iOS app'
    case 'mobile':
      return 'Mobile app'
    case 'mock':
      return 'Local mode'
    case 'unknown':
      return 'Unknown surface'
  }
}

function physicalSurfaceKind(kind: LegacyAuroraSurfaceKind): AuroraSurfaceKind {
  switch (kind) {
    case 'desktop-local':
    case 'desktop-thin':
      return 'desktop-tauri'
    case 'web':
      return 'hosted-web'
    case 'android':
      return 'android'
    case 'ios':
      return 'ios'
    case 'mock':
      return 'test'
    case 'mobile':
    case 'unknown':
      return 'unknown'
  }
}
