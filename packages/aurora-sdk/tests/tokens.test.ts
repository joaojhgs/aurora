import { describe, expect, it } from 'vitest'

import { AUTH_METHODS, AuroraClient, MockAuroraTransport } from '../src/index.js'

describe('AuroraClient token lifecycle', () => {
  it('lists, creates, updates, and revokes tokens through the token namespace', async () => {
    const client = new AuroraClient({ transport: new MockAuroraTransport() })

    const listed = await client.tokens.list()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return

    const tokenId = listed.data.tokens[0]?.id
    expect(tokenId).toBeTruthy()

    const created = await client.tokens.create(
      {
        principal_id: 'ops-bot',
        scopes: ['Gateway.use'],
        expires_in_days: 30
      },
      {
        reason: 'Create scoped test token',
        reauthConfirmed: true
      }
    )
    expect(created.data.token).toMatch(/^mock-created-token-value-/)
    expect(created.auditReceipt).toBe('aar-mock-admin-action')

    const updated = await client.tokens.updateScopes(
      { token_id: tokenId!, scopes: ['Gateway.use'] },
      { reason: 'Narrow token scopes', reauthConfirmed: true }
    )
    expect(updated.data.success).toBe(true)

    const afterUpdate = await client.tokens.list()
    expect(afterUpdate.ok && afterUpdate.data.tokens.find((token) => token.id === tokenId)?.scopes)
      .toEqual(['Gateway.use'])

    const revoked = await client.tokens.revoke(
      { token_id: tokenId! },
      { reason: 'Revoke old token', reauthConfirmed: true }
    )
    expect(revoked.data.success).toBe(true)

    const afterRevoke = await client.tokens.list()
    expect(afterRevoke.ok && afterRevoke.data.tokens.some((token) => token.id === tokenId)).toBe(false)
  })

  it('submits token creation with AdminAction confirmation headers', async () => {
    const calls: Array<{ method: string; payload: unknown; headers?: Record<string, string> }> = []
    const transport = new MockAuroraTransport().register('Auth.CreateToken', (request) => {
      calls.push({
        method: request.method,
        payload: request.payload,
        ...(request.headers ? { headers: request.headers } : {})
      })
      return {
        token: 'secret-created-token-value',
        id: 'token-created',
        prefix: 'secret_c',
        scopes: ['Gateway.use'],
        expires_at: '2030-01-01T00:00:00Z'
      }
    })
    const client = new AuroraClient({ transport })

    const created = await client.tokens.create(
      { principal_id: 'ops-bot', scopes: ['Gateway.use'] },
      { reason: 'Create scoped test token', reauthConfirmed: true }
    )

    expect(created.data.token).toBe('secret-created-token-value')
    expect(calls).toContainEqual(expect.objectContaining({
      method: AUTH_METHODS.createToken,
      payload: expect.objectContaining({ principal_id: 'ops-bot', scopes: ['Gateway.use'] }),
      headers: expect.objectContaining({
        'X-Aurora-AdminAction-Id': 'mock-admin-action',
        'X-Aurora-AdminAction-Token': 'mock-confirmation-token',
        'X-Aurora-AdminAction-Digest': 'mock-digest'
      })
    }))
  })
})
