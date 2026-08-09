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
  extraFields: Record<string, unknown> = {}
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
      key_id: AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
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
