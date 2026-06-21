/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AURORA_GATEWAY_URL?: string
  readonly VITE_AURORA_GATEWAY_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
