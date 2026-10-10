import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  serializeRuntimeProfileDocument,
  type AuroraRuntimeProfileDocumentV2,
} from '../src/runtime-profile'
import { sanitizeRuntimeEndpoint } from '../src/profile-sanitizer'

interface ProfileVector {
  name: string
  allowPythonFull: boolean
  input: AuroraRuntimeProfileDocumentV2
  canonicalJson: string
}

const fixture = JSON.parse(readFileSync(new URL(
  '../../../rust/crates/aurora-voice-native/tests/fixtures/runtime-profile-canonical-v2.json',
  import.meta.url,
), 'utf8')) as { vectors: ProfileVector[] }

describe('UI output shared with the native canonical profile validator', () => {
  for (const vector of fixture.vectors) {
    it(vector.name, () => {
      expect(serializeRuntimeProfileDocument(vector.input, {
        allowPythonFull: vector.allowPythonFull,
      })).toBe(vector.canonicalJson)
    })
  }

  it('preserves several brokers in the first output with a derived signaling address', () => {
    const vector = fixture.vectors.find((item) => item.name === 'derived-signaling-multiple-brokers-first-output')!
    const first = JSON.parse(serializeRuntimeProfileDocument(vector.input)) as AuroraRuntimeProfileDocumentV2
    expect(first.profiles[0]?.homeConnection?.webrtcProfile?.signalingBrokers).toHaveLength(2)
    const second = JSON.parse(serializeRuntimeProfileDocument(first)) as AuroraRuntimeProfileDocumentV2
    expect(second.profiles[0]?.homeConnection?.webrtcProfile?.signalingBrokers).toHaveLength(1)
  })

  it('rejects decoded credential query keys with Unicode case folding', () => {
    for (const key of ['token', 'PASSWORD', 'paſſword', 'Key', '%6b%65%79', 'monkey']) {
      expect(() => sanitizeRuntimeEndpoint(
        `https://gateway.example.test/?${key}=private`,
        'address', new Set(['https:']), 'Runtime profile',
      )).toThrow()
    }
    expect(sanitizeRuntimeEndpoint(
      'https://gateway.example.test/?room=public',
      'address', new Set(['https:']), 'Runtime profile',
    )).toBe('https://gateway.example.test/?room=public')
  })

  it('uses Unicode letter and number categories for saved wake phrases', () => {
    const vector = fixture.vectors.find((item) => item.name === 'full-settings-assets-wake-overlay')!
    for (const phrase of ['Hey Aurora', 'Olá Aurora', '你好', 'Ⅷ Aurora', '٢ Aurora', '𐐀 Aurora', "Aurora's-call"]) {
      const document = structuredClone(vector.input)
      document.profiles[0]!.localNode.localSpeechSelection!.wakePhrase!.phrase = phrase
      expect(JSON.parse(serializeRuntimeProfileDocument(document)).profiles[0].localNode.localSpeechSelection.wakePhrase.phrase).toBe(phrase)
    }
    for (const phrase of ['😀 Aurora', '\u0345Aurora', 'A\u0301', '-Aurora', 'https:hello', 'Secret Aurora', 'paſſword', 'key=Aurora', 'a\tAurora', 'a\u2028Aurora']) {
      const document = structuredClone(vector.input)
      document.profiles[0]!.localNode.localSpeechSelection!.wakePhrase!.phrase = phrase
      expect(() => serializeRuntimeProfileDocument(document)).toThrow()
    }
  })

  it('trims ECMAScript whitespace and preserves other edge characters in identities', () => {
    const vector = fixture.vectors.find((item) => item.name === 'remote-http')!
    const trimmed = [
      '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
      '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
      '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
    ]
    for (const character of [...trimmed, '\u0085', '\u001c', '\u180e', '\u200b']) {
      const document = structuredClone(vector.input)
      document.activeProfileId = null
      document.profiles[0]!.id = `${character}home${character}`
      const saved = JSON.parse(serializeRuntimeProfileDocument(document)) as AuroraRuntimeProfileDocumentV2
      expect(saved.profiles[0]?.id).toBe(trimmed.includes(character) ? 'home' : `${character}home${character}`)
    }
  })
})
