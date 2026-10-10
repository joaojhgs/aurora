import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, MockAuroraTransport } from '@aurora/client'
import { AdminOverviewContent, buildAdminOverviewSnapshot } from '../src/index'

describe('AdminOverviewContent', () => {
  it('renders loading as progress instead of an error alert', () => {
    const markup = renderToStaticMarkup(
      <AdminOverviewContent manifest={null} transportKind="http" loading />
    )

    expect(markup).toContain('Service overview loading')
    expect(markup).toContain('data-slot="skeleton"')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('role="alert"')
    expect(markup).not.toContain('Service overview unavailable')
  })

  it('renders unavailable overview through the shared route notice while preserving diagnostics navigation', () => {
    const markup = renderToStaticMarkup(
      <AdminOverviewContent manifest={null} transportKind="http" error={{ code: 'transport_loss' }} />
    )

    expect(markup).toContain('Service overview unavailable')
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('href="/diagnostics"')
  })

  it('renders readiness, health totals, unavailable features, audit shortcuts, and product-facing status from the SDK manifest', async () => {
    const client = new Aurora({ transport: new MockAuroraTransport() })
    const manifest = await buildAdminOverviewSnapshot(client)
    const markup = renderToStaticMarkup(
      <AdminOverviewContent manifest={manifest} transportKind={client.transport.kind} />
    )

    expect(manifest.totals.services).toBeGreaterThan(0)
    expect(manifest.methods.length).toBeGreaterThan(0)
    expect(markup).toContain('Readiness')
    expect(markup).toContain('How Aurora is running')
    expect(markup).toContain('Health')
    expect(markup).toContain('Unavailable features')
    expect(markup).toContain('Last update')
    expect(markup).toContain('Activity')
    expect(markup).toContain('Protected actions')
    expect(markup).toContain('/admin/services')
    expect(markup).toContain('/admin/config')
    expect(markup).toContain('Settings impact')
    expect(markup).not.toContain('visual mock')
    expect(markup).not.toContain('Posture')
    expect(markup).not.toContain('Service mode')
    expect(markup).not.toContain('Refresh ID')
    expect(markup).not.toContain('Refresh ID sample')
    expect(markup).not.toContain('threads')
    expect(markup).not.toContain('processes')
    expect(markup).not.toContain('Process runbook')
    expect(markup).not.toContain('Config reload impact')
    expect(markup).not.toContain('Rail')
  })
})
