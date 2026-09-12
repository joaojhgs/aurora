import { describe, expect, it } from 'vitest'

import {
  assertNoInteropSeededSecrets,
  redactInteropArtifactValue,
  redactInteropSeededText,
} from '../../../tests/e2e/webrtc_interop/assertions.js'

describe('WebRTC interop artifact redaction', () => {
  it('redacts every generated secret from nested success and failure evidence', () => {
    const secrets = ['room-secret-value', 'token-value']
    const evidence = {
      error: `failed for ${secrets[0]}`,
      nested: {
        token: secrets[1],
        repeated: `${secrets[0]}:${secrets[0]}`,
      },
    }

    const redacted = redactInteropArtifactValue(evidence, secrets)

    expect(redacted).toEqual({
      error: 'failed for [REDACTED]',
      nested: {
        token: '[REDACTED]',
        repeated: '[REDACTED]:[REDACTED]',
      },
    })
    expect(() =>
      assertNoInteropSeededSecrets(redacted, secrets),
    ).not.toThrow()
  })

  it('detects leaks without echoing the credential in the error', () => {
    const secret = 'do-not-print-this-secret'

    expect(() =>
      assertNoInteropSeededSecrets({ secret }, [secret]),
    ).toThrow('contains 1 seeded secret value')
    try {
      assertNoInteropSeededSecrets({ secret }, [secret])
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })

  it('ignores empty seed entries while redacting text', () => {
    expect(
      redactInteropSeededText('token=secret', ['', 'secret']),
    ).toBe('token=[REDACTED]')
  })
})
