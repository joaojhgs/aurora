import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

let server: Server
let origin: string
let browserEnvelopeModule = ''

test.beforeAll(async () => {
  const bundled = await build({
    stdin: {
      contents: `
        export {
          BrowserEnvelopeCryptoPort,
        } from './packages/aurora-ui/dist/local-data/browser-envelope-crypto.js'
        export {
          clearBrowserDeviceData,
        } from './packages/aurora-ui/dist/local-data/clear-device-data.js'
      `,
      resolveDir: repositoryRoot,
      sourcefile: 'browser-envelope-module.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: ['@aurora/client/local-data', '@aurora/client/webrtc'],
  })
  browserEnvelopeModule = bundled.outputFiles[0]?.text ?? ''
  if (browserEnvelopeModule.length === 0) throw new Error('Browser envelope module bundle was empty')
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/browser-envelope-module.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
      response.end(browserEnvelopeModule)
      return
    }
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <script type="importmap">
          {"imports":{
            "@aurora/client/local-data":"/packages/aurora-sdk/dist/local-data/index.js",
            "@aurora/client/webrtc":"/packages/aurora-sdk/dist/webrtc/index.js",
            "zod/v4":"/packages/aurora-sdk/node_modules/zod/v4/index.js",
            "@noble/hashes/":"/packages/aurora-sdk/node_modules/@noble/hashes/"
          }}
        </script>
        <title>Aurora envelope crypto smoke</title>`)
      return
    }
    const filePath = resolveServedFilePath(pathname)
    if (filePath === null) {
      response.writeHead(404)
      response.end('Not found')
      return
    }
    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(filePath).pipe(response)
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Browser envelope crypto smoke did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
})

test('real Chromium IndexedDB persists a non-extractable local-data envelope key', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This smoke is scoped to real Chromium IndexedDB CryptoKey persistence.')
  await page.goto(origin)
  const result = await page.evaluate(async () => {
    const modulePath = '/browser-envelope-module.js'
    const {
      BrowserEnvelopeCryptoPort,
    } = await import(modulePath)

    const databaseName = deriveTestBrowserEnvelopeCryptoDatabaseName(location.origin, 'node-1')
    await deleteDatabase(databaseName)

    const aad = new TextEncoder().encode('aad')
    const plaintext = new TextEncoder().encode('persisted browser secret')
    const first = new BrowserEnvelopeCryptoPort({
      origin: location.origin,
      profileId: 'profile-1',
      localNodeId: 'node-1',
    })
    const envelope = await first.encrypt('local-structured-data', plaintext, aad)
    await first.close()

    const storedKey = await readStoredKey(databaseName, envelope.keyId)
    const exportFailed = await crypto.subtle.exportKey('raw', storedKey).then(
      () => false,
      () => true,
    )

    const reopened = new BrowserEnvelopeCryptoPort({
      origin: location.origin,
      profileId: 'profile-1',
      localNodeId: 'node-1',
    })
    const decrypted = await reopened.decrypt(envelope, aad)
    await reopened.close()
    await deleteDatabase(databaseName)
    const missingKeyPort = new BrowserEnvelopeCryptoPort({
      origin: location.origin,
      profileId: 'profile-1',
      localNodeId: 'node-1',
    })
    const missingKey = await missingKeyPort.decrypt(envelope, aad).then(
      () => null,
      (error: unknown) => error instanceof Error && 'metadata' in error
        ? (error as { metadata?: { reason?: string } }).metadata?.reason ?? null
        : null,
    )
    await missingKeyPort.close()

    return {
      decrypted: new TextDecoder().decode(decrypted),
      exportFailed,
      extractable: storedKey.extractable,
      algorithmName: storedKey.algorithm.name,
      algorithmLength: 'length' in storedKey.algorithm ? storedKey.algorithm.length : null,
      usages: [...storedKey.usages].sort(),
      missingKey,
      ciphertextIncludesPlaintext: envelope.ciphertextAndTagB64Url.includes('persisted')
    }

    async function readStoredKey(databaseName: string, keyId: string): Promise<CryptoKey> {
      const database = await openDatabase(databaseName)
      try {
        return await new Promise<CryptoKey>((resolveKey, rejectKey) => {
          const transaction = database.transaction('keys', 'readonly')
          const request = transaction.objectStore('keys').get(keyId)
          request.onsuccess = () => {
            const value = request.result
            if (!(value instanceof CryptoKey)) {
              rejectKey(new Error('Stored value is not a CryptoKey'))
              return
            }
            resolveKey(value)
          }
          request.onerror = () => rejectKey(request.error ?? new Error('Stored key read failed'))
        })
      } finally {
        database.close()
      }
    }

    async function openDatabase(databaseName: string): Promise<IDBDatabase> {
      return await new Promise<IDBDatabase>((resolveDatabase, rejectDatabase) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolveDatabase(request.result)
        request.onerror = () => rejectDatabase(request.error ?? new Error('IndexedDB open failed'))
      })
    }

    async function deleteDatabase(databaseName: string): Promise<void> {
      await new Promise<void>((resolveDelete, rejectDelete) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolveDelete()
        request.onerror = () => rejectDelete(request.error ?? new Error('IndexedDB delete failed'))
        request.onblocked = () => rejectDelete(new Error('IndexedDB delete blocked'))
      })
    }

    function deriveTestBrowserEnvelopeCryptoDatabaseName(origin: string, localNodeId: string): string {
      return `aurora-local-data-envelope-${stableHash(`${new URL(origin).origin}\u0000${localNodeId}`)}`
    }

    function stableHash(value: string): string {
      let hash = 0xcbf29ce484222325n
      const prime = 0x100000001b3n
      for (const byte of new TextEncoder().encode(value)) {
        hash ^= BigInt(byte)
        hash = BigInt.asUintN(64, hash * prime)
      }
      return hash.toString(16).padStart(16, '0')
    }
  })

  expect(result).toEqual({
    decrypted: 'persisted browser secret',
    exportFailed: true,
    extractable: false,
    algorithmName: 'AES-GCM',
    algorithmLength: 256,
    usages: ['decrypt', 'encrypt'],
    missingKey: 'missing_key',
    ciphertextIncludesPlaintext: false
  })
})

test('real Chromium clear-device removes local envelope keys and leaves unrelated databases alone', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This smoke is scoped to real Chromium IndexedDB cleanup.')
  await page.goto(origin)
  const result = await page.evaluate(async () => {
    const modulePath = '/browser-envelope-module.js'
    const {
      BrowserEnvelopeCryptoPort,
      clearBrowserDeviceData,
    } = await import(modulePath)

    const profileId = `profile-clear-${Date.now()}`
    const localNodeId = `node-clear-${Date.now()}`
    const databaseName = deriveTestBrowserEnvelopeCryptoDatabaseName(location.origin, localNodeId)
    const unrelatedDatabaseName = `unrelated-clear-${Date.now()}`
    await deleteDatabase(databaseName)
    await createUnrelatedDatabase(unrelatedDatabaseName)

    const aad = new TextEncoder().encode('aad')
    const plaintext = new TextEncoder().encode('clear browser secret')
    const first = new BrowserEnvelopeCryptoPort({
      origin: location.origin,
      profileId,
      localNodeId,
    })
    const envelope = await first.encrypt('local-structured-data', plaintext, aad)
    await first.close()

    const clearResult = await clearBrowserDeviceData({
      profileId,
      localNodeId,
      origin: location.origin,
    })
    const reopened = new BrowserEnvelopeCryptoPort({
      origin: location.origin,
      profileId,
      localNodeId,
    })
    const missingKey = await reopened.decrypt(envelope, aad).then(
      () => null,
      (error: unknown) => error instanceof Error && 'metadata' in error
        ? (error as { metadata?: { reason?: string } }).metadata?.reason ?? null
        : null,
    )
    await reopened.close()
    const unrelatedValue = await readUnrelatedValue(unrelatedDatabaseName)
    await deleteDatabase(unrelatedDatabaseName)

    return {
      clearOk: clearResult.ok,
      failedSteps: clearResult.failures.map((step: { step: string }) => step.step),
      missingKey,
      unrelatedValue,
    }

    async function createUnrelatedDatabase(databaseName: string): Promise<void> {
      const database = await openDatabase(databaseName, (upgrade) => {
        if (!upgrade.objectStoreNames.contains('records')) upgrade.createObjectStore('records')
      })
      try {
        await new Promise<void>((resolveWrite, rejectWrite) => {
          const tx = database.transaction('records', 'readwrite')
          tx.objectStore('records').put('kept', 'sentinel')
          tx.oncomplete = () => resolveWrite()
          tx.onerror = () => rejectWrite(tx.error ?? new Error('Unrelated write failed'))
          tx.onabort = () => rejectWrite(tx.error ?? new Error('Unrelated write aborted'))
        })
      } finally {
        database.close()
      }
    }

    async function readUnrelatedValue(databaseName: string): Promise<unknown> {
      const database = await openDatabase(databaseName)
      try {
        return await new Promise<unknown>((resolveRead, rejectRead) => {
          const tx = database.transaction('records', 'readonly')
          const request = tx.objectStore('records').get('sentinel')
          request.onsuccess = () => resolveRead(request.result)
          request.onerror = () => rejectRead(request.error ?? new Error('Unrelated read failed'))
        })
      } finally {
        database.close()
      }
    }

    async function openDatabase(databaseName: string, upgrade?: (database: IDBDatabase) => void): Promise<IDBDatabase> {
      return await new Promise<IDBDatabase>((resolveDatabase, rejectDatabase) => {
        const request = indexedDB.open(databaseName, 1)
        request.onupgradeneeded = () => upgrade?.(request.result)
        request.onsuccess = () => resolveDatabase(request.result)
        request.onerror = () => rejectDatabase(request.error ?? new Error('IndexedDB open failed'))
      })
    }

    async function deleteDatabase(databaseName: string): Promise<void> {
      await new Promise<void>((resolveDelete, rejectDelete) => {
        const request = indexedDB.deleteDatabase(databaseName)
        request.onsuccess = () => resolveDelete()
        request.onerror = () => rejectDelete(request.error ?? new Error('IndexedDB delete failed'))
        request.onblocked = () => rejectDelete(new Error('IndexedDB delete blocked'))
      })
    }

    function deriveTestBrowserEnvelopeCryptoDatabaseName(origin: string, nodeId: string): string {
      return `aurora-local-data-envelope-${stableHash(`${new URL(origin).origin}\u0000${nodeId}`)}`
    }

    function stableHash(value: string): string {
      let hash = 0xcbf29ce484222325n
      const prime = 0x100000001b3n
      for (const byte of new TextEncoder().encode(value)) {
        hash ^= BigInt(byte)
        hash = BigInt.asUintN(64, hash * prime)
      }
      return hash.toString(16).padStart(16, '0')
    }
  })

  expect(result).toEqual({
    clearOk: true,
    failedSteps: [],
    missingKey: 'missing_key',
    unrelatedValue: 'kept',
  })
})

function resolveServedFilePath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname.replace(/^\/+/u, ''))
  const resolved = resolve(repositoryRoot, decoded)
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`)) return null
  const stat = statSync(resolved, { throwIfNoEntry: false })
  return stat?.isFile() === true ? resolved : null
}
