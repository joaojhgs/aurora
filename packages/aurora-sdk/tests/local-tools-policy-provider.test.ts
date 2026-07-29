import { describe, expect, it } from 'vitest'

import { createToolingPeerHostRegistry, type PeerHostCallContext } from '../src/peer-host/index.js'
import {
  LocalToolExecutionPolicy,
  LocalToolRegistry,
  createLocalToolingProviderHandlers,
  type LocalToolDescriptorV1
} from '../src/local-tools/index.js'

const safeDescriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.echo',
  localName: 'echo',
  displayName: 'Echo',
  description: 'Echo input',
  argsSchema: { type: 'object', properties: { text: { type: 'string' }, apiToken: { type: 'string' } }, required: ['text'] },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, secretToken: { type: 'string' } } },
  argumentVisibility: { text: 'public', apiToken: 'secret' },
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

const dangerousDescriptor: LocalToolDescriptorV1 = {
  ...safeDescriptor,
  toolContractId: 'core.delete',
  localName: 'delete',
  displayName: 'Delete',
  safetyClass: 'dangerous',
  mutating: true,
  confirmationPolicy: 'always',
  handlerId: 'core.delete'
}

describe('local Tooling policy/provider', () => {
  it('executes safe tools through generated boundaries and trusted context grants only', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: ({ arguments: args }) => ({ ok: true, secretToken: String(args.apiToken) }) })
    const policy = new LocalToolExecutionPolicy({ providerPeerId: 'provider', providerServiceInstanceId: 'local:provider:Tooling' })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })

    const response = await provider.executeTool({
      tool_name: 'echo',
      arguments: { text: 'hi', apiToken: 'secret-value' },
      caller_permissions: []
    }, context(['Tooling.ExecuteTool', 'Echo.Use']))

    expect(response).toMatchObject({ ok: true, status: 'success', error: null })
    expect(JSON.stringify(response)).not.toContain('secret-value')
    expect(response.display_args_preview).toMatchObject({ text: 'hi', apiToken: '<redacted>' })
  })

  it('rechecks method, tool, capability, resource, schema, and safety before dispatch', async () => {
    let calls = 0
    let resourceAllowed = true
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: () => { calls += 1; return { ok: true } } })
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      ports: {
        hasMethodGrant: (methodId) => methodId === 'Tooling.ExecuteTool',
        hasToolGrant: (toolContractId) => toolContractId === 'core.echo',
        hasCapabilityGrant: (capabilityId) => capabilityId === 'echo.read',
        hasResourceGrant: () => resourceAllowed
      }
    })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })

    const missingMethod = await provider.prepareExecution({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Echo.Use']))
    expect(missingMethod).toMatchObject({ ok: false, policy_decision: { reason: 'recipient_missing_execute_permission' } })

    const schemaMismatch = await provider.prepareExecution({
      tool_name: 'echo',
      arguments: { text: 'hi' },
      expected_args_schema_hash: '0'.repeat(64)
    }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    expect(schemaMismatch).toMatchObject({ ok: false, policy_decision: { reason: 'args_schema_hash_mismatch' } })

    resourceAllowed = false
    const denied = await provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    expect(denied).toMatchObject({ ok: false, status: 'denied', error_code: 'resource_not_granted' })
    expect(calls).toBe(0)

    const registryWithCapabilityBlock = new LocalToolRegistry({ stablePeerId: 'provider' })
    registryWithCapabilityBlock.register({ descriptor: safeDescriptor, handler: () => { calls += 1; return { ok: true } } })
    const capabilityPolicy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      ports: { hasCapabilityGrant: () => false }
    })
    const capabilityProvider = createLocalToolingProviderHandlers({
      registry: registryWithCapabilityBlock,
      policy: capabilityPolicy,
      providerPeerId: 'provider',
      serviceInstanceId: 'local:provider:Tooling'
    })
    expect(await capabilityProvider.prepareExecution({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))).toMatchObject({
      ok: false,
      policy_decision: { reason: 'capability_not_granted' }
    })

    const notFound = await provider.executeTool({ tool_name: 'missing', arguments: {} }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    expect(notFound).toMatchObject({ ok: false, status: 'not_found', error_code: 'tool_not_found' })
  })

  it('requires one-time approval tokens for dangerous tools and rejects replay or changed args', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: dangerousDescriptor, handler: () => ({ ok: true }) })
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      randomToken: () => 'fixed',
      nowMs: () => 1_000
    })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })
    const callContext = context(['Tooling.ExecuteTool', 'Echo.Use'])
    const request = { tool_name: 'delete', arguments: { text: 'target' } }
    const prepared = await policy.prepare(registry.resolveForDispatch('delete')!, request, {
      callerPeerId: 'peer-a',
      callerPrincipalId: 'principal-a',
      permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
      methodId: 'Tooling.ExecuteTool',
      nowMs: 1_000
    })
    const token = policy.issueApprovalToken(prepared, request, {
      callerPeerId: 'peer-a',
      callerPrincipalId: 'principal-a',
      permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
      methodId: 'Tooling.ExecuteTool',
      nowMs: 1_000
    })

    const mismatch = await provider.executeTool({ ...request, arguments: { text: 'changed' }, approval_token: token }, callContext)
    expect(mismatch).toMatchObject({ ok: false, status: 'denied', error_code: 'approval_token_args_hash_mismatch' })

    const freshPrepared = await policy.prepare(registry.resolveForDispatch('delete')!, request, {
      callerPeerId: 'peer-a',
      callerPrincipalId: 'principal-a',
      permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
      methodId: 'Tooling.ExecuteTool',
      nowMs: 1_000
    })
    const fresh = policy.issueApprovalToken(freshPrepared, request, {
      callerPeerId: 'peer-a',
      callerPrincipalId: 'principal-a',
      permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
      methodId: 'Tooling.ExecuteTool',
      nowMs: 1_000
    })
    expect(await provider.executeTool({ ...request, approval_token: fresh }, callContext)).toMatchObject({ ok: true, status: 'success' })
    expect(await provider.executeTool({ ...request, approval_token: fresh }, callContext)).toMatchObject({ ok: false, status: 'denied', error_code: 'approval_token_replayed' })
  })

  it('rejects expired approval tokens without dispatching', async () => {
    let calls = 0
    let nowMs = 1_000
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: dangerousDescriptor, handler: () => { calls += 1; return { ok: true } } })
    const policy = new LocalToolExecutionPolicy({
      providerPeerId: 'provider',
      providerServiceInstanceId: 'local:provider:Tooling',
      tokenTtlSeconds: 1,
      nowMs: () => nowMs,
      randomToken: () => 'expiry'
    })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })
    const execution = {
      callerPeerId: 'peer-a',
      callerPrincipalId: 'principal-a',
      permissions: ['Tooling.ExecuteTool', 'Echo.Use'],
      methodId: 'Tooling.ExecuteTool',
      nowMs
    }
    const request = { tool_name: 'delete', arguments: { text: 'target' } }
    const prepared = await policy.prepare(registry.resolveForDispatch('delete')!, request, execution)
    const token = policy.issueApprovalToken(prepared, request, execution)
    nowMs = 2_001

    expect(await provider.executeTool({ ...request, approval_token: token }, context(['Tooling.ExecuteTool', 'Echo.Use']))).toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'approval_token_expired'
    })
    expect(calls).toBe(0)
  })

  it('passes cancellation to handlers and prevents late success', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    const abort = new AbortController()
    let handlerSignal: AbortSignal | null = null
    registry.register({
      descriptor: safeDescriptor,
      handler: ({ signal }) => {
        handlerSignal = signal
        abort.abort()
        return { ok: true }
      }
    })
    const policy = new LocalToolExecutionPolicy({ providerPeerId: 'provider', providerServiceInstanceId: 'local:provider:Tooling' })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })

    const response = await provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Tooling.ExecuteTool', 'Echo.Use'], abort.signal))

    expect(handlerSignal).toBe(abort.signal)
    expect(response).toMatchObject({ ok: false, status: 'failed', error_code: 'cancelled' })
  })

  it('redacts handler error contents and rejects hostile arguments before dispatch', async () => {
    let calls = 0
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({
      descriptor: safeDescriptor,
      handler: () => {
        calls += 1
        throw new Error('apiToken=secret-value')
      }
    })
    const policy = new LocalToolExecutionPolicy({ providerPeerId: 'provider', providerServiceInstanceId: 'local:provider:Tooling' })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })

    const failed = await provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    expect(failed).toMatchObject({ ok: false, status: 'failed', error: 'Tool execution failed' })
    expect(JSON.stringify(failed)).not.toContain('secret-value')
    expect(() => provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi', constructor: 'polluted' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))).rejects.toThrow()
    expect(() => provider.executeTool({ tool_name: 'echo', arguments: { text: 'x'.repeat(2 * 1024 * 1024 + 1) } }, context(['Tooling.ExecuteTool', 'Echo.Use']))).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('returns a handler bundle consumable by createToolingPeerHostRegistry', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: () => ({ ok: true }) })
    const policy = new LocalToolExecutionPolicy({ providerPeerId: 'provider', providerServiceInstanceId: 'local:provider:Tooling' })
    const handlers = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling' })
    const peerHostRegistry = createToolingPeerHostRegistry(handlers)

    expect(peerHostRegistry.list().map((method) => method.methodId)).toEqual([
      'Tooling.ExecuteTool',
      'Tooling.GetExportCatalog',
      'Tooling.GetTools',
      'Tooling.PrepareExecution'
    ])
    expect(await peerHostRegistry.dispatch(peerHostRegistry.get('Tooling.GetTools')!, {}, context(['Tooling.GetTools']))).toMatchObject({
      count: 1
    })
  })
})

function context(permissions: string[], signal: AbortSignal = new AbortController().signal): PeerHostCallContext {
  return {
    id: 'call-1',
    methodId: 'Tooling.ExecuteTool',
    remotePeerId: 'peer-a',
    identity: {
      callerPeerId: 'peer-a',
      principalId: 'principal-a',
      effectivePermissions: permissions,
      authGrantRevision: 1,
      manifestRevision: 1
    },
    signal,
    receivedAtMs: 1_000,
    deadlineAtMs: 31_000
  }
}
