import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { expect, test } from '@playwright/test'

const repositoryRoot = process.cwd()
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
        <title>Aurora browser local data IndexedDB test</title>`)
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
  if (address === null || typeof address === 'string') throw new Error('Browser local data test server did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
})

test('real Chromium IndexedDB local data uses Web Locks ownership and persists after reopen', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This smoke is scoped to real Chromium Web Locks and IndexedDB behavior.')
  await page.goto(origin)
  const result = await page.evaluate(async () => {
    if (!navigator.locks) throw new Error('Chromium Web Locks API is unavailable')
    const {
      BrowserIndexedDbLocalDataBackend,
      deriveBrowserLocalDataDatabaseName,
    } = await import('/packages/aurora-ui/dist/local-data/index.js')
    await deleteDatabase(deriveBrowserLocalDataDatabaseName(location.origin, 'node-1'))
    await deleteDatabase(deriveBrowserLocalDataDatabaseName(location.origin, 'node-2'))
    await deleteDatabase('aurora-browser-storage-locks')

    const firstBackend = new BrowserIndexedDbLocalDataBackend({ origin: location.origin })
    const first = await firstBackend.open('profile-1', 'node-1')
    await first.conversations.upsertConversation(conversation('profile-1', 'node-1'))
    await first.memory.upsertMemoryItem(memory('profile-1', 'node-1', 'memory-1'))

    const deniedBackend = new BrowserIndexedDbLocalDataBackend({ origin: location.origin })
    const denied = await deniedBackend.open('profile-2', 'node-1').then(
      () => ({ denied: false, reason: null }),
      (error) => ({ denied: true, reason: error?.metadata?.reason ?? error?.message ?? null }),
    )

    const distinctBackend = new BrowserIndexedDbLocalDataBackend({ origin: location.origin })
    const distinct = await distinctBackend.open('profile-2', 'node-2')
    await distinct.memory.upsertMemoryItem(memory('profile-2', 'node-2', 'memory-node-2'))
    const distinctCount = (await distinct.memory.listMemoryItems()).length
    await distinct.close()
    await first.close()

    const reopenedBackend = new BrowserIndexedDbLocalDataBackend({ origin: location.origin })
    const reopened = await reopenedBackend.open('profile-1', 'node-1')
    const reopenedMemory = await reopened.memory.listMemoryItems()
    const reopenedConversations = await reopened.conversations.listConversations()
    await reopened.close()

    const reacquiredBackend = new BrowserIndexedDbLocalDataBackend({ origin: location.origin })
    const reacquired = await reacquiredBackend.open('profile-1', 'node-1')
    const reacquiredCount = (await reacquired.memory.listMemoryItems()).length
    await reacquired.clear()
    await reacquired.close()
    await deleteDatabase(deriveBrowserLocalDataDatabaseName(location.origin, 'node-1'))
    await deleteDatabase(deriveBrowserLocalDataDatabaseName(location.origin, 'node-2'))
    await deleteDatabase('aurora-browser-storage-locks')

    return {
      denied,
      distinctCount,
      reopenedMemoryCount: reopenedMemory.length,
      reopenedConversationCount: reopenedConversations.length,
      reacquiredCount,
    }

    function conversation(profileId: string, localNodeId: string) {
      return {
        id: 'conversation-1',
        profileId,
        localNodeId,
        titleEnvelope: envelope(),
        createdAtMs: 1000,
        updatedAtMs: 1100,
        archivedAtMs: null,
      }
    }

    function memory(profileId: string, localNodeId: string, id: string) {
      return {
        id,
        profileId,
        localNodeId,
        namespace: 'notes',
        payloadEnvelope: envelope(),
        sourceType: 'conversation',
        sourceId: 'conversation-1',
        createdAtMs: 1200,
        updatedAtMs: 1300,
        expiresAtMs: null,
      }
    }

    function envelope() {
      return {
        version: 1,
        algorithm: 'AES-GCM-256',
        keyId: 'key-browser-smoke',
        nonceB64Url: 'AAAAAAAAAAAAAAAA',
        ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
        createdAtMs: 1000,
      }
    }

    function deleteDatabase(name: string): Promise<void> {
      return new Promise((resolveDelete, rejectDelete) => {
        const request = indexedDB.deleteDatabase(name)
        request.onsuccess = () => resolveDelete()
        request.onerror = () => rejectDelete(request.error ?? new Error('Unable to reset test database'))
        request.onblocked = () => rejectDelete(new Error('Test database reset was blocked'))
      })
    }
  })

  expect(result.denied).toEqual({ denied: true, reason: 'owner_exists' })
  expect(result.distinctCount).toBe(1)
  expect(result.reopenedMemoryCount).toBe(1)
  expect(result.reopenedConversationCount).toBe(1)
  expect(result.reacquiredCount).toBe(1)
})

function resolveServedFilePath(pathname: string): string | null {
  const requestedPath = resolve(repositoryRoot, `.${pathname}`)
  const allowedPrefix = `${repositoryRoot}${sep}`
  if (!requestedPath.startsWith(allowedPrefix)) return null
  if (existsSync(requestedPath) && statSync(requestedPath).isFile()) return requestedPath

  const jsModulePath = `${requestedPath}.js`
  if (
    extname(requestedPath) === ''
    && jsModulePath.startsWith(allowedPrefix)
    && existsSync(jsModulePath)
    && statSync(jsModulePath).isFile()
  ) {
    return jsModulePath
  }

  return null
}
