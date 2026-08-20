import { describe, expect, it } from 'vitest'
import { grantListResolver, scriptedResolver } from './helpers/authority-doubles.js'

import {
  LocalToolExecutionPolicy,
  LocalToolRegistry,
  createLocalToolingProviderHandlers,
  createPeerAuthorityLocalToolPolicyPorts,
  type LocalToolDescriptorV1,
  type LocalToolExecutionContext
} from '../src/local-tools/index.js'
import {
  type AuthenticatedPeerContext,
  type PeerHostCallContext,
  type ProviderLocalPeerCredentialVerifierV1,
  type ProviderLocalPeerGrantV1,
  type PeerRelationshipSelector,
  type PeerAuthorityDecision,
  type PeerGrantResolutionRequest,
  type ReconnectTransportAttestation
} from '../src/peer-host/index.js'

const selector: PeerRelationshipSelector = {
  tokenId: 'token-1',
  claimantPeerId: 'peer-a',
  verifierPeerId: 'provider',
  roomName: 'room-a'
}

const transport: ReconnectTransportAttestation = {
  channelBinding: 'b'.repeat(64),
  claimantSignalingPeerId: 'signal-peer-a',
  verifierSignalingPeerId: 'signal-provider'
}

const authenticatedPeerContext: AuthenticatedPeerContext = {
  selector,
  transport,
  credentialRevision: 7,
  authenticatedAtMs: 900
}

const descriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.echo',
  localName: 'echo',
  displayName: 'Echo',
  description: 'Echo input',
  argsSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, bearer: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, caller: { type: 'string' } },
    required: ['ok', 'caller'],
    additionalProperties: false
  },
  argumentVisibility: { text: 'public', bearer: 'secret' },
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

describe('local Tooling authority policy ports', () => {
  it('allows execution only when method, tool, capability, and resource grants match the authenticated peer', async () => {
    const { provider } = await providerWithGrant(grant())

    await expect(provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({
      ok: true,
      status: 'success',
      data: { ok: true, caller: 'peer-a' }
    })

    const missingTool = await providerWithGrant(grant({ allowedToolContractIds: ['core.other'] }))
    await expect(missingTool.provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'tool_not_granted' })

    const missingCapability = await providerWithGrant(grant({ capabilityPackIds: ['echo.write'] }))
    await expect(missingCapability.provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'capability_not_granted' })

    const missingResource = await providerWithGrant(grant({ resourceScopes: ['echo.remote'] }))
    await expect(missingResource.provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'resource_not_granted' })
  })

  it('denies an explicitly missing method grant before checking tool dimensions', async () => {
    const { provider } = await providerWithGrant(grant({ allowedMethodIds: ['Tooling.GetTools'] }))

    await expect(provider.prepareExecution(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({ ok: false, policy_decision: { reason: 'method_not_granted' } })
  })

  it('fails closed when authenticated context is missing or belongs to a different caller', async () => {
    const { provider } = await providerWithGrant(grant())

    await expect(provider.prepareExecution(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'] })
    )).resolves.toMatchObject({ ok: false, policy_decision: { reason: 'method_not_granted' } })

    await expect(provider.prepareExecution(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({
        permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
        callerPeerId: 'peer-b',
        authenticatedPeerContext
      })
    )).resolves.toMatchObject({ ok: false, policy_decision: { reason: 'method_not_granted' } })

    await expect(provider.prepareExecution(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({
        permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
        authenticatedPeerContext: {
          ...authenticatedPeerContext,
          selector: { ...selector, verifierPeerId: 'other-provider' }
        }
      })
    )).resolves.toMatchObject({ ok: false, policy_decision: { reason: 'method_not_granted' } })
  })

  it('fails closed to structured policy denial when the resolver or grant repository throws', async () => {
    // The authority is unreachable. What this asserts is that the *policy*
    // fails closed into a structured denial rather than throwing or allowing.
    const resolver = scriptedResolver({
      resolveGrant: () => {
        throw new Error('repository unavailable')
      }
    })
    const registry = registryWithHandler()
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      ports: createPeerAuthorityLocalToolPolicyPorts({ resolver, providerPeerId: 'provider' })
    })
    const provider = createLocalToolingProviderHandlers({
      registry,
      policy,
      providerPeerId: 'provider',
      serviceInstanceId: 'local:provider:Tooling',
      audit: () => undefined,
      exportDecision: { isShared: () => true }
    })

    await expect(provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'method_not_granted' })
  })

  it('propagates authenticated context through provider policy checks and handlers', async () => {
    let policyContext: LocalToolExecutionContext | undefined
    let handlerContext: LocalToolExecutionContext | undefined
    const { provider } = await providerWithGrant(grant(), {
      observePolicyContext: (context) => { policyContext = context },
      observeHandlerContext: (context) => { handlerContext = context }
    })

    await expect(provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello' } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )).resolves.toMatchObject({ ok: true, status: 'success' })

    expect(policyContext?.authenticatedPeerContext).toEqual(authenticatedPeerContext)
    expect(handlerContext?.authenticatedPeerContext).toEqual(authenticatedPeerContext)
  })

  it('keeps raw bearer material and verifier hashes out of policy responses and audits', async () => {
    const rawBearer = 'raw-bearer-secret-value'
    const verifierHash = 'c'.repeat(64)
    const localAudit: unknown[] = []
    const resolver = grantListResolver([grant()])
    const registry = registryWithHandler()
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      ports: createPeerAuthorityLocalToolPolicyPorts({ resolver, providerPeerId: 'provider' })
    })
    const provider = createLocalToolingProviderHandlers({
      registry,
      policy,
      providerPeerId: 'provider',
      serviceInstanceId: 'local:provider:Tooling',
      audit: (record) => { localAudit.push(record) },
      exportDecision: { isShared: () => true }
    })

    const response = await provider.executeTool(
      { tool_name: 'echo', arguments: { text: 'hello', bearer: rawBearer } },
      context({ permissions: ['Tooling.ExecuteTool', 'Echo.Use'], authenticatedPeerContext })
    )
    // The authority's own audit rows are Rust's after R2 and are covered by the
    // crate's tests; what this asserts is that nothing secret reaches the
    // response or the local tool audit on the way back out.
    const serialized = JSON.stringify({ response, localAudit })

    expect(response).toMatchObject({ ok: true, status: 'success' })
    expect(serialized).not.toContain(rawBearer)
    expect(serialized).not.toContain(verifierHash)
  })
})

async function providerWithGrant(
  localGrant: ProviderLocalPeerGrantV1,
  observers: {
    readonly observePolicyContext?: (context: LocalToolExecutionContext) => void
    readonly observeHandlerContext?: (context: LocalToolExecutionContext) => void
  } = {}
) {
  const resolver = grantListResolver([localGrant])
  const basePorts = createPeerAuthorityLocalToolPolicyPorts({ resolver, providerPeerId: 'provider' })
  const policy = new LocalToolExecutionPolicy({
    providerPeerId: 'provider',
    providerServiceInstanceId: 'local:provider:Tooling',
    ports: {
      ...basePorts,
      hasMethodGrant: (methodId, context) => {
        observers.observePolicyContext?.(context)
        return basePorts.hasMethodGrant?.(methodId, context) ?? false
      }
    }
  })
  const registry = registryWithHandler(observers.observeHandlerContext)
  const provider = createLocalToolingProviderHandlers({
    registry,
    policy,
    providerPeerId: 'provider',
    serviceInstanceId: 'local:provider:Tooling',
    audit: () => undefined,
    exportDecision: { isShared: () => true }
  })
  return { provider, registry, policy }
}

function registryWithHandler(observe?: (context: LocalToolExecutionContext) => void): LocalToolRegistry {
  const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
  registry.register({
    descriptor,
    handler: ({ context }) => {
      observe?.(context)
      return { ok: true, caller: context.callerPeerId }
    }
  })
  return registry
}

function grant(patch: Partial<ProviderLocalPeerGrantV1> = {}): ProviderLocalPeerGrantV1 {
  return {
    version: 1,
    grantId: 'grant-1',
    ...selector,
    allowedMethodIds: ['Tooling.ExecuteTool'],
    allowedToolContractIds: ['core.echo'],
    capabilityPackIds: ['echo.read'],
    resourceScopes: ['echo.local'],
    createdAtMs: 1,
    grantRevision: 1,
    ...patch
  }
}

function verifier(tokenHashHex: string): ProviderLocalPeerCredentialVerifierV1 {
  return {
    version: 1,
    ...selector,
    tokenHashHex,
    createdAtMs: 1,
    credentialRevision: 7
  }
}

function context(input: {
  readonly permissions: readonly string[]
  readonly callerPeerId?: string
  readonly authenticatedPeerContext?: AuthenticatedPeerContext
}): PeerHostCallContext {
  const callerPeerId = input.callerPeerId ?? 'peer-a'
  return {
    id: 'call-1',
    methodId: 'Tooling.ExecuteTool',
    remotePeerId: callerPeerId,
    identity: {
      callerPeerId,
      principalId: 'principal-a',
      effectivePermissions: input.permissions,
      authGrantRevision: 1,
      manifestRevision: 1
    },
    ...(input.authenticatedPeerContext !== undefined ? { authenticatedPeerContext: input.authenticatedPeerContext } : {}),
    signal: new AbortController().signal,
    receivedAtMs: 1_000,
    deadlineAtMs: 31_000
  }
}

