import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

let server: Server
let origin: string

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <script type="importmap">
          {"imports":{
            "@aurora/client/local-data":"/packages/aurora-sdk/dist/local-data/index.js",
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
    const modulePath = '/packages/aurora-ui/dist/local-data/index.js'
    const {
      BrowserEnvelopeCryptoPort,
      deriveBrowserEnvelopeCryptoDatabaseName,
    } = await import(modulePath)

    const databaseName = deriveBrowserEnvelopeCryptoDatabaseName(location.origin, 'node-1')
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
    await reopened.deleteKeyForTesting('local-structured-data', envelope.keyId)
    const missingKey = await reopened.decrypt(envelope, aad).then(
      () => null,
      (error: unknown) => error instanceof Error && 'metadata' in error
        ? (error as { metadata?: { reason?: string } }).metadata?.reason ?? null
        : null,
    )
    await reopened.close()
    await deleteDatabase(databaseName)

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

function resolveServedFilePath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname.replace(/^\/+/u, ''))
  const resolved = resolve(repositoryRoot, decoded)
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`)) return null
  const stat = statSync(resolved, { throwIfNoEntry: false })
  return stat?.isFile() === true ? resolved : null
}
