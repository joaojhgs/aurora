import { describe, expect, it } from 'vitest'

import { createToolingPeerHostRegistry, type PeerHostCallContext } from '../src/peer-host/index.js'
import {
  LocalToolExecutionPolicy,
  LocalToolRegistry,
  createLocalToolingProviderHandlers,
  toolSchemaHash,
  type LocalToolAuditRecord,
  type LocalToolDescriptorV1
} from '../src/local-tools/index.js'

const safeDescriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.echo',
  localName: 'echo',
  displayName: 'Echo',
  description: 'Echo input',
  argsSchema: { type: 'object', properties: { text: { type: 'string' }, apiToken: { type: 'string' } }, required: ['text'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, secretToken: { type: 'string' } }, required: ['ok'], additionalProperties: false },
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
    registry.register({ descriptor: safeDescriptor, handler: () => ({ ok: true }) })
    const provider = providerFor(registry)

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
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling', audit: noopAudit, exportDecision: allowExport })

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
      ports: { hasToolGrant: () => true, hasCapabilityGrant: () => false }
    })
    const capabilityProvider = createLocalToolingProviderHandlers({
      registry: registryWithCapabilityBlock,
      policy: capabilityPolicy,
      providerPeerId: 'provider',
      serviceInstanceId: 'local:provider:Tooling',
      audit: noopAudit,
      exportDecision: allowExport
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
      nowMs: () => 1_000,
      ports: allowPorts()
    })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling', audit: noopAudit, exportDecision: allowExport })
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
    await expect(provider.executeTool({ ...request, confirmed: true }, callContext)).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'approval_token_required'
    })

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
      randomToken: () => 'expiry',
      ports: allowPorts()
    })
    const provider = createLocalToolingProviderHandlers({ registry, policy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling', audit: noopAudit, exportDecision: allowExport })
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
    const provider = providerFor(registry)

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
    const provider = providerFor(registry)

    const failed = await provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    expect(failed).toMatchObject({ ok: false, status: 'failed', error: 'Tool execution failed' })
    expect(JSON.stringify(failed)).not.toContain('secret-value')
    await expect(provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi', extra: 'polluted' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'argument_schema_invalid'
    })
    await expect(provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi', constructor: 'polluted' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))).rejects.toThrow(/unsafe_object_key/)
    expect(() => provider.executeTool({ tool_name: 'echo', arguments: { text: 'x'.repeat(2 * 1024 * 1024 + 1) } }, context(['Tooling.ExecuteTool', 'Echo.Use']))).rejects.toThrow()
    expect(calls).toBe(1)
  })

  it('keeps GetTools aligned with export projection grants, authority, and self exclusion', () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: () => ({ ok: true }) })

    const defaultDenied = createLocalToolingProviderHandlers({
      registry,
      policy: new LocalToolExecutionPolicy({
        providerPeerId: 'provider',
        providerServiceInstanceId: 'local:provider:Tooling',
        ports: allowPorts()
      }),
      providerPeerId: 'provider',
      serviceInstanceId: 'local:provider:Tooling',
      audit: noopAudit
    })
    expect(defaultDenied.getTools({}, context(['*'], undefined, 'Tooling.GetTools'))).toMatchObject({ tools: [], count: 0 })
    expect(providerFor(registry).getTools({}, context(['*'], undefined, 'Tooling.GetTools', 'provider'))).toMatchObject({ tools: [], count: 0 })

    const response = providerFor(registry).getTools({}, context(['Tooling.*', 'Echo.*'], undefined, 'Tooling.GetTools'))
    expect(response.count).toBe(1)
    expect(response.tools[0]).toMatchObject({
      provider_peer_id: 'provider',
      provider_service_instance_id: 'local:provider:Tooling',
      provenance: {
        provider_peer_id: 'provider',
        provider_service_instance_id: 'local:provider:Tooling'
      }
    })
    expect(JSON.stringify(response)).not.toContain('handlerId')
  })

  it('validates recursive schemas before dispatch and validates output before return', async () => {
    let calls = 0
    const nestedDescriptor: LocalToolDescriptorV1 = {
      ...safeDescriptor,
      toolContractId: 'core.nested',
      localName: 'nested',
      handlerId: 'core.nested',
      argsSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 8 },
              tags: { type: 'array', items: { type: 'string' }, maxItems: 2 }
            },
            required: ['name'],
            additionalProperties: false
          }
        },
        required: ['profile'],
        additionalProperties: false
      },
      argumentVisibility: { profile: 'public' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    }
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: nestedDescriptor, handler: () => { calls += 1; return { ok: true, extra: 'blocked' } } })
    const provider = providerFor(registry)

    await expect(provider.executeTool({
      tool_name: 'nested',
      arguments: { profile: { name: 'friendly', tags: ['a', 'b', 'c'] } }
    }, context(['Tooling.ExecuteTool', 'Echo.Use']))).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'argument_schema_invalid' })
    expect(calls).toBe(0)

    await expect(provider.executeTool({
      tool_name: 'nested',
      arguments: { profile: { name: 'short', tags: ['a'] } }
    }, context(['Tooling.ExecuteTool', 'Echo.Use']))).resolves.toMatchObject({ ok: false, status: 'failed', error_code: 'output_schema_invalid' })
    expect(calls).toBe(1)
  })

  it('records mandatory redacted audit outcomes for prepare and execute', async () => {
    const records: LocalToolAuditRecord[] = []
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: () => ({ ok: true }) })
    const provider = providerFor(registry, {
      audit: (record) => { records.push(record) },
      connectionEpoch: 'epoch-1'
    })

    await provider.prepareExecution({ tool_name: 'echo', arguments: { text: 'hi', apiToken: 'secret-value' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    await provider.executeTool({ tool_name: 'echo', arguments: { text: 'hi', apiToken: 'secret-value' }, dry_run: true }, context(['Tooling.ExecuteTool', 'Echo.Use']))
    await provider.executeTool({ tool_name: 'missing', arguments: { text: 'hi' } }, context(['Tooling.ExecuteTool', 'Echo.Use']))

    expect(records.map((record) => [record.action, record.result])).toEqual([
      ['prepare', 'allowed'],
      ['execute', 'dry_run'],
      ['execute', 'not_found']
    ])
    expect(records[0]).toMatchObject({
      provider_peer_id: 'provider',
      provider_service_instance_id: 'local:provider:Tooling',
      caller_peer_id: 'peer-a',
      method_id: 'Tooling.ExecuteTool',
      connection_epoch: 'epoch-1',
      redacted: true,
      secrets_redacted: true,
      display_args_preview: { text: 'hi', apiToken: '<redacted>' }
    })
    expect(JSON.stringify(records)).not.toContain('secret-value')
  })

  it('uses wildcard and method-type permissions while remaining grant-deny by default', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: () => ({ ok: true }) })
    const allowed = providerFor(registry)
    const deniedPolicy = new LocalToolExecutionPolicy({ providerPeerId: 'provider', providerServiceInstanceId: 'local:provider:Tooling' })
    const denied = createLocalToolingProviderHandlers({ registry, policy: deniedPolicy, providerPeerId: 'provider', serviceInstanceId: 'local:provider:Tooling', audit: noopAudit, exportDecision: allowExport })

    await expect(allowed.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['Tooling.use', 'Echo.*']))).resolves.toMatchObject({ ok: true, status: 'success' })
    await expect(allowed.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['*']))).resolves.toMatchObject({ ok: true, status: 'success' })
    await expect(denied.executeTool({ tool_name: 'echo', arguments: { text: 'hi' } }, context(['*']))).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'tool_not_granted' })
    await expect(denied.executeTool({ tool_name: 'echo', arguments: { text: 'hi' }, dry_run: true }, context(['*']))).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'tool_not_granted' })
  })

  it('keeps schema hashes and policy checks immutable after external descriptor mutation', async () => {
    const mutableDescriptor = structuredClone(safeDescriptor)
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    const registered = registry.register({ descriptor: mutableDescriptor, handler: () => ({ ok: true }) })
    const entry = registry.resolveForDispatch('echo')!
    mutableDescriptor.argsSchema = { type: 'object', properties: {}, additionalProperties: true as false }

    expect(registered.schemaHash).toBe(toolSchemaHash({
      args_schema: registered.toolInfo.args_schema,
      schema: registered.toolInfo.schema,
      argument_visibility: registered.toolInfo.argument_visibility
    }))
    await expect(providerFor(registry).executeTool({ tool_name: 'echo', arguments: { anything: 'blocked' } }, context(['*']))).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'argument_schema_invalid'
    })
    expect(entry.descriptor.argsSchema).toMatchObject({ additionalProperties: false })
  })

  it('returns a handler bundle consumable by createToolingPeerHostRegistry', async () => {
    const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
    registry.register({ descriptor: safeDescriptor, handler: () => ({ ok: true }) })
    const handlers = providerFor(registry)
    const peerHostRegistry = createToolingPeerHostRegistry(handlers)

    expect(peerHostRegistry.list().map((method) => method.methodId)).toEqual([
      'Tooling.ExecuteTool',
      'Tooling.GetExportCatalog',
      'Tooling.GetTools',
      'Tooling.PrepareExecution'
    ])
    expect(await peerHostRegistry.dispatch(peerHostRegistry.get('Tooling.GetTools')!, {}, context(['Tooling.GetTools', 'Tooling.ExecuteTool', 'Echo.Use'], undefined, 'Tooling.GetTools'))).toMatchObject({
      count: 1
    })
  })
})

const noopAudit = () => undefined
const allowExport = { isShared: () => true }

function allowPorts() {
  return {
    hasMethodGrant: (methodId: string) => methodId === 'Tooling.ExecuteTool',
    hasToolGrant: () => true,
    hasCapabilityGrant: () => true,
    hasResourceGrant: () => true
  }
}

function providerFor(
  registry: LocalToolRegistry,
  overrides: Partial<Parameters<typeof createLocalToolingProviderHandlers>[0]> = {}
) {
  const policy = overrides.policy ?? new LocalToolExecutionPolicy({
    providerPeerId: 'provider',
    providerServiceInstanceId: 'local:provider:Tooling',
    ports: allowPorts()
  })
  return createLocalToolingProviderHandlers({
    registry,
    policy,
    providerPeerId: 'provider',
    serviceInstanceId: 'local:provider:Tooling',
    audit: noopAudit,
    exportDecision: allowExport,
    ...overrides
  })
}

function context(
  permissions: string[],
  signal: AbortSignal = new AbortController().signal,
  methodId = 'Tooling.ExecuteTool',
  callerPeerId = 'peer-a'
): PeerHostCallContext {
  return {
    id: 'call-1',
    methodId,
    remotePeerId: callerPeerId,
    identity: {
      callerPeerId,
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
