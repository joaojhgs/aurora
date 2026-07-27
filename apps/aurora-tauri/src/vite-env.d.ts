/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AURORA_GATEWAY_URL?: string
  readonly VITE_AURORA_RUNTIME_MODE?: 'desktop-thin' | 'android-thin' | 'ios-thin'
  readonly VITE_AURORA_SIGNALING_URL?: string
  readonly VITE_AURORA_CONNECTION_MODE?: string
  readonly VITE_AURORA_THIN_CONNECTION_MODE?: string
  readonly VITE_AURORA_NODE_NAME?: string
  readonly VITE_AURORA_STABLE_PEER_ID?: string
  readonly VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
