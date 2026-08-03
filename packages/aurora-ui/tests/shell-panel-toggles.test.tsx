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
    expect(mobileNavigation?.hidden).toBe(true)
    expect(activity?.getAttribute('aria-hidden')).toBe('true')

    await act(async () => menuButton?.click())
    expect(shell.dataset.navigationOpen).toBe('true')
    expect(navigation?.getAttribute('aria-hidden')).toBeNull()
    expect(mobileNavigation?.getAttribute('aria-hidden')).toBe('false')
    expect(mobileNavigation?.hidden).toBe(false)
    expect(container.querySelector('button[aria-label="Hide navigation menu"]')).not.toBeNull()

    await act(async () => activityButton?.click())
    expect(shell.dataset.navigationOpen).toBe('false')
    expect(shell.dataset.activityCollapsed).toBe('false')
    expect(mobileNavigation?.hidden).toBe(true)
    expect(activity?.getAttribute('aria-hidden')).toBe('false')

    await act(async () => {
      root.unmount()
    })
  })

  it('closes the navigation menu after navigating between routes', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const onNavigate = vi.fn()
    const navigableSnapshot = {
      ...snapshot,
      routes: snapshot.routes.map((route) => route.item.id === 'mesh'
        ? { ...route, disabled: false, routeable: true, state: 'available-local' as const, blockers: [] }
        : route),
    }

    await act(async () => {
      root.render(
        <AppShell snapshot={navigableSnapshot} currentPath="/assistant" onNavigate={onNavigate}>
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
      '.aui-mobile-sheet a[href="/mesh"]',
    )
    destination?.focus()
    expect(document.activeElement).toBe(destination)
    await act(async () => destination?.click())

    expect(onNavigate).toHaveBeenCalledWith('/mesh')
    expect(shell.dataset.navigationOpen).toBe('false')
    expect(container.querySelector<HTMLElement>('.aui-mobile-sheet')?.hidden).toBe(true)
    const closedMenuButton = container.querySelector<HTMLButtonElement>('button[aria-label="Show navigation menu"]')
    expect(closedMenuButton).not.toBeNull()
    expect(document.activeElement).toBe(closedMenuButton)

    await act(async () => {
      root.unmount()
    })
  })

  it('returns the content viewport to the top when the active route changes', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot} currentPath="/mesh">
          <div>Mesh content</div>
        </AppShell>,
      )
    })

    const content = container.querySelector<HTMLElement>('main#content')!
    content.scrollTop = 640

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot} currentPath="/settings">
          <div>Settings content</div>
        </AppShell>,
      )
    })

    expect(content.scrollTop).toBe(0)

    await act(async () => root.unmount())
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
    expect(container.querySelector('a[href="/admin/services"]')).toBeNull()
    expect(container.querySelector('a[href="/admin/tokens"]')).toBeNull()
    expect(container.querySelector('a[href="/settings"]')).not.toBeNull()
    expect(container.querySelector('[data-mobile-tab="settings"]')).not.toBeNull()
    expect(container.textContent).toContain('Connected to Aurora')
    expect(container.textContent).toContain('member')
    expect(container.textContent).toContain('Limited access')
    expect(container.textContent).not.toContain('Scoped access')
    expect(container.textContent).not.toContain('Full access')
    expect(container.textContent).not.toContain('Web Thin')

    await act(async () => {
      root.render(
        <AppShell snapshot={snapshot} sessionIsAdmin runtimeMode="web-thin">
          <div>Content</div>
        </AppShell>,
      )
    })

    expect(container.textContent).toContain('Operate · admin only')
    expect(container.querySelector('a[href="/admin"]')).not.toBeNull()
    expect(container.querySelector('[data-mobile-tab="admin"]')).toBeNull()
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-mobile-tab]'))
        .map((tab) => tab.dataset.mobileTab),
    ).toEqual(['assistant', 'mesh', 'settings'])
    expect(container.querySelector('a[href="/admin/services"]')).not.toBeNull()
    expect(container.querySelector('a[href="/admin/tokens"]')).not.toBeNull()
    expect(container.textContent).toContain('admin')
    expect(container.textContent).toContain('Administrator on Aurora unavailable')
    expect(container.textContent).not.toContain('Full access')
    expect(container.textContent).not.toContain('Web Thin')

    await act(async () => root.unmount())
  })

  it('updates the mobile product-role label when the same native surface changes role', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const mobileSnapshot = {
      ...snapshot,
      loadState: 'ready' as const,
      error: null,
      nativePlatform: 'android',
      nodeName: 'Home Aurora',
    }

    await act(async () => {
      root.render(
        <AppShell snapshot={mobileSnapshot} runtimeMode="mobile-native" nodeMode="remote-console">
          <div>Content</div>
        </AppShell>,
      )
    })
    expect(container.textContent).toContain('Connected to Home Aurora')
    expect(container.textContent).not.toContain('This device is available')

    await act(async () => {
      root.render(
        <AppShell snapshot={mobileSnapshot} runtimeMode="mobile-native" nodeMode="mesh-node">
          <div>Content</div>
        </AppShell>,
      )
    })
    expect(container.textContent).toContain('This device is available')

    await act(async () => root.unmount())
  })
})
