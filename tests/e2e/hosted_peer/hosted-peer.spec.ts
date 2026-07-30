import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

type JsonObject = Record<string, unknown>

type MeshStatus = {
  local?: {
    mesh_enabled?: boolean
    mesh_started?: boolean
    webrtc_started?: boolean
    peer_id?: string
    node_name?: string
    peer_selection?: string
    version_policy?: string
  }
}

type MeshInviteConfig = {
  app_id?: string
  room?: string
  room_password?: string
}

type PendingPairing = {
  code?: string
  remote_peer_id?: string
  status?: string
  verification_code?: string
}

type WebRtcPeerDiagnostic = {
  stable_peer_id?: string
  connection_state?: string
  ice_connection_state?: string
  data_channel_state?: string
  auth_state?: string
  effective_permission_count?: number
  is_admin?: boolean
}

type PersistedMeshPeer = {
  peer_id?: string
  node_name?: string
  outbound_status?: string
  inbound_status?: string
  connection_status?: string
}

const baseUrl = process.env.AURORA_HOSTED_PEER_BASE_URL ?? ''
const gatewayUrl = process.env.AURORA_HOSTED_PEER_GATEWAY_URL ?? ''
const gatewayApiKey = process.env.AURORA_HOSTED_PEER_GATEWAY_API_KEY ?? ''
const brokerUrl = process.env.AURORA_HOSTED_PEER_BROKER_URL ?? ''
const expectedNodeName =
  process.env.AURORA_HOSTED_PEER_EXPECTED_NODE ?? 'Hosted Peer E2E Python'
const configured = Boolean(baseUrl && gatewayUrl && gatewayApiKey && brokerUrl)

const permissions = [
  'Gateway.use',
  'Gateway.GetRegistry',
  'Gateway.GetCapabilityCatalog',
  'Gateway.GetCapabilityGraph',
  'Gateway.GetMeshStatus',
  'Gateway.GetWebRTCDiagnostics',
  'Auth.WhoAmI',
  'Auth.MeshListPeers',
  'Auth.MeshGetPeer',
  'Config.use',
  'Orchestrator.use',
  'TTS.use',
  'DB.use',
  'Tooling.use',
  'Scheduler.use',
  'Backup.use',
]

test.skip(
  !configured,
  'run through scripts/hosted_peer_e2e.sh so the full Python service and hosted UI are available',
)

test('hosted peer UI pairs bilaterally and stays WebRTC-only across navigation, blur, and reload', async ({
  page,
  request,
}, testInfo) => {
  const consoleErrors: string[] = []
  const browserGatewayRequests: Array<{ method: string; url: string }> = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (browserRequest) => {
    if (browserRequest.url().startsWith(gatewayUrl)) {
      browserGatewayRequests.push({
        method: browserRequest.method(),
        url: browserRequest.url(),
      })
    }
  })

  const ready = await waitFor(
    async () => {
      const status = await post<MeshStatus>(request, '/api/Gateway/GetMeshStatus')
      return status.local?.mesh_started && status.local.webrtc_started ? status : null
    },
    'Python mesh and WebRTC startup',
    90_000,
  )
  const inviteConfig = await post<MeshInviteConfig>(
    request,
    '/api/Gateway/GetMeshInviteConfig',
  )
  const roomSecret = inviteConfig.room_password ?? ''
  const expectedPythonPeerId = ready.local?.peer_id ?? ''
  expect(expectedPythonPeerId).not.toBe('')
  expect(ready.local?.node_name).toBe(expectedNodeName)
  expect(inviteConfig.app_id).not.toBe('')
  expect(inviteConfig.room).not.toBe('')
  expect(roomSecret).not.toBe('')

  const invite = buildInvite(ready, inviteConfig)
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Node name').fill('E2E Hosted Peer')
  await page.getByLabel('Paste mesh invite').fill(JSON.stringify(invite))
  await page.getByRole('button', { name: 'Save invite and continue' }).click()
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })

  const review = page.getByRole('button', { name: 'Review & approve' })
  await review.waitFor({ state: 'visible', timeout: 90_000 })
  const codeElement = page
    .locator('code[aria-label^="Verification code "]')
    .first()
  const uiCode = normalizeCode(
    (await codeElement.getAttribute('aria-label'))?.replace(
      'Verification code ',
      '',
    ),
  )
  expect(uiCode).not.toBe('')

  const pending = await waitFor(
    async () => {
      const output = await post<{ pairings?: PendingPairing[] }>(
        request,
        '/api/Auth/ListPendingPairings',
      )
      return (
        output.pairings?.find(
          (pairing) =>
            pairing.status === 'pending' &&
            normalizeCode(pairing.verification_code) === uiCode,
        ) ?? null
      )
    },
    'matching Python pending pairing',
  )
  const stablePeerId = pending.remote_peer_id ?? ''
  expect(stablePeerId).not.toBe('')
  expect(normalizeCode(pending.verification_code)).toBe(uiCode)

  await confirmedAdminPost(
    request,
    '/api/Auth/PairingApprove',
    'Auth.PairingApprove',
    {
      code: pending.code,
      permissions,
      is_admin: false,
    },
  )
  await review.click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve & pair' })
    .click()

  const authenticated = await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], stablePeerId)
    },
    'authenticated open WebRTC data channel',
  )
  expect(authenticated.is_admin).toBe(false)
  expect(authenticated.effective_permission_count).toBe(permissions.length)

  const connectedPeer = await waitFor(
    async () => {
      const peers = await post<{ peers?: PersistedMeshPeer[] }>(
        request,
        '/api/Auth/MeshListPeers',
      )
      return (
        peers.peers?.find(
          (peer) =>
            peer.peer_id === stablePeerId &&
            peer.outbound_status === 'approved' &&
            peer.inbound_status === 'approved' &&
            peer.connection_status === 'connected',
        ) ?? null
      )
    },
    'persisted bilateral peer approval',
  )
  expect(connectedPeer.connection_status).toBe('connected')
  expect(connectedPeer.node_name).toBe('E2E Hosted Peer')

  const meshRoot = page.locator('[data-thin-peer-status]').first()
  await expect(meshRoot).toHaveAttribute('data-thin-peer-status', 'authorized')
  await expect(meshRoot).toHaveAttribute('data-thin-peer-state', 'authorized')
  await expect(meshRoot).toHaveAttribute(
    'data-thin-peer-error',
    'webrtc_mesh_authorized',
  )

  const routeCounts = await waitFor(
    async () => {
      const routesText = await page.locator('[aria-label="Routes"]').textContent()
      const match = routesText?.match(/Routes\s+(\d+)\/(\d+)\s+ready/)
      if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null
      return { available: Number(match[1]), total: Number(match[2]) }
    },
    'large registry and capability catalog delivery over WebRTC',
  )
  expect(routeCounts).toEqual({ available: 20, total: 22 })
  await page
    .locator('[aria-labelledby="mesh-peers-title"]')
    .getByRole('button', { name: 'Refresh' })
    .click()
  await expectMeshResourceReady(page, connectedPeer.node_name)
  await expect(page.locator('body')).toContainText(expectedNodeName)
  await expect(page.locator('body')).toContainText('Member')
  await expect(page.locator('body')).not.toContainText('Operate · admin only')
  await expect(page.locator('body')).not.toContainText(
    /WebRTC mesh transport is not connected|secure browser\/webview context/i,
  )
  expect(browserGatewayRequests).toEqual([])

  const navigationTimeOrigin = await page.evaluate(() => performance.timeOrigin)
  await page.getByRole('link', { name: 'Tools & Plugins' }).click()
  await page.waitForURL(/\/tools/, { timeout: 30_000 })
  await expect(
    page.getByRole('heading', { name: 'Tools & Plugins' }),
  ).toBeVisible()
  await expect(page.locator('[aria-label="Routes"]')).toContainText(
    `${routeCounts.available}/${routeCounts.total}`,
  )
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    navigationTimeOrigin,
  )
  await expect(page.locator('body')).not.toContainText(
    /WebRTC mesh transport is not connected|secure browser\/webview context/i,
  )

  await page.getByRole('link', { name: 'Mesh & Peers' }).click()
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    navigationTimeOrigin,
  )

  const blurEventObserved = await page.evaluate(() => {
    let observed = false
    window.addEventListener('blur', () => {
      observed = true
    }, { once: true })
    window.dispatchEvent(new FocusEvent('blur'))
    return observed
  })
  expect(blurEventObserved).toBe(true)
  await page.waitForTimeout(2_000)
  const afterBlurDiagnostics = await post<{
    peers?: WebRtcPeerDiagnostic[]
  }>(request, '/api/Gateway/GetWebRTCDiagnostics')
  expect(
    liveDiagnosticFor(afterBlurDiagnostics.peers ?? [], stablePeerId),
  ).not.toBeNull()

  const storageBeforeReload = await readRawBrowserVault(page)
  expect(storageBeforeReload.keyIsNonExtractable).toBe(true)
  expect(storageBeforeReload.encryptedRecordKeys.length).toBeGreaterThanOrEqual(2)
  expect(storageBeforeReload.serializedVault).not.toContain(roomSecret)
  expect(storageBeforeReload.localStorageDump).not.toContain(roomSecret)
  expect(storageBeforeReload.localStorageDump).not.toContain(pending.code ?? '')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })
  const reconnected = await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], stablePeerId)
    },
    'persisted credential reconnect after reload',
    120_000,
  )
  expect(reconnected.is_admin).toBe(false)
  await expect(
    page.getByRole('button', { name: 'Review & approve' }),
  ).toHaveCount(0)
  await expect(meshRoot).toHaveAttribute('data-thin-peer-status', 'authorized')
  await expect(page.locator('[aria-label="Routes"]')).toContainText(
    `${routeCounts.available}/${routeCounts.total}`,
  )
  await expectMeshResourceReady(page, connectedPeer.node_name)
  const finalScreenshotPath = testInfo.outputPath(
    'authorized-mesh-after-reload.png',
  )
  await page.screenshot({ path: finalScreenshotPath, fullPage: true })
  await testInfo.attach('authorized mesh after reload', {
    path: finalScreenshotPath,
    contentType: 'image/png',
  })
  expect(browserGatewayRequests).toEqual([])
  expect(consoleErrors).toEqual([])
})

async function post<T>(
  request: APIRequestContext,
  path: string,
  body: JsonObject = {},
): Promise<T> {
  const response = await request.post(`${gatewayUrl}${path}`, {
    headers: {
      'X-API-Key': gatewayApiKey,
      'content-type': 'application/json',
    },
    data: body,
  })
  const text = await response.text()
  if (!response.ok()) {
    throw new Error(`${path} ${response.status()}: ${text}`)
  }
  return JSON.parse(text) as T
}

async function confirmedAdminPost(
  request: APIRequestContext,
  path: string,
  methodId: string,
  body: JsonObject,
): Promise<JsonObject> {
  const draft = await post<{
    action_id: string
    nonce: string
    digest: string
    required_phrase: string
  }>(request, '/api/Gateway/AdminActionDraft', {
    method_id: methodId,
    payload: body,
  })
  const confirmation = await post<{
    action_id: string
    confirmation_token: string
    digest: string
  }>(request, '/api/Gateway/AdminActionConfirm', {
    action_id: draft.action_id,
    nonce: draft.nonce,
    digest: draft.digest,
    reason: 'Automated hosted peer WebRTC verification',
    reauth_confirmed: true,
    phrase: draft.required_phrase,
  })
  const response = await request.post(`${gatewayUrl}${path}`, {
    headers: {
      'X-API-Key': gatewayApiKey,
      'X-Aurora-AdminAction-Id': confirmation.action_id,
      'X-Aurora-AdminAction-Token': confirmation.confirmation_token,
      'X-Aurora-AdminAction-Digest': confirmation.digest,
      'content-type': 'application/json',
    },
    data: body,
  })
  const text = await response.text()
  if (!response.ok()) {
    throw new Error(`${path} ${response.status()}: ${text}`)
  }
  return JSON.parse(text) as JsonObject
}

function buildInvite(
  status: MeshStatus,
  inviteConfig: MeshInviteConfig,
): JsonObject {
  return {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: new Date().toISOString(),
    node: {
      peer_id: status.local?.peer_id,
      node_name: status.local?.node_name,
    },
    mesh: {
      enabled: status.local?.mesh_enabled === true,
      version_policy: status.local?.version_policy ?? 'compatible',
      peer_selection: status.local?.peer_selection ?? 'lowest_latency',
    },
    signaling: {
      provider: 'mqtt',
      app_id: inviteConfig.app_id,
      room: inviteConfig.room,
      room_password: inviteConfig.room_password,
      encrypt_signaling: true,
      mqtt_brokers: [brokerUrl],
      mqtt_topic_root: 'aurora',
    },
    webrtc: {
      enabled: true,
      app_layer_e2ee: true,
      stun_servers: [],
      turn_servers: [],
    },
    auth: {
      default_pairing_permissions: permissions,
      auth_timeout_seconds: 30,
      pairing_timeout_seconds: 120,
    },
  }
}

function normalizeCode(value: unknown): string {
  return String(value ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase()
}

function liveDiagnosticFor(
  diagnostics: WebRtcPeerDiagnostic[],
  stablePeerId: string,
): WebRtcPeerDiagnostic | null {
  return (
    diagnostics.find(
      (peer) =>
        peer.stable_peer_id === stablePeerId &&
        peer.connection_state === 'connected' &&
        peer.data_channel_state === 'open' &&
        peer.auth_state === 'authenticated',
    ) ?? null
  )
}

async function waitFor<T>(
  probe: () => Promise<T | null | false | undefined>,
  label: string,
  timeout = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeout
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`Timed out waiting for ${label}: ${String(lastError ?? '')}`)
}

async function expectMeshResourceReady(
  page: Page,
  expectedPeerName: string | undefined,
): Promise<void> {
  const meshResource = page.locator('[aria-labelledby="mesh-peers-title"]')
  await expect(meshResource).not.toContainText('Loading Aurora mesh', {
    timeout: 30_000,
  })
  await expect(meshResource).toContainText('mesh started · webrtc started')
  await expect(meshResource).not.toContainText('No mesh peers yet')
  if (expectedPeerName) {
    await expect(meshResource).toContainText(expectedPeerName)
  }
}

async function readRawBrowserVault(page: Page): Promise<{
  encryptedRecordKeys: string[]
  keyIsNonExtractable: boolean
  serializedVault: string
  localStorageDump: string
}> {
  return await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('aurora-web-thin-v1')
      open.onsuccess = () => resolve(open.result)
      open.onerror = () =>
        reject(open.error ?? new Error('Unable to open browser vault'))
    })
    try {
      const transaction = database.transaction('vault', 'readonly')
      const store = transaction.objectStore('vault')
      const [keys, values] = await Promise.all([
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const request = store.getAllKeys()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () =>
            reject(request.error ?? new Error('Unable to read vault keys'))
        }),
        new Promise<unknown[]>((resolve, reject) => {
          const request = store.getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () =>
            reject(request.error ?? new Error('Unable to read vault records'))
        }),
      ])
      const keyStrings = keys.map(String)
      const vaultKey = values[keyStrings.indexOf('internal:vault-key')]
      const encryptedRecordKeys = keyStrings.filter(
        (key) => key.startsWith('credential:') || key.startsWith('room:'),
      )
      for (const key of encryptedRecordKeys) {
        const value = values[keyStrings.indexOf(key)] as
          | { version?: unknown; nonce?: unknown; ciphertext?: unknown }
          | undefined
        if (
          value?.version !== 1 ||
          typeof value.nonce !== 'string' ||
          typeof value.ciphertext !== 'string'
        ) {
          throw new Error(`Vault record ${key} is not an encrypted envelope`)
        }
      }
      return {
        encryptedRecordKeys,
        keyIsNonExtractable:
          vaultKey instanceof CryptoKey && vaultKey.extractable === false,
        serializedVault: JSON.stringify(values),
        localStorageDump: JSON.stringify({ ...localStorage }),
      }
    } finally {
      database.close()
    }
  })
}
