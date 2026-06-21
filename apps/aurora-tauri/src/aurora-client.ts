import {
  AuroraClient,
  HttpGatewayTransport,
  MockAuroraTransport,
  TauriLocalTransport,
  type TauriSidecarStatus
} from '@aurora/client'
import { invoke } from '@tauri-apps/api/core'

export interface AuroraTauriRuntime {
  client: AuroraClient
  mode: 'desktop-local' | 'desktop-thin' | 'mock'
  sidecarStatus: () => Promise<TauriSidecarStatus | null>
  shutdown: () => Promise<void>
}

export function createAuroraTauriRuntime(): AuroraTauriRuntime {
  if (isTauriRuntime()) {
    const transport = new TauriLocalTransport({ invoke })
    return {
      client: new AuroraClient({ transport }),
      mode: import.meta.env.VITE_AURORA_GATEWAY_URL ? 'desktop-thin' : 'desktop-local',
      sidecarStatus: () => transport.getSidecarStatus(),
      shutdown: () => invoke<void>('aurora_shutdown')
    }
  }

  const gatewayUrl = import.meta.env.VITE_AURORA_GATEWAY_URL
  if (gatewayUrl) {
    return {
      client: new AuroraClient({
        transport: new HttpGatewayTransport({
          baseUrl: gatewayUrl,
          bearerToken: import.meta.env.VITE_AURORA_GATEWAY_TOKEN
        })
      }),
      mode: 'desktop-thin',
      sidecarStatus: async () => null,
      shutdown: async () => undefined
    }
  }

  return {
    client: new AuroraClient({ transport: new MockAuroraTransport() }),
    mode: 'mock',
    sidecarStatus: async () => null,
    shutdown: async () => undefined
  }
}

function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}
