import { describe, expect, it, vi } from 'vitest'

import {
  PeerHostContractRegistry,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  type LocalPeerGrantV1,
  type PeerHostCallContext
} from '../src/webrtc/index.js'

function grant(patch: Partial<LocalPeerGrantV1> = {}): LocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-1',
    tokenId: 'token-1',
    claimantPeerId: 'peer-a',
    allowedMethodIds: ['Tooling.GetTools'],
    allowedToolContractIds: [],
    capabilityPackIds: [],
    resourceScopes: [],
    createdAtMs: 1,
    grantRevision: 1,
    ...patch
  }
}

function host(handler: (input: unknown, context: PeerHostCallContext) => Promise<unknown> | unknown = vi.fn(async () => ({ count: 0, tools: [] })), store = new SessionPeerHostAuthorizationStore([grant()])) {
  const registry = createToolingPeerHostRegistry({
    getTools: handler,
    getExportCatalog: async () => ({
      ok: true,
      provider_peer_id: 'local-peer',
      service_instance_id: 'local:local-peer:Tooling',
      selected_protocol_tier: 'projection_v1',
      authority_revision: { auth_grant_revision: 0, catalog_revision: 0, export_policy_revision: 0, manifest_revision: 0, switch_revision: 0 },
      projection_revision: '0',
      projection_digest: '0'.repeat(64),
      page_index: 0,
      page_size: 100,
      page_hash: '0'.repeat(64),
      tools: [],
      retirements: [],
      complete: true,
      total_count: 0,
      final_checksum: '0'.repeat(64)
    }),
    prepareExecution: async () => { throw new Error('not implemented') },
    executeTool: async () => { throw new Error('not implemented') }
  })
  const peerHost = new WebRtcPeerHost({
    localPeerId: 'local-peer',
    nodeName: 'Local',
    registry,
    authorizationStore: store,
    clock: () => 1000,
    randomId: () => 'epoch-1'
  })
  const sent: unknown[] = []
  peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
  peerHost.startEpoch()
  peerHost.markManifestAcknowledged()
  return { peerHost, sent, handler }
}

describe('WebRtcPeerHost', () => {
  it('parses generated Tooling schemas before dispatching an authorized handler', async () => {
    const handler = vi.fn(async (_input: unknown, context: PeerHostCallContext) => {
      expect(context.identity.callerPeerId).toBe('peer-a')
      return { count: 0, tools: [] }
    })
    const { peerHost, sent } = host(handler)
    await peerHost.handleCall({
      type: 'call',
      id: 'call-1',
      method: 'Tooling.GetTools',
      params: { top_k: 1 },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)).toEqual({ type: 'result', id: 'call-1', result: { count: 0, tools: [] } })
  })

  it('never dispatches malformed, oversized, unauthorized, expired, or revoked calls', async () => {
    const handler = vi.fn(async () => ({ count: 0, tools: [] }))
    const expired = new SessionPeerHostAuthorizationStore([grant({ expiresAtMs: 500 })])
    const revoked = new SessionPeerHostAuthorizationStore([grant({ revokedAtMs: 500 })])

    const malformed = host(handler)
    await malformed.peerHost.handleCall({
      type: 'call',
      id: 'bad-schema',
      method: 'Tooling.GetTools',
      params: { top_k: -1 },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const oversized = host(handler)
    await oversized.peerHost.handleCall({
      type: 'call',
      id: 'oversized',
      method: 'Tooling.GetTools',
      params: { query: 'x'.repeat(300_000) },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const unauthorized = host(handler)
    await unauthorized.peerHost.handleCall({
      type: 'call',
      id: 'unauthorized',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: [] }
    }, 'peer-a')

    const expiredHost = host(handler, expired)
    await expiredHost.peerHost.handleCall({
      type: 'call',
      id: 'expired',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const revokedHost = host(handler, revoked)
    await revokedHost.peerHost.handleCall({
      type: 'call',
      id: 'revoked',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    expect(handler).not.toHaveBeenCalled()
    expect(malformed.sent.at(-1)).toMatchObject({ type: 'error', id: 'bad-schema', error: { code: 400, reason_code: 'schema_validation_failed' } })
    expect(oversized.sent.at(-1)).toMatchObject({ type: 'error', id: 'oversized', error: { code: 413, reason_code: 'request_too_large' } })
    expect(unauthorized.sent.at(-1)).toMatchObject({ type: 'error', id: 'unauthorized', error: { code: 403, reason_code: 'missing_required_permission' } })
    expect(expiredHost.sent.at(-1)).toMatchObject({ type: 'error', id: 'expired', error: { code: 403, reason_code: 'grant_expired' } })
    expect(revokedHost.sent.at(-1)).toMatchObject({ type: 'error', id: 'revoked', error: { code: 403, reason_code: 'grant_revoked' } })
  })

  it('tracks stream and subscription ownership cleanup on cancel and disconnect', async () => {
    async function* stream(_input: unknown, context: PeerHostCallContext): AsyncIterable<unknown> {
      yield { first: true }
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    const registry = new PeerHostContractRegistry().register({
      methodId: 'Tooling.GetTools',
      methodType: 'stream',
      inputSchemaId: 'Tooling.GetTools.input.ToolingGetToolsRequest',
      outputSchemaId: 'Tooling.GetTools.output.ToolingGetToolsResponse',
      inputSchema: {} as never,
      outputSchema: {} as never,
      requiredPermissions: ['Tooling.GetTools'],
      handler: async () => ({ count: 0, tools: [] }),
      streamHandler: stream
    })
    registry.parseInput = (_method, value) => value
    registry.parseOutput = (_method, value) => value
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([grant()]),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    peerHost.startEpoch()
    peerHost.markManifestAcknowledged()

    void peerHost.handleCall({ type: 'call', id: 'stream-1', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
    await Promise.resolve()
    expect(peerHost.getActiveWorkCount()).toBe(1)
    peerHost.handleCancel('stream-1')
    await Promise.resolve()
    expect(peerHost.getActiveWorkCount()).toBe(0)

    await peerHost.handleSubscribe({ type: 'subscribe', id: 'sub-1', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
    expect(peerHost.getActiveWorkCount()).toBe(1)
    peerHost.handleDisconnect('lost')
    expect(peerHost.getActiveWorkCount()).toBe(0)
  })
})
