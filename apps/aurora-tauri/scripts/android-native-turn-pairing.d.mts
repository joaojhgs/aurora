export const NATIVE_TURN_PAIRING_PERMISSIONS: readonly string[]

export function activeAndroidProfileDocument(rawValue: unknown): {
  document: Record<string, unknown>
  active: {
    id: unknown
    localNode: { stablePeerId: unknown; [key: string]: unknown }
    [key: string]: unknown
  }
}

export function matchPendingPairing<TPairing extends Record<string, unknown>>(
  pairings: readonly TPairing[] | null | undefined,
  input: {
    verificationCode: string
    androidPeerId?: string | null
    expectedDeviceName?: string | null
  },
): TPairing

export function assertPairingDiagnostics(input: {
  diagnostics: Record<string, unknown>
  persistedPeers: Record<string, unknown>
  nativeSession: Record<string, unknown>
  androidPeerId: string
  pythonPeerId: string
  permissions?: readonly string[]
}): {
  androidPeerId: unknown
  pythonPeerId: string
  effectivePermissionCount: unknown
  authenticated: true
  bilaterallyApproved: true
  nativeSessionBound: true
}

export function createPairingCleanup(input: {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  originalProfileValue: string | undefined
  pythonPeerId: string
  previousCredential: { found?: boolean }
}): () => Promise<void>

export type AndroidRuntimeEvaluateParams = {
  expression: string
  returnByValue: true
  awaitPromise: true
}

export type AndroidCdpClient = {
  send: (method: 'Runtime.evaluate', params: AndroidRuntimeEvaluateParams) => Promise<unknown>
}

export type PairingHttpResponse = {
  ok: () => boolean
  status: () => number
  json: () => Promise<unknown>
}

export function pairFreshPythonWithAndroid(input: {
  android: { client: AndroidCdpClient }
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  request: { post: (url: string, options?: { headers?: Record<string, string>; data?: unknown }) => Promise<PairingHttpResponse> }
  gatewayUrl: string
  gatewayApiKey: string
  inviteText: string
  pythonPeerId: string
  expectedDeviceName?: string
  permissions?: readonly string[]
  navigateToMesh?: (client: AndroidCdpClient) => Promise<void>
  timeoutMs?: number
}): Promise<{
  androidPeerId: unknown
  pythonPeerId: string
  effectivePermissionCount: unknown
  authenticated: true
  bilaterallyApproved: true
  nativeSessionBound: true
  verificationCode: string
  originalProfileValue: string
  cleanup: () => Promise<void>
}>
