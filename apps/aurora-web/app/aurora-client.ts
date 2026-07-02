import {
  AuroraClient,
  AuroraError,
  HttpGatewayTransport,
  MockAuroraTransport,
  type AuroraTransport,
  type AuroraTransportRequest,
  type AuroraTransportResponse,
} from '@aurora/client'

type BrowserClientCache = {
  key: string
  client: AuroraClient
}

let browserClientCache: BrowserClientCache | null = null

class MissingGatewayTransport implements AuroraTransport {
  readonly kind = 'http'

  async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>
  ): Promise<AuroraTransportResponse<TData>> {
    throw new AuroraError({
      code: 'transport_loss',
      message: 'Aurora Gateway URL is not configured. Set AURORA_GATEWAY_URL/NEXT_PUBLIC_AURORA_GATEWAY_URL or explicitly enable AURORA_WEB_DEMO_MODE=1 for labeled offline demo data.',
      method: request.method,
      busTopic: request.busTopic,
      detail: {
        demo_mode: false,
        secrets_redacted: true,
        repair_action: 'Configure a real Gateway URL or opt into demo mode explicitly.'
      }
    })
  }
}

export function createAuroraWebClient(): AuroraClient {
  const gatewayUrl = process.env.AURORA_GATEWAY_URL
  if (gatewayUrl) {
    return new AuroraClient({
      transport: new HttpGatewayTransport({
        baseUrl: gatewayUrl,
        bearerToken: process.env.AURORA_GATEWAY_TOKEN
      })
    })
  }
  if (isServerDemoMode()) {
    return new AuroraClient({ transport: new MockAuroraTransport() })
  }
  return new AuroraClient({ transport: new MissingGatewayTransport() })
}

export function createAuroraBrowserClient(): AuroraClient {
  const key = browserClientCacheKey()
  if (browserClientCache?.key === key) return browserClientCache.client

  const gatewayUrl = process.env.NEXT_PUBLIC_AURORA_GATEWAY_URL
  let client: AuroraClient
  if (gatewayUrl) {
    client = new AuroraClient({
      transport: new HttpGatewayTransport({
        baseUrl: gatewayUrl,
        bearerToken: () => client.auth.bearerToken()
      })
    })
  } else if (isBrowserDemoMode()) {
    client = new AuroraClient({ transport: new MockAuroraTransport() })
  } else {
    client = new AuroraClient({ transport: new MissingGatewayTransport() })
  }
  browserClientCache = { key, client }
  return client
}

export function resetAuroraBrowserClientForTests(): void {
  browserClientCache = null
}

export function isAuroraWebDemoMode(): boolean {
  return isServerDemoMode() || isBrowserDemoMode()
}

function browserClientCacheKey(): string {
  return JSON.stringify({
    gatewayUrl: process.env.NEXT_PUBLIC_AURORA_GATEWAY_URL ?? '',
    demoMode: isBrowserDemoMode()
  })
}

function isServerDemoMode(): boolean {
  return process.env.NODE_ENV === 'test' || truthy(process.env.AURORA_WEB_DEMO_MODE)
}

function isBrowserDemoMode(): boolean {
  return process.env.NODE_ENV === 'test' || truthy(process.env.NEXT_PUBLIC_AURORA_WEB_DEMO_MODE)
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
}
