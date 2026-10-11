import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_TURN_PAIRING_PERMISSIONS,
  activeAndroidProfileDocument,
  assertPairingDiagnostics,
  createPairingCleanup,
  matchPendingPairing,
  pairFreshPythonWithAndroid,
} from '../scripts/android-native-turn-pairing.mjs'

const profileValue = JSON.stringify({
  version: 1,
  activeProfileId: 'phone',
  profiles: [{
    id: 'phone',
    label: 'Phone',
    localNode: { stablePeerId: 'android-peer-1' },
  }],
})

describe('fresh Android and Python pairing helper', () => {
  it('reads the active Android stable identity and rejects ambiguous profile state', () => {
    expect(activeAndroidProfileDocument(profileValue).active.localNode.stablePeerId).toBe('android-peer-1')
    expect(() => activeAndroidProfileDocument(JSON.stringify({ profiles: [] }))).toThrow(/active stable peer identity/u)
    expect(() => activeAndroidProfileDocument('{')).toThrow()
  })

  it('matches one pending request by exact verification code and Android peer', () => {
    const expected = {
      code: 'request-code',
      verification_code: 'AB-CD',
      status: 'pending',
      remote_peer_id: 'android-peer-1',
      device_name: 'Aurora phone',
    }
    expect(matchPendingPairing([
      { ...expected, remote_peer_id: 'other-peer' },
      expected,
    ], {
      verificationCode: 'abcd',
      androidPeerId: 'android-peer-1',
      expectedDeviceName: 'Aurora phone',
    })).toBe(expected)
    expect(() => matchPendingPairing([expected], {
      verificationCode: 'abcd',
      androidPeerId: 'other-peer',
    })).toThrow(/exactly one/u)
    expect(() => matchPendingPairing([expected, expected], {
      verificationCode: 'abcd',
      androidPeerId: 'android-peer-1',
    })).toThrow(/exactly one/u)
  })

  it('requires authenticated, bilateral diagnostics and the same native Python session peer', () => {
    const diagnostics = {
      peers: [{
        stable_peer_id: 'android-peer-1',
        connection_state: 'connected',
        data_channel_state: 'open',
        auth_state: 'authenticated',
        effective_permission_count: NATIVE_TURN_PAIRING_PERMISSIONS.length,
      }],
    }
    const persistedPeers = {
      peers: [{
        peer_id: 'android-peer-1',
        outbound_status: 'approved',
        inbound_status: 'approved',
        connection_status: 'connected',
        outbound_permissions: [...NATIVE_TURN_PAIRING_PERMISSIONS],
      }],
    }
    const nativeSession = { peers: [{ peerId: 'python-peer-1', connectionId: 7 }] }
    expect(assertPairingDiagnostics({
      diagnostics,
      persistedPeers,
      nativeSession,
      androidPeerId: 'android-peer-1',
      pythonPeerId: 'python-peer-1',
    })).toMatchObject({
      androidPeerId: 'android-peer-1',
      pythonPeerId: 'python-peer-1',
      authenticated: true,
      bilaterallyApproved: true,
    })
    expect(() => assertPairingDiagnostics({
      diagnostics: { peers: [{ ...diagnostics.peers[0], auth_state: 'pending' }] },
      persistedPeers,
      nativeSession,
      androidPeerId: 'android-peer-1',
      pythonPeerId: 'python-peer-1',
    })).toThrow(/authenticated/u)
    expect(() => assertPairingDiagnostics({
      diagnostics,
      persistedPeers,
      nativeSession: { peers: [{ peerId: 'different-python', connectionId: 7 }] },
      androidPeerId: 'android-peer-1',
      pythonPeerId: 'python-peer-1',
    })).toThrow(/native session/u)
  })

  it('restores the exact profile and removes only a newly created Python credential', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = []
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push([command, args])
      if (command === 'aurora_thin_profile_set') return { ok: true }
      if (command === 'aurora_thin_profile_get') return { value: profileValue }
      if (command === 'aurora_thin_peer_credential_delete') return { found: false }
      if (command === 'aurora_thin_peer_credential_status') return { found: false }
      return undefined
    })
    await createPairingCleanup({
      invoke,
      originalProfileValue: profileValue,
      pythonPeerId: 'python-peer-1',
      previousCredential: { found: false },
    })()
    expect(calls).toEqual([
      ['aurora_thin_profile_set', { value: profileValue }],
      ['aurora_thin_profile_get', undefined],
      ['aurora_thin_peer_credential_delete', { request: { peerId: 'python-peer-1' } }],
      ['aurora_thin_peer_credential_status', { request: { peerId: 'python-peer-1' } }],
    ])

    calls.length = 0
    await createPairingCleanup({
      invoke,
      originalProfileValue: profileValue,
      pythonPeerId: 'python-peer-1',
      previousCredential: { found: true },
    })()
    expect(calls).toEqual([
      ['aurora_thin_profile_set', { value: profileValue }],
      ['aurora_thin_profile_get', undefined],
    ])
  })

  it('retains both profile-restore and credential-delete failures', async () => {
    const profileFailure = new Error('profile restore failed')
    const credentialFailure = new Error('credential delete failed')
    const invoke = vi.fn(async (command: string) => {
      if (command === 'aurora_thin_profile_set') throw profileFailure
      throw credentialFailure
    })
    await expect(createPairingCleanup({
      invoke,
      originalProfileValue: profileValue,
      pythonPeerId: 'python-peer-1',
      previousCredential: { found: false },
    })()).rejects.toMatchObject({
      errors: [profileFailure, credentialFailure],
    })
  })

  it('drives the production review dialog, bilateral admin approval, and delayed native binding', async () => {
    const controlAttempts = new Map<string, number>()
    const client = {
      send: vi.fn(async (_method: string, params: { expression: string }) => {
        const expression = params.expression
        for (const label of ['Review & approve', 'Approve & pair']) {
          if (expression.includes(label)) {
            const attempt = controlAttempts.get(label) ?? 0
            controlAttempts.set(label, attempt + 1)
            return { result: { result: { value: attempt > 0 } } }
          }
        }
        if (expression.includes('Connect device') || expression.includes('Join from an invite') || expression.includes('#mesh-join-invite') || expression.includes('Apply invite') || expression.includes('Invite applied')) return { result: { result: { value: true } } }
        if (expression.includes('[role="dialog"]')) return { result: { result: { value: 'AB-CD' } } }
        throw new Error(`Unexpected CDP expression: ${expression}`)
      }),
    }
    const calls: string[] = []
    let nativeSnapshots = 0
    const invoke = vi.fn(async (command: string) => {
      calls.push(command)
      if (command === 'aurora_thin_profile_get') return { value: profileValue }
      if (command === 'aurora_thin_peer_credential_status') return { found: false }
      if (command === 'aurora_mesh_session_snapshot') return nativeSnapshots++ === 0 ? { peers: [] } : { peers: [{ peerId: 'python-peer-1', connectionId: 12 }] }
      if (command === 'aurora_thin_profile_set') return { ok: true }
      if (command === 'aurora_thin_peer_credential_delete') return { found: false }
      throw new Error(`Unexpected invoke: ${command}`)
    })
    const pending = { code: 'pairing-request-1', verification_code: 'AB-CD', status: 'pending', remote_peer_id: 'android-peer-1', device_name: 'Aurora phone' }
    const response = (body: unknown) => ({ ok: () => true, status: () => 200, json: async () => body })
    let diagnosticsReads = 0
    let persistedReads = 0
    const request = {
      post: vi.fn(async (url: string, _options?: { headers?: Record<string, string>; data?: unknown }) => {
        if (url.endsWith('/Auth/ListPendingPairings')) return response({ pairings: [pending] })
        if (url.endsWith('/Gateway/AdminActionDraft')) return response({ action_id: 'draft-1', nonce: 'nonce-1', digest: 'digest-1', required_phrase: 'Confirm' })
        if (url.endsWith('/Gateway/AdminActionConfirm')) return response({ action_id: 'confirm-1', confirmation_token: 'token-1', digest: 'digest-2' })
        if (url.endsWith('/Auth/PairingApprove')) return response({ ok: true })
        if (url.endsWith('/Gateway/GetWebRTCDiagnostics')) {
          diagnosticsReads += 1
          return response({ peers: [{ stable_peer_id: 'android-peer-1', connection_state: diagnosticsReads > 1 ? 'connected' : 'connecting', data_channel_state: diagnosticsReads > 1 ? 'open' : 'connecting', auth_state: diagnosticsReads > 1 ? 'authenticated' : 'pending', effective_permission_count: diagnosticsReads > 1 ? NATIVE_TURN_PAIRING_PERMISSIONS.length : 0 }] })
        }
        if (url.endsWith('/Auth/MeshListPeers')) {
          persistedReads += 1
          return response({ peers: [{ peer_id: 'android-peer-1', outbound_status: 'approved', inbound_status: 'approved', connection_status: persistedReads > 1 ? 'connected' : 'connecting', outbound_permissions: persistedReads > 1 ? [...NATIVE_TURN_PAIRING_PERMISSIONS] : [] }] })
        }
        throw new Error(`Unexpected gateway URL: ${url}`)
      }),
    }
    const result = await pairFreshPythonWithAndroid({
      android: { client }, invoke, request,
      gatewayUrl: 'http://127.0.0.1:43123', gatewayApiKey: 'test-key',
      inviteText: 'aurora://mesh/invite/test', pythonPeerId: 'python-peer-1',
      expectedDeviceName: 'Aurora phone', navigateToMesh: vi.fn(), timeoutMs: 1000,
      permissions: [...NATIVE_TURN_PAIRING_PERMISSIONS],
    })
    expect(result).toMatchObject({ androidPeerId: 'android-peer-1', pythonPeerId: 'python-peer-1', verificationCode: 'AB-CD' })
    expect(request.post.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:43123/api/Auth/ListPendingPairings',
      'http://127.0.0.1:43123/api/Gateway/AdminActionDraft',
      'http://127.0.0.1:43123/api/Gateway/AdminActionConfirm',
      'http://127.0.0.1:43123/api/Auth/PairingApprove',
      'http://127.0.0.1:43123/api/Gateway/GetWebRTCDiagnostics',
      'http://127.0.0.1:43123/api/Gateway/GetWebRTCDiagnostics',
      'http://127.0.0.1:43123/api/Auth/MeshListPeers',
      'http://127.0.0.1:43123/api/Auth/MeshListPeers',
    ])
    expect(request.post.mock.calls[0]?.[1]).toMatchObject({ headers: { 'X-API-Key': 'test-key' } })
    expect(request.post.mock.calls[2]?.[1]).toMatchObject({ data: { action_id: 'draft-1', nonce: 'nonce-1', digest: 'digest-1' } })
    expect(request.post.mock.calls[3]?.[1]).toMatchObject({ headers: { 'X-Aurora-AdminAction-Id': 'confirm-1', 'X-Aurora-AdminAction-Token': 'token-1' }, data: { code: 'pairing-request-1' } })
    await result.cleanup()
    expect(calls).toEqual([
      'aurora_thin_profile_get', 'aurora_thin_peer_credential_status', 'aurora_mesh_session_snapshot',
      'aurora_mesh_session_snapshot',
      'aurora_thin_profile_set', 'aurora_thin_profile_get', 'aurora_thin_peer_credential_delete',
      'aurora_thin_peer_credential_status',
    ])
  })

  it('fails a fresh pairing on duplicate exact pending requests and still restores state', async () => {
    const client = {
      send: vi.fn(async (_method: string, params: { expression: string }) => ({
        result: { result: { value: params.expression.includes('[role="dialog"]') ? 'AB-CD' : true } },
      })),
    }
    const calls: string[] = []
    const invoke = vi.fn(async (command: string) => {
      calls.push(command)
      if (command === 'aurora_thin_profile_get') return { value: profileValue }
      if (command === 'aurora_thin_peer_credential_status') return { found: false }
      if (command === 'aurora_thin_profile_set') return { ok: true }
      if (command === 'aurora_thin_peer_credential_delete') return { found: false }
      throw new Error(`Unexpected invoke: ${command}`)
    })
    const pending = { code: 'pairing-request-1', verification_code: 'AB-CD', status: 'pending', remote_peer_id: 'android-peer-1' }
    const request = {
      post: vi.fn(async () => ({
        ok: () => true,
        status: () => 200,
        json: async () => ({ pairings: [pending, { ...pending, code: 'pairing-request-2' }] }),
      })),
    }
    await expect(pairFreshPythonWithAndroid({
      android: { client }, invoke, request,
      gatewayUrl: 'http://127.0.0.1:43124', gatewayApiKey: 'test-key',
      inviteText: 'aurora://mesh/invite/test', pythonPeerId: 'python-peer-2', timeoutMs: 50,
    })).rejects.toThrow(/exactly one/u)
    expect(calls).toEqual([
      'aurora_thin_profile_get', 'aurora_thin_peer_credential_status',
      'aurora_thin_profile_set', 'aurora_thin_profile_get',
      'aurora_thin_peer_credential_delete', 'aurora_thin_peer_credential_status',
    ])
    expect(request.post).toHaveBeenCalledTimes(1)
  })

  it('refuses an existing Android credential before touching the invite UI', async () => {
    const send = vi.fn()
    const invoke = vi.fn(async (command: string) => {
      if (command === 'aurora_thin_profile_get') return { value: profileValue }
      if (command === 'aurora_thin_peer_credential_status') return { found: true, hasBearerToken: false, secretsRedacted: true }
      throw new Error(`Unexpected invoke: ${command}`)
    })
    await expect(pairFreshPythonWithAndroid({
      android: { client: { send } }, invoke, request: { post: vi.fn() },
      gatewayUrl: 'http://127.0.0.1:43125', gatewayApiKey: 'test-key',
      inviteText: 'aurora://mesh/invite/test', pythonPeerId: 'python-peer-existing', timeoutMs: 50,
    })).rejects.toThrow(/already has an Android credential/u)
    expect(send).not.toHaveBeenCalled()
  })
})
