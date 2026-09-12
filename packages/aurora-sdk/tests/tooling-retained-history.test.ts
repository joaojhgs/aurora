import { describe, expect, it } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  TOOLING_METHODS,
  mergeToolManagementInventory,
  toolCatalogFixture,
} from '../src/index.js'

describe('Tooling retained remote history SDK surface', () => {
  it('keeps retained tools separate, stable, and explicitly non-callable', async () => {
    const transport = MockAuroraTransport.empty().register(TOOLING_METHODS.getToolSourceDetail, () => ({
      found: true,
      source: {
        source_id: 'mesh:peer-stable:Tooling', source: 'mesh_peer', display_name: 'Renamed Aurora',
        provider_peer_id: 'peer-stable', provider_service_instance_id: 'remote:peer-stable:Tooling',
        provider_kind: 'mesh_peer', status: 'unshared', tool_count: 0, retained_tool_count: 1,
        inactive_tool_count: 1, availability_counts: { unshared: 1 }, reason_code: 'projection_unshared',
        reason: 'Provider stopped sharing', shared_by_policy: false, removed_at: 123,
      },
      tools: [], blocked_tools: [], grants: [], pending_approvals: [], policy_rules: [],
      retained_tools: [{
        peer_id: 'peer-stable', provider_id: 'provider-stable', provider_label: 'Renamed Aurora',
        service_instance_id: 'remote:peer-stable:Tooling', source_id: 'mesh:peer-stable:Tooling',
        global_tool_id: 'tool-stable', local_tool_name: 'schedule.list', display_name: 'List schedules',
        source: 'core', retained_source_id: 'source-stable', share_group_id: 'group-stable',
        share_group_label: 'Scheduler', provider_tool_id: 'provider-tool-stable', retained_availability: 'unshared',
        effective_availability: 'unshared', reason_code: 'projection_unshared', provider_reason_code: null,
        schema_hash: 'a'.repeat(64), accepted_schema_hash: 'a'.repeat(64), review_required: false,
        projection_revision: 'rev-1', current_generation: 4, active_generation: null,
        first_seen_at: 1, last_seen_at: 2, updated_at: 3, compacted_at: null,
        approval_grant_ids: ['grant-1'], policy_rule_ids: ['policy-1'], tool: null, secrets_redacted: true,
      }],
      secrets_redacted: true,
    }))
    const detail = await new AuroraClient({ transport }).tools.getSourceDetail('mesh:peer-stable:Tooling')
    expect(detail?.source).toMatchObject({
      retainedToolCount: 1, inactiveToolCount: 1, availabilityCounts: { unshared: 1 },
      sharedByPolicy: false, reasonCode: 'projection_unshared', removedAt: 123,
    })
    expect(detail?.tools).toEqual([])
    expect(detail?.blockedTools).toEqual([])
    expect(detail?.retainedTools).toEqual([
      expect.objectContaining({ peerId: 'peer-stable', globalToolId: 'tool-stable', displayName: 'List schedules', historyOnly: true, callable: false, lastKnownTool: null }),
    ])
  })

  it('renders first-seen permission blocks with the exact missing permission', async () => {
    const remoteTool = {
      ...toolCatalogFixture.tools[0],
      global_tool_id: 'aurora-tool:v1:peer-stable:Tooling:speak',
      provider_peer_id: 'peer-stable',
      provider_service_instance_id: 'remote:peer-stable:Tooling',
      display_name: 'Renamed Aurora.speak',
      local_name: 'speak',
      name: 'speak',
      source_type: 'mesh_peer',
      execution_location: 'remote',
    }
    const transport = MockAuroraTransport.empty().register(TOOLING_METHODS.getToolSourceDetail, () => ({
      found: true,
      source: {
        source_id: 'mesh:peer-stable:Tooling', source: 'mesh_peer', display_name: 'Renamed Aurora',
        provider_peer_id: 'peer-stable', provider_service_instance_id: 'remote:peer-stable:Tooling',
        provider_kind: 'mesh_peer', status: 'permission_blocked', tool_count: 0, retained_tool_count: 1,
        inactive_tool_count: 1, availability_counts: { permission_blocked: 1 },
      },
      tools: [], blocked_tools: [], grants: [], pending_approvals: [], policy_rules: [],
      retained_tools: [{
        peer_id: 'peer-stable', provider_id: 'provider-stable', provider_label: 'Renamed Aurora',
        service_instance_id: 'remote:peer-stable:Tooling', source_id: 'mesh:peer-stable:Tooling',
        global_tool_id: remoteTool.global_tool_id, local_tool_name: 'speak', display_name: 'Renamed Aurora.speak',
        source: 'core', retained_availability: 'permission_blocked', effective_availability: 'permission_blocked',
        reason_code: 'recipient_missing_tool_permissions', missing_permissions: ['TTS.Request'],
        schema_hash: 'a'.repeat(64), accepted_schema_hash: 'a'.repeat(64), review_required: false,
        projection_revision: 'rev-1', current_generation: 1, active_generation: null,
        first_seen_at: 1, last_seen_at: 2, updated_at: 3, tool: remoteTool, secrets_redacted: true,
      }],
      secrets_redacted: true,
    }))
    const detail = await new AuroraClient({ transport }).tools.getSourceDetail('mesh:peer-stable:Tooling')
    const inventory = mergeToolManagementInventory(
      detail?.tools ?? [],
      detail?.blockedTools ?? [],
      detail?.retainedTools ?? [],
    )
    expect(inventory).toHaveLength(1)
    expect(inventory[0]).toMatchObject({
      state: 'unavailable',
      blockReasonCode: 'recipient_missing_tool_permissions',
      disabledReason: 'Blocked by peer permissions. Missing: TTS.Request.',
    })
  })
})
