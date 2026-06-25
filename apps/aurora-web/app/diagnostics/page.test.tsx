import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Page from './page'

describe('Diagnostics page', () => {
  it('renders SDK-backed diagnostics, redaction, and AdminAction export states', async () => {
    const markup = renderToStaticMarkup(await Page())

    expect(markup).toContain('Diagnostics Probes')
    expect(markup).toContain('Capability catalog snapshot')
    expect(markup).toContain('Mesh And Route Snapshot')
    expect(markup).toContain('Redaction Preview')
    expect(markup).toContain('Tokens and credentials')
    expect(markup).toContain('Support Bundle Export')
    expect(markup).toContain('AdminAction draft, confirmation, and audit receipt')
    expect(markup).toContain('privacy-blocked')
  })
})
