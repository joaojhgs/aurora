import type { AuroraCapabilityPack, AuroraLocalSpeechPackState, AuroraNodeMode, AuroraRuntimeTier, AuroraSurfaceKind, LegacyAuroraSurfaceKind } from './runtime-profile'
export type { AuroraLocalSpeechPackState, AuroraSurfaceKind, LegacyAuroraSurfaceKind } from './runtime-profile'

/**
 * Native shells dispatch this event when foreground media must be released
 * without tearing down the control-plane WebRTC peer.
 */
export const AURORA_RELEASE_FOCUSED_MEDIA_EVENT = 'aurora:release-focused-media'

export type AuroraSurfaceFeature =
  | 'desktopCommands'
  | 'desktopOverlay'
  | 'localVoice'
  | 'localSettings'
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
  enabledCapabilityPacks?: readonly AuroraCapabilityPack[] | null | undefined
  localSpeechPackState?: AuroraLocalSpeechPackState | null | undefined
  localSpeechEngineCapabilities?: AuroraLocalSpeechEngineCapabilities | null | undefined
  /** The native voice adapter exists, but its route may still be unavailable. */
  nativeVoicePresent?: boolean | undefined
  nativeVoiceAvailable?: boolean | undefined
  /** Native background or hands-free voice is available with installed wake assets. */
  nativeWakewordAvailable?: boolean | undefined
}

export interface AuroraLocalSpeechEngineCapabilities {
  vad?: boolean | undefined
  kws?: boolean | undefined
  stt?: boolean | undefined
  tts?: boolean | undefined
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
  /**
   * Whether this surface can route WebRTC through Aurora's own Rust transport
   * instead of the WebView's RTCPeerConnection: a native shell on a platform
   * that compiles the transport in (linux, macos, windows, android, ios; see
   * `apps/aurora-tauri/src-tauri/Cargo.toml`). A browser tab never has it.
   */
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
  /** Product-safe state for on-device speech assets; this never implies browser capture can run local VAD/KWS/STT/TTS. */
  localSpeechPack: AuroraLocalSpeechPackStatus
  voiceCapture: AuroraVoiceCapturePolicy
}

export type AuroraVoiceCaptureOwner = 'coordinator-daemon' | 'webview-focused' | 'mobile-native' | 'unavailable'
  | 'native-desktop'

export interface AuroraLocalSpeechPackStatus {
  state: AuroraLocalSpeechPackState
  availabilityState: 'ready' | 'pending' | 'degraded' | 'unsupported'
  label: string
  detail: string
  blockers: string[]
  canRunLocalVad: boolean
  canRunLocalKws: boolean
  canRunLocalStt: boolean
  canRunLocalTts: boolean
}

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
    ?? 'remote-console'
  const runtimeTier: AuroraRuntimeTier = input.runtimeTier
    ?? 'none'
  const enabledCapabilityPacks = input.enabledCapabilityPacks ?? []

  const legacyKind: LegacyAuroraSurfaceKind = nativeAndroid
    ? 'android'
    : nativeIos
      ? 'ios'
      : usesLocalSidecar
        ? 'desktop-local'
        : isDesktopThin
          ? 'desktop-thin'
          : runtimeMode === 'mock' || (transportKind === 'mock' && !runtimeMode)
            ? 'mock'
            : explicitWebThin || transportKind === 'http'
              ? 'web'
              : isMobile
                ? 'mobile'
                : 'unknown'

  const physicalKind: AuroraSurfaceKind = physicalSurfaceKind(legacyKind)
  const isDesktop = legacyKind === 'desktop-local' || legacyKind === 'desktop-thin'
  const supportsNativeWebRtcBridge = usesNativeShell && (isDesktop || nativeAndroid || nativeIos)
  const isWebThin = legacyKind === 'web' || legacyKind === 'desktop-thin' || (isMobile && (transportKind === 'http' || usesWebRtcTransport))
  const supportsWebRtcThin = isWebThin || isMobile
  const prefersWebRtcTransport = usesWebRtcTransport
  const trustsNativeWebViewOrigin = usesNativeShell
  const ownsLocalNodeState = nodeMode === 'mesh-node'
  const canManageLocalServiceConfiguration = legacyKind === 'mock' || (ownsLocalNodeState && usesLocalSidecar)
  const isRemoteConsole = !ownsLocalNodeState
  const usesBrowserVoiceRuntime = physicalKind === 'hosted-web' && !usesNativeShell
  const localSpeechPack = resolveAuroraLocalSpeechPack({
    requestedState: input.localSpeechPackState ?? undefined,
    runtimeTier,
    enabledCapabilityPacks,
    engineCapabilities: input.localSpeechEngineCapabilities ?? undefined,
  })
  const voiceCapture = getAuroraVoiceCapturePolicy(legacyKind, {
    nativeVoicePresent: input.nativeVoicePresent === true,
    nativeVoiceAvailable: input.nativeVoiceAvailable === true,
    nativeWakewordAvailable: input.nativeWakewordAvailable === true,
    localSpeechPack,
  })
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
    localSpeechPack,
    voiceCapture: {
      ...voiceCapture,
      usesBrowserVoiceRuntime,
    },
  }
}

export function resolveAuroraLocalSpeechPack(input: {
  requestedState?: AuroraLocalSpeechPackState | undefined
  runtimeTier: AuroraRuntimeTier
  enabledCapabilityPacks?: readonly AuroraCapabilityPack[] | null | undefined
  engineCapabilities?: AuroraLocalSpeechEngineCapabilities | null | undefined
}): AuroraLocalSpeechPackStatus {
  const requestedState = input.requestedState && isAuroraLocalSpeechPackState(input.requestedState)
    ? input.requestedState
    : null
  const foregroundVoiceEnabled = input.enabledCapabilityPacks?.includes('foreground-voice') === true
  const engines = input.engineCapabilities ?? {}
  const engineCapabilityPresent = engines.vad === true || engines.kws === true || engines.stt === true || engines.tts === true
  const localSpeechAllowed = foregroundVoiceEnabled || engineCapabilityPresent
  const state: AuroraLocalSpeechPackState = requestedState
    ?? (!localSpeechAllowed ? 'disabled' : 'unavailable')
  const availabilityState = localSpeechAvailabilityState(state)
  const canRunLocalEngine = localSpeechAllowed && state === 'ready'
  return {
    state,
    availabilityState,
    label: 'On-device speech',
    detail: localSpeechPackDetail(state),
    blockers: localSpeechPackBlockers(state),
    canRunLocalVad: canRunLocalEngine && engines.vad === true,
    canRunLocalKws: canRunLocalEngine && engines.kws === true,
    canRunLocalStt: canRunLocalEngine && engines.stt === true,
    canRunLocalTts: canRunLocalEngine && engines.tts === true,
  }
}

function isAuroraLocalSpeechPackState(value: string): value is AuroraLocalSpeechPackState {
  return value === 'disabled'
    || value === 'downloading'
    || value === 'incompatible'
    || value === 'over-budget'
    || value === 'ready'
    || value === 'unavailable'
}

function localSpeechAvailabilityState(state: AuroraLocalSpeechPackState): AuroraLocalSpeechPackStatus['availabilityState'] {
  if (state === 'ready') return 'ready'
  if (state === 'downloading') return 'pending'
  if (state === 'over-budget') return 'degraded'
  return 'unsupported'
}

function localSpeechPackDetail(state: AuroraLocalSpeechPackState): string {
  switch (state) {
    case 'downloading':
      return 'On-device speech is still being prepared.'
    case 'incompatible':
      return 'On-device speech is not compatible with this device.'
    case 'over-budget':
      return 'On-device speech needs more available storage or memory before it can run.'
    case 'ready':
      return 'On-device speech is ready.'
    case 'unavailable':
      return 'On-device speech is unavailable on this device right now.'
    case 'disabled':
      return 'On-device speech is turned off on this device.'
  }
}

function localSpeechPackBlockers(state: AuroraLocalSpeechPackState): string[] {
  switch (state) {
    case 'downloading':
      return ['local_speech_downloading']
    case 'incompatible':
      return ['local_speech_incompatible']
    case 'over-budget':
      return ['local_speech_over_budget']
    case 'ready':
      return []
    case 'unavailable':
      return ['local_speech_unavailable']
    case 'disabled':
      return ['local_speech_disabled']
  }
}

/**
 * Best-effort runtimeMode when a host only has the SDK transport kind.
 * Prefer passing an explicit runtimeMode from the saved profile.
 */
export function runtimeModeFromTransportKind(transportKind: string | null | undefined): string {
  const kind = normalize(transportKind)
  if (kind === 'tauri-local') return 'desktop-local'
  if (kind === 'tauri-thin') return 'desktop-thin'
  if (kind === 'native-mobile') return 'mobile-native'
  if (kind === 'mock') return 'mock'
  if (kind === 'mesh' || kind === 'webrtc' || kind === 'webrtc-preferred' || kind === 'webrtc-only') return 'web-thin'
  if (kind === 'http') return 'web-thin'
  return 'web-thin'
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

/**
 * Local This-device Settings belong on native shells and on hosted web only
 * when this browser is itself a mesh node. Hosted web remote consoles manage
 * the connected Aurora through Operate, not a local Settings page.
 */
export function surfaceOwnsLocalSettings(profile: AuroraSurfaceProfile): boolean {
  if (profile.isDesktop && profile.usesNativeShell) return true
  if (profile.supportsMobileNative) return true
  return profile.physicalKind === 'hosted-web' && profile.ownsLocalNodeState
}

export function shouldShowForSurface(profile: AuroraSurfaceProfile, feature: AuroraSurfaceFeature): boolean {
  switch (feature) {
    case 'desktopCommands':
      return profile.supportsDesktopCommands
    case 'desktopOverlay':
      return profile.isDesktop && profile.usesNativeShell
    case 'localSettings':
      return surfaceOwnsLocalSettings(profile)
    case 'localVoice':
      return profile.voiceCapture.focusedPushToTalkOwner !== 'unavailable'
        || profile.voiceCapture.wakewordOwner !== 'unavailable'
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

export function getAuroraVoiceCapturePolicy(
  kind: LegacyAuroraSurfaceKind,
  options: {
    nativeVoicePresent?: boolean
    nativeVoiceAvailable?: boolean
    nativeWakewordAvailable?: boolean
    localSpeechPack?: AuroraLocalSpeechPackStatus
  } = {},
): AuroraVoiceCapturePolicy {
  const nativeWakewordReady = options.nativeWakewordAvailable === true
    && options.localSpeechPack?.canRunLocalVad === true
    && options.localSpeechPack.canRunLocalKws === true
  switch (kind) {
    case 'desktop-local':
      if (nativeWakewordReady) {
        return {
          focusedPushToTalkOwner: 'native-desktop',
          wakewordOwner: 'native-desktop',
          wakewordRequiresFocus: false,
          canUseWebViewVisualizer: false,
          avoidCoordinatorPushToTalk: true,
          usesBrowserVoiceRuntime: false,
          detail: 'Desktop voice can listen while Aurora is running.'
        }
      }
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
      if (nativeWakewordReady) {
        return {
          focusedPushToTalkOwner: 'native-desktop',
          wakewordOwner: 'native-desktop',
          wakewordRequiresFocus: false,
          canUseWebViewVisualizer: false,
          avoidCoordinatorPushToTalk: true,
          usesBrowserVoiceRuntime: false,
          detail: 'Desktop voice can listen while Aurora is running.'
        }
      }
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
      if (options.nativeVoiceAvailable === true) {
        if (nativeWakewordReady) {
          return {
            focusedPushToTalkOwner: 'mobile-native',
            wakewordOwner: 'mobile-native',
            wakewordRequiresFocus: false,
            canUseWebViewVisualizer: false,
            avoidCoordinatorPushToTalk: true,
            usesBrowserVoiceRuntime: false,
            detail: 'Android voice can listen while Aurora is active on this device.'
          }
        }
        return {
          focusedPushToTalkOwner: 'mobile-native',
          wakewordOwner: 'unavailable',
          wakewordRequiresFocus: true,
          canUseWebViewVisualizer: false,
          avoidCoordinatorPushToTalk: true,
          usesBrowserVoiceRuntime: false,
          detail: 'Android push-to-talk uses the device microphone. Hands-free voice is unavailable on this device.'
        }
      }
      if (options.nativeVoicePresent === true) {
        return {
          focusedPushToTalkOwner: 'unavailable',
          wakewordOwner: 'unavailable',
          wakewordRequiresFocus: true,
          canUseWebViewVisualizer: false,
          avoidCoordinatorPushToTalk: true,
          usesBrowserVoiceRuntime: false,
          detail: 'Voice capture is unavailable on this device right now.'
        }
      }
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: false,
        detail: 'Android push-to-talk is available while Aurora is open. Hands-free voice is unavailable on this device.'
      }
    case 'ios':
      if (options.nativeVoiceAvailable === true) {
        if (nativeWakewordReady) {
          return {
            focusedPushToTalkOwner: 'mobile-native',
            wakewordOwner: 'mobile-native',
            wakewordRequiresFocus: false,
            canUseWebViewVisualizer: false,
            avoidCoordinatorPushToTalk: true,
            usesBrowserVoiceRuntime: false,
            detail: 'iOS voice can keep listening during a listening session you start.'
          }
        }
        return {
          focusedPushToTalkOwner: 'mobile-native',
          wakewordOwner: 'unavailable',
          wakewordRequiresFocus: true,
          canUseWebViewVisualizer: false,
          avoidCoordinatorPushToTalk: true,
          usesBrowserVoiceRuntime: false,
          detail: 'iOS push-to-talk uses the device microphone. Hands-free voice is unavailable on this device.'
        }
      }
      return {
        focusedPushToTalkOwner: 'unavailable',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: false,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: false,
        detail: 'Voice capture is unavailable on this device right now.'
      }
    case 'mobile':
      return {
        focusedPushToTalkOwner: 'webview-focused',
        wakewordOwner: 'unavailable',
        wakewordRequiresFocus: true,
        canUseWebViewVisualizer: true,
        avoidCoordinatorPushToTalk: true,
        usesBrowserVoiceRuntime: false,
        detail: 'Mobile push-to-talk is available while Aurora is open. Background voice is unavailable on this device.'
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
