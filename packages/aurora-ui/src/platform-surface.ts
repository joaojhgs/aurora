import type { AuroraPhysicalSurfaceKind, AuroraRuntimeTier } from './runtime-profile'

export type AuroraSurfaceKind =
  | 'desktop-local'
  | 'desktop-thin'
  | 'web'
  | 'android'
  | 'ios'
  | 'mobile'
  | 'mock'
  | 'unknown'

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
  physicalKind: AuroraPhysicalSurfaceKind
  /** Legacy deployment/surface alias retained for existing callers during the runtime-profile migration. */
  kind: AuroraSurfaceKind
  legacyKind: AuroraSurfaceKind
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
            : explicitWebThin || transportKind === 'http'
              ? 'web'
              : isMobile
                ? 'mobile'
                : 'unknown'

  const physicalKind: AuroraPhysicalSurfaceKind = physicalSurfaceKind(kind)
  const isDesktop = kind === 'desktop-local' || kind === 'desktop-thin'
  const isWebThin = kind === 'web' || kind === 'desktop-thin' || (isMobile && (transportKind === 'http' || usesWebRtcTransport))
  const supportsWebRtcThin = isWebThin || isMobile
  const prefersWebRtcTransport = usesWebRtcTransport
  const trustsNativeWebViewOrigin = usesNativeShell
  const canManageLocalServiceConfiguration = usesLocalSidecar || kind === 'mock'
  const voiceCapture = getAuroraVoiceCapturePolicy(kind)
  return {
    physicalKind,
    kind,
    legacyKind: kind,
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
    supportsWebRtcThin,
    prefersWebRtcTransport,
    trustsNativeWebViewOrigin,
    canManageLocalServiceConfiguration,
    voiceCapture,
  }
}

export function getAuroraPhysicalSurfaceKind(
  input: AuroraSurfaceProfileInput = {},
): AuroraPhysicalSurfaceKind {
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
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        detail: 'Android thin uses focused foreground WebView microphone capture only; no durable background wakeword is claimed.'
      }
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
      return 'Local mode'
    case 'unknown':
      return 'Unknown surface'
  }
}

function physicalSurfaceKind(kind: AuroraSurfaceKind): AuroraPhysicalSurfaceKind {
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
