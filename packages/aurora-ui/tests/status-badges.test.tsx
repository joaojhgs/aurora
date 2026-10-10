// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HealthBadge } from '../src/status-badges'

let root: Root | undefined

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
})

describe('HealthBadge product status', () => {
  it.each([
    ['Degraded', 'Needs attention', 'text-warning'],
    ['Healthy', 'Healthy', 'text-success'],
    ['Offline', 'Offline', 'text-destructive'],
  ])('renders %s with readable status and its existing tone', async (health, label, tone) => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root!.render(
        <div aria-label="Aurora shell status">
          <HealthBadge health={health} />
        </div>,
      )
    })

    const status = container.querySelector('[aria-label="Aurora shell status"]')!
    const badge = status.querySelector('[data-slot="badge"]')!
    expect(status.textContent).toBe(label)
    expect(badge.classList.contains(tone)).toBe(true)
    expect(badge.getAttribute('aria-hidden')).not.toBe('true')
    expect(badge.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    if (health === 'Degraded') {
      expect(status.textContent).toMatch(/needs attention|refresh needed/iu)
    }
  })
})
