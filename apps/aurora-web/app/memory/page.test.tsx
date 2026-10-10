import { renderToReadableStream } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import Page from './page'

vi.mock('../shell-state', () => ({
  getShellSnapshot: vi.fn(async () => ({
    routes: [],
    evidenceSource: 'local snapshot',
  })),
}))

describe('Memory page unavailable state', () => {
  it('renders a user-facing recovery message', async () => {
    const stream = await renderToReadableStream(await Page())
    await stream.allReady
    const markup = await new Response(stream).text()

    expect(markup).toContain('Memory &amp; Knowledge')
    expect(markup).toContain('This feature is available through Aurora.')
    expect(markup).not.toContain('capability graph')
    expect(markup).not.toContain('AuroraClient')
  })
})
