import { describe, expect, it, vi } from 'vitest'

import type { ToolApprovalConfirmRequest } from '../src/admin.js'
import {
  LocalToolRegistry,
  type LocalToolDescriptorV1
} from '../src/local-tools/index.js'
import {
  createLightweightToolClientAdapter,
  createOnDeviceLightweightToolPolicy,
  type LightweightToolClientDelegate
} from '../src/lightweight-orchestrator/index.js'
import type { JsonObject, ToolingPrepareExecutionRequest, ToolingProjectionToolInfo } from '../src/types.js'

const safeDescriptor: LocalToolDescriptorV1 = {
  version: 1,
  toolContractId: 'core.echo',
  localName: 'echo',
  displayName: 'Echo',
  description: 'Echo input',
  argsSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, apiToken: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    required: ['ok'],
    additionalProperties: false
  },
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

describe('lightweight tool-client adapter', () => {
  it('executes a local safe tool through registry handlers and policy redaction', async () => {
    const { adapter, registry } = fixture()
    const tool = registry.resolvePublicId('echo')!
    const prepared = await adapter.prepareExecution(request('echo', { text: 'hi', apiToken: 'secret' }, tool.schemaHash))

    expect(prepared).toMatchObject({ ok: true, policy_decision: { allowed: true }, args_schema_hash: tool.schemaHash })
    expect(prepared.display_args_preview).toMatchObject({ text: 'hi', apiToken: '<redacted>' })

    const executed = await adapter.execute(request('echo', { text: 'hi', apiToken: 'secret' }, tool.schemaHash))
    expect(executed).toMatchObject({ ok: true, status: 'success', data: { ok: true, text: 'hi' } })
    expect(JSON.stringify(executed)).not.toContain('secret')
  })

  it('issues local approval tokens only after confirm and rejects denial or replay', async () => {
    const { adapter, registry } = fixture({ includeDangerous: true, ids: idSequence('approval') })
    const tool = registry.resolvePublicId('delete')!
    const payload = request('delete', { text: 'remove' }, tool.schemaHash)
    const approval = await adapter.requestApproval(payload)

    expect(approval).toMatchObject({ ok: true, approval_request_id: 'local-lw-approval-approval' })
    const denied = await adapter.confirmExecution(confirm(approval.approval_request_id!, false))
    expect(denied).toMatchObject({ ok: false, approval_token: null, error: 'approval_denied' })
    await expect(adapter.execute(payload)).resolves.toMatchObject({ ok: false, status: 'denied', error_code: 'approval_token_required' })

    const nextApproval = await adapter.requestApproval(payload)
    const confirmed = await adapter.confirmExecution(confirm(nextApproval.approval_request_id!, true))
    expect(confirmed).toMatchObject({ ok: true, approval_token: expect.stringMatching(/^local_tool_approval_/) })
    await expect(adapter.execute({ ...payload, approval_token: confirmed.approval_token, confirmed: true })).resolves.toMatchObject({ ok: true })
    await expect(adapter.execute({ ...payload, approval_token: confirmed.approval_token, confirmed: true })).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'approval_token_replayed'
    })
  })

  it('rejects schema mismatch before local dispatch', async () => {
    const { adapter } = fixture()

    await expect(adapter.prepareExecution(request('echo', { text: 'hi' }, '0'.repeat(64)))).resolves.toMatchObject({
      ok: false,
      policy_decision: { reason: 'args_schema_hash_mismatch' }
    })
    await expect(adapter.execute(request('echo', { text: 'hi' }, '0'.repeat(64)))).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      error_code: 'args_schema_hash_mismatch'
    })
  })

  it('limits on-device self-authority to registered capabilities and resources', async () => {
    const { adapter } = fixture()

    await expect(adapter.execute(request('echo', { text: 'hi' }))).resolves.toMatchObject({
      ok: true,
      status: 'success'
    })
  })

  it('delegates remote methods without rewriting payloads', async () => {
    const remote = remoteDelegate()
    const remoteTool = remoteToolInfo('remote.search')
    const { adapter } = fixture({ remote, availableTools: [remoteTool] })
    const payload = request('remote.search', { q: 'aurora' }, null, 'remote')

    await adapter.prepareExecution(payload)
    await adapter.requestApproval(payload)
    await adapter.confirmExecution(confirm('remote-approval', true))
    await adapter.execute(payload)

    expect(remote.calls).toEqual([
      ['prepare', payload],
      ['request', payload],
      ['confirm', confirm('remote-approval', true)],
      ['execute', payload]
    ])
  })

  it('fails closed for ambiguous local and remote tool IDs', async () => {
    const { registry } = fixture()
    const local = registry.publicTools()[0]!
    const remote = { ...remoteToolInfo('echo'), name: local.name, local_name: local.local_name, global_tool_id: 'remote:echo' }
    const adapter = createLightweightToolClientAdapter({
      ...baseOptions(registry),
      remote: remoteDelegate(),
      availableTools: [local, remote]
    })

    await expect(adapter.prepareExecution(request('echo', { text: 'hi' }))).rejects.toMatchObject({
      reasonCode: 'ambiguous_tool_route'
    })
  })

  it('sanitizes local handler errors', async () => {
    const { adapter } = fixture({ handler: () => { throw new Error('secret stack token') } })

    const result = await adapter.execute(request('echo', { text: 'hi' }))
    expect(result).toMatchObject({ ok: false, status: 'failed', error: 'Tool execution failed', error_code: 'handler_failed' })
    expect(JSON.stringify(result)).not.toContain('secret stack token')
  })
})

function fixture(options: {
  readonly includeDangerous?: boolean
  readonly ids?: () => string
  readonly handler?: (args: JsonObject) => JsonObject
  readonly remote?: LightweightToolClientDelegate | null
  readonly availableTools?: readonly ToolingProjectionToolInfo[]
} = {}) {
  const registry = new LocalToolRegistry({ stablePeerId: 'provider' })
  registry.register({
    descriptor: safeDescriptor,
    handler: ({ arguments: args }) => options.handler?.(args) ?? { ok: true, text: String(args.text ?? '') }
  })
  if (options.includeDangerous) {
    registry.register({ descriptor: dangerousDescriptor, handler: () => ({ ok: true, text: 'deleted' }) })
  }
  const adapter = createLightweightToolClientAdapter({
    ...baseOptions(registry),
    ...(options.remote !== undefined ? { remote: options.remote } : {}),
    ...(options.availableTools ? { availableTools: options.availableTools } : { availableTools: registry.publicTools() }),
    ...(options.ids ? { ids: options.ids } : {})
  })
  return { adapter, registry }
}

function baseOptions(registry: LocalToolRegistry) {
  return {
    localRegistry: registry,
    localPolicy: createOnDeviceLightweightToolPolicy({
      localRegistry: registry,
      providerPeerId: 'provider',
      serviceInstanceId: 'local:provider:Tooling',
      randomToken: () => 'token',
      nowMs: () => 1_000
    }),
    providerPeerId: 'provider',
    serviceInstanceId: 'local:provider:Tooling',
    callerPeerId: 'peer-a',
    callerPrincipalId: 'principal-a',
    callerPermissions: ['Tooling.ExecuteTool', 'Echo.Use'],
    nowMs: () => 1_000,
    audit: vi.fn()
  }
}

function request(
  toolName: string,
  args: JsonObject,
  expectedHash: string | null = null,
  executionLocation: 'local' | 'remote' = 'local'
): ToolingPrepareExecutionRequest {
  return {
    tool_name: toolName,
    arguments: args,
    expected_args_schema_hash: expectedHash,
    resource_selector: { execution_location: executionLocation },
    mesh_selector: null,
    correlation_id: `corr-${toolName}`
  }
}

function confirm(approval_request_id: string, approve: boolean): ToolApprovalConfirmRequest {
  return {
    approval_request_id,
    approver_principal_id: 'principal-a',
    approve,
    grant_scope: 'once',
    correlation_id: `confirm-${approval_request_id}`
  }
}

function remoteDelegate(): LightweightToolClientDelegate & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    async prepareExecution(payload) {
      calls.push(['prepare', payload])
      return {
        ok: true,
        policy_decision: {
          allowed: true,
          share: true,
          approval_required: false,
          approval_mode: 'approve_all_local_safe',
          decision_id: 'remote-decision',
          token_ttl_seconds: 300
        },
        args_hash: 'a'.repeat(64),
        resource_selector_hash: 'b'.repeat(64),
        route_decision_id: 'remote-route',
        correlation_id: payload.correlation_id ?? 'remote-corr',
        provider_peer_id: 'remote-peer',
        provider_service_instance_id: 'remote-service',
        global_tool_id: payload.tool_name,
        local_tool_name: payload.tool_name,
        args_schema_hash: null,
        display_args_preview: {},
        argument_visibility: {},
        secrets_redacted: true
      }
    },
    async requestApproval(payload) {
      calls.push(['request', payload])
      return { ok: true, approval_request_id: 'remote-approval', policy_decision: {}, expires_at: null, correlation_id: payload.correlation_id ?? 'remote-corr', error: null }
    },
    async confirmExecution(payload) {
      calls.push(['confirm', payload])
      return { ok: true, approval_token: 'remote-token', expires_at: null, policy_decision_id: null, correlation_id: payload.correlation_id ?? null, error: null }
    },
    async execute(payload) {
      calls.push(['execute', payload])
      return { ok: true, data: { remote: true }, status: 'success', correlation_id: payload.correlation_id ?? null, provider_peer_id: 'remote-peer', global_tool_id: payload.tool_name }
    }
  }
}

function remoteToolInfo(name: string): ToolingProjectionToolInfo {
  return {
    name,
    local_name: name,
    global_tool_id: name,
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: name,
    share_group_id: name,
    share_group_label: name,
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: 'remote-peer',
    provider_service_instance_id: 'remote-service',
    provider_label: null,
    provider_granted_permissions: null,
    provider_available: true,
    namespace: 'remote',
    display_name: name,
    aliases: [],
    description: name,
    args_schema: { type: 'object' },
    schema: { type: 'object' },
    argument_visibility: {},
    source_type: 'mesh_peer',
    source: 'mesh_peer',
    source_id: 'remote',
    trust_tier: 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    execution_location: 'remote',
    safety_class: 'safe',
    risk_class: 'safe',
    data_egress: false,
    mutating: false,
    external: false,
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: false,
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: 'remote-peer',
      provider_service_instance_id: 'remote-service',
      provider_kind: 'mesh_peer',
      source: 'mesh_peer',
      advertised_name: name
    }
  }
}

function idSequence(...ids: string[]) {
  let index = 0
  return () => ids[index++] ?? `id-${index}`
}
