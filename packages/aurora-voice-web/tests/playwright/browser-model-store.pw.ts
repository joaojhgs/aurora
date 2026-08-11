import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, relative, sep } from 'node:path'

const repoRoot = normalize(join(import.meta.dirname, '..', '..', '..', '..'))
const packageRoot = join(repoRoot, 'packages', 'aurora-voice-web')

let server: Server
let baseUrl: string

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname

    if (pathname === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end('<!doctype html><meta charset="utf-8"><title>Aurora voice web browser store</title>')
      return
    }

    const filePath = normalize(join(packageRoot, pathname))
    const rel = relative(packageRoot, filePath)
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      response.writeHead(403)
      response.end()
      return
    }

    try {
      const body = await readFile(filePath)
      response.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'no-store'
      })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('browser model store server did not expose a TCP port'))
        return
      }
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

test.beforeEach(async ({ page }, testInfo) => {
  await page.goto(baseUrl)
  await page.evaluate(async (namespace) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(namespace)
      request.onerror = () => reject(new Error('failed to clear IndexedDB test database'))
      request.onsuccess = () => resolve()
      request.onblocked = () => reject(new Error('blocked clearing IndexedDB test database'))
    })
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory()
      if (typeof root.keys === 'function') {
        for await (const key of root.keys()) {
          if (String(key).startsWith(namespace)) await root.removeEntry(String(key), { recursive: true })
        }
      }
    }
  }, storageNamespace(testInfo.project.name))
})

test('selects the durable browser backend truthfully for this engine', async ({ page }, testInfo) => {
  await installNamespacedStore(page, testInfo.project.name)

  const result = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    const report = await host.persistenceReport()
    return {
      backend: host.backendKind(),
      hasOpfs: typeof navigator.storage?.getDirectory === 'function',
      hasIndexedDb: typeof indexedDB?.open === 'function',
      report
    }
  })

  expect(result.hasIndexedDb).toBe(true)
  expect(result.backend).toBe(result.hasOpfs ? 'opfs' : 'indexeddb')
  expect(result.report.available).toBe(true)
  expect(result.report.usedBytes).toBeGreaterThanOrEqual(0)
})

test('falls back to IndexedDB when OPFS open is unavailable', async ({ page }, testInfo) => {
  await installNamespacedStore(page, testInfo.project.name)
  await requireBrowserStoreWriteSupport(page, testInfo.project.name)

  const result = await page.evaluate(async () => {
    if (navigator.storage) {
      Object.defineProperty(navigator.storage, 'getDirectory', {
        configurable: true,
        value: async () => {
          throw new DOMException('blocked by browser policy', 'SecurityError')
        }
      })
    }
    const host = await window.__auroraBrowserStore.create()
    await host.writeJson('pack@meta', '{"fallback":true}')
    return {
      backend: host.backendKind(),
      value: await host.readJson('pack@meta')
    }
  })

  expect(result).toEqual({
    backend: 'indexeddb',
    value: '{"fallback":true}'
  })
})

test('persists JSON and promoted bytes across reloads', async ({ page }, testInfo) => {
  await installNamespacedStore(page, testInfo.project.name)
  await requireBrowserStoreWriteSupport(page, testInfo.project.name)

  const first = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    await host.writeJson('pack@meta', '{"name":"pockettts"}')
    await host.appendStaging('pack@voice.bin', 0, new Uint8Array([3, 1]))
    await host.appendStaging('pack@voice.bin', 2, new Uint8Array([4, 1, 5]))
    await host.promoteStagingAtomic('pack@voice.bin')
    return {
      backend: host.backendKind(),
      keys: await host.listPromotedKeys(),
      meta: await host.readJson('pack@meta'),
      stat: await host.promotedStat('pack@voice.bin'),
      chunk: await host.readPromotedChunk('pack@voice.bin', 1, 3)
    }
  })

  expect(first.keys).toEqual(['pack@voice.bin'])
  expect(first.meta).toBe('{"name":"pockettts"}')
  expect(first.stat).toEqual({ byteLength: 5, sha256: null })
  expect(Array.from(first.chunk.bytes)).toEqual([1, 4, 1])
  expect(first.chunk.complete).toBe(false)

  await page.reload()
  await installNamespacedStore(page, testInfo.project.name)

  const reopened = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    return {
      backend: host.backendKind(),
      keys: await host.listPromotedKeys(),
      meta: await host.readJson('pack@meta'),
      stat: await host.promotedStat('pack@voice.bin'),
      chunk: await host.readPromotedChunk('pack@voice.bin', 3, 8)
    }
  })

  expect(reopened.backend).toBe(first.backend)
  expect(reopened.keys).toEqual(['pack@voice.bin'])
  expect(reopened.meta).toBe('{"name":"pockettts"}')
  expect(reopened.stat).toEqual({ byteLength: 5, sha256: null })
  expect(Array.from(reopened.chunk.bytes)).toEqual([1, 5])
  expect(reopened.chunk.complete).toBe(true)
})

test('reopens a verified signed pack across reload without fetching model bytes again', async ({ page }, testInfo) => {
  await installNamespacedStore(page, testInfo.project.name)
  await requireBrowserStoreWriteSupport(page, testInfo.project.name)

  const first = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    const bytes = new Uint8Array([21, 22, 23, 24])
    const manifest = await window.__auroraBrowserModelPack.signedManifest(bytes)
    let fetchCount = 0
    const receipt = await window.__auroraBrowserModelPack.installVerifiedBrowserModelPack({
      host,
      manifest,
      allowNonProductionTestSignature: true,
      allowNonProductionLoopbackHttpAssetUrls: true,
      trustedAssetBaseUrl: window.location.href,
      fetchBytes: async (url) => {
        fetchCount += 1
        if (url !== `${window.location.origin}/fixtures/pockettts-web-test.bin`) {
          throw new Error(`unexpected model asset url: ${url}`)
        }
        return bytes
      }
    })
    return {
      fetchCount,
      receipt,
      keys: await host.listPromotedKeys()
    }
  })

  expect(first.fetchCount).toBe(1)
  expect(first.keys).toHaveLength(1)
  expect(first.receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/)

  await page.reload()
  await installNamespacedStore(page, testInfo.project.name)
  const unexpectedNetwork: string[] = []
  await page.route('**/*', (route) => {
    unexpectedNetwork.push(route.request().url())
    return route.abort('blockedbyclient')
  })

  const reopened = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    const active = await window.__auroraBrowserModelPack.openActiveBrowserModelPack(
      host,
      { task: 'stt' },
      { allowNonProductionTestSignature: true }
    )
    return {
      identity: active?.identity ?? null,
      bytes: active?.files[0] ? Array.from(await active.files[0].readAll()) : []
    }
  })

  expect(reopened.identity).toEqual(first.receipt.identity)
  expect(reopened.bytes).toEqual([21, 22, 23, 24])
  expect(unexpectedNetwork).toEqual([])
})

test('replaces JSON snapshots without reviving stale bytes', async ({ page }, testInfo) => {
  await installNamespacedStore(page, testInfo.project.name)
  await requireBrowserStoreWriteSupport(page, testInfo.project.name)

  await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    await host.writeJson('pack@meta', 'one')
    await host.writeJson('pack@meta', 'two')
    await host.writeJson('pack@meta', 'different-size')
  })

  await page.reload()
  await installNamespacedStore(page, testInfo.project.name)

  const result = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    return {
      value: await host.readJson('pack@meta'),
      keys: await host.listJsonKeys('pack@')
    }
  })

  expect(result).toEqual({
    value: 'different-size',
    keys: ['pack@meta']
  })
})

test('surfaces missing referenced blobs as redacted failures', async ({ page }, testInfo) => {
  await installNamespacedStore(page, testInfo.project.name)
  await requireBrowserStoreWriteSupport(page, testInfo.project.name)

  const result = await page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    await host.writeJson('sensitive-pack@meta', '{"token":"secret"}')
    await host.appendStaging('sensitive-pack@voice.bin', 0, new Uint8Array([9, 8, 7]))
    await host.promoteStagingAtomic('sensitive-pack@voice.bin')

    const snapshot = await host.port.readSnapshot()
    const jsonEntry = snapshot.json[0]
    if (!jsonEntry) throw new Error('missing JSON snapshot entry')
    await host.port.deleteBlob(jsonEntry.physicalKey)
    const error = await host.readJson('sensitive-pack@meta').then(
      () => null,
      (caught) => caught
    )
    return JSON.stringify({
      name: error?.name,
      message: error?.message,
      code: error?.code
    })
  })

  expect(result).toContain('AuroraBrowserModelStoreError')
  expect(result).toContain('evicted')
  expect(result).not.toContain('sensitive-pack')
  expect(result).not.toContain('voice.bin')
  expect(result).not.toContain('secret')
  expect(result).not.toContain('aurora-')
})

async function installNamespacedStore(page: Page, projectName: string): Promise<void> {
  await page.addInitScript(
    ({ databaseName, opfsPrefix }) => {
      window.__auroraVoiceWebBrowserStoreTest = { databaseName, opfsPrefix }
    },
    {
      databaseName: storageNamespace(projectName),
      opfsPrefix: `${storageNamespace(projectName)}.`
    }
  )
  await page.reload()
  await page.addScriptTag({ type: 'module', content: browserHarnessModule() })
  await page.waitForFunction(() => window.__auroraBrowserStore !== undefined)
}

async function requireBrowserStoreWriteSupport(page: Page, projectName: string): Promise<void> {
  const support = await browserStoreWriteSupport(page)
  if (support.supported) return
  if (projectName === 'webkit') {
    expect(support.backend).toBe('indexeddb')
    expect(support.hasOpfs).toBe(false)
    expect(support.message).toBe('aurora_voice_web_store:storage')
    test.skip(true, `known WebKit IndexedDB Blob write gap: ${support.message}`)
  }
  throw new Error(
    `${projectName} browser model store write probe failed with ${support.backend}: ${support.message}`
  )
}

type BrowserStoreWriteSupport =
  | { readonly supported: true; readonly backend: 'opfs' | 'indexeddb'; readonly hasOpfs: boolean }
  | { readonly supported: false; readonly backend: 'opfs' | 'indexeddb'; readonly hasOpfs: boolean; readonly message: string }

async function browserStoreWriteSupport(page: Page): Promise<BrowserStoreWriteSupport> {
  return page.evaluate(async () => {
    const host = await window.__auroraBrowserStore.create()
    const backend = host.backendKind()
    const hasOpfs = typeof navigator.storage?.getDirectory === 'function'
    try {
      await host.writeJson('support@probe', '{"ok":true}')
      const value = await host.readJson('support@probe')
      return value === '{"ok":true}'
        ? { supported: true, backend, hasOpfs }
        : { supported: false, backend, hasOpfs, message: 'browser model store probe did not round-trip JSON bytes' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { supported: false, backend, hasOpfs, message }
    }
  })
}

function storageNamespace(projectName: string): string {
  return `aurora-voice-web-browser-store-${projectName}`
}

function browserHarnessModule(): string {
  return `
    import {
      AuroraBrowserModelStoreHost,
      createBrowserModelStorePort,
      IndexedDbBrowserModelStorePort,
      OpfsBrowserModelStorePort
    } from '/dist/browser-model-store-host.js';
    import {
      AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
      AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
      installVerifiedBrowserModelPack,
      openActiveBrowserModelPack
    } from '/dist/browser-model-pack.js';

    try {
      const namespace = window.__auroraVoiceWebBrowserStoreTest;
      const TEST_PRIVATE_KEY_PKCS8_BASE64 = 'MC4CAQAwBQYDK2VwBCIEIBVNj/cSHz9pWMrteoqMMTyDd+p51OEdgbIRQJDEHiBP';

      class NamespacedIndexedDbBrowserModelStorePort extends IndexedDbBrowserModelStorePort {
        constructor(globalObject = globalThis) {
          super(globalObject, 'indexeddb', namespace.databaseName);
        }
      }

      class NamespacedOpfsDirectoryHandle {
        constructor(delegate, prefix) {
          this.delegate = delegate;
          this.prefix = prefix;
        }

        async getDirectoryHandle(name, options) {
          return new NamespacedOpfsDirectoryHandle(
            await this.delegate.getDirectoryHandle(this.prefix + name, options),
            this.prefix
          );
        }

        async getFileHandle(name, options) {
          return this.delegate.getFileHandle(this.prefix + name, options);
        }

        async removeEntry(name, options) {
          return this.delegate.removeEntry(this.prefix + name, options);
        }

        async *keys() {
          if (typeof this.delegate.keys !== 'function') return;
          for await (const key of this.delegate.keys()) {
            const value = String(key);
            if (value.startsWith(this.prefix)) yield value.slice(this.prefix.length);
          }
        }
      }

      async function createNamespacedPort() {
        if (globalThis.isSecureContext === true && typeof navigator.storage?.getDirectory === 'function') {
          try {
            const root = new NamespacedOpfsDirectoryHandle(
              await navigator.storage.getDirectory(),
              namespace.opfsPrefix
            );
            const storage = {
              getDirectory: async () => root
            };
            if (typeof navigator.storage.estimate === 'function') {
              storage.estimate = () => navigator.storage.estimate();
            }
            if (typeof navigator.storage.persisted === 'function') {
              storage.persisted = () => navigator.storage.persisted();
            }
            return await OpfsBrowserModelStorePort.create({
              isSecureContext: globalThis.isSecureContext,
              crypto: globalThis.crypto,
              indexedDB: globalThis.indexedDB,
              navigator: { storage }
            });
          } catch (error) {
            if (!globalThis.indexedDB) throw error;
          }
        }
        return new NamespacedIndexedDbBrowserModelStorePort(globalThis);
      }

      window.__auroraBrowserStore = {
        create: async () => new AuroraBrowserModelStoreHost(await createNamespacedPort()),
        createDefault: async () => new AuroraBrowserModelStoreHost(await createBrowserModelStorePort())
      };
      window.__auroraBrowserModelPack = {
        installVerifiedBrowserModelPack,
        openActiveBrowserModelPack,
        signedManifest: async (bytes) => {
          const unsigned = {
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
          };
          const privateKey = await crypto.subtle.importKey(
            'pkcs8',
            decodeBase64(TEST_PRIVATE_KEY_PKCS8_BASE64),
            'Ed25519',
            false,
            ['sign']
          );
          const { signature: _signature, ...unsignedPayload } = unsigned;
          const signature = await crypto.subtle.sign('Ed25519', privateKey, encodeUtf8(canonicalJson(unsignedPayload)));
          return {
            ...unsigned,
            signature: {
              key_id: AURORA_NON_PRODUCTION_MODEL_PACK_KEY_ID,
              algorithm: AURORA_MODEL_PACK_SIGNATURE_ALGORITHM,
              value: encodeBase64(new Uint8Array(signature))
            }
          };
        }
      };
    } catch (error) {
      window.__auroraBrowserStoreInstallError = String(error?.stack ?? error);
      throw error;
    }

    async function sha256Hex(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function canonicalJson(value) {
      if (value === null) return 'null';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      if (typeof value === 'number') return String(value);
      if (typeof value === 'string') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
      return '{' + Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
        .join(',') + '}';
    }

    function encodeUtf8(value) {
      return new TextEncoder().encode(value);
    }

    function decodeBase64(value) {
      const decoded = atob(value);
      return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    }

    function encodeBase64(value) {
      let binary = '';
      for (const byte of value) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
  `
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

declare global {
  interface Window {
    __auroraVoiceWebBrowserStoreTest: {
      readonly databaseName: string
      readonly opfsPrefix: string
    }
    __auroraBrowserStore: {
      create: () => Promise<{
        backendKind(): 'opfs' | 'indexeddb'
        persistenceReport(): Promise<{ available: boolean; persistent: boolean; quotaBytes: number | null; usedBytes: number }>
        readJson(key: string): Promise<string | null>
        writeJson(key: string, value: string): Promise<void>
        listJsonKeys(prefix: string): Promise<readonly string[]>
        appendStaging(key: string, offset: number, bytes: Uint8Array): Promise<void>
        promoteStagingAtomic(key: string): Promise<void>
        listPromotedKeys(): Promise<readonly string[]>
        promotedStat(key: string): Promise<{ byteLength: number; sha256: string | null } | null>
        readPromotedChunk(key: string, offset: number, maxBytes: number): Promise<{ bytes: Uint8Array; offset: number; complete: boolean }>
        port: {
          readSnapshot(): Promise<{ json: readonly { physicalKey: string }[] }>
          deleteBlob(physicalKey: string): Promise<void>
        }
      }>
    }
    __auroraBrowserModelPack: {
      signedManifest(bytes: Uint8Array): Promise<unknown>
      installVerifiedBrowserModelPack(options: {
        host: unknown
        manifest: unknown
        allowNonProductionTestSignature: true
        allowNonProductionLoopbackHttpAssetUrls?: true
        trustedAssetBaseUrl?: string
        fetchBytes: (url: string, signal?: AbortSignal) => Promise<Uint8Array>
        signal?: AbortSignal
      }): Promise<{
        identity: unknown
        manifestSha256: string
      }>
      openActiveBrowserModelPack(
        host: unknown,
        scope: { task: string },
        options: { allowNonProductionTestSignature: true }
      ): Promise<{
        identity: unknown
        files: readonly [{ readAll(): Promise<Uint8Array> }]
      } | null>
    }
  }
}
