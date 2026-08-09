import { describe, expect, it } from 'vitest'

import {
  AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
  AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
  installVerifiedBrowserModelPack,
  openActiveBrowserModelPack,
  verifyBrowserModelPackManifest,
  type AuroraBrowserModelPackManifest
} from '../src/browser-model-pack.js'
import { MemoryWebModelStoreHost } from '../src/test-doubles/index.js'

const TEST_PRIVATE_KEY_PKCS8_BASE64 = 'MC4CAQAwBQYDK2VwBCIEIBVNj/cSHz9pWMrteoqMMTyDd+p51OEdgbIRQJDEHiBP'
const TEST_PUBLIC_KEY_BASE64 = 'k1NEXA5D4H1jAs3GBxo9Cr42I6BUeYEA/HqYiTOUKhc='
const TEST_RELEASE_KEY_ID = 'aurora-release-web-wasm-test'

describe('browser model pack verification', () => {
  it('requires signed trust and keeps non-production trust behind an explicit option', async () => {
    const manifest = await signedManifest(new Uint8Array([1, 2, 3]))

    await expect(verifyBrowserModelPackManifest({ ...manifest, signature: null })).rejects.toMatchObject({ code: 'unsigned' })
    await expect(verifyBrowserModelPackManifest(manifest)).rejects.toMatchObject({ code: 'untrusted_key' })
    await expect(verifyBrowserModelPackManifest(manifest, { allowNonProductionTestSignature: true })).resolves.toMatchObject({
      pack_id: 'pockettts-web-test',
      verification_mode: 'signature',
      key_id: AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
      variant_id: 'web-wasm32-test'
    })
  })

  it('installs a verified pack and reopens promoted bytes offline after reload', async () => {
    const bytes = new Uint8Array([4, 5, 6, 7])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    let fetchCount = 0

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      fetchBytes: async (url) => {
        fetchCount += 1
        expect(url).toBe('/fixtures/pockettts-web-test.bin')
        return bytes
      },
      nowMs: () => 42
    })

    expect(fetchCount).toBe(1)
    expect(receipt).toMatchObject({
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verificationMode: 'signature',
      verificationKeyId: AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
      identity: {
        packId: 'pockettts-web-test',
        packVersion: '1.0.0',
        variantId: 'web-wasm32-test',
        scope: { task: 'stt', slotId: 'default' }
      }
    })

    const reopened = await openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    expect(reopened?.identity).toEqual(receipt.identity)
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual([4, 5, 6, 7])
  })

  it('requires release key, release hash, and signature for production release-hash trust', async () => {
    const manifest = await signedManifest(new Uint8Array([41, 42, 43]), {}, TEST_RELEASE_KEY_ID)
    const expectedReleaseManifestSha256 = await manifestSha256(manifest)
    const trustedReleaseKeys = [{ keyId: TEST_RELEASE_KEY_ID, publicKeyBase64: TEST_PUBLIC_KEY_BASE64 }]

    await expect(verifyBrowserModelPackManifest(manifest, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256
    })).resolves.toMatchObject({
      manifest_sha256: expectedReleaseManifestSha256,
      verification_mode: 'release-hash',
      key_id: TEST_RELEASE_KEY_ID
    })

    await expect(verifyBrowserModelPackManifest(manifest, { trustedReleaseKeys }))
      .rejects.toMatchObject({ code: 'release_hash' })
    await expect(verifyBrowserModelPackManifest(manifest, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256: '0'.repeat(64)
    })).rejects.toMatchObject({ code: 'release_hash' })
    await expect(verifyBrowserModelPackManifest(manifest, {
      trustedReleaseKeys: [],
      expectedReleaseManifestSha256
    })).rejects.toMatchObject({ code: 'untrusted_key' })
    await expect(verifyBrowserModelPackManifest({ ...manifest, signature: null }, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256
    })).rejects.toMatchObject({ code: 'unsigned' })

    const signature = manifest.signature
    expect(signature).not.toBeNull()
    expect(signature).toBeDefined()
    await expect(verifyBrowserModelPackManifest({
      ...manifest,
      signature: {
        key_id: signature?.key_id ?? TEST_RELEASE_KEY_ID,
        algorithm: signature?.algorithm ?? AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
        value: encodeBase64(new Uint8Array(64))
      }
    }, {
      trustedReleaseKeys,
      expectedReleaseManifestSha256
    })).rejects.toMatchObject({ code: 'signature' })
  })

  it('reopens release-hash trusted packs offline only when the pinned hash is supplied again', async () => {
    const bytes = new Uint8Array([51, 52, 53, 54])
    const manifest = await signedManifest(bytes, {}, TEST_RELEASE_KEY_ID)
    const releaseTrust = {
      trustedReleaseKeys: [{ keyId: TEST_RELEASE_KEY_ID, publicKeyBase64: TEST_PUBLIC_KEY_BASE64 }],
      expectedReleaseManifestSha256: await manifestSha256(manifest)
    }
    const host = new MemoryWebModelStoreHost()
    let fetchCount = 0

    const receipt = await installVerifiedBrowserModelPack({
      host,
      manifest,
      ...releaseTrust,
      fetchBytes: async () => {
        fetchCount += 1
        return bytes
      }
    })

    expect(receipt).toMatchObject({
      manifestSha256: releaseTrust.expectedReleaseManifestSha256,
      verificationMode: 'release-hash',
      verificationKeyId: TEST_RELEASE_KEY_ID
    })
    expect(fetchCount).toBe(1)

    const reopened = await openActiveBrowserModelPack(host, { task: 'stt' }, releaseTrust)
    expect(Array.from(await reopened?.files[0]?.readAll() ?? [])).toEqual([51, 52, 53, 54])
    expect(fetchCount).toBe(1)
    await expect(openActiveBrowserModelPack(host, { task: 'stt' }, {
      trustedReleaseKeys: releaseTrust.trustedReleaseKeys
    })).rejects.toMatchObject({ code: 'release_hash' })
  })

  it('rejects duplicate active file ids instead of reopening an incomplete two-file pack', async () => {
    const firstBytes = new Uint8Array([61, 62, 63])
    const secondBytes = new Uint8Array([71, 72, 73])
    const manifest = await signedTwoFileManifest(firstBytes, secondBytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      fetchBytes: async (url) => {
        if (url === '/fixtures/pockettts-web-test-a.bin') return firstBytes
        if (url === '/fixtures/pockettts-web-test-b.bin') return secondBytes
        throw new Error(`unexpected fixture url: ${url}`)
      }
    })

    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    expect(activeKey).toBeDefined()
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      files: Array<Record<string, unknown>>
    }
    active.files = [active.files[0] ?? {}, { ...(active.files[0] ?? {}) }]
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })
  })

  it('rejects duplicate manifest and receipt file collections at trust boundaries', async () => {
    const firstBytes = new Uint8Array([81, 82, 83])
    const secondBytes = new Uint8Array([91, 92, 93])
    const manifest = await signedTwoFileManifest(firstBytes, secondBytes)

    await expect(verifyBrowserModelPackManifest({
      ...manifest,
      files: [
        manifest.files[0] ?? manifest.files[1]!,
        { ...(manifest.files[1] ?? manifest.files[0]!), file_id: manifest.files[0]?.file_id ?? 'model-a' }
      ]
    }, { allowNonProductionTestSignature: true })).rejects.toMatchObject({ code: 'duplicate_id' })

    await expect(verifyBrowserModelPackManifest({
      ...manifest,
      variants: [{
        ...(manifest.variants[0] ?? {
          variant_id: 'web-wasm32-test',
          target: 'web',
          os: 'web',
          arch: 'wasm32'
        }),
        file_ids: ['model-a', 'model-a']
      }]
    }, { allowNonProductionTestSignature: true })).rejects.toMatchObject({ code: 'duplicate_id' })

    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      fetchBytes: async (url) => url.endsWith('-a.bin') ? firstBytes : secondBytes
    })
    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      verification_receipt: {
        file_ids: string[]
        files: Array<Record<string, unknown>>
      }
    }

    active.verification_receipt.file_ids = ['model-a', 'model-a']
    await host.writeJson(activeKey ?? '', JSON.stringify(active))
    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })

    active.verification_receipt.file_ids = ['model-a', 'model-b']
    active.verification_receipt.files = [
      active.verification_receipt.files[0] ?? {},
      { ...(active.verification_receipt.files[0] ?? {}) }
    ]
    await host.writeJson(activeKey ?? '', JSON.stringify(active))
    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })
  })

  it('rejects forged active metadata instead of trusting browser-mutable receipts', async () => {
    const bytes = new Uint8Array([8, 9, 10])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      fetchBytes: async () => bytes
    })

    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    expect(activeKey).toBeDefined()
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as {
      manifest_json: string
      verification_receipt: { manifest_sha256: string }
    }
    active.verification_receipt.manifest_sha256 = '0'.repeat(64)
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'receipt' })
  })

  it('rejects signed-manifest tampering on offline reopen', async () => {
    const bytes = new Uint8Array([11, 12, 13])
    const manifest = await signedManifest(bytes)
    const host = new MemoryWebModelStoreHost()
    await installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      fetchBytes: async () => bytes
    })

    const [activeKey] = await host.listJsonKeys('aurora.voice.web-store.v1:active:')
    const active = JSON.parse(await host.readJson(activeKey ?? '') ?? '{}') as { manifest_json: string }
    const storedManifest = JSON.parse(active.manifest_json) as Record<string, unknown>
    storedManifest.display_name = 'Tampered'
    active.manifest_json = JSON.stringify(storedManifest)
    await host.writeJson(activeKey ?? '', JSON.stringify(active))

    await expect(openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )).rejects.toMatchObject({ code: 'signature' })
  })

  it('keeps nested signature fields inside the canonical signed payload', async () => {
    const bytes = new Uint8Array([31, 32, 33])
    const manifest = await signedManifest(bytes, {
      provenance: {
        signature: 'operator-inventory-signature'
      }
    })

    await expect(verifyBrowserModelPackManifest(manifest, { allowNonProductionTestSignature: true })).resolves.toMatchObject({
      verification_mode: 'signature'
    })

    const tampered = {
      ...manifest,
      provenance: {
        signature: 'forged-operator-inventory-signature'
      }
    }
    await expect(verifyBrowserModelPackManifest(tampered, { allowNonProductionTestSignature: true })).rejects.toMatchObject({
      code: 'signature'
    })
  })
})

async function signedManifest(
  bytes: Uint8Array,
  extraFields: Record<string, unknown> = {},
  keyId = AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID
): Promise<AuroraBrowserModelPackManifest> {
  const unsigned: AuroraBrowserModelPackManifest = {
    ...extraFields,
    schema_version: 1,
    pack_id: 'pockettts-web-test',
    pack_version: '1.0.0',
    display_name: 'PocketTTS Web Test',
    tasks: ['stt'],
    files: [{
      file_id: 'model',
      asset_id: 'model',
      task: 'stt',
      url: '/fixtures/pockettts-web-test.bin',
      sha256: await sha256Hex(bytes),
      byte_size: bytes.byteLength,
      installed_size: bytes.byteLength,
      compression: 'none'
    }],
    variants: [{
      variant_id: 'web-wasm32-test',
      file_ids: ['model'],
      target: 'web',
      os: 'web',
      arch: 'wasm32'
    }],
    revocation: null,
    signature: null
  }
  const signature = await signCanonicalManifest(unsigned)
  return {
    ...unsigned,
    signature: {
      key_id: keyId,
      algorithm: AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
      value: signature
    }
  }
}

async function signedTwoFileManifest(
  firstBytes: Uint8Array,
  secondBytes: Uint8Array
): Promise<AuroraBrowserModelPackManifest> {
  return signedUnsignedManifest({
    schema_version: 1,
    pack_id: 'pockettts-web-test',
    pack_version: '1.0.0',
    display_name: 'PocketTTS Web Test',
    tasks: ['stt'],
    files: [{
      file_id: 'model-a',
      asset_id: 'model-a',
      task: 'stt',
      url: '/fixtures/pockettts-web-test-a.bin',
      sha256: await sha256Hex(firstBytes),
      byte_size: firstBytes.byteLength,
      installed_size: firstBytes.byteLength,
      compression: 'none'
    }, {
      file_id: 'model-b',
      asset_id: 'model-b',
      task: 'stt',
      url: '/fixtures/pockettts-web-test-b.bin',
      sha256: await sha256Hex(secondBytes),
      byte_size: secondBytes.byteLength,
      installed_size: secondBytes.byteLength,
      compression: 'none'
    }],
    variants: [{
      variant_id: 'web-wasm32-test',
      file_ids: ['model-a', 'model-b'],
      target: 'web',
      os: 'web',
      arch: 'wasm32'
    }],
    revocation: null,
    signature: null
  })
}

async function signedUnsignedManifest(
  unsigned: AuroraBrowserModelPackManifest,
  keyId = AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID
): Promise<AuroraBrowserModelPackManifest> {
  const signature = await signCanonicalManifest(unsigned)
  return {
    ...unsigned,
    signature: {
      key_id: keyId,
      algorithm: AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
      value: signature
    }
  }
}

async function signCanonicalManifest(manifest: AuroraBrowserModelPackManifest): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    decodeBase64(TEST_PRIVATE_KEY_PKCS8_BASE64),
    'Ed25519',
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('Ed25519', privateKey, encodeUtf8(canonicalJson(stripSignature(manifest))))
  return encodeBase64(new Uint8Array(signature))
}

function stripSignature(manifest: AuroraBrowserModelPackManifest): Record<string, unknown> {
  const { signature: _signature, ...unsigned } = manifest
  return unsigned
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function manifestSha256(manifest: AuroraBrowserModelPackManifest): Promise<string> {
  return sha256Hex(encodeUtf8(canonicalJson(stripSignature(manifest))))
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}
