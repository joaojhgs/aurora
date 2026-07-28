// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../src/shell'
import { errorShellSnapshot } from '../src/shell-data'

const snapshot = errorShellSnapshot('test', new Error('offline'))

describe('AppShell side-panel toggles', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('starts with both side panels closed and toggles each from the header', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot}>
          <div>Content</div>
        </AppShell>,
      )
    })

    const shell = container.firstElementChild as HTMLElement
    const navigation = container.querySelector<HTMLElement>('#primary-navigation')
    const mobileNavigation = container.querySelector<HTMLElement>('.aui-mobile-sheet')
    const menuButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show navigation menu"]')
    const activityButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show activity rail"]')
    const activity = container.querySelector<HTMLElement>('[aria-label="Aurora activity"]')

    expect(shell.dataset.navigationOpen).toBe('false')
    expect(shell.dataset.activityCollapsed).toBe('true')
    expect(navigation?.getAttribute('aria-hidden')).toBeNull()
    expect(mobileNavigation?.getAttribute('aria-hidden')).toBe('true')
    expect(activity?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => menuButton?.click())
    expect(shell.dataset.navigationOpen).toBe('true')
    expect(navigation?.getAttribute('aria-hidden')).toBeNull()
    expect(mobileNavigation?.getAttribute('aria-hidden')).toBe('false')
    expect(container.querySelector('button[aria-label="Hide navigation menu"]')).not.toBeNull()

    await act(async () => activityButton?.click())
    expect(shell.dataset.navigationOpen).toBe('false')
    expect(shell.dataset.activityCollapsed).toBe('false')
    expect(activity?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => {
      root.unmount()
    })
  })

  it('keeps the navigation menu open while navigating between routes', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onNavigate = vi.fn()

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot} currentPath="/assistant" onNavigate={onNavigate}>
          <div>Content</div>
        </AppShell>,
      )
    })

    const shell = container.firstElementChild as HTMLElement
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Show navigation menu"]')?.click()
    })
    expect(shell.dataset.navigationOpen).toBe('true')

    const destination = container.querySelector<HTMLAnchorElement>(
      '#primary-navigation a[href="/mesh"]',
    )
    await act(async () => destination?.click())

    expect(onNavigate).toHaveBeenCalledWith('/mesh')
    expect(shell.dataset.navigationOpen).toBe('true')
    expect(container.querySelector('button[aria-label="Hide navigation menu"]')).not.toBeNull()

    await act(async () => {
      root.unmount()
    })
  })

  it('hides admin navigation from non-admin peer sessions while retaining ordinary settings', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot} sessionIsAdmin={false} runtimeMode="web-thin">
          <div>Content</div>
        </AppShell>,
      )
    })

    expect(container.textContent).not.toContain('Operate · admin only')
    expect(container.querySelector('a[href="/admin"]')).toBeNull()
    expect(container.querySelector('[data-mobile-tab="admin"]')).toBeNull()
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull()
    expect(container.querySelector('[data-mobile-tab="settings"]')).not.toBeNull()
    expect(container.textContent).toContain('Web Thin')
    expect(container.textContent).toContain('member')
    expect(container.textContent).toContain('Scoped access')
    expect(container.textContent).not.toContain('Full access')

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot} sessionIsAdmin runtimeMode="web-thin">
          <div>Content</div>
        </AppShell>,
      )
    })

    expect(container.textContent).toContain('Operate · admin only')
    expect(container.querySelector('a[href="/admin"]')).not.toBeNull()
    expect(container.querySelector('[data-mobile-tab="admin"]')).not.toBeNull()
    expect(container.textContent).toContain('admin')
    expect(container.textContent).toContain('Full access')

    await act(async () => root.unmount())
  })
})
