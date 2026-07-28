import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import { AdminOverviewContent, buildAdminOverviewSnapshot } from '../src/index'

describe('AdminOverviewContent', () => {
  it('renders deployment posture, health totals, capability gaps, audit shortcuts, and backend catalog status from the SDK manifest', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const manifest = await buildAdminOverviewSnapshot(client)
    const markup = renderToStaticMarkup(
      <AdminOverviewContent manifest={manifest} transportKind={client.transport.kind} />
    )

    expect(manifest.totals.services).toBeGreaterThan(0)
    expect(manifest.methods.length).toBeGreaterThan(0)
    expect(markup).toContain('Posture')
    expect(markup).toContain('Service mode')
    expect(markup).toContain('Health')
    expect(markup).toContain('Gaps')
    expect(markup).toContain('Refresh ID')
    expect(markup).toContain('Activity')
    expect(markup).toContain('Protected admin changes')
    expect(markup).toContain('/admin/services')
    expect(markup).toContain('/admin/config')
    expect(markup).not.toContain('visual mock')
  })
})
