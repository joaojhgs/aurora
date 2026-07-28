import { describe, expect, it } from 'vitest'
import { getAuroraSurfaceProfile } from '../src/platform-surface'

describe('Aurora surface profile regression coverage', () => {
  it('keeps hosted remote-console surfaces free of local service ownership', () => {
    const profile = getAuroraSurfaceProfile({
      runtimeMode: 'web-thin',
      transportKind: 'mesh',
    })

    expect(profile.kind).toBe('web')
    expect(profile.isWebThin).toBe(true)
    expect(profile.usesLocalSidecar).toBe(false)
    expect(profile.canManageLocalServiceConfiguration).toBe(false)
    expect(profile.supportsWebRtcThin).toBe(true)
    expect(profile.prefersWebRtcTransport).toBe(true)
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
    expect(local.usesLocalSidecar).toBe(true)
    expect(local.canManageLocalServiceConfiguration).toBe(true)
    expect(remote.kind).toBe('desktop-thin')
    expect(remote.usesLocalSidecar).toBe(false)
    expect(remote.canManageLocalServiceConfiguration).toBe(false)
    expect(remote.trustsNativeWebViewOrigin).toBe(true)
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

    expect(desktopLocal.voiceCapture.wakewordOwner).toBe('coordinator-daemon')
    expect(desktopLocal.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(hosted.voiceCapture.wakewordOwner).toBe('webview-focused')
    expect(hosted.voiceCapture.wakewordRequiresFocus).toBe(true)
    expect(android.voiceCapture.focusedPushToTalkOwner).toBe('webview-focused')
    expect(android.voiceCapture.wakewordOwner).toBe('webview-focused')
    expect(android.voiceCapture.detail).toBe('Android capture is available while Aurora is open in the foreground.')
  })
})
