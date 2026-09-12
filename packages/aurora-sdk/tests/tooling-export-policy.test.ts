import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
  TOOLING_METHODS,
  normalizePolicyOverrides,
  normalizeToolExportDecision,
  normalizeToolExportPolicy,
  type AuroraTransportRequest,
  type ToolingExportMutationResponse,
} from '../src/index.js'

const exportMutationResponse: ToolingExportMutationResponse = {
  ok: true,
  policy: {
    default_state: 'shared',
    revision: 8,
    initialized: true,
    migrated_from_legacy: true,
    updated_at: 1_784_073_600,
  },
  rule: null,
  cleared: false,
  changed: true,
  audit_id: 'toolexportaudit_test',
  previous_revision: 7,
  revision: 8,
  correlation_id: 'corr-export',
}

describe('Tooling export policy SDK surface', () => {
  it('publishes the exact revisioned Tooling export contract identities', () => {
    expect(TOOLING_METHODS).toMatchObject({
      getToolExportPolicy: 'Tooling.GetToolExportPolicy',
      setToolExportDefault: 'Tooling.SetToolExportDefault',
      upsertToolGroupExportPolicy: 'Tooling.UpsertToolGroupExportPolicy',
      upsertToolExportOverride: 'Tooling.UpsertToolExportOverride',
      clearToolExportOverride: 'Tooling.ClearToolExportOverride',
      previewToolExportDecision: 'Tooling.PreviewToolExportDecision',
    })
    expect(TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT).toBe('CONFIRM TOOL EXPORT POLICY CHANGE')
  })

  it('serializes read and preview requests without approval or trust fields', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = MockAuroraTransport.empty()
      .register(TOOLING_METHODS.getToolExportPolicy, (request) => {
        requests.push(request)
        return {
          policy: exportMutationResponse.policy,
          rules: [],
          stale_tool_ids: [],
          stale_group_ids: [],
          protocol_tier: 'projection_v1',
          mesh_switches: {
            provider_mesh_tooling_enabled: true,
            consumer_mesh_tooling_enabled: true,
            revision: 0,
            enforcement_active: false,
          },
          secrets_redacted: true,
        }
      })
      .register(TOOLING_METHODS.previewToolExportDecision, (request) => {
        requests.push(request)
        return {
          decision: {
            effective_state: 'unshared',
            inherited_from: 'peer_tool',
            matched_rule_id: 'rule-peer-tool',
            peer_id: 'peer-stable-2',
            global_tool_id: 'aurora-tool:v1:local:Tooling:schedule.list',
            share_group_id: 'core:scheduler',
            exportable: false,
            stale_tool_id: false,
            stale_group_id: false,
            prerequisites: { local_exportable: true, enforcement_active: false },
            policy_revision: 8,
            reason_code: 'peer_tool_override',
          },
        }
      })
    const client = new AuroraClient({ transport })

    await client.tools.getToolExportPolicy({ peer_id: 'peer-stable-2', include_rules: true, include_stale: false })
    await client.tools.previewToolExportDecision({
      global_tool_id: 'aurora-tool:v1:local:Tooling:schedule.list',
      share_group_id: 'core:scheduler',
      peer_id: 'peer-stable-2',
    })

    expect(requests).toEqual([
      expect.objectContaining({
        method: 'Tooling.GetToolExportPolicy',
        path: '/api/Tooling/GetToolExportPolicy',
        payload: { peer_id: 'peer-stable-2', include_rules: true, include_stale: false },
      }),
      expect.objectContaining({
        method: 'Tooling.PreviewToolExportDecision',
        path: '/api/Tooling/PreviewToolExportDecision',
        payload: {
          global_tool_id: 'aurora-tool:v1:local:Tooling:schedule.list',
          share_group_id: 'core:scheduler',
          peer_id: 'peer-stable-2',
        },
      }),
    ])
    expect(JSON.stringify(requests)).not.toContain('approval_mode')
    expect(JSON.stringify(requests)).not.toContain('trust_tier')
  })

  it('preserves optimistic revision and audit fields through AdminAction writes', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = exportAdminTransport(requests)
    const client = new AuroraClient({ transport })
    const request = {
      state: 'unshared' as const,
      expected_revision: 7,
      actor_principal_id: 'principal-owner',
      reason: 'Do not export scheduler tools to this peer',
      confirmation_text: TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
      correlation_id: 'corr-export',
      global_tool_id: 'aurora-tool:v1:local:Tooling:schedule.list',
      peer_id: 'peer-stable-2',
    }

    const response = await client.tools.upsertToolExportOverride(request)

    expect(response).toEqual(exportMutationResponse)
    expect(requests.map((item) => item.method)).toEqual([
      'Gateway.AdminActionDraft',
      'Gateway.AdminActionConfirm',
      'Tooling.UpsertToolExportOverride',
    ])
    const draft = requests[0]?.payload as Record<string, unknown>
    expect(draft).toMatchObject({
      method_id: 'Tooling.UpsertToolExportOverride',
      affected_resources: [
        'tool-export:aurora-tool:v1:local:Tooling:schedule.list:peer:peer-stable-2',
      ],
      payload: request,
    })
    expect(requests[1]?.payload).toMatchObject({
      reason: request.reason,
      phrase: 'CONFIRM',
      reauth_confirmed: true,
    })
    expect(requests[2]?.payload).toMatchObject({
      confirmation_text: TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    })
    expect(requests[2]).toEqual(expect.objectContaining({
      path: '/api/Tooling/UpsertToolExportOverride',
      payload: request,
      headers: {
        'X-Aurora-AdminAction-Id': 'aa-export',
        'X-Aurora-AdminAction-Token': 'token-export',
        'X-Aurora-AdminAction-Digest': 'digest-export',
      },
    }))
  })

  it('keeps legacy share presentation and approval trust mutations independent', async () => {
    expect(normalizePolicyOverrides({
      default_share: true,
      default_approval_mode: 'ask_each_time',
      policy_mode: 'enforce',
      default_token_ttl_seconds: 300,
      rules: [{
        rule_id: 'legacy-unshared',
        share: false,
        approval_mode: 'ask_each_time',
        global_tool_id: 'aurora-tool:v1:local:Tooling:schedule.list',
      }],
    })[0]).toEqual(expect.objectContaining({ share: false, approvalMode: 'ask_each_time', trustTier: 'untrusted' }))

    const requests: AuroraTransportRequest[] = []
    const client = new AuroraClient({ transport: exportAdminTransport(requests, TOOLING_METHODS.upsertToolPolicyOverride) })
    await client.tools.upsertToolOverride({
      toolId: 'aurora-tool:v1:local:Tooling:schedule.list',
      approvalMode: 'ask_each_time',
      share: false,
      reason: 'Keep approval separate from export',
    })

    const write = requests.find((item) => item.method === TOOLING_METHODS.upsertToolPolicyOverride)
    expect(write?.payload).toEqual(expect.objectContaining({ trust_tier: 'untrusted' }))
    expect(write?.payload).not.toEqual(expect.objectContaining({ trust_tier: 'blocked' }))
  })

  it('clears source and tool trust overrides through explicit AdminAction contracts', async () => {
    const sourceRequests: AuroraTransportRequest[] = []
    const sourceClient = new AuroraClient({
      transport: exportAdminTransport(sourceRequests, TOOLING_METHODS.clearSourcePolicy),
    })
    await sourceClient.tools.clearSourcePolicy({
      sourceId: 'local:core',
      reason: 'Inherit the global Tooling approval default',
    })
    expect(sourceRequests.find((item) => item.method === TOOLING_METHODS.clearSourcePolicy)).toEqual(
      expect.objectContaining({
        path: '/api/Tooling/ClearSourcePolicy',
        payload: expect.objectContaining({ source_id: 'local:core' }),
      }),
    )

    const toolRequests: AuroraTransportRequest[] = []
    const toolClient = new AuroraClient({
      transport: exportAdminTransport(toolRequests, TOOLING_METHODS.clearToolPolicyOverride),
    })
    await toolClient.tools.clearToolOverride({
      toolId: 'aurora-tool:v1:local:Tooling:schedule.list',
      localToolName: 'list_scheduled_tasks_tool',
      reason: 'Inherit the source approval policy',
    })
    expect(toolRequests.find((item) => item.method === TOOLING_METHODS.clearToolPolicyOverride)).toEqual(
      expect.objectContaining({
        path: '/api/Tooling/ClearToolPolicyOverride',
        payload: expect.objectContaining({
          global_tool_id: 'aurora-tool:v1:local:Tooling:schedule.list',
          local_tool_name: 'list_scheduled_tasks_tool',
        }),
      }),
    )
  })

  it('normalizes All peers and named peer scopes without treating labels as authority', () => {
    const response = {
      policy: exportMutationResponse.policy!,
      rules: [{
        rule_id: 'rule-group', peer_id: 'peer-stable-2', scope_type: 'group' as const,
        scope_id: 'core:scheduler', state: 'shared' as const, actor_principal_id: 'owner',
        reason: 'share', created_at: 1, updated_at: 2,
      }],
      stale_tool_ids: [], stale_group_ids: [], protocol_tier: 'projection_v1' as const,
      mesh_switches: { provider_mesh_tooling_enabled: true, consumer_mesh_tooling_enabled: true, revision: 3, enforcement_active: true },
      secrets_redacted: true,
    }
    expect(normalizeToolExportPolicy(response).scope).toMatchObject({ peerId: null, label: 'All peers', stale: false })
    const named = normalizeToolExportPolicy(response, { peerId: 'peer-stable-2', label: 'Aurora 2' })
    expect(named.scope).toMatchObject({ peerId: 'peer-stable-2', label: 'Aurora 2', stale: false })
    expect(named.rules[0]).toMatchObject({ peerId: 'peer-stable-2', scopeId: 'core:scheduler' })
  })

  it('keeps friendly scope labels out of normalized policy reads', async () => {
    const requests: AuroraTransportRequest[] = []
    const response = {
      policy: exportMutationResponse.policy!, rules: [], stale_tool_ids: [], stale_group_ids: [],
      protocol_tier: 'projection_v1',
      mesh_switches: { provider_mesh_tooling_enabled: true, consumer_mesh_tooling_enabled: true, revision: 1, enforcement_active: true },
      secrets_redacted: true,
    }
    const client = new AuroraClient({ transport: MockAuroraTransport.empty().register(TOOLING_METHODS.getToolExportPolicy, (request) => {
      requests.push(request)
      return response
    }) })
    const all = await client.tools.getToolExportPolicyModel()
    const named = await client.tools.getToolExportPolicyModel({ peer_id: 'peer-stable-2' }, { label: 'Aurora 2' })
    expect(all.scope).toMatchObject({ peerId: null, label: 'All peers', stale: false })
    expect(named.scope).toMatchObject({ peerId: 'peer-stable-2', label: 'Aurora 2', stale: false })
    expect(requests.map((request) => request.payload)).toEqual([{}, { peer_id: 'peer-stable-2' }])
    expect(JSON.stringify(requests)).not.toContain('Aurora 2')
  })

  it('normalizes all decision sources and preserves false versus unknown prerequisite evidence', () => {
    const sources = ['peer_tool', 'global_tool', 'peer_group', 'global_group', 'global_default'] as const
    for (const inherited_from of sources) {
      const model = normalizeToolExportDecision({
        effective_state: 'shared', inherited_from, peer_id: null,
        global_tool_id: 'tool-stable', share_group_id: 'group-stable', exportable: true,
        stale_tool_id: false, stale_group_id: false,
        prerequisites: {
          local_exportable: true,
          service_shared: false,
          peer_execute_rbac: null,
          enforcement_active: true,
          evidence: [{ key: 'service_shared', state: 'blocked', source: 'mesh_policy', reason_code: 'service_unshared' }],
        },
        policy_revision: 9, reason_code: 'effective',
      })
      expect(model.inheritedFromLabel).not.toBe(inherited_from)
      expect(model.prerequisites.find((row) => row.key === 'service_shared')).toMatchObject({ state: 'blocked', reasonCode: 'service_unshared' })
      expect(model.prerequisites.find((row) => row.key === 'peer_execute_rbac')?.state).toBe('unknown')
    }
  })

  it('serializes group/tool clear sharing writes independently from approval writes', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = exportAdminTransport(requests, TOOLING_METHODS.clearToolExportOverride)
    const client = new AuroraClient({ transport })
    await client.tools.clearToolExportOverride({
      scope_type: 'group', scope_id: 'group-stable', peer_id: 'peer-stable-2', expected_revision: 8,
      actor_principal_id: 'owner', reason: 'inherit again', confirmation_text: TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    })
    const write = requests.at(-1)
    expect(write?.method).toBe(TOOLING_METHODS.clearToolExportOverride)
    expect(write?.payload).toMatchObject({ scope_id: 'group-stable', peer_id: 'peer-stable-2', expected_revision: 8 })
    expect(JSON.stringify(write?.payload)).not.toMatch(/approval_mode|trust_tier|display_name/)
    expect(requests.some((request) => request.method === TOOLING_METHODS.upsertToolPolicyOverride)).toBe(false)
  })

  it('uses stable group identity for All peers and omits the peer overlay', async () => {
    const requests: AuroraTransportRequest[] = []
    const client = new AuroraClient({ transport: exportAdminTransport(requests, TOOLING_METHODS.upsertToolGroupExportPolicy) })
    await client.tools.upsertToolGroupExportPolicy({
      state: 'shared', share_group_id: 'group-stable', expected_revision: 8, actor_principal_id: 'owner',
      reason: 'share group', confirmation_text: TOOLING_EXPORT_POLICY_CONFIRMATION_TEXT,
    })
    const payload = requests.at(-1)?.payload as Record<string, unknown>
    expect(payload).toMatchObject({ share_group_id: 'group-stable', expected_revision: 8 })
    expect(payload).not.toHaveProperty('peer_id')
    expect(JSON.stringify(payload)).not.toMatch(/approval_mode|trust_tier|group_label/)
  })

  it('normalizes durable stale recipient scopes without exposing tool membership', () => {
    const model = normalizeToolExportPolicy({
      policy: exportMutationResponse.policy!,
      rules: [], stale_tool_ids: [], stale_group_ids: [], protocol_tier: 'projection_v1',
      recipient_scopes: [{
        peer_id: 'peer-removed-stable', display_name: 'Previously configured peer', stale: true,
        rule_count: 2, last_rule_updated_at: 42,
      }],
      mesh_switches: { provider_mesh_tooling_enabled: true, consumer_mesh_tooling_enabled: true, revision: 1, enforcement_active: true },
      secrets_redacted: true,
    })
    expect(model.scopes).toEqual([
      expect.objectContaining({ peerId: null, label: 'All peers', stale: false }),
      {
        peerId: 'peer-removed-stable', label: 'Previously configured peer', stale: true,
        ruleCount: 2, lastRuleUpdatedAt: 42,
      },
    ])
    expect(JSON.stringify(model.scopes)).not.toContain('globalToolId')
    expect(JSON.stringify(model.scopes)).not.toContain('scopeId')
  })
})

function exportAdminTransport(
  requests: AuroraTransportRequest[],
  mutationMethod: string = TOOLING_METHODS.upsertToolExportOverride,
): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register('Gateway.AdminActionDraft', (request) => {
      requests.push(request)
      return {
        action_id: 'aa-export',
        nonce: 'nonce-export',
        digest: 'digest-export',
        method_id: mutationMethod,
        affected_resources: [],
        required_phrase: 'CONFIRM',
        required_reason: true,
        required_reauth: true,
        expires_at: '2026-07-13T23:59:00Z',
        expires_in_seconds: 300,
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest',
        },
      }
    })
    .register('Gateway.AdminActionConfirm', (request) => {
      requests.push(request)
      return {
        action_id: 'aa-export',
        confirmation_token: 'token-export',
        digest: 'digest-export',
        confirmed: true,
        expires_at: '2026-07-13T23:59:00Z',
        audit_receipt: 'audit-export',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest',
        },
      }
    })
    .register(mutationMethod, (request) => {
      requests.push(request)
      return exportMutationResponse
    })
}
