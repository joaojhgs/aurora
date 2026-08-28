import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import Page from './page'

vi.mock('../../shell-state', () => ({
  getShellSnapshot: vi.fn(async () => ({
    routes: [],
    evidenceSource: 'local snapshot',
  })),
}))

describe('Data policy page unavailable state', () => {
  it('renders a user-facing recovery message', async () => {
    const markup = renderToStaticMarkup(await Page())

    expect(markup).toContain('Data settings are not available from this connection yet.')
    expect(markup).not.toContain('capability graph')
    expect(markup).not.toContain('AuroraClient')
  })
})
