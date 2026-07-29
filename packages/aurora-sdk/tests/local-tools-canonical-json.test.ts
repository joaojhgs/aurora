import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { canonicalJson, canonicalJsonSha256Hex, CanonicalJsonError } from '../src/local-tools/canonical-json.js'
import { globalToolId, percentEncodeRfc3986Utf8, providerServiceInstanceId, toolSchemaHash } from '../src/local-tools/identity.js'

const providerInventory = JSON.parse(readFileSync(resolve(process.cwd(), 'src/generated/tooling-local-provider-v1.json'), 'utf8'))

describe('local-tools canonical JSON', () => {
  it('matches Python canonical digest vectors with Unicode preserved and sorted keys', () => {
    for (const item of providerInventory.canonical_digest_vectors.canonical_digest_cases) {
      expect(canonicalJsonSha256Hex(item.canonical_a, { ensureAscii: true })).toBe(item.digest)
      expect(canonicalJsonSha256Hex(item.canonical_b, { ensureAscii: true })).toBe(item.digest)
    }
    expect(canonicalJson(providerInventory.canonical_digest_vectors.schema_digest.canonical_a)).toContain('☃')
    expect(canonicalJsonSha256Hex(providerInventory.canonical_digest_vectors.schema_digest.canonical_a, { ensureAscii: true })).toBe(
      providerInventory.canonical_digest_vectors.schema_digest.digest
    )
    expect(canonicalJsonSha256Hex(providerInventory.canonical_digest_vectors.schema_digest.canonical_b, { ensureAscii: true })).toBe(
      providerInventory.canonical_digest_vectors.schema_digest.digest
    )
  })

  it('rejects values that Python catalog hashes must not accept silently', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ a: -0 })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ constructor: 'polluted' })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(Object.create(null))).toThrow(CanonicalJsonError)
  })

  it('uses the exact Python Tooling schema-hash payload', () => {
    const tool = providerInventory.canonical_digest_vectors.tool_schema_hash.canonical_tool
    expect(toolSchemaHash(tool)).toBe(providerInventory.canonical_digest_vectors.tool_schema_hash.digest)
  })
})

describe('local-tools identity', () => {
  it('uses Python-compatible RFC3986 UTF-8 percent encoding', () => {
    expect(percentEncodeRfc3986Utf8("peer!'()*")).toBe('peer%21%27%28%29%2A')
    expect(providerServiceInstanceId('peer-☃')).toBe('local:peer-%E2%98%83:Tooling')
    expect(canonicalJsonSha256Hex(providerInventory.canonical_digest_vectors.identity_digest.canonical_a, { ensureAscii: true })).toBe(
      providerInventory.canonical_digest_vectors.identity_digest.digest
    )
  })

  it('matches Python canonical global tool ID vectors', () => {
    const identity = providerInventory.canonical_digest_vectors.canonical_tool_identity
    expect(globalToolId(identity.stable_peer_id, identity.tool_contract_id)).toBe(identity.global_tool_id)
    for (const item of providerInventory.canonical_digest_vectors.canonical_tool_identity_cases) {
      expect(globalToolId(item.stable_peer_id, item.tool_contract_id)).toBe(item.global_tool_id)
    }
  })
})
