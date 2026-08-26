import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  expect,
  test,
  type APIRequestContext,
} from '@playwright/test'

type JsonObject = Record<string, unknown>

type AndroidHelpers = {
  connectInstalledWebview: (context: {
    adb: string
    serial: string
    appId: string
  }) => Promise<AndroidWebview>
  invokeTauri: (
    client: AndroidCdpClient,
    command: string,
    args?: JsonObject,
  ) => Promise<unknown>
  resolveAndroidDeviceSerial: (devices: string, explicit?: string) => string
}

type AndroidCdpClient = {
  send: (method: string, params?: JsonObject, timeoutMs?: number) => Promise<JsonObject>
}

type AndroidWebview = {
  client: AndroidCdpClient
  close: () => void
}

type MeshStatus = {
  local?: {
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
  data_channel_state?: string
  auth_state?: string
  effective_permission_count?: number
}

type PersistedMeshPeer = {
  peer_id?: string
  node_name?: string
  outbound_status?: string
  inbound_status?: string
  connection_status?: string
}

type NativeMeshPeer = {
  connectionId?: number
  peerId?: string
  answeredPings?: number
  lastRttMs?: number
}

const baseUrl = process.env.AURORA_THREE_NODE_BASE_URL ?? ''
const gatewayUrl = process.env.AURORA_THREE_NODE_GATEWAY_URL ?? ''
const gatewayApiKey = process.env.AURORA_THREE_NODE_GATEWAY_API_KEY ?? ''
const brokerUrl = process.env.AURORA_THREE_NODE_BROKER_URL ?? ''
const configured = Boolean(baseUrl && gatewayUrl && gatewayApiKey && brokerUrl)

const browserPeerName = `Aurora self-hosted UI ${Date.now().toString(36)}`
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

test.skip(!configured, 'run through the android:three-node:live package command')

test('full Python, installed Android, and self-hosted UI share one live Rust WebRTC mesh', async ({
  page,
  request,
}) => {
  const androidHelpers = await loadAndroidHelpers()
  const browserGatewayRequests: string[] = []
  page.on('request', (browserRequest) => {
    if (browserRequest.url().startsWith(gatewayUrl)) {
      browserGatewayRequests.push(browserRequest.url())
    }
  })

  const meshStatus = await waitFor(
    async () => {
      const status = await post<MeshStatus>(request, '/api/Gateway/GetMeshStatus')
      return status.local?.mesh_started && status.local.webrtc_started ? status : null
    },
    'full Python mesh startup',
    90_000,
  )
  const pythonPeerId = meshStatus.local?.peer_id ?? ''
  const pythonNodeName = meshStatus.local?.node_name ?? ''
  expect(pythonPeerId).not.toBe('')
  expect(pythonNodeName).not.toBe('')

  const inviteConfig = await post<MeshInviteConfig>(
    request,
    '/api/Gateway/GetMeshInviteConfig',
  )
  expect(inviteConfig.app_id).not.toBe('')
  expect(inviteConfig.room).not.toBe('')
  expect(inviteConfig.room_password).not.toBe('')

  const android = await connectAndroid(androidHelpers)
  try {
    const storedProfile = await androidHelpers.invokeTauri(
      android.webview.client,
      'aurora_thin_profile_get',
    ) as {
      value?: string
    }
    const profileDocument = JSON.parse(storedProfile.value ?? 'null') as {
      activeProfileId?: string
      profiles?: Array<{
        id?: string
        localNode?: { nodeName?: string; stablePeerId?: string }
      }>
    } | null
    const activeProfile = profileDocument?.profiles?.find(
      (profile) => profile.id === profileDocument.activeProfileId,
    )
    const androidPeerId = activeProfile?.localNode?.stablePeerId ?? ''
    expect(androidPeerId).not.toBe('')

    const androidCredential = await androidHelpers.invokeTauri(
      android.webview.client,
      'aurora_thin_peer_credential_status',
      { request: { peerId: pythonPeerId } },
    ) as {
      found?: boolean
      hasBearerToken?: boolean
      credential?: { claimantPeerId?: string }
    }
    expect(androidCredential.found).toBe(true)
    expect(androidCredential.hasBearerToken).toBe(true)
    expect(androidCredential.credential?.claimantPeerId).toBe(androidPeerId)

    const androidDiagnostic = await waitFor(
      async () => liveDiagnosticFor(
        (await post<{ peers?: WebRtcPeerDiagnostic[] }>(
          request,
          '/api/Gateway/GetWebRTCDiagnostics',
        )).peers ?? [],
        androidPeerId,
      ),
      'installed Android native mesh authentication',
      120_000,
    )
    expect(androidDiagnostic.effective_permission_count).toBeGreaterThan(0)

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    const makeAvailableChoice = page.getByRole('radio', {
      name: /Make this device available/,
    })
    await expect(makeAvailableChoice).toBeVisible()
    await expect(makeAvailableChoice).toBeEnabled()
    await makeAvailableChoice.click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page
      .getByRole('textbox', { name: 'This device name', exact: true })
      .fill(browserPeerName)
    await page.getByLabel('Paste invite').fill(JSON.stringify(buildInvite(meshStatus, inviteConfig)))
    await page.getByRole('button', { name: 'Save invite and continue' }).click()
    await page.waitForURL(/\/mesh/u, { timeout: 30_000 })

    const review = page.getByRole('button', { name: 'Review & approve' })
    await review.waitFor({ state: 'visible', timeout: 90_000 })
    const browserCode = normalizeCode(
      (await page
        .locator('code[aria-label^="Verification code "]')
        .first()
        .getAttribute('aria-label'))?.replace('Verification code ', ''),
    )
    expect(browserCode).not.toBe('')

    const pending = await waitFor(
      async () => {
        const output = await post<{ pairings?: PendingPairing[] }>(
          request,
          '/api/Auth/ListPendingPairings',
        )
        return output.pairings?.find(
          (pairing) => pairing.status === 'pending'
            && normalizeCode(pairing.verification_code) === browserCode,
        ) ?? null
      },
      'self-hosted UI pairing request',
    )
    const browserPeerId = pending.remote_peer_id ?? ''
    expect(browserPeerId).not.toBe('')

    await confirmedAdminPost(
      request,
      '/api/Auth/PairingApprove',
      'Auth.PairingApprove',
      { code: pending.code, permissions, is_admin: false },
    )
    await review.click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Approve & pair' })
      .click()

    const simultaneousDiagnostics = await waitFor(
      async () => {
        const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
          request,
          '/api/Gateway/GetWebRTCDiagnostics',
        )
        const peers = diagnostics.peers ?? []
        const browser = liveDiagnosticFor(peers, browserPeerId)
        const installedAndroid = liveDiagnosticFor(peers, androidPeerId)
        return browser && installedAndroid ? { browser, installedAndroid } : null
      },
      'simultaneous Android and self-hosted UI sessions',
      120_000,
    )
    expect(simultaneousDiagnostics.browser.effective_permission_count).toBe(permissions.length)

    const persistedPeers = await waitFor(
      async () => {
        const output = await post<{ peers?: PersistedMeshPeer[] }>(
          request,
          '/api/Auth/MeshListPeers',
        )
        const peers = output.peers ?? []
        const browser = connectedPeerFor(peers, browserPeerId)
        const installedAndroid = connectedPeerFor(peers, androidPeerId)
        return browser && installedAndroid ? { browser, installedAndroid } : null
      },
      'bilateral three-node peer roster',
    )
    expect(persistedPeers.browser.node_name).toBe(browserPeerName)
    const androidNodeName = persistedPeers.installedAndroid.node_name
      ?? activeProfile?.localNode?.nodeName
      ?? androidPeerId

    const nativePeer = await waitFor(
      async () => {
        const snapshot = await androidHelpers.invokeTauri(
          android.webview.client,
          'aurora_mesh_session_snapshot',
        ) as { peers?: NativeMeshPeer[] }
        return snapshot.peers?.find(
          (peer) => peer.peerId === pythonPeerId && Number.isInteger(peer.connectionId),
        ) ?? null
      },
      'Android Rust mesh binding',
    )
    const rttMs = await androidHelpers.invokeTauri(
      android.webview.client,
      'aurora_native_webrtc_measure_rtt',
      { request: { peerConnectionId: nativePeer.connectionId } },
    ) as number
    expect(Number.isFinite(rttMs)).toBe(true)
    expect(rttMs).toBeGreaterThan(0)

    await page.goto(`${baseUrl}/mesh`, { waitUntil: 'domcontentloaded' })
    await clickFirstRefresh(page)
    await expect(page.locator('body')).toContainText(androidNodeName, { timeout: 90_000 })
    await expect(page.locator('body')).toContainText(pythonNodeName)

    await androidNavigateToMesh(android.webview.client)
    const androidBody = await waitFor(
      async () => {
        await clickAndroidRefresh(android.webview.client)
        const body = await androidText(android.webview.client)
        return body.includes(browserPeerName) && body.includes(pythonNodeName) ? body : null
      },
      'Android roster visibility for the self-hosted UI node',
      90_000,
      3_000,
    )
    expect(androidBody).toContain(browserPeerName)
    expect(browserGatewayRequests).toEqual([])

    console.log(JSON.stringify({
      ok: true,
      androidPeerId,
      browserPeerId,
      pythonPeerId,
      authenticatedPeerCount: 2,
      androidNativeRttMs: rttMs,
      androidAnsweredPings: nativePeer.answeredPings ?? null,
      androidProjectedRttMs: nativePeer.lastRttMs ?? null,
      rostersMutuallyVisible: true,
    }))
  } finally {
    android.webview.close()
  }
})

async function loadAndroidHelpers(): Promise<AndroidHelpers> {
  const moduleUrl = pathToFileURL(resolve(
    process.cwd(),
    'apps/aurora-tauri/scripts/android-voice-live-smoke.mjs',
  )).href
  return await import(moduleUrl) as AndroidHelpers
}

async function connectAndroid(androidHelpers: AndroidHelpers) {
  const adb = process.env.AURORA_ANDROID_ADB ?? 'adb'
  const devices = execFileSync(adb, ['devices', '-l'], { encoding: 'utf8' })
  const serial = androidHelpers.resolveAndroidDeviceSerial(
    devices,
    process.env.AURORA_ANDROID_DEVICE_SERIAL ?? process.env.ANDROID_SERIAL,
  )
  const appId = process.env.AURORA_ANDROID_APP_ID ?? 'dev.aurora.desktop'
  const resolvedActivity = execFileSync(adb, [
    '-s', serial,
    'shell', 'cmd', 'package', 'resolve-activity', '--brief',
    '-c', 'android.intent.category.LAUNCHER', appId,
  ], { encoding: 'utf8' }).trim().split(/\r?\n/u).at(-1)
  if (!resolvedActivity?.includes('/')) {
    throw new Error(`Android launcher activity could not be resolved for ${appId}.`)
  }
  execFileSync(adb, [
    '-s', serial,
    'shell', 'am', 'start', '-W', '-n', resolvedActivity,
  ], { stdio: 'ignore' })
  return {
    serial,
    webview: await androidHelpers.connectInstalledWebview({ adb, serial, appId }),
  }
}

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
  if (!response.ok()) throw new Error(`${path} failed with status ${response.status()}.`)
  return await response.json() as T
}

async function confirmedAdminPost(
  request: APIRequestContext,
  path: string,
  methodId: string,
  body: JsonObject,
): Promise<void> {
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
    reason: 'Verify the real Android and self-hosted UI mesh topology',
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
  if (!response.ok()) throw new Error(`${path} failed with status ${response.status()}.`)
}

function liveDiagnosticFor(peers: WebRtcPeerDiagnostic[], peerId: string) {
  return peers.find(
    (peer) => peer.stable_peer_id === peerId
      && peer.connection_state === 'connected'
      && peer.data_channel_state === 'open'
      && peer.auth_state === 'authenticated',
  ) ?? null
}

function connectedPeerFor(peers: PersistedMeshPeer[], peerId: string) {
  return peers.find(
    (peer) => peer.peer_id === peerId
      && peer.outbound_status === 'approved'
      && peer.inbound_status === 'approved'
      && peer.connection_status === 'connected',
  ) ?? null
}

function normalizeCode(value: unknown) {
  return String(value ?? '').replace(/\s+/gu, '')
}

function buildInvite(status: MeshStatus, invite: MeshInviteConfig): JsonObject {
  return {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: new Date().toISOString(),
    node: {
      peer_id: status.local?.peer_id,
      node_name: status.local?.node_name,
    },
    mesh: {
      enabled: true,
      version_policy: status.local?.version_policy ?? 'compatible',
      peer_selection: status.local?.peer_selection ?? 'lowest_latency',
    },
    signaling: {
      provider: 'mqtt',
      app_id: invite.app_id,
      room: invite.room,
      room_password: invite.room_password,
      encrypt_signaling: true,
      mqtt_brokers: [brokerUrl],
      mqtt_topic_root: 'aurora',
    },
    webrtc: {
      enabled: true,
      strategy: 'mqtt',
      enable_app_layer_e2ee: true,
      legacy_event_broadcast: false,
      stun_servers: [],
      turn_servers: [],
    },
  }
}

async function clickFirstRefresh(page: import('@playwright/test').Page) {
  const refresh = page.getByRole('button', { name: 'Refresh' }).first()
  await expect(refresh).toBeVisible()
  await refresh.click()
}

async function androidNavigateToMesh(client: AndroidCdpClient) {
  await client.send('Runtime.evaluate', {
    expression: `location.href = '/mesh'`,
    returnByValue: true,
  })
  await waitFor(
    async () => (await androidText(client)).includes('Connected devices') ? true : null,
    'Android mesh page',
    30_000,
  )
}

async function clickAndroidRefresh(client: AndroidCdpClient) {
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Refresh');
      if (!button) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
  })
}

async function androidText(client: AndroidCdpClient) {
  const response = await client.send('Runtime.evaluate', {
    expression: 'document.body?.innerText ?? ""',
    returnByValue: true,
  })
  return String(
    (response as { result?: { result?: { value?: unknown } } }).result?.result?.value ?? '',
  )
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}.`,
  )
}
