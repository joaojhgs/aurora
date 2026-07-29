import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'

import {
  MemoryPeerGrantRepository,
  PeerAuthorityResolver,
  PeerHostContractRegistry,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  type LocalPeerGrantV1,
  type PeerHostAuthorizationStore,
  type PeerHostCallContext
} from '../src/webrtc/index.js'
import { providerServiceInstanceId } from '../src/local-tools/identity.js'
import { PeerAuthorityHostAuthorizationStore } from '../src/peer-host/authorization.js'
import { DenyAllInboundCredentialVerifierStore, NoopReconnectChallengeStore, type AuthenticatedPeerContext, type LocalPeerGrantV1 as AuthorityGrant } from '../src/peer-host/authority.js'

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

function authorityGrant(patch: Partial<AuthorityGrant> = {}): AuthorityGrant {
  return {
    version: 1,
    grantId: 'authority-grant-1',
    tokenId: 'token-1',
    claimantPeerId: 'peer-a',
    verifierPeerId: 'local-peer',
    roomName: 'room-a',
    allowedMethodIds: ['Tooling.GetTools'],
    allowedToolContractIds: [],
    capabilityPackIds: [],
    resourceScopes: [],
    createdAtMs: 1,
    grantRevision: 7,
    ...patch
  }
}

function authenticatedContext(patch: Partial<AuthenticatedPeerContext> = {}): AuthenticatedPeerContext {
  return {
    selector: {
      tokenId: 'token-1',
      claimantPeerId: 'peer-a',
      verifierPeerId: 'local-peer',
      roomName: 'room-a'
    },
    transport: {
      channelBinding: 'a'.repeat(64),
      claimantSignalingPeerId: 'sig-peer-a',
      verifierSignalingPeerId: 'local'
    },
    credentialRevision: 3,
    authenticatedAtMs: 999,
    ...patch
  }
}

function host(handler: (input: unknown, context: PeerHostCallContext) => Promise<unknown> | unknown = vi.fn(async () => ({ count: 0, tools: [] })), store: PeerHostAuthorizationStore = new SessionPeerHostAuthorizationStore([grant()])) {
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
  const manifest = peerHost.startEpoch()
  peerHost.markManifestAcknowledged(ackFromManifest(manifest))
  return { peerHost, sent, handler }
}

function ackFromManifest(manifest: Record<string, unknown>, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'manifest_ack',
    connection_epoch: manifest.connection_epoch,
    manifest_revision: manifest.manifest_revision,
    manifest_digest: manifest.manifest_digest,
    compatible_services: manifest.required_services,
    ...patch
  }
}

function firstSharedService(manifest: Record<string, unknown>): Record<string, unknown> {
  expect(Array.isArray(manifest.shared_services)).toBe(true)
  const [service] = manifest.shared_services as Record<string, unknown>[]
  expect(service).toBeDefined()
  if (!service) throw new Error('manifest shared service missing')
  return service
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForTimeoutWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
  await flush()
}

describe('WebRtcPeerHost', () => {
  it('uses canonical local tool provider identity in manifests for RFC3986-sensitive peer ids', () => {
    const localPeerId = "peer \u2603!'()*"
    const expectedServiceInstanceId = providerServiceInstanceId(localPeerId)
    expect(expectedServiceInstanceId).toBe('local:peer%20%E2%98%83%21%27%28%29%2A:Tooling')
    const peerHost = new WebRtcPeerHost({
      localPeerId,
      nodeName: 'Local',
      registry: new PeerHostContractRegistry(),
      authorizationStore: new SessionPeerHostAuthorizationStore(),
      clock: () => 1000,
      randomId: () => 'epoch-identity'
    })

    const firstService = firstSharedService(peerHost.startEpoch())
    const secondService = firstSharedService(peerHost.startEpoch())

    expect(firstService.provider_id).toBe(expectedServiceInstanceId)
    expect(firstService.service_instance_id).toBe(expectedServiceInstanceId)
    expect(secondService.provider_id).toBe(expectedServiceInstanceId)
    expect(secondService.service_instance_id).toBe(expectedServiceInstanceId)
  })

  it('keeps generated Tooling registry permissions aligned for export catalog reads', () => {
    const registry = createToolingPeerHostRegistry({
      getTools: async () => ({ count: 0, tools: [] }),
      getExportCatalog: async () => ({
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

    expect(registry.get('Tooling.GetExportCatalog')?.requiredPermissions).toEqual(['Tooling.GetTools'])
    expect(registry.get('Tooling.PrepareExecution')?.requiredPermissions).toEqual(['Tooling.ExecuteTool'])
  })

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

  it('does not open handlers for bare, forged, stale, or incompatible manifest ACKs', async () => {
    const handler = vi.fn(async () => ({ count: 0, tools: [] }))
    const registry = createToolingPeerHostRegistry({
      getTools: handler,
      getExportCatalog: async () => { throw new Error('not implemented') },
      prepareExecution: async () => { throw new Error('not implemented') },
      executeTool: async () => { throw new Error('not implemented') }
    })
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([grant({ allowedMethodIds: ['Tooling.GetTools', 'Tooling.ProjectionInvalidated'] })]),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const first = peerHost.startEpoch()
    expect(peerHost.markManifestAcknowledged({ type: 'manifest_ack' })).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { connection_epoch: 'wrong' }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { manifest_digest: '1'.repeat(64) }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { compatible_services: [] }))).toBe(false)
    await peerHost.handleCall({ type: 'call', id: 'not-ready', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
    expect(handler).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'not-ready', error: { code: 425 } })
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first))).toBe(true)
    await peerHost.handleCall({ type: 'call', id: 'ready', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
    expect(handler).toHaveBeenCalledTimes(1)
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

    const unauthorized = host(handler, new SessionPeerHostAuthorizationStore())
    await unauthorized.peerHost.handleCall({
      type: 'call',
      id: 'unauthorized',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
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
    expect(unauthorized.sent.at(-1)).toMatchObject({ type: 'error', id: 'unauthorized', error: { code: 403, reason_code: 'grant_not_found' } })
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
    }).registerEvent({
      topic: 'Tooling.ProjectionInvalidated',
      outputSchemaId: 'Tooling.ProjectionInvalidated.output',
      outputSchema: z.object({ provider_peer_id: z.string() }),
      requiredPermissions: [],
      handler: () => ({ close: vi.fn() })
    })
    registry.parseInput = (_method, value) => value
    registry.parseOutput = (_method, value) => value
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore([grant({ allowedMethodIds: ['Tooling.GetTools', 'Tooling.ProjectionInvalidated'] })]),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const manifest = peerHost.startEpoch()
    peerHost.markManifestAcknowledged(ackFromManifest(manifest))

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

  it('authorizes registered subscriptions before activation and rejects hostile subscription attempts', async () => {
    const opened = vi.fn(() => ({ close: vi.fn() }))
    const registry = new PeerHostContractRegistry().registerEvent({
      topic: 'Tooling.ProjectionInvalidated',
      outputSchemaId: 'Tooling.ProjectionInvalidated.output',
      outputSchema: z.object({ provider_peer_id: z.string() }),
      requiredPermissions: ['Tooling.SubscribeProjection'],
      handler: opened
    })
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new SessionPeerHostAuthorizationStore(),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const manifest = peerHost.startEpoch()
    peerHost.markManifestAcknowledged(ackFromManifest(manifest))

    await peerHost.handleSubscribe({ type: 'subscribe', id: 'unknown', topics: ['Unknown.Topic'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
    await peerHost.handleSubscribe({ type: 'subscribe', id: 'unauthorized', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
    expect(opened).not.toHaveBeenCalled()
    expect(peerHost.getActiveWorkCount()).toBe(0)
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'subscribe_rejected', id: 'unknown', reason: 'topic_not_registered' }),
      expect.objectContaining({ type: 'subscribe_rejected', id: 'unauthorized', reason: 'grant_not_found' })
    ]))

    for (const [id, store, reason] of [
      ['expired-sub', new SessionPeerHostAuthorizationStore([grant({ allowedMethodIds: ['Tooling.ProjectionInvalidated'], expiresAtMs: 500 })]), 'grant_expired'],
      ['revoked-sub', new SessionPeerHostAuthorizationStore([grant({ allowedMethodIds: ['Tooling.ProjectionInvalidated'], revokedAtMs: 500 })]), 'grant_revoked'],
    ] as const) {
      const blocked = new WebRtcPeerHost({
        localPeerId: 'local-peer',
        nodeName: 'Local',
        registry: new PeerHostContractRegistry().registerEvent({
          topic: 'Tooling.ProjectionInvalidated',
          outputSchemaId: 'Tooling.ProjectionInvalidated.output',
          outputSchema: z.object({ provider_peer_id: z.string() }),
          requiredPermissions: [],
          handler: opened
        }),
        authorizationStore: store,
        clock: () => 1000,
        randomId: () => 'epoch-1'
      })
      const blockedSent: unknown[] = []
      blocked.attach({ sendFrame: async (frame) => { blockedSent.push(frame) } })
      const blockedManifest = blocked.startEpoch()
      blocked.markManifestAcknowledged(ackFromManifest(blockedManifest))
      await blocked.handleSubscribe({ type: 'subscribe', id, topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
      expect(blocked.getActiveWorkCount()).toBe(0)
      expect(blockedSent.at(-1)).toMatchObject({ type: 'subscribe_rejected', id, reason })
    }

    const allowed = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: new PeerHostContractRegistry().registerEvent({
        topic: 'Tooling.ProjectionInvalidated',
        outputSchemaId: 'Tooling.ProjectionInvalidated.output',
        outputSchema: z.object({ provider_peer_id: z.string() }),
        requiredPermissions: [],
        handler: opened
      }),
      authorizationStore: new SessionPeerHostAuthorizationStore([grant({ allowedMethodIds: ['Tooling.ProjectionInvalidated'] })]),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const allowedSent: unknown[] = []
    allowed.attach({ sendFrame: async (frame) => { allowedSent.push(frame) } })
    const allowedManifest = allowed.startEpoch()
    allowed.markManifestAcknowledged(ackFromManifest(allowedManifest))
    await allowed.handleSubscribe({ type: 'subscribe', id: 'sub-ok', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
    expect(opened).toHaveBeenCalledTimes(1)
    expect(allowed.getActiveWorkCount()).toBe(1)
    expect(allowedSent.at(-1)).toMatchObject({ type: 'subscribed', id: 'sub-ok' })
  })

  it('uses authenticated authority context instead of forged caller identity or effective permissions', async () => {
    const grants = new MemoryPeerGrantRepository()
    await grants.upsertGrant(authorityGrant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new DenyAllInboundCredentialVerifierStore(),
      grantRepository: grants,
      challengeStore: new NoopReconnectChallengeStore()
    })
    const handler = vi.fn(async (_input: unknown, context: PeerHostCallContext) => {
      expect(context.identity).toMatchObject({
        callerPeerId: 'peer-a',
        effectivePermissions: [],
        authGrantRevision: 3
      })
      expect(context.authenticatedPeerContext?.selector).toMatchObject({ tokenId: 'token-1', claimantPeerId: 'peer-a' })
      return { count: 0, tools: [] }
    })
    const { peerHost, sent } = host(handler, new PeerAuthorityHostAuthorizationStore(resolver))

    await peerHost.handleCall({
      type: 'call',
      id: 'authority-ok',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-b', effective_perms: ['*', 'Tooling.GetTools'] }
    }, 'peer-a', authenticatedContext())

    expect(handler).toHaveBeenCalledTimes(1)
    expect(sent.at(-1)).toEqual({ type: 'result', id: 'authority-ok', result: { count: 0, tools: [] } })
  })

  it('denies authority-backed provider calls without authenticated context or matching selector', async () => {
    const grants = new MemoryPeerGrantRepository()
    await grants.upsertGrant(authorityGrant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new DenyAllInboundCredentialVerifierStore(),
      grantRepository: grants,
      challengeStore: new NoopReconnectChallengeStore()
    })
    const handler = vi.fn(async () => ({ count: 0, tools: [] }))
    const missing = host(handler, new PeerAuthorityHostAuthorizationStore(resolver))
    await missing.peerHost.handleCall({
      type: 'call',
      id: 'no-context',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['*'] }
    }, 'peer-a')

    const mismatch = host(handler, new PeerAuthorityHostAuthorizationStore(resolver))
    await mismatch.peerHost.handleCall({
      type: 'call',
      id: 'selector-mismatch',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['*'] }
    }, 'peer-a', authenticatedContext({ selector: { ...authenticatedContext().selector, claimantPeerId: 'peer-b' } }))

    expect(handler).not.toHaveBeenCalled()
    expect(missing.sent.at(-1)).toMatchObject({ type: 'error', id: 'no-context', error: { code: 403, reason_code: 'peer_not_authenticated' } })
    expect(mismatch.sent.at(-1)).toMatchObject({ type: 'error', id: 'selector-mismatch', error: { code: 403, reason_code: 'selector_mismatch' } })
  })

  it('races non-cooperative handlers, sends one timeout, ignores late success, and hides raw errors', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const handler = vi.fn(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { count: 0, tools: [] }
      })
      const { peerHost, sent } = host(handler)
      const pending = peerHost.handleCall({ type: 'call', id: 'slow', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
      await Promise.resolve()
      await Promise.resolve()
      vi.advanceTimersByTime(30_001)
      await Promise.resolve()
      await Promise.resolve()
      expect(sent.filter((frame) => (frame as any).type === 'error' && (frame as any).id === 'slow')).toHaveLength(1)
      expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'slow', error: { code: 504, message: 'request timed out', reason_code: 'request_timeout' } })
      expect(peerHost.getActiveWorkCount()).toBe(0)
      release()
      await pending
      expect(sent.filter((frame) => (frame as any).id === 'slow')).toHaveLength(1)

      const boom = host(vi.fn(async () => { throw new Error('secret stack token') }))
      await boom.peerHost.handleCall({ type: 'call', id: 'boom', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
      expect(JSON.stringify(boom.sent.at(-1))).not.toContain('secret stack token')
      expect(boom.sent.at(-1)).toMatchObject({ type: 'error', id: 'boom', error: { code: 500, message: 'handler failed', reason_code: 'handler_failed' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('consumes timeout send rejection for late call and stream work without leaking raw sender text', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const sent: unknown[] = []
      let callRelease!: () => void
      const registry = new PeerHostContractRegistry().register({
        methodId: 'Tooling.GetTools',
        methodType: 'unary',
        inputSchemaId: 'Tooling.GetTools.input',
        outputSchemaId: 'Tooling.GetTools.output',
        inputSchema: z.any(),
        outputSchema: z.object({ count: z.number(), tools: z.array(z.unknown()) }),
        requiredPermissions: ['Tooling.GetTools'],
        timeoutMs: 1,
        handler: async () => {
          await new Promise<void>((resolve) => { callRelease = resolve })
          return { count: 0, tools: [] }
        }
      })
      const peerHost = new WebRtcPeerHost({
        localPeerId: 'local-peer',
        nodeName: 'Local',
        registry,
        authorizationStore: new SessionPeerHostAuthorizationStore([grant()]),
        clock: () => Date.now(),
        randomId: () => 'timeout-ref'
      })
      peerHost.attach({
        sendFrame: async (frame) => {
          sent.push(frame)
          throw new Error('send failed secret')
        }
      })
      const manifest = peerHost.startEpoch()
      peerHost.markManifestAcknowledged(ackFromManifest(manifest))

      const call = peerHost.handleCall({ type: 'call', id: 'late-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
      await flush()
      await waitForTimeoutWork()
      expect(peerHost.getDiagnostics()).toMatchObject({ activeWorkCount: 0, timeoutSendFailureCount: 1, lastTimeoutFailureReason: 'timeout_send_failed' })
      expect(JSON.stringify(peerHost.getDiagnostics())).not.toContain('send failed secret')
      expect(unhandled.map(String).join('\n')).not.toContain('send failed secret')
      expect(sent).toHaveLength(1)
      expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'late-call', error: { code: 504, reason_code: 'request_timeout' } })
      callRelease()
      await call
      expect(sent).toHaveLength(1)

      const streamSent: unknown[] = []
      let streamRelease!: () => void
      async function* lateStream(): AsyncIterable<unknown> {
        await new Promise<void>((resolve) => { streamRelease = resolve })
        yield { count: 0, tools: [] }
      }
      const streamRegistry = new PeerHostContractRegistry().register({
        methodId: 'Tooling.GetTools',
        methodType: 'stream',
        inputSchemaId: 'Tooling.GetTools.input',
        outputSchemaId: 'Tooling.GetTools.output',
        inputSchema: z.any(),
        outputSchema: z.object({ count: z.number(), tools: z.array(z.unknown()) }),
        requiredPermissions: ['Tooling.GetTools'],
        timeoutMs: 1,
        handler: async () => ({ count: 0, tools: [] }),
        streamHandler: lateStream
      })
      const streamHost = new WebRtcPeerHost({
        localPeerId: 'local-peer',
        nodeName: 'Local',
        registry: streamRegistry,
        authorizationStore: new SessionPeerHostAuthorizationStore([grant()]),
        clock: () => Date.now(),
        randomId: () => 'stream-timeout-ref'
      })
      streamHost.attach({
        sendFrame: async (frame) => {
          streamSent.push(frame)
          throw new Error('send failed secret')
        }
      })
      const streamManifest = streamHost.startEpoch()
      streamHost.markManifestAcknowledged(ackFromManifest(streamManifest))

      const stream = streamHost.handleCall({ type: 'call', id: 'late-stream', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
      await flush()
      await waitForTimeoutWork()
      expect(streamHost.getDiagnostics()).toMatchObject({ activeWorkCount: 0, timeoutSendFailureCount: 1, lastTimeoutFailureReason: 'timeout_send_failed' })
      expect(JSON.stringify(streamHost.getDiagnostics())).not.toContain('send failed secret')
      expect(unhandled.map(String).join('\n')).not.toContain('send failed secret')
      expect(streamSent).toHaveLength(1)
      expect(streamSent.at(-1)).toMatchObject({ type: 'error', id: 'late-stream', error: { code: 504, reason_code: 'request_timeout' } })
      streamRelease()
      await stream
      expect(streamSent).toHaveLength(1)
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
