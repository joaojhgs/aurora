// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  BrowserShellBootScreen,
  BrowserShellStartError,
} from './shell-startup'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
})

describe('shell startup presentation', () => {
  it('renders the hosted web boot state with accessible progress semantics', () => {
    const markup = renderToStaticMarkup(<BrowserShellBootScreen />)

    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('aria-label="Loading Aurora"')
    expect(markup).toContain('data-browser-shell-boot="true"')
    expect(markup).toContain('Loading Aurora…')
    expect(markup).not.toContain('Try again')
  })

  it('renders the hosted web start failure with safe recovery copy', () => {
    const markup = renderToStaticMarkup(<BrowserShellStartError onRetry={() => undefined} />)

    expect(markup).toContain('data-browser-shell-start="failed"')
    expect(markup).toContain('Aurora could not start on this device.')
    expect(markup).toContain('Your saved connection is safe. Try opening Aurora again.')
    expect(markup).toContain('Try again')
    expect(markup).not.toContain('token')
    expect(markup).not.toContain('stack')
  })

  it('fires the hosted web retry action', async () => {
    const onRetry = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<BrowserShellStartError onRetry={onRetry} />)
      await Promise.resolve()
    })

    const retryButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Try again')
    expect(retryButton).toBeDefined()

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
