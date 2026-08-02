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
  outbound_permissions?: string[]
  inbound_status?: string
  inbound_permissions?: string[]
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

const reducedPermissions = [
  'Gateway.use',
  'Gateway.GetRegistry',
  'Gateway.GetCapabilityCatalog',
  'Gateway.GetCapabilityGraph',
  'Gateway.GetMeshStatus',
  'Gateway.GetWebRTCDiagnostics',
  'Auth.WhoAmI',
  'Auth.MeshListPeers',
  'Auth.MeshGetPeer',
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
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByPlaceholder('Kitchen tablet').fill('E2E Hosted Peer')
  await page.getByLabel('Paste invite').fill(JSON.stringify(invite))
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
            peer.connection_status === 'connected' &&
            sameStringSet(peer.outbound_permissions ?? [], permissions),
        ) ?? null
      )
    },
    'persisted bilateral peer approval',
  )
  expect(connectedPeer.connection_status).toBe('connected')
  expect(connectedPeer.node_name).toBe('E2E Hosted Peer')
  expect(new Set(connectedPeer.outbound_permissions ?? [])).toEqual(
    new Set(permissions),
  )
  // A remote-console browser approves the relationship without exposing local methods.
  expect(connectedPeer.inbound_permissions ?? []).toEqual([])

  const meshRoot = page.locator('[data-thin-peer-status]').first()
  await expect(meshRoot).toHaveAttribute('data-thin-peer-status', 'authorized')
  await expect(meshRoot).toHaveAttribute('data-thin-peer-state', 'authorized')
  await expect(meshRoot).toHaveAttribute(
    'data-thin-peer-error',
    'webrtc_mesh_authorized',
  )

  await page
    .locator('[aria-labelledby="mesh-peers-title"]')
    .getByRole('button', { name: 'Refresh' })
    .click()
  await expectMeshResourceReady(page, connectedPeer.node_name)
  await expect(page.locator('body')).toContainText(expectedNodeName)
  await expect(page.locator('body')).toContainText('Member')
  await expect(page.locator('body')).not.toContainText('Operate · admin only')
  await expectNonAdminNavigation(page)
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
  await expect(page.getByRole('link', { name: 'Mesh' })).toBeVisible()
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(
    navigationTimeOrigin,
  )
  await expect(page.locator('body')).not.toContainText(
    /WebRTC mesh transport is not connected|secure browser\/webview context/i,
  )

  await page.getByRole('link', { name: 'Mesh', exact: true }).click()
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
  expect(storageBeforeReload.runtimeProfileSummary).toMatchObject({
    activeProfileNodeMode: 'remote-console',
    activeProfileRuntimeTier: 'none',
    savedProfileCount: 1,
    localCapabilityPackCount: 0,
    hasHomeConnection: true,
    hasMeshMembership: false,
    secretsPresentInProfile: false,
  })

  const secondPage = await page.context().newPage()
  try {
    await secondPage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await expect(secondPage.locator('[data-browser-shell-boot="true"]')).toHaveCount(0, {
      timeout: 30_000,
    })
    const secondTabStorage = await readRawBrowserVault(secondPage)
    expect(secondTabStorage.encryptedRecordKeys).toEqual(
      storageBeforeReload.encryptedRecordKeys,
    )
    expect(secondTabStorage.serializedVault).not.toContain(roomSecret)
  } finally {
    await secondPage.close()
  }

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
  await expectMeshResourceReady(page, connectedPeer.node_name)
  const finalScreenshotPath = testInfo.outputPath(
    'authorized-mesh-after-reload.png',
  )
  await page.screenshot({ path: finalScreenshotPath, fullPage: true })
  await testInfo.attach('authorized mesh after reload', {
    path: finalScreenshotPath,
    contentType: 'image/png',
  })

  await confirmedAdminPost(
    request,
    '/api/Auth/MeshUpdatePeerPermissions',
    'Auth.MeshUpdatePeerPermissions',
    {
      peer_id: stablePeerId,
      permissions: reducedPermissions,
    },
  )
  const reducedPeer = await waitFor(
    async () => {
      const peers = await post<{ peers?: PersistedMeshPeer[] }>(
        request,
        '/api/Auth/MeshListPeers',
      )
      return (
        peers.peers?.find(
          (peer) =>
            peer.peer_id === stablePeerId &&
            sameStringSet(peer.outbound_permissions ?? [], reducedPermissions),
        ) ?? null
      )
    },
    'reduced peer permissions persisted on the Python authority',
  )
  expect(reducedPeer.outbound_status).toBe('approved')
  expect(reducedPeer.connection_status).toBe('connected')
  const reducedDiagnostic = await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      const live = liveDiagnosticFor(diagnostics.peers ?? [], stablePeerId)
      return live?.effective_permission_count === reducedPermissions.length
        ? live
        : null
    },
    'active WebRTC session permission count follows the reduced grant',
  )
  expect(reducedDiagnostic.is_admin).toBe(false)
  const requestsBeforeDeniedToolLoad = browserGatewayRequests.length
  await page.getByRole('link', { name: 'Tools & Plugins' }).click()
  await page.waitForURL(/\/tools/, { timeout: 30_000 })
  await expectRemovedToolAccessHidden(page)
  expect(browserGatewayRequests).toHaveLength(requestsBeforeDeniedToolLoad)
  await page.getByRole('link', { name: 'Mesh', exact: true }).click()
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })

  await confirmedAdminPost(
    request,
    '/api/Auth/MeshRemovePeer',
    'Auth.MeshRemovePeer',
    {
      peer_id: stablePeerId,
      revoke_token: true,
    },
  )
  const removedPeer = await waitFor(
    async () => {
      const peers = await post<{ peers?: PersistedMeshPeer[] }>(
        request,
        '/api/Auth/MeshListPeers',
      )
      return peers.peers?.some((peer) => peer.peer_id === stablePeerId)
        ? null
        : { removed: true }
    },
    'peer removal after authority revocation',
  )
  expect(removedPeer.removed).toBe(true)
  await expectRevokedBrowserPeerRequiresApproval(page)

  await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], stablePeerId) === null
    },
    'revoked browser peer disconnects from the Python WebRTC registry',
  )
  const requestsBeforeRevokedReload = browserGatewayRequests.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })
  await expectRevokedBrowserPeerRequiresApproval(page)
  expect(browserGatewayRequests).toHaveLength(requestsBeforeRevokedReload)
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
  await expect(meshResource).toHaveAttribute('data-thin-peer-status', 'authorized', {
    timeout: 30_000,
  })
  await expect(meshResource).toContainText('Connected devices')
  if (expectedPeerName) {
    await expect(meshResource).toContainText(expectedPeerName)
  }
}

async function readRawBrowserVault(page: Page): Promise<{
  encryptedRecordKeys: string[]
  keyIsNonExtractable: boolean
  serializedVault: string
  localStorageDump: string
  runtimeProfileSummary: {
    activeProfileNodeMode: string | null
    activeProfileRuntimeTier: string | null
    savedProfileCount: number
    localCapabilityPackCount: number
    hasHomeConnection: boolean
    hasMeshMembership: boolean
    secretsPresentInProfile: boolean
  }
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
        runtimeProfileSummary: runtimeProfileSummary(),
      }
    } finally {
      database.close()
    }

    function runtimeProfileSummary() {
      const raw = localStorage.getItem('aurora.runtimeProfiles.v2')
      const document = raw ? JSON.parse(raw) as {
        activeProfileId?: unknown
        profiles?: Array<Record<string, unknown>>
      } : null
      const profiles = document?.profiles ?? []
      const activeProfile =
        profiles.find((profile) => profile.id === document?.activeProfileId) ??
        profiles[0] ??
        null
      const localNode = activeProfile?.localNode as
        | {
          enabledCapabilityPacks?: unknown[]
          meshMembership?: unknown
        }
        | undefined
      return {
        activeProfileNodeMode:
          typeof activeProfile?.nodeMode === 'string'
            ? activeProfile.nodeMode
            : null,
        activeProfileRuntimeTier:
          typeof activeProfile?.runtimeTier === 'string'
            ? activeProfile.runtimeTier
            : null,
        savedProfileCount: profiles.length,
        localCapabilityPackCount: Array.isArray(localNode?.enabledCapabilityPacks)
          ? localNode.enabledCapabilityPacks.length
          : 0,
        hasHomeConnection: Boolean(activeProfile?.homeConnection),
        hasMeshMembership: Boolean(localNode?.meshMembership),
        secretsPresentInProfile: containsSecretField(document),
      }
    }

    function containsSecretField(value: unknown): boolean {
      if (Array.isArray(value)) return value.some(containsSecretField)
      if (typeof value !== 'object' || value === null) return false
      return Object.entries(value).some(([key, child]) => (
        key !== 'roomSecretRef'
        && /(?:token|secret|password|credential|authorization|bearer)/iu.test(key)
      ) || containsSecretField(child))
    }
  })
}

async function expectNonAdminNavigation(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: 'Admin Overview' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Services' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Access & RBAC' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Tokens' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
}

async function expectRemovedToolAccessHidden(page: Page): Promise<void> {
  const body = page.locator('body')
  await expect(body).toContainText('No sources', { timeout: 30_000 })
  await expect(body).not.toContainText(
    /Tooling\.|Gateway\.|WebRTC mesh transport|fallback|raw token|room password/i,
  )
}

async function expectRevokedBrowserPeerRequiresApproval(page: Page): Promise<void> {
  const meshRoot = page.locator('[data-thin-peer-status]').first()
  await expect(meshRoot).not.toHaveAttribute('data-thin-peer-status', 'authorized', {
    timeout: 90_000,
  })
  await expect(meshRoot).not.toHaveAttribute('data-thin-peer-status', 'fallback-http')
  await expect(page.locator('body')).toContainText(
    /offline|approval|connecting to the invited Aurora node|Review & approve|Reconnect/i,
    { timeout: 30_000 },
  )
  await expect(page.locator('body')).not.toContainText(
    /raw token|room password|authorization|WebRTC mesh transport is not connected|fallback/i,
  )
  const stillAuthorized = await meshRoot.evaluate(
    (element) => element.getAttribute('data-thin-peer-status') === 'authorized',
  )
  expect(stillAuthorized).toBe(false)
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}
