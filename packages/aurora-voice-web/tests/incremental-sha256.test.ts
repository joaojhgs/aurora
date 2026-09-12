import { describe, expect, it } from 'vitest'

import { IncrementalSha256 } from '../src/incremental-sha256.js'

describe('IncrementalSha256', () => {
  it('matches WebCrypto across empty and uneven chunk boundaries', async () => {
    for (const bytes of [new Uint8Array(), patternedBytes(1), patternedBytes(63), patternedBytes(64), patternedBytes(131_123)]) {
      const digest = new IncrementalSha256()
      for (let offset = 0; offset < bytes.byteLength; offset += 997) {
        digest.update(bytes.subarray(offset, Math.min(bytes.byteLength, offset + 997)))
      }
      expect(digest.digestHex()).toBe(await webCryptoSha256(bytes))
    }
  })

  it('does not permit mutation after finalization', () => {
    const digest = new IncrementalSha256().update(new Uint8Array([1, 2, 3]))
    digest.digestHex()
    expect(() => digest.update(new Uint8Array([4]))).toThrow('already_finished')
    expect(() => digest.digestHex()).toThrow('already_finished')
  })
})

function patternedBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 17) & 0xff)
}

async function webCryptoSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
