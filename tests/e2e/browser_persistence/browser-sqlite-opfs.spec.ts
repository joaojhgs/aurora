import { type ViteDevServer, createServer as createViteServer } from 'vite'
import { expect, test } from '@playwright/test'

const repositoryRoot = process.cwd()

let vite: ViteDevServer
let origin: string

test.beforeAll(async () => {
  vite = await createViteServer({
    root: repositoryRoot,
    configFile: false,
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: {
        ignored: [
          '**/.artifacts/**',
          '**/.gitnexus/**',
          '**/.next/**',
          '**/.venv/**',
          '**/gen/android/**',
          '**/htmlcov/**',
          '**/reports/**',
          '**/target/**'
        ]
      },
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      fs: {
        allow: [repositoryRoot]
      }
    },
    optimizeDeps: {
      entries: ['tests/e2e/browser_persistence/browser-sqlite-proof.html'],
      exclude: ['@sqlite.org/sqlite-wasm']
    }
  })
  await vite.listen()
  origin = vite.resolvedUrls?.local[0] ?? ''
  if (origin.length === 0) throw new Error('Vite server did not expose a local URL')
})

test.afterAll(async () => {
  await vite.close()
})

test('opens, writes, closes, reloads, and reopens persistent browser SQLite without fallback', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The OPFS SAH pool proof currently requires Chromium.')
  const localNodeId = `node-sqlite-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await page.goto(`${origin}tests/e2e/browser_persistence/browser-sqlite-proof.html`)

  const first = await page.evaluate(async ({ localNodeId }) => {
    const { BrowserSqliteLocalDataBackend } = await import('/packages/aurora-ui/src/local-data/browser-sqlite-worker-client.ts')
    const backend = new BrowserSqliteLocalDataBackend()
    const session = await backend.open('profile-1', localNodeId)
    await session.memory.upsertMemoryItem({
      id: 'memory-profile-1',
      profileId: 'profile-1',
      localNodeId,
      namespace: 'notes',
      payloadEnvelope: envelope(),
      sourceType: 'browser-proof',
      sourceId: null,
      createdAtMs: 1000,
      updatedAtMs: 1000,
      expiresAtMs: null
    })
    const status = await backend.status()
    const listed = await session.memory.listMemoryItems()
    const exported = await session.exportV1()
    await session.close()
    return {
      status,
      listed,
      exportedCounts: exported.recordCounts
    }

    function envelope() {
      return {
        version: 1,
        algorithm: 'AES-GCM-256',
        keyId: 'key-local-structured-data-1',
        nonceB64Url: 'AAAAAAAAAAAAAAAA',
        ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
        createdAtMs: 1000
      }
    }
  }, { localNodeId })

  expect(first.status).toMatchObject({
    kind: 'sqlite-wasm-opfs',
    persistent: true,
    sqlite: true,
    profileId: 'profile-1',
    migrationState: 'idle'
  })
  expect(first.status.degradedReason).toBeUndefined()
  expect(first.listed).toHaveLength(1)
  expect(first.exportedCounts.memoryItems).toBe(1)

  await page.reload()
  const reopened = await page.evaluate(async ({ localNodeId }) => {
    const { BrowserSqliteLocalDataBackend } = await import('/packages/aurora-ui/src/local-data/browser-sqlite-worker-client.ts')
    const backend = new BrowserSqliteLocalDataBackend()
    const session = await backend.open('profile-1', localNodeId)
    const listed = await session.memory.listMemoryItems()
    await session.close()
    return listed
  }, { localNodeId })

  expect(reopened).toHaveLength(1)
  expect(reopened[0]).toMatchObject({
    id: 'memory-profile-1',
    profileId: 'profile-1',
    localNodeId
  })

  const profileIsolation = await page.evaluate(async ({ localNodeId }) => {
    const { BrowserSqliteLocalDataBackend } = await import('/packages/aurora-ui/src/local-data/browser-sqlite-worker-client.ts')
    const { buildLocalDataExportV1 } = await import('/packages/aurora-sdk/src/local-data/index.ts')
    const backendTwo = new BrowserSqliteLocalDataBackend()
    const sessionTwo = await backendTwo.open('profile-2', localNodeId)
    const before = await sessionTwo.memory.listMemoryItems()
    await sessionTwo.memory.upsertMemoryItem({
      id: 'memory-profile-2',
      profileId: 'profile-2',
      localNodeId,
      namespace: 'notes',
      payloadEnvelope: envelope(),
      sourceType: 'browser-proof',
      sourceId: null,
      createdAtMs: 1000,
      updatedAtMs: 1000,
      expiresAtMs: null
    })
    const exportedTwo = await sessionTwo.exportV1()
    await sessionTwo.importV1(buildLocalDataExportV1({
      sourceBackend: 'sqlite-wasm-opfs',
      schemaVersion: exportedTwo.schemaVersion,
      profileId: 'profile-2',
      localNodeId,
      exportedAtMs: Date.now(),
      records: emptyRecords()
    }))
    const afterImportTwo = await sessionTwo.memory.listMemoryItems()
    await sessionTwo.close()

    const backendOne = new BrowserSqliteLocalDataBackend()
    const sessionOne = await backendOne.open('profile-1', localNodeId)
    const after = await sessionOne.memory.listMemoryItems()
    const exportedOne = await sessionOne.exportV1()
    await sessionOne.close()
    return {
      profileTwoBeforeCount: before.length,
      profileTwoExportCount: exportedTwo.recordCounts.memoryItems,
      profileTwoAfterImportCount: afterImportTwo.length,
      profileOneAfterCount: after.length,
      profileOneExportCount: exportedOne.recordCounts.memoryItems
    }

    function envelope() {
      return {
        version: 1,
        algorithm: 'AES-GCM-256',
        keyId: 'key-local-structured-data-1',
        nonceB64Url: 'AAAAAAAAAAAAAAAA',
        ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
        createdAtMs: 1000
      }
    }

    function emptyRecords() {
      return {
        conversations: [],
        messages: [],
        memoryItems: [],
        localToolStates: [],
        peerGrantMetadata: [],
        localAudit: []
      }
    }
  }, { localNodeId })

  expect(profileIsolation).toEqual({
    profileTwoBeforeCount: 0,
    profileTwoExportCount: 1,
    profileTwoAfterImportCount: 0,
    profileOneAfterCount: 1,
    profileOneExportCount: 1
  })
})
