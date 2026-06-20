import { AuroraClient, HttpGatewayTransport, MockAuroraTransport } from '@aurora/client'

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
  return new AuroraClient({ transport: new MockAuroraTransport() })
}
