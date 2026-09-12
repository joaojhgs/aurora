import { describe, expect, it } from 'vitest'
import {
  BrowserEnvelopeCryptoPort,
  BrowserIndexedDbLocalDataBackend,
} from '@aurora/ui/local-data/browser'

describe('@aurora/ui browser local-data package export', () => {
  it('exposes only the browser-safe IndexedDB and envelope adapters', () => {
    expect(BrowserEnvelopeCryptoPort).toBeTypeOf('function')
    expect(BrowserIndexedDbLocalDataBackend).toBeTypeOf('function')
  })
})
