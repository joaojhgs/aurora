import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Page from './page'

describe('Diagnostics page', () => {
  it('renders product-safe diagnostics, redaction, and support export states', async () => {
    const markup = renderToStaticMarkup(await Page())

    expect(markup).toContain('Health Checks')
    expect(markup).toContain('Available Features')
    expect(markup).toContain('Device Connection')
    expect(markup).toContain('Trusted device connection health')
    expect(markup).toContain('Redaction Preview')
    expect(markup).toContain('Tokens and credentials')
    expect(markup).toContain('Support Bundle Export')
    expect(markup).toContain('Confirmation controls are loading')

    const appOwnedMarkup = markup.slice(0, markup.indexOf('<div class="flex flex-col gap-6">'))
    expect(appOwnedMarkup).not.toMatch(/Gateway\.|WebRTC|DataChannel|sidecar|evidence|SDK|fallback|provider|contract|raw|room-password|\/home\//i)
  })
})
