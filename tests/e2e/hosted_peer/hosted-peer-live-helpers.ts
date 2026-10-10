import { expect, type APIRequestContext, type Page } from '@playwright/test'

export type JsonObject = Record<string, unknown>

export type MeshStatus = {
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

export type MeshInviteConfig = {
  app_id?: string
  room?: string
  room_password?: string
}

export type PendingPairing = {
  code?: string
  remote_peer_id?: string
  status?: string
  verification_code?: string
}

export type WebRtcPeerDiagnostic = {
  stable_peer_id?: string
  connection_state?: string
  data_channel_state?: string
  auth_state?: string
}

export const baseUrl = process.env.AURORA_HOSTED_PEER_BASE_URL ?? ''
export const gatewayUrl = process.env.AURORA_HOSTED_PEER_GATEWAY_URL ?? ''
export const gatewayApiKey = process.env.AURORA_HOSTED_PEER_GATEWAY_API_KEY ?? ''
export const brokerUrl = process.env.AURORA_HOSTED_PEER_BROKER_URL ?? ''
export const expectedNodeName =
  process.env.AURORA_HOSTED_PEER_EXPECTED_NODE ?? 'Hosted Peer E2E Python'
export const testControlUrl = process.env.AURORA_HOSTED_PEER_TEST_CONTROL_URL ?? ''
export const liveShellAcceptance =
  process.env.AURORA_HOSTED_PEER_LIVE_SHELL_ACCEPTANCE === '1'
export const configured = Boolean(baseUrl && gatewayUrl && gatewayApiKey && brokerUrl)

export const liveAcceptancePermissions = [
  'Gateway.use',
  'Gateway.manage',
  'Gateway.GetRegistry',
  'Gateway.GetCapabilityCatalog',
  'Gateway.GetCapabilityGraph',
  'Gateway.GetMeshStatus',
  'Gateway.GetWebRTCDiagnostics',
  'Auth.WhoAmI',
  'Auth.MeshListPeers',
  'Auth.MeshGetPeer',
  'Config.use',
  'Config.GetSchemaMetadata',
  'Config.PreviewDiff',
  'Config.CommitChangeSet',
  'Orchestrator.use',
  'Orchestrator.RemoteInference',
  'TTS.use',
  'DB.use',
  'Tooling.use',
  'Scheduler.use',
  'Backup.use',
]

export async function connectHostedPeer(page: Page, request: APIRequestContext): Promise<{
  stablePeerId: string
  expectedPythonPeerId: string
}> {
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

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByPlaceholder('Kitchen tablet').fill('E2E Live Shell')
  await page.getByLabel('Paste invite').fill(JSON.stringify(buildInvite(ready, inviteConfig)))
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

  await confirmedAdminPost(
    request,
    '/api/Auth/PairingApprove',
    'Auth.PairingApprove',
    {
      code: pending.code,
      permissions: liveAcceptancePermissions,
      is_admin: false,
    },
  )
  await review.click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Approve & pair' })
    .click()

  await waitFor(
    async () => {
      const diagnostics = await post<{ peers?: WebRtcPeerDiagnostic[] }>(
        request,
        '/api/Gateway/GetWebRTCDiagnostics',
      )
      return liveDiagnosticFor(diagnostics.peers ?? [], stablePeerId)
    },
    'authenticated open WebRTC data channel',
  )

  const meshRoot = page.locator('[data-thin-peer-status]').first()
  await expect(meshRoot).toHaveAttribute('data-thin-peer-status', 'authorized')
  return { stablePeerId, expectedPythonPeerId }
}

export async function completedAssistantMessageTexts(page: Page): Promise<string[]> {
  return await page.locator('[data-slot="message"][data-align="start"]').evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      if (!node.querySelector('[aria-label="Assistant message actions"]')) return []
      const content = node.querySelector('[data-slot="message-content"] p')
      const text = (content?.textContent ?? node.textContent ?? '').replace(/\s+/gu, ' ').trim()
      return text ? [text] : []
    }),
  )
}

export async function expectNewCompletedAssistantMessage(
  page: Page,
  beforeCount: number,
  expectedText: string,
): Promise<void> {
  await expect.poll(
    async () => {
      const texts = await completedAssistantMessageTexts(page)
      return texts.length > beforeCount ? texts.at(-1) ?? '' : ''
    },
    { timeout: 90_000 },
  ).toBe(expectedText)
}

export async function setLiveShellSubscriptionDrop(
  request: APIRequestContext,
  enabled: boolean,
  flush = enabled,
): Promise<{ enabled?: boolean; dropped?: number }> {
  if (!testControlUrl) throw new Error('AURORA_HOSTED_PEER_TEST_CONTROL_URL is not configured')
  const response = await request.post(`${testControlUrl}/drop`, {
    data: { enabled, flush },
  })
  const text = await response.text()
  if (!response.ok()) {
    throw new Error(`/drop ${response.status()}: ${text}`)
  }
  return JSON.parse(text) as { enabled?: boolean; dropped?: number }
}

export type LiveShellSubscriptionDropState = {
  enabled?: boolean
  drop_count?: number
  subscriptions?: unknown[]
  rpc_calls?: Array<{
    monotonic_ms?: number
    method?: string
    drop_enabled?: boolean
  }>
  now_monotonic_ms?: number
}

export async function readLiveShellSubscriptionDropState(
  request: APIRequestContext,
): Promise<LiveShellSubscriptionDropState> {
  if (!testControlUrl) throw new Error('AURORA_HOSTED_PEER_TEST_CONTROL_URL is not configured')
  const response = await request.get(`${testControlUrl}/state`)
  const text = await response.text()
  if (!response.ok()) {
    throw new Error(`/state ${response.status()}: ${text}`)
  }
  return JSON.parse(text) as LiveShellSubscriptionDropState
}

export type LiveShellConnectionState = {
  scopeId?: string | null
  health?: string
  config?: string
}

export type HostedLiveShellTraceState = {
  counts?: Record<string, number>
  entries?: Array<{
    stage?: string
    stream?: string
    kind?: string
    id?: string | null
    freshness?: string
  }>
}

export async function readHostedLiveShellTrace(page: Page): Promise<HostedLiveShellTraceState> {
  return await page.evaluate(() => {
    const probe = (window as Window & { __auroraHostedLiveShellTrace?: () => unknown }).__auroraHostedLiveShellTrace
    const trace = probe?.()
    return trace && typeof trace === 'object' ? trace as HostedLiveShellTraceState : {}
  })
}

export async function readLiveShellConnectionState(page: Page): Promise<LiveShellConnectionState> {
  return await page.evaluate(() => {
    const probe = (window as Window & { __auroraHostedLiveShellState?: () => unknown }).__auroraHostedLiveShellState
    const state = probe?.()
    return state && typeof state === 'object' ? state as LiveShellConnectionState : {}
  })
}

export async function waitForLiveShellStreamsConnected(
  page: Page,
  timeout = 15_000,
): Promise<LiveShellConnectionState> {
  return await waitFor(
    async () => {
      const state = await readLiveShellConnectionState(page)
      return state.health === 'connected' && state.config === 'connected' ? state : null
    },
    'live shell health and config streams connected',
    timeout,
  )
}

export async function waitForLiveShellSubscriptions(
  request: APIRequestContext,
  timeout = 15_000,
): Promise<LiveShellSubscriptionDropState> {
  return await waitFor(
    async () => {
      const state = await readLiveShellSubscriptionDropState(request)
      return (state.subscriptions?.length ?? 0) >= 2 ? state : null
    },
    'live shell status subscriptions',
    timeout,
  )
}

export async function readShellStatusText(page: Page): Promise<string> {
  return normalizeVisibleText([
    await page.getByLabel('Aurora shell status').innerText(),
    await page.getByLabel('Aurora version and connection state').innerText(),
  ].join(' '))
}

export async function waitForShellStatusText(
  page: Page,
  pattern: RegExp,
  timeout = 30_000,
): Promise<string> {
  return await waitFor(
    async () => {
      const text = await readShellStatusText(page)
      return pattern.test(text) ? text : null
    },
    `shell status matching ${pattern}`,
    timeout,
  )
}

export function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export async function post<T>(
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

export async function confirmedAdminPost(
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
    reason: 'Automated hosted peer live shell acceptance',
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

export async function waitFor<T>(
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
      default_pairing_permissions: liveAcceptancePermissions,
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
