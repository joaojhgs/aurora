import { describe, expect, it } from 'vitest'

import { canonicalJson as toolsCanonicalJson } from '../src/local-tools/canonical-json.js'
import { canonicalJson as webrtcCanonicalJson } from '../src/webrtc/encoding.js'

describe('WebRTC canonical JSON', () => {
  it('matches local-tools ASCII escaping and code-point key order', () => {
    const value = { z: 1, a: 2, '😀': 'snow☃' }
    const encoded = webrtcCanonicalJson(value)
    expect(encoded).toBe(toolsCanonicalJson(value, { ensureAscii: true }))
    expect(encoded).toContain('\\ud83d\\ude00')
    expect(encoded).toContain('\\u2603')
    expect(encoded.startsWith('{"a":')).toBe(true)
  })
})
