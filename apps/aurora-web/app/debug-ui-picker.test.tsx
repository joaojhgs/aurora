// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebugUiPicker } from './debug-ui-picker'

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.unstubAllEnvs()
  window.history.replaceState({}, '', '/')
})

describe('development preview picker', () => {
  it('does not render in production builds', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(<DebugUiPicker />)
    })
    expect(container.querySelector('[data-aurora-dev-preview]')).toBeNull()
  })

  it('renders surface, role, and access controls when debug launch is enabled', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_AURORA_DEBUG_UI', '1')
    window.history.replaceState({}, '', '/?aurora-surface=android&aurora-role=mesh-node&aurora-admin=1')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(<DebugUiPicker />)
    })
    expect(container.querySelector('[data-aurora-dev-preview]')).not.toBeNull()
    expect(container.textContent).toContain('Development preview')
    expect(container.querySelector('select[aria-label="Development preview surface"]')).toHaveProperty('value', 'android')
    expect(container.querySelector('select[aria-label="Development preview role"]')).toHaveProperty('value', 'mesh-node')
    expect(container.querySelector('select[aria-label="Development preview access"]')).toHaveProperty('value', 'admin')
  })
})
