import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import {
  AdminTokensView,
  buildAdminTokensSnapshot,
  buildTokenRevokeAdminAction,
  buildTokenRotateAdminAction,
  dismissOneTimeTokenReveal,
  type AdminTokensSnapshot
} from '../src/index'

describe('AdminTokensView', () => {
  it('renders prototype-density token table and revoke action', async () => {
    const snapshot = await buildAdminTokensSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminTokensView snapshot={snapshot} />)

    expect(snapshot.tokens.map((token) => token.prefix)).toContain('aur_stu')
    expect(snapshot.tokens.some((token) => token.revokeAction?.methodId === 'Auth.RevokeToken')).toBe(true)
    expect(snapshot.tokens.some((token) => token.rotateAction?.requiresAdminAction)).toBe(true)
    expect(markup).toContain('Tokens')
    expect(markup).toContain('API tokens issued to principals, with their granted scopes.')
    expect(markup).toContain('Principal')
    expect(markup).toContain('Scopes')
    expect(markup).toContain('Expires')
    expect(markup).toContain('Revoke')
    expect(markup).not.toContain('Create token unavailable')
    expect(markup).not.toContain('Auth.CreateToken is not exposed')
    expect(markup).not.toContain('secret-token')
  })

  it('builds revoke and rotate AdminAction requests without secret payloads', async () => {
    const snapshot = await buildAdminTokensSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const token = snapshot.tokens.find((row) => row.id === 'token-studio-mac-active')
    expect(token).toBeTruthy()

    const revokeAction = buildTokenRevokeAdminAction(token!, 'revoke exposed workstation token')
    expect(revokeAction.methodId).toBe('Auth.RevokeToken')
    expect(revokeAction.payload).toEqual({ token_id: 'token-studio-mac-active' })
    expect(revokeAction.reason).toBe('revoke exposed workstation token')

    const rotateAction = buildTokenRotateAdminAction(token!)
    expect(rotateAction.methodId).toBe('Auth.RevokeToken')
    expect(rotateAction.payload).toEqual({ token_id: 'token-studio-mac-active', rotate: true })
    expect(rotateAction.affectedResources).toEqual(expect.arrayContaining(['token:replacement-one-time-reveal']))
    expect(JSON.stringify(revokeAction)).not.toContain('secret-token')
    expect(JSON.stringify(rotateAction)).not.toContain('secret-token')
  })

  it('renders token owners and backend last-used status without exposing secrets', async () => {
    const transport = new MockAuroraTransport()
    transport.register('Auth.ListTokens', () => ({
      tokens: [
        {
          id: 'token-last-used',
          prefix: 'aur_lus',
          user_id: 'principal-owner',
          owner: 'Operations owner',
          device_id: 'device-ops',
          scopes: ['Gateway.use'],
          created_at: '2026-01-01T00:00:00Z',
          expires_at: '2026-12-31T00:00:00Z',
          last_used_at: '2026-02-02T00:00:00Z',
          secret: 'secret-token-should-not-render'
        }
      ]
    }))
    const snapshot = await buildAdminTokensSnapshot(new Aurora({ transport }))
    const markup = renderToStaticMarkup(<AdminTokensView snapshot={snapshot} />)

    expect(snapshot.tokens[0]).toEqual(expect.objectContaining({ owner: 'Operations owner', lastUsedAt: '2026-02-02T00:00:00Z' }))
    expect(markup).toContain('Operations owner')
    expect(markup).not.toContain('Last used')
    expect(markup).not.toContain('secret-token-should-not-render')
  })

  it('purges one-time reveal secrets after dismissal and never stores them in AdminAction payloads', async () => {
    const snapshot = await buildAdminTokensSnapshot(new Aurora({ transport: new MockAuroraTransport() }))
    const secret = 'new-token-secret-value'
    const revealedSnapshot: AdminTokensSnapshot = {
      ...snapshot,
      oneTimeReveal: {
        tokenId: 'token-new',
        prefix: 'aur_new',
        secret,
        expiresAt: '2026-12-31T00:00:00Z'
      }
    }
    const revealMarkup = renderToStaticMarkup(<AdminTokensView snapshot={revealedSnapshot} />)
    expect(revealMarkup).not.toContain(secret)

    const dismissedSnapshot = dismissOneTimeTokenReveal(revealedSnapshot)
    const dismissedMarkup = renderToStaticMarkup(<AdminTokensView snapshot={dismissedSnapshot} />)
    expect(dismissedMarkup).not.toContain(secret)
    for (const token of snapshot.tokens) {
      expect(JSON.stringify(token.revokeAction)).not.toContain(secret)
      expect(JSON.stringify(token.rotateAction)).not.toContain(secret)
    }
  })

  it('renders token loading, empty, denied, degraded, and unavailable states', async () => {
    const loadingMarkup = renderToStaticMarkup(<AdminTokensView snapshot={loadingSnapshot()} />)
    expect(loadingMarkup).toContain('Tokens')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListTokens', () => ({ tokens: [] }))
    const emptySnapshot = await buildAdminTokensSnapshot(new Aurora({ transport: emptyTransport }))
    expect(renderToStaticMarkup(<AdminTokensView snapshot={emptySnapshot} />)).toContain('No tokens to show')

    const deniedTransport = new MockAuroraTransport().fail('Auth.ListTokens', 'permission', 'token access denied')
    const deniedSnapshot = await buildAdminTokensSnapshot(new Aurora({ transport: deniedTransport }))
    expect(renderToStaticMarkup(<AdminTokensView snapshot={deniedSnapshot} />)).toContain('Tokens')

    const degradedTransport = new MockAuroraTransport().fail('Gateway.GetCapabilityCatalog', 'transport_loss', 'token capability catalog unavailable')
    const degradedSnapshot = await buildAdminTokensSnapshot(new Aurora({ transport: degradedTransport }))
    expect(renderToStaticMarkup(<AdminTokensView snapshot={degradedSnapshot} />)).toContain('Tokens')

    const unavailableSnapshot = await buildAdminTokensSnapshot(
      new Aurora({ transport: MockAuroraTransport.empty().lose('Auth.ListTokens').lose('Gateway.GetCapabilityCatalog') })
    )
    expect(renderToStaticMarkup(<AdminTokensView snapshot={unavailableSnapshot} />)).toContain('No tokens to show')
  })
})

function loadingSnapshot(): AdminTokensSnapshot {
  return {
    loadState: 'loading',
    tokens: [],
    listState: 'pending',
    listReason: 'Loading Auth.ListTokens and token capability status through Aurora.',
    revokeState: 'pending',
    revokeReason: 'Loading Auth.RevokeToken capability status through Aurora.',
    createState: 'unsupported',
    createReason: 'Auth.CreateToken is not exposed by the SDK/contracts in this checkout; creation remains a disabled preview.',
    secretsRedacted: true,
    warnings: [],
    error: null,
    evidenceSource: 'pending Aurora SDK calls',
    oneTimeReveal: null
  }
}
