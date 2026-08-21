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

test('hosted browser mesh-node shares its local Tools service and tools with the real Python peer and fails closed for a second tab', async ({
  page,
  request,
}, testInfo) => {
  const consoleErrors: string[] = []
  const expectedOfflineConsoleErrors: string[] = []
  const browserGatewayRequests: Array<{ method: string; url: string }> = []
  let exercisingOfflineRecovery = false
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (
      exercisingOfflineRecovery &&
      /WebSocket connection .*\/mqtt.*(?:ERR_INTERNET_DISCONNECTED|Data frame received after close)/u.test(
        text,
      )
    ) {
      expectedOfflineConsoleErrors.push(text)
      return
    }
    consoleErrors.push(text)
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
  await page.getByRole('textbox', { name: 'This device name', exact: true }).fill(browserPeerName)
  await page.getByLabel('Paste invite').fill(JSON.stringify(buildInvite(ready, inviteConfig)))
  await page.getByRole('button', { name: 'Save invite and continue' }).click()
  await page.waitForURL(/\/mesh/, { timeout: 30_000 })
  await page.locator(
    '[data-local-node-provider]:not([data-local-node-provider="not-configured"])',
  ).waitFor({ state: 'visible', timeout: 60_000 })

  const review = page.getByRole('button', { name: 'Review & approve' })
  await Promise.race([
    review.waitFor({ state: 'visible', timeout: 90_000 }),
    page.locator('[data-browser-shell-start="failed"]').waitFor({
      state: 'visible',
      timeout: 90_000,
    }).then(() => {
      throw new Error(
        `Browser mesh-node startup failed: ${consoleErrors.join(' | ') || 'no browser console error was captured'}`,
      )
    }),
  ])
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
  await expect(meshRoot).toHaveAttribute('data-local-feature-count', /^[1-9]\d*$/u)

  await expect(page.getByLabel('Features on this device')).toHaveCount(0)
  const serviceSharing = page.locator('[aria-labelledby="service-routing-title"]')
  await expect(serviceSharing).toBeVisible()
  await expect(serviceSharing).toContainText('Service sharing')
  await expect(serviceSharing).toContainText('Tools')
  await expect(serviceSharing).not.toContainText(forbiddenProductionTerms)
  const toolsServiceCard = serviceSharing.getByRole('article').filter({
    has: page.getByRole('heading', { name: 'Tools', exact: true }),
  })
  const toolsServiceSwitch = toolsServiceCard.getByRole('switch', {
    name: /Share Tools from this device/u,
  })
  await expect(toolsServiceSwitch).not.toBeChecked()

  await toolsServiceSwitch.click()
  await toolsServiceCard.getByRole('button', { name: 'Review changes' }).click()
  const enabledServiceReview = serviceSharing.getByRole('region', {
    name: 'Service sharing change review',
  })
  await expect(enabledServiceReview.getByText('Ready to save')).toBeVisible()
  await enabledServiceReview
    .getByText('I approve these changes for this session.')
    .click()
  await enabledServiceReview.getByRole('button', { name: 'Save changes' }).click()
  await expect(toolsServiceSwitch).toBeChecked()

  await toolsServiceSwitch.click()
  await toolsServiceCard.getByRole('button', { name: 'Review changes' }).click()
  const disabledServiceReview = serviceSharing.getByRole('region', {
    name: 'Service sharing change review',
  })
  await expect(disabledServiceReview.getByText('Ready to save')).toBeVisible()
  await disabledServiceReview
    .getByText('I approve these changes for this session.')
    .click()
  await disabledServiceReview.getByRole('button', { name: 'Save changes' }).click()
  await expect(toolsServiceSwitch).not.toBeChecked()

  await toolsServiceSwitch.click()
  await toolsServiceCard.getByRole('button', { name: 'Review changes' }).click()
  const reenabledServiceReview = serviceSharing.getByRole('region', {
    name: 'Service sharing change review',
  })
  await expect(reenabledServiceReview.getByText('Ready to save')).toBeVisible()
  await reenabledServiceReview
    .getByText('I approve these changes for this session.')
    .click()
  await reenabledServiceReview.getByRole('button', { name: 'Save changes' }).click()
  await expect(toolsServiceSwitch).toBeChecked()

  const secondPage = await page.context().newPage()
  try {
    await secondPage.goto(`${baseUrl}/mesh`, { waitUntil: 'domcontentloaded' })
    const secondRoot = secondPage.locator('[data-local-node-provider]').first()
    await secondRoot.waitFor({ state: 'visible', timeout: 60_000 })
    await testInfo.attach('browser-local-node-ownership.json', {
      body: JSON.stringify(
        {
          primary: await browserLocalNodeOwnership(page),
          secondary: await browserLocalNodeOwnership(secondPage),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
    await expect(secondRoot).toHaveAttribute('data-local-node-provider', 'open-in-another-tab', {
      timeout: 60_000,
    })
    await expect(secondRoot).toHaveAttribute('data-local-data-writable', 'false')
    await expect(
      secondPage.getByText('This device is already available from another open tab.', {
        exact: true,
      }),
    ).toBeVisible()
  } finally {
    await secondPage.close()
  }

  const peerFeaturesButton = page
    .locator('[aria-labelledby="mesh-peers-title"]')
    .getByRole('button', { name: 'Features', exact: true })
  await peerFeaturesButton.click()
  const peerFeaturesDialog = page.getByRole('dialog', {
    name: `Features - ${expectedNodeName}`,
    exact: true,
  })
  await expect(peerFeaturesDialog).toBeVisible()
  const peerToolsSwitch = peerFeaturesDialog.getByRole('switch', {
    name: 'Toggle Tools',
    exact: true,
  })
  await expect(peerToolsSwitch).not.toBeChecked()
  await peerToolsSwitch.click()
  await expect(peerToolsSwitch).toBeChecked()
  const savePeerFeatures = peerFeaturesDialog.getByRole('button', {
    name: 'Save',
    exact: true,
  })
  await savePeerFeatures.click()
  const peerPermissionRow = page.locator('tr').filter({ hasText: expectedNodeName })
  await expect(peerPermissionRow).toContainText('Tool use', { timeout: 30_000 })
  await expect(savePeerFeatures).toBeEnabled()
  await peerFeaturesDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(peerFeaturesDialog).not.toBeVisible()

  await page.goto(`${baseUrl}/tools`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible()
  await expect(page.getByText('Service sharing', { exact: true })).toHaveCount(0)
  const localToolDetails = page.getByRole('button', {
    name: /Toggle details for .*device status/iu,
  })
  await expect(localToolDetails).toBeVisible()
  await localToolDetails.click()
  const localToolSharing = page.getByRole('group', {
    name: 'Mesh sharing for Get device status',
    exact: true,
  })
  await expect(localToolSharing).toBeVisible()
  await expect(
    page.getByRole('group', { name: /Mesh sharing for .* group/iu }),
  ).toBeVisible()
  await localToolSharing
    .getByRole('button', { name: 'Do not share tools', exact: true })
    .click()
  await expect(
    localToolSharing.getByText('Tool is not shared with approved devices.'),
  ).toBeVisible()
  await localToolSharing
    .getByRole('button', { name: 'Share tools', exact: true })
    .click()
  await expect(localToolSharing.getByText('Tool sharing updated.')).toBeVisible()

  await page.goto(`${baseUrl}/mesh`, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[aria-labelledby="mesh-peers-title"]')).toContainText(expectedNodeName)

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
      const blockedCandidate = catalog.blocked_tools?.find(({ tool: item }) =>
        item !== undefined &&
        ([item.tool_contract_id, item.local_name, item.name].includes(browserToolContractId) ||
          item.local_name === browserToolLocalName),
      )
      if (blockedCandidate) {
        throw new Error(
          `browser-local tool is blocked: ${blockedCandidate.reason_code ?? 'unknown'}`,
        )
      }
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
    }),
  )
  if (
    execution.data &&
    typeof execution.data === 'object' &&
    'batteryLevel' in execution.data
  ) {
    expect((execution.data as { batteryLevel: number }).batteryLevel).toBeGreaterThanOrEqual(0)
    expect((execution.data as { batteryLevel: number }).batteryLevel).toBeLessThanOrEqual(1)
  }

  const requestsBeforeRefresh = browserGatewayRequests.length
  await page
    .locator('[aria-labelledby="mesh-peers-title"]')
    .getByRole('button', { name: 'Refresh' })
    .click()
  await expect(page.locator('[aria-labelledby="mesh-peers-title"]')).toContainText(expectedNodeName)
  expect(browserGatewayRequests).toHaveLength(requestsBeforeRefresh)

  exercisingOfflineRecovery = true
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
  await page.waitForTimeout(500)
  exercisingOfflineRecovery = false

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
  expect(
    (deniedCatalog.tools ?? []).find(
      (item) =>
        item.provider_peer_id === browserPeerId ||
        item.tool_contract_id === browserToolContractId,
    ),
  ).toBeUndefined()
  const deniedExecutionResponse = await request.post(
    `${gatewayUrl}/api/Tooling/ExecuteTool`,
    {
      headers: {
        'X-API-Key': gatewayApiKey,
        'content-type': 'application/json',
      },
      data: {
        tool_name: tool.global_tool_id ?? browserToolContractId,
        arguments: {},
        mesh_selector: {
          peer_id: browserPeerId,
          service_instance_id: tool.provider_service_instance_id,
          tool_id: tool.global_tool_id ?? tool.name,
        },
        correlation_id: 'hosted-mesh-node-reduced-permissions-deny',
      },
    },
  )
  const deniedExecutionPayload = (await deniedExecutionResponse.json()) as {
    ok?: boolean
  }
  expect(deniedExecutionResponse.ok() && deniedExecutionPayload.ok === true).toBe(false)

  const screenshotPath = testInfo.outputPath('hosted-mesh-node-shared-feature.png')
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach('hosted mesh-node shared feature', {
    path: screenshotPath,
    contentType: 'image/png',
  })
  expect(browserGatewayRequests).toEqual([])
  expect(expectedOfflineConsoleErrors.length).toBeGreaterThan(0)
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

async function browserLocalNodeOwnership(page: Page): Promise<JsonObject> {
  return await page.evaluate(async () => {
    const profileDocument = JSON.parse(
      localStorage.getItem('aurora.runtimeProfiles.v2') ?? 'null',
    ) as {
      activeProfileId?: string | null
      profiles?: Array<{
        id?: string
        localNode?: { stablePeerId?: string }
      }>
    } | null
    const activeProfile = profileDocument?.profiles?.find(
      (profile) => profile.id === profileDocument.activeProfileId,
    )
    const lockSnapshot = await navigator.locks?.query()
    return {
      url: location.href,
      visibilityState: document.visibilityState,
      activeProfileId: profileDocument?.activeProfileId ?? null,
      localStablePeerId: activeProfile?.localNode?.stablePeerId ?? null,
      providerState:
        document.querySelector('[data-local-node-provider]')?.getAttribute(
          'data-local-node-provider',
        ) ?? null,
      heldLocks:
        lockSnapshot?.held?.map((lock) => ({ name: lock.name, mode: lock.mode })) ?? [],
      pendingLocks:
        lockSnapshot?.pending?.map((lock) => ({ name: lock.name, mode: lock.mode })) ?? [],
    }
  })
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
