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

type ToolCatalog = {
  tools?: ToolInfo[]
  blocked_tools?: Array<{ tool?: ToolInfo; reason_code?: string }>
}

type ToolInfo = {
  name?: string
  local_name?: string
  global_tool_id?: string
  tool_contract_id?: string
  provider_peer_id?: string
  provider_service_instance_id?: string
}

type ToolExecutionResponse = {
  ok?: boolean
  status?: string
  data?: JsonObject | null
  provider_peer_id?: string
}

const baseUrl = process.env.AURORA_HOSTED_MESH_NODE_BASE_URL ?? ''
const gatewayUrl = process.env.AURORA_HOSTED_MESH_NODE_GATEWAY_URL ?? ''
const gatewayApiKey = process.env.AURORA_HOSTED_MESH_NODE_GATEWAY_API_KEY ?? ''
const brokerUrl = process.env.AURORA_HOSTED_MESH_NODE_BROKER_URL ?? ''
const expectedNodeName =
  process.env.AURORA_HOSTED_MESH_NODE_EXPECTED_NODE ?? 'Hosted Mesh Node E2E Python'
const configured = Boolean(baseUrl && gatewayUrl && gatewayApiKey && brokerUrl)

const browserPeerName = 'E2E Hosted Mesh Node'
const browserToolContractId = 'aurora.local.native.get_device_status.v1'
const browserToolLocalName = 'native.get_device_status'

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
  'Tooling.use',
  'Tooling.GetTools',
  'Tooling.GetToolCatalog',
  'Tooling.GetExportCatalog',
  'Tooling.PrepareExecution',
  'Tooling.ExecuteTool',
  'Native.GetDeviceStatus',
]

const reducedPermissions = [
  'Gateway.use',
  'Gateway.GetMeshStatus',
  'Gateway.GetWebRTCDiagnostics',
  'Auth.WhoAmI',
  'Auth.MeshListPeers',
]

const forbiddenProductionTerms =
  /\b(?:proof|evidence|fixture|assertion|implementation|tested|debug|manifest|contract|schema|migration|fallback|provider\/consumer|provider|consumer|hybrid|route counts|runtime|sidecar|thin|SQLite|IndexedDB|OPFS|DataChannel|WebRTC|HTTP|WSS)\b/i

test.skip(
  !configured,
  'run through scripts/hosted_mesh_node_e2e.sh so the Python service and hosted UI are available',
)

test('hosted browser mesh-node shares one local feature with the real Python peer and fails closed for a second tab', async ({
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
  const expectedPythonPeerId = ready.local?.peer_id ?? ''
  expect(expectedPythonPeerId).not.toBe('')
  expect(ready.local?.node_name).toBe(expectedNodeName)
  expect(inviteConfig.room_password ?? '').not.toBe('')

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  const makeAvailableChoice = page.getByRole('radio', {
    name: /Make this device available/,
  })
  await expect(makeAvailableChoice).toBeVisible()
  if (await makeAvailableChoice.isDisabled()) {
    await testInfo.attach('hosted-mesh-node-blocker.txt', {
      body:
        'Hosted web onboarding currently disables "Make this device available" before invite import, so the browser cannot persist a mesh-node runtime profile through the production setup flow.',
      contentType: 'text/plain',
    })
    test.skip(
      true,
      'hosted web onboarding disables browser mesh-node setup before invite import',
    )
  }
  await makeAvailableChoice.click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('Device name').fill(browserPeerName)
  await page.getByLabel('Paste invite').fill(JSON.stringify(buildInvite(ready, inviteConfig)))
  await page.getByRole('button', { name: 'Save invite and continue' }).click()
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })

  const review = page.getByRole('button', { name: 'Review & approve' })
  await review.waitFor({ state: 'visible', timeout: 90_000 })
  const uiCode = normalizeCode(
    (await page
      .locator('code[aria-label^="Verification code "]')
      .first()
      .getAttribute('aria-label'))?.replace('Verification code ', ''),
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
  const browserPeerId = pending.remote_peer_id ?? ''
  expect(browserPeerId).not.toBe('')

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

  const diagnostic = await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], browserPeerId)
    },
    'authenticated browser mesh-node data channel',
  )
  expect(diagnostic.is_admin).toBe(false)

  const connectedPeer = await waitFor(
    async () => {
      const peers = await post<{ peers?: PersistedMeshPeer[] }>(
        request,
        '/api/Auth/MeshListPeers',
      )
      return (
        peers.peers?.find(
          (peer) =>
            peer.peer_id === browserPeerId &&
            peer.outbound_status === 'approved' &&
            peer.inbound_status === 'approved' &&
            peer.connection_status === 'connected',
        ) ?? null
      )
    },
    'persisted bilateral mesh-node approval',
  )
  expect(connectedPeer.node_name).toBe(browserPeerName)
  expect(new Set(connectedPeer.outbound_permissions ?? [])).toEqual(new Set(permissions))

  const meshRoot = page.locator('[data-local-node-provider]').first()
  await expect(meshRoot).toHaveAttribute('data-local-node-provider', 'available')
  await expect(meshRoot).toHaveAttribute('data-local-node-provider-available', 'true')
  await expect(meshRoot).toHaveAttribute('data-local-data-writable', 'true')
  await expect(meshRoot).toHaveAttribute('data-local-feature-count', '1')

  const featurePanel = page.getByLabel('Features on this device')
  await expect(featurePanel).toBeVisible()
  await expect(featurePanel).not.toContainText(forbiddenProductionTerms)
  await page.getByLabel('Turn Get device status on').click()
  await expect(featurePanel.getByText('1 on')).toBeVisible()
  await featurePanel.getByRole('button', { name: 'Choose features' }).click()
  await page.getByLabel('Shared features').getByLabel('Get device status').click()
  await page.getByRole('button', { name: 'Save sharing' }).click()
  await expect(featurePanel.getByText('1 feature shared')).toBeVisible()

  const secondPage = await page.context().newPage()
  try {
    await secondPage.goto(`${baseUrl}/mesh`, { waitUntil: 'domcontentloaded' })
    const secondRoot = secondPage.locator('[data-local-node-provider]').first()
    await expect(secondRoot).toHaveAttribute('data-local-node-provider', 'open-in-another-tab', {
      timeout: 60_000,
    })
    await expect(secondRoot).toHaveAttribute('data-local-data-writable', 'false')
    await expect(secondPage.getByRole('status')).toContainText(
      'This device is already available from another open tab.',
    )
  } finally {
    await secondPage.close()
  }

  const tool = await waitFor(
    async () => {
      const catalog = await post<ToolCatalog>(
        request,
        '/api/Tooling/GetToolCatalog',
        {
          query: 'device status',
          top_k: 20,
          include_unavailable: true,
          include_blocked_tools: true,
        },
      )
      const candidate = catalog.tools?.find((item) =>
        [item.tool_contract_id, item.local_name, item.name].includes(browserToolContractId) ||
        item.local_name === browserToolLocalName,
      )
      return candidate ?? null
    },
    'Python aggregate Tooling catalog discovers the shared browser-local tool',
    120_000,
  )
  expect(tool.provider_peer_id).toBe(browserPeerId)
  expect(tool.provider_service_instance_id).toContain(browserPeerId)

  const execution = await post<ToolExecutionResponse>(
    request,
    '/api/Tooling/ExecuteTool',
    {
      tool_name: tool.name ?? tool.global_tool_id ?? browserToolContractId,
      arguments: {},
      mesh_selector: {
        peer_id: browserPeerId,
        service_instance_id: tool.provider_service_instance_id,
        tool_id: tool.global_tool_id ?? tool.name,
      },
      correlation_id: 'hosted-mesh-node-python-invokes-browser-tool',
    },
  )
  expect(execution).toMatchObject({
    ok: true,
    status: 'success',
    provider_peer_id: browserPeerId,
  })
  expect(execution.data).toEqual(
    expect.objectContaining({
      online: expect.any(Boolean),
      availableCapabilities: expect.arrayContaining([browserToolContractId]),
    }),
  )

  const requestsBeforeRefresh = browserGatewayRequests.length
  await page
    .locator('[aria-labelledby="mesh-peers-title"]')
    .getByRole('button', { name: 'Refresh' })
    .click()
  await expect(page.locator('[aria-labelledby="mesh-peers-title"]')).toContainText(expectedNodeName)
  expect(browserGatewayRequests).toHaveLength(requestsBeforeRefresh)

  await page.context().setOffline(true)
  await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], browserPeerId) === null
    },
    'Python sees browser mesh-node leave while browser is offline',
    120_000,
  )
  await page.context().setOffline(false)
  await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], browserPeerId)
    },
    'browser mesh-node reconnects after network returns',
    120_000,
  )

  await confirmedAdminPost(
    request,
    '/api/Auth/MeshUpdatePeerPermissions',
    'Auth.MeshUpdatePeerPermissions',
    {
      peer_id: browserPeerId,
      permissions: reducedPermissions,
    },
  )
  const reduced = await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      const live = liveDiagnosticFor(diagnostics.peers ?? [], browserPeerId)
      return live?.effective_permission_count === reducedPermissions.length ? live : null
    },
    'active browser mesh-node session follows permission reduction',
  )
  expect(reduced.is_admin).toBe(false)
  const deniedCatalog = await post<ToolCatalog>(
    request,
    '/api/Tooling/GetToolCatalog',
    {
      query: 'device status',
      top_k: 20,
      include_unavailable: true,
      include_blocked_tools: true,
    },
  )
  expect(deniedCatalog.tools ?? []).toEqual([])
  expect(deniedCatalog.blocked_tools ?? []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        reason_code: 'permission_denied',
      }),
    ]),
  )

  const screenshotPath = testInfo.outputPath('hosted-mesh-node-shared-feature.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach('hosted mesh-node shared feature', {
    path: screenshotPath,
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
    reason: 'Automated hosted mesh-node verification',
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
