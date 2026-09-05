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
            "@aurora/client/webrtc":"/packages/aurora-sdk/dist/webrtc/credentials.js",
            "@aurora/client/node-config":"/packages/aurora-sdk/dist/node-config.js",
            "@noble/hashes/":"/packages/aurora-sdk/node_modules/@noble/hashes/"
          }}
        </script>
        <title>Aurora browser persistence test</title>`)
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
  if (address === null || typeof address === 'string') throw new Error('Browser persistence test server did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
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

test.afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose())
  })
})

test('survives a real page refresh without storing plaintext secrets', async ({ page }) => {
  await page.goto(origin)
  const first = await page.evaluate(async () => {
    const {
      BrowserPersistentPeerCredentialStore,
      IndexedDbBrowserVaultStorage,
    } = await import('/packages/aurora-ui/dist/browser-peer-persistence.js')
    await deleteDatabase('aurora-web-thin-v1')
    localStorage.clear()

    const profile = {
      mode: 'webrtc-only',
      appId: 'aurora',
      room: 'browser-e2e-room',
      roomSecretRef: 'ref:memory:browser-e2e-room',
      signalingBrokers: ['wss://signal.example.test/mqtt'],
      expectedStablePeerId: 'host-peer',
      production: true,
      requireAppLayerE2ee: true,
    }
    const credential = {
      tokenId: 'browser-e2e-token',
      claimantPeerId: 'browser-peer',
      verifierPeerId: 'host-peer',
      claimantSignalingPeerId: 'browser-signal-old',
      verifierSignalingPeerId: 'host-signal-old',
      roomName: profile.room,
      rawBearerToken: 'browser-e2e-bearer-must-be-encrypted',
    }
    const challenge = reconnectChallenge()
    const store = new BrowserPersistentPeerCredentialStore()
    store.setRoomSecret(profile.roomSecretRef, 'browser-e2e-room-secret-must-be-encrypted')
    store.saveConnectionProfile(profile)
    const stablePeerId = store.getOrCreateLocalStablePeerId()
    await store.save('host-peer', credential)
    const proof = await store.prove('host-peer', challenge)
    await store.close()

    const rawStorage = new IndexedDbBrowserVaultStorage()
    const keys = await rawStorage.keys()
    const values = await Promise.all(keys.map(async (key: string) => await rawStorage.get(key)))
    const vaultKey = values[keys.indexOf('internal:vault-key')]
    const serialized = JSON.stringify(values)
    await rawStorage.close()
    return {
      stablePeerId,
      proof,
      profile,
      serialized,
      localStorageDump: JSON.stringify({ ...localStorage }),
      keyIsNonExtractable: vaultKey instanceof CryptoKey && vaultKey.extractable === false,
    }

    function reconnectChallenge() {
      return {
        type: 'mesh_auth_challenge_v1',
        challenge: 'a'.repeat(64),
        channel_binding: 'b'.repeat(64),
        claimant_peer_id: 'browser-peer',
        verifier_peer_id: 'host-peer',
        claimant_signaling_peer_id: 'browser-signal-new',
        verifier_signaling_peer_id: 'host-signal-new',
        room_name: 'browser-e2e-room',
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

  expect(first.keyIsNonExtractable).toBe(true)
  expect(first.serialized).not.toContain('browser-e2e-bearer-must-be-encrypted')
  expect(first.serialized).not.toContain('browser-e2e-room-secret-must-be-encrypted')
  expect(first.localStorageDump).not.toContain('browser-e2e-bearer-must-be-encrypted')
  expect(first.localStorageDump).not.toContain('browser-e2e-room-secret-must-be-encrypted')

  await page.reload()
  const restored = await page.evaluate(async () => {
    const { BrowserPersistentPeerCredentialStore } =
      await import('/packages/aurora-ui/dist/browser-peer-persistence.js')
    const challenge = {
      type: 'mesh_auth_challenge_v1',
      challenge: 'a'.repeat(64),
      channel_binding: 'b'.repeat(64),
      claimant_peer_id: 'browser-peer',
      verifier_peer_id: 'host-peer',
      claimant_signaling_peer_id: 'browser-signal-new',
      verifier_signaling_peer_id: 'host-signal-new',
      room_name: 'browser-e2e-room',
    }
    const store = new BrowserPersistentPeerCredentialStore()
    const stablePeerId = store.getOrCreateLocalStablePeerId()
    const profile = store.loadConnectionProfile()
    const roomSecret = new TextDecoder().decode(await store.getRoomSecret('ref:memory:browser-e2e-room') ?? undefined)
    const credential = await store.get('host-peer')
    const proof = await store.prove('host-peer', challenge)
    const status = store.persistenceStatus()
    await store.clear()
    await store.close()
    localStorage.clear()
    return { stablePeerId, profile, roomSecret, credential, proof, status }
  })

  expect(restored.stablePeerId).toBe(first.stablePeerId)
  expect(restored.profile).toEqual(first.profile)
  expect(restored.roomSecret).toBe('browser-e2e-room-secret-must-be-encrypted')
  expect(restored.credential).toMatchObject({
    tokenId: 'browser-e2e-token',
    claimantPeerId: 'browser-peer',
    verifierPeerId: 'host-peer',
  })
  expect(restored.proof).toEqual(first.proof)
  expect(restored.status).toMatchObject({
    backend: 'encrypted-indexeddb',
    secretsPersisted: true,
    profilePersisted: true,
  })
})
