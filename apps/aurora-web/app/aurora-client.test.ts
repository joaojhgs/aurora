import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuroraWebClient } from './aurora-client'

describe('createAuroraWebClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the SDK mock transport only in explicit test or demo mode', () => {
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('mock')
  })

  it('fails closed instead of using fixture data as production truth when Gateway URL is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '')

    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('http')
    await expect(client.capabilities.getGraph()).rejects.toThrow(/Gateway URL is not configured/)
  })

  it('requires explicit demo opt-in for fixture-backed web mode outside tests', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '1')

    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('mock')
  })
})
