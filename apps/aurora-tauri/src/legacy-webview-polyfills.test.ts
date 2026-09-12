import { describe, expect, it } from 'vitest'

import { installLegacyWebViewPolyfills } from './legacy-webview-polyfills'

describe('legacy Android WebView polyfills', () => {
  it('installs a non-enumerable Array.at fallback with negative-index support', () => {
    const prototype: {
      at?: (this: unknown[], index: number) => unknown
    } = {}

    installLegacyWebViewPolyfills(prototype)

    expect(prototype.at?.call(['first', 'last'], 0)).toBe('first')
    expect(prototype.at?.call(['first', 'last'], Number.NaN)).toBe('first')
    expect(prototype.at?.call(['first', 'last'], -1)).toBe('last')
    expect(prototype.at?.call(['first', 'last'], Infinity)).toBeUndefined()
    expect(prototype.at?.call(['first', 'last'], 9)).toBeUndefined()
    expect(Object.keys(prototype)).not.toContain('at')
  })
})
