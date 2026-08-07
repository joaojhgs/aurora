import type { AuroraNodeMode, AuroraRuntimeTier, AuroraSurfaceKind, LegacyAuroraSurfaceKind } from './runtime-profile'
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
  nodeMode?: AuroraNodeMode | null | undefined
  runtimeTier?: AuroraRuntimeTier | null | undefined
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
  /** Aurora's native RTCPeerConnection bridge is currently packaged only on Linux desktop. */
  supportsNativeWebRtcBridge: boolean
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
  /** Product role for this surface; independent from its active transport. */
  nodeMode: AuroraNodeMode
  /** Local service tier physically available on this surface. */
  runtimeTier: AuroraRuntimeTier
  /** Mesh/device pages must project this node rather than the connected authority. */
  ownsLocalNodeState: boolean
  /** This surface is managing a connected Aurora authority instead of exposing itself. */
  isRemoteConsole: boolean
  /** Hosted web uses the browser Rust/WASM voice runtime for focused foreground capture. */
  usesBrowserVoiceRuntime: boolean
  voiceCapture: AuroraVoiceCapturePolicy
}

export type AuroraVoiceCaptureOwner = 'coordinator-daemon' | 'webview-focused' | 'mobile-native' | 'unavailable'
  | 'native-desktop'

export interface AuroraVoiceCapturePolicy {
  /** Foreground push-to-talk can capture from the WebView with getUserMedia. */
  focusedPushToTalkOwner: AuroraVoiceCaptureOwner
  /** Capability owner for wake/background voice controls; availability still comes from that owner status. */
  wakewordOwner: AuroraVoiceCaptureOwner
  /** Whether wakeword is honest only while the WebView/browser is focused. */
  wakewordRequiresFocus: boolean
  /** Whether the UI may start a WebView recorder for live waveform bars. */
  canUseWebViewVisualizer: boolean
  /** Whether the UI should avoid STTCoordinator.Listen for push-to-talk to prevent duplicate daemon events. */
  avoidCoordinatorPushToTalk: boolean
  /** Hosted web uses the browser Rust/WASM voice runtime for focused foreground capture. */
  usesBrowserVoiceRuntime: boolean
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
  const runtimeSaysNativeMobile = runtimeMode === 'mobile-native' || transportKind === 'native-mobile'
  const nativeSaysAndroid = nativePlatform.includes('android')
  const nativeSaysIos = /\b(ios|iphone|ipad|ipod)\b/.test(nativePlatform)
  const userAgentSaysAndroid = userAgent.includes('android')
  const userAgentSaysIos = /(iphone|ipad|ipod)/.test(userAgent)
  const nativeSaysLinux = /\blinux\b/.test(nativePlatform)
  const userAgentSaysLinux = userAgent.includes('linux') && !userAgentSaysAndroid
  const isAndroid = runtimeSaysAndroid || nativeSaysAndroid || (!runtimeSaysIos && !nativeSaysIos && userAgentSaysAndroid)
  const isIos = runtimeSaysIos || nativeSaysIos || (!runtimeSaysAndroid && !nativeSaysAndroid && userAgentSaysIos)
  const nativeAndroid = runtimeSaysAndroid || nativeSaysAndroid || (runtimeSaysNativeMobile && !runtimeSaysIos && !nativeSaysIos && userAgentSaysAndroid)
  const nativeIos = runtimeSaysIos || nativeSaysIos || (runtimeSaysNativeMobile && !runtimeSaysAndroid && !nativeSaysAndroid && userAgentSaysIos)
  const runtimeSaysMobile = runtimeMode.includes('mobile') || runtimeSaysNativeMobile
  const isMobile = isAndroid || isIos || runtimeSaysMobile
  const usesLocalSidecar = runtimeMode === 'desktop-local' || transportKind === 'tauri-local'
  const isDesktopThin = runtimeMode === 'desktop-thin' || transportKind === 'tauri-thin'
  const explicitWebThin = runtimeMode === 'web' || runtimeMode === 'web-thin' || runtimeMode === 'thin-shell'
  const usesWebRtcTransport = transportKind === 'mesh' || transportKind === 'webrtc' || transportKind === 'webrtc-preferred' || transportKind === 'webrtc-only'
  const usesNativeShell = usesLocalSidecar || isDesktopThin || transportKind.startsWith('tauri') || runtimeSaysNativeMobile || nativeAndroid || nativeIos
  const nodeMode: AuroraNodeMode = input.nodeMode
    ?? (usesLocalSidecar ? 'mesh-node' : 'remote-console')
  const runtimeTier: AuroraRuntimeTier = input.runtimeTier
    ?? (usesLocalSidecar ? 'python-full' : 'none')

  const legacyKind: LegacyAuroraSurfaceKind = nativeAndroid
    ? 'android'
    : nativeIos
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
  const supportsNativeWebRtcBridge = isDesktop && usesNativeShell && (
    nativeSaysLinux || userAgentSaysLinux
  )
  const isWebThin = legacyKind === 'web' || legacyKind === 'desktop-thin' || (isMobile && (transportKind === 'http' || usesWebRtcTransport))
  const supportsWebRtcThin = isWebThin || isMobile
  const prefersWebRtcTransport = usesWebRtcTransport
  const trustsNativeWebViewOrigin = usesNativeShell
  const canManageLocalServiceConfiguration = usesLocalSidecar || legacyKind === 'mock'
  const ownsLocalNodeState = nodeMode === 'mesh-node' || usesLocalSidecar
  const isRemoteConsole = !ownsLocalNodeState
  const voiceCapture = getAuroraVoiceCapturePolicy(legacyKind)
  const usesBrowserVoiceRuntime = physicalKind === 'hosted-web' && !usesNativeShell
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
    supportsMobileNative: nativeAndroid || nativeIos || runtimeSaysNativeMobile,
    supportsIosOnly: nativeIos,
    supportsAndroidOnly: nativeAndroid,
    supportsNativeWebRtcBridge,
    isWebThin,
    supportsWebRtcThin,
    prefersWebRtcTransport,
    trustsNativeWebViewOrigin,
    canManageLocalServiceConfiguration,
    nodeMode,
    runtimeTier,
    ownsLocalNodeState,
    isRemoteConsole,
    usesBrowserVoiceRuntime,
    voiceCapture: {
      ...voiceCapture,
      usesBrowserVoiceRuntime,
    },
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
        focusedPushToTalkOwner: 'native-desktop',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: false,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: false,
        detail: 'Desktop push-to-talk is available. Background voice is not available yet.'
      }
    case 'desktop-thin':
      return {
        focusedPushToTalkOwner: 'native-desktop',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: false,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: false,
        detail: 'Desktop push-to-talk is available. Background voice is not available yet.'
      }
    case 'web':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: kind === 'web',
        detail: 'Browser capture is available only while the page is focused.'
      }
    case 'android':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'webview-focused',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: false,
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
        usesBrowserVoiceRuntime: false,
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
        usesBrowserVoiceRuntime: false,
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
