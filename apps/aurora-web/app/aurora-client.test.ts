import { describe, expect, it } from 'vitest'
import { createAuroraWebClient } from './aurora-client'

describe('createAuroraWebClient', () => {
  it('uses the SDK mock transport as an explicit development fallback', () => {
    const previous = process.env.AURORA_GATEWAY_URL
    delete process.env.AURORA_GATEWAY_URL
    const client = createAuroraWebClient()
    if (previous === undefined) delete process.env.AURORA_GATEWAY_URL
    else process.env.AURORA_GATEWAY_URL = previous

    expect(client.transport.kind).toBe('mock')
  })
})
