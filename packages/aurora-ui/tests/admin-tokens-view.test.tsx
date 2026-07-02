import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import {
  AdminTokensView,
  buildAdminTokensSnapshot,
  buildTokenRevokeAdminAction,
  buildTokenRotateAdminAction,
  dismissOneTimeTokenReveal,
  type AdminTokensSnapshot
} from '../src/index'

describe('AdminTokensView', () => {
  it('renders scoped token metadata, one-time reveal rules, and AdminAction evidence', async () => {
    const snapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
    const markup = renderToStaticMarkup(<AdminTokensView snapshot={snapshot} />)

    expect(snapshot.tokens.map((token) => token.prefix)).toContain('aur_stu')
    expect(snapshot.tokens.some((token) => token.revokeAction?.methodId === 'Auth.RevokeToken')).toBe(true)
    expect(snapshot.tokens.some((token) => token.rotateAction?.requiresAdminAction)).toBe(true)
    expect(markup).toContain('Tokens')
    expect(markup).toContain('Create-token preview wizard')
    expect(markup).toContain('Create token unavailable')
    expect(markup).toContain('Auth.CreateToken is not exposed')
    expect(markup).toContain('Scoped token inventory')
    expect(markup).not.toContain('secret-token')
  })

  it('builds revoke and rotate AdminAction requests without secret payloads', async () => {
    const snapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
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

  it('renders token owners and backend last-used evidence without exposing secrets', async () => {
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
    const snapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport }))
    const markup = renderToStaticMarkup(<AdminTokensView snapshot={snapshot} />)

    expect(snapshot.tokens[0]).toEqual(expect.objectContaining({ owner: 'Operations owner', lastUsedAt: '2026-02-02T00:00:00Z' }))
    expect(markup).toContain('Operations owner')
    expect(markup).toContain('Last used')
    expect(markup).not.toContain('secret-token-should-not-render')
  })

  it('purges one-time reveal secrets after dismissal and never stores them in AdminAction payloads', async () => {
    const snapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport: new MockAuroraTransport() }))
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
    expect(revealMarkup).toContain('Copy one-time secret for aur_new')
    expect(revealMarkup).toContain('Dismiss one-time secret for aur_new')

    const dismissedSnapshot = dismissOneTimeTokenReveal(revealedSnapshot)
    const dismissedMarkup = renderToStaticMarkup(<AdminTokensView snapshot={dismissedSnapshot} />)
    expect(dismissedMarkup).toContain('token secrets are not retained')
    expect(dismissedMarkup).not.toContain(secret)
    for (const token of snapshot.tokens) {
      expect(JSON.stringify(token.revokeAction)).not.toContain(secret)
      expect(JSON.stringify(token.rotateAction)).not.toContain(secret)
    }
  })

  it('renders token loading, empty, denied, degraded, and unavailable states', async () => {
    const loadingMarkup = renderToStaticMarkup(<AdminTokensView snapshot={loadingSnapshot()} />)
    expect(loadingMarkup).toContain('Loading token metadata')

    const emptyTransport = new MockAuroraTransport()
    emptyTransport.register('Auth.ListTokens', () => ({ tokens: [] }))
    const emptySnapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport: emptyTransport }))
    expect(renderToStaticMarkup(<AdminTokensView snapshot={emptySnapshot} />)).toContain('No scoped tokens')

    const deniedTransport = new MockAuroraTransport().fail('Auth.ListTokens', 'permission', 'token access denied')
    const deniedSnapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport: deniedTransport }))
    expect(renderToStaticMarkup(<AdminTokensView snapshot={deniedSnapshot} />)).toContain('token access denied')

    const degradedTransport = new MockAuroraTransport().fail('Gateway.GetCapabilityCatalog', 'transport_loss', 'token capability catalog unavailable')
    const degradedSnapshot = await buildAdminTokensSnapshot(new AuroraClient({ transport: degradedTransport }))
    expect(renderToStaticMarkup(<AdminTokensView snapshot={degradedSnapshot} />)).toContain('token capability catalog unavailable')

    const unavailableSnapshot = await buildAdminTokensSnapshot(
      new AuroraClient({ transport: MockAuroraTransport.empty().lose('Auth.ListTokens').lose('Gateway.GetCapabilityCatalog') })
    )
    expect(renderToStaticMarkup(<AdminTokensView snapshot={unavailableSnapshot} />)).toContain('Auth token SDK resources are unavailable')
  })
})

function loadingSnapshot(): AdminTokensSnapshot {
  return {
    loadState: 'loading',
    tokens: [],
    listState: 'pending',
    listReason: 'Loading Auth.ListTokens and token capability evidence through AuroraClient.',
    revokeState: 'pending',
    revokeReason: 'Loading Auth.RevokeToken capability evidence through AuroraClient.',
    createState: 'unsupported',
    createReason: 'Auth.CreateToken is not exposed by the SDK/contracts in this checkout; creation remains a disabled preview.',
    secretsRedacted: true,
    warnings: [],
    error: null,
    evidenceSource: 'pending AuroraClient SDK calls',
    oneTimeReveal: null
  }
}
