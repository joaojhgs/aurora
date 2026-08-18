// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DebugUiIndicator,
  DebugUiPicker,
  debugUiBadgeLabel,
  resetAuroraDebugUiIndicatorForTests,
} from './debug-ui-picker'
import { AURORA_DEBUG_UI_ROOT_ID, AURORA_DEBUG_VIEWPORT_ROOT_ID } from './debug-ui-override'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  resetAuroraDebugUiIndicatorForTests()
  document.body.innerHTML = ''
  document.cookie = 'aurora-debug-ui=; Path=/; Max-Age=0'
  window.sessionStorage.clear()
  vi.unstubAllEnvs()
  window.history.replaceState({}, '', '/')
})

function renderPreview(children?: React.ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <>
        <DebugUiIndicator />
        <DebugUiPicker>{children}</DebugUiPicker>
      </>,
    )
  })
  return container
}

describe('development preview picker', () => {
  it('does not render in production builds', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    renderPreview()
    expect(document.querySelector('[data-aurora-dev-preview]')).toBeNull()
    expect(document.getElementById(AURORA_DEBUG_UI_ROOT_ID)).toBeNull()
    expect(document.body.querySelector('[data-aurora-debug-viewport]')).toBeNull()
    expect(document.getElementById('aurora-debug-ui-runtime-css')).toBeNull()
  })

  it('does not inject badge, overlay, or emulator unless the debug UI flag is set', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '')
    window.history.replaceState({}, '', '/?aurora-surface=android&aurora-role=mesh-node&aurora-viewport=phone')
    renderPreview(<div>shell</div>)
    expect(document.querySelector('[data-aurora-dev-preview]')).toBeNull()
    expect(document.querySelector('[data-aurora-dev-preview-badge]')).toBeNull()
    expect(document.getElementById(AURORA_DEBUG_UI_ROOT_ID)).toBeNull()
    expect(document.body.querySelector('[data-aurora-debug-viewport]')).toBeNull()
    expect(document.getElementById('aurora-debug-ui-runtime-css')).toBeNull()
    expect(document.documentElement.hasAttribute('data-aurora-debug-compact')).toBe(false)
  })

  it('renders a compact chip and frames a mobile viewport for android', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/?aurora-surface=android&aurora-role=mesh-node&aurora-admin=1')
    const container = renderPreview(<div data-testid="shell">shell</div>)
    const badge = document.querySelector('[data-aurora-dev-preview-badge]') as HTMLButtonElement | null
    const host = document.getElementById(AURORA_DEBUG_UI_ROOT_ID)
    expect(badge).not.toBeNull()
    expect(badge?.classList.contains('aurora-debug-ui-badge')).toBe(true)
    expect(badge?.textContent?.trim()).toBe('A')
    expect(badge?.style.position).toBe('fixed')
    expect(badge?.style.right).toBe('16px')
    expect(badge?.style.bottom).toBe('16px')
    expect(badge?.getAttribute('aria-label')).toBe('Development preview: Android · Make available · Phone · Admin')
    expect(host).not.toBeNull()
    expect(host?.className).toBe('aurora-debug-ui-host')
    expect(document.body.contains(badge)).toBe(true)
    expect(badge?.closest(`#${AURORA_DEBUG_UI_ROOT_ID}`)).toBe(host)
    expect(document.querySelector('[data-aurora-debug-viewport="phone"]')).not.toBeNull()
    expect(document.querySelector('[data-aurora-debug-viewport-frame="phone"]')).not.toBeNull()
    expect(document.documentElement.getAttribute('data-aurora-debug-compact')).toBe('phone')
    expect(container.querySelector('[data-aurora-debug-viewport="phone"]')).not.toBeNull()
    expect(document.querySelector('select[aria-label="Development preview viewport"]')).toBeNull()

    act(() => {
      badge?.click()
    })
    expect(host?.textContent).toContain('Development preview')
    expect(document.querySelector('select[aria-label="Development preview surface"]')).toHaveProperty('value', 'android')
    expect(document.querySelector('select[aria-label="Development preview role"]')).toHaveProperty('value', 'mesh-node')
    expect(document.querySelector('select[aria-label="Development preview access"]')).toHaveProperty('value', 'admin')
    expect(document.querySelector('select[aria-label="Development preview viewport"]')).toHaveProperty('value', 'phone')
  })

  it('keeps desktop/web full-bleed unless a viewport is chosen', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/?aurora-surface=web&aurora-role=remote-console&aurora-admin=0')
    const container = renderPreview(<div>shell</div>)
    expect(document.querySelector('[data-aurora-dev-preview-badge]')?.getAttribute('aria-label'))
      .toBe('Development preview: Web · Connect · Full')
    expect(container.querySelector('[data-aurora-debug-viewport]')).toBeNull()
    expect(document.querySelector('[data-aurora-debug-viewport]')).toBeNull()
    expect(document.getElementById(AURORA_DEBUG_VIEWPORT_ROOT_ID)).toBeNull()
    expect(document.documentElement.hasAttribute('data-aurora-debug-compact')).toBe(false)
  })

  it('frames an explicit phone viewport even on web', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/?aurora-surface=web&aurora-role=remote-console&aurora-viewport=phone')
    const container = renderPreview(<div>shell</div>)
    expect(document.querySelector('[data-aurora-dev-preview-badge]')?.getAttribute('aria-label'))
      .toBe('Development preview: Web · Connect · Phone')
    expect(document.querySelector('[data-aurora-debug-viewport="phone"]')).not.toBeNull()
    expect(document.documentElement.getAttribute('data-aurora-debug-compact')).toBe('phone')
  })

  it('frames leftover android full-bleed as phone and drops the frame when Full is chosen', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/?aurora-surface=android&aurora-role=mesh-node&aurora-viewport=full')
    const container = renderPreview(<div data-testid="shell">shell</div>)
    const badge = document.querySelector('[data-aurora-dev-preview-badge]') as HTMLButtonElement
    expect(badge.getAttribute('aria-label')).toBe('Development preview: Android · Make available · Phone')
    expect(document.querySelector('[data-aurora-debug-viewport="phone"]')).not.toBeNull()

    act(() => {
      badge.click()
    })
    const viewport = document.querySelector('select[aria-label="Development preview viewport"]') as HTMLSelectElement
    act(() => {
      viewport.value = 'full'
      viewport.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.querySelector('[data-aurora-debug-viewport]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-aurora-debug-compact')).toBe(false)
    expect(document.querySelector('[data-aurora-dev-preview-badge]')?.getAttribute('aria-label'))
      .toBe('Development preview: Android · Make available · Full')
  })

  it('keeps the last known chip if override sources disappear', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/?aurora-surface=android&aurora-role=mesh-node&aurora-viewport=phone')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(<DebugUiIndicator />)
    })
    expect(document.querySelector('[data-aurora-dev-preview-badge]')?.getAttribute('aria-label'))
      .toBe('Development preview: Android · Make available · Phone')

    act(() => {
      root.unmount()
    })
    roots.splice(roots.indexOf(root), 1)
    window.history.replaceState({}, '', '/')
    document.cookie = 'aurora-debug-ui=; Path=/; Max-Age=0'
    window.sessionStorage.clear()
    const remount = createRoot(container)
    roots.push(remount)
    act(() => {
      remount.render(<DebugUiIndicator />)
    })
    expect(document.querySelector('[data-aurora-dev-preview-badge]')?.getAttribute('aria-label'))
      .toBe('Development preview: Android · Make available · Phone')
    expect(document.querySelector('[data-aurora-dev-preview-badge]')).not.toBeNull()
  })

  it('shows the compact chip in development even without a query override', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/')
    renderPreview(<div>shell</div>)
    const badge = document.querySelector('[data-aurora-dev-preview-badge]') as HTMLButtonElement | null
    expect(badge).not.toBeNull()
    expect(badge?.textContent?.trim()).toBe('A')
    expect(badge?.getAttribute('aria-label')).toBe('Development preview: Web · Connect · Full')
    expect(document.querySelector('[data-aurora-debug-viewport]')).toBeNull()
  })

  it('formats badge copy for the current surface, role, and viewport', () => {
    expect(debugUiBadgeLabel({
      surface: 'web',
      role: 'remote-console',
      admin: false,
      viewport: 'full',
      viewportExplicit: false,
    })).toBe('Web · Connect · Full')
    expect(debugUiBadgeLabel({
      surface: 'android',
      role: 'mesh-node',
      admin: false,
      viewport: 'phone',
      viewportExplicit: false,
    })).toBe('Android · Make available · Phone')
  })
})
