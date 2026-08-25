import { describe, expect, it } from 'vitest'
import { getAuroraSurfaceProfile, runtimeModeFromTransportKind, shouldShowForSurface, surfaceCanConfigureBackgroundWake } from '../src/platform-surface'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'

describe('Aurora surface profile regression coverage', () => {
  it('keeps hosted remote-console surfaces free of local service ownership', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
    })

    expect(profile.kind).toBe('web')
    expect(profile.isWebThin).toBe(true)
    expect(profile.usesLocalSidecar).toBe(false)
    expect(profile.canManageLocalServiceConfiguration).toBe(false)
    expect(profile.ownsLocalNodeState).toBe(false)
    expect(profile.isRemoteConsole).toBe(true)
    expect(profile.supportsWebRtcThin).toBe(true)
    expect(profile.prefersWebRtcTransport).toBe(true)
  })

  it('keeps Android mesh-node ownership separate from its connected WebRTC authority', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'mesh',
      nativePlatform: 'android',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
    })

    expect(profile.kind).toBe('android')
    expect(profile.isWebThin).toBe(true)
    expect(profile.nodeMode).toBe('mesh-node')
    expect(profile.runtimeTier).toBe('lightweight-ts')
    expect(profile.ownsLocalNodeState).toBe(true)
    expect(profile.isRemoteConsole).toBe(false)
    expect(profile.canManageLocalServiceConfiguration).toBe(false)
  })

  it('derives mesh peer budgets from the physical surface', () => {
    const desktop = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'webrtc-preferred',
    })
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'webrtc-preferred',
      nativePlatform: 'android',
    })
    const ios = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'webrtc-preferred',
    })

    expect(desktop.meshPeerBudget).toEqual({
      foregroundPeerLimit: null,
      backgroundPeerLimit: null,
      backgroundStandbyReason: 'connection_budget',
    })
    expect(android.meshPeerBudget).toEqual({
      foregroundPeerLimit: 8,
      backgroundPeerLimit: 2,
      backgroundStandbyReason: 'connection_budget',
    })
    expect(ios.meshPeerBudget).toEqual({
      foregroundPeerLimit: 4,
      backgroundPeerLimit: 1,
      backgroundStandbyReason: 'surface_suspended',
    })
  })

  it('keeps desktop local service ownership separate from desktop remote-console transport', () => {
    const local = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
      nodeMode: 'mesh-node',
      runtimeTier: 'python-full',
    })
    const remote = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'webrtc-preferred',
    })

    expect(local.kind).toBe('desktop-local')
    expect(local.nodeMode).toBe('mesh-node')
    expect(local.runtimeTier).toBe('python-full')
    expect(local.ownsLocalNodeState).toBe(true)
    expect(local.usesLocalSidecar).toBe(true)
    expect(local.canManageLocalServiceConfiguration).toBe(true)
    expect(remote.kind).toBe('desktop-thin')
    expect(remote.nodeMode).toBe('remote-console')
    expect(remote.ownsLocalNodeState).toBe(false)
    expect(remote.usesLocalSidecar).toBe(false)
    expect(remote.canManageLocalServiceConfiguration).toBe(false)
    expect(remote.trustsNativeWebViewOrigin).toBe(true)
  })

  it('does not derive product role or tier from a local sidecar surface', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
    })

    expect(profile.kind).toBe('desktop-local')
    expect(profile.usesLocalSidecar).toBe(true)
    expect(profile.nodeMode).toBe('remote-console')
    expect(profile.runtimeTier).toBe('none')
    expect(profile.ownsLocalNodeState).toBe(false)
    expect(profile.canManageLocalServiceConfiguration).toBe(false)
    expect(profile.isRemoteConsole).toBe(true)
  })

  it('keeps mock service configuration available without assigning local-node ownership', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'mock',
      transportKind: 'mock',
    })

    expect(profile.kind).toBe('mock')
    expect(profile.nodeMode).toBe('remote-console')
    expect(profile.runtimeTier).toBe('none')
    expect(profile.ownsLocalNodeState).toBe(false)
    expect(profile.canManageLocalServiceConfiguration).toBe(true)
  })

  it('gives the native WebRTC bridge to every native shell, and to no browser tab', () => {
    const linux = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    })
    const macos = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    })
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'android-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36',
    })
    const ios = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    })
    const hostedLinux = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    })
    const hostedAndroid = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36',
    })

    // Every platform below compiles the Rust transport, so the shell is the
    // whole question — being on Linux stopped being part of it.
    expect(linux.supportsNativeWebRtcBridge).toBe(true)
    expect(macos.supportsNativeWebRtcBridge).toBe(true)
    expect(android.supportsNativeWebRtcBridge).toBe(true)
    expect(ios.supportsNativeWebRtcBridge).toBe(true)
    // A hosted page has a WebView RTCPeerConnection and no Rust behind it,
    // whatever platform it is running on.
    expect(hostedLinux.supportsNativeWebRtcBridge).toBe(false)
    expect(hostedAndroid.supportsNativeWebRtcBridge).toBe(false)
  })

  it('keeps voice ownership centralized by surface capabilities', () => {
    const desktopLocal = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
    })
    const hosted = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'http',
    })
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
    })
    const ios = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'native-mobile',
      nativePlatform: 'ios',
    })

    expect(desktopLocal.voiceCapture.focusedPushToTalkOwner).toBe('native-desktop')
    expect(desktopLocal.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(desktopLocal.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(desktopLocal.voiceCapture.canUseWebViewVisualizer).toBe(false)
    expect(desktopLocal.voiceCapture.avoidCoordinatorPushToTalk).toBe(true)
    expect(desktopLocal.voiceCapture.detail).toBe('Desktop push-to-talk is available. Background voice is not available yet.')
    expect(findForbiddenProductionCopyTerms(desktopLocal.voiceCapture.detail)).toEqual([])
    expect(hosted.voiceCapture.wakewordOwner).toBe('webview-focused')
    expect(hosted.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(surfaceCanConfigureBackgroundWake(hosted)).toBe(false)
    expect(surfaceCanConfigureBackgroundWake(desktopLocal)).toBe(false)
    expect(hosted.localSpeechPack).toMatchObject({
      state: 'disabled',
      availabilityState: 'unsupported',
      canRunLocalVad: false,
      canRunLocalKws: false,
      canRunLocalStt: false,
      canRunLocalTts: false,
    })
    expect(android.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(android.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(android.voiceCapture.detail).toBe('Android push-to-talk is available while Aurora is open. Hands-free voice is unavailable on this device.')
    expect(ios.voiceCapture.focusedPushToTalkOwner).toBe('unavailable')
    expect(ios.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(ios.voiceCapture.canUseWebViewVisualizer).toBe(false)
    expect(ios.voiceCapture.usesBrowserVoiceRuntime).toBe(false)
    expect(findForbiddenProductionCopyTerms(ios.voiceCapture.detail)).toEqual([])
  })

  it.each([
    ['disabled', [], 'unsupported'],
    ['unavailable', ['foreground-voice'], 'unsupported'],
    ['downloading', ['foreground-voice'], 'pending'],
    ['incompatible', ['foreground-voice'], 'unsupported'],
    ['over-budget', ['foreground-voice'], 'degraded'],
    ['ready', ['foreground-voice'], 'ready'],
  ] as const)('models %s local speech without enabling unapproved local engines', (
    localSpeechPackState,
    enabledCapabilityPacks,
    availabilityState,
  ) => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks,
      localSpeechPackState,
    })

    expect(profile.localSpeechPack).toMatchObject({
      state: localSpeechPackState,
      availabilityState,
      canRunLocalVad: false,
      canRunLocalKws: false,
      canRunLocalStt: false,
      canRunLocalTts: false,
    })
    expect(findForbiddenProductionCopyTerms(profile.localSpeechPack.detail)).toEqual([])
  })

  it('enables local speech engines only with a ready selected download and engine evidence', () => {
    const ready = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })
    const missingEngine = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, stt: true, tts: false },
    })
    const absentDownload = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'unavailable',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })

    expect(ready.localSpeechPack).toMatchObject({
      state: 'ready',
      availabilityState: 'ready',
      canRunLocalVad: true,
      canRunLocalKws: true,
      canRunLocalStt: true,
      canRunLocalTts: true,
    })
    expect(missingEngine.localSpeechPack).toMatchObject({
      state: 'ready',
      canRunLocalVad: true,
      canRunLocalKws: false,
      canRunLocalStt: true,
      canRunLocalTts: false,
    })
    expect(absentDownload.localSpeechPack).toMatchObject({
      state: 'unavailable',
      canRunLocalVad: false,
      canRunLocalKws: false,
      canRunLocalStt: false,
      canRunLocalTts: false,
    })
  })

  it('preserves requested speech state while withholding engines without capability evidence', () => {
    const disabled = getAuroraSurfaceProfile({
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: [],
      localSpeechPackState: 'downloading',
    })
    const incompatible = getAuroraSurfaceProfile({
      nodeMode: 'mesh-node',
      runtimeTier: 'none',
      enabledCapabilityPacks: ['foreground-voice'],
    })
    const unavailable = getAuroraSurfaceProfile({
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
      enabledCapabilityPacks: ['foreground-voice'],
    })

    expect(disabled.localSpeechPack.state).toBe('downloading')
    expect(disabled.localSpeechPack.canRunLocalTts).toBe(false)
    expect(incompatible.localSpeechPack.state).toBe('unavailable')
    expect(unavailable.localSpeechPack.state).toBe('unavailable')
  })

  it('keeps local speech engine readiness independent from node role and transport', () => {
    const desktopRemoteConsole = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'webrtc-only',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })
    const androidRemoteConsole = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
      nativeVoiceAvailable: true,
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })

    expect(desktopRemoteConsole.isRemoteConsole).toBe(true)
    expect(desktopRemoteConsole.localSpeechPack).toMatchObject({
      state: 'ready',
      availabilityState: 'ready',
      canRunLocalVad: true,
      canRunLocalKws: true,
      canRunLocalStt: true,
      canRunLocalTts: true,
    })
    expect(androidRemoteConsole.isRemoteConsole).toBe(true)
    expect(androidRemoteConsole.localSpeechPack.canRunLocalVad).toBe(true)
    expect(androidRemoteConsole.localSpeechPack.canRunLocalKws).toBe(true)
    expect(androidRemoteConsole.localSpeechPack.canRunLocalStt).toBe(true)
    expect(androidRemoteConsole.localSpeechPack.canRunLocalTts).toBe(true)
  })

  it('uses native wake ownership only when native wake and local VAD/KWS are ready', () => {
    const desktop = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'webrtc-only',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
      nativeVoiceAvailable: true,
      nativeWakewordAvailable: true,
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nodeMode: 'remote-console',
      runtimeTier: 'none',
      nativeVoiceAvailable: true,
      nativeWakewordAvailable: true,
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })
    const missingKws = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nativeVoiceAvailable: true,
      nativeWakewordAvailable: true,
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: false, stt: true, tts: true },
    })
    const ios = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'native-mobile',
      nativePlatform: 'ios',
      nativeVoicePresent: true,
      nativeVoiceAvailable: true,
      nativeWakewordAvailable: true,
      localSpeechPackState: 'ready',
      localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
    })

    expect(desktop.voiceCapture).toMatchObject({
      wakewordOwner: 'native-desktop',
      wakewordRequiresFocus: false,
    })
    expect(surfaceCanConfigureBackgroundWake(desktop)).toBe(true)
    expect(android.voiceCapture).toMatchObject({
      wakewordOwner: 'mobile-native',
      wakewordRequiresFocus: false,
    })
    expect(surfaceCanConfigureBackgroundWake(android)).toBe(true)
    expect(missingKws.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(surfaceCanConfigureBackgroundWake(missingKws)).toBe(false)
    expect(ios.voiceCapture).toMatchObject({
      focusedPushToTalkOwner: 'mobile-native',
      wakewordOwner: 'mobile-native',
      wakewordRequiresFocus: false,
    })
    expect(surfaceCanConfigureBackgroundWake(ios)).toBe(true)
    expect(findForbiddenProductionCopyTerms(desktop.voiceCapture.detail)).toEqual([])
    expect(findForbiddenProductionCopyTerms(android.voiceCapture.detail)).toEqual([])
    expect(findForbiddenProductionCopyTerms(ios.voiceCapture.detail)).toEqual([])
  })

  it('keeps mobile browsers on the hosted web runtime when web mode is explicit', () => {
    const chromeAndroid = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'http',
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
    })
    const mobileSafari = getAuroraSurfaceProfile({
      runtimeMode: 'thin-shell',
      transportKind: 'webrtc-preferred',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    })

    for (const profile of [chromeAndroid, mobileSafari]) {
      expect(profile.physicalKind).toBe('hosted-web')
      expect(profile.kind).toBe('web')
      expect(profile.usesNativeShell).toBe(false)
      expect(profile.trustsNativeWebViewOrigin).toBe(false)
      expect(profile.supportsMobileNative).toBe(false)
      expect(profile.supportsAndroidOnly).toBe(false)
      expect(profile.supportsIosOnly).toBe(false)
      expect(profile.usesBrowserVoiceRuntime).toBe(true)
      expect(profile.voiceCapture.usesBrowserVoiceRuntime).toBe(true)
    }

    expect(chromeAndroid.isMobile).toBe(true)
    expect(chromeAndroid.isAndroid).toBe(true)
    expect(chromeAndroid.isIos).toBe(false)
    expect(mobileSafari.isMobile).toBe(true)
    expect(mobileSafari.isAndroid).toBe(false)
    expect(mobileSafari.isIos).toBe(true)
  })

  it('keeps Android hands-free voice withheld while native push-to-talk is available', () => {
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nativeVoiceAvailable: true,
    })

    expect(android.voiceCapture.focusedPushToTalkOwner).toBe('mobile-native')
    expect(android.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(android.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(android.voiceCapture.canUseWebViewVisualizer).toBe(false)
    expect(findForbiddenProductionCopyTerms(android.voiceCapture.detail)).toEqual([])
  })

  it('routes iOS focused push-to-talk through the native adapter only when ready', () => {
    const ios = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'native-mobile',
      nativePlatform: 'ios',
      nativeVoicePresent: true,
      nativeVoiceAvailable: true,
    })

    expect(ios.voiceCapture.focusedPushToTalkOwner).toBe('mobile-native')
    expect(ios.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(ios.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(ios.voiceCapture.canUseWebViewVisualizer).toBe(false)
    expect(findForbiddenProductionCopyTerms(ios.voiceCapture.detail)).toEqual([])
  })

  it('fails closed for legacy mobile profiles without a native voice adapter', () => {
    const mobile = getAuroraSurfaceProfile({ runtimeMode: 'mobile', transportKind: 'native-mobile' })

    expect(mobile.kind).toBe('mobile')
    expect(mobile.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(mobile.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(mobile.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(mobile.voiceCapture.canUseWebViewVisualizer).toBe(true)
    expect(findForbiddenProductionCopyTerms(mobile.voiceCapture.detail)).toEqual([])
  })

  it('withholds Android voice when the native adapter exists without a ready route', () => {
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nativeVoicePresent: true,
      nativeVoiceAvailable: false,
    })

    expect(android.voiceCapture.focusedPushToTalkOwner).toBe('unavailable')
    expect(android.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(android.voiceCapture.canUseWebViewVisualizer).toBe(false)
    expect(findForbiddenProductionCopyTerms(android.voiceCapture.detail)).toEqual([])
  })

  it('keeps explicit native mobile shells native even when the transport is thin', () => {
    const android = getAuroraSurfaceProfile({
      runtimeMode: 'mobile-native',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
    })
    const ios = getAuroraSurfaceProfile({
      runtimeMode: 'ios-thin',
      transportKind: 'webrtc-preferred',
      nativePlatform: 'ios',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
    })

    expect(android.physicalKind).toBe('android')
    expect(android.kind).toBe('android')
    expect(android.usesNativeShell).toBe(true)
    expect(android.trustsNativeWebViewOrigin).toBe(true)
    expect(android.supportsMobileNative).toBe(true)
    expect(android.supportsAndroidOnly).toBe(true)
    expect(android.supportsIosOnly).toBe(false)
    expect(android.usesBrowserVoiceRuntime).toBe(false)
    expect(android.voiceCapture.usesBrowserVoiceRuntime).toBe(false)

    expect(ios.physicalKind).toBe('ios')
    expect(ios.kind).toBe('ios')
    expect(ios.usesNativeShell).toBe(true)
    expect(ios.trustsNativeWebViewOrigin).toBe(true)
    expect(ios.supportsMobileNative).toBe(true)
    expect(ios.supportsAndroidOnly).toBe(false)
    expect(ios.supportsIosOnly).toBe(true)
    expect(ios.usesBrowserVoiceRuntime).toBe(false)
    expect(ios.voiceCapture.usesBrowserVoiceRuntime).toBe(false)
  })

  it('keeps desktop Tauri, desktop web, mock, and unknown surfaces in separate voice buckets', () => {
    const desktopWeb = getAuroraSurfaceProfile({
      runtimeMode: 'web',
      transportKind: 'http',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15',
    })
    const desktopLocal = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
    })
    const desktopThin = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
    })
    const mock = getAuroraSurfaceProfile({
      runtimeMode: 'mock',
      transportKind: 'mock',
    })
    const unknown = getAuroraSurfaceProfile()

    expect(desktopWeb.physicalKind).toBe('hosted-web')
    expect(desktopWeb.usesNativeShell).toBe(false)
    expect(desktopWeb.supportsMobileNative).toBe(false)
    expect(desktopWeb.usesBrowserVoiceRuntime).toBe(true)

    expect(desktopLocal.physicalKind).toBe('desktop-tauri')
    expect(desktopLocal.usesNativeShell).toBe(true)
    expect(desktopLocal.trustsNativeWebViewOrigin).toBe(true)
    expect(desktopLocal.supportsMobileNative).toBe(false)
    expect(desktopLocal.usesBrowserVoiceRuntime).toBe(false)

    expect(desktopThin.physicalKind).toBe('desktop-tauri')
    expect(desktopThin.usesNativeShell).toBe(true)
    expect(desktopThin.trustsNativeWebViewOrigin).toBe(true)
    expect(desktopThin.usesBrowserVoiceRuntime).toBe(false)
    expect(desktopThin.voiceCapture.focusedPushToTalkOwner).toBe('native-desktop')
    expect(desktopThin.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(desktopThin.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(desktopThin.voiceCapture.canUseWebViewVisualizer).toBe(false)

    expect(mock.physicalKind).toBe('test')
    expect(mock.usesBrowserVoiceRuntime).toBe(false)
    expect(mock.supportsMobileNative).toBe(false)

    expect(unknown.physicalKind).toBe('unknown')
    expect(unknown.usesNativeShell).toBe(false)
    expect(unknown.supportsMobileNative).toBe(false)
    expect(unknown.usesBrowserVoiceRuntime).toBe(false)
  })

  it('shows local Settings on native shells and hosted-web nodes, not hosted-web remote consoles', () => {
    const webRemote = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'http',
      nodeMode: 'remote-console',
    })
    const webNode = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'http',
      nodeMode: 'mesh-node',
    })
    const desktopThin = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-thin',
      transportKind: 'tauri-thin',
      nativePlatform: 'linux',
      nodeMode: 'remote-console',
    })
    const androidRemote = getAuroraSurfaceProfile({
      runtimeMode: 'android',
      transportKind: 'native-mobile',
      nativePlatform: 'android',
      nodeMode: 'remote-console',
    })
    const hostedAndroidBrowser = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'http',
      nodeMode: 'remote-console',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
    })

    expect(shouldShowForSurface(webRemote, 'localSettings')).toBe(false)
    expect(shouldShowForSurface(webNode, 'localSettings')).toBe(true)
    expect(shouldShowForSurface(desktopThin, 'localSettings')).toBe(true)
    expect(shouldShowForSurface(androidRemote, 'localSettings')).toBe(true)
    expect(shouldShowForSurface(hostedAndroidBrowser, 'localSettings')).toBe(false)
    expect(hostedAndroidBrowser.physicalKind).toBe('hosted-web')
  })

  it('does not let mock SDK transport hide hosted-web node Settings', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mock',
      nodeMode: 'mesh-node',
      runtimeTier: 'lightweight-ts',
    })

    expect(profile.physicalKind).toBe('hosted-web')
    expect(profile.ownsLocalNodeState).toBe(true)
    expect(shouldShowForSurface(profile, 'localSettings')).toBe(true)
  })

  it('lets explicit native platform override conflicting hosted-web hints', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'http',
      nativePlatform: 'android',
      userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
    })

    expect(profile.physicalKind).toBe('android')
    expect(profile.kind).toBe('android')
    expect(profile.usesNativeShell).toBe(true)
    expect(profile.trustsNativeWebViewOrigin).toBe(true)
    expect(profile.supportsMobileNative).toBe(true)
    expect(profile.supportsAndroidOnly).toBe(true)
    expect(profile.usesBrowserVoiceRuntime).toBe(false)
  })

  it('maps SDK transport kinds to a best-effort runtimeMode', () => {
    expect(runtimeModeFromTransportKind('tauri-local')).toBe('desktop-local')
    expect(runtimeModeFromTransportKind('tauri-thin')).toBe('desktop-thin')
    expect(runtimeModeFromTransportKind('native-mobile')).toBe('mobile-native')
    expect(runtimeModeFromTransportKind('mock')).toBe('mock')
    expect(runtimeModeFromTransportKind('mesh')).toBe('web-thin')
    expect(runtimeModeFromTransportKind('http')).toBe('web-thin')
    expect(runtimeModeFromTransportKind(null)).toBe('web-thin')
  })
})
