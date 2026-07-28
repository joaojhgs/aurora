/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AURORA_RUNTIME_MODE?: 'desktop-thin' | 'android-thin' | 'ios-thin'
  readonly VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK?: string
  readonly VITE_AURORA_WEBRTC_THIN_CLIENT?: string
  readonly VITE_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS?: string
  readonly VITE_AURORA_WEBRTC_FRAGMENTATION?: string
  readonly VITE_AURORA_WEBRTC_APP_LAYER_E2EE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
