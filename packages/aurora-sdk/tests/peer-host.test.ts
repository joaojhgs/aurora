import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'

import { MemoryLocalDataBackend } from '../src/local-data/index.js'
import {
  MemoryPeerGrantRepository,
  MemoryPeerRevocationBroadcaster,
  PeerAuthorityResolver,
  PeerHostContractRegistry,
  SessionPeerHostAuthorizationStore,
  WebRtcPeerHost,
  createToolingPeerHostRegistry,
  type LocalPeerGrantV1,
  type PeerHostAuthorizationStore,
  type PeerHostCallContext
} from '../src/webrtc/index.js'
import { PeerAuthorityHostAuthorizationStore } from '../src/peer-host/authorization.js'
import { DenyAllInboundCredentialVerifierStore, NoopReconnectChallengeStore, type AuthenticatedPeerContext, type LocalPeerGrantV1 as AuthorityGrant, type PeerRevocationBroadcaster } from '../src/peer-host/authority.js'
import { LocalDataPeerAuditSink } from '../src/peer-host/local-data-authority-adapters.js'

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

async function host(
  handler: (input: unknown, context: PeerHostCallContext) => Promise<unknown> | unknown = vi.fn(async () => ({ count: 0, tools: [] })),
  store: PeerHostAuthorizationStore = new SessionPeerHostAuthorizationStore([grant()]),
  manifestContext?: AuthenticatedPeerContext
) {
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
  const manifest = await peerHost.startEpoch('peer-a', manifestContext)
  peerHost.markManifestAcknowledged(ackFromManifest(manifest))
  return { peerHost, sent, handler }
}

function ackFromManifest(manifest: Record<string, unknown>, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const evidence = manifest.recipient_projection_evidence as Record<string, unknown>
  return {
    type: 'manifest_ack',
    compatible_services: Array.isArray(manifest.shared_services) && manifest.shared_services.length > 0 ? ['Tooling'] : [],
    incompatible_services: [],
    unused_services: [],
    active_protocol: 'projection-v1',
    active_version: 'v1',
    active_tier: 'projection',
    protocol_revision: 'v1',
    registry_revision: evidence.registry_revision,
    export_policy_revision: evidence.policy_revision,
    auth_grant_revision: evidence.auth_grant_revision,
    projection_digest: evidence.projection_digest,
    services: [
      { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' }
    ],
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

function revocationEvent(selector = authenticatedContext().selector, patch: Record<string, unknown> = {}) {
  return {
    type: 'peer_authority_revoked_v1' as const,
    selector,
    revokedGrantIds: ['authority-grant-1'],
    credentialRevision: 4,
    revokedAtMs: 1234,
    reasonCode: 'operator_revoked',
    redacted: true as const,
    ...patch
  }
}

async function authorityHost(options: {
  handler?: (input: unknown, context: PeerHostCallContext) => Promise<unknown> | unknown
  streamHandler?: (input: unknown, context: PeerHostCallContext) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
  subscriptionClose?: (reason?: string) => void | Promise<void>
  broadcaster?: PeerRevocationBroadcaster
  sender?: { sendFrame(frame: Record<string, unknown>): Promise<void> }
  context?: AuthenticatedPeerContext
} = {}) {
  const registry = new PeerHostContractRegistry().register({
    methodId: 'Tooling.GetTools',
    methodType: options.streamHandler ? 'stream' : 'unary',
    inputSchemaId: 'Tooling.GetTools.input',
    outputSchemaId: 'Tooling.GetTools.output',
    inputSchema: z.any(),
    outputSchema: z.any(),
    requiredPermissions: ['Tooling.GetTools'],
    handler: options.handler ?? (async () => ({ count: 0, tools: [] })),
    ...(options.streamHandler ? { streamHandler: options.streamHandler } : {})
  }).registerEvent({
    topic: 'Tooling.ProjectionInvalidated',
    outputSchemaId: 'Tooling.ProjectionInvalidated.output',
    outputSchema: z.object({ provider_peer_id: z.string() }),
    requiredPermissions: ['Tooling.ProjectionInvalidated'],
    handler: () => ({ close: options.subscriptionClose ?? (() => undefined) })
  })
  registry.parseInput = (_method, value) => value
  registry.parseOutput = (_method, value) => value
  const grants = new MemoryPeerGrantRepository()
  await grants.upsertGrant(authorityGrant({ allowedMethodIds: ['Tooling.GetTools', 'Tooling.ProjectionInvalidated'] }))
  const resolver = new PeerAuthorityResolver({
    verifierStore: new DenyAllInboundCredentialVerifierStore(),
    grantRepository: grants,
    challengeStore: new NoopReconnectChallengeStore()
  })
  const broadcaster = options.broadcaster ?? new MemoryPeerRevocationBroadcaster()
  const peerHost = new WebRtcPeerHost({
    localPeerId: 'local-peer',
    nodeName: 'Local',
    registry,
    authorizationStore: new PeerAuthorityHostAuthorizationStore(resolver),
    revocationBroadcaster: broadcaster,
    clock: () => 1000,
    randomId: () => 'epoch-1'
  })
  const sent: unknown[] = []
  peerHost.attach(options.sender ?? { sendFrame: async (frame) => { sent.push(frame) } })
  const context = options.context ?? authenticatedContext()
  const manifest = await peerHost.startEpoch('peer-a', context)
  peerHost.markManifestAcknowledged(ackFromManifest(manifest))
  return { peerHost, sent, broadcaster, context }
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
  it('omits legacy local tool provider identity fields from canonical manifests', async () => {
    const localPeerId = "peer \u2603!'()*"
    const peerHost = new WebRtcPeerHost({
      localPeerId,
      nodeName: 'Local',
      registry: new PeerHostContractRegistry().register({
        methodId: 'Tooling.GetTools',
        methodType: 'unary',
        inputSchemaId: 'Tooling.GetTools.input',
        outputSchemaId: 'Tooling.GetTools.output',
        inputSchema: z.any(),
        outputSchema: z.any(),
        requiredPermissions: ['Tooling.GetTools'],
        handler: async () => ({ count: 0, tools: [] })
      }),
      authorizationStore: new SessionPeerHostAuthorizationStore([grant()]),
      clock: () => 1000,
      randomId: () => 'epoch-identity'
    })

    const firstService = firstSharedService(await peerHost.startEpoch('peer-a'))
    const secondService = firstSharedService(await peerHost.startEpoch('peer-a'))

    expect(firstService.provider_id).toBeUndefined()
    expect(firstService.service_instance_id).toBeUndefined()
    expect(secondService.provider_id).toBeUndefined()
    expect(secondService.service_instance_id).toBeUndefined()
  })

  it('emits a Python projection-v1 Tooling manifest without private ACK or lease fields', async () => {
    const { peerHost } = await host()
    const manifest = await peerHost.startEpoch('peer-a')

    expect(Object.keys(manifest).sort()).toEqual([
      'active_protocol',
      'active_tier',
      'active_version',
      'aurora_version',
      'granted_permissions',
      'node_name',
      'peer_id',
      'projection_active',
      'projection_supported',
      'recipient_projection_evidence',
      'shared_services',
      'supported_protocols',
      'timestamp',
      'type'
    ])
    expect(manifest).toMatchObject({
      type: 'manifest',
      peer_id: 'local-peer',
      active_protocol: 'projection-v1',
      active_version: 'v1',
      active_tier: 'projection',
      supported_protocols: ['legacy-unfiltered-v0', 'projection-v1'],
      projection_supported: true,
      projection_active: true,
      granted_permissions: null
    })
    expect(JSON.stringify(manifest)).not.toContain('connection_epoch')
    expect(JSON.stringify(manifest)).not.toContain('manifest_digest')
    expect(JSON.stringify(manifest)).not.toContain('provider_lease_v1')
    const service = firstSharedService(manifest)
    expect(service).toMatchObject({ module: 'Tooling', capabilities: [] })
    expect(typeof service.digest).toBe('string')
    const methods = service.methods as Array<Record<string, unknown>>
    expect(methods.map((method) => method.bus_topic)).toEqual([
      'Tooling.GetTools'
    ])
    expect(methods.every((method) => method.method_type === 'use')).toBe(true)
    expect(manifest.recipient_projection_evidence).toMatchObject({
      provider_peer_id: 'local-peer',
      recipient_peer_id: 'peer-a',
      auth_grant_revision: 1,
      auth_grant_state: 'active',
      protocol_tier: 'projection-v1',
      grants: [{ permission: 'Tooling.GetTools', source: 'effective' }]
    })
    for (const field of ['registry_digest', 'policy_digest', 'auth_grant_digest', 'grants_digest', 'projection_digest', 'evidence_digest']) {
      expect((manifest.recipient_projection_evidence as Record<string, unknown>)[field]).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('writes a redacted epoch-bearing audit row for authority manifest evaluation', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    const grants = new MemoryPeerGrantRepository()
    await grants.upsertGrant(authorityGrant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new DenyAllInboundCredentialVerifierStore(),
      grantRepository: grants,
      challengeStore: new NoopReconnectChallengeStore(),
      auditSink: new LocalDataPeerAuditSink({
        auditRepository: session.localAudit,
        profileId: 'profile-1',
        localNodeId: 'node-1',
        randomId: () => 'audit-manifest'
      })
    })

    await host(
      vi.fn(async () => ({ count: 0, tools: [] })),
      new PeerAuthorityHostAuthorizationStore(resolver),
      authenticatedContext()
    )

    await expect(session.localAudit.listAudit()).resolves.toEqual([
      expect.objectContaining({
        id: 'audit-manifest',
        peerId: 'peer-a',
        action: 'manifest.snapshot',
        decision: 'accepted',
        connectionEpoch: 'epoch-1',
        correlationId: 'manifest:epoch-1',
        redactedDetailJson: expect.objectContaining({
          redacted: true,
          secretsRedacted: true,
          authorityState: 'active'
        })
      })
    ])
    expect(JSON.stringify(await session.localAudit.listAudit())).not.toMatch(/peer-verifier|room-a|tokenHashHex|proofHex|bearer|[a-f0-9]{64}/u)
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
    const { peerHost, sent } = await host(handler)
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
    const first = await peerHost.startEpoch('peer-a')
    expect(peerHost.currentLease()).toBeNull()
    expect(sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(0)
    expect(peerHost.markManifestAcknowledged({ type: 'manifest_ack' })).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { projection_digest: '1'.repeat(64) }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { auth_grant_revision: 999 }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { compatible_services: [] }))).toBe(false)
    const missingServices = ackFromManifest(first)
    delete missingServices.services
    expect(peerHost.markManifestAcknowledged(missingServices)).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, { incompatible_services: ['Tooling'] }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, {
      services: [
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' },
        { service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' }
      ]
    }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, {
      compatible_services: [],
      incompatible_services: ['Tooling'],
      services: [
        { service_id: 'Tooling', service_label: '', status: 'incompatible', reason_codes: ['method_not_advertised'], reason: '' }
      ]
    }))).toBe(false)
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first, {
      compatible_services: [],
      unused_services: ['Tooling'],
      services: [
        { service_id: 'Tooling', service_label: '', status: 'unused', reason_codes: ['not_requested'], reason: '' }
      ]
    }))).toBe(false)
    await flush()
    expect(sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(0)
    await peerHost.handleCall({ type: 'call', id: 'not-ready', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
    expect(handler).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'not-ready', error: { code: 425 } })
    expect(peerHost.markManifestAcknowledged(ackFromManifest(first))).toBe(true)
    await flush()
    expect(sent.filter((frame) => (frame as any).type === 'provider_lease')).toHaveLength(1)
    await peerHost.handleCall({ type: 'call', id: 'ready', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('never dispatches malformed, oversized, unauthorized, expired, or revoked calls', async () => {
    const handler = vi.fn(async () => ({ count: 0, tools: [] }))
    const expired = new SessionPeerHostAuthorizationStore([grant({ grantId: 'expiring-grant', expiresAtMs: 5_000 })])
    const revoked = new SessionPeerHostAuthorizationStore([grant({ grantId: 'revokable-grant' })])

    const malformed = await host(handler)
    await malformed.peerHost.handleCall({
      type: 'call',
      id: 'bad-schema',
      method: 'Tooling.GetTools',
      params: { top_k: -1 },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const oversized = await host(handler)
    await oversized.peerHost.handleCall({
      type: 'call',
      id: 'oversized',
      method: 'Tooling.GetTools',
      params: { query: 'x'.repeat(300_000) },
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const unauthorizedStore = new SessionPeerHostAuthorizationStore([grant()])
    const unauthorized = await host(handler, unauthorizedStore)
    unauthorizedStore.clear()
    await unauthorized.peerHost.handleCall({
      type: 'call',
      id: 'unauthorized',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const expiredHost = await host(handler, expired)
    expired.upsertGrant(grant({ grantId: 'expiring-grant', expiresAtMs: 500 }))
    await expiredHost.peerHost.handleCall({
      type: 'call',
      id: 'expired',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] }
    }, 'peer-a')

    const revokedHost = await host(handler, revoked)
    revoked.revokeGrant('revokable-grant', 500)
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
    const manifest = await peerHost.startEpoch('peer-a')
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
    const registry = new PeerHostContractRegistry().register({
      methodId: 'Tooling.GetTools',
      methodType: 'unary',
      inputSchemaId: 'Tooling.GetTools.input',
      outputSchemaId: 'Tooling.GetTools.output',
      inputSchema: z.any(),
      outputSchema: z.any(),
      requiredPermissions: ['Tooling.GetTools'],
      handler: async () => ({ count: 0, tools: [] })
    }).registerEvent({
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
      authorizationStore: new SessionPeerHostAuthorizationStore([grant()]),
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const manifest = await peerHost.startEpoch('peer-a')
    peerHost.markManifestAcknowledged(ackFromManifest(manifest))

    await peerHost.handleSubscribe({ type: 'subscribe', id: 'unknown', topics: ['Unknown.Topic'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
    await peerHost.handleSubscribe({ type: 'subscribe', id: 'unauthorized', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
    expect(opened).not.toHaveBeenCalled()
    expect(peerHost.getActiveWorkCount()).toBe(0)
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'subscribe_rejected', id: 'unknown', reason: 'topic_not_registered' }),
      expect.objectContaining({ type: 'subscribe_rejected', id: 'unauthorized', reason: 'grant_not_found' })
    ]))

    const expiredSubStore = new SessionPeerHostAuthorizationStore([grant({ grantId: 'sub-grant', allowedMethodIds: ['Tooling.ProjectionInvalidated'], expiresAtMs: 5_000 })])
    const revokedSubStore = new SessionPeerHostAuthorizationStore([grant({ grantId: 'sub-grant', allowedMethodIds: ['Tooling.ProjectionInvalidated'] })])
    for (const { id, store, reason, expire } of [
      {
        id: 'expired-sub',
        store: expiredSubStore,
        reason: 'grant_expired',
        expire: () => expiredSubStore.upsertGrant(grant({ grantId: 'sub-grant', allowedMethodIds: ['Tooling.ProjectionInvalidated'], expiresAtMs: 500 }))
      },
      {
        id: 'revoked-sub',
        store: revokedSubStore,
        reason: 'grant_revoked',
        expire: () => revokedSubStore.revokeGrant('sub-grant', 500)
      }
    ] as const) {
      const blocked = new WebRtcPeerHost({
        localPeerId: 'local-peer',
        nodeName: 'Local',
        registry: new PeerHostContractRegistry().register({
          methodId: 'Tooling.ProjectionInvalidated',
          methodType: 'unary',
          inputSchemaId: 'Tooling.ProjectionInvalidated.input',
          outputSchemaId: 'Tooling.ProjectionInvalidated.output',
          inputSchema: z.any(),
          outputSchema: z.any(),
          requiredPermissions: ['Tooling.SubscribeProjection'],
          handler: async () => ({ ok: true })
        }).registerEvent({
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
      const blockedManifest = await blocked.startEpoch('peer-a')
      blocked.markManifestAcknowledged(ackFromManifest(blockedManifest))
      expire()
      await blocked.handleSubscribe({ type: 'subscribe', id, topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a')
      expect(blocked.getActiveWorkCount()).toBe(0)
      expect(blockedSent.at(-1)).toMatchObject({ type: 'subscribe_rejected', id, reason })
    }

    const allowed = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry: new PeerHostContractRegistry().register({
        methodId: 'Tooling.ProjectionInvalidated',
        methodType: 'unary',
        inputSchemaId: 'Tooling.ProjectionInvalidated.input',
        outputSchemaId: 'Tooling.ProjectionInvalidated.output',
        inputSchema: z.any(),
        outputSchema: z.any(),
        requiredPermissions: ['Tooling.SubscribeProjection'],
        handler: async () => ({ ok: true })
      }).registerEvent({
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
    const allowedManifest = await allowed.startEpoch('peer-a')
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
        effectivePermissions: ['Tooling.GetTools'],
        authGrantRevision: 7
      })
      expect(context.authenticatedPeerContext?.selector).toMatchObject({ tokenId: 'token-1', claimantPeerId: 'peer-a' })
      expect(context.authenticatedPeerContext?.connectionEpoch).toBe('epoch-1')
      return { count: 0, tools: [] }
    })
    const { peerHost, sent } = await host(handler, new PeerAuthorityHostAuthorizationStore(resolver), authenticatedContext())

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

  it('terminates active unary work and prevents new calls when the authenticated selector is revoked', async () => {
    let aborted = false
    const { peerHost, sent, broadcaster } = await authorityHost({
      handler: async (_input, context) => {
        await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true }))
        return { count: 0, tools: [] }
      }
    })

    const pending = peerHost.handleCall({ type: 'call', id: 'active-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a', authenticatedContext())
    await flush()
    expect(peerHost.getActiveWorkCount()).toBe(1)

    await broadcaster.publish(revocationEvent({ ...authenticatedContext().selector, claimantPeerId: 'peer-b' }))
    await flush()
    expect(peerHost.getActiveWorkCount()).toBe(1)
    expect(aborted).toBe(false)

    await broadcaster.publish(revocationEvent())
    await flush()
    await pending
    expect(aborted).toBe(true)
    expect(peerHost.getActiveWorkCount()).toBe(0)
    expect(sent.filter((frame) => (frame as any).id === 'active-call')).toEqual([
      expect.objectContaining({ type: 'error', id: 'active-call', error: expect.objectContaining({ code: 403, reason_code: 'peer_authority_revoked' }) })
    ])
    expect(JSON.stringify(sent)).not.toMatch(/tokenHash|bearer|proof|room-a|operator_revoked/u)

    await peerHost.handleCall({ type: 'call', id: 'after-revoke', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a', authenticatedContext())
    expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'after-revoke', error: { code: 403, reason_code: 'peer_authority_revoked' } })
  })

  it('terminates active streams and subscriptions on matching revocation only', async () => {
    const closedReasons: Array<string | undefined> = []
    async function* stream(_input: unknown, context: PeerHostCallContext): AsyncIterable<unknown> {
      yield { count: 1, tools: [] }
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { count: 2, tools: [] }
    }
    const { peerHost, sent, broadcaster } = await authorityHost({
      streamHandler: stream,
      subscriptionClose: (reason) => { closedReasons.push(reason) }
    })

    const pendingStream = peerHost.handleCall({ type: 'call', id: 'active-stream', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a', authenticatedContext())
    await flush()
    await peerHost.handleSubscribe({ type: 'subscribe', id: 'active-sub', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a', authenticatedContext())
    expect(peerHost.getActiveWorkCount()).toBe(2)

    await broadcaster.publish(revocationEvent({ ...authenticatedContext().selector, roomName: 'other-room' }))
    await flush()
    expect(peerHost.getActiveWorkCount()).toBe(2)
    expect(closedReasons).toEqual([])

    await broadcaster.publish(revocationEvent())
    await flush()
    await pendingStream
    expect(peerHost.getActiveWorkCount()).toBe(0)
    expect(closedReasons).toEqual(['peer_authority_revoked'])
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', id: 'active-stream', error: expect.objectContaining({ code: 403, reason_code: 'peer_authority_revoked' }) }),
      expect.objectContaining({ type: 'unsubscribed', id: 'active-sub', subscription_id: 'active-sub', removed: true })
    ]))
    expect(sent.filter((frame) => (frame as any).id === 'active-stream' && (frame as any).type === 'error')).toHaveLength(1)
  })

  it('closes subscription handles returned after a matching revocation wins the open race', async () => {
    let releaseOpen!: () => void
    let sawAbort = false
    const close = vi.fn()
    const registry = new PeerHostContractRegistry().register({
      methodId: 'Tooling.GetTools',
      methodType: 'unary',
      inputSchemaId: 'Tooling.GetTools.input',
      outputSchemaId: 'Tooling.GetTools.output',
      inputSchema: z.any(),
      outputSchema: z.any(),
      requiredPermissions: ['Tooling.GetTools'],
      handler: async () => ({ count: 0, tools: [] })
    }).registerEvent({
      topic: 'Tooling.ProjectionInvalidated',
      outputSchemaId: 'Tooling.ProjectionInvalidated.output',
      outputSchema: z.object({ provider_peer_id: z.string() }),
      requiredPermissions: ['Tooling.ProjectionInvalidated'],
      handler: async (context) => {
        context.signal.addEventListener('abort', () => { sawAbort = true }, { once: true })
        await new Promise<void>((resolve) => { releaseOpen = resolve })
        return { close }
      }
    })
    const grants = new MemoryPeerGrantRepository()
    await grants.upsertGrant(authorityGrant({ allowedMethodIds: ['Tooling.GetTools', 'Tooling.ProjectionInvalidated'] }))
    const broadcaster = new MemoryPeerRevocationBroadcaster()
    const peerHost = new WebRtcPeerHost({
      localPeerId: 'local-peer',
      nodeName: 'Local',
      registry,
      authorizationStore: new PeerAuthorityHostAuthorizationStore(new PeerAuthorityResolver({
        verifierStore: new DenyAllInboundCredentialVerifierStore(),
        grantRepository: grants,
        challengeStore: new NoopReconnectChallengeStore()
      })),
      revocationBroadcaster: broadcaster,
      clock: () => 1000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const manifest = await peerHost.startEpoch('peer-a', authenticatedContext())
    peerHost.markManifestAcknowledged(ackFromManifest(manifest))

    const pending = peerHost.handleSubscribe({ type: 'subscribe', id: 'suspended-sub', topics: ['Tooling.ProjectionInvalidated'], correlation_ids: [], ttl_seconds: 60 }, 'peer-a', authenticatedContext())
    await flush()
    expect(peerHost.getActiveWorkCount()).toBe(1)

    await broadcaster.publish(revocationEvent())
    await flush()
    expect(sawAbort).toBe(true)
    expect(peerHost.getActiveWorkCount()).toBe(0)

    releaseOpen()
    await pending
    expect(close).toHaveBeenCalledWith('peer_authority_revoked')
    expect(sent.some((frame) => (frame as any).type === 'subscribed' && (frame as any).id === 'suspended-sub')).toBe(false)
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'unsubscribed', id: 'suspended-sub', subscription_id: 'suspended-sub', removed: true })
    ]))
    expect(peerHost.getActiveWorkCount()).toBe(0)
  })

  it('cleans revocation listeners on disconnect and swallows revocation terminal send failures', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      let listener: ((event: ReturnType<typeof revocationEvent>) => void) | null = null
      let subscribeCount = 0
      let unsubscribeCount = 0
      const broadcaster = {
        async publish(event: ReturnType<typeof revocationEvent>) { listener?.(event) },
        subscribe(next: (event: ReturnType<typeof revocationEvent>) => void) {
          subscribeCount += 1
          listener = next
          return () => {
            unsubscribeCount += 1
            if (listener === next) listener = null
          }
        }
      } satisfies PeerRevocationBroadcaster
      let release!: () => void
      const sent: unknown[] = []
      const { peerHost } = await authorityHost({
        broadcaster,
        sender: {
          sendFrame: async (frame) => {
            sent.push(frame)
            if ((frame as any).id === 'send-fails') throw new Error('secret send failed')
          }
        },
        handler: async (_input, context) => {
          await new Promise<void>((resolve) => {
            release = resolve
            context.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return { count: 0, tools: [] }
        }
      })
      const pending = peerHost.handleCall({ type: 'call', id: 'send-fails', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a', authenticatedContext())
      await flush()
      expect(peerHost.getActiveWorkCount()).toBe(1)
      await broadcaster.publish(revocationEvent())
      await flush()
      release()
      await pending
      expect(peerHost.getActiveWorkCount()).toBe(0)
      expect(unhandled).toEqual([])
      expect(JSON.stringify(sent)).not.toContain('secret send failed')

      peerHost.handleDisconnect('closed')
      expect(subscribeCount).toBe(1)
      expect(unsubscribeCount).toBe(1)
      await broadcaster.publish(revocationEvent())
      await flush()
      expect(sent.filter((frame) => (frame as any).id === 'send-fails')).toHaveLength(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
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
    const missing = await host(handler, new PeerAuthorityHostAuthorizationStore(resolver), authenticatedContext())
    await missing.peerHost.handleCall({
      type: 'call',
      id: 'no-context',
      method: 'Tooling.GetTools',
      params: {},
      identity: { caller_peer_id: 'peer-a', effective_perms: ['*'] }
    }, 'peer-a')

    const mismatch = await host(handler, new PeerAuthorityHostAuthorizationStore(resolver), authenticatedContext())
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
      const { peerHost, sent } = await host(handler)
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

      const boom = await host(vi.fn(async () => { throw new Error('secret stack token') }))
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
      const manifest = await peerHost.startEpoch('peer-a')
      peerHost.markManifestAcknowledged(ackFromManifest(manifest))

      const call = peerHost.handleCall({ type: 'call', id: 'late-call', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
      await flush()
      await waitForTimeoutWork()
      expect(peerHost.getDiagnostics()).toMatchObject({ activeWorkCount: 0, timeoutSendFailureCount: 1, lastTimeoutFailureReason: 'timeout_send_failed' })
      expect(JSON.stringify(peerHost.getDiagnostics())).not.toContain('send failed secret')
      expect(unhandled.map(String).join('\n')).not.toContain('send failed secret')
      expect(sent.filter((frame) => (frame as any).id === 'late-call')).toHaveLength(1)
      expect(sent.at(-1)).toMatchObject({ type: 'error', id: 'late-call', error: { code: 504, reason_code: 'request_timeout' } })
      callRelease()
      await call
      expect(sent.filter((frame) => (frame as any).id === 'late-call')).toHaveLength(1)

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
      const streamManifest = await streamHost.startEpoch('peer-a')
      streamHost.markManifestAcknowledged(ackFromManifest(streamManifest))

      const stream = streamHost.handleCall({ type: 'call', id: 'late-stream', method: 'Tooling.GetTools', params: {}, identity: { caller_peer_id: 'peer-a', effective_perms: ['Tooling.GetTools'] } }, 'peer-a')
      await flush()
      await waitForTimeoutWork()
      expect(streamHost.getDiagnostics()).toMatchObject({ activeWorkCount: 0, timeoutSendFailureCount: 1, lastTimeoutFailureReason: 'timeout_send_failed' })
      expect(JSON.stringify(streamHost.getDiagnostics())).not.toContain('send failed secret')
      expect(unhandled.map(String).join('\n')).not.toContain('send failed secret')
      expect(streamSent.filter((frame) => (frame as any).id === 'late-stream')).toHaveLength(1)
      expect(streamSent.at(-1)).toMatchObject({ type: 'error', id: 'late-stream', error: { code: 504, reason_code: 'request_timeout' } })
      streamRelease()
      await stream
      expect(streamSent.filter((frame) => (frame as any).id === 'late-stream')).toHaveLength(1)
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
