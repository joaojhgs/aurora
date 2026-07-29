import { describe, expect, it } from 'vitest'

import {
  LocalToolRegistry,
  createMeshNodeLocalToolProvider,
  type LocalToolDescriptorV1,
  type LocalToolExecutionContext
} from '../src/local-tools/index.js'
import {
  MemoryInboundCredentialVerifierStore,
  MemoryPeerGrantRepository,
  PeerAuthorityResolver,
  type AuthenticatedPeerContext,
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

describe('mesh-node local Tooling provider composition', () => {
  it('fails closed without explicit authority, audit, and export decision ports', async () => {
    const composition = createMeshNodeLocalToolProvider({
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

  it('advertises and executes only through authenticated grants plus explicit export sharing', async () => {
    const grantRepository = new MemoryPeerGrantRepository()
    await grantRepository.upsertGrant(grant())
    const resolver = new PeerAuthorityResolver({
      verifierStore: new MemoryInboundCredentialVerifierStore(),
      grantRepository
    })
    const audits: unknown[] = []
    const composition = createMeshNodeLocalToolProvider({
      localPeerId: 'provider',
      nodeName: 'Provider',
      registry: registryWithEcho(),
      authorityResolver: resolver,
      exportDecision: { isShared: () => true },
      audit: (record) => { audits.push(record) },
      cursorSecret: 'cursor-secret',
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
    expect(JSON.stringify({ result, audits })).not.toContain('cursor-secret')
  })

  it('rejects registries created for a different provider identity', () => {
    expect(() => createMeshNodeLocalToolProvider({
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
