import { describe, expect, it } from 'vitest'
import { getAuroraSurfaceProfile } from '../src/platform-surface'
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

  it('keeps desktop local service ownership separate from desktop remote-console transport', () => {
    const local = getAuroraSurfaceProfile({
      runtimeMode: 'desktop-local',
      transportKind: 'tauri-local',
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

  it('limits the native WebRTC bridge to Linux desktop shells', () => {
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
    const hostedLinux = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'webrtc-only',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    })

    expect(linux.supportsNativeWebRtcBridge).toBe(true)
    expect(macos.supportsNativeWebRtcBridge).toBe(false)
    expect(android.supportsNativeWebRtcBridge).toBe(false)
    expect(hostedLinux.supportsNativeWebRtcBridge).toBe(false)
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
    expect(android.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(android.voiceCapture.wakewordOwner).toBe('webview-focused')
    expect(android.voiceCapture.detail).toBe('Android capture is available while Aurora is open in the foreground.')
    expect(ios.voiceCapture.focusedPushToTalkOwner).toBe('unavailable')
    expect(ios.voiceCapture.wakewordOwner).toBe('unavailable')
    expect(ios.voiceCapture.canUseWebViewVisualizer).toBe(false)
    expect(ios.voiceCapture.usesBrowserVoiceRuntime).toBe(false)
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
})
