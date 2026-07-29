import { describe, expect, it } from 'vitest'

import {
  LocalToolRegistry,
  MESH_NODE_TOOLING_METHOD_IDS,
  NATIVE_TOOL_DESCRIPTORS,
  createMeshNodeLocalToolProvider,
  type LocalToolDescriptorV1,
  type LocalToolExecutionContext
} from '../src/local-tools/index.js'
import {
  MemoryInboundCredentialVerifierStore,
  MemoryPeerGrantRepository,
  PeerAuthorityResolver,
  type AuthenticatedPeerContext,
  type PeerAuthorityDecision,
  type PeerGrantResolutionRequest,
  type PeerHostCallContext,
  type ProviderLocalPeerGrantV1,
  type PeerRelationshipSelector,
  type ReconnectTransportAttestation
} from '../src/peer-host/index.js'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-a',
  verifierPeerId: 'provider',
  roomName: 'room-a'
}

const transport: ReconnectTransportAttestation = {
  channelBinding: 'c'.repeat(64),
  claimantSignalingPeerId: 'signal-peer-a',
  verifierSignalingPeerId: 'signal-provider'
}

const authenticatedPeerContext: AuthenticatedPeerContext = {
  selector,
  transport,
  credentialRevision: 3,
  authenticatedAtMs: 1_000
}

const descriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.echo',
  localName: 'echo',
  displayName: 'Echo',
  description: 'Echo input',
  argsSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, caller: { type: 'string' } },
    required: ['ok', 'caller'],
    additionalProperties: false
  },
  argumentVisibility: { text: 'public' },
  requiredPermissions: ['Echo.Use'],
  resourceScopes: ['echo.local'],
  safetyClass: 'standard',
  privacyClass: 'personal',
  mutating: false,
  dataEgress: false,
  nativeRequirements: { capabilityIds: ['echo.read'], osPermissions: [] },
  confirmationPolicy: 'never',
  handlerId: 'core.echo'
}

const sensitiveDescriptor: LocalToolDescriptorV1 = {
  ...descriptor,
  toolContractId: 'native.share_text',
  localName: 'share_text',
  displayName: 'Share text',
  description: 'Share text',
  requiredPermissions: ['Native.Share'],
  resourceScopes: ['native.share'],
  safetyClass: 'sensitive',
  mutating: true,
  dataEgress: true,
  nativeRequirements: { capabilityIds: ['aurora.browser.share'], osPermissions: [] },
  confirmationPolicy: 'sensitive',
  handlerId: 'native.share_text'
}

describe('mesh-node local Tooling provider composition', () => {
  it('fails closed without explicit authority, audit, and export decision ports', async () => {
    const composition = createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho(),
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    })

    expect(composition.enabled).toBe(false)
    expect(composition.registeredToolIds).toEqual(['core.echo'])
    expect(composition.peerHostRegistry.list()).toEqual([])
    await expect(composition.policy.prepare(
      composition.localToolRegistry.resolveForDispatch('echo')!,
      { tool_name: 'echo', arguments: { text: 'hello' } },
      executionContext()
    )).resolves.toMatchObject({
      ok: false,
      policy_decision: { reason: 'method_not_granted' }
    })
    await expect(composition.peerHost.startEpoch('peer-a', authenticatedPeerContext)).resolves.toMatchObject({
      shared_services: []
    })
  })

  it('fails closed when export or audit ports are missing even if authority grants exist', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })
    const base = {
      nodeMode: 'mesh-node' as const,
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho(),
      authorityResolver: resolver,
      cursorSecret: 'cursor-secret-1234',
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    }

    for (const composition of [
      createMeshNodeLocalToolProvider({ ...base, audit: () => undefined }),
      createMeshNodeLocalToolProvider({ ...base, exportDecision: { isShared: () => true } })
    ]) {
      expect(composition.enabled).toBe(false)
      expect(composition.peerHostRegistry.list()).toEqual([])
      await expect(composition.peerHost.startEpoch('peer-a', authenticatedPeerContext)).resolves.toMatchObject({
        shared_services: []
      })
    }
  })

  it('does not instantiate local provider methods for remote-console or unspecified modes', async () => {
    for (const nodeMode of ['remote-console', undefined] as const) {
      const grantRepository = new MemoryPeerGrantRepository()
      await grantRepository.upsertGrant(grant())
      const resolver = new PeerAuthorityResolver({
        verifierStore: new MemoryInboundCredentialVerifierStore(),
        grantRepository
      })
      const composition = createMeshNodeLocalToolProvider({
        ...(nodeMode !== undefined ? { nodeMode } : {}),
        localPeerId: 'provider',
        nodeName: 'Provider',
        registry: registryWithEcho(),
        authorityResolver: resolver,
        exportDecision: { isShared: () => true },
        audit: () => undefined,
        cursorSecret: 'cursor-secret-1234',
        clock: () => 1_000,
        randomId: () => 'epoch-1'
      })

      expect(composition.enabled).toBe(false)
      expect(composition.peerHostRegistry.list()).toEqual([])
      await expect(composition.peerHost.startEpoch('peer-a', authenticatedPeerContext)).resolves.toMatchObject({
        shared_services: []
      })
    }
  })

  it('advertises and executes only through authenticated grants plus explicit export sharing', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })
    const audits: unknown[] = []
    const composition = createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho(),
      authorityResolver: resolver,
      exportDecision: { isShared: () => true },
      audit: (record) => { audits.push(record) },
      cursorSecret: 'cursor-secret-1234',
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    })

    expect(composition.enabled).toBe(true)
    expect(composition.peerHostRegistry.list().map((method) => method.methodId)).toEqual([
      'Tooling.ExecuteTool',
      'Tooling.GetExportCatalog',
      'Tooling.GetTools',
      'Tooling.PrepareExecution'
    ])
    const manifest = await composition.peerHost.startEpoch('peer-a', authenticatedPeerContext)
    expect(JSON.stringify(manifest)).toContain('Tooling.ExecuteTool')

    const provider = composition.peerHostRegistry.get('Tooling.ExecuteTool')
    expect(provider).toBeDefined()
    if (!provider) throw new Error('execute method missing')

    const result = await composition.peerHostRegistry.dispatch(provider, {
      tool_name: 'echo',
      arguments: { text: 'hello' }
    }, {
      id: 'call-1',
      methodId: 'Tooling.ExecuteTool',
      remotePeerId: 'peer-a',
      identity: {
        callerPeerId: 'peer-a',
        principalId: 'principal-a',
        effectivePermissions: ['Tooling.ExecuteTool', 'Echo.Use'],
        authGrantRevision: 5,
        manifestRevision: 1
      },
      authenticatedPeerContext,
      signal: new AbortController().signal,
      receivedAtMs: 1_000,
      deadlineAtMs: 31_000
    })

    expect(result).toMatchObject({
      ok: true,
      status: 'success',
      data: { ok: true, caller: 'peer-a' }
    })
    expect(JSON.stringify({ result, audits })).not.toContain('cursor-secret-1234')
  })

  it('executes granted local tools through the real peer-host call path', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })
    const composition = createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho(),
      authorityResolver: resolver,
      exportDecision: { isShared: () => true },
      audit: () => undefined,
      cursorSecret: 'cursor-secret-1234',
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    })
    const sent: unknown[] = []
    composition.peerHost.attach({ sendFrame: async (frame) => { sent.push(frame) } })
    const manifest = await composition.peerHost.startEpoch('peer-a', authenticatedPeerContext)
    expect(composition.peerHost.markManifestAcknowledged(ackFromManifest(manifest))).toBe(true)

    await composition.peerHost.handleCall({
      type: 'call',
      id: 'execute-1',
      method: 'Tooling.ExecuteTool',
      params: {
        tool_name: 'echo',
        arguments: { text: 'hello' }
      },
      identity: { caller_peer_id: 'forged-peer', effective_perms: [] }
    }, 'peer-a', authenticatedPeerContext)

    expect(sent.at(-1)).toMatchObject({
      type: 'result',
      id: 'execute-1',
      result: {
        ok: true,
        status: 'success',
        data: { ok: true, caller: 'peer-a' }
      }
    })
  })

  it('fails closed to structured denial when authority grant resolution throws', async () => {
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository: new ThrowingPeerGrantRepository()
    })
    const composition = createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho(),
      authorityResolver: resolver,
      exportDecision: { isShared: () => true },
      audit: () => undefined,
      cursorSecret: 'cursor-secret-1234',
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    })
    const execute = composition.peerHostRegistry.get('Tooling.ExecuteTool')
    expect(execute).toBeDefined()
    if (!execute) throw new Error('execute method missing')

    await expect(composition.peerHostRegistry.dispatch(execute, {
      tool_name: 'echo',
      arguments: { text: 'hello' }
    }, callContext())).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'method_not_granted'
    })
  })

  it('requires local approval tokens for sensitive tools and rejects token replay', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant({
      allowedToolContractIds: ['native.share_text'],
      capabilityPackIds: ['aurora.browser.share'],
      resourceScopes: ['native.share']
    }))
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })
    const composition = createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithSensitiveTool(),
      authorityResolver: resolver,
      exportDecision: { isShared: () => true },
      audit: () => undefined,
      cursorSecret: 'cursor-secret-1234',
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    })
    const entry = composition.localToolRegistry.resolveForDispatch('share_text')
    expect(entry).toBeDefined()
    if (!entry) throw new Error('sensitive tool missing')
    const request = { tool_name: 'share_text', arguments: { text: 'hello' } }
    const context = executionContext({ permissions: ['Tooling.ExecuteTool', 'Native.Share'] })

    const prepared = await composition.policy.validateForExecute(entry, request, context)
    expect(prepared).toMatchObject({
      ok: false,
      policy_decision: { approval_required: true, reason: 'approval_token_required' }
    })
    const token = composition.policy.issueApprovalToken(prepared, request, context)
    await expect(composition.policy.validateForExecute(entry, { ...request, approval_token: token }, context)).resolves.toMatchObject({
      ok: true,
      policy_decision: { allowed: true, reason: null }
    })
    await expect(composition.policy.validateForExecute(entry, { ...request, approval_token: token }, context)).resolves.toMatchObject({
      ok: false,
      policy_decision: { reason: 'approval_token_replayed' }
    })
  })

  it('keeps empty registries out of manifests and omits raw native escape hatches', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })
    const composition = createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: new LocalToolRegistry({ stablePeerId: 'provider' }),
      authorityResolver: resolver,
      exportDecision: { isShared: () => true },
      audit: () => undefined,
      cursorSecret: 'cursor-secret-1234',
      clock: () => 1_000,
      randomId: () => 'epoch-1'
    })

    await expect(composition.peerHost.startEpoch('peer-a', authenticatedPeerContext)).resolves.toMatchObject({
      shared_services: []
    })
    expect(MESH_NODE_TOOLING_METHOD_IDS).toEqual([
      'Tooling.GetTools',
      'Tooling.GetExportCatalog',
      'Tooling.PrepareExecution',
      'Tooling.ExecuteTool'
    ])
    expect(JSON.stringify(NATIVE_TOOL_DESCRIPTORS)).not.toMatch(/shell|process|filesystem|filePath|path/u)
  })

  it('does not enable production provider methods without a pagination cursor secret', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })

    for (const cursorSecret of [undefined, 'short'] as const) {
      const composition = createMeshNodeLocalToolProvider({
        nodeMode: 'mesh-node',
        localPeerId: 'provider',
        nodeName: 'Provider',
        registry: registryWithEcho(),
        authorityResolver: resolver,
        exportDecision: { isShared: () => true },
        audit: () => undefined,
        ...(cursorSecret !== undefined ? { cursorSecret } : {}),
        clock: () => 1_000,
        randomId: () => 'epoch-1'
      })

      expect(composition.enabled).toBe(false)
      expect(composition.peerHostRegistry.list()).toEqual([])
    }
  })

  it('rejects registries created for a different provider identity', () => {
    expect(() => createMeshNodeLocalToolProvider({
      nodeMode: 'mesh-node',
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho('other-provider')
    })).toThrow(/peer identity/u)
  })
})

function registryWithEcho(stablePeerId = 'provider'): LocalToolRegistry {
  const registry = new LocalToolRegistry({
    stablePeerId,
    providerLabel: 'Provider',
    source: 'core',
    sourceId: 'test'
  })
  registry.register({
    descriptor,
    handler: ({ context }) => ({ ok: true, caller: context.callerPeerId })
  })
  return registry
}

function registryWithSensitiveTool(): LocalToolRegistry {
  const registry = new LocalToolRegistry({
    stablePeerId: 'provider',
    providerLabel: 'Provider',
    source: 'core',
    sourceId: 'test'
  })
  registry.register({
    descriptor: sensitiveDescriptor,
    handler: ({ context }) => ({ ok: true, caller: context.callerPeerId })
  })
  return registry
}

function grant(patch: Partial<ProviderLocalPeerGrantV1> = {}): ProviderLocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-1',
    ...selector,
    allowedMethodIds: [
      'Tooling.GetTools',
      'Tooling.GetExportCatalog',
      'Tooling.PrepareExecution',
      'Tooling.ExecuteTool'
    ],
    allowedToolContractIds: ['core.echo'],
    capabilityPackIds: ['echo.read'],
    resourceScopes: ['echo.local'],
    createdAtMs: 1,
    grantRevision: 5,
    ...patch
  }
}

function executionContext(patch: Partial<LocalToolExecutionContext> = {}): LocalToolExecutionContext {
  return {
    callerPeerId: 'peer-a',
    callerPrincipalId: 'principal-a',
    authenticatedPeerContext,
    permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
    methodId: 'Tooling.ExecuteTool',
    nowMs: 1_000,
    ...patch
  }
}

function callContext(patch: Partial<PeerHostCallContext> = {}): PeerHostCallContext {
  return {
    id: 'call-1',
    methodId: 'Tooling.ExecuteTool',
    remotePeerId: 'peer-a',
    identity: {
      callerPeerId: 'peer-a',
      principalId: 'principal-a',
      effectivePermissions: ['Tooling.ExecuteTool', 'Echo.Use'],
      authGrantRevision: 5,
      manifestRevision: 1
    },
    authenticatedPeerContext,
    signal: new AbortController().signal,
    receivedAtMs: 1_000,
    deadlineAtMs: 31_000,
    ...patch
  }
}

function ackFromManifest(manifest: Record<string, unknown>, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const evidence = manifest.recipient_projection_evidence as Record<string, unknown>
  const hasSharedServices = Array.isArray(manifest.shared_services) && manifest.shared_services.length > 0
  return {
    type: 'manifest_ack',
    compatible_services: hasSharedServices ? ['Tooling'] : [],
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
    services: hasSharedServices
      ? [{ service_id: 'Tooling', service_label: '', status: 'compatible', reason_codes: [], reason: '' }]
      : [],
    ...patch
  }
}

class ThrowingPeerGrantRepository extends MemoryPeerGrantRepository {
  override async resolveGrant(_request: PeerGrantResolutionRequest): Promise<PeerAuthorityDecision> {
    throw new Error('repository unavailable')
  }
}
