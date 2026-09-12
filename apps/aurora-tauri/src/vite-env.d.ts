/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK?: string
  readonly VITE_AURORA_WEBRTC_THIN_CLIENT?: string
  readonly VITE_AURORA_WEBRTC_SCOPED_SUBSCRIPTIONS?: string
  readonly VITE_AURORA_WEBRTC_FRAGMENTATION?: string
  readonly VITE_AURORA_WEBRTC_APP_LAYER_E2EE?: string
  readonly VITE_AURORA_MESH_NODE_RUNTIME_V1?: string
  readonly VITE_AURORA_LOCAL_TOOL_PROVIDER_V1?: string
  readonly VITE_AURORA_LIGHTWEIGHT_ORCHESTRATOR_V1?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
