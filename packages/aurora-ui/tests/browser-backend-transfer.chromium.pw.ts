import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { build } from 'esbuild'

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const sqliteWasmPath = '/node_modules/.pnpm/@sqlite.org+sqlite-wasm@3.53.0-build1/node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm'
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
}

let server: Server
let origin: string
let workerBundle = ''

test.beforeAll(async () => {
  const bundled = await build({
    entryPoints: [resolve(repositoryRoot, 'packages/aurora-ui/dist/local-data/browser-sqlite-worker.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: ['*.wasm']
  })
  workerBundle = bundled.outputFiles[0]?.text ?? ''
  if (workerBundle.length === 0) throw new Error('Browser transfer smoke worker bundle was empty')
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/browser-backend-transfer-worker-bundle.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end(workerBundle)
      return
    }
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <script type="importmap">
          {"imports":{
            "@aurora/client/local-data":"/packages/aurora-sdk/dist/local-data/index.js",
            "@sqlite.org/sqlite-wasm":"/node_modules/.pnpm/@sqlite.org+sqlite-wasm@3.53.0-build1/node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs",
            "zod/v4":"/packages/aurora-sdk/node_modules/zod/v4/index.js",
            "@noble/hashes/":"/packages/aurora-sdk/node_modules/@noble/hashes/"
          }}
        </script>
        <title>Aurora browser backend transfer smoke</title>`)
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
  if (address === null || typeof address === 'string') throw new Error('Browser transfer smoke did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
})

test('real Chromium transfers local data between IndexedDB and Worker OPFS SQLite', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This smoke is scoped to real Chromium IndexedDB and OPFS SQLite persistence.')
  await page.goto(origin)
  const result = await page.evaluate(async ({ wasmPath }) => {
    const modulePath = '/packages/aurora-ui/dist/local-data/index.js'
    const {
      BrowserIndexedDbLocalDataBackend,
      BrowserSqliteLocalDataBackend,
      LocalStorageBrowserLocalDataBackendPointerStore,
      createLocalDataBackend,
      transferBrowserLocalDataBackend,
    } = await import(modulePath)

    const profileId = `profile-transfer-${Date.now()}`
    const firstNodeId = `node-transfer-a-${Date.now()}`
    const secondNodeId = `node-transfer-b-${Date.now()}`
    const pointerStore = new LocalStorageBrowserLocalDataBackendPointerStore({
      storage: localStorage,
      keyPrefix: 'aurora.transfer-smoke.pointer'
    })

    const indexedSource = new BrowserIndexedDbLocalDataBackend({ origin: location.origin, ownerId: 'source-idb-a' })
    const indexedSourceSession = await indexedSource.open(profileId, firstNodeId)
    await indexedSourceSession.memory.upsertMemoryItem(memoryFixture(profileId, firstNodeId, 'memory-idb-source'))
    const sqliteState = {
      wasmAssetUrl: wasmPath,
      createWorker: () => new Worker('/browser-backend-transfer-worker-bundle.js', { type: 'module' })
    }
    await transferBrowserLocalDataBackend({
      profileId,
      localNodeId: firstNodeId,
      sourceBackend: indexedSource,
      targetBackend: new BrowserSqliteLocalDataBackend(sqliteState),
      reopenTargetBackend: () => new BrowserSqliteLocalDataBackend(sqliteState),
      pointerStore,
      nowMs: () => 3000
    })
    const retainedAfterFirstTransfer = await indexedSourceSession.memory.listMemoryItems()
    const bootstrappedSqlite = await createLocalDataBackend(profileId, firstNodeId, { pointerStore, ...sqliteState })
    const bootstrappedSqliteSession = await bootstrappedSqlite.open(profileId, firstNodeId)
    const bootstrappedSqliteExport = await bootstrappedSqliteSession.exportV1()
    await bootstrappedSqlite.close()
    await indexedSource.close()

    const sqliteSource = new BrowserSqliteLocalDataBackend(sqliteState)
    const sqliteSourceSession = await sqliteSource.open(profileId, secondNodeId)
    await sqliteSourceSession.memory.upsertMemoryItem(memoryFixture(profileId, secondNodeId, 'memory-sqlite-source'))
    const indexedState = () => new BrowserIndexedDbLocalDataBackend({ origin: location.origin, ownerId: `target-idb-${Math.random()}` })
    await transferBrowserLocalDataBackend({
      profileId,
      localNodeId: secondNodeId,
      sourceBackend: sqliteSource,
      targetBackend: indexedState(),
      reopenTargetBackend: indexedState,
      pointerStore,
      nowMs: () => 4000
    })
    const retainedAfterSecondTransfer = await sqliteSourceSession.memory.listMemoryItems()
    const bootstrappedIndexed = await createLocalDataBackend(profileId, secondNodeId, {
      pointerStore,
      indexedDbBackend: indexedState(),
      ...sqliteState
    })
    const bootstrappedIndexedSession = await bootstrappedIndexed.open(profileId, secondNodeId)
    const bootstrappedIndexedExport = await bootstrappedIndexedSession.exportV1()
    await bootstrappedIndexed.close()
    await sqliteSource.close()

    const staleNodeId = `node-transfer-stale-${Date.now()}`
    const staleOtherProfileId = `profile-transfer-other-${Date.now()}`
    const staleSqlite = new BrowserSqliteLocalDataBackend(sqliteState)
    const staleSqliteSession = await staleSqlite.open(staleOtherProfileId, staleNodeId)
    await staleSqliteSession.memory.upsertMemoryItem(memoryFixture(staleOtherProfileId, staleNodeId, 'memory-stale-other-profile'))
    await staleSqlite.close()

    const staleIndexedSource = new BrowserIndexedDbLocalDataBackend({ origin: location.origin, ownerId: 'source-idb-stale' })
    const staleIndexedSourceSession = await staleIndexedSource.open(profileId, staleNodeId)
    await staleIndexedSourceSession.memory.upsertMemoryItem(memoryFixture(profileId, staleNodeId, 'memory-stale-source'))
    const staleSourceExport = await staleIndexedSourceSession.exportV1()
    await pointerStore.write({
      version: 1,
      profileId,
      localNodeId: staleNodeId,
      schemaVersion: staleSourceExport.schemaVersion,
      selectedBackend: 'indexeddb',
      committedAtMs: 5000
    })
    const sameNodeTransfer = await transferBrowserLocalDataBackend({
      profileId,
      localNodeId: staleNodeId,
      sourceBackend: staleIndexedSource,
      targetBackend: new BrowserSqliteLocalDataBackend(sqliteState),
      reopenTargetBackend: () => new BrowserSqliteLocalDataBackend(sqliteState),
      pointerStore
    })
    const staleSourceRetained = await staleIndexedSourceSession.memory.listMemoryItems()
    await staleIndexedSource.close()
    const staleProfileSqlite = new BrowserSqliteLocalDataBackend(sqliteState)
    const staleProfileSqliteSession = await staleProfileSqlite.open(profileId, staleNodeId)
    const staleProfileSqliteExport = await staleProfileSqliteSession.exportV1()
    await staleProfileSqlite.close()
    const staleSqliteReopened = new BrowserSqliteLocalDataBackend(sqliteState)
    const staleSqliteReopenedSession = await staleSqliteReopened.open(staleOtherProfileId, staleNodeId)
    const staleOtherProfileRetained = await staleSqliteReopenedSession.memory.listMemoryItems()
    await staleSqliteReopened.close()

    return {
      retainedAfterFirstTransfer: retainedAfterFirstTransfer.map((record: { readonly id: string }) => record.id),
      bootstrappedSqliteSource: bootstrappedSqliteExport.sourceBackend,
      bootstrappedSqliteCounts: bootstrappedSqliteExport.recordCounts,
      firstPointer: await pointerStore.read(profileId, firstNodeId),
      retainedAfterSecondTransfer: retainedAfterSecondTransfer.map((record: { readonly id: string }) => record.id),
      bootstrappedIndexedSource: bootstrappedIndexedExport.sourceBackend,
      bootstrappedIndexedCounts: bootstrappedIndexedExport.recordCounts,
      secondPointer: await pointerStore.read(profileId, secondNodeId),
      sameNodeTransferBackend: sameNodeTransfer.committedBackend,
      stalePointer: await pointerStore.read(profileId, staleNodeId),
      staleProfileSqliteCounts: staleProfileSqliteExport.recordCounts,
      staleSourceRetained: staleSourceRetained.map((record: { readonly id: string }) => record.id),
      staleOtherProfileRetained: staleOtherProfileRetained.map((record: { readonly id: string }) => record.id),
    }

    function memoryFixture(profile: string, node: string, id: string) {
      return {
        id,
        profileId: profile,
        localNodeId: node,
        namespace: 'notes',
        payloadEnvelope: {
          version: 1,
          algorithm: 'AES-GCM-256',
          keyId: 'key-local-structured-data-1',
          nonceB64Url: 'AAAAAAAAAAAAAAAA',
          ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
          createdAtMs: 1000
        },
        sourceType: 'conversation',
        sourceId: 'conversation-1',
        createdAtMs: 1000,
        updatedAtMs: 1000,
        expiresAtMs: null
      }
    }
  }, { wasmPath: sqliteWasmPath })

  expect(result).toMatchObject({
    retainedAfterFirstTransfer: ['memory-idb-source'],
    bootstrappedSqliteSource: 'sqlite-wasm-opfs',
    bootstrappedSqliteCounts: { memoryItems: 1 },
    firstPointer: { selectedBackend: 'sqlite-wasm-opfs', committedAtMs: 3000 },
    retainedAfterSecondTransfer: ['memory-sqlite-source'],
    bootstrappedIndexedSource: 'indexeddb',
    bootstrappedIndexedCounts: { memoryItems: 1 },
    secondPointer: { selectedBackend: 'indexeddb', committedAtMs: 4000 },
    sameNodeTransferBackend: 'sqlite-wasm-opfs',
    stalePointer: { selectedBackend: 'sqlite-wasm-opfs' },
    staleProfileSqliteCounts: { memoryItems: 1 },
    staleSourceRetained: ['memory-stale-source'],
    staleOtherProfileRetained: ['memory-stale-other-profile']
  })
})

function resolveServedFilePath(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname.replace(/^\/+/u, ''))
  const resolved = resolve(repositoryRoot, decoded)
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`)) return null
  const stat = statSync(resolved, { throwIfNoEntry: false })
  return stat?.isFile() === true ? resolved : null
}
